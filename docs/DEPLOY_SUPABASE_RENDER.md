# Moving GovCheck to Supabase + Render (free pilot)

This guide takes you from **where you are now** — a local GovCheck with an initial source
refresh stored in `./data/pglite` — to a **shared hosted GovCheck** your team opens with a
URL and a password:

```
local ./data/pglite ──(npm run db:promote)──▶ Supabase PostgreSQL ◀── Render web app (team uses this)
                                                        ▲
                                    GitHub Actions: `npm run sync:due` every 3 hours
```

* **Supabase** is the permanent, shared database: opportunities, raw source records and every
  version, change history, decisions, notes, capture data, scores, cursors and API usage.
* **Render Free** serves the website and API. Its disk is temporary, so nothing is stored there.
  It sleeps after ~15 minutes without visitors and takes up to a minute to wake up (GovCheck
  shows a "Connecting…" message meanwhile).
* **GitHub Actions** checks sources on a schedule directly against Supabase, so data keeps
  accumulating even while the Render site is asleep.

Your local `./data/pglite` is **never modified or deleted** by any step below. It stays your
fallback copy.

Teammates only ever need **the Render URL and the GovCheck password**. They never need Node,
Git, PowerShell, SAM keys, Supabase credentials or GitHub access.

---

## What you need

* The GovCheck repository on GitHub (this branch merged into `main`, see step 0).
* Your computer with GovCheck already working locally (Node 20.10+; `npm ci` done).
* Free accounts: [supabase.com](https://supabase.com), [render.com](https://render.com) (sign in with GitHub).
* Your SAM.gov public API key (optional Anthropic API key).

Commands below are shown for macOS/Linux and **Windows PowerShell** where they differ. Run
them in the GovCheck folder.

---

## 0. Get the new code

Merge this branch into `main` on GitHub (Render and the GitHub Actions schedule both use `main`).
Locally:

```bash
git checkout main
git pull
npm ci
```

## 1. Stop local GovCheck and make a safety copy

1. Stop the local server (Ctrl+C in the terminal running `npm run dev`).
2. Optional but recommended — copy the folder `data/pglite` somewhere safe
   (e.g. `data/pglite-backup-2026-10-04`). Promotion never touches it, but a second copy costs nothing.

You do not need to upgrade the local database first: the promotion applies the new migrations
to its temporary snapshot, not to your folder.

## 2. Create the Supabase project

1. In Supabase: **New project**. Pick a name (e.g. `govcheck`), a **strong database password**
   (save it in your password manager), and the region closest to your team. Plan: **Free**.
2. Wait until the project is ready.
3. **Connection string.** Click **Connect** (top of the project dashboard) → choose
   **Session pooler** → copy the URI. It looks like:
   ```
   postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```
   Replace `[YOUR-PASSWORD]` with the database password. Use the **Session pooler** string
   (port 5432): it works over IPv4, which Render and GitHub Actions need. (The "Direct
   connection" host is IPv6-only on the free plan.) If your password contains characters such
   as `@ : / ? #`, URL-encode them (e.g. `@` → `%40`) or choose a password without them.
4. **CA certificate.** Project **Settings → Database → SSL configuration → Download
   certificate**. Save it as `supabase-ca.crt` inside the GovCheck folder's `data/` directory
   (that folder is git-ignored, so the file can never be committed).
5. Leave everything else at defaults. You do **not** need Supabase API keys, the `anon` key or
   the `service_role` key — GovCheck connects to the database directly from its server, and
   row-level security (migration `002`) keeps Supabase's auto-generated web APIs closed.

> Do **not** start GovCheck against Supabase yet. Promote first (step 3), so Supabase receives
> your existing data instead of a fresh empty setup. (If you already did, see "Troubleshooting".)

## 3. Promote your local database into Supabase

### 3a. Configure the target (temporary)

Add these two lines to your local `.env` file (keep `DATABASE_URL` **empty** for now):

```dotenv
TARGET_DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
DATABASE_SSL_CA_FILE=./data/supabase-ca.crt
```

### 3b. Dry run — see what would happen (writes nothing anywhere)

```bash
npm run db:promote -- --dry-run
```

It prints the local row count of every table, what Supabase already has (nothing yet), the
migrations Supabase still needs, and whether anything would conflict. It ends with
`Dry run complete.`

### 3c. Promote

```bash
npm run db:promote
```

What happens:

1. Your `data/pglite` folder is copied to a temporary snapshot; only the snapshot is read.
2. The normal GovCheck migrations are applied to Supabase.
3. Every table is copied in dependency order, in batches (one transaction per batch), keeping
   all IDs and relationships: raw source records **and every stored version**, opportunities,
   identifiers, field provenance, snapshots, change events, relationships, awards, vendors,
   contacts, documents and extracted text, requirements, AI analyses, scores and score
   history, decisions (with history), notes, tags, capture pipeline and its history, company
   profile and capabilities, preference models, sync runs and errors, **source cursors and
   schedules**, and today's SAM API usage.
4. Rows already in Supabase are never overwritten (re-running only fills in what's missing).
5. Every local row is looked up in Supabase by primary key; connector cursors, schema version
   and the company profile are checked.
6. A report table is printed and saved to `data/promotion-report-<time>.json`, and it confirms
   `Local database unchanged: verified`.

Large databases take a while (tens of minutes for hundreds of thousands of rows over the
internet). **If it is interrupted, run the same command again** — it resumes, skipping rows
already copied.

### 3d. Validate the counts

In the printed report every table should show `missing 0`, `remote after` equal to `local`,
and all checks `[OK]`:

```
table                     local  remote before  remote after  inserted  present  differs  missing
opportunities             12345          (new)         12345     12345        0        0        0
source_records            40210          (new)         40210     40210        0        0        0
source_record_versions    41877          (new)         41877     41877        0        0        0
…
Checks:
  [OK] Every local row is present in the target (by primary key) — all present
  [OK] Source connector cursors preserved (next sync continues where local left off) — 14 connectors match
  [OK] Company profile is the active profile in the target — …
  [OK] Schema versions match — 001_core, 002_row_level_security, 003_capture_scores_quality, 004_hosting_budget_search
```

Running `npm run db:promote` a second time should show `inserted 0` everywhere. That is the
idempotency check.

## 4. Point your local GovCheck at Supabase and verify

1. Edit `.env`:
   ```dotenv
   DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   DATABASE_SSL_CA_FILE=./data/supabase-ca.crt
   # TARGET_DATABASE_URL is no longer needed — delete that line.
   ```
2. `npm run dev` and open http://localhost:5173. The startup log says
   `Database: PostgreSQL at aws-0-…pooler.supabase.com:5432/postgres · TLS verified with custom CA (DATABASE_SSL_CA_FILE)`.
3. Check that your existing opportunities, decisions, notes and capture pipeline are all there.
   **Sources & sync** should show the same "last successful" times and stored counts as before.
4. Small incremental sync: on **Sources & sync**, click **Check due sources now** (or run
   `npm run sync:due`). Only sources whose interval has elapsed run. In the run history
   ("History"), the counts read *retrieved / new / changed / unchanged / failed*: previously
   downloaded records show up as **unchanged** and are not re-processed; the SAM API window
   continues from the saved cursor instead of starting over.
5. `npm run status` prints data freshness, what is due next, today's SAM budget and the
   database size.

## 5. Prepare the certificate as a secret

Hosted services can't read a file from your computer, so the certificate is supplied as a
one-line base64 secret:

* macOS / Linux: `base64 -w0 data/supabase-ca.crt` (macOS: `base64 -i data/supabase-ca.crt`)
* Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("data\supabase-ca.crt"))`

Copy the long single-line output. That value is `DATABASE_SSL_CA_BASE64`. (It is a public CA
certificate, not a password, but treat it as configuration and keep it in secrets anyway.)

## 6. Deploy the web app on Render (Free)

1. Render dashboard → **New → Blueprint** → connect your GitHub account → choose the
   GovCheck repository and the `main` branch. Render reads `render.yaml`.
2. It asks for the values marked `sync: false`:
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Session pooler connection string (with password) |
   | `DATABASE_SSL_CA_BASE64` | the one-line output from step 5 |
   | `SAM_API_KEY` | your SAM.gov key |
   | `ANTHROPIC_API_KEY` | optional — leave blank to run without AI |
   | `APP_PASSWORD` | the shared password your team will use |

   `SESSION_SECRET` and `CRON_SECRET` are generated by Render automatically.
   `REQUIRE_DATABASE_URL=true` makes the app refuse to start on a temporary local database,
   and `SCHEDULER_ENABLED=false` leaves scheduling to GitHub Actions.
3. **Apply**. The first build takes a few minutes. When it shows **Live**, open the URL
   (e.g. `https://govcheck.onrender.com`). `/api/health` should return `{"ok":true,"database":"postgres",…}`.
4. Sign in with `APP_PASSWORD`. You see the same data as in step 4 — signing in never starts a
   refresh.

Security notes: the browser only talks to the GovCheck server; database credentials, SAM and
Anthropic keys never leave Render. Login cookies are `HttpOnly`, `Secure` (production) and
signed with `SESSION_SECRET`.

## 7. Configure GitHub Actions (scheduled syncing)

Repository on GitHub → **Settings → Secrets and variables → Actions**.

**Secrets** tab → *New repository secret* (same values as on Render):

| Secret | Required |
|---|---|
| `DATABASE_URL` | yes |
| `DATABASE_SSL_CA_BASE64` | yes |
| `SAM_API_KEY` | for SAM.gov API checks |
| `ANTHROPIC_API_KEY` | only if you want AI analysis during scheduled runs |

**Variables** tab → *New repository variable*:

| Variable | Value |
|---|---|
| `GOVCHECK_SCHEDULED_SYNC` | `true` (turns the schedule on) |
| `SAM_DAILY_REQUEST_LIMIT` | `10` (or `1000` for a role/system key; must match Render) |
| `CONTACT_EMAIL` | optional, sent in the User-Agent to public sources |

## 8. Enable and test the schedule

1. **Actions** tab → **Scheduled sync** → **Run workflow** → tick *dry run* → **Run**. The log
   shows which sources are due and how SAM requests would be spent. No data changes.
2. Run it again without *dry run*. The job applies migrations (none pending), runs only the due
   sources, and prints a status summary. Secrets are masked in logs.
3. From now on it runs every 3 hours by itself. Each source still runs only when *it* is due
   (SAM API every 6 h, free bulk extract daily, forecasts/SUBNet/Grants.gov/USAspending on
   their own intervals). The **Sources & sync** page shows "Last check … by github-actions".

GitHub pauses scheduled workflows in repositories with no activity for 60 days; a commit or a
manual run re-enables them. You'll get an email from GitHub if that happens.

## 9. Send the team the link

Send teammates:

1. the Render URL, and
2. the GovCheck password.

That's all they need. The first visit after a quiet period shows "Connecting to GovCheck…" for
up to a minute while Render wakes up.

---

## How scheduled syncing works

* Each source has its own interval (`schedule_minutes`) and saved **cursor**. `npm run sync:due`
  (and the **Check due sources now** button) runs only sources whose interval has elapsed and
  continues from the cursor. Nothing runs before company setup is complete.
* Raw records are compared by **content hash**: unchanged records only get their "last seen"
  time updated; they are not re-normalized, re-enriched, re-scored or re-analyzed. Changed
  records get a new **source_record_version** (identical versions are never stored twice), the
  opportunity profile is recomputed and **change events** are recorded once per change.
* A database **lease** guarantees only one process ingests at a time (GitHub Actions, the web
  app's manual buttons, a laptop CLI). If one is running, the others skip and say so. A process
  that dies releases the lease automatically after 10 minutes.
* **Refresh all sources** and **Full reconciliation** still exist under *Sources & sync →
  Advanced*, with a warning; normal operation never needs them.

## How SAM.gov requests are conserved

With a personal key (10 requests/day), every request counts:

1. Scheduled work may use only **limit − reserve** (default reserve: 2 of 10). The reserve is
   kept for **Refresh this opportunity** and **Targeted search**.
2. Scheduled checks are spent in priority order: (1) opportunities marked
   Pursue/Interested/Watch or in an active capture stage — searched by solicitation number, so
   amendments re-posted under new notice IDs are found, with the full description fetched only
   when the notice changed; (2) relevant active opportunities closing within 21 days whose data
   is older than 2 days; (3) strong matches with stale data; (4) new strong matches from the
   bulk file that were never fetched live; then (6) the general new-notices feed with whatever
   is left.
3. Broad discovery uses free sources: the SAM bulk extract (daily), USAspending, GSA and DHS
   forecasts, SBA SUBNet and Grants.gov.
4. SAM attachments are never downloaded unless `SAM_DOWNLOAD_DOCUMENTS=true`.
5. The limit is enforced atomically in the database, so the web app and GitHub Actions together
   can never exceed `SAM_DAILY_REQUEST_LIMIT`. **Sources & sync → SAM.gov API budget** shows the
   limit, used, remaining, reserve, which categories used the requests and when the counter
   resets (00:00 UTC).

## How targeted search works

**Targeted search** (left menu) lets anyone search with NAICS codes, a title phrase, keywords,
PSC, agency, set-asides, states, notice types and date windows.

1. **Search GovCheck** searches the stored data. It is free and never contacts SAM.
2. **Search live SAM…** opens a confirmation showing the number of requests (one per NAICS
   code), today's remaining budget and the exact parameters sent. Nothing is sent until you
   click **Confirm**. Changing filters never spends a request.
3. Live results are de-duplicated by notice ID and saved through the normal pipeline (raw
   record, version history, scoring), so they become part of GovCheck's intelligence.

## Database size (Supabase Free = 500 MB)

* `SAM_BULK_INGEST_MODE=focused` (default) scans the whole free bulk file but stores only
  notices that match your NAICS (or its 4-digit industry group / `SAM_BULK_FOCUS_NAICS_PREFIXES`),
  your PSC codes, your capability terms (title, or two terms in the description), a preferred
  agency in your NAICS sector — **or that GovCheck already tracks** (same notice ID or
  solicitation number), so changing your profile later never stops tracking existing
  opportunities. Set `SAM_BULK_INGEST_MODE=full` on larger infrastructure.
* **Sources & sync → Database & storage** shows size, largest tables, version growth, recent
  sync volume and a projection; it warns at `DB_SIZE_WARN_MB` (400) and near `DB_SIZE_LIMIT_MB`
  (500). GovCheck never deletes history to save space — it warns so you can decide (upgrade the
  Supabase plan, narrow ingestion, disable a source).

## Rollback

* **App version:** Render → your service → **Events** → pick the previous deploy → **Rollback**.
* **Back to local-only:** set `DATABASE_URL=` (empty) in your local `.env`. GovCheck uses
  `./data/pglite` again, exactly as it was before the promotion. Work done in the hosted app
  after promotion stays in Supabase (it is not copied back automatically).
* **Disable scheduled syncing:** set the variable `GOVCHECK_SCHEDULED_SYNC` to `false`, or
  disable the workflow in the **Actions** tab.
* **Database:** promotion only inserts. To start the Supabase side over, create a new
  Supabase project and promote again. Supabase Free does not include downloadable backups; use
  **Company profile → Export backup** regularly for everything your team created, and keep the
  local `data/pglite` copy.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `self-signed certificate in certificate chain` / `unable to get local issuer certificate` | The CA is missing or wrong. Re-download it from *this* project (Settings → Database → SSL configuration) and set `DATABASE_SSL_CA_FILE` / `DATABASE_SSL_CA_BASE64`. Do not switch to `DATABASE_SSL_ALLOW_UNVERIFIED`. |
| `DATABASE_SSL_CA_BASE64 did not decode to a PEM certificate` | Encode the whole `.crt` file on one line (step 5); paste without quotes or spaces. |
| `ENOTFOUND` / `ENETUNREACH` from Render or GitHub Actions | You used the Direct connection (IPv6). Use the **Session pooler** string. |
| `password authentication failed` | Wrong database password, or special characters not URL-encoded. Reset it in Supabase → Settings → Database. |
| Promotion says the target "already contains GovCheck's auto-created reference data" | GovCheck was started against Supabase before promotion and created its default capability library / an empty company profile. Nothing real is there, so re-run with `npm run db:promote -- --replace-target-seed-data`. |
| Promotion says the target "already contains different GovCheck data" | Supabase holds a different GovCheck database (e.g. syncs ran there first). Nothing was written. Promote into a fresh Supabase project. |
| Promotion was interrupted | Run the same command again; it resumes. |
| "A sync is already running (… on fv-az123…)" | GitHub Actions is syncing. Wait for it; the lease clears itself within 10 minutes if a job crashed. |
| Render shows "Connecting to GovCheck…" for a long time | First visit after idling takes up to a minute. If it never connects, check Render → Logs for a database error. |
| Workflow log: `Repository secret DATABASE_URL is not set` | Add the secrets in step 7. |
