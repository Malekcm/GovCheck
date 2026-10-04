import type { Db } from '../db';
import { json } from '../db';
import { contentHash } from '../lib/hash';
import { CAPABILITY_TAXONOMY, FEEDBACK_REASONS, SYSTEM_QUEUES } from './capabilities';

/** Bump when runSeed's SQL changes so existing databases re-seed once. */
const SEED_LOGIC_VERSION = 2;

/**
 * Idempotent reference data. Never touches user-entered rows.
 *
 * Re-seeding is ~200 statements; over a network connection (Supabase) that noticeably slows
 * a cold start of a free-tier web instance. When the reference data is unchanged since the
 * last seed (tracked by hash in app_state) and the company row exists, it is skipped.
 */
export async function runSeed(db: Db, opts: { force?: boolean } = {}): Promise<{ skipped: boolean }> {
  const hash = contentHash({ v: SEED_LOGIC_VERSION, CAPABILITY_TAXONOMY, FEEDBACK_REASONS, SYSTEM_QUEUES });
  if (!opts.force) {
    const prev = await db.one<{ value: { hash: string } }>(`SELECT value FROM app_state WHERE key = 'seed:hash'`);
    const company = await db.one('SELECT id FROM company_profiles LIMIT 1');
    if (prev?.value.hash === hash && company) return { skipped: true };
  }
  await seedReferenceData(db);
  await db.query(`INSERT INTO app_state (key, value) VALUES ('seed:hash', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [json({ hash, at: new Date().toISOString() })]);
  return { skipped: false };
}

async function seedReferenceData(db: Db): Promise<void> {
  let order = 0;
  for (const cat of CAPABILITY_TAXONOMY) {
    const parent = await db.one<{ id: string }>(
      `INSERT INTO capabilities (slug, name, category, keywords, is_custom, sort_order) VALUES ($1,$2,$2,'{}',false,$3)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order RETURNING id`,
      [`cat:${cat.slug}`, cat.category, order++],
    );
    for (const item of cat.items) {
      await db.query(
        `INSERT INTO capabilities (slug, name, category, keywords, parent_id, is_custom, sort_order) VALUES ($1,$2,$3,$4::text[],$5,false,$6)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, parent_id = EXCLUDED.parent_id, sort_order = EXCLUDED.sort_order,
           keywords = CASE WHEN capabilities.is_custom OR capabilities.keywords_customized THEN capabilities.keywords ELSE EXCLUDED.keywords END`,
        [item.slug, item.name, cat.category, item.keywords ?? [], parent!.id, order++],
      );
    }
  }
  let i = 0;
  for (const r of FEEDBACK_REASONS) {
    await db.query(
      `INSERT INTO user_feedback_reasons (code, label, polarity, feature_groups, sort_order) VALUES ($1,$2,$3,$4::text[],$5)
       ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, polarity = EXCLUDED.polarity, feature_groups = EXCLUDED.feature_groups, sort_order = EXCLUDED.sort_order`,
      [r.code, r.label, r.polarity, r.groups, i++],
    );
  }
  let q = 0;
  for (const view of SYSTEM_QUEUES) {
    await db.query(
      `INSERT INTO watchlists (slug, name, description, filters, sort, is_system, sort_order) VALUES ($1,$2,$3,$4::jsonb,$5,true,$6)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, filters = EXCLUDED.filters, sort = EXCLUDED.sort, sort_order = EXCLUDED.sort_order`,
      [view.slug, view.name, view.description, json(view.filters), view.sort ?? 'best', q++],
    );
  }
  // System queues are reference data: retire ones that no longer exist (user-saved views are never touched).
  await db.query('DELETE FROM watchlists WHERE is_system AND NOT (slug = ANY($1::text[]))', [SYSTEM_QUEUES.map((v) => v.slug)]);
  const company = await db.one('SELECT id FROM company_profiles LIMIT 1');
  if (!company) await db.query(`INSERT INTO company_profiles (name) VALUES (NULL)`);
}
