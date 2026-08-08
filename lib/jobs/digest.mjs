/**
 * Digest dispatch.
 *
 * This platform gives no Cron Triggers, so there is nothing to schedule sends
 * on. Instead a run piggybacks on a feed rebuild — which already happens in the
 * background via waitUntil — and each subscriber is rate-limited by their own
 * `lastSentAt` watermark rather than by a clock. The practical effect is a
 * daily digest for any site with daily traffic, and no digest at all for a site
 * nobody visits, which is the honest failure mode for a traffic-driven design.
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
