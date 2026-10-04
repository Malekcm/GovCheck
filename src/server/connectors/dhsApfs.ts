import { fiscalPeriod, toIso } from '../lib/dates';
import { parseMoneyRange } from '../lib/money';
import type { FetchPage, NormalizedContact, NormalizedOpportunity, RawRecord, SourceAdapter } from './types';
import { stateCode } from './util';

/**
 * DHS Acquisition Planning Forecast System (APFS) — the Department of Homeland Security's
 * official public procurement forecast. The public site is backed by an unauthenticated JSON
 * endpoint that returns every published forecast in one response (~600 records, ~1.5 MB).
 *
 * Why it matters for BD: unlike the GSA listing, APFS publishes contracting / small-business
 * contacts, the estimated solicitation release date, the contract vehicle, and — for
 * follow-on requirements — the INCUMBENT contractor and contract number, which links the
 * forecast exactly to the incumbent's award history.
 */
export const APFS_API_URL = 'https://apfs-cloud.dhs.gov/api/forecast/';
export const APFS_PUBLIC_URL = 'https://apfs-cloud.dhs.gov/forecast/';
const DEPARTMENT = 'Department of Homeland Security';

/** APFS organization prefixes → component names as SAM.gov / USAspending report them. */
const COMPONENTS: [RegExp, string][] = [
  [/^CBP\b/i, 'U.S. Customs and Border Protection'],
  [/^ICE\b/i, 'U.S. Immigration and Customs Enforcement'],
  [/^TSA\b/i, 'Transportation Security Administration'],
  [/^USCG\b/i, 'U.S. Coast Guard'],
  [/^FEMA\b/i, 'Federal Emergency Management Agency'],
  [/^USSS\b/i, 'U.S. Secret Service'],
  [/^USCIS\b/i, 'U.S. Citizenship and Immigration Services'],
  [/^FLETC\b/i, 'Federal Law Enforcement Training Centers'],
  [/CISA\b/i, 'Cybersecurity and Infrastructure Security Agency'],
  [/S&T\b/i, 'Science and Technology Directorate'],
  [/^DHS HQ\b/i, 'Office of Procurement Operations'],
];

export function apfsComponent(org: string | null | undefined): string | null {
  if (!org) return null;
  for (const [re, name] of COMPONENTS) if (re.test(org.trim())) return name;
  return org.split('/')[0].trim() || null;
}

const s = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/\u0002/g, '').trim();
  return t ? t : null;
};

/** APFS small-business program → SAM set-aside code. `small_business_set_aside` says whether it is actually set aside. */
function setAside(program: string | null, isSetAside: boolean | null): { code: string | null; label: string | null } {
  if (!program || /^none$/i.test(program)) return { code: null, label: isSetAside === false || !program ? null : 'No set-aside' };
  if (/^tbd$/i.test(program)) return { code: null, label: 'To be determined' };
  const map: Record<string, string> = { SB: 'SBA', '8(a)': '8A', SDVOSB: 'SDVOSBC', HUBZONE: 'HZC', WOSB: 'WOSB', EDWOSB: 'EDWOSB' };
  const code = map[program.toUpperCase() === 'HUBZONE' ? 'HUBZONE' : program] ?? null;
  if (isSetAside === false) return { code: null, label: `${program} program considered — not set aside` };
  return { code, label: program === 'AbilityOne' ? 'AbilityOne (procurement list)' : program };
}

/** Only an existing ordering vehicle restricts who can bid; a new definitive contract or new IDIQ does not. */
function orderingVehicle(v: string | null): string | null {
  if (!v) return null;
  if (/definitive contract|^indefinite delivery contract$|^to be determined|^unknown/i.test(v)) return null;
  return /TO\/DO|task order|delivery order|BPA|schedule|FSS|GWAC|FSSI|strategic sourcing|call order/i.test(v) ? v : null;
}

function person(role: string, first: unknown, last: unknown, email: unknown, phone: unknown, organization: string | null): NormalizedContact | null {
  const name = [s(first), s(last)].filter(Boolean).join(' ') || null;
  const em = s(email);
  if (!name && !em) return null;
  return { role, fullName: name, email: em, phone: s(phone), organization };
}

export function normalizeApfs(r: any): NormalizedOpportunity {
  const status = s(r.contract_status)?.toUpperCase() ?? null;
  const competitive = s(r.competitive);
  const followOn = status === 'REC' || /follow-?on/i.test(competitive ?? '');
  const noLongerRequired = status === 'NLR' || /no longer required/i.test(competitive ?? '');
  const component = apfsComponent(s(r.organization));
  const naicsMatch = /^(\d{2,6})/.exec(s(r.naics) ?? '');
  const range = s(r.dollar_range?.display_name ?? r.dollar_range);
  const value = parseMoneyRange(range?.replace(/\bto\b/i, '-'));
  const sa = setAside(s(r.small_business_program), typeof r.small_business_set_aside === 'boolean' ? r.small_business_set_aside : null);
  const vehicleRaw = s(r.contract_vehicle);
  const incumbentContract = s(r.contract_number);
  const incumbent = s(r.contractor);
  const fy = Number(r.fiscal_year);
  const city = s(r.place_of_performance_city);
  const state = s(r.place_of_performance_state);

  const dates: NormalizedOpportunity['dates'] = [];
  const est = (kind: string, v: unknown, basis: string, text?: string | null) => {
    const iso = toIso(v);
    if (iso || text) dates.push({ kind, value: iso, text: text ?? null, basis });
  };
  est('posted', r.published_date ?? r.publish_date, 'Date the forecast was published in DHS APFS.');
  est('updated', r.last_updated_date, 'Last update in DHS APFS.');
  est('expected_solicitation', r.estimated_solicitation_release_date ?? r.estimated_release_date, 'Estimated solicitation release date published by DHS (an estimate, not a commitment).');
  est('expected_award', r.anticipated_award_date, 'Anticipated award date published by DHS (estimate).', s(r.award_quarter));
  est('performance_start', r.estimated_period_of_performance_start, 'Estimated period of performance start published by DHS.');
  est('performance_end', r.estimated_period_of_performance_end, 'Estimated period of performance end published by DHS.');
  if (Number.isFinite(fy) && fy > 2000) dates.push({ kind: 'forecast_award_fy', text: `FY${fy}`, value: fiscalPeriod(fy).end.toISOString(), basis: 'Fiscal year of the planned award, as published.' });

  const org = component ? `DHS ${component}` : DEPARTMENT;
  const contacts = [
    person('program', r.requirements_contact_first_name, r.requirements_contact_last_name, r.requirements_contact_email, r.requirements_contact_phone, s(r.requirements_office) ?? org),
    person('program', r.alternate_contact_first_name, r.alternate_contact_last_name, r.alternate_contact_email, r.alternate_contact_phone, s(r.requirements_office) ?? org),
    person('small_business', r.sbs_coordinator_first_name, r.sbs_coordinator_last_name, r.sbs_coordinator_email, r.sbs_coordinator_phone, s(r.apfs_coordinator_office) ?? org),
  ].filter((c): c is NormalizedContact => !!c);

  const apfsNumber = s(r.apfs_number) ?? `APFS-${r.id}`;
  const identifiers: NormalizedOpportunity['identifiers'] = [
    { type: 'forecast_id', value: `APFS-${r.id}` },
    { type: 'source_listing_id', value: apfsNumber },
  ];
  // The incumbent's contract number identifies the PREDECESSOR, never this record — it links, it does not merge.
  if (followOn && incumbentContract) identifiers.push({ type: 'predecessor_piid', value: incumbentContract });

  return {
    opportunityClass: 'prime',
    stage: 'forecast',
    noticeType: `DHS APFS forecast${competitive ? ` — ${competitive}` : ''}`,
    status: noLongerRequired ? 'cancelled' : 'forecast',
    statusBasis: noLongerRequired ? 'DHS APFS marks this requirement "No Longer Required".' : undefined,
    title: s(r.requirements_title) ?? `DHS forecast ${apfsNumber}`,
    description: s(r.requirement)?.replace(/\r\n/g, '\n') ?? null,
    identifiers,
    agency: { department: DEPARTMENT, subtier: component, office: s(r.contracting_office), fullPath: s(r.organization) },
    naics: naicsMatch ? [naicsMatch[1]] : [],
    setAsideCode: sa.code,
    setAside: sa.label,
    contractVehicle: orderingVehicle(vehicleRaw),
    pricingType: s(r.contract_type) && !/unknown|to be determined/i.test(String(r.contract_type)) ? s(r.contract_type) : null,
    competitionType: competitive,
    dates,
    financials:
      value.low != null || value.high != null
        ? [{ kind: 'forecast_estimate', low: value.low, high: value.high, label: `DHS forecast dollar range: ${range}`, basis: 'Published dollar range in the DHS Acquisition Planning Forecast System.' }]
        : [],
    place: city || state ? { city: city && !/^multiple$/i.test(city) ? city : null, state: stateCode(state) } : null,
    contacts,
    documents: [],
    links: [{ url: APFS_PUBLIC_URL, label: 'DHS Acquisition Planning Forecast System' }],
    url: APFS_PUBLIC_URL,
    recompeteHint: followOn,
    extra: {
      apfsNumber,
      organization: s(r.organization),
      requirementsOffice: s(r.requirements_office),
      contractingOffice: s(r.contracting_office),
      contractStatus: status,
      competitive,
      contractVehicleRaw: vehicleRaw,
      dollarRange: range,
      awardQuarter: s(r.award_quarter),
      smallBusinessProgram: s(r.small_business_program),
      smallBusinessSetAside: r.small_business_set_aside ?? null,
      incumbentContractor: incumbent,
      incumbentContractNumber: incumbentContract,
      previousPublishedDate: s(r.previous_published_date ?? r.previous_publish_date),
      fiscalYear: Number.isFinite(fy) ? fy : null,
    },
  };
}

export const dhsApfsAdapter: SourceAdapter = {
  meta: {
    id: 'dhs_apfs',
    name: 'DHS Acquisition Planning Forecast System',
    sourceType: 'forecast',
    baseUrl: APFS_API_URL,
    accessMethod: 'api',
    authRequired: false,
    priority: 38,
    defaultScheduleMinutes: 24 * 60,
    description: 'Official DHS procurement forecast (CBP, ICE, TSA, USCG, FEMA, CISA, USSS, USCIS, FLETC, HQ): dollar range, vehicle, set-aside program, estimated solicitation/award dates, contacts, and incumbent contractor + contract number for follow-on work.',
    supportsReconcile: false,
    supportsIdentifierFetch: [],
    notes:
      'Public, unauthenticated JSON that powers apfs-cloud.dhs.gov/forecast (no robots.txt restrictions). Each run reads the full list in one request; unchanged forecasts are skipped by hash and forecasts that disappear are marked "not seen", never deleted. ' +
      'Follow-on forecasts carry the incumbent contract number, which is linked exactly to SAM/USAspending award history and recompete signals.',
  },
  parserVersion: 'apfs-1',

  isConfigured() {
    return { configured: true };
  },

  async testConnection(ctx) {
    try {
      const res = await ctx.http.request<any[]>({ url: APFS_API_URL, timeoutMs: 60_000, retries: 1 });
      const n = Array.isArray(res.data) ? res.data.length : 0;
      return n ? { status: 'healthy', message: `Connected. ${n.toLocaleString()} published DHS forecasts.` } : { status: 'degraded', message: 'APFS returned no forecasts — the API shape may have changed.' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },

  async *fetchIncremental(ctx, cursor): AsyncGenerator<FetchPage> {
    const res = await ctx.http.request<any[]>({ url: APFS_API_URL, timeoutMs: 90_000, retries: 3, hostDelayMs: 1000, maxBytes: 100 * 1024 * 1024 });
    if (!Array.isArray(res.data)) throw new Error('DHS APFS returned an unexpected payload (expected a JSON array).');
    const now = new Date();
    const records: RawRecord[] = res.data
      .filter((r) => r && r.id != null)
      .map((r) => ({ sourceRecordId: String(r.id), kind: 'forecast' as const, raw: r, retrievedAt: now, sourceUrl: APFS_PUBLIC_URL }));
    const prevCount = Number(cursor.lastCount ?? 0);
    // A sudden collapse in the published count usually means an API change, not mass cancellation.
    const warning = prevCount > 50 && records.length < prevCount * 0.5 ? `APFS returned ${records.length} forecasts vs ${prevCount} last run — verify the source before trusting "not seen" markers.` : undefined;
    for (let i = 0; i < records.length; i += 200) {
      yield { records: records.slice(i, i + 200), apiRequests: i === 0 ? 1 : 0, note: `${Math.min(i + 200, records.length)}/${records.length} DHS forecasts`, warning: i === 0 ? warning : undefined };
    }
    yield { records: [], cursor: { ...cursor, lastCount: records.length, lastFullListingAt: now.toISOString() } };
  },

  normalize(record) {
    return { type: 'opportunity', data: normalizeApfs(record.raw) };
  },
};
