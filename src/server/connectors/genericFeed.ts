import { parse as parseCsv } from 'csv-parse/sync';
import { parse as parseHtml } from 'node-html-parser';
import { sha256 } from '../lib/hash';
import { toIso } from '../lib/dates';
import { parseMoneyRange } from '../lib/money';
import { robotsAllows } from '../lib/robots';
import { htmlToText, looksLikeHtml, sanitizeExternalHtml } from '../lib/text';
import type { OpportunityClass, Stage } from '../../shared/domain';
import type { ConnectorContext, ConnectorMeta, FetchPage, NormalizedOpportunity, RawRecord, SourceAdapter } from './types';
import { setAsideFromText, stateCode } from './util';

/**
 * Configurable connector for additional official public sources (Tier 8):
 * agency forecast CSVs, OSDBU pages that publish RSS/Atom, state/county/municipal
 * procurement feeds, transit authorities, public universities, etc.
 *
 * Supports RSS 2.0, Atom, JSON (array or nested via `itemsPath`) and CSV.
 * Field mapping is configurable; sensible defaults cover RSS/Atom.
 */
export interface FeedConfig {
  url: string;
  format: 'rss' | 'atom' | 'json' | 'csv';
  /** Opportunity class for every record from this feed. */
  opportunityClass?: OpportunityClass;
  stage?: Stage;
  jurisdiction?: string; // e.g. "State of Virginia", "City of Austin"
  jurisdictionLevel?: 'federal' | 'state' | 'county' | 'municipal' | 'authority' | 'university' | 'other';
  /** Dot path to the array of items for JSON feeds. */
  itemsPath?: string;
  /** Column / property names for JSON & CSV feeds. */
  fields?: Partial<Record<'id' | 'title' | 'description' | 'url' | 'deadline' | 'posted' | 'agency' | 'office' | 'naics' | 'value' | 'setAside' | 'solicitationNumber' | 'state' | 'contactName' | 'contactEmail' | 'contactPhone', string>>;
  requestDelayMs?: number;
}

const get = (o: any, path?: string): any => (path ? path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), o) : undefined);
const str = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());

export function parseFeedItems(body: string, cfg: FeedConfig): Record<string, unknown>[] {
  if (cfg.format === 'json') {
    const data = JSON.parse(body);
    const items = cfg.itemsPath ? get(data, cfg.itemsPath) : data;
    return Array.isArray(items) ? items : [];
  }
  if (cfg.format === 'csv') {
    return parseCsv(body, { columns: true, bom: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true }) as Record<string, unknown>[];
  }
  const root = parseHtml(body, { lowerCaseTagName: false, comment: false, blockTextElements: { script: false, style: false } });
  const nodes = cfg.format === 'atom' ? root.querySelectorAll('entry') : root.querySelectorAll('item');
  return nodes.map((n) => {
    const t = (sel: string) => n.querySelector(sel)?.text?.trim() || null;
    const linkEl = n.querySelector('link');
    const link = cfg.format === 'atom' ? linkEl?.getAttribute('href') ?? null : t('link') ?? linkEl?.getAttribute('href') ?? null;
    return {
      id: t('guid') ?? t('id') ?? link,
      title: t('title'),
      description: t('description') ?? t('summary') ?? t('content'),
      url: link,
      posted: t('pubDate') ?? t('published') ?? t('updated'),
      category: t('category'),
    };
  });
}

function mapped(item: Record<string, unknown>, cfg: FeedConfig, key: keyof NonNullable<FeedConfig['fields']>): unknown {
  const field = cfg.fields?.[key];
  if (field) return get(item, field);
  return (item as any)[key];
}

export function normalizeFeedItem(item: Record<string, unknown>, cfg: FeedConfig, connectorName: string): NormalizedOpportunity {
  const title = str(mapped(item, cfg, 'title')) ?? 'Untitled notice';
  const descRaw = str(mapped(item, cfg, 'description'));
  const url = str(mapped(item, cfg, 'url'));
  const deadline = toIso(mapped(item, cfg, 'deadline'));
  const posted = toIso(mapped(item, cfg, 'posted'));
  const value = parseMoneyRange(mapped(item, cfg, 'value'));
  const setAside = setAsideFromText(str(mapped(item, cfg, 'setAside')));
  const solNum = str(mapped(item, cfg, 'solicitationNumber'));
  const naics = str(mapped(item, cfg, 'naics'));
  const contactEmail = str(mapped(item, cfg, 'contactEmail'));
  const contactName = str(mapped(item, cfg, 'contactName'));
  const stage: Stage = cfg.stage ?? (/\b(RFI|request for information)\b/i.test(title) ? 'rfi' : /sources sought/i.test(title) ? 'sources_sought' : /forecast/i.test(title) ? 'forecast' : 'solicitation');
  return {
    opportunityClass: cfg.opportunityClass ?? 'prime',
    stage,
    stageBasis: cfg.stage ? undefined : 'Stage inferred from the feed item title.',
    noticeType: `${connectorName} item`,
    status: deadline && new Date(deadline).getTime() < Date.now() ? 'closed' : stage === 'forecast' ? 'forecast' : 'active',
    title,
    description: descRaw ? (looksLikeHtml(descRaw) ? sanitizeExternalHtml(descRaw) : descRaw) : null,
    identifiers: [
      { type: 'feed_item_id', value: `${connectorName}:${str(mapped(item, cfg, 'id')) ?? url ?? sha256(title).slice(0, 16)}` },
      ...(solNum ? [{ type: 'solicitation_number' as const, value: solNum }] : []),
    ],
    agency: { department: str(mapped(item, cfg, 'agency')) ?? cfg.jurisdiction ?? null, office: str(mapped(item, cfg, 'office')) },
    naics: naics ? naics.split(/[,;\s]+/).filter((c) => /^\d{2,6}$/.test(c)) : [],
    setAsideCode: setAside.code,
    setAside: setAside.label,
    dates: [...(posted ? [{ kind: 'posted', value: posted }] : []), ...(deadline ? [{ kind: 'response_due', value: deadline }] : [])],
    financials: value.low != null || value.high != null ? [{ kind: 'official_estimate', low: value.low, high: value.high, label: 'Value listed in feed' }] : [],
    place: str(mapped(item, cfg, 'state')) ? { state: stateCode(str(mapped(item, cfg, 'state'))) } : null,
    contacts: contactEmail || contactName ? [{ role: 'primary', fullName: contactName, email: contactEmail, phone: str(mapped(item, cfg, 'contactPhone')) }] : [],
    documents: [],
    links: url ? [{ url, label: `${connectorName} listing` }] : [],
    url,
    extra: { jurisdiction: cfg.jurisdiction ?? null, jurisdictionLevel: cfg.jurisdictionLevel ?? null, summaryText: descRaw && looksLikeHtml(descRaw) ? htmlToText(descRaw).slice(0, 500) : null },
  };
}

export function createFeedAdapter(meta: Pick<ConnectorMeta, 'id' | 'name'> & Partial<ConnectorMeta>, cfg: FeedConfig): SourceAdapter {
  const fullMeta: ConnectorMeta = {
    sourceType: 'feed',
    baseUrl: cfg.url,
    accessMethod: 'feed',
    authRequired: false,
    priority: 60,
    defaultScheduleMinutes: 24 * 60,
    description: `Custom public ${cfg.format.toUpperCase()} feed${cfg.jurisdiction ? ` — ${cfg.jurisdiction}` : ''}.`,
    supportsReconcile: false,
    supportsIdentifierFetch: [],
    ...meta,
  };
  async function load(ctx: ConnectorContext): Promise<Record<string, unknown>[]> {
    if (!cfg.url) throw new Error('Feed URL is not configured.');
    const robots = await robotsAllows(ctx.http, cfg.url);
    if (!robots.allowed) throw new Error(`robots.txt disallows ${cfg.url}`);
    // publicOnly: feed URLs are user-configured, so every hop must resolve to a public host (SSRF guard).
    const res = await ctx.http.request<string>({ url: cfg.url, responseType: 'text', timeoutMs: 60_000, retries: 2, hostDelayMs: cfg.requestDelayMs ?? 1500, maxBytes: 50 * 1024 * 1024, publicOnly: true });
    return parseFeedItems(res.data, cfg);
  }
  const itemId = (item: Record<string, unknown>) =>
    str(cfg.fields?.id ? get(item, cfg.fields.id) : (item as any).id) ?? str((item as any).url) ?? sha256(JSON.stringify(item)).slice(0, 24);
  return {
    meta: fullMeta,
    parserVersion: 'feed-1',
    isConfigured: () => (cfg.url ? { configured: true } : { configured: false, reason: 'Feed URL is missing.' }),
    async testConnection(ctx) {
      try {
        const items = await load(ctx);
        return items.length ? { status: 'healthy', message: `Feed parsed: ${items.length} items.` } : { status: 'degraded', message: 'Feed loaded but contained no items (check format / itemsPath).' };
      } catch (err) {
        return { status: 'error', message: err instanceof Error ? err.message : String(err) };
      }
    },
    async *fetchIncremental(ctx): AsyncGenerator<FetchPage> {
      const items = await load(ctx);
      const now = new Date();
      const records: RawRecord[] = items.map((item) => ({ sourceRecordId: itemId(item), kind: 'opportunity', raw: item, retrievedAt: now }));
      yield { records, apiRequests: 1, note: `${records.length} feed items` };
    },
    normalize(record) {
      return { type: 'opportunity', data: normalizeFeedItem(record.raw as Record<string, unknown>, cfg, fullMeta.name) };
    },
  };
}
