import type { Hono } from 'hono';
import { z } from 'zod';
import { CERTIFICATION_TYPES, CLEARANCE_LEVELS, DEFAULT_SCORE_WEIGHTS, SCORE_COMPONENTS } from '../../shared/domain';
import { HttpProblem, readJson, type AppDeps } from '../app';
import { json } from '../db';
import { robotsAllows } from '../lib/robots';
import { findPhrase, htmlToText } from '../lib/text';
import { startExclusive } from '../pipeline/sync';
import { getCompanyId } from '../scoring/profile';
import { prepareScoring, scoreMany } from '../scoring/run';

const nullableNum = z.number().nonnegative().nullable().optional();
const strList = z.array(z.string().trim().min(1).max(200)).max(200).optional();

const ProfileUpdate = z
  .object({
    name: z.string().max(200).nullable(),
    website: z.string().max(300).nullable(),
    uei: z.string().max(20).nullable(),
    cage: z.string().max(10).nullable(),
    business_size: z.enum(['small', 'other_than_small', 'unknown']).nullable(),
    sam_registration_status: z.enum(['active', 'inactive', 'pending', 'not_registered', 'unknown']).nullable(),
    sam_registration_expires: z.string().nullable(),
    primary_naics: z.string().max(6).nullable(),
    security_clearances: z.array(z.enum(CLEARANCE_LEVELS)),
    facility_clearance: z.string().max(40).nullable(),
    geographic_service_area: strList,
    remote_capable: z.boolean().nullable(),
    onsite_capable: z.boolean().nullable(),
    travel_willingness: z.enum(['none', 'limited', 'regional', 'national']).nullable(),
    prime_sub_preference: z.enum(['prime', 'sub', 'either']).nullable(),
    min_contract_value: nullableNum,
    preferred_max_value: nullableNum,
    max_realistic_value: nullableNum,
    preferred_duration_months: z.number().int().nonnegative().nullable(),
    team_capacity: z.number().int().nonnegative().nullable(),
    preferred_agencies: strList,
    excluded_agencies: strList,
    preferred_locations: strList,
    excluded_locations: strList,
    preferred_opportunity_types: strList,
    excluded_opportunity_types: strList,
    keywords: strList,
    negative_keywords: strList,
    include_grants: z.boolean(),
    scoring_weights: z.record(z.enum(SCORE_COMPONENTS), z.number().min(0).max(100)).nullable(),
  })
  .partial();

const ARRAY_COLS = new Set(['security_clearances', 'geographic_service_area', 'preferred_agencies', 'excluded_agencies', 'preferred_locations', 'excluded_locations', 'preferred_opportunity_types', 'excluded_opportunity_types', 'keywords', 'negative_keywords']);

const CapabilityUpdate = z.object({
  status: z.enum(['confirmed', 'suggested', 'rejected']).default('confirmed'),
  strength: z.number().int().min(1).max(5).nullable().optional(),
  years_experience: z.number().min(0).max(80).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  technologies: z.array(z.string().max(100)).max(50).optional(),
  staff_qualifications: z.string().max(4000).nullable().optional(),
  evidence: z.string().max(4000).nullable().optional(),
});

const PastPerformance = z.object({
  client: z.string().max(200).nullable().optional(),
  agency: z.string().max(200).nullable().optional(),
  is_government: z.boolean().nullable().optional(),
  project_name: z.string().min(1).max(300),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  dollar_value: z.number().nonnegative().nullable().optional(),
  role: z.enum(['prime', 'sub', 'commercial']).nullable().optional(),
  naics: z.array(z.string().max(6)).max(20).optional(),
  psc: z.array(z.string().max(4)).max(20).optional(),
  capability_ids: z.array(z.string().uuid()).max(100).optional(),
  technologies: z.array(z.string().max(100)).max(50).optional(),
  description: z.string().max(10000).nullable().optional(),
  outcomes: z.string().max(5000).nullable().optional(),
  contract_number: z.string().max(100).nullable().optional(),
  reference_name: z.string().max(200).nullable().optional(),
  reference_contact: z.string().max(300).nullable().optional(),
});

const Vehicle = z.object({
  name: z.string().min(1).max(200),
  vehicle_type: z.string().max(40).nullable().optional(),
  contract_number: z.string().max(100).nullable().optional(),
  role: z.enum(['prime', 'sub']).nullable().optional(),
  expiration_date: z.string().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export function registerCompanyRoutes(app: Hono, deps: AppDeps) {
  const { db } = deps;
  const companyId = async () => {
    const id = await getCompanyId(db);
    if (!id) throw new HttpProblem(500, 'Company profile missing — restart the server to re-seed.');
    return id;
  };
  const rescoreInBackground = (reason: string) =>
    startExclusive(
      `Re-scoring (${reason})`,
      async () => {
        await scoreMany(db, 'all', reason, await prepareScoring(db));
      },
      deps.log,
    );

  app.get('/api/company', async (c) => {
    const id = await companyId();
    const profile = await db.one('SELECT * FROM company_profiles WHERE id = $1', [id]);
    const [naics, psc, certs, vehicles, pastPerformance, capCounts] = await Promise.all([
      db.query('SELECT * FROM company_naics WHERE company_id = $1 ORDER BY is_primary DESC, code', [id]),
      db.query('SELECT * FROM company_psc WHERE company_id = $1 ORDER BY code', [id]),
      db.query('SELECT * FROM company_certifications WHERE company_id = $1', [id]),
      db.query('SELECT * FROM company_contract_vehicles WHERE company_id = $1 ORDER BY created_at', [id]),
      db.query('SELECT * FROM company_past_performance WHERE company_id = $1 ORDER BY end_date DESC NULLS FIRST, created_at DESC', [id]),
      db.one<{ confirmed: number; suggested: number }>(
        `SELECT count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed, count(*) FILTER (WHERE status = 'suggested')::int AS suggested FROM company_capabilities WHERE company_id = $1`,
        [id],
      ),
    ]);
    return c.json({ profile, naics, psc, certifications: certs, certificationTypes: CERTIFICATION_TYPES, vehicles, pastPerformance, capabilityCounts: capCounts, defaultWeights: DEFAULT_SCORE_WEIGHTS });
  });

  app.put('/api/company', async (c) => {
    const id = await companyId();
    const body = ProfileUpdate.parse(await readJson(c));
    const entries = Object.entries(body).filter(([, v]) => v !== undefined);
    if (entries.length) {
      const sets = entries.map(([k], i) => `${k} = $${i + 2}${ARRAY_COLS.has(k) ? '::text[]' : k === 'scoring_weights' ? '::jsonb' : ''}`);
      await db.query(`UPDATE company_profiles SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [id, ...entries.map(([k, v]) => (k === 'scoring_weights' ? json(v) : v))]);
    }
    return c.json(await db.one('SELECT * FROM company_profiles WHERE id = $1', [id]));
  });

  app.put('/api/company/onboarding', async (c) => {
    const id = await companyId();
    const body = z.object({ step: z.number().int().min(0).max(20), completed: z.boolean().optional() }).parse(await readJson(c));
    await db.query(`UPDATE company_profiles SET onboarding_step = $2, onboarding_completed_at = CASE WHEN $3 THEN COALESCE(onboarding_completed_at, now()) ELSE onboarding_completed_at END WHERE id = $1`, [
      id,
      body.step,
      !!body.completed,
    ]);
    return c.json({ ok: true });
  });

  app.put('/api/company/naics', async (c) => {
    const id = await companyId();
    const body = z.object({ codes: z.array(z.object({ code: z.string().regex(/^\d{2,6}$/), description: z.string().max(300).nullable().optional(), is_primary: z.boolean().optional() })).max(200) }).parse(await readJson(c));
    await db.tx(async (tx) => {
      await tx.query('DELETE FROM company_naics WHERE company_id = $1', [id]);
      for (const n of body.codes) await tx.query('INSERT INTO company_naics (company_id, code, description, is_primary) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, n.code, n.description ?? null, !!n.is_primary]);
      const primary = body.codes.find((n) => n.is_primary)?.code;
      if (primary) await tx.query('UPDATE company_profiles SET primary_naics = $2 WHERE id = $1', [id, primary]);
    });
    return c.json(await db.query('SELECT * FROM company_naics WHERE company_id = $1 ORDER BY is_primary DESC, code', [id]));
  });

  app.put('/api/company/psc', async (c) => {
    const id = await companyId();
    const body = z.object({ codes: z.array(z.object({ code: z.string().regex(/^[A-Z0-9]{1,4}$/i), description: z.string().max(300).nullable().optional() })).max(200) }).parse(await readJson(c));
    await db.tx(async (tx) => {
      await tx.query('DELETE FROM company_psc WHERE company_id = $1', [id]);
      for (const n of body.codes) await tx.query('INSERT INTO company_psc (company_id, code, description) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, n.code.toUpperCase(), n.description ?? null]);
    });
    return c.json(await db.query('SELECT * FROM company_psc WHERE company_id = $1 ORDER BY code', [id]));
  });

  // Certifications are set only by explicit user action.
  app.put('/api/company/certifications', async (c) => {
    const id = await companyId();
    const body = z
      .object({ items: z.array(z.object({ cert_type: z.string().min(1).max(80), status: z.enum(['held', 'not_held', 'pending', 'unknown']), expiration_date: z.string().nullable().optional(), notes: z.string().max(1000).nullable().optional() })).max(50) })
      .parse(await readJson(c));
    await db.tx(async (tx) => {
      for (const it of body.items) {
        await tx.query(
          `INSERT INTO company_certifications (company_id, cert_type, status, confirmed_at, expiration_date, notes) VALUES ($1,$2,$3, CASE WHEN $3 = 'held' THEN now() END, $4, $5)
           ON CONFLICT (company_id, cert_type) DO UPDATE SET status = EXCLUDED.status, confirmed_at = CASE WHEN EXCLUDED.status = 'held' THEN COALESCE(company_certifications.confirmed_at, now()) ELSE NULL END,
             expiration_date = EXCLUDED.expiration_date, notes = EXCLUDED.notes`,
          [id, it.cert_type, it.status, it.expiration_date || null, it.notes ?? null],
        );
      }
    });
    return c.json(await db.query('SELECT * FROM company_certifications WHERE company_id = $1', [id]));
  });

  app.post('/api/company/vehicles', async (c) => {
    const id = await companyId();
    const v = Vehicle.parse(await readJson(c));
    return c.json(await db.one('INSERT INTO company_contract_vehicles (company_id, name, vehicle_type, contract_number, role, expiration_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [id, v.name, v.vehicle_type ?? null, v.contract_number ?? null, v.role ?? null, v.expiration_date || null, v.notes ?? null]));
  });
  app.put('/api/company/vehicles/:vid', async (c) => {
    const v = Vehicle.parse(await readJson(c));
    return c.json(
      await db.one('UPDATE company_contract_vehicles SET name=$2, vehicle_type=$3, contract_number=$4, role=$5, expiration_date=$6, notes=$7 WHERE id::text = $1 RETURNING *', [
        c.req.param('vid'),
        v.name,
        v.vehicle_type ?? null,
        v.contract_number ?? null,
        v.role ?? null,
        v.expiration_date || null,
        v.notes ?? null,
      ]),
    );
  });
  app.delete('/api/company/vehicles/:vid', async (c) => {
    await db.query('DELETE FROM company_contract_vehicles WHERE id::text = $1', [c.req.param('vid')]);
    return c.json({ ok: true });
  });

  const ppParams = (p: z.infer<typeof PastPerformance>) => [
    p.client ?? null,
    p.agency ?? null,
    p.is_government ?? null,
    p.project_name,
    p.start_date || null,
    p.end_date || null,
    p.dollar_value ?? null,
    p.role ?? null,
    p.naics ?? [],
    p.psc ?? [],
    p.capability_ids ?? [],
    p.technologies ?? [],
    p.description ?? null,
    p.outcomes ?? null,
    p.contract_number ?? null,
    p.reference_name ?? null,
    p.reference_contact ?? null,
  ];
  app.post('/api/company/past-performance', async (c) => {
    const id = await companyId();
    const p = PastPerformance.parse(await readJson(c));
    return c.json(
      await db.one(
        `INSERT INTO company_past_performance (company_id, client, agency, is_government, project_name, start_date, end_date, dollar_value, role, naics, psc, capability_ids, technologies, description, outcomes, contract_number, reference_name, reference_contact)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11::text[],$12::uuid[],$13::text[],$14,$15,$16,$17,$18) RETURNING *`,
        [id, ...ppParams(p)],
      ),
    );
  });
  app.put('/api/company/past-performance/:pid', async (c) => {
    const p = PastPerformance.parse(await readJson(c));
    return c.json(
      await db.one(
        `UPDATE company_past_performance SET client=$2, agency=$3, is_government=$4, project_name=$5, start_date=$6, end_date=$7, dollar_value=$8, role=$9, naics=$10::text[], psc=$11::text[],
           capability_ids=$12::uuid[], technologies=$13::text[], description=$14, outcomes=$15, contract_number=$16, reference_name=$17, reference_contact=$18, updated_at = now()
         WHERE id::text = $1 RETURNING *`,
        [c.req.param('pid'), ...ppParams(p)],
      ),
    );
  });
  app.delete('/api/company/past-performance/:pid', async (c) => {
    await db.query('DELETE FROM company_past_performance WHERE id::text = $1', [c.req.param('pid')]);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------
  // Capabilities
  // ---------------------------------------------------------------------
  app.get('/api/capabilities', async (c) => {
    const id = await companyId();
    const rows = await db.query<any>(
      `SELECT c.*, cc.status, cc.strength, cc.years_experience, cc.notes, cc.technologies, cc.staff_qualifications, cc.evidence, cc.suggested_reason
       FROM capabilities c LEFT JOIN company_capabilities cc ON cc.capability_id = c.id AND cc.company_id = $1 ORDER BY c.sort_order, c.created_at`,
      [id],
    );
    const parents = rows.filter((r) => r.slug.startsWith('cat:') || (!r.parent_id && r.is_custom && r.slug.startsWith('cat:')));
    const tree = parents.map((p) => ({ ...p, children: rows.filter((r) => r.parent_id === p.id) }));
    const orphans = rows.filter((r) => !r.slug.startsWith('cat:') && !r.parent_id);
    if (orphans.length) tree.push({ id: 'custom', name: 'Custom capabilities', slug: 'cat:custom', category: 'Custom', children: orphans } as any);
    return c.json(tree);
  });

  app.put('/api/company/capabilities/:capId', async (c) => {
    const id = await companyId();
    const b = CapabilityUpdate.parse(await readJson(c));
    await db.query(
      `INSERT INTO company_capabilities (company_id, capability_id, status, strength, years_experience, notes, technologies, staff_qualifications, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9)
       ON CONFLICT (company_id, capability_id) DO UPDATE SET status = EXCLUDED.status, strength = EXCLUDED.strength, years_experience = EXCLUDED.years_experience,
         notes = EXCLUDED.notes, technologies = EXCLUDED.technologies, staff_qualifications = EXCLUDED.staff_qualifications, evidence = EXCLUDED.evidence, updated_at = now()`,
      [id, c.req.param('capId'), b.status, b.strength ?? 3, b.years_experience ?? null, b.notes ?? null, b.technologies ?? [], b.staff_qualifications ?? null, b.evidence ?? null],
    );
    return c.json({ ok: true });
  });

  app.delete('/api/company/capabilities/:capId', async (c) => {
    const id = await companyId();
    await db.query('DELETE FROM company_capabilities WHERE company_id = $1 AND capability_id::text = $2', [id, c.req.param('capId')]);
    return c.json({ ok: true });
  });

  app.post('/api/capabilities', async (c) => {
    const id = await companyId();
    const b = z.object({ name: z.string().min(2).max(120), parent_id: z.string().uuid().nullable().optional(), keywords: z.array(z.string().max(100)).max(40).optional() }).parse(await readJson(c));
    const parent = b.parent_id ? await db.one<{ name: string }>('SELECT name FROM capabilities WHERE id = $1', [b.parent_id]) : null;
    const slug = `custom-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`;
    const row = await db.one<{ id: string }>(
      `INSERT INTO capabilities (slug, name, category, keywords, parent_id, is_custom, sort_order) VALUES ($1,$2,$3,$4::text[],$5,true, 100000) RETURNING id`,
      [slug, b.name.trim(), parent?.name ?? 'Custom', b.keywords ?? [], b.parent_id ?? null],
    );
    await db.query(`INSERT INTO company_capabilities (company_id, capability_id, status, strength) VALUES ($1,$2,'confirmed',3) ON CONFLICT DO NOTHING`, [id, row!.id]);
    return c.json({ id: row!.id });
  });

  app.put('/api/capabilities/:capId', async (c) => {
    const b = z.object({ name: z.string().min(2).max(120).optional(), keywords: z.array(z.string().max(100)).max(60) }).parse(await readJson(c));
    await db.query(`UPDATE capabilities SET keywords = $2::text[], name = COALESCE($3, name), keywords_customized = true WHERE id::text = $1`, [c.req.param('capId'), b.keywords, b.name ?? null]);
    return c.json({ ok: true });
  });

  /** Read the company website and propose capabilities as SUGGESTED. The user must confirm each one. */
  app.post('/api/company/suggest-capabilities', async (c) => {
    const id = await companyId();
    const body = z.object({ url: z.string().url().optional() }).parse(await readJson(c).catch(() => ({})));
    const profile = await db.one<{ website: string | null }>('SELECT website FROM company_profiles WHERE id = $1', [id]);
    let url = body.url ?? profile?.website ?? null;
    if (!url) throw new HttpProblem(400, 'Add the company website to the profile first.');
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const robots = await robotsAllows(deps.http, url);
    if (!robots.allowed) throw new HttpProblem(422, 'The website’s robots.txt disallows automated reading of that page.');
    const res = await deps.http.request<string>({ url, responseType: 'text', timeoutMs: 20_000, retries: 1, maxBytes: 3_000_000 });
    const text = htmlToText(res.data);
    const lower = text.toLowerCase();
    const caps = await db.query<{ id: string; name: string; keywords: string[]; status: string | null }>(
      `SELECT c.id, c.name, c.keywords, cc.status FROM capabilities c LEFT JOIN company_capabilities cc ON cc.capability_id = c.id AND cc.company_id = $1 WHERE c.slug NOT LIKE 'cat:%'`,
      [id],
    );
    const suggestions: { id: string; name: string; reason: string }[] = [];
    for (const cap of caps) {
      if (cap.status) continue; // never override a user decision
      const term = [cap.name, ...cap.keywords].find((t) => t.length > 3 && findPhrase(lower, t) >= 0);
      if (!term) continue;
      const reason = `Website mentions “${term}”`;
      await db.query(`INSERT INTO company_capabilities (company_id, capability_id, status, strength, suggested_reason) VALUES ($1,$2,'suggested',NULL,$3) ON CONFLICT DO NOTHING`, [id, cap.id, reason]);
      suggestions.push({ id: cap.id, name: cap.name, reason });
    }
    return c.json({ source: url, suggestions });
  });

  app.post('/api/company/rescore', async (c) => {
    const r = rescoreInBackground('profile updated');
    return c.json(r.started ? { started: true } : { started: false, message: `Busy: ${r.label}. Scores will refresh after it finishes; try again shortly.` });
  });
}
