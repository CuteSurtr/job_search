/**
 * Alert subscription logic, kept free of I/O so every rule here is testable.
 *
 * Nothing in this file sends mail or touches a database; it decides what a
 * subscription means, which postings belong in a digest, and when one is due.
 */

/** Digest cadence. A new grad checking daily is the case worth serving. */
export const DIGEST_INTERVAL_HOURS = 24;

/** Never put more than this in one email — a wall of jobs gets deleted, not read. */
export const MAX_DIGEST_JOBS = 12;

/**
 * Deliberately conservative. This is not RFC 5322 — it rejects the shapes that
 * are almost certainly typos or injection attempts, and anything surviving it
 * still has to pass the confirmation click before it ever receives a digest.
 *
 * @param {unknown} value
 * @returns {string | null} the normalised address, or null when unusable
 */
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length < 6 || trimmed.length > 254) return null;
  if (/[\s<>(),;:"\\[\]]/.test(trimmed)) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(trimmed)) return null;
  if (trimmed.includes("..")) return null;
  return trimmed;
}

/**
 * Keep only the filter fields a digest actually understands, so an arbitrary
 * JSON body cannot become arbitrary stored state.
 *
 * @param {unknown} input
 */
export function sanitizeFilters(input) {
  const source = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  const text = (value, max = 60) =>
    typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null;

  const minPay = Number(source.minPay);
  return {
    state: text(source.state, 20),
    specialty: text(source.specialty),
    setting: text(source.setting, 20),
    minPay: Number.isFinite(minPay) && minPay > 0 && minPay < 500 ? minPay : null,
    residencyOnly: source.residencyOnly === true,
  };
}

/**
 * Does a posting belong in this subscription's digest?
 *
 * @param {import("./types").Job} job
 * @param {ReturnType<typeof sanitizeFilters>} filters
 */
export function jobMatchesFilters(job, filters) {
  if (filters.state && job.state !== filters.state) return false;
  if (filters.specialty && job.specialty !== filters.specialty) return false;
  if (filters.setting && job.setting !== filters.setting) return false;
  if (filters.residencyOnly && job.setting !== "Residency") return false;
  // A pay floor can only be judged against a posting that publishes one.
  if (filters.minPay !== null && (job.pay === null || job.pay < filters.minPay)) return false;
  return true;
}

/**
 * Postings to include for one subscriber: matching their filters, and first
 * seen since their last digest. The watermark is what stops a daily email from
 * repeating the same roles forever.
 *
 * @param {import("./types").Job[]} jobs
 * @param {ReturnType<typeof sanitizeFilters>} filters
 * @param {string | null} lastSentAt
 */
export function selectDigestJobs(jobs, filters, lastSentAt) {
  const watermark = lastSentAt ? Date.parse(lastSentAt) : Number.NaN;

  return jobs
    .filter((job) => {
      if (!jobMatchesFilters(job, filters)) return false;
      // With no history we cannot tell new from old, so a first digest sends
      // the current matches rather than nothing.
      if (!Number.isFinite(watermark)) return true;
      if (!job.firstSeenAt) return false;
      const seen = Date.parse(job.firstSeenAt);
      return Number.isFinite(seen) && seen > watermark;
    })
    .sort((a, b) => a.postedMinutes - b.postedMinutes)
    .slice(0, MAX_DIGEST_JOBS);
}

/**
 * @param {{ status: string, lastSentAt: string | null }} subscription
 * @param {number} [nowMs]
 */
export function digestDue(subscription, nowMs = Date.now()) {
  if (subscription.status !== "confirmed") return false;
  if (!subscription.lastSentAt) return true;
  const last = Date.parse(subscription.lastSentAt);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= DIGEST_INTERVAL_HOURS * 3600 * 1000;
}

/**
 * A capability secret for the confirm and unsubscribe links. Random rather than
 * derived, so knowing an address tells you nothing about its token.
 */
export function createToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @param {unknown} token */
export function isValidToken(token) {
  return typeof token === "string" && /^[0-9a-f]{48}$/.test(token);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {import("./types").Job[]} jobs
 * @param {{ origin: string, token: string }} links
 */
export function renderDigestEmail(jobs, { origin, token }) {
  const unsubscribe = `${origin}/api/alerts/unsubscribe?token=${token}`;
  const rows = jobs
    .map(
      (job) => `
      <tr><td style="padding:14px 0;border-bottom:1px solid #e3e8e4">
        <a href="${escapeHtml(job.employerUrl)}" style="color:#0d6b67;font-weight:700;text-decoration:none">${escapeHtml(job.title)}</a>
        <div style="color:#5f6f6c;font-size:13px;margin-top:4px">${escapeHtml(job.hospital)} · ${escapeHtml(job.location)}</div>
        <div style="color:#7d8a87;font-size:12px;margin-top:2px">${escapeHtml(job.specialty)} · ${escapeHtml(job.payLabel)}</div>
      </td></tr>`,
    )
    .join("");

  const plural = jobs.length === 1 ? "role" : "roles";
  return {
    subject: `${jobs.length} new grad nursing ${plural} matching your search`,
    html: `<!doctype html><html><body style="margin:0;background:#f7f6f1;font-family:system-ui,-apple-system,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:28px 20px">
    <h1 style="font-size:20px;color:#142b2c;margin:0 0 6px">NurseLaunch</h1>
    <p style="color:#5f6f6c;font-size:14px;margin:0 0 18px">${jobs.length} new ${plural} since your last digest.</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="color:#8b9793;font-size:11px;margin-top:24px">
      Listings link to each employer's own posting. Always confirm eligibility with the employer.<br>
      <a href="${unsubscribe}" style="color:#8b9793">Unsubscribe</a>
    </p>
  </div></body></html>`,
    text: `NurseLaunch — ${jobs.length} new ${plural} since your last digest.\n\n${jobs
      .map((job) => `- ${job.title}\n  ${job.hospital} · ${job.location}\n  ${job.employerUrl}`)
      .join("\n\n")}\n\nUnsubscribe: ${unsubscribe}\n`,
  };
}

/**
 * @param {{ origin: string, token: string }} links
 */
export function renderConfirmEmail({ origin, token }) {
  const confirm = `${origin}/api/alerts/confirm?token=${token}`;
  return {
    subject: "Confirm your NurseLaunch job alerts",
    html: `<!doctype html><html><body style="margin:0;background:#f7f6f1;font-family:system-ui,-apple-system,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:28px 20px">
    <h1 style="font-size:20px;color:#142b2c;margin:0 0 6px">Confirm your alerts</h1>
    <p style="color:#5f6f6c;font-size:14px">Click below to start receiving new grad nursing roles matching your search. If you did not request this, ignore this email — nothing will be sent.</p>
    <p><a href="${confirm}" style="display:inline-block;background:#0d6b67;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Confirm subscription</a></p>
  </div></body></html>`,
    text: `Confirm your NurseLaunch alerts: ${confirm}\n\nIf you did not request this, ignore this email — nothing will be sent.\n`,
  };
}
