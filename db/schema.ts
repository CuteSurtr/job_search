import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
 * functional when the D1 binding is absent (see lib/jobs/history.mjs).
 */
export const jobSightings = sqliteTable(
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
    firstSeenAt: text("first_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    /** Updated on every scan that still returns the posting. */
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    /** Set once the posting stops appearing; null while it is still listed. */
    closedAt: text("closed_at"),
  },
  (table) => [
    index("job_sightings_first_seen_idx").on(table.firstSeenAt),
    index("job_sightings_last_seen_idx").on(table.lastSeenAt),
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
export const alertSubscriptions = sqliteTable(
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
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    confirmedAt: text("confirmed_at"),
    /** Digest watermark: only postings first seen after this are sent. */
    lastSentAt: text("last_sent_at"),
  },
  (table) => [
    index("alert_subscriptions_status_idx").on(table.status),
    index("alert_subscriptions_token_idx").on(table.token),
  ],
);

export type AlertSubscription = typeof alertSubscriptions.$inferSelect;
