# G2X, Tango and third-party data: what GovCheck stores and why

GovCheck tracks one canonical opportunity per real procurement, built from several sources. Each source falls under different terms, so storage is split into four categories that are never mixed.

| # | Category | Where it lives | Examples |
|---|---|---|---|
| 1 | Public government records retrieved independently from authorized government feeds | `source_records`, `source_record_versions`, canonical `opportunities` fields with `official` provenance | SAM.gov notices, DHS APFS forecasts, USAspending awards |
| 2 | User-authored capture work | `user_notes`, `user_tags`, `user_opportunity_decisions`, `opportunity_capture`, `opportunity_assignments`, `opportunity_tracking`, research leads (`user_research_lead` source) | Notes, decisions, owners, a lead's own title |
| 3 | Minimal discovery attribution and links | `opportunity_discovery`, `discovery_match_decisions` | "Discovered via G2X by Pat on 2026-11-04", the G2X record link, a one-way SHA-256 key of that link |
| 4 | Provider-controlled licensed content | **Not stored** | G2X titles, summaries, notice text, attachments, team notes, AI answers; Tango payloads |

Category 4 is never promoted into category 1. An official record enters GovCheck only when GovCheck retrieves it itself from a government connector (for G2X results: the SAM.gov Opportunities API, by notice ID or solicitation number). The G2X result is used, transiently, only to decide which SAM.gov lookup to make.

## What the G2X integration does today

- **Interactive, individual use only.** Each member connects their own G2X account (OAuth with PKCE). Tokens are encrypted per user. One member's session and results are never visible to another member.
- **Read-only tools only**, discovered live from G2X. Arguments are validated against the live tool schema before any call.
- **No automatic pagination.** GovCheck fetches the next page only when the member clicks *Load next page*.
- **Search results are not written to the database.** Matching against GovCheck is read-only. Automated tests assert that no G2X result text appears in any table after a search.
- **Already in GovCheck (Case A):** matched by SAM notice ID, or by solicitation number plus a compatible agency, or by an earlier user decision. *Open existing opportunity* — no duplicate.
- **Official record available (Case B):** *Verify on SAM.gov & track* spends 1–2 SAM.gov requests, ingests the official notice through the normal pipeline, and stores a category-3 attribution row. The opportunity shows SAM.gov as its official source and G2X as its first-discovered source.
- **G2X-only (Case C):** *Track as research lead* requires explicit confirmation that the member wrote the title and notes. The record is labeled *Research lead · Not government verified · No official solicitation confirmed · Source discovery: G2X*, is an intelligence signal (never an open solicitation), and every value has `user_entered` provenance. The API rejects any extra fields (`.strict()`), so provider payloads cannot be attached.
- **G2X source tab:** shows attribution and connection status; *Load in my G2X session* fetches the record live for the current member only and does not store it.

## Disabled until written authorization exists

These are off in code (`G2X_CAPABILITIES` are all `false`) and behind `G2X_LICENSED_IMPORT_ENABLED` (default `false`). `POST /api/g2x/import` returns 403:

- automated or background G2X searches, refreshes or harvesting;
- storing G2X content (titles, descriptions, attachments, AI output) in the shared database;
- sharing one member's G2X results with teammates;
- sending G2X content to another AI provider.

### What permission would be needed for full automatic G2X → GovCheck integration

Written authorization from G2X (an addendum to the account's terms, or an API/data license) that explicitly covers:

1. **Systematic retrieval:** scheduled, non-interactive queries and pagination through result sets.
2. **Persistent storage** of the specific fields to be kept (for example title, notice type, dates, agency, summary), with any retention limit.
3. **Team sharing:** displaying stored G2X content to every member of the organization, not just the member whose account retrieved it.
4. **Derived use:** combining G2X fields with government records in the consolidated Summary, and in exports.
5. **AI processing:** whether G2X content may be sent to a third-party model (currently prohibited by GovCheck).
6. **Attribution and deletion duties:** required labels, and what must be deleted if the subscription ends.

Until then, Cases A–C above are the supported workflow. A licensed importer should be built behind the existing flag, store its content as a separate, clearly labeled source family, and be covered by its own tests.

## Tango

Tango research is interactive and quota-limited (see `TANGO_RESEARCH.md`). No Tango payload is stored. Only user-authored research notes (`research_signals`) are persisted, and they appear on an opportunity's source tabs as user-authored notes.
