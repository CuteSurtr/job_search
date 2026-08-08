/**
 * Digest dispatch.
 *
 * Driven by Vercel Cron via `/api/cron/digest` (schedule in `vercel.json`).
 * This used to piggyback on feed rebuilds because Workers offered no scheduler,
 * which meant a site nobody visited sent nothing; that is no longer the case.
 *
 * Each subscriber is still paced by their own `lastSentAt` watermark rather
 * than assuming the schedule fired exactly once. That keeps the function
 * idempotent: a retried or manually triggered run cannot double-send, and a
 * missed run is picked up by the next one.
 */

import { digestDue, renderDigestEmail, sanitizeFilters, selectDigestJobs } from "./alerts.mjs";
import { sendEmail, alertsConfigured } from "./email.mjs";
import { getSubscriptionDb, listConfirmed, markSent } from "./subscriptions.mjs";

/** Ceiling on sends per run, so one request cannot fan out unbounded work. */
const MAX_SENDS_PER_RUN = 25;

/**
 * @param {import("./types").Job[]} jobs
 * @param {string} origin
 * @returns {Promise<{ sent: number, skipped: number }>}
 */
export async function runDigests(jobs, origin) {
  const result = { sent: 0, skipped: 0 };
  if (jobs.length === 0) return result;
  if (!(await alertsConfigured())) return result;

  const db = await getSubscriptionDb();
  if (!db) return result;

  let subscribers;
  try {
    subscribers = await listConfirmed(db);
  } catch (error) {
    console.error("[digest] could not read subscribers:", error);
    return result;
  }

  const now = Date.now();
  const sentAt = new Date(now).toISOString();

  for (const subscriber of subscribers) {
    if (result.sent >= MAX_SENDS_PER_RUN) break;
    if (!digestDue(subscriber, now)) {
      result.skipped += 1;
      continue;
    }

    let filters;
    try {
      filters = sanitizeFilters(JSON.parse(subscriber.filters ?? "{}"));
    } catch {
      filters = sanitizeFilters({});
    }

    const matches = selectDigestJobs(jobs, filters, subscriber.lastSentAt);
    if (matches.length === 0) {
      // Nothing new for them. Deliberately does not advance the watermark, so a
      // role that appears later still counts as new rather than being skipped.
      result.skipped += 1;
      continue;
    }

    const message = renderDigestEmail(matches, { origin, token: subscriber.token });
    const ok = await sendEmail({ to: subscriber.email, ...message });
    if (!ok) {
      result.skipped += 1;
      continue;
    }

    try {
      // Only after a confirmed send — advancing on failure would silently drop
      // that batch of roles from the subscriber's next digest.
      await markSent(db, subscriber.id, sentAt);
      result.sent += 1;
    } catch (error) {
      console.error("[digest] could not record send:", error);
    }
  }

  return result;
}
