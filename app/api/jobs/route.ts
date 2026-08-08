import { after } from "next/server";
import { readCacheEntry, sharedCacheConfigured, writeCache } from "@/lib/jobs/cache.mjs";
import {
  FEED_FRESH_SECONDS,
  FEED_SERVE_SECONDS,
  blocksOnRebuild,
  decideFeedAction,
} from "@/lib/jobs/feed-policy.mjs";
import {
  extractPay,
  isNewGradNursingRole,
  licenseFromText,
  normalizeLocation,
  postedMinutes,
  settingFromTitle,
  specialtyFromTitle,
  stableId,
  stateFromTitle,
  stripHtml,
  summaryFromText,
} from "@/lib/jobs/matching.mjs";
import { ageMinutes, recordSighting } from "@/lib/jobs/history.mjs";
import { COVERED_STATES, SEARCH_TERMS, SOURCES } from "@/lib/jobs/sources.mjs";
import { employerUrlFor, fetchDetailFor, fetchPostingsFor } from "@/lib/jobs/ats.mjs";
import { createBudget, mapWithConcurrency } from "@/lib/jobs/workday.mjs";
import type { Job, JobFeed } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

const FEED_CACHE_KEY = "feed";

/**
 * Upper bound on upstream calls for one cold build. Searches are reserved
 * first because a job we never find cannot be enriched later, whereas an
 * un-enriched job is still a usable listing that the detail route can fill in
 * on demand.
 */
const SUBREQUEST_BUDGET = 280;

/**
 * Two pages per search term rather than three. Across this many employers the
 * third page almost never contains a new-grad match — the search is relevance
 * ordered — and the saved allowance buys detail enrichment instead, which is
 * what puts a wage on a card.
 */
const MAX_SEARCH_PAGES = 2;
const MAX_ENRICHED = 80;
const MAX_LISTED = 200;

/** Employers scanned at once. Bounds both open sockets and burst load upstream. */
const SOURCE_CONCURRENCY = 12;

/** Detail fetches at once. */
const DETAIL_CONCURRENCY = 12;

type WorkdayDetail = {
  title?: string;
  location?: string;
  postedOn?: string;
  startDate?: string;
  timeType?: string;
  remoteType?: string;
  externalUrl?: string;
  jobDescription?: string;
};

type SourceOutcome = {
  source: (typeof SOURCES)[number];
  postings: { title: string; externalPath: string; locationsText?: string; postedOn?: string; bulletFields?: string[] }[];
  ok: boolean;
  error?: string;
};

async function collectPostings(budget: ReturnType<typeof createBudget>): Promise<SourceOutcome[]> {
  // Bounded rather than all-at-once: with this many employers, firing every
  // search simultaneously is a burst none of them asked for, and it makes the
  // slowest source contend with the rest for the wall-clock budget.
  return mapWithConcurrency(
    SOURCES,
    SOURCE_CONCURRENCY,
    async (source): Promise<SourceOutcome> => {
      try {
        const perTerm = await Promise.all(
          SEARCH_TERMS.map((term) => fetchPostingsFor(source, term, { budget, maxPages: MAX_SEARCH_PAGES })),
        );
        return { source, postings: perTerm.flat(), ok: true };
      } catch (error) {
        return {
          source,
          postings: [],
          ok: false,
          error: error instanceof Error ? error.message : "Unknown source error",
        };
      }
    },
  );
}

/**
 * Place a posting on the map, in descending order of certainty:
 *
 *  1. the location field, when it actually contains a city or state
 *  2. a full state name in the title ("... Illinois Locations")
 *  3. the employer's footprint, but only when they operate in exactly one state
 *
 * Step 3 exists because several tenants report a facility name where a city
 * should be and Workday exposes no state field at all. For a single-state
 * employer that is not a guess — every one of their postings is in that state.
 * A multi-state employer stays unresolved rather than being assigned a state
 * it might not be in, since a wrong state is worse than an honest "varies".
 */
function resolveState(fromLocation: string, title: string, employerStates: string[]) {
  if (fromLocation !== "Multi-state") return fromLocation;
  const fromTitle = stateFromTitle(title);
  if (fromTitle !== "Multi-state") return fromTitle;
  return employerStates.length === 1 ? employerStates[0] : "Multi-state";
}

async function buildFeed(): Promise<JobFeed> {
  // Generous wall-clock allowance: a rebuild runs in the background behind a
  // served response, so finishing slowly beats dropping a source. At 20s the
  // slowest employers were being aborted mid-scan.
  const budget = createBudget(SUBREQUEST_BUDGET, 45000);
  const updatedAt = new Date();
  const outcomes = await collectPostings(budget);

  const seen = new Set<string>();
  const matches = outcomes
    .flatMap(({ source, postings }) => postings.map((posting) => ({ source, posting })))
    .filter(({ source, posting }) => {
      const key = `${source.key}:${posting.externalPath}`;
      if (seen.has(key)) return false;
      if (!isNewGradNursingRole(posting.title)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => postedMinutes(a.posting.postedOn) - postedMinutes(b.posting.postedOn))
    .slice(0, MAX_LISTED);

  // Freshest postings get the detail call; the rest are listed immediately and
  // enriched by /api/jobs/detail when a visitor actually opens them.
  const enrichLimit = Math.min(MAX_ENRICHED, matches.length, budget.remaining());

  const jobs = await mapWithConcurrency(
    matches.map((match, index) => ({ ...match, index })),
    DETAIL_CONCURRENCY,
    async ({ source, posting, index }): Promise<Job> => {
      const detail =
        index < enrichLimit
          ? ((await fetchDetailFor(source, posting.externalPath, budget)) as WorkdayDetail | null)
          : null;

      const description = stripHtml(detail?.jobDescription ?? "");
      const location = normalizeLocation(detail?.location || posting.locationsText || "", source.name);
      const employerUrl = detail?.externalUrl || employerUrlFor(source, posting.externalPath);
      const title = detail?.title || posting.title;
      const pay = detail ? extractPay(description) : { pay: null, payLabel: "See posting" };

      return {
        id: stableId(employerUrl),
        title,
        hospital: source.name,
        sourceKey: source.key,
        path: posting.externalPath,
        city: location.city,
        state: resolveState(location.state, title, source.states),
        location: location.label,
        specialty: specialtyFromTitle(title),
        setting: settingFromTitle(title),
        pay: pay.pay,
        payLabel: pay.payLabel,
        postedMinutes: postedMinutes(detail?.postedOn || posting.postedOn),
        postedLabel: (detail?.postedOn || posting.postedOn || "Recently posted").replace(/^Posted\s+/i, ""),
        shift: detail?.timeType || detail?.remoteType || "Schedule on posting",
        start: detail?.startDate ? `Listed ${detail.startDate}` : "See cohort details",
        license: detail ? licenseFromText(description) : "See posting",
        source: "Employer career site",
        accent: source.accent,
        summary: detail
          ? summaryFromText(description, source.name)
          : `A current ${source.name} posting whose title matches a new graduate nursing pathway. Open the role for full requirements.`,
        employerUrl,
        requisition: posting.bulletFields?.[0] ?? null,
        enriched: Boolean(detail),
      };
    },
  );

  const failed = outcomes.filter((outcome) => !outcome.ok);

  // Sighting history is an enhancement: when D1 is absent or the table has not
  // been migrated this returns null and the feed keeps the employer's own ages.
  const firstSeen = await recordSighting(jobs);
  const tracked = firstSeen
    ? jobs.map((job) => ({
        ...job,
        postedMinutes: ageMinutes(firstSeen.get(job.id), job.postedMinutes, updatedAt.getTime()),
        // Always carried when history is on, so the client can tell a visitor
        // which roles appeared since they last looked.
        firstSeenAt: firstSeen.get(job.id) ?? null,
      }))
    : jobs;

  return {
    jobs: tracked,
    meta: {
      updatedAt: updatedAt.toISOString(),
      nextRefreshAt: new Date(updatedAt.getTime() + FEED_FRESH_SECONDS * 1000).toISOString(),
      sourceCount: SOURCES.length,
      successfulSources: outcomes.length - failed.length,
      failedSources: failed.map((outcome) => outcome.source.name),
      failureReasons: failed.map((outcome) => ({
        source: outcome.source.name,
        reason: outcome.error ?? "Unknown source error",
      })),
      enrichedCount: tracked.filter((job) => job.enriched).length,
      historyTracked: firstSeen !== null,
      // Without a shared cache every cold instance rebuilds from scratch, so
      // this is the difference between one scan an hour and one per instance.
      sharedCache: sharedCacheConfigured(),
      coveredStates: COVERED_STATES,
      cacheSeconds: FEED_FRESH_SECONDS,
    },
  };
}

/**
 * One rebuild at a time per isolate. Without this, a burst of traffic arriving
 * on an expired cache would each start their own eight-source scan.
 */
let inFlightRebuild: Promise<JobFeed> | null = null;

function rebuildOnce(): Promise<JobFeed> {
  if (inFlightRebuild) return inFlightRebuild;
  inFlightRebuild = buildFeed()
    .then(async (feed) => {
      // Only a feed that actually found something is worth keeping. Caching a
      // total upstream outage would strand the site on an empty list.
      if (feed.jobs.length > 0) await writeCache(FEED_CACHE_KEY, feed, FEED_SERVE_SECONDS);
      return feed;
    })
    .finally(() => {
      inFlightRebuild = null;
    });
  return inFlightRebuild;
}

/**
 * Schedule a rebuild that outlives this response. `after` keeps the serverless
 * invocation alive until the work settles, which is what stops a background
 * refresh being killed the moment the response is flushed.
 *
 * Called outside a request scope (a test importing the module directly) `after`
 * throws, so the promise is simply left to run best-effort instead.
 */
function rebuildInBackground() {
  const promise = rebuildOnce();
  promise.catch(() => {
    // A failed background refresh just means the stale feed is served again.
  });
  try {
    after(promise);
  } catch {
    // No request scope; the rebuild still runs, it just is not awaited.
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const wantsRefresh = url.searchParams.get("refresh") === "1";
  const entry = await readCacheEntry<JobFeed>(FEED_CACHE_KEY);
  const action = decideFeedAction(entry, wantsRefresh);

  if (blocksOnRebuild(action)) {
    return feedResponse(await rebuildOnce(), action === "refresh" ? "refreshed" : "miss");
  }

  if (action === "stale") {
    // Serve what we have now and refresh behind it, so the visitor who happens
    // to arrive after expiry is not the one who pays for the scan.
    rebuildInBackground();
    return feedResponse((entry as { value: JobFeed }).value, "stale");
  }

  return feedResponse((entry as { value: JobFeed }).value, "hit");
}

function feedResponse(feed: JobFeed, cacheState: "hit" | "miss" | "stale" | "refreshed") {
  // `max-age=0` keeps the browser revalidating — without it a visitor can sit
  // on a stale payload, which makes the "Check now" button quietly useless.
  // The edge still holds the feed via `s-maxage`.
  const response = Response.json(feed);
  response.headers.set(
    "Cache-Control",
    feed.jobs.length > 0
      ? `public, max-age=0, must-revalidate, s-maxage=${FEED_FRESH_SECONDS}, stale-while-revalidate=${FEED_SERVE_SECONDS}`
      : "public, max-age=0, must-revalidate, s-maxage=60",
  );
  response.headers.set("X-Feed-Cache", cacheState);
  return response;
}
