/**
 * Postgres connection, resolved once per process and shared.
 *
 * The contract this file exists to preserve: **a missing database is a valid
 * configuration, not an error.** Sighting history and email alerts both degrade
 * to a working feed when `getDb()` returns null, and that is the deployed state
 * until someone provisions a database. Nothing here throws on absence.
 *
 * Serverless-specific settings, all load-bearing:
 *
 *  - `max: 1` — every warm lambda holds its own pool, so a pool per instance
 *    multiplied by instance count is what actually hits Postgres. One is the
 *    only number that scales.
 *  - `prepare: false` — required behind a transaction-mode pooler (PgBouncer,
 *    Supabase's 6543 port, Neon's pooled endpoint). Named prepared statements
 *    do not survive a connection being handed to another client mid-session.
 *  - `idle_timeout` — a frozen lambda holding an open socket is a connection
 *    slot nobody can use. Better to reconnect than to leak.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";

/** @type {ReturnType<typeof drizzle> | null | undefined} */
let cached;

/** Read at call time rather than module scope so tests can set it per case. */
function connectionString() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ""
  );
}

/**
 * The shared database handle, or null when none is configured.
 *
 * @returns {ReturnType<typeof drizzle> | null}
 */
export function getDb() {
  if (cached !== undefined) return cached;

  const url = connectionString();
  if (!url) {
    cached = null;
    return cached;
  }

  try {
    const sql = postgres(url, {
      max: 1,
      prepare: false,
      idle_timeout: 20,
      connect_timeout: 10,
      // Managed Postgres almost universally terminates TLS at the pooler with a
      // certificate the client cannot chain. `require` still encrypts.
      ssl: url.includes("sslmode=disable") ? false : "require",
      onnotice: () => {},
    });
    cached = drizzle(sql, { schema });
  } catch (error) {
    // A malformed URL must not take the site down with it.
    console.error("[db] could not initialise Postgres:", error);
    cached = null;
  }

  return cached;
}

/** Whether a database is configured. Cheap enough to call per request. */
export function databaseConfigured() {
  return getDb() !== null;
}

/**
 * Drop the memoised handle. Only for tests that swap `DATABASE_URL` between
 * cases — production resolves the connection once and keeps it.
 */
export function resetDbForTests() {
  cached = undefined;
}
