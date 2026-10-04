import { Readable, Transform } from 'node:stream';
import { parse } from 'csv-parse';
import { addDays, parseDate } from '../../lib/dates';
import { normalizeIdentifier } from '../../lib/ids';
import { htmlToText } from '../../lib/text';
import { matchedTerms, termMatcher } from '../../pipeline/searchTerms';
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
export async function* streamSamCsv(
  input: NodeJS.ReadableStream,
  filter: RowFilter,
  ctx: Pick<ConnectorContext, 'shouldStop'>,
  sourceLabel: string,
  extraNote?: () => string,
): AsyncGenerator<FetchPage> {
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
      yield { records: batch, note: `${sourceLabel}: scanned ${scanned.toLocaleString()} rows, kept ${matched.toLocaleString()}${extraNote ? ` ${extraNote()}` : ''}` };
      batch = [];
    }
  }
  (parser as unknown as Readable).destroy?.();
  yield {
    records: batch,
    note: `${sourceLabel}: scanned ${scanned.toLocaleString()} rows, kept ${matched.toLocaleString()}${extraNote ? ` ${extraNote()}` : ''}`,
    cursor: { lastFileScannedAt: new Date().toISOString(), lastScanRows: scanned, lastScanMatched: matched },
  };
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

// ---------------------------------------------------------------------------
// Focused ingestion
// ---------------------------------------------------------------------------
/**
 * Supabase Free has limited storage, so by default the bulk file is still scanned in full
 * but only relevant rows are stored. A row is kept when ANY rule matches (documented in
 * docs/DEPLOY_SUPABASE_RENDER.md):
 *
 *   tracked              notice ID already in GovCheck (continued change tracking — an
 *                        opportunity is never dropped because the profile changed later)
 *   tracked_solicitation solicitation number of an opportunity already in GovCheck
 *                        (amendments re-posted under a new notice ID)
 *   naics                NAICS matches a company NAICS code, its 4-digit industry group,
 *                        or an allowed prefix (SAM_BULK_FOCUS_NAICS_PREFIXES / connector setting)
 *   psc                  PSC starts with a company PSC code
 *   title_keyword        title contains a capability / keyword discovery term
 *   description_keywords description contains ≥ 2 distinct discovery terms
 *   preferred_agency     a preferred agency posting in one of the company's NAICS sectors
 *
 * Keyword rules are skipped when the title contains a negative keyword. Set
 * SAM_BULK_INGEST_MODE=full to keep every row in the lookback window instead.
 */
export interface BulkFocus {
  naicsPrefixes: string[];
  naicsSectors: string[];
  psc: string[];
  terms: RegExp | null;
  negative: RegExp | null;
  knownNoticeIds: Set<string>;
  knownSolicitations: Set<string>;
  preferredAgencies: string[];
  minDescriptionHits: number;
}

export type FocusReason = 'tracked' | 'tracked_solicitation' | 'naics' | 'psc' | 'title_keyword' | 'description_keywords' | 'preferred_agency';

export function isKnownRow(row: Record<string, string>, focus: Pick<BulkFocus, 'knownNoticeIds' | 'knownSolicitations'>): FocusReason | null {
  if (row.NoticeId && focus.knownNoticeIds.has(row.NoticeId.trim().toUpperCase())) return 'tracked';
  const sol = normalizeIdentifier('solicitation_number', row['Sol#']);
  if (sol && focus.knownSolicitations.has(sol)) return 'tracked_solicitation';
  return null;
}

/** Why a bulk row is relevant (or null when it is not). Pure — unit tested. */
export function focusReason(row: Record<string, string>, focus: BulkFocus): FocusReason | null {
  const known = isKnownRow(row, focus);
  if (known) return known;
  const naics = (row.NaicsCode ?? '').trim();
  if (naics && focus.naicsPrefixes.some((p) => naics.startsWith(p))) return 'naics';
  const psc = (row.ClassificationCode ?? '').trim().toUpperCase();
  if (psc && focus.psc.some((p) => psc.startsWith(p.toUpperCase()))) return 'psc';
  const title = row.Title ?? '';
  const negative = focus.negative ? matchedTerms(focus.negative, title).length > 0 : false;
  if (!negative && focus.terms) {
    if (matchedTerms(focus.terms, title).length) return 'title_keyword';
    const desc = row.Description ? htmlToText(row.Description.slice(0, 12_000)) : '';
    if (matchedTerms(focus.terms, desc).length >= focus.minDescriptionHits) return 'description_keywords';
  }
  if (naics && focus.preferredAgencies.length && focus.naicsSectors.some((s) => naics.startsWith(s))) {
    const agency = `${row['Department/Ind.Agency'] ?? ''} ${row['Sub-Tier'] ?? ''}`.toLowerCase();
    if (focus.preferredAgencies.some((a) => a && agency.includes(a.toLowerCase()))) return 'preferred_agency';
  }
  return null;
}

/** Build the focus rules from the company profile and what GovCheck already tracks. */
export async function loadBulkFocus(ctx: ConnectorContext): Promise<BulkFocus> {
  const extra = [...((ctx.settings.naicsPrefixes as string[] | undefined) ?? []), ...ctx.config.samBulkFocusNaicsPrefixes];
  const naicsPrefixes = [...new Set([...ctx.focus.naics, ...ctx.focus.naics.map((n) => n.slice(0, 4)), ...extra].map((p) => p.trim()).filter((p) => p.length >= 2))];
  const knownNoticeIds = new Set<string>();
  for (const r of await ctx.db.query<{ v: string }>(`SELECT source_record_id AS v FROM source_records WHERE connector_id IN ('sam_bulk','sam_opportunities')`)) knownNoticeIds.add(r.v.trim().toUpperCase());
  for (const r of await ctx.db.query<{ v: string }>(`SELECT normalized_value AS v FROM opportunity_identifiers WHERE id_type = 'notice_id'`)) knownNoticeIds.add(r.v);
  const knownSolicitations = new Set((await ctx.db.query<{ v: string }>(`SELECT DISTINCT normalized_value AS v FROM opportunity_identifiers WHERE id_type = 'solicitation_number'`)).map((r) => r.v));
  return {
    naicsPrefixes,
    naicsSectors: [...new Set(ctx.focus.naics.map((n) => n.slice(0, 2)))],
    psc: ctx.focus.psc.filter(Boolean),
    terms: termMatcher(ctx.focus.terms ?? []),
    negative: termMatcher(ctx.focus.negativeKeywords ?? []),
    knownNoticeIds,
    knownSolicitations,
    preferredAgencies: ctx.focus.preferredAgencies ?? [],
    minDescriptionHits: Number(ctx.settings.minDescriptionHits ?? 2),
  };
}

function reasonCounter() {
  const counts: Record<string, number> = {};
  return {
    count(reason: string) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    },
    note: () => {
      const parts = Object.entries(counts).map(([k, v]) => `${k} ${v.toLocaleString()}`);
      return parts.length ? `(${parts.join(', ')})` : '';
    },
  };
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
    // Daily: the bulk extract is free (no API key, no request budget) and is the main way
    // GovCheck notices amendments and changes to SAM notices it already tracks.
    reconcileScheduleMinutes: 24 * 60,
    description: 'Official public Contract Opportunities extract (~220 MB daily CSV, plus archived fiscal-year files). Reconciles the live API so records and versions are never lost.',
    supportsReconcile: true,
    supportsIdentifierFetch: [],
    notes:
      'No API key needed and no daily request limit. Reconciliation streams the full file (daily by default). In focused mode (SAM_BULK_INGEST_MODE=focused, the default) ' +
      'only notices relevant to your profile (NAICS, PSC, capability keywords, preferred agencies) or already tracked by GovCheck are stored, keeping the database small; ' +
      'full mode keeps every notice posted within SAM_BULK_LOOKBACK_DAYS or still open. Unchanged notices are skipped by content hash. ' +
      'Archived fiscal-year files can be imported on demand (profile-filtered) from the Sources page.',
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
    const mode = (ctx.settings.ingestMode as string | undefined) ?? ctx.config.samBulkIngestMode;
    if (fy) {
      const explicit = ctx.params.naicsPrefixes as string[] | undefined;
      const stream = () => openStream(ctx, samArchiveCsvUrl(fy));
      if (explicit?.length) {
        yield* streamSamCsv(await stream(), naicsPrefixFilter([...new Set(explicit)]), ctx, `FY${fy} archive`);
        return;
      }
      // Profile-aware: NAICS industry groups, PSC, capability terms, or already tracked.
      const focus = await loadBulkFocus(ctx);
      if (!focus.naicsPrefixes.length && !focus.terms && !focus.psc.length)
        throw new Error('Archived imports are filtered by your profile. Add NAICS codes or capabilities to the company profile, or pass naicsPrefixes.');
      const counter = reasonCounter();
      const filter: RowFilter = (row) => {
        const why = focusReason(row, focus);
        if (why) counter.count(why);
        return !!why;
      };
      yield* streamSamCsv(await stream(), filter, ctx, `FY${fy} archive`, counter.note);
      return;
    }
    const lookback = Number(ctx.settings.lookbackDays ?? ctx.config.samBulkLookbackDays);
    const recent = recentOrActiveFilter(lookback);
    if (mode === 'full') {
      const prefixes = (ctx.settings.naicsPrefixes as string[] | undefined) ?? [];
      const naics = naicsPrefixFilter(prefixes);
      const stream = await openStream(ctx, SAM_FULL_CSV_URL);
      yield* streamSamCsv(stream, (r) => recent(r) && naics(r), ctx, 'Full extract (full mode)');
      return;
    }
    const focus = await loadBulkFocus(ctx);
    const counter = reasonCounter();
    const filter: RowFilter = (row) => {
      // Already-tracked notices are kept even when old, so closings and archive changes are seen.
      const known = isKnownRow(row, focus);
      if (known) {
        counter.count(known);
        return true;
      }
      if (!recent(row)) return false;
      const why = focusReason(row, focus);
      if (why) counter.count(why);
      return !!why;
    };
    const stream = await openStream(ctx, SAM_FULL_CSV_URL);
    yield* streamSamCsv(stream, filter, ctx, 'Full extract (focused mode)', counter.note);
  },

  normalize(record) {
    const row = record.raw as Record<string, string>;
    return { type: 'opportunity', data: samNoticeToNormalized(samCsvRowToNotice(row)) };
  },
};
