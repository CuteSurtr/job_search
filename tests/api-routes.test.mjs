import assert from "node:assert/strict";
import test from "node:test";

/**
 * Route-level checks against the built worker. These cover the request
 * validation that runs before any upstream call, so the suite stays offline and
 * fast — the parsing that happens after a successful fetch is covered by
 * job-matching.test.mjs.
 */
async function callWorker(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-routes`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "application/json" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("detail route rejects an unknown source without calling upstream", async () => {
  const response = await callWorker("/api/jobs/detail?source=not-a-hospital&path=/job/x");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Unknown source" });
});

test("detail route rejects paths outside the Workday job namespace", async () => {
  const paths = ["/etc/passwd", "/job/../../admin", "/wday/cxs/other/endpoint", "/job/x?redirect=1", ""];
  for (const path of paths) {
    const response = await callWorker(`/api/jobs/detail?source=ochsner&path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 400, `expected 400 for ${path || "(empty)"}`);
    assert.deepEqual(await response.json(), { error: "Invalid job path" });
  }
});

test("detail route requires both parameters", async () => {
  assert.equal((await callWorker("/api/jobs/detail")).status, 400);
  assert.equal((await callWorker("/api/jobs/detail?source=ochsner")).status, 400);
});
