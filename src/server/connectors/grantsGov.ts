import { stableStringify } from '../lib/hash';
import { toIso } from '../lib/dates';
import { parseMoney } from '../lib/money';
import { htmlToText, looksLikeHtml, sanitizeExternalHtml } from '../lib/text';
import type { IdentifierType } from '../lib/ids';
import type { ConnectorContext, FetchPage, NormalizedOpportunity, RawRecord, SourceAdapter } from './types';

const API = 'https://api.grants.gov/v1/api';
export const grantsAttachmentUrl = (id: number | string) => `https://apply07.grants.gov/grantsws/rest/opportunity/att/download/${id}`;
export const grantsDetailUrl = (id: number | string) => `https://www.grants.gov/search-results-detail/${id}`;

async function search(ctx: ConnectorContext, startRecordNum: number, rows: number) {
  const res = await ctx.http.request<any>({
    url: `${API}/search2`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, startRecordNum, oppStatuses: 'forecasted|posted', sortBy: 'openDate|desc' }),
    timeoutMs: 60_000,
    retries: 3,
    hostDelayMs: 500,
  });
  if (res.data?.errorcode && res.data.errorcode !== 0) throw new Error(`Grants.gov search error: ${res.data.msg}`);
  return { hits: (res.data?.data?.oppHits ?? []) as any[], total: Number(res.data?.data?.hitCount ?? 0) };
}

async function fetchDetail(ctx: ConnectorContext, id: string | number) {
  const res = await ctx.http.request<any>({
    url: `${API}/fetchOpportunity`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opportunityId: Number(id) }),
    timeoutMs: 45_000,
    retries: 2,
    hostDelayMs: 500,
  });
  if (res.data?.errorcode && res.data.errorcode !== 0) throw new Error(`Grants.gov fetch error: ${res.data.msg}`);
  const data = res.data?.data ?? null;
  return data;
}

const s = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());

export function normalizeGrant(raw: { hit: any; detail?: any }): NormalizedOpportunity {
  const hit = raw.hit ?? {};
  const d = raw.detail ?? null;
  const syn = d?.synopsis ?? null;
  const fc = d?.forecast ?? null;
  const isForecast = (s(hit.oppStatus) ?? s(d?.docType) ?? '').toLowerCase().startsWith('forecast');
  const info = syn ?? fc ?? {};
  const descRaw = s(info.synopsisDesc) ?? s(info.forecastDesc);
  const description = descRaw ? (looksLikeHtml(descRaw) ? sanitizeExternalHtml(descRaw) : descRaw) : null;
  const id = s(hit.id) ?? s(d?.id);
  const number = s(hit.number) ?? s(d?.opportunityNumber);
  const closeDate = s(info.responseDate) ?? s(hit.closeDate) ?? s(fc?.estApplicationResponseDate);
  const openDate = s(info.postingDate) ?? s(hit.openDate);

  const contacts: NormalizedOpportunity['contacts'] = [];
  const email = s(info.agencyContactEmail);
  const contactName = s(info.agencyContactName);
  const contactDesc = s(info.agencyContactDesc);
  if (email || contactName || contactDesc) {
    const personLine = contactDesc ? htmlToText(contactDesc).split('\n')[0] : null;
    contacts.push({ role: 'grants_contact', fullName: personLine && !/@/.test(personLine) ? personLine : contactName, email, phone: s(info.agencyContactPhone ?? info.agencyPhone), organization: s(info.agencyName) });
  }

  const documents: NormalizedOpportunity['documents'] = [];
  for (const folder of Array.isArray(d?.synopsisAttachmentFolders) ? d.synopsisAttachmentFolders : []) {
    for (const att of Array.isArray(folder.synopsisAttachments) ? folder.synopsisAttachments : []) {
      documents.push({
        url: grantsAttachmentUrl(att.id),
        filename: s(att.fileName),
        mimeType: s(att.mimeType),
        sizeBytes: Number(att.fileLobSize) || null,
        postedAt: toIso(att.createdDate),
        docType: /announcement|nofo/i.test(`${folder.folderType} ${att.fileName}`) ? 'ANNOUNCEMENT' : 'ATTACHMENT',
      });
    }
  }
  for (const link of Array.isArray(d?.synopsisDocumentURLs) ? d.synopsisDocumentURLs : []) {
    if (link?.url) documents.push({ url: link.url, filename: s(link.description) ?? link.url, docType: 'ATTACHMENT' });
  }

  const financials: NormalizedOpportunity['financials'] = [];
  const ceiling = parseMoney(info.awardCeiling);
  const floor = parseMoney(info.awardFloor);
  const total = parseMoney(info.estimatedFunding);
  if (ceiling) financials.push({ kind: 'grant_ceiling', low: ceiling, high: ceiling, label: 'Award ceiling' });
  if (floor) financials.push({ kind: 'grant_floor', low: floor, high: floor, label: 'Award floor' });
  if (total) financials.push({ kind: 'grant_total_funding', low: total, high: total, label: 'Estimated total program funding' });

  const alns: string[] = Array.isArray(d?.cfdas) ? d.cfdas.map((c: any) => s(c.cfdaNumber)).filter(Boolean) : Array.isArray(hit.cfdaList) ? hit.cfdaList : [];
  const eligibility: string[] = Array.isArray(info.applicantTypes) ? info.applicantTypes.map((a: any) => s(a.description)).filter(Boolean) : [];

  return {
    opportunityClass: 'grant',
    stage: isForecast ? 'grant_forecast' : 'grant_posted',
    noticeType: isForecast ? 'Grant forecast' : 'Grant synopsis',
    status: isForecast ? 'forecast' : closeDate && new Date(toIso(closeDate) ?? 0).getTime() < Date.now() ? 'closed' : 'active',
    title: s(hit.title) ?? s(d?.opportunityTitle) ?? `Grant ${number}`,
    description,
    identifiers: [
      ...(id ? [{ type: 'grant_id' as const, value: id }] : []),
      ...(number ? [{ type: 'grant_number' as const, value: number }] : []),
    ],
    agency: { department: s(d?.topAgencyDetails?.agencyName) ?? s(info.topAgencyDetails?.agencyName), departmentCode: s(d?.topAgencyDetails?.agencyCode), subtier: s(hit.agency) ?? s(info.agencyName), subtierCode: s(hit.agencyCode) },
    naics: [],
    dates: [
      ...(openDate ? [{ kind: 'posted', value: toIso(openDate) }] : []),
      ...(closeDate ? [{ kind: 'response_due', value: toIso(closeDate) }] : []),
      ...(s(info.archiveDate) ? [{ kind: 'archive', value: toIso(info.archiveDate) }] : []),
      ...(s(info.lastUpdatedDate) ? [{ kind: 'updated', value: toIso(info.lastUpdatedDate) }] : []),
      ...(s(fc?.estAwardDate) ? [{ kind: 'expected_award', value: toIso(fc.estAwardDate) }] : []),
      ...(s(fc?.estProjectStartDate) ? [{ kind: 'performance_start', value: toIso(fc.estProjectStartDate) }] : []),
    ],
    financials,
    contacts,
    documents,
    links: [{ url: id ? grantsDetailUrl(id) : 'https://www.grants.gov', label: 'Grants.gov opportunity' }],
    url: id ? grantsDetailUrl(id) : null,
    eligibility,
    extra: {
      aln: alns,
      fundingInstruments: Array.isArray(info.fundingInstruments) ? info.fundingInstruments.map((f: any) => f.description) : [],
      fundingCategories: Array.isArray(info.fundingActivityCategories) ? info.fundingActivityCategories.map((f: any) => f.description) : [],
      expectedNumberOfAwards: s(info.numberOfAwards),
      costSharing: info.costSharing ?? null,
      eligibilityDescription: s(info.applicantEligibilityDesc),
      category: d?.opportunityCategory?.description ?? null,
      detailCaptured: !!d,
    },
  };
}

export const grantsGovAdapter: SourceAdapter = {
  meta: {
    id: 'grants_gov',
    name: 'Grants.gov',
    sourceType: 'grants',
    baseUrl: API,
    accessMethod: 'api',
    authRequired: false,
    priority: 30,
    defaultScheduleMinutes: 24 * 60,
    description: 'Federal grant and cooperative agreement opportunities (forecasted and posted). Shown separately from procurement contracts.',
    supportsReconcile: false,
    supportsIdentifierFetch: ['grant_id'],
    notes: 'Runs only when "Include grants/funding opportunities" is enabled in the company profile. Fetches the full listing of forecasted + posted grants and opportunity details for new or changed records.',
  },
  parserVersion: 'grants-1',

  isConfigured() {
    return { configured: true };
  },

  async testConnection(ctx) {
    try {
      const { total } = await search(ctx, 0, 1);
      return { status: 'healthy', message: `Connected. ${total.toLocaleString()} forecasted/posted grant opportunities.` };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },

  async *fetchIncremental(ctx, cursor): AsyncGenerator<FetchPage> {
    if (!ctx.focus.includeGrants) {
      yield { records: [], note: 'Grants are disabled in the company profile ("Include grants/funding opportunities" = No).' };
      return;
    }
    const pageSize = 250;
    const maxDetails = Number(ctx.settings.maxDetailsPerRun ?? 400);
    let detailCount = 0;
    let start = 0;
    let total = Infinity;
    while (start < total) {
      if (ctx.shouldStop()) return;
      const res = await search(ctx, start, pageSize);
      total = res.total;
      if (!res.hits.length) break;
      const records: RawRecord[] = [];
      for (const hit of res.hits) {
        const id = String(hit.id);
        const existing = await ctx.db.one<{ raw: any }>('SELECT raw FROM source_records WHERE connector_id = $1 AND source_record_id = $2', ['grants_gov', id]);
        let detail = existing?.raw?.hit && stableStringify(existing.raw.hit) === stableStringify(hit) ? existing.raw.detail : undefined;
        if (!detail && detailCount < maxDetails) {
          try {
            detail = await fetchDetail(ctx, id);
            detailCount++;
          } catch (err) {
            ctx.log.warn(`Grant detail fetch failed for ${id}`, err);
          }
        }
        records.push({ sourceRecordId: id, kind: 'grant', raw: detail ? { hit, detail } : { hit }, retrievedAt: new Date(), sourceUrl: grantsDetailUrl(id) });
      }
      start += res.hits.length;
      yield { records, apiRequests: 1 + detailCount, note: `${Math.min(start, total)}/${total} grants listed` };
    }
    yield { records: [], cursor: { ...cursor, lastFullListingAt: new Date().toISOString() } };
  },

  async fetchByIdentifier(ctx, idType: IdentifierType, value: string) {
    if (idType !== 'grant_id') throw new Error(`Grants.gov cannot be fetched by ${idType}`);
    const detail = await fetchDetail(ctx, value);
    const hit = { id: value, number: detail?.opportunityNumber, title: detail?.opportunityTitle, oppStatus: detail?.docType === 'forecast' ? 'forecasted' : 'posted' };
    const existing = await ctx.db.one<{ raw: any }>('SELECT raw FROM source_records WHERE connector_id = $1 AND source_record_id = $2', ['grants_gov', value]);
    return [{ sourceRecordId: value, kind: 'grant', raw: { hit: existing?.raw?.hit ?? hit, detail }, retrievedAt: new Date(), sourceUrl: grantsDetailUrl(value) }];
  },

  normalize(record) {
    return { type: 'opportunity', data: normalizeGrant(record.raw as any) };
  },
};
