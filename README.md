# GovCheck — Government Opportunity Intelligence Engine

GovCheck continuously discovers, consolidates, enriches, scores and tracks potential government work across the **entire procurement lifecycle** — forecasts, sources sought/RFIs, presolicitations, solicitations, amendments, awards, contract performance, expiration and possible recompetes — plus subcontracting and (optionally) grant opportunities.

Every record from every source is kept verbatim. Records about the same procurement are consolidated into one **Opportunity Profile** whose every value carries provenance — **OFFICIAL**, **DERIVED**, **ESTIMATED**, **AI EXTRACTED**, **USER ENTERED** or **UNKNOWN** — so inferred information never looks official. Refreshes never delete history or touch your decisions, notes, tags or manual links. The system builds a proprietary, growing dataset of agencies, offices, contracts, vendors, incumbents, pricing and your own pursuit decisions.

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

Without any keys you still get live data from **GSA forecasts, SBA SUBNet, Grants.gov, USAspending** and the **SAM.gov bulk extract**. Adding `SAM_API_KEY` enables the live SAM Opportunities and Contract Awards APIs.

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
| User data | `user_opportunity_decisions` (full history), `user_feedback_reasons`, `user_notes`, `user_tags`, `user_field_overrides`, `watchlists` (saved views), `merge_decisions` (journaled, undoable) |
| Intelligence | `coverage_signals`, `ai_analyses` (cached by content hash), `app_state` |

---

## Environment variables

See [`.env.example`](.env.example) for the complete annotated list.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Production | Postgres/Supabase connection string. Empty → embedded PGlite. |
| `DATABASE_SSL_CA_FILE` | With Supabase | Path to Supabase's CA certificate (TLS is verified by default). |
| `SAM_API_KEY` | For SAM APIs | SAM.gov public API key (server-side only). |
| `SAM_DAILY_REQUEST_LIMIT` | — | Daily SAM request ceiling (default **10** = non-federal personal key). |
| `SAM_DOWNLOAD_DOCUMENTS` | — | Download SAM attachments (uses the SAM budget). Default false. |
| `ANTHROPIC_API_KEY` | Optional | Enables AI extraction/summaries. |
| `ANTHROPIC_MODEL` | — | Default `claude-opus-5-5`. |
| `CRON_SECRET` | For external cron | Bearer secret for `POST /api/cron/sync`. |
| `APP_PASSWORD` | Recommended when hosted | Single shared password; HttpOnly signed session cookie. |
| `SESSION_SECRET` | — | Cookie signing secret. |
| `SCHEDULER_ENABLED` | — | In-process scheduler (default on when `NODE_ENV=production`). |
| `PORT`, `APP_BASE_URL` | — | Server port / public URL. |

**Secrets never reach the browser.** The UI only receives booleans (“configured / not configured”). Logged messages are redacted (`api_key=`, bearer tokens, connection strings and the values of all secret env vars).

---

## Database & migrations

Migrations live in [`migrations/`](migrations) and run automatically at server start (forward-only, recorded in `schema_migrations`). To run them explicitly:

```bash
npm run migrate
```

### Using Supabase
1. Create a Supabase project.
2. *Project Settings → Database → Connection string*: copy the **Session pooler** (or direct) URI into `DATABASE_URL`.
3. Download the SSL certificate (*Database → SSL Configuration*) and set `DATABASE_SSL_CA_FILE=/path/to/prod-ca.crt`. (`DATABASE_SSL_ALLOW_UNVERIFIED=true` is an explicit, not-recommended opt-out.)
4. Start the server — migrations create the schema.

**Row-level security**: migration `002` enables RLS on every table with *no* permissive policies. The browser never talks to Supabase directly; the server connects with the privileged role, so Supabase's auto-generated REST/GraphQL APIs expose nothing even if an anon key leaks.

**Backups / portability**: `GET /api/export/backup.json` (the **Export backup** button on the Company profile page) exports everything you created — profile, capabilities, decisions (with history), notes, tags, overrides, manual relationships, merges and preference-model history. Use Supabase's point-in-time backups for full database backups. With PGlite, copy the `data/pglite` directory while the server is stopped.

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
| **SAM.gov Data Services (bulk CSV)** | Official bulk file | — | Full daily extract (~220 MB) incl. full description text; archived fiscal-year files | Reconciliation only (weekly by default). Streams, decodes Windows-1252, filters to notices posted in `SAM_BULK_LOOKBACK_DAYS` or still open; unchanged rows skipped by hash. Archived FY import filtered to your NAICS groups. |
| **SAM.gov Contract Awards API** | Official API | `SAM_API_KEY` | PIID, modifications, IDV, solicitation ID, obligations, base+options, pricing type, competition, offers, business size, awardee UEI/CAGE | Incremental by last-modified date for your NAICS; targeted lookups by solicitation ID/PIID during opportunity refresh. Award families keyed by IDV+PIID. |
| **USAspending.gov** | Official API | — | Prime awards, obligations, outlays, periods of performance, recipients, agencies, solicitation identifiers, subaward counts | Scheduled **recompete scan**: for each profile NAICS, binary-searches the End-Date-sorted results to the first contract ending after today, then walks forward to the 18-month horizon. Also used for incumbent, pricing and agency analysis. Executive-compensation names are stripped (personal data). |
| **GSA Acquisition Gateway Forecasts** | Public JSON listing | — | Government-wide procurement forecasts: agency, sub-agency, NAICS, value band, award FY, acquisition strategy, award status (incl. recompete hints) | Forecast **detail pages require a login.gov session and are not accessed**, so forecast contacts are not collected. Page-view counters are excluded from snapshots to avoid false “changes”. |
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
- **Change detection** emits events: NEW_OPPORTUNITY, NEW_SOURCE, STATUS/STAGE/DEADLINE/VALUE/CONTACT/FIELD changes, NEW_DOCUMENT, DOCUMENT_UPDATED, AMENDMENT, AWARD_POSTED, FORECAST_LINKED, INCUMBENT_IDENTIFIED, RECOMPETE_SIGNAL, RELATIONSHIP_FOUND, REMOVED_FROM_SOURCE.
- Records that disappear from a full listing are marked **not seen** — never deleted.

Manual controls: **Refresh all sources** (top bar), per-source **Sync/Reconcile/Test** (Sources page), **Refresh this opportunity** (dossier: re-fetches each contributing record by identifier, pulls SAM awards by solicitation ID, USAspending history, documents, re-scores — user data untouched).

CLI equivalents:

```bash
npm run sync                     # all sources, incremental + derived intelligence
npm run sync -- reconcile        # reconciliation pass (bulk CSV, full listings)
npm run sync -- usaspending      # one source
npm run sync -- archive 2025     # import archived SAM FY2025 (filtered to your NAICS)
npx tsx src/server/cli.ts score  # rescore everything
```

---

## Scheduled jobs

| Job | Default cadence |
|---|---|
| SAM Opportunities API | every 6 h (budget-aware) |
| SAM Contract Awards | daily |
| GSA forecasts | daily (+ weekly full reconciliation) |
| SBA SUBNet | daily |
| Grants.gov | daily |
| USAspending recompete scan | daily |
| SAM bulk extract reconciliation | weekly |
| Derived engines | after every sync |

Two ways to run them:
1. **In-process scheduler** (`SCHEDULER_ENABLED=true`, default in production): checks every 5 minutes for due work. Scheduled syncs start only after onboarding is complete.
2. **External cron**: `POST /api/cron/sync` with `Authorization: Bearer $CRON_SECRET` runs whatever is due (`?mode=all` forces a full refresh). A ready-made GitHub Actions workflow is in `.github/workflows/scheduled-sync.yml` (enable with the repo variable `GOVCHECK_SCHEDULED_SYNC=true` and secrets `GOVCHECK_URL`, `GOVCHECK_CRON_SECRET`).

Only one sync runs at a time; runs left “running” by a restart are marked failed on boot.

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

**Discovery reasons** (“Why we found it”) list sources, profile matches, related history (same office as past pursuits, linked awards, forecasts) and signals (expiring contracts, non-SAM-only records).

**Data completeness** is a separate 0–100 measure of how much is known (agency, scope, value, deadline, NAICS, PSC, set-aside, contacts, documents, award history, incumbent, duration, evaluation criteria, place).

**Pricing intelligence**: official values (forecast band, ceiling, award, obligated, base+options) are shown separately from **derived/estimated** values. The enrichment engine pulls same-agency + NAICS award history from USAspending, finds possible incumbents (office, NAICS/PSC, scope similarity, end date vs expected start) and comparable awards, and produces an **Estimated likely range** (interquartile range of comparable values) with confidence and a written basis. Thin records (e.g. one-line forecasts) are matched on agency + NAICS only and labeled low confidence.

**Recompete intelligence**: contracts in your NAICS/PSC/capability area ending within 18 months are checked for successor procurements (same agency, NAICS/PSC, scope similarity, posted within 24 months of expiration) and for existing forecasts before any signal is created. Otherwise a **POSSIBLE RECOMPETE — INTELLIGENCE SIGNAL, NOT AN ACTIVE SOLICITATION** profile is created with the incumbent, value, period of performance and a derived recompete window.

---

## How preference learning works

- Every decision (*Pursue, Interested, Watch, Maybe, Pass, Not relevant*) with optional reasons and free text is stored permanently with full history; changing PASS → PURSUE keeps both records and retrains.
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

The app is one Node process (API + built SPA + scheduler) plus PostgreSQL.

**Docker** (any host):
```bash
docker build -t govcheck .
docker run -p 8787:8787 --env-file .env -v govcheck-data:/app/data govcheck
```

**Render**: `render.yaml` defines a Docker web service with health check `/api/health`; set `DATABASE_URL` (Supabase), `DATABASE_SSL_CA_FILE` (bundle the CA or mount a secret file), `SAM_API_KEY`, `APP_PASSWORD`, optionally `ANTHROPIC_API_KEY`.

**Any VM / Fly.io / Railway**: `npm ci && npm run build && NODE_ENV=production npm start`.

Recommended production settings: `DATABASE_URL` (Supabase), `APP_PASSWORD`, `CRON_SECRET`, `SESSION_SECRET`, `SCHEDULER_ENABLED=true` (or the external cron workflow). Serverless platforms with short function timeouts are not suitable for the sync workers.

---

## Testing & quality checks

```bash
npm run lint
npm run typecheck
npm test            # vitest — fixtures only, no live government calls
npm run build
npm run check       # all of the above
```

The suite (in-memory Postgres via PGlite + recorded real API fixtures) covers: SAM API & bulk normalization, SAM Contract Awards & USAspending normalization, GSA/SUBNet/Grants/RSS normalizers, identifier normalization, exact solicitation matching, cross-agency solicitation collisions, PIID matching, award linking with provenance, duplicate prevention, probabilistic relationship scoring (no auto-merge), merge + undo, raw snapshot retention, change detection, refresh preserving decisions/notes/tags, not-seen marking, coverage signals, explainable scoring & weights, eligibility rules, preference learning direction & decision history, retraining with PASS→PURSUE, failed-connector isolation, robots.txt compliance, USAspending page binary search, API secret non-exposure, password/cron auth, and a smoke test of every read endpoint.

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
| Supabase TLS error (“self-signed certificate in chain”) | Set `DATABASE_SSL_CA_FILE` to Supabase's CA cert. |
| “A sync is already running” | Only one sync runs at a time; wait for it (top-bar spinner) or check *Sources → History*. |
| Documents show **skipped** | SAM attachments need `SAM_DOWNLOAD_DOCUMENTS=true` (uses the SAM budget); SBA attachments are disallowed by robots.txt — open them from the link. |
| Scores look flat | Confirm capabilities (with strengths), add NAICS and past performance; scoring re-runs automatically after profile saves. |
| Reset local data | Stop the server and delete `data/pglite` (export a backup first). |

---

## Known limitations

- **SAM rate limits**: with a 10-request/day key, the live API alone cannot cover all notices; rely on the bulk extract for breadth.
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
