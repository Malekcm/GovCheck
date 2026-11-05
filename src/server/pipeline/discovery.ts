import crypto from 'node:crypto';
import type { Db } from '../db';
import { json } from '../db';
import { normalizeIdentifier } from '../lib/ids';
import { nameKey } from '../lib/text';
import { jaccard } from '../scoring/similarity';
import { addIdentifiers, setFieldValues, setDates } from './apply';
import { recomputeOpportunity } from './canonical';
import { recordEvent } from './events';
import { linkSource, survivingId, upsertRelationship } from './resolve';
import { setTracking } from './tracking';

/**
 * Discovery attribution and user-authored research leads.
 *
 * Four storage categories are kept apart (see docs/g2x-data-permissions.md):
 *   1. Public government records from authorized government feeds  → source_records
 *   2. User-authored capture notes, decisions and leads              → user_* / tracking / lead source
 *   3. Minimal discovery attribution and links                       → opportunity_discovery
 *   4. Provider-controlled licensed content (G2X, Tango payloads)    → NEVER stored
 *
 * Nothing in this module accepts provider payloads. Discovery rows hold a provider name, a
 * one-way key of the record link, and (when permitted) the link itself.
 */
export const RESEARCH_LEAD_CONNECTOR = 'user_research_lead';

export const DISCOVERY_PROVIDERS: Record<string, { label: string; licensed: boolean }> = {
  g2x: { label: 'G2X', licensed: true },
  tango: { label: 'Tango', licensed: true },
  manual: { label: 'Manual research', licensed: false },
};

export function providerRecordKey(provider: string, recordRef: string): string {
  return crypto.createHash('sha256').update(`${provider}:${recordRef.trim()}`).digest('hex');
}

export function agenciesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (k: string) => k.replace(/\bDEPT\b/g, 'DEPARTMENT').replace(/\bTHE\b/g, '').replace(/\s+/g, ' ').trim();
  const ka = nameKey(a);
  const kb = nameKey(b);
  if (!ka || !kb) return false;
  const na = norm(ka);
  const nb = norm(kb);
  return na === nb || na.includes(nb) || nb.includes(na);
}

export async function recordDiscovery(
  db: Db,
  opportunityId: string,
  d: { provider: string; recordRef: string; recordUrl?: string | null; actorId?: string | null; discoveredAt?: Date; leadOrigin?: boolean },
): Promise<boolean> {
  const key = providerRecordKey(d.provider, d.recordRef);
  const row = await db.one<{ id: string }>(
    `INSERT INTO opportunity_discovery (opportunity_id, provider, provider_record_key, provider_record_url, is_lead_origin, discovered_by, discovered_at)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now())) ON CONFLICT DO NOTHING RETURNING id`,
    [opportunityId, d.provider, key, d.recordUrl ?? null, !!d.leadOrigin, d.actorId ?? null, d.discoveredAt ?? null],
  );
  if (row)
    await recordEvent(db, opportunityId, {
      type: 'DISCOVERY_ATTRIBUTED',
      title: `Discovery attributed to ${DISCOVERY_PROVIDERS[d.provider]?.label ?? d.provider}`,
      dedupeKey: `discovery:${d.provider}:${key}`,
      detail: { provider: d.provider },
    });
  return !!row;
}

export interface LeadInput {
  title: string;
  notes?: string | null;
  sourceUrl: string;
  provider: string;
  /** Only values the user typed themselves. Never copied provider content. */
  agency?: string | null;
  solicitationNumber?: string | null;
  responseDeadline?: string | null;
  naics?: string | null;
  track?: boolean;
  relateTo?: { opportunityId: string; type: 'predecessor' | 'successor' | 'related' } | null;
}

/**
 * Create (or return) a user-authored research lead. The lead is an ordinary canonical
 * opportunity so it can be tracked, assigned and later merged into its official record —
 * but every value is user_entered, it is an intelligence signal (never an open solicitation),
 * and verification_status stays 'research_lead' until a government source is linked.
 */
export async function createResearchLead(db: Db, input: LeadInput, actorId: string | null): Promise<{ opportunityId: string; created: boolean }> {
  const key = providerRecordKey(input.provider, input.sourceUrl);
  return db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`lead:${key}`]);
    const existing = await tx.one<{ opportunity_id: string }>(
      `SELECT d.opportunity_id FROM opportunity_discovery d WHERE d.provider = $1 AND d.provider_record_key = $2 AND d.is_lead_origin`,
      [input.provider, key],
    );
    if (existing) {
      return { opportunityId: await survivingId(tx, existing.opportunity_id), created: false };
    }
    const opp = await tx.one<{ id: string }>(
      `INSERT INTO opportunities (title, opportunity_class, stage, status, is_signal, verification_status) VALUES ($1,'intelligence','other','signal',true,'research_lead') RETURNING id`,
      [input.title],
    );
    const id = opp!.id;
    // The lead's own record holds only what the team member wrote.
    const authored = { title: input.title, sourceUrl: input.sourceUrl, agency: input.agency ?? null, solicitationNumber: input.solicitationNumber ?? null, responseDeadline: input.responseDeadline ?? null, naics: input.naics ?? null, discoveryProvider: input.provider, authoredBy: actorId };
    const rec = await tx.one<{ id: string }>(
      `INSERT INTO source_records (connector_id, source_record_id, record_kind, raw, content_hash, parser_version, retrieved_at, source_url, normalized)
       VALUES ($1,$2,'opportunity',$3::jsonb,$4,'lead-1',now(),$5,$6::jsonb) RETURNING id`,
      [RESEARCH_LEAD_CONNECTOR, `lead:${id}`, json(authored), key, input.sourceUrl, json({ type: 'opportunity', data: { stage: 'other', title: input.title, userAuthored: true } })],
    );
    await linkSource(tx, id, rec!.id, 'manual', 1, ['User-authored research lead'], 'primary');
    const ref = { opportunityId: id, connectorId: RESEARCH_LEAD_CONNECTOR, sourceRecordId: rec!.id };
    const basis = 'Entered by a team member when creating a research lead. Not government verified.';
    await setFieldValues(tx, ref, [
      { field: 'title', value: input.title, provenance: 'user_entered', basis },
      { field: 'stage', value: 'other', provenance: 'user_entered', basis },
      { field: 'status', value: 'signal', provenance: 'user_entered', basis },
      { field: 'opportunity_class', value: 'intelligence', provenance: 'user_entered', basis },
      { field: 'department', value: input.agency ?? null, provenance: 'user_entered', basis },
      { field: 'solicitation_number', value: input.solicitationNumber ?? null, provenance: 'user_entered', basis },
      { field: 'naics_code', value: input.naics ?? null, provenance: 'user_entered', basis },
      { field: 'primary_url', value: input.sourceUrl, provenance: 'user_entered', basis },
    ]);
    if (input.responseDeadline) await setDates(tx, ref, [{ kind: 'response_due', value: input.responseDeadline, provenance: 'user_entered', basis }]);
    if (input.responseDeadline) await setFieldValues(tx, ref, [{ field: 'response_deadline', value: input.responseDeadline, provenance: 'user_entered', basis }]);
    // Leads never auto-merge (they are signals); a user-typed solicitation number only powers review suggestions.
    if (input.solicitationNumber) await addIdentifiers(tx, id, [{ type: 'solicitation_number', value: input.solicitationNumber }], rec!.id);
    await recordDiscovery(tx, id, { provider: input.provider, recordRef: input.sourceUrl, recordUrl: input.sourceUrl, actorId, leadOrigin: true });
    if (input.notes?.trim()) await tx.query('INSERT INTO user_notes (opportunity_id, body, actor_id) VALUES ($1,$2,$3)', [id, input.notes.trim(), actorId]);
    await tx.query(`INSERT INTO user_tags (opportunity_id, tag) VALUES ($1,'research-lead') ON CONFLICT DO NOTHING`, [id]);
    await recomputeOpportunity(tx, id, { priorities: new Map([[RESEARCH_LEAD_CONNECTOR, 95], ['user', 0]]), isNew: true });
    if (input.track !== false) await setTracking(tx, id, { tracked: true, actorId, reason: 'Tracked as research lead' });
    if (input.relateTo) await upsertRelationship(tx, input.relateTo.type === 'successor' ? id : input.relateTo.opportunityId, input.relateTo.type === 'successor' ? input.relateTo.opportunityId : id, input.relateTo.type === 'related' ? 'related' : 'predecessor', 1, 'manual', [`Marked by user while tracking a ${input.provider} research lead`], 'user');
    await suggestLeadMatches(tx, id);
    return { opportunityId: id, created: true };
  });
}

/**
 * When an official record and a research lead share a user-entered solicitation number and a
 * compatible agency, suggest (never perform) a merge. The user decides in Potential Match review.
 */
export async function suggestLeadMatches(db: Db, opportunityId: string): Promise<number> {
  const me = await db.one<{ id: string; verification_status: string; department_name: string | null }>('SELECT id, verification_status, department_name FROM opportunities WHERE id = $1', [opportunityId]);
  if (!me) return 0;
  const rows = await db.query<{ other: string; department_name: string | null; value: string; verification_status: string }>(
    `SELECT DISTINCT o.id AS other, o.department_name, oi.value, o.verification_status FROM opportunity_identifiers mine
     JOIN opportunity_identifiers oi ON oi.id_type = 'solicitation_number' AND oi.normalized_value = mine.normalized_value AND oi.opportunity_id <> mine.opportunity_id
     JOIN opportunities o ON o.id = oi.opportunity_id AND o.merged_into_id IS NULL
     WHERE mine.opportunity_id = $1 AND mine.id_type = 'solicitation_number' AND o.verification_status <> $2`,
    [opportunityId, me.verification_status],
  );
  let n = 0;
  for (const r of rows) {
    const compatible = agenciesCompatible(r.department_name, me.department_name) || !r.department_name || !me.department_name;
    if (!compatible) continue;
    const [lead, official] = me.verification_status === 'research_lead' ? [me.id, r.other] : [r.other, me.id];
    if (await upsertRelationship(db, official, lead, 'possible_same_procurement', 0.9, 'exact', [`Research lead's user-entered solicitation number ${r.value} matches an official record`])) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Matching a discovery result (not stored) against GovCheck
// ---------------------------------------------------------------------------
export interface DiscoveryRow {
  provider: string;
  recordRef: string;
  recordUrl: string | null;
  title: string | null;
  agency: string | null;
  solicitationNumber: string | null;
  /** A government notice ID the provider row points at. Only a candidate until a government source confirms it. */
  noticeIdCandidate: string | null;
  naics: string | null;
  officialFamily: string | null;
}

export type MatchStatus = 'existing' | 'potential_match' | 'official_candidate' | 'research_lead_only' | 'dismissed';

export interface MatchResult {
  status: MatchStatus;
  opportunity: { id: string; title: string; verification_status: string; tracked: boolean; stage: string; connector_ids: string[] } | null;
  evidence: string[];
  conflicts: string[];
  candidates: { id: string; title: string; stage: string; department_name: string | null; score: number; evidence: string[]; conflicts: string[]; suggestedRelationship: 'same' | 'predecessor' }[];
  decision: string | null;
}

const OPP_COLS = `o.id, o.title, o.verification_status, o.stage, o.connector_ids, o.department_name, o.naics_code, ${'COALESCE((SELECT tr.tracked FROM opportunity_tracking tr WHERE tr.opportunity_id = o.id), false)'} AS tracked`;

export async function matchDiscoveryRow(db: Db, row: DiscoveryRow): Promise<MatchResult> {
  const key = providerRecordKey(row.provider, row.recordRef);
  const result: MatchResult = { status: 'research_lead_only', opportunity: null, evidence: [], conflicts: [], candidates: [], decision: null };
  const pick = async (id: string) => db.one<any>(`SELECT ${OPP_COLS} FROM opportunities o WHERE o.id = $1`, [id]);

  // 1. The user's earlier decisions about this exact provider record are respected.
  const decisions = await db.query<{ decision: string; opportunity_id: string | null }>('SELECT decision, opportunity_id FROM discovery_match_decisions WHERE provider = $1 AND provider_record_key = $2 ORDER BY decided_at DESC', [row.provider, key]);
  const linked = decisions.find((d) => d.decision === 'linked' && d.opportunity_id);
  if (linked) {
    result.status = 'existing';
    result.opportunity = await pick(await survivingId(db, linked.opportunity_id!));
    result.evidence.push('You previously linked this result to this opportunity.');
    result.decision = 'linked';
    return result;
  }
  if (decisions.some((d) => d.decision === 'dismissed')) {
    result.status = 'dismissed';
    result.decision = 'dismissed';
    return result;
  }
  const separate = new Set(decisions.filter((d) => ['separate', 'predecessor', 'successor'].includes(d.decision)).map((d) => d.opportunity_id));

  // 2. Previously attributed discovery (lead or official) for this record link.
  const attributed = await db.one<{ opportunity_id: string }>('SELECT opportunity_id FROM opportunity_discovery WHERE provider = $1 AND provider_record_key = $2 ORDER BY is_lead_origin, discovered_at LIMIT 1', [row.provider, key]);
  if (attributed) {
    result.status = 'existing';
    result.opportunity = await pick(await survivingId(db, attributed.opportunity_id));
    result.evidence.push('This result was already added to GovCheck.');
    return result;
  }

  // 3. Strong identifiers: government notice ID, then solicitation number + compatible agency.
  const notice = normalizeIdentifier('notice_id', row.noticeIdCandidate);
  if (notice) {
    const hit = await db.one<{ opportunity_id: string }>(
      `SELECT oi.opportunity_id FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id WHERE oi.id_type = 'notice_id' AND oi.normalized_value = $1 ORDER BY o.created_at LIMIT 1`,
      [notice],
    );
    if (hit) {
      result.status = 'existing';
      result.opportunity = await pick(await survivingId(db, hit.opportunity_id));
      result.evidence.push(`SAM.gov notice ID ${row.noticeIdCandidate} matches`);
      return result;
    }
  }
  const sol = normalizeIdentifier('solicitation_number', row.solicitationNumber);
  if (sol) {
    const hits = await db.query<{ id: string; department_name: string | null; is_signal: boolean; stage: string; title: string }>(
      `SELECT DISTINCT o.id, o.department_name, o.is_signal, o.stage, o.title FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id
       WHERE oi.id_type = 'solicitation_number' AND oi.normalized_value = $1 AND o.merged_into_id IS NULL`,
      [sol],
    );
    for (const h of hits) {
      if (separate.has(h.id)) continue;
      if (agenciesCompatible(h.department_name, row.agency) && h.stage !== 'award') {
        result.status = 'existing';
        result.opportunity = await pick(h.id);
        result.evidence.push(`Solicitation number ${row.solicitationNumber} and agency match`);
        return result;
      }
      // Same number, different buyer or an award: solicitation numbers are only unique within an agency.
      const conflicts = h.stage === 'award' ? ['Existing record is an award; a recompete must not be merged into its predecessor award'] : [`Agency differs: GovCheck "${h.department_name ?? 'unknown'}" vs result "${row.agency ?? 'unknown'}"`];
      result.candidates.push({ id: h.id, title: h.title, stage: h.stage, department_name: h.department_name, score: 0.6, evidence: [`Solicitation number ${row.solicitationNumber} matches`], conflicts, suggestedRelationship: h.stage === 'award' ? 'predecessor' : 'same' });
    }
  }

  // 4. Weak similarity never links automatically; it is offered for review.
  if (row.title && row.title.length >= 12) {
    const words = row.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4).slice(0, 6);
    if (words.length) {
      const cands = await db.query<{ id: string; title: string; stage: string; department_name: string | null; naics_code: string | null }>(
        `SELECT o.id, o.title, o.stage, o.department_name, o.naics_code FROM opportunities o WHERE o.merged_into_id IS NULL AND (${words.map((_, i) => `o.title ILIKE $${i + 1}`).join(' OR ')})
         ORDER BY o.last_changed_at DESC LIMIT 60`,
        words.map((w) => `%${w}%`),
      );
      for (const c of cands) {
        if (separate.has(c.id) || result.candidates.some((x) => x.id === c.id)) continue;
        const sim = jaccard(row.title, c.title);
        const sameAgency = agenciesCompatible(c.department_name, row.agency);
        const sameNaics = !!row.naics && row.naics === c.naics_code;
        const score = sim * 0.7 + (sameAgency ? 0.2 : 0) + (sameNaics ? 0.1 : 0);
        if (score < 0.45) continue;
        const evidence = [`Title similarity ${Math.round(sim * 100)}%`, ...(sameAgency ? ['Compatible agency'] : []), ...(sameNaics ? [`Same NAICS ${row.naics}`] : [])];
        const conflicts = [...(!sameAgency && c.department_name && row.agency ? [`Agency differs: "${c.department_name}" vs "${row.agency}"`] : []), ...(c.stage === 'award' ? ['Existing record is an award (possible predecessor, not the same procurement)'] : [])];
        result.candidates.push({ id: c.id, title: c.title, stage: c.stage, department_name: c.department_name, score: Number(score.toFixed(2)), evidence, conflicts, suggestedRelationship: c.stage === 'award' ? 'predecessor' : 'same' });
      }
      result.candidates.sort((a, b) => b.score - a.score);
      result.candidates = result.candidates.slice(0, 5);
    }
  }
  if (result.candidates.length) result.status = 'potential_match';
  else if (row.officialFamily && (notice || sol)) result.status = 'official_candidate';
  if (result.status === 'official_candidate' || (result.status === 'potential_match' && row.officialFamily && (notice || sol))) result.evidence.push('The result points to an official government notice that can be verified independently.');
  return result;
}

export async function recordMatchDecision(db: Db, d: { provider: string; recordRef: string; opportunityId: string | null; decision: 'linked' | 'separate' | 'predecessor' | 'successor' | 'dismissed'; actorId: string | null; recordUrl?: string | null }) {
  const key = providerRecordKey(d.provider, d.recordRef);
  await db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO discovery_match_decisions (provider, provider_record_key, opportunity_id, decision, decided_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider, provider_record_key, opportunity_id) DO UPDATE SET decision = EXCLUDED.decision, decided_by = EXCLUDED.decided_by, decided_at = now()`,
      [d.provider, key, d.opportunityId, d.decision, d.actorId],
    );
    if (d.decision === 'linked' && d.opportunityId) await recordDiscovery(tx, d.opportunityId, { provider: d.provider, recordRef: d.recordRef, recordUrl: d.recordUrl ?? null, actorId: d.actorId });
  });
}
