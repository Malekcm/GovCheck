import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { samOpportunitiesAdapter } from '../src/server/connectors/sam/samOpportunities';
import { gsaForecastAdapter } from '../src/server/connectors/gsaForecast';
import { retrainAndRescore, scoreMany } from '../src/server/scoring/run';
import { computeCoverage } from '../src/server/pipeline/coverage';
import { createTestDb, fixtureJson, ingestWith, samRecord, setupCompany, testDeps } from './helpers/setup';

describe('API smoke test: every read endpoint works on a populated database', () => {
  it('returns 200 for all GET routes', async () => {
    const db = await createTestDb();
    await setupCompany(db);
    const item = fixtureJson('sam_opportunity_sources_sought.json');
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(item), samRecord({ ...item, noticeId: 'second', solicitationNumber: null, title: 'Power BI dashboards and data analytics support' })]);
    const row = fixtureJson('gsa_forecast_page.json').listing.data[0];
    await ingestWith(db, gsaForecastAdapter, [{ sourceRecordId: String(row.nid), kind: 'forecast', raw: row, retrievedAt: new Date() }]);
    await scoreMany(db, 'all');
    const opp = await db.one<{ id: string; agency_id: string; office_id: string }>('SELECT id, agency_id, office_id FROM opportunities WHERE office_id IS NOT NULL LIMIT 1');
    await db.query(`INSERT INTO user_opportunity_decisions (opportunity_id, decision, reasons) VALUES ($1,'pass','{wrong_scope,too_large}')`, [opp!.id]);
    await retrainAndRescore(db, 'test');
    await computeCoverage(db, { companyNaics: ['541511'] });
    const vendor = await db.query<{ id: string }>(`INSERT INTO vendors (name, name_key, uei) VALUES ('ACME','ACME','ABCDEF123456') RETURNING id`);

    const app = createApp(await testDeps(db));
    const paths = [
      '/api/health',
      '/api/meta',
      '/api/queues',
      '/api/dashboard',
      '/api/company',
      '/api/capabilities',
      '/api/opportunities',
      '/api/opportunities?q=analytics&minFit=0&stage=rfi,forecast&sort=deadline&openOnly=true&decision=none,pass&setAside=SBA,NONE&naics=5415&valueMin=1&recompete=true',
      '/api/opportunities/export.csv',
      `/api/opportunities/${opp!.id}`,
      `/api/opportunities/${opp!.id}/preference`,
      `/api/opportunities/${opp!.id}/search-related?q=power`,
      '/api/changes?days=30',
      '/api/changes?days=30&type=NEW_OPPORTUNITY&minFit=10',
      '/api/coverage',
      '/api/coverage?type=FORECAST_ONLY',
      '/api/merge/candidates',
      '/api/merge/history',
      '/api/agencies',
      `/api/agencies/${opp!.agency_id}`,
      `/api/offices/${opp!.office_id}`,
      '/api/vendors',
      '/api/vendors?q=acme',
      `/api/vendors/${vendor[0].id}`,
      '/api/preferences/model',
      '/api/sources',
      '/api/sync/status',
      '/api/sync/runs',
      '/api/export/backup.json',
      '/api/auth/me',
    ];
    for (const p of paths) {
      const res = await app.request(p);
      if (res.status !== 200) throw new Error(`${p} → ${res.status}: ${await res.text()}`);
    }
    const model: any = await (await app.request('/api/preferences/model')).json();
    expect(model.active.sample_count).toBe(1);
    expect(model.reasonCounts.map((r: any) => r.code).sort()).toEqual(['too_large', 'wrong_scope']);
  });
});
