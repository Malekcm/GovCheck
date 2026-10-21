import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { assertPublicUrl } from '../lib/urlSafety';
import { TangoBlocked, TangoBudget, type TangoCategory } from '../pipeline/tangoBudget';

/** Filter names verified against Tango OpenAPI 5.11.0 (2026-10-19). */
export const TANGO_FILTERS = {
  forecasts: ['agency','source_system','naics_code','naics_starts_with','fiscal_year','status','search','award_date_after','award_date_before'],
  vehicles: ['search','agency','naics_code','program_acronym','last_date_to_order_after','last_date_to_order_before'],
  idvs: ['search','uei','piid','naics','awarding_agency','solicitation_identifier','expiring_gte','expiring_lte'],
  subawards: ['prime_uei','sub_uei','recipient','award_key','awarding_agency','fiscal_year'],
  entities: ['search','uei','name','naics','cage_code'],
  contracts: ['search','uei','piid','naics','awarding_agency','solicitation_identifier','expiring_gte','expiring_lte'],
  opportunities: ['search','agency','naics','solicitation_number','opportunity_id','awardee_uei','active'],
  news: ['search','source','vertical','tag','published_after','published_before'],
  events: ['search','source','state','organizer','is_virtual','start_date_after','start_date_before'],
} as const;
export const TangoQuery = z.object({
  resource: z.enum(['forecasts','vehicles','idvs','subawards','entities','contracts','opportunities','news','events']),
  filters: z.record(z.string(), z.string().trim().min(1).max(200)),
  limit: z.number().int().min(1).max(25).default(5),
  maxPages: z.number().int().min(1).max(3).default(1),
}).strict();
export type ResearchQuery = z.infer<typeof TangoQuery>;
export function previewTango(input: unknown) {
  const query = TangoQuery.parse(input);
  const allowed: readonly string[] = TANGO_FILTERS[query.resource];
  if (Object.keys(query.filters).some(k => !allowed.includes(k))) throw new TangoBlocked('Unsupported filter for this Tango endpoint.');
  const scopes = ['search','agency','awarding_agency','naics','naics_code','naics_starts_with','uei','prime_uei','sub_uei','piid','recipient','name','cage_code','award_key','program_acronym','solicitation_number','solicitation_identifier','opportunity_id','awardee_uei','organizer','tag'];
  if (!scopes.some(k => (query.filters[k]?.length ?? 0) >= 2)) throw new TangoBlocked('Scope research with an agency, NAICS, company identifier, or capability keyword of at least two characters.');
  const endpoint = `/api/${query.resource}/`;
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...query, filters: Object.fromEntries(Object.entries(query.filters).sort()) })).digest('hex');
  return { query, endpoint, estimatedRequests: query.maxPages, maxRecords: query.limit * query.maxPages,
    fingerprint, persistence: 'transient-only', entitlement: ['news','events'].includes(query.resource) ? 'G2X User group required' : 'Plan-specific field restrictions may apply' };
}

export type TangoTransport = (url: string, init: RequestInit) => Promise<Response>;
export class TangoClient {
  private budget: TangoBudget;
  constructor(db: Db, private config: AppConfig, private transport?: TangoTransport) {
    this.budget = new TangoBudget(db, config.tango);
  }

  async research(input: unknown, fingerprint: string, category: TangoCategory = 'manual') {
    const plan = previewTango(input);
    if (fingerprint !== plan.fingerprint) throw new TangoBlocked('Preview the current query before executing it.');
    const cfg = this.config.tango;
    if (!cfg.enabled || !cfg.apiKey) throw new TangoBlocked('Configure TANGO_API_KEY and explicitly set TANGO_ENABLED=true on the server.');
    // Scheduling cannot be enabled by an environment toggle before storage rights and a cadence are reviewed.
    if (category === 'background') throw new TangoBlocked('Scheduled Tango research is not enabled in this release.');
    if (this.config.nodeEnv === 'test' && !this.transport) throw new TangoBlocked('Tests must inject a mocked Tango transport.');
    const base = new URL(cfg.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new TangoBlocked('TANGO_BASE_URL must be a trusted HTTPS origin without credentials, path, or query.');
    if (!this.transport) await assertPublicUrl(base.href);
    let url = new URL(plan.endpoint, base);
    for (const [key, value] of Object.entries(plan.query.filters)) url.searchParams.set(key, value);
    url.searchParams.set('limit', String(plan.query.limit));
    const records: Record<string, unknown>[] = [], warnings: unknown[] = [];
    const seen = new Set<string>();
    let requests = 0, hasMore = false;
    for (let page = 0; page < plan.query.maxPages; page++) {
      if (page) await new Promise(resolve => setTimeout(resolve, 3100));
      const id = await this.budget.reserve(plan.endpoint, category);
      requests++;
      let response: Response;
      try {
        response = await (this.transport ?? fetch)(url.href, {
          headers: { 'X-API-KEY': cfg.apiKey, Accept: 'application/json' },
          redirect: 'error', signal: AbortSignal.timeout(20000),
        });
      } catch {
        await this.budget.finish(id, null);
        throw new TangoBlocked('Tango network request failed. The attempt was counted; no automatic retry was made.');
      }
      await this.budget.finish(id, response.status, response.headers);
      if (!response.ok) {
        await response.body?.cancel();
        throw new TangoBlocked(response.status === 403 ? 'Tango denied this endpoint. G2X news/events require the G2X User entitlement; ask MakeGov to verify account access.' : `Tango returned HTTP ${response.status}. The attempt was counted; no automatic retry was made.`);
      }
      // Bound the body before parsing, without logging or persisting it.
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2_000_000) { await reader.cancel(); throw new TangoBlocked('Tango response exceeded the safe size limit.'); }
          chunks.push(value);
        }
      }
      let data: { results: Record<string, unknown>[]; next?: string | null; meta?: unknown; upstream_warnings?: unknown };
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!Array.isArray(data.results) || data.results.length > plan.query.limit || data.results.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Error();
      } catch { throw new TangoBlocked('Tango returned an unexpected response shape. No response content was retained.'); }
      for (const row of data.results) {
        const stableId = row.g2x_id ?? row.key ?? row.uuid ?? row.id ?? row.opportunity_id ?? row.uei;
        const key = stableId === undefined ? JSON.stringify(row) : String(stableId);
        if (!seen.has(key)) { seen.add(key); records.push(row); }
      }
      if (data.meta && typeof data.meta === 'object' && 'upgrade_hints' in data.meta) warnings.push({ upgrade_hints: data.meta.upgrade_hints });
      if (data.upstream_warnings) warnings.push(data.upstream_warnings);
      hasMore = !!data.next;
      if (!data.next || page + 1 >= plan.query.maxPages) break;
      const next = new URL(data.next, base);
      // Never send the API key to a provider-supplied URL or allow it to broaden the query.
      if (next.origin !== base.origin || next.pathname !== plan.endpoint || next.username || next.password || next.hash) throw new TangoBlocked('Unsafe Tango pagination URL rejected.');
      const paginationKeys = ['page','cursor'];
      const expected = new URL(url);
      for (const key of paginationKeys) expected.searchParams.delete(key);
      for (const [key, value] of expected.searchParams) if (next.searchParams.get(key) !== value) throw new TangoBlocked('Tango pagination changed the previewed query.');
      for (const key of next.searchParams.keys()) if (!expected.searchParams.has(key) && !paginationKeys.includes(key)) throw new TangoBlocked('Unexpected pagination parameter.');
      if (next.href === url.href) throw new TangoBlocked('Repeated Tango pagination URL rejected.');
      url = next;
    }
    return { records, warnings, requests, hasMore, observedAt: new Date().toISOString(), source: ['news','events'].includes(plan.query.resource) ? 'G2X via Tango' : 'Tango', persistence: 'transient-only', budget: await this.budget.status() };
  }
}
