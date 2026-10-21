import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../src/server/app';
import { TangoClient, previewTango, type TangoTransport } from '../src/server/connectors/tango';
import { createDb, type Db } from '../src/server/db';
import { runMigrations } from '../src/server/db/migrate';
import { TangoBudget } from '../src/server/pipeline/tangoBudget';
import { matchResearch } from '../src/server/pipeline/researchMatching';
import { registerTangoRoutes } from '../src/server/routes/tango';
import { loadConfig, SECRET_ENV_NAMES } from '../src/server/config';
import { createTestDb, testConfig, testDeps } from './helpers/setup';
import { PG_URL, withTempDatabase } from './helpers/pg';

let db: Db;
const config = () => testConfig({ tango: { ...loadConfig({}).tango, enabled: true, apiKey: 'fixture-key-only' } });
const plan = () => previewTango({ resource: 'forecasts', filters: { agency: 'DOT' }, limit: 5, maxPages: 1 });
const response = (data: unknown = { results: [], next: null }, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers });
// PGlite query does not support multiple statements with parameters; exec is appropriate here.
const ageRequests = async () => db.exec(`UPDATE tango_budget SET last_dispatch=clock_timestamp()-interval '2 minutes'; UPDATE tango_requests SET attempted_at=clock_timestamp()-interval '2 minutes'`);

beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec('TRUNCATE tango_requests, tango_budget, research_signals CASCADE'); });

describe('Tango quota reservations', () => {
  it('atomically admits one of many concurrent dispatches and isolates SAM quotas', async () => {
    const budget = new TangoBudget(db, config().tango);
    const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => budget.reserve('/api/news/', 'manual')));
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    expect((await budget.status()).used).toBe(1);
    expect(await db.one(`SELECT * FROM api_usage WHERE connector_id='tango'`)).toBeNull();
  });
  it('enforces 80 internal, 70 background, 20 provider and 10 manual reserves', async () => {
    const budget = new TangoBudget(db, config().tango);
    await budget.status();
    await db.query(`UPDATE tango_budget SET used=70,background_used=70`);
    await expect(budget.reserve('/api/forecasts/', 'background')).rejects.toThrow('Manual research reserve');
    await budget.reserve('/api/forecasts/', 'manual');
    await ageRequests();
    await db.query(`UPDATE tango_budget SET used=80`);
    await expect(budget.reserve('/api/news/', 'manual')).rejects.toThrow('allocation exhausted');
    await db.query(`UPDATE tango_budget SET used=1,provider_remaining=20`);
    await expect(budget.reserve('/api/news/', 'manual')).rejects.toThrow('safety reserve');
  });
  it('resets UTC days and months while retaining the lifetime development cap', async () => {
    const budget = new TangoBudget(db, config().tango);
    await budget.status();
    await db.query(`UPDATE tango_budget SET usage_day='2000-01-01',usage_month='2000-01',used=80,month_used=1000,test_used=5,provider_remaining=0`);
    const status = await budget.status();
    expect(status.used).toBe(0); expect(status.monthUsed).toBe(0); expect(status.providerRemaining).toBeNull();
    expect(status.resetsAt).toMatch(/T00:00:00.000Z$/);
    await expect(budget.reserve('/api/forecasts/', 'test')).rejects.toThrow('lifetime');
  });
  it('protects monthly allowance and prevents invalid values from raising safety caps', async () => {
    const cfg = loadConfig({ TANGO_PROVIDER_RESERVE: '0', TANGO_MANUAL_RESERVE: '0', TANGO_TEST_MAX_REQUESTS: '900' }).tango;
    expect(cfg.providerReserve).toBe(20); expect(cfg.manualReserve).toBe(10); expect(cfg.testMaxRequests).toBe(5);
    const budget = new TangoBudget(db, cfg);
    await budget.status(); await db.query(`UPDATE tango_budget SET month_used=$1`, [cfg.monthlyLimit]);
    await expect(budget.reserve('/api/news/', 'manual')).rejects.toThrow('allocation exhausted');
  });
  it('reconciles only downward, counts failures, handles reset durations, and protects burst windows', async () => {
    const budget = new TangoBudget(db, config().tango);
    const id = await budget.reserve('/api/news/', 'manual');
    await budget.finish(id, 200, new Headers({ 'x-ratelimit-daily-remaining': '50', 'x-ratelimit-daily-reset': '300', 'x-ratelimit-burst-remaining': '0', 'x-ratelimit-burst-reset': '45' }));
    expect((await budget.status()).providerRemaining).toBe(50);
    await expect(budget.reserve('/api/news/', 'manual')).rejects.toThrow('cooling down');
    await budget.finish(id, 200, new Headers({ 'x-ratelimit-daily-remaining': '90' }));
    expect((await budget.status()).providerRemaining).toBe(50);
    const reset = (await budget.status()).providerReset!;
    expect(new Date(reset).getTime()).toBeGreaterThan(Date.now() + 290000);
    expect(new Date(reset).getTime()).toBeLessThan(Date.now() + 310000);
  });
  it('stops until daily reset after 429 and never refunds uncertain attempts', async () => {
    const budget = new TangoBudget(db, config().tango);
    const id = await budget.reserve('/api/news/', 'manual');
    await budget.finish(id, 429, new Headers({ 'x-ratelimit-daily-remaining': '0', 'x-ratelimit-daily-reset': '20000' }));
    await expect(budget.reserve('/api/news/', 'manual')).rejects.toThrow('cooling down');
    expect((await budget.status()).used).toBe(1);
    expect(new Date((await budget.status()).blockedUntil!).getTime()).toBeGreaterThan(Date.now()+19990000);
  });
  it('blocks repeated tests for a minute and all calls following authentication failure', async () => {
    const budget = new TangoBudget(db, config().tango);
    const id = await budget.reserve('/api/forecasts/', 'test');
    await db.query(`UPDATE tango_budget SET last_dispatch=clock_timestamp()-interval '10 seconds'`);
    await expect(budget.reserve('/api/forecasts/', 'test')).rejects.toThrow('one minute');
    await budget.finish(id, 401);
    await expect(budget.reserve('/api/news/', 'manual')).rejects.toThrow('Authentication failed');
  });
});

describe('bounded Tango and G2X research', () => {
  it('previews without dispatching, rejects unsupported and broad queries', () => {
    expect(plan().estimatedRequests).toBe(1);
    expect(() => previewTango({ resource: 'news', filters: {}, limit: 5 })).toThrow('Scope research');
    expect(() => previewTango({ resource: 'news', filters: { api_key: 'secret', search: 'cloud' } })).toThrow('Unsupported');
    expect(() => previewTango({ resource: 'news', filters: { search: 'cloud' }, maxPages: 1000 })).toThrow();
    expect(() => previewTango({ resource: 'news', filters: { search: 'cloud' }, persist: true })).toThrow();
  });
  it('uses X-API-KEY, prevents redirects, deduplicates records and never persists payloads', async () => {
    const transport = vi.fn<TangoTransport>(async (_url, init) => {
      expect(init.headers).toEqual({ 'X-API-KEY': 'fixture-key-only', Accept: 'application/json' });
      expect(init.redirect).toBe('error');
      return response({ results: [{ title: 'SYNTHETIC-PROVIDER-CONTENT' }, { title: 'SYNTHETIC-PROVIDER-CONTENT' }], next: null, meta: { resolved_filters: { agency: 'DOT' } } });
    });
    const p = plan(); const result = await new TangoClient(db, config(), transport).research(p.query, p.fingerprint);
    expect(result.records).toHaveLength(1); expect(transport).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual([]); // ordinary resolver metadata is not an upgrade warning
    const journal = await db.query('SELECT * FROM tango_requests');
    expect(JSON.stringify(journal)).not.toContain('SYNTHETIC-PROVIDER-CONTENT');
    expect(JSON.stringify(journal)).not.toContain('fixture-key-only');
    expect(await db.one(`SELECT id FROM source_records WHERE connector_id='tango'`)).toBeNull();
  });
  it('fails closed without flags, explicit preview, or injected test transport', async () => {
    const p = plan(); const transport = vi.fn<TangoTransport>();
    const cfg = config(); cfg.tango.enabled = false;
    await expect(new TangoClient(db, cfg, transport).research(p.query,p.fingerprint)).rejects.toThrow('TANGO_ENABLED');
    await expect(new TangoClient(db, config(), transport).research(p.query,'wrong')).rejects.toThrow('Preview');
    await expect(new TangoClient(db, config()).research(p.query,p.fingerprint)).rejects.toThrow('mocked');
    await expect(new TangoClient(db, config(),transport).research(p.query,p.fingerprint,'background')).rejects.toThrow('Scheduled');
    expect(transport).not.toHaveBeenCalled();
    expect(SECRET_ENV_NAMES).toContain('TANGO_API_KEY');
  });
  it('counts network failures, sanitizes errors and does not retry', async () => {
    const transport = vi.fn<TangoTransport>(async () => { throw new Error('fixture-key-only'); });
    const p = plan();
    await expect(new TangoClient(db,config(),transport).research(p.query,p.fingerprint)).rejects.toThrow('attempt was counted');
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await new TangoBudget(db,config().tango).status()).used).toBe(1);
  });
  it.each([401,403,429,500])('stops on HTTP %i without retries or exposing the body', async status => {
    const transport = vi.fn<TangoTransport>(async () => response({ detail: 'secret provider body' },status));
    const p = plan();
    try { await new TangoClient(db,config(),transport).research(p.query,p.fingerprint); throw new Error('Expected failure'); }
    catch (error) { expect(String(error)).not.toContain('secret provider body'); }
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('stops at page caps and rejects hostile pagination without forwarding credentials', async () => {
    const p = previewTango({ resource: 'news', filters: { search: 'cloud' }, maxPages: 2, limit: 5 });
    const transport = vi.fn<TangoTransport>(async () => response({ results: [],next:'https://attacker.example/api/news/?search=cloud&limit=5&page=2' }));
    await expect(new TangoClient(db,config(),transport).research(p.query,p.fingerprint)).rejects.toThrow('Unsafe');
    expect(transport).toHaveBeenCalledTimes(1);
    await ageRequests();
    const capped = previewTango({ ...p.query, maxPages: 1 });
    const result = await new TangoClient(db,config(),transport).research(capped.query,capped.fingerprint);
    expect(result.hasMore).toBe(true); expect(result.requests).toBe(1);
  });
  it('supports two bounded pages and preserves plan filters', async () => {
    const p = previewTango({resource:'forecasts',filters:{agency:'DOT'},maxPages:2,limit:1});
    let count=0;
    const transport = vi.fn<TangoTransport>(async () => response({ results: [{ id: ++count }], next: count===1 ? 'https://tango.dev/api/forecasts/?agency=DOT&limit=1&page=2' : null }));
    const result = await new TangoClient(db,config(),transport).research(p.query,p.fingerprint);
    expect(result.requests).toBe(2); expect(result.records).toHaveLength(2);
  });
  it('rejects malformed JSON, excessive records, and bodies above the bound', async () => {
    const p=plan();
    for (const payload of [response({results:'invalid'}),response({results:Array.from({length:6},()=>({}))}),new Response('x'.repeat(2000001))]) {
      await ageRequests();
      await expect(new TangoClient(db,config(),async()=>payload).research(p.query,p.fingerprint)).rejects.toThrow(/shape|size/);
    }
  });
});

describe('research routes and persistence boundaries', () => {
  it('ordinary page/status/preview loads spend zero requests and expose no key', async () => {
    const deps = await testDeps(db,undefined, { tango: config().tango });
    const app = createApp(deps);
    const spy=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('No live calls allowed'));
    try {
      const status=await app.request('/api/tango/status'); expect(status.status).toBe(200);
      expect(await status.text()).not.toContain('fixture-key-only');
      expect((await app.request('/api/tango/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(plan().query)})).status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('requires app authentication and explicit acknowledgement on connection tests', async () => {
    const app=createApp(await testDeps(db,undefined,{appPassword:'test-password'}));
    expect((await app.request('/api/tango/status')).status).toBe(401);
    const publicApp=createApp(await testDeps(db));
    expect((await publicApp.request('/api/tango/test',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}})).status).toBe(400);
  });
  it('executes the reviewed G2X route with mocked transport and accepts independent OrangeSlices notes only', async () => {
    const app = new Hono();
    registerTangoRoutes(app,await testDeps(db,undefined,{tango:config().tango}), async()=>response({results:[{g2x_id:'synthetic-1',title:'Synthetic G2X news'}],next:null}));
    const p=previewTango({resource:'news',filters:{search:'technology'}});
    const run=await app.request('/api/tango/research',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:p.query,fingerprint:p.fingerprint})});
    expect(run.status).toBe(200); expect((await run.json() as {source:string}).source).toBe('G2X via Tango');
    const guardedApp=createApp(await testDeps(db));
    const post=(body: unknown)=>guardedApp.request('/api/research/signals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const note={sourceName:'OrangeSlices',sourceUrl:'https://orangeslices.ai/example',notes:'My independent assessment',category:'news',independentlyAuthored:true};
    expect((await post(note)).status).toBe(201);
    expect((await post({...note,sourceName:'Tango'})).status).toBe(400);
    expect((await post({...note,raw:{title:'provider'}})).status).toBe(400);
    expect((await post({...note,sourceUrl:'https://attacker.example'})).status).toBe(400);
    const rls=await db.query<{relrowsecurity:boolean}>(`SELECT relrowsecurity FROM pg_class WHERE relname IN ('tango_budget','tango_requests','research_signals')`);
    expect(rls).toHaveLength(3); expect(rls.every(x=>x.relrowsecurity)).toBe(true);
  });
  it('associates strong identifiers but never names, descriptions, or agency-less solicitations', async () => {
    const opp=await db.one<{id:string}>(`INSERT INTO opportunities(title,department_name,opportunity_class,stage,status) VALUES ('Synthetic cloud project','Department of Transportation','prime','solicitation','open') RETURNING id`);
    await db.query(`INSERT INTO opportunity_identifiers(opportunity_id,id_type,value,normalized_value) VALUES ($1,'solicitation_number','DOT-TEST-123','DOTTEST123')`,[opp!.id]);
    expect((await matchResearch(db,{title:'Synthetic cloud project',description:'same'})).opportunities).toHaveLength(0);
    expect((await matchResearch(db,{solicitation_number:'DOTTEST123'})).opportunities).toHaveLength(0);
    expect((await matchResearch(db,{solicitation_number:'DOTTEST123',organization:{department_name:'Other Agency'}})).opportunities).toHaveLength(0);
    expect((await matchResearch(db,{solicitation_number:'DOTTEST123',organization:{department_name:'Department of Transportation'}})).opportunities[0].id).toBe(opp!.id);
  });
});

describe.skipIf(!PG_URL)('Tango shared PostgreSQL concurrency', () => {
  it('shares one reservation across independent database pools', async () => {
    await withTempDatabase(async url => {
      const first=await createDb({databaseUrl:url,pgliteDir:''});
      const second=await createDb({databaseUrl:url,pgliteDir:''});
      try {
        await runMigrations(first,testConfig().migrationsDir);
        const a=new TangoBudget(first,config().tango), b=new TangoBudget(second,config().tango);
        await a.status();
        await first.query(`UPDATE tango_budget SET used=79`);
        const attempts=await Promise.allSettled(Array.from({length:12},(_,i)=>(i%2?a:b).reserve('/api/news/','manual')));
        expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);
        expect((await a.status()).used).toBe(80);
      } finally { await first.close(); await second.close(); }
    });
  });
});
