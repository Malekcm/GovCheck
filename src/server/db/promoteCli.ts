import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config';
import { createDb, describeDatabaseUrl, type Db } from './index';
import { runMigrations } from './migrate';
import { formatReport, promoteDatabase, PromotionAborted, type PromoteReport } from './promote';

/**
 * `npm run db:promote -- [--dry-run] [--from ./data/pglite] [--overwrite] [--replace-target-seed-data] [--batch-size 500]`
 *
 * Copies the local PGlite database (SOURCE, never modified) into the PostgreSQL / Supabase
 * database named by TARGET_DATABASE_URL (or DATABASE_URL). TLS settings come from the usual
 * DATABASE_SSL_CA_PEM / DATABASE_SSL_CA_BASE64 / DATABASE_SSL_CA_FILE variables.
 */
export interface PromoteCliArgs {
  dryRun: boolean;
  from: string | null;
  overwrite: boolean;
  replaceTargetSeed: boolean;
  batchSize: number;
  help: boolean;
}

export function parsePromoteArgs(argv: string[]): PromoteCliArgs {
  const args: PromoteCliArgs = { dryRun: false, from: null, overwrite: false, replaceTargetSeed: false, batchSize: 500, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--overwrite') args.overwrite = true;
    else if (a === '--replace-target-seed-data') args.replaceTargetSeed = true;
    else if (a === '--from') args.from = argv[++i] ?? null;
    else if (a.startsWith('--from=')) args.from = a.slice(7);
    else if (a === '--batch-size') args.batchSize = Number(argv[++i]);
    else if (a.startsWith('--batch-size=')) args.batchSize = Number(a.slice(13));
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown option ${a}. Use --help.`);
  }
  if (!Number.isFinite(args.batchSize) || args.batchSize < 10) throw new Error('--batch-size must be a number ≥ 10');
  return args;
}

/** Path + size + mtime of every file: proves the local database directory was not touched. */
export function directoryFingerprint(dir: string, content = false): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        h.update(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}\n`);
        if (content) h.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

const HELP = `GovCheck: promote the local PGlite database into PostgreSQL / Supabase

  npm run db:promote -- --dry-run      show what would be copied (writes nothing anywhere)
  npm run db:promote                   copy (insert-only, resumable, safe to re-run)

Options
  --from <dir>                  local PGlite directory (default: PGLITE_DIR or ./data/pglite)
  --overwrite                   also UPDATE target rows whose content differs from local
                                (default: rows already in the target are kept as they are)
  --replace-target-seed-data    if the target only holds GovCheck's auto-created reference data
                                (it was started once before promotion), replace it with yours
  --batch-size <n>              rows per batch (default 500)

Environment
  TARGET_DATABASE_URL   the Supabase connection string (falls back to DATABASE_URL)
  DATABASE_SSL_CA_PEM / DATABASE_SSL_CA_BASE64 / DATABASE_SSL_CA_FILE   Supabase CA certificate

The local database is never modified: GovCheck copies the directory to a temporary snapshot
and reads the snapshot. Stop the local GovCheck server before promoting.`;

export async function runPromoteCli(argv: string[], env: NodeJS.ProcessEnv = process.env, hooks: { openTarget?: (url: string) => Promise<Db>; quiet?: boolean } = {}): Promise<number> {
  const console = hooks.quiet ? { log: () => undefined, error: () => undefined } : globalThis.console;
  const args = parsePromoteArgs(argv);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const config = loadConfig(env);
  const targetUrl = env.TARGET_DATABASE_URL?.trim() || config.databaseUrl;
  if (!targetUrl) throw new Error('Set TARGET_DATABASE_URL (or DATABASE_URL) to the Supabase connection string. See docs/DEPLOY_SUPABASE_RENDER.md.');
  if (!/^postgres(ql)?:\/\//i.test(targetUrl)) throw new Error('TARGET_DATABASE_URL must be a postgres:// connection string.');
  const sourceDir = path.resolve(args.from ?? config.pgliteDir);
  if (!fs.existsSync(path.join(sourceDir, 'PG_VERSION'))) throw new Error(`No GovCheck PGlite database found at ${sourceDir} (expected a PG_VERSION file).`);

  console.log(`Source (read-only): ${sourceDir}`);
  console.log(`Target:             ${describeDatabaseUrl(targetUrl)}`);
  console.log(args.dryRun ? 'Mode:               DRY RUN — nothing will be written' : `Mode:               copy (${args.overwrite ? 'insert + overwrite differing rows' : 'insert-only; existing target rows are kept'})`);

  const before = directoryFingerprint(sourceDir);
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'govcheck-promote-'));
  const snapDir = path.join(snapshot, 'pglite');
  console.log(`Copying the local database to a temporary snapshot (${snapDir})…`);
  fs.cpSync(sourceDir, snapDir, { recursive: true });

  const source = await createDb({ pgliteDir: snapDir });
  const target = hooks.openTarget ? await hooks.openTarget(targetUrl) : await createDb({ ...config, databaseUrl: targetUrl, databasePoolMax: 4 });
  let report: PromoteReport | null = null;
  let exit: number;
  try {
    // Bring the SNAPSHOT up to this build's schema (the real directory is untouched).
    await runMigrations(source, config.migrationsDir);
    report = await promoteDatabase(source, target, config.migrationsDir, {
      dryRun: args.dryRun,
      overwrite: args.overwrite,
      replaceTargetSeed: args.replaceTargetSeed,
      batchSize: args.batchSize,
      log: (l) => console.log(l),
    });
    exit = report.ok ? 0 : 2;
  } catch (err) {
    if (err instanceof PromotionAborted) {
      report = err.report;
      console.error(`\nPROMOTION STOPPED — nothing unsafe was done.\n${err.message}`);
      exit = 3;
    } else {
      console.error(`\nPromotion failed: ${err instanceof Error ? err.message : String(err)}\nIt is safe to fix the problem and run the same command again; rows already copied are skipped.`);
      exit = 1;
    }
  } finally {
    await source.close().catch(() => undefined);
    await target.close().catch(() => undefined);
    fs.rmSync(snapshot, { recursive: true, force: true });
  }

  const after = directoryFingerprint(sourceDir);
  if (report) {
    console.log(`\n${formatReport(report)}`);
    const file = path.resolve(env.PROMOTE_REPORT_DIR ?? 'data', `promotion-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...report, target: describeDatabaseUrl(targetUrl), source: sourceDir, localUnchanged: before === after }, null, 2));
    console.log(`\nReport saved to ${file}`);
  }
  console.log(before === after ? 'Local database unchanged: verified (file sizes and timestamps identical).' : 'WARNING: the local database directory changed during promotion — was GovCheck running locally?');
  if (exit === 0) console.log(args.dryRun ? '\nDry run complete. Run again without --dry-run to copy.' : '\nPromotion complete and verified.');
  return exit;
}
