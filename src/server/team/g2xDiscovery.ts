import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { normalizeIdentifier } from '../lib/ids';
import { loadCompanyContext } from '../scoring/profile';
import { agenciesCompatible, matchDiscoveryRow, recordDiscovery, type DiscoveryRow } from '../pipeline/discovery';
import { setTracking } from '../pipeline/tracking';
import { executeLiveSearch, LiveSearchRefused } from '../pipeline/targetedSearch';
import { G2X_CAPABILITIES, type G2xClient } from './g2x';
import { actor } from './security';

/**
 * G2X guided discovery. Everything here runs inside the requesting member's own G2X session:
 *  - results are returned to that member and never written to the database;
 *  - matching against GovCheck is read-only;
 *  - nothing paginates automatically (the member asks for each next page);
 *  - an official record is ingested only from an authorized government connector (SAM.gov),
 *    with G2X kept as a separate discovery attribution.
 */
export const G2X_RETENTION = 'Individual interactive session only. Not stored, not shared with teammates, not sent to another AI provider.';

// ---------------------------------------------------------------------------
// Minimal JSON Schema validation against the live discovered tool schema
// ---------------------------------------------------------------------------
type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; items?: Schema; additionalProperties?: boolean | Schema; minimum?: number; maximum?: number; maxLength?: number; minLength?: number; maxItems?: number; description?: string; default?: unknown };

const typeOk = (t: string, v: unknown) =>
  t === 'string' ? typeof v === 'string' : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'boolean' ? typeof v === 'boolean' : t === 'array' ? Array.isArray(v) : t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : t === 'null' ? v === null : true;

export function validateAgainstSchema(schema: Schema | undefined, value: unknown, path = 'arguments'): string[] {
  if (!schema) return [];
  const issues: string[] = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
  if (types.length && !types.some((t) => typeOk(t, value))) return [`${path} must be ${types.join(' or ')}`];
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) issues.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'string') {
    if (schema.maxLength != null && value.length > schema.maxLength) issues.push(`${path} is longer than ${schema.maxLength}`);
    if (schema.minLength != null && value.length < schema.minLength) issues.push(`${path} is shorter than ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) issues.push(`${path} must be ≥ ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) issues.push(`${path} must be ≤ ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) issues.push(`${path} has more than ${schema.maxItems} items`);
    value.forEach((v, i) => issues.push(...validateAgainstSchema(schema.items, v, `${path}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) issues.push(`${path}.${r} is required`);
    for (const [k, v] of Object.entries(obj)) {
      const prop = schema.properties?.[k];
      if (prop) issues.push(...validateAgainstSchema(prop, v, `${path}.${k}`));
      else if (schema.additionalProperties === false) issues.push(`${path}.${k} is not accepted by this tool`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Company profile → tool arguments (only properties the live schema declares)
// ---------------------------------------------------------------------------
const PROFILE_MAP: { profile: 'keywords' | 'naics' | 'agencies' | 'status'; names: RegExp }[] = [
  { profile: 'keywords', names: /^(query|q|keywords?|search|text|term)$/i },
  { profile: 'naics', names: /^naics(_codes?|codes?)?$/i },
  { profile: 'agencies', names: /^(agenc(y|ies)|funding_agenc(y|ies)|department|buyer)$/i },
  { profile: 'status', names: /^status$/i },
];

export async function profileArguments(deps: AppDeps, schema: Schema) {
  const company = await loadCompanyContext(deps.db);
  const row = await deps.db.one<{ keywords: string[]; preferred_agencies: string[] }>('SELECT keywords, preferred_agencies FROM company_profiles ORDER BY created_at LIMIT 1');
  const keywords = [...new Set([...(row?.keywords ?? []), ...company.capabilities.map((c: any) => c.name)])].filter(Boolean).slice(0, 5);
  const values = { keywords, naics: company.naics.slice(0, 5), agencies: (row?.preferred_agencies ?? []).slice(0, 3) };
  const args: Record<string, unknown> = {};
  const mapped: { property: string; from: string }[] = [];
  const used = new Set<string>();
  const FROM = { keywords: 'Company keywords and capabilities', naics: 'Saved NAICS codes', agencies: 'Preferred agencies', status: 'Open opportunities only' } as const;
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const m = PROFILE_MAP.find((x) => x.names.test(name));
    if (!m || used.has(m.profile)) continue;
    const types = prop.type ? (Array.isArray(prop.type) ? prop.type : [prop.type]) : ['string'];
    let value: unknown;
    if (m.profile === 'status') value = prop.enum?.includes('open') || (!prop.enum && types.includes('string')) ? 'open' : undefined;
    else {
      const list = values[m.profile];
      if (!list.length) continue;
      if (types.includes('array')) value = prop.maxItems ? list.slice(0, prop.maxItems) : list;
      else if (types.includes('string')) value = list[0];
    }
    if (value === undefined || validateAgainstSchema(prop, value).length) continue;
    args[name] = value;
    used.add(m.profile);
    mapped.push({ property: name, from: FROM[m.profile] });
  }
  const unsupported = (['keywords', 'naics', 'agencies'] as const).filter((p) => values[p].length && !used.has(p)).map((p) => FROM[p]);
  return { arguments: args, mapped, unsupported, issues: validateAgainstSchema(schema, args) };
}

// ---------------------------------------------------------------------------
// Result parsing (transient)
// ---------------------------------------------------------------------------
export interface G2xRow {
  g2xId: string;
  title: string | null;
  noticeType: string | null;
  solicitationNumber: string | null;
  responseDeadline: string | null;
  agency: string | null;
  naics: string | null;
  setAside: string | null;
  recordUrl: string | null;
  family: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeG2xUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && /(^|\.)g2x\.com$/i.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}
const str = (v: unknown, max = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function parseG2xSearch(result: any): { rows: G2xRow[]; nextCursor: string | null } {
  let structured = result?.structuredContent;
  if (!structured?.rows) {
    for (const block of result?.content ?? []) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const start = block.text.lastIndexOf('{"kind"');
      if (start < 0) continue;
      try {
        structured = JSON.parse(block.text.slice(start));
        break;
      } catch {
        /* not a JSON tail */
      }
    }
  }
  const rows: G2xRow[] = (Array.isArray(structured?.rows) ? structured.rows : [])
    .filter((r: any) => r && (r.record_type === undefined || r.record_type === 'opportunity'))
    .slice(0, 100)
    .map((r: any) => {
      const recordUrl = safeG2xUrl(r.record_url);
      const family = recordUrl ? (new URL(recordUrl).pathname.match(/\/opportunities\/([a-z_]+)\//i)?.[1]?.toLowerCase() ?? null) : null;
      return {
        g2xId: String(r.id ?? '').slice(0, 100),
        title: str(r.title, 400),
        noticeType: str(r.notice_type, 100),
        solicitationNumber: str(r.solicitation_number, 100),
        responseDeadline: str(r.response_deadline, 40),
        agency: str(r.funding_agency ?? r.agency, 200),
        naics: str(r.naics, 10),
        setAside: str(r.set_aside, 100),
        recordUrl,
        family,
      };
    })
    .filter((r: G2xRow) => r.g2xId);
  const notes: string[] = Array.isArray(structured?.notes) ? structured.notes : [];
  const nextCursor = notes.map((n) => (typeof n === 'string' ? n.match(/cursor\s+"([^"]{8,4000})"/)?.[1] : null)).find(Boolean) ?? null;
  return { rows, nextCursor };
}

/** A SAM.gov notice ID the G2X row points at — only a candidate until SAM.gov itself confirms it. */
export function samNoticeCandidate(row: Pick<G2xRow, 'g2xId' | 'family'>): string | null {
  return row.family === 'sam' && UUID.test(row.g2xId) ? row.g2xId.replace(/-/g, '').toLowerCase() : null;
}

export function toDiscoveryRow(row: G2xRow): DiscoveryRow {
  return {
    provider: 'g2x',
    recordRef: row.recordUrl ?? `g2x:${row.g2xId}`,
    recordUrl: row.recordUrl,
    title: row.title,
    agency: row.agency,
    solicitationNumber: row.solicitationNumber,
    noticeIdCandidate: samNoticeCandidate(row),
    naics: row.naics,
    officialFamily: row.family === 'sam' ? 'sam' : null,
  };
}

const GROUP_OF: Record<string, 'in_govcheck' | 'verifiable' | 'research_leads' | 'dismissed'> = {
  existing: 'in_govcheck',
  official_candidate: 'verifiable',
  potential_match: 'research_leads',
  research_lead_only: 'research_leads',
  dismissed: 'dismissed',
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerG2xDiscoveryRoutes(app: Hono, deps: AppDeps, client: G2xClient, enabled: () => void) {
  const toolCache = new Map<string, { at: number; tools: any[] }>();
  const tools = async (userId: string) => {
    const hit = toolCache.get(userId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.tools;
    const list = await client.tools(userId);
    toolCache.set(userId, { at: Date.now(), tools: list });
    return list;
  };
  const readOnlyTool = async (userId: string, name: string) => {
    const tool = (await tools(userId)).find((t) => t.name === name);
    if (!tool || tool.annotations?.readOnlyHint !== true) throw new HttpProblem(403, 'Only discovered tools explicitly annotated read-only can run.');
    return tool;
  };
  const notViewer = (c: any) => {
    if (actor(c)!.role === 'viewer') throw new HttpProblem(403, 'Viewers cannot initiate research.');
  };

  app.get('/api/g2x/guided', async (c) => {
    enabled();
    const user = actor(c)!.user_id;
    const list = (await tools(user)).filter((t) => t.annotations?.readOnlyHint === true);
    const name = c.req.query('tool') ?? list.find((t) => /search/i.test(t.name) && /opportunit/i.test(`${t.name} ${t.description ?? ''}`))?.name ?? list[0]?.name;
    const tool = list.find((t) => t.name === name);
    if (!tool) throw new HttpProblem(404, 'No read-only G2X search tool is available for your account.');
    return c.json({ tool: { name: tool.name, title: tool.title ?? tool.name, description: tool.description ?? null, inputSchema: tool.inputSchema ?? null }, ...(await profileArguments(deps, tool.inputSchema ?? {})) });
  });

  app.post('/api/g2x/search', async (c) => {
    enabled();
    notViewer(c);
    const user = actor(c)!.user_id;
    const b = z
      .object({ tool: z.string().max(150), arguments: z.record(z.string(), z.unknown()), cursor: z.string().max(4000).optional(), acknowledgeIndividualUse: z.literal(true) })
      .strict()
      .parse(await readJson(c));
    const tool = await readOnlyTool(user, b.tool);
    const args = { ...b.arguments };
    // The next page is fetched only because the member asked for it; GovCheck never loops over cursors.
    if (b.cursor) {
      if (!tool.inputSchema?.properties?.cursor) throw new HttpProblem(422, 'This tool does not accept a page cursor.');
      args.cursor = b.cursor;
    }
    const issues = validateAgainstSchema(tool.inputSchema ?? {}, args);
    if (issues.length) return c.json({ error: 'Arguments do not match the live G2X tool schema.', issues }, 422);
    const result = await client.rpc(user, 'tools/call', { name: b.tool, arguments: args });
    const { rows, nextCursor } = parseG2xSearch(result);
    const matched = [];
    for (const row of rows) {
      const match = await matchDiscoveryRow(deps.db, toDiscoveryRow(row));
      matched.push({ ...row, samNoticeCandidate: samNoticeCandidate(row), match, group: GROUP_OF[match.status] });
    }
    return c.json({
      rows: matched,
      groups: { in_govcheck: matched.filter((r) => r.group === 'in_govcheck').length, verifiable: matched.filter((r) => r.group === 'verifiable').length, research_leads: matched.filter((r) => r.group === 'research_leads').length, dismissed: matched.filter((r) => r.group === 'dismissed').length },
      nextCursor,
      retention: G2X_RETENTION,
    });
  });

  /**
   * Case B: locate the official notice through SAM.gov (the authorized government connector) and
   * ingest it through the normal pipeline. G2X is recorded only as discovery attribution.
   */
  app.post('/api/g2x/verify', async (c) => {
    enabled();
    notViewer(c);
    const user = actor(c)!.user_id;
    const b = z
      .object({
        g2xId: z.string().trim().min(8).max(100),
        recordUrl: z.string().url().max(2000).refine((u) => !!safeG2xUrl(u), 'Must be a g2x.com record link'),
        solicitationNumber: z.string().trim().max(100).nullable().optional(),
        agency: z.string().trim().max(200).nullable().optional(),
        track: z.boolean().default(true),
        confirmSamRequest: z.literal(true),
      })
      .strict()
      .parse(await readJson(c));
    const family = new URL(b.recordUrl).pathname.match(/\/opportunities\/([a-z_]+)\//i)?.[1]?.toLowerCase() ?? null;
    if (family !== 'sam') throw new HttpProblem(422, 'Only results that reference a SAM.gov notice can be verified against an official government source.');
    const startedAt = new Date();
    const notice = samNoticeCandidate({ g2xId: b.g2xId, family });
    const sol = normalizeIdentifier('solicitation_number', b.solicitationNumber ?? null);
    const confirmed = async (): Promise<string | null> => {
      if (notice) {
        const hit = await deps.db.one<{ opportunity_id: string }>(`SELECT oi.opportunity_id FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id AND o.merged_into_id IS NULL WHERE oi.id_type = 'notice_id' AND oi.normalized_value = $1 LIMIT 1`, [notice.toUpperCase()]);
        if (hit) return hit.opportunity_id;
      }
      if (sol) {
        const hits = await deps.db.query<{ id: string; department_name: string | null }>(
          `SELECT DISTINCT o.id, o.department_name FROM opportunity_identifiers oi JOIN opportunities o ON o.id = oi.opportunity_id AND o.merged_into_id IS NULL
           WHERE oi.id_type = 'solicitation_number' AND oi.normalized_value = $1 AND o.verification_status = 'government_verified' AND o.stage <> 'award'`,
          [sol],
        );
        const ok = hits.find((h) => agenciesCompatible(h.department_name, b.agency));
        if (ok) return ok.id;
      }
      return null;
    };
    let opportunityId = await confirmed();
    let requestsUsed = 0;
    const notes: string[] = [];
    if (!opportunityId) {
      const yearAgo = new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10);
      const attempts = [...(notice ? [{ noticeId: notice }] : []), ...(b.solicitationNumber ? [{ solicitationNumber: b.solicitationNumber }] : [])];
      if (!attempts.length) throw new HttpProblem(422, 'This result has no notice or solicitation identifier to verify. Track it as a research lead instead.');
      for (const a of attempts) {
        try {
          const r = await executeLiveSearch(deps, { naics: [], keywords: [], setAside: [], states: [], noticeTypes: [], postedFrom: yearAgo, ...a }, { confirm: true, maxRequests: 1, triggeredBy: `g2x-verify:${user}` });
          requestsUsed += r.requestsUsed;
          notes.push(r.message);
        } catch (err) {
          if (err instanceof LiveSearchRefused) throw new HttpProblem(err.status, err.message);
          throw err;
        }
        opportunityId = await confirmed();
        if (opportunityId) break;
      }
    }
    if (!opportunityId) return c.json({ status: 'not_found', requestsUsed, message: 'SAM.gov did not return a notice matching this result’s identifiers and agency. You can track it as a research lead.', notes });
    await recordDiscovery(deps.db, opportunityId, { provider: 'g2x', recordRef: b.recordUrl, recordUrl: b.recordUrl, actorId: user, discoveredAt: startedAt });
    const { recomputeOpportunity } = await import('../pipeline/canonical');
    const { connectorPriorities } = await import('../connectors/registry');
    await recomputeOpportunity(deps.db, opportunityId, { priorities: await connectorPriorities(deps.db) });
    if (b.track) await setTracking(deps.db, opportunityId, { tracked: true, actorId: user, reason: 'Tracked from G2X discovery (official SAM.gov record verified)' });
    return c.json({ status: 'verified', opportunityId, officialSource: 'SAM.gov', discoverySource: 'G2X', requestsUsed, notes });
  });

  /** G2X source tab: the current member's own live session view of one record. Never stored. */
  app.get('/api/g2x/record/:g2xId', async (c) => {
    enabled();
    const user = actor(c)!.user_id;
    const g2xId = z.string().regex(UUID).parse(c.req.param('g2xId'));
    const tool = (await tools(user)).find((t) => /get_record$/i.test(t.name) && t.annotations?.readOnlyHint === true);
    if (!tool) throw new HttpProblem(404, 'Your G2X account does not expose a read-only record tool.');
    const args: Record<string, unknown> = { id: g2xId };
    if (tool.inputSchema?.properties?.record_type) args.record_type = 'opportunity';
    const issues = validateAgainstSchema(tool.inputSchema ?? {}, args);
    if (issues.length) return c.json({ error: 'The G2X record tool schema changed.', issues }, 422);
    return c.json({ result: await client.rpc(user, 'tools/call', { name: tool.name, arguments: args }), retention: G2X_RETENTION });
  });

  /** Placeholder for a future licensed importer. Disabled: no written authorization covers systematic storage. */
  app.post('/api/g2x/import', async (c) => {
    const authorized = deps.config.g2xLicensedImportEnabled && G2X_CAPABILITIES.persistenceAuthorized && G2X_CAPABILITIES.automatedRefreshAuthorized;
    if (!authorized) throw new HttpProblem(403, 'Automated G2X import is disabled. It requires written authorization from G2X for systematic storage, background refresh and team sharing (see docs/g2x-data-permissions.md).');
    return c.json({ error: 'Licensed importer not implemented.' }, 501);
  });
}
