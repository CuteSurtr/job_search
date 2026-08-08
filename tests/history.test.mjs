import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";
import { drizzle } from "drizzle-orm/d1";

import { jobSightings } from "../db/schema.ts";
import {
  D1_MAX_VARIABLES,
  INSERT_CHUNK,
  SELECT_CHUNK,
  SIGHTING_COLUMNS,
  ageMinutes,
  recordSightingWith,
} from "../lib/jobs/history.mjs";

/**
 * Minimal D1 surface over node:sqlite — prepare/bind/run/all plus batch, which
 * is everything drizzle's D1 driver calls. Lets the real migration and the real
 * queries run offline.
 */
function fakeD1(sqlite) {
  const exec = (sql, params) => sqlite.prepare(sql).all(...params);
  const statement = (sql, params = []) => ({
    async run() {
      sqlite.prepare(sql).run(...params);
      return { success: true, meta: {} };
    },
    async all() {
      return { results: exec(sql, params), success: true, meta: {} };
    },
    async first() {
      return exec(sql, params)[0] ?? null;
    },
    async raw() {
      return exec(sql, params).map((row) => Object.values(row));
    },
  });

  return {
    prepare(sql) {
      return { ...statement(sql), bind: (...params) => statement(sql, params) };
    },
    async batch(statements) {
      const out = [];
      for (const item of statements) out.push(await item.all());
      return out;
    },
  };
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const migration = readFileSync(new URL("../drizzle/0000_glorious_bug.sql", import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) sqlite.exec(trimmed);
  }
  return { sqlite, db: drizzle(fakeD1(sqlite), { schema: { jobSightings } }) };
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

const rows = (sqlite) =>
  Object.fromEntries(
    sqlite
      .prepare("select id, first_seen_at, last_seen_at, closed_at, title from job_sightings")
      .all()
      .map((row) => [row.id, row]),
  );

test("a first scan records every posting as newly seen and open", async () => {
  const { sqlite, db } = freshDb();
  const firstSeen = await recordSightingWith(db, [job("a"), job("b")], "2026-08-01T10:00:00.000Z");

  const stored = rows(sqlite);
  assert.equal(Object.keys(stored).length, 2);
  assert.equal(stored.a.first_seen_at, "2026-08-01T10:00:00.000Z");
  assert.equal(stored.a.closed_at, null);
  assert.equal(firstSeen.get("a"), "2026-08-01T10:00:00.000Z");
});

test("a later scan advances last-seen but never rewrites first-seen", async () => {
  const { sqlite, db } = freshDb();
  await recordSightingWith(db, [job("a")], "2026-08-01T10:00:00.000Z");
  const firstSeen = await recordSightingWith(db, [job("a")], "2026-08-05T10:00:00.000Z");

  const stored = rows(sqlite);
  // This is the entire point of the table: the original sighting must survive.
  assert.equal(stored.a.first_seen_at, "2026-08-01T10:00:00.000Z");
  assert.equal(stored.a.last_seen_at, "2026-08-05T10:00:00.000Z");
  assert.equal(firstSeen.get("a"), "2026-08-01T10:00:00.000Z");
});

test("a posting that stops appearing is marked closed", async () => {
  const { sqlite, db } = freshDb();
  await recordSightingWith(db, [job("a"), job("b")], "2026-08-01T10:00:00.000Z");
  await recordSightingWith(db, [job("a")], "2026-08-02T10:00:00.000Z");

  const stored = rows(sqlite);
  assert.equal(stored.a.closed_at, null, "still listed");
  assert.equal(stored.b.closed_at, "2026-08-02T10:00:00.000Z", "no longer listed");
});

test("a reposted role reopens instead of staying closed", async () => {
  const { sqlite, db } = freshDb();
  await recordSightingWith(db, [job("a"), job("b")], "2026-08-01T10:00:00.000Z");
  await recordSightingWith(db, [job("a")], "2026-08-02T10:00:00.000Z");
  await recordSightingWith(db, [job("a"), job("b")], "2026-08-03T10:00:00.000Z");

  const stored = rows(sqlite);
  assert.equal(stored.b.closed_at, null);
  assert.equal(stored.b.first_seen_at, "2026-08-01T10:00:00.000Z", "original sighting preserved");
});

test("an employer that did not respond does not have its roles closed", async () => {
  const { sqlite, db } = freshDb();
  await recordSightingWith(
    db,
    [job("a", { sourceKey: "ochsner" }), job("b", { sourceKey: "sentara" })],
    "2026-08-01T10:00:00.000Z",
  );
  // Sentara is missing from this scan entirely — an outage, not a closed role.
  await recordSightingWith(db, [job("a", { sourceKey: "ochsner" })], "2026-08-02T10:00:00.000Z");

  const stored = rows(sqlite);
  assert.equal(stored.b.closed_at, null, "an unreachable source must not mass-close its listings");
});

test("changed posting details are refreshed on re-sighting", async () => {
  const { sqlite, db } = freshDb();
  await recordSightingWith(db, [job("a", { title: "Old title" })], "2026-08-01T10:00:00.000Z");
  await recordSightingWith(db, [job("a", { title: "New title" })], "2026-08-02T10:00:00.000Z");

  assert.equal(rows(sqlite).a.title, "New title");
});

test("batches stay under D1's bound-variable ceiling", () => {
  // Local SQLite allows ~32k variables, so an oversized batch passes every test
  // above and only fails in production with "D1_ERROR: too many SQL variables".
  // That is exactly what happened at 60 rows per insert (600 variables).
  const insertParams = INSERT_CHUNK * SIGHTING_COLUMNS + 2;
  assert.ok(
    insertParams <= D1_MAX_VARIABLES,
    `insert batch binds ${insertParams} variables, over D1's ${D1_MAX_VARIABLES}`,
  );
  assert.ok(SELECT_CHUNK <= D1_MAX_VARIABLES, "select batch binds one variable per id");
  assert.ok(INSERT_CHUNK >= 1 && SELECT_CHUNK >= 1);
});

test("a scan larger than one batch still records every posting", async () => {
  const { sqlite, db } = freshDb();
  const many = Array.from({ length: INSERT_CHUNK * 3 + 1 }, (_, index) => job(`job-${index}`));
  const firstSeen = await recordSightingWith(db, many, "2026-08-01T10:00:00.000Z");

  assert.notEqual(firstSeen, null, "a multi-batch scan must not fail");
  assert.equal(Object.keys(rows(sqlite)).length, many.length);
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
