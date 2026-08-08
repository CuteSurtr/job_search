"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HIRING_STATISTICS, STATISTICS_RETRIEVED } from "@/lib/content/statistics.mjs";
import { US_STATES } from "@/lib/jobs/matching.mjs";
import { employersInState } from "@/lib/jobs/sources.mjs";
import type { Job, JobDetail, FeedMeta } from "@/lib/jobs/types";

type FeedResponse = { jobs: Job[]; meta: FeedMeta };

const SAVED_KEY = "nurselaunch-saved-v2";
const LEGACY_SAVED_KEY = "nurselaunch-saved";
const LAST_VISIT_KEY = "nurselaunch-last-visit";

const ANY_STATE = "All states";
const ANY_SPECIALTY = "All specialties";
const ANY_PATH = "All paths";

const POSTED_WINDOWS = [
  { label: "Any time", value: "any", minutes: Number.POSITIVE_INFINITY },
  { label: "Past 24 hours", value: "1d", minutes: 24 * 60 },
  { label: "Past 3 days", value: "3d", minutes: 3 * 24 * 60 },
  { label: "Past week", value: "7d", minutes: 7 * 24 * 60 },
  { label: "Past 30 days", value: "30d", minutes: 30 * 24 * 60 },
];

/**
 * Timestamp of the previous visit, read once at mount and then frozen — if it
 * updated live, every role would stop being "new to you" the moment the page
 * loaded. Returns null on a first visit, when nothing is new by definition.
 */
function readLastVisit(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_VISIT_KEY);
    window.localStorage.setItem(LAST_VISIT_KEY, new Date().toISOString());
    if (!raw) return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type Filters = {
  query: string;
  state: string;
  specialty: string;
  setting: string;
  minPay: string;
  since: string;
  sort: string;
  residencyOnly: boolean;
  showSaved: boolean;
};

const DEFAULT_FILTERS: Filters = {
  query: "",
  state: ANY_STATE,
  specialty: ANY_SPECIALTY,
  setting: ANY_PATH,
  minPay: "0",
  since: "any",
  sort: "Newest",
  residencyOnly: false,
  showSaved: false,
};

function timeAgo(iso: string | undefined, now: number) {
  if (!iso) return "waiting for first scan";
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} hr ago`;
}

/**
 * There is no scheduler behind the feed — it re-scans when a visitor arrives
 * after the cache has expired. So this reports when the feed becomes due rather
 * than promising a scan at a fixed time, and says "due now" once it has passed
 * instead of counting down forever.
 */
function nextScan(iso: string | undefined, now: number) {
  if (!iso) return "soon";
  const minutes = Math.ceil((new Date(iso).getTime() - now) / 60000);
  if (minutes <= 0) return "due now";
  if (minutes <= 1) return "less than a minute";
  return `${minutes} min`;
}

/** "A", "A and B", "A, B and C", then "A, B, C and 4 more". */
function formatEmployerList(names: string[], max = 3) {
  const shown = names.slice(0, max);
  const remaining = names.length - shown.length;
  if (remaining > 0) return `${shown.join(", ")} and ${remaining} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** localStorage is user-writable and survives deploys, so never trust its shape. */
function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/**
 * Saved roles, tolerant of both storage formats. v2 holds whole job records so
 * a save survives the role leaving the feed; v1 held bare ids, which are kept
 * as stubs and filled in by the next feed load rather than discarded.
 */
function readSavedJobs(): Job[] {
  const stored = readStoredJson<unknown>(SAVED_KEY, null);
  if (Array.isArray(stored)) {
    return stored.filter((entry): entry is Job =>
      Boolean(entry && typeof entry === "object" && "id" in entry),
    );
  }

  const legacyIds = readStoredJson<unknown>(LEGACY_SAVED_KEY, []);
  if (!Array.isArray(legacyIds)) return [];
  return legacyIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => ({ id }) as Job);
}

/** Read filters from the query string so a shared URL reproduces the search. */
function filtersFromSearch(search: string): Partial<Filters> {
  const params = new URLSearchParams(search);
  const next: Partial<Filters> = {};
  if (params.get("q")) next.query = params.get("q") as string;
  if (params.get("state")) next.state = params.get("state") as string;
  if (params.get("specialty")) next.specialty = params.get("specialty") as string;
  if (params.get("path")) next.setting = params.get("path") as string;
  if (params.get("pay")) next.minPay = params.get("pay") as string;
  if (params.get("since")) next.since = params.get("since") as string;
  if (params.get("sort")) next.sort = params.get("sort") as string;
  if (params.get("residency") === "1") next.residencyOnly = true;
  if (params.get("saved") === "1") next.showSaved = true;
  return next;
}

function searchFromFilters(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.query.trim()) params.set("q", filters.query.trim());
  if (filters.state !== ANY_STATE) params.set("state", filters.state);
  if (filters.specialty !== ANY_SPECIALTY) params.set("specialty", filters.specialty);
  if (filters.setting !== ANY_PATH) params.set("path", filters.setting);
  if (filters.minPay !== "0") params.set("pay", filters.minPay);
  if (filters.since !== "any") params.set("since", filters.since);
  if (filters.sort !== "Newest") params.set("sort", filters.sort);
  if (filters.residencyOnly) params.set("residency", "1");
  if (filters.showSaved) params.set("saved", "1");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function JobsClient() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [meta, setMeta] = useState<FeedMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [savedJobs, setSavedJobs] = useState<Job[]>([]);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "error">("idle");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(12);
  // Starts at 0 rather than Date.now() to keep render pure. Nothing reads it
  // until `meta` arrives, and the feed load stamps it before that happens.
  const [now, setNow] = useState(0);
  const [copied, setCopied] = useState(false);
  const [lastVisit, setLastVisit] = useState<number | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertEmail, setAlertEmail] = useState("");
  const [alertState, setAlertState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [alertError, setAlertError] = useState("");

  const detailCache = useRef(new Map<string, JobDetail>());
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const hydratedFromUrl = useRef(false);

  /** Every filter change also returns the list to page one. */
  const setFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setVisibleCount(12);
  }, []);

  const loadJobs = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      // A manual check asks the server to re-scan; it re-scans only if its own
      // cached feed is stale enough, otherwise it replies from cache.
      const response = await fetch(manual ? "/api/jobs?refresh=1" : "/api/jobs", {
        headers: { accept: "application/json" },
        cache: manual ? "no-store" : "default",
      });
      if (!response.ok) throw new Error(`Feed returned ${response.status}`);
      const payload = (await response.json()) as FeedResponse;
      setJobs(payload.jobs);
      setMeta(payload.meta);
      setNow(Date.now());
      // Upgrade any v1 id-only saves to full records now that we have them, so
      // a saved role keeps its detail even after it drops out of the feed.
      setSavedJobs((current) => {
        let changed = false;
        const filled = current.map((entry) => {
          if (entry.title) return entry;
          const match = payload.jobs.find((job) => job.id === entry.id);
          if (!match) return entry;
          changed = true;
          return match;
        });
        return changed ? filled : current;
      });
    } catch {
      setError("The live feed is temporarily unavailable. Please try again in a moment.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // One-time hydration from browser-owned state (localStorage and the query
  // string). It has to happen after mount because neither exists during the
  // server render, and reading them lazily would desync hydration — which is
  // exactly the "subscribe to an external system" case the rule below guards.
  useEffect(() => {
    const restoredSaved = readSavedJobs();
    const urlFilters = filtersFromSearch(window.location.search);
    const previousVisit = readLastVisit();

    /* eslint-disable react-hooks/set-state-in-effect */
    setSavedJobs(restoredSaved);
    setFilters((current) => ({ ...current, ...urlFilters }));
    setLastVisit(previousVisit);
    /* eslint-enable react-hooks/set-state-in-effect */
    hydratedFromUrl.current = true;

    void loadJobs();
    // Alerts only appear when the deployment can actually deliver them.
    void fetch("/api/alerts", { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : { enabled: false }))
      .then((payload: { enabled?: boolean }) => setAlertsEnabled(payload.enabled === true))
      .catch(() => setAlertsEnabled(false));

    const refreshTimer = window.setInterval(() => void loadJobs(true), 60 * 60 * 1000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [loadJobs]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SAVED_KEY, JSON.stringify(savedJobs));
    } catch {
      // Private-mode or quota failures must not break the page.
    }
  }, [savedJobs]);

  // Mirror the active search into the URL so it can be shared or bookmarked.
  useEffect(() => {
    if (!hydratedFromUrl.current) return;
    const search = searchFromFilters(filters);
    const next = `${window.location.pathname}${search}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(null, "", next);
    }
  }, [filters]);

  const savedIds = useMemo(() => new Set(savedJobs.map((job) => job.id)), [savedJobs]);

  /** Live count per state, used to annotate the full national list. */
  const stateCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const job of jobs) counts.set(job.state, (counts.get(job.state) ?? 0) + 1);
    return counts;
  }, [jobs]);

  /**
   * All 50 states plus DC, always — not just the ones with a posting today.
   * Residency intakes are seasonal, so a state with nothing this week may have
   * a cohort next month, and hiding it makes the tracker look regional.
   */
  const stateOptions = useMemo(
    () => US_STATES.map((state) => ({ ...state, count: stateCounts.get(state.code) ?? 0 })),
    [stateCounts],
  );

  const multiStateCount = stateCounts.get("Multi-state") ?? 0;
  const selectedStateName = US_STATES.find((state) => state.code === filters.state)?.name ?? filters.state;

  /** Employers we poll in the selected state — empty means no coverage there yet. */
  const employersHere = useMemo(
    () => (filters.state === ANY_STATE ? [] : employersInState(filters.state)),
    [filters.state],
  );
  const specialties = useMemo(
    () => [...new Set(jobs.map((job) => job.specialty))].sort((a, b) => a.localeCompare(b)),
    [jobs],
  );

  /**
   * In the saved view, list saved snapshots rather than the live feed, so a role
   * that has since dropped off the feed is still reachable instead of silently
   * vanishing from the visitor's list.
   */
  const sourceJobs = useMemo(() => {
    if (!filters.showSaved) return jobs;
    const live = new Map(jobs.map((job) => [job.id, job]));
    // Prefer the live record, then drop any v1 stub the feed could not fill in.
    return savedJobs.map((job) => live.get(job.id) ?? job).filter((job) => job.title);
  }, [filters.showSaved, jobs, savedJobs]);

  const liveIds = useMemo(() => new Set(jobs.map((job) => job.id)), [jobs]);

  const sinceMinutes = useMemo(
    () => POSTED_WINDOWS.find((window) => window.value === filters.since)?.minutes ?? Number.POSITIVE_INFINITY,
    [filters.since],
  );

  const filteredJobs = useMemo(() => {
    const normalized = filters.query.trim().toLowerCase();
    const minPay = Number(filters.minPay);

    return sourceJobs
      .filter((job) => {
        const matchesQuery =
          !normalized ||
          [job.title, job.hospital, job.city, job.state, job.specialty, job.location]
            .join(" ")
            .toLowerCase()
            .includes(normalized);
        return (
          matchesQuery &&
          (filters.state === ANY_STATE || job.state === filters.state) &&
          (filters.specialty === ANY_SPECIALTY || job.specialty === filters.specialty) &&
          (filters.setting === ANY_PATH || job.setting === filters.setting) &&
          (minPay === 0 || (job.pay !== null && job.pay >= minPay)) &&
          job.postedMinutes <= sinceMinutes &&
          (!filters.residencyOnly || job.setting === "Residency")
        );
      })
      .sort((a, b) => {
        if (filters.sort === "Highest pay") return (b.pay ?? -1) - (a.pay ?? -1);
        if (filters.sort === "Employer") return a.hospital.localeCompare(b.hospital);
        return a.postedMinutes - b.postedMinutes;
      });
  }, [sourceJobs, filters, sinceMinutes]);

  /** Roles this tracker first saw after the visitor's previous visit. */
  const isNewToYou = useCallback(
    (job: Job) => {
      if (!lastVisit || !job.firstSeenAt) return false;
      const seen = Date.parse(job.firstSeenAt);
      return Number.isFinite(seen) && seen > lastVisit;
    },
    [lastVisit],
  );

  const newSinceLastVisit = useMemo(() => jobs.filter(isNewToYou).length, [jobs, isNewToYou]);

  const addedRecently = jobs.filter((job) => job.postedMinutes <= 24 * 60).length;
  const listedPayCount = jobs.filter((job) => job.pay !== null).length;
  const syncLabel = timeAgo(meta?.updatedAt, now);
  const nextScanLabel = nextScan(meta?.nextRefreshAt, now);

  const clearFilters = useCallback(() => {
    setFilters((current) => ({ ...DEFAULT_FILTERS, showSaved: current.showSaved }));
    setVisibleCount(12);
  }, []);

  const toggleSaved = useCallback((job: Job) => {
    setSavedJobs((current) =>
      current.some((entry) => entry.id === job.id)
        ? current.filter((entry) => entry.id !== job.id)
        : [...current, job],
    );
  }, []);

  const openJob = useCallback((job: Job, trigger: HTMLElement | null) => {
    restoreFocusTo.current = trigger;
    setSelectedJob(job);
  }, []);

  const closeJob = useCallback(() => {
    setSelectedJob(null);
    setDetail(null);
    setDetailState("idle");
  }, []);

  // Fetch the full posting only when a visitor actually opens it.
  useEffect(() => {
    if (!selectedJob) return;
    const key = `${selectedJob.sourceKey}:${selectedJob.path}`;
    const cachedDetail = detailCache.current.get(key);
    if (cachedDetail) {
      setDetail(cachedDetail);
      setDetailState("idle");
      return;
    }
    if (!selectedJob.sourceKey || !selectedJob.path) {
      setDetailState("error");
      return;
    }

    let cancelled = false;
    setDetail(null);
    setDetailState("loading");

    void (async () => {
      try {
        const params = new URLSearchParams({ source: selectedJob.sourceKey, path: selectedJob.path });
        const response = await fetch(`/api/jobs/detail?${params}`, { headers: { accept: "application/json" } });
        if (!response.ok) throw new Error(`Detail returned ${response.status}`);
        const payload = (await response.json()) as JobDetail;
        detailCache.current.set(key, payload);
        if (cancelled) return;
        setDetail(payload);
        setDetailState("idle");
      } catch {
        if (!cancelled) setDetailState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedJob]);

  // Dialog behaviour: escape to close, focus moved in and handed back, and the
  // page behind held still while it is open.
  useEffect(() => {
    if (!selectedJob) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeJob();
    };
    document.addEventListener("keydown", onKeyDown);

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      restoreFocusTo.current?.focus();
      restoreFocusTo.current = null;
    };
  }, [selectedJob, closeJob]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  /** Subscribes the visitor's current filters, so the digest matches what they see. */
  const submitAlert = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setAlertState("sending");
      setAlertError("");
      try {
        const response = await fetch("/api/alerts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: alertEmail,
            filters: {
              state: filters.state === ANY_STATE ? null : filters.state,
              specialty: filters.specialty === ANY_SPECIALTY ? null : filters.specialty,
              setting: filters.setting === ANY_PATH ? null : filters.setting,
              minPay: Number(filters.minPay) || null,
              residencyOnly: filters.residencyOnly,
            },
          }),
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Could not subscribe.");
        setAlertState("sent");
      } catch (error) {
        setAlertState("error");
        setAlertError(error instanceof Error ? error.message : "Could not subscribe.");
      }
    },
    [alertEmail, filters],
  );

  const closeAlert = useCallback(() => {
    setAlertOpen(false);
    setAlertState("idle");
    setAlertError("");
  }, []);

  const shareSearch = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, []);

  const goToJobs = () => document.getElementById("jobs")?.scrollIntoView();
  const detailPay = detail?.payLabel ?? (selectedJob?.enriched ? selectedJob.payLabel : null);

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="NurseLaunch home">
          <span className="brand-mark" aria-hidden="true"><i /><i /></span>
          <span>NurseLaunch</span>
        </a>
        <nav className="desktop-nav" aria-label="Primary navigation">
          <a className={!filters.showSaved ? "active" : ""} href="#jobs" onClick={() => setFilter("showSaved", false)}>Find jobs</a>
          <a href="#how-it-works">How it works</a>
          <a href="#hiring-data">Hiring data</a>
          <button
            className={`nav-saved ${filters.showSaved ? "active" : ""}`}
            onClick={() => { setFilter("showSaved", true); goToJobs(); }}
          >
            Saved <span>{savedJobs.length}</span>
          </button>
        </nav>
        <button className="header-cta" onClick={() => { setFilter("showSaved", !filters.showSaved); goToJobs(); }}>
          {filters.showSaved ? "Browse all jobs" : `Saved jobs · ${savedJobs.length}`}
        </button>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="eyebrow"><span className="pulse-dot" /> Live employer feed · refreshed hourly</div>
            <h1 id="hero-title">Your first nursing job,<br />without the endless scroll.</h1>
            <p>
              New graduate RN residencies and early-career roles pulled directly from
              participating hospital career sites—never reposted application links.
            </p>
          </div>
          <div className="hero-stats" aria-label="Live job tracker statistics">
            <div><strong>{loading ? "—" : jobs.length}</strong><span>live matches</span></div>
            <div><strong>{loading ? "—" : addedRecently}</strong><span>posted today</span></div>
            <div><strong>{loading ? "—" : meta?.successfulSources ?? 0}</strong><span>employers checked</span></div>
          </div>
        </section>

        <section className="search-dock" aria-label="Search jobs">
          <label className="search-field">
            <span aria-hidden="true">⌕</span>
            <span className="sr-only">Search jobs</span>
            <input
              value={filters.query}
              onChange={(event) => setFilter("query", event.target.value)}
              placeholder="Search specialty, hospital, or city"
            />
          </label>
          <label className="select-field">
            <span className="sr-only">State</span>
            <select value={filters.state} onChange={(event) => setFilter("state", event.target.value)}>
              <option value={ANY_STATE}>All 50 states</option>
              {multiStateCount > 0 && <option value="Multi-state">Multi-state ({multiStateCount})</option>}
              {stateOptions.map((state) => (
                <option key={state.code} value={state.code}>
                  {state.name}{state.count > 0 ? ` (${state.count})` : ""}
                </option>
              ))}
            </select>
          </label>
          <button className="search-button" onClick={goToJobs}>Search jobs</button>
        </section>

        <section className="trust-strip">
          <span>Conservative new-grad title matching</span>
          <span>Direct employer links</span>
          <span>One-hour source cache</span>
        </section>

        <section className="jobs-layout" id="jobs">
          <button className="mobile-filter-button" onClick={() => setFiltersOpen(!filtersOpen)}>
            Filters <span>{filteredJobs.length} matches</span>
          </button>

          <aside className={`filters ${filtersOpen ? "open" : ""}`} aria-label="Job filters">
            <div className="filter-heading"><h2>Filters</h2><button onClick={clearFilters}>Clear all</button></div>
            <div className="filter-group">
              <h3>Specialty</h3>
              <div className="specialty-list">
                <button
                  className={filters.specialty === ANY_SPECIALTY ? "selected" : ""}
                  onClick={() => setFilter("specialty", ANY_SPECIALTY)}
                >
                  {ANY_SPECIALTY} <span>{jobs.length}</span>
                </button>
                {specialties.map((item) => (
                  <button
                    key={item}
                    className={filters.specialty === item ? "selected" : ""}
                    onClick={() => setFilter("specialty", item)}
                  >
                    {item}<span>{jobs.filter((job) => job.specialty === item).length}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="filter-group">
              <label htmlFor="path-select">Entry path</label>
              <select id="path-select" value={filters.setting} onChange={(event) => setFilter("setting", event.target.value)}>
                <option>{ANY_PATH}</option><option>Residency</option><option>Staff RN</option><option>Fellowship</option>
              </select>
            </div>
            <div className="filter-group">
              <label htmlFor="since-select">Posted within</label>
              <select id="since-select" value={filters.since} onChange={(event) => setFilter("since", event.target.value)}>
                {POSTED_WINDOWS.map((window) => (
                  <option key={window.value} value={window.value}>{window.label}</option>
                ))}
              </select>
            </div>
            <div className="filter-group">
              <label htmlFor="pay-select">Minimum listed pay</label>
              <select id="pay-select" value={filters.minPay} onChange={(event) => setFilter("minPay", event.target.value)}>
                <option value="0">Any pay ({listedPayCount} list pay)</option>
                <option value="30">$30+/hr</option><option value="35">$35+/hr</option><option value="40">$40+/hr</option><option value="45">$45+/hr</option><option value="50">$50+/hr</option>
              </select>
              <small className="filter-hint">Only postings that publish a rate can match a minimum.</small>
            </div>
            <label className="switch-row">
              <span><strong>Residencies only</strong><small>Structured transition programs</small></span>
              <input type="checkbox" checked={filters.residencyOnly} onChange={(event) => setFilter("residencyOnly", event.target.checked)} />
              <i aria-hidden="true" />
            </label>
            <div className="scan-card">
              <span className={`scan-icon ${refreshing ? "spinning" : ""}`} aria-hidden="true">↻</span>
              <div><strong>Source refresh {nextScanLabel === "due now" ? "due now" : `in ${nextScanLabel}`}</strong><small>Last checked {syncLabel}</small></div>
              <button disabled={refreshing} aria-label="Check the cached job feed now" onClick={() => void loadJobs(true)}>{refreshing ? "Checking…" : "Check now"}</button>
            </div>
          </aside>

          <div className="results-column">
            <div className="results-toolbar">
              <div>
                <h2>{filters.showSaved ? "Saved roles" : "Live new grad roles"}</h2>
                <p>
                  {loading
                    ? "Scanning employer career sites…"
                    : `${filteredJobs.length} matching ${filteredJobs.length === 1 ? "role" : "roles"} · Feed updated ${syncLabel}`}
                </p>
              </div>
              <label className="sort-control">
                <span>Sort</span>
                <select value={filters.sort} onChange={(event) => setFilter("sort", event.target.value)}>
                  <option>Newest</option><option>Highest pay</option><option>Employer</option>
                </select>
              </label>
            </div>

            <div className="active-filters" aria-live="polite">
              {filters.showSaved && <button onClick={() => setFilter("showSaved", false)}>Saved only ×</button>}
              {filters.state !== ANY_STATE && <button onClick={() => setFilter("state", ANY_STATE)}>{selectedStateName} ×</button>}
              {filters.specialty !== ANY_SPECIALTY && <button onClick={() => setFilter("specialty", ANY_SPECIALTY)}>{filters.specialty} ×</button>}
              {filters.setting !== ANY_PATH && <button onClick={() => setFilter("setting", ANY_PATH)}>{filters.setting} ×</button>}
              {filters.since !== "any" && <button onClick={() => setFilter("since", "any")}>{POSTED_WINDOWS.find((window) => window.value === filters.since)?.label} ×</button>}
              {Number(filters.minPay) > 0 && <button onClick={() => setFilter("minPay", "0")}>${filters.minPay}+/hr ×</button>}
              {filters.residencyOnly && <button onClick={() => setFilter("residencyOnly", false)}>Residencies only ×</button>}
              {!loading && filteredJobs.length > 0 && (
                <button className="share-chip" onClick={() => void shareSearch()}>{copied ? "Link copied ✓" : "Copy search link"}</button>
              )}
            </div>

            {!loading && newSinceLastVisit > 0 && !filters.showSaved && (
              <p className="visit-note">
                {newSinceLastVisit} {newSinceLastVisit === 1 ? "role has" : "roles have"} appeared since your last visit.
              </p>
            )}

            {error && (
              <div className="feed-error" role="alert">
                <div><strong>Live feed paused</strong><p>{error}</p></div>
                <button onClick={() => void loadJobs()}>Try again</button>
              </div>
            )}

            {loading ? (
              <div className="job-list" aria-label="Loading live jobs">
                {[1, 2, 3].map((item) => <div className="job-card loading-card" key={item}><i /><span /><span /><b /></div>)}
              </div>
            ) : (
              <div className="job-list">
                {filteredJobs.slice(0, visibleCount).map((job, index) => (
                  <article className={`job-card ${index === 0 && !filters.showSaved ? "featured" : ""}`} key={job.id}>
                    <div className="job-topline">
                      <div className="hospital-mark" aria-hidden="true">{job.accent}</div>
                      <div className="job-title-block">
                        <div className="job-badges">
                          <span className="verified">New-grad match</span>
                          <span>{job.setting}</span>
                          {job.postedMinutes <= 24 * 60 && <span className="hot">New today</span>}
                          {isNewToYou(job) && <span className="fresh">New to you</span>}
                          {filters.showSaved && !liveIds.has(job.id) && <span className="stale">Not in current feed</span>}
                        </div>
                        <h3><button onClick={(event) => openJob(job, event.currentTarget)}>{job.title}</button></h3>
                        <p>{job.hospital} <i>·</i> {job.location}</p>
                      </div>
                      <button
                        className={`save-button ${savedIds.has(job.id) ? "saved" : ""}`}
                        onClick={() => toggleSaved(job)}
                        aria-pressed={savedIds.has(job.id)}
                        aria-label={savedIds.has(job.id) ? `Unsave ${job.title}` : `Save ${job.title}`}
                      >
                        {savedIds.has(job.id) ? "♥" : "♡"}
                      </button>
                    </div>
                    <div className="job-facts"><span>{job.specialty}</span><span>{job.shift}</span><span>{job.license}</span></div>
                    <div className="job-footer">
                      <div className="pay-block"><strong>{job.payLabel}</strong><span>{job.start}</span></div>
                      <div className="job-actions">
                        <small>{job.postedLabel}</small>
                        <button onClick={(event) => openJob(job, event.currentTarget)}>View role <span>→</span></button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {!loading && !error && filteredJobs.length === 0 && (
              <div className="empty-state">
                <span>⌕</span>
                <h3>
                  {filters.showSaved
                    ? "No saved roles yet"
                    : filters.state !== ANY_STATE
                      ? `No live roles in ${selectedStateName} right now`
                      : "No matching live roles"}
                </h3>
                <p>
                  {filters.showSaved ? (
                    "Tap the heart on any role to keep it here. Saved roles stay on this device."
                  ) : filters.state !== ANY_STATE && employersHere.length > 0 ? (
                    <>
                      We check {formatEmployerList(employersHere)} in {selectedStateName} every hour. New graduate
                      residencies run in seasonal cohorts, so a state can be empty one month and hiring the next.
                    </>
                  ) : filters.state !== ANY_STATE ? (
                    <>
                      We do not yet poll an employer in {selectedStateName}. The tracker currently covers{" "}
                      {meta?.coveredStates?.length ?? 40} states across {meta?.sourceCount ?? 28} hospital systems, and
                      more are added as their career feeds are verified.
                    </>
                  ) : (
                    "Try widening your filters. The source feed checks again every hour."
                  )}
                </p>
                <button onClick={filters.showSaved ? () => setFilter("showSaved", false) : clearFilters}>
                  {filters.showSaved ? "Browse live roles" : "Reset filters"}
                </button>
              </div>
            )}

            {!loading && visibleCount < filteredJobs.length && (
              <button className="load-more" onClick={() => setVisibleCount((count) => count + 12)}>Show more live roles <span>↓</span></button>
            )}

            {meta && meta.failedSources.length > 0 && (
              <p className="source-note">
                {meta.successfulSources} of {meta.sourceCount} sources responded during this scan. Unavailable sources will be retried automatically.
              </p>
            )}
          </div>
        </section>

        <section className="how-it-works" id="how-it-works" aria-labelledby="how-title">
          <div className="section-intro">
            <span className="eyebrow">How it works</span>
            <h2 id="how-title">Three steps, no reposted listings.</h2>
          </div>
          <ol className="how-steps">
            <li>
              <strong>We poll employer career sites directly</strong>
              <p>Every hour we read the public job feeds of {meta?.sourceCount ?? 8} hospital systems. Nothing is scraped from an aggregator, so each link opens the employer&apos;s own application.</p>
            </li>
            <li>
              <strong>We keep only genuine new-grad pathways</strong>
              <p>A posting must name a residency, fellowship, or new graduate track. Advanced-practice, LPN, and management roles that share the vocabulary are filtered out.</p>
            </li>
            <li>
              <strong>You filter, save, and apply at the source</strong>
              <p>Narrow by state, specialty, entry path, or posted date, keep roles with the heart icon, and share a filtered search with a single link.</p>
            </li>
          </ol>
        </section>

        <section className="stats-section" id="hiring-data" aria-labelledby="stats-title">
          <div className="section-intro">
            <span className="eyebrow">The new grad market</span>
            <h2 id="stats-title">What the hiring data says.</h2>
            <p className="section-lede">
              Context for the roles above, from published workforce research rather than from this feed.
            </p>
          </div>
          <div className="stats-grid">
            {HIRING_STATISTICS.map((stat) => (
              <article className="stat-card" key={stat.id}>
                <strong>{stat.value}</strong>
                <h3>{stat.label}</h3>
                <p>{stat.detail}</p>
                <a href={stat.sourceUrl} target="_blank" rel="noreferrer noopener">
                  {stat.source} <span className="stat-period">· {stat.period}</span>
                </a>
              </article>
            ))}
          </div>
          <p className="stats-note">
            Figures are transcribed from the sources linked on each card and were last checked in{" "}
            {STATISTICS_RETRIEVED}. They describe the national market, not the roles listed above.
          </p>
        </section>

        <section className="alert-banner">
          <div>
            <span className="eyebrow">Built for a focused search</span>
            <h2>{alertsEnabled ? "Get new roles by email." : "Fresh roles. Straight to the source."}</h2>
            <p>
              {alertsEnabled
                ? "We will email you when new roles match the filters you have set. Confirm once, unsubscribe from any email."
                : "Listings link directly to hospital career sites and refresh from the source feed about once an hour."}
            </p>
          </div>
          {alertsEnabled ? (
            <button onClick={() => setAlertOpen(true)}>Email me new roles <span>→</span></button>
          ) : (
            <button onClick={() => { clearFilters(); setFilter("showSaved", false); goToJobs(); }}>Browse every live role <span>→</span></button>
          )}
        </section>
      </main>

      <footer>
        <a className="brand footer-brand" href="#top"><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>NurseLaunch</span></a>
        <p>Current employer postings for the first step in your nursing career.</p>
        <div><a href="#how-it-works">How it works</a><a href="mailto:hello@nurselaunch.example">Feedback</a><span>© 2026 NurseLaunch</span></div>
      </footer>

      {alertOpen && (
        <div className="modal-backdrop centered" onMouseDown={closeAlert}>
          <section
            className="alert-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="alert-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="modal-close" onClick={closeAlert} aria-label="Close">×</button>
            {alertState === "sent" ? (
              <div className="alert-success">
                <span aria-hidden="true">✓</span>
                <h2 id="alert-dialog-title">Check your inbox</h2>
                <p>Confirm the link we just sent and your alerts will start. Nothing is sent until you do.</p>
                <button onClick={closeAlert}>Done</button>
              </div>
            ) : (
              <>
                <span className="eyebrow">Job alerts</span>
                <h2 id="alert-dialog-title">Email me matching roles</h2>
                <p>
                  You will get roles matching your current filters
                  {filters.state !== ANY_STATE && <> in <strong>{filters.state}</strong></>}
                  {filters.specialty !== ANY_SPECIALTY && <> for <strong>{filters.specialty}</strong></>}
                  . At most one email a day.
                </p>
                <form onSubmit={submitAlert}>
                  <label>
                    Email address
                    <input
                      type="email"
                      required
                      value={alertEmail}
                      onChange={(event) => setAlertEmail(event.target.value)}
                      placeholder="you@example.com"
                      autoComplete="email"
                    />
                  </label>
                  {alertState === "error" && <p className="detail-note">{alertError}</p>}
                  <button type="submit" disabled={alertState === "sending"}>
                    {alertState === "sending" ? "Sending…" : "Send confirmation link"}
                  </button>
                </form>
                <small>Double opt-in. We only store your address and filters, and never share them.</small>
              </>
            )}
          </section>
        </div>
      )}

      {selectedJob && (
        <div className="modal-backdrop" onMouseDown={closeJob}>
          <section
            className="detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="job-dialog-title"
            tabIndex={-1}
            ref={(node) => { dialogRef.current = node; }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="modal-close" onClick={closeJob} aria-label="Close job details">×</button>
            <div className="detail-header">
              <div className="hospital-mark large">{selectedJob.accent}</div>
              <div>
                <span className="verified">New-grad match</span>
                <h2 id="job-dialog-title">{selectedJob.title}</h2>
                <p>{selectedJob.hospital} · {detail?.location ?? selectedJob.location}</p>
              </div>
            </div>
            <div className="detail-grid">
              <div><span>Pay range</span><strong>{detailPay ?? (detailState === "loading" ? "Checking…" : "See posting")}</strong></div>
              <div><span>Schedule</span><strong>{detail?.shift ?? selectedJob.shift}</strong></div>
              <div><span>Posting age</span><strong>{detail?.postedLabel ?? selectedJob.postedLabel}</strong></div>
              <div><span>License</span><strong>{detail?.license ?? selectedJob.license}</strong></div>
            </div>
            <div className="detail-body">
              <h3>Why it matched</h3>
              <p>{detail?.summary ?? selectedJob.summary}</p>

              {detailState === "loading" && (
                <div className="detail-loading" aria-live="polite"><span /><span /><span /></div>
              )}

              {detailState === "error" && (
                <p className="detail-note">
                  The full posting could not be loaded right now. Open it on the employer site for complete requirements.
                </p>
              )}

              {detail && detail.highlights.length > 0 && (
                <>
                  <h3 className="detail-subhead">Requirements at a glance</h3>
                  <ul className="detail-highlights">
                    {detail.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}
                  </ul>
                </>
              )}

              {detail && detail.description && (
                <details className="detail-full">
                  <summary>Read the full posting</summary>
                  <div className="detail-description">
                    {detail.description.split("\n").filter(Boolean).map((line, index) => (
                      <p key={`${index}-${line.slice(0, 24)}`}>{line}</p>
                    ))}
                  </div>
                </details>
              )}

              <div className="verification-note">
                <span>✓</span>
                <p>
                  <strong>Matched from the current employer listing</strong><br />
                  The title explicitly signals a new graduate or nurse residency pathway. Always confirm cohort dates, license timing, and experience requirements with the employer.
                </p>
              </div>
            </div>
            <div className="detail-actions">
              <button onClick={() => toggleSaved(selectedJob)} aria-pressed={savedIds.has(selectedJob.id)}>
                {savedIds.has(selectedJob.id) ? "♥ Saved" : "♡ Save role"}
              </button>
              <a href={detail?.employerUrl ?? selectedJob.employerUrl} target="_blank" rel="noreferrer">
                Open employer posting <span>↗</span>
              </a>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
