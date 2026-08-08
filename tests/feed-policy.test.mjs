import assert from "node:assert/strict";
import test from "node:test";

import {
  FEED_FRESH_SECONDS,
  FEED_SERVE_SECONDS,
  MIN_REFRESH_SECONDS,
  blocksOnRebuild,
  decideFeedAction,
} from "../lib/jobs/feed-policy.mjs";

const entry = (ageSeconds) => ({ ageSeconds });

test("a current feed is served straight from cache", () => {
  assert.equal(decideFeedAction(entry(0), false), "hit");
  assert.equal(decideFeedAction(entry(FEED_FRESH_SECONDS - 1), false), "hit");
  assert.equal(decideFeedAction(entry(FEED_FRESH_SECONDS), false), "hit");
});

test("an expired feed is still served, with a rebuild behind it", () => {
  // The whole point: the visitor who arrives after expiry must not be the one
  // who waits ~7s for eight career sites to answer.
  assert.equal(decideFeedAction(entry(FEED_FRESH_SECONDS + 1), false), "stale");
  assert.equal(decideFeedAction(entry(FEED_SERVE_SECONDS), false), "stale");
  assert.equal(blocksOnRebuild("stale"), false);
});

test("a feed too old to trust is rebuilt before answering", () => {
  assert.equal(decideFeedAction(entry(FEED_SERVE_SECONDS + 1), false), "build");
  assert.equal(decideFeedAction(null, false), "build");
  assert.equal(blocksOnRebuild("build"), true);
});

test("manual refresh re-scans only past the floor", () => {
  // Inside the floor the button is a no-op against upstream, by design.
  assert.equal(decideFeedAction(entry(0), true), "hit");
  assert.equal(decideFeedAction(entry(MIN_REFRESH_SECONDS), true), "hit");
  assert.equal(decideFeedAction(entry(MIN_REFRESH_SECONDS + 1), true), "refresh");
  assert.equal(blocksOnRebuild("refresh"), true);
});

test("manual refresh cannot be used to bypass the rate floor", () => {
  // Ten rapid clicks against a fresh cache must never reach the employers.
  const actions = Array.from({ length: 10 }, () => decideFeedAction(entry(30), true));
  assert.ok(actions.every((action) => action === "hit"));
});

test("a corrupt age is treated as no cache at all", () => {
  assert.equal(decideFeedAction(entry(Number.NaN), false), "build");
  assert.equal(decideFeedAction(entry(Number.POSITIVE_INFINITY), false), "build");
});

test("the serve window is longer than the freshness window", () => {
  // If these ever cross, the stale branch becomes unreachable and every
  // post-expiry visitor goes back to waiting on a cold scan.
  assert.ok(FEED_SERVE_SECONDS > FEED_FRESH_SECONDS);
  assert.ok(MIN_REFRESH_SECONDS < FEED_FRESH_SECONDS);
});
