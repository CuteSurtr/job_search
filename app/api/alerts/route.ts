import {
  createToken,
  normalizeEmail,
  renderConfirmEmail,
  sanitizeFilters,
} from "@/lib/jobs/alerts.mjs";
import { alertsConfigured, sendEmail } from "@/lib/jobs/email.mjs";
import { getSubscriptionDb, upsertPending } from "@/lib/jobs/subscriptions.mjs";

export const dynamic = "force-dynamic";

/** Advertises whether subscriptions can be accepted at all. */
export async function GET() {
  const [configured, db] = await Promise.all([alertsConfigured(), getSubscriptionDb()]);
  return Response.json({ enabled: configured && db !== null });
}

/**
 * Start a subscription. Double opt-in: this stores a pending row and emails a
 * confirmation link; nothing is ever sent to an address that has not clicked it.
 */
export async function POST(request: Request) {
  const configured = await alertsConfigured();
  if (!configured) {
    return Response.json(
      { error: "Email alerts are not configured on this deployment." },
      { status: 503 },
    );
  }

  const db = await getSubscriptionDb();
  if (!db) {
    return Response.json({ error: "Alert storage is unavailable." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const payload = (body ?? {}) as { email?: unknown; filters?: unknown };
  const email = normalizeEmail(payload.email);
  if (!email) {
    return Response.json({ error: "That email address does not look valid." }, { status: 400 });
  }

  const filters = sanitizeFilters(payload.filters);
  const token = createToken();

  try {
    await upsertPending(db, { id: crypto.randomUUID(), email, filters, token });
  } catch (error) {
    console.error("[alerts] could not store subscription:", error);
    return Response.json(
      { error: "Could not save the subscription. Please try again." },
      { status: 500 },
    );
  }

  const origin = new URL(request.url).origin;
  const message = renderConfirmEmail({ origin, token });
  const sent = await sendEmail({ to: email, ...message });

  if (!sent) {
    return Response.json(
      { error: "Could not send the confirmation email. Please try again shortly." },
      { status: 502 },
    );
  }

  // Identical response whether or not the address was already known, so this
  // endpoint cannot be used to test which addresses are subscribed.
  return Response.json({ ok: true, message: "Check your inbox to confirm your alerts." });
}
