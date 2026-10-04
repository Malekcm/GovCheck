import { beforeEach, describe, expect, it } from 'vitest';
import { samBulkAdapter } from '../src/server/connectors/sam/samBulk';
import { samOpportunitiesAdapter } from '../src/server/connectors/sam/samOpportunities';
import { usaspendingAdapter } from '../src/server/connectors/usaspending';
import type { RawRecord } from '../src/server/connectors/types';
import type { Db } from '../src/server/db';
import { connectorPriorities } from '../src/server/connectors/registry';
import { markUnseen } from '../src/server/pipeline/ingest';
import { mergeOpportunities, undoMerge } from '../src/server/pipeline/merge';
import { computeCoverage } from '../src/server/pipeline/coverage';
import { createTestDb, fixtureJson, ingestWith, samRecord } from './helpers/setup';

const base = () => fixtureJson('sam_opportunity_sources_sought.json');

function solicitationFor(sourcesSought: any, over: Record<string, unknown> = {}) {
  return {
    ...sourcesSought,
    noticeId: 'f0f0f0f0aaaabbbbccccdddd00001111',
    title: 'Enterprise Data Analytics and Power BI Dashboard Support',
    type: 'Combined Synopsis/Solicitation',
    baseType: 'Combined Synopsis/Solicitation',
    postedDate: '2026-08-01',
    responseDeadLine: '2026-09-15T17:00:00-04:00',
    ...over,
  };
}

async function oppCount(db: Db) {
  return (await db.one<{ n: number }>('SELECT count(*)::int AS n FROM opportunities WHERE merged_into_id IS NULL'))!.n;
}

describe('ingestion, entity resolution and durability', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createTestDb();
  });

  it('stores the raw source record verbatim with a content hash and parser version', async () => {
    const item = base();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(item)]);
    const sr = await db.one<any>('SELECT * FROM source_records');
    expect(sr.raw).toEqual(item);
    expect(sr.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sr.parser_version).toBe(samOpportunitiesAdapter.parserVersion);
    expect(sr.normalized.data.stage).toBe('rfi');
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM source_record_versions'))!.n).toBe(1);
  });

  it('prevents duplicates: re-ingesting the same record is a no-op', async () => {
    const r1 = await ingestWith(db, samOpportunitiesAdapter, [samRecord(base())]);
    const r2 = await ingestWith(db, samOpportunitiesAdapter, [samRecord(base())]);
    expect(r1.results).toEqual(['new']);
    expect(r2.results).toEqual(['unchanged']);
    expect(await oppCount(db)).toBe(1);
  });

  it('exact match: the same notice from the API and from the bulk CSV consolidate into one profile', async () => {
    const item = base();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(item)]);
    const csvRow = {
      NoticeId: item.noticeId,
      Title: item.title,
      'Sol#': item.solicitationNumber,
      'Department/Ind.Agency': 'HOMELAND SECURITY, DEPARTMENT OF',
      'Sub-Tier': 'US CUSTOMS AND BORDER PROTECTION',
      Office: 'ENTERPRISE SERVICES PROCUREMENT DIVISION',
      Type: 'Sources Sought',
      PostedDate: '2026-06-01 09:00:00',
      NaicsCode: '541511',
      Description: 'Full description text from the bulk extract, which the API only provides by URL.',
      Active: 'Yes',
    };
    await ingestWith(db, samBulkAdapter, [{ sourceRecordId: item.noticeId, kind: 'opportunity', raw: csvRow, retrievedAt: new Date() }]);
    expect(await oppCount(db)).toBe(1);
    const opp = await db.one<any>('SELECT * FROM opportunities');
    expect(opp.connector_ids.sort()).toEqual(['sam_bulk', 'sam_opportunities']);
    expect(opp.source_count).toBe(2);
    expect(opp.description).toContain('Full description text'); // filled from the second source
  });

  it('exact solicitation-number matching links the lifecycle (RFI → solicitation) and advances the stage', async () => {
    const rfi = base();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(rfi)]);
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(solicitationFor(rfi))]);
    expect(await oppCount(db)).toBe(1);
    const opp = await db.one<any>('SELECT * FROM opportunities');
    expect(opp.stage).toBe('combined_synopsis');
    // Lifecycle-anchored field: deadline comes from the solicitation, not the RFI.
    expect(new Date(opp.response_deadline).toISOString()).toBe('2026-09-15T21:00:00.000Z');
    const lifecycle = await db.query<any>(`SELECT lifecycle_stage FROM opportunity_events WHERE is_lifecycle ORDER BY occurred_at`);
    expect(lifecycle.map((e) => e.lifecycle_stage)).toEqual(['rfi', 'combined_synopsis']);
    const events = await db.query<any>(`SELECT event_type FROM opportunity_events`);
    expect(events.map((e) => e.event_type)).toEqual(expect.arrayContaining(['NEW_OPPORTUNITY', 'NEW_SOURCE', 'STAGE_CHANGED', 'DEADLINE_CHANGED']));
  });

  it('does not merge identical solicitation numbers from different agencies', async () => {
    const a = base();
    const b = { ...solicitationFor(a), noticeId: 'zzzz0000', fullParentPathName: 'AGRICULTURE, DEPARTMENT OF.FOREST SERVICE.USDA-FS CSA EAST' };
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(a), samRecord(b)]);
    expect(await oppCount(db)).toBe(2);
  });

  it('retains every version of a changed source record and detects field changes', async () => {
    const item = base();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(item)]);
    const changed = { ...item, responseDeadLine: '2026-06-27T17:00:00-04:00', postedDate: '2026-06-05' };
    const r = await ingestWith(db, samOpportunitiesAdapter, [samRecord(changed)]);
    expect(r.results).toEqual(['changed']);
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM source_record_versions'))!.n).toBe(2);
    const sr = await db.one<any>('SELECT version_count FROM source_records');
    expect(sr.version_count).toBe(2);
    const ev = await db.query<any>(`SELECT event_type, title FROM opportunity_events WHERE event_type IN ('DEADLINE_CHANGED','AMENDMENT')`);
    expect(ev.map((e) => e.event_type).sort()).toEqual(['AMENDMENT', 'DEADLINE_CHANGED']);
    expect(ev.find((e) => e.event_type === 'DEADLINE_CHANGED').title).toContain('2026-06-20 → 2026-06-27');
    // History of the field value is kept, not overwritten.
    const deadlines = await db.query<any>(`SELECT is_current FROM opportunity_field_values WHERE field = 'response_deadline'`);
    expect(deadlines.map((d) => d.is_current).sort()).toEqual([false, true]);
  });

  it('a refresh never removes user decisions, notes, tags or manual links', async () => {
    const item = base();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(item)]);
    const opp = await db.one<{ id: string }>('SELECT id FROM opportunities');
    await db.query(`INSERT INTO user_opportunity_decisions (opportunity_id, decision, reasons, explanation) VALUES ($1,'pursue','{excellent_capability_fit}','Great fit')`, [opp!.id]);
    await db.query(`INSERT INTO user_notes (opportunity_id, body) VALUES ($1,'Call the CO')`, [opp!.id]);
    await db.query(`INSERT INTO user_tags (opportunity_id, tag) VALUES ($1,'priority')`, [opp!.id]);
    // refresh with changed content, then a full-listing pass where the record disappears
    await ingestWith(db, samOpportunitiesAdapter, [samRecord({ ...item, title: `${item.title} (Amended)` })]);
    await markUnseen(db, 'sam_opportunities', new Date(Date.now() + 1000));
    expect(await db.one<any>('SELECT decision, explanation FROM user_opportunity_decisions WHERE is_current')).toMatchObject({ decision: 'pursue', explanation: 'Great fit' });
    expect((await db.one<any>('SELECT body FROM user_notes'))!.body).toBe('Call the CO');
    expect((await db.one<any>('SELECT tag FROM user_tags'))!.tag).toBe('priority');
    // Disappeared from the source: marked, never deleted.
    const o = await db.one<any>('SELECT seen_status FROM opportunities');
    expect(o.seen_status).toBe('not_seen');
    expect((await db.one<any>('SELECT seen_status FROM source_records')).seen_status).toBe('not_seen');
    expect(await oppCount(db)).toBe(1);
  });

  it('links a USAspending award to the solicitation by solicitation ID and records the incumbent with provenance', async () => {
    const item = base();
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(solicitationFor(item))]);
    const award: RawRecord = {
      sourceRecordId: 'CONT_AWD_70RDAD26F00000001_7014_-NONE-_-NONE-',
      kind: 'award',
      retrievedAt: new Date(),
      raw: {
        search: { generated_internal_id: 'CONT_AWD_70RDAD26F00000001_7014_-NONE-_-NONE-', 'Award ID': '70RDAD26F00000001', 'Recipient Name': 'ACME ANALYTICS LLC', 'Award Amount': 2400000, 'Start Date': '2026-10-01', 'End Date': '2027-09-30' },
        detail: {
          piid: '70RDAD26F00000001',
          generated_unique_award_id: 'CONT_AWD_70RDAD26F00000001_7014_-NONE-_-NONE-',
          total_obligation: 2400000,
          base_and_all_options: 9800000,
          date_signed: '2026-09-25',
          recipient: { recipient_name: 'ACME ANALYTICS LLC', recipient_uei: 'ABCDEF123456' },
          period_of_performance: { start_date: '2026-10-01', end_date: '2027-09-30', potential_end_date: '2030-09-30 00:00:00' },
          awarding_agency: { toptier_agency: { name: 'Department of Homeland Security' }, subtier_agency: { name: 'U.S. Customs and Border Protection' } },
          latest_transaction_contract_data: { solicitation_identifier: '70RDAD26RFI0042', type_set_aside_description: 'SMALL BUSINESS SET ASIDE - TOTAL' },
        },
      },
    };
    await ingestWith(db, usaspendingAdapter, [award]);
    const link = await db.one<any>(`SELECT relationship, confidence, method, evidence FROM opportunity_awards`);
    expect(link).toMatchObject({ relationship: 'award_of', confidence: 'high', method: 'exact' });
    expect(link.evidence[0]).toMatch(/solicitation ID/);
    const opp = await db.one<any>('SELECT incumbent_name, has_incumbent FROM opportunities');
    expect(opp).toMatchObject({ incumbent_name: 'ACME ANALYTICS LLC', has_incumbent: true });
    const fin = await db.query<any>(`SELECT kind, amount_low, provenance FROM opportunity_financials WHERE is_current ORDER BY kind`);
    expect(fin).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'potential_value', amount_low: 9800000, provenance: 'official' })]));
    expect((await db.query(`SELECT 1 FROM opportunity_events WHERE event_type = 'AWARD_POSTED'`)).length).toBe(1);
  });

  it('PIID matching links a SAM award notice to the contract record', async () => {
    const notice = { ...base(), noticeId: 'award0001', type: 'Award Notice', baseType: 'Award Notice', title: 'Award - Data Analytics', award: { number: '70RDAD26F00000077', amount: '1500000', date: '2026-09-01', awardee: { name: 'BETA DATA INC', ueiSAM: 'ZZZZZZ999999' } } };
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(notice)]);
    const award: RawRecord = {
      sourceRecordId: 'CONT_AWD_70RDAD26F00000077',
      kind: 'award',
      retrievedAt: new Date(),
      raw: { search: { generated_internal_id: 'CONT_AWD_70RDAD26F00000077', 'Award ID': '70RDAD26F00000077', 'Recipient Name': 'BETA DATA INC', 'Award Amount': 1500000, 'End Date': '2027-08-31' } },
    };
    await ingestWith(db, usaspendingAdapter, [award]);
    const links = await db.query<any>(`SELECT a.award_key, oa.relationship FROM opportunity_awards oa JOIN awards a ON a.id = oa.award_id ORDER BY a.award_key`);
    expect(links.map((l) => l.relationship)).toEqual(['award_of', 'award_of']);
    expect(links.map((l) => l.award_key)).toEqual(['piid::70RDAD26F00000077', 'sam_notice:award0001']);
    const opp = await db.one<any>('SELECT stage, status FROM opportunities');
    expect(opp).toMatchObject({ stage: 'award', status: 'awarded' });
  });

  it('suggests (but never auto-merges) probabilistic relationships', async () => {
    const a = { ...base(), solicitationNumber: null, noticeId: 'prob-a', title: 'Power BI Dashboard Development and Data Analytics Support Services' };
    const b = { ...base(), solicitationNumber: null, noticeId: 'prob-b', title: 'Data Analytics Support Services and Power BI Dashboard Development', type: 'Solicitation', baseType: 'Solicitation', postedDate: '2026-07-15' };
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(a), samRecord(b)]);
    expect(await oppCount(db)).toBe(2);
    const rel = await db.one<any>(`SELECT relationship_type, status, method, confidence, evidence FROM opportunity_relationships`);
    expect(rel.status).toBe('suggested');
    expect(rel.method).toBe('probabilistic');
    expect(['possible_same_procurement', 'possible_duplicate', 'related']).toContain(rel.relationship_type);
    expect(Number(rel.confidence)).toBeGreaterThan(0.5);
    expect(rel.evidence.join(' ')).toMatch(/Same contracting office/);
  });

  it('merges two profiles and fully undoes the merge, keeping user data with its original profile', async () => {
    const a = { ...base(), solicitationNumber: null, noticeId: 'm-a', title: 'Dashboard modernization' };
    const b = { ...base(), solicitationNumber: null, noticeId: 'm-b', title: 'Totally different requirement for janitorial services', naicsCode: '561720', naicsCodes: ['561720'] };
    await ingestWith(db, samOpportunitiesAdapter, [samRecord(a), samRecord(b)]);
    const [pa, pb] = (await db.query<{ id: string }>(`SELECT id FROM opportunities ORDER BY title`)).map((r) => r.id);
    await db.query(`INSERT INTO user_notes (opportunity_id, body) VALUES ($1,'note on B')`, [pb]);
    const priorities = await connectorPriorities(db);
    const mergeId = await mergeOpportunities(db, pa, pb, priorities, 'test');
    expect(await oppCount(db)).toBe(1);
    expect((await db.one<any>('SELECT opportunity_id FROM user_notes'))!.opportunity_id).toBe(pa);
    expect((await db.one<any>('SELECT source_count FROM opportunities WHERE id = $1', [pa])).source_count).toBe(2);
    await undoMerge(db, mergeId, priorities);
    expect(await oppCount(db)).toBe(2);
    expect((await db.one<any>('SELECT opportunity_id FROM user_notes'))!.opportunity_id).toBe(pb);
    expect((await db.one<any>('SELECT source_count FROM opportunities WHERE id = $1', [pa])).source_count).toBe(1);
  });

  it('coverage analysis flags forecast-only records', async () => {
    const row = fixtureJson('gsa_forecast_page.json').listing.data[0];
    const { gsaForecastAdapter } = await import('../src/server/connectors/gsaForecast');
    await ingestWith(db, gsaForecastAdapter, [{ sourceRecordId: String(row.nid), kind: 'forecast', raw: row, retrievedAt: new Date() }]);
    await db.query('UPDATE opportunities SET fit_score = 60');
    const r = await computeCoverage(db);
    expect(r.byType.FORECAST_ONLY ?? r.byType.FORECAST_OVERDUE).toBe(1);
  });
});
