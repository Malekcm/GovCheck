---
name: federal-opportunity-capture
description: Evidence-backed federal contract opportunity intelligence, capture qualification, incumbent research, company fit mapping, and editable Word bid/no-bid research reports. Use for SAM.gov, DHS APFS, GSA eBuy, agency forecasts, RFIs, RFQs, RFPs, contract notices, recompetes, and federal market leads.
---

# Federal opportunity capture research

## Purpose
Turn one or more public opportunity URLs, IDs, PDFs, PWS/SOW files, or user descriptions into an executive-ready, **editable Word capture research report**, with a documented answer to each material BD question, traceable source, Savan (or other selected firm) alignment, and an evidence-request queue. Do **not** create a PowerPoint by default. Deck production is a separate skill and requires an explicit user request.

## Trigger and input
Use this skill when the user provides a federal opportunity or asks for a capture review, recompete research, competitive analysis, feasibility, qualification, win theme, or bid/no-bid briefing.

Accept partial input. At minimum, start with an opportunity URL/title/agency or solicitation ID. If provided, load an approved corporate profile and previous validated past-performance evidence. The `templates/opportunity_intake.yaml` and `templates/company_profile_savan.yaml` show useful optional inputs. Do not delay public research while waiting for nonessential internal information; instead generate clear OPEN rows with recommended documents and owners.

## Required output
1. An editable `.docx` report generated using the Word template/layout rules in `references/word_report_standard.md`.
2. An answer register with status, source, checked-on date, missing evidence and owner. Include this in the Word appendix and optionally as CSV if requested.
3. A capability and past-performance matrix mapped **task by task**, separating credible evidence from claimed strength or missing capability.
4. A **conditional** qualification decision based on mandatory eligibility gates and documented facts, not a fabricated probability of winning.
5. A full source register containing exact official URLs and dated source notes. Hyperlink clean labels in Word rather than pasting long unbreakable URLs into narrow cells.

## Non-negotiable verification rules
- **VERIFY CURRENT SOLICITATION**: Forecasts, industry articles, SAM award notices, limited-sources justifications, and predecessor RFQs do NOT establish that the present RFP is open. Seek an official current solicitation number, issuance date, response date, complete amendments, and the posting location. If the vehicle uses a gated portal such as GSA eBuy, mark PUBLIC STATUS UNVERIFIED and assign an authorized account holder to inspect it. Do not claim it was not issued anywhere.
- **TREAT OLD PWS AS HISTORICAL**: Label predecessor requirements with their year and contract number. Mark all assumptions about current deliverables, personnel, clearance or pricing as unconfirmed until a current solicitation is available.
- **RECONCILE VEHICLE MATCH**: Verify exact prime legal entity/UEI, contract number, schedule family (SB vs UR), awarded domain/CLIN, ordering lane, active status, NAICS, size and small business affiliation. Holding one OASIS+ contract does not guarantee eligibility for a task order in another domain.
- **DO NOT CONFUSE CONTRACT FINANCIAL FIELDS**: Forecast band, ceiling, base/option value, awarded amount, obligations, spend-to-date and anticipated funded run-rate are separate and separately labeled.
- **EVIDENCE STATUS**: VERIFIED_PRIMARY, VERIFIED_SECONDARY, INTERNAL_APPROVED, INTERNAL_UNVALIDATED, INFERRED, OPEN, CONFLICTING, STALE. Assertions from the user are valid internal assessment inputs but not independent third-party verification.
- **CLEAR PROVENANCE**: For each material claim provide source link or exact provided file section, retrieval date and caveat. Use primary government notices and signed amendments over aggregator data. If public source cannot be retrieved, do not invent details or citations.
- **CONTACTS**: Identify procurement contacts, the program office, small business specialist, contracting officer, contracting specialist, COR if known, and approved vendor engagement path. Do not conflate forecast POC with the actual CO or COR. Note rules/limitations on procurement communications.
- **COMPETITION**: Research incumbent, predecessor prime/subs, parent BPA/IDIQ, past orders, related recompete awards, reported obligations, competition level and apparent eligibility. Make no unsupported competitor performance allegations, proprietary claims, or purported win probabilities.
- **LEGAL**: Flag, do not purport to decide, complex SBA affiliation/size, limitations on subcontracting, FAR ordering eligibility, OCI, clearance, facility and subcontract flow-down issues; assign counsel/contracts for validation.
- **HUMAN APPROVAL**: Never call a proposal bid-ready without current solicitation and a human-authorized go/no-go decision. Never auto-submit outreach or proposals.

## Operating sequence
### Phase 1. Create the acquisition fingerprint
Gather title, agency/subagency, office, forecast and opportunity IDs, notice classification, NAICS/PSC, set-aside, known vehicle, domain/CLIN, acquisition strategy, pricing type, geography, value definitions, period, anticipated and actual dates, and sources. Record every forecast change with dates and provenance. Build opportunity entity resolution across differently named notices and IDs. Flag uncertainty instead of merging similar titles as one award.

### Phase 2. Trace the solicitation
Search official agency forecast, SAM.gov opportunities, GSA eBuy guidance, agency acquisition / OSDBU pages, USAspending and FPDS/SAM award references, and any applicable government portal. Then use specialized market sites as lead generation, not as substitutes for primary records. Search exact IDs, predecessor contract number, titles and synonyms, agency office, key NAICS and named incumbents. Distinguish negative **public search** results from proof of non-public absence. Deliver a query log and the exact next action to obtain gated files.

### Phase 3. Understand customer demand and incumbent
Read the current PWS/SOW and evaluation factors if available. Otherwise read the historical PWS as dated evidence, clearly separate it, and develop workstream hypotheses. Identify mission changes, drivers, incumbent workstreams, major orders, value/obligation distinction, contract period and past competition. List plausible displacement barriers and what it would take to overcome them.

### Phase 4. Map company strengths, gaps and teaming
Load the company-specific profile. For each proposed or required workstream list current fit (STRONG, PARTIAL, GAP/PARTNER, UNKNOWN), supporting case study ID, exact prime/sub role, customer, period, value, outcomes, named SME/certifications and evidence approval status. Respect user-provided assessments (e.g., Savan data/architecture STRONG), but separately ask for approved proof, CVs and artifacts. Do not downgrade a user-confirmed core strength merely because public contract artifacts are unavailable. Do not upgrade unknown work into a verified reference.

### Phase 5. Assess mandatory hard gates and decision factors
Validate access to actual solicitation; legal prime/vehicle domain and entity; size/set-aside; security and OCI; key personnel / hiring / compliant teaming; delivery geography; price and financial capacity; subcontract limitations. Hard gates are **not** offset by a high weighted score. Use the optional weighted rubric only for comparative internal diligence; missing ratings remain N/A. Recommend G0 (screen), G1 (qualify), G2 (pursue), G3 (bid/no bid), G4 (submit readiness), or G5 (closeout / lessons) conditionally.

### Phase 6. Produce research Word package
Use the order in `references/word_report_standard.md` and the question bank in `references/bd_question_bank.md`; include all critical questions, answered or open with next evidence request. Tables must fit page width. Do not let columns or borders exceed text margins. Use repeated table header rows, no split of ordinary data rows where feasible, short labels, meaningful page breaks and human-readable hyperlinks. Do NOT default to PowerPoint.

### Phase 7. QA and handoff
Render the DOCX using `/home/oai/skills/docx/render_docx.py` if available, inspect every rendered page, fix overflow, merged headers, clipped cells, giant source links, abandoned headings or empty tables and render again. Verify the full source ledger and that counts and statuses reconcile. Provide the file plus 3-5 highest-priority missing inputs the user can supply. Tag final research date and a precise unverified/gated access statement.

## Reference files
- `references/bd_question_bank.md`: exhaustive BD research questions and response standards
- `references/evidence_and_sources.md`: source hierarchy, provenance, and claim hygiene
- `references/word_report_standard.md`: report sections and table-layout acceptance test
- `templates/opportunity_intake.yaml`: optional lead intake example
- `templates/company_profile_savan.yaml`: starting internal Savan profile, **not pre-approved proof**
- `templates/Capability_Matrix.csv`: editable input fields for an evidence crosswalk
- `scripts/docx_table_layout.py`: reusable python-docx fixed-width/repeated-header table helper
- `examples/USCG_DCS_Capture_Research_Rev2.docx`: sample output for a specific lead; never reuse old fact values without refreshing
