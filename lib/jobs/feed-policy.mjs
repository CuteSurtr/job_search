/**
 * When to serve the cached feed and when to go back to the employers.
 *
 * Split out from the route because this is the subtlest logic in the app and
 * the branches are otherwise only reachable by waiting an hour. Pure and
 * time-injected so `tests/feed-policy.test.mjs` can exercise every path.
 */

/** How long a feed is considered current. Past this it is refreshed in the background. */
export const FEED_FRESH_SECONDS = 3600;

/**
 * How long a stale feed may still be served while a rebuild runs behind it.
 * Deliberately long: a day-old listing carrying a visible "last checked"
 * timestamp is far more useful to someone job hunting than a spinner.
 */
export const FEED_SERVE_SECONDS = 24 * 3600;

/**
 * Floor on how often `?refresh=1` may actually re-scan. Without it the
 * visitor-facing "Check now" button would be an open invitation to hammer
 * every hospital career site we poll.
 */
export const MIN_REFRESH_SECONDS = 300;

/**
 * @typedef {"build" | "refresh" | "stale" | "hit"} FeedAction
 *
 * - `build`   nothing usable cached; this request waits for the scan
 * - `refresh` manual check, old enough to be allowed; this request waits
 * - `stale`   serve the cached copy now, rebuild behind it
 * - `hit`     cached copy is current
 */

/**
 * @param {{ ageSeconds: number } | null} entry
 * @param {boolean} wantsRefresh
 * @returns {FeedAction}
 */
export function decideFeedAction(entry, wantsRefresh) {
  if (!entry || !Number.isFinite(entry.ageSeconds) || entry.ageSeconds > FEED_SERVE_SECONDS) {
    return "build";
  }
  if (wantsRefresh && entry.ageSeconds > MIN_REFRESH_SECONDS) return "refresh";
  if (entry.ageSeconds > FEED_FRESH_SECONDS) return "stale";
  return "hit";
}

/** Whether the caller must wait for the rebuild before it can answer. */
export function blocksOnRebuild(action) {
  return action === "build" || action === "refresh";
}
