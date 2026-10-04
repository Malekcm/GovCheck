import { bootstrap, loadEnvFile } from './bootstrap';
import { runPromoteCli } from './db/promoteCli';
import { samBudgetStatus } from './pipeline/budget';
import { computeCoverage } from './pipeline/coverage';
import { storageDiagnostics } from './pipeline/diagnostics';
import { samPriorityOverview } from './pipeline/samPriority';
import { dueDetails, runDueWorkNow } from './pipeline/scheduler';
import { postProcess, runAllSources, runConnector } from './pipeline/sync';
import { loadCompanyContext } from './scoring/profile';
import { retrainAndRescore, scoreMany } from './scoring/run';

/**
 * Command-line entry points (useful for cron jobs on the host and first-time imports):
 *   npm run migrate                      apply migrations + seed
 *   npm run sync:due                     NORMAL OPERATION: run only the sources that are due (+ derived intelligence)
 *   npm run sync:due -- --dry-run        show what is due and how SAM requests would be spent; change nothing
 *   npm run status                       data freshness, schedule, SAM budget and database size
 *   npm run db:promote [-- --dry-run]    copy the local PGlite database into Supabase/Postgres (see docs)
 *   npm run sync                         ADVANCED: refresh every enabled source now (incremental) + derived intelligence
 *   npm run sync -- reconcile            ADVANCED: full reconciliation pass (bulk files, full listings)
 *   npm run sync -- <connectorId> [reconcile]
 *   npm run sync -- archive <FY>         import an archived SAM fiscal-year file (filtered to profile NAICS)
 *   npx tsx src/server/cli.ts score      rescore everything
 *   npx tsx src/server/cli.ts retrain    retrain the preference model
 */
function flag(args: string[], name: string): string | null {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return null;
  const a = args[i];
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : 'true';
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'promote') {
    // Never bootstrap here: that would open (and migrate) the live local database.
    loadEnvFile();
    process.exitCode = await runPromoteCli(args);
    return;
  }
  const deps = await bootstrap();
  const { log, db } = deps;
  try {
    switch (cmd) {
      case 'migrate':
        log.info('Database migrated and seeded.');
        break;
      case 'sync': {
        if (args[0] === 'due') {
          const triggeredBy = flag(args, '--triggered-by') ?? 'cli';
          if (flag(args, '--dry-run')) {
            const { onboardingComplete, details } = await dueDetails(db);
            if (!onboardingComplete) log.info('Onboarding is not complete: nothing runs on a schedule until the company profile setup is finished.');
            for (const d of details) log.info(`${d.due ? 'DUE    ' : 'not due'} ${d.id}${d.kind === 'reconcile' ? ' (reconcile)' : ''} — ${d.reason}${d.nextAt ? ` · next ${d.nextAt}` : ''}`);
            const plan = await samPriorityOverview(db, deps.config);
            log.info(`SAM budget: ${plan.used}/${plan.limit} used today, ${plan.reserve} reserved for manual use, ${plan.backgroundAvailable} available to scheduled checks.`);
            for (const t of plan.tiers) log.info(`  ${t.label}: ${t.candidates.length} candidate(s)`);
            break;
          }
          const r = await runDueWorkNow(deps, triggeredBy);
          if (!r.started) {
            log.info(`Another GovCheck process is already syncing (${r.label}); nothing to do.`);
            break;
          }
          if (!r.report?.results.length) log.info('Nothing is due. Every source is within its schedule.');
          if (r.report?.priority) log.info(`SAM priority checks: ${r.report.priority.message}`);
          for (const x of r.report?.results ?? []) log.info(`${x.connectorId}: ${x.status} — retrieved ${x.stats.retrieved}, new ${x.stats.created}, changed ${x.stats.updated}, unchanged ${x.stats.unchanged} — ${x.message}`);
          if (r.report) log.info(`${r.report.dirty} opportunity profile(s) changed and were re-scored.`);
          break;
        }
        if (!args.length || args[0] === 'reconcile') {
          const results = await runAllSources(deps, { triggeredBy: 'cli', mode: args[0] === 'reconcile' ? 'reconcile' : 'incremental' });
          for (const r of results) log.info(`${r.connectorId}: ${r.status} — ${r.message}`);
        } else if (args[0] === 'archive') {
          const fy = Number(args[1]);
          if (!fy) throw new Error('Usage: sync archive <fiscalYear>');
          const r = await runConnector(deps, 'sam_bulk', { mode: 'reconcile', triggeredBy: 'cli', params: { fiscalYear: fy }, timeLimitMs: 6 * 3600_000, maxChanged: Number.POSITIVE_INFINITY });
          await postProcess(deps, { dirty: new Set(r.dirty), triggeredBy: 'cli' });
          log.info(`${r.connectorId}: ${r.status} — ${r.message}`);
        } else {
          const r = await runConnector(deps, args[0], { mode: args[1] === 'reconcile' ? 'reconcile' : 'incremental', triggeredBy: 'cli', timeLimitMs: 4 * 3600_000 });
          await postProcess(deps, { dirty: new Set(r.dirty), triggeredBy: 'cli', runRecompete: args[0] === 'usaspending' });
          log.info(`${r.connectorId}: ${r.status} — ${r.message}`);
        }
        break;
      }
      case 'status': {
        const { details } = await dueDetails(db);
        for (const d of details) log.info(`${d.due ? 'DUE    ' : 'ok     '} ${d.id}${d.kind === 'reconcile' ? ' (reconcile)' : ''}${d.nextAt ? ` · next ${d.nextAt}` : ''}`);
        const sam = await samBudgetStatus(db, deps.config);
        log.info(`SAM requests today: ${sam.used}/${sam.limit} (reserve ${sam.reserve}) · resets ${sam.resetsAt}`);
        const st = await storageDiagnostics(db, deps.config);
        log.info(`Database: ${st.sizeMb ?? '?'} MB · ${st.counts.opportunities} opportunities · ${st.counts.source_records} source records · ${st.counts.source_record_versions} versions`);
        for (const w of st.warnings) log.warn(w);
        break;
      }
      case 'score':
        log.info(`Scored ${await scoreMany(db, 'all', 'cli')} profiles.`);
        break;
      case 'retrain': {
        const m = await retrainAndRescore(db, 'cli');
        log.info(`Preference model v${m.version} (${m.sampleCount} decisions, stage ${m.stage}).`);
        break;
      }
      case 'coverage': {
        const co = await loadCompanyContext(db);
        log.info(JSON.stringify(await computeCoverage(db, { companyNaics: co.naics })));
        break;
      }
      default:
        log.info('Commands: migrate | sync due [--dry-run] | status | promote [--dry-run] | sync [reconcile|<connector> [reconcile]|archive <FY>] | score | retrain | coverage');
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
