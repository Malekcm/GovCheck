import fs from 'node:fs';
import path from 'node:path';
import type { AppDeps } from '../../src/server/app';
import { loadConfig, type AppConfig } from '../../src/server/config';
import { ensureConnectors, ensureEngines, connectorPriorities } from '../../src/server/connectors/registry';
import type { RawRecord, RequestBudget, SourceAdapter } from '../../src/server/connectors/types';
import { createDb, type Db } from '../../src/server/db';
import { runMigrations } from '../../src/server/db/migrate';
import type { HttpClient, HttpRequest, HttpResponse } from '../../src/server/lib/http';
import { silentLogger } from '../../src/server/lib/logger';
import { emptyStats, ingestRecord, type IngestContext } from '../../src/server/pipeline/ingest';
import { runSeed } from '../../src/server/seed';

export const FIXTURES = path.resolve(__dirname, '../fixtures');
export const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
export const fixtureJson = <T = any>(name: string): T => JSON.parse(fixture(name));

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), migrationsDir: path.resolve(__dirname, '../../migrations'), ...over };
}

/** Fresh, fully migrated + seeded in-memory Postgres (PGlite). */
export async function createTestDb(config = testConfig()): Promise<Db> {
  const db = await createDb(config, { memory: true });
  await runMigrations(db, config.migrationsDir);
  await runSeed(db);
  await ensureConnectors(db, config);
  await ensureEngines(db);
  return db;
}

export class UnlimitedBudget implements RequestBudget {
  used = 0;
  async remaining() {
    return Number.POSITIVE_INFINITY;
  }
  async consume() {
    this.used++;
  }
}

type Route = (req: HttpRequest) => unknown | Promise<unknown>;

/** HTTP client that serves fixtures by URL pattern; unmatched requests fail loudly (no live calls in tests). */
export class FixtureHttp implements HttpClient {
  calls: string[] = [];
  constructor(private routes: [RegExp, Route][]) {}
  async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
    this.calls.push(req.url);
    for (const [re, handler] of this.routes) {
      if (re.test(req.url)) {
        const data = await handler(req);
        return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), url: req.url, data: data as T };
      }
    }
    throw new Error(`No fixture route for ${req.url}`);
  }
}

export async function testDeps(db: Db, http: HttpClient = new FixtureHttp([[/robots\.txt$/, () => '']]), over: Partial<AppConfig> = {}): Promise<AppDeps> {
  return { db, config: testConfig(over), http, log: silentLogger, budget: new UnlimitedBudget() };
}

export async function ingestWith(db: Db, adapter: SourceAdapter, records: RawRecord[]) {
  const ictx: IngestContext = {
    db,
    connectorId: adapter.meta.id,
    connectorName: adapter.meta.name,
    adapter,
    priorities: await connectorPriorities(db),
    log: silentLogger,
    dirty: new Set(),
    stats: emptyStats(),
  };
  const results: string[] = [];
  for (const r of records) results.push(await ingestRecord(ictx, r));
  return { results, dirty: [...ictx.dirty], stats: ictx.stats };
}

export const samRecord = (item: any): RawRecord => ({ sourceRecordId: item.noticeId, kind: 'opportunity', raw: item, retrievedAt: new Date() });

export async function setupCompany(db: Db, opts: { naics?: string[]; caps?: string[]; certs?: Record<string, string>; clearances?: string[] } = {}) {
  const co = await db.one<{ id: string }>('SELECT id FROM company_profiles LIMIT 1');
  const id = co!.id;
  await db.query(
    `UPDATE company_profiles SET name = 'Test Co', business_size = 'small', sam_registration_status = 'active', remote_capable = true, min_contract_value = 100000,
       preferred_max_value = 10000000, max_realistic_value = 30000000, prime_sub_preference = 'either', security_clearances = $2::text[] WHERE id = $1`,
    [id, opts.clearances ?? []],
  );
  for (const [i, code] of (opts.naics ?? ['541511', '541512']).entries()) await db.query('INSERT INTO company_naics (company_id, code, is_primary) VALUES ($1,$2,$3)', [id, code, i === 0]);
  for (const slug of opts.caps ?? ['power-bi', 'data-analytics', 'dashboard-development', 'sql', 'program-management']) {
    await db.query(`INSERT INTO company_capabilities (company_id, capability_id, status, strength) SELECT $1, id, 'confirmed', 5 FROM capabilities WHERE slug = $2`, [id, slug]);
  }
  for (const [cert, status] of Object.entries(opts.certs ?? {})) await db.query('INSERT INTO company_certifications (company_id, cert_type, status) VALUES ($1,$2,$3)', [id, cert, status]);
  return id;
}
