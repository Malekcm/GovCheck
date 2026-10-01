import { addDays, parseDate, toDateOnly, toSamDate } from '../../lib/dates';
import { parseMoney } from '../../lib/money';
import { titleCase } from '../../lib/text';
import type { IdentifierType } from '../../lib/ids';
import type { ConnectorContext, FetchPage, NormalizedAward, RawRecord, SourceAdapter } from '../types';
import { SAM_BUDGET_KEY } from './samOpportunities';

const BASE = 'https://api.sam.gov/contract-awards/v1/search';
const LIMIT = 100;

function url(ctx: ConnectorContext, params: Record<string, string | number>): string {
  const u = new URL(BASE);
  u.searchParams.set('api_key', ctx.config.samApiKey ?? '');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function search(ctx: ConnectorContext, params: Record<string, string | number>) {
  await ctx.budget.consume(SAM_BUDGET_KEY);
  const res = await ctx.http.request<any>({ url: url(ctx, params), timeoutMs: 90_000, retries: 2, hostDelayMs: 1500 });
  return res.data ?? {};
}

const get = (o: any, path: string): any => path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), o);
const s = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const nm = (o: any): string | null => s(o?.name) ?? s(o?.code);

export function samAwardRecordId(item: any): string {
  return [get(item, 'contractId.referencedIDVPiid'), get(item, 'contractId.piid'), get(item, 'contractId.modificationNumber') ?? '0', get(item, 'contractId.transactionNumber') ?? '0']
    .map((x) => s(x) ?? '')
    .join('|');
}

/** One award family per PIID (+ parent IDV). Modifications update the same award row. */
export function samAwardKey(item: any): string {
  return `piid:${(s(get(item, 'contractId.referencedIDVPiid')) ?? '').toUpperCase()}:${(s(get(item, 'contractId.piid')) ?? '').toUpperCase()}`;
}

export function normalizeSamAward(item: any): NormalizedAward {
  const core = item.coreData ?? {};
  const det = item.awardDetails ?? {};
  const awardee = det.awardeeData ?? item.awardeeData ?? {};
  const contracting = get(core, 'federalOrganization.contractingInformation') ?? {};
  const funding = get(core, 'federalOrganization.fundingInformation') ?? {};
  const naicsArr = get(core, 'productOrServiceInformation.principalNaics');
  const naics = Array.isArray(naicsArr) && naicsArr.length ? s(naicsArr[0]?.code) : null;
  const sizeArr = get(det, 'preferenceProgramsInformation.contractingOfficerBusinessSizeDetermination');
  const pop = core.principalPlaceOfPerformance ?? {};
  return {
    awardKey: samAwardKey(item),
    piid: s(get(item, 'contractId.piid')),
    modificationNumber: s(get(item, 'contractId.modificationNumber')),
    referencedIdvPiid: s(get(item, 'contractId.referencedIDVPiid')),
    solicitationId: s(core.solicitationId),
    awardType: nm(core.awardOrIDVType) ?? s(core.awardOrIDV),
    idvType: nm(get(core, 'acquisitionData.typeOfIdc')),
    description: s(get(det, 'productOrServiceInformation.descriptionOfContractRequirement')),
    awardee: {
      name: s(get(awardee, 'awardeeHeader.legalBusinessName')) ?? s(get(awardee, 'awardeeHeader.awardeeName')),
      uei: s(get(awardee, 'awardeeUEIInformation.uniqueEntityId')),
      cage: s(get(awardee, 'awardeeUEIInformation.cageCode')),
      parentUei: s(get(awardee, 'awardeeUEIInformation.awardeeUltimateParentUniqueEntityId')),
      parentName: s(get(awardee, 'awardeeUEIInformation.awardeeUltimateParentName')),
      city: s(get(awardee, 'awardeeLocation.city')),
      state: s(get(awardee, 'awardeeLocation.state.code')),
    },
    dollarsObligated: parseMoney(get(det, 'dollars.actionObligation')),
    totalObligated: parseMoney(get(det, 'totalContractDollars.totalActionObligation')),
    baseAndAllOptions: parseMoney(get(det, 'totalContractDollars.totalBaseAndAllOptionsValue')) ?? parseMoney(get(det, 'dollars.baseAndAllOptionsValue')),
    baseAndExercised: parseMoney(get(det, 'totalContractDollars.totalBaseAndExercisedOptionsValue')) ?? parseMoney(get(det, 'dollars.baseAndExercisedOptionsValue')),
    dateSigned: toDateOnly(get(det, 'dates.dateSigned')),
    popStart: toDateOnly(get(det, 'dates.periodOfPerformanceStartDate')),
    popCurrentEnd: toDateOnly(get(det, 'dates.currentCompletionDate')),
    popPotentialEnd: toDateOnly(get(det, 'dates.ultimateCompletionDate')),
    agency: {
      department: titleCase(nm(contracting.contractingDepartment)),
      departmentCode: s(contracting.contractingDepartment?.code),
      subtier: titleCase(nm(contracting.contractingSubtier)),
      subtierCode: s(contracting.contractingSubtier?.code),
      office: titleCase(nm(contracting.contractingOffice)),
      officeCode: s(contracting.contractingOffice?.code),
    },
    fundingAgency: titleCase(nm(funding.fundingSubtier) ?? nm(funding.fundingDepartment)),
    fundingOffice: titleCase(nm(funding.fundingOffice)),
    naics,
    psc: s(get(core, 'productOrServiceInformation.productOrService.code')),
    pricingType: nm(get(core, 'acquisitionData.typeOfContractPricing')),
    extentCompeted: nm(get(core, 'competitionInformation.extentCompeted')),
    setAside: nm(get(core, 'competitionInformation.typeOfSetAside')),
    numberOfOffers: Number.parseInt(s(get(det, 'competitionInformation.numberOfOffersReceived')) ?? '', 10) || null,
    businessSize: Array.isArray(sizeArr) && sizeArr.length ? nm(sizeArr[0]) : null,
    placeState: s(pop.state?.code),
    placeCity: nm(pop.city),
    lastModified: get(det, 'transactionData.lastModifiedDate') ? parseDate(get(det, 'transactionData.lastModifiedDate'))?.toISOString() ?? null : null,
  };
}

function toRecords(items: any[]): RawRecord[] {
  const now = new Date();
  return items.filter(Boolean).map((it) => ({ sourceRecordId: samAwardRecordId(it), kind: 'award' as const, raw: it, retrievedAt: now }));
}

export const samAwardsAdapter: SourceAdapter = {
  meta: {
    id: 'sam_awards',
    name: 'SAM.gov Contract Awards (API)',
    sourceType: 'federal_awards',
    baseUrl: BASE,
    accessMethod: 'api',
    authRequired: true,
    authEnvVar: 'SAM_API_KEY',
    priority: 20,
    defaultScheduleMinutes: 24 * 60,
    description: 'Official FPDS-backed contract award data: PIIDs, IDVs, modifications, obligations, competition, pricing type and awardee details.',
    supportsReconcile: false,
    supportsIdentifierFetch: ['piid', 'solicitation_number', 'award_number'],
    notes:
      'Incremental runs pull awards modified since the last run for your profile NAICS codes (100 per request). ' +
      'Shares the SAM.gov daily request budget with the opportunities API, so it runs after it. Opportunity refreshes look awards up by solicitation ID / PIID.',
  },
  parserVersion: 'sam-awards-1',

  isConfigured(config) {
    return config.samApiKey ? { configured: true } : { configured: false, reason: 'SAM_API_KEY is not set.' };
  },

  async testConnection(ctx) {
    if (!ctx.config.samApiKey) return { status: 'not_configured', message: 'SAM_API_KEY is not set.' };
    if ((await ctx.budget.remaining(SAM_BUDGET_KEY)) <= 0) return { status: 'degraded', message: 'Daily SAM.gov request budget is used up.' };
    try {
      const today = new Date();
      const data = await search(ctx, { lastModifiedDate: `[${toSamDate(addDays(today, -2))},${toSamDate(today)}]`, limit: 1 });
      return { status: 'healthy', message: `Connected. ${data.totalRecords ?? 0} award transactions modified in the last 2 days.` };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },

  async *fetchIncremental(ctx, cursor): AsyncGenerator<FetchPage> {
    const naics = ctx.focus.naics.slice(0, 100);
    if (!naics.length) {
      yield { records: [], note: 'No NAICS codes on the company profile — add NAICS codes to pull relevant award history.' };
      return;
    }
    const reserve = Number(ctx.settings.reserveRequests ?? 2);
    const today = new Date();
    const last = parseDate(cursor.lastModifiedTo as string | undefined);
    const from = last ? addDays(last, -2) : addDays(today, -Number(ctx.settings.initialLookbackDays ?? 30));
    let offset = Number((cursor.resume as any)?.offset ?? 0);
    for (;;) {
      if (ctx.shouldStop()) return;
      if ((await ctx.budget.remaining(SAM_BUDGET_KEY)) - reserve <= 0) {
        yield { records: [], cursor: { ...cursor, resume: { offset } }, note: 'SAM.gov daily request budget reached — will resume on the next run.' };
        return;
      }
      const data = await search(ctx, { lastModifiedDate: `[${toSamDate(from)},${toSamDate(today)}]`, naicsCode: naics.join('~'), limit: LIMIT, offset });
      const items: any[] = Array.isArray(data.awardSummary) ? data.awardSummary : [];
      const total = Number(data.totalRecords ?? 0);
      offset += 1; // Contract Awards API offset is a page index (offset x limit <= 400,000)
      const done = items.length === 0 || offset * LIMIT >= total;
      yield {
        records: toRecords(items),
        apiRequests: 1,
        cursor: done ? { lastModifiedTo: toDateOnly(today), resume: null } : { ...cursor, resume: { offset } },
        note: `${Math.min(offset * LIMIT, total)}/${total} award transactions`,
      };
      if (done) return;
    }
  },

  async fetchByIdentifier(ctx, idType: IdentifierType, value: string) {
    if (!ctx.config.samApiKey) throw new Error('SAM_API_KEY is not set.');
    if ((await ctx.budget.remaining(SAM_BUDGET_KEY)) <= 0) throw new Error('SAM.gov daily request budget is exhausted.');
    const params: Record<string, string | number> = { limit: LIMIT };
    if (idType === 'piid' || idType === 'award_number') params.piid = value;
    else if (idType === 'solicitation_number') params.solicitationID = value;
    else throw new Error(`SAM awards cannot be fetched by ${idType}`);
    const data = await search(ctx, params);
    return toRecords(Array.isArray(data.awardSummary) ? data.awardSummary : []);
  },

  normalize(record) {
    return { type: 'award', data: normalizeSamAward(record.raw) };
  },
};
