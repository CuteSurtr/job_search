import { readCache, writeCache } from "@/lib/jobs/cache.mjs";
import {
  extractHighlights,
  extractPay,
  licenseFromText,
  normalizeLocation,
  stableId,
  stripHtml,
  summaryFromText,
} from "@/lib/jobs/matching.mjs";
import { SOURCES_BY_KEY } from "@/lib/jobs/sources.mjs";
import { employerUrlFor, fetchDetailFor, isValidPathFor } from "@/lib/jobs/ats.mjs";
import type { JobDetail } from "@/lib/jobs/types";

export const dynamic = "force-dynamic";

const DETAIL_TTL_SECONDS = 3600;
const MAX_DESCRIPTION_CHARS = 6000;

/**
 * Full detail for one posting, fetched when a visitor opens it rather than for
 * every listing on every scan. Keeps the feed build cheap and gives the detail
 * view the real posting body instead of a one-line summary.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sourceKey = url.searchParams.get("source") ?? "";
  const path = url.searchParams.get("path") ?? "";

  const source = SOURCES_BY_KEY.get(sourceKey);
  if (!source) {
    return Response.json({ error: "Unknown source" }, { status: 400 });
  }
  // Validated against this source's own ATS, never a shared rule: Workday paths
  // are free-form text and Oracle's are numeric ids, so the looser check must
  // not be applied to the stricter system.
  if (!isValidPathFor(source, path)) {
    return Response.json({ error: "Invalid job path" }, { status: 400 });
  }

  const cacheKey = `detail:${sourceKey}:${path}`;
  const cached = await readCache<JobDetail>(cacheKey);
  if (cached) {
    const hit = Response.json(cached);
    hit.headers.set("Cache-Control", `public, s-maxage=${DETAIL_TTL_SECONDS}`);
    hit.headers.set("X-Feed-Cache", "hit");
    return hit;
  }

  const detail = await fetchDetailFor(source, path);
  if (!detail) {
    return Response.json({ error: "Posting is no longer available" }, { status: 502 });
  }

  const info = detail as {
    title?: string;
    location?: string;
    postedOn?: string;
    startDate?: string;
    timeType?: string;
    remoteType?: string;
    externalUrl?: string;
    jobDescription?: string;
  };

  const description = stripHtml(info.jobDescription ?? "");
  const employerUrl = info.externalUrl || employerUrlFor(source, path);
  const pay = extractPay(description);

  const payload: JobDetail = {
    id: stableId(employerUrl),
    title: info.title ?? "Nursing role",
    location: normalizeLocation(info.location, source.name).label,
    pay: pay.pay,
    payLabel: pay.payLabel,
    shift: info.timeType || info.remoteType || "Schedule on posting",
    start: info.startDate ? `Listed ${info.startDate}` : "See cohort details",
    license: licenseFromText(description),
    postedLabel: (info.postedOn || "Recently posted").replace(/^Posted\s+/i, ""),
    summary: summaryFromText(description, source.name),
    description: description.slice(0, MAX_DESCRIPTION_CHARS),
    highlights: extractHighlights(description),
    employerUrl,
  };

  await writeCache(cacheKey, payload, DETAIL_TTL_SECONDS);

  const response = Response.json(payload);
  response.headers.set("Cache-Control", `public, s-maxage=${DETAIL_TTL_SECONDS}`);
  response.headers.set("X-Feed-Cache", "miss");
  return response;
}
