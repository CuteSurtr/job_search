/**
 * What we actually know about visa sponsorship, per employer.
 *
 * This file exists because the obvious version of this feature would be a lie.
 * Sponsorship cannot be scraped from the feed: a sample of 90 live postings
 * with full description bodies (median ~4,700 characters) found **one** that
 * mentioned sponsorship, visas, work authorisation or OPT at all, and **zero**
 * that stated a position either way. Employer nursing-careers pages are just as
 * silent. Only aggregator blogs assert that a given hospital sponsors, and they
 * cite nothing.
 *
 * There is a structural reason for the silence. Registered nursing is a
 * Schedule A shortage occupation, so an employer petitioning for a nurse skips
 * PERM labour certification and files the I-140 straight with USCIS. Nothing
 * reaches the Department of Labor for certification, so no public disclosure
 * trail exists — and a hospital has no reason to advertise sponsorship on a
 * new-graduate requisition.
 *
 * So this is a hand-curated registry with the same contract as
 * `lib/content/statistics.mjs`: every positive or negative claim carries the
 * evidence it rests on, and `tests/sponsorship.test.mjs` fails the build on an
 * unsourced one. Three rules are load-bearing:
 *
 *  1. **A claim needs a citation.** `documented`, `reported` and `excluded` all
 *     require a source and a link. `unknown` must carry neither, because there
 *     is nothing to cite.
 *  2. **Absent is not the same as unknown.** An employer with no entry here has
 *     *not been checked*; an `unknown` entry has been checked and nothing was
 *     found. Telling a job hunter "we looked and found nothing" is useful.
 *     Implying it when nobody looked is not. This mirrors how the state filter
 *     already separates "no employer covers this state" from "covered, nothing
 *     listed right now".
 *  3. **Nothing is inferred from size or prestige.** A large system that
 *     plausibly sponsors is still `unknown` until it says so somewhere citable.
 *     Sending someone to spend one of their twelve OPT months on a guess is the
 *     failure this whole file is built to prevent.
 *
 * @typedef {"documented" | "reported" | "excluded" | "unknown"} SponsorshipStatus
 * @typedef {{
 *   sourceKey: string,
 *   status: SponsorshipStatus,
 *   note: string,
 *   source?: string,
 *   sourceUrl?: string,
 * }} SponsorshipRecord
 */

/** When the entries below were last checked against their sources. */
export const SPONSORSHIP_CHECKED = "August 2026";

/**
 * How to read each status on a card.
 *
 * `reported` exists so that credible third-party evidence can be shown without
 * being dressed up as the employer's own commitment — the distinction a reader
 * needs in order to decide whether to rely on it.
 */
export const SPONSORSHIP_LABELS = {
  documented: {
    label: "Sponsorship documented",
    detail: "The employer's own material names visa sponsorship for nurses.",
  },
  reported: {
    label: "Sponsorship reported",
    detail: "A credible source outside the employer reports sponsorship. Confirm before relying on it.",
  },
  excluded: {
    label: "No sponsorship",
    detail: "This employer or posting states that it does not sponsor.",
  },
  unknown: {
    label: "Not documented",
    detail: "We checked and found no published position either way. It does not mean no.",
  },
  unchecked: {
    label: "Not checked",
    detail: "We have not researched this employer's sponsorship position yet.",
  },
};

/**
 * @type {SponsorshipRecord[]}
 *
 * Deliberately short. Every entry below is the result of reading the
 * employer's own pages; none is transcribed from a jobs blog. The list is far
 * more `unknown` than anything else, and that is the honest state of the
 * evidence rather than a gap waiting to be filled in with optimism.
 */
export const SPONSORSHIP_RECORDS = [
  {
    sourceKey: "massgeneralbrigham",
    status: "unknown",
    note: "Nursing careers pages carry no sponsorship statement in either direction. University-affiliated, so cap-exempt H-1B may be possible for an experienced specialty nurse — that is a route in year three, not at graduation.",
  },
  {
    sourceKey: "nyp",
    status: "unknown",
    note: "Nursing careers pages carry no sponsorship statement. New York is one of the five states whose licence unlocks the cheaper 212(r) certified statement, which matters only if you were educated in an approved country — the US counts.",
  },
  {
    sourceKey: "stanfordmedicine",
    status: "unknown",
    note: "Careers pages carry no sponsorship statement. University-affiliated.",
  },
  {
    sourceKey: "vumc",
    status: "unknown",
    note: "Careers pages carry no sponsorship statement. University-affiliated.",
  },
];

/** @type {Map<string, SponsorshipRecord>} */
const BY_SOURCE = new Map(SPONSORSHIP_RECORDS.map((record) => [record.sourceKey, record]));

/**
 * The employer's sponsorship position, or `unchecked` when nobody has looked.
 *
 * @param {string} sourceKey
 * @returns {SponsorshipStatus | "unchecked"}
 */
export function employerSponsorship(sourceKey) {
  return BY_SOURCE.get(sourceKey)?.status ?? "unchecked";
}

/**
 * @param {string} sourceKey
 * @returns {SponsorshipRecord | null}
 */
export function sponsorshipRecord(sourceKey) {
  return BY_SOURCE.get(sourceKey) ?? null;
}

/**
 * Combine what the posting says with what we know about the employer.
 *
 * A posting that rules sponsorship out wins over anything recorded here: it is
 * newer, it is specific to this requisition, and it is the employer's own
 * words. Everything else defers to the curated record.
 *
 * @param {SponsorshipStatus | null} fromPosting
 * @param {string} sourceKey
 * @returns {SponsorshipStatus | "unchecked"}
 */
export function resolveSponsorship(fromPosting, sourceKey) {
  if (fromPosting === "excluded") return "excluded";
  const employer = employerSponsorship(sourceKey);
  // A posting naming sponsorship is worth surfacing even when the employer has
  // no record, but it never outranks a recorded exclusion.
  if (fromPosting === "documented" && employer !== "excluded") return "documented";
  return employer;
}
