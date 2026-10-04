import { Readable, Transform } from 'node:stream';
import { parse } from 'csv-parse';
import { addDays, parseDate } from '../../lib/dates';
import type { ConnectorContext, FetchPage, RawRecord, SourceAdapter } from '../types';
import { samCsvRowToNotice, samNoticeToNormalized } from './common';

const BASE = 'https://sam.gov/api/prod/fileextractservices/v1/api/download/Contract%20Opportunities';
export const SAM_FULL_CSV_URL = `${BASE}/datagov/ContractOpportunitiesFullCSV.csv?privacy=Public`;
export const samArchiveCsvUrl = (fy: number) => `${BASE}/Archived%20Data/FY${fy}_archived_opportunities.csv?privacy=Public`;
const BATCH = 400;

/** SAM extracts are Windows-1252 encoded. */
function windows1252Decoder(): Transform {
  const decoder = new TextDecoder('windows-1252');
  return new Transform({
    transform(chunk, _enc, cb) {
      cb(null, decoder.decode(chunk, { stream: true }));
    },
    flush(cb) {
      cb(null, decoder.decode());
    },
  });
}

export type RowFilter = (row: Record<string, string>) => boolean;

/** Stream a SAM CSV (from a web stream or node stream) into pages of RawRecords. */
export async function* streamSamCsv(input: NodeJS.ReadableStream, filter: RowFilter, ctx: Pick<ConnectorContext, 'shouldStop'>, sourceLabel: string): AsyncGenerator<FetchPage> {
  const parser = (input as Readable).pipe(windows1252Decoder()).pipe(
    parse({ columns: true, bom: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true, trim: false }),
  );
  let batch: RawRecord[] = [];
  let scanned = 0;
  let matched = 0;
  const retrievedAt = new Date();
  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    scanned++;
    if (ctx.shouldStop()) break;
    if (!row.NoticeId || !filter(row)) continue;
    matched++;
    batch.push({ sourceRecordId: row.NoticeId, kind: 'opportunity', raw: row, retrievedAt, sourceUrl: row.Link || undefined });
    if (batch.length >= BATCH) {
      yield { records: batch, note: `${sourceLabel}: scanned ${scanned.toLocaleString()} rows, matched ${matched.toLocaleString()}` };
      batch = [];
    }
  }
  (parser as unknown as Readable).destroy?.();
  yield { records: batch, note: `${sourceLabel}: scanned ${scanned.toLocaleString()} rows, matched ${matched.toLocaleString()}`, cursor: { lastFileScannedAt: new Date().toISOString(), lastScanRows: scanned, lastScanMatched: matched } };
}

export function recentOrActiveFilter(lookbackDays: number, now = new Date()): RowFilter {
  const cutoff = addDays(now, -lookbackDays).getTime();
  return (row) => {
    const posted = parseDate(row.PostedDate);
    if (posted && posted.getTime() >= cutoff) return true;
    if ((row.Active ?? '').toLowerCase() === 'yes') {
      const deadline = parseDate(row.ResponseDeadLine);
      if (deadline && deadline.getTime() >= now.getTime()) return true;
    }
    return false;
  };
}

export function naicsPrefixFilter(prefixes: string[]): RowFilter {
  const list = prefixes.map((p) => p.trim()).filter(Boolean);
  return (row) => !list.length || list.some((p) => (row.NaicsCode ?? '').startsWith(p));
}

async function openStream(ctx: ConnectorContext, url: string): Promise<NodeJS.ReadableStream> {
  const res = await ctx.http.request<ReadableStream<Uint8Array>>({ url, responseType: 'stream', timeoutMs: 60 * 60_000, retries: 2, hostDelayMs: 0 });
  if (!res.data) throw new Error('Empty response body from SAM data services');
  return Readable.fromWeb(res.data as any);
}

export const samBulkAdapter: SourceAdapter = {
  meta: {
    id: 'sam_bulk',
    name: 'SAM.gov Data Services (bulk CSV)',
    sourceType: 'federal_opportunities',
    baseUrl: SAM_FULL_CSV_URL,
    accessMethod: 'bulk',
    authRequired: false,
    priority: 15,
    defaultScheduleMinutes: null,
    reconcileScheduleMinutes: 7 * 24 * 60,
    description: 'Official public Contract Opportunities extract (~220 MB daily CSV, plus archived fiscal-year files). Reconciles the live API so records and versions are never lost.',
    supportsReconcile: true,
    supportsIdentifierFetch: [],
    notes:
      'No API key needed and no daily request limit. Reconciliation streams the full file and keeps notices posted within SAM_BULK_LOOKBACK_DAYS or still open. ' +
      'Unchanged notices are skipped by content hash. Archived fiscal-year files can be imported on demand (filtered to your NAICS prefixes) from the Sources page.',
  },
  parserVersion: 'sam-bulk-3',

  isConfigured() {
    return { configured: true };
  },

  async testConnection(ctx) {
    try {
      const res = await ctx.http.request<string>({
        url: 'https://sam.gov/api/prod/fileextractservices/v1/api/listfiles?random=1&domain=Contract+Opportunities/datagov&privacy=Public',
        responseType: 'text',
        retries: 1,
        timeoutMs: 30_000,
      });
      const ok = res.data.includes('ContractOpportunitiesFullCSV');
      const m = /"displayKey":"ContractOpportunitiesFullCSV.csv","dateModified":"([^"]+)"/.exec(res.data);
      return ok ? { status: 'healthy', message: `Full extract available${m ? ` (updated ${m[1]})` : ''}.` } : { status: 'degraded', message: 'Extract listing did not include the full CSV.' };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },

  // Incremental refreshes come from the live API; the bulk file is a reconciliation source.
  // eslint-disable-next-line require-yield
  async *fetchIncremental() {
    return;
  },

  async *fetchReconcile(ctx): AsyncGenerator<FetchPage> {
    const fy = ctx.params.fiscalYear ? Number(ctx.params.fiscalYear) : null;
    if (fy) {
      const prefixes = (ctx.params.naicsPrefixes as string[] | undefined) ?? ctx.focus.naics.map((n) => n.slice(0, 4));
      if (!prefixes.length) throw new Error('Archived imports are filtered by NAICS. Add NAICS codes to the company profile or pass naicsPrefixes.');
      const stream = await openStream(ctx, samArchiveCsvUrl(fy));
      yield* streamSamCsv(stream, naicsPrefixFilter([...new Set(prefixes)]), ctx, `FY${fy} archive`);
      return;
    }
    const lookback = Number(ctx.settings.lookbackDays ?? ctx.config.samBulkLookbackDays);
    const prefixes = (ctx.settings.naicsPrefixes as string[] | undefined) ?? [];
    const recent = recentOrActiveFilter(lookback);
    const naics = naicsPrefixFilter(prefixes);
    const stream = await openStream(ctx, SAM_FULL_CSV_URL);
    yield* streamSamCsv(stream, (r) => recent(r) && naics(r), ctx, 'Full extract');
  },

  normalize(record) {
    const row = record.raw as Record<string, string>;
    return { type: 'opportunity', data: samNoticeToNormalized(samCsvRowToNotice(row)) };
  },
};
