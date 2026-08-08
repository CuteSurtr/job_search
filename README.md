# NurseLaunch

A new-graduate nursing job tracker. It polls the public career-site feeds of 38
hospital systems across two applicant tracking systems, keeps only postings that
name a genuine new-grad pathway, and links each one back to the employer's own
application. Built on [vinext](https://github.com/cloudflare/vinext) and
deployed as a Cloudflare Worker.

## Geographic coverage

The state filter lists all 50 states plus DC, always. What that does and does
not mean:

- Polled employers now operate in **all 51**. `tests/ats.test.mjs` asserts this
  directly, so losing a state is a build failure rather than a silent gap.
- The last five — **AK, AL, HI, WV, DC** — were closed two different ways, and
  the split is worth knowing before adding more. Three were ordinary Workday
  tenants nobody had found: WVU Medicine (WV), Children's National (DC) and
  Southeast Health (AL). WVU is the instructive one — it answers its *own*
  careers-page search API with HTTP 500, which is what the earlier attempt hit,
  while the CXS endpoint underneath is healthy. A 500 from a career site is not
  evidence the tenant is unreachable.
- The remaining two genuinely needed the second adapter. **Providence** (AK) and
  **Adventist Health** (HI) run Oracle Cloud Recruiting, not Workday.
- A covered state with nothing showing gets the employers we poll there by
  name, because residency intakes are seasonal — a state can be empty one month
  and hiring the next. That is different from not being covered, and the UI
  distinguishes the two.
- Coverage is not the same as placement. WVU Medicine posts real new-grad roles
  today, but reports a facility name where a city should be *and* operates in
  four states, so those roles land under "Multi-state" rather than under the WV
  filter — see the `resolveState` rule below. Oracle sources do not have this
  problem.
- **Live postings never span all 50 states at once**, and no amount of employer
  coverage changes that. Cohorts cluster by season and region.

Placing a posting on the map is harder than it looks: several tenants report a
facility name where a city should be ("Mercy Hospital South"), and Workday
exposes no city or state field to fall back on. `resolveState` in the feed route
tries the location, then a full state name in the title, then the employer's
declared footprint — but only when that employer operates in exactly one state,
where it is exact rather than a guess. Multi-state employers stay unresolved,
because a wrong state is worse for a job hunter than an honest "varies".

Two-letter codes are never inferred from a title. Nursing titles are dense with
abbreviations that collide with state codes — "OR" is the operating room, and
reading it as Oregon filed Ohio residencies under an Oregon filter.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This project does not use `wrangler.jsonc`.

## How the feed works

Employers sit on one of two applicant tracking systems, both of which expose a
public JSON search endpoint. `lib/jobs/ats.mjs` is the only place that knows
which is which — it resolves four things by the `ats` discriminant on each
registry entry (search, detail, path validation, apply URL) and every caller
goes through it. Adding a third ATS means four new branches and nothing else.

- **Workday** (`lib/jobs/workday.mjs`, 36 employers) rejects `limit > 20` with
  an opaque HTTP 400. Breadth comes from paging (`offset`), never from a larger
  page. Raising the page size silently empties the entire site, so
  `WORKDAY_PAGE_SIZE` is not a tuning knob.
- **Oracle Cloud Recruiting** (`lib/jobs/oracle.mjs`, 2 employers) accepts far
  larger pages — 100 was served without complaint — so `ORACLE_PAGE_SIZE` of 50
  is our ceiling, not the API's. Its `finder` argument is one semicolon-and-comma
  delimited string rather than ordinary query parameters, so the keyword is
  URL-encoded before it goes in: an unescaped `;` or `,` in a search term would
  terminate the argument early and change the query.
- **A Worker request has a finite subrequest allowance.** Every upstream call is
  drawn from an explicit budget, and the feed degrades to un-enriched listings
  rather than failing when the budget runs out. Both clients honour the same
  budget contract.

Two normalisations happen at the Oracle boundary so nothing downstream needs a
second code path:

- **Posting age.** Oracle reports an exact ISO date; Workday reports prose
  ("Posted 30+ Days Ago"). The date is converted *down* to Workday's vocabulary
  rather than threaded through as a richer type. `postedMinutes` is a tested
  pure function every consumer already relies on, and `job_sightings` is what
  makes ages real anyway — so the lossy direction is the safe one.
- **Path validation is per-ATS and must stay that way.** Workday paths are
  free-form text; Oracle requisition ids are numeric. Applying Workday's looser
  rule to an Oracle source would let arbitrary text reach the `finder` argument
  in the detail URL. `isValidPathFor` picks the right rule; neither validator
  should be called directly.

Routes:

| Route | Purpose |
| --- | --- |
| `GET /api/jobs` | The assembled feed. Cached for an hour. `?refresh=1` re-scans, but no more often than once every five minutes. |
| `GET /api/jobs/detail?source=&path=` | Full posting body for one role, fetched only when a visitor opens it. `source` must be a known registry key and `path` a `/job/...` Workday path. |
| `GET/POST /api/alerts` | Whether email alerts are available, and subscribing to them. See below. |
| `GET /api/alerts/confirm?token=` | Completes double opt-in from the emailed link. |
| `GET /api/alerts/unsubscribe?token=` | One-click unsubscribe from any digest. |

Caching is two-layer (`lib/jobs/cache.mjs`): a module-scoped map that survives
between requests in one isolate, plus the Workers Cache API where it exists. A
feed that found nothing is never cached, so an upstream outage cannot strand the
site on an empty list.

## Sighting history (optional D1)

Workday reports posting age only as vague prose ("Posted 30+ Days Ago") and says
nothing at all once a listing disappears. `job_sightings` records what each scan
saw and when, which turns both into real data: a truthful posting age, a "new
since your last visit" badge, and a closed flag instead of a role silently
vanishing.

`bindings.json` declares `"d1": "DB"`, and `npm run db:generate` has already
produced `drizzle/0000_glorious_bug.sql`. The build copies `drizzle/` to
`dist/migrations/` so a deploy can apply it against a fresh database.

**This is an enhancement, never a dependency.** `lib/jobs/history.mjs` catches
everything and returns null, so a missing binding, an unmigrated table, or a
failed write all degrade to employer-reported ages with the feed intact. The
`meta.historyTracked` flag in `/api/jobs` tells you which mode a response came
from. Failures are logged rather than swallowed — a dead feature that looks
exactly like "D1 was never bound" is the failure mode worth avoiding.

Two constraints are load-bearing and covered by tests:

- **D1 rejects statements binding more than 100 variables.** Batch sizes are
  derived from the column count for that reason. Local SQLite allows ~32k, so an
  oversized batch passes every test and fails only in production — which is
  exactly what happened at 60 rows (600 variables). `tests/history.test.mjs`
  asserts the ceiling directly.
- **Closing is scoped to sources that answered.** Otherwise one employer being
  briefly unreachable would mass-close every role they list.

To apply the migration to the local dev database:

```bash
node -e "const{DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const f=fs.readdirSync('.wrangler/state/v3/d1/miniflare-D1DatabaseObject').find(n=>n.endsWith('.sqlite')&&n!=='metadata.sqlite');const db=new DatabaseSync('.wrangler/state/v3/d1/miniflare-D1DatabaseObject/'+f);for(const s of fs.readFileSync('drizzle/0000_glorious_bug.sql','utf8').split('--> statement-breakpoint'))if(s.trim())db.exec(s.trim());console.log('applied')"
```

## Email alerts (needs configuration)

Subscribers get a daily digest of newly-seen roles matching the filters they had
set when they subscribed. **The feature is off until you configure a provider**,
and it says so rather than pretending:

- `GET /api/alerts` reports `{ enabled: false }`, and the UI hides the subscribe
  CTA entirely.
- `POST /api/alerts` returns 503 rather than accepting an address it could never
  mail. Storing addresses you cannot deliver to is the failure worth avoiding.

To turn it on, set two Worker secrets:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put ALERTS_FROM_EMAIL
```

`ALERTS_FROM_EMAIL` must be a sender verified with your provider, e.g.
`NurseLaunch <alerts@yourdomain.com>`. For local development put both in a
`.dev.vars` file (gitignored).

Swapping providers means rewriting one `fetch` in `lib/jobs/email.mjs`.

Design notes:

- **Double opt-in.** A subscription is stored `pending` and only ever receives a
  digest after the emailed link is clicked. Confirm and unsubscribe are
  capability URLs carrying a random 24-byte token, never anything derived from
  the address.
- **No enumeration.** Subscribing an existing address, and unsubscribing an
  unknown token, both return exactly what a first-time request returns.
- **No cron, so digests ride on traffic.** There are no Cron Triggers on this
  platform, so a digest run piggybacks on the background feed rebuild. Each
  subscriber is paced by their own `lastSentAt` watermark rather than a clock —
  so a site with daily visitors sends daily digests, and a site nobody visits
  sends none. That is a real limitation, not a detail.
- **The watermark only advances after a confirmed send**, so a provider outage
  delays a digest instead of silently dropping those roles from it.
- Unsubscribe is a `GET` on purpose: it has to work from an email client with no
  JavaScript.

## Hiring statistics

`lib/content/statistics.mjs` holds the figures shown under "What the hiring
data says". These are the only numbers on the site that are **not** derived from
the feed — they are transcribed from named reports (BLS, AACN, NSI,
Vizient/AACN), which makes them the one thing here that can go stale while still
looking authoritative.

Every entry therefore carries its publisher, the period the figure describes,
and a link to the source, and `tests/statistics.test.mjs` fails the build if any
of the three is missing or if a card cites an aggregator instead of the
publisher. When updating a figure, change its `period` and the module's
`STATISTICS_RETRIEVED` date in the same edit.

## Layout

- `app/` — the site: `jobs-client.tsx` is the whole UI, `api/` holds the routes
- `lib/jobs/` — sources registry, the `ats` dispatcher over the Workday and
  Oracle clients, cache, refresh policy, sighting history, and the pure text
  parsers that decide what counts as a new-grad role
- `db/schema.ts` + `drizzle/` — the `job_sightings` and `alert_subscriptions`
  tables and their migrations
- `tests/` — `job-matching` covers the parsers, `ats` the two-ATS registry and
  the Oracle adapter's normalisation, `feed-policy` the cache decisions,
  `history` the D1 semantics against real SQLite, `alerts` the subscription and
  digest rules, `api-routes`/`alert-routes` request validation, `rendered-html`
  the server-rendered shell. All offline.
- `bindings.json` declares the optional D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development, and
  `build/package-migrations.ts` copies `drizzle/` into the build output
- `examples/d1/` is the starter's original opt-in D1 example, kept for reference

## Editing the matchers

`lib/jobs/matching.mjs` carries the product risk: a posting is shown because a
regex said it looks like a new-grad role, and the wage on the card is scraped
out of free-text HTML. Two rules there are load-bearing and covered by tests:

- Med-surg is classified before perioperative, or "Medical Surgical" gets read
  as an operating-room role.
- A dollar range only counts as a wage if a pay label precedes it or a unit
  follows it, and never when bonus/tuition wording is nearby — otherwise a
  "$7,500 sign-on bonus" is shown as an hourly rate.

Run `npm test` after any change to these.

## Useful Commands

- `npm run dev`: start local development
- `npm run build`: verify the vinext build output
- `npm test`: build, then run every suite in `tests/` (no network required)
- `npm run lint`: ESLint over the project
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
