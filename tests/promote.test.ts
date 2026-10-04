import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureConnectors, ensureEngines } from '../src/server/connectors/registry';
import { samOpportunitiesAdapter } from '../src/server/connectors/sam/samOpportunities';
import { createDb, json, type Db } from '../src/server/db';
import { runMigrations } from '../src/server/db/migrate';
import { promoteDatabase, PromotionAborted } from '../src/server/db/promote';
import { directoryFingerprint, runPromoteCli } from '../src/server/db/promoteCli';
import { runSeed } from '../src/server/seed';
import { fixtureJson, ingestWith, samRecord, setupCompany, testConfig } from './helpers/setup';
import { PG_URL, withTempDatabase } from './helpers/pg';

const MIGRATIONS = testConfig().migrationsDir;
const tmpDirs: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A realistic local database on disk: sources, versions, decisions, capture, merges, cursors. */
async function buildLocalDatabase(dir: string): Promise<{ oppIds: string[] }> {
  const db = await createDb({ pgliteDir: dir });
  await runMigrations(db, MIGRATIONS);
  await runSeed(db);
  const config = testConfig();
  await ensureConnectors(db, config);
  await ensureEngines(db);
  await setupCompany(db);
  await db.query(`UPDATE company_profiles SET onboarding_completed_at = now(), name = 'Local Co'`);
  const item = fixtureJson('sam_opportunity_sources_sought.json');
  await ingestWith(db, samOpportunitiesAdapter, [samRecord(item), samRecord({ ...item, noticeId: 'second-notice', solicitationNumber: 'OTHER-SOL-001', title: 'Power BI dashboards' })]);
  // A changed version of the first notice → two source_record_versions rows.
  await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...item, responseDeadLine: '2026-07-01T17:00:00-04:00' })]);
  const opps = await db.query<{ id: string }>('SELECT id FROM opportunities ORDER BY created_at');
  // A merge (self-referencing foreign key) and user-owned work.
  await db.query('UPDATE opportunities SET merged_into_id = $1 WHERE id = $2', [opps[0].id, opps[1].id]);
  await db.query(`INSERT INTO user_opportunity_decisions (opportunity_id, decision, reasons) VALUES ($1, 'pursue', '{excellent_capability_fit}')`, [opps[0].id]);
  await db.query(`INSERT INTO user_notes (opportunity_id, body) VALUES ($1, 'Call the CO on Monday')`, [opps[0].id]);
  await db.query(`INSERT INTO user_tags (opportunity_id, tag) VALUES ($1, 'priority')`, [opps[0].id]);
  await db.query(`INSERT INTO opportunity_capture (opportunity_id, pursuit_stage, owner, win_probability) VALUES ($1, 'capture', 'Pat', 40)`, [opps[0].id]);
  await db.query(`INSERT INTO capabilities (slug, name, category, keywords, is_custom, parent_id) SELECT 'custom-geo', 'Geospatial', 'Custom', '{"GIS","esri"}', true, id FROM capabilities WHERE slug = 'cat:program-project-management'`);
  await db.query(`UPDATE source_connectors SET cursor = $1::jsonb, next_run_at = now() + interval '3 hours' WHERE id = 'sam_opportunities'`, [json({ lastPostedTo: '2026-09-30', offsetMode: 'record', resume: null })]);
  await db.query(`INSERT INTO api_usage (connector_id, usage_date, requests) VALUES ('sam', '2026-09-30', 7)`);
  await db.query(`INSERT INTO app_state (key, value) VALUES ('sync:lease', '{"holder":"x","expiresAt":"2999-01-01T00:00:00Z"}'::jsonb)`);
  // JSON null vs SQL NULL must survive exactly.
  await db.query(`INSERT INTO app_state (key, value) VALUES ('json-null-test', 'null'::jsonb)`);
  await db.close();
  return { oppIds: opps.map((o) => o.id) };
}

async function openCopy(dir: string): Promise<Db> {
  const copy = path.join(tmp('govcheck-copy-'), 'pglite');
  fs.cpSync(dir, copy, { recursive: true });
  return createDb({ pgliteDir: copy });
}

const memoryTarget = () => createDb({ pgliteDir: '' }, { memory: true });

describe('PGlite → Postgres promotion', () => {
  let localDir: string;
  let oppIds: string[];
  beforeAll(async () => {
    localDir = path.join(tmp('govcheck-local-'), 'pglite');
    ({ oppIds } = await buildLocalDatabase(localDir));
  });

  it('copies every table, preserving UUIDs, versions, cursors, merges and user work; re-running is a no-op', async () => {
    const source = await openCopy(localDir);
    const target = await memoryTarget();
    const report = await promoteDatabase(source, target, MIGRATIONS, { batchSize: 10 });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    for (const t of report.tables) {
      expect(t.missingAfter, t.table).toBe(0);
      expect(t.targetAfter, t.table).toBe(t.sourceCount);
    }
    const byTable = Object.fromEntries(report.tables.map((t) => [t.table, t]));
    expect(byTable.source_record_versions.sourceCount).toBe(3);
    expect(byTable.app_state.sourceCount).toBeGreaterThan(0);

    expect((await target.query<{ id: string }>('SELECT id FROM opportunities ORDER BY created_at')).map((r) => r.id)).toEqual(oppIds);
    const merged = await target.one<any>('SELECT merged_into_id FROM opportunities WHERE id = $1', [oppIds[1]]);
    expect(merged.merged_into_id).toBe(oppIds[0]);
    const cursor = await target.one<any>(`SELECT cursor, next_run_at FROM source_connectors WHERE id = 'sam_opportunities'`);
    expect(cursor.cursor.lastPostedTo).toBe('2026-09-30');
    expect(cursor.next_run_at).not.toBeNull();
    expect((await target.one<any>(`SELECT decision FROM user_opportunity_decisions`)).decision).toBe('pursue');
    expect((await target.one<any>(`SELECT body FROM user_notes`)).body).toBe('Call the CO on Monday');
    expect((await target.one<any>(`SELECT owner, win_probability FROM opportunity_capture`)).owner).toBe('Pat');
    expect((await target.one<any>(`SELECT keywords FROM capabilities WHERE slug = 'custom-geo'`)).keywords).toEqual(['GIS', 'esri']);
    expect((await target.one<any>(`SELECT requests FROM api_usage WHERE usage_date = '2026-09-30'`)).requests).toBe(7);
    // The source's runtime lease is never copied; JSON null stays JSON null.
    expect(await target.one(`SELECT 1 FROM app_state WHERE key = 'sync:lease'`)).toBeNull();
    expect((await target.one<any>(`SELECT value IS NULL AS sql_null, jsonb_typeof(value) AS t FROM app_state WHERE key = 'json-null-test'`)).t).toBe('null');
    // Versions are byte-identical.
    const srcHashes = (await source.query<any>('SELECT id, content_hash FROM source_record_versions ORDER BY id')).map((r) => `${r.id}:${r.content_hash}`);
    const tgtHashes = (await target.query<any>('SELECT id, content_hash FROM source_record_versions ORDER BY id')).map((r) => `${r.id}:${r.content_hash}`);
    expect(tgtHashes).toEqual(srcHashes);
    // Full-text search works on the copied rows (generated column rebuilt by the target).
    expect((await target.one<any>(`SELECT count(*)::int AS n FROM opportunities WHERE search_vector @@ plainto_tsquery('english', 'dashboard')`)).n).toBeGreaterThan(0);

    // Idempotent: a second run inserts nothing and reports everything as already present.
    const again = await promoteDatabase(source, target, MIGRATIONS, { batchSize: 7 });
    expect(again.ok).toBe(true);
    for (const t of again.tables) {
      expect(t.inserted, t.table).toBe(0);
      expect(t.differing, t.table).toBe(0);
      expect(t.identical, t.table).toBe(t.sourceCount);
    }
    await source.close();
    await target.close();
  });

  it('resumes an interrupted promotion: only the missing rows are copied', async () => {
    const source = await openCopy(localDir);
    const target = await memoryTarget();
    await promoteDatabase(source, target, MIGRATIONS);
    // Simulate a run that died half-way through the leaf tables.
    await target.query('DELETE FROM user_notes');
    await target.query('DELETE FROM source_record_versions WHERE id IN (SELECT id FROM source_record_versions ORDER BY id LIMIT 2)');
    const r = await promoteDatabase(source, target, MIGRATIONS);
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.tables.map((t) => [t.table, t]));
    expect(by.user_notes.inserted).toBe(1);
    expect(by.source_record_versions.inserted).toBe(2);
    expect(by.opportunities.inserted).toBe(0);
    await source.close();
    await target.close();
  });

  it('never overwrites newer target data by default, and reports the difference', async () => {
    const source = await openCopy(localDir);
    const target = await memoryTarget();
    await promoteDatabase(source, target, MIGRATIONS);
    await target.query(`UPDATE user_notes SET body = 'Edited in the hosted app'`);
    const r = await promoteDatabase(source, target, MIGRATIONS);
    expect(r.tables.find((t) => t.table === 'user_notes')!.differing).toBe(1);
    expect((await target.one<any>('SELECT body FROM user_notes')).body).toBe('Edited in the hosted app');
    const o = await promoteDatabase(source, target, MIGRATIONS, { overwrite: true });
    expect(o.tables.find((t) => t.table === 'user_notes')!.updated).toBe(1);
    expect((await target.one<any>('SELECT body FROM user_notes')).body).toBe('Call the CO on Monday');
    await source.close();
    await target.close();
  });

  it('a dry run writes nothing to the target (not even migrations)', async () => {
    const source = await openCopy(localDir);
    const target = await memoryTarget();
    const r = await promoteDatabase(source, target, MIGRATIONS, { dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.pendingTargetMigrations.length).toBeGreaterThan(3);
    expect(r.tables.every((t) => t.targetBefore === null && t.inserted === 0)).toBe(true);
    expect((await target.one<any>(`SELECT to_regclass('opportunities')::text AS t`)).t).toBeNull();
    await source.close();
    await target.close();
  });

  it('stops before writing when the target was started on its own first, and can replace only auto-created reference data', async () => {
    const source = await openCopy(localDir);
    const target = await memoryTarget();
    // The hosted app booted against the empty database before promotion.
    await runMigrations(target, MIGRATIONS);
    await runSeed(target);
    await ensureConnectors(target, testConfig());
    await ensureEngines(target);
    const before = (await target.one<any>('SELECT count(*)::int AS n FROM capabilities')).n;
    const err = await promoteDatabase(source, target, MIGRATIONS).catch((e) => e);
    expect(err).toBeInstanceOf(PromotionAborted);
    expect((err as PromotionAborted).report.conflicts.map((c) => c.table)).toEqual(expect.arrayContaining(['capabilities', 'company_profiles']));
    expect((err as Error).message).toMatch(/--replace-target-seed-data/);
    expect((await target.one<any>('SELECT count(*)::int AS n FROM capabilities')).n).toBe(before); // nothing written
    expect((await target.one<any>('SELECT count(*)::int AS n FROM opportunities')).n).toBe(0);

    const r = await promoteDatabase(source, target, MIGRATIONS, { replaceTargetSeed: true });
    expect(r.ok).toBe(true);
    expect((await target.one<any>(`SELECT cursor FROM source_connectors WHERE id = 'sam_opportunities'`)).cursor.lastPostedTo).toBe('2026-09-30');
    expect((await target.query<any>('SELECT id FROM company_profiles')).length).toBe(1);
    await source.close();
    await target.close();
  });

  it('refuses to mix two different databases, even with --replace-target-seed-data', async () => {
    const source = await openCopy(localDir);
    const target = await memoryTarget();
    await runMigrations(target, MIGRATIONS);
    await runSeed(target);
    await ensureConnectors(target, testConfig());
    const item = fixtureJson('sam_opportunity_sources_sought.json');
    await ingestWith(target, samOpportunitiesAdapter, [samRecord(item)]); // same notice, different UUIDs
    const err = await promoteDatabase(source, target, MIGRATIONS, { replaceTargetSeed: true }).catch((e) => e);
    expect(err).toBeInstanceOf(PromotionAborted);
    expect((err as Error).message).toMatch(/different GovCheck data/);
    expect((await target.one<any>('SELECT count(*)::int AS n FROM opportunities')).n).toBe(1);
    await source.close();
    await target.close();
  });

  it('the CLI never alters the local database directory (content-level check)', async () => {
    const before = directoryFingerprint(localDir, true);
    const reportDir = tmp('govcheck-report-');
    const code = await runPromoteCli(['--from', localDir], { TARGET_DATABASE_URL: 'postgres://user:secret@db.example.supabase.co:5432/postgres', MIGRATIONS_DIR: MIGRATIONS, PROMOTE_REPORT_DIR: reportDir } as any, {
      quiet: true,
      openTarget: () => memoryTarget(),
    });
    expect(code).toBe(0);
    expect(directoryFingerprint(localDir, true)).toBe(before);
    const reports = fs.readdirSync(reportDir);
    expect(reports.length).toBe(1);
    const saved = fs.readFileSync(path.join(reportDir, reports[0]), 'utf8');
    expect(saved).not.toContain('secret'); // connection string password never written
    const parsed = JSON.parse(saved);
    expect(parsed.localUnchanged).toBe(true);
    expect(parsed.target).toBe('PostgreSQL at db.example.supabase.co:5432/postgres');
    expect(parsed.tables.find((t: any) => t.table === 'opportunities').targetAfter).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Real PostgreSQL target (runs when TEST_DATABASE_URL points at a disposable test database).
// ---------------------------------------------------------------------------
describe.skipIf(!PG_URL)('promotion into real PostgreSQL', () => {
  it('promotes, verifies and is idempotent against PostgreSQL', () =>
    withTempDatabase(async (PG_URL) => {
      const localDir = path.join(tmp('govcheck-local-pg-'), 'pglite');
      const { oppIds } = await buildLocalDatabase(localDir);
      const before = directoryFingerprint(localDir, true);
      const env = { TARGET_DATABASE_URL: PG_URL, MIGRATIONS_DIR: MIGRATIONS, PROMOTE_REPORT_DIR: tmp('govcheck-report-pg-') } as any;
      expect(await runPromoteCli(['--from', localDir, '--dry-run'], env, { quiet: true })).toBe(0);
      expect(await runPromoteCli(['--from', localDir, '--batch-size', '10'], env, { quiet: true })).toBe(0);
      expect(await runPromoteCli(['--from', localDir], env, { quiet: true })).toBe(0); // re-run: no-op
      expect(directoryFingerprint(localDir, true)).toBe(before);
      const pg = await createDb({ databaseUrl: PG_URL, pgliteDir: '' });
      expect(pg.kind).toBe('postgres');
      expect((await pg.query<{ id: string }>('SELECT id FROM opportunities ORDER BY created_at')).map((r) => r.id)).toEqual(oppIds);
      expect((await pg.one<any>(`SELECT cursor FROM source_connectors WHERE id = 'sam_opportunities'`)).cursor.lastPostedTo).toBe('2026-09-30');
      expect((await pg.one<any>(`SELECT count(*)::int AS n FROM source_record_versions`)).n).toBe(3);
      await pg.close();
    }));
});
