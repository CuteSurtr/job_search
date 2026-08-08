/**
 * Client for Oracle Cloud Recruiting (ORC) candidate-experience sites.
 *
 * This is the second ATS behind the feed. It exists because five states — AK,
 * AL, HI, WV and DC — had no reachable Workday employer, and two of the systems
 * that cover them (Providence and Adventist Health) run Oracle instead.
 *
 * Where it differs from Workday, and why the differences matter:
 *
 *  - **Locations are already `City, ST, United States`.** Workday frequently
 *    reports a facility name where a city should be, which is why the feed has
 *    a single-state footprint fallback at all. Oracle needs none of it — every
 *    posting places itself, including for multi-state employers, which is the
 *    case Workday cannot resolve.
 *  - **`limit` above 20 is accepted.** Workday answers an opaque HTTP 400; ORC
 *    served 100 without complaint. The page size here is still held at 50 to
 *    keep one page's parse bounded, but paging is a choice rather than the only
 *    option it is on Workday.
 *  - **Posting age is an exact ISO date**, not the prose Workday emits.
 *
 * That last one is normalised *down* to Workday's vocabulary rather than
 * threaded through as a richer type. One age path is worth more than a day of
 * extra precision here: `postedMinutes` is a tested pure function every
 * consumer already relies on, and `job_sightings` is what makes ages real
 * anyway (see `history.mjs`). The lossy direction is the safe one.
 */

import { ACCEPT_LANGUAGE } from "./workday.mjs";

const USER_AGENT =
  "Mozilla/5.0 (compatible; NurseLaunch/1.0; +https://github.com/CuteSurtr/job_search)";
const REQUEST_TIMEOUT_MS = 9000;

/**
 * ORC accepts larger pages than Workday, but a page still has to be parsed in
 * a Worker, so this is a deliberate ceiling rather than the API's.
 */
export const ORACLE_PAGE_SIZE = 50;

/**
 * @typedef {import("./workday.mjs").Budget} Budget
 * @typedef {{ title: string, externalPath: string, locationsText?: string, postedOn?: string, bulletFields?: string[] }} Posting
 */

/** @param {import("./sources.mjs").JobSource} source */
function apiBase(source) {
  return `https://${source.host}/hcmRestApi/resources/latest`;
}

/**
 * The public job URL a visitor should land on. Not derivable from the search
 * response — ORC omits `ExternalPostingUrl` on these tenants — so it is built
 * from the same site number the search uses.
 *
 * @param {import("./sources.mjs").JobSource} source
 * @param {string} externalPath
 */
export function oracleEmployerUrl(source, externalPath) {
  const id = externalPath.replace(/^\/job\//, "");
  return `https://${source.host}/hcmUI/CandidateExperience/en/sites/${source.site}/job/${id}`;
}

/**
 * ORC requisition ids are numeric strings. Keeping this stricter than the
 * Workday path check means a crafted `path` cannot be walked into another
 * resource through the detail route's `finder` argument.
 *
 * @param {unknown} path
 * @returns {path is string}
 */
export function isValidOraclePath(path) {
  return typeof path === "string" && /^\/job\/\d{1,15}$/.test(path);
}

/**
 * ISO date to the prose vocabulary `postedMinutes` already parses. A date in
 * the future (clock skew between the tenant and us) reads as today rather than
 * as a negative age.
 *
 * @param {string | null | undefined} iso
 * @param {number} [now]
 */
export function postedLabelFromDate(iso, now = Date.now()) {
  if (!iso) return "Recently posted";
  const posted = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(posted)) return "Recently posted";

  const startOfToday = new Date(now);
  startOfToday.setUTCHours(0, 0, 0, 0);
  const days = Math.round((startOfToday.getTime() - posted) / 86400000);

  if (days <= 0) return "Posted Today";
  if (days === 1) return "Posted Yesterday";
  return `Posted ${days} Days Ago`;
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        // See ACCEPT_LANGUAGE in workday.mjs: undici's `*` default trips at
        // least one tenant's WAF. Sent here for the same reason.
        "accept-language": ACCEPT_LANGUAGE,
        "user-agent": USER_AGENT,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ORC's `finder` argument is a single semicolon-delimited string rather than
 * ordinary query parameters, so it is assembled by hand. The keyword is encoded
 * because it reaches the server inside that string, where an unescaped `;` or
 * `,` would terminate the argument early.
 *
 * @param {import("./sources.mjs").JobSource} source
 * @param {string} searchText
 * @param {number} offset
 */
export function oracleSearchUrl(source, searchText, offset) {
  const finder = [
    "findReqs",
    `siteNumber=${source.site}`,
    `limit=${ORACLE_PAGE_SIZE}`,
    `offset=${offset}`,
    "sortBy=POSTING_DATES_DESC",
    `keyword=${encodeURIComponent(searchText)}`,
  ];
  return (
    `${apiBase(source)}/recruitingCEJobRequisitions` +
    `?onlyData=true&expand=requisitionList&finder=${finder[0]};${finder.slice(1).join(",")}`
  );
}

/**
 * One page of search results, normalised to the same posting shape the Workday
 * client returns so the feed does not care which ATS answered.
 *
 * @param {import("./sources.mjs").JobSource} source
 * @param {string} searchText
 * @param {number} offset
 * @returns {Promise<{ total: number, postings: Posting[] }>}
 */
export async function fetchOracleSearchPage(source, searchText, offset) {
  const response = await fetchWithTimeout(oracleSearchUrl(source, searchText, offset));
  if (!response.ok) {
    const reason = (await response.text().catch(() => "")).slice(0, 180);
    throw new Error(`Search returned ${response.status}: ${reason}`);
  }

  const body = /** @type {{ items?: { TotalJobsCount?: number, requisitionList?: Record<string, unknown>[] }[] }} */ (
    await response.json()
  );
  return normalizeOracleSearch(body);
}

/**
 * Split out from the fetch so `tests/ats.test.mjs` can exercise the mapping
 * against a captured payload without a network call.
 *
 * @param {{ items?: { TotalJobsCount?: number, requisitionList?: Record<string, unknown>[] }[] }} body
 * @param {number} [now]
 * @returns {{ total: number, postings: Posting[] }}
 */
export function normalizeOracleSearch(body, now = Date.now()) {
  const result = body?.items?.[0];
  if (!result) return { total: 0, postings: [] };

  const postings = (result.requisitionList ?? [])
    .filter((requisition) => requisition && requisition.Id != null && requisition.Title)
    .map((requisition) => ({
      title: String(requisition.Title),
      externalPath: `/job/${String(requisition.Id)}`,
      locationsText: typeof requisition.PrimaryLocation === "string" ? requisition.PrimaryLocation : "",
      postedOn: postedLabelFromDate(
        typeof requisition.PostedDate === "string" ? requisition.PostedDate : null,
        now,
      ),
      // Workday carries the requisition number in `bulletFields`; ORC exposes it
      // as the id itself, so the card shows the same thing from both.
      bulletFields: [String(requisition.Id)],
    }));

  return { total: Number(result.TotalJobsCount ?? postings.length), postings };
}

/**
 * Page through one search term. Mirrors the Workday client's contract exactly:
 * a first-page failure propagates because the source is genuinely down, a
 * later-page failure keeps what the earlier pages returned.
 *
 * @param {import("./sources.mjs").JobSource} source
 * @param {string} searchText
 * @param {{ budget: Budget, maxPages?: number }} options
 * @returns {Promise<Posting[]>}
 */
export async function fetchAllOraclePostings(source, searchText, { budget, maxPages = 2 }) {
  if (!budget.spend()) return [];

  const first = await fetchOracleSearchPage(source, searchText, 0);
  const postings = [...first.postings];
  const pages = Math.min(maxPages, Math.ceil(first.total / ORACLE_PAGE_SIZE) || 1);

  for (let page = 1; page < pages; page++) {
    if (!budget.spend()) break;
    try {
      const next = await fetchOracleSearchPage(source, searchText, page * ORACLE_PAGE_SIZE);
      if (next.postings.length === 0) break;
      postings.push(...next.postings);
    } catch {
      break;
    }
  }

  return postings;
}

/**
 * Full posting detail, mapped onto the same field names the Workday detail
 * returns so both routes can consume one shape. Returns null on any failure so
 * one bad posting never fails the feed.
 *
 * @param {import("./sources.mjs").JobSource} source
 * @param {string} externalPath
 * @param {Budget} [budget]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function fetchOracleDetail(source, externalPath, budget) {
  if (budget && !budget.spend()) return null;
  if (!isValidOraclePath(externalPath)) return null;

  const id = externalPath.replace(/^\/job\//, "");
  const url =
    `${apiBase(source)}/recruitingCEJobRequisitionDetails` +
    `?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${source.site}`;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    const body = /** @type {{ items?: Record<string, unknown>[] }} */ (await response.json());
    return normalizeOracleDetail(body, source, externalPath);
  } catch {
    return null;
  }
}

/**
 * `now` is injectable for the same reason it is on `normalizeOracleSearch`:
 * posting age is derived from the clock, and a test that asserts a label
 * against the real one passes today and fails tomorrow.
 *
 * @param {{ items?: Record<string, unknown>[] }} body
 * @param {import("./sources.mjs").JobSource} source
 * @param {string} externalPath
 * @param {number} [now]
 * @returns {Record<string, unknown> | null}
 */
export function normalizeOracleDetail(body, source, externalPath, now = Date.now()) {
  const item = body?.items?.[0];
  if (!item) return null;

  const str = (value) => (typeof value === "string" && value.trim() ? value : undefined);

  return {
    title: str(item.Title),
    location: str(item.PrimaryLocation),
    postedOn: postedLabelFromDate(str(item.ExternalPostedStartDate)?.slice(0, 10) ?? null, now),
    startDate: undefined,
    timeType: str(item.JobSchedule) ?? str(item.JobShift),
    remoteType: undefined,
    externalUrl: str(item.ExternalPostingUrl) ?? oracleEmployerUrl(source, externalPath),
    // ORC splits the body across three optional blocks; a posting that fills
    // only the qualifications block still has to render, so all present blocks
    // are joined rather than picking one.
    jobDescription: [item.ExternalDescriptionStr, item.ExternalResponsibilitiesStr, item.ExternalQualificationsStr]
      .filter((block) => typeof block === "string" && block.trim())
      .join("\n"),
  };
}
