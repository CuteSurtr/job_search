import { isValidToken } from "@/lib/jobs/alerts.mjs";
import { confirmByToken, getSubscriptionDb } from "@/lib/jobs/subscriptions.mjs";

export const dynamic = "force-dynamic";

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — NurseLaunch</title></head>
<body style="margin:0;background:#f7f6f1;font-family:system-ui,-apple-system,Arial,sans-serif;color:#142b2c">
<div style="max-width:520px;margin:12vh auto;padding:32px;background:#fff;border:1px solid #dfe4df;border-radius:16px">
<h1 style="font-size:22px;margin:0 0 10px">${title}</h1>
<p style="color:#5f6f6c;font-size:14px;line-height:1.6;margin:0 0 20px">${body}</p>
<a href="/" style="color:#0d6b67;font-weight:700;text-decoration:none">Back to NurseLaunch</a>
</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

/** Completes double opt-in. Reached from the emailed link, so it renders HTML. */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!isValidToken(token)) {
    return page("Link not valid", "That confirmation link is malformed. Try subscribing again.", 400);
  }

  const db = await getSubscriptionDb();
  if (!db) {
    return page("Temporarily unavailable", "Alert storage is unavailable right now. Please try the link again shortly.", 503);
  }

  try {
    const confirmed = await confirmByToken(db, token);
    if (!confirmed) {
      // Either already confirmed, unsubscribed, or a stale token — all the same
      // to the visitor, and none of them worth distinguishing publicly.
      return page("Nothing to confirm", "This link has already been used or is no longer valid.", 410);
    }
  } catch (error) {
    console.error("[alerts] confirm failed:", error);
    return page("Something went wrong", "We could not confirm your subscription. Please try again shortly.", 500);
  }

  return page("Alerts confirmed", "You will get an email when new roles match your search. You can unsubscribe from any digest.");
}
