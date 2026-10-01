import { bootstrap } from './bootstrap';
import { computeCoverage } from './pipeline/coverage';
import { postProcess, runAllSources, runConnector } from './pipeline/sync';
import { loadCompanyContext } from './scoring/profile';
import { retrainAndRescore, scoreMany } from './scoring/run';

/**
 * Command-line entry points (useful for cron jobs on the host and first-time imports):
 *   npm run migrate                      apply migrations + seed
 *   npm run sync                         refresh all enabled sources (incremental) + derived intelligence
 *   npm run sync -- reconcile            broader reconciliation pass (bulk files, full listings)
 *   npm run sync -- <connectorId> [reconcile]
 *   npm run sync -- archive <FY>         import an archived SAM fiscal-year file (filtered to profile NAICS)
 *   npx tsx src/server/cli.ts score      rescore everything
 *   npx tsx src/server/cli.ts retrain    retrain the preference model
 */
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const deps = await bootstrap();
  const { log, db } = deps;
  try {
    switch (cmd) {
      case 'migrate':
        log.info('Database migrated and seeded.');
        break;
      case 'sync': {
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
        log.info('Commands: migrate | sync [reconcile|<connector> [reconcile]|archive <FY>] | score | retrain | coverage');
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
