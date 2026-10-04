import type { Db } from '../db';
import { json } from '../db';
import { recomputeOpportunity } from './canonical';
import { recordEvent } from './events';
import { upsertRelationship } from './resolve';

type Moved = Record<string, unknown[]>;

/** Tables with a surrogate `id` that can simply be re-pointed (with optional uniqueness guard). */
const ID_TABLES: { table: string; guard?: string }[] = [
  { table: 'opportunity_identifiers', guard: 'NOT EXISTS (SELECT 1 FROM opportunity_identifiers x WHERE x.opportunity_id = $1 AND x.id_type = t.id_type AND x.normalized_value = t.normalized_value)' },
  { table: 'opportunity_field_values' },
  { table: 'opportunity_dates' },
  { table: 'opportunity_financials' },
  { table: 'opportunity_locations', guard: 'NOT EXISTS (SELECT 1 FROM opportunity_locations x WHERE x.opportunity_id = $1 AND x.kind = t.kind AND x.location_key = t.location_key)' },
  { table: 'opportunity_documents', guard: 'NOT EXISTS (SELECT 1 FROM opportunity_documents x WHERE x.opportunity_id = $1 AND x.url = t.url)' },
  { table: 'opportunity_requirements' },
  { table: 'opportunity_events', guard: 'NOT EXISTS (SELECT 1 FROM opportunity_events x WHERE x.opportunity_id = $1 AND x.dedupe_key = t.dedupe_key)' },
  { table: 'user_notes' },
  { table: 'user_field_overrides', guard: 'NOT EXISTS (SELECT 1 FROM user_field_overrides x WHERE x.opportunity_id = $1 AND x.field = t.field)' },
  { table: 'opportunity_capture_history' },
];

/** Composite-key tables: [table, key columns other than opportunity_id]. */
const KEY_TABLES: [string, string[]][] = [
  ['opportunity_sources', ['source_record_id']],
  ['opportunity_contacts', ['contact_id', 'role']],
  ['opportunity_awards', ['award_id', 'relationship']],
  ['opportunity_vendors', ['vendor_id', 'role']],
  ['user_tags', ['tag']],
  // One capture record per profile: moved only when the surviving profile has none.
  ['opportunity_capture', []],
];

const keyMatch = (keys: string[]) => (keys.length ? keys.map((k) => `x.${k} = t.${k}`).join(' AND ') : 'true');
const keyReturning = (keys: string[]) => (keys.length ? keys.map((k) => `t.${k}`).join(', ') : 'true AS moved');

export async function mergeOpportunities(db: Db, primaryId: string, secondaryId: string, priorities: Map<string, number>, note?: string): Promise<string> {
  if (primaryId === secondaryId) throw new Error('Cannot merge a profile into itself.');
  return db.tx(async (tx) => {
    const sec = await tx.one<{ merged_into_id: string | null; title: string }>('SELECT merged_into_id, title FROM opportunities WHERE id = $1', [secondaryId]);
    const pri = await tx.one<{ merged_into_id: string | null; title: string }>('SELECT merged_into_id, title FROM opportunities WHERE id = $1', [primaryId]);
    if (!sec || !pri) throw new Error('Profile not found.');
    if (sec.merged_into_id || pri.merged_into_id) throw new Error('One of these profiles has already been merged.');
    const moved: Moved = {};

    for (const { table, guard } of ID_TABLES) {
      const rows = await tx.query<{ id: string }>(
        `UPDATE ${table} t SET opportunity_id = $1 WHERE t.opportunity_id = $2 ${guard ? `AND ${guard}` : ''} RETURNING t.id`,
        [primaryId, secondaryId],
      );
      moved[table] = rows.map((r) => r.id);
    }
    for (const [table, keys] of KEY_TABLES) {
      const rows = await tx.query<Record<string, unknown>>(
        `UPDATE ${table} t SET opportunity_id = $1 WHERE t.opportunity_id = $2 AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.opportunity_id = $1 AND ${keyMatch(keys)}) RETURNING ${keyReturning(keys)}`,
        [primaryId, secondaryId],
      );
      moved[table] = rows;
    }
    // Decisions: keep the primary's current decision if it has one; otherwise carry the secondary's over.
    const primaryHasDecision = !!(await tx.one('SELECT 1 FROM user_opportunity_decisions WHERE opportunity_id = $1 AND is_current', [primaryId]));
    const decisions = await tx.query<{ id: string; is_current: boolean }>(
      'UPDATE user_opportunity_decisions SET opportunity_id = $1 WHERE opportunity_id = $2 RETURNING id, is_current',
      [primaryId, secondaryId],
    );
    moved.user_opportunity_decisions = decisions.map((d) => ({ id: d.id, wasCurrent: d.is_current }));
    if (primaryHasDecision && decisions.some((d) => d.is_current))
      await tx.query('UPDATE user_opportunity_decisions SET is_current = false WHERE id = ANY($1::uuid[])', [decisions.filter((d) => d.is_current).map((d) => d.id)]);

    await tx.query('UPDATE opportunities SET merged_into_id = $1, updated_at = now() WHERE id = $2', [primaryId, secondaryId]);
    const rel = await upsertRelationship(tx, primaryId, secondaryId, 'merged', 1, 'manual', [note ?? 'Merged by user'], 'user');
    await tx.query(`UPDATE opportunity_relationships SET status = 'confirmed', decided_at = now() WHERE status = 'suggested' AND ((from_opportunity_id = $1 AND to_opportunity_id = $2) OR (from_opportunity_id = $2 AND to_opportunity_id = $1))`, [primaryId, secondaryId]);
    const row = await tx.one<{ id: string }>(
      `INSERT INTO merge_decisions (action, primary_id, secondary_id, relationship_id, moved, note) VALUES ('merge',$1,$2,$3,$4::jsonb,$5) RETURNING id`,
      [primaryId, secondaryId, rel, json(moved), note ?? null],
    );
    await recordEvent(tx, primaryId, { type: 'MERGED', title: `Merged with “${sec.title}”`, dedupeKey: `merge:${row!.id}`, detail: { mergeId: row!.id, secondaryId } });
    await recomputeOpportunity(tx, primaryId, { priorities });
    return row!.id;
  });
}

export async function undoMerge(db: Db, mergeId: string, priorities: Map<string, number>): Promise<void> {
  await db.tx(async (tx) => {
    const m = await tx.one<{ primary_id: string; secondary_id: string; moved: Moved; undone_at: string | null; relationship_id: string | null }>('SELECT * FROM merge_decisions WHERE id = $1 AND action = $2', [mergeId, 'merge']);
    if (!m) throw new Error('Merge not found.');
    if (m.undone_at) throw new Error('This merge was already undone.');
    for (const { table } of ID_TABLES) {
      const ids = (m.moved[table] ?? []) as string[];
      if (ids.length) await tx.query(`UPDATE ${table} SET opportunity_id = $1 WHERE id = ANY($2::uuid[])`, [m.secondary_id, ids]);
    }
    for (const [table, keys] of KEY_TABLES) {
      for (const k of (m.moved[table] ?? []) as Record<string, unknown>[]) {
        const cond = keys.length ? keys.map((key, i) => `${key} = $${i + 3}`).join(' AND ') : 'true';
        await tx.query(`UPDATE ${table} SET opportunity_id = $1 WHERE opportunity_id = $2 AND ${cond}`, [m.secondary_id, m.primary_id, ...keys.map((key) => k[key])]);
      }
    }
    for (const d of (m.moved.user_opportunity_decisions ?? []) as { id: string; wasCurrent: boolean }[]) {
      await tx.query('UPDATE user_opportunity_decisions SET opportunity_id = $1, is_current = $2 WHERE id = $3', [m.secondary_id, d.wasCurrent, d.id]);
    }
    await tx.query('UPDATE opportunities SET merged_into_id = NULL, updated_at = now() WHERE id = $1', [m.secondary_id]);
    if (m.relationship_id) await tx.query(`UPDATE opportunity_relationships SET status = 'rejected', decided_at = now() WHERE id = $1`, [m.relationship_id]);
    await tx.query('UPDATE merge_decisions SET undone_at = now() WHERE id = $1', [mergeId]);
    await tx.query(`INSERT INTO merge_decisions (action, primary_id, secondary_id, note) VALUES ('undo_merge',$1,$2,$3)`, [m.primary_id, m.secondary_id, `Undo of merge ${mergeId}`]);
    await recordEvent(tx, m.primary_id, { type: 'MERGED', title: 'Merge undone', dedupeKey: `unmerge:${mergeId}` });
    await recomputeOpportunity(tx, m.primary_id, { priorities });
    await recomputeOpportunity(tx, m.secondary_id, { priorities });
  });
}

export async function decideRelationship(
  db: Db,
  action: 'keep_separate' | 'link_related' | 'mark_predecessor' | 'mark_successor',
  primaryId: string,
  secondaryId: string,
  relationshipId: string | null,
  note?: string,
): Promise<void> {
  await db.tx(async (tx) => {
    if (relationshipId) await tx.query(`UPDATE opportunity_relationships SET status = $2, decided_at = now() WHERE id = $1`, [relationshipId, action === 'keep_separate' ? 'rejected' : 'confirmed']);
    if (action === 'keep_separate') {
      await tx.query(`UPDATE opportunity_relationships SET status = 'rejected', decided_at = now() WHERE relationship_type IN ('possible_duplicate','possible_same_procurement') AND ((from_opportunity_id = $1 AND to_opportunity_id = $2) OR (from_opportunity_id = $2 AND to_opportunity_id = $1))`, [primaryId, secondaryId]);
    } else {
      const type = action === 'link_related' ? 'related' : action === 'mark_predecessor' ? 'predecessor' : 'successor';
      // predecessor: secondary is the predecessor of primary; successor: secondary succeeds primary
      await upsertRelationship(tx, secondaryId, primaryId, type, 1, 'manual', [note ?? `Marked by user (${type})`], 'user');
    }
    await tx.query(`INSERT INTO merge_decisions (action, primary_id, secondary_id, relationship_id, note) VALUES ($1,$2,$3,$4,$5)`, [action, primaryId, secondaryId, relationshipId, note ?? null]);
  });
}
