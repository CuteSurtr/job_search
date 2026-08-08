import assert from "node:assert/strict";
import test from "node:test";

import {
  SPONSORSHIP_CHECKED,
  SPONSORSHIP_LABELS,
  SPONSORSHIP_RECORDS,
  employerSponsorship,
  resolveSponsorship,
  sponsorshipRecord,
} from "../lib/content/sponsorship.mjs";
import { sponsorshipFromText } from "../lib/jobs/matching.mjs";
import { SOURCES_BY_KEY } from "../lib/jobs/sources.mjs";

/**
 * Sponsorship is the one claim on this site where being wrong costs a reader
 * something irreversible: nursing OPT is twelve months with no STEM extension,
 * and an application sent to an employer that was never going to sponsor is a
 * slice of that runway gone. These assertions are the guard against a future
 * edit quietly upgrading a guess into a claim.
 */

const CITED = new Set(["documented", "reported", "excluded"]);

test("every claim carries the evidence it rests on", () => {
  for (const record of SPONSORSHIP_RECORDS) {
    assert.ok(SPONSORSHIP_LABELS[record.status], `${record.sourceKey} has an unknown status`);
    assert.equal(typeof record.note, "string");
    assert.ok(record.note.trim().length > 0, `${record.sourceKey} needs a note`);

    if (CITED.has(record.status)) {
      assert.equal(typeof record.source, "string", `${record.sourceKey} is a claim and needs a source`);
      assert.ok(record.source.trim().length > 0, `${record.sourceKey}.source is empty`);
      assert.match(record.sourceUrl ?? "", /^https:\/\//, `${record.sourceKey} must link to its evidence`);
    }
  }
});

test("an unknown record cites nothing, because there is nothing to cite", () => {
  for (const record of SPONSORSHIP_RECORDS.filter((r) => r.status === "unknown")) {
    assert.equal(record.source, undefined, `${record.sourceKey} is unknown but names a source`);
    assert.equal(record.sourceUrl, undefined, `${record.sourceKey} is unknown but links somewhere`);
  }
});

test("claims cite the employer or a primary source, never a jobs blog", () => {
  // Aggregators assert that a given hospital sponsors and cite nothing. That is
  // exactly the material this registry exists to keep off the page.
  const aggregators =
    /visamadeez|f1jobs|migratemate|ziprecruiter|indeed\.com|glassdoor|nursingmanthra|corptocorp|globalnurseguide|simplyhired|talent\.com|dynamichealthstaff/i;
  for (const record of SPONSORSHIP_RECORDS) {
    if (!record.sourceUrl) continue;
    assert.doesNotMatch(
      record.sourceUrl,
      aggregators,
      `${record.sourceKey} cites an aggregator rather than the employer or a primary source`,
    );
  }
});

test("every record names an employer we actually poll", () => {
  for (const record of SPONSORSHIP_RECORDS) {
    assert.ok(SOURCES_BY_KEY.has(record.sourceKey), `${record.sourceKey} is not in the source registry`);
  }
  const keys = SPONSORSHIP_RECORDS.map((r) => r.sourceKey);
  assert.equal(new Set(keys).size, keys.length, "duplicate sponsorship record");
});

test("the checked date is recorded", () => {
  assert.match(SPONSORSHIP_CHECKED, /\d{4}/);
});

/**
 * The distinction the whole file turns on. "We looked and found nothing" and
 * "nobody looked" are different things to tell a job hunter, and collapsing
 * them would let silence read as diligence.
 */
test("unchecked and unknown stay distinct", () => {
  assert.equal(employerSponsorship("massgeneralbrigham"), "unknown", "checked, nothing published");
  assert.equal(employerSponsorship("ochsner"), "unchecked", "no entry means nobody looked");
  assert.equal(sponsorshipRecord("ochsner"), null);
  assert.ok(SPONSORSHIP_LABELS.unknown.detail.length > 0);
  assert.ok(SPONSORSHIP_LABELS.unchecked.detail.length > 0);
  assert.notEqual(SPONSORSHIP_LABELS.unknown.label, SPONSORSHIP_LABELS.unchecked.label);
});

/* ------------------------------------------------- posting-text classifier -- */

test("an exclusion is recognised however it is phrased", () => {
  const phrasings = [
    "Applicants must be authorized to work for any employer in the U.S. We are unable to sponsor or take over sponsorship of an employment visa.",
    "This position is not eligible for visa sponsorship.",
    "Candidates must be able to work without current or future sponsorship.",
    "No visa sponsorship is offered for this role.",
    "Sponsorship is not available for this position.",
    "The organization does not sponsor employment visas.",
    "Must be legally authorized to work in the United States without the need for sponsorship.",
  ];
  for (const text of phrasings) {
    assert.equal(sponsorshipFromText(text), "excluded", `missed exclusion: ${text.slice(0, 56)}`);
  }
});

/**
 * The ordering bug worth a test of its own. "Authorized to work without
 * sponsorship" contains the word, so a positive matcher running first would
 * read a refusal as an offer — and send someone to apply for a job that had
 * already ruled them out.
 */
test("wording that contains 'sponsorship' while refusing it is never read as an offer", () => {
  const refusals = [
    "Must be authorized to work without sponsorship, now or in the future.",
    "Visa sponsorship is not available; sponsorship will not be provided.",
    "We are unable to provide sponsorship for this role.",
  ];
  for (const text of refusals) {
    assert.notEqual(sponsorshipFromText(text), "documented", `read a refusal as an offer: ${text.slice(0, 50)}`);
    assert.equal(sponsorshipFromText(text), "excluded");
  }
});

test("an explicit offer is recognised", () => {
  const offers = [
    "We will sponsor qualified international nurses for EB-3 immigrant visas.",
    "Visa sponsorship is available for this position.",
    "Employment sponsorship is provided for eligible candidates.",
    "The health system can sponsor candidates requiring work authorization.",
  ];
  for (const text of offers) {
    assert.equal(sponsorshipFromText(text), "documented", `missed offer: ${text.slice(0, 56)}`);
  }
});

test("silence stays silence rather than becoming a position", () => {
  const silent = [
    "New graduate RN residency, medical-surgical unit, day shift.",
    "BSN required. Must hold or be eligible for a Louisiana RN license.",
    "Competitive pay, relocation assistance and a $10,000 sign-on bonus.",
    "",
    null,
    undefined,
  ];
  for (const text of silent) {
    assert.equal(sponsorshipFromText(text), null, `invented a position from: ${String(text).slice(0, 50)}`);
  }
});

/* ------------------------------------------------------------- resolution -- */

test("a posting that rules sponsorship out overrides a friendlier employer record", () => {
  // The posting is newer, specific to this requisition, and the employer's own
  // words. It has to win.
  assert.equal(resolveSponsorship("excluded", "massgeneralbrigham"), "excluded");
  assert.equal(resolveSponsorship("excluded", "ochsner"), "excluded");
});

test("a posting naming sponsorship surfaces even with no employer record", () => {
  assert.equal(resolveSponsorship("documented", "ochsner"), "documented");
});

test("a silent posting falls back to the employer record", () => {
  assert.equal(resolveSponsorship(null, "massgeneralbrigham"), "unknown");
  assert.equal(resolveSponsorship(null, "ochsner"), "unchecked");
});

test("nothing is inferred from employer size, prestige or state", () => {
  // Every entry in the registry today is `unknown`, and that is correct: no
  // employer we poll publishes a sponsorship position. If a future edit adds a
  // `documented` record, the citation tests above are what it has to satisfy.
  for (const record of SPONSORSHIP_RECORDS) {
    if (record.status === "documented" || record.status === "reported") {
      assert.ok(
        record.sourceUrl,
        `${record.sourceKey} claims sponsorship without a link to where it says so`,
      );
    }
  }
});
