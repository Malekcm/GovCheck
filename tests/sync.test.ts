import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { Db } from '../src/server/db';
import { firstPageEndingAfter } from '../src/server/connectors/usaspending';
import { runAllSources } from '../src/server/pipeline/sync';
import { createTestDb, fixture, fixtureJson, FixtureHttp, setupCompany, testDeps } from './helpers/setup';

describe('sync orchestration', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await setupCompany(db);
    await db.query(`UPDATE company_profiles SET include_grants = true`);
  });

  it('isolates a failing connector: other sources still sync and derived engines still run', async () => {
    const grant = fixtureJson('grants_fetch.json');
    const forecast = fixtureJson('gsa_forecast_page.json');
    let subnetPage = 0;
    const http = new FixtureHttp([
      [/robots\.txt$/, () => 'User-agent: *\nDisallow: /sites/default/files/*\n'],
      [/api\.grants\.gov\/v1\/api\/search2/, (req) => (JSON.parse(req.body!).startRecordNum > 0 ? { errorcode: 0, data: { hitCount: 1, oppHits: [] } } : { errorcode: 0, data: { hitCount: 1, oppHits: [{ id: String(grant.data.id), number: grant.data.opportunityNumber, title: grant.data.opportunityTitle, oppStatus: 'posted' }] } })],
      [/api\.grants\.gov\/v1\/api\/fetchOpportunity/, () => grant],
      [/ag-dashboard\.acquisitiongateway\.gov/, (req) => (/page=0/.test(req.url) ? forecast : { listing: { data: [], total: 5 } })],
      [/legacy\.sba\.gov\/federal-contracting/, () => (subnetPage++ === 0 ? fixture('subnet_listing.html') : '<html><table class="usa-table"><tbody></tbody></table></html>')],
      [/legacy\.sba\.gov\/opportunity\//, () => fixture('subnet_detail.html')],
      [/api\.usaspending\.gov/, () => {
        throw new Error('HTTP 503 from https://api.usaspending.gov: Service Unavailable');
      }],
    ]);
    const deps = await testDeps(db, http);
    const results = await runAllSources(deps, { triggeredBy: 'test' });
    const byId = Object.fromEntries(results.map((r) => [r.connectorId, r]));
    expect(byId.usaspending.status).toBe('failed');
    expect(byId.grants_gov.status).toBe('success');
    expect(byId.gsa_forecast.status).toBe('success');
    expect(byId.sba_subnet.status).toBe('success');
    expect(byId.sam_opportunities.status).toBe('skipped'); // no key → Not Configured, not an error
    const health = Object.fromEntries((await db.query<any>('SELECT id, health FROM source_connectors')).map((r) => [r.id, r.health]));
    expect(health.usaspending).toBe('error');
    expect(health.grants_gov).toBe('healthy');
    expect(health.sam_opportunities).toBe('not_configured');
    const errors = await db.query<any>(`SELECT step, message FROM sync_errors WHERE connector_id = 'usaspending'`);
    expect(errors[0].message).toMatch(/503/);
    // subnet attachment download is blocked by robots.txt (no download attempted)
    expect(http.calls.some((u) => /sites\/default\/files/.test(u))).toBe(false);
    const classes = (await db.query<any>('SELECT opportunity_class, count(*)::int AS n FROM opportunities GROUP BY 1 ORDER BY 1')).map((r) => r.opportunity_class);
    expect(classes).toEqual(['grant', 'prime', 'subcontract']);
    const scored = await db.one<any>('SELECT count(*)::int AS n FROM opportunities WHERE fit_score IS NOT NULL');
    expect(scored.n).toBeGreaterThan(10);
    const runs = await db.query<any>(`SELECT connector_id, status FROM sync_runs WHERE connector_id LIKE 'engine:%'`);
    expect(runs.map((r) => r.connector_id)).toEqual(expect.arrayContaining(['engine:scoring', 'engine:coverage']));
  });

  it('binary-searches USAspending pages for the first contract ending after a date', async () => {
    // 50 pages of 10 contracts, end dates increasing by one day per contract from 2025-01-01
    const start = Date.UTC(2025, 0, 1);
    const pages = Array.from({ length: 50 }, (_, p) => Array.from({ length: 10 }, (_, i) => ({ 'End Date': new Date(start + (p * 10 + i) * 86_400_000).toISOString().slice(0, 10) })));
    let calls = 0;
    const r = await firstPageEndingAfter(async (page) => {
      calls++;
      return { results: pages[page - 1] ?? [], hasNext: page < 50 };
    }, new Date(start + 333 * 86_400_000));
    expect(r?.page).toBe(34);
    expect(calls).toBeLessThan(15);
  });
});

describe('HTTP API', () => {
  it('records decisions with reasons, keeps history, and never exposes secrets', async () => {
    const db = await createTestDb();
    const deps = await testDeps(db, undefined, { samApiKey: 'SECRET-SAM-KEY-123', anthropicApiKey: 'sk-ant-secret' });
    const app = createApp(deps);
    const meta = await (await app.request('/api/meta')).text();
    expect(meta).not.toContain('SECRET-SAM-KEY-123');
    expect(meta).not.toContain('sk-ant-secret');
    expect(JSON.parse(meta).configuration.samApiKey).toBe(true);

    const row = await db.one<{ id: string }>(`INSERT INTO opportunities (title, opportunity_class, stage, status) VALUES ('Test opp','prime','solicitation','active') RETURNING id`);
    const post = (body: unknown) => app.request(`/api/opportunities/${row!.id}/decision`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    expect((await post({ decision: 'pass', reasons: ['wrong_scope'], explanation: 'Mostly cybersecurity operations.' })).status).toBe(200);
    expect((await post({ decision: 'pursue', reasons: ['excellent_capability_fit'] })).status).toBe(200);
    expect((await post({ decision: 'bogus' })).status).toBe(400);
    const decisions = await db.query<any>('SELECT decision, is_current, explanation FROM user_opportunity_decisions ORDER BY decided_at');
    expect(decisions).toEqual([
      { decision: 'pass', is_current: false, explanation: 'Mostly cybersecurity operations.' },
      { decision: 'pursue', is_current: true, explanation: null },
    ]);
    const note = await app.request(`/api/opportunities/${row!.id}/notes`, { method: 'POST', body: JSON.stringify({ body: 'Teaming idea' }), headers: { 'Content-Type': 'application/json' } });
    expect(note.status).toBe(200);
    const dossier: any = await (await app.request(`/api/opportunities/${row!.id}`)).json();
    expect(dossier.currentDecision.decision).toBe('pursue');
    expect(dossier.notes[0].body).toBe('Teaming idea');
    const csv = await (await app.request('/api/opportunities/export.csv')).text();
    expect(csv.split('\r\n')[0]).toContain('Fit score');
    expect(csv).toContain('Test opp');
  });

  it('protects the API and cron endpoint with secrets when configured', async () => {
    const db = await createTestDb();
    const app = createApp(await testDeps(db, undefined, { appPassword: 'pw-123456', cronSecret: 'cron-secret-xyz', sessionSecret: 's3cr3t' }));
    expect((await app.request('/api/dashboard')).status).toBe(401);
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/cron/sync', { method: 'POST' })).status).toBe(401);
    const login = await app.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'pw-123456' }), headers: { 'Content-Type': 'application/json' } });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await app.request('/api/dashboard', { headers: { cookie } })).status).toBe(200);
  });
});
