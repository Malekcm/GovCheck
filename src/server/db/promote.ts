import type { Db } from './index';
import { json } from './index';
import { appliedMigrations, availableMigrations, runMigrations } from './migrate';

/**
 * One-time promotion of a local GovCheck database (PGlite) into a shared PostgreSQL /
 * Supabase database.
 *
 * Safety model
 *  - The SOURCE is only ever read. (The CLI additionally works on a snapshot copy of the
 *    PGlite directory, so not a single byte of ./data/pglite changes.)
 *  - The TARGET is migrated with the normal migrations, then rows are INSERTED. Rows that
 *    already exist in the target (same primary key) are never overwritten unless
 *    --overwrite is given; they are counted as "identical" or "differs (kept target)".
 *  - Before writing anything, every unique key is checked: if the target already holds
 *    different rows under the same natural key (e.g. the hosted app was started against the
 *    target before promotion and created its own capability library), the promotion stops
 *    and explains, instead of guessing.
 *  - UUIDs, relationships, connector cursors, sync history and API usage are copied as-is,
 *    so the next incremental sync continues exactly where the local database left off.
 *  - Work is batched (one transaction per batch, keyset pagination) and idempotent:
 *    re-running copies only what is missing, so an interrupted promotion is resumed by
 *    simply running it again.
 *  - Afterwards every source primary key is looked up in the target; anything missing is
 *    reported, never silently ignored.
 */

export interface PromoteOptions {
  dryRun?: boolean;
  /** Rows per batch (large-text tables use a fifth of this). */
  batchSize?: number;
  /** Update target rows whose content differs from the source (default: keep the target's). */
  overwrite?: boolean;
  /** If the target only holds GovCheck's auto-created reference data, replace it with the source's. */
  replaceTargetSeed?: boolean;
  log?: (line: string) => void;
}

export interface TableReport {
  table: string;
  sourceCount: number;
  targetBefore: number | null;
  targetAfter: number | null;
  inserted: number;
  identical: number;
  differing: number;
  updated: number;
  missingAfter: number | null;
  errors: string[];
}

export interface PromoteCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PromoteReport {
  ok: boolean;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  migrationsApplied: string[];
  pendingTargetMigrations: string[];
  tables: TableReport[];
  conflicts: { table: string; constraint: string; count: number; examples: string[] }[];
  checks: PromoteCheck[];
  problems: string[];
}

export class PromotionAborted extends Error {
  constructor(
    message: string,
    readonly report: PromoteReport,
  ) {
    super(message);
    this.name = 'PromotionAborted';
  }
}

interface Column {
  name: string;
  type: string;
  generated: boolean;
  isJson: boolean;
}

interface TableInfo {
  name: string;
  columns: Column[];
  pk: string[];
  /** Columns referencing the same table (inserted as NULL, filled in a second pass). */
  selfRefs: string[];
  uniques: { name: string; columns: string[] }[];
  dependsOn: string[];
}

/** Rows never copied: the target's own runtime lease. */
const ROW_FILTERS: Record<string, string> = { app_state: `key <> 'sync:lease'` };
const LARGE_TABLES = new Set(['source_records', 'source_record_versions', 'opportunity_documents', 'ai_analyses', 'opportunity_snapshots']);
const MAX_PAYLOAD_CHARS = 8_000_000;

/** Tables whose rows mean "this database holds real work", used to decide if a target is seed-only. */
const DATA_TABLES = [
  'opportunities',
  'source_records',
  'awards',
  'company_capabilities',
  'company_naics',
  'company_psc',
  'company_certifications',
  'company_contract_vehicles',
  'company_past_performance',
  'user_opportunity_decisions',
  'user_notes',
  'user_tags',
  'opportunity_capture',
];

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

async function listTables(db: Db): Promise<string[]> {
  const rows = await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'schema_migrations' ORDER BY tablename`);
  return rows.map((r) => r.t);
}

async function tableInfo(db: Db, table: string): Promise<TableInfo> {
  const cols = await db.query<{ name: string; type: string; generated: string }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attgenerated::text AS generated
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [table],
  );
  const idx = await db.query<{ name: string; primary: boolean; cols: string[]; partial: boolean; expr: boolean }>(
    `SELECT ic.relname AS name, i.indisprimary AS primary, i.indpred IS NOT NULL AS partial, i.indexprs IS NOT NULL AS expr,
       ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols
     FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = $1 AND i.indisunique`,
    [table],
  );
  const fks = await db.query<{ ref: string; cols: string[] }>(
    `SELECT rc.relname AS ref, ARRAY(SELECT a.attname::text FROM unnest(con.conkey) k(attnum) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS cols
     FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = $1 AND con.contype = 'f'`,
    [table],
  );
  const pk = idx.find((i) => i.primary)?.cols ?? [];
  return {
    name: table,
    columns: cols.map((c) => ({ name: c.name, type: c.type, generated: !!c.generated && c.generated !== '', isJson: c.type === 'jsonb' || c.type === 'json' })),
    pk,
    selfRefs: [...new Set(fks.filter((f) => f.ref === table).flatMap((f) => f.cols))],
    uniques: idx.filter((i) => !i.primary && !i.partial && !i.expr).map((i) => ({ name: i.name, columns: i.cols })),
    dependsOn: [...new Set(fks.filter((f) => f.ref !== table).map((f) => f.ref))],
  };
}

/** Parents before children. Throws on a cycle between different tables (none exist today). */
export function topoSort(infos: TableInfo[]): TableInfo[] {
  const byName = new Map(infos.map((i) => [i.name, i]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: TableInfo[] = [];
  const visit = (t: TableInfo, path: string[]) => {
    if (done.has(t.name)) return;
    if (visiting.has(t.name)) throw new Error(`Foreign-key cycle between tables: ${[...path, t.name].join(' → ')}`);
    visiting.add(t.name);
    for (const dep of t.dependsOn) {
      const d = byName.get(dep);
      if (d) visit(d, [...path, t.name]);
    }
    visiting.delete(t.name);
    done.add(t.name);
    out.push(t);
  };
  for (const t of [...infos].sort((a, b) => a.name.localeCompare(b.name))) visit(t, []);
  return out;
}

const copyCols = (t: TableInfo) => t.columns.filter((c) => !c.generated);

/** Source projection: JSON columns as text so they survive the round trip exactly (JSON null ≠ SQL NULL). */
function sourceProjection(t: TableInfo): string {
  return copyCols(t)
    .map((c) => (c.isJson ? `${q(c.name)}::text AS ${q(c.name)}` : q(c.name)))
    .join(', ');
}

/** Target-side record definition for json_to_recordset. */
function recordDef(t: TableInfo, cols = copyCols(t)): string {
  return cols.map((c) => `${q(c.name)} ${c.isJson ? 'text' : c.type}`).join(', ');
}

const srcExpr = (c: Column, alias = 's') => (c.isJson ? `${alias}.${q(c.name)}::${c.type}` : `${alias}.${q(c.name)}`);

async function count(db: Db, table: string): Promise<number> {
  const where = ROW_FILTERS[table] ? ` WHERE ${ROW_FILTERS[table]}` : '';
  return (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${q(table)}${where}`))?.n ?? 0;
}

/** Keyset-paginated read of a source table as JSON rows. */
async function* readBatches(db: Db, t: TableInfo, size: number, opts: { projection?: string; extraWhere?: string } = {}): AsyncGenerator<string[]> {
  const pkCols = t.pk.map((p) => t.columns.find((c) => c.name === p)!);
  const order = pkCols.map((c) => q(c.name)).join(', ');
  let last: string[] | null = null;
  for (;;) {
    const conds: string[] = [];
    if (ROW_FILTERS[t.name]) conds.push(ROW_FILTERS[t.name]);
    if (opts.extraWhere) conds.push(`(${opts.extraWhere})`);
    const params: unknown[] = [];
    if (last) {
      params.push(...last);
      conds.push(`(${order}) > (${pkCols.map((c, i) => `$${i + 1}::${c.type}`).join(', ')})`);
    }
    const rows = await db.query<{ j: string; k: string[] }>(
      `SELECT row_to_json(x)::text AS j, ARRAY[${pkCols.map((c) => `x.${q(c.name)}::text`).join(', ')}] AS k
       FROM (SELECT ${opts.projection ?? sourceProjection(t)} FROM ${q(t.name)} ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${size}) x`,
      params,
    );
    if (!rows.length) return;
    yield rows.map((r) => r.j);
    last = rows[rows.length - 1].k;
    if (rows.length < size) return;
  }
}

/** Split a batch so no single statement carries more than ~8 MB of JSON. */
function chunkBySize(rows: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const r of rows) {
    if (cur.length && size + r.length > MAX_PAYLOAD_CHARS) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(r);
    size += r.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

const pkMatch = (t: TableInfo, a: string, b: string) => t.pk.map((p) => `${a}.${q(p)} = ${b}.${q(p)}`).join(' AND ');

async function copyChunk(target: Db, t: TableInfo, rows: string[], overwrite: boolean): Promise<{ inserted: number; identical: number; differing: number; updated: number }> {
  const cols = copyCols(t);
  const payload = `[${rows.join(',')}]`;
  const src = `json_to_recordset($1::json) AS s(${recordDef(t)})`;
  return target.tx(async (tx) => {
    if (tx.kind === 'postgres') await tx.exec(`SET LOCAL statement_timeout = '15min'`);
    const cmp = await tx.one<{ identical: number; differing: number }>(
      `SELECT count(*) FILTER (WHERE (${cols.map((c) => `t.${q(c.name)}`).join(', ')}) IS NOT DISTINCT FROM (${cols.map((c) => srcExpr(c)).join(', ')}))::int AS identical,
              count(*) FILTER (WHERE (${cols.map((c) => `t.${q(c.name)}`).join(', ')}) IS DISTINCT FROM (${cols.map((c) => srcExpr(c)).join(', ')}))::int AS differing
       FROM ${src} JOIN ${q(t.name)} t ON ${pkMatch(t, 't', 's')}`,
      [payload],
    );
    const ins = await tx.one<{ n: number }>(
      `WITH ins AS (
         INSERT INTO ${q(t.name)} (${cols.map((c) => q(c.name)).join(', ')})
         SELECT ${cols.map((c) => (t.selfRefs.includes(c.name) ? 'NULL' : srcExpr(c))).join(', ')} FROM ${src}
         ON CONFLICT (${t.pk.map(q).join(', ')}) DO NOTHING RETURNING 1)
       SELECT count(*)::int AS n FROM ins`,
      [payload],
    );
    let updated = 0;
    if (overwrite && cmp!.differing > 0) {
      const settable = cols.filter((c) => !t.pk.includes(c.name) && !t.selfRefs.includes(c.name));
      const up = await tx.query(
        `UPDATE ${q(t.name)} t SET ${settable.map((c) => `${q(c.name)} = ${srcExpr(c)}`).join(', ')} FROM ${src}
         WHERE ${pkMatch(t, 't', 's')} AND (${settable.map((c) => `t.${q(c.name)}`).join(', ')}) IS DISTINCT FROM (${settable.map((c) => srcExpr(c)).join(', ')}) RETURNING 1`,
        [payload],
      );
      updated = up.length;
    }
    return { inserted: ins!.n, identical: cmp!.identical, differing: cmp!.differing, updated };
  });
}

/** Second pass for self-references: fill columns that were inserted as NULL. */
async function fillSelfRefs(source: Db, target: Db, t: TableInfo, size: number): Promise<void> {
  if (!t.selfRefs.length) return;
  const cols = t.columns.filter((c) => t.pk.includes(c.name) || t.selfRefs.includes(c.name));
  const projection = cols.map((c) => q(c.name)).join(', ');
  for await (const rows of readBatches(source, t, size, { projection, extraWhere: t.selfRefs.map((c) => `${q(c)} IS NOT NULL`).join(' OR ') })) {
    const payload = `[${rows.join(',')}]`;
    for (const col of t.selfRefs) {
      await target.query(
        `UPDATE ${q(t.name)} t SET ${q(col)} = s.${q(col)} FROM json_to_recordset($1::json) AS s(${recordDef(t, cols)})
         WHERE ${pkMatch(t, 't', 's')} AND t.${q(col)} IS NULL AND s.${q(col)} IS NOT NULL`,
        [payload],
      );
    }
  }
}

/** Count source rows whose primary key is absent from the target. */
async function missingInTarget(source: Db, target: Db, t: TableInfo, tableExists: boolean): Promise<number> {
  const cols = t.columns.filter((c) => t.pk.includes(c.name));
  const projection = cols.map((c) => q(c.name)).join(', ');
  let missing = 0;
  for await (const rows of readBatches(source, t, 5000, { projection })) {
    if (!tableExists) {
      missing += rows.length;
      continue;
    }
    const r = await target.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM json_to_recordset($1::json) AS s(${recordDef(t, cols)}) WHERE NOT EXISTS (SELECT 1 FROM ${q(t.name)} t WHERE ${pkMatch(t, 't', 's')})`,
      [`[${rows.join(',')}]`],
    );
    missing += r?.n ?? 0;
  }
  return missing;
}

/** Rows in the source whose natural (unique) key exists in the target under a different primary key. */
async function findConflicts(source: Db, target: Db, t: TableInfo): Promise<{ table: string; constraint: string; count: number; examples: string[] }[]> {
  const out: { table: string; constraint: string; count: number; examples: string[] }[] = [];
  for (const u of t.uniques) {
    const cols = t.columns.filter((c) => t.pk.includes(c.name) || u.columns.includes(c.name));
    const projection = cols.map((c) => (c.isJson ? `${q(c.name)}::text AS ${q(c.name)}` : q(c.name))).join(', ');
    let n = 0;
    const examples: string[] = [];
    for await (const rows of readBatches(source, t, 2000, { projection })) {
      const r = await target.query<{ k: string }>(
        `SELECT concat_ws(' / ', ${u.columns.map((c) => `s.${q(c)}::text`).join(', ')}) AS k
         FROM json_to_recordset($1::json) AS s(${recordDef(t, cols)})
         JOIN ${q(t.name)} t ON (${u.columns.map((c) => `t.${q(c)}`).join(', ')}) = (${u.columns.map((c) => srcExpr(cols.find((x) => x.name === c)!)).join(', ')})
         WHERE NOT (${pkMatch(t, 't', 's')})`,
        [`[${rows.join(',')}]`],
      );
      n += r.length;
      for (const x of r) if (examples.length < 5) examples.push(x.k);
    }
    if (n) out.push({ table: t.name, constraint: `${u.name} (${u.columns.join(', ')})`, count: n, examples });
  }
  // company_profiles has no natural key; a second, different profile in the target would make
  // "the company" ambiguous, so it is treated as a conflict too.
  if (t.name === 'company_profiles') {
    const srcIds = (await source.query<{ id: string }>('SELECT id::text AS id FROM company_profiles')).map((r) => r.id);
    if (srcIds.length) {
      const others = await target.query<{ id: string; name: string | null }>('SELECT id::text AS id, name FROM company_profiles WHERE NOT (id::text = ANY($1::text[]))', [srcIds]);
      if (others.length) out.push({ table: 'company_profiles', constraint: 'single company profile', count: others.length, examples: others.slice(0, 3).map((o) => `${o.id} (${o.name ?? 'blank, auto-created'})`) });
    }
  }
  return out;
}

/** True when the target holds nothing but what GovCheck creates automatically on first start. */
async function targetIsSeedOnly(target: Db): Promise<{ seedOnly: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  for (const t of DATA_TABLES) {
    const exists = await target.one<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [t]);
    if (!exists?.t) continue;
    const n = await count(target, t);
    if (n) reasons.push(`${t}: ${n} row(s)`);
  }
  const prof = await target.one<{ n: number }>(`SELECT count(*)::int AS n FROM company_profiles WHERE onboarding_completed_at IS NOT NULL OR name IS NOT NULL`).catch(() => null);
  if (prof?.n) reasons.push(`company_profiles: ${prof.n} configured profile(s)`);
  const custom = await target.one<{ n: number }>(`SELECT count(*)::int AS n FROM capabilities WHERE is_custom OR keywords_customized`).catch(() => null);
  if (custom?.n) reasons.push(`capabilities: ${custom.n} custom/edited`);
  return { seedOnly: reasons.length === 0, reasons };
}

async function clearTargetSeed(target: Db): Promise<void> {
  await target.tx(async (tx) => {
    await tx.query(`DELETE FROM watchlists WHERE is_system`);
    await tx.query(`UPDATE capabilities SET parent_id = NULL WHERE NOT is_custom`);
    await tx.query(`DELETE FROM capabilities WHERE NOT is_custom AND NOT keywords_customized`);
    await tx.query(`DELETE FROM company_profiles WHERE onboarding_completed_at IS NULL AND name IS NULL`);
    // Auto-registered connector rows that never ran are refreshed from the source below.
  });
}

export async function promoteDatabase(source: Db, target: Db, migrationsDir: string, options: PromoteOptions = {}): Promise<PromoteReport> {
  const log = options.log ?? (() => undefined);
  const batchSize = Math.max(10, options.batchSize ?? 500);
  const dryRun = !!options.dryRun;
  const report: PromoteReport = {
    ok: false,
    dryRun,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    migrationsApplied: [],
    pendingTargetMigrations: [],
    tables: [],
    conflicts: [],
    checks: [],
    problems: [],
  };
  const abort = (msg: string): never => {
    report.problems.push(msg);
    report.finishedAt = new Date().toISOString();
    throw new PromotionAborted(msg, report);
  };

  // 1. Schema versions ---------------------------------------------------------
  const shipped = availableMigrations(migrationsDir);
  const srcApplied = await appliedMigrations(source);
  const srcMissing = shipped.filter((v) => !srcApplied.includes(v));
  if (srcMissing.length) abort(`The local database is missing migrations ${srcMissing.join(', ')}. Run GovCheck locally once (or "npm run migrate") before promoting.`);
  const unknown = srcApplied.filter((v) => !shipped.includes(v));
  if (unknown.length) abort(`The local database has migrations this build does not know (${unknown.join(', ')}). Update GovCheck before promoting.`);

  const tgtApplied = await appliedMigrations(target);
  const tgtUnknown = tgtApplied.filter((v) => !shipped.includes(v));
  if (tgtUnknown.length) abort(`The target database has migrations this build does not know (${tgtUnknown.join(', ')}). It was set up by a newer GovCheck; update before promoting.`);
  report.pendingTargetMigrations = shipped.filter((v) => !tgtApplied.includes(v));
  if (!dryRun) {
    const res = await runMigrations(target, migrationsDir);
    report.migrationsApplied = res.applied;
    if (res.applied.length) log(`Applied ${res.applied.length} migration(s) to the target: ${res.applied.join(', ')}`);
  } else if (report.pendingTargetMigrations.length) {
    log(`[dry run] The target needs ${report.pendingTargetMigrations.length} migration(s): ${report.pendingTargetMigrations.join(', ')} (not applied in a dry run).`);
  }

  // 2. Table structure ----------------------------------------------------------
  const tables = await listTables(source);
  const infos: TableInfo[] = [];
  for (const t of tables) infos.push(await tableInfo(source, t));
  const noPk = infos.filter((i) => !i.pk.length).map((i) => i.name);
  if (noPk.length) abort(`Tables without a primary key cannot be copied idempotently: ${noPk.join(', ')}.`);
  let ordered: TableInfo[];
  try {
    ordered = topoSort(infos);
  } catch (err) {
    ordered = abort((err as Error).message);
  }

  const targetTables = new Set(await listTables(target));
  for (const t of ordered) {
    if (!targetTables.has(t.name)) {
      if (!dryRun) abort(`Table ${t.name} exists locally but not in the target after migrations — the schemas are incompatible.`);
      continue;
    }
    const tgt = await tableInfo(target, t.name);
    for (const c of copyCols(t)) {
      const tc = tgt.columns.find((x) => x.name === c.name);
      if (!tc) abort(`Schema mismatch: ${t.name}.${c.name} exists locally but not in the target.`);
      else if (tc.type !== c.type) abort(`Schema mismatch: ${t.name}.${c.name} is ${c.type} locally but ${tc.type} in the target.`);
    }
    if (tgt.pk.join(',') !== t.pk.join(',')) abort(`Schema mismatch: primary key of ${t.name} differs (${t.pk.join(',')} vs ${tgt.pk.join(',')}).`);
  }

  // 3. Counts before ------------------------------------------------------------
  for (const t of ordered) {
    report.tables.push({
      table: t.name,
      sourceCount: await count(source, t.name),
      targetBefore: targetTables.has(t.name) ? await count(target, t.name) : null,
      targetAfter: null,
      inserted: 0,
      identical: 0,
      differing: 0,
      updated: 0,
      missingAfter: null,
      errors: [],
    });
  }
  const row = (name: string) => report.tables.find((r) => r.table === name)!;
  log(`Source: ${report.tables.reduce((s, r) => s + r.sourceCount, 0).toLocaleString()} rows in ${ordered.length} tables.`);

  // 4. Conflict preflight (read-only) ------------------------------------------
  const scanConflicts = async () => {
    const found: PromoteReport['conflicts'] = [];
    for (const t of ordered) if (targetTables.has(t.name)) found.push(...(await findConflicts(source, target, t)));
    return found;
  };
  report.conflicts = await scanConflicts();
  if (report.conflicts.length) {
    const seed = await targetIsSeedOnly(target);
    const describe = report.conflicts.map((c) => `  - ${c.table} ${c.constraint}: ${c.count} row(s), e.g. ${c.examples.join('; ')}`).join('\n');
    if (seed.seedOnly && options.replaceTargetSeed && !dryRun) {
      log('The target holds only GovCheck’s auto-created reference data (capability library, system queues, blank company profile). Replacing it with the local copies (--replace-target-seed-data).');
      await clearTargetSeed(target);
      report.conflicts = await scanConflicts();
      if (report.conflicts.length) abort(`Conflicts remain after replacing the target's auto-created reference data:\n${report.conflicts.map((c) => `  - ${c.table} ${c.constraint}: ${c.count}`).join('\n')}`);
    } else if (seed.seedOnly) {
      const msg = `The target already contains GovCheck's auto-created reference data that conflicts with your local data (it was probably started against this database before promotion):\n${describe}\nIt holds no real work, so it is safe to replace: re-run with --replace-target-seed-data.`;
      if (dryRun) report.problems.push(msg);
      else abort(msg);
    } else {
      const msg = `The target already contains different GovCheck data under the same keys, so promoting would mix two databases:\n${describe}\nTarget data present: ${seed.reasons.join(', ')}.\nNothing was written. Promote into a new, empty Supabase database, or resolve the conflicting rows manually.`;
      if (dryRun) report.problems.push(msg);
      else abort(msg);
    }
  }

  if (dryRun) {
    for (const t of ordered) row(t.name).missingAfter = targetTables.has(t.name) ? await missingInTarget(source, target, t, true) : row(t.name).sourceCount;
    report.ok = report.problems.length === 0;
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // 5. Copy -----------------------------------------------------------------------
  for (const t of ordered) {
    const r = row(t.name);
    if (!r.sourceCount) continue;
    const size = LARGE_TABLES.has(t.name) ? Math.max(10, Math.floor(batchSize / 5)) : batchSize;
    let done = 0;
    for await (const rows of readBatches(source, t, size)) {
      for (const chunk of chunkBySize(rows)) {
        const res = await copyChunk(target, t, chunk, !!options.overwrite);
        r.inserted += res.inserted;
        r.identical += res.identical;
        r.differing += res.differing;
        r.updated += res.updated;
      }
      done += rows.length;
      if (r.sourceCount > size) log(`  ${t.name}: ${done.toLocaleString()}/${r.sourceCount.toLocaleString()}`);
    }
    await fillSelfRefs(source, target, t, batchSize);
    log(`${t.name}: ${r.inserted.toLocaleString()} inserted, ${r.identical.toLocaleString()} already present, ${r.differing.toLocaleString()} differ${options.overwrite ? ` (${r.updated} updated)` : ' (target kept)'}`);
  }

  // Connector rows auto-registered by a hosted app that never synced must take the local
  // cursors, schedules and settings — otherwise the next sync would start over.
  const srcConnectors = await source.query<any>(`SELECT id, cursor::text AS cursor, config::text AS config, enabled, schedule_minutes, next_run_at, last_attempted_at, last_success_at, last_run_id, records_retrieved_total, health, health_message FROM source_connectors`);
  for (const c of srcConnectors) {
    const tgt = await target.one<{ last_run_id: string | null; cursor: string }>(`SELECT last_run_id, cursor::text AS cursor FROM source_connectors WHERE id = $1`, [c.id]);
    if (tgt && tgt.last_run_id === null && (tgt.cursor === '{}' || options.overwrite) && tgt.cursor !== c.cursor) {
      await target.query(
        `UPDATE source_connectors SET cursor = $2::jsonb, config = $3::jsonb, enabled = $4, schedule_minutes = $5, next_run_at = $6, last_attempted_at = $7, last_success_at = $8,
           last_run_id = $9, records_retrieved_total = $10, health = $11, health_message = $12, updated_at = now() WHERE id = $1`,
        [c.id, c.cursor, c.config, c.enabled, c.schedule_minutes, c.next_run_at, c.last_attempted_at, c.last_success_at, c.last_run_id, c.records_retrieved_total, c.health, c.health_message],
      );
      log(`source_connectors: ${c.id} took the local cursor and schedule (target row had never synced).`);
    }
  }

  // Sequences (none today; kept generic so a future serial column cannot collide).
  const seqs = await target.query<{ table: string; column: string; seq: string }>(
    `SELECT c.relname AS table, a.attname AS column, pg_get_serial_sequence(quote_ident(c.relname), a.attname) AS seq
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND pg_get_serial_sequence(quote_ident(c.relname), a.attname) IS NOT NULL`,
  );
  for (const s of seqs) await target.query(`SELECT setval($1, GREATEST((SELECT COALESCE(max(${q(s.column)}), 0) FROM ${q(s.table)}), 1))`, [s.seq]);

  // 6. Verify ---------------------------------------------------------------------
  log('Verifying…');
  for (const t of ordered) {
    const r = row(t.name);
    r.targetAfter = await count(target, t.name);
    r.missingAfter = await missingInTarget(source, target, t, true);
    if (r.missingAfter) r.errors.push(`${r.missingAfter} local row(s) are not in the target`);
  }
  const missingTotal = report.tables.reduce((s, r) => s + (r.missingAfter ?? 0), 0);
  report.checks.push({ name: 'Every local row is present in the target (by primary key)', ok: missingTotal === 0, detail: missingTotal ? `${missingTotal} missing` : 'all present' });

  const tgtConnectors = new Map((await target.query<{ id: string; cursor: string }>(`SELECT id, cursor::text AS cursor FROM source_connectors`)).map((c) => [c.id, c.cursor]));
  const cursorDiffs = srcConnectors.filter((c) => tgtConnectors.get(c.id) !== c.cursor).map((c) => c.id);
  report.checks.push({
    name: 'Source connector cursors preserved (next sync continues where local left off)',
    ok: cursorDiffs.length === 0,
    detail: cursorDiffs.length ? `different in target: ${cursorDiffs.join(', ')} (the target already had its own sync history; it was kept)` : `${srcConnectors.length} connectors match`,
  });

  const company = await source.one<{ id: string; onboarding_completed_at: string | null }>('SELECT id::text AS id, onboarding_completed_at FROM company_profiles ORDER BY created_at LIMIT 1');
  if (company) {
    const tgtCompany = await target.one<{ id: string }>('SELECT id::text AS id FROM company_profiles ORDER BY created_at LIMIT 1');
    report.checks.push({ name: 'Company profile is the active profile in the target', ok: tgtCompany?.id === company.id, detail: tgtCompany?.id === company.id ? company.id : `target's first profile is ${tgtCompany?.id}` });
  }
  const tgtVersions = await appliedMigrations(target);
  report.checks.push({ name: 'Schema versions match', ok: tgtVersions.join(',') === shipped.join(','), detail: tgtVersions.join(', ') });
  const fkCount = await target.one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname = current_schema() AND con.contype = 'f'`);
  report.checks.push({ name: 'Relationships enforced by the target (foreign keys)', ok: true, detail: `${fkCount?.n ?? 0} foreign-key constraints validated every inserted row` });

  report.ok = report.checks.every((c) => c.ok) && report.problems.length === 0;
  report.finishedAt = new Date().toISOString();
  await target.query(`INSERT INTO app_state (key, value) VALUES ('promotion:last', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [
    json({ at: report.finishedAt, ok: report.ok, rows: report.tables.reduce((s, r) => s + r.sourceCount, 0), inserted: report.tables.reduce((s, r) => s + r.inserted, 0) }),
  ]);
  return report;
}

/** Fixed-width table for the terminal. */
export function formatReport(report: PromoteReport): string {
  const head = ['table', 'local', 'remote before', 'remote after', 'inserted', 'present', 'differs', 'missing', 'errors'];
  const rows = report.tables.map((r) => [
    r.table,
    String(r.sourceCount),
    r.targetBefore == null ? '(new)' : String(r.targetBefore),
    r.targetAfter == null ? '-' : String(r.targetAfter),
    String(r.inserted),
    String(r.identical),
    r.updated ? `${r.differing} (${r.updated} upd)` : String(r.differing),
    r.missingAfter == null ? '-' : String(r.missingAfter),
    r.errors.length ? r.errors.join('; ') : '',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  const out = [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)];
  if (report.conflicts.length) out.push('', 'Conflicts:', ...report.conflicts.map((c) => `  ${c.table} ${c.constraint}: ${c.count} (e.g. ${c.examples.join('; ')})`));
  if (report.checks.length) out.push('', 'Checks:', ...report.checks.map((c) => `  [${c.ok ? 'OK' : 'FAIL'}] ${c.name} — ${c.detail}`));
  if (report.problems.length) out.push('', 'Problems:', ...report.problems.map((p) => `  ${p}`));
  return out.join('\n');
}
