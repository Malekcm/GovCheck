import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { bootstrap } from '../src/server/bootstrap';
import { loadConfig } from '../src/server/config';
import { createDb, describeDatabaseUrl, resolveCaCertificate, sslOptions, stripSslParams } from '../src/server/db';
import { acquireLease, currentLease, releaseLease, renewLease } from '../src/server/pipeline/lease';
import { dueWork, runDueWorkNow } from '../src/server/pipeline/scheduler';
import { recoverInterruptedRuns, startSharedExclusive } from '../src/server/pipeline/sync';
import { runSeed } from '../src/server/seed';
import { redact } from '../src/server/lib/logger';
import { createTestDb, fixture, FixtureHttp, setupCompany, testConfig, testDeps } from './helpers/setup';
import { PG_URL, withTempDatabase } from './helpers/pg';

const FAKE_PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUFAKEFAKEFAKE\n-----END CERTIFICATE-----';

describe('database selection and TLS configuration', () => {
  it('uses PGlite when DATABASE_URL is absent and PostgreSQL when it is present', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'govcheck-sel-'));
    const local = loadConfig({ PGLITE_DIR: dir } as any);
    expect(local.databaseUrl).toBeUndefined();
    const pglite = await createDb(local);
    expect(pglite.kind).toBe('pglite');
    await pglite.close();
    fs.rmSync(dir, { recursive: true, force: true });

    const hosted = loadConfig({ DATABASE_URL: 'postgres://u:p@db.example.supabase.co:5432/postgres' } as any);
    const pg = await createDb(hosted); // the pool connects lazily: no network needed here
    expect(pg.kind).toBe('postgres');
    await pg.close();
  });

  it('accepts the Supabase CA as PEM text, base64, or a file — and keeps verification on', () => {
    const url = 'postgres://u:p@db.example.supabase.co:5432/postgres';
    expect(sslOptions({ databaseUrl: url, pgliteDir: '' })).toBe(true);
    expect(sslOptions({ databaseUrl: url, pgliteDir: '', databaseSslCaPem: FAKE_PEM.replace(/\n/g, '\\n') })).toEqual({ ca: FAKE_PEM, rejectUnauthorized: true });
    const b64 = Buffer.from(FAKE_PEM).toString('base64');
    expect(resolveCaCertificate({ databaseUrl: url, pgliteDir: '', databaseSslCaBase64: b64 })).toEqual({ ca: FAKE_PEM, source: 'base64' });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'govcheck-ca-')), 'ca.crt');
    fs.writeFileSync(file, FAKE_PEM);
    expect(resolveCaCertificate({ databaseUrl: url, pgliteDir: '', databaseSslCaFile: file })?.source).toBe('file');
    expect(() => resolveCaCertificate({ databaseUrl: url, pgliteDir: '', databaseSslCaBase64: Buffer.from('not a cert').toString('base64') })).toThrow(/did not decode to a PEM/);
    expect(sslOptions({ databaseUrl: 'postgres://postgres:postgres@localhost:5432/x', pgliteDir: '' })).toBeUndefined();
    // Unverified TLS only when explicitly requested.
    expect(sslOptions({ databaseUrl: url, pgliteDir: '', databaseSslAllowUnverified: true })).toEqual({ rejectUnauthorized: false });
    // sslmode in the URL must not silently replace the verified configuration.
    expect(stripSslParams(`${url}?sslmode=require&application_name=govcheck`)).toBe(`${url}?application_name=govcheck`);
  });

  it('never logs or exposes connection credentials or certificates', async () => {
    expect(describeDatabaseUrl('postgresql://postgres.abc:SuperSecret@aws-0-us-east-1.pooler.supabase.com:5432/postgres')).toBe('PostgreSQL at aws-0-us-east-1.pooler.supabase.com:5432/postgres');
    expect(redact('connect postgres://postgres:SuperSecret@host/db failed')).not.toContain('SuperSecret');
    const db = await createTestDb();
    const app = createApp(await testDeps(db, undefined, { databaseSslCaPem: FAKE_PEM, cronSecret: 'cron-secret-123', sessionSecret: 'session-secret-123' }));
    for (const p of ['/api/meta', '/api/sources', '/api/sync/overview', '/api/sam/budget', '/api/admin/storage', '/api/health']) {
      const body = await (await app.request(p)).text();
      expect(body).not.toContain('BEGIN CERTIFICATE');
      expect(body).not.toContain('cron-secret-123');
      expect(body).not.toContain('session-secret-123');
    }
  });

  it('refuses to start a hosted deployment on the embedded database', async () => {
    await expect(bootstrap({ requireDatabaseUrl: true, databaseUrl: undefined })).rejects.toThrow(/REQUIRE_DATABASE_URL/);
  });

  it('skips re-seeding when reference data is unchanged (fast cold starts) without losing keyword edits', async () => {
    const db = await createTestDb();
    expect((await runSeed(db)).skipped).toBe(true);
    await db.query(`UPDATE capabilities SET keywords = '{"custom term"}', keywords_customized = true WHERE slug = 'power-bi'`);
    await runSeed(db, { force: true });
    expect((await db.one<any>(`SELECT keywords FROM capabilities WHERE slug = 'power-bi'`)).keywords).toEqual(['custom term']);
  });
});

describe('shared sync lease (hosted app + GitHub Actions on one database)', () => {
  it('lets one process hold the lease, blocks others, and allows takeover after expiry', async () => {
    const db = await createTestDb();
    expect(await acquireLease(db, 'GitHub Actions: due sources', 'gha', 60_000)).toBe(true);
    expect(await acquireLease(db, 'Render: due sources', 'render', 60_000)).toBe(false);
    expect((await currentLease(db))?.label).toBe('GitHub Actions: due sources');
    expect(await renewLease(db, 'render')).toBe(false);
    expect(await renewLease(db, 'gha')).toBe(true);
    await db.query(`UPDATE app_state SET value = jsonb_set(value, '{expiresAt}', to_jsonb(now() - interval '1 minute')) WHERE key = 'sync:lease'`);
    expect(await acquireLease(db, 'Render: due sources', 'render', 60_000)).toBe(true);
    await releaseLease(db, 'gha'); // not the holder: no effect
    expect((await currentLease(db))?.holder).toBe('render');
    await releaseLease(db, 'render');
    expect(await currentLease(db)).toBeNull();
  });

  it('does not start a sync while another process holds the lease, and does not mark its runs failed', async () => {
    const db = await createTestDb();
    const deps = await testDeps(db);
    await acquireLease(db, 'GitHub Actions: due sources', 'other-process', 60_000);
    await db.query(`INSERT INTO sync_runs (connector_id, mode, status, triggered_by, started_at) VALUES ('grants_gov', 'incremental', 'running', 'github-actions', now())`);
    let ran = false;
    const r = await startSharedExclusive(deps, 'manual', async () => {
      ran = true;
    });
    expect(r.started).toBe(false);
    expect(r.label).toMatch(/GitHub Actions/);
    expect(ran).toBe(false);
    expect(await recoverInterruptedRuns(db)).toBe(0); // the web app waking up leaves the other run alone
    await releaseLease(db, 'other-process');
    expect(await recoverInterruptedRuns(db)).toBe(1); // genuinely abandoned once nobody holds the lease
  });
});

describe('scheduled "due" sync', () => {
  it('runs only the sources that are due, and nothing before onboarding is complete', async () => {
    const db = await createTestDb();
    await setupCompany(db);
    await db.query(`UPDATE company_profiles SET include_grants = true`);
    expect(await dueWork(db)).toEqual({ incremental: [], reconcile: [] }); // onboarding not complete
    await db.query(`UPDATE company_profiles SET onboarding_completed_at = now()`);
    // Everything ran recently except SBA SUBNet; the bulk file was reconciled an hour ago.
    await db.query(`UPDATE source_connectors SET next_run_at = now() + interval '2 hours' WHERE source_type <> 'engine'`);
    await db.query(`UPDATE source_connectors SET next_run_at = now() - interval '1 minute' WHERE id = 'sba_subnet'`);
    await db.query(`INSERT INTO app_state (key, value) VALUES ('reconcile:sam_bulk', jsonb_build_object('at', now() - interval '1 hour')), ('reconcile:usaspending', jsonb_build_object('at', now() - interval '1 hour')), ('reconcile:gsa_forecast', jsonb_build_object('at', now() - interval '1 hour')), ('reconcile:dhs_apfs', jsonb_build_object('at', now() - interval '1 hour')), ('reconcile:grants_gov', jsonb_build_object('at', now() - interval '1 hour')), ('reconcile:sba_subnet', jsonb_build_object('at', now() - interval '1 hour')) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const work = await dueWork(db);
    expect(work.incremental).toEqual(['sba_subnet']);
    expect(work.reconcile).toEqual([]);

    let page = 0;
    // Any request to another source fails loudly: proves nothing else runs.
    const http = new FixtureHttp([
      [/robots\.txt$/, () => ''],
      [/legacy\.sba\.gov\/federal-contracting/, () => (page++ === 0 ? fixture('subnet_listing.html') : '<html><table class="usa-table"><tbody></tbody></table></html>')],
      [/legacy\.sba\.gov\/opportunity\//, () => fixture('subnet_detail.html')],
    ]);
    const deps = await testDeps(db, http);
    const r = await runDueWorkNow(deps, 'github-actions');
    expect(r.started).toBe(true);
    expect(r.report!.results.map((x) => x.connectorId)).toEqual(['sba_subnet']);
    const runs = await db.query<any>(`SELECT DISTINCT connector_id FROM sync_runs WHERE connector_id NOT LIKE 'engine:%'`);
    expect(runs.map((x) => x.connector_id)).toEqual(['sba_subnet']);
    expect(http.calls.every((u) => /sba\.gov|robots/.test(u))).toBe(true);
    // Its next run is scheduled, so an immediate second pass does nothing.
    expect((await dueWork(db)).incremental).toEqual([]);
    const second = await runDueWorkNow(deps, 'github-actions');
    expect(second.report!.results).toEqual([]);
    const beat = await db.one<any>(`SELECT value FROM app_state WHERE key = 'scheduler:last'`);
    expect(beat.value.triggeredBy).toBe('github-actions');
    expect(await currentLease(db)).toBeNull(); // released
  });

  it('exposes "check due sources now" without triggering a full refresh', async () => {
    const db = await createTestDb();
    const app = createApp(await testDeps(db));
    const res = await app.request('/api/sync/due', { method: 'POST' });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.started).toBe(false);
    expect(body.nothingDue).toBe(true);
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM sync_runs`)).n).toBe(0);
    const overview: any = await (await app.request('/api/sync/overview')).json();
    expect(overview).toHaveProperty('dataCurrentAsOf');
    expect(overview).toHaveProperty('nextScheduledCheck');
  });

  it('storage diagnostics report counts, size and growth', async () => {
    const db = await createTestDb();
    const app = createApp(await testDeps(db, undefined, { dbSizeWarnMb: 1, dbSizeLimitMb: 2 }));
    const d: any = await (await app.request('/api/admin/storage')).json();
    expect(d.counts.opportunities).toBe(0);
    expect(d.counts).toHaveProperty('source_record_versions');
    expect(d.versionGrowth.length).toBe(14);
    if (d.sizeMb != null) {
      expect(d.level).toBe('critical'); // a migrated database is larger than the 2 MB test limit
      expect(d.warnings[0]).toMatch(/does not delete history/);
    }
  });
});

describe('configuration defaults', () => {
  it('reserves part of a small SAM budget for interactive use and defaults bulk ingestion to focused', () => {
    const c = testConfig();
    expect(c.samDailyRequestLimit).toBe(10);
    expect(c.samManualReserve).toBe(2);
    expect(c.samBulkIngestMode).toBe('focused');
    expect(loadConfig({ SAM_DAILY_REQUEST_LIMIT: '1000' } as any).samManualReserve).toBe(50);
    expect(loadConfig({ SAM_BULK_INGEST_MODE: 'full' } as any).samBulkIngestMode).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// Real PostgreSQL (runs when TEST_DATABASE_URL points at a disposable test database).
// ---------------------------------------------------------------------------
describe.skipIf(!PG_URL)('shared PostgreSQL: several processes at once', () => {
  it('two processes starting together apply each migration exactly once, and the SAM limit holds across connections', () =>
    withTempDatabase(async (PG_URL) => {
      const { runMigrations } = await import('../src/server/db/migrate');
      const { DbRequestBudget } = await import('../src/server/pipeline/budget');
      const admin = await createDb({ databaseUrl: PG_URL, pgliteDir: '' });
      const a = await createDb({ databaseUrl: PG_URL, pgliteDir: '', databasePoolMax: 4 });
      const b = await createDb({ databaseUrl: PG_URL, pgliteDir: '', databasePoolMax: 4 });
      const [ra, rb] = await Promise.all([runMigrations(a, testConfig().migrationsDir), runMigrations(b, testConfig().migrationsDir)]);
      expect([...ra.applied, ...rb.applied].sort()).toEqual(['001_core', '002_row_level_security', '003_capture_scores_quality', '004_hosting_budget_search']);
      expect((await admin.one<any>('SELECT count(*)::int AS n FROM schema_migrations')).n).toBe(4);

      // "Web app" and "GitHub Actions" spending the same 5-request budget concurrently.
      const budgets = [new DbRequestBudget(a, { sam: 5 }), new DbRequestBudget(b, { sam: 5 })];
      const attempts = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => budgets[i % 2].consume('sam', 1, { category: 'test' })));
      expect(attempts.filter((x) => x.status === 'fulfilled').length).toBe(5);
      expect((await admin.one<any>(`SELECT requests FROM api_usage WHERE connector_id = 'sam'`)).requests).toBe(5);

      // The lease admits one holder across processes.
      const got = await Promise.all([acquireLease(a, 'web', 'web-proc', 60_000), acquireLease(b, 'gha', 'gha-proc', 60_000)]);
      expect(got.filter(Boolean).length).toBe(1);
      await Promise.all([a.close(), b.close(), admin.close()]);
    }));
});
