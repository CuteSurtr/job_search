/**
 * Two-layer read-through cache for upstream feed data.
 *
 * Building the feed costs dozens of upstream calls, so it must not happen once
 * per visitor. Layer one is a module-scoped Map, which survives between
 * requests handled by the same isolate and is the only layer that exists under
 * `node` (tests, local checks). Layer two is the Workers Cache API, shared
 * across isolates in a colo, and simply absent elsewhere.
 *
 * Values are plain JSON-serialisable objects.
 */

const CACHE_NAMESPACE = "https://nurselaunch.internal/cache/v1/";

/** @type {Map<string, { createdAt: number, expiresAt: number, value: unknown }>} */
const memory = new Map();

function now() {
  return Date.now();
}

/** @returns {Promise<Cache | null>} */
async function openEdgeCache() {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open("nurselaunch-v1");
  } catch {
    return null;
  }
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

  const edge = await openEdgeCache();
  if (!edge) return null;

  try {
    const response = await edge.match(new Request(`${CACHE_NAMESPACE}${encodeURIComponent(key)}`));
    if (!response) return null;
    const envelope = /** @type {{ createdAt: number, expiresAt: number, value: T }} */ (
      await response.json()
    );
    if (!envelope || envelope.expiresAt <= now()) return null;
    memory.set(key, envelope);
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
  memory.set(key, envelope);

  const edge = await openEdgeCache();
  if (!edge) return;

  try {
    await edge.put(
      new Request(`${CACHE_NAMESPACE}${encodeURIComponent(key)}`),
      new Response(JSON.stringify(envelope), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ttlSeconds}`,
        },
      }),
    );
  } catch {
    // A cache miss is always survivable; a cache write failure must never be.
  }
}
