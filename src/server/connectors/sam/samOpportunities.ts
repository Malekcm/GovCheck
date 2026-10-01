import { addDays, parseDate, toDateOnly, toSamDate } from '../../lib/dates';
import { sanitizeExternalHtml } from '../../lib/text';
import type { IdentifierType } from '../../lib/ids';
import type { ConnectorContext, FetchPage, RawRecord, SourceAdapter } from '../types';
import { samApiItemToNotice, samNoticeToNormalized } from './common';

export const SAM_BUDGET_KEY = 'sam';
const BASE = 'https://api.sam.gov/opportunities/v2/search';
const PAGE_LIMIT = 1000;

function samUrl(ctx: ConnectorContext, params: Record<string, string | number>): string {
  const u = new URL(BASE);
  u.searchParams.set('api_key', ctx.config.samApiKey ?? '');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

/** How many SAM requests this connector may use now, keeping `reserve` for on-demand refreshes. */
async function available(ctx: ConnectorContext, reserve: number): Promise<number> {
  return Math.max(0, (await ctx.budget.remaining(SAM_BUDGET_KEY)) - reserve);
}

async function samSearch(ctx: ConnectorContext, params: Record<string, string | number>) {
  await ctx.budget.consume(SAM_BUDGET_KEY);
  const res = await ctx.http.request<any>({ url: samUrl(ctx, params), timeoutMs: 90_000, retries: 2, hostDelayMs: 1500 });
  return res.data ?? {};
}

function toRecords(items: any[]): RawRecord[] {
  const now = new Date();
  return items
    .filter((it) => it && it.noticeId)
    .map((it) => ({ sourceRecordId: String(it.noticeId), kind: 'opportunity' as const, raw: it, retrievedAt: now, sourceUrl: it.uiLink ?? undefined }));
}

/** Fetch the full description text for a notice (costs one SAM request). */
export async function fetchSamDescription(ctx: ConnectorContext, descriptionUrl: string): Promise<string | null> {
  if (!ctx.config.samApiKey) return null;
  if ((await ctx.budget.remaining(SAM_BUDGET_KEY)) <= 0) return null;
  const u = new URL(descriptionUrl);
  u.searchParams.set('api_key', ctx.config.samApiKey);
  await ctx.budget.consume(SAM_BUDGET_KEY);
  const res = await ctx.http.request<string>({ url: u.toString(), responseType: 'text', timeoutMs: 45_000, retries: 1, hostDelayMs: 1500 });
  const body = (res.data ?? '').trim();
  if (!body || /^description not found/i.test(body)) return null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.description === 'string') return sanitizeExternalHtml(parsed.description);
  } catch {
    /* plain text/html */
  }
  return sanitizeExternalHtml(body);
}

export const samOpportunitiesAdapter: SourceAdapter = {
  meta: {
    id: 'sam_opportunities',
    name: 'SAM.gov Contract Opportunities (API)',
    sourceType: 'federal_opportunities',
    baseUrl: BASE,
    accessMethod: 'api',
    authRequired: true,
    authEnvVar: 'SAM_API_KEY',
    priority: 10,
    defaultScheduleMinutes: 360,
    description: 'Official live feed of federal notices: forecasts-to-award lifecycle notices, sources sought, solicitations, amendments and award notices.',
    supportsReconcile: false,
    supportsIdentifierFetch: ['notice_id', 'solicitation_number'],
    notes:
      'Ingests ALL notice types posted in the window (not keyword filtered). Uses an incremental posted-date window with a 3-day overlap. ' +
      'SAM.gov personal API keys for non-federal users without a role are limited to 10 requests/day; the connector budgets requests (SAM_DAILY_REQUEST_LIMIT) and resumes the next day. ' +
      'Full descriptions require one extra request per notice, so breadth comes from the free bulk CSV connector.',
  },
  parserVersion: 'sam-opps-2',

  isConfigured(config) {
    return config.samApiKey ? { configured: true } : { configured: false, reason: 'SAM_API_KEY is not set. Request a free public API key at sam.gov (Account Details → Public API Key).' };
  },

  async testConnection(ctx) {
    if (!ctx.config.samApiKey) return { status: 'not_configured', message: 'SAM_API_KEY is not set.' };
    const remaining = await ctx.budget.remaining(SAM_BUDGET_KEY);
    if (remaining <= 0) return { status: 'degraded', message: 'Daily SAM.gov request budget is used up; requests resume tomorrow.' };
    try {
      const today = new Date();
      const data = await samSearch(ctx, { postedFrom: toSamDate(addDays(today, -1)), postedTo: toSamDate(today), limit: 1, offset: 0 });
      return { status: 'healthy', message: `Connected. ${data.totalRecords ?? 0} notices posted since yesterday.` };
    } catch (err) {
      return { status: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },

  async *fetchIncremental(ctx, cursor): AsyncGenerator<FetchPage> {
    const overlapDays = Number(ctx.settings.overlapDays ?? 3);
    const initialLookbackDays = Number(ctx.settings.initialLookbackDays ?? 14);
    const reserve = Number(ctx.settings.reserveRequests ?? 2);
    const today = new Date();
    const resume = (cursor.resume as { postedFrom: string; postedTo: string; offset: number; page: number } | undefined) ?? null;
    let offsetMode = (cursor.offsetMode as 'record' | 'page' | undefined) ?? 'record';

    let from: Date;
    let to: Date;
    let offset = 0;
    let page = 0;
    if (resume) {
      from = parseDate(resume.postedFrom) ?? addDays(today, -initialLookbackDays);
      to = parseDate(resume.postedTo) ?? today;
      offset = resume.offset;
      page = resume.page ?? 0;
    } else {
      const last = parseDate(cursor.lastPostedTo as string | undefined);
      from = last ? addDays(last, -overlapDays) : addDays(today, -initialLookbackDays);
      to = today;
    }
    // SAM limits the posted range to one year.
    if (to.getTime() - from.getTime() > 364 * 86_400_000) from = addDays(to, -364);

    for (;;) {
      if (ctx.shouldStop()) return;
      if ((await available(ctx, reserve)) <= 0) {
        yield {
          records: [],
          cursor: { ...cursor, offsetMode, resume: { postedFrom: toDateOnly(from), postedTo: toDateOnly(to), offset, page } },
          note: 'SAM.gov daily request budget reached — the window will resume automatically on the next run.',
        };
        return;
      }
      const data = await samSearch(ctx, { postedFrom: toSamDate(from), postedTo: toSamDate(to), limit: PAGE_LIMIT, offset: offsetMode === 'record' ? offset : page });
      const items: any[] = Array.isArray(data.opportunitiesData) ? data.opportunitiesData : [];
      const total = Number(data.totalRecords ?? 0);

      if (items.length === 0 && offset > 0 && offset < total && offsetMode === 'record') {
        // The API interpreted offset as a page index. Switch modes and retry this page.
        offsetMode = 'page';
        continue;
      }

      offset += items.length;
      page += 1;
      const done = items.length === 0 || offset >= total;
      yield {
        records: toRecords(items),
        apiRequests: 1,
        cursor: done
          ? { offsetMode, lastPostedTo: toDateOnly(to), resume: null }
          : { ...cursor, offsetMode, resume: { postedFrom: toDateOnly(from), postedTo: toDateOnly(to), offset, page } },
        note: `Window ${toDateOnly(from)} → ${toDateOnly(to)}: ${Math.min(offset, total)}/${total}`,
      };
      if (done) return;
    }
  },

  async fetchByIdentifier(ctx, idType: IdentifierType, value: string, hint?: Record<string, unknown>) {
    if (!ctx.config.samApiKey) throw new Error('SAM_API_KEY is not set.');
    if ((await ctx.budget.remaining(SAM_BUDGET_KEY)) <= 0) throw new Error('SAM.gov daily request budget is exhausted; try again tomorrow.');
    const today = new Date();
    const posted = parseDate(hint?.postedAt);
    const from = posted ? addDays(posted, -2) : addDays(today, -364);
    const to = posted ? (addDays(posted, 362) > today ? today : addDays(posted, 362)) : today;
    const params: Record<string, string | number> = { postedFrom: toSamDate(from), postedTo: toSamDate(to), limit: 50, offset: 0 };
    if (idType === 'notice_id') params.noticeid = value;
    else if (idType === 'solicitation_number') params.solnum = value;
    else throw new Error(`SAM opportunities cannot be fetched by ${idType}`);
    const data = await samSearch(ctx, params);
    const records = toRecords(Array.isArray(data.opportunitiesData) ? data.opportunitiesData : []);
    // Retrieve the full description (one budgeted request) for the first record.
    for (const r of records.slice(0, 1)) {
      const descUrl = (r.raw as any).description;
      if (typeof descUrl === 'string' && /^https?:/i.test(descUrl)) {
        try {
          const text = await fetchSamDescription(ctx, descUrl);
          if (text) r.rawText = text; // kept separately so the raw API JSON stays verbatim
        } catch (err) {
          ctx.log.warn('Could not fetch SAM description', err);
        }
      }
    }
    return records;
  },

  normalize(record) {
    const item = record.raw as any;
    const notice = samApiItemToNotice(item);
    if (record.rawText) notice.description = record.rawText;
    return { type: 'opportunity', data: samNoticeToNormalized(notice) };
  },
};
