# GovCheck — Government Opportunity Intelligence Engine

GovCheck continuously discovers, consolidates, enriches, scores and tracks potential government work across the **entire procurement lifecycle** — forecasts, sources sought/RFIs, presolicitations, solicitations, amendments, awards, contract performance, expiration and possible recompetes — plus subcontracting and (optionally) grant opportunities.

Every record from every source is kept verbatim. Records about the same procurement are consolidated into one **Opportunity Profile** whose every value carries provenance — **OFFICIAL**, **DERIVED**, **ESTIMATED**, **AI EXTRACTED**, **USER ENTERED** or **UNKNOWN** — so inferred information never looks official. Refreshes never delete history or touch your decisions, notes, tags or manual links. The system builds a proprietary, growing dataset of agencies, offices, contracts, vendors, incumbents, pricing and your own pursuit decisions.

**Hosting for a team:** GovCheck runs on **Supabase** (shared database) + **Render Free** (web app) + **GitHub Actions** (scheduled source checks). Your existing local data can be promoted with one command. Step-by-step: **[docs/DEPLOY_SUPABASE_RENDER.md](docs/DEPLOY_SUPABASE_RENDER.md)**.

---

## Contents
1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [Environment variables](#environment-variables)
4. [Database & migrations (Supabase)](#database--migrations)
5. [SAM.gov API key setup](#samgov-api-key-setup)
6. [Data sources](#data-sources)
7. [Sync process](#sync-process)
8. [Scheduled jobs](#scheduled-jobs)
9. [How matching works](#how-matching-works)
10. [How preference learning works](#how-preference-learning-works)
11. [AI configuration](#ai-configuration)
12. [Data durability guarantees](#data-durability-guarantees)
13. [Deployment](#deployment)
14. [Testing & quality checks](#testing--quality-checks)
15. [Troubleshooting](#troubleshooting)
16. [Known limitations](#known-limitations)

---

## Quick start

Requirements: **Node.js 20.10+** (22 LTS recommended). No database server needed for local use.

```bash
git clone https://github.com/Malekcm/GovCheck.git
cd GovCheck
npm install
cp .env.example .env        # optional: add SAM_API_KEY / ANTHROPIC_API_KEY
npm run dev                 # API on :8787, UI on http://localhost:5173
```

Then open http://localhost:5173 and follow the **Setup guide**:

1. Company information → 2. Capabilities → 3. NAICS/PSC → 4. Certifications → 5. Preferred work → 6. Contract size → 7. Locations → 8. Past performance → 9. Sources/API keys → 10. **Initial data sync**.

Every step can be skipped and revisited from **Company profile**.

Without any keys you still get live data from **GSA forecasts, DHS APFS forecasts, SBA SUBNet, Grants.gov, USAspending** and the **SAM.gov bulk extract**. Adding `SAM_API_KEY` enables the live SAM Opportunities and Contract Awards APIs.

Production-style local run:

```bash
npm run build
npm start                   # serves API + built UI on http://localhost:8787
```

---

## Architecture

```
┌──────────────── Browser (React + Vite SPA) ────────────────┐
│ Dashboard · Work queues · Dossier · Company profile ·      │
│ Coverage · Changes · Merge review · Agencies · Vendors ·   │
│ Learning · Sources & sync         (no secrets, ever)       │
└───────────────────────────┬─────────────────────────────────┘
                            │ /api (JSON, optional password cookie)
┌───────────────────────────┴─────────────────────────────────┐
│ Node server (Hono)                                          │
│  routes/        REST API, CSV export, cron endpoint         │
│  connectors/    Source adapters (registry + custom feeds)   │
│  pipeline/      store → normalize → resolve → link → apply  │
│                 → change detection → enrich → recompete →   │
│                 documents → AI → score → coverage           │
│  scoring/       explainable fit · eligibility rules ·       │
│                 TF-IDF similarity · preference learning     │
│  ai/            provider abstraction (Claude), rule-based   │
│                 extraction, content-hash cache              │
│  scheduler      in-process (or external via /api/cron/sync) │
└───────────────────────────┬─────────────────────────────────┘
                            │ SQL (same migrations both ways)
        Supabase / PostgreSQL (DATABASE_URL)  ─or─  embedded PGlite (local file)
```

- **Frontend**: React 19, React Router, TanStack Query, hand-built design system (`src/client/styles.css`) with a strict colour code for provenance. Light/dark follow the OS.
- **Backend**: TypeScript on Node with Hono. Long-running syncs need a persistent process, so the server is designed for a Node host (Docker/Render/Fly/VM) rather than short-lived serverless functions.
- **Database**: PostgreSQL. `DATABASE_URL` → Supabase/any Postgres via `pg`; otherwise an embedded **PGlite** (Postgres compiled to WASM) database in `./data/pglite`. Both run the identical SQL migrations, including full-text search (`tsvector` + GIN).
- **Shared domain** (`src/shared/domain.ts`): lifecycle stages, provenance labels, decisions, eligibility states, glossary — used by server and UI.

### Key tables

| Area | Tables |
|---|---|
| Company | `company_profiles`, `capabilities`, `company_capabilities`, `company_naics`, `company_psc`, `company_certifications`, `company_contract_vehicles`, `company_past_performance` |
| Sources | `source_connectors` (registry), `sync_runs`, `sync_errors`, `api_usage` (daily budgets), `source_records` (raw, verbatim), `source_record_versions` (every version, forever) |
| Profiles | `opportunities` (canonical), `opportunity_identifiers`, `opportunity_sources`, `opportunity_field_values` (field-level provenance, conflicts kept), `opportunity_snapshots`, `opportunity_events`, `opportunity_relationships`, `opportunity_contacts`, `opportunity_locations`, `opportunity_dates`, `opportunity_financials`, `opportunity_documents`, `opportunity_requirements` |
| Awards & entities | `awards`, `opportunity_awards`, `opportunity_vendors`, `vendors`, `agencies`, `agency_offices`, `contacts` |
| Scoring & learning | `match_scores`, `match_score_components`, `match_explanations`, `score_history`, `preference_models`, `preference_weights` |
| User data | `user_opportunity_decisions` (full history), `user_feedback_reasons`, `user_notes`, `user_tags`, `user_field_overrides`, `watchlists` (saved views), `merge_decisions` (journaled, undoable), `opportunity_capture` + `opportunity_capture_history` (capture pipeline, journaled) |
| Intelligence | `coverage_signals`, `ai_analyses` (cached by content hash), `app_state` |

---

## Environment variables

See [`.env.example`](.env.example) for the complete annotated list.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Hosted | Postgres/Supabase connection string (Supabase: Session pooler). Empty → embedded PGlite. |
| `DATABASE_SSL_CA_BASE64` / `DATABASE_SSL_CA_PEM` / `DATABASE_SSL_CA_FILE` | With Supabase | Supabase's CA certificate as a one-line base64 secret, as PEM text, or as a file path. TLS is always verified. |
| `DATABASE_SSL_ALLOW_UNVERIFIED` | — | Explicit, not-recommended opt-out of certificate verification. |
| `DATABASE_POOL_MAX` | — | Connections per process (default 8; Render blueprint uses 5, GitHub Actions 3). |
| `REQUIRE_DATABASE_URL` | Hosted | `true` refuses to start on the temporary embedded database. |
| `TARGET_DATABASE_URL` | Promotion only | Target of `npm run db:promote` (falls back to `DATABASE_URL`). |
| `SAM_API_KEY` | For SAM APIs | SAM.gov public API key (server-side only). |
| `SAM_DAILY_REQUEST_LIMIT` | — | Daily SAM request ceiling shared by every GovCheck process (default **10** = non-federal personal key). |
| `SAM_MANUAL_RESERVE_REQUESTS` | — | Requests scheduled work leaves for manual refreshes/targeted searches (default 20% of the limit). |
| `SAM_TARGETED_SEARCH_MAX_REQUESTS` | — | Request ceiling for one targeted search (default 3). |
| `SAM_TRACKED_REFRESH_HOURS`, `SAM_STALE_DAYS`, `SAM_PRIORITY_MIN_FIT` | — | SAM priority-check thresholds (24 h, 7 days, fit 60). |
| `SAM_DOWNLOAD_DOCUMENTS` | — | Download SAM attachments (uses the SAM budget). Default false. |
| `SAM_BULK_INGEST_MODE` | — | `focused` (default: relevant or already-tracked notices only) or `full`. |
| `SAM_BULK_FOCUS_NAICS_PREFIXES` | — | Extra NAICS prefixes always kept by focused bulk ingestion. |
| `DB_SIZE_WARN_MB`, `DB_SIZE_LIMIT_MB` | — | Storage warnings (default 400 / 500 MB = Supabase Free). |
| `ANTHROPIC_API_KEY` | Optional | Enables AI extraction/summaries. |
| `ANTHROPIC_MODEL` | — | Default `claude-opus-5-5`. |
| `CRON_SECRET` | For external cron | Bearer secret for `POST /api/cron/sync`. |
| `APP_PASSWORD` | Recommended when hosted | Single shared password; HttpOnly signed session cookie. |
| `SESSION_SECRET` | — | Cookie signing secret. |
| `SCHEDULER_ENABLED` | — | In-process scheduler (default on when `NODE_ENV=production`; `false` on Render when GitHub Actions schedules). |
| `PORT`, `APP_BASE_URL` | — | Server port / public URL. |

**SSRF protection:** custom feed URLs, document links and robots.txt lookups may only reach public hosts — every redirect hop is re-checked; loopback, private, link-local (cloud metadata) and reserved ranges are refused. **Exports** neutralize spreadsheet formulas (CSV/XLSX injection) and never truncate silently.

**Secrets never reach the browser.** The UI only receives booleans (“configured / not configured”). Logged messages are redacted (`api_key=`, bearer tokens, connection strings and the values of all secret env vars).

---

## Database & migrations

Migrations live in [`migrations/`](migrations) and run automatically at server start (forward-only, recorded in `schema_migrations`). To run them explicitly:

```bash
npm run migrate
```

### Using Supabase
Full walkthrough (including promoting an existing local database): **[docs/DEPLOY_SUPABASE_RENDER.md](docs/DEPLOY_SUPABASE_RENDER.md)**. In short:
1. Create a Supabase project.
2. **Connect → Session pooler**: copy the URI into `DATABASE_URL` (IPv4; works from Render and GitHub Actions).
3. Download the CA certificate (*Settings → Database → SSL configuration*) and supply it as `DATABASE_SSL_CA_FILE` (local), or base64-encoded on one line as `DATABASE_SSL_CA_BASE64` (Render / GitHub secrets).
4. Start the server — migrations create the schema. Migrations take a database advisory lock, so several processes can start at once safely.

### Promoting an existing local (PGlite) database
```bash
npm run db:promote -- --dry-run   # what would be copied; writes nothing
npm run db:promote                # copy into TARGET_DATABASE_URL (or DATABASE_URL)
```
The local `./data/pglite` is never modified (a temporary snapshot copy is read). All tables are copied with their UUIDs and relationships — raw records and every version, opportunities, events, snapshots, scores, decisions, notes, capture, cursors, sync history and API usage — in resumable, insert-only batches, then every row is verified by primary key and a report is printed and saved to `data/`. Re-running is safe and copies only what is missing. Conflicting data already in the target stops the promotion before anything is written.

**Row-level security**: migration `002` enables RLS on every table with *no* permissive policies. The browser never talks to Supabase directly; the server connects with the privileged role, so Supabase's auto-generated REST/GraphQL APIs expose nothing even if an anon key leaks.

**Backups / portability**: `GET /api/export/backup.json` (the **Export backup** button on the Company profile page) exports everything you created — profile, capabilities, decisions (with history), notes, tags, overrides, manual relationships, merges and preference-model history. Supabase's paid plans add database backups. With PGlite, copy the `data/pglite` directory while the server is stopped.

---

## SAM.gov API key setup

1. Sign in at [sam.gov](https://sam.gov) → your name → **Account Details**.
2. Under **Public API Key**, request/view your key.
3. Add `SAM_API_KEY=...` to `.env` (local) or your host's secret settings; restart.
4. **Rate limits**: non-federal personal keys without a role get **10 requests/day**; with a role or a system account, 1,000/day. Set `SAM_DAILY_REQUEST_LIMIT` accordingly. GovCheck counts every SAM request in the database (`api_usage`), reserves a couple for on-demand “Refresh this opportunity”, and **resumes** partially fetched windows the next day from a saved cursor.

Because SAM descriptions and attachments each cost a request, broad coverage comes from the free **SAM bulk extract** (no key, no limit) — the API adds freshness.

---

## Data sources

All sources implement one adapter interface (`src/server/connectors/types.ts`):
`meta`, `isConfigured()`, `testConnection()`, `fetchIncremental()`, `fetchReconcile()`, `fetchByIdentifier()`, `normalize()` (cursor returned per page). Adding a source = one adapter file + one line in the registry. A source failure is isolated: it is marked **Degraded/Error** with a logged reason and never stops other syncs.

| Source | Access | Key | What it provides | Notes |
|---|---|---|---|---|
| **SAM.gov Contract Opportunities API** | Official API | `SAM_API_KEY` | All notice types (sources sought, RFI, presolicitation, solicitation, combined synopsis, special notices, award notices), full agency hierarchy, NAICS, PSC, set-aside, place of performance, contacts, resource links, award data | Ingests *all* notices in the posted-date window (not keyword-filtered). 3-day overlap. Budgeted & resumable. Self-detects whether `offset` is a page index or a record offset. |
| **SAM.gov Data Services (bulk CSV)** | Official bulk file | — | Full daily extract (~220 MB) incl. full description text; archived fiscal-year files | Reconciliation only (daily by default). Streams, decodes Windows-1252, considers notices posted in `SAM_BULK_LOOKBACK_DAYS` or still open; in `focused` mode (default) stores only profile-relevant or already-tracked notices; unchanged rows skipped by hash. Archived FY import is profile-filtered. |
| **SAM.gov Contract Awards API** | Official API | `SAM_API_KEY` | PIID, modifications, IDV, solicitation ID, obligations, base+options, pricing type, competition, offers, business size, awardee UEI/CAGE | Incremental by last-modified date for your NAICS; targeted lookups by solicitation ID/PIID during opportunity refresh. Award families keyed by IDV+PIID. |
| **USAspending.gov** | Official API | — | Prime awards **and IDVs (IDIQ/GWAC/BPA/FSS)**, obligations, outlays, periods of performance, recipients, agencies, solicitation identifiers, subaward counts | Scheduled **recompete scan**: for each profile NAICS, binary-searches the End-Date-sorted contracts (and *Last Date to Order*-sorted IDVs) to the first one ending after today, then walks forward to the 18-month horizon. Also used for incumbent, pricing and agency analysis. Executive-compensation names are stripped (personal data). |
| **GSA Acquisition Gateway Forecasts** | Public JSON listing | — | Government-wide procurement forecasts: agency, sub-agency, NAICS, value band, award FY, acquisition strategy, award status (incl. recompete hints; *Exercise of Option* flagged as not a new competition) | Forecast **detail pages require a login.gov session and are not accessed**, so forecast contacts are not collected. Page-view counters are excluded from snapshots to avoid false “changes”. **The live listing repeats page 2 as page 1** — the connector measures unique vs. reported records and marks the source *degraded* with the coverage % rather than green. |
| **DHS Acquisition Planning Forecast System (APFS)** | Public JSON API | — | ~600 DHS forecasts (CBP, ICE, TSA, USCG, FEMA, CISA…): dollar range, vehicle, set-aside program, **estimated solicitation release**, anticipated award, estimated PoP, **requirements + small-business contacts**, and for follow-ons the **incumbent contractor + contract number** | One request per run (full list). Incumbent contract numbers link exactly to award history and recompete signals. *No Longer Required* → cancelled. Missing forecasts are marked not-seen, never deleted; a collapsed listing degrades the source instead. |
| **SBA SUBNet** | Permitted public pages | — | Subcontracting opportunities by large primes: prime, title, description, closing/start dates, place, NAICS, contact, attachments | No API/feed exists. Respects robots.txt, ≥2s between requests, detail page fetched only when the listing row changed. Class = **SUBCONTRACT**. SBA's robots.txt disallows `/sites/default/files/*`, so attachments are linked, **not downloaded**. |
| **Grants.gov** | Official API | — | Forecasted & posted grants: number, agency, dates, instruments, categories, eligibility, ceiling/floor/total funding, expected awards, ALN, contacts, attachments | Runs only if *Include grants* is on. Visually distinct from contracts. |
| **Custom public feeds** | RSS/Atom/JSON/CSV | — | Agency forecasts, OSDBU pages, state/county/municipal portals, transit authorities, universities | Add from *Sources & sync → Add public feed* with field mapping. robots.txt honoured. No authenticated/CAPTCHA portals. |

Derived **intelligence engines** (recompete, enrichment, documents, AI, scoring, coverage) are registered like sources so their runs, health and errors are visible.

---

## Sync process

```
fetch page ─▶ store raw snapshot (hash; new version kept if changed)
          ─▶ normalize (parser version recorded; re-normalized when parsers change)
          ─▶ resolve entity (strong identifiers only auto-link)
          ─▶ link source record to profile, apply field values with provenance
          ─▶ recompute canonical profile (precedence rules) ─▶ snapshot diff ─▶ events
          ─▶ suggest probabilistic relationships (never auto-merged)
after all sources: recompete engine ─▶ score ─▶ USAspending enrichment (incumbents,
          comparables, estimated value) ─▶ documents ─▶ AI (optional) ─▶ rescore ─▶ coverage
```

- **Incremental** syncs use per-source cursors (persisted after every page, so interrupted runs resume) with an overlap window. **Reconciliation** (bulk CSV, full forecast listing) runs separately.
- **Entity resolution**: exact matches on notice ID, solicitation number (agency-compatible only), PIID/award number, forecast ID, grant IDs, SUBNet IDs. Identifier normalization is conservative (only spaces/hyphens/periods/underscores stripped from contract-style IDs; placeholders like `TBD`/`N/A` and IDs < 5 characters never match). Probabilistic matches (title/description TF-IDF, office, NAICS, PSC, set-aside, dates, values, place) produce **suggested** relationships with confidence and evidence in **Merge Review**: *Merge, Keep separate, Link as related, Mark predecessor/successor, Undo merge*.
- **Canonical values**: provenance precedence (user > official > derived > AI > estimated), then lifecycle stage (a solicitation's deadline supersedes a sources-sought deadline), then source priority, then recency. Conflicting official values are all kept and flagged.
- **Change detection** emits events: NEW_OPPORTUNITY, NEW_SOURCE, STATUS/STAGE/DEADLINE/VALUE/CONTACT/FIELD changes, **SCOPE_CHANGED** (sentence-level description diff with the added text; whitespace/markup-only edits ignored), **DATES_CHANGED** (questions due, PoP start/end, expected solicitation), **SET_ASIDE_CHANGED**, **SOLICITATION_RELEASED**, **CANCELLED** (derived from the notice text — SAM has no structured flag), NEW_DOCUMENT, DOCUMENT_UPDATED, **QA_PUBLISHED**, AMENDMENT, AWARD_POSTED, FORECAST_LINKED, INCUMBENT_IDENTIFIED, RECOMPETE_SIGNAL, RELATIONSHIP_FOUND, REMOVED_FROM_SOURCE. New snapshot keys are only compared when both snapshots have them, so upgrades never produce a burst of false changes.
- **Coverage warnings**: a connector that cannot see everything the source says exists (duplicate pages, collapsed listings) reports a warning; the run becomes *partial_success*, the source *degraded*, and the warning is logged and shown on **Data quality**.
- Records that disappear from a full listing are marked **not seen** — never deleted.

**Normal operation is scheduled and incremental.** Signing in only shows what the database holds. Sources are checked when *they* are due; previously downloaded unchanged records are skipped by content hash and are never re-enriched, re-scored or re-analyzed.

Manual controls (Sources & sync): **Check due sources now** (runs only due sources), per-source **Sync/Reconcile/Test**, and under *Advanced* **Refresh all sources** and **Full reconciliation** (heavier; confirmation with a warning). **Refresh this opportunity** on the dossier re-fetches each contributing record by identifier, pulls SAM awards by solicitation ID, USAspending history, documents, re-scores — user data untouched. **Targeted search** searches GovCheck first and only contacts SAM.gov after an explicit confirmation that shows the request cost.

**What changed?** *Recent changes* has one-click views — since yesterday, new opportunities this week, amendments on watched/pursued opportunities — plus `scope=tracked` / `meaningful=true` / `since=<ISO time>` filters on `/api/changes`; each dossier's change history can be narrowed to "since our decision" (`/api/opportunities/:id/changes?since=decision`). Events added by schema 004: REOPENED, NOTICE_TYPE_CHANGED, AGENCY_CHANGED, AWARD_INFO_ADDED.

CLI equivalents:

```bash
npm run sync:due                 # NORMAL: only sources that are due (+ derived intelligence for what changed)
npm run sync:due -- --dry-run    # what is due, and how SAM requests would be spent
npm run status                   # freshness, schedule, SAM budget, database size
npm run sync                     # advanced: every source now, incremental
npm run sync -- reconcile        # advanced: reconciliation pass (bulk CSV, full listings)
npm run sync -- usaspending      # one source
npm run sync -- archive 2025     # import archived SAM FY2025 (profile-filtered)
npx tsx src/server/cli.ts score  # rescore everything
```

---

## Scheduled jobs

| Job | Default cadence |
|---|---|
| SAM Opportunities API (priority checks, then new-notice feed) | every 6 h (budget-aware) |
| SAM Contract Awards | daily |
| GSA forecasts | daily (+ weekly full reconciliation) |
| DHS APFS forecasts | daily |
| SBA SUBNet | daily |
| Grants.gov | daily |
| USAspending recompete scan | daily |
| SAM bulk extract reconciliation (free; focused ingestion) | daily |
| Derived engines | after every sync |

Three ways to run them (all run only what is due):
1. **GitHub Actions** (recommended for free hosting): `.github/workflows/scheduled-sync.yml` runs `npm run sync:due` every 3 hours **directly against Supabase**, so it does not depend on a sleeping web instance. Enable with the repository variable `GOVCHECK_SCHEDULED_SYNC=true` and the secrets `DATABASE_URL`, `DATABASE_SSL_CA_BASE64`, `SAM_API_KEY` (and optionally `ANTHROPIC_API_KEY`). Manual runs (`workflow_dispatch`) offer a dry-run option.
2. **In-process scheduler** (`SCHEDULER_ENABLED=true`, default in production) for always-on hosts: checks every 5 minutes. Set it to `false` when GitHub Actions schedules (as `render.yaml` does).
3. **External cron**: `POST /api/cron/sync` with `Authorization: Bearer $CRON_SECRET` (`?mode=all` forces a full refresh).

Scheduled syncs start only after onboarding is complete. Only one process syncs at a time: an expiring **database lease** coordinates the web app, GitHub Actions and any CLI, and runs left “running” by a crashed process are marked failed only when no process holds the lease.

### SAM.gov request budget
The daily limit is enforced atomically in the database across all processes, and every request is journaled with a category (Sources & sync → *SAM.gov API budget* shows limit, used, remaining, reserve, usage by category and reset time). Scheduled work uses only *limit − reserve* and spends it in priority order: (1) Pursue/Interested/Watch and active-capture opportunities (searched by solicitation number to catch amendments; description re-fetched only when the notice changed), (2) relevant active opportunities closing within 21 days with data older than 2 days, (3) strong matches with stale data, (4) new strong matches from the bulk file never fetched live, then the general new-notice feed. Targeted searches and manual refreshes may use the reserve. Breadth comes from free sources (SAM bulk extract, USAspending, forecasts, SUBNet, Grants.gov).

### Focused bulk ingestion and capability terms
In `focused` mode the free SAM bulk file is still scanned in full, but a notice is stored only if it matches the company NAICS (or its 4-digit industry group / `SAM_BULK_FOCUS_NAICS_PREFIXES`), PSC, a capability/keyword **discovery term** in the title (or two in the description), a preferred agency within the company's NAICS sectors — or if GovCheck **already tracks** it (same notice ID or solicitation number), so later profile changes never stop change tracking. Discovery terms are derived from confirmed capabilities, their keywords and technologies, and company keywords; single generic words are excluded. They are listed on Sources & sync and edited on the Company page (edits to built-in capability keywords now survive restarts).

---

## How matching works

**Base company fit (0–100)** — objective, explainable, independent of feedback. Weighted components (weights configurable in *Company profile → Scoring weights*):

| Component | Default | What earns points |
|---|---|---|
| Capability match | 30 | Confirmed capabilities (and their keywords/technologies) found in title/description/documents, weighted by strength 1–5; title mentions count more. Quoted evidence shown. |
| Scope / technical | 20 | TF-IDF cosine similarity between the opportunity text and your capabilities + past performance (shared terms listed). |
| Past performance | 15 | Best-matching project: scope similarity + same agency + same NAICS + comparable size. |
| NAICS / PSC / agency | 10 | Exact/industry-group NAICS, PSC, preferred agencies; excluded agencies zero it. |
| Value fit | 10 | Against min worthwhile / preferred max / realistic max. Unknown is neutral; estimated values count with reduced confidence. |
| Location / delivery | 5 | Service area, preferred/excluded locations, remote/on-site capability, travel. |
| Timeline / capacity | 5 | Days to respond (too soon loses points); pre-solicitation stages score well (time to position); duration vs preference. |
| Strategy | 5 | Prime/sub preference, preferred/excluded opportunity types, keywords and negative keywords. |

**Eligibility** (separate from the score): *Eligible, Likely eligible, Unclear, Likely ineligible, Ineligible*. Hard signals — set-aside vs your **confirmed** certifications/business size, clearance requirements detected in text vs your clearances, contract-vehicle restrictions vs vehicles you hold, SAM registration status, grant applicant types. *Ineligible* is only used when an official restriction conflicts with something you explicitly confirmed; ambiguous or text-derived evidence yields *Unclear* with what to verify. Pre-solicitation records are at most *Likely eligible*.

**Separate score dimensions** (never blended into fit): **Strategic attractiveness** (value vs. your range, timing/positioning, competition restriction you qualify for, customer relationship, incumbent dynamics, option-exercise / sole-source / cancellation penalties), **Data confidence** (completeness, scope text, parsed documents, official vs. inferred value, corroborating sources, open eligibility questions — with the list of what is missing), and **Review priority** = 80 % personalized fit + 20 % attractiveness, then **capped by eligibility** (*Ineligible* ≤ 10, *Likely ineligible* × 0.5, *Unclear* × 0.85) and by status (cancelled/expired × 0.4). The default “Best” sort and the dashboard use review priority, so a keyword-perfect 8(a) set-aside you cannot bid never outranks work you can win. Every point is explained in the dossier.

**Recommended next actions** are generated deterministically (no AI needed) from stage, deadlines, eligibility flags, documents, contacts and incumbent status — each with the reason.

**Discovery reasons** (“Why we found it”) list sources, profile matches, related history (same office as past pursuits, linked awards, forecasts) and signals (expiring contracts, non-SAM-only records).

**Data completeness** is a separate 0–100 measure of how much is known (agency, scope, value, deadline, NAICS, PSC, set-aside, contacts, documents, award history, incumbent, duration, evaluation criteria, place).

**Pricing intelligence**: official values (forecast band, ceiling, award, obligated, base+options) are shown separately from **derived/estimated** values. The enrichment engine pulls same-agency + NAICS award history from USAspending, finds possible incumbents (office, NAICS/PSC, scope similarity, end date vs expected start) and comparable awards, and produces an **Estimated likely range** (interquartile range of comparable values) with confidence and a written basis. Thin records (e.g. one-line forecasts) are matched on agency + NAICS only and labeled low confidence.

**Recompete intelligence**: contracts in your NAICS/PSC/capability area ending within 18 months are checked for successor procurements (same agency, NAICS/PSC, scope similarity, posted within 24 months of expiration) and for existing forecasts before any signal is created. Otherwise a **POSSIBLE RECOMPETE — INTELLIGENCE SIGNAL, NOT AN ACTIVE SOLICITATION** profile is created with the incumbent, value, period of performance and a derived recompete window.

---

## How preference learning works

- Every decision (*Strong pursue, Pursue, Partner/Sub, Watch, Review later, Pass, Not eligible, Duplicate/irrelevant*; legacy *Interested/Maybe/Not relevant* remain valid) with structured reasons (e.g. *agency relationship, incumbent displacement, wrong technology, no past performance, impossible deadline, vehicle/clearance unavailable, incumbent too strong, not profitable, outside strategy*) and free text is stored permanently with full history; changing PASS → PURSUE keeps both records and retrains. *Not eligible*, *Duplicate* and *Review later* are recorded but **do not train** the preference model (they say nothing about what work you want).
- **Capture pipeline** (Discovered → Reviewing → Qualified → Capture → Bid/No-bid → Proposal → Submitted → Awarded/Lost/No-bid) with owner, priority, win probability, next action/date, proposal deadline, partners, win themes, risks and questions. Every edit is journaled; refreshes never touch it; merges carry it (and undo returns it).
- Each opportunity has an interpretable feature vector: fit-component ratios, agency/sub-agency/office, NAICS & NAICS group, PSC group, stage, class, set-aside, value band, state, contract vehicle, clearance, on-site, matched capabilities and capability areas, incumbent presence.
- An **L2-regularized logistic regression** (soft labels: pursue 1.0 … not relevant 0.0) is trained on your current decisions. **Reasons add targeted samples** restricted to the feature groups each reason speaks to (e.g. *Too large* → value band; *Wrong agency* → agency/office).
- **Preference score** = (1 − α)·fit + α·100·p(pursue), with α growing with evidence: 0 decisions → 0; 1–9 → 0.06 (≈ base); 10–24 → 0.2; 25–49 → 0.35; 50+ → 0.55. Base fit is never modified.
- Each retrain creates a new model version with sample count, weights, training accuracy, a base-fit-only baseline and (≥15 decisions) 5-fold cross-validated accuracy. The **Preference learning** page shows top positive/negative weights, what changed since the previous version and the biggest re-rankings; each dossier shows its feature contributions and score history (“why your personalized score changed”).

---

## AI configuration

AI improves understanding but is never a single point of failure: ingestion, search, scoring, learning and rule-based requirement detection all work without it.

- Set `ANTHROPIC_API_KEY` (server-side only). Default model `claude-opus-5-5` (`ANTHROPIC_MODEL` to change).
- Uses structured outputs (Zod schema) to extract: work summary, customer need, likely responsibilities, objectives, tasks, workstreams, deliverables, mandatory/technical requirements, technologies, systems, labor categories, staffing, key personnel, clearance, certifications, contract vehicle/type, pricing info, period of performance, options, place, travel, performance/reporting/compliance requirements, submission deadline/method, questions deadline, page limits, volumes, forms, evaluation criteria, contacts, risks and **missing information** — each with a verbatim evidence quote, document and page.
- The prompt requires `null`/empty for anything not stated and treats documents as data (prompt-injection resistant). Results are labeled **AI EXTRACTED** and never override official values.
- **Caching**: results are keyed by a hash of the exact input content + model + prompt version; unchanged content is never re-analyzed (no tokens spent). Server-side refusal fallback is enabled; refusals and errors are recorded, not fatal.
- Automatic analysis runs after syncs for opportunities with fit ≥ `AI_AUTO_ANALYZE_MIN_FIT` (max `AI_MAX_ANALYSES_PER_RUN` per run); any opportunity can be analyzed on demand.

Deterministic **rule-based extraction** (always on, labeled DERIVED with quoted evidence) detects clearance levels, contract vehicles, on-site/travel, page limits, question deadlines, evaluation factors (LPTA/best value), contract types, submission methods, certifications and key-personnel language.

**Documents**: PDF (text layer, per-page), DOCX, XLSX, CSV, TXT, HTML are parsed; scanned PDFs are flagged `ocr_needed` (OCR is not enabled). Each document keeps a content hash and version; changed files emit DOCUMENT_UPDATED.

---

## Data durability guarantees

- Raw source records are stored verbatim with retrieval time, content hash and parser version; **every distinct version** is kept in `source_record_versions`.
- Field values are retired (not overwritten) when a source changes them; conflicts across sources are preserved.
- No refresh deletes profiles, records, decisions, notes, tags, overrides, manual relationships or merge decisions. Merges are journaled and fully reversible.
- Disappearing records are marked `not_seen`; AI analyses persist while content is unchanged; preference-model history is retained.
- Tests verify these guarantees (see below).

---

## Deployment

The app is one Node process (API + built SPA + optional scheduler) plus PostgreSQL.

**Free team pilot — Supabase + Render Free + GitHub Actions:** follow **[docs/DEPLOY_SUPABASE_RENDER.md](docs/DEPLOY_SUPABASE_RENDER.md)**. `render.yaml` deploys a `plan: free` Docker web service with `REQUIRE_DATABASE_URL=true` and `SCHEDULER_ENABLED=false`; all state is in Supabase. While a sleeping instance wakes up, the server answers immediately with a "starting" state and the browser shows *Connecting to GovCheck…*. Teammates need only the URL and `APP_PASSWORD`.

**Docker** (any host):
```bash
docker build -t govcheck .
docker run -p 8787:8787 --env-file .env -v govcheck-data:/app/data govcheck
```

**Render**: `render.yaml` defines the web service with health check `/api/health`; it asks for `DATABASE_URL`, `DATABASE_SSL_CA_BASE64`, `SAM_API_KEY`, `APP_PASSWORD` and optionally `ANTHROPIC_API_KEY`, and generates `SESSION_SECRET`/`CRON_SECRET`.

**Any VM / Fly.io / Railway**: `npm ci && npm run build && NODE_ENV=production npm start`.

Recommended production settings: `DATABASE_URL` (Supabase) + `DATABASE_SSL_CA_BASE64`, `REQUIRE_DATABASE_URL=true`, `APP_PASSWORD`, `SESSION_SECRET`, and either `SCHEDULER_ENABLED=true` (always-on host) or the GitHub Actions workflow. Serverless platforms with short function timeouts are not suitable for the sync workers.

---

## Testing & quality checks

```bash
npm run lint
npm run typecheck
npm test            # vitest — fixtures only, no live government calls
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/govcheck_test npm test   # also run the real-PostgreSQL tests (CI does this)
npm run build
npm run check       # all of the above
```

The suite (in-memory Postgres via PGlite + recorded real API fixtures) covers: SAM API & bulk normalization, SAM Contract Awards & USAspending normalization, GSA/SUBNet/Grants/RSS normalizers, identifier normalization, exact solicitation matching, cross-agency solicitation collisions, PIID matching, award linking with provenance, duplicate prevention, probabilistic relationship scoring (no auto-merge), merge + undo, raw snapshot retention, change detection, refresh preserving decisions/notes/tags, not-seen marking, coverage signals, explainable scoring & weights, eligibility rules, preference learning direction & decision history, retraining with PASS→PURSUE, failed-connector isolation, robots.txt compliance, USAspending page binary search, API secret non-exposure, password/cron auth, and a smoke test of every read endpoint. `tests/bd.test.ts` adds: DHS APFS normalization and exact incumbent/recompete linking, not-seen handling, GSA duplicate-page coverage warnings, scope-change detection (and no-noise on whitespace), derived cancellation, solicitation-released, upgrade-safe snapshots, sole-source detection, attractiveness/confidence/priority with eligibility capping, non-training decisions, capture journaling through refresh/merge/undo, compliance requirement extraction with explicit/mentioned strength, document classification, recommended actions, IDV end dates, SSRF guards, CSV formula neutralization, and every new endpoint/export. `tests/promote.test.ts`, `tests/hosting.test.ts` and `tests/sam.test.ts` cover the hosted setup: PGlite→Postgres promotion (all tables, UUIDs, versions, cursors, merges, idempotency, resume, no overwrite, dry run, conflict refusal, local directory unchanged — against real PostgreSQL when `TEST_DATABASE_URL` is set), PGlite/Postgres selection, CA-from-secret TLS, the cross-process sync lease, due-only scheduling, atomic SAM budgets with category journaling and reserve, the SAM priority order, targeted-search planning/budgeting (previews never contact SAM), focused bulk ingestion, capability terms, new change events without duplicates, and user data surviving refreshes.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| SAM sources show **Not configured** | Set `SAM_API_KEY` in the server environment and restart. |
| SAM sync stops with “budget reached” | Expected with personal keys (10/day). The window resumes automatically next day; raise `SAM_DAILY_REQUEST_LIMIT` if your key allows more. |
| SAM HTTP 403/401 | Key invalid/expired — regenerate in SAM.gov Account Details. |
| No recompete signals | Add NAICS codes to the company profile, then sync USAspending. |
| Grants never appear | Turn on *Include grants* in Company information. |
| SUBNet or forecast source **Degraded/Error** | The public page/listing likely changed. Other sources keep working; check *Sources → History* for the logged error. |
| Supabase TLS error (“self-signed certificate in chain”) | Supply Supabase's CA (`DATABASE_SSL_CA_FILE`, or `DATABASE_SSL_CA_BASE64` on hosts). More in the [deployment guide](docs/DEPLOY_SUPABASE_RENDER.md#troubleshooting). |
| “A sync is already running” | Only one process syncs at a time (web app, GitHub Actions, CLI share a lease); wait for it or check *Sources → History*. |
| Documents show **skipped** | SAM attachments need `SAM_DOWNLOAD_DOCUMENTS=true` (uses the SAM budget); SBA attachments are disallowed by robots.txt — open them from the link. |
| Scores look flat | Confirm capabilities (with strengths), add NAICS and past performance; scoring re-runs automatically after profile saves. |
| Reset local data | Stop the server and delete `data/pglite` (export a backup first). |

---

## Coverage matrix

See [`docs/SOURCE_COVERAGE.md`](docs/SOURCE_COVERAGE.md) for the per-source **raw → ingested → stored → displayed → missing** matrix, remaining gaps, sources that must not be scraped, keys to obtain, cadence and storage estimates, and [`docs/AUDIT_2026-10.md`](docs/AUDIT_2026-10.md) for the BD audit report.

## Known limitations

- **SAM rate limits**: with a 10-request/day key, the live API alone cannot cover all notices; GovCheck spends it on tracked and high-priority opportunities and relies on the free bulk extract for breadth.
- **Free hosting**: Render Free sleeps after ~15 minutes idle (first visit waits up to a minute); Supabase Free is 500 MB — keep `SAM_BULK_INGEST_MODE=focused` and watch *Database & storage*. GitHub pauses scheduled workflows after 60 days without repository activity.
- **GSA forecast contacts/details** require login.gov and are not collected.
- **SBA SUBNet** has no API; the reader depends on page structure and is marked Degraded if it changes. SBA attachments are not downloaded (robots.txt).
- **OCR** for scanned PDFs is not enabled (flagged as `ocr_needed`).
- **Semantic matching** uses TF-IDF (deterministic, no external service). An embeddings provider/pgvector can be added behind the same `SimilarityModel` interface.
- **Personnel/vendor data** is limited to public procurement fields; no personal data is scraped.
- Single-workspace (one company profile). Multi-user roles are not implemented; `APP_PASSWORD` gates access.

## Project layout

```
migrations/               SQL migrations (schema + RLS)
src/shared/domain.ts      shared vocabulary (stages, provenance, decisions…)
src/server/
  connectors/             source adapters + registry (sam/, usaspending, gsaForecast, sbaSubnet, grantsGov, genericFeed)
  pipeline/               store, apply, resolve, canonical, awards, enrich, recompete, coverage, documents, merge, sync, scheduler
  scoring/                fit, eligibility, similarity, preference, run
  ai/                     provider abstraction, Claude provider, analysis cache, rule-based extraction
  routes/                 REST API
src/client/               React app (pages/, components/, styles.css)
tests/                    vitest suites + recorded fixtures
```
