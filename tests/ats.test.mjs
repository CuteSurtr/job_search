import assert from "node:assert/strict";
import test from "node:test";

import { employerUrlFor, isValidPathFor } from "../lib/jobs/ats.mjs";
import {
  ORACLE_PAGE_SIZE,
  isValidOraclePath,
  normalizeOracleDetail,
  normalizeOracleSearch,
  oracleEmployerUrl,
  oracleSearchUrl,
  postedLabelFromDate,
} from "../lib/jobs/oracle.mjs";
import { COVERED_STATES, SOURCES, SOURCES_BY_KEY } from "../lib/jobs/sources.mjs";
import { ACCEPT_LANGUAGE } from "../lib/jobs/workday.mjs";
import { US_STATES, normalizeLocation, postedMinutes } from "../lib/jobs/matching.mjs";

/**
 * The second ATS adapter, exercised offline against captured payload shapes.
 *
 * The parts worth pinning are the ones where the two systems disagree: path
 * validation, URL construction, and the ISO-date-to-prose normalisation that
 * lets one age path serve both.
 */

const providence = SOURCES_BY_KEY.get("providence");
const ochsner = SOURCES_BY_KEY.get("ochsner");

test("every registry entry declares an ats, defaulting to workday", () => {
  for (const source of SOURCES) {
    assert.ok(
      source.ats === "workday" || source.ats === "oracle",
      `${source.key} has an unknown ats: ${source.ats}`,
    );
  }
  assert.equal(ochsner.ats, "workday", "an entry with no explicit ats is Workday");
  assert.equal(providence.ats, "oracle");
});

test("oracle entries carry a site number and no workday tenant", () => {
  for (const source of SOURCES.filter((entry) => entry.ats === "oracle")) {
    assert.match(source.site, /^CX_\d+$/, `${source.key} needs a CX site number`);
    assert.equal(source.tenant, undefined, `${source.key} should not declare a Workday tenant`);
  }
});

test("workday entries all still carry a tenant", () => {
  for (const source of SOURCES.filter((entry) => entry.ats === "workday")) {
    assert.ok(source.tenant, `${source.key} is missing its Workday tenant`);
  }
});

/**
 * The whole point of the adapter. Five states had no polled employer before it;
 * a regression here silently returns the site to "we do not cover you".
 */
test("all 50 states and DC now have at least one polled employer", () => {
  const missing = US_STATES.filter((state) => !COVERED_STATES.includes(state.code));
  assert.deepEqual(missing, [], `uncovered: ${missing.map((s) => s.code).join(", ")}`);
  assert.equal(COVERED_STATES.length, 51);
});

test("the five formerly uncovered states each resolve to a named employer", () => {
  const expected = {
    AK: "Providence",
    AL: "Southeast Health",
    HI: "Adventist Health",
    WV: "WVU Medicine",
    DC: "Children’s National Hospital",
  };
  for (const [code, name] of Object.entries(expected)) {
    const employers = SOURCES.filter((source) => source.states.includes(code)).map((s) => s.name);
    assert.ok(employers.includes(name), `${code} should be covered by ${name}, got ${employers}`);
  }
});

test("source keys and accents stay unique", () => {
  const keys = SOURCES.map((source) => source.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate source key");

  // AdventHealth and Adventist Health are different organisations. Colliding
  // their accents would make two unrelated employers indistinguishable.
  const advent = SOURCES.filter((source) => source.key.startsWith("advent"));
  assert.equal(new Set(advent.map((s) => s.accent)).size, advent.length);
});

test("path validation is per-ATS, not shared", () => {
  // A Workday path is free-form text; the same string must be refused for an
  // Oracle source, whose ids are numeric.
  const workdayPath = "/job/Orlando-FL/Nurse-Residency_25012345";
  assert.equal(isValidPathFor(ochsner, workdayPath), true);
  assert.equal(isValidPathFor(providence, workdayPath), false);

  const oraclePath = "/job/449337";
  assert.equal(isValidPathFor(providence, oraclePath), true);
});

test("oracle path validation refuses anything that could escape the finder argument", () => {
  const hostile = [
    '/job/449337"',
    "/job/449337,siteNumber=CX_2",
    "/job/449337;x=1",
    "/job/../../admin",
    "/job/abc",
    "/job/",
    "/job/12345678901234567",
    "",
    null,
    undefined,
  ];
  for (const path of hostile) {
    assert.equal(isValidOraclePath(path), false, `should reject ${JSON.stringify(path)}`);
  }
});

test("employer URLs are built per-ATS", () => {
  assert.equal(
    employerUrlFor(ochsner, "/job/Jefferson-LA/Nurse-Residency_REQ1"),
    "https://ochsner.wd1.myworkdayjobs.com/Ochsner/job/Jefferson-LA/Nurse-Residency_REQ1",
  );
  assert.equal(
    employerUrlFor(providence, "/job/449337"),
    "https://evac.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/449337",
  );
  assert.equal(oracleEmployerUrl(providence, "/job/1"), employerUrlFor(providence, "/job/1"));
});

test("oracle search URL encodes the keyword so it cannot terminate the finder", () => {
  const url = oracleSearchUrl(providence, "nurse residency", 0);
  assert.ok(url.includes("keyword=nurse%20residency"));
  assert.ok(url.includes("siteNumber=CX_1"));
  assert.ok(url.includes(`limit=${ORACLE_PAGE_SIZE}`));

  // A separator inside the search text must not reach the server raw.
  const hostile = oracleSearchUrl(providence, "a,siteNumber=CX_9;b", 0);
  assert.ok(!hostile.includes("a,siteNumber=CX_9;b"));
  assert.ok(hostile.includes("keyword=a%2CsiteNumber%3DCX_9%3Bb"));
});

test("oracle search offset paging uses the page size", () => {
  assert.ok(oracleSearchUrl(providence, "nurse", 0).includes("offset=0"));
  assert.ok(oracleSearchUrl(providence, "nurse", 50).includes("offset=50"));
});

test("posted dates normalise into the prose postedMinutes already parses", () => {
  const now = Date.parse("2026-08-07T15:00:00Z");

  assert.equal(postedLabelFromDate("2026-08-07", now), "Posted Today");
  assert.equal(postedLabelFromDate("2026-08-06", now), "Posted Yesterday");
  assert.equal(postedLabelFromDate("2026-07-28", now), "Posted 10 Days Ago");

  // A tenant clock ahead of ours must not produce a negative age.
  assert.equal(postedLabelFromDate("2026-08-09", now), "Posted Today");

  // Unusable input sorts to the back rather than masquerading as fresh.
  assert.equal(postedLabelFromDate(null, now), "Recently posted");
  assert.equal(postedLabelFromDate("not-a-date", now), "Recently posted");

  // The round trip is what matters: the label has to survive postedMinutes.
  assert.equal(postedMinutes(postedLabelFromDate("2026-08-07", now)), 0);
  assert.equal(postedMinutes(postedLabelFromDate("2026-08-06", now)), 24 * 60);
  assert.equal(postedMinutes(postedLabelFromDate("2026-07-28", now)), 10 * 24 * 60);
});

test("oracle search payload maps onto the workday posting shape", () => {
  const now = Date.parse("2026-08-07T15:00:00Z");
  const { total, postings } = normalizeOracleSearch(
    {
      items: [
        {
          TotalJobsCount: 64,
          requisitionList: [
            {
              Id: "449337",
              Title: "RN Residency - Med/Surg",
              PostedDate: "2026-08-06",
              PrimaryLocation: "Seward, AK, United States",
            },
            // Incomplete records are dropped rather than rendered as blanks.
            { Id: null, Title: "Broken" },
            { Id: "1", Title: null },
          ],
        },
      ],
    },
    now,
  );

  assert.equal(total, 64);
  assert.equal(postings.length, 1);
  assert.deepEqual(postings[0], {
    title: "RN Residency - Med/Surg",
    externalPath: "/job/449337",
    locationsText: "Seward, AK, United States",
    postedOn: "Posted Yesterday",
    bulletFields: ["449337"],
  });

  // The path it produced must pass its own validator.
  assert.equal(isValidPathFor(providence, postings[0].externalPath), true);
});

test("an empty or malformed oracle payload yields nothing rather than throwing", () => {
  assert.deepEqual(normalizeOracleSearch({}), { total: 0, postings: [] });
  assert.deepEqual(normalizeOracleSearch({ items: [] }), { total: 0, postings: [] });
  assert.deepEqual(normalizeOracleSearch({ items: [{}] }), { total: 0, postings: [] });
});

/**
 * Oracle reports `City, ST` on every posting, which is the reason these two
 * multi-state employers can be placed on the map at all — the Workday footprint
 * fallback deliberately refuses to guess for multi-state sources.
 */
test("oracle locations place a multi-state employer without the footprint fallback", () => {
  assert.ok(providence.states.length > 1, "Providence is multi-state");
  for (const [raw, code] of [
    ["Seward, AK, United States", "AK"],
    ["Missoula, MT, United States", "MT"],
    ["Kailua, HI, United States", "HI"],
  ]) {
    assert.equal(normalizeLocation(raw, providence.name).state, code);
  }
});

test("oracle detail maps onto the shared detail shape and joins its description blocks", () => {
  const detail = normalizeOracleDetail(
    {
      items: [
        {
          Id: "449337",
          Title: "RN Residency",
          PrimaryLocation: "Seward, AK, United States",
          ExternalPostedStartDate: "2026-08-06T00:00:00+00:00",
          JobSchedule: "Full time",
          ExternalDescriptionStr: "<p>Body</p>",
          ExternalQualificationsStr: "<p>Quals</p>",
        },
      ],
    },
    providence,
    "/job/449337",
    Date.parse("2026-08-07T15:00:00Z"),
  );

  assert.equal(detail.title, "RN Residency");
  assert.equal(detail.location, "Seward, AK, United States");
  assert.equal(detail.timeType, "Full time");
  assert.equal(detail.postedOn, "Posted Yesterday");
  assert.equal(detail.jobDescription, "<p>Body</p>\n<p>Quals</p>");
  assert.equal(
    detail.externalUrl,
    "https://evac.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/449337",
  );
});

test("oracle detail returns null when the requisition is gone", () => {
  assert.equal(normalizeOracleDetail({}, providence, "/job/1"), null);
  assert.equal(normalizeOracleDetail({ items: [] }, providence, "/job/1"), null);
});

/**
 * Regression guard. Node's fetch defaults `Accept-Language` to `*`, and at
 * least one tenant's WAF (WVU Medicine) answers that with an opaque HTTP 500 —
 * costing an entire state's coverage while every other employer keeps working.
 * The header looks like noise and is not.
 */
test("a concrete Accept-Language is sent, never undici's `*` default", () => {
  assert.notEqual(ACCEPT_LANGUAGE, "*", "`*` is the value that trips the WAF");
  assert.match(ACCEPT_LANGUAGE, /^[a-z]{2}(-[A-Z]{2})?(,|$)/, "must name a real language");
});

test("both ATS clients send that header on every upstream call", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(new Headers(init?.headers).get("accept-language"));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const budget = { spend: () => true, remaining: () => 10, expired: () => false };
    const { fetchAllPostings } = await import("../lib/jobs/workday.mjs");
    const { fetchAllOraclePostings, fetchOracleDetail } = await import("../lib/jobs/oracle.mjs");

    await fetchAllPostings(ochsner, "nurse residency", { budget, maxPages: 1 });
    await fetchAllOraclePostings(providence, "nurse residency", { budget, maxPages: 1 });
    await fetchOracleDetail(providence, "/job/1", budget);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(seen.length >= 3, `expected upstream calls, saw ${seen.length}`);
  for (const value of seen) {
    assert.equal(value, ACCEPT_LANGUAGE, "an upstream call went out without the header");
  }
});
