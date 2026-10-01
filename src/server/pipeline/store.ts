import type { Db } from '../db';
import { json } from '../db';
import { contentHash } from '../lib/hash';
import type { RawRecord } from '../connectors/types';

export interface StoredRecord {
  id: string;
  status: 'new' | 'changed' | 'unchanged';
  /** Parser version changed: re-normalize even though content is unchanged. */
  reparse: boolean;
  rawText: string | null;
  previousNormalized: any | null;
  previousHash: string | null;
  contentHash: string;
}

interface ExistingRow {
  id: string;
  source_record_id: string;
  content_hash: string;
  parser_version: string;
  raw_text: string | null;
  normalized: any | null;
}

function hashOf(rec: RawRecord, rawText: string | null): string {
  return contentHash({ raw: rec.raw ?? null, rawText: rawText ?? null });
}

/**
 * Persist a raw source record. Content is never overwritten without first being
 * kept as a version, and records are never deleted. When a source omits the
 * supplemental raw_text (e.g. a detail page we chose not to re-fetch), the
 * previously stored text is carried forward rather than lost.
 */
export async function storeSourceRecord(db: Db, connectorId: string, rec: RawRecord, parserVersion: string): Promise<StoredRecord> {
  const existing = await db.one<ExistingRow>('SELECT id, source_record_id, content_hash, parser_version, raw_text, normalized FROM source_records WHERE connector_id = $1 AND source_record_id = $2', [connectorId, rec.sourceRecordId]);
  const rawText = rec.rawText ?? existing?.raw_text ?? null;
  const hash = hashOf(rec, rawText);

  if (!existing) {
    const row = await db.one<{ id: string }>(
      `INSERT INTO source_records (connector_id, source_record_id, record_kind, raw, raw_text, content_hash, parser_version, retrieved_at, source_url)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING id`,
      [connectorId, rec.sourceRecordId, rec.kind, json(rec.raw ?? null), rawText, hash, parserVersion, rec.retrievedAt, rec.sourceUrl ?? null],
    );
    await db.query(
      `INSERT INTO source_record_versions (source_record_id, content_hash, raw, raw_text, parser_version, retrieved_at) VALUES ($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [row!.id, hash, json(rec.raw ?? null), rawText, parserVersion, rec.retrievedAt],
    );
    return { id: row!.id, status: 'new', reparse: false, rawText, previousNormalized: null, previousHash: null, contentHash: hash };
  }

  if (existing.content_hash === hash) {
    await db.query(`UPDATE source_records SET last_seen_at = now(), retrieved_at = $2, seen_status = 'active' WHERE id = $1`, [existing.id, rec.retrievedAt]);
    return {
      id: existing.id,
      status: 'unchanged',
      reparse: existing.parser_version !== parserVersion || !existing.normalized,
      rawText,
      previousNormalized: existing.normalized,
      previousHash: existing.content_hash,
      contentHash: hash,
    };
  }

  await db.query(
    `INSERT INTO source_record_versions (source_record_id, content_hash, raw, raw_text, parser_version, retrieved_at) VALUES ($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [existing.id, hash, json(rec.raw ?? null), rawText, parserVersion, rec.retrievedAt],
  );
  await db.query(
    `UPDATE source_records SET raw = $2::jsonb, raw_text = $3, content_hash = $4, parser_version = $5, retrieved_at = $6, source_url = COALESCE($7, source_url),
       last_seen_at = now(), last_changed_at = now(), seen_status = 'active', version_count = version_count + 1
     WHERE id = $1`,
    [existing.id, json(rec.raw ?? null), rawText, hash, parserVersion, rec.retrievedAt, rec.sourceUrl ?? null],
  );
  return { id: existing.id, status: 'changed', reparse: true, rawText, previousNormalized: existing.normalized, previousHash: existing.content_hash, contentHash: hash };
}

/**
 * Batch pre-check used by high-volume sources (bulk files): returns the records that
 * are new or changed and touches last_seen for the rest with a single statement.
 */
export async function partitionUnchanged(db: Db, connectorId: string, records: RawRecord[], parserVersion: string): Promise<{ changed: RawRecord[]; unchanged: number }> {
  if (!records.length) return { changed: [], unchanged: 0 };
  const ids = records.map((r) => r.sourceRecordId);
  const rows = await db.query<ExistingRow>(
    'SELECT id, source_record_id, content_hash, parser_version, raw_text, normalized IS NOT NULL AS normalized FROM source_records WHERE connector_id = $1 AND source_record_id = ANY($2::text[])',
    [connectorId, ids],
  );
  const byId = new Map(rows.map((r) => [r.source_record_id, r]));
  const changed: RawRecord[] = [];
  const unchangedIds: string[] = [];
  for (const rec of records) {
    const ex = byId.get(rec.sourceRecordId) ?? null;
    if (ex && ex.content_hash === hashOf(rec, rec.rawText ?? ex.raw_text) && ex.parser_version === parserVersion && ex.normalized) unchangedIds.push(ex.id);
    else changed.push(rec);
  }
  if (unchangedIds.length) await db.query(`UPDATE source_records SET last_seen_at = now(), seen_status = 'active' WHERE id = ANY($1::uuid[])`, [unchangedIds]);
  return { changed, unchanged: unchangedIds.length };
}

export async function saveNormalized(db: Db, sourceRecordId: string, normalized: unknown): Promise<void> {
  await db.query('UPDATE source_records SET normalized = $2::jsonb, normalized_hash = $3, normalized_at = now() WHERE id = $1', [sourceRecordId, json(normalized), contentHash(normalized)]);
}
