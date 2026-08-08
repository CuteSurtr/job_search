import { isValidToken } from "@/lib/jobs/alerts.mjs";
import { getSubscriptionDb, unsubscribeByToken } from "@/lib/jobs/subscriptions.mjs";

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

/**
 * One-click unsubscribe from any digest. Kept to a GET on purpose: it has to
 * work from an email client with no JavaScript, and an unsubscribe that is hard
 * to reach is how a sender ends up marked as spam.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!isValidToken(token)) {
    return page("Link not valid", "That unsubscribe link is malformed.", 400);
  }

  const db = await getSubscriptionDb();
  if (!db) {
    return page("Temporarily unavailable", "Please try this link again shortly.", 503);
  }

  try {
    await unsubscribeByToken(db, token);
  } catch (error) {
    console.error("[alerts] unsubscribe failed:", error);
    return page("Something went wrong", "We could not process that just now. Please try again shortly.", 500);
  }

  // Reports success even for an unknown token: someone clicking unsubscribe
  // should never be told "you were not subscribed anyway".
  return page("Unsubscribed", "You will not receive any more NurseLaunch alerts.");
}
