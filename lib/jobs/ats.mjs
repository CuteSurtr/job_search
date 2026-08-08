/**
 * One interface over the two applicant tracking systems the feed reads.
 *
 * The registry in `sources.mjs` is a single list because callers should not
 * care who hosts an employer's careers site — the feed asks for postings and
 * gets postings. Everything ATS-specific is resolved here, by the `ats`
 * discriminant on each source.
 *
 * Adding a third ATS means adding a branch to each of these four functions and
 * nothing else. That is the point of the file: the feed route, the detail route
 * and the tests all go through here, so none of them grows a second code path.
 */

import {
  fetchAllOraclePostings,
  fetchOracleDetail,
  isValidOraclePath,
  oracleEmployerUrl,
} from "./oracle.mjs";
import { isValidExternalPath } from "./sources.mjs";
import { fetchAllPostings, fetchDetail } from "./workday.mjs";

/**
 * @typedef {import("./sources.mjs").JobSource} JobSource
 * @typedef {import("./workday.mjs").Budget} Budget
 */

/**
 * Postings for one search term from whichever ATS this employer uses. Both
 * clients return the same posting shape and honour the same budget contract,
 * so the caller sees no difference.
 *
 * @param {JobSource} source
 * @param {string} searchText
 * @param {{ budget: Budget, maxPages?: number }} options
 */
export function fetchPostingsFor(source, searchText, options) {
  return source.ats === "oracle"
    ? fetchAllOraclePostings(source, searchText, options)
    : fetchAllPostings(source, searchText, options);
}

/**
 * Full detail for one posting, normalised to a common shape. Both clients
 * return null rather than throwing, so a single dead posting never fails a
 * scan.
 *
 * @param {JobSource} source
 * @param {string} externalPath
 * @param {Budget} [budget]
 */
export function fetchDetailFor(source, externalPath, budget) {
  return source.ats === "oracle"
    ? fetchOracleDetail(source, externalPath, budget)
    : fetchDetail(source, externalPath, budget);
}

/**
 * Whether `path` is a path this source could legitimately have produced.
 *
 * This is the guard on `/api/jobs/detail`, where the path arrives from the
 * query string. It is per-ATS rather than shared because the two systems accept
 * different shapes and the looser of the two must not be applied to the
 * stricter: an ORC requisition id is numeric, and validating it with Workday's
 * rule would let arbitrary text through into the `finder` argument.
 *
 * @param {JobSource} source
 * @param {unknown} path
 * @returns {path is string}
 */
export function isValidPathFor(source, path) {
  return source.ats === "oracle" ? isValidOraclePath(path) : isValidExternalPath(path);
}

/**
 * The employer-facing URL for a posting, used as the apply link and as the
 * seed for the job's stable id. Workday's external path appends to the career
 * site root; ORC has no public path at all and one is composed from the site
 * number.
 *
 * @param {JobSource} source
 * @param {string} externalPath
 */
export function employerUrlFor(source, externalPath) {
  return source.ats === "oracle"
    ? oracleEmployerUrl(source, externalPath)
    : `https://${source.host}/${source.site}${externalPath}`;
}
