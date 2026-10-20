# Tango and G2X research

GovCheck supports deliberate, bounded, read-only Tango lookups from **Sources & sync**.
It does not ingest Tango payloads into searchable opportunity, award, entity, document,
source-record, scoring, or AI tables. Existing government-source precedence is unchanged.

## Data and access (verified 2026-10-20)

The canonical [OpenAPI schema](https://tango.dev/api/schema/) was version 5.11.0,
build 5.11.0-1 dated October 19, 2026. Supported lists and validated filter names:

| Category | Endpoint | Example scope |
| --- | --- | --- |
| Agency forecasts | `/api/forecasts/` | `agency=DOT`, `naics_code=541512` |
| Vehicles | `/api/vehicles/` | `search=SEWP`, `agency=GSA` |
| IDVs | `/api/idvs/` | `piid`, `uei`, `naics` |
| Subawards | `/api/subawards/` | `prime_uei`, `sub_uei`, `award_key` |
| Companies | `/api/entities/` | `uei`, `name`, `naics` |
| Awards | `/api/contracts/` | `piid`, `uei`, `awarding_agency` |
| Opportunities | `/api/opportunities/` | `agency`, `naics`, `solicitation_number` |
| G2X news | `/api/news/` | `search`, `vertical`, `tag` |
| G2X events | `/api/events/` | `search`, `organizer`, `start_date_after` |

The [G2X integration changelog](https://docs.makegov.com/changelog/#420-2026-04-30)
explicitly requires the **G2X User** account group for news and events. A valid Tango
API key alone does not prove that entitlement. Ask MakeGov to link/authorize the G2X
account if these endpoints return 403; do not retry repeatedly or scrape G2X.

The schema also documents `/api/company/rag/`, but does not specify a company selector.
GovCheck deliberately does not guess parameters for that endpoint. G2X entity expansion
fields and eBuy access are separate future extensions requiring confirmed permissions.

[Plans and data access](https://docs.makegov.com/getting-started/pricing/) describe raw
federal data as available on Free, including forecasts, vehicles, IDVs, contracts,
subawards, entities and SAM opportunities. Computed enrichments have paid-plan gates;
the UI displays provider `meta`/upgrade hints. eBuy requires paid-plan arrangement and
contract linking. G2X membership is a separate entitlement, not an assumed Free benefit.

Free is documented at **100 requests/day, 25/minute**, resetting at midnight UTC.
Current public plan documentation does not specify a monthly Free allowance. The default
1,000-request monthly local safeguard is conservative application policy, **not a verified
provider allowance**. Check the account profile and lower `TANGO_MONTHLY_REQUEST_LIMIT`
if needed. External tools' monthly usage cannot be inferred from the local journal.

## Setup

1. Copy `.env.example` to `.env` if needed. Keep `.env` Git-ignored.
2. Add `TANGO_API_KEY` locally; never put it in chat, frontend code, test fixtures, or Git.
3. Set `TANGO_ENABLED=true` for deliberate manual lookup. Restart the server.
4. Keep `TANGO_AUTO_SYNC=false`. This release refuses scheduled dispatch even if it is
   accidentally set true. Due-source diagnostics report `tango_research` as disabled.
5. For all hosted app/CLI/Actions processes using one account, use the **same PostgreSQL
   DATABASE_URL**. Embedded PGlite is for single-process local development, not shared quota.

Additional server variables and defaults:

| Variable | Default |
| --- | --- |
| `TANGO_BASE_URL` | `https://tango.dev` (trusted HTTPS origin only) |
| `TANGO_DAILY_REQUEST_LIMIT` | 100 |
| `TANGO_INTERNAL_DAILY_CAP` | 80 |
| `TANGO_PROVIDER_RESERVE` | 20 minimum |
| `TANGO_MANUAL_RESERVE` | 10 minimum |
| `TANGO_TEST_MAX_REQUESTS` | 5 maximum over the ledger's lifetime |
| `TANGO_MONTHLY_REQUEST_LIMIT` | 1000 local safeguard; verify account profile |

Render: apply the migration using the normal release process, set `TANGO_API_KEY` in the
server environment, then explicitly enable manual research. No production credentials
are changed by this feature. The blueprint disables automatic deployment; for an existing
service, independently verify its dashboard Auto-Deploy setting before merging a release
that must not deploy. A blueprint edit alone is not proof the existing service is paused.

GitHub Actions: scheduled Tango remains explicitly disabled and the key is not passed
to the existing scheduled workflow. Only after scheduling is authorized, add repository
secret `TANGO_API_KEY`, use the same database, and implement the reviewed transient or
authorized-persistence consumer before lifting the hard scheduling guard.

## Budget and failure behavior

An account-wide PostgreSQL row is locked inside a transaction before every attempt.
It counts successful and failed dispatches, enforces 80 total/70 background daily requests,
protects 20 provider requests and 10 internal manual requests, and tracks monthly attempts.
All keys/processes share the `tango` ledger because provider quotas are account-wide.

Dispatches are spaced by at least 3 seconds across processes (at most 20/minute).
Connection tests additionally require a one-minute cooldown and a lifetime five-test cap.
Development smoke requests use that same capped category. Do not reset its counters
to work around the development allowance.

Provider daily headers can only reduce the local remaining estimate. Provider remaining
is decremented at reservation, and reset durations are interpreted as seconds, not epoch
timestamps. Missing headers leave the balance unknown; local usage is never labeled as
the actual provider balance. External tools can consume requests between observations,
so a stale header cannot guarantee account-wide availability. Stop other tools during tests.

429 stops execution without retry; retry/reset headers establish a shared cooldown.
Daily exhaustion blocks through the reported daily reset. A 401 blocks subsequent calls
until the key is corrected and the user explicitly clears the authentication block. A 403
stops the current lookup with an entitlement explanation. All failures count conservatively.

Only endpoint, category, timestamps, HTTP outcome and remaining quota are journaled.
Credentials, query filters, provider error bodies and content are not logged. There are no
automatic retries, refresh-on-page-load calls, or scheduled Tango calls.

## Query workflow and matching

Preview is local and free. It shows endpoint, filters, maximum pages, records and request
cost. At least one agency/NAICS/company/identifier/capability scope is required; pages are
capped at 3 and page size at 25. Execution must submit the exact preview fingerprint.
Every page reserves its own request. Pagination cannot change the approved filters,
origin or endpoint, and redirects are refused. Responses are limited to 2 MB per page.

Results live only in component state; they are cleared when the panel is closed/unmounted
or the user presses Clear. No React Query cache, browser storage or database holds payloads.
Exact notice/PIID identifiers associate existing opportunities; solicitation matching also
requires an exact department match. Exact UEI associates known vendors. Missing agency
information, ambiguous names and similar descriptions never trigger a merge. Unmatched
records are leads requiring review, not automatically proven coverage gaps or official awards.

The separate research-note model supports source links, categories, related opportunities
or companies, confidence, observation date, verification, notes and review state. Only
independently authored Manual/OrangeSlices notes are accepted. No provider payload field
exists. OrangeSlices links are saved without scraping article text. The UI supports note
creation and review; API clients can also supply company IDs and update verification.

## Licensing boundary and next steps

[MakeGov terms](https://tango.makegov.com/terms/) prohibit building searchable datasets
from content without authorization. Obtain written permission covering persistent raw
storage, extracted identifiers/derived fields, indexing, retention, internal access and any
redistribution. Confirm G2X third-party rights separately. A feature flag or paid plan by
itself does not establish those rights. There is deliberately no flag to enable persistence.

After authorization, extend the separated client/preview/budget/matching services with an
explicit storage sink. Recommend evaluating one weekly agency/NAICS forecast lookup first,
and one targeted vehicle/subaward lookup for active capture work. Measure incremental
value versus the existing GSA/DHS/SAM/USAspending connectors before setting a cadence.
No automated schedule is enabled in this release.

## Validation

`npm run check` runs lint, typechecking, mocked tests and build without Tango requests.
The Tango test suite covers quotas, concurrent reservations, resets, headers, HTTP/network
failures, authentication, pagination, query bounds, identifier matching, RLS and persistence
restrictions. CI also exercises independent PostgreSQL pools against a disposable database.

No-cost CLI preview/status:

```sh
npx tsx src/server/cli.ts tango --resource forecasts --filter agency --value DOT
npx tsx src/server/cli.ts tango status
```

Explicitly authorized smoke verification (one request, counted against lifetime test cap):

```sh
npx tsx src/server/cli.ts tango --resource forecasts --filter agency --value DOT --live-smoke --acknowledge-request-cost=true
npx tsx src/server/cli.ts tango --resource news --filter search --value technology --live-smoke --acknowledge-request-cost=true
```

Wait at least one minute between development tests. CLI live-smoke output contains only
endpoint, request/record counts, validation outcome and quota metadata; no response bodies.
