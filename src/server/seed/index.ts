import type { Db } from '../db';
import { json } from '../db';
import { CAPABILITY_TAXONOMY, FEEDBACK_REASONS, SYSTEM_QUEUES } from './capabilities';

/** Idempotent reference data. Never touches user-entered rows. */
export async function runSeed(db: Db): Promise<void> {
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
           keywords = CASE WHEN capabilities.is_custom THEN capabilities.keywords ELSE EXCLUDED.keywords END`,
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
  const company = await db.one('SELECT id FROM company_profiles LIMIT 1');
  if (!company) await db.query(`INSERT INTO company_profiles (name) VALUES (NULL)`);
}
