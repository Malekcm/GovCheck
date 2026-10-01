import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCORE_WEIGHTS } from '../src/shared/domain';
import { samOpportunitiesAdapter } from '../src/server/connectors/sam/samOpportunities';
import type { Db } from '../src/server/db';
import { evaluateEligibility } from '../src/server/scoring/eligibility';
import { scoreOpportunity } from '../src/server/scoring/fit';
import { buildSamples, extractFeatures, predict, stageForCount, trainLogistic } from '../src/server/scoring/preference';
import { loadCompanyContext } from '../src/server/scoring/profile';
import { retrainAndRescore, scoreMany } from '../src/server/scoring/run';
import { TfIdfModel } from '../src/server/scoring/similarity';
import type { CompanyContext, OppForScoring } from '../src/server/scoring/types';
import { createTestDb, fixtureJson, ingestWith, samRecord, setupCompany } from './helpers/setup';

function company(over: Partial<CompanyContext> = {}): CompanyContext {
  return {
    id: 'c',
    name: 'Test',
    configured: true,
    capabilities: [
      { id: '1', slug: 'power-bi', name: 'Power BI', category: 'Data / Analytics', keywords: ['Power BI'], strength: 5, years: 6, technologies: [] },
      { id: '2', slug: 'sql', name: 'SQL', category: 'Data / Analytics', keywords: ['SQL'], strength: 4, years: 10, technologies: [] },
      { id: '3', slug: 'program-management', name: 'Program Management', category: 'Program / Project Management', keywords: ['program management'], strength: 4, years: 8, technologies: [] },
    ],
    naics: ['541511', '541512'],
    primaryNaics: '541511',
    psc: ['DA01'],
    certs: {},
    businessSize: 'small',
    samStatus: 'active',
    vehicles: [],
    clearances: [],
    facilityClearance: null,
    pastPerformance: [{ id: 'p', name: 'Agency BI modernization', agency: 'US Customs and Border Protection', client: null, value: 3_000_000, role: 'prime', naics: ['541511'], psc: [], text: 'Built Power BI dashboards and SQL data warehouse for executive reporting', endDate: null }],
    remoteCapable: true,
    onsiteCapable: true,
    travelWillingness: 'regional',
    serviceArea: ['DC', 'VA', 'MD'],
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

function opp(over: Partial<OppForScoring> = {}): OppForScoring {
  return {
    id: 'o',
    title: 'Power BI Dashboard Development and SQL Data Integration',
    text: 'The contractor shall develop Power BI dashboards, integrate SQL Server data sources and provide program management support for executive reporting.',
    stage: 'solicitation',
    opportunityClass: 'prime',
    isSignal: false,
    status: 'active',
    naics: '541511',
    naicsCodes: ['541511'],
    psc: 'DA01',
    setAsideCode: null,
    setAside: null,
    department: 'Homeland Security, Department of',
    subtier: 'US Customs and Border Protection',
    office: 'Enterprise Services Procurement Division',
    valueLow: 2_000_000,
    valueHigh: 5_000_000,
    valueProvenance: 'official',
    valueLabel: 'Official estimate',
    placeState: 'DC',
    placeCity: 'Washington',
    deadline: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    postedAt: new Date().toISOString(),
    performanceStart: null,
    performanceEnd: null,
    contractVehicle: null,
    eligibility: [],
    requirements: [],
    ...over,
  };
}

const model = new TfIdfModel(['generic federal services', 'janitorial grounds maintenance', 'construction of buildings', 'power bi dashboards sql data']);

describe('explainable fit scoring', () => {
  it('produces all components with points, maxima and explanations that sum to the fit score', () => {
    const r = scoreOpportunity(opp(), company(), model);
    expect(r.components.map((c) => c.component)).toEqual(['capability', 'scope', 'past_performance', 'alignment', 'value', 'location', 'timeline', 'strategy']);
    const total = r.components.reduce((s, c) => s + c.points, 0);
    expect(r.fit).toBe(Math.round(total));
    for (const c of r.components) {
      expect(c.points).toBeLessThanOrEqual(c.max);
      expect(c.explanation.length).toBeGreaterThan(0);
    }
    expect(r.matchedCapabilities.map((m) => m.name)).toEqual(expect.arrayContaining(['Power BI', 'SQL', 'Program Management']));
    expect(r.fit).toBeGreaterThan(65);
  });

  it('scores unrelated work low and says why', () => {
    const r = scoreOpportunity(opp({ title: 'Janitorial and grounds maintenance', text: 'Custodial services for federal building', naics: '561720', naicsCodes: ['561720'], psc: 'S201' }), company(), model);
    expect(r.fit).toBeLessThan(40);
    expect(r.components.find((c) => c.component === 'capability')!.explanation[0]).toMatch(/None of your confirmed capabilities/);
  });

  it('respects configurable weights', () => {
    const heavy = scoreOpportunity(opp(), company({ weights: { ...DEFAULT_SCORE_WEIGHTS, capability: 60, scope: 0 } }), model);
    expect(heavy.components.find((c) => c.component === 'capability')!.max).toBe(60);
  });

  it('flags contracts far above the realistic maximum as a gap', () => {
    const r = scoreOpportunity(opp({ valueLow: 200_000_000, valueHigh: 300_000_000 }), company(), model);
    expect(r.gaps.join(' ')).toMatch(/significantly larger/);
  });
});

describe('hard eligibility rules', () => {
  it('8(a) set-aside + user explicitly not 8(a) → ineligible (as prime), with teaming note', () => {
    const r = evaluateEligibility(opp({ setAsideCode: '8A' }), company({ certs: { '8A': 'not_held' } }));
    expect(r.status).toBe('ineligible');
    expect(r.flags[0].text).toMatch(/Teaming as a subcontractor/);
  });
  it('8(a) set-aside + status unknown → unclear (never assumed ineligible)', () => {
    expect(evaluateEligibility(opp({ setAsideCode: '8A' }), company()).status).toBe('unclear');
  });
  it('8(a) set-aside + confirmed 8(a) → eligible', () => {
    expect(evaluateEligibility(opp({ setAsideCode: '8A' }), company({ certs: { '8A': 'held' } })).status).toBe('eligible');
  });
  it('small business set-aside uses the business size the user entered', () => {
    expect(evaluateEligibility(opp({ setAsideCode: 'SBA' }), company({ businessSize: 'other_than_small' })).status).toBe('ineligible');
  });
  it('detects clearance requirements from text and compares to the profile', () => {
    const text = 'All personnel must possess an active Secret clearance at time of proposal submission.';
    expect(evaluateEligibility(opp({ text }), company()).status).toBe('unclear');
    expect(evaluateEligibility(opp({ text }), company({ clearances: ['public_trust'] })).status).toBe('likely_ineligible');
    expect(evaluateEligibility(opp({ text }), company({ clearances: ['top_secret'] })).status).toBe('eligible');
  });
  it('contract vehicle restrictions require holding the vehicle', () => {
    const text = 'This task order will be issued under the GSA MAS to holders of SIN 54151S.';
    const r = evaluateEligibility(opp({ text }), company());
    expect(r.flags.some((f) => f.rule === 'vehicle')).toBe(true);
    expect(evaluateEligibility(opp({ text }), company({ vehicles: ['GSA MAS'] })).flags.some((f) => f.rule === 'vehicle')).toBe(false);
  });
  it('pre-solicitation records are at most likely eligible', () => {
    expect(evaluateEligibility(opp({ stage: 'forecast' }), company()).status).toBe('likely_eligible');
  });
});

describe('preference learning', () => {
  it('uses conservative blending by sample count', () => {
    expect(stageForCount(0)).toEqual({ stage: 'base_only', alpha: 0 });
    expect(stageForCount(5).alpha).toBeLessThan(0.1);
    expect(stageForCount(12).stage).toBe('small');
    expect(stageForCount(30).stage).toBe('moderate');
    expect(stageForCount(80).stage).toBe('strong');
  });

  it('learns the direction of user preferences from decisions and reasons', () => {
    const fit = scoreOpportunity(opp(), company(), model);
    const good = extractFeatures(opp({ department: 'Agency A' }), fit);
    const bad = extractFeatures(opp({ department: 'Agency B' }), fit);
    const decisions = [
      ...Array.from({ length: 8 }, () => ({ decision: 'pursue' as const, reasons: ['good_agency'], features: good })),
      ...Array.from({ length: 8 }, () => ({ decision: 'pass' as const, reasons: ['wrong_agency'], features: bad })),
    ];
    const m = trainLogistic(buildSamples(decisions));
    expect(predict(m, good)).toBeGreaterThan(0.6);
    expect(predict(m, bad)).toBeLessThan(0.4);
    expect(m.weights.get('agency:AGENCY A')!).toBeGreaterThan(0);
    expect(m.weights.get('agency:AGENCY B')!).toBeLessThan(0);
  });
});

describe('scoring + feedback persistence (database)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
    await setupCompany(db);
  });

  it('persists components, explanations and history; retraining keeps base fit independent', async () => {
    const item = fixtureJson('sam_opportunity_sources_sought.json');
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(item)]);
    expect(await scoreMany(db, 'all')).toBe(1);
    const o = await db.one<any>('SELECT id, fit_score, preference_score, eligibility_status, discovery_reasons FROM opportunities');
    expect(o.fit_score).toBeGreaterThan(0);
    expect(o.preference_score).toBe(o.fit_score); // no decisions yet → preference = base fit
    expect(o.discovery_reasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(['source:sam_opportunities', 'naics']));
    expect((await db.query('SELECT * FROM match_score_components')).length).toBe(8);

    // PASS, then change to PURSUE: history kept, model retrained each time, base fit unchanged
    await db.query(`INSERT INTO user_opportunity_decisions (opportunity_id, decision, reasons) VALUES ($1,'pass','{wrong_scope}')`, [o.id]);
    const m1 = await retrainAndRescore(db, 'test pass');
    await db.query('UPDATE user_opportunity_decisions SET is_current = false WHERE opportunity_id = $1', [o.id]);
    await db.query(`INSERT INTO user_opportunity_decisions (opportunity_id, decision, reasons) VALUES ($1,'pursue','{excellent_capability_fit}')`, [o.id]);
    const m2 = await retrainAndRescore(db, 'test pursue');
    expect(m2.version).toBe(m1.version + 1);
    expect((await db.query('SELECT * FROM user_opportunity_decisions WHERE opportunity_id = $1', [o.id])).length).toBe(2);
    const after = await db.one<any>('SELECT fit_score, preference_score FROM opportunities');
    expect(after.fit_score).toBe(o.fit_score);
    const models = await db.query<any>('SELECT version, sample_count, is_active FROM preference_models ORDER BY version');
    expect(models.filter((x) => x.is_active)).toHaveLength(1);
    const co = await loadCompanyContext(db);
    expect(co.capabilities.length).toBe(5);
  });
});
