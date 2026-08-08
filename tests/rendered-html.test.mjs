import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the NurseLaunch job tracker", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>NurseLaunch — New Grad Nursing Jobs<\/title>/i);
  assert.match(html, /Your first nursing job/);
  assert.match(html, /Live new grad roles/);
  assert.match(html, /Live employer feed/);
  assert.match(html, /Three steps, no reposted listings/);
  assert.match(html, /id="how-it-works"/);
  assert.doesNotMatch(html, /react-loading-skeleton/i);
});
