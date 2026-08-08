/**
 * Published research on new-graduate nursing hiring.
 *
 * Unlike everything else on this site, these numbers are not scraped — they are
 * transcribed from named reports. That makes them the one thing here that can
 * go quietly stale and still look authoritative, so every entry carries its
 * source, the period the figure describes, and a link. Anything without all
 * three does not belong on the page, and `tests/statistics.test.mjs` enforces
 * that rather than trusting future edits to remember.
 *
 * When updating: change the figure, the `period`, and `retrieved` together.
 *
 * @typedef {{
 *   id: string,
 *   value: string,
 *   label: string,
 *   detail: string,
 *   source: string,
 *   sourceUrl: string,
 *   period: string,
 * }} Statistic
 */

/** When these figures were last checked against their sources. */
export const STATISTICS_RETRIEVED = "August 2026";

/** @type {Statistic[]} */
export const HIRING_STATISTICS = [
  {
    id: "openings",
    value: "189,100",
    label: "RN openings projected each year",
    detail:
      "Average annual openings over the decade, most from nurses retiring or leaving the occupation rather than from new positions.",
    source: "US Bureau of Labor Statistics, Occupational Outlook Handbook",
    sourceUrl: "https://www.bls.gov/ooh/healthcare/registered-nurses.htm",
    period: "2024–2034 projection",
  },
  {
    id: "offer-rate",
    value: "84%",
    label: "of BSN graduates had an offer at graduation",
    detail:
      "Employment rates climb further in the months after graduation, as licensure completes and cohort start dates arrive.",
    source: "American Association of Colleges of Nursing",
    sourceUrl: "https://www.aacnnursing.org/news-data/all-news/employment-22",
    period: "survey conducted August 2023",
  },
  {
    id: "first-year-turnover",
    value: "22.7%",
    label: "first-year RN turnover",
    detail:
      "Roughly one in five new nurses leaves within a year — which is why the structure of a first job matters as much as the offer.",
    source: "NSI National Health Care Retention & RN Staffing Report",
    sourceUrl: "https://www.nsinursingsolutions.com/documents/library/nsi_national_health_care_retention_report.pdf",
    period: "2026 report, 2025 data",
  },
  {
    id: "residency-retention",
    value: "89%",
    label: "retention in an accredited nurse residency",
    detail:
      "Against a 76.2% national first-year benchmark. The clearest argument for choosing a residency over an unstructured first post.",
    source: "Vizient/AACN Nurse Residency Program",
    sourceUrl: "https://www.vizient.com/products/nurse-residency-program",
    period: "2023 cohort",
  },
  {
    id: "early-separations",
    value: "29%",
    label: "of all RN departures are nurses under one year",
    detail:
      "Early-career churn is a large share of the national vacancy problem, and the reason employers fund residency cohorts at all.",
    source: "NSI National Health Care Retention & RN Staffing Report",
    sourceUrl: "https://www.nsinursingsolutions.com/documents/library/nsi_national_health_care_retention_report.pdf",
    period: "2026 report, 2025 data",
  },
  {
    id: "growth",
    value: "5%",
    label: "projected growth in RN employment",
    detail:
      "Faster than the average across all occupations, though the bulk of hiring comes from replacement rather than growth.",
    source: "US Bureau of Labor Statistics, Occupational Outlook Handbook",
    sourceUrl: "https://www.bls.gov/ooh/healthcare/registered-nurses.htm",
    period: "2024–2034 projection",
  },
];
