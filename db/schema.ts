import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Sighting history for job postings.
 *
 * Workday only reports posting age as vague prose ("Posted 30+ Days Ago"), and
 * says nothing at all once a posting disappears. Recording what we saw and when
 * turns both into real data: a truthful "posted today", and the ability to tell
 * a visitor that a saved role has actually closed rather than silently dropping
 * it from the list.
 *
 * This table is an enhancement, never a dependency — the feed is fully
 * functional with no database configured at all (see lib/jobs/history.mjs).
 *
 * Timestamps are real `timestamptz` rather than the ISO strings this carried on
 * SQLite. Postgres has the type, comparisons no longer depend on lexicographic
 * ordering happening to match chronological ordering, and the application layer
 * still exchanges ISO strings at its boundaries.
 */
export const jobSightings = pgTable(
  "job_sightings",
  {
    /** Stable FNV-1a hash of the employer URL, matching Job.id in the feed. */
    id: text("id").primaryKey(),
    sourceKey: text("source_key").notNull(),
    title: text("title").notNull(),
    hospital: text("hospital").notNull(),
    state: text("state").notNull().default("Multi-state"),
    specialty: text("specialty").notNull().default("General Residency"),
    employerUrl: text("employer_url").notNull().default(""),
    /** When this posting was first seen in any scan — the honest "posted" date. */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Updated on every scan that still returns the posting. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    /** Set once the posting stops appearing; null while it is still listed. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("job_sightings_first_seen_idx").on(table.firstSeenAt),
    index("job_sightings_last_seen_idx").on(table.lastSeenAt),
    // closeMissing filters on source_key and closed_at together on every scan.
    index("job_sightings_source_open_idx").on(table.sourceKey, table.closedAt),
  ],
);

export type JobSighting = typeof jobSightings.$inferSelect;

/**
 * Email alert subscriptions.
 *
 * Double opt-in: a row is created unconfirmed and only receives digests once
 * the address has been confirmed through the emailed link. `token` is the
 * capability secret behind both the confirm and unsubscribe URLs, so it is
 * random per subscription and never derived from the address.
 */
export const alertSubscriptions = pgTable(
  "alert_subscriptions",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    /** Serialised filter set, matched against new postings. */
    filters: text("filters").notNull().default("{}"),
    /** Secret used by the confirm and unsubscribe links. */
    token: text("token").notNull(),
    status: text("status", { enum: ["pending", "confirmed", "unsubscribed"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** Digest watermark: only postings first seen after this are sent. */
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  },
  (table) => [
    index("alert_subscriptions_status_idx").on(table.status),
    index("alert_subscriptions_token_idx").on(table.token),
  ],
);

export type AlertSubscription = typeof alertSubscriptions.$inferSelect;
