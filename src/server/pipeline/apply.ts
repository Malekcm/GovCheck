import type { Provenance } from '../../shared/domain';
import type { Db } from '../db';
import { json } from '../db';
import { stableStringify } from '../lib/hash';
import { normalizeIdentifier, type IdentifierType } from '../lib/ids';
import type { NormalizedOpportunity } from '../connectors/types';
import { upsertContact } from './entities';

export interface FieldInput {
  field: string;
  value: unknown;
  provenance?: Provenance;
  basis?: string | null;
  confidence?: string | null;
}

interface SourceRef {
  opportunityId: string;
  connectorId: string;
  sourceRecordId: string | null;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function valueText(v: unknown): string | null {
  if (isEmpty(v)) return null;
  if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 497)}…` : v;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).filter((x) => !isEmpty(x)).join(', ');
  return String(v);
}

/**
 * Replace the current values contributed by ONE source (record) with a new set.
 * Old values are retired (is_current = false) — never deleted — so history and
 * conflicts across sources remain inspectable.
 */
export async function setFieldValues(db: Db, ref: SourceRef, rawInputs: FieldInput[]): Promise<{ changedFields: string[] }> {
  // One value per field per source: the last one supplied wins.
  const inputs = [...new Map(rawInputs.map((i) => [i.field, i])).values()];
  const existing = await db.query<{ id: string; field: string; value: unknown; provenance: string }>(
    `SELECT id, field, value, provenance FROM opportunity_field_values
     WHERE opportunity_id = $1 AND connector_id = $2 AND source_record_id IS NOT DISTINCT FROM $3::uuid AND is_current`,
    [ref.opportunityId, ref.connectorId, ref.sourceRecordId],
  );
  const byField = new Map(existing.map((e) => [e.field, e]));
  const retire: string[] = [];
  const insert: Record<string, unknown>[] = [];
  const changedFields: string[] = [];
  for (const inp of inputs) {
    const cur = byField.get(inp.field);
    if (isEmpty(inp.value)) {
      if (cur) {
        retire.push(cur.id);
        changedFields.push(inp.field);
      }
      continue;
    }
    if (cur && stableStringify(cur.value) === stableStringify(inp.value) && cur.provenance === (inp.provenance ?? 'official')) continue;
    if (cur) retire.push(cur.id);
    changedFields.push(inp.field);
    insert.push({
      opportunity_id: ref.opportunityId,
      field: inp.field,
      value: inp.value,
      value_text: valueText(inp.value),
      provenance: inp.provenance ?? 'official',
      connector_id: ref.connectorId,
      source_record_id: ref.sourceRecordId,
      basis: inp.basis ?? null,
      confidence: inp.confidence ?? null,
    });
  }
  if (retire.length) await db.query('UPDATE opportunity_field_values SET is_current = false, superseded_at = now() WHERE id = ANY($1::uuid[])', [retire]);
  if (insert.length) {
    await db.query(
      `INSERT INTO opportunity_field_values (opportunity_id, field, value, value_text, provenance, connector_id, source_record_id, basis, confidence)
       SELECT x.opportunity_id, x.field, x.value, x.value_text, x.provenance, x.connector_id, x.source_record_id, x.basis, x.confidence
       FROM jsonb_to_recordset($1::jsonb) AS x(opportunity_id uuid, field text, value jsonb, value_text text, provenance text, connector_id text, source_record_id uuid, basis text, confidence text)`,
      [json(insert)],
    );
  }
  return { changedFields };
}

export async function addIdentifiers(db: Db, opportunityId: string, ids: { type: IdentifierType; value: string }[], sourceRecordId: string | null): Promise<void> {
  const rows = ids
    .map((i) => ({ type: i.type, value: i.value, norm: normalizeIdentifier(i.type, i.value) }))
    .filter((r) => r.norm);
  if (!rows.length) return;
  await db.query(
    `INSERT INTO opportunity_identifiers (opportunity_id, id_type, value, normalized_value, source_record_id)
     SELECT $1, x.type, x.value, x.norm, $2 FROM jsonb_to_recordset($3::jsonb) AS x(type text, value text, norm text)
     ON CONFLICT (opportunity_id, id_type, normalized_value) DO NOTHING`,
    [opportunityId, sourceRecordId, json(rows)],
  );
}

/** Replace the dated facts contributed by one source record. */
export async function setDates(db: Db, ref: SourceRef, dates: NormalizedOpportunity['dates']): Promise<void> {
  const existing = await db.query<{ id: string; kind: string; date_value: Date | null; date_text: string | null }>(
    `SELECT id, kind, date_value, date_text FROM opportunity_dates WHERE opportunity_id = $1 AND connector_id = $2 AND source_record_id IS NOT DISTINCT FROM $3::uuid AND is_current`,
    [ref.opportunityId, ref.connectorId, ref.sourceRecordId],
  );
  const key = (k: string, v: string | null | undefined, t: string | null | undefined) => `${k}|${v ? new Date(v).toISOString() : ''}|${t ?? ''}`;
  const have = new Map(existing.map((e) => [key(e.kind, e.date_value ? new Date(e.date_value).toISOString() : null, e.date_text), e.id]));
  const want = dates.filter((d) => d.value || d.text);
  const keep = new Set<string>();
  const insert: Record<string, unknown>[] = [];
  for (const d of want) {
    const k = key(d.kind, d.value ?? null, d.text ?? null);
    if (have.has(k)) keep.add(have.get(k)!);
    else insert.push({ kind: d.kind, date_value: d.value ?? null, date_text: d.text ?? null, provenance: d.provenance ?? 'official', basis: d.basis ?? null });
  }
  const retire = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (retire.length) await db.query('UPDATE opportunity_dates SET is_current = false WHERE id = ANY($1::uuid[])', [retire]);
  if (insert.length)
    await db.query(
      `INSERT INTO opportunity_dates (opportunity_id, kind, date_value, date_text, provenance, connector_id, source_record_id, basis)
       SELECT $1, x.kind, x.date_value, x.date_text, x.provenance, $2, $3, x.basis FROM jsonb_to_recordset($4::jsonb) AS x(kind text, date_value timestamptz, date_text text, provenance text, basis text)`,
      [ref.opportunityId, ref.connectorId, ref.sourceRecordId, json(insert)],
    );
}

/** Replace the financial facts contributed by one source (record or derived engine). */
export async function setFinancials(
  db: Db,
  ref: SourceRef & { awardId?: string | null },
  items: { kind: string; low?: number | null; high?: number | null; label?: string | null; basis?: string | null; provenance?: Provenance; confidence?: string | null; awardId?: string | null }[],
  scopeKinds?: string[],
): Promise<void> {
  const params: unknown[] = [ref.opportunityId, ref.connectorId, ref.sourceRecordId];
  let scope = '';
  if (scopeKinds?.length) {
    params.push(scopeKinds);
    scope = ` AND kind = ANY($4::text[])`;
  }
  const existing = await db.query<{ id: string; kind: string; amount_low: number | null; amount_high: number | null; basis: string | null; award_id: string | null; provenance: string; label: string | null }>(
    `SELECT id, kind, amount_low, amount_high, basis, award_id, provenance, label FROM opportunity_financials
     WHERE opportunity_id = $1 AND connector_id = $2 AND source_record_id IS NOT DISTINCT FROM $3::uuid AND is_current${scope}`,
    params,
  );
  const sig = (k: string, lo: unknown, hi: unknown, award: unknown, prov: unknown, label: unknown, basis: unknown) => stableStringify([k, lo ?? null, hi ?? null, award ?? null, prov ?? null, label ?? null, basis ?? null]);
  const have = new Map(existing.map((e) => [sig(e.kind, e.amount_low, e.amount_high, e.award_id, e.provenance, e.label, e.basis), e.id]));
  const keep = new Set<string>();
  const insert: Record<string, unknown>[] = [];
  for (const f of items) {
    if (f.low == null && f.high == null) continue;
    const k = sig(f.kind, f.low, f.high, f.awardId ?? ref.awardId ?? null, f.provenance ?? 'official', f.label ?? null, f.basis ?? null);
    if (have.has(k)) keep.add(have.get(k)!);
    else
      insert.push({
        kind: f.kind,
        amount_low: f.low ?? null,
        amount_high: f.high ?? null,
        provenance: f.provenance ?? 'official',
        award_id: f.awardId ?? ref.awardId ?? null,
        label: f.label ?? null,
        basis: f.basis ?? null,
        confidence: f.confidence ?? null,
      });
  }
  const retire = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (retire.length) await db.query('UPDATE opportunity_financials SET is_current = false WHERE id = ANY($1::uuid[])', [retire]);
  if (insert.length)
    await db.query(
      `INSERT INTO opportunity_financials (opportunity_id, kind, amount_low, amount_high, provenance, connector_id, source_record_id, award_id, label, basis, confidence)
       SELECT $1, x.kind, x.amount_low, x.amount_high, x.provenance, $2, $3, x.award_id, x.label, x.basis, x.confidence
       FROM jsonb_to_recordset($4::jsonb) AS x(kind text, amount_low numeric, amount_high numeric, provenance text, award_id uuid, label text, basis text, confidence text)`,
      [ref.opportunityId, ref.connectorId, ref.sourceRecordId, json(insert)],
    );
}

export async function setContacts(db: Db, ref: SourceRef, contacts: NormalizedOpportunity['contacts']): Promise<void> {
  for (const c of contacts) {
    const contactId = await upsertContact(db, c);
    if (!contactId) continue;
    await db.query(
      `INSERT INTO opportunity_contacts (opportunity_id, contact_id, role, provenance, connector_id, source_record_id) VALUES ($1,$2,$3,'official',$4,$5)
       ON CONFLICT (opportunity_id, contact_id, role) DO UPDATE SET last_seen_at = now(), connector_id = EXCLUDED.connector_id, source_record_id = EXCLUDED.source_record_id`,
      [ref.opportunityId, contactId, c.role || 'primary', ref.connectorId, ref.sourceRecordId],
    );
  }
}

export async function setLocations(db: Db, ref: SourceRef, place: NormalizedOpportunity['place'], kind = 'place_of_performance'): Promise<void> {
  if (!place) return;
  const key = [place.street, place.city, place.state, place.zip, place.country].map((x) => (x ?? '').toString().trim().toUpperCase()).join('|');
  if (key.replace(/\|/g, '') === '') return;
  await db.query(
    `INSERT INTO opportunity_locations (opportunity_id, kind, street, city, state, zip, country, provenance, connector_id, source_record_id, location_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'official',$8,$9,$10) ON CONFLICT (opportunity_id, kind, location_key) DO NOTHING`,
    [ref.opportunityId, kind, place.street ?? null, place.city ?? null, place.state ?? null, place.zip ?? null, place.country ?? null, ref.connectorId, ref.sourceRecordId, key],
  );
}

/** Register document links. Returns URLs that are new to this profile. */
export async function setDocuments(db: Db, ref: SourceRef, docs: NormalizedOpportunity['documents']): Promise<string[]> {
  const created: string[] = [];
  for (const d of docs) {
    if (!d.url) continue;
    const row = await db.one<{ inserted: boolean }>(
      `INSERT INTO opportunity_documents (opportunity_id, connector_id, source_record_id, url, filename, doc_type, mime_type, size_bytes, posted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (opportunity_id, url) DO UPDATE SET last_seen_at = now(), filename = COALESCE(opportunity_documents.filename, EXCLUDED.filename),
         doc_type = COALESCE(opportunity_documents.doc_type, EXCLUDED.doc_type), mime_type = COALESCE(opportunity_documents.mime_type, EXCLUDED.mime_type),
         size_bytes = COALESCE(EXCLUDED.size_bytes, opportunity_documents.size_bytes)
       RETURNING (xmax = 0) AS inserted`,
      [ref.opportunityId, ref.connectorId, ref.sourceRecordId, d.url, d.filename ?? null, d.docType ?? null, d.mimeType ?? null, d.sizeBytes ?? null, d.postedAt ?? null],
    );
    if (row?.inserted) created.push(d.url);
  }
  return created;
}

const DATE_FIELD: Record<string, string> = {
  posted: 'posted_at',
  updated: 'source_updated_at',
  response_due: 'response_deadline',
  archive: 'archive_date',
  performance_start: 'performance_start',
  performance_end: 'performance_end',
};

/** Translate a normalized opportunity into provenance-tagged field values. */
export function fieldInputsFor(n: NormalizedOpportunity): FieldInput[] {
  const sol = n.identifiers.find((i) => i.type === 'solicitation_number')?.value ?? null;
  const notice = n.identifiers.find((i) => i.type === 'notice_id')?.value ?? null;
  const inputs: FieldInput[] = [
    { field: 'title', value: n.title },
    { field: 'description', value: n.description ?? null },
    { field: 'opportunity_class', value: n.opportunityClass },
    { field: 'stage', value: n.stage, provenance: n.stageBasis ? 'derived' : 'official', basis: n.stageBasis ?? null },
    { field: 'notice_type', value: n.noticeType ?? null },
    { field: 'status', value: n.status, provenance: n.statusBasis ? 'derived' : 'official', basis: n.statusBasis ?? null },
    { field: 'solicitation_number', value: sol },
    { field: 'notice_id', value: notice },
    { field: 'department', value: n.agency.department ?? null },
    { field: 'subtier', value: n.agency.subtier ?? null },
    { field: 'office', value: n.agency.office ?? null },
    { field: 'naics_code', value: n.naics[0] ?? null },
    { field: 'naics_codes', value: n.naics },
    { field: 'psc_code', value: n.psc ?? null },
    { field: 'set_aside_code', value: n.setAsideCode ?? null },
    { field: 'set_aside', value: n.setAside ?? null },
    { field: 'contract_vehicle', value: n.contractVehicle ?? null },
    { field: 'pricing_type', value: n.pricingType ?? null },
    { field: 'competition_type', value: n.competitionType ?? null },
    { field: 'place', value: n.place && Object.values(n.place).some(Boolean) ? n.place : null },
    { field: 'primary_url', value: n.url ?? null },
    { field: 'prime_contractor', value: n.primeContractor ?? null },
    { field: 'eligibility', value: n.eligibility ?? [] },
  ];
  for (const d of n.dates) {
    const f = DATE_FIELD[d.kind];
    if (f && d.value) inputs.push({ field: f, value: d.value, provenance: d.provenance ?? 'official', basis: d.basis ?? null });
  }
  return inputs;
}
