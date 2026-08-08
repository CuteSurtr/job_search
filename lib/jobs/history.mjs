/**
 * Sighting history, backed by D1 when it exists.
 *
 * Every function here is best-effort by design. The D1 binding is optional on
 * this platform, the table may not be migrated yet, and a job board that goes
 * down because its analytics table is missing would be a bad trade. So each
 * entry point catches everything and falls back to the feed's own data — the
 * site is fully usable with no database at all, it just loses the "first seen"
 * precision and the closed-role flag.
 */

import { drizzle } from "drizzle-orm/d1";
import { and, inArray, isNull, sql } from "drizzle-orm";
// Explicit extension: Node resolves this file directly when running the tests,
// and only the bundler tolerates an extensionless TypeScript specifier.
import { jobSightings } from "../../db/schema.ts";

/**
 * D1 rejects any statement binding more than 100 variables
 * ("D1_ERROR: too many SQL variables"), so chunk sizes are derived from the
 * parameter count rather than picked by feel.
 *
 * Note that local SQLite allows ~32k variables, so this ceiling does not exist
 * in the tests — it is asserted explicitly in tests/history.test.mjs instead.
 */
export const D1_MAX_VARIABLES = 100;

/** Columns bound per inserted row. */
export const SIGHTING_COLUMNS = 10;

/** Extra bindings in the ON CONFLICT clause: last_seen_at and closed_at. */
const UPSERT_EXTRA_PARAMS = 2;

/** Rows per insert: 8 x 10 columns + 2 = 82 bound variables. */
export const INSERT_CHUNK = Math.floor((D1_MAX_VARIABLES - UPSERT_EXTRA_PARAMS) / SIGHTING_COLUMNS);

/** Ids per select, one bound variable each. */
export const SELECT_CHUNK = D1_MAX_VARIABLES - 10;

/**
 * `cloudflare:workers` only resolves inside the Workers runtime — a static
 * import of it makes the built bundle unloadable under plain Node, which is
 * how the test suite drives the worker. Resolving it lazily keeps the module
 * importable everywhere and simply yields no database off-platform.
 *
 * @type {Promise<Record<string, unknown> | null> | null}
 */
let envPromise = null;

async function getWorkerEnv() {
  if (!envPromise) {
    envPromise = import("cloudflare:workers")
      .then((module) => module.env ?? null)
      .catch(() => null);
  }
  return envPromise;
}

async function getDbOrNull() {
  try {
    const env = await getWorkerEnv();
    if (!env?.DB) return null;
    return drizzle(env.DB, { schema: { jobSightings } });
  } catch {
    return null;
  }
}

/** @param {unknown[]} items @param {number} size */
function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Record this scan: upsert every job we just saw, then mark anything that was
 * previously open and is now absent as closed.
 *
 * Returns a map of job id to its true first-seen timestamp, or null when no
 * database is available.
 *
 * @param {import("./types").Job[]} jobs
 * @returns {Promise<Map<string, string> | null>}
 */
export async function recordSighting(jobs) {
  if (jobs.length === 0) return null;
  const db = await getDbOrNull();
  if (!db) return null;
  return recordSightingWith(db, jobs, new Date().toISOString());
}

/**
 * The body of {@link recordSighting} with the database handed in, so the SQL
 * semantics that matter — first-seen surviving an upsert, and absent postings
 * being closed — can be tested against a real SQLite instead of only in
 * production.
 *
 * @param {import("drizzle-orm/d1").DrizzleD1Database<any>} db
 * @param {import("./types").Job[]} jobs
 * @param {string} seenAt
 * @returns {Promise<Map<string, string> | null>}
 */
export async function recordSightingWith(db, jobs, seenAt) {
  try {
    for (const batch of chunk(jobs, INSERT_CHUNK)) {
      await db
        .insert(jobSightings)
        .values(
          batch.map((job) => ({
            id: job.id,
            sourceKey: job.sourceKey,
            title: job.title,
            hospital: job.hospital,
            state: job.state,
            specialty: job.specialty,
            employerUrl: job.employerUrl,
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
            closedAt: null,
          })),
        )
        // firstSeenAt is deliberately not overwritten — that is the whole point
        // of the table. A role that reappears after a gap is also reopened.
        .onConflictDoUpdate({
          target: jobSightings.id,
          set: {
            lastSeenAt: seenAt,
            title: sql`excluded.title`,
            state: sql`excluded.state`,
            specialty: sql`excluded.specialty`,
            employerUrl: sql`excluded.employer_url`,
            closedAt: null,
          },
        });
    }

    await closeMissing(db, jobs, seenAt);
    return await readFirstSeen(db, jobs);
  } catch (error) {
    // Degrading to employer-reported ages is fine; degrading silently is not —
    // without this the feature can be dead in production and look identical to
    // "D1 was never bound".
    console.error("[history] sighting write failed:", error);
    return null;
  }
}

/**
 * Mark postings that this scan did not return as closed. Scoped to the sources
 * that actually answered, so an employer being briefly unreachable does not
 * mass-close every role they list.
 */
async function closeMissing(db, jobs, seenAt) {
  const respondingSources = [...new Set(jobs.map((job) => job.sourceKey))];
  if (respondingSources.length === 0) return;

  try {
    await db
      .update(jobSightings)
      .set({ closedAt: seenAt })
      .where(
        and(
          isNull(jobSightings.closedAt),
          inArray(jobSightings.sourceKey, respondingSources),
          sql`${jobSightings.lastSeenAt} < ${seenAt}`,
        ),
      );
  } catch (error) {
    // Losing the closed flag is survivable; failing the scan is not.
    console.error("[history] close-missing failed:", error);
  }
}

/** @returns {Promise<Map<string, string>>} */
async function readFirstSeen(db, jobs) {
  const firstSeen = new Map();
  for (const batch of chunk(jobs, SELECT_CHUNK)) {
    const rows = await db
      .select({ id: jobSightings.id, firstSeenAt: jobSightings.firstSeenAt })
      .from(jobSightings)
      .where(
        inArray(
          jobSightings.id,
          batch.map((job) => job.id),
        ),
      );
    for (const row of rows) firstSeen.set(row.id, row.firstSeenAt);
  }
  return firstSeen;
}

/**
 * Age of a posting in minutes, taking the older of what we observed and what
 * the employer reports.
 *
 * Always taking the maximum is the only safe rule, because each source is
 * blind in one direction. Our own record cannot know a posting existed before
 * we started watching, so a role first seen an hour ago may really be months
 * old — Workday's "30+ Days Ago" corrects that. Workday in turn caps its own
 * prose at "30+" and sometimes reports a stale date, so a posting we have
 * watched for longer than it claims is corrected by our record. Taking the
 * larger value means the site never advertises a role as fresher than either
 * source supports, which is the direction that matters: telling a new grad a
 * three-month-old posting went up today wastes their application.
 *
 * @param {string | undefined} firstSeenAt
 * @param {number} reportedMinutes
 * @param {number} [nowMs]
 */
export function ageMinutes(firstSeenAt, reportedMinutes, nowMs = Date.now()) {
  if (!firstSeenAt) return reportedMinutes;
  const seen = new Date(firstSeenAt).getTime();
  if (!Number.isFinite(seen)) return reportedMinutes;
  const observed = Math.max(0, Math.round((nowMs - seen) / 60000));
  return Math.max(observed, reportedMinutes);
}
