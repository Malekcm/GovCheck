import type { Db } from '../db';
import { formatMoney } from '../lib/money';
import { findPhrase, htmlToText, nameKey, titleCase, truncate } from '../lib/text';
import type { CompanyContext } from '../scoring/types';
import { TfIdfModel } from '../scoring/similarity';
import { addIdentifiers, setDates, setFieldValues } from './apply';
import { applyAwardFacts, linkAwardExact, linkAwardToOpportunity } from './awards';
import { recomputeOpportunity } from './canonical';
import { recompeteWindow } from './enrich';
import { recordEvent } from './events';
import { linkSource, upsertRelationship } from './resolve';

interface Award {
  id: string;
  piid: string | null;
  piid_key: string | null;
  usaspending_id: string | null;
  description: string | null;
  awardee_name: string | null;
  vendor_id: string | null;
  department_name: string | null;
  subtier_name: string | null;
  office_name: string | null;
  naics_code: string | null;
  psc_code: string | null;
  place_state: string | null;
  place_city: string | null;
  date_signed: string | null;
  pop_start: string | null;
  pop_current_end: string | null;
  pop_potential_end: string | null;
  total_obligated: number | null;
  base_and_all_options: number | null;
  dollars_obligated: number | null;
  connector_id: string;
  source_record_id: string | null;
  solicitation_id: string | null;
  referenced_idv_piid: string | null;
}

export interface RecompeteResult {
  candidates: number;
  signalsCreated: number;
  signalsRefreshed: number;
  successorsLinked: number;
  createdIds: string[];
  touchedIds: string[];
}

function relevant(a: Award, co: CompanyContext): { ok: boolean; why: string[] } {
  const why: string[] = [];
  if (a.naics_code && co.naics.includes(a.naics_code)) why.push(`NAICS ${a.naics_code} is in your profile`);
  if (a.psc_code && co.psc.includes(a.psc_code)) why.push(`PSC ${a.psc_code} is in your preferences`);
  const text = (a.description ?? '').toLowerCase();
  const caps = co.capabilities.filter((c) => [c.name, ...c.keywords].some((k) => k.length > 3 && findPhrase(text, k) >= 0));
  if (caps.length) why.push(`Description references ${caps.slice(0, 3).map((c) => c.name).join(', ')}`);
  return { ok: why.length > 0, why };
}

/**
 * Identify expiring contracts relevant to the company and, when no successor procurement
 * can be found, create POSSIBLE RECOMPETE intelligence profiles. These are always flagged
 * as signals — never as active solicitations.
 */
export async function runRecompeteEngine(db: Db, co: CompanyContext, priorities: Map<string, number>, opts: { horizonMonths?: number; minValue?: number } = {}): Promise<RecompeteResult> {
  const horizon = opts.horizonMonths ?? 18;
  const minValue = opts.minValue ?? Math.max(100_000, (co.minValue ?? 0) * 0.5);
  const res: RecompeteResult = { candidates: 0, signalsCreated: 0, signalsRefreshed: 0, successorsLinked: 0, createdIds: [], touchedIds: [] };
  if (!co.naics.length && !co.psc.length && !co.capabilities.length) return res;

  const awards = await db.query<Award>(
    `SELECT * FROM awards
     WHERE award_key NOT LIKE 'sam_notice:%' AND pop_current_end >= current_date AND pop_current_end <= current_date + ($1::int * interval '1 month')
       AND COALESCE(base_and_all_options, total_obligated, dollars_obligated, 0) >= $2
     ORDER BY pop_current_end ASC LIMIT 2000`,
    [horizon, minValue],
  );
  for (const a of awards) {
    const rel = relevant(a, co);
    if (!rel.ok || !a.piid_key) continue;
    res.candidates++;

    // A non-signal record (e.g. a DHS forecast) that names this contract as its predecessor IS the
    // successor procurement: link it exactly and do not invent a separate signal.
    const namedSuccessor = await db.one<{ opportunity_id: string }>(
      `SELECT oi.opportunity_id FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id
       WHERE oi.id_type = 'predecessor_piid' AND oi.normalized_value = $1 AND o.merged_into_id IS NULL AND NOT o.is_signal LIMIT 1`,
      [a.piid_key],
    );
    if (namedSuccessor) {
      await linkAwardExact(db, a.id);
      await recomputeOpportunity(db, namedSuccessor.opportunity_id, { priorities });
      res.successorsLinked++;
      res.touchedIds.push(namedSuccessor.opportunity_id);
    }
    const existingSignal = await db.one<{ opportunity_id: string }>(
      `SELECT oi.opportunity_id FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id
       WHERE oi.id_type = 'predecessor_piid' AND oi.normalized_value = $1 AND o.merged_into_id IS NULL AND o.is_signal LIMIT 1`,
      [a.piid_key],
    );
    if (namedSuccessor && !existingSignal) continue;
    if (existingSignal) {
      await refreshSignalFacts(db, existingSignal.opportunity_id, a);
      await recomputeOpportunity(db, existingSignal.opportunity_id, { priorities });
      res.signalsRefreshed++;
      res.touchedIds.push(existingSignal.opportunity_id);
      continue;
    }

    const successor = await findSuccessor(db, a);
    if (successor) {
      const evidence = [...successor.evidence, `Contract ${a.piid} (${a.awardee_name ?? 'unknown vendor'}) ends ${a.pop_current_end}`];
      const isNew = await linkAwardToOpportunity(db, successor.id, a.id, { relationship: 'possible_incumbent', confidence: successor.score >= 0.5 ? 'medium' : 'low', confidenceScore: successor.score, method: 'probabilistic', evidence });
      await applyAwardFacts(db, successor.id, a as any, 'possible_incumbent', successor.score >= 0.5 ? 'medium' : 'low');
      if (isNew) {
        await recordEvent(db, successor.id, {
          type: 'RECOMPETE_SIGNAL',
          title: `Possible follow-on to expiring contract ${a.piid} (${a.awardee_name ?? 'unknown'}, ends ${a.pop_current_end})`,
          dedupeKey: `recompete-successor:${a.id}`,
          detail: { awardId: a.id, evidence },
        });
      }
      await recomputeOpportunity(db, successor.id, { priorities });
      res.successorsLinked++;
      res.touchedIds.push(successor.id);
      continue;
    }

    const id = await createRecompeteSignal(db, a, rel.why, priorities);
    res.signalsCreated++;
    res.createdIds.push(id);
    res.touchedIds.push(id);
  }
  return res;
}

async function findSuccessor(db: Db, a: Award): Promise<{ id: string; score: number; evidence: string[] } | null> {
  if (!a.subtier_name && !a.department_name) return null;
  const end = a.pop_current_end ? new Date(a.pop_current_end) : new Date();
  const cutoff = new Date(end.getTime() - 24 * 30.4375 * 86_400_000);
  const cands = await db.query<{ id: string; title: string; description: string | null; office_name: string | null; subtier_name: string | null; department_name: string | null; stage: string }>(
    `SELECT id, title, description, office_name, subtier_name, department_name, stage FROM opportunities
     WHERE merged_into_id IS NULL AND NOT is_signal AND stage <> 'award' AND opportunity_class = 'prime'
       AND (naics_code = $1 OR ($2::text IS NOT NULL AND psc_code = $2)) AND COALESCE(posted_at, created_at) >= $3 LIMIT 300`,
    [a.naics_code, a.psc_code, cutoff],
  );
  const agencyKey = nameKey(a.subtier_name ?? a.department_name);
  const filtered = cands.filter((c) => nameKey(c.subtier_name) === agencyKey || nameKey(c.department_name) === agencyKey);
  if (!filtered.length || !a.description) return null;
  const model = new TfIdfModel([a.description, ...filtered.map((c) => `${c.title} ${htmlToText(c.description ?? '').slice(0, 2000)}`)]);
  const av = model.vector(a.description);
  let best: { id: string; score: number; evidence: string[] } | null = null;
  for (const c of filtered) {
    const sim = model.cosine(av, model.vector(`${c.title} ${htmlToText(c.description ?? '').slice(0, 2000)}`));
    const sameOffice = !!a.office_name && nameKey(c.office_name) === nameKey(a.office_name);
    const score = sim * 0.75 + (sameOffice ? 0.25 : 0);
    if (score >= 0.3 && (!best || score > best.score)) best = { id: c.id, score: Number(score.toFixed(3)), evidence: [`Scope similarity ${Math.round(sim * 100)}%`, sameOffice ? 'Same contracting office' : 'Same agency', `Posted within 24 months of contract expiration`] };
  }
  return best;
}

async function refreshSignalFacts(db: Db, oppId: string, a: Award): Promise<void> {
  const official = { opportunityId: oppId, connectorId: a.connector_id, sourceRecordId: a.source_record_id };
  await setDates(db, official, [
    ...(a.pop_start ? [{ kind: 'performance_start', value: new Date(a.pop_start).toISOString() }] : []),
    ...(a.pop_current_end ? [{ kind: 'performance_end', value: new Date(a.pop_current_end).toISOString() }] : []),
    ...(a.pop_potential_end ? [{ kind: 'potential_end', value: new Date(a.pop_potential_end).toISOString() }] : []),
  ]);
  if (a.pop_current_end) {
    const w = recompeteWindow(new Date(a.pop_current_end));
    await setDates(db, { opportunityId: oppId, connectorId: 'derived:recompete', sourceRecordId: null }, [
      { kind: 'recompete_window_start', value: w.start.toISOString(), provenance: 'derived', basis: 'Follow-on solicitations are typically released 3–12 months before the incumbent contract expires.' },
      { kind: 'recompete_window_end', value: w.end.toISOString(), provenance: 'derived', basis: 'Follow-on solicitations are typically released 3–12 months before the incumbent contract expires.' },
    ]);
  }
  await applyAwardFacts(db, oppId, a as any, 'incumbent', 'high');
}

export async function createRecompeteSignal(db: Db, a: Award, why: string[], priorities: Map<string, number>): Promise<string> {
  const title = `Possible recompete: ${truncate(titleCase(a.description ?? `Contract ${a.piid}`), 110)}`;
  const row = await db.one<{ id: string }>(
    `INSERT INTO opportunities (title, opportunity_class, stage, status, is_signal) VALUES ($1,'intelligence','recompete_signal','signal',true) RETURNING id`,
    [title],
  );
  const oppId = row!.id;
  const derived = { opportunityId: oppId, connectorId: 'derived:recompete', sourceRecordId: null };
  const official = { opportunityId: oppId, connectorId: a.connector_id, sourceRecordId: a.source_record_id };
  if (a.source_record_id) await linkSource(db, oppId, a.source_record_id, 'created', 1, ['Intelligence profile generated from this expiring award record'], 'historical');
  await addIdentifiers(
    db,
    oppId,
    [
      ...(a.piid ? [{ type: 'predecessor_piid' as const, value: a.piid }] : []),
      ...(a.usaspending_id ? [{ type: 'usaspending_award_id' as const, value: a.usaspending_id }] : []),
    ],
    a.source_record_id,
  );
  const value = a.base_and_all_options ?? a.total_obligated ?? a.dollars_obligated;
  const basis = 'Generated by the recompete engine: an existing contract in your NAICS/PSC/capability area ends within the horizon and no successor procurement was found in connected sources.';
  await setFieldValues(db, derived, [
    { field: 'title', value: title, provenance: 'derived', basis },
    { field: 'opportunity_class', value: 'intelligence', provenance: 'derived', basis },
    { field: 'stage', value: 'recompete_signal', provenance: 'derived', basis },
    { field: 'status', value: 'signal', provenance: 'derived', basis },
    {
      field: 'description',
      value: `INTELLIGENCE SIGNAL — NOT AN ACTIVE SOLICITATION.\n\nContract ${a.piid}${a.referenced_idv_piid ? ` (order under ${a.referenced_idv_piid})` : ''} awarded to ${a.awardee_name ?? 'an unknown vendor'} by ${a.office_name ?? a.subtier_name ?? a.department_name ?? 'the agency'} ends on ${a.pop_current_end}${a.pop_potential_end && a.pop_potential_end !== a.pop_current_end ? ` (potential end with options: ${a.pop_potential_end})` : ''}. Recorded value: ${formatMoney(value)}.\n\nOfficial award description: ${a.description ?? 'not provided'}\n\nWhy this was flagged: ${why.join('; ')}.`,
      provenance: 'derived',
      basis,
    },
  ]);
  await setFieldValues(db, official, [
    { field: 'department', value: a.department_name },
    { field: 'subtier', value: a.subtier_name },
    { field: 'office', value: a.office_name },
    { field: 'naics_code', value: a.naics_code },
    { field: 'naics_codes', value: a.naics_code ? [a.naics_code] : [] },
    { field: 'psc_code', value: a.psc_code },
    { field: 'place', value: a.place_state || a.place_city ? { state: a.place_state, city: a.place_city } : null },
    { field: 'performance_start', value: a.pop_start },
    { field: 'performance_end', value: a.pop_current_end },
  ]);
  await refreshSignalFacts(db, oppId, a);
  await linkAwardToOpportunity(db, oppId, a.id, { relationship: 'incumbent', confidence: 'high', method: 'exact', evidence: ['This profile was generated from the incumbent contract record.'] });
  await recordEvent(db, oppId, {
    type: 'RECOMPETE_SIGNAL',
    title: `Expiring contract ${a.piid} (${a.awardee_name ?? 'unknown vendor'}) ends ${a.pop_current_end} — no successor procurement detected`,
    dedupeKey: `recompete:${a.id}`,
    occurredAt: new Date(),
    detail: { awardId: a.id, why },
  });
  if (a.date_signed)
    await recordEvent(db, oppId, { type: 'LIFECYCLE', isLifecycle: true, lifecycleStage: 'award', title: `Incumbent contract ${a.piid} signed with ${a.awardee_name ?? 'unknown vendor'}`, occurredAt: a.date_signed, dedupeKey: `life-award:${a.id}`, connectorId: a.connector_id, sourceRecordId: a.source_record_id });
  if (a.pop_current_end)
    await recordEvent(db, oppId, { type: 'LIFECYCLE', isLifecycle: true, lifecycleStage: 'contract_end', title: `Incumbent contract current completion date`, occurredAt: a.pop_current_end, dedupeKey: `life-end:${a.id}`, connectorId: a.connector_id, sourceRecordId: a.source_record_id });
  await recomputeOpportunity(db, oppId, { priorities, isNew: true });
  // A signal might correspond to a forecast already in the database.
  const forecasts = await db.query<{ id: string; title: string }>(
    `SELECT id, title FROM opportunities WHERE stage = 'forecast' AND merged_into_id IS NULL AND naics_code = $1 AND (subtier_name ILIKE $2 OR department_name ILIKE $2) LIMIT 100`,
    [a.naics_code, a.subtier_name ?? a.department_name ?? '___'],
  );
  if (forecasts.length && a.description) {
    const model = new TfIdfModel([a.description, ...forecasts.map((f) => f.title)]);
    for (const f of forecasts) {
      const sim = model.similarity(a.description, f.title);
      if (sim >= 0.3) await upsertRelationship(db, f.id, oppId, 'possible_same_procurement', Number(Math.min(0.9, 0.4 + sim).toFixed(2)), 'probabilistic', [`Forecast title similar to expiring contract description (${Math.round(sim * 100)}%)`, 'Same agency and NAICS']);
    }
  }
  return oppId;
}

