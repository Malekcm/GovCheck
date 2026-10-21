# Tango integration validation — October 20, 2026

**Release gate: do not merge until G2X access is enabled and verified.**
The implementation and local verification are complete, but the configured account's G2X
news request returned HTTP 403. Main has not been changed and no production deployment
or production credential update was performed.

## Implemented

- `src/server/connectors/tango.ts`: OpenAPI-verified filters for nine resource lists,
  request previews, bounded retrieval, safe pagination, no redirects/retries, transient results.
- `src/server/pipeline/tangoBudget.ts`: shared PostgreSQL reservations, provider reconciliation,
  daily/monthly safeguards, protected reserves, burst/cooldown rules and safe request journals.
- `src/server/pipeline/researchMatching.ts`: read-only exact-identifier associations;
  solicitation association additionally requires matching departments. No inferred merges.
- `src/server/routes/tango.ts`, `app.ts`: authenticated status, preview, execute, test and
  independent research-note endpoints. No API requests when opening ordinary pages.
- `src/client/components/TangoResearch.tsx`, `pages/Sources.tsx`: configuration, quotas,
  deliberate preview/execute, transient result rendering, OrangeSlices links and user notes.
- `migrations/005_tango_research.sql`: quota/journal/user-note tables with RLS enabled;
  no provider-content table or persistence flag.
- `config.ts`, `cli.ts`, `pipeline/scheduler.ts`: server-only secrets, safe defaults,
  no-cost CLI preview/status, capped development smoke checks and disabled due-source entry.
- `.env.example`, `render.yaml`, `.github/workflows/scheduled-sync.yml`: deployment
  configuration with scheduling disabled. Render blueprint automatic deployment disabled;
  an existing service's actual dashboard setting still requires verification before merge.
- `tests/tango.test.ts`, `tests/hosting.test.ts`, source coverage and setup documentation.

## Exact live usage

| Request | Endpoint and scope | Result | Reported daily remaining |
| --- | --- | --- | --- |
| 1 | `/api/forecasts/?agency=DOT&limit=5` | HTTP 200; five records; CLI authentication/schema check | 99 |
| 2 | `/api/news/?search=technology&limit=5` | HTTP 403; stopped, no retry | 98 |
| 3 | `/api/forecasts/?agency=DOT&limit=5` | HTTP 200; browser → API → provider → result rendering validated | 97 |

**Total: 3 authenticated procurement API requests, 97 reported daily requests remaining.**
The local budget records all three attempts (two development tests and one deliberate UI
research request). An earlier second-test command was rejected locally by the cooldown;
it made zero provider calls. No live events/vehicle/subaward request was attempted after
the G2X denial. Those paths use mocked validation only.

Public documentation and the unauthenticated OpenAPI schema were retrieved separately;
they did not use the configured API key. No complete provider responses were retained in
logs, fixtures, database records, screenshots or deliverables. Browser results were cleared.

## Checks

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test`: 131 passed, zero skipped with disposable PostgreSQL 16 in Docker.
- `npm run build`: client and server passed.
- Independent PostgreSQL pools respected the final available internal budget slot.
- Browser: configuration/quota page, zero-cost preview, one-page cap, five transient
  forecast results, updated quota balance and clearing results verified.
- Build secret scan: no configured Tango key in any generated build file; `.env` is ignored
  and untracked. The key was never printed.

## Access, licensing and configuration

Free-plan raw federal data includes forecasts, vehicles, IDVs, awards, subawards,
entities and SAM opportunities. Paid tiers unlock computed enrichments and higher
quotas; G2X User membership and arranged eBuy access are separate restrictions.
The public pricing documentation does not establish a monthly Free allowance; 1,000/month
is a conservative local safeguard that must be checked against the actual account profile.

Persistent Tango/G2X ingestion remains blocked by licensing. Obtain MakeGov's written
authorization covering storage, indexing, derived data, retention and internal use, plus
any G2X third-party rights. The current manual, transient lookup mode requires no ingestion
rewrite when a separately authorized storage sink is added later.

The local `.env` has the user's key and `TANGO_ENABLED=true`; `TANGO_AUTO_SYNC=false`.
For a later production release, use the normal migration process, put the key into Render's
server environment, explicitly enable manual research and keep auto-sync disabled.
Use one shared PostgreSQL database across all account consumers. Do not add the Tango
secret to scheduled Actions until scheduled use is authorized.

## Required next action

Ask MakeGov to confirm/enable the account's **G2X User** entitlement for `/api/news/`
and `/api/events/`. After access is confirmed, perform one bounded G2X recheck, staying
within the five-total-request development limit, verify CI on the final PR head, confirm
that merging cannot trigger an unapproved production deployment, and merge to main.
The user has already authorized the merge once these conditions pass; no repeat merge
permission request is needed.

Recommend assessing one weekly, agency/NAICS-scoped forecast lookup and capture-specific
vehicle/subaward research after rights are established. Measure actual overlap and value
against current government connectors before enabling any automated cadence.

Sources: [OpenAPI](https://tango.dev/api/schema/),
[G2X changelog](https://docs.makegov.com/changelog/),
[plan access](https://docs.makegov.com/getting-started/pricing/),
[rate limits](https://docs.makegov.com/guides/patterns/rate-limits/),
[terms](https://tango.makegov.com/terms/).
