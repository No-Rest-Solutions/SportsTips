import { loadConfig } from './config.mjs';
import { prepareFreshDailyCheck, runForcedDailyCheck } from './forced-daily-check.mjs';
import { runAnalysisJob } from './jobs/analysis.mjs';
import { runPicksJob } from './jobs/picks.mjs';
import { runPromoGenerationJob, runPromoSettlementJob, runPromoReportJob } from './jobs/promos.mjs';
import { runReferralsJob } from './jobs/referrals.mjs';
import { runResultsJob } from './jobs/results.mjs';
import { runSlatesJob } from './jobs/slates.mjs';
import { runTabMenuJob } from './jobs/tab-menu.mjs';
import { runTrackerSummaryJob } from './jobs/tracker-summary.mjs';
import { loadRuntimeStatus, saveRuntimeStatus } from './runtime-status.mjs';
import { getDueJobs } from './scheduler.mjs';
import { loadState, saveState } from './state.mjs';

const JOBS = {
  slates: runSlatesJob,
  analysis: runAnalysisJob,
  picks: runPicksJob,
  referrals: runReferralsJob,
  results: runResultsJob,
  trackerSummary: runTrackerSummaryJob,
  tabMenu: runTabMenuJob,
  promosGeneration: runPromoGenerationJob,
  promosSettlement: runPromoSettlementJob,
  promosReport: runPromoReportJob
};
const RESULT_TEAM_MARKET_SUMMARY = 'h2h, spreads, totals, double_chance, and first-half variants';
const RESULT_PLAYER_MARKETS_BY_SPORT = {
  afl: ['player_disposals'],
  nrl: ['player_points'],
  nba: ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists', 'player_points_assists', 'player_points_rebounds', 'player_rebounds_assists'],
  mlb: ['batter_hits', 'pitcher_strikeouts'],
  nfl: ['player_pass_yds', 'player_rush_yds']
};
const OUTDOOR_RESEARCH_SPORT_KEYS = new Set(['afl', 'mlb', 'nfl', 'nrl', 'soccer_epl', 'soccer_uefa_champs_league']);
const RUNTIME_WEBHOOK_FIELDS = [
  'slates',
  'picks',
  'picksNba',
  'picksMlb',
  'picksAfl',
  'picksNrl',
  'picksNfl',
  'picksEpl',
  'picksOther',
  'referralsNew',
  'referralsUpdatedTerms',
  'referralsCancelled',
  'referralsMasterlist',
  'unitTracking',
  'unitReport'
];

function isOtherSportWebhookBucket(sportKey) {
  if (!sportKey) {
    return false;
  }

  return sportKey === 'nhl'
    || sportKey.startsWith('tennis')
    || (sportKey.startsWith('soccer') && sportKey !== 'soccer_epl');
}

function getDoctorWebhookBucket(sportKey) {
  switch (sportKey) {
    case 'nba':
      return 'picksNba';
    case 'mlb':
      return 'picksMlb';
    case 'afl':
      return 'picksAfl';
    case 'nrl':
      return 'picksNrl';
    case 'nfl':
      return 'picksNfl';
    case 'soccer_epl':
      return 'picksEpl';
    default:
      return isOtherSportWebhookBucket(sportKey) ? 'picksOther' : 'picks';
  }
}

function getDoctorSettlementSources(sportKey) {
  const sources = ['ESPN'];

  if (sportKey === 'afl') {
    sources.push('Official AFL', 'Flashscore');
  } else if (sportKey === 'nrl') {
    sources.push('Official NRL', 'Flashscore');
  }

  return sources;
}

function getDoctorResearchChecks(sportKey) {
  const checks = [];

  checks.push('Recent ESPN finalized-team form scoring (soft signal only)');
  checks.push('External soft signals from TAB market presence and Sportsbet targetBet alignment when available');

  if (['afl', 'nrl', 'nba', 'nhl', 'nfl', 'soccer_epl', 'soccer_uefa_champs_league'].includes(sportKey)) {
    checks.push('ESPN team-injury checks for prop candidates when team metadata exists');
  }

  if (sportKey === 'afl') {
    checks.push('Official AFL player-team confirmation');
  }

  if (sportKey === 'mlb') {
    checks.push('Official MLB starter and lineup checks with projected RotoWire lineup/news support');
  }

  if (OUTDOOR_RESEARCH_SPORT_KEYS.has(sportKey)) {
    checks.push(sportKey === 'nrl'
      ? 'Open-Meteo weather plus official NRL weather and ground conditions'
      : 'Open-Meteo outdoor weather checks');
  }

  if (!checks.length) {
    checks.push('No dedicated pre-pick research gate beyond market structure and benchmark filters');
  }

  return checks;
}

function formatDoctorPlayerMarkets(sportKey) {
  const markets = RESULT_PLAYER_MARKETS_BY_SPORT[sportKey] || [];
  return markets.length ? markets.join(', ') : 'none';
}

function parseCli(argv) {
  const flags = new Set(argv.filter((item) => item.startsWith('--')));
  const positional = argv.filter((item) => !item.startsWith('--'));
  const command = positional[0] || 'doctor';
  const target = positional[1] || 'all';
  return {
    command,
    target,
    dryRun: flags.has('--dry-run')
  };
}

function isPendingWatchPick(trackedPick) {
  const status = String(trackedPick?.status || '').toLowerCase();

  if (trackedPick?.postedAt || trackedPick?.replacementPostedAt || trackedPick?.pregameRecheckedAt) {
    return false;
  }

  return ![
    'posted_waiting_for_pregame_recheck',
    'pregame_recheck_passed',
    'replacement_posted',
    'replacement_expired',
    'cancelled'
  ].includes(status);
}

function isActiveTrackedPick(trackedPick) {
  const status = String(trackedPick?.status || '').toLowerCase();

  return ![
    'pregame_recheck_passed',
    'replacement_expired',
    'cancelled'
  ].includes(status);
}

function getWatchedPickCount(state) {
  const trackedPicks = Object.values(state.tracking?.picks || {});
  const activeTrackedPicks = trackedPicks.filter((trackedPick) => isActiveTrackedPick(trackedPick)).length;

  if (activeTrackedPicks > 0) {
    return activeTrackedPicks;
  }

  return trackedPicks.filter((trackedPick) => isPendingWatchPick(trackedPick)).length;
}

function buildRuntimeWebhookState(webhooks = {}) {
  return Object.fromEntries(RUNTIME_WEBHOOK_FIELDS.map((field) => [field, Boolean(webhooks?.[field])]));
}

async function writeRuntimeStatus(config, state, patch = {}) {
  const existing = await loadRuntimeStatus(config.__paths.runtimeStatusFile);
  const nowIso = new Date().toISOString();
  const lastMarketQuoteCount = Number(state.providers?.marketScrape?.lastQuoteCount);
  const preserveStartedAt = existing.running && existing.pid === process.pid;

  await saveRuntimeStatus(config.__paths.runtimeStatusFile, {
    ...existing,
    running: true,
    pid: process.pid,
    mode: 'daemon',
    timezone: config.timezone,
    dryRun: Boolean(config.dryRun),
    startedAt: preserveStartedAt ? (existing.startedAt || nowIso) : nowIso,
    heartbeatAt: nowIso,
    stoppedAt: null,
    stopReason: null,
    watchedPicks: getWatchedPickCount(state),
    lastMarketQuoteCount: Number.isFinite(lastMarketQuoteCount) ? lastMarketQuoteCount : null,
    lastMarketRefreshAt: state.providers?.marketScrape?.lastRefreshAt || null,
    webhooks: buildRuntimeWebhookState(config.discord.webhooks),
    lastRuns: state.jobs || {},
    lastError: null,
    ...patch
  });
}

async function stopRuntimeStatus(config, state, patch = {}) {
  const existing = await loadRuntimeStatus(config.__paths.runtimeStatusFile);
  const lastMarketQuoteCount = Number(state.providers?.marketScrape?.lastQuoteCount);

  await saveRuntimeStatus(config.__paths.runtimeStatusFile, {
    ...existing,
    running: false,
    pid: null,
    heartbeatAt: new Date().toISOString(),
    watchedPicks: getWatchedPickCount(state),
    lastMarketQuoteCount: Number.isFinite(lastMarketQuoteCount)
      ? lastMarketQuoteCount
      : existing.lastMarketQuoteCount ?? null,
    lastMarketRefreshAt: state.providers?.marketScrape?.lastRefreshAt || existing.lastMarketRefreshAt || null,
    lastRuns: state.jobs || existing.lastRuns || {},
    ...patch
  });
}

async function runNamedJob(jobName, context) {
  const handler = JOBS[jobName];

  if (!handler) {
    throw new Error(`Unknown job: ${jobName}`);
  }

  const result = await handler(context);
  const extras = [];

  if (result.generated !== undefined) {
    extras.push(`generated ${result.generated}`);
  }

  if (result.considered !== undefined) {
    extras.push(`considered ${result.considered}`);
  }

  if (result.watched !== undefined) {
    extras.push(`watching ${result.watched}`);
  }

  if (result.offers !== undefined) {
    extras.push(`offers ${result.offers}`);
  }

  if (result.changes !== undefined) {
    extras.push(`changes ${result.changes}`);
  }

  console.log(`[${jobName}] posted ${result.posted}${extras.length ? ` | ${extras.join(' | ')}` : ''}`);
}

async function runDoctor(config, state) {
  console.log(`Config: ${config.__paths.configPath}`);
  console.log(`Timezone: ${config.timezone}`);
  console.log(`Dry run: ${Boolean(config.dryRun)}`);
  console.log(`Slate webhook: ${config.discord.webhooks.slates ? 'configured' : 'missing'}`);
  console.log(`Shared picks webhook: ${config.discord.webhooks.picks ? 'configured' : 'missing'}`);
  console.log(`NBA picks webhook: ${config.discord.webhooks.picksNba ? 'configured' : 'missing'}`);
  console.log(`MLB picks webhook: ${config.discord.webhooks.picksMlb ? 'configured' : 'missing'}`);
  console.log(`AFL picks webhook: ${config.discord.webhooks.picksAfl ? 'configured' : 'missing'}`);
  console.log(`NRL picks webhook: ${config.discord.webhooks.picksNrl ? 'configured' : 'missing'}`);
  console.log(`NFL picks webhook: ${config.discord.webhooks.picksNfl ? 'configured' : 'missing'}`);
  console.log(`EPL picks webhook: ${config.discord.webhooks.picksEpl ? 'configured' : 'missing'}`);
  console.log(`Other picks webhook: ${config.discord.webhooks.picksOther ? 'configured' : 'missing'}`);
  console.log(`Referral new webhook: ${config.discord.webhooks.referralsNew ? 'configured' : 'missing'}`);
  console.log(`Referral updated-terms webhook: ${config.discord.webhooks.referralsUpdatedTerms ? 'configured' : 'missing'}`);
  console.log(`Referral cancelled webhook: ${config.discord.webhooks.referralsCancelled ? 'configured' : 'missing'}`);
  console.log(`Referral masterlist webhook: ${config.discord.webhooks.referralsMasterlist ? 'configured' : 'missing'}`);
  console.log(`Results / Unit Tracking webhook: ${config.discord.webhooks.unitTracking ? 'configured' : 'missing'}`);
  console.log(`Unit Report webhook: ${config.discord.webhooks.unitReport ? 'configured' : 'missing'}`);
  console.log(`OpenAI: ${config.openai.enabled ? (config.openai.apiKey ? `configured via ${config.openai.apiKeyEnv} (${config.openai.model})` : `missing ${config.openai.apiKeyEnv} (${config.openai.model})`) : 'disabled'}`);
  console.log(`Analysis engine: ${config.analysis.engine}${config.analysis.engine === 'auto' ? ' (OpenAI when available, rules fallback otherwise)' : ''}`);
  console.log(`Deep analysis: ${config.analysis.deepAnalysis?.enabled ? `enabled | ${config.analysis.deepAnalysis.requireLegEvidence ? 'HARD GATE (only evidence-supported legs)' : 'observe only (no gating)'} | last ${config.analysis.deepAnalysis.recentGames} games, min ${config.analysis.deepAnalysis.minGames}, hit-rate ${config.analysis.deepAnalysis.minHitRate}` : 'disabled'}`);
  console.log(`Market scrape: ${config.marketScrape.enabled ? `enabled | ${config.marketScrape.bookmakerTitle} -> ${config.__paths.snapshotFile} | refresh ${config.marketScrape.refreshIntervalMinutes}m | freshness ${config.marketScrape.maxSnapshotAgeMinutes}m` : 'disabled'}`);
  console.log(`Runtime status file: ${config.__paths.runtimeStatusFile}`);
  console.log(`Analysis timing: ${config.jobs.analysis.enabled ? `${config.jobs.analysis.time} start | every ${config.jobs.analysis.intervalMinutes}m | ${config.analysis.lookaheadHours}h lookahead` : 'disabled'}`);
  console.log(`Picks timing: shortlist ${config.jobs.picks.shortlistHours}h out | post window ${config.jobs.picks.postWindowHours}h | recheck ${config.jobs.picks.preWindowCheckMinutes}m outside window and ${config.jobs.picks.inWindowCheckMinutes}m inside window`);
  console.log(`Referrals timing: ${config.jobs.referrals.enabled ? `${config.jobs.referrals.time} start | every ${config.jobs.referrals.intervalMinutes}m | catalog ${config.__paths.referralsCatalogFile}` : 'disabled'}`);
  console.log(`Tracker summary: ${config.bankrollTracker?.enabled !== false ? `${config.bankrollTracker.summaryTime} via ${config.bankrollTracker.summaryWebhook || 'unitReport'} webhook` : 'disabled'}`);
  console.log(`Promos: ${config.jobs?.promos?.enabled ? `generate ${config.jobs.promos.generationTime} | settle every ${config.jobs.promos.settlementIntervalMinutes}m | report ${config.jobs.promos.reportTime}` : 'disabled'}`);
  console.log(`Cached validation entries: ${Object.keys(state.cache?.oddsValidation || {}).length}`);

  if (state.providers?.marketScrape?.lastQuoteCount !== undefined) {
    console.log(`Last scraped quote count: ${state.providers.marketScrape.lastQuoteCount}`);
  }

  if (state.providers?.marketScrape?.lastRefreshAt) {
    console.log(`Last scraped refresh: ${state.providers.marketScrape.lastRefreshAt}`);
  }

  console.log(`Benchmark support thresholds: significant ${config.benchmarkFilters.significantSupportScore.toFixed(2)} | strong ${config.benchmarkFilters.strongSupportScore.toFixed(2)}`);
  console.log('Enabled sports:');

  for (const sport of config.sports) {
    if (sport.enabled) {
      console.log(`- ${sport.label} (${sport.marketPageUrl || 'default sportsbook page'})`);
    }
  }

  console.log('Coverage audit:');

  for (const sport of config.sports) {
    if (!sport.enabled) {
      continue;
    }

    const sportKey = String(sport.key || sport.marketKey || '').trim().toLowerCase();
    const settlementSources = getDoctorSettlementSources(sportKey).join(' + ');
    const researchChecks = getDoctorResearchChecks(sportKey).join(' | ');

    console.log(`- ${sport.label} | webhook ${getDoctorWebhookBucket(sportKey)} | results ${settlementSources} | team results ${RESULT_TEAM_MARKET_SUMMARY} | player auto-grade ${formatDoctorPlayerMarkets(sportKey)} | research ${researchChecks}`);
  }

  console.log('Research gaps:');
  console.log('- Past-performance is now a soft recent-team-form signal from finalized ESPN results, but there is still no broad player-level rolling-form provider layer across every supported prop market.');
  console.log('- External soft signals currently use TAB market presence plus Sportsbet embedded targetBet matches when available; full bookmaker editorial or TAB tip ingestion is still not wired.');
}

async function runOnce(target, context) {
  if (target === 'prepare-daily-check') {
    const result = await prepareFreshDailyCheck(context.config, context.state);
    console.log(`[prepare-daily-check] cleared ${result.removedGeneratedFeedPicks} generated feed picks | ${result.removedPostedPickIds.length} posted ids | ${result.removedTrackingPickIds.length} tracked ids`);
    return;
  }

  if (target === 'daily-check') {
    const result = await runForcedDailyCheck(context);
    console.log(`[daily-check] slates ${result.slates.posted} | analysis generated ${result.analysis.generated} of ${result.analysis.considered} | picks posted ${result.picks.posted} watching ${result.picks.watched}`);
    return;
  }

  const jobs = target === 'all' ? Object.keys(JOBS) : [target];

  for (const jobName of jobs) {
    await runNamedJob(jobName, context);
  }
}

async function runDaemon(context) {
  console.log(`Scheduler running in ${context.config.timezone}. Press Ctrl+C to stop.`);

  let shuttingDown = false;

  const finalize = async (reason, error = null) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    await stopRuntimeStatus(context.config, context.state, {
      stopReason: reason,
      stoppedAt: new Date().toISOString(),
      lastError: error ? String(error.message || error) : null,
      status: 'stopped'
    });
  };

  const handleSignal = (signal) => {
    finalize(signal)
      .catch((error) => {
        console.error(error.message);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    await writeRuntimeStatus(context.config, context.state, {
      status: 'starting'
    });

    for (;;) {
      await writeRuntimeStatus(context.config, context.state, {
        status: 'idle'
      });

      const dueJobs = getDueJobs(context.config, context.state, new Date());

      for (const jobName of dueJobs) {
        await writeRuntimeStatus(context.config, context.state, {
          status: `running:${jobName}`
        });

        // Isolate each job: a single job throwing must NEVER turn the whole daemon off.
        // Log it, record it in runtime-status, and carry on to the next job / next cycle.
        try {
          await runNamedJob(jobName, context);
          await saveState(context.config.__paths.stateFile, context.state);
        } catch (jobError) {
          const message = String(jobError?.stack || jobError?.message || jobError);
          console.error(`[daemon] job "${jobName}" failed (continuing): ${message}`);
          context.state.lastJobError = {
            job: jobName,
            message: String(jobError?.message || jobError),
            at: new Date().toISOString()
          };
          try {
            await saveState(context.config.__paths.stateFile, context.state);
          } catch (saveError) {
            console.error(`[daemon] could not persist state after job failure: ${saveError?.message || saveError}`);
          }
          try {
            await writeRuntimeStatus(context.config, context.state, {
              status: 'idle',
              lastError: `job ${jobName}: ${String(jobError?.message || jobError)}`
            });
          } catch {
            // best-effort status write; never let it crash the loop
          }
        }
      }

      await writeRuntimeStatus(context.config, context.state, {
        status: 'idle'
      });

      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  } catch (error) {
    await finalize('error', error);
    throw error;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
  }
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const dryRun = cli.dryRun || config.dryRun;
  const context = {
    config,
    state,
    dryRun
  };

  if (cli.command === 'doctor') {
    await runDoctor(config, state);
    return;
  }

  if (cli.command === 'once') {
    await runOnce(cli.target, context);
    await saveState(config.__paths.stateFile, state);
    return;
  }

  if (cli.command === 'daemon') {
    await runDaemon(context);
    return;
  }

  throw new Error(`Unknown command: ${cli.command}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});