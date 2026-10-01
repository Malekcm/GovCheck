import { CLEARANCE_LEVELS, DEFAULT_SCORE_WEIGHTS, type ClearanceLevel, type ScoreComponent } from '../../shared/domain';
import type { Db } from '../db';
import type { CompanyContext } from './types';

export async function getCompanyId(db: Db): Promise<string | null> {
  const row = await db.one<{ id: string }>('SELECT id FROM company_profiles ORDER BY created_at LIMIT 1');
  return row?.id ?? null;
}

/** Load the (single-workspace) company profile into the shape the scoring engine needs. */
export async function loadCompanyContext(db: Db): Promise<CompanyContext> {
  const p = await db.one<any>('SELECT * FROM company_profiles ORDER BY created_at LIMIT 1');
  const id: string | null = p?.id ?? null;
  const caps = id
    ? await db.query<any>(
        `SELECT c.id, c.slug, c.name, c.category, c.keywords, cc.strength, cc.years_experience, cc.technologies
         FROM company_capabilities cc JOIN capabilities c ON c.id = cc.capability_id
         WHERE cc.company_id = $1 AND cc.status = 'confirmed'`,
        [id],
      )
    : [];
  const naics = id ? await db.query<{ code: string; is_primary: boolean }>('SELECT code, is_primary FROM company_naics WHERE company_id = $1', [id]) : [];
  const psc = id ? await db.query<{ code: string }>('SELECT code FROM company_psc WHERE company_id = $1', [id]) : [];
  const certs = id ? await db.query<{ cert_type: string; status: string }>('SELECT cert_type, status FROM company_certifications WHERE company_id = $1', [id]) : [];
  const vehicles = id ? await db.query<{ name: string }>('SELECT name FROM company_contract_vehicles WHERE company_id = $1', [id]) : [];
  const pp = id ? await db.query<any>('SELECT * FROM company_past_performance WHERE company_id = $1', [id]) : [];
  const capNames = new Map(caps.map((c) => [c.id, c.name]));

  const weights = { ...DEFAULT_SCORE_WEIGHTS, ...((p?.scoring_weights as Partial<Record<ScoreComponent, number>>) ?? {}) };
  const primary = p?.primary_naics ?? naics.find((n) => n.is_primary)?.code ?? null;
  const allNaics = [...new Set([...(primary ? [primary] : []), ...naics.map((n) => n.code)])];

  return {
    id,
    name: p?.name ?? null,
    configured: caps.length > 0 || allNaics.length > 0,
    capabilities: caps.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      category: c.category,
      keywords: c.keywords ?? [],
      strength: c.strength ?? 3,
      years: c.years_experience ?? null,
      technologies: c.technologies ?? [],
    })),
    naics: allNaics,
    primaryNaics: primary,
    psc: psc.map((x) => x.code),
    certs: Object.fromEntries(certs.map((c) => [c.cert_type, c.status as any])),
    businessSize: p?.business_size ?? null,
    samStatus: p?.sam_registration_status ?? null,
    vehicles: vehicles.map((v) => v.name),
    clearances: ((p?.security_clearances ?? []) as string[]).filter((c): c is ClearanceLevel => (CLEARANCE_LEVELS as readonly string[]).includes(c)),
    facilityClearance: p?.facility_clearance ?? null,
    pastPerformance: pp.map((x) => ({
      id: x.id,
      name: x.project_name,
      agency: x.agency,
      client: x.client,
      value: x.dollar_value,
      role: x.role,
      naics: x.naics ?? [],
      psc: x.psc ?? [],
      endDate: x.end_date,
      text: [x.project_name, x.description, x.outcomes, (x.technologies ?? []).join(' '), (x.capability_ids ?? []).map((cid: string) => capNames.get(cid) ?? '').join(' ')].filter(Boolean).join('. '),
    })),
    remoteCapable: p?.remote_capable ?? null,
    onsiteCapable: p?.onsite_capable ?? null,
    travelWillingness: p?.travel_willingness ?? null,
    serviceArea: p?.geographic_service_area ?? [],
    preferredLocations: p?.preferred_locations ?? [],
    excludedLocations: p?.excluded_locations ?? [],
    primeSubPreference: p?.prime_sub_preference ?? null,
    minValue: p?.min_contract_value ?? null,
    preferredMaxValue: p?.preferred_max_value ?? null,
    maxRealisticValue: p?.max_realistic_value ?? null,
    preferredDurationMonths: p?.preferred_duration_months ?? null,
    teamCapacity: p?.team_capacity ?? null,
    preferredAgencies: p?.preferred_agencies ?? [],
    excludedAgencies: p?.excluded_agencies ?? [],
    preferredTypes: p?.preferred_opportunity_types ?? [],
    excludedTypes: p?.excluded_opportunity_types ?? [],
    keywords: p?.keywords ?? [],
    negativeKeywords: p?.negative_keywords ?? [],
    includeGrants: p?.include_grants ?? false,
    weights,
  };
}

/** Text describing what the company does, used for scope similarity. */
export function companyCorpus(co: CompanyContext): string {
  return [
    ...co.capabilities.map((c) => `${c.name} ${c.keywords.join(' ')} ${c.technologies.join(' ')}`),
    ...co.keywords,
    ...co.pastPerformance.map((p) => p.text),
  ].join('. ');
}
