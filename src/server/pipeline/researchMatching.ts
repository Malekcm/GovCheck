import type { Db } from '../db';
import { normalizeIdentifier, type IdentifierType } from '../lib/ids';

const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Read-only associations. Never creates, merges, or upgrades a government record. */
export async function matchResearch(db: Db, row: Record<string, unknown>) {
  const organization = object(row.organization ?? row.awarding_office);
  const department = text(organization.department_name);
  const identifiers: [IdentifierType, string | undefined][] = [
    ['notice_id', text(row.notice_id)], ['notice_id', text(row.opportunity_id)],
    ['solicitation_number', text(row.solicitation_number ?? row.solicitation_identifier)],
    ['piid', text(row.piid)], ['idv_piid', text(object(row.parent_award).piid)],
  ];
  const opportunities = new Map<string, { id: string; title: string; evidence: string; verification: string }>();
  for (const [type, value] of identifiers) {
    const normalized = normalizeIdentifier(type, value);
    if (!normalized || (type === 'solicitation_number' && !department)) continue;
    const matches = await db.query<{ id: string; title: string }>(`SELECT DISTINCT o.id, o.title FROM opportunity_identifiers i
      JOIN opportunities o ON o.id=i.opportunity_id WHERE i.id_type=$1 AND i.normalized_value=$2
      AND o.merged_into_id IS NULL AND NOT o.is_signal
      AND ($3::text IS NULL OR lower(o.department_name)=lower($3)) LIMIT 20`,
    [type, normalized, type === 'solicitation_number' ? department : null]);
    for (const match of matches) opportunities.set(match.id, { ...match, evidence: `Exact ${type}${type === 'solicitation_number' ? ' and department' : ''}`, verification: 'identifier-match-only' });
  }
  const uei = text(row.uei ?? object(row.recipient).uei ?? object(row.prime_recipient).uei);
  const companies = uei && /^[A-Z0-9]{12}$/i.test(uei) ? await db.query<{ id: string; name: string }>('SELECT id,name FROM vendors WHERE upper(uei)=$1', [uei.toUpperCase()]) : [];
  return { opportunities: [...opportunities.values()], companies, classification: 'unverified-source-intelligence',
    coverage: opportunities.size ? 'identifier-overlap' : 'unmatched-lead-requires-review' };
}
