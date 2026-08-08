import { runDigests } from "@/lib/jobs/digest.mjs";
import { alertsConfigured } from "@/lib/jobs/email.mjs";
import type { JobFeed } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

/** A digest run fans out to at most 25 sends; allow room for a slow provider. */
export const maxDuration = 60;

/**
 * Scheduled digest send, invoked by Vercel Cron (see `vercel.json`).
 *
 * On Workers there were no cron triggers, so digests had to piggyback on feed
 * rebuilds and a site nobody visited sent nothing. That limitation is gone: the
 * schedule is now a schedule. Each subscriber is still paced by their own
 * `lastSentAt` watermark, so an extra invocation is harmless and a missed one
 * is caught by the next.
 *
 * The endpoint is public by URL, so `CRON_SECRET` is what actually protects it.
 * Vercel sends it as a bearer token on scheduled invocations. Refusing to run
 * when it is unset is deliberate — an unauthenticated endpoint that emails your
 * subscribers on demand is worse than one that does nothing.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "CRON_SECRET is not configured; refusing to run." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await alertsConfigured())) {
    return Response.json({ ok: true, skipped: "email provider not configured" });
  }

  const origin = new URL(request.url).origin;

  // Goes through the feed's own endpoint rather than rebuilding inline, so a
  // digest reuses the cached scan a visitor already paid for instead of
  // starting a second one against 38 employers.
  let feed: JobFeed;
  try {
    const response = await fetch(`${origin}/api/jobs`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`feed responded ${response.status}`);
    feed = (await response.json()) as JobFeed;
  } catch (error) {
    console.error("[cron] could not read the feed:", error);
    return Response.json({ error: "Feed unavailable" }, { status: 502 });
  }

  if (!feed.meta?.historyTracked) {
    // Without sighting history every job looks new on every run, which would
    // mail subscribers the same roles indefinitely.
    return Response.json({ ok: true, skipped: "no sighting history; cannot tell new from old" });
  }

  const result = await runDigests(feed.jobs, origin);
  return Response.json({ ok: true, ...result });
}
