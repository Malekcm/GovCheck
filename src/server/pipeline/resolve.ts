import { STAGE_ORDER, type Stage } from '../../shared/domain';
import type { Db } from '../db';
import { json } from '../db';
import { normalizeIdentifier, matchGroupOf, STRONG_IDENTIFIER_TYPES } from '../lib/ids';
import { htmlToText, nameKey } from '../lib/text';
import type { NormalizedOpportunity } from '../connectors/types';
import { TfIdfModel, jaccard } from '../scoring/similarity';
import { recordEvent } from './events';

export interface ResolveResult {
  opportunityId: string;
  created: boolean;
  method: 'existing_link' | 'exact' | 'created';
  evidence: string[];
}

/** Follow merge pointers to the surviving profile. */
export async function survivingId(db: Db, id: string): Promise<string> {
  let cur = id;
  for (let i = 0; i < 10; i++) {
    const row = await db.one<{ merged_into_id: string | null }>('SELECT merged_into_id FROM opportunities WHERE id = $1', [cur]);
    if (!row?.merged_into_id) return cur;
    cur = row.merged_into_id;
  }
  return cur;
}

function agenciesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return true; // unknown on one side: identifier decides
  if (ka === kb) return true;
  // Tolerate naming variants ("DEPT OF DEFENSE" vs "DEPARTMENT OF DEFENSE")
  const norm = (k: string) => k.replace(/\bDEPT\b/g, 'DEPARTMENT').replace(/\bTHE\b/g, '').replace(/\s+/g, ' ').trim();
  const na = norm(ka);
  const nb = norm(kb);
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Find (or create) the profile a normalized record belongs to.
 * Only strong identifiers auto-link. Similar-looking records are NOT merged here;
 * they get suggested relationships for human review (see suggestRelationships).
 */
export async function resolveOpportunity(db: Db, n: NormalizedOpportunity, sourceRecordId: string): Promise<ResolveResult> {
  const link = await db.one<{ opportunity_id: string }>('SELECT opportunity_id FROM opportunity_sources WHERE source_record_id = $1 ORDER BY linked_at LIMIT 1', [sourceRecordId]);
  if (link) return { opportunityId: await survivingId(db, link.opportunity_id), created: false, method: 'existing_link', evidence: [] };

  const evidence: string[] = [];
  const candidates = new Map<string, string[]>();
  for (const ident of n.identifiers) {
    if (!STRONG_IDENTIFIER_TYPES.includes(ident.type)) continue;
    const norm = normalizeIdentifier(ident.type, ident.value);
    const group = matchGroupOf(ident.type);
    if (!norm || !group) continue;
    const rows = await db.query<{ opportunity_id: string; department_name: string | null; is_signal: boolean; opportunity_class: string }>(
      `SELECT DISTINCT oi.opportunity_id, o.department_name, o.is_signal, o.opportunity_class
       FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id
       WHERE oi.id_type = ANY($1::text[]) AND oi.normalized_value = $2`,
      [group, norm],
    );
    for (const r of rows) {
      if (r.is_signal) continue; // intelligence signals are linked by relationship, never merged into
      if (ident.type === 'solicitation_number') {
        // Solicitation numbers are only unique within an agency; require compatible agencies.
        if (!agenciesCompatible(r.department_name, n.agency.department)) continue;
        if (r.opportunity_class !== n.opportunityClass && !(r.opportunity_class === 'prime' && n.opportunityClass === 'prime')) continue;
      }
      const target = await survivingId(db, r.opportunity_id);
      const why = `${ident.type.replace(/_/g, ' ')} ${ident.value} matches`;
      candidates.set(target, [...(candidates.get(target) ?? []), why]);
    }
  }

  if (candidates.size) {
    const ids = [...candidates.keys()];
    const ordered = await db.query<{ id: string }>('SELECT id FROM opportunities WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC', [ids]);
    const target = ordered[0].id;
    evidence.push(...(candidates.get(target) ?? []));
    // More than one existing profile shares a strong identifier: flag as likely duplicates.
    for (const other of ordered.slice(1)) {
      await upsertRelationship(db, target, other.id, 'possible_duplicate', 0.95, 'exact', [`Shares a strong identifier: ${(candidates.get(other.id) ?? []).join('; ')}`]);
    }
    return { opportunityId: target, created: false, method: 'exact', evidence };
  }

  const row = await db.one<{ id: string }>(
    `INSERT INTO opportunities (title, opportunity_class, stage, status, is_signal) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [n.title, n.opportunityClass, n.stage, n.status, n.opportunityClass === 'intelligence'],
  );
  return { opportunityId: row!.id, created: true, method: 'created', evidence: ['No existing profile shares a strong identifier.'] };
}

export async function linkSource(db: Db, opportunityId: string, sourceRecordId: string, method: string, confidence: number, evidence: string[], role = 'primary'): Promise<boolean> {
  const row = await db.one<{ inserted: boolean }>(
    `INSERT INTO opportunity_sources (opportunity_id, source_record_id, role, link_method, confidence, evidence) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (opportunity_id, source_record_id) DO NOTHING RETURNING true AS inserted`,
    [opportunityId, sourceRecordId, role, method, confidence, json(evidence)],
  );
  return !!row?.inserted;
}

export async function upsertRelationship(
  db: Db,
  fromId: string,
  toId: string,
  type: string,
  confidence: number,
  method: string,
  evidence: string[],
  createdBy: 'system' | 'user' = 'system',
): Promise<string | null> {
  if (fromId === toId) return null;
  // Respect user decisions: never resurrect a relationship the user rejected.
  const rejected = await db.one(
    `SELECT 1 FROM opportunity_relationships WHERE status = 'rejected' AND ((from_opportunity_id = $1 AND to_opportunity_id = $2) OR (from_opportunity_id = $2 AND to_opportunity_id = $1))`,
    [fromId, toId],
  );
  if (rejected && createdBy === 'system') return null;
  if (createdBy === 'system') {
    const mirrored = await db.one<{ id: string }>(
      'SELECT id FROM opportunity_relationships WHERE from_opportunity_id = $1 AND to_opportunity_id = $2 AND relationship_type = $3',
      [toId, fromId, type],
    );
    if (mirrored) return mirrored.id;
  }
  const row = await db.one<{ id: string; inserted: boolean }>(
    `INSERT INTO opportunity_relationships (from_opportunity_id, to_opportunity_id, relationship_type, status, confidence, method, evidence, created_by, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
     ON CONFLICT (from_opportunity_id, to_opportunity_id, relationship_type) DO UPDATE SET
       confidence = GREATEST(opportunity_relationships.confidence, EXCLUDED.confidence),
       evidence = CASE WHEN opportunity_relationships.created_by = 'user' THEN opportunity_relationships.evidence ELSE EXCLUDED.evidence END
     RETURNING id, (xmax = 0) AS inserted`,
    [fromId, toId, type, createdBy === 'user' ? 'confirmed' : 'suggested', confidence, method, json(evidence), createdBy, createdBy === 'user' ? new Date() : null],
  );
  if (row?.inserted && createdBy === 'system') {
    for (const [a, b] of [
      [fromId, toId],
      [toId, fromId],
    ]) {
      await recordEvent(db, a, {
        type: 'RELATIONSHIP_FOUND',
        title: `Possible relationship found (${type.replace(/_/g, ' ')}, ${Math.round(confidence * 100)}% confidence)`,
        dedupeKey: `rel:${row.id}`,
        detail: { relationshipId: row.id, other: b, type, evidence },
      });
    }
  }
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Probabilistic relationship suggestions
// ---------------------------------------------------------------------------
interface Cand {
  id: string;
  title: string;
  description: string | null;
  stage: string;
  opportunity_class: string;
  is_signal: boolean;
  office_id: string | null;
  subagency_id: string | null;
  agency_id: string | null;
  naics_code: string | null;
  psc_code: string | null;
  set_aside_code: string | null;
  posted_at: string | null;
  value_low: number | null;
  value_high: number | null;
  place_state: string | null;
  connector_ids: string[];
}

export interface MatchScore {
  score: number;
  evidence: string[];
}

/** Weighted similarity between two profiles, with human-readable evidence. */
export function relationshipScore(a: Cand, b: Cand, model: TfIdfModel): MatchScore {
  const ev: string[] = [];
  let s = 0;
  const titleSim = Math.max(model.similarity(a.title, b.title), jaccard(a.title, b.title));
  s += 0.32 * titleSim;
  if (titleSim >= 0.35) ev.push(`Title similarity ${Math.round(titleSim * 100)}%`);
  const da = htmlToText(a.description ?? '').slice(0, 3000);
  const dbt = htmlToText(b.description ?? '').slice(0, 3000);
  if (da.length > 80 && dbt.length > 80) {
    const descSim = model.similarity(da, dbt);
    s += 0.16 * descSim;
    if (descSim >= 0.3) ev.push(`Scope description similarity ${Math.round(descSim * 100)}%`);
  }
  if (a.office_id && a.office_id === b.office_id) {
    s += 0.15;
    ev.push('Same contracting office');
  } else if (a.subagency_id && a.subagency_id === b.subagency_id) {
    s += 0.08;
    ev.push('Same sub-agency');
  } else if (a.agency_id && a.agency_id === b.agency_id) {
    s += 0.03;
  }
  if (a.naics_code && a.naics_code === b.naics_code) {
    s += 0.12;
    ev.push(`Same NAICS ${a.naics_code}`);
  } else if (a.naics_code && b.naics_code && a.naics_code.slice(0, 4) === b.naics_code.slice(0, 4)) {
    s += 0.05;
  }
  if (a.psc_code && a.psc_code === b.psc_code) {
    s += 0.06;
    ev.push(`Same PSC ${a.psc_code}`);
  }
  if (a.set_aside_code && a.set_aside_code === b.set_aside_code) s += 0.03;
  if (a.place_state && a.place_state === b.place_state) s += 0.03;
  if (a.posted_at && b.posted_at) {
    const days = Math.abs(new Date(a.posted_at).getTime() - new Date(b.posted_at).getTime()) / 86_400_000;
    if (days <= 365) {
      s += 0.05 * (1 - days / 365);
      if (days <= 120) ev.push(`Posted ${Math.round(days)} days apart`);
    }
  }
  const av = a.value_high ?? a.value_low;
  const bv = b.value_high ?? b.value_low;
  if (av && bv) {
    const ratio = Math.min(av, bv) / Math.max(av, bv);
    if (ratio >= 0.5) {
      s += 0.05 * ratio;
      ev.push('Comparable values');
    }
  }
  return { score: Math.min(1, s), evidence: ev };
}

function relationshipTypeFor(a: Cand, b: Cand, score: number): string | null {
  const sa = STAGE_ORDER[a.stage as Stage] ?? 0;
  const sb = STAGE_ORDER[b.stage as Stage] ?? 0;
  const sameSourceFamily = a.connector_ids.some((c) => b.connector_ids.includes(c));
  if (a.is_signal || b.is_signal) return score >= 0.5 ? 'possible_same_procurement' : null;
  if (a.stage === 'forecast' || b.stage === 'forecast') return score >= 0.5 ? 'forecast_of' : score >= 0.42 ? 'related' : null;
  if (sa !== sb) {
    // Award notices from years earlier with the same office/NAICS/scope are possible predecessors.
    const older = new Date(a.posted_at ?? 0).getTime() < new Date(b.posted_at ?? 0).getTime() ? a : b;
    const newer = older === a ? b : a;
    const gapDays = (new Date(newer.posted_at ?? 0).getTime() - new Date(older.posted_at ?? 0).getTime()) / 86_400_000;
    if (older.stage === 'award' && gapDays > 365 && score >= 0.5) return 'possible_predecessor';
    return score >= 0.55 ? 'possible_same_procurement' : score >= 0.45 ? 'related' : null;
  }
  if (!sameSourceFamily && score >= 0.72) return 'possible_duplicate';
  if (score >= 0.78) return 'possible_duplicate';
  return score >= 0.5 ? 'related' : null;
}

const CAND_COLS = `id, title, description, stage, opportunity_class, is_signal, office_id, subagency_id, agency_id, naics_code, psc_code, set_aside_code, posted_at, value_low, value_high, place_state, connector_ids`;

/**
 * Suggest relationships between a profile and similar profiles (same agency + NAICS/PSC/office).
 * Suggestions are reviewed in Merge Review — never merged automatically.
 */
export async function suggestRelationships(db: Db, opportunityId: string): Promise<number> {
  const me = await db.one<Cand>(`SELECT ${CAND_COLS} FROM opportunities WHERE id = $1`, [opportunityId]);
  if (!me || (!me.agency_id && me.opportunity_class !== 'subcontract')) return 0;
  const cands = await db.query<Cand>(
    `SELECT ${CAND_COLS} FROM opportunities
     WHERE id <> $1 AND merged_into_id IS NULL AND opportunity_class <> 'grant'
       AND ((agency_id = $2 AND (office_id = $3 OR naics_code = $4 OR psc_code = $5 OR subagency_id = $6)) OR ($2::uuid IS NULL AND naics_code = $4))
     ORDER BY COALESCE(posted_at, created_at) DESC LIMIT 250`,
    [opportunityId, me.agency_id, me.office_id, me.naics_code, me.psc_code, me.subagency_id],
  );
  if (!cands.length) return 0;
  const model = new TfIdfModel([me, ...cands].map((c) => `${c.title} ${htmlToText(c.description ?? '').slice(0, 1500)}`));
  let created = 0;
  for (const c of cands) {
    const { score, evidence } = relationshipScore(me, c, model);
    const type = relationshipTypeFor(me, c, score);
    if (!type) continue;
    const [from, to] = type === 'forecast_of' && me.stage !== 'forecast' ? [c.id, me.id] : type === 'possible_predecessor' && me.stage !== 'award' ? [c.id, me.id] : [me.id, c.id];
    const id = await upsertRelationship(db, from, to, type, Number(score.toFixed(3)), 'probabilistic', evidence);
    if (id) created++;
  }
  return created;
}

/**
 * Agency forecast IDs are sometimes cited in SAM notices. When a forecast's listing ID
 * appears verbatim in another profile's text, that is strong derived evidence of a link.
 */
export async function linkForecastReferences(db: Db, opportunityId: string): Promise<number> {
  const me = await db.one<{ title: string; description: string | null; stage: string }>('SELECT title, description, stage FROM opportunities WHERE id = $1', [opportunityId]);
  if (!me || me.stage === 'forecast') return 0;
  const text = `${me.title} ${htmlToText(me.description ?? '')}`.toUpperCase().replace(/[\s\-._]+/g, '');
  if (text.length < 20) return 0;
  const rows = await db.query<{ opportunity_id: string; value: string }>(
    `SELECT oi.opportunity_id, oi.value FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id
     WHERE oi.id_type = 'source_listing_id' AND length(oi.normalized_value) >= 8 AND o.merged_into_id IS NULL AND position(oi.normalized_value IN $1) > 0 LIMIT 5`,
    [text],
  );
  let n = 0;
  for (const r of rows) {
    if (await upsertRelationship(db, r.opportunity_id, opportunityId, 'forecast_of', 0.9, 'exact', [`Forecast listing ID ${r.value} is cited in this notice's text`])) n++;
  }
  return n;
}
