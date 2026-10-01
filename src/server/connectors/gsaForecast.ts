import { parse as parseHtml } from 'node-html-parser';
import { fiscalPeriod, parseDate, toIso } from '../lib/dates';
import { parseMoneyRange } from '../lib/money';
import { decodeEntities, htmlToText } from '../lib/text';
import type { FetchPage, NormalizedOpportunity, RawRecord, SourceAdapter } from './types';
import { setAsideFromText, stateCode } from './util';

const LIST_URL = 'https://ag-dashboard.acquisitiongateway.gov/api/v3.0/resources/forecast';
export const FORECAST_PUBLIC_URL = 'https://acquisitiongateway.gov/forecast';
const PAGE_SIZE = 25;

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = htmlToText(String(v)).trim();
  return s || null;
}

function parseNaics(render: unknown): { code: string; label: string | null }[] {
  if (!render) return [];
  const root = parseHtml(String(render));
  const out: { code: string; label: string | null }[] = [];
  const codes = root.querySelectorAll('.field--name-name');
  const labels = root.querySelectorAll('.field--name-field-label');
  codes.forEach((c, i) => {
    const code = c.text.trim();
    if (/^\d{2,6}$/.test(code)) out.push({ code, label: labels[i]?.text.trim() ?? null });
  });
  if (!out.length) {
    const m = String(render).match(/\b\d{6}\b/g);
    for (const code of m ?? []) out.push({ code, label: null });
  }
  return out;
}

function parsePlace(render: unknown): { city: string | null; state: string | null; country: string | null } | null {
  if (!render) return null;
  const root = parseHtml(String(render));
  const city = root.querySelector('.locality')?.text.trim() || null;
  const state = root.querySelector('.administrative-area')?.text.trim() || null;
  const country = root.querySelector('.country')?.text.trim() || null;
  if (!city && !state && !country) {
    const t = text(render);
    return t ? { city: null, state: stateCode(t), country: null } : null;
  }
  return { city: city ? decodeEntities(city) : null, state: stateCode(state) ?? state, country };
}

async function fetchPage(ctx: Parameters<SourceAdapter['testConnection']>[0], page: number): Promise<{ rows: any[]; total: number }> {
  const res = await ctx.http.request<any>({ url: `${LIST_URL}?_format=json&page=${page}`, timeoutMs: 60_000, retries: 3, hostDelayMs: Number(ctx.settings.requestDelayMs ?? 1200) });
  const listing = res.data?.listing ?? {};
  return { rows: Array.isArray(listing.data) ? listing.data : [], total: Number(listing.total ?? 0) };
}

function toRecord(row: any): RawRecord {
  // `rank` holds site page-view/like counters that change on every visit. They carry no
  // procurement information and would create a spurious new version on every sync.
  const { rank: _volatileCounters, ...stable } = row ?? {};
  return { sourceRecordId: String(row.nid ?? row.values?.nid), kind: 'forecast', raw: stable, retrievedAt: new Date(), sourceUrl: FORECAST_PUBLIC_URL };
}

export function normalizeForecast(row: any): NormalizedOpportunity {
  const r = row.render ?? {};
  const v = row.values ?? {};
  const title = text(r.title) ?? text(v.title) ?? `Forecast ${row.nid}`;
  const department = text(r.field_result_id);
  const subagency = text(r.field_funding_organization);
  const awardStatus = text(r.field_award_status);
  const contractType = text(r.field_contract_type);
  const strategy = text(r.field_acquisition_strategy);
  const fy = Number.parseInt(text(r.field_estimated_award_fy) ?? '', 10);
  const valueText = text(r.field_estimated_contract_v_max);
  const value = parseMoneyRange(valueText);
  const naics = parseNaics(r.field_naics_code);
  const place = parsePlace(r.field_place_of_performance);
  const setAside = setAsideFromText(strategy);
  const pop = text(v.field_period_of_performance) ?? text(r.field_period_of_performance);
  const listingId = text(r.field_source_listing_id) ?? text(v.field_source_listing_id);
  const recompeteHint = /recompet|follow.?on|re-?compet/i.test(`${awardStatus ?? ''} ${strategy ?? ''} ${title}`);

  const dates: NormalizedOpportunity['dates'] = [];
  if (Number.isFinite(fy)) {
    const { start, end } = fiscalPeriod(fy);
    dates.push({ kind: 'forecast_award_fy', text: `FY${fy}`, value: end.toISOString(), basis: 'Estimated award fiscal year as published in the forecast.' });
    dates.push({ kind: 'expected_award', text: `FY${fy} (${start.toISOString().slice(0, 10)} – ${end.toISOString().slice(0, 10)})`, value: start.toISOString() });
  }
  if (pop) dates.push({ kind: 'performance_start', value: toIso(pop), text: 'Period of performance (as listed in forecast)' });
  if (v.created) dates.push({ kind: 'posted', value: parseDate(v.created)?.toISOString() ?? null });
  if (v.changed) dates.push({ kind: 'updated', value: parseDate(v.changed)?.toISOString() ?? null });

  const identifiers: NormalizedOpportunity['identifiers'] = [{ type: 'forecast_id', value: `AG-${row.nid}` }];
  if (listingId) identifiers.push({ type: 'source_listing_id', value: listingId });

  return {
    opportunityClass: 'prime',
    stage: 'forecast',
    noticeType: 'Procurement forecast',
    status: 'forecast',
    title,
    description: text(r.body) ?? text(v.body),
    identifiers,
    agency: { department, subtier: subagency && subagency !== department ? subagency : null },
    naics: naics.map((n) => n.code),
    setAsideCode: setAside.code,
    setAside: setAside.label,
    pricingType: contractType && !/to be determined/i.test(contractType) ? contractType : null,
    dates,
    financials:
      value.low != null || value.high != null
        ? [{ kind: 'forecast_estimate', low: value.low, high: value.high, label: `Forecast estimated contract value: ${valueText}`, basis: 'Published value band in the agency procurement forecast.' }]
        : [],
    place: place ? { city: place.city, state: place.state, country: place.country } : null,
    contacts: [],
    documents: [],
    links: [{ url: FORECAST_PUBLIC_URL, label: 'GSA Acquisition Gateway Forecast Tool' }],
    url: FORECAST_PUBLIC_URL,
    recompeteHint,
    extra: { awardStatus, contractType, acquisitionStrategy: strategy, estimatedValueBand: valueText, naicsLabels: naics, forecastNid: row.nid, sourceListingId: listingId },
  };
}

export const gsaForecastAdapter: SourceAdapter = {
  meta: {
    id: 'gsa_forecast',
    name: 'GSA Acquisition Gateway Forecasts',
    sourceType: 'forecast',
    baseUrl: LIST_URL,
    accessMethod: 'api',
    authRequired: false,
    priority: 40,
    defaultScheduleMinutes: 24 * 60,
    reconcileScheduleMinutes: 7 * 24 * 60,
    description: 'Government-wide procurement forecasts (planned acquisitions) published by participating agencies on GSA Acquisition Gateway.',
    supportsReconcile: true,
    supportsIdentifierFetch: [],
    notes:
      'Uses the public JSON listing behind the Forecast Tool (25 records/page). Incremental runs read the newest pages; weekly reconciliation re-reads the full listing (~400 pages) to catch edits. ' +
      'Forecast detail pages require a login.gov session and are NOT accessed, so point-of-contact details are not captured from this source.',
  },
  parserVersion: 'gsa-forecast-1',

  isConfigured() {
    return { configured: true };
  },

  async testConnection(ctx) {
    try {
      const { rows, total } = await fetchPage(ctx, 0);
      return rows.length ? { status: 'healthy', message: `Connected. ${total.toLocaleString()} forecast records listed.` } : { status: 'degraded', message: 'Listing returned no rows — the page structure may have changed.' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },

  async *fetchIncremental(ctx, cursor): AsyncGenerator<FetchPage> {
    const maxPages = Number(ctx.settings.incrementalPages ?? 20);
    const lastCreated = Number(cursor.lastCreated ?? 0);
    const overlap = 7 * 86400;
    let newest = lastCreated;
    for (let page = 0; page < maxPages; page++) {
      if (ctx.shouldStop()) return;
      const { rows, total } = await fetchPage(ctx, page);
      if (!rows.length) break;
      const created = rows.map((r) => Number(r.values?.created ?? 0));
      newest = Math.max(newest, ...created);
      const allOld = lastCreated > 0 && created.every((c) => c < lastCreated - overlap);
      yield { records: rows.map(toRecord), apiRequests: 1, note: `Page ${page + 1} of ${Math.ceil(total / PAGE_SIZE)}` };
      if (allOld) break;
    }
    yield { records: [], cursor: { ...cursor, lastCreated: newest } };
  },

  async *fetchReconcile(ctx, cursor): AsyncGenerator<FetchPage> {
    let page = Number((cursor.reconcileResume as number | undefined) ?? 0);
    let total = Infinity;
    for (; page * PAGE_SIZE < total; page++) {
      if (ctx.shouldStop()) {
        yield { records: [], cursor: { ...cursor, reconcileResume: page }, note: 'Paused — will resume from this page.' };
        return;
      }
      const res = await fetchPage(ctx, page);
      total = res.total || 0;
      if (!res.rows.length) break;
      yield { records: res.rows.map(toRecord), apiRequests: 1, cursor: { ...cursor, reconcileResume: page + 1 }, note: `Page ${page + 1} of ${Math.ceil(total / PAGE_SIZE)}` };
    }
    yield { records: [], cursor: { ...cursor, reconcileResume: 0, lastReconciledAt: new Date().toISOString() } };
  },

  normalize(record) {
    return { type: 'opportunity', data: normalizeForecast(record.raw) };
  },
};
