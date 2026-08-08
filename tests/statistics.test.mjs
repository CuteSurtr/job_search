import assert from "node:assert/strict";
import test from "node:test";

import { HIRING_STATISTICS, STATISTICS_RETRIEVED } from "../lib/content/statistics.mjs";

/**
 * These figures are transcribed from outside reports rather than scraped, so
 * nothing in the running system can notice when one goes stale or loses its
 * attribution. These assertions are the only guard against a future edit
 * quietly publishing an unsourced number.
 */

test("every statistic is attributed, dated, and linkable", () => {
  assert.ok(HIRING_STATISTICS.length > 0);
  for (const stat of HIRING_STATISTICS) {
    for (const field of ["id", "value", "label", "detail", "source", "sourceUrl", "period"]) {
      assert.equal(typeof stat[field], "string", `${stat.id}.${field} must be a string`);
      assert.ok(stat[field].trim().length > 0, `${stat.id}.${field} is empty`);
    }
    // An unsourced statistic on a public page is worse than no statistic.
    assert.match(stat.sourceUrl, /^https:\/\//, `${stat.id} must link to its source over https`);
    assert.match(stat.period, /\d{4}/, `${stat.id}.period must name a year`);
    assert.ok(stat.source.length > 8, `${stat.id}.source should name the publisher, not abbreviate it`);
  }
});

test("statistic ids are unique", () => {
  const ids = HIRING_STATISTICS.map((stat) => stat.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("values read as figures rather than prose", () => {
  for (const stat of HIRING_STATISTICS) {
    assert.match(stat.value, /^[\d,.]+%?$/, `${stat.id}.value should be a bare number or percentage`);
    assert.ok(stat.value.length <= 10, `${stat.id}.value is too long to render as a headline figure`);
  }
});

test("the retrieved date is recorded", () => {
  assert.match(STATISTICS_RETRIEVED, /\d{4}/);
});

test("sources point at the publisher, not an aggregator", () => {
  // Blog roundups restate these numbers with drifting values and no date; the
  // card has to link somewhere a reader can check the figure themselves.
  const aggregators = /nurse\.com|indeed\.com|ziprecruiter|glassdoor|beckershospitalreview|nightingale\.edu|simplyhired|talent\.com/i;
  for (const stat of HIRING_STATISTICS) {
    assert.doesNotMatch(stat.sourceUrl, aggregators, `${stat.id} cites an aggregator rather than the publisher`);
  }
});
