import assert from "node:assert/strict";
import test from "node:test";

/**
 * Route behaviour for alerts when no email provider is configured — which is
 * the default state of a fresh deployment. The feature must refuse cleanly and
 * store nothing, rather than accepting addresses it can never mail.
 */
async function callWorker(path, init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-alerts`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "application/json" }, ...init }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("alerts report themselves disabled when no provider is configured", async () => {
  const response = await callWorker("/api/alerts");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });
});

test("subscribing is refused rather than silently accepted", async () => {
  const response = await callWorker("/api/alerts", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email: "grad@example.com", filters: { state: "LA" } }),
  });
  // 503, not 200: telling someone "check your inbox" when nothing can be sent
  // is worse than telling them the feature is off.
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.match(payload.error, /not configured/i);
});

test("confirm and unsubscribe reject malformed tokens", async () => {
  for (const path of ["/api/alerts/confirm?token=nope", "/api/alerts/unsubscribe?token=../../etc"]) {
    const response = await callWorker(path);
    assert.equal(response.status, 400, path);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  }
});

test("confirm and unsubscribe pages are never indexed", async () => {
  const response = await callWorker("/api/alerts/confirm?token=nope");
  const html = await response.text();
  assert.match(html, /<meta name="robots" content="noindex">/);
});
