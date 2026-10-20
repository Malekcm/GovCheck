# Team accounts and capture research

This feature branch starts at `d806718` on `feat/procurement-intelligence`, preserving the Tango integration ahead of `main`. It adds team authentication, assignments, research jobs and personal G2X OAuth. It does not enable a production cutover or deploy anything.

## Architecture review and migration risks

The inspected application uses Hono APIs, React and TanStack Query, direct PostgreSQL through `pg`, and embedded PGlite for local tests. Migrations run through GovCheck's existing sequential SQL runner, rather than the Supabase CLI migration runner. The original shared-password cookie contains no individual identity. Existing canonical resolution, source versioning, field provenance and reversible merge machinery are retained.

Migration `006_team.sql` is additive. Historical notes, decisions, capture owners, capture history, sources and events are retained. New UUID actor columns remain null for unknown historical actors. No legacy owner name is guessed or converted into a UUID. Administrators must select a verified user for structured assignments; legacy owner text remains visible. A deterministic initial organization UUID avoids seed collisions during database promotion. New public-schema tables have RLS enabled and no browser Data API policies: access is through the authorized server and its existing privileged database connection.

There is one shared procurement workspace. Organization membership is explicit, but this release does not offer independent organizations or claim full tenant isolation. Adding organizations later requires scoping the existing company and procurement tables and every shared query before exposing organization creation.

No production database credentials were available during implementation. The repository schema and an upgrade from migrations 001–005 were inspected and tested locally; actual production row counts, custom schema changes, user data and Supabase Auth configuration still require read-only staging review and a backup before cutover.

## Configure and bootstrap without locking out the pilot

1. Back up the database and verify that it can be restored. Rehearse the migration on a copy of the existing PostgreSQL database. Keep Render auto-deploy disabled.
2. Use Node 22 or later. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY`. Set an independent random `SESSION_SECRET` of at least 32 characters. Set `APP_BASE_URL` to the exact public HTTPS application origin without a trailing slash. Never put administrative keys in `VITE_*` variables.
3. In Supabase Auth, disable public signup. Configure the Site URL and allowlist the exact `${APP_BASE_URL}/auth/accept` redirect. Configure approved email delivery/SMTP and verify invitation and reset delivery. Default confirmation links are supported; no custom email template is required. Invitation/recovery fragments are immediately removed from the browser URL, exchanged once, and not saved in browser storage.
4. Configure **`GOVCHECK_BOOTSTRAP_ADMIN_EMAIL` locally with the intended first administrator's email**. No address is assumed by the code. Run `npm run bootstrap:admin` against the intended staging database. The command locks the initial organization and permits bootstrap only when no administrator exists. If Supabase already has that email or invitation delivery fails, resolve its account state before retrying; the command fails closed rather than silently claiming an existing account.
5. Remove the bootstrap variable after acceptance. The one-time invitation is associated with a server-created admin membership. Accept the email and set a password of at least 12 characters.
6. Set `GOVCHECK_TEAM_AUTH_ENABLED=true` in staging and test the administrator login, password recovery, a member, a viewer, deactivation, logout and denied mutations. Team mode requires valid configuration and HTTPS in production. Once it is enabled, `APP_PASSWORD` and old shared-password cookies cannot authorize any application route.
7. Enable team mode in production only after this cutover rehearsal passes. Until that deliberate change, legacy pilot authentication keeps working. Restrict any rollback to legacy authentication to the controlled pilot environment; do not reintroduce it as an individual-permission bypass in a team deployment.

Application sessions use a random HttpOnly SameSite cookie; only its hash is stored as the session ID. Supabase access/refresh credentials are encrypted with AES-GCM on the server. Every request verifies the provider user and reloads active membership/role from the database. Refresh rotation is serialized per session. Deactivation removes application sessions immediately, and subsequent requests fail authorization. Rotating `SESSION_SECRET` invalidates encrypted sessions and G2X credentials; users must reconnect. Keep database backups and this encryption key protected separately.

## Permissions and collaboration

| Role | Access |
| --- | --- |
| Admin | Team invitations and membership, source/company administration, all team work |
| Manager | Team assignments, opportunity/capture work, research and report review |
| Member | Read the team workspace; edit assigned opportunities, own task progress and permitted capture research |
| Viewer | Read team information; no capture, assignment or research mutations |

Authorization is enforced before existing routes, including exports and the Tango integration. Health is public; existing cron endpoints retain their separate secret checks. Client-supplied role/user/organization values never establish permission. Cross-origin browser writes are rejected. Team audit entries contain actor UUID, method, path and time, without request bodies, credentials or provider results.

Each opportunity has one active owner and multiple collaborators. Statuses are Not Started, Researching, Awaiting Review, Complete and Blocked. Next actions and due dates persist in PostgreSQL. Managers assign research by selecting an owner/collaborators and an explicit research next action; members use My Work to open the dossier and update their own status. The workload view includes capture stage and overdue work. Assignment changes use row locks, optimistic revisions and request UUIDs. Stale writes fail with a reload message; replaying the same request does not duplicate history. Progress updates retain assignment IDs, assignment dates and the original assigning user.

List filters include My opportunities, My collaborations, Unassigned, selected user and assignment due date, alongside existing agency, status, capture stage and deadline filters. The pipeline displays structured owner names, falling back to retained legacy text where no UUID owner exists.

## Identity and merge preservation

Exact notice IDs retain their global identity. Solicitation, contract and forecast identifier matching requires known compatible agencies. Vendor UEI, title similarity and NAICS do not establish a procurement identity. Parent vehicles and predecessor identifiers remain relationships rather than automatic task-order/follow-on merges. Existing duplicate suggestions, evidence/confidence review, source refresh and field conflict displays remain available. The dossier labels its source section Sources and Evidence.

Merges carry notes, assignment history, research runs and authored research signals to the survivor. Competing distinct owners become owner plus collaborator; overlapping assignments remain preserved as inactive rows with their original snapshots in the merge decision. Undo restores the original rows and their roles. If a moved assignment was edited afterward, undo refuses to overwrite that work; a manager must reconcile it first. Existing overlapping capture plans remain stored and visible under retained plans on the survivor, and undo restores their original profiles. Reports, feedback and notifications remain linked by stable research-run IDs.

## Versioned research workflow

The complete original `federal-opportunity-capture` package was located and verified locally before implementation. Its reusable instructions, full question bank, all evidence/report references, generic intake/matrix/Word templates and scripts are versioned under `research-skills/federal-opportunity-capture/1.0.0`. Company-specific profile data and the historical customer report remain in the original local package and were excluded from this public repository and runtime distribution. No missing reference was reconstructed. Runtime inputs always use GovCheck's configured company profile; no company or opportunity facts are taken from a historical example.

The runtime loads the full SKILL.md, question bank, evidence rules and Word standard. A content hash pins the workflow version on every run. All **93 question IDs** must appear exactly once, and required research sections must be present. Verified answers need registered evidence; unknown citations, missing questions, unsupported internal approval and forecast-only current-solicitation assertions fail validation.

Conduct Initial Research first previews the canonical profile, permitted government source records/documents, linked awards, identifiers, company context, assigned names, missing inputs, model, expected cost and external-data use. The user must explicitly approve the scope, estimate and external transmission. `RESEARCH_ESTIMATED_COST_USD` is administrator supplied and must be configured; it is an estimate, not a hard provider spending limit or a fabricated price. The evidence and workflow hashes are checked again when queuing.

The server executes two bounded Anthropic requests: public discovery with up to eight government-domain web searches, then structured research using the complete skill and discovery evidence. Discovery must actually execute; attempted query records come from tool events. Search hits are leads, not proof of full current-solicitation access. G2X/Tango payloads are excluded. The existing Anthropic provider/key/model configuration is reused; no external key enters the frontend. Large snapshots above 180,000 serialized characters are rejected explicitly rather than silently truncating evidence. Supporting larger dossiers requires document selection/chunking before removing this safety limit.

Runs store the initiating UUID, skill version, pinned model, evidence snapshot/hash, status, timestamps, report JSON, source/answer registers, token usage, configured cost estimate, errors and review information. Repeated clicks return the existing run for the same meaningful evidence/workflow. Identical source retrievals do not produce new fingerprints; material source or company changes permit a new run. Cancelled/failed runs are not silently regenerated. Failed runs can be explicitly retried after acknowledging possible prior charges. Cancellation aborts in-process calls and is checked by other workers within five seconds; provider usage already incurred cannot be undone.

Reports include comparison of changed answers/statuses, persistent review feedback, manager review attribution, a capability matrix, risks and next actions. Completion creates an individual in-app notification. Neither model output nor human report review changes an official source field or records a final bid decision automatically.

Editable Word export uses a server-side Node renderer adapted to the supplied Word layout standard: Letter pages, 0.75-inch margins, a 7-inch text area, fixed table/cell widths, repeating headers, non-splitting table rows, clean hyperlinks, page numbers and grouped answer blocks. The original Python helpers remain packaged. A synthetic 93-question report was rendered with LibreOffice during development to inspect layout. New real reports still require substantive human evidence review; a successful synthetic render does not validate their claims or every possible content length. No PowerPoint is generated.

## Durable execution on Render and GitHub Actions

Set `GOVCHECK_RESEARCH_ENABLED=true` only after configuring Anthropic and the expected-cost estimate. The web process polls the PostgreSQL queue every five seconds while awake. Claims use `FOR UPDATE SKIP LOCKED` and a unique claim UUID; workers can safely coexist. A running job has a 20-minute lease. Expired jobs become failed with an explicit possible-prior-usage message, rather than silently making another billed request. A user whose permission is revoked cannot start a queued run.

`npm run research:worker` processes **one already approved job** and exits. `.github/workflows/research-worker.yml` can run it every 15 minutes to handle a sleeping free Render service. The workflow is disabled until repository variable `GOVCHECK_RESEARCH_WORKER_ENABLED=true`. Configure its database/TLS and Anthropic secrets only after staging acceptance. Scheduled Actions can be delayed, so this is a pilot queue without a guaranteed latency SLA. It introduces no paid infrastructure and does not perform G2X extraction or independent opportunity ingestion. Check GitHub Actions allowances before enabling. An always-on worker is an optional future infrastructure decision, not provisioned by this branch.

## Personal G2X OAuth and restrictions

The only MCP endpoint is `https://mcp.g2x.com/mcp/research`. The server discovers authorization metadata from the documented protected-resource metadata; token endpoints are never hardcoded. Authorization code + S256 PKCE uses short-lived one-use state bound to the signed-in GovCheck user. Dynamic public-client registration is reused, or `G2X_CLIENT_ID` can identify an existing registration. The current metadata delegates registration to the MCP host while using a separate Clerk issuer; this explicit trusted-host delegation is supported. HTTPS/public URL checks, issuer checks and redirect refusal protect discovery and token requests.

Access and refresh tokens are encrypted server-side per individual account. Refresh rotation is locked, MCP initialization negotiates the protocol, and `tools/list` discovers account-specific schemas with pagination. Only tools explicitly marked read-only can run, and every call also uses the research-only endpoint. Results stay in local component memory and no response payload is placed in audit logs, research snapshots, the database or another AI provider. Clear results or leave the page to discard that view. Disconnect removes stored credentials and attempts provider revocation when advertised. Errors distinguish reconnect/401, entitlement/403, throttling/429 and unavailable/503 cases.

`G2X_INTERACTIVE_RESEARCH_ENABLED` defaults false. Automated refresh, content persistence and team sharing are separately represented as **hard-disabled capabilities** in this release. There is no scheduled G2X ingestion and no environment switch that silently permits it. Written integration authorization and a separately reviewed implementation would be needed before supporting targeted scheduled checks, licensed retention, sharing or AI-provider transfer. An exposed tool is not proof of those rights.

Official documentation reviewed on 2026-10-20:

- [G2X developers](https://g2x.com/docs/developers)
- [G2X authentication](https://g2x.com/docs/developers/authentication)
- [G2X tool schemas and annotations](https://g2x.com/docs/developers/tools)
- [G2X tool reference](https://g2x.com/mcp/tools)
- [G2X membership and integration terms](https://g2x.com/community-member-guidelines)
- [Supabase inviteUserByEmail](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail)
- [Supabase getUser](https://supabase.com/docs/reference/javascript/auth-getuser)
- [Supabase email link behavior](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Supabase changelog](https://supabase.com/changelog)
- [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)

Public G2X resource and authorization-server metadata were read without authentication. No client registration, G2X tool call, Tango API call, Supabase invitation, production database mutation or billed Anthropic request was performed during implementation.

## Acceptance before deployment

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`. Normal tests use mocked external providers and migrated PGlite. The existing CI includes a real PostgreSQL service for its PostgreSQL-specific checks. Implementation verification also ran all PostgreSQL-specific checks against a disposable native PostgreSQL 16 container. This establishes local SQL/concurrency compatibility; require CI and a hosted staging database rehearsal before promotion.

Before production, verify real invitation/reset links and SMTP, active-session deactivation, HTTPS cookies and logout, two simultaneous users editing assignments, production row counts/history, source refresh and merge/undo, a bounded approved Anthropic run and its citations/cost, Word output with that real report, and G2X login/entitlements under an authorized individual's account. G2X can remain off while team accounts and assignments are accepted. Five inherited moderate npm audit findings remain in the mammoth/exceljs dependency trees; compatible available fixes removed the critical findings. Do not apply the suggested breaking downgrades without a separate compatibility review.
