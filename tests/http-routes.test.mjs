import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

/**
 * Route and render behaviour against the real production server.
 *
 * These used to import the compiled Worker bundle and call its `fetch` export
 * directly. Next has no single importable server object, so instead one
 * `next start` is booted for the whole file and every case shares it — three
 * separate files would have meant three builds' worth of startup.
 *
 * The environment is scrubbed on the way in. Every assertion here describes a
 * *fresh, unconfigured* deployment — no email provider, no database — which is
 * exactly the state these routes have to handle gracefully, and which a
 * developer's own `.env` would otherwise quietly break.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 30000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;

/** @type {import("node:child_process").ChildProcess | null} */
let server = null;

async function waitForReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`next start exited early with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE}/api/alerts`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2000),
      });
      if (response.status > 0) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become ready on ${BASE}`);
}

before(async () => {
  server = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["next", "start", "--port", String(PORT), "--hostname", "127.0.0.1"],
    {
      cwd: ROOT,
      stdio: "ignore",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        NODE_ENV: "production",
        // The unconfigured baseline these tests describe.
        RESEND_API_KEY: "",
        ALERTS_FROM_EMAIL: "",
        DATABASE_URL: "",
        POSTGRES_URL: "",
        KV_REST_API_URL: "",
        KV_REST_API_TOKEN: "",
        CRON_SECRET: "",
      },
    },
  );
  await waitForReady();
});

after(() => {
  server?.kill();
});

const get = (path, init = {}) =>
  fetch(`${BASE}${path}`, { headers: { accept: "application/json" }, ...init });

/* ---------------------------------------------------------------- detail -- */

test("detail route rejects an unknown source without calling upstream", async () => {
  const response = await get("/api/jobs/detail?source=not-a-hospital&path=/job/x");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Unknown source" });
});

test("detail route rejects paths outside the Workday job namespace", async () => {
  const paths = ["/etc/passwd", "/job/../../admin", "/wday/cxs/other/endpoint", "/job/x?redirect=1", ""];
  for (const path of paths) {
    const response = await get(`/api/jobs/detail?source=ochsner&path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 400, `expected 400 for ${path || "(empty)"}`);
    assert.deepEqual(await response.json(), { error: "Invalid job path" });
  }
});

test("detail route applies the Oracle path rule to an Oracle source", async () => {
  // A path that is valid for Workday must not be accepted for Oracle, whose
  // requisition ids are numeric and reach a `finder` argument.
  const response = await get(
    `/api/jobs/detail?source=providence&path=${encodeURIComponent("/job/Orlando-FL/Nurse-Residency_1")}`,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid job path" });
});

test("detail route requires both parameters", async () => {
  assert.equal((await get("/api/jobs/detail")).status, 400);
  assert.equal((await get("/api/jobs/detail?source=ochsner")).status, 400);
});

/* ---------------------------------------------------------------- alerts -- */

test("alerts report themselves disabled when no provider is configured", async () => {
  const response = await get("/api/alerts");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });
});

test("subscribing is refused rather than silently accepted", async () => {
  const response = await get("/api/alerts", {
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
    const response = await get(path);
    assert.equal(response.status, 400, path);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  }
});

test("confirm and unsubscribe pages are never indexed", async () => {
  const response = await get("/api/alerts/confirm?token=nope");
  const html = await response.text();
  assert.match(html, /<meta name="robots" content="noindex">/);
});

/* ------------------------------------------------------------------ cron -- */

test("the digest cron refuses to run when CRON_SECRET is unset", async () => {
  // An unauthenticated endpoint that mails every subscriber on request is worse
  // than one that does nothing, so absent configuration must fail closed.
  const response = await get("/api/cron/digest");
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /CRON_SECRET/);
});

test("the digest cron rejects a wrong bearer token", async () => {
  const response = await get("/api/cron/digest", {
    headers: { accept: "application/json", authorization: "Bearer not-the-secret" },
  });
  // 503 here too, because the secret is unset in this environment — the point
  // is that a caller-supplied token never becomes the thing that authorises.
  assert.ok([401, 503].includes(response.status));
});

/* ---------------------------------------------------------------- render -- */

test("server-renders the NurseLaunch job tracker", async () => {
  const response = await fetch(BASE, { headers: { accept: "text/html" } });
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
