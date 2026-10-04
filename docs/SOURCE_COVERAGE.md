# GovCheck source & field coverage matrix

Audit date: 2026-10-04. Verified against the live public endpoints where no key is required (GSA Acquisition Gateway, DHS APFS, USAspending, SBA SUBNet, Grants.gov) and against recorded fixtures for SAM.gov (key required).

Legend — **Ingested**: read by the connector. **Stored**: kept in `source_records.raw` (always, verbatim) and/or normalized tables. **Displayed**: visible in the dossier/list. **Missing**: available at the source but not captured, or not available at all.

Every raw record is stored verbatim (`source_records.raw`, every distinct version in `source_record_versions`), so "not normalized" never means "thrown away" — it means "kept, but not yet turned into a queryable field".

## SAM.gov Contract Opportunities API (`sam_opportunities`, key required)

| Raw data available | Ingested / normalized | Displayed | Missing / notes |
|---|---|---|---|
| noticeId, solicitationNumber, title, type, baseType | ✅ identifiers, stage, notice type | ✅ | — |
| postedDate, responseDeadLine, archiveDate/Type, active | ✅ dated facts with provenance | ✅ | `updatedDate` is not in v2 search results (re-posts detected by content hash) |
| fullParentPathName/Code, department/subTier/office, officeAddress | ✅ agency → sub-agency → office hierarchy, office codes | ✅ | — |
| naicsCode(s), classificationCode (PSC), typeOfSetAside(+Description) | ✅ | ✅ | — |
| placeOfPerformance (street/city/state/zip/country) | ✅ | ✅ | — |
| pointOfContact[] (type, name, title, email, phone, fax) | ✅ contacts with role + first/last seen | ✅ | `additionalInfo.content` was discarded — **now kept** as contact organization |
| description (URL → separate request) | ✅ on targeted refresh only (1 request each) | ✅ | Bulk extract provides full text for free |
| resourceLinks[] (attachments) | ✅ document records | ✅ | Filenames/sizes only known after download (each download costs a SAM request) |
| award{number, amount, date, awardee{name, UEI, location}} | ✅ award record + exact links | ✅ | — |
| uiLink, additionalInfoLink | ✅ | ✅ | — |
| Cancellation | ❌ no structured field | — | **New:** detected from title/description ("cancelled") → status `cancelled`, provenance DERIVED with basis |
| Justification / J&A / intent to sole source | partial (stage "other") | — | **New:** mapped to special notice + sole-source flag + requirement |

## SAM.gov Data Services bulk CSV (`sam_bulk`, no key)

Same notice model as the API, plus full description text. All 40+ columns (incl. both contacts, award fields, AAC/CGAC/FPDS codes, organization type) are parsed. Archived fiscal-year files are importable (filtered to profile NAICS). Gap: the extract has no attachment list.

## SAM.gov Contract Awards API (`sam_awards`, key required)

PIID, modification, referenced IDV, solicitation ID, obligations (action/total/base+options/base+exercised), dates (signed, PoP start/current/ultimate), contracting + funding org hierarchy, NAICS/PSC, pricing type, extent competed, set-aside, offers received, business size, awardee UEI/CAGE/parent. All normalized into `awards`. Gap: subcontract plans, option schedules (not in the API).

## USAspending (`usaspending`, no key)

| Raw | Normalized | Notes |
|---|---|---|
| Contract awards (A–D): ID, recipient (+UEI, parent), dates, amounts, outlays, agencies/offices, NAICS/PSC, place | ✅ | Executive-compensation names are deliberately stripped (personal data) |
| **IDVs (IDIQ/GWAC/BPA/FSS)** | **New** — scanned by *Last Date to Order* | Previously ignored: expiring vehicles were invisible to the recompete engine |
| Award detail: base/all-options, competition, pricing type, set-aside, offers, subaward count/amount, solicitation identifier | ✅ (up to N detail calls/run) | — |
| Transactions / modification history | stored inside detail payload, not normalized | Enhancement: modification timeline per contract |
| Subaward details (prime → sub) | ❌ | Enhancement: `/subawards/` endpoint for subcontracting intelligence |

## GSA Acquisition Gateway forecasts (`gsa_forecast`, no key)

All 14 listing fields are captured (title, body, agency, sub-agency, place, source listing ID, award status, contract type, award FY, value band, NAICS, acquisition strategy, PoP, created/changed). **Missing:** contacts and details (behind login.gov — not accessed by design).
**Found during audit:** the live listing returns page 2 as an exact copy of page 1 (verified repeatedly), so some forecasts are unreachable through pagination. The connector now measures unique-vs-reported totals and reports a coverage warning (source shows *degraded*) instead of a green check.
**New:** "Exercise of Option" award status is flagged — it is not a new competition and is ranked accordingly.

## DHS Acquisition Planning Forecast System (`dhs_apfs`, **new**, no key)

Public JSON (`https://apfs-cloud.dhs.gov/api/forecast/`), ~600 forecasts across CBP, ICE, TSA, USCG, FEMA, CISA, USSS, USCIS, FLETC, HQ. All 45 fields are stored; normalized: title, requirement text, component → office, NAICS, dollar range (forecast estimate), small-business program + whether set aside, contract vehicle (only ordering vehicles are treated as restrictions), contract type, competition status, award quarter/FY, **estimated solicitation release date**, anticipated award date, estimated PoP start/end, place, **requirements, alternate and small-business contacts**, and for follow-ons the **incumbent contractor + contract number** (linked exactly to award history and recompete signals). "No Longer Required" → cancelled (derived).

## SBA SUBNet (`sba_subnet`, no API — permitted public pages)

Listing + detail: prime, division, website, identifier, title, description, NAICS (+labels), place, start/closing dates, business-type preferences, POC, attachments (links only — SBA robots.txt disallows `/sites/default/files/*`).

## Grants.gov (`grants_gov`, no key; only when grants are enabled)

Search + fetchOpportunity: number/ID, agency hierarchy, dates (post/close/archive/estimates), ceiling/floor/total funding, expected awards, ALNs, funding instruments & categories, eligibility (applicant types + text), cost sharing, contacts, attachments. Gap: forecast-only fields beyond those listed; version history beyond content hashing.

## Custom feeds (`feed_*`)

RSS/Atom/JSON/CSV with field mapping; designed for state/local, transit, university and agency feeds. **New:** URLs are SSRF-checked on save and on every request/redirect.

## Derived data (not from one source)

Recompete signals, incumbent candidates, comparable-award value estimates, requirement extraction (rules: clearance, vehicles, CMMC, FedRAMP, NIST 800-171, Section 508, citizenship, experience, bonding, transition, sole source, page limits, evaluation basis…; optional AI), document classification (Section L/M, PWS/SOW/SOO, CLINs, Q&A, amendments, DD-254, wage determinations), change events, coverage signals, fit/eligibility/attractiveness/confidence/priority scores. All labeled DERIVED / ESTIMATED / AI EXTRACTED with basis.

---

## Remaining coverage gaps

| Gap | Why | Path forward |
|---|---|---|
| SAM notices beyond 10 requests/day | Personal non-federal keys are capped | Request a role / system account (1,000/day); rely on the free bulk extract for breadth (weekly reconcile by default — consider daily) |
| SAM attachments | Each download costs a SAM request | `SAM_DOWNLOAD_DOCUMENTS=true` with a higher-quota key; prioritize high-fit profiles (already ordered by fit) |
| GSA forecast contacts/details | login.gov wall | Do not automate; contact the listed agency or use APFS-style agency feeds |
| GSA listing pagination defect | Upstream bug | Measured and reported; consider reporting to GSA; agency-direct forecasts (APFS) reduce dependence |
| Other agency forecasts (VA, HHS, DOE, NASA, DoD components, Treasury…) | Mostly Excel/PDF pages or portals; formats change | Add as custom CSV/JSON feeds where an official file exists; otherwise document |
| FPDS ATOM feed | FPDS is being retired into SAM.gov | Use SAM Contract Awards API |
| Subaward data | Not yet implemented | USAspending `/subawards/` |
| SAM Entity (vendor details, size, certs) | Requires SAM key (entity API) | Add when a higher-quota key is available |
| OCR of scanned PDFs | No OCR engine bundled | Add Tesseract/cloud OCR behind the existing `ocr_needed` status |
| Q&A / amendments inside SAM | Only as attachments | Classified as QA/AMENDMENT when downloaded |
| State & local portals (eVA, Cal eProcure, BidNet, Bonfire, etc.) | Mostly authenticated or ToS-restricted | Only official public feeds via the custom feed connector |

## Sources that cannot / should not be scraped automatically

- GSA Acquisition Gateway forecast **detail pages** (login.gov).
- SAM.gov web UI (use the API/bulk extract instead; scraping violates SAM terms).
- GovWin, Bloomberg Government, HigherGov, GovSpend and other paid aggregators (paywalls/licensing).
- PIEE / eBuy / NECO / DIBBS solicitation systems (authenticated).
- SBA SUBNet attachments under `/sites/default/files/` (robots.txt).
- Any portal behind CAPTCHA, login, or explicit no-robots terms.

## Keys and accounts to obtain

| Key | Unlocks | Where |
|---|---|---|
| `SAM_API_KEY` (personal) | Live SAM notices, descriptions, attachments, Contract Awards — 10 req/day | SAM.gov → Account Details → Public API Key |
| SAM role / system account | 1,000 req/day — makes daily SAM coverage and attachment download practical | SAM.gov (entity registration + role, or system account application) |
| `ANTHROPIC_API_KEY` (optional) | AI requirement extraction, summaries | console.anthropic.com |
| Supabase/Postgres `DATABASE_URL` | Shared multi-user deployment | Supabase project |

## Recommended sync cadence

| Source | Cadence | Rationale |
|---|---|---|
| SAM Opportunities API | every 6 h (budget-aware, 3-day overlap) | Freshness for deadlines/amendments |
| SAM bulk extract | **daily** reconcile if bandwidth allows (default weekly) | Free breadth; catches everything the 10-request budget misses |
| SAM Contract Awards | daily | Award postings / incumbent facts |
| DHS APFS | daily | Small single request; forecasts update weekly-ish |
| GSA forecasts | daily incremental + weekly full reconcile | Measures coverage each reconcile |
| USAspending recompete scan | daily (weekly is enough for >6-month horizons) | Award data lags ~30 days anyway |
| SBA SUBNet | daily | Short-fuse subcontracting notices |
| Grants.gov | daily (only if grants enabled) | — |
| Derived engines | after each sync | — |

## Storage estimate

Per opportunity profile (all tables, typical): raw JSON 3–15 KB per source version, normalized + field provenance ~5–10 KB, events/snapshots ~1–3 KB per change. Rough sizing: 100k profiles with ~2 versions each ≈ 3–5 GB including indexes; extracted document text adds ~30–200 KB per parsed document (only downloaded for high-fit profiles). Binary documents are **not** stored — only metadata, hash and extracted text. The full-text GIN index is the largest index (~20–30 % of `opportunities`). Nothing is deleted on refresh; when size matters, archive `source_record_versions` older than N years to cold storage rather than deleting them.
