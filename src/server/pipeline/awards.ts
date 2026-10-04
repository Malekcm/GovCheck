import type { Db } from '../db';
import { json } from '../db';
import { normalizeIdentifier } from '../lib/ids';
import { formatMoney } from '../lib/money';
import type { NormalizedAward } from '../connectors/types';
import { upsertVendor } from './entities';
import { recordEvent } from './events';
import { setDates, setFinancials } from './apply';
import { upsertRelationship } from './resolve';

const MONEY_AND_POP = ['dollars_obligated', 'total_obligated', 'base_and_all_options', 'base_and_exercised', 'total_outlays', 'pop_start', 'pop_current_end', 'pop_potential_end', 'number_of_offers', 'subaward_count', 'subaward_amount'];
const DESCRIPTIVE = [
  'modification_number',
  'referenced_idv_piid',
  'solicitation_id',
  'solicitation_key',
  'usaspending_id',
  'award_type',
  'idv_type',
  'description',
  'vendor_id',
  'awardee_name',
  'awardee_uei',
  'awardee_cage',
  'department_name',
  'subtier_name',
  'office_name',
  'office_code',
  'funding_agency',
  'funding_office',
  'naics_code',
  'psc_code',
  'pricing_type',
  'extent_competed',
  'set_aside',
  'business_size',
  'place_state',
  'place_city',
  'piid',
  'piid_key',
];

/**
 * Upsert an award family. Several sources (SAM Contract Awards modifications, USAspending)
 * contribute to one row keyed by IDV+PIID. Money and period fields follow the most recently
 * modified source data; descriptive fields fill gaps; the base signature date keeps the earliest.
 */
export async function upsertAward(db: Db, a: NormalizedAward, connectorId: string, sourceRecordId: string | null): Promise<{ id: string; created: boolean }> {
  const vendorId = await upsertVendor(db, a.awardee);
  const row: Record<string, unknown> = {
    award_key: a.awardKey,
    connector_id: connectorId,
    source_record_id: sourceRecordId,
    piid: a.piid ?? null,
    piid_key: normalizeIdentifier('piid', a.piid),
    modification_number: a.modificationNumber ?? null,
    referenced_idv_piid: a.referencedIdvPiid ?? null,
    solicitation_id: a.solicitationId ?? null,
    solicitation_key: normalizeIdentifier('solicitation_number', a.solicitationId),
    usaspending_id: a.usaspendingId ?? null,
    award_type: a.awardType ?? null,
    idv_type: a.idvType ?? null,
    description: a.description ?? null,
    vendor_id: vendorId,
    awardee_name: a.awardee.name ?? null,
    awardee_uei: a.awardee.uei?.toUpperCase() ?? null,
    awardee_cage: a.awardee.cage ?? null,
    dollars_obligated: a.dollarsObligated ?? null,
    total_obligated: a.totalObligated ?? null,
    base_and_all_options: a.baseAndAllOptions ?? null,
    base_and_exercised: a.baseAndExercised ?? null,
    total_outlays: a.totalOutlays ?? null,
    date_signed: a.dateSigned ?? null,
    pop_start: a.popStart ?? null,
    pop_current_end: a.popCurrentEnd ?? null,
    pop_potential_end: a.popPotentialEnd ?? null,
    department_name: a.agency.department ?? null,
    subtier_name: a.agency.subtier ?? null,
    office_name: a.agency.office ?? null,
    office_code: a.agency.officeCode ?? null,
    funding_agency: a.fundingAgency ?? null,
    funding_office: a.fundingOffice ?? null,
    naics_code: a.naics ?? null,
    psc_code: a.psc ?? null,
    pricing_type: a.pricingType ?? null,
    extent_competed: a.extentCompeted ?? null,
    set_aside: a.setAside ?? null,
    number_of_offers: a.numberOfOffers ?? null,
    business_size: a.businessSize ?? null,
    place_state: a.placeState ?? null,
    place_city: a.placeCity ?? null,
    subaward_count: a.subawardCount ?? null,
    subaward_amount: a.subawardAmount ?? null,
    last_modified: a.lastModified ?? null,
  };
  const cols = Object.keys(row);
  const newer = `(EXCLUDED.last_modified IS NULL OR awards.last_modified IS NULL OR EXCLUDED.last_modified >= awards.last_modified)`;
  const updates = [
    ...MONEY_AND_POP.map((c) => `${c} = CASE WHEN ${newer} THEN COALESCE(EXCLUDED.${c}, awards.${c}) ELSE COALESCE(awards.${c}, EXCLUDED.${c}) END`),
    ...DESCRIPTIVE.map((c) => `${c} = COALESCE(EXCLUDED.${c}, awards.${c})`),
    `date_signed = LEAST(COALESCE(EXCLUDED.date_signed, awards.date_signed), COALESCE(awards.date_signed, EXCLUDED.date_signed))`,
    `last_modified = GREATEST(awards.last_modified, EXCLUDED.last_modified)`,
    `connector_id = EXCLUDED.connector_id`,
    `source_record_id = COALESCE(EXCLUDED.source_record_id, awards.source_record_id)`,
    `updated_at = now()`,
  ];
  const result = await db.one<{ id: string; created: boolean }>(
    `INSERT INTO awards (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (award_key) DO UPDATE SET ${updates.join(', ')}
     RETURNING id, (xmax = 0) AS created`,
    cols.map((c) => row[c]),
  );
  return result!;
}

export interface AwardLinkInput {
  relationship: 'award_of' | 'incumbent' | 'possible_incumbent' | 'predecessor' | 'possible_predecessor' | 'comparable' | 'task_order';
  confidence: 'high' | 'medium' | 'low';
  confidenceScore?: number;
  method: 'exact' | 'probabilistic' | 'manual';
  evidence: string[];
}

export async function linkAwardToOpportunity(db: Db, opportunityId: string, awardId: string, link: AwardLinkInput): Promise<boolean> {
  const rejected = await db.one(`SELECT 1 FROM opportunity_awards WHERE opportunity_id = $1 AND award_id = $2 AND status = 'rejected'`, [opportunityId, awardId]);
  if (rejected && link.method !== 'manual') return false;
  const row = await db.one<{ inserted: boolean }>(
    `INSERT INTO opportunity_awards (opportunity_id, award_id, relationship, confidence, confidence_score, method, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (opportunity_id, award_id, relationship) DO UPDATE SET confidence = EXCLUDED.confidence, confidence_score = EXCLUDED.confidence_score, evidence = EXCLUDED.evidence
     RETURNING (xmax = 0) AS inserted`,
    [opportunityId, awardId, link.relationship, link.confidence, link.confidenceScore ?? null, link.method, json(link.evidence)],
  );
  return !!row?.inserted;
}

export async function setVendorRole(db: Db, opportunityId: string, vendorId: string, role: string, confidence: string, evidence: string[]): Promise<void> {
  await db.query(
    `INSERT INTO opportunity_vendors (opportunity_id, vendor_id, role, confidence, evidence) VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (opportunity_id, vendor_id, role) DO UPDATE SET confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence`,
    [opportunityId, vendorId, role, confidence, json(evidence)],
  );
}

interface AwardRow {
  id: string;
  piid: string | null;
  piid_key: string | null;
  solicitation_key: string | null;
  solicitation_id: string | null;
  vendor_id: string | null;
  awardee_name: string | null;
  total_obligated: number | null;
  dollars_obligated: number | null;
  base_and_all_options: number | null;
  date_signed: string | null;
  pop_start: string | null;
  pop_current_end: string | null;
  pop_potential_end: string | null;
  connector_id: string;
  source_record_id: string | null;
  department_name: string | null;
}

/** Record award facts (dates, values, incumbent) onto a linked profile, with provenance. */
export async function applyAwardFacts(db: Db, opportunityId: string, award: AwardRow, relationship: AwardLinkInput['relationship'], confidence: string): Promise<void> {
  const ref = { opportunityId, connectorId: `${award.connector_id}:award`, sourceRecordId: award.source_record_id };
  const confirmed = confidence === 'high' && (relationship === 'award_of' || relationship === 'incumbent');
  const value = award.base_and_all_options ?? award.total_obligated ?? award.dollars_obligated;
  if (relationship === 'award_of') {
    await setFinancials(db, { ...ref, awardId: award.id }, [
      { kind: 'award_value', low: award.total_obligated ?? award.dollars_obligated, high: award.total_obligated ?? award.dollars_obligated, label: `Obligated on award ${award.piid}`, awardId: award.id },
      { kind: 'potential_value', low: award.base_and_all_options, high: award.base_and_all_options, label: `Base + all options on award ${award.piid}`, awardId: award.id },
    ], ['award_value', 'potential_value']);
    await setDates(db, ref, [
      ...(award.date_signed ? [{ kind: 'award_date', value: new Date(award.date_signed).toISOString() }] : []),
      ...(award.pop_start ? [{ kind: 'performance_start', value: new Date(award.pop_start).toISOString() }] : []),
      ...(award.pop_current_end ? [{ kind: 'performance_end', value: new Date(award.pop_current_end).toISOString() }] : []),
      ...(award.pop_potential_end ? [{ kind: 'potential_end', value: new Date(award.pop_potential_end).toISOString() }] : []),
    ]);
  } else if (relationship === 'incumbent' || relationship === 'possible_incumbent' || relationship === 'predecessor') {
    await setFinancials(
      db,
      { ...ref, awardId: award.id },
      value != null
        ? [
            {
              kind: 'historical_incumbent',
              low: value,
              high: value,
              awardId: award.id,
              provenance: confirmed ? 'official' : 'derived',
              confidence,
              label: `${confirmed ? 'Incumbent' : 'Possible incumbent'} award ${award.piid} (${award.awardee_name ?? 'unknown vendor'})`,
              basis: confirmed
                ? `Official award amount (${award.base_and_all_options != null ? 'base + all options' : 'obligated'}) on the linked incumbent contract.`
                : `Official award amount on a contract matched by agency/NAICS/scope similarity (${confidence} confidence). The link itself is derived.`,
            },
          ]
        : [],
      ['historical_incumbent'],
    );
  }
  if (award.vendor_id) {
    const role = relationship === 'award_of' ? 'awardee' : confirmed ? 'confirmed_incumbent' : relationship === 'possible_incumbent' ? 'possible_incumbent' : null;
    if (role) await setVendorRole(db, opportunityId, award.vendor_id, role, confidence, [`Award ${award.piid}`]);
  }
}

/** Exact links for an award: solicitation ID ↔ solicitation number; PIID ↔ award number/PIID; PIID ↔ predecessor PIID. Returns affected profile IDs. */
export async function linkAwardExact(db: Db, awardId: string): Promise<string[]> {
  const award = await db.one<AwardRow>('SELECT * FROM awards WHERE id = $1', [awardId]);
  if (!award) return [];
  const touched = new Set<string>();

  const link = async (oppId: string, input: AwardLinkInput) => {
    const isNew = await linkAwardToOpportunity(db, oppId, award.id, input);
    await applyAwardFacts(db, oppId, award, input.relationship, input.confidence);
    touched.add(oppId);
    if (isNew && input.relationship === 'award_of') {
      await recordEvent(db, oppId, {
        type: 'AWARD_POSTED',
        title: `Award ${award.piid ?? ''} to ${award.awardee_name ?? 'unknown vendor'}${award.total_obligated ? ` (${formatMoney(award.total_obligated)} obligated)` : ''}`,
        dedupeKey: `award:${award.id}`,
        occurredAt: award.date_signed,
        isLifecycle: true,
        lifecycleStage: 'award',
        connectorId: award.connector_id,
        sourceRecordId: award.source_record_id,
        detail: { awardId: award.id, evidence: input.evidence },
      });
    }
    if (isNew && input.relationship === 'incumbent') {
      await recordEvent(db, oppId, { type: 'INCUMBENT_IDENTIFIED', title: `Incumbent contract ${award.piid} (${award.awardee_name ?? 'unknown'}) linked`, dedupeKey: `incumbent:${award.id}`, detail: { awardId: award.id } });
    }
  };

  if (award.solicitation_key) {
    const opps = await db.query<{ id: string; posted_at: string | null; department_name: string | null; is_signal: boolean }>(
      `SELECT DISTINCT o.id, o.posted_at, o.department_name, o.is_signal FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id
       WHERE oi.id_type = 'solicitation_number' AND oi.normalized_value = $1 AND o.merged_into_id IS NULL`,
      [award.solicitation_key],
    );
    for (const o of opps) {
      if (o.is_signal) continue;
      const signed = award.date_signed ? new Date(award.date_signed).getTime() : null;
      const posted = o.posted_at ? new Date(o.posted_at).getTime() : null;
      // A contract signed long before this notice was posted that shares the solicitation number
      // is an earlier award (e.g. a reused solicitation) — a predecessor, not this notice's award.
      if (signed && posted && signed < posted - 365 * 86_400_000) {
        await link(o.id, { relationship: 'possible_predecessor', confidence: 'medium', method: 'exact', evidence: [`Award solicitation ID ${award.solicitation_id} matches, but the award was signed over a year before this notice was posted.`] });
      } else {
        await link(o.id, { relationship: 'award_of', confidence: 'high', method: 'exact', evidence: [`Award solicitation ID ${award.solicitation_id} matches this profile's solicitation number.`] });
      }
    }
  }
  if (award.piid_key) {
    const opps = await db.query<{ id: string; id_type: string }>(
      `SELECT DISTINCT o.id, oi.id_type FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id
       WHERE oi.id_type IN ('piid','award_number','predecessor_piid') AND oi.normalized_value = $1 AND o.merged_into_id IS NULL`,
      [award.piid_key],
    );
    for (const o of opps) {
      if (o.id_type === 'predecessor_piid') await link(o.id, { relationship: 'incumbent', confidence: 'high', method: 'exact', evidence: [`The source names contract ${award.piid} as the incumbent / predecessor contract.`] });
      else await link(o.id, { relationship: 'award_of', confidence: 'high', method: 'exact', evidence: [`Award PIID ${award.piid} matches the award number on this notice.`] });
    }
  }
  return [...touched];
}

/**
 * A record that names its predecessor contract (e.g. a DHS APFS follow-on forecast) links
 * exactly to (a) award records already stored for that PIID — as the incumbent — and (b) any
 * POSSIBLE RECOMPETE signal generated from the same contract (they describe the same follow-on).
 * When the source also names the incumbent contractor, that official fact is recorded even if
 * no award record has been retrieved yet.
 */
export async function linkPredecessorContracts(db: Db, opportunityId: string, predecessorPiids: string[], incumbent?: { name: string | null; contract: string | null } | null): Promise<string[]> {
  const touched = new Set<string>();
  for (const raw of predecessorPiids) {
    const key = normalizeIdentifier('piid', raw);
    if (!key) continue;
    for (const a of await db.query<{ id: string }>(`SELECT id FROM awards WHERE piid_key = $1 AND award_key NOT LIKE 'sam_notice:%'`, [key])) {
      for (const id of await linkAwardExact(db, a.id)) touched.add(id);
    }
    const signals = await db.query<{ id: string }>(
      `SELECT DISTINCT o.id FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id
       WHERE oi.id_type = 'predecessor_piid' AND oi.normalized_value = $1 AND o.is_signal AND o.merged_into_id IS NULL AND o.id <> $2`,
      [key, opportunityId],
    );
    for (const sgl of signals) {
      await upsertRelationship(db, opportunityId, sgl.id, 'forecast_of', 0.95, 'exact', [`Both reference incumbent contract ${raw}: this record is the planned follow-on of the expiring contract.`]);
      touched.add(sgl.id);
    }
  }
  if (incumbent?.name) {
    const vendorId = await upsertVendor(db, { name: incumbent.name });
    if (vendorId) {
      const existing = await db.one(`SELECT 1 FROM opportunity_vendors WHERE opportunity_id = $1 AND vendor_id = $2 AND role = 'confirmed_incumbent'`, [opportunityId, vendorId]);
      await setVendorRole(db, opportunityId, vendorId, 'confirmed_incumbent', 'high', [`Source lists ${incumbent.name}${incumbent.contract ? ` (contract ${incumbent.contract})` : ''} as the incumbent.`]);
      if (!existing)
        await recordEvent(db, opportunityId, {
          type: 'INCUMBENT_IDENTIFIED',
          title: `Incumbent named by source: ${incumbent.name}${incumbent.contract ? ` (${incumbent.contract})` : ''}`,
          dedupeKey: `incumbent-named:${vendorId}`,
        });
    }
  }
  touched.add(opportunityId);
  return [...touched];
}
