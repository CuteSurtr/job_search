/**
 * D1-backed storage for alert subscriptions.
 *
 * Unlike sighting history, these operations are not best-effort: a subscriber
 * who is told "check your inbox" when nothing was stored has been lied to. So
 * failures here surface to the caller and the route reports them honestly.
 */

import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { alertSubscriptions } from "../../db/schema.ts";

let envPromise = null;

async function getWorkerEnv() {
  if (!envPromise) {
    envPromise = import("cloudflare:workers")
      .then((module) => module.env ?? null)
      .catch(() => null);
  }
  return envPromise;
}

/** @returns {Promise<import("drizzle-orm/d1").DrizzleD1Database<any> | null>} */
export async function getSubscriptionDb() {
  try {
    const env = await getWorkerEnv();
    if (!env?.DB) return null;
    return drizzle(env.DB, { schema: { alertSubscriptions } });
  } catch {
    return null;
  }
}

/**
 * Create or update a pending subscription for an address.
 *
 * Re-subscribing an existing address rotates its token and returns it to
 * pending, which doubles as the recovery path for a lost confirmation link. It
 * deliberately reveals nothing to the caller about whether the address already
 * existed.
 *
 * @param {import("drizzle-orm/d1").DrizzleD1Database<any>} db
 * @param {{ id: string, email: string, filters: object, token: string }} input
 */
export async function upsertPending(db, { id, email, filters, token }) {
  await db
    .insert(alertSubscriptions)
    .values({
      id,
      email,
      filters: JSON.stringify(filters),
      token,
      status: "pending",
      confirmedAt: null,
      lastSentAt: null,
    })
    .onConflictDoUpdate({
      target: alertSubscriptions.email,
      set: {
        filters: sql`excluded.filters`,
        token: sql`excluded.token`,
        status: "pending",
        confirmedAt: null,
      },
    });
}

/**
 * @param {import("drizzle-orm/d1").DrizzleD1Database<any>} db
 * @param {string} token
 */
export async function confirmByToken(db, token) {
  const rows = await db
    .update(alertSubscriptions)
    .set({ status: "confirmed", confirmedAt: new Date().toISOString() })
    .where(and(eq(alertSubscriptions.token, token), eq(alertSubscriptions.status, "pending")))
    .returning({ email: alertSubscriptions.email });
  return rows.length > 0;
}

/**
 * @param {import("drizzle-orm/d1").DrizzleD1Database<any>} db
 * @param {string} token
 */
export async function unsubscribeByToken(db, token) {
  const rows = await db
    .update(alertSubscriptions)
    .set({ status: "unsubscribed" })
    .where(eq(alertSubscriptions.token, token))
    .returning({ email: alertSubscriptions.email });
  return rows.length > 0;
}

/**
 * Confirmed subscribers only. Capped because a digest run piggybacks on a
 * visitor request and must stay bounded.
 *
 * @param {import("drizzle-orm/d1").DrizzleD1Database<any>} db
 * @param {number} limit
 */
export async function listConfirmed(db, limit = 50) {
  return db
    .select({
      id: alertSubscriptions.id,
      email: alertSubscriptions.email,
      filters: alertSubscriptions.filters,
      token: alertSubscriptions.token,
      status: alertSubscriptions.status,
      lastSentAt: alertSubscriptions.lastSentAt,
    })
    .from(alertSubscriptions)
    .where(eq(alertSubscriptions.status, "confirmed"))
    .limit(limit);
}

/**
 * @param {import("drizzle-orm/d1").DrizzleD1Database<any>} db
 * @param {string} id
 * @param {string} sentAt
 */
export async function markSent(db, id, sentAt) {
  await db
    .update(alertSubscriptions)
    .set({ lastSentAt: sentAt })
    .where(eq(alertSubscriptions.id, id));
}
