import assert from "node:assert/strict";
import test from "node:test";

import {
  DIGEST_INTERVAL_HOURS,
  MAX_DIGEST_JOBS,
  createToken,
  digestDue,
  isValidToken,
  jobMatchesFilters,
  normalizeEmail,
  renderDigestEmail,
  sanitizeFilters,
  selectDigestJobs,
} from "../lib/jobs/alerts.mjs";

const job = (overrides = {}) => ({
  id: "job-1",
  title: "Nurse Residency Program",
  hospital: "Ochsner Health",
  location: "New Orleans, LA",
  state: "LA",
  specialty: "General Residency",
  setting: "Residency",
  pay: 32,
  payLabel: "$32.00–$45.00/hr",
  postedMinutes: 60,
  employerUrl: "https://example.invalid/job",
  firstSeenAt: "2026-08-05T00:00:00.000Z",
  ...overrides,
});

test("accepts ordinary addresses and normalises them", () => {
  assert.equal(normalizeEmail("  Nurse.Grad+alerts@Example.CO.uk "), "nurse.grad+alerts@example.co.uk");
  assert.equal(normalizeEmail("a@b.io"), "a@b.io");
});

test("rejects addresses that are malformed or carry injection payloads", () => {
  const bad = [
    "",
    "not-an-email",
    "@example.com",
    "user@",
    "user@localhost",
    "user name@example.com",
    "user@exa mple.com",
    'user@example.com"; DROP TABLE',
    "user@@example.com",
    "user..name@example.com",
    "<script>@example.com",
    "user@example.com\nBcc: victim@example.com",
    null,
    42,
    `${"a".repeat(250)}@example.com`,
  ];
  for (const value of bad) {
    assert.equal(normalizeEmail(value), null, JSON.stringify(value));
  }
});

test("filters are reduced to known fields only", () => {
  const cleaned = sanitizeFilters({
    state: "LA",
    specialty: "Emergency",
    setting: "Residency",
    minPay: 35,
    residencyOnly: true,
    hideNoSponsor: true,
    // Anything else must not survive into stored state.
    isAdmin: true,
    __proto__: { polluted: true },
    email: "attacker@example.com",
  });
  assert.deepEqual(Object.keys(cleaned).sort(), [
    "hideNoSponsor", "minPay", "residencyOnly", "setting", "specialty", "state",
  ]);
  assert.equal(cleaned.state, "LA");
  assert.equal(cleaned.minPay, 35);
  assert.equal(cleaned.residencyOnly, true);
  assert.equal(cleaned.hideNoSponsor, true);
});

test("nonsense filter values become no filter at all", () => {
  const cleaned = sanitizeFilters({
    state: "", specialty: "x".repeat(500), minPay: -5, residencyOnly: "yes", hideNoSponsor: "1",
  });
  assert.equal(cleaned.state, null);
  assert.equal(cleaned.specialty, null);
  assert.equal(cleaned.minPay, null);
  assert.equal(cleaned.residencyOnly, false, "only a real boolean counts");
  assert.equal(cleaned.hideNoSponsor, false, "only a real boolean counts");
  assert.deepEqual(sanitizeFilters(null), {
    state: null,
    specialty: null,
    setting: null,
    minPay: null,
    residencyOnly: false,
    hideNoSponsor: false,
  });
});

test("a job matches only when every set filter agrees", () => {
  const filters = sanitizeFilters({ state: "LA", specialty: "General Residency", minPay: 30 });
  assert.equal(jobMatchesFilters(job(), filters), true);
  assert.equal(jobMatchesFilters(job({ state: "TX" }), filters), false);
  assert.equal(jobMatchesFilters(job({ specialty: "Emergency" }), filters), false);
  assert.equal(jobMatchesFilters(job({ pay: 20 }), filters), false);
});

test("a pay floor excludes postings that publish no rate", () => {
  // The alternative would email someone a role they explicitly filtered out.
  const filters = sanitizeFilters({ minPay: 30 });
  assert.equal(jobMatchesFilters(job({ pay: null }), filters), false);
  assert.equal(jobMatchesFilters(job({ pay: null }), sanitizeFilters({})), true);
});

test("the sponsorship filter drops only what a posting rules out in writing", () => {
  const filters = sanitizeFilters({ hideNoSponsor: true });

  // The one case it exists for.
  assert.equal(jobMatchesFilters(job({ sponsorship: "excluded" }), filters), false);

  // Everything else survives. Almost every posting is silent on the subject, so
  // treating undocumented as a "no" would empty the digest entirely — the
  // subscriber would conclude nobody is hiring rather than that nobody says.
  for (const status of ["documented", "reported", "unknown", "unchecked", undefined]) {
    assert.equal(
      jobMatchesFilters(job({ sponsorship: status }), filters),
      true,
      `${String(status)} must not be treated as a refusal`,
    );
  }
});

test("residency-only excludes staff roles", () => {
  const filters = sanitizeFilters({ residencyOnly: true });
  assert.equal(jobMatchesFilters(job({ setting: "Residency" }), filters), true);
  assert.equal(jobMatchesFilters(job({ setting: "Staff RN" }), filters), false);
});

test("a digest only carries roles first seen since the last one", () => {
  const jobs = [
    job({ id: "old", firstSeenAt: "2026-08-01T00:00:00.000Z" }),
    job({ id: "new", firstSeenAt: "2026-08-06T00:00:00.000Z" }),
  ];
  const selected = selectDigestJobs(jobs, sanitizeFilters({}), "2026-08-05T00:00:00.000Z");
  assert.deepEqual(
    selected.map((entry) => entry.id),
    ["new"],
    "resending the same roles daily is how an alert becomes spam",
  );
});

test("a first digest sends current matches rather than nothing", () => {
  const jobs = [job({ id: "a" }), job({ id: "b" })];
  const selected = selectDigestJobs(jobs, sanitizeFilters({}), null);
  assert.equal(selected.length, 2);
});

test("a digest is capped and ordered newest first", () => {
  const jobs = Array.from({ length: MAX_DIGEST_JOBS + 8 }, (_, index) =>
    job({ id: `job-${index}`, postedMinutes: 1000 - index, firstSeenAt: null }),
  );
  const selected = selectDigestJobs(jobs, sanitizeFilters({}), null);
  assert.equal(selected.length, MAX_DIGEST_JOBS);
  assert.ok(selected[0].postedMinutes <= selected[1].postedMinutes);
});

test("digests are due at most once per interval, and only when confirmed", () => {
  const now = Date.parse("2026-08-07T12:00:00.000Z");
  assert.equal(digestDue({ status: "confirmed", lastSentAt: null }, now), true);
  assert.equal(digestDue({ status: "confirmed", lastSentAt: "2026-08-07T11:00:00.000Z" }, now), false);
  assert.equal(digestDue({ status: "confirmed", lastSentAt: "2026-08-05T11:00:00.000Z" }, now), true);
  // Unconfirmed addresses must never receive a digest — that is the whole
  // purpose of double opt-in.
  assert.equal(digestDue({ status: "pending", lastSentAt: null }, now), false);
  assert.equal(digestDue({ status: "unsubscribed", lastSentAt: null }, now), false);
  assert.ok(DIGEST_INTERVAL_HOURS >= 1);
});

test("tokens are unguessable-shaped and validated strictly", () => {
  const token = createToken();
  assert.equal(isValidToken(token), true);
  assert.notEqual(createToken(), createToken());
  for (const bad of ["", "abc", token.toUpperCase(), `${token}0`, "../../etc", null, 7]) {
    assert.equal(isValidToken(bad), false, JSON.stringify(bad));
  }
});

test("digest email escapes posting content and carries an unsubscribe link", () => {
  const token = createToken();
  const message = renderDigestEmail(
    [job({ title: '<script>alert("x")</script> Nurse Residency' })],
    { origin: "https://example.invalid", token },
  );
  assert.match(message.subject, /1 new grad nursing role/);
  assert.doesNotMatch(message.html, /<script>alert/, "posting text must not become live markup");
  assert.match(message.html, /&lt;script&gt;/);
  assert.match(message.html, new RegExp(`/api/alerts/unsubscribe\\?token=${token}`));
  assert.match(message.text, /Unsubscribe: https:\/\/example\.invalid/);
});
