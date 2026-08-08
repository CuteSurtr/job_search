/**
 * Two-layer read-through cache for upstream feed data.
 *
 * Building the feed costs up to a few hundred upstream calls, so it must not
 * happen once per visitor. On Workers, layer two was the Cache API, shared
 * across isolates in a colo. Serverless has no equivalent: a module-scoped Map
 * is scoped to one warm instance, and Vercel runs many. Left at one layer,
 * every cold instance would re-scan all 38 employers — slow for the visitor who
 * lands on it, and a burst of traffic at hospital career sites that never asked
 * for it.
 *
 * So layer two is Redis over its REST API, which both Vercel KV and Upstash
 * speak, reached with plain `fetch` so no client library is needed and the edge
 * runtime stays an option. It is **optional**: with no credentials the cache
 * quietly collapses to the in-memory layer and the site still works. Setting it
 * up is the difference between a fast site and a slow one, not between a
 * working site and a broken one.
 *
 * Values are plain JSON-serialisable objects.
 */

const KEY_PREFIX = "nurselaunch:cache:v1:";

/** @type {Map<string, { createdAt: number, expiresAt: number, value: unknown }>} */
const memory = new Map();

/**
 * Bounds the in-memory layer. Without this a long-lived instance accumulates an
 * entry per detail page ever opened, and the feed entry it actually needs can
 * be evicted by memory pressure instead of by policy.
 */
const MEMORY_MAX_ENTRIES = 200;

function now() {
  return Date.now();
}

/**
 * Vercel KV and Upstash expose the same REST protocol under different variable
 * names. Read at call time so a deployment can add credentials without a
 * rebuild.
 *
 * @returns {{ url: string, token: string } | null}
 */
function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

/**
 * One Redis command, as the REST API's command-array form.
 *
 * Every failure path returns null. A cache is an optimisation: an unreachable
 * Redis has to look exactly like a miss, never like an error, or an outage in
 * the cache takes the site with it.
 *
 * @param {unknown[]} command
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
async function redis(command, timeoutMs = 2000) {
  const config = redisConfig();
  if (!config) return null;

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
      // Never let a slow cache become a slow page — the miss path is cheap.
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = /** @type {{ result?: unknown }} */ (await response.json());
    return body?.result ?? null;
  } catch {
    return null;
  }
}

/** @param {string} key @param {{ createdAt: number, expiresAt: number, value: unknown }} envelope */
function remember(key, envelope) {
  // Insertion-ordered, so the first key is the oldest written.
  if (memory.size >= MEMORY_MAX_ENTRIES && !memory.has(key)) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, envelope);
}

/**
 * Read an entry along with its age, so a caller can distinguish "fresh",
 * "usable but worth refreshing", and "too old to serve" — the three states
 * background revalidation needs.
 *
 * @template T
 * @param {string} key
 * @returns {Promise<{ value: T, ageSeconds: number } | null>}
 */
export async function readCacheEntry(key) {
  const hit = memory.get(key);
  if (hit && hit.expiresAt > now()) {
    return { value: /** @type {T} */ (hit.value), ageSeconds: (now() - hit.createdAt) / 1000 };
  }
  if (hit) memory.delete(key);

  const raw = await redis(["GET", `${KEY_PREFIX}${key}`]);
  if (typeof raw !== "string") return null;

  try {
    const envelope = /** @type {{ createdAt: number, expiresAt: number, value: T }} */ (
      JSON.parse(raw)
    );
    if (!envelope || envelope.expiresAt <= now()) return null;
    remember(key, envelope);
    return { value: envelope.value, ageSeconds: (now() - envelope.createdAt) / 1000 };
  } catch {
    return null;
  }
}

/**
 * @template T
 * @param {string} key
 * @returns {Promise<T | null>}
 */
export async function readCache(key) {
  const entry = await readCacheEntry(key);
  return entry ? /** @type {T} */ (entry.value) : null;
}

/**
 * @template T
 * @param {string} key
 * @param {T} value
 * @param {number} ttlSeconds
 */
export async function writeCache(key, value, ttlSeconds) {
  const createdAt = now();
  const envelope = { createdAt, expiresAt: createdAt + ttlSeconds * 1000, value };
  remember(key, envelope);

  // `EX` rather than an unbounded key: the envelope carries its own expiry for
  // the age calculation, but Redis still has to reclaim the memory on its own.
  await redis(["SET", `${KEY_PREFIX}${key}`, JSON.stringify(envelope), "EX", ttlSeconds]);
}

/** Whether a shared cache layer is configured. Surfaced in the feed's meta. */
export function sharedCacheConfigured() {
  return redisConfig() !== null;
}

/** Drop the in-memory layer. Tests only. */
export function clearMemoryCacheForTests() {
  memory.clear();
}
