import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app';
import { samOpportunitiesAdapter } from '../src/server/connectors/sam/samOpportunities';
import { usaspendingAdapter } from '../src/server/connectors/usaspending';
import { connectorPriorities } from '../src/server/connectors/registry';
import type { RawRecord } from '../src/server/connectors/types';
import type { Db } from '../src/server/db';
import { createResearchLead, matchDiscoveryRow, providerRecordKey, recordDiscovery } from '../src/server/pipeline/discovery';
import { summarizeField } from '../src/server/pipeline/dossier';
import { mergeOpportunities, undoMerge } from '../src/server/pipeline/merge';
import { setTracking, trackingState } from '../src/server/pipeline/tracking';
import { parseG2xSearch, profileArguments, samNoticeCandidate, toDiscoveryRow, validateAgainstSchema } from '../src/server/team/g2xDiscovery';
import { seal } from '../src/server/team/security';
import { createTestDb, FixtureHttp, fixtureJson, ingestWith, samRecord, setupCompany, testDeps } from './helpers/setup';

vi.mock('../src/server/lib/urlSafety', () => ({ assertPublicUrl: async (url: string) => new URL(url) }));
const provider = vi.hoisted(() => ({ users: new Map<string, any>() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      getUser: async (token: string) => ({ data: { user: [...provider.users.values()].find((u) => u.id === token) ?? null }, error: null }),
      signInWithPassword: async ({ email, password }: any) => {
        const user = provider.users.get(email);
        return { data: { session: user && password === 'valid' ? { access_token: user.id, refresh_token: 'refresh', expires_at: Date.now() / 1000 + 3600 } : null }, error: null };
      },
      setSession: async (session: any) => ({ data: { session }, error: null }),
      refreshSession: async () => ({ data: { session: null }, error: true }),
      admin: { signOut: async () => ({ error: null }) },
    },
  }),
}));

const open: Db[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((d) => d.close()));
  provider.users.clear();
});

const SECRET = 'a-very-long-session-secret-at-least-32-characters';
const G2X_RESULT = () => fixtureJson('g2x_search_synthetic.json');
const samItem = () => fixtureJson('sam_opportunity_sources_sought.json');
const SAM_SEARCH = /api\.sam\.gov\/opportunities\/v2\/search/;
const OFFICIAL_BETA = () => ({
  ...samItem(),
  noticeId: 'bbbbbbbb000040008000000000000002',
  title: 'Official Program Management Support Presolicitation',
  solicitationNumber: 'SYN-NEW-0002',
  fullParentPathName: 'DEPT OF DEFENSE.DEFENSE INFORMATION SYSTEMS AGENCY.DITCO',
  type: 'Presolicitation',
  baseType: 'Presolicitation',
  uiLink: 'https://sam.gov/opp/bbbbbbbb000040008000000000000002/view',
});

const SEARCH_TOOL = {
  name: 'g2x_search_opportunities',
  description: 'Search opportunities',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, naics: { type: 'array', items: { type: 'string' }, maxItems: 5 }, status: { type: 'string', enum: ['open', 'closed'] }, cursor: { type: 'string' } }, required: ['query'], additionalProperties: false },
};
const RECORD_TOOL = { name: 'g2x_get_record', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { id: { type: 'string' }, record_type: { type: 'string', enum: ['opportunity', 'award'] } }, required: ['id'] } };

/** Team-mode app with a mocked G2X MCP endpoint and a fixture SAM.gov API. No live calls. */
async function setup(opts: { samItems?: any[] } = {}) {
  const db = await createTestDb();
  open.push(db);
  const samCalls: string[] = [];
  const http = new FixtureHttp([
    [/robots\.txt$/, () => ''],
    [/noticedesc/, () => 'Official description text.'],
    [
      SAM_SEARCH,
      (req) => {
        samCalls.push(req.url);
        const u = new URL(req.url);
        const items = (opts.samItems ?? []).filter((i) => (!u.searchParams.get('noticeid') || i.noticeId === u.searchParams.get('noticeid')) && (!u.searchParams.get('solnum') || i.solicitationNumber === u.searchParams.get('solnum')));
        return { totalRecords: items.length, opportunitiesData: items };
      },
    ],
  ]);
  const g2xCalls: any[] = [];
  const g2xFetch = (async (input: any, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    g2xCalls.push(body);
    const json = (v: any) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (body?.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body?.method === 'initialize') return json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } });
    if (body?.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: [SEARCH_TOOL, RECORD_TOOL] } });
    if (body?.method === 'tools/call' && body.params.name === 'g2x_get_record') return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Synthetic live record text' }] } });
    if (body?.method === 'tools/call') return json({ jsonrpc: '2.0', id: body.id, result: G2X_RESULT() });
    throw new Error(`Unexpected G2X call ${String(input)}`);
  }) as unknown as typeof fetch;
  const deps = { ...(await testDeps(db, http, { teamAuthEnabled: true, supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'p', supabaseServiceKey: 's', sessionSecret: SECRET, g2xEnabled: true, samApiKey: 'test-key', samDailyRequestLimit: 50 })), g2xFetch };
  const ids: Record<string, string> = {};
  for (const role of ['admin', 'manager', 'member', 'viewer', 'other']) {
    const id = crypto.randomUUID();
    ids[role] = id;
    provider.users.set(`${role}@test.gov`, { id, email: `${role}@test.gov` });
    await db.query('INSERT INTO team_members(user_id,organization_id,email,name,role) SELECT $1,id,$2,$3,$4 FROM organizations LIMIT 1', [id, `${role}@test.gov`, role, role === 'other' ? 'member' : role]);
  }
  // Only these members connected their own G2X account.
  for (const role of ['manager', 'member', 'viewer'])
    await db.query('INSERT INTO g2x_connections(user_id,credentials) VALUES ($1,$2)', [ids[role], seal(SECRET, { access_token: `tok-${role}`, refresh_token: 'r', expires_at: Date.now() + 3_600_000, issuer: 'https://auth.g2x.com', client_id: 'c' })]);
  const app = createApp(deps);
  const cookies: Record<string, string> = {};
  for (const role of Object.keys(ids)) {
    const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${role}@test.gov`, password: 'valid' }) });
    expect(res.status).toBe(200);
    cookies[role] = res.headers.get('set-cookie')!.split(';')[0];
  }
  const request = (role: string, path: string, method = 'GET', body?: any) => app.request(path, { method, headers: { Cookie: cookies[role], 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const search = (role = 'member') => request(role, '/api/g2x/search', 'POST', { tool: SEARCH_TOOL.name, arguments: { query: 'synthetic test' }, acknowledgeIndividualUse: true });
  return { db, deps, app, ids, request, search, samCalls, g2xCalls };
}

async function dbText(db: Db): Promise<string> {
  const tables = await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema()`);
  let out = '';
  for (const { t } of tables) out += JSON.stringify(await db.query(`SELECT * FROM "${t}"`));
  return out;
}

describe('G2X result parsing and schema validation (mocked responses)', () => {
  it('parses structured rows, extracts the cursor without following it, and derives only a candidate SAM notice ID', () => {
    const { rows, nextCursor } = parseG2xSearch(G2X_RESULT());
    expect(rows).toHaveLength(4);
    expect(nextCursor).toBe('SYNTHETICCURSOR123');
    expect(rows[0]).toMatchObject({ solicitationNumber: '70RDAD-26-RFI-0042', agency: 'HOMELAND SECURITY, DEPARTMENT OF', family: 'sam' });
    expect(samNoticeCandidate(rows[0])).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
    expect(samNoticeCandidate(rows[2])).toBeNull(); // not a SAM-family record
    // Falls back to the JSON tail of the text block when structuredContent is absent.
    const textOnly = parseG2xSearch({ content: G2X_RESULT().content });
    expect(textOnly.rows).toHaveLength(1);
    expect(textOnly.nextCursor).toBe('SYNTHETICCURSOR123');
  });
  it('rejects unsafe links and validates arguments against the live tool schema', () => {
    const r = G2X_RESULT();
    r.structuredContent.rows[0].record_url = 'http://evil.example/x';
    expect(parseG2xSearch(r).rows[0].recordUrl).toBeNull();
    expect(validateAgainstSchema(SEARCH_TOOL.inputSchema as any, { query: 'x' })).toEqual([]);
    expect(validateAgainstSchema(SEARCH_TOOL.inputSchema as any, { naics: [1], extra: true })).toEqual(expect.arrayContaining(['arguments.query is required', 'arguments.naics[0] must be string', 'arguments.extra is not accepted by this tool']));
    expect(validateAgainstSchema(SEARCH_TOOL.inputSchema as any, { query: 'x', status: 'archived' })[0]).toMatch(/one of/);
  });
  it('builds search arguments from the company profile using only properties the schema declares', async () => {
    const db = await createTestDb();
    open.push(db);
    await setupCompany(db, { naics: ['541611', '541519'] });
    await db.query(`UPDATE company_profiles SET keywords = ARRAY['program management'], preferred_agencies = ARRAY['DHS']`);
    const out = await profileArguments(await testDeps(db), SEARCH_TOOL.inputSchema as any);
    expect(out.arguments).toEqual({ query: 'program management', naics: ['541611', '541519'], status: 'open' });
    expect(out.unsupported).toEqual(['Preferred agencies']);
    expect(out.issues).toEqual([]);
  });
});

describe('cross-source matching and deduplication', () => {
  it('matches existing opportunities by notice ID or solicitation + compatible agency, never by solicitation alone', async () => {
    const db = await createTestDb();
    open.push(db);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(samItem())]);
    const [alpha, beta, gamma, delta] = parseG2xSearch(G2X_RESULT()).rows.map(toDiscoveryRow);
    const a = await matchDiscoveryRow(db, alpha);
    expect(a.status).toBe('existing');
    expect(a.evidence[0]).toMatch(/notice ID/);
    // Same solicitation number without the notice ID still matches when the agency is compatible.
    const solOnly = await matchDiscoveryRow(db, { ...alpha, recordRef: 'x', noticeIdCandidate: null });
    expect(solOnly.status).toBe('existing');
    expect(solOnly.evidence[0]).toMatch(/Solicitation number .* agency match/);
    // Incorrect agency: same solicitation number at a different buyer requires review.
    const d = await matchDiscoveryRow(db, delta);
    expect(d.status).toBe('potential_match');
    expect(d.candidates[0].conflicts[0]).toMatch(/Agency differs/);
    expect((await matchDiscoveryRow(db, beta)).status).toBe('official_candidate');
    expect((await matchDiscoveryRow(db, gamma)).status).toBe('research_lead_only');
  });
  it('treats an award with the same solicitation number as a possible predecessor, not the same procurement', async () => {
    const db = await createTestDb();
    open.push(db);
    const award = { ...samItem(), noticeId: 'eeee0000eeee0000eeee0000eeee0001', type: 'Award Notice', baseType: 'Award Notice', title: 'Award: Enterprise Data Analytics', award: { number: '70RDAD21C00000001', amount: '1000000', date: '2021-09-01', awardee: { name: 'Incumbent Co', ueiSAM: 'ABCDEFABCDEF' } } };
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(award)]);
    const [alpha] = parseG2xSearch(G2X_RESULT()).rows.map(toDiscoveryRow);
    const m = await matchDiscoveryRow(db, { ...alpha, noticeIdCandidate: null });
    expect(m.status).toBe('potential_match');
    expect(m.candidates[0]).toMatchObject({ suggestedRelationship: 'predecessor' });
    expect(m.candidates[0].conflicts.join(' ')).toMatch(/award/i);
  });
  it('ingestion is idempotent across retries, repeated pages and concurrent refreshes', async () => {
    const db = await createTestDb();
    open.push(db);
    const rec = samRecord(samItem());
    await ingestWith(db, samOpportunitiesAdapter, [rec, rec]);
    await Promise.allSettled([ingestWith(db, samOpportunitiesAdapter, [rec]), ingestWith(db, samOpportunitiesAdapter, [rec])]);
    await ingestWith(db, samOpportunitiesAdapter, [rec]);
    expect((await db.one<any>('SELECT count(*)::int AS n FROM opportunities'))!.n).toBe(1);
    expect((await db.one<any>('SELECT count(*)::int AS n FROM source_records'))!.n).toBe(1);
    expect((await db.one<any>('SELECT source_count, connector_ids FROM opportunities'))).toMatchObject({ source_count: 1, connector_ids: ['sam_opportunities'] });
  });
  it('respects earlier user decisions about a discovery result', async () => {
    const db = await createTestDb();
    open.push(db);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(samItem())]);
    const opp = (await db.one<any>('SELECT id FROM opportunities'))!.id;
    const [, , gamma, delta] = parseG2xSearch(G2X_RESULT()).rows.map(toDiscoveryRow);
    const { recordMatchDecision } = await import('../src/server/pipeline/discovery');
    await recordMatchDecision(db, { provider: 'g2x', recordRef: delta.recordRef, opportunityId: opp, decision: 'separate', actorId: null });
    expect((await matchDiscoveryRow(db, delta)).candidates.find((c) => c.id === opp)).toBeUndefined();
    await recordMatchDecision(db, { provider: 'g2x', recordRef: gamma.recordRef, opportunityId: null, decision: 'dismissed', actorId: null });
    await recordMatchDecision(db, { provider: 'g2x', recordRef: gamma.recordRef, opportunityId: null, decision: 'dismissed', actorId: null });
    expect((await matchDiscoveryRow(db, gamma)).status).toBe('dismissed');
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM discovery_match_decisions WHERE decision = 'dismissed'`))!.n).toBe(1);
  });
});

describe('canonical field selection and conflicting evidence', () => {
  const pri = new Map([['sam_opportunities', 10], ['dhs_apfs', 30], ['ai', 90]]);
  const fv = (o: any) => ({ id: crypto.randomUUID(), field: 'response_deadline', provenance: 'official', connector_id: 'sam_opportunities', source_record_id: crypto.randomUUID(), observed_at: '2026-10-01T00:00:00Z', src_stage: 'solicitation', ...o });
  it('keeps an official value over a newer AI value and reports corroboration across source families', () => {
    const s = summarizeField('naics_code', 'NAICS', [fv({ field: 'naics_code', value: '541511' }), fv({ field: 'naics_code', value: '541512', provenance: 'ai_extracted', connector_id: 'ai', observed_at: '2026-11-01T00:00:00Z' }), fv({ field: 'naics_code', value: '541511', connector_id: 'dhs_apfs', src_stage: 'forecast' })], pri);
    expect(s.value).toBe('541511');
    expect(s.authority).toBe('government_confirmed');
    expect(s.corroboratedBy).toEqual(['DHS APFS']);
    expect(s.conflict).toBe(false);
  });
  it('flags disagreement between official records, but not lifecycle supersession', () => {
    const superseded = summarizeField('response_deadline', 'Deadline', [fv({ value: '2026-12-01T17:00:00Z' }), fv({ value: '2026-06-20T17:00:00Z', src_stage: 'sources_sought' })], pri);
    expect(superseded.value).toBe('2026-12-01T17:00:00Z');
    expect(superseded.conflict).toBe(false);
    expect(superseded.superseded).toHaveLength(1);
    const conflict = summarizeField('set_aside', 'Set-aside', [fv({ field: 'set_aside', value: 'Total Small Business' }), fv({ field: 'set_aside', value: '8(a) Set-Aside', connector_id: 'dhs_apfs' })], pri);
    expect(conflict.conflict).toBe(true);
    expect(conflict.alternatives).toHaveLength(2);
    const forecastOnly = summarizeField('naics_code', 'NAICS', [fv({ field: 'naics_code', value: '541611', connector_id: 'dhs_apfs', src_stage: 'forecast' })], pri);
    expect(forecastOnly.authority).toBe('official_forecast');
  });
});

describe('tracking, research leads, merge and undo', () => {
  it('creates an idempotent, explicitly labeled research lead that never becomes an open solicitation', async () => {
    const db = await createTestDb();
    open.push(db);
    const input = { title: 'My lead about PMO support', notes: 'Call the CO', sourceUrl: 'https://g2x.com/app/opportunities/forecast/cccccccc-0000-4000-8000-000000000003', provider: 'g2x', solicitationNumber: null, track: true } as const;
    const [a, b] = await Promise.all([createResearchLead(db, input, null), createResearchLead(db, input, null)]);
    expect(a.opportunityId).toBe(b.opportunityId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const o = await db.one<any>('SELECT * FROM opportunities WHERE id = $1', [a.opportunityId]);
    expect(o).toMatchObject({ verification_status: 'research_lead', is_signal: true, opportunity_class: 'intelligence', first_discovered_source: 'g2x' });
    expect(o.stage).not.toBe('solicitation');
    expect((await trackingState(db, a.opportunityId)).tracked).toBe(true);
    const values = await db.query<any>('SELECT DISTINCT provenance FROM opportunity_field_values WHERE opportunity_id = $1', [a.opportunityId]);
    expect(values.map((v) => v.provenance)).toEqual(['user_entered']);
  });
  it('a source refresh never erases tracking, decisions, notes, tags or assignments', async () => {
    const db = await createTestDb();
    open.push(db);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(samItem())]);
    const id = (await db.one<any>('SELECT id FROM opportunities'))!.id;
    const user = crypto.randomUUID();
    await db.query("INSERT INTO team_members(user_id,organization_id,email,name,role) SELECT $1,id,'o@test.gov','Owner','member' FROM organizations LIMIT 1", [user]);
    await setTracking(db, id, { tracked: true, actorId: user });
    await db.query(`INSERT INTO user_opportunity_decisions (opportunity_id, decision) VALUES ($1,'pursue')`, [id]);
    await db.query(`INSERT INTO user_notes (opportunity_id, body) VALUES ($1,'keep me')`, [id]);
    await db.query(`INSERT INTO user_tags (opportunity_id, tag) VALUES ($1,'priority')`, [id]);
    await db.query(`INSERT INTO opportunity_assignments (opportunity_id, user_id, assignment_role) VALUES ($1,$2,'owner')`, [id, user]);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...samItem(), title: 'Amended title', responseDeadLine: '2026-12-20T17:00:00-04:00' })]);
    expect((await trackingState(db, id)).tracked).toBe(true);
    expect((await db.one<any>('SELECT title FROM opportunities WHERE id = $1', [id]))!.title).toBe('Amended title');
    for (const t of ['user_opportunity_decisions', 'user_notes', 'user_tags', 'opportunity_assignments']) expect((await db.one<any>(`SELECT count(*)::int AS n FROM ${t} WHERE opportunity_id = $1`, [id]))!.n).toBe(1);
    // Idempotent tracking requests.
    const req = crypto.randomUUID();
    await setTracking(db, id, { tracked: false, requestId: req });
    await setTracking(db, id, { tracked: false, requestId: req });
    await expect(setTracking(db, id, { tracked: true, requestId: req })).rejects.toThrow(/Idempotency/);
    expect((await db.one<any>('SELECT count(*)::int AS n FROM opportunity_tracking_history WHERE opportunity_id = $1', [id]))!.n).toBe(2);
  });
  it('merging a research lead into its official record preserves tracking and discovery attribution, and undo restores both', async () => {
    const db = await createTestDb();
    open.push(db);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(samItem())]);
    const official = (await db.one<any>('SELECT id FROM opportunities'))!.id;
    const lead = await createResearchLead(db, { title: 'Lead for the CBP analytics RFI', sourceUrl: 'https://g2x.com/app/opportunities/sam/a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90', provider: 'g2x', solicitationNumber: '70RDAD-26-RFI-0042', agency: 'HOMELAND SECURITY, DEPARTMENT OF', track: true }, null);
    // The user-typed solicitation number produces a review suggestion, never an automatic merge.
    expect(await db.one(`SELECT 1 FROM opportunity_relationships WHERE relationship_type = 'possible_same_procurement' AND status = 'suggested'`)).toBeTruthy();
    expect((await db.one<any>('SELECT merged_into_id FROM opportunities WHERE id = $1', [lead.opportunityId]))!.merged_into_id).toBeNull();
    const priorities = await connectorPriorities(db);
    const mergeId = await mergeOpportunities(db, official, lead.opportunityId, priorities, 'Official record found');
    const merged = await db.one<any>('SELECT verification_status, first_discovered_source, connector_ids, source_count FROM opportunities WHERE id = $1', [official]);
    expect(merged.verification_status).toBe('government_verified');
    expect(merged.connector_ids).toEqual(['sam_opportunities', 'user_research_lead']);
    expect((await trackingState(db, official)).tracked).toBe(true);
    expect(await db.one(`SELECT 1 FROM opportunity_discovery WHERE opportunity_id = $1 AND provider = 'g2x'`, [official])).toBeTruthy();
    await undoMerge(db, mergeId, priorities);
    expect((await trackingState(db, lead.opportunityId)).tracked).toBe(true);
    expect((await trackingState(db, official)).explicit).toBeNull();
    expect(await db.one(`SELECT 1 FROM opportunity_discovery WHERE opportunity_id = $1 AND provider = 'g2x'`, [lead.opportunityId])).toBeTruthy();
    expect((await db.one<any>('SELECT verification_status FROM opportunities WHERE id = $1', [lead.opportunityId]))!.verification_status).toBe('research_lead');
  });
});

describe('G2X discovery API (team mode, mocked G2X and SAM.gov)', () => {
  it('groups results by GovCheck status without storing any G2X content', async () => {
    const { db, search, request, samCalls } = await setup();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(samItem())]);
    const before = await dbText(db);
    const res = await search();
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.groups).toEqual({ in_govcheck: 1, verifiable: 1, research_leads: 2, dismissed: 0 });
    expect(body.nextCursor).toBe('SYNTHETICCURSOR123');
    expect(samCalls).toHaveLength(0); // matching is local and free
    const after = await dbText(db);
    expect(after).not.toMatch(/Synthetic G2X Result/);
    expect(after.length - before.length).toBeLessThan(2000); // only audit rows
    expect((await request('admin', '/api/g2x/import', 'POST', {})).status).toBe(403);
  });
  it('rejects arguments that do not match the live tool schema and never paginates on its own', async () => {
    const { request, g2xCalls } = await setup();
    const bad = await request('member', '/api/g2x/search', 'POST', { tool: SEARCH_TOOL.name, arguments: { naics: '541611' }, acknowledgeIndividualUse: true });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).issues).toEqual(expect.arrayContaining(['arguments.query is required']));
    expect(g2xCalls.filter((c) => c?.method === 'tools/call')).toHaveLength(0);
    await request('member', '/api/g2x/search', 'POST', { tool: SEARCH_TOOL.name, arguments: { query: 'x' }, acknowledgeIndividualUse: true });
    expect(g2xCalls.filter((c) => c?.method === 'tools/call')).toHaveLength(1);
    await request('member', '/api/g2x/search', 'POST', { tool: SEARCH_TOOL.name, arguments: { query: 'x' }, cursor: 'SYNTHETICCURSOR123', acknowledgeIndividualUse: true });
    const calls = g2xCalls.filter((c) => c?.method === 'tools/call');
    expect(calls).toHaveLength(2);
    expect(calls[1].params.arguments.cursor).toBe('SYNTHETICCURSOR123');
  });
  it('Case B: verifies through SAM.gov, ingests the official record, and keeps G2X as discovery attribution only', async () => {
    const { db, request, samCalls } = await setup({ samItems: [OFFICIAL_BETA()] });
    const row = { g2xId: 'bbbbbbbb-0000-4000-8000-000000000002', recordUrl: 'https://g2x.com/app/opportunities/sam/bbbbbbbb-0000-4000-8000-000000000002', solicitationNumber: 'SYN-NEW-0002', agency: 'DEPT OF DEFENSE', track: true, confirmSamRequest: true };
    const res = await request('member', '/api/g2x/verify', 'POST', row);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ status: 'verified', officialSource: 'SAM.gov', discoverySource: 'G2X', requestsUsed: 1 });
    const o = await db.one<any>('SELECT * FROM opportunities WHERE id = $1', [body.opportunityId]);
    expect(o).toMatchObject({ title: 'Official Program Management Support Presolicitation', connector_ids: ['sam_opportunities'], verification_status: 'government_verified', first_discovered_source: 'g2x' });
    expect((await trackingState(db, o.id)).tracked).toBe(true);
    const disc = await db.one<any>('SELECT provider, provider_record_key, provider_record_url FROM opportunity_discovery WHERE opportunity_id = $1', [o.id]);
    expect(disc).toEqual({ provider: 'g2x', provider_record_key: providerRecordKey('g2x', row.recordUrl), provider_record_url: row.recordUrl });
    expect(await dbText(db)).not.toMatch(/Synthetic G2X Result/);
    // Repeating the action spends no SAM request and creates no duplicate.
    const again = (await (await request('member', '/api/g2x/verify', 'POST', row)).json()) as any;
    expect(again).toMatchObject({ status: 'verified', opportunityId: o.id, requestsUsed: 0 });
    expect(samCalls).toHaveLength(1);
    expect((await db.one<any>('SELECT count(*)::int AS n FROM opportunities'))!.n).toBe(1);
    // The next search shows it as already in GovCheck.
    const groups = ((await (await request('member', '/api/g2x/search', 'POST', { tool: SEARCH_TOOL.name, arguments: { query: 'x' }, acknowledgeIndividualUse: true })).json()) as any).rows;
    expect(groups.find((r: any) => r.g2xId === row.g2xId)).toMatchObject({ group: 'in_govcheck' });
  });
  it('Case B not found: reports it without creating anything', async () => {
    const { db, request } = await setup({ samItems: [] });
    const res = (await (await request('member', '/api/g2x/verify', 'POST', { g2xId: 'bbbbbbbb-0000-4000-8000-000000000002', recordUrl: 'https://g2x.com/app/opportunities/sam/bbbbbbbb-0000-4000-8000-000000000002', solicitationNumber: 'SYN-NEW-0002', agency: 'DEPT OF DEFENSE', confirmSamRequest: true })).json()) as any;
    expect(res.status).toBe('not_found');
    expect((await db.one<any>('SELECT count(*)::int AS n FROM opportunities'))!.n).toBe(0);
  });
  it('Case C: research leads require explicit user authorship and reject provider payloads', async () => {
    const { db, request } = await setup();
    const lead = { title: 'Energy analytics forecast lead', notes: 'Ask about timing', sourceUrl: 'https://g2x.com/app/opportunities/forecast/cccccccc-0000-4000-8000-000000000003', provider: 'g2x', confirmUserAuthored: true };
    expect((await request('member', '/api/research-leads', 'POST', { ...lead, confirmUserAuthored: false })).status).toBe(400);
    expect((await request('member', '/api/research-leads', 'POST', { ...lead, g2xRecord: { title: 'copied' } })).status).toBe(400);
    expect((await request('member', '/api/research-leads', 'POST', { ...lead, sourceUrl: 'https://example.com/x' })).status).toBe(400);
    expect((await request('viewer', '/api/research-leads', 'POST', lead)).status).toBe(403);
    const created = await request('member', '/api/research-leads', 'POST', lead);
    expect(created.status).toBe(201);
    const body = (await created.json()) as any;
    expect(body.labels).toEqual(['Research lead', 'Not government verified', 'No official solicitation confirmed', 'Source discovery: G2X']);
    expect((await request('member', '/api/research-leads', 'POST', lead)).status).toBe(200);
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM opportunities WHERE verification_status = 'research_lead'`))!.n).toBe(1);
    // The next search lists the result as already tracked in GovCheck.
    const rows = ((await (await request('member', '/api/g2x/search', 'POST', { tool: SEARCH_TOOL.name, arguments: { query: 'x' }, acknowledgeIndividualUse: true })).json()) as any).rows;
    expect(rows.find((r: any) => r.g2xId.startsWith('cccccccc'))).toMatchObject({ group: 'in_govcheck', match: { opportunity: { verification_status: 'research_lead', tracked: true } } });
    // List filters: research leads, G2X discovery, tracked.
    const list = (await (await request('member', '/api/opportunities?verification=research_lead&source=g2x&tracked=true&firstDiscovered=g2x')).json()) as any;
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ verification_status: 'research_lead', tracked: true, discovery_providers: ['g2x'] });
  });
  it('enforces team permissions and per-user G2X session isolation', async () => {
    const { request } = await setup({ samItems: [OFFICIAL_BETA()] });
    expect((await request('viewer', '/api/g2x/search', 'POST', { tool: SEARCH_TOOL.name, arguments: { query: 'x' }, acknowledgeIndividualUse: true })).status).toBe(403);
    expect((await request('viewer', '/api/g2x/verify', 'POST', { g2xId: 'bbbbbbbb-0000-4000-8000-000000000002', recordUrl: 'https://g2x.com/app/opportunities/sam/bbbbbbbb-0000-4000-8000-000000000002', confirmSamRequest: true })).status).toBe(403);
    // A member without their own G2X connection cannot use another member's session.
    expect((await request('other', '/api/g2x/search', 'POST', { tool: SEARCH_TOOL.name, arguments: { query: 'x' }, acknowledgeIndividualUse: true })).status).toBe(401);
    expect((await request('other', '/api/g2x/record/bbbbbbbb-0000-4000-8000-000000000002')).status).toBe(401);
    const live = (await (await request('member', '/api/g2x/record/bbbbbbbb-0000-4000-8000-000000000002')).json()) as any;
    expect(live.retention).toMatch(/Individual interactive session only/);
  });
});

describe('dossier: dynamic source tabs, versions, source counts and filters', () => {
  it('builds one Summary and one tab per contributing source family with versions and contributed fields', async () => {
    const { db, request } = await setup();
    const rfi = samItem();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(rfi)]);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...rfi, noticeId: 'f0f0f0f0aaaabbbbccccdddd00001111', type: 'Combined Synopsis/Solicitation', baseType: 'Combined Synopsis/Solicitation', postedDate: '2026-08-01', responseDeadLine: '2026-09-15T17:00:00-04:00' })]);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...rfi, title: 'RFI - amended' })]);
    const award: RawRecord = {
      sourceRecordId: 'CONT_AWD_70RDAD26F00000001_7014_-NONE-_-NONE-',
      kind: 'award',
      retrievedAt: new Date(),
      raw: {
        search: { generated_internal_id: 'CONT_AWD_70RDAD26F00000001_7014_-NONE-_-NONE-', 'Award ID': '70RDAD26F00000001', 'Recipient Name': 'ACME ANALYTICS LLC', 'Award Amount': 2400000 },
        detail: { piid: '70RDAD26F00000001', total_obligation: 2400000, base_and_all_options: 9800000, recipient: { recipient_name: 'ACME ANALYTICS LLC' }, awarding_agency: { toptier_agency: { name: 'Department of Homeland Security' }, subtier_agency: { name: 'U.S. Customs and Border Protection' } }, latest_transaction_contract_data: { solicitation_identifier: '70RDAD26RFI0042' } },
      },
    };
    await ingestWith(db, usaspendingAdapter, [award]);
    const id = (await db.one<any>('SELECT id FROM opportunities WHERE merged_into_id IS NULL'))!.id;
    await recordDiscovery(db, id, { provider: 'g2x', recordRef: 'https://g2x.com/app/opportunities/sam/a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90', recordUrl: 'https://g2x.com/app/opportunities/sam/a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90' });
    const d = (await (await request('member', `/api/opportunities/${id}`)).json()) as any;
    expect(d.sourceTabs.map((t: any) => t.key)).toEqual(['sam', 'usaspending', 'g2x']);
    const sam = d.sourceTabs[0];
    expect(sam.records).toHaveLength(2); // two SAM notices, one tab
    const rfiRec = sam.records.find((r: any) => r.recordId === rfi.noticeId);
    expect(rfiRec.versionCount).toBe(2);
    expect(rfiRec.versions).toHaveLength(2);
    expect(rfiRec.changesSincePrevious.some((c: any) => c.field === 'title')).toBe(true);
    expect(rfiRec.fieldsContributed.length).toBeGreaterThan(3);
    expect(d.sourceTabs[2].session).toMatchObject({ connected: true, persistenceAuthorized: false });
    expect(d.sourceTabs[2].records).toHaveLength(0);
    const deadline = d.summary.fields.find((f: any) => f.field === 'response_deadline');
    expect(deadline.source.label).toBe('SAM.gov');
    expect(deadline.conflict).toBe(false);
    expect(deadline.superseded.length).toBeGreaterThan(0);
    expect(d.summary.value.facts.find((v: any) => v.kind === 'potential_value')).toMatchObject({ category: 'award', source: 'USAspending' });
    expect(d.compare.columns.map((c: any) => c.key)).toEqual(['sam', 'usaspending']);
    expect(d.compare.sessionOnly).toEqual(['G2X']);
    expect(d.compare.rows.find((r: any) => r.field === 'response_deadline').cells[1].state).toBe('not_applicable');
    // An opportunity with several providers appears once, with an accurate count.
    const list = (await (await request('member', '/api/opportunities?sourceCount=multi')).json()) as any;
    expect(list.total).toBe(1);
    expect(list.items[0].connector_ids).toEqual(['sam_opportunities', 'usaspending']);
    expect(list.items[0].discovery_providers).toEqual(['g2x']);
    expect(((await (await request('member', '/api/opportunities?source=g2x')).json()) as any).total).toBe(1);
    expect(((await (await request('member', '/api/opportunities?recentlyEnriched=true')).json()) as any).total).toBe(1);
    expect(((await (await request('member', '/api/opportunities?sourceCount=single')).json()) as any).total).toBe(0);
    const registry = (await (await request('member', '/api/sources/registry')).json()) as any[];
    expect(registry.map((r) => r.id)).toEqual(expect.arrayContaining(['sam_opportunities', 'dhs_apfs', 'usaspending', 'user_research_lead', 'g2x']));
    expect(registry.some((r) => r.id.startsWith('engine:'))).toBe(false);
  });
  it('requires a reason for a canonical override and preserves every source value', async () => {
    const { db, request } = await setup();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(samItem())]);
    const id = (await db.one<any>('SELECT id FROM opportunities'))!.id;
    expect((await request('manager', `/api/opportunities/${id}/overrides`, 'PUT', { field: 'naics_code', value: '541512' })).status).toBe(400);
    expect((await request('manager', `/api/opportunities/${id}/overrides`, 'PUT', { field: 'naics_code', value: '541512', note: 'CO confirmed by email' })).status).toBe(200);
    const d = (await (await request('manager', `/api/opportunities/${id}`)).json()) as any;
    const naics = d.summary.fields.find((f: any) => f.field === 'naics_code');
    expect(naics).toMatchObject({ value: '541512', authority: 'user_override', overridden: { reason: 'CO confirmed by email' } });
    expect(naics.alternatives.map((a: any) => a.value)).toEqual(['541512', '541511']);
    // Members cannot override unassigned opportunities.
    expect((await request('member', `/api/opportunities/${id}/overrides`, 'PUT', { field: 'naics_code', value: '1', note: 'nope' })).status).toBe(403);
  });
  it('members may track, but only assignees or managers may untrack', async () => {
    const { db, request } = await setup();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(samItem())]);
    const id = (await db.one<any>('SELECT id FROM opportunities'))!.id;
    expect((await request('viewer', `/api/opportunities/${id}/track`, 'POST', { tracked: true })).status).toBe(403);
    expect(((await (await request('member', `/api/opportunities/${id}/track`, 'POST', { tracked: true })).json()) as any).tracked).toBe(true);
    expect((await request('member', `/api/opportunities/${id}/track`, 'POST', { tracked: false })).status).toBe(403);
    expect(((await (await request('manager', `/api/opportunities/${id}/track`, 'POST', { tracked: false })).json()) as any).tracked).toBe(false);
    expect(((await (await request('member', '/api/opportunities?tracked=false')).json()) as any).total).toBe(1);
  });
});
