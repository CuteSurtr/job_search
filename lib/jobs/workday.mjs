/**
 * Thin client for the public Workday CXS endpoints.
 *
 * Two limits shape everything here:
 *  - Workday answers `limit > 20` with an opaque HTTP 400, so breadth comes
 *    from paging, not from a bigger page.
 *  - One request has a finite time and call allowance, so every call is drawn
 *    from an explicit budget and the caller degrades instead of throwing when
 *    it runs out.
 */

import { WORKDAY_PAGE_SIZE, cxsUrl } from "./sources.mjs";

const USER_AGENT =
  "Mozilla/5.0 (compatible; NurseLaunch/1.0; +https://github.com/CuteSurtr/job_search)";
const REQUEST_TIMEOUT_MS = 9000;

/**
 * Sent explicitly on every upstream call, and load-bearing.
 *
 * Node's `fetch` (undici) defaults `Accept-Language` to `*` when the header is
 * absent. WVU Medicine's WAF answers `*` with an opaque HTTP 500 — every other
 * tenant tolerates it, so the symptom is one employer mysteriously failing on
 * Node while working from curl and from the Cloudflare runtime, which sends no
 * such default. `Accept-Encoding` cannot be overridden this way (the fetch spec
 * forbids it) but `Accept-Language` can, so a real value is the whole fix.
 *
 * Do not remove this to "clean up the headers".
 */
export const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

/**
 * @typedef {{ title: string, externalPath: string, locationsText?: string, postedOn?: string, bulletFields?: string[] }} WorkdayPosting
 * @typedef {{ spend: () => boolean, remaining: () => number, expired: () => boolean }} Budget
 */

/**
 * A shared allowance for one inbound request: `max` subrequests, `deadlineMs`
 * of wall clock. `spend()` returns false once either is gone.
 *
 * @param {number} max
 * @param {number} [deadlineMs]
 * @returns {Budget}
 */
export function createBudget(max, deadlineMs = 20000) {
  let used = 0;
  const startedAt = Date.now();
  const expired = () => Date.now() - startedAt > deadlineMs;
  return {
    spend() {
      if (used >= max || expired()) return false;
      used += 1;
      return true;
    },
    remaining: () => Math.max(0, max - used),
    expired,
  };
}

/**
 * @param {string} url
 * @param {RequestInit} init
 */
async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One page of search results. Only the first page carries a meaningful `total`.
 *
 * @param {import("./sources.mjs").WorkdaySource} source
 * @param {string} searchText
 * @param {number} offset
 * @returns {Promise<{ total: number, postings: WorkdayPosting[] }>}
 */
export async function fetchSearchPage(source, searchText, offset) {
  const payload = JSON.stringify({
    appliedFacets: {},
    limit: WORKDAY_PAGE_SIZE,
    offset,
    searchText,
  });

  const response = await fetchWithTimeout(`${cxsUrl(source)}/jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "accept-language": ACCEPT_LANGUAGE,
      "user-agent": USER_AGENT,
    },
    body: payload,
  });

  if (!response.ok) {
    const reason = (await response.text().catch(() => "")).slice(0, 180);
    throw new Error(`Search returned ${response.status}: ${reason}`);
  }

  const body = /** @type {{ total?: number, jobPostings?: WorkdayPosting[] }} */ (
    await response.json()
  );
  return { total: Number(body.total ?? 0), postings: body.jobPostings ?? [] };
}

/**
 * Page through one search term until the reported total is covered, the page
 * cap is hit, or the budget runs dry. A failure on the first page propagates
 * (the source is genuinely down); a failure on a later page keeps whatever the
 * earlier pages returned.
 *
 * @param {import("./sources.mjs").WorkdaySource} source
 * @param {string} searchText
 * @param {{ budget: Budget, maxPages?: number }} options
 * @returns {Promise<WorkdayPosting[]>}
 */
export async function fetchAllPostings(source, searchText, { budget, maxPages = 3 }) {
  if (!budget.spend()) return [];

  const first = await fetchSearchPage(source, searchText, 0);
  const postings = [...first.postings];
  const pages = Math.min(maxPages, Math.ceil(first.total / WORKDAY_PAGE_SIZE) || 1);

  for (let page = 1; page < pages; page++) {
    if (!budget.spend()) break;
    try {
      const next = await fetchSearchPage(source, searchText, page * WORKDAY_PAGE_SIZE);
      if (next.postings.length === 0) break;
      postings.push(...next.postings);
    } catch {
      break;
    }
  }

  return postings;
}

/**
 * Full posting detail, including the HTML description. Returns null on any
 * failure so one bad posting never fails the whole feed.
 *
 * @param {import("./sources.mjs").WorkdaySource} source
 * @param {string} externalPath
 * @param {Budget} [budget]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchDetail(source, externalPath, budget) {
  if (budget && !budget.spend()) return null;
  try {
    const response = await fetchWithTimeout(`${cxsUrl(source)}${externalPath}`, {
      headers: {
        accept: "application/json",
        "accept-language": ACCEPT_LANGUAGE,
        "user-agent": USER_AGENT,
      },
    });
    if (!response.ok) return null;
    const body = /** @type {{ jobPostingInfo?: Record<string, unknown> }} */ (
      await response.json()
    );
    return body.jobPostingInfo ?? null;
  } catch {
    return null;
  }
}

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
