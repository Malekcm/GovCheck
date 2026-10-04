import { addMonths, parseDate, toDateOnly } from '../lib/dates';
import { titleCase } from '../lib/text';
import type { IdentifierType } from '../lib/ids';
import type { ConnectorContext, FetchPage, NormalizedAward, RawRecord, SourceAdapter } from './types';

const API = 'https://api.usaspending.gov/api/v2';
export const CONTRACT_AWARD_TYPES = ['A', 'B', 'C', 'D'];
export const IDV_AWARD_TYPES = ['IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E'];

const SEARCH_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Recipient UEI',
  'Start Date',
  'End Date',
  'Award Amount',
  'Total Outlays',
  'Description',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Awarding Office',
  'Funding Agency',
  'Funding Sub Agency',
  'Contract Award Type',
  'NAICS',
  'PSC',
  'Place of Performance State Code',
  'Place of Performance City Code',
  'Last Modified Date',
  'Base Obligation Date',
  'generated_internal_id',
  'recipient_id',
];

export interface AwardSearchFilters {
  naics?: string[];
  psc?: string[];
  keywords?: string[];
  awardingSubAgency?: string | null;
  awardingAgency?: string | null;
  recipientSearch?: string | null;
  awardIds?: string[];
  startDate?: string;
  endDate?: string;
  minAmount?: number;
  /** 'contracts' (A–D, default) or 'idvs' (IDIQs, GWACs, BPAs, FSS — different field names). */
  awardGroup?: 'contracts' | 'idvs';
}

/** IDV searches use different column names and have no "End Date" (the ordering period ends on "Last Date to Order"). */
const IDV_SEARCH_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Recipient UEI',
  'Start Date',
  'Last Date to Order',
  'Award Amount',
  'Total Outlays',
  'Description',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Funding Agency',
  'Funding Sub Agency',
  'Contract Award Type',
  'naics_code',
  'psc_code',
  'Place of Performance State Code',
  'Last Modified Date',
  'Base Obligation Date',
  'generated_internal_id',
  'recipient_id',
];

export async function usaspendingSearch(
  ctx: Pick<ConnectorContext, 'http'>,
  filters: AwardSearchFilters,
  opts: { page?: number; limit?: number; sort?: string; order?: 'asc' | 'desc' } = {},
): Promise<{ results: any[]; hasNext: boolean }> {
  const today = new Date();
  const f: Record<string, unknown> = {
    award_type_codes: filters.awardGroup === 'idvs' ? IDV_AWARD_TYPES : CONTRACT_AWARD_TYPES,
    time_period: [{ start_date: filters.startDate ?? toDateOnly(addMonths(today, -60)), end_date: filters.endDate ?? toDateOnly(today) }],
  };
  if (filters.naics?.length) f.naics_codes = { require: filters.naics };
  if (filters.psc?.length) f.psc_codes = { require: filters.psc.map((p) => [p]) };
  if (filters.keywords?.length) f.keywords = filters.keywords;
  if (filters.awardIds?.length) f.award_ids = filters.awardIds;
  if (filters.recipientSearch) f.recipient_search_text = [filters.recipientSearch];
  if (filters.minAmount) f.award_amounts = [{ lower_bound: filters.minAmount }];
  const agencies: unknown[] = [];
  if (filters.awardingSubAgency) agencies.push({ type: 'awarding', tier: 'subtier', name: filters.awardingSubAgency });
  else if (filters.awardingAgency) agencies.push({ type: 'awarding', tier: 'toptier', name: filters.awardingAgency });
  if (agencies.length) f.agencies = agencies;
  const res = await ctx.http.request<any>({
    url: `${API}/search/spending_by_award/`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: f, fields: filters.awardGroup === 'idvs' ? IDV_SEARCH_FIELDS : SEARCH_FIELDS, limit: opts.limit ?? 100, page: opts.page ?? 1, sort: opts.sort ?? 'Award Amount', order: opts.order ?? 'desc' }),
    timeoutMs: 60_000,
    retries: 3,
    hostDelayMs: 700,
  });
  return { results: Array.isArray(res.data?.results) ? res.data.results : [], hasNext: !!res.data?.page_metadata?.hasNext };
}

export async function usaspendingAwardDetail(ctx: Pick<ConnectorContext, 'http'>, generatedId: string): Promise<any> {
  const res = await ctx.http.request<any>({ url: `${API}/awards/${encodeURIComponent(generatedId)}/`, timeoutMs: 45_000, retries: 3, hostDelayMs: 700 });
  const detail = res.data ?? {};
  // Privacy: executive compensation names are personal data not needed for procurement intelligence.
  delete detail.executive_details;
  return detail;
}

export function searchRowToRecord(row: any, detail?: any): RawRecord {
  return {
    sourceRecordId: String(row.generated_internal_id ?? detail?.generated_unique_award_id ?? row.internal_id),
    kind: 'award',
    raw: detail ? { search: row, detail } : { search: row },
    retrievedAt: new Date(),
    sourceUrl: `https://www.usaspending.gov/award/${encodeURIComponent(String(row.generated_internal_id ?? detail?.generated_unique_award_id))}`,
  };
}

const s = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export function normalizeUsaspendingAward(raw: { search?: any; detail?: any }): NormalizedAward {
  const r = raw.search ?? {};
  const d = raw.detail ?? null;
  const ltc = d?.latest_transaction_contract_data ?? {};
  const generatedId = s(r.generated_internal_id) ?? s(d?.generated_unique_award_id) ?? '';
  const piid = s(d?.piid) ?? s(r['Award ID']);
  const parentPiid = s(d?.parent_award?.piid);
  const naics = typeof r.NAICS === 'object' && r.NAICS ? s(r.NAICS.code) : s(r.NAICS) ?? s(r.naics_code) ?? s(d?.naics_hierarchy?.base_code?.code);
  const psc = typeof r.PSC === 'object' && r.PSC ? s(r.PSC.code) : s(r.PSC) ?? s(r.psc_code) ?? s(d?.psc_hierarchy?.base_code?.code);
  const isIdv = /^CONT_IDV_/i.test(generatedId) || r['Last Date to Order'] !== undefined;
  return {
    awardKey: `piid:${(parentPiid ?? '').toUpperCase()}:${(piid ?? generatedId).toUpperCase()}`,
    piid,
    referencedIdvPiid: parentPiid,
    solicitationId: s(ltc.solicitation_identifier),
    usaspendingId: generatedId,
    awardType: s(d?.type_description) ?? s(r['Contract Award Type']),
    idvType: isIdv ? (s(d?.type_description) ?? s(r['Contract Award Type'])) : s(d?.parent_award?.idv_type_description),
    description: s(d?.description) ?? s(r.Description),
    awardee: {
      name: s(d?.recipient?.recipient_name) ?? s(r['Recipient Name']),
      uei: s(d?.recipient?.recipient_uei) ?? s(r['Recipient UEI']),
      parentUei: s(d?.recipient?.parent_recipient_uei),
      parentName: s(d?.recipient?.parent_recipient_name),
      businessTypes: Array.isArray(d?.recipient?.business_categories) ? d.recipient.business_categories : undefined,
    },
    dollarsObligated: n(d?.total_obligation) ?? n(r['Award Amount']),
    totalObligated: n(d?.total_obligation) ?? n(r['Award Amount']),
    baseAndAllOptions: n(d?.base_and_all_options),
    baseAndExercised: n(d?.base_exercised_options),
    totalOutlays: n(d?.total_outlay) ?? n(r['Total Outlays']),
    dateSigned: toDateOnly(d?.date_signed ?? r['Base Obligation Date']),
    popStart: toDateOnly(d?.period_of_performance?.start_date ?? r['Start Date']),
    // For IDVs the meaningful "end" is the last date to order (when the vehicle stops accepting orders).
    popCurrentEnd: toDateOnly(isIdv ? (r['Last Date to Order'] ?? d?.period_of_performance?.end_date) : (d?.period_of_performance?.end_date ?? r['End Date'])),
    popPotentialEnd: toDateOnly(d?.period_of_performance?.potential_end_date),
    agency: {
      department: titleCase(s(d?.awarding_agency?.toptier_agency?.name) ?? s(r['Awarding Agency'])),
      subtier: titleCase(s(d?.awarding_agency?.subtier_agency?.name) ?? s(r['Awarding Sub Agency'])),
      subtierCode: s(d?.awarding_agency?.subtier_agency?.code),
      office: titleCase(s(d?.awarding_agency?.office_agency_name) ?? s(r['Awarding Office'])),
    },
    fundingAgency: titleCase(s(d?.funding_agency?.subtier_agency?.name) ?? s(r['Funding Sub Agency']) ?? s(r['Funding Agency'])),
    fundingOffice: titleCase(s(d?.funding_agency?.office_agency_name)),
    naics,
    psc,
    pricingType: s(ltc.type_of_contract_pricing_description) ?? s(ltc.type_of_contract_pricing),
    extentCompeted: s(ltc.extent_competed_description) ?? s(ltc.extent_competed),
    setAside: s(ltc.type_set_aside_description),
    numberOfOffers: n(ltc.number_of_offers_received),
    placeState: s(d?.place_of_performance?.state_code) ?? s(r['Place of Performance State Code']),
    placeCity: titleCase(s(d?.place_of_performance?.city_name)),
    subawardCount: n(d?.subaward_count),
    subawardAmount: n(d?.total_subaward_amount),
    lastModified: parseDate(r['Last Modified Date'] ?? d?.period_of_performance?.last_modified_date)?.toISOString() ?? null,
  };
}

type PageFetcher = (page: number) => Promise<{ results: any[]; hasNext: boolean }>;

/**
 * Find the first result page (sorted by End Date ascending) containing a contract that ends on
 * or after `date`. USAspending pages are random-access, so this is an exponential probe followed
 * by a binary search: ~2·log2(pages) requests instead of walking every page.
 */
export async function firstPageEndingAfter(fetchPage: PageFetcher, date: Date, maxPage = 400, endField = 'End Date'): Promise<{ page: number; requests: number } | null> {
  let requests = 0;
  const lastEnd = async (page: number): Promise<number | null> => {
    requests++;
    const { results } = await fetchPage(page);
    if (!results.length) return null;
    const ends = results.map((r) => parseDate(r[endField])?.getTime() ?? 0);
    return Math.max(...ends);
  };
  // exponential probe for an upper bound
  let lo = 1;
  let hi = 1;
  for (;;) {
    const end = await lastEnd(hi);
    if (end === null) break; // past the last page
    if (end >= date.getTime()) break;
    lo = hi + 1;
    if (hi >= maxPage) return null;
    hi = Math.min(maxPage, hi * 2);
  }
  // binary search in [lo, hi] for the first page whose last end date >= date
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const end = await lastEnd(mid);
    if (end !== null && end >= date.getTime()) hi = mid;
    else if (end === null) hi = mid;
    else lo = mid + 1;
  }
  return { page: lo, requests };
}

/**
 * Scan for contracts in the company's NAICS codes whose period of performance ends within the
 * recompete horizon. Results are sorted by End Date ascending; the scan jumps straight to the first
 * page ending after today and walks forward until contracts end beyond the horizon.
 */
async function* recompeteScan(ctx: ConnectorContext, cursor: Record<string, unknown>): AsyncGenerator<FetchPage> {
  const naics = ctx.focus.naics.slice(0, Number(ctx.settings.maxNaics ?? 6));
  if (!naics.length) {
    yield { records: [], note: 'No NAICS codes on the company profile — add NAICS codes to scan award history and recompetes.' };
    return;
  }
  const horizonMonths = Number(ctx.settings.recompeteHorizonMonths ?? 18);
  const minAmount = Number(ctx.settings.minAwardAmount ?? 150_000);
  const maxPages = Number(ctx.settings.maxPagesPerNaics ?? 8);
  const maxDetails = Number(ctx.settings.maxDetailsPerRun ?? 60);
  const today = new Date();
  const horizon = addMonths(today, horizonMonths);
  // Contracts with any action in the last 3 years (expiring work is almost always recently active).
  const startDate = toDateOnly(addMonths(today, -36))!;
  let detailsFetched = 0;

  // Contracts (A–D) end on "End Date"; IDVs (IDIQ/GWAC/BPA/FSS) stop accepting orders on "Last Date to Order".
  // Expiring IDVs are major recompete events, so both are scanned unless includeIdvs = false.
  const groups: { group: 'contracts' | 'idvs'; endField: string; sort: string }[] = [{ group: 'contracts', endField: 'End Date', sort: 'End Date' }];
  if (ctx.settings.includeIdvs !== false) groups.push({ group: 'idvs', endField: 'Last Date to Order', sort: 'Last Date to Order' });
  for (const g of groups) {
    for (const code of naics) {
      if (ctx.shouldStop()) return;
      // IDV "Award Amount" is the obligation on the vehicle itself (usually ~$0 — the money is on the orders),
      // so a minimum-amount filter would hide nearly every expiring IDIQ/BPA. Apply it to contracts only.
      const fetchPage: PageFetcher = (page) =>
        usaspendingSearch(ctx, { naics: [code], startDate, minAmount: g.group === 'contracts' ? minAmount : undefined, awardGroup: g.group }, { page, sort: g.sort, order: 'asc' });
      const first = await firstPageEndingAfter(fetchPage, today, 400, g.endField);
      if (!first) {
        yield { records: [], note: `NAICS ${code} ${g.group}: none ending after today` };
        continue;
      }
      let requests = first.requests;
      for (let page = first.page; page < first.page + maxPages; page++) {
        if (ctx.shouldStop()) return;
        const { results, hasNext } = await fetchPage(page);
        requests++;
        const records: RawRecord[] = [];
        let beyondHorizon = false;
        for (const row of results) {
          const end = parseDate(row[g.endField]);
          if (!end || end.getTime() < today.getTime()) continue;
          if (end.getTime() > horizon.getTime()) {
            beyondHorizon = true; // later than the horizon: not a recompete yet
            continue;
          }
          let detail: any;
          if (detailsFetched < maxDetails && row.generated_internal_id) {
            try {
              detail = await usaspendingAwardDetail(ctx, String(row.generated_internal_id));
              detailsFetched++;
              requests++;
            } catch (err) {
              ctx.log.warn('USAspending detail fetch failed', err);
            }
          }
          records.push(searchRowToRecord(row, detail));
        }
        yield { records, apiRequests: requests, note: `NAICS ${code} ${g.group} page ${page}: ${records.length} ending by ${toDateOnly(horizon)}` };
        requests = 0;
        if (!hasNext || beyondHorizon) break;
      }
    }
  }
  yield { records: [], cursor: { ...cursor, lastScanAt: today.toISOString() } };
}

export const usaspendingAdapter: SourceAdapter = {
  meta: {
    id: 'usaspending',
    name: 'USAspending.gov',
    sourceType: 'spending',
    baseUrl: API,
    accessMethod: 'api',
    authRequired: false,
    priority: 25,
    defaultScheduleMinutes: 24 * 60,
    description: 'Public award and spending history: prime awards, obligations, periods of performance, recipients, agencies, subawards. Powers incumbent, pricing and recompete intelligence.',
    supportsReconcile: false,
    supportsIdentifierFetch: ['piid', 'award_number', 'usaspending_award_id', 'solicitation_number'],
    notes:
      'Scheduled runs scan contracts in your NAICS codes that end within the recompete horizon (default 18 months). ' +
      'Opportunity refreshes and agency pages run targeted searches (same agency + NAICS) for incumbent and pricing analysis. No API key required.',
  },
  parserVersion: 'usaspending-2',

  isConfigured() {
    return { configured: true };
  },

  async testConnection(ctx) {
    try {
      const res = await ctx.http.request<any>({ url: `${API}/references/toptier_agencies/`, timeoutMs: 30_000, retries: 1 });
      const count = Array.isArray(res.data?.results) ? res.data.results.length : 0;
      return { status: count ? 'healthy' : 'degraded', message: count ? `Connected (${count} agencies).` : 'Unexpected response.' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },

  fetchIncremental(ctx, cursor) {
    return recompeteScan(ctx, cursor);
  },

  async fetchByIdentifier(ctx, idType: IdentifierType, value: string) {
    if (idType === 'usaspending_award_id') {
      const detail = await usaspendingAwardDetail(ctx, value);
      return [searchRowToRecord({ generated_internal_id: value }, detail)];
    }
    const { results } = await usaspendingSearch(ctx, { awardIds: [value], startDate: '2007-10-01' }, { limit: 25 });
    const out: RawRecord[] = [];
    for (const row of results.slice(0, 10)) {
      let detail: any;
      try {
        detail = await usaspendingAwardDetail(ctx, String(row.generated_internal_id));
      } catch {
        /* search row alone is still useful */
      }
      out.push(searchRowToRecord(row, detail));
    }
    return out;
  },

  normalize(record) {
    return { type: 'award', data: normalizeUsaspendingAward(record.raw as any) };
  },
};
