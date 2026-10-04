import { PROVENANCE_RANK, STAGE_LABELS, STAGE_ORDER, type Provenance, type Stage } from '../../shared/domain';
import type { Db } from '../db';
import { json } from '../db';
import { contentHash, sha256, stableStringify } from '../lib/hash';
import { formatRange } from '../lib/money';
import { htmlToText } from '../lib/text';
import { resolveAgency } from './entities';
import { computeCompleteness } from './completeness';
import { recordEvent } from './events';

interface FV {
  id: string;
  field: string;
  value: any;
  provenance: Provenance;
  connector_id: string | null;
  source_record_id: string | null;
  observed_at: string;
  src_stage: string | null;
}

const ANCHORED_FIELDS = new Set(['title', 'status', 'response_deadline', 'notice_type', 'set_aside_code', 'set_aside', 'posted_at', 'archive_date', 'description', 'primary_url', 'notice_id']);

function stageOrder(s: string | null | undefined): number {
  return s ? STAGE_ORDER[s as Stage] ?? 0 : 0;
}

/**
 * Choose the canonical value for a field.
 *  1. Provenance precedence (user > official > derived > AI > estimated). AI or estimated
 *     values never replace an official value.
 *  2. For lifecycle-anchored fields (title, deadline, status…), prefer the source record at
 *     the most advanced procurement stage — a solicitation's deadline supersedes the
 *     sources-sought deadline. Award notices are not used as the anchor for descriptions.
 *  3. Source precedence (connector priority), then the most recent observation.
 */
export function chooseValue(values: FV[], field: string, priorities: Map<string, number>): FV | null {
  if (!values.length) return null;
  const anchored = ANCHORED_FIELDS.has(field);
  const sorted = [...values].sort((a, b) => {
    const pr = PROVENANCE_RANK[a.provenance] - PROVENANCE_RANK[b.provenance];
    if (pr) return pr;
    if (anchored) {
      const sa = field === 'description' && a.src_stage === 'award' ? -1 : stageOrder(a.src_stage);
      const sb = field === 'description' && b.src_stage === 'award' ? -1 : stageOrder(b.src_stage);
      if (sa !== sb) return sb - sa;
    }
    const pa = priorities.get(a.connector_id ?? '') ?? priorities.get((a.connector_id ?? '').split(':')[0]) ?? 70;
    const pb = priorities.get(b.connector_id ?? '') ?? priorities.get((b.connector_id ?? '').split(':')[0]) ?? 70;
    if (pa !== pb) return pa - pb;
    return new Date(b.observed_at).getTime() - new Date(a.observed_at).getTime();
  });
  return sorted[0];
}

/**
 * Scope fingerprint used for change detection: sentence-level hashes of the normalized
 * description text. Whitespace, case and markup changes produce identical fingerprints, so
 * cosmetic edits at the source do not create "scope changed" noise.
 */
export function scopeSentences(description: string | null | undefined): { text: string; hash: string }[] {
  const plain = htmlToText(description ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ');
  const out: { text: string; hash: string }[] = [];
  const seen = new Set<string>();
  for (const raw of plain.split(/(?<=[.!?;:])\s+|\n+/)) {
    const text = raw.trim();
    const norm = text.toLowerCase().replace(/[^a-z0-9$%]+/g, ' ').trim();
    if (norm.length < 12) continue;
    const hash = sha256(norm).slice(0, 12);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({ text, hash });
    if (out.length >= 600) break;
  }
  return out;
}

function dayOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

export function diffScope(prevHashes: string[], next: { text: string; hash: string }[]): { added: string[]; removedCount: number; changeRatio: number } {
  const prev = new Set(prevHashes);
  const nextSet = new Set(next.map((s) => s.hash));
  const added = next.filter((s) => !prev.has(s.hash)).map((s) => s.text);
  const removedCount = prevHashes.filter((h) => !nextSet.has(h)).length;
  const base = Math.max(prevHashes.length, next.length, 1);
  return { added, removedCount, changeRatio: (added.length + removedCount) / (2 * base) };
}

interface Headline {
  low: number | null;
  high: number | null;
  provenance: Provenance | null;
  label: string | null;
}

const HEADLINE_ORDER = [
  'official_estimate',
  'ceiling',
  'forecast_estimate',
  'subcontract_value',
  'grant_ceiling',
  'grant_total_funding',
  'award_value',
  'potential_value',
  'historical_incumbent',
  'estimated_likely',
];

export function chooseHeadlineValue(stage: string, fins: { kind: string; amount_low: number | null; amount_high: number | null; provenance: Provenance; label: string | null }[]): Headline {
  const order = stage === 'award' ? ['award_value', 'potential_value', ...HEADLINE_ORDER] : HEADLINE_ORDER;
  for (const kind of order) {
    const candidates = fins.filter((f) => f.kind === kind && (f.amount_low != null || f.amount_high != null));
    if (!candidates.length) continue;
    const f = candidates.sort((a, b) => PROVENANCE_RANK[a.provenance] - PROVENANCE_RANK[b.provenance])[0];
    const labelByKind: Record<string, string> = {
      official_estimate: 'Official estimate',
      ceiling: 'Ceiling',
      forecast_estimate: 'Forecast estimate',
      subcontract_value: 'Subcontract value',
      grant_ceiling: 'Award ceiling',
      grant_total_funding: 'Total program funding',
      award_value: 'Award value',
      potential_value: 'Potential value (base + options)',
      historical_incumbent: 'Historical incumbent value',
      estimated_likely: 'Estimated likely value',
    };
    return { low: f.amount_low, high: f.amount_high ?? f.amount_low, provenance: f.provenance, label: labelByKind[kind] ?? f.label };
  }
  return { low: null, high: null, provenance: null, label: null };
}

export interface RecomputeOptions {
  priorities: Map<string, number>;
  /** Suppress change events (used for brand-new profiles, which get NEW_OPPORTUNITY instead). */
  isNew?: boolean;
}

/** Rebuild the canonical OpportunityProfile row from all contributing evidence, then diff and record change events. */
export async function recomputeOpportunity(db: Db, opportunityId: string, opts: RecomputeOptions): Promise<{ eventTypes: string[] }> {
  const opp = await db.one<any>('SELECT * FROM opportunities WHERE id = $1', [opportunityId]);
  if (!opp) return { eventTypes: [] };

  const values = await db.query<FV>(
    `SELECT fv.id, fv.field, fv.value, fv.provenance, fv.connector_id, fv.source_record_id, fv.observed_at, sr.normalized->'data'->>'stage' AS src_stage
     FROM opportunity_field_values fv LEFT JOIN source_records sr ON sr.id = fv.source_record_id
     WHERE fv.opportunity_id = $1 AND fv.is_current`,
    [opportunityId],
  );
  const overrides = await db.query<{ field: string; value: any }>('SELECT field, value FROM user_field_overrides WHERE opportunity_id = $1', [opportunityId]);
  for (const o of overrides) values.push({ id: `override:${o.field}`, field: o.field, value: o.value, provenance: 'user_entered', connector_id: 'user', source_record_id: null, observed_at: new Date().toISOString(), src_stage: null });

  const byField = new Map<string, FV[]>();
  for (const v of values) {
    if (!byField.has(v.field)) byField.set(v.field, []);
    byField.get(v.field)!.push(v);
  }
  const pick = (field: string) => chooseValue(byField.get(field) ?? [], field, opts.priorities)?.value ?? null;

  // Stage = the most advanced lifecycle stage any contributing record has reached.
  let stage: string = opp.stage;
  const stages = (byField.get('stage') ?? []).map((v) => v.value as string);
  if (stages.length) stage = stages.sort((a, b) => stageOrder(b) - stageOrder(a))[0];
  const statusCandidates = (byField.get('status') ?? []).filter((v) => v.src_stage === stage);
  const status = (statusCandidates.length ? chooseValue(statusCandidates, 'status', opts.priorities)?.value : pick('status')) ?? opp.status;
  const classes = (byField.get('opportunity_class') ?? []).map((v) => v.value as string);
  const opportunityClass = classes.includes('prime') ? 'prime' : classes.includes('grant') ? 'grant' : classes.includes('subcontract') ? 'subcontract' : classes[0] ?? opp.opportunity_class;
  const isSignal = opportunityClass === 'intelligence' || stage === 'recompete_signal';

  const department = pick('department');
  const subtier = pick('subtier');
  const office = pick('office');
  const place = pick('place') as { city?: string; state?: string; zip?: string; country?: string } | null;
  const refs = await resolveAgency(db, { department, subtier, office });

  const fins = await db.query<{ kind: string; amount_low: number | null; amount_high: number | null; provenance: Provenance; label: string | null }>(
    'SELECT kind, amount_low, amount_high, provenance, label FROM opportunity_financials WHERE opportunity_id = $1 AND is_current',
    [opportunityId],
  );
  const headline = chooseHeadlineValue(stage, fins);

  const stats = await db.one<any>(
    `SELECT
       (SELECT count(*)::int FROM opportunity_documents WHERE opportunity_id = $1) AS docs,
       (SELECT count(*)::int FROM opportunity_contacts WHERE opportunity_id = $1) AS contacts,
       (SELECT count(*)::int FROM opportunity_awards WHERE opportunity_id = $1 AND status = 'active') AS awards,
       (SELECT count(*)::int FROM opportunity_requirements WHERE opportunity_id = $1 AND is_current AND category IN ('evaluation_factor')) AS eval_criteria,
       (SELECT string_agg(DISTINCT sr.connector_id, ',') FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id WHERE os.opportunity_id = $1) AS connectors,
       (SELECT count(*)::int FROM opportunity_sources WHERE opportunity_id = $1) AS sources,
       (SELECT string_agg(COALESCE(c.email, c.full_name), '|' ORDER BY COALESCE(c.email, c.full_name)) FROM opportunity_contacts oc JOIN contacts c ON c.id = oc.contact_id WHERE oc.opportunity_id = $1) AS contact_sig,
       (SELECT v.name FROM opportunity_vendors ov JOIN vendors v ON v.id = ov.vendor_id WHERE ov.opportunity_id = $1 AND ov.role IN ('confirmed_incumbent','awardee') ORDER BY ov.created_at LIMIT 1) AS confirmed_incumbent,
       (SELECT v.name FROM opportunity_vendors ov JOIN vendors v ON v.id = ov.vendor_id WHERE ov.opportunity_id = $1 AND ov.role = 'possible_incumbent' ORDER BY ov.created_at LIMIT 1) AS possible_incumbent,
       (SELECT min(date_value) FROM opportunity_dates WHERE opportunity_id = $1 AND is_current AND kind = 'performance_start') AS pop_start,
       (SELECT max(date_value) FROM opportunity_dates WHERE opportunity_id = $1 AND is_current AND kind IN ('performance_end','potential_end')) AS pop_end,
       (SELECT min(date_value) FROM opportunity_dates WHERE opportunity_id = $1 AND is_current AND kind = 'questions_due') AS questions_due,
       (SELECT min(date_value) FROM opportunity_dates WHERE opportunity_id = $1 AND is_current AND kind IN ('expected_solicitation')) AS expected_solicitation`,
    [opportunityId],
  );
  const connectorIds: string[] = stats.connectors ? String(stats.connectors).split(',').sort() : opp.connector_ids ?? [];
  const recompeteHint = (await db.one<{ hint: boolean }>(
    `SELECT bool_or((sr.normalized->'data'->>'recompeteHint')::boolean) AS hint FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id WHERE os.opportunity_id = $1`,
    [opportunityId],
  ))?.hint;

  const description: string | null = pick('description');
  const responseDeadline = pick('response_deadline');
  const naicsCodes: string[] = [...new Set((byField.get('naics_codes') ?? []).flatMap((v) => (Array.isArray(v.value) ? v.value : [])))];
  const completeness = computeCompleteness({
    stage,
    opportunityClass,
    hasAgency: !!department,
    hasOffice: !!office,
    descriptionLength: (description ?? '').length,
    hasValue: headline.low != null || headline.high != null,
    hasDeadline: !!responseDeadline,
    hasNaics: !!pick('naics_code'),
    hasPsc: !!pick('psc_code'),
    setAsideKnown: (byField.get('set_aside_code') ?? []).length > 0 || (byField.get('set_aside') ?? []).length > 0 || stage === 'solicitation' || stage === 'combined_synopsis',
    contactCount: stats.contacts,
    documentCount: stats.docs,
    hasAwardHistory: stats.awards > 0,
    incumbentConfirmed: !!stats.confirmed_incumbent,
    hasIncumbentCandidate: !!stats.possible_incumbent,
    hasDuration: !!stats.pop_start || !!stats.pop_end || !!pick('performance_start') || !!pick('performance_end'),
    hasEvaluationCriteria: stats.eval_criteria > 0,
    hasPlace: !!place,
  });

  const next = {
    title: pick('title') ?? opp.title,
    opportunity_class: opportunityClass,
    stage,
    notice_type: pick('notice_type'),
    status,
    is_signal: isSignal,
    solicitation_number: pick('solicitation_number'),
    primary_notice_id: pick('notice_id'),
    agency_id: refs.agencyId,
    subagency_id: refs.subagencyId,
    office_id: refs.officeId,
    department_name: department,
    subtier_name: subtier,
    office_name: office,
    naics_code: pick('naics_code'),
    naics_codes: naicsCodes,
    psc_code: pick('psc_code'),
    set_aside_code: pick('set_aside_code'),
    set_aside: pick('set_aside'),
    contract_vehicle: pick('contract_vehicle'),
    pricing_type: pick('pricing_type'),
    competition_type: pick('competition_type'),
    posted_at: pick('posted_at'),
    source_updated_at: pick('source_updated_at'),
    response_deadline: responseDeadline,
    archive_date: pick('archive_date'),
    performance_start: (pick('performance_start') ?? stats.pop_start ?? null) as string | null,
    performance_end: (pick('performance_end') ?? stats.pop_end ?? null) as string | null,
    value_low: headline.low,
    value_high: headline.high,
    value_provenance: headline.provenance,
    value_label: headline.label,
    place_city: place?.city ?? null,
    place_state: place?.state ?? null,
    place_zip: place?.zip ?? null,
    place_country: place?.country ?? null,
    description,
    primary_url: pick('primary_url'),
    has_documents: stats.docs > 0,
    has_incumbent: !!(stats.confirmed_incumbent || stats.possible_incumbent),
    incumbent_name: stats.confirmed_incumbent ?? stats.possible_incumbent ?? null,
    recompete_signal: isSignal || !!recompeteHint,
    source_count: stats.sources,
    connector_ids: connectorIds,
    data_completeness: completeness.score,
    completeness_detail: completeness,
  };

  const snapshot = {
    title: next.title,
    stage: next.stage,
    status: next.status,
    response_deadline: next.response_deadline ? new Date(next.response_deadline).toISOString() : null,
    value_low: next.value_low,
    value_high: next.value_high,
    value_provenance: next.value_provenance,
    set_aside_code: next.set_aside_code,
    naics_code: next.naics_code,
    psc_code: next.psc_code,
    office_name: next.office_name,
    solicitation_number: next.solicitation_number,
    incumbent_name: next.incumbent_name,
    connector_ids: next.connector_ids,
    contact_sig: stats.contact_sig ?? '',
    documents: stats.docs,
    // Added in schema 003. diffEvents only compares keys present in BOTH snapshots, so
    // profiles created before these keys existed never get spurious change events.
    desc_sents: scopeSentences(description).map((x) => x.hash),
    performance_start: dayOf(next.performance_start),
    performance_end: dayOf(next.performance_end),
    questions_due: stats.questions_due ? new Date(stats.questions_due).toISOString() : null,
    expected_solicitation: stats.expected_solicitation ? new Date(stats.expected_solicitation).toISOString().slice(0, 10) : null,
    contract_vehicle: next.contract_vehicle ?? null,
    pricing_type: next.pricing_type ?? null,
  };
  const hash = contentHash(snapshot);
  const eventTypes: string[] = [];

  if (hash !== opp.canonical_hash) {
    const prevSnap = await db.one<{ snapshot: typeof snapshot }>('SELECT snapshot FROM opportunity_snapshots WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1', [opportunityId]);
    await db.query('INSERT INTO opportunity_snapshots (opportunity_id, canonical_hash, snapshot) VALUES ($1,$2,$3::jsonb)', [opportunityId, hash, json(snapshot)]);
    const prev = prevSnap?.snapshot;
    if (opts.isNew || !prev) {
      await recordEvent(db, opportunityId, {
        type: 'NEW_OPPORTUNITY',
        title: `New ${STAGE_LABELS[stage as Stage] ?? stage} profile created`,
        dedupeKey: 'new',
        detail: { connectors: connectorIds },
      });
      eventTypes.push('NEW_OPPORTUNITY');
    } else {
      eventTypes.push(...(await diffEvents(db, opportunityId, prev, snapshot, hash, description)));
    }
  }

  const cols = Object.keys(next);
  const setSql = cols.map((c, i) => `${c} = $${i + 2}${c === 'completeness_detail' ? '::jsonb' : c === 'naics_codes' || c === 'connector_ids' ? '::text[]' : ''}`).join(', ');
  const params = cols.map((c) => (c === 'completeness_detail' ? json((next as any)[c]) : (next as any)[c]));
  await db.query(
    `UPDATE opportunities SET ${setSql}, canonical_hash = $${cols.length + 2}, updated_at = now(), last_seen_at = now()${eventTypes.length && !opts.isNew ? ', last_changed_at = now()' : ''} WHERE id = $1`,
    [opportunityId, ...params, hash],
  );
  return { eventTypes };
}

/** Connectors whose records are agency procurement forecasts. */
export const FORECAST_CONNECTORS = ['gsa_forecast', 'dhs_apfs'];

const EARLY_STAGES = new Set(['forecast', 'grant_forecast', 'recompete_signal', 'sources_sought', 'rfi', 'special_notice', 'presolicitation']);

async function diffEvents(db: Db, opportunityId: string, prev: any, next: any, hash: string, description: string | null): Promise<string[]> {
  const out: string[] = [];
  const add = async (type: string, title: string, field: string | null, oldV: unknown, newV: unknown, detail: Record<string, unknown> = {}) => {
    await recordEvent(db, opportunityId, { type, title, field, oldValue: oldV, newValue: newV, detail, dedupeKey: `${type}:${field ?? ''}:${hash}` });
    out.push(type);
  };
  /** Only compare keys both snapshots have (older snapshots predate some keys). */
  const both = (k: string) => k in prev && k in next;
  const fmtDate = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 10) : 'none');
  if (prev.stage !== next.stage) {
    await add('STAGE_CHANGED', `Stage changed: ${STAGE_LABELS[prev.stage as Stage] ?? prev.stage} → ${STAGE_LABELS[next.stage as Stage] ?? next.stage}`, 'stage', prev.stage, next.stage);
    if (next.stage === 'award') await add('AWARD_POSTED', 'Award posted', 'stage', prev.stage, next.stage);
    if ((next.stage === 'solicitation' || next.stage === 'combined_synopsis') && EARLY_STAGES.has(prev.stage))
      await add('SOLICITATION_RELEASED', `Solicitation released (was ${STAGE_LABELS[prev.stage as Stage] ?? prev.stage})`, 'stage', prev.stage, next.stage);
  }
  if (prev.status !== next.status) {
    if (next.status === 'cancelled') await add('CANCELLED', 'Notice cancelled at the source', 'status', prev.status, next.status);
    else await add('STATUS_CHANGED', `Status changed: ${prev.status} → ${next.status}`, 'status', prev.status, next.status);
  }
  if (both('desc_sents') && Array.isArray(prev.desc_sents) && prev.desc_sents.length && next.desc_sents.length) {
    const d = diffScope(prev.desc_sents, scopeSentences(description));
    // Noise control: ignore single tiny edits; report real requirement text changes.
    const meaningful = d.added.filter((t) => t.length >= 25);
    if (meaningful.length + d.removedCount >= 2 || (meaningful.length >= 1 && d.changeRatio >= 0.03)) {
      await add(
        'SCOPE_CHANGED',
        `Scope / description changed: ${meaningful.length} sentence(s) added, ${d.removedCount} removed`,
        'description',
        null,
        null,
        { addedSentences: meaningful.slice(0, 8), removedCount: d.removedCount, changeRatio: Number(d.changeRatio.toFixed(3)) },
      );
    }
  }
  for (const [field, label] of [
    ['questions_due', 'Questions deadline'],
    ['performance_start', 'Period of performance start'],
    ['performance_end', 'Period of performance end'],
    ['expected_solicitation', 'Expected solicitation date'],
  ] as const) {
    if (both(field) && (prev[field] ?? null) !== (next[field] ?? null)) await add('DATES_CHANGED', `${label} changed ${fmtDate(prev[field])} → ${fmtDate(next[field])}`, field, prev[field], next[field]);
  }
  for (const [field, label] of [
    ['contract_vehicle', 'Contract vehicle'],
    ['pricing_type', 'Contract / pricing type'],
  ] as const) {
    if (both(field) && stableStringify(prev[field]) !== stableStringify(next[field])) await add('FIELD_CHANGED', `${label} changed: ${prev[field] ?? 'none'} → ${next[field] ?? 'none'}`, field, prev[field], next[field]);
  }
  if (prev.response_deadline !== next.response_deadline) await add('DEADLINE_CHANGED', `Deadline changed ${fmtDate(prev.response_deadline)} → ${fmtDate(next.response_deadline)}`, 'response_deadline', prev.response_deadline, next.response_deadline);
  if (prev.value_low !== next.value_low || prev.value_high !== next.value_high)
    await add('VALUE_CHANGED', `Value changed ${formatRange(prev.value_low, prev.value_high)} → ${formatRange(next.value_low, next.value_high)}`, 'value', [prev.value_low, prev.value_high], [next.value_low, next.value_high], { provenance: next.value_provenance });
  for (const [field, label] of [
    ['title', 'Title'],
    ['set_aside_code', 'Set-aside'],
    ['naics_code', 'NAICS'],
    ['psc_code', 'PSC'],
    ['office_name', 'Office'],
    ['solicitation_number', 'Solicitation number'],
  ] as const) {
    if (stableStringify(prev[field]) !== stableStringify(next[field]))
      await add(field === 'set_aside_code' ? 'SET_ASIDE_CHANGED' : 'FIELD_CHANGED', `${label} changed: ${prev[field] ?? 'none'} → ${next[field] ?? 'none'}`, field, prev[field], next[field]);
  }
  if ((prev.contact_sig ?? '') !== (next.contact_sig ?? '')) await add('CONTACT_CHANGED', 'Point of contact changed', 'contacts', prev.contact_sig, next.contact_sig);
  if (!prev.incumbent_name && next.incumbent_name) await add('INCUMBENT_IDENTIFIED', `Incumbent identified: ${next.incumbent_name}`, 'incumbent', null, next.incumbent_name);
  const prevConn: string[] = prev.connector_ids ?? [];
  const newConn = (next.connector_ids as string[]).filter((c) => !prevConn.includes(c));
  for (const c of newConn) {
    await add('NEW_SOURCE', `New source linked: ${c}`, 'sources', prevConn, next.connector_ids, { connector: c });
    const isForecastSource = (x: string) => FORECAST_CONNECTORS.includes(x);
    if (isForecastSource(c) || (prevConn.some(isForecastSource) && c.startsWith('sam'))) await add('FORECAST_LINKED', isForecastSource(c) ? 'Forecast record linked to this profile' : 'SAM notice linked to forecast', 'sources', null, c);
  }
  return out;
}
