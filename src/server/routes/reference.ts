import type { Hono } from 'hono';
import type { AppDeps } from '../app';
import { NAICS_SECTORS, naicsSector } from '../../shared/domain';

/**
 * Lookup lists for search forms (NAICS codes, agencies). Built only from what GovCheck already
 * holds: the company profile, opportunities and award records. Read-only, cached briefly.
 */
export interface NaicsOption {
  code: string;
  title: string | null;
  sector: string | null;
  inProfile: boolean;
  count: number;
}

const TTL_MS = 60 * 1000;

export function registerReferenceRoutes(app: Hono, deps: AppDeps) {
  const { db } = deps;
  let naicsCache: { at: number; rows: NaicsOption[] } | null = null;
  let agencyCache: { at: number; rows: { name: string; parent: string | null; count: number; preferred: boolean }[] } | null = null;

  const loadNaics = async (): Promise<NaicsOption[]> => {
    if (naicsCache && Date.now() - naicsCache.at < TTL_MS) return naicsCache.rows;
    const [profile, seen, titled] = await Promise.all([
      db.query<{ code: string; description: string | null }>('SELECT code, description FROM company_naics'),
      db.query<{ code: string; n: number }>(
        `SELECT code, sum(n)::int AS n FROM (
           SELECT naics_code AS code, count(*) AS n FROM opportunities WHERE merged_into_id IS NULL AND naics_code ~ '^[0-9]{2,6}$' GROUP BY 1
           UNION ALL
           SELECT naics_code, count(*) FROM awards WHERE naics_code ~ '^[0-9]{2,6}$' GROUP BY 1
         ) x GROUP BY code`,
      ),
      // USAspending award records carry the official NAICS title next to the code.
      db.query<{ code: string; title: string }>(
        `SELECT DISTINCT ON (code) code, title FROM (
           SELECT COALESCE(raw->'search'->'NAICS'->>'code', raw->'detail'->'naics_hierarchy'->'base_code'->>'code') AS code,
                  COALESCE(raw->'search'->'NAICS'->>'description', raw->'detail'->'naics_hierarchy'->'base_code'->>'description') AS title
           FROM source_records WHERE connector_id = 'usaspending' AND raw IS NOT NULL
         ) t WHERE code ~ '^[0-9]{2,6}$' AND title IS NOT NULL AND title <> '' ORDER BY code, title`,
      ),
    ]);
    const map = new Map<string, NaicsOption>();
    const get = (code: string) => {
      let o = map.get(code);
      if (!o) map.set(code, (o = { code, title: null, sector: naicsSector(code), inProfile: false, count: 0 }));
      return o;
    };
    for (const s of NAICS_SECTORS) for (const c of s.codes) get(c).title = s.title;
    for (const t of titled) get(t.code).title ??= titleCase(t.title);
    for (const s of seen) get(s.code).count = s.n;
    for (const p of profile) {
      const o = get(p.code);
      o.inProfile = true;
      if (p.description) o.title = p.description;
    }
    const rows = [...map.values()].sort((a, b) => Number(b.inProfile) - Number(a.inProfile) || b.count - a.count || a.code.localeCompare(b.code));
    naicsCache = { at: Date.now(), rows };
    return rows;
  };

  app.get('/api/reference/naics', async (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 80);
    const rows = await loadNaics();
    const words = q.split(/\s+/).filter(Boolean);
    const hits = !q
      ? rows
      : rows.filter((r) => (/^\d+$/.test(q) ? r.code.startsWith(q) : words.every((w) => `${r.code} ${r.title ?? ''} ${r.sector ?? ''}`.toLowerCase().includes(w))));
    return c.json({ total: hits.length, options: hits.slice(0, 50) });
  });

  app.get('/api/reference/agencies', async (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 80);
    if (!agencyCache || Date.now() - agencyCache.at > TTL_MS) {
      const [agencies, prefs] = await Promise.all([
        db.query<{ name: string; parent: string | null; count: number }>(
          `SELECT a.name, p.name AS parent,
             (SELECT count(*)::int FROM opportunities o WHERE o.merged_into_id IS NULL AND (o.agency_id = a.id OR o.subagency_id = a.id)) AS count
           FROM agencies a LEFT JOIN agencies p ON p.id = a.parent_id`,
        ),
        db.one<{ preferred_agencies: string[] }>('SELECT preferred_agencies FROM company_profiles ORDER BY created_at LIMIT 1'),
      ]);
      const preferred = new Set((prefs?.preferred_agencies ?? []).map((s) => s.toLowerCase()));
      const rows = agencies.map((a) => ({ ...a, preferred: preferred.has(a.name.toLowerCase()) }));
      for (const p of prefs?.preferred_agencies ?? []) if (!rows.some((r) => r.name.toLowerCase() === p.toLowerCase())) rows.push({ name: p, parent: null, count: 0, preferred: true });
      rows.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.count - a.count || a.name.localeCompare(b.name));
      agencyCache = { at: Date.now(), rows };
    }
    const words = q.split(/\s+/).filter(Boolean);
    const hits = agencyCache.rows.filter((r) => words.every((w) => `${r.name} ${r.parent ?? ''}`.toLowerCase().includes(w)));
    return c.json({ total: hits.length, options: hits.slice(0, 50) });
  });
}

const SMALL = new Set(['and', 'or', 'of', 'the', 'for', 'in', 'on', 'to', 'except', 'a']);
/** USAspending titles are upper case ("COMPUTER SYSTEMS DESIGN SERVICES"); show them in title case. */
function titleCase(s: string) {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .split(/(\s+|\(|\))/)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}
