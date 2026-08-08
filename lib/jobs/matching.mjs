/**
 * Pure text-processing helpers shared by the feed and detail routes.
 *
 * These carry the whole risk of the product: a posting is only shown because a
 * regex here said it looks like a new-grad nursing role, and the pay figure on
 * the card is scraped out of free-text HTML. They live apart from `route.ts` so
 * `tests/job-matching.test.mjs` can exercise them without a build.
 */

const STATE_CODES = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS",
  Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA",
  Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT",
  Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
  Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX",
  Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV",
  Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC",
};

const VALID_STATE_CODES = new Set(Object.values(STATE_CODES));

/**
 * Every US state plus DC, sorted by name. The state filter is built from this
 * rather than from whatever the current scan happened to return, so the site
 * reads as nationwide and a visitor can select their own state and get a
 * straight answer — including "nothing right now" — instead of wondering
 * whether they are covered at all.
 */
export const US_STATES = Object.entries(STATE_CODES)
  .map(([name, code]) => ({ name, code }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const UNKNOWN_STATE = "Multi-state";
export const MULTI_LOCATION = "Multiple locations";
export const PAY_UNLISTED = "Pay not listed";

/**
 * Deliberately conservative: a posting must read as nursing *and* as an
 * explicit early-career pathway, and must not be one of the advanced-practice
 * or non-bedside roles that share the vocabulary. Showing a new grad a job they
 * cannot get is worse than missing one.
 *
 * @param {string} title
 */
export function isNewGradNursingRole(title) {
  const value = String(title ?? "").toLowerCase();
  const nursing = /\b(rn|registered nurse|nurse|nursing)\b/.test(value);
  const earlyCareer =
    /(new grad|new graduate|graduate nurse|nurse residency|rn residency|residency program|nurse resident|nurse fellowship|transition to practice|clinical nurse i\b|staff nurse i\b)/.test(
      value,
    );
  const excluded =
    /(practitioner|anesthet|\bcrna\b|assistant|\blpn\b|\blvn\b|student|physician|pharmac|manager|director|educator|coordinator|faculty|instructor|recruiter)/.test(
      value,
    );
  return nursing && earlyCareer && !excluded;
}

/**
 * Workday reports posting age as prose ("Posted Yesterday", "Posted 30+ Days
 * Ago"). Anything unparseable sorts to the back of the list rather than the
 * front, so an unrecognised format never masquerades as fresh.
 *
 * @param {string} [postedOn]
 */
export function postedMinutes(postedOn = "") {
  const normalized = String(postedOn ?? "").toLowerCase();
  if (/just posted|posted today|\btoday\b/.test(normalized)) return 0;
  if (normalized.includes("yesterday")) return 24 * 60;

  const days = normalized.match(/(\d+)\+?\s*days?/);
  if (days) return Number(days[1]) * 24 * 60;

  const hours = normalized.match(/(\d+)\+?\s*hours?/);
  if (hours) return Number(hours[1]) * 60;

  const minutes = normalized.match(/(\d+)\+?\s*minutes?/);
  if (minutes) return Number(minutes[1]);

  return 31 * 24 * 60;
}

/** @param {string} [location] */
export function stateFromLocation(location = "") {
  const value = String(location ?? "");

  const abbreviation = value.match(/(?:^|,|\s|-)\s*([A-Z]{2})(?=\b|$)/);
  if (abbreviation && VALID_STATE_CODES.has(abbreviation[1])) return abbreviation[1];

  const lower = value.toLowerCase();
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (lower.includes(name.toLowerCase())) return code;
  }
  return UNKNOWN_STATE;
}

/**
 * State from a job title, used only when the location field yields nothing.
 *
 * Full names only — never two-letter codes. Nursing titles are dense with
 * abbreviations that collide with state codes: "OR" is the operating room, and
 * matching it as Oregon put Ohio residencies under an Oregon filter. A title
 * that names "Illinois" or "North Carolina" is unambiguous; "OR" never is.
 *
 * @param {string} [title]
 */
export function stateFromTitle(title = "") {
  const value = String(title ?? "").toLowerCase();
  for (const [name, code] of Object.entries(STATE_CODES)) {
    if (value.includes(name.toLowerCase())) return code;
  }
  return UNKNOWN_STATE;
}

/** @param {string} [location] */
export function cityFromLocation(location = "") {
  const value = String(location ?? "").trim();
  if (!value || /^\d+\s+locations?$/i.test(value)) return MULTI_LOCATION;
  return value.split(/,| - /)[0].trim() || MULTI_LOCATION;
}

/** Rewrite SHOUTED text as Title Case, leaving mixed-case text untouched. */
function titleCaseIfShouting(value) {
  if (value !== value.toUpperCase() || !/[A-Z]{3}/.test(value)) return value;
  return value.toLowerCase().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/**
 * Some employers name the facility rather than the city, so the location reads
 * `"ADVENTHEALTH OCALA"`. Dropping a leading copy of the employer's own name
 * recovers the place. Only distinctive first words qualify, so a generic one
 * like "Saint" cannot eat part of a real place name.
 */
function stripEmployerPrefix(value, employer) {
  const firstWord = String(employer ?? "").trim().split(/\s+/)[0]?.replace(/[^a-z0-9]/gi, "");
  if (!firstWord || firstWord.length < 6) return value;
  const stripped = value.replace(new RegExp(`^${firstWord}\\b[\\s,-]*`, "i"), "").trim();
  return stripped || value;
}

/**
 * Workday location strings arrive in three shapes:
 *
 *   "Suffolk, VA"                                              plain
 *   "Saint Luke's South Hospital | 12300 Metcalf Ave | Overland Park | KS"
 *   "ADVENTHEALTH OCALA"                                       facility name
 *
 * Rendering the last two verbatim produced unreadable cards, so all three
 * collapse to one `City, ST` label. The state is read before the city is
 * re-cased, so a trailing code is never mangled into "Tx".
 *
 * @param {string} [raw]
 * @param {string} [employer]
 * @returns {{ label: string, city: string, state: string }}
 */
export function normalizeLocation(raw = "", employer = "") {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!value || /^\d+\s+locations?$/i.test(value)) {
    return { label: MULTI_LOCATION, city: MULTI_LOCATION, state: UNKNOWN_STATE };
  }

  const segments = value.split("|").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length >= 3) {
    const state = stateFromLocation(segments[segments.length - 1]);
    const city = titleCaseIfShouting(segments[segments.length - 2]);
    return { label: state === UNKNOWN_STATE ? city : `${city}, ${state}`, city, state };
  }

  const trimmed = stripEmployerPrefix(value, employer);
  const state = stateFromLocation(trimmed);
  const city = titleCaseIfShouting(cityFromLocation(trimmed));
  return { label: state === UNKNOWN_STATE ? city : `${city}, ${state}`, city, state };
}

/**
 * Ordered most-specific first. Two ordering rules are load-bearing:
 *
 *  - Med-surg is tested before perioperative, because "Medical Surgical" is a
 *    floor specialty, not an operating-room role, and a bare `surgical` test
 *    would otherwise claim it.
 *  - `\bor\b` is intentionally absent from the perioperative test — the English
 *    "or" in a title like "Med Surg or Telemetry" would swallow the posting.
 *
 * @param {string} title
 */
export function specialtyFromTitle(title) {
  const value = String(title ?? "").toLowerCase();
  if (/(nicu|neonatal)/.test(value)) return "Neonatal";
  if (/(picu|pediatric|paediatric|children)/.test(value)) return "Pediatrics";
  if (/(icu|critical care|intensive care)/.test(value)) return "Critical Care";
  if (/(emergency|trauma|\bed\b|\ber\b)/.test(value)) return "Emergency";
  if (/(mother|baby|labor|delivery|obstetric|postpartum|women)/.test(value)) return "Maternal Health";
  if (/(oncology|cancer|hematology|infusion)/.test(value)) return "Oncology";
  if (/(cardiac|cardio|telemetry|heart|\bccu\b)/.test(value)) return "Cardiac";
  if (/(med.?surg|medical.?surgical|intermediate care|stepdown|step.down|progressive care)/.test(value)) return "Med-Surg";
  if (/(operating room|periop|\bpacu\b|surgical services|surgery center)/.test(value)) return "Perioperative";
  if (/(neuro|stroke)/.test(value)) return "Neuroscience";
  if (/(behavioral|psychiatric|psych|mental health)/.test(value)) return "Behavioral Health";
  if (/(home health|hospice|community|clinic|ambulatory)/.test(value)) return "Ambulatory";
  return "General Residency";
}

/** @param {string} title */
export function settingFromTitle(title) {
  const value = String(title ?? "").toLowerCase();
  if (/fellowship/.test(value)) return "Fellowship";
  if (/residen/.test(value)) return "Residency";
  return "Staff RN";
}

/** @param {string} [value] */
export function stripHtml(value = "") {
  return String(value ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;| |Â /g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const HOURS_PER_YEAR = 2080;
const PLAUSIBLE_HOURLY = { min: 15, max: 200 };
const PLAUSIBLE_ANNUAL = { min: 30000, max: 400000 };

/** A range is only a wage if something nearby says so. */
const PAY_LABEL_BEFORE = /(pay range|pay rate|hourly rate|base pay|base rate|salary range|compensation range|pay scale|rate of pay|wage)[^$]{0,40}$/i;
const UNIT_HOURLY_AFTER = /^[^\d$]{0,30}(per hour|hourly|an hour|\/\s?hr\b|\/\s?hour\b|hour)/i;
const UNIT_ANNUAL_AFTER = /^[^\d$]{0,35}(per year|annually|annual|\/\s?yr\b|\/\s?year\b|year|salary)/i;

/** Figures that live next to these words are perks, not wages. */
const NON_WAGE_CONTEXT =
  /(sign[- ]?on|bonus|tuition|reimburse|assistance|relocation|debt|scholarship|discount|referral|adoption|fertility|surrogacy|401k|403b|match|insurance|deductible)/i;

/**
 * Wage ranges appear in two shapes across these employers, and only one of them
 * names its units:
 *
 *   "Pay Range: $31.53 – $52.24"        (labelled, unitless)
 *   "$31.53 - $52.24 per hour"          (unlabelled, unit-suffixed)
 *
 * So a range qualifies if it is *either* preceded by a pay label or followed by
 * a unit — and is rejected outright when it sits next to bonus/tuition wording,
 * because those numbers ("$7,500 sign-on bonus", "$5,250/year tuition") are the
 * most common dollar figures in a nursing posting and must never be shown as a
 * wage. Unitless labelled ranges are classified by magnitude.
 *
 * Annual ranges are normalised to an hourly figure (2080 h/yr) so the minimum-pay
 * filter can compare like with like; `payLabel` keeps the employer's own units so
 * nothing is misrepresented to the reader.
 *
 * @param {string} text
 * @returns {{ pay: number | null, payLabel: string }}
 */
export function extractPay(text) {
  const value = String(text ?? "");
  const pattern = /\$\s?(\d{1,3}(?:,\d{3})?(?:\.\d{1,2})?)\s*(?:-|–|—|to)\s*\$?\s?(\d{1,3}(?:,\d{3})?(?:\.\d{1,2})?)/gi;

  for (const match of value.matchAll(pattern)) {
    const low = Number(match[1].replace(/,/g, ""));
    const high = Number(match[2].replace(/,/g, ""));
    if (!(low > 0) || high < low) continue;

    const index = match.index ?? 0;
    const before = value.slice(Math.max(0, index - 90), index);
    const after = value.slice(index + match[0].length);

    if (NON_WAGE_CONTEXT.test(before) || NON_WAGE_CONTEXT.test(after.slice(0, 40))) continue;

    const labelled = PAY_LABEL_BEFORE.test(before);
    const hourlyUnit = UNIT_HOURLY_AFTER.test(after);
    const annualUnit = UNIT_ANNUAL_AFTER.test(after);
    if (!labelled && !hourlyUnit && !annualUnit) continue;

    const looksHourly = hourlyUnit || (!annualUnit && high <= PLAUSIBLE_HOURLY.max);

    if (looksHourly && low >= PLAUSIBLE_HOURLY.min && high <= PLAUSIBLE_HOURLY.max) {
      return { pay: low, payLabel: `$${low.toFixed(2)}–$${high.toFixed(2)}/hr` };
    }

    if (!looksHourly && low >= PLAUSIBLE_ANNUAL.min && high <= PLAUSIBLE_ANNUAL.max) {
      return {
        pay: Math.round((low / HOURS_PER_YEAR) * 100) / 100,
        payLabel: `$${low.toLocaleString("en-US")}–$${high.toLocaleString("en-US")}/yr`,
      };
    }
  }

  return { pay: null, payLabel: PAY_UNLISTED };
}

/** @param {string} text */
export function licenseFromText(text) {
  const value = String(text ?? "");
  if (/(nclex.{0,40}pending|graduate nurse.{0,50}(permit|eligible)|\bgn permit\b|prior to nclex)/i.test(value)) {
    return "NCLEX pending accepted";
  }
  if (/(compact license|multistate license|multi-state license|nurse licensure compact|\bnlc\b)/i.test(value)) {
    return "Compact RN accepted";
  }
  if (/(current.{0,30}rn licen|active.{0,30}rn licen|licensed.{0,20}registered nurse)/i.test(value)) {
    return "Active RN license required";
  }
  return "RN license requirements vary";
}

/**
 * @param {string} text
 * @param {string} employer
 */
export function summaryFromText(text, employer) {
  const sentences = String(text ?? "").match(/[^.!?\n]+[.!?]/g) ?? [];
  const relevant = sentences.find((sentence) =>
    /(new grad|new graduate|residency|transition to practice|no experience)/i.test(sentence),
  );
  const cleaned = relevant?.trim();
  if (cleaned && cleaned.length >= 45 && cleaned.length <= 320) return cleaned;
  return `A current employer posting matched to a new graduate nursing pathway at ${employer}. Confirm cohort, unit, and eligibility details on the employer site.`;
}

/**
 * Pull the bulleted lines out of a stripped description so the detail view can
 * show requirements as a list instead of a wall of prose.
 *
 * @param {string} text
 * @param {number} [max]
 */
export function extractHighlights(text, max = 8) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.replace(/^[•\-–*•]\s*/, "").trim())
    .filter((line) => line.length >= 20 && line.length <= 220)
    .filter((line) => /(licen|bsn|adn|degree|nclex|bls|acls|certif|experience|graduat|shift|schedul|requir|prefer)/i.test(line))
    .slice(0, max);
}

/**
 * FNV-1a over the employer URL. Stable across scans so a saved job keeps its
 * identity, and stable across deploys so saved IDs in localStorage survive.
 *
 * @param {string} value
 */
export function stableId(value) {
  let hash = 2166136261;
  const input = String(value ?? "");
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `job-${(hash >>> 0).toString(36)}`;
}
