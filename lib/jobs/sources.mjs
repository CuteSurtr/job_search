/**
 * Employer career sites we poll, across two applicant tracking systems.
 *
 * Most entries are Workday CXS tenants, which expose a public JSON search
 * endpoint at `https://{host}/wday/cxs/{tenant}/{site}/jobs`. The rest are
 * Oracle Cloud Recruiting sites, where `host` is the tenant pod and `site` is
 * the candidate-experience site number (`CX_1`), and `tenant` is unused.
 * `lib/jobs/ats.mjs` resolves the difference; nothing else needs to know.
 *
 * `key` is the stable identifier the browser sends back to `/api/jobs/detail`,
 * so renaming one invalidates saved deep links. Add rather than rename.
 *
 * `states` is the employer's operating footprint. Several Workday tenants
 * report a facility name where a city should be ("Mercy Hospital South"), and
 * Workday exposes no city or state field at all — so for a single-state
 * employer the footprint is the only way to place a posting on the map, and it
 * is exact. Multi-state employers are deliberately left unresolved rather than
 * guessed at. Oracle sources need none of this: they report `City, ST` on every
 * posting, so even a seven-state employer places itself.
 *
 * @typedef {{ key: string, name: string, host: string, tenant?: string, site: string, accent: string, states: string[], ats: "workday" | "oracle" }} JobSource
 * @typedef {Omit<JobSource, "ats"> & { ats?: "workday" | "oracle" }} JobSourceInput
 */

/** @type {JobSourceInput[]} */
const REGISTRY = [
  {
    key: "adventhealth",
    name: "AdventHealth",
    host: "adventhealth.wd12.myworkdayjobs.com",
    tenant: "adventhealth",
    site: "AH_External_Career_Site",
    accent: "AH",
    states: ["FL", "GA", "IL", "KS", "KY", "NC", "TX", "WI", "CO"],
  },
  {
    key: "massgeneralbrigham",
    name: "Mass General Brigham",
    host: "massgeneralbrigham.wd1.myworkdayjobs.com",
    tenant: "massgeneralbrigham",
    site: "MGBExternal",
    accent: "MG",
    states: ["MA", "NH"],
  },
  {
    key: "ochsner",
    name: "Ochsner Health",
    host: "ochsner.wd1.myworkdayjobs.com",
    tenant: "ochsner",
    site: "Ochsner",
    accent: "OH",
    states: ["LA", "MS"],
  },
  {
    key: "saintlukes",
    name: "Saint Luke’s Health System",
    host: "saintlukes.wd1.myworkdayjobs.com",
    tenant: "saintlukes",
    site: "saintlukeshealthcareers",
    accent: "SL",
    states: ["MO", "KS"],
  },
  {
    key: "sentara",
    name: "Sentara Health",
    host: "sentara.wd1.myworkdayjobs.com",
    tenant: "sentara",
    site: "SCS",
    accent: "SH",
    states: ["VA", "NC"],
  },
  {
    key: "ohiohealth",
    name: "OhioHealth",
    host: "ohiohealth.wd5.myworkdayjobs.com",
    tenant: "ohiohealth",
    site: "OhioHealthJobs",
    accent: "OH",
    states: ["OH"],
  },
  {
    key: "stanfordmedicine",
    name: "Stanford Health Care",
    host: "stanfordmedicine.wd115.myworkdayjobs.com",
    tenant: "stanfordmedicine",
    site: "SHC_External_Career_Site",
    accent: "ST",
    states: ["CA"],
  },
  {
    key: "chop",
    name: "Children’s Hospital of Philadelphia",
    host: "chop.wd108.myworkdayjobs.com",
    tenant: "chop",
    site: "CHOPExternalCareers",
    accent: "CH",
    states: ["PA", "NJ"],
  },
  {
    key: "musc",
    name: "MUSC Health",
    host: "musc.wd1.myworkdayjobs.com",
    tenant: "musc",
    site: "MUSC",
    accent: "MU",
    states: ["SC"],
  },
  {
    key: "osu",
    name: "Ohio State Wexner Medical Center",
    host: "osu.wd1.myworkdayjobs.com",
    tenant: "osu",
    site: "OSUCareers",
    accent: "OS",
    states: ["OH"],
  },
  {
    key: "intermountain",
    name: "Intermountain Health",
    host: "imh.wd108.myworkdayjobs.com",
    tenant: "imh",
    site: "IntermountainCareers",
    accent: "IM",
    states: ["UT", "ID", "NV", "CO", "MT", "WY", "KS"],
  },
  {
    key: "denverhealth",
    name: "Denver Health",
    host: "denverhealth.wd1.myworkdayjobs.com",
    tenant: "denverhealth",
    site: "DHHA-Main",
    accent: "DH",
    states: ["CO"],
  },
  {
    key: "baystate",
    name: "Baystate Health",
    host: "baystatehealth.wd12.myworkdayjobs.com",
    tenant: "baystatehealth",
    site: "External_Careers",
    accent: "BS",
    states: ["MA"],
  },
  {
    key: "benefis",
    name: "Benefis Health System",
    host: "benefis.wd1.myworkdayjobs.com",
    tenant: "benefis",
    site: "BHS",
    accent: "BF",
    states: ["MT"],
  },
  {
    // Verified reachable, but currently between residency cohorts. Kept because
    // these programs are seasonal — dropping a source between intakes would
    // lose coverage at exactly the moment it starts posting again.
    key: "memorialhermann",
    name: "Memorial Hermann Health System",
    host: "memorialhermann.wd5.myworkdayjobs.com",
    tenant: "memorialhermann",
    site: "external",
    accent: "MH",
    states: ["TX"],
  },

  // Multi-state systems. These carry the most reach per source: one endpoint
  // covers residencies across many states, which is how national coverage gets
  // built without needing one tenant per state.
  {
    key: "trinityhealth",
    name: "Trinity Health",
    host: "trinityhealth.wd1.myworkdayjobs.com",
    tenant: "trinityhealth",
    site: "Jobs",
    accent: "TH",
    states: ["CA", "CT", "DE", "FL", "GA", "IA", "ID", "IL", "IN", "MA", "MD", "MI", "NE", "NJ", "NY", "OH", "OR", "PA", "SC", "WI"],
  },
  {
    key: "mercy",
    name: "Mercy",
    host: "mercy.wd1.myworkdayjobs.com",
    tenant: "mercy",
    site: "mercycareers",
    accent: "MC",
    states: ["MO", "AR", "OK", "KS"],
  },
  {
    key: "bannerhealth",
    name: "Banner Health",
    host: "bannerhealth.wd108.myworkdayjobs.com",
    tenant: "bannerhealth",
    site: "Careers",
    accent: "BN",
    states: ["AZ", "CA", "CO", "NE", "NV", "WY"],
  },
  {
    key: "uvmhealth",
    name: "University of Vermont Health Network",
    host: "uvmhealth.wd1.myworkdayjobs.com",
    tenant: "uvmhealth",
    site: "External",
    accent: "UV",
    states: ["VT", "NY"],
  },

  // Regional systems, each verified to return live new-grad matches.
  {
    key: "vumc",
    name: "Vanderbilt University Medical Center",
    host: "vumc.wd1.myworkdayjobs.com",
    tenant: "vumc",
    site: "vumccareers",
    accent: "VU",
    states: ["TN"],
  },
  {
    key: "adventisthealthcare",
    name: "Adventist HealthCare",
    host: "adventisthealthcare.wd1.myworkdayjobs.com",
    tenant: "adventisthealthcare",
    site: "AdventistHealthCareCareers",
    accent: "AC",
    states: ["MD"],
  },
  {
    key: "vcuhealth",
    name: "VCU Health",
    host: "vcuhealth.wd1.myworkdayjobs.com",
    tenant: "vcuhealth",
    site: "VCUHEALTH_Careers",
    accent: "VC",
    states: ["VA"],
  },
  {
    key: "memorialhealthcare",
    name: "Memorial Healthcare System",
    host: "memorialhealthcare.wd1.myworkdayjobs.com",
    tenant: "memorialhealthcare",
    site: "MHS_Careers",
    accent: "MS",
    states: ["FL"],
  },
  {
    key: "bmc",
    name: "Boston Medical Center",
    host: "bmc.wd1.myworkdayjobs.com",
    tenant: "bmc",
    site: "bmc",
    accent: "BM",
    states: ["MA"],
  },
  {
    key: "wellstar",
    name: "Wellstar Health System",
    host: "wellstar.wd1.myworkdayjobs.com",
    tenant: "wellstar",
    site: "wellstarcareers",
    accent: "WS",
    states: ["GA"],
  },

  // Reachable and verified, currently between cohorts. Each is included because
  // it is the only source we have for its state.
  {
    key: "multicare",
    name: "MultiCare Health System",
    host: "multicare.wd1.myworkdayjobs.com",
    tenant: "multicare",
    site: "multicare",
    accent: "ML",
    states: ["WA"],
  },
  {
    key: "sharp",
    name: "Sharp HealthCare",
    host: "sharp.wd1.myworkdayjobs.com",
    tenant: "sharp",
    site: "External",
    accent: "SP",
    states: ["CA"],
  },
  {
    key: "uofl",
    name: "UofL Health",
    host: "uofl.wd1.myworkdayjobs.com",
    tenant: "uofl",
    site: "UoflCareerSite",
    accent: "UL",
    states: ["KY"],
  },

  // Added to close geographic gaps. Sanford is the single biggest win here: one
  // endpoint covers the upper Midwest, including three states nothing else
  // reached. It also reports locations as "ND, Bismarck", which parses cleanly.
  {
    key: "sanford",
    name: "Sanford Health",
    host: "sanford.wd5.myworkdayjobs.com",
    tenant: "sanford",
    site: "SanfordHealth",
    accent: "SF",
    states: ["SD", "ND", "MN", "IA", "WY", "WI", "MI"],
  },
  {
    key: "phsorg",
    name: "Presbyterian Healthcare Services",
    host: "phsorg.wd1.myworkdayjobs.com",
    tenant: "phsorg",
    site: "Careers",
    accent: "PH",
    states: ["NM"],
  },
  {
    key: "mainegeneral",
    name: "MaineGeneral Health",
    host: "mainegeneral.wd5.myworkdayjobs.com",
    tenant: "mainegeneral",
    site: "mainegeneralcareers",
    accent: "ME",
    states: ["ME"],
  },
  {
    key: "brownhealth",
    name: "Brown University Health",
    host: "brownhealth.wd12.myworkdayjobs.com",
    tenant: "brownhealth",
    site: "External_Careers",
    accent: "BH",
    states: ["RI", "MA"],
  },
  {
    key: "nyp",
    name: "NewYork-Presbyterian",
    host: "nyp.wd1.myworkdayjobs.com",
    tenant: "nyp",
    site: "nypcareers",
    accent: "NP",
    states: ["NY"],
  },

  // The last five uncovered states. Four of these were previously recorded as
  // unreachable; three of them turned out to be ordinary Workday tenants under
  // a host nobody had found. WVU Medicine in particular answers HTTP 500 on the
  // search API its own careers page calls, which is what the earlier attempt
  // hit — the CXS endpoint underneath is healthy.
  {
    key: "wvumedicine",
    name: "WVU Medicine",
    host: "wvumedicine.wd1.myworkdayjobs.com",
    tenant: "wvumedicine",
    // Two sites are published, `WVUH` and `UHA`. WVUH is the hospital division
    // and the one that carries bedside postings; UHA is the physician practice.
    site: "WVUH",
    accent: "WV",
    states: ["WV", "PA", "MD", "OH"],
  },
  {
    key: "childrensnational",
    name: "Children’s National Hospital",
    host: "childrensnational.wd108.myworkdayjobs.com",
    tenant: "childrensnational",
    site: "CN_Careers",
    accent: "CN",
    states: ["DC", "MD", "VA"],
  },
  {
    // Verified reachable and currently between cohorts, kept for the same
    // reason as MultiCare and Sharp: it is the only source we have for Alabama.
    key: "southeasthealth",
    name: "Southeast Health",
    host: "seh.wd503.myworkdayjobs.com",
    tenant: "seh",
    site: "SoutheastHealth",
    accent: "SE",
    states: ["AL"],
  },

  // Oracle Cloud Recruiting. Both are large multi-state systems that no Workday
  // entry could reach, and both report `City, ST` on every posting — so unlike
  // the multi-state Workday tenants above, their roles place themselves on the
  // map instead of falling back to "varies".
  {
    ats: "oracle",
    key: "providence",
    name: "Providence",
    host: "evac.fa.us2.oraclecloud.com",
    site: "CX_1",
    accent: "PR",
    states: ["AK", "WA", "OR", "CA", "MT", "NM", "TX"],
  },
  {
    // Not AdventHealth. Two unrelated systems with near-identical names, both
    // in this registry, on different continents' worth of geography and
    // different ATSs. The accent codes are kept distinct on purpose.
    ats: "oracle",
    key: "adventisthealth",
    name: "Adventist Health",
    host: "ecvz.fa.us2.oraclecloud.com",
    site: "CX_1",
    accent: "AV",
    states: ["HI", "CA", "OR", "WA"],
  },
];

/**
 * Workday is the default because it is the overwhelming majority; an entry only
 * declares `ats` when it is something else.
 *
 * @type {JobSource[]}
 */
export const SOURCES = REGISTRY.map((source) => ({ ats: "workday", ...source }));

/** @type {Map<string, JobSource>} */
export const SOURCES_BY_KEY = new Map(SOURCES.map((source) => [source.key, source]));

/** Every state where at least one polled employer operates. */
export const COVERED_STATES = [...new Set(SOURCES.flatMap((source) => source.states))].sort();

/** @param {string} code */
export function employersInState(code) {
  return SOURCES.filter((source) => source.states.includes(code)).map((source) => source.name);
}

/**
 * Workday rejects any `limit` above 20 with an opaque HTTP 400, so paging is
 * the only way to read past the first 20 hits.
 */
export const WORKDAY_PAGE_SIZE = 20;

export const SEARCH_TERMS = ["nurse residency", "new graduate nurse"];

/** Workday only. @param {JobSource} source */
export function cxsUrl(source) {
  return `https://${source.host}/wday/cxs/${source.tenant}/${source.site}`;
}

/**
 * Workday external paths look like `/job/Orlando-FL/Nurse-Residency_25012345`.
 * Reject anything else so a crafted `path` query cannot walk the CXS API into
 * unrelated endpoints.
 *
 * Workday only — Oracle paths are numeric and validated by `isValidOraclePath`.
 * Route through `isValidPathFor` in `ats.mjs` rather than calling either
 * directly, so a source is never checked against the wrong ATS's rule.
 *
 * @param {unknown} path
 * @returns {path is string}
 */
export function isValidExternalPath(path) {
  return (
    typeof path === "string" &&
    path.length <= 300 &&
    /^\/job\/[^\s?#]+$/.test(path) &&
    !path.includes("..")
  );
}
