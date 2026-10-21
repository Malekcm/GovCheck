# Editable Word capture report standard

## Executive ordering and substance
1. Cover: buyer, requirement title, procurement identifiers, research as-of date, disclaimers.
2. One-page executive gate recommendation, facts at a glance, hard blockers, decision and owner.
3. Acquisition fingerprint: current status, solicitation trace, timeline, historical changes, vehicle/domain/NAICS/set-aside, contract type, value definitions.
4. Procurement discovery register: search surfaces, current result, proof / next action; clear primary link.
5. Customer and contacts map: agency/program office/CO/forecast POC/OSDBU/eBuy, verified coordinates and engagement limits.
6. Incumbency, predecessor, active awards, obligations vs ceiling, recompete strategy, competitors and buyer dynamics.
7. Scope and requirement families: official current PWS first; historical PWS separately marked; technical, security, staffing and reporting.
8. Company executive fit summary (up to 12 rows), then granular editable requirements-to-evidence matrix; mark STRONG/PARTIAL/GAP/UNKNOWN and source/evidence-request owner.
9. Hard gate checklist and weighted assessment (N/A allowed); G0-G5 recommendations and risks.
10. BD discovery questions: question ID, precise current answer, VERIFIED/INTERNAL/INFERRED/OPEN, source and action owner; group related questions.
11. Time-boxed research and capture plan: owner, request, deliverable, deadline and stop rules.
12. Source ledger: short title, clean clickable URL label (hyperlink target stores full source URL), date/caveat. Internal sources have explicit filename + approval status.
13. Appendix / modifications: open evidence request list, conflicts, decision/assumption register and change log if needed.

## Word table QA rules
- US Letter portrait; text width ≤ 7.0 inches at 0.75-inch margins. For unusually dense matrices, use an explicit landscape appendix or split into vertically stacked tables; never shrink to illegibility.
- Set both *table grid columns* AND *cell.width* for all rows. Set fixed table layout and exact table width; `autofit=False` alone is not sufficient.
- Repeat first/header row; avoid splitting data rows if feasible; align table left with zero indent and fixed cell padding.
- Use fonts ≥7.3pt in dense matrices; prefer 8pt, and body 9-10pt. Use concise content, not long complete prose in four columns.
- Do not set fixed row heights. Color header background dark and alternating subtle gray for scanability. Apply contrast checks.
- Use clean link labels and real external hyperlinks in source ledgers, not unbroken 100-character URL strings in cells.
- No cross-page clipped text, no table outside margins, no overlapping footer, and no orphaned header row. Avoid pages mostly empty unless purposeful.
- Every table has an intelligible header and a way to complete missing information (status + evidence requested + owner).

## Final test
Generate/edit with python-docx, render all pages to PNG, visually inspect each page, patch and repeat. Also run structural checks for all column and cell widths and that each source register URL has a hyperlink target. Deliver only the Word document and skill/supporting files, not QA page images, unless explicitly requested.
