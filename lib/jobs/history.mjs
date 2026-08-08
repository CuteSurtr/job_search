/**
 * Sighting history, backed by Postgres when one is configured.
 *
 * Every function here is best-effort by design. `DATABASE_URL` is optional, the
 * table may not be migrated yet, and a job board that goes down because its
 * analytics table is missing would be a bad trade. So each entry point catches
 * everything and falls back to the feed's own data — the site is fully usable
 * with no database at all, it just loses the "first seen" precision and the
 * closed-role flag.
 */

import { and, inArray, isNull, lt, sql } from "drizzle-orm";
// Explicit extension: Node resolves this file directly when running the tests,
// and only the bundler tolerates an extensionless TypeScript specifier.
import { jobSightings } from "../../db/schema.ts";
import { getDb } from "../db.mjs";

/**
 * Postgres binds up to 65535 parameters per statement, so the D1 ceiling of 100
 * that used to derive these numbers is gone. They are kept, and kept modest,
 * for a different reason: a single statement carrying every posting in a scan
 * is one long-running write on a pooled serverless connection, and splitting it
 * lets an interrupted scan leave a consistent partial record rather than
 * nothing. The failure this guards against changed; the batching still earns
 * its place.
 */
export const MAX_BIND_PARAMS = 65535;

/** Columns bound per inserted row. */
export const SIGHTING_COLUMNS = 10;

/** Rows per insert statement. 200 x 10 columns is well inside the ceiling. */
export const INSERT_CHUNK = 200;

/** Ids per select, one bound variable each. */
export const SELECT_CHUNK = 500;

function getDbOrNull() {
  try {
    return getDb();
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
  const db = getDbOrNull();
  if (!db) return null;
  return recordSightingWith(db, jobs, new Date().toISOString());
}

/**
 * The body of {@link recordSighting} with the database handed in, so the SQL
 * semantics that matter — first-seen surviving an upsert, and absent postings
 * being closed — can be tested against a real Postgres instead of only in
 * production.
 *
 * `seenAt` stays an ISO string at this boundary because that is what the feed
 * and the tests speak. The columns are `timestamptz`, so it is converted once
 * here and converted back on read; no ISO strings reach the driver.
 *
 * @param {import("drizzle-orm/postgres-js").PostgresJsDatabase<any>} db
 * @param {import("./types").Job[]} jobs
 * @param {string} seenAt
 * @returns {Promise<Map<string, string> | null>}
 */
export async function recordSightingWith(db, jobs, seenAt) {
  const seenDate = new Date(seenAt);
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
            firstSeenAt: seenDate,
            lastSeenAt: seenDate,
            closedAt: null,
          })),
        )
        // firstSeenAt is deliberately not overwritten — that is the whole point
        // of the table. A role that reappears after a gap is also reopened.
        .onConflictDoUpdate({
          target: jobSightings.id,
          set: {
            lastSeenAt: seenDate,
            title: sql`excluded.title`,
            state: sql`excluded.state`,
            specialty: sql`excluded.specialty`,
            employerUrl: sql`excluded.employer_url`,
            closedAt: null,
          },
        });
    }

    await closeMissing(db, jobs, seenDate);
    return await readFirstSeen(db, jobs);
  } catch (error) {
    // Degrading to employer-reported ages is fine; degrading silently is not —
    // without this the feature can be dead in production and look identical to
    // "no database was ever configured".
    console.error("[history] sighting write failed:", error);
    return null;
  }
}

/**
 * Mark postings that this scan did not return as closed. Scoped to the sources
 * that actually answered, so an employer being briefly unreachable does not
 * mass-close every role they list.
 */
async function closeMissing(db, jobs, seenDate) {
  const respondingSources = [...new Set(jobs.map((job) => job.sourceKey))];
  if (respondingSources.length === 0) return;

  try {
    await db
      .update(jobSightings)
      .set({ closedAt: seenDate })
      .where(
        and(
          isNull(jobSightings.closedAt),
          inArray(jobSightings.sourceKey, respondingSources),
          // A real timestamp comparison now, not string ordering that happened
          // to sort correctly because the strings were ISO-8601.
          lt(jobSightings.lastSeenAt, seenDate),
        ),
      );
  } catch (error) {
    // Losing the closed flag is survivable; failing the scan is not.
    console.error("[history] close-missing failed:", error);
  }
}

/**
 * Back to ISO strings at the boundary: everything downstream — `ageMinutes`,
 * the `firstSeenAt` field on a Job, the digest watermark comparison — treats
 * this as a string, and JSON has no date type anyway.
 *
 * @returns {Promise<Map<string, string>>}
 */
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
    for (const row of rows) {
      firstSeen.set(row.id, row.firstSeenAt instanceof Date ? row.firstSeenAt.toISOString() : row.firstSeenAt);
    }
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
