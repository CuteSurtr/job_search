/** Shared shape of the feed, imported by both the route handlers and the UI. */

export type JobSetting = "Residency" | "Staff RN" | "Fellowship";

export type Job = {
  id: string;
  title: string;
  hospital: string;
  /** Source registry key, sent back to /api/jobs/detail. */
  sourceKey: string;
  /** Workday external path, sent back to /api/jobs/detail. */
  path: string;
  city: string;
  state: string;
  location: string;
  specialty: string;
  setting: JobSetting;
  /** Hourly rate used for filtering and sorting; null when the posting omits pay. */
  pay: number | null;
  payLabel: string;
  postedMinutes: number;
  postedLabel: string;
  shift: string;
  start: string;
  license: string;
  source: string;
  accent: string;
  summary: string;
  employerUrl: string;
  requisition: string | null;
  /**
   * Visa sponsorship position, from the posting body where it says anything and
   * otherwise from the curated employer registry.
   *
   * `unchecked` means nobody has researched that employer — deliberately
   * distinct from `unknown`, which means we looked and found no published
   * position. Neither is a "no".
   */
  sponsorship: "documented" | "reported" | "excluded" | "unknown" | "unchecked";
  /** False when the listing came from search alone and still needs a detail fetch. */
  enriched: boolean;
  /** When this tracker first saw the posting. Null when history is unavailable. */
  firstSeenAt?: string | null;
};

export type JobDetail = {
  id: string;
  title: string;
  location: string;
  payLabel: string;
  pay: number | null;
  shift: string;
  start: string;
  license: string;
  postedLabel: string;
  summary: string;
  /** Full plain-text posting body. */
  description: string;
  /** Requirement-like lines pulled out of the description. */
  highlights: string[];
  employerUrl: string;
};

export type FeedMeta = {
  updatedAt: string;
  nextRefreshAt: string;
  sourceCount: number;
  successfulSources: number;
  failedSources: string[];
  failureReasons: { source: string; reason: string }[];
  enrichedCount: number;
  /** True when Postgres sighting history backed this scan's posting ages. */
  historyTracked?: boolean;
  /**
   * True when a shared cache (Vercel KV / Upstash) is configured. Without it
   * each serverless instance keeps its own in-memory copy and rebuilds on every
   * cold start.
   */
  sharedCache?: boolean;
  /** Every state where at least one polled employer operates. */
  coveredStates?: string[];
  cacheSeconds: number;
};

export type JobFeed = { jobs: Job[]; meta: FeedMeta };
