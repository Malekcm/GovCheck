import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { focusReason, type BulkFocus } from '../src/server/connectors/sam/samBulk';
import { samOpportunitiesAdapter } from '../src/server/connectors/sam/samOpportunities';
import type { Db } from '../src/server/db';
import { budgetFor, BudgetExhaustedError, DbRequestBudget, samBudgetStatus } from '../src/server/pipeline/budget';
import { planSamPriorityWork, runSamPriorityChecks } from '../src/server/pipeline/samPriority';
import { buildSearchTerms, discoveryTerms, matchedTerms, termMatcher } from '../src/server/pipeline/searchTerms';
import { refreshOpportunity, runConnector } from '../src/server/pipeline/sync';
import { planLiveSearch, TargetedFilters } from '../src/server/pipeline/targetedSearch';
import { loadCompanyContext } from '../src/server/scoring/profile';
import { createTestDb, fixtureJson, FixtureHttp, ingestWith, samRecord, setupCompany, testDeps } from './helpers/setup';

const SAM_SEARCH = /api\.sam\.gov\/opportunities\/v2\/search/;
const item = () => fixtureJson('sam_opportunity_sources_sought.json');

describe('SAM request budget', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('never exceeds the daily limit, even with concurrent callers, and journals every request by category', async () => {
    const budget = new DbRequestBudget(db, { sam: 3 }, { sam: 1 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => budget.consume('sam', 1, { category: i % 2 ? 'tracked' : 'discovery' })));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(3);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof BudgetExhaustedError)).toBe(true);
    expect(await budget.used('sam')).toBe(3);
    expect(await budget.remaining('sam')).toBe(0);
    expect(await budget.backgroundRemaining('sam')).toBe(0);
    const cats = await budget.usageByCategory('sam');
    expect(cats.reduce((s, c) => s + c.requests, 0)).toBe(3);
  });

  it('reports limit, used, remaining, reserve, categories and reset time', async () => {
    const config = (await testDeps(db, undefined, { samDailyRequestLimit: 10, samManualReserve: 2 })).config;
    const budget = budgetFor(db, config);
    await budget.consume('sam', 1, { category: 'tracked' });
    await budget.consume('sam', 2, { category: 'targeted_search' });
    // A request counted by an older build (no journal row) is shown as unattributed, not hidden.
    await db.query(`UPDATE api_usage SET requests = requests + 1 WHERE connector_id = 'sam'`);
    const s = await samBudgetStatus(db, config);
    expect(s).toMatchObject({ limit: 10, used: 4, remaining: 6, reserve: 2, backgroundAvailable: 4 });
    expect(Object.fromEntries(s.byCategory.map((c) => [c.category, c.requests]))).toEqual({ tracked: 1, targeted_search: 2, unattributed: 1 });
    expect(new Date(s.resetsAt).getUTCHours()).toBe(0);
  });
});

describe('SAM priority model', () => {
  let db: Db;
  let ids: { tracked: string; strong: string; weak: string };
  beforeEach(async () => {
    db = await createTestDb();
    await setupCompany(db);
    const base = item();
    await ingestWith(db, samOpportunitiesAdapter, [
      samRecord(base),
      samRecord({ ...base, noticeId: 'strong-0001', solicitationNumber: 'STRONG-SOL-0001', title: 'Data analytics platform modernization' }),
      samRecord({ ...base, noticeId: 'weak-0001', solicitationNumber: 'WEAK-SOL-0001', title: 'Janitorial services' }),
    ]);
    const opp = async (sol: string) => (await db.one<{ id: string }>('SELECT id FROM opportunities WHERE solicitation_number = $1', [sol]))!.id;
    ids = { tracked: await opp(base.solicitationNumber), strong: await opp('STRONG-SOL-0001'), weak: await opp('WEAK-SOL-0001') };
    await db.query(`UPDATE opportunities SET status = 'active', response_deadline = now() + interval '60 days', fit_score = 85 WHERE id = $1`, [ids.strong]);
    await db.query(`UPDATE opportunities SET status = 'active', response_deadline = now() + interval '60 days', fit_score = 20 WHERE id = $1`, [ids.weak]);
    await db.query(`UPDATE opportunities SET status = 'active', response_deadline = now() + interval '60 days', fit_score = 30 WHERE id = $1`, [ids.tracked]);
    await db.query(`INSERT INTO user_opportunity_decisions (opportunity_id, decision) VALUES ($1, 'watch')`, [ids.tracked]);
    // All SAM data is 10 days old.
    await db.query(`UPDATE source_records SET retrieved_at = now() - interval '10 days', last_seen_at = now() - interval '10 days'`);
  });

  const http = () =>
    new FixtureHttp([
      [/noticedesc/, () => 'Amended description: the government now also requires Tableau dashboards.'],
      [SAM_SEARCH, (req) => {
        const u = new URL(req.url);
        const sol = u.searchParams.get('solnum');
        const base = item();
        if (sol === base.solicitationNumber) return { totalRecords: 1, opportunitiesData: [{ ...base, responseDeadLine: '2026-12-01T17:00:00-04:00', title: `${base.title} (Amendment 1)` }] };
        if (sol === 'STRONG-SOL-0001') return { totalRecords: 1, opportunitiesData: [{ ...base, noticeId: 'strong-0001', solicitationNumber: 'STRONG-SOL-0001', title: 'Data analytics platform modernization' }] };
        return { totalRecords: 0, opportunitiesData: [] };
      }],
    ]);

  it('plans tracked opportunities first, then strong stale matches; weak matches are never spent on', async () => {
    const deps = await testDeps(db, undefined, { samApiKey: 'k', samPriorityMinFit: 60 });
    const tiers = await planSamPriorityWork(db, deps.config);
    expect(tiers[0].map((c) => c.opportunityId)).toEqual([ids.tracked]);
    expect(tiers.flat().map((c) => c.opportunityId)).toContain(ids.strong);
    expect(tiers.flat().map((c) => c.opportunityId)).not.toContain(ids.weak);
  });

  it('spends only the background allowance (limit − reserve), tracked first, through normal ingestion', async () => {
    const h = http();
    const deps = await testDeps(db, h, { samApiKey: 'k', samDailyRequestLimit: 4, samManualReserve: 2, samPriorityMinFit: 60 });
    deps.budget = budgetFor(db, deps.config);
    const r = await runSamPriorityChecks(deps, { triggeredBy: 'test' });
    expect(r.requests).toBe(2); // 4 − 2 reserved
    expect(r.byCategory).toEqual({ tracked: 2 }); // search + changed description for the watched notice
    expect(r.changedRecords).toBe(1);
    const usage = await db.query<any>(`SELECT category, sum(requests)::int AS n FROM api_request_log GROUP BY 1`);
    expect(usage).toEqual([{ category: 'tracked', n: 2 }]);
    // Change history recorded through the normal pipeline (versions + events), no duplicates.
    const versions = await db.one<any>(`SELECT count(*)::int AS n FROM source_record_versions v JOIN source_records s ON s.id = v.source_record_id WHERE s.source_record_id = $1`, [item().noticeId]);
    expect(versions.n).toBe(2);
    const events = await db.query<any>(`SELECT event_type FROM opportunity_events WHERE opportunity_id = $1 AND event_type IN ('DEADLINE_CHANGED','AMENDMENT')`, [ids.tracked]);
    expect(events.map((e) => e.event_type).sort()).toEqual(['AMENDMENT', 'DEADLINE_CHANGED']);
    expect((await db.one<any>(`SELECT sam_live_checked_at FROM opportunities WHERE id = $1`, [ids.tracked])).sam_live_checked_at).not.toBeNull();

    // Background discovery now has nothing left: it makes no request.
    const before = h.calls.length;
    const disc = await runConnector(deps, 'sam_opportunities', { mode: 'incremental', triggeredBy: 'test' });
    expect(h.calls.length).toBe(before);
    expect(disc.message).toMatch(/budget reached/);
    expect(await deps.budget.remaining('sam')).toBe(2);

    // A manual refresh may use the reserve.
    const refreshed = await refreshOpportunity(deps, ids.strong);
    expect(refreshed.steps.find((s) => s.step === 'sam_opportunities')?.status).toBe('success');
    const manual = await db.one<any>(`SELECT sum(requests)::int AS n FROM api_request_log WHERE category = 'manual_refresh'`);
    expect(manual.n).toBeGreaterThan(0);
    expect(await deps.budget.remaining('sam')).toBeGreaterThanOrEqual(0);
    expect((await db.one<any>(`SELECT requests FROM api_usage WHERE connector_id = 'sam'`)).requests).toBeLessThanOrEqual(4);
  });

  it('does not re-check the same opportunity on the next run', async () => {
    const deps = await testDeps(db, http(), { samApiKey: 'k', samDailyRequestLimit: 100, samManualReserve: 2, samPriorityMinFit: 60 });
    deps.budget = budgetFor(db, deps.config);
    const first = await runSamPriorityChecks(deps, { triggeredBy: 'test' });
    expect(first.checked).toBeGreaterThanOrEqual(2);
    const second = await runSamPriorityChecks(deps, { triggeredBy: 'test' });
    expect(second.checked).toBe(0);
  });

  it('user decisions, notes and capture data survive source refreshes', async () => {
    await db.query(`INSERT INTO user_notes (opportunity_id, body) VALUES ($1, 'Teaming with ACME')`, [ids.tracked]);
    await db.query(`INSERT INTO opportunity_capture (opportunity_id, pursuit_stage, owner) VALUES ($1, 'capture', 'Jordan')`, [ids.tracked]);
    await db.query(`INSERT INTO user_tags (opportunity_id, tag) VALUES ($1, 'hot')`, [ids.tracked]);
    const deps = await testDeps(db, http(), { samApiKey: 'k', samDailyRequestLimit: 100, samPriorityMinFit: 60 });
    deps.budget = budgetFor(db, deps.config);
    await runSamPriorityChecks(deps, { triggeredBy: 'test' });
    await refreshOpportunity(deps, ids.tracked);
    expect((await db.one<any>('SELECT decision FROM user_opportunity_decisions WHERE opportunity_id = $1 AND is_current', [ids.tracked])).decision).toBe('watch');
    expect((await db.one<any>('SELECT body FROM user_notes WHERE opportunity_id = $1', [ids.tracked])).body).toBe('Teaming with ACME');
    expect((await db.one<any>('SELECT owner, pursuit_stage FROM opportunity_capture WHERE opportunity_id = $1', [ids.tracked])).owner).toBe('Jordan');
    expect((await db.one<any>('SELECT tag FROM user_tags WHERE opportunity_id = $1', [ids.tracked])).tag).toBe('hot');
  });

  it('shows the budget and the plan without spending anything', async () => {
    const h = http();
    const app = createApp(await testDeps(db, h, { samApiKey: 'k', samPriorityMinFit: 60 }));
    const b: any = await (await app.request('/api/sam/budget')).json();
    expect(b.status.limit).toBe(10);
    expect(b.plan.tiers[0].category).toBe('tracked');
    expect(h.calls).toEqual([]);
  });
});

describe('targeted search', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await setupCompany(db);
  });

  const filters = (over: Partial<TargetedFilters> = {}) => TargetedFilters.parse({ naics: ['541511', '541512'], ...over });

  it('plans one request per NAICS, applies multi-value filters locally, and refuses over-broad or over-budget plans', () => {
    const p = planLiveSearch(filters({ noticeTypes: ['r', 'o'], states: ['VA'], titlePhrase: 'dashboard', keywords: ['power bi'] }), 3, new Date('2026-10-01T00:00:00Z'));
    expect(p.estimatedRequests).toBe(2);
    expect(p.calls.map((c) => c.ncode)).toEqual(['541511', '541512']);
    expect(p.calls[0]).toMatchObject({ title: 'dashboard', state: 'VA', postedFrom: '07/03/2026', postedTo: '10/01/2026', limit: 1000 });
    expect(p.calls[0]).not.toHaveProperty('ptype'); // two types → filtered locally
    expect(p.localFilters.join(' ')).toMatch(/Notice types/);
    expect(p.blocked).toBeNull();
    expect(planLiveSearch(filters({ naics: ['541511', '541512', '541513', '541519'] }), 3).blocked).toMatch(/needs 4 SAM requests/);
    expect(planLiveSearch(TargetedFilters.parse({}), 3).blocked).toMatch(/at least one SAM filter/);
    const wide = planLiveSearch(filters({ postedFrom: '2024-01-01', postedTo: '2026-01-01' }), 3);
    expect(wide.warnings.join(' ')).toMatch(/one year/);
  });

  it('searching and previewing never contacts SAM or spends budget — only an explicit confirmed live search does', async () => {
    const h = new FixtureHttp([[SAM_SEARCH, () => ({ totalRecords: 0, opportunitiesData: [] })]]);
    const deps = await testDeps(db, h, { samApiKey: 'k' });
    deps.budget = budgetFor(db, deps.config);
    const app = createApp(deps);
    const post = (url: string, body: unknown) => app.request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    // A user typing / changing filters: many previews.
    for (const f of [{ naics: ['5415'] }, { naics: ['541511'], titlePhrase: 'dash' }, { naics: ['541511'], titlePhrase: 'dashboard', states: ['VA', 'MD'] }, { keywords: ['analytics'] }]) {
      const res = await post('/api/targeted-search/preview', { filters: f });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.live.plan).toHaveProperty('estimatedRequests');
      expect(body.live.budget.remaining).toBe(10);
    }
    expect((await post('/api/targeted-search/live', { filters: { naics: ['541511'] } })).status).toBe(400); // not confirmed
    expect(h.calls).toEqual([]);
    expect(await db.one('SELECT * FROM api_usage')).toBeNull();
  });

  it('a confirmed live search de-duplicates by notice ID and ingests results with provenance and versions', async () => {
    const base = item();
    const a = { ...base, noticeId: 'live-a', solicitationNumber: 'LIVE-A-0001', title: 'Power BI dashboard support' };
    const b = { ...base, noticeId: 'live-b', solicitationNumber: 'LIVE-B-0001', title: 'Enterprise analytics support', naicsCode: '541512' };
    const h = new FixtureHttp([[SAM_SEARCH, (req) => (new URL(req.url).searchParams.get('ncode') === '541511' ? { totalRecords: 2, opportunitiesData: [a, b] } : { totalRecords: 1, opportunitiesData: [b] })]]);
    const deps = await testDeps(db, h, { samApiKey: 'k' });
    deps.budget = budgetFor(db, deps.config);
    const app = createApp(deps);
    const res = await app.request('/api/targeted-search/live', { method: 'POST', body: JSON.stringify({ filters: { naics: ['541511', '541512'] }, confirm: true }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(200);
    const r: any = await res.json();
    expect(r.requestsUsed).toBe(2);
    expect(r.kept).toBe(2);
    expect(r.newRecords).toBe(2);
    expect(r.opportunities.length).toBe(2);
    // The journal records the filters sent, never the API key.
    const journal = JSON.stringify(await db.query('SELECT detail FROM api_request_log'));
    expect(journal).toContain('541512');
    expect(journal).not.toContain('api_key');
    const stored = await db.query<any>(`SELECT source_record_id FROM source_records WHERE connector_id = 'sam_opportunities' ORDER BY 1`);
    expect(stored.map((s) => s.source_record_id)).toEqual(['live-a', 'live-b']);
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM source_record_versions`)).n).toBe(2);
    expect((await db.one<any>(`SELECT sum(requests)::int AS n FROM api_request_log WHERE category = 'targeted_search'`)).n).toBe(2);
    const hist = (await (await app.request('/api/targeted-search/history')).json()) as any[];
    expect(hist[0]).toMatchObject({ requests_used: 2, results_kept: 2, status: 'success' });
    // The local search now finds them without any request.
    const before = h.calls.length;
    const local: any = await (await app.request('/api/targeted-search/preview', { method: 'POST', body: JSON.stringify({ filters: { naics: ['541512'] } }), headers: { 'Content-Type': 'application/json' } })).json();
    expect(local.local.results.map((o: any) => o.solicitation_number)).toContain('LIVE-B-0001');
    expect(h.calls.length).toBe(before);
  });

  it('refuses a live search the remaining budget cannot cover', async () => {
    const h = new FixtureHttp([[SAM_SEARCH, () => ({ totalRecords: 0, opportunitiesData: [] })]]);
    const deps = await testDeps(db, h, { samApiKey: 'k', samDailyRequestLimit: 3 });
    deps.budget = budgetFor(db, deps.config);
    await deps.budget.consume('sam', 2, { category: 'tracked' });
    const app = createApp(deps);
    const res = await app.request('/api/targeted-search/live', { method: 'POST', body: JSON.stringify({ filters: { naics: ['541511', '541512'] }, confirm: true }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(429);
    expect(h.calls).toEqual([]);
  });
});

describe('capability-based discovery and focused bulk ingestion', () => {
  it('derives normalized discovery terms from capabilities and drops generic words', async () => {
    const terms = buildSearchTerms({
      capabilities: [{ id: '1', slug: 'x', name: 'Power BI', category: 'c', keywords: ['Power BI', 'DAX', 'support', 'dashboards'], strength: 5, years: null, technologies: ['Tableau'] }],
      keywords: ['  Data Governance ', 'management'],
    });
    const byTerm = Object.fromEntries(terms.map((t) => [t.term, t]));
    expect(byTerm['power bi'].sources).toEqual(['Power BI']);
    expect(byTerm.dax).toBeDefined(); // acronym kept
    expect(byTerm.support.generic).toBe(true);
    expect(byTerm.management.generic).toBe(true);
    expect(byTerm['data governance'].generic).toBe(false);
    const m = termMatcher(discoveryTerms({ capabilities: [], keywords: ['power bi', 'tableau'] }));
    expect(matchedTerms(m, 'Support for Power  BI and TABLEAU dashboards; powerbiz no')).toEqual(['power bi', 'tableau']);
  });

  const focus = (over: Partial<BulkFocus> = {}): BulkFocus => ({
    naicsPrefixes: ['541511', '5415'],
    naicsSectors: ['54'],
    psc: ['D3'],
    terms: termMatcher(['power bi', 'data analytics', 'dashboard']),
    negative: termMatcher(['construction']),
    knownNoticeIds: new Set(['KNOWN-1']),
    knownSolicitations: new Set(['W912DY24R0001']),
    preferredAgencies: ['veterans affairs'],
    minDescriptionHits: 2,
    ...over,
  });

  it('keeps relevant or already-tracked notices and drops the rest', () => {
    const f = focus();
    expect(focusReason({ NoticeId: 'known-1', NaicsCode: '236220', Title: 'Building' }, f)).toBe('tracked');
    expect(focusReason({ NoticeId: 'x', 'Sol#': 'W912DY-24-R-0001', NaicsCode: '236220', Title: 'Amendment' }, f)).toBe('tracked_solicitation');
    expect(focusReason({ NoticeId: 'x', NaicsCode: '541519', Title: 'Other IT' }, f)).toBe('naics');
    expect(focusReason({ NoticeId: 'x', NaicsCode: '999999', ClassificationCode: 'D302', Title: 'IT' }, f)).toBe('psc');
    // Unexpected NAICS but a very strong capability match still surfaces.
    expect(focusReason({ NoticeId: 'x', NaicsCode: '611430', Title: 'Power BI dashboard training' }, f)).toBe('title_keyword');
    expect(focusReason({ NoticeId: 'x', NaicsCode: '611430', Title: 'Training', Description: '<p>Data analytics and dashboard work.</p>' }, f)).toBe('description_keywords');
    expect(focusReason({ NoticeId: 'x', NaicsCode: '611430', Title: 'Training', Description: 'One dashboard only.' }, f)).toBeNull();
    expect(focusReason({ NoticeId: 'x', NaicsCode: '236220', Title: 'Construction of a dashboard kiosk' }, f)).toBeNull(); // negative keyword
    expect(focusReason({ NoticeId: 'x', NaicsCode: '541990', Title: 'Consulting', 'Department/Ind.Agency': 'VETERANS AFFAIRS, DEPARTMENT OF' }, f)).toBe('preferred_agency');
    expect(focusReason({ NoticeId: 'x', NaicsCode: '236220', Title: 'Roof repair' }, f)).toBeNull();
  });

  it('focused reconciliation stores only relevant rows, keeps tracking existing notices after a profile change, and full mode keeps everything', async () => {
    const db = await createTestDb();
    await setupCompany(db, { naics: ['541511'] });
    const header = '"NoticeId","Title","Sol#","Department/Ind.Agency","PostedDate","Type","NaicsCode","ClassificationCode","Active","ResponseDeadLine","Description"';
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const csv = (rows: string[][]) => [header, ...rows.map((r) => r.map((c) => `"${c}"`).join(','))].join('\n');
    const rows = [
      ['n-relevant', 'Software development', 'SOL-1', 'GSA', recent, 'Solicitation', '541511', 'D399', 'Yes', '', ''],
      ['n-keyword', 'Power BI dashboards for HR', 'SOL-2', 'OPM', recent, 'Solicitation', '611430', '', 'Yes', '', ''],
      ['n-irrelevant', 'Roof repair', 'SOL-3', 'ARMY', recent, 'Solicitation', '236220', 'Z1AA', 'Yes', '', ''],
    ];
    const http = new FixtureHttp([[/ContractOpportunitiesFullCSV/, () => Readable.toWeb(Readable.from([Buffer.from(csv(rows), 'latin1')]))]]);
    const deps = await testDeps(db, http);
    const r1 = await runConnector(deps, 'sam_bulk', { mode: 'reconcile', triggeredBy: 'test' });
    expect(r1.status).toBe('success');
    const stored = async () => (await db.query<any>(`SELECT source_record_id FROM source_records WHERE connector_id = 'sam_bulk' ORDER BY 1`)).map((x) => x.source_record_id);
    expect(await stored()).toEqual(['n-keyword', 'n-relevant']);
    expect(r1.message).toMatch(/naics 1/);

    // The company drops that NAICS: the notice already tracked keeps being reconciled.
    await db.query('DELETE FROM company_naics');
    rows[0][1] = 'Software development (amended)';
    const r2 = await runConnector(deps, 'sam_bulk', { mode: 'reconcile', triggeredBy: 'test' });
    expect(r2.stats.updated).toBe(1);
    expect((await db.one<any>(`SELECT title FROM opportunities WHERE solicitation_number = 'SOL-1'`)).title).toMatch(/amended/);

    const full = await testDeps(db, http, { samBulkIngestMode: 'full' });
    await runConnector(full, 'sam_bulk', { mode: 'reconcile', triggeredBy: 'test' });
    expect(await stored()).toEqual(['n-irrelevant', 'n-keyword', 'n-relevant']);
  });

  it('capability keyword edits are inspectable through the discovery terms endpoint', async () => {
    const db = await createTestDb();
    await setupCompany(db, { caps: ['power-bi'] });
    const app = createApp(await testDeps(db));
    const cap = await db.one<{ id: string }>(`SELECT id FROM capabilities WHERE slug = 'power-bi'`);
    await app.request(`/api/capabilities/${cap!.id}`, { method: 'PUT', body: JSON.stringify({ keywords: ['Power BI', 'Fabric semantic models'] }), headers: { 'Content-Type': 'application/json' } });
    const t: any = await (await app.request('/api/discovery/terms')).json();
    expect(t.terms.map((x: any) => x.term)).toContain('fabric semantic models');
    expect(t.bulk.mode).toBe('focused');
    const co = await loadCompanyContext(db);
    expect(co.capabilities[0].keywords).toContain('Fabric semantic models');
  });
});

describe('change tracking', () => {
  it('records notice type, reopen and award changes once — re-ingesting the same change adds nothing', async () => {
    const db = await createTestDb();
    const base = { ...item(), active: 'Yes', responseDeadLine: '2027-01-01T17:00:00-04:00', archiveDate: '2027-06-01' };
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(base)]);
    const id = (await db.one<{ id: string }>('SELECT id FROM opportunities'))!.id;
    const types = async () => (await db.query<any>(`SELECT event_type FROM opportunity_events WHERE opportunity_id = $1 AND event_type NOT IN ('LIFECYCLE','NEW_OPPORTUNITY') ORDER BY detected_at, event_type`, [id])).map((e) => e.event_type);

    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...base, type: 'Special Notice', baseType: 'Special Notice' })]);
    expect(await types()).toContain('NOTICE_TYPE_CHANGED');
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...base, type: 'Special Notice', baseType: 'Special Notice', active: 'No' })]);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...base, type: 'Special Notice', baseType: 'Special Notice', active: 'Yes' })]);
    expect(await types()).toContain('REOPENED');
    const count = (await types()).length;
    // Same content again: no new version, no duplicate events.
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...base, type: 'Special Notice', baseType: 'Special Notice', active: 'Yes' })]);
    expect((await types()).length).toBe(count);

    const app = createApp(await testDeps(db));
    await db.query(`INSERT INTO user_opportunity_decisions (opportunity_id, decision, decided_at) VALUES ($1, 'pursue', now() - interval '1 hour')`, [id]);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...base, type: 'Special Notice', baseType: 'Special Notice', active: 'Yes', responseDeadLine: '2027-02-01T17:00:00-04:00' })]);
    const since: any = await (await app.request(`/api/opportunities/${id}/changes?since=decision`)).json();
    expect(since.basis).toMatch(/pursue/);
    expect(since.events.map((e: any) => e.event_type)).toContain('DEADLINE_CHANGED');
    const tracked: any = await (await app.request(`/api/changes?days=1&scope=tracked&meaningful=true`)).json();
    expect(tracked.events.every((e: any) => e.opportunity_id === id)).toBe(true);
    expect(tracked.summary.opportunities).toBe(1);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect((await app.request(`/api/changes?since=${encodeURIComponent(yesterday)}`)).status).toBe(200);
  });
});
