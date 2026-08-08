/**
 * Outbound email, via whatever provider is configured.
 *
 * There is no default provider and no fallback: with no API key the whole alert
 * feature reports itself as unavailable rather than quietly accepting addresses
 * it can never mail. `alertsConfigured()` is what the API and the UI use to
 * decide whether to offer subscriptions at all.
 *
 * Configure by setting both, as Worker secrets:
 *   RESEND_API_KEY    an API key from resend.com
 *   ALERTS_FROM_EMAIL a verified sender, e.g. "NurseLaunch <alerts@yourdomain>"
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

let envPromise = null;

async function getWorkerEnv() {
  if (!envPromise) {
    envPromise = import("cloudflare:workers")
      .then((module) => module.env ?? null)
      .catch(() => null);
  }
  return envPromise;
}

/** @returns {Promise<{ apiKey: string, from: string } | null>} */
export async function emailConfig() {
  const env = await getWorkerEnv();
  const apiKey = env?.RESEND_API_KEY;
  const from = env?.ALERTS_FROM_EMAIL;
  if (typeof apiKey !== "string" || !apiKey) return null;
  if (typeof from !== "string" || !from) return null;
  return { apiKey, from };
}

export async function alertsConfigured() {
  return (await emailConfig()) !== null;
}

/**
 * Send one message. Returns false rather than throwing, so a provider outage
 * degrades a digest instead of failing the request that triggered it.
 *
 * @param {{ to: string, subject: string, html: string, text: string }} message
 */
export async function sendEmail({ to, subject, html, text }) {
  const config = await emailConfig();
  if (!config) return false;

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: config.from, to: [to], subject, html, text }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      // Never log the recipient — this is the one place a subscriber address
      // could leak into logs.
      console.error("[email] provider rejected send:", response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[email] send failed:", error instanceof Error ? error.message : error);
    return false;
  }
}
