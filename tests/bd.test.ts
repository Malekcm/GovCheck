import { beforeEach, describe, expect, it } from 'vitest';
import { DECISION_LABEL_VALUE, DEFAULT_SCORE_WEIGHTS } from '../src/shared/domain';
import { createApp } from '../src/server/app';
import { extractRuleRequirements, requirementStrength } from '../src/server/ai/rules';
import { dhsApfsAdapter, normalizeApfs } from '../src/server/connectors/dhsApfs';
import { gsaForecastAdapter, normalizeForecast, PageTracker } from '../src/server/connectors/gsaForecast';
import { detectSamFlags, samApiItemToNotice, samNoticeToNormalized } from '../src/server/connectors/sam/common';
import { samOpportunitiesAdapter } from '../src/server/connectors/sam/samOpportunities';
import { normalizeUsaspendingAward } from '../src/server/connectors/usaspending';
import type { Db } from '../src/server/db';
import { classifyDocument } from '../src/server/documents/extract';
import { csvCell, neutralizeFormula } from '../src/server/lib/csv';
import { FetchHttpClient } from '../src/server/lib/http';
import { assertPublicUrl, assertSafeUrlSyntax, isPrivateAddress } from '../src/server/lib/urlSafety';
import { upsertAward } from '../src/server/pipeline/awards';
import { diffScope, scopeSentences } from '../src/server/pipeline/canonical';
import { mergeOpportunities, undoMerge } from '../src/server/pipeline/merge';
import { runRecompeteEngine } from '../src/server/pipeline/recompete';
import { runConnector } from '../src/server/pipeline/sync';
import { connectorPriorities } from '../src/server/connectors/registry';
import { recommendActions } from '../src/server/scoring/actions';
import { computePriority, scoreAttractiveness, scoreConfidence, type ScoringExtras } from '../src/server/scoring/dimensions';
import { scoreOpportunity } from '../src/server/scoring/fit';
import { buildSamples } from '../src/server/scoring/preference';
import { loadCompanyContext } from '../src/server/scoring/profile';
import { scoreMany } from '../src/server/scoring/run';
import { TfIdfModel } from '../src/server/scoring/similarity';
import type { CompanyContext, OppForScoring } from '../src/server/scoring/types';
import { createTestDb, fixtureJson, FixtureHttp, ingestWith, samRecord, setupCompany, testDeps } from './helpers/setup';

const apfs = () => fixtureJson<any[]>('dhs_apfs_forecasts.json');
const apfsRecord = (r: any) => ({ sourceRecordId: String(r.id), kind: 'forecast' as const, raw: r, retrievedAt: new Date() });
const sam = () => fixtureJson('sam_opportunity_sources_sought.json');
const json = (body: unknown) => ({ method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

// ---------------------------------------------------------------------------
// New source: DHS APFS
// ---------------------------------------------------------------------------
describe('DHS APFS forecast connector', () => {
  it('normalizes official contacts, estimated dates, set-aside and the incumbent contract of a follow-on', () => {
    const rec = apfs().find((r) => r.contract_status === 'REC' && /541511/.test(r.naics))!;
    const n = normalizeApfs(rec);
    expect(n.stage).toBe('forecast');
    expect(n.agency.department).toBe('Department of Homeland Security');
    expect(n.naics).toEqual(['541511']);
    expect(n.setAsideCode).toBe('SDVOSBC');
    expect(n.recompeteHint).toBe(true);
    expect(n.identifiers).toEqual(expect.arrayContaining([{ type: 'predecessor_piid', value: rec.contract_number }, { type: 'source_listing_id', value: rec.apfs_number }]));
    expect(n.extra.incumbentContractor).toBe(rec.contractor);
    expect(n.contacts.map((c) => c.role)).toEqual(expect.arrayContaining(['program', 'small_business']));
    expect(n.dates.map((d) => d.kind)).toEqual(expect.arrayContaining(['expected_solicitation', 'expected_award', 'performance_start', 'performance_end', 'forecast_award_fy']));
    expect(n.financials[0].kind).toBe('forecast_estimate');
    expect(n.financials[0].low).toBeGreaterThan(0);
  });

  it('marks "No Longer Required" forecasts as cancelled with a derived basis, and never treats a definitive contract as a vehicle restriction', () => {
    const nlr = normalizeApfs(apfs().find((r) => r.contract_status === 'NLR')!);
    expect(nlr.status).toBe('cancelled');
    expect(nlr.statusBasis).toMatch(/No Longer Required/);
    const anyRec = normalizeApfs({ ...apfs()[0], contract_vehicle: 'Definitive Contract' });
    expect(anyRec.contractVehicle).toBeNull();
    const ordered = normalizeApfs({ ...apfs()[0], contract_vehicle: 'IDIQ TO/DO (Non Strategic Sourcing Vehicle Multiple Award Contract)' });
    expect(ordered.contractVehicle).toMatch(/TO\/DO/);
  });

  it('links a follow-on forecast exactly to the incumbent award and to an existing recompete signal', async () => {
    const db = await createTestDb();
    await setupCompany(db, { naics: ['541511'] });
    const rec = apfs().find((r) => r.contract_status === 'REC' && /541511/.test(r.naics))!;
    const end = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10);
    const award = await upsertAward(
      db,
      { awardKey: `piid::${rec.contract_number}`, piid: rec.contract_number, awardee: { name: rec.contractor, uei: 'ZZZZ11112222' }, agency: { department: 'Department of Homeland Security', subtier: 'U.S. Customs and Border Protection' }, naics: '541511', baseAndAllOptions: 4_000_000, popCurrentEnd: end, description: 'IT support' },
      'usaspending',
      null,
    );
    // The recompete engine creates a signal for the expiring contract BEFORE the forecast exists.
    const co = await loadCompanyContext(db);
    const priorities = await connectorPriorities(db);
    const first = await runRecompeteEngine(db, co, priorities);
    expect(first.signalsCreated).toBe(1);

    await ingestWith(db, dhsApfsAdapter, [apfsRecord(rec)]);
    const forecast = await db.one<any>(`SELECT id, incumbent_name FROM opportunities WHERE stage = 'forecast'`);
    const link = await db.one<any>(`SELECT relationship, confidence, method FROM opportunity_awards WHERE opportunity_id = $1 AND award_id = $2`, [forecast.id, award.id]);
    expect(link).toMatchObject({ relationship: 'incumbent', confidence: 'high', method: 'exact' });
    expect(forecast.incumbent_name).toBeTruthy();
    const rel = await db.one<any>(`SELECT relationship_type, method FROM opportunity_relationships WHERE from_opportunity_id = $1`, [forecast.id]);
    expect(rel).toMatchObject({ relationship_type: 'forecast_of', method: 'exact' });
    const ev = await db.query<any>(`SELECT event_type FROM opportunity_events WHERE opportunity_id = $1 AND event_type = 'INCUMBENT_IDENTIFIED'`, [forecast.id]);
    expect(ev.length).toBeGreaterThan(0);

    // Re-running the engine treats the forecast as the successor instead of inventing more signals.
    const again = await runRecompeteEngine(db, co, priorities);
    expect(again.signalsCreated).toBe(0);
    expect(again.successorsLinked).toBe(1);
  });

  it('a later full listing that omits a forecast marks it not seen (never deleted); a collapsed listing degrades instead', async () => {
    const db = await createTestDb();
    const list = apfs();
    let call = 0;
    const http = new FixtureHttp([[/apfs-cloud\.dhs\.gov\/api\/forecast/, () => (call++ === 0 ? list : list.slice(1))]]);
    const deps = await testDeps(db, http);
    expect((await runConnector(deps, 'dhs_apfs', { triggeredBy: 'test' })).status).toBe('success');
    expect((await runConnector(deps, 'dhs_apfs', { triggeredBy: 'test' })).status).toBe('success');
    const unseen = await db.one<any>(`SELECT count(*)::int AS n FROM source_records WHERE connector_id = 'dhs_apfs' AND seen_status = 'not_seen'`);
    expect(unseen.n).toBe(1);
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM opportunities`)).n).toBe(list.length);
  });
});

// ---------------------------------------------------------------------------
// Coverage honesty
// ---------------------------------------------------------------------------
describe('coverage warnings instead of green checks', () => {
  it('detects a repeated listing page (observed live on GSA Acquisition Gateway)', () => {
    const t = new PageTracker();
    expect(t.add(0, [{ nid: 1 }, { nid: 2 }])).toBeNull();
    expect(t.add(1, [{ nid: 3 }, { nid: 4 }])).toBeNull();
    expect(t.add(2, [{ nid: 3 }, { nid: 4 }])).toMatch(/repeated/);
    expect(t.unique).toBe(4);
    expect(t.duplicatePages).toBe(1);
  });

  it('a reconciliation that cannot reach every listed record is partial_success with a logged coverage warning', async () => {
    const db = await createTestDb();
    const page = fixtureJson('gsa_forecast_page.json');
    const http = new FixtureHttp([[/ag-dashboard\.acquisitiongateway\.gov/, (req) => ({ listing: { ...page.listing, total: 100, data: /page=[01]&|page=[01]$/.test(req.url) ? page.listing.data : [] } })]]);
    const r = await runConnector(await testDeps(db, http), 'gsa_forecast', { mode: 'reconcile', triggeredBy: 'test' });
    expect(r.status).toBe('partial_success');
    expect(r.message).toMatch(/Coverage warning/);
    const health = await db.one<any>(`SELECT health FROM source_connectors WHERE id = 'gsa_forecast'`);
    expect(health.health).toBe('degraded');
    const errs = await db.query<any>(`SELECT step FROM sync_errors WHERE connector_id = 'gsa_forecast'`);
    expect(errs.some((e) => e.step === 'coverage')).toBe(true);
  });

  it('flags GSA "Exercise of Option" forecasts as not a new competition', () => {
    const row = fixtureJson('gsa_forecast_page.json').listing.data[0];
    const n = normalizeForecast(row);
    expect(row.render.field_award_status).toMatch(/Exercise of Option/);
    expect(n.extra.optionExercise).toBe(true);
    expect(n.recompeteHint).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------
describe('meaningful change detection', () => {
  let db: Db;
  const desc1 = 'The contractor shall develop Power BI dashboards for executive reporting. Work is performed remotely. Offerors must hold an active SAM registration.';
  const desc2 = `${desc1} The contractor shall also migrate 40 legacy SSRS reports to Power BI Premium. All personnel must hold a Secret clearance.`;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('fingerprints scope text so cosmetic edits are ignored', () => {
    const a = scopeSentences(desc1);
    const b = scopeSentences(`<p>${desc1.toUpperCase().replace(/ /g, '  ')}</p>`);
    expect(diffScope(a.map((x) => x.hash), b).added).toEqual([]);
    const c = diffScope(a.map((x) => x.hash), scopeSentences(desc2));
    expect(c.added.length).toBe(2);
    expect(c.removedCount).toBe(0);
  });

  it('emits SCOPE_CHANGED with the added requirement text, but not for whitespace-only edits', async () => {
    const item = { ...sam(), description: desc1 };
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(item)]);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...item, description: `  ${desc1}\n\n` })]);
    expect(await db.query(`SELECT 1 FROM opportunity_events WHERE event_type = 'SCOPE_CHANGED'`)).toHaveLength(0);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...item, description: desc2 })]);
    const ev = await db.one<any>(`SELECT title, detail FROM opportunity_events WHERE event_type = 'SCOPE_CHANGED'`);
    expect(ev.title).toMatch(/2 sentence\(s\) added/);
    expect(ev.detail.addedSentences.join(' ')).toMatch(/Secret clearance/);
  });

  it('detects cancellation from the notice title (DERIVED, with basis) and emits CANCELLED', async () => {
    const item = sam();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(item)]);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...item, title: `CANCELLED - ${item.title}` })]);
    const o = await db.one<any>('SELECT status FROM opportunities');
    expect(o.status).toBe('cancelled');
    const fv = await db.one<any>(`SELECT provenance, basis FROM opportunity_field_values WHERE field = 'status' AND is_current`);
    expect(fv.provenance).toBe('derived');
    expect(fv.basis).toMatch(/cancel/i);
    expect(await db.query(`SELECT 1 FROM opportunity_events WHERE event_type = 'CANCELLED'`)).toHaveLength(1);
  });

  it('emits SOLICITATION_RELEASED when an RFI advances to a solicitation', async () => {
    const rfi = sam();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(rfi)]);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...rfi, noticeId: 'ffff0000ffff0000ffff0000ffff0000', title: 'Enterprise Data Analytics Support', type: 'Combined Synopsis/Solicitation', baseType: 'Combined Synopsis/Solicitation', postedDate: '2026-08-01' })]);
    expect(await db.query(`SELECT 1 FROM opportunity_events WHERE event_type = 'SOLICITATION_RELEASED'`)).toHaveLength(1);
  });

  it('profiles snapshotted before the new change keys existed get no spurious change events', async () => {
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...sam(), description: desc1 })]);
    const o = await db.one<any>('SELECT id FROM opportunities');
    // Simulate a pre-upgrade snapshot (no desc_sents / performance / vehicle keys) with a different hash.
    const snap = await db.one<any>('SELECT snapshot FROM opportunity_snapshots ORDER BY created_at DESC LIMIT 1');
    const old = { ...snap.snapshot };
    for (const k of ['desc_sents', 'performance_start', 'performance_end', 'questions_due', 'expected_solicitation', 'contract_vehicle', 'pricing_type']) delete old[k];
    await db.query(`INSERT INTO opportunity_snapshots (opportunity_id, canonical_hash, snapshot, created_at) VALUES ($1, 'legacy', $2::jsonb, now() + interval '1 second')`, [o.id, JSON.stringify(old)]);
    await db.query(`UPDATE opportunities SET canonical_hash = 'legacy' WHERE id = $1`, [o.id]);
    const { recomputeOpportunity } = await import('../src/server/pipeline/canonical');
    await recomputeOpportunity(db, o.id, { priorities: await connectorPriorities(db) });
    expect(await db.query(`SELECT event_type FROM opportunity_events WHERE event_type IN ('SCOPE_CHANGED','DATES_CHANGED','FIELD_CHANGED')`)).toHaveLength(0);
  });

  it('detects sole-source intent and justification notices', () => {
    expect(detectSamFlags('Notice of Intent to Sole Source', 'The Government intends to award a sole source contract to ACME under FAR 6.302-1.', 'Special Notice').soleSource).toBeTruthy();
    expect(detectSamFlags('J&A for brand name', null, 'Justification').soleSource).toMatch(/Justification/);
    const n = samNoticeToNormalized(samApiItemToNotice({ ...sam(), type: 'Justification', baseType: 'Justification' }));
    expect(n.stage).toBe('special_notice');
    expect(n.stageBasis).toMatch(/Justification/);
  });
});

// ---------------------------------------------------------------------------
// Scoring dimensions & eligibility gating
// ---------------------------------------------------------------------------
function company(over: Partial<CompanyContext> = {}): CompanyContext {
  return {
    id: 'c',
    name: 'Test',
    configured: true,
    capabilities: [{ id: '1', slug: 'power-bi', name: 'Power BI', category: 'Data', keywords: ['Power BI', 'dashboards'], strength: 5, years: 6, technologies: [] }],
    naics: ['541511'],
    primaryNaics: '541511',
    psc: [],
    certs: { '8A': 'not_held' },
    businessSize: 'small',
    samStatus: 'active',
    vehicles: [],
    clearances: [],
    facilityClearance: null,
    pastPerformance: [],
    remoteCapable: true,
    onsiteCapable: true,
    travelWillingness: 'regional',
    serviceArea: [],
    preferredLocations: [],
    excludedLocations: [],
    primeSubPreference: 'either',
    minValue: 250_000,
    preferredMaxValue: 10_000_000,
    maxRealisticValue: 25_000_000,
    preferredDurationMonths: null,
    teamCapacity: null,
    preferredAgencies: [],
    excludedAgencies: [],
    preferredTypes: [],
    excludedTypes: [],
    keywords: [],
    negativeKeywords: [],
    includeGrants: false,
    weights: { ...DEFAULT_SCORE_WEIGHTS },
    ...over,
  };
}
const oppFor = (over: Partial<OppForScoring> = {}): OppForScoring => ({
  id: 'o',
  title: 'Power BI dashboards',
  text: 'The contractor shall build Power BI dashboards and data models.',
  stage: 'solicitation',
  opportunityClass: 'prime',
  isSignal: false,
  status: 'active',
  naics: '541511',
  naicsCodes: ['541511'],
  psc: null,
  setAsideCode: null,
  setAside: null,
  department: 'Dept',
  subtier: null,
  office: null,
  valueLow: 1_000_000,
  valueHigh: 2_000_000,
  valueProvenance: 'official',
  valueLabel: 'Official estimate',
  placeState: null,
  placeCity: null,
  deadline: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  postedAt: null,
  performanceStart: null,
  performanceEnd: null,
  contractVehicle: null,
  eligibility: [],
  requirements: [],
  ...over,
});
const extras = (over: Partial<ScoringExtras> = {}): ScoringExtras => ({
  dataCompleteness: 70,
  descriptionLength: 600,
  extractedDocuments: 1,
  documentCount: 1,
  sourceCount: 2,
  hasIncumbent: false,
  officePursuits: 0,
  cancelled: false,
  optionExercise: false,
  soleSourceIntent: false,
  ...over,
});
const tfidf = new TfIdfModel(['power bi dashboards', 'janitorial services', 'construction']);

describe('separate score dimensions', () => {
  it('a perfect keyword match on an 8(a) set-aside the company does not hold cannot rank high', () => {
    const o = oppFor({ setAsideCode: '8A', setAside: '8(a)' });
    const fit = scoreOpportunity(o, company(), tfidf);
    expect(fit.eligibility.status).toBe('ineligible');
    const att = scoreAttractiveness(o, fit, company(), extras());
    const pr = computePriority({ preference: 95, attractiveness: att.score, eligibility: fit.eligibility.status, status: 'active', stage: 'solicitation', deadline: o.deadline, isSignal: false });
    expect(pr.score).toBeLessThanOrEqual(10);
    expect(pr.factors.map((f) => f.label)).toContain('Eligibility');
  });

  it('attractiveness explains every point and penalizes option exercises, cancellations and sole-source intent', () => {
    const o = oppFor();
    const fit = scoreOpportunity(o, company(), tfidf);
    const good = scoreAttractiveness(o, fit, company(), extras());
    const option = scoreAttractiveness({ ...o, stage: 'forecast' }, fit, company(), extras({ optionExercise: true }));
    const ss = scoreAttractiveness(o, fit, company(), extras({ soleSourceIntent: true }));
    expect(option.score).toBeLessThan(good.score);
    expect(ss.score).toBeLessThan(good.score);
    for (const f of good.factors) expect(f.detail.length).toBeGreaterThan(5);
  });

  it('data confidence drops and lists what is missing when the record is thin', () => {
    const o = oppFor({ valueLow: null, valueHigh: null, valueProvenance: null, deadline: null });
    const fit = scoreOpportunity(o, company(), tfidf);
    const thin = scoreConfidence(o, fit, extras({ dataCompleteness: 20, descriptionLength: 40, extractedDocuments: 0, documentCount: 0, sourceCount: 1 }));
    const rich = scoreConfidence(oppFor(), scoreOpportunity(oppFor(), company(), tfidf), extras());
    expect(thin.score).toBeLessThan(rich.score);
    expect(thin.missing).toEqual(expect.arrayContaining(['Any value information', 'Response deadline']));
  });

  it('persists the dimensions and uses priority for the "best" sort', async () => {
    const db = await createTestDb();
    await setupCompany(db, { certs: { '8A': 'not_held' } });
    const item = { ...sam(), description: 'Power BI dashboards and SQL data analytics support for executive reporting.' };
    await ingestWith(db, samOpportunitiesAdapter, [
      samRecord({ ...item, noticeId: 'aaaa', typeOfSetAside: '8A', typeOfSetAsideDescription: '8(a) Set-Aside', solicitationNumber: 'X1-8A-00001' }),
      samRecord({ ...item, noticeId: 'bbbb', typeOfSetAside: null, typeOfSetAsideDescription: null, solicitationNumber: 'X1-OPEN-00002' }),
    ]);
    await scoreMany(db, 'all');
    const rows = await db.query<any>('SELECT primary_notice_id, fit_score, priority_score, attractiveness_score, confidence_score, eligibility_status FROM opportunities ORDER BY primary_notice_id');
    expect(rows.every((r) => r.attractiveness_score != null && r.confidence_score != null && r.priority_score != null)).toBe(true);
    const blocked = rows.find((r) => r.primary_notice_id === 'AAAA' || r.primary_notice_id === 'aaaa')!;
    expect(blocked.eligibility_status).toBe('ineligible');
    const app = createApp(await testDeps(db));
    const list: any = await (await app.request('/api/opportunities?sort=best')).json();
    expect(list.items[list.items.length - 1].eligibility_status).toBe('ineligible');
  });
});

// ---------------------------------------------------------------------------
// Decisions, learning, capture, refresh safety, merge
// ---------------------------------------------------------------------------
describe('BD decisions and capture pipeline', () => {
  it('"Not eligible", "Duplicate" and "Review later" never train the preference model', () => {
    expect(DECISION_LABEL_VALUE.not_eligible).toBeNull();
    expect(DECISION_LABEL_VALUE.duplicate_irrelevant).toBeNull();
    const samples = buildSamples([
      { decision: 'not_eligible', reasons: ['requires_certification'], features: { 'naics:541511': 1 } },
      { decision: 'strong_pursue', reasons: [], features: { 'naics:541511': 1 } },
    ]);
    expect(samples).toHaveLength(1);
    expect(samples[0].y).toBe(1);
  });

  it('accepts the expanded decisions, journals capture edits and keeps them through refreshes, merges and undo', async () => {
    const db = await createTestDb();
    const app = createApp(await testDeps(db));
    const item = sam();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(item), samRecord({ ...item, noticeId: 'other00000000000000000000000000', solicitationNumber: 'ZZ-OTHER-00099', title: 'Unrelated' })]);
    const [a, b] = await db.query<any>(`SELECT id FROM opportunities ORDER BY title`);
    const post = await app.request(`/api/opportunities/${b.id}/decision`, { method: 'POST', body: JSON.stringify({ decision: 'strong_pursue', reasons: ['agency_relationship'] }), headers: { 'Content-Type': 'application/json' } });
    expect(post.status).toBe(200);

    expect((await app.request(`/api/opportunities/${b.id}/capture`, json({ pursuit_stage: 'qualified', owner: 'Dana', win_probability: 40, partners: ['Acme'] }))).status).toBe(200);
    expect((await app.request(`/api/opportunities/${b.id}/capture`, json({ pursuit_stage: 'capture', next_action: 'Meet the CO', next_action_date: '2026-11-01' }))).status).toBe(200);
    expect((await app.request(`/api/opportunities/${b.id}/capture`, json({ pursuit_stage: 'not_a_stage' }))).status).toBe(400);
    const hist = await db.query<any>(`SELECT changes FROM opportunity_capture_history WHERE opportunity_id = $1 ORDER BY changed_at`, [b.id]);
    expect(hist).toHaveLength(2);
    expect(hist[1].changes.pursuit_stage).toEqual(['qualified', 'capture']);
    await db.query(`INSERT INTO user_field_overrides (opportunity_id, field, value) VALUES ($1, 'naics_code', '"541512"')`, [b.id]);

    // Source refresh with changed content never touches capture data.
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...item, noticeId: 'other00000000000000000000000000', solicitationNumber: 'ZZ-OTHER-00099', title: 'Unrelated (amended)' })]);
    expect(await db.one<any>(`SELECT pursuit_stage, owner FROM opportunity_capture WHERE opportunity_id = $1`, [b.id])).toMatchObject({ pursuit_stage: 'capture', owner: 'Dana' });

    // Merge B into A moves capture + overrides; undo returns them.
    const priorities = await connectorPriorities(db);
    const mergeId = await mergeOpportunities(db, a.id, b.id, priorities);
    expect((await db.one<any>(`SELECT opportunity_id FROM opportunity_capture`)).opportunity_id).toBe(a.id);
    expect((await db.one<any>(`SELECT naics_code FROM opportunities WHERE id = $1`, [a.id])).naics_code).toBe('541512');
    await undoMerge(db, mergeId, priorities);
    expect((await db.one<any>(`SELECT opportunity_id FROM opportunity_capture`)).opportunity_id).toBe(b.id);
    expect((await db.one<any>(`SELECT opportunity_id FROM user_field_overrides`)).opportunity_id).toBe(b.id);

    const pipeline: any = await (await app.request('/api/pipeline')).json();
    expect(pipeline.stages.find((s: any) => s.stage === 'capture').items[0].id).toBe(b.id);
    const backup: any = await (await app.request('/api/export/backup.json')).json();
    expect(backup.opportunity_capture).toHaveLength(1);
    expect(backup.opportunity_capture_history).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Requirements, documents, recommended actions
// ---------------------------------------------------------------------------
describe('document & requirement intelligence', () => {
  it('extracts compliance, citizenship, experience, bonding, transition and sole-source requirements with strength', () => {
    const text = `Offerors must be CMMC Level 2 certified and the system shall be hosted in a FedRAMP Moderate authorized cloud.
      The contractor shall comply with NIST SP 800-171. All deliverables must conform to Section 508.
      Personnel must be U.S. citizens. The Program Manager shall have a minimum of 10 years of program management experience.
      A performance bond is required. The contractor shall submit a transition plan with a 60-day phase-in period.
      FAR 52.219-14 Limitations on Subcontracting applies. The incumbent contractor is Acme Federal LLC.
      The Government may consider Section 508 later.`;
    const reqs = extractRuleRequirements(text);
    const cats = reqs.map((r) => r.category);
    for (const c of ['security_compliance', 'citizenship', 'experience', 'bonding_insurance', 'transition', 'subcontracting_limit', 'incumbent_mention']) expect(cats).toContain(c);
    expect(reqs.find((r) => /CMMC Level 2/.test(r.text))?.strength).toBe('explicit');
    expect(reqs.find((r) => r.category === 'experience')?.text).toMatch(/10\+ years/);
    expect(reqs.find((r) => r.category === 'incumbent_mention')?.text).toMatch(/Acme Federal LLC/);
    expect(requirementStrength('the agency may later consider FedRAMP', 'security_compliance')).toBe('mentioned');
  });

  it('classifies solicitation documents by filename first, then strict text patterns', () => {
    expect(classifyDocument('Attachment 2 - PWS.pdf', null)).toBe('PWS');
    expect(classifyDocument('Section L - Instructions.docx', null)).toBe('SECTION_L');
    expect(classifyDocument('Section_M_Evaluation.pdf', null)).toBe('SECTION_M');
    expect(classifyDocument('CLIN Pricing Schedule.xlsx', null)).toBe('PRICING');
    expect(classifyDocument('DD254.pdf', null)).toBe('SECURITY');
    expect(classifyDocument('Q&A Round 1.pdf', null)).toBe('QA');
    expect(classifyDocument('SF30 Amendment 0002.pdf', null)).toBe('AMENDMENT');
    // "acknowledge amendments" inside an RFP must not make it an amendment
    expect(classifyDocument('solicitation.pdf', 'Offerors shall acknowledge all amendments. REQUEST FOR PROPOSAL')).toBe('RFP');
    expect(classifyDocument(null, 'PERFORMANCE WORK STATEMENT for help desk')).toBe('PWS');
  });

  it('recommends concrete next actions with reasons', () => {
    const acts = recommendActions({
      opportunity: { stage: 'sources_sought', status: 'active', response_deadline: new Date(Date.now() + 5 * 86_400_000).toISOString(), priority_score: 70, opportunity_class: 'prime', value_low: null, value_high: null },
      documents: [],
      contacts: [],
      requirements: [{ category: 'sole_source', text: 'Intent to award sole source' }],
      explanations: [{ kind: 'verify', text: 'Confirm small business size' }],
      vendors: [],
      relationships: [],
      currentDecision: null,
    });
    const text = acts.map((a) => a.action).join(' | ');
    expect(text).toMatch(/decision/i);
    expect(text).toMatch(/capability statement/i);
    expect(text).toMatch(/sole-source/i);
    expect(acts.every((a) => a.why.length > 5)).toBe(true);
    expect(recommendActions({ opportunity: { status: 'cancelled' }, documents: [], contacts: [], requirements: [], explanations: [], vendors: [], relationships: [], currentDecision: null })[0].action).toMatch(/Stop/);
  });
});

// ---------------------------------------------------------------------------
// USAspending IDVs
// ---------------------------------------------------------------------------
describe('USAspending IDV coverage', () => {
  it('uses "Last Date to Order" as the end of an IDV (IDIQ/BPA/GWAC)', () => {
    const a = normalizeUsaspendingAward({ search: { 'Award ID': 'N6134017D0009', generated_internal_id: 'CONT_IDV_N6134017D0009_9700', 'Last Date to Order': '2027-09-30', naics_code: '541511', psc_code: 'D308', 'Contract Award Type': 'INDEFINITE DELIVERY / INDEFINITE QUANTITY' } });
    expect(a.popCurrentEnd).toBe('2027-09-30');
    expect(a.naics).toBe('541511');
    expect(a.psc).toBe('D308');
    expect(a.idvType).toMatch(/INDEFINITE/);
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
describe('security hardening', () => {
  it('classifies private, loopback, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '52.1.2.3', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('rejects unsafe feed / document URLs, including hosts that resolve to private IPs', async () => {
    expect(() => assertSafeUrlSyntax('file:///etc/passwd')).toThrow();
    expect(() => assertSafeUrlSyntax('http://localhost:8787/api/export/backup.json')).toThrow();
    expect(() => assertSafeUrlSyntax('http://user:pw@example.com/')).toThrow();
    expect(() => assertSafeUrlSyntax('http://169.254.169.254/latest/meta-data')).toThrow();
    await expect(assertPublicUrl('https://evil.example/', async () => ['10.0.0.5'])).rejects.toThrow(/private/);
    await expect(assertPublicUrl('https://ok.example/', async () => ['93.184.216.34'])).resolves.toBeTruthy();
    const http = new FetchHttpClient();
    await expect(http.request({ url: 'http://127.0.0.1:9/x', publicOnly: true, retries: 0 })).rejects.toThrow(/Blocked unsafe URL/);
  });

  it('refuses to register a custom feed pointing at an internal address', async () => {
    const db = await createTestDb();
    const app = createApp(await testDeps(db));
    const res = await app.request('/api/sources', { method: 'POST', body: JSON.stringify({ name: 'Internal', url: 'http://localhost:5432/', format: 'rss' }), headers: { 'Content-Type': 'application/json' } });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/rejected/);
  });

  it('neutralizes spreadsheet formulas in exports (CSV injection) but keeps negative numbers', () => {
    expect(neutralizeFormula('=HYPERLINK("http://x","click")')).toBe(`'=HYPERLINK("http://x","click")`);
    expect(neutralizeFormula('+1+1')).toBe("'+1+1");
    expect(neutralizeFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeFormula('-12,500.00')).toBe('-12,500.00');
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell(-5)).toBe('-5');
  });
});

// ---------------------------------------------------------------------------
// New endpoints & exports
// ---------------------------------------------------------------------------
describe('BD endpoints and exports', () => {
  it('serves data quality, pipeline, expiring contracts, xlsx, changes CSV, dossier, provenance and brief exports', async () => {
    const db = await createTestDb();
    await setupCompany(db, { naics: ['541511'] });
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...sam(), title: '=cmd|/C calc!A0 Power BI support' })]);
    await ingestWith(db, dhsApfsAdapter, apfs().map(apfsRecord));
    await ingestWith(db, gsaForecastAdapter, [{ sourceRecordId: '1', kind: 'forecast', raw: fixtureJson('gsa_forecast_page.json').listing.data[0], retrievedAt: new Date() }]);
    await upsertAward(db, { awardKey: 'piid::EXP1', piid: 'EXP0000001', awardee: { name: 'Incumbent Inc' }, agency: { department: 'Dept' }, naics: '541511', totalObligated: 2_000_000, popCurrentEnd: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10) }, 'usaspending', null);
    await scoreMany(db, 'all');
    const opp = await db.one<any>(`SELECT id FROM opportunities WHERE connector_ids @> ARRAY['sam_opportunities']`);
    const app = createApp(await testDeps(db));

    const dq: any = await (await app.request('/api/data-quality')).json();
    expect(dq.sources.find((s: any) => s.id === 'dhs_apfs').stored_records).toBe(apfs().length);
    expect(dq.gaps.active_total).toBeGreaterThan(0);
    expect(dq.byAgency.length).toBeGreaterThan(0);

    const exp: any = await (await app.request('/api/intel/expiring?months=12')).json();
    expect(exp.items.map((i: any) => i.piid)).toContain('EXP0000001');
    expect(exp.summary.find((s: any) => s.window === '0-3' || s.window === '3-6').contracts).toBeGreaterThanOrEqual(0);

    const xlsx = await app.request('/api/opportunities/export.xlsx');
    expect(xlsx.status).toBe(200);
    expect(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');

    const csv = await (await app.request('/api/opportunities/export.csv')).text();
    expect(csv).toContain(`'=cmd|/C calc!A0 Power BI support`);
    expect(csv.split('\r\n')[0]).toContain('Value provenance');

    expect((await app.request('/api/changes/export.csv?days=30')).status).toBe(200);
    const dossier: any = await (await app.request(`/api/opportunities/${opp.id}/export.json`)).json();
    expect(dossier.format).toBe('govcheck-dossier-v1');
    expect(Array.isArray(dossier.recommendedActions)).toBe(true);
    const prov: any = await (await app.request(`/api/opportunities/${opp.id}/sources.json`)).json();
    expect(prov.records[0].raw).toBeTruthy();
    expect(prov.versions.length).toBeGreaterThan(0);
    const brief = await (await app.request(`/api/opportunities/${opp.id}/brief.md`)).text();
    expect(brief).toMatch(/Recommended next actions/);

    for (const p of ['/api/opportunities?sort=attractiveness&minConfidence=0&expiringWithinMonths=24', '/api/opportunities?captureStage=capture&owner=x&tag=y&incumbent=acme&noticeType=forecast&changeType=SCOPE_CHANGED', '/api/queues', '/api/dashboard']) {
      const r = await app.request(p);
      if (r.status !== 200) throw new Error(`${p} → ${r.status}: ${await r.text()}`);
    }
  });
});
