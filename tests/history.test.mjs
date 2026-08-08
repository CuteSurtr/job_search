import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { jobSightings } from "../db/schema.ts";
import {
  INSERT_CHUNK,
  MAX_BIND_PARAMS,
  SELECT_CHUNK,
  SIGHTING_COLUMNS,
  ageMinutes,
  recordSightingWith,
} from "../lib/jobs/history.mjs";

/**
 * These run against PGlite — a real Postgres compiled to WASM, in-process and
 * offline. That matters more than it sounds: this suite previously ran on
 * SQLite while production ran D1, and the semantics being asserted here (upsert
 * preserving first_seen_at, timestamptz comparison in closeMissing, `excluded.`
 * references) are exactly the kind that differ between dialects. Now the test
 * dialect and the deployed dialect are the same one.
 */

const MIGRATIONS = fileURLToPath(new URL("../drizzle/", import.meta.url));

/** Read whatever drizzle-kit generated, so regenerating does not break this. */
function migrationSql() {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "no migration found in drizzle/");
  return files.map((name) => readFileSync(path.join(MIGRATIONS, name), "utf8")).join("\n");
}

async function freshDb() {
  const client = new PGlite();
  await client.waitReady;
  for (const statement of migrationSql().split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await client.exec(trimmed);
  }
  return { client, db: drizzle(client, { schema: { jobSightings } }) };
}

const job = (id, overrides = {}) => ({
  id,
  sourceKey: "ochsner",
  title: `Nurse Residency ${id}`,
  hospital: "Ochsner Health",
  state: "LA",
  specialty: "General Residency",
  employerUrl: `https://example.invalid/${id}`,
  postedMinutes: 100,
  ...overrides,
});

/** Timestamps come back as Date objects; compare them as ISO strings. */
const iso = (value) => (value instanceof Date ? value.toISOString() : value);

async function rows(client) {
  const result = await client.query(
    "select id, first_seen_at, last_seen_at, closed_at, title from job_sightings",
  );
  return Object.fromEntries(
    result.rows.map((row) => [
      row.id,
      {
        ...row,
        first_seen_at: iso(row.first_seen_at),
        last_seen_at: iso(row.last_seen_at),
        closed_at: iso(row.closed_at),
      },
    ]),
  );
}

test("a first scan records every posting as newly seen and open", async () => {
  const { client, db } = await freshDb();
  const firstSeen = await recordSightingWith(db, [job("a"), job("b")], "2026-08-01T10:00:00.000Z");

  const stored = await rows(client);
  assert.equal(Object.keys(stored).length, 2);
  assert.equal(stored.a.first_seen_at, "2026-08-01T10:00:00.000Z");
  assert.equal(stored.a.closed_at, null);
  assert.equal(firstSeen.get("a"), "2026-08-01T10:00:00.000Z");
});

test("a later scan advances last-seen but never rewrites first-seen", async () => {
  const { client, db } = await freshDb();
  await recordSightingWith(db, [job("a")], "2026-08-01T10:00:00.000Z");
  const firstSeen = await recordSightingWith(db, [job("a")], "2026-08-05T10:00:00.000Z");

  const stored = await rows(client);
  // This is the entire point of the table: the original sighting must survive.
  assert.equal(stored.a.first_seen_at, "2026-08-01T10:00:00.000Z");
  assert.equal(stored.a.last_seen_at, "2026-08-05T10:00:00.000Z");
  assert.equal(firstSeen.get("a"), "2026-08-01T10:00:00.000Z");
});

test("a posting that stops appearing is marked closed", async () => {
  const { client, db } = await freshDb();
  await recordSightingWith(db, [job("a"), job("b")], "2026-08-01T10:00:00.000Z");
  await recordSightingWith(db, [job("a")], "2026-08-02T10:00:00.000Z");

  const stored = await rows(client);
  assert.equal(stored.a.closed_at, null, "still listed");
  assert.equal(stored.b.closed_at, "2026-08-02T10:00:00.000Z", "no longer listed");
});

test("a reposted role reopens instead of staying closed", async () => {
  const { client, db } = await freshDb();
  await recordSightingWith(db, [job("a"), job("b")], "2026-08-01T10:00:00.000Z");
  await recordSightingWith(db, [job("a")], "2026-08-02T10:00:00.000Z");
  await recordSightingWith(db, [job("a"), job("b")], "2026-08-03T10:00:00.000Z");

  const stored = await rows(client);
  assert.equal(stored.b.closed_at, null);
  assert.equal(stored.b.first_seen_at, "2026-08-01T10:00:00.000Z", "original sighting preserved");
});

test("an employer that did not respond does not have its roles closed", async () => {
  const { client, db } = await freshDb();
  await recordSightingWith(
    db,
    [job("a", { sourceKey: "ochsner" }), job("b", { sourceKey: "sentara" })],
    "2026-08-01T10:00:00.000Z",
  );
  // Sentara is missing from this scan entirely — an outage, not a closed role.
  await recordSightingWith(db, [job("a", { sourceKey: "ochsner" })], "2026-08-02T10:00:00.000Z");

  const stored = await rows(client);
  assert.equal(stored.b.closed_at, null, "an unreachable source must not mass-close its listings");
});

test("changed posting details are refreshed on re-sighting", async () => {
  const { client, db } = await freshDb();
  await recordSightingWith(db, [job("a", { title: "Old title" })], "2026-08-01T10:00:00.000Z");
  await recordSightingWith(db, [job("a", { title: "New title" })], "2026-08-02T10:00:00.000Z");

  assert.equal((await rows(client)).a.title, "New title");
});

test("batches stay well inside Postgres's bound-parameter ceiling", () => {
  // Postgres allows 65535 parameters per statement, so unlike D1's ceiling of
  // 100 this is not a cliff the batch sizes are pressed up against. The
  // assertion is kept because the chunking still exists — a future edit that
  // raises INSERT_CHUNK into the thousands should have to notice this.
  const insertParams = INSERT_CHUNK * SIGHTING_COLUMNS;
  assert.ok(
    insertParams <= MAX_BIND_PARAMS,
    `insert batch binds ${insertParams} parameters, over Postgres's ${MAX_BIND_PARAMS}`,
  );
  assert.ok(SELECT_CHUNK <= MAX_BIND_PARAMS, "select batch binds one parameter per id");
  assert.ok(INSERT_CHUNK >= 1 && SELECT_CHUNK >= 1);
});

test("a scan larger than one batch still records every posting", async () => {
  const { client, db } = await freshDb();
  const many = Array.from({ length: INSERT_CHUNK * 2 + 1 }, (_, index) => job(`job-${index}`));
  const firstSeen = await recordSightingWith(db, many, "2026-08-01T10:00:00.000Z");

  assert.notEqual(firstSeen, null, "a multi-batch scan must not fail");
  assert.equal(Object.keys(await rows(client)).length, many.length);
  assert.equal(firstSeen.size, many.length);
});

test("posting age takes the older of our record and the employer's", async () => {
  const now = Date.parse("2026-08-07T12:00:00.000Z");

  // Seen an hour ago, but the employer says it is 30+ days old — believe them.
  assert.equal(ageMinutes("2026-08-07T11:00:00.000Z", 30 * 24 * 60, now), 30 * 24 * 60);

  // Watched for three days while the employer still claims "today" — believe us.
  assert.equal(ageMinutes("2026-08-04T12:00:00.000Z", 0, now), 3 * 24 * 60);

  // No record at all falls back to the employer's figure.
  assert.equal(ageMinutes(undefined, 240, now), 240);
  assert.equal(ageMinutes("not-a-date", 240, now), 240);
});
