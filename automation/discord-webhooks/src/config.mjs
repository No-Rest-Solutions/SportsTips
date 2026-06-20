import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ANALYSIS_ENGINES = new Set(['auto', 'openai', 'rules']);
const TEAM_SPORT_H2H_POLICIES = new Set(['balanced', 'fallback_only']);
const DEFAULT_SPORTS_GAME_ODDS_LEAGUE_IDS = {
  afl: 'AFL',
  nrl: 'NRL',
  mlb: 'MLB',
  nba: 'NBA',
  nhl: 'NHL',
  nfl: 'NFL',
  soccer_epl: 'EPL'
};

function getResolvedWorkspaceRoot() {
  return process.env.SPORTSTIPS_WORKSPACE_ROOT
    ? path.resolve(process.env.SPORTSTIPS_WORKSPACE_ROOT)
    : path.resolve(here, '../../../');
}

function resolveWorkspacePath(candidate) {
  if (!candidate) {
    return candidate;
  }

  return path.isAbsolute(candidate) ? candidate : path.join(getResolvedWorkspaceRoot(), candidate);
}

function assertTime(label, value) {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    throw new Error(`${label} must use HH:MM 24-hour format.`);
  }
}

function numberOrFallback(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePregameRecheckHours(value) {
  const normalized = (Array.isArray(value) ? value : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .sort((left, right) => right - left);

  return [...new Set(normalized)].length
    ? [...new Set(normalized)]
    : [3, 1];
}

function normalizeAnalysisEngine(value) {
  const normalized = String(value || 'auto').toLowerCase();
  return ANALYSIS_ENGINES.has(normalized) ? normalized : 'auto';
}

function normalizeTeamSportsH2hPolicy(value) {
  const normalized = String(value || 'balanced').toLowerCase();
  return TEAM_SPORT_H2H_POLICIES.has(normalized) ? normalized : 'balanced';
}

function sanitizeRoleMentionValue(value) {
  return String(value || '').trim();
}

function normalizeRoleMentions(source) {
  const roleMentions = source && typeof source === 'object' ? source : {};
  const legacyChannels = Array.isArray(roleMentions.channels) ? roleMentions.channels : [];
  const legacyText = sanitizeRoleMentionValue(roleMentions.text);
  const picks = roleMentions.picks && typeof roleMentions.picks === 'object' ? roleMentions.picks : {};

  return {
    enabled: Boolean(roleMentions.enabled),
    slates: sanitizeRoleMentionValue(roleMentions.slates || (legacyChannels.includes('slates') ? legacyText : '')),
    picks: {
      shared: sanitizeRoleMentionValue(picks.shared || (legacyChannels.includes('picks') ? legacyText : '')),
      nba: sanitizeRoleMentionValue(picks.nba),
      mlb: sanitizeRoleMentionValue(picks.mlb),
      afl: sanitizeRoleMentionValue(picks.afl),
      nrl: sanitizeRoleMentionValue(picks.nrl),
      nfl: sanitizeRoleMentionValue(picks.nfl),
      epl: sanitizeRoleMentionValue(picks.epl),
      other: sanitizeRoleMentionValue(picks.other)
    }
  };
}

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return '';
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

async function loadWorkspaceEnvFile() {
  const envPath = resolveWorkspacePath('automation/discord-webhooks/.env');

  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!key) {
        continue;
      }

      if (process.env[key]) {
        continue;
      }

      process.env[key] = parseEnvValue(trimmed.slice(separatorIndex + 1));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

export async function loadConfig(configPathArg) {
  await loadWorkspaceEnvFile();
  const { configPath, config } = await loadRawConfigFile(configPathArg);

  if (!config.timezone) {
    throw new Error('Config is missing timezone.');
  }

  if (!config.discord?.webhooks) {
    throw new Error('Config is missing discord.webhooks.');
  }

  if (!Array.isArray(config.sports)) {
    throw new Error('Config is missing sports array.');
  }

  const openAiEnv = config.openai?.apiKeyEnv || 'OPENAI_API_KEY';
  const sportsGameOddsSource = config.sportsGameOdds || {};
  const sportsGameOddsEnv = sportsGameOddsSource.apiKeyEnv || 'SPORTS_GAME_ODDS_API_KEY';
  const sportsGameOddsEnabled = Boolean(sportsGameOddsSource.enabled);
  const rawWebhooks = config.discord?.webhooks || {};
  const settlementWebhook = String(config.bankrollTracker?.settlementWebhook || 'unitTracking').trim() || 'unitTracking';
  const summaryWebhook = String(config.bankrollTracker?.summaryWebhook || 'unitReport').trim() || 'unitReport';

  config.discord = {
    username: config.discord?.username || 'SportsTips',
    avatarUrl: config.discord?.avatarUrl || '',
    webhooks: {
      slates: rawWebhooks.slates || '',
      picks: rawWebhooks.picks || '',
      picksNba: rawWebhooks.picksNba || '',
      picksMlb: rawWebhooks.picksMlb || '',
      picksAfl: rawWebhooks.picksAfl || '',
      picksNrl: rawWebhooks.picksNrl || '',
      picksNfl: rawWebhooks.picksNfl || '',
      picksEpl: rawWebhooks.picksEpl || '',
      picksOther: rawWebhooks.picksOther || '',
      referralsNew: rawWebhooks.referralsNew || '',
      referralsUpdatedTerms: rawWebhooks.referralsUpdatedTerms || '',
      referralsCancelled: rawWebhooks.referralsCancelled || '',
      referralsMasterlist: rawWebhooks.referralsMasterlist || '',
      results: rawWebhooks.results || '',
      unitTracking: rawWebhooks.unitTracking || rawWebhooks.results || '',
      unitReport: rawWebhooks.unitReport || '',
      mlbTracking: rawWebhooks.mlbTracking || '',
      mlbReport: rawWebhooks.mlbReport || '',
      promoAfl: rawWebhooks.promoAfl || '',
      promoNrl: rawWebhooks.promoNrl || '',
      promoTennis: rawWebhooks.promoTennis || '',
      promoSoccer: rawWebhooks.promoSoccer || '',
      evidence: rawWebhooks.evidence || ''
    },
    roleMentions: normalizeRoleMentions(config.discord?.roleMentions)
  };

  config.benchmarkFilters = {
    requireSupportData: Boolean(config.benchmarkFilters?.requireSupportData),
    significantSupportScore: numberOrFallback(config.benchmarkFilters?.significantSupportScore, 5),
    strongSupportScore: numberOrFallback(config.benchmarkFilters?.strongSupportScore, 8),
    minBooksAtOrAbove: numberOrFallback(config.benchmarkFilters?.minBooksAtOrAbove, 2)
  };

  config.sportsGameOdds = {
    enabled: sportsGameOddsEnabled,
    apiKeyEnv: sportsGameOddsEnv,
    apiKey: sportsGameOddsEnabled ? (process.env[sportsGameOddsEnv] || '') : '',
    maxMonthlyObjects: numberOrFallback(sportsGameOddsSource.maxMonthlyObjects, 2500),
    reserveObjects: numberOrFallback(sportsGameOddsSource.reserveObjects, 100),
    usageTtlMinutes: numberOrFallback(sportsGameOddsSource.usageTtlMinutes, 720),
    cacheTtlMinutes: numberOrFallback(sportsGameOddsSource.cacheTtlMinutes, 360),
    eventCacheTtlMinutes: numberOrFallback(sportsGameOddsSource.eventCacheTtlMinutes, 180),
    bookmakers: Array.isArray(sportsGameOddsSource.bookmakers) ? sportsGameOddsSource.bookmakers : [],
    useForPicksWhenSnapshotMissing: sportsGameOddsEnabled && sportsGameOddsSource.useForPicksWhenSnapshotMissing !== false,
    useForSlatesWhenScrapeMissing: sportsGameOddsEnabled && sportsGameOddsSource.useForSlatesWhenScrapeMissing !== false
  };

  config.openai = {
    enabled: config.openai?.enabled !== false,
    apiKeyEnv: openAiEnv,
    apiKey: process.env[openAiEnv] || '',
    baseUrl: config.openai?.baseUrl || 'https://api.openai.com/v1',
    model: config.openai?.model || 'gpt-5.4',
    reasoningEffort: config.openai?.reasoningEffort || 'medium',
    maxOutputTokens: numberOrFallback(config.openai?.maxOutputTokens, 5000),
    timeoutMs: numberOrFallback(config.openai?.timeoutMs, 90000),
    temperature: numberOrFallback(config.openai?.temperature, 0.2),
    promptCachePrefix: config.openai?.promptCachePrefix || 'sportstips-analysis'
  };

  config.bookmakerFallback = {
    enabled: config.bookmakerFallback?.enabled !== false,
    snapshotFile: config.bookmakerFallback?.snapshotFile || 'automation/discord-webhooks/bookmaker-snapshots.json',
    providers: Array.isArray(config.bookmakerFallback?.providers) && config.bookmakerFallback.providers.length
      ? config.bookmakerFallback.providers
      : ['tab', 'sportsbet', 'neds'],
    maxSnapshotAgeMinutes: numberOrFallback(config.bookmakerFallback?.maxSnapshotAgeMinutes, 180),
    preferSnapshot: config.bookmakerFallback?.preferSnapshot !== false
  };

  config.marketScrape = {
    enabled: config.marketScrape?.enabled !== false && config.bookmakerFallback.enabled !== false,
    snapshotFile: config.marketScrape?.snapshotFile || config.bookmakerFallback.snapshotFile,
    refreshIntervalMinutes: numberOrFallback(config.marketScrape?.refreshIntervalMinutes, 60),
    maxSnapshotAgeMinutes: numberOrFallback(config.marketScrape?.maxSnapshotAgeMinutes, config.bookmakerFallback.maxSnapshotAgeMinutes),
    bookmakerKey: config.marketScrape?.bookmakerKey || 'sportsbet-web',
    bookmakerTitle: config.marketScrape?.bookmakerTitle || 'Sportsbet Web'
  };

  // TAB market-menu preference. The menu is captured opportunistically (npm run capture:tab)
  // and the pick generator softly prefers markets TAB offers so tips stay placeable on TAB.
  config.tab = {
    enabled: config.tab?.enabled !== false,
    menuFile: config.tab?.menuFile || 'automation/discord-webhooks/tab-market-menu.json',
    jurisdiction: config.tab?.jurisdiction || 'NSW',
    edgePath: config.tab?.edgePath || ''
  };

  if (config.jobs?.slates?.enabled) {
    assertTime('jobs.slates.time', config.jobs.slates.time);
  }

  if (config.jobs?.analysis?.enabled) {
    assertTime('jobs.analysis.time', config.jobs.analysis.time);
  }

  if (config.jobs?.picks?.enabled) {
    assertTime('jobs.picks.time', config.jobs.picks.time);
  }

  if (config.jobs?.referrals?.enabled) {
    assertTime('jobs.referrals.time', config.jobs.referrals.time);
  }

  if (config.bankrollTracker?.enabled !== false && config.bankrollTracker?.summaryTime) {
    assertTime('bankrollTracker.summaryTime', config.bankrollTracker.summaryTime);
  }

  if (config.jobs?.tabMenu?.enabled && config.jobs?.tabMenu?.time) {
    assertTime('jobs.tabMenu.time', config.jobs.tabMenu.time);
  }

  config.referrals = {
    requestTimeoutMs: numberOrFallback(config.referrals?.requestTimeoutMs, 30000),
    catalogFile: config.referrals?.catalogFile || 'automation/discord-webhooks/referrals-catalog.json',
    historyFile: config.referrals?.historyFile || 'automation/discord-webhooks/referrals-history.json'
  };

  config.jobs = {
    ...config.jobs,
    analysis: {
      enabled: Boolean(config.jobs?.analysis?.enabled),
      time: config.jobs?.analysis?.time || '08:30',
      intervalMinutes: numberOrFallback(config.jobs?.analysis?.intervalMinutes, 180)
    },
    picks: {
      enabled: Boolean(config.jobs?.picks?.enabled),
      time: config.jobs?.picks?.time || '09:00',
      intervalMinutes: numberOrFallback(config.jobs?.picks?.intervalMinutes, 15),
      shortlistHours: numberOrFallback(config.jobs?.picks?.shortlistHours, 24),
      postWindowHours: numberOrFallback(config.jobs?.picks?.postWindowHours, 12),
      pregameRecheckHours: normalizePregameRecheckHours(config.jobs?.picks?.pregameRecheckHours),
      pregameRecheckMinutes: numberOrFallback(config.jobs?.picks?.pregameRecheckMinutes, 60),
      preWindowCheckMinutes: numberOrFallback(config.jobs?.picks?.preWindowCheckMinutes, 60),
      inWindowCheckMinutes: numberOrFallback(config.jobs?.picks?.inWindowCheckMinutes, 15),
      holdIfSupportRulesFail: config.jobs?.picks?.holdIfSupportRulesFail !== false,
      replacementCutoffMinutes: numberOrFallback(config.jobs?.picks?.replacementCutoffMinutes, 15)
    },
    referrals: {
      enabled: Boolean(config.jobs?.referrals?.enabled),
      time: config.jobs?.referrals?.time || '06:30',
      intervalMinutes: numberOrFallback(config.jobs?.referrals?.intervalMinutes, 360)
    },
    slates: config.jobs?.slates,
    results: {
      enabled: Boolean(config.jobs?.results?.enabled),
      intervalMinutes: numberOrFallback(config.jobs?.results?.intervalMinutes, 15),
      settlementSweepHours: numberOrFallback(config.jobs?.results?.settlementSweepHours, 3),
      // Consult broad public fallback result sources (e.g. TheSportsDB) when no
      // primary source matched. Off by default so tests never hit the network.
      fallbackSettlement: config.jobs?.results?.fallbackSettlement === true,
      // Refund (void) a player-prop leg when the player was a late scratch / DNP
      // or was pulled early (minimal minutes) rather than grading it a loss (#33).
      refundNonParticipants: config.jobs?.results?.refundNonParticipants === true
    },
    tabMenu: {
      enabled: config.jobs?.tabMenu?.enabled !== false && config.tab?.enabled !== false,
      time: config.jobs?.tabMenu?.time || '05:00'
    },
    promos: {
      enabled: Boolean(config.jobs?.promos?.enabled),
      generationTime: config.jobs?.promos?.generationTime || '09:30',
      settlementIntervalMinutes: numberOrFallback(config.jobs?.promos?.settlementIntervalMinutes, 30),
      reportTime: config.jobs?.promos?.reportTime || '23:30'
    }
  };

  config.bankrollTracker = {
    enabled: config.bankrollTracker?.enabled !== false,
    csvFile: resolveWorkspacePath(config.bankrollTracker?.csvFile || 'automation/discord-webhooks/bot-bankroll-tracker.csv'),
    startingBankrollUnits: numberOrFallback(config.bankrollTracker?.startingBankrollUnits, 10),
    unitSizeAud: numberOrFallback(config.bankrollTracker?.unitSizeAud, 10),
    settlementWebhook: settlementWebhook === 'results' ? 'unitTracking' : settlementWebhook,
    summaryTime: config.bankrollTracker?.summaryTime || '07:45',
    summaryWebhook: summaryWebhook === 'results' ? 'unitReport' : summaryWebhook,
    rollingWindowDays: numberOrFallback(config.bankrollTracker?.rollingWindowDays, 30),
    repeatLossThreshold: numberOrFallback(config.bankrollTracker?.repeatLossThreshold, 2),
    losingLegsReportFile: resolveWorkspacePath(config.bankrollTracker?.losingLegsReportFile || 'automation/discord-webhooks/bot-losing-legs-report.md'),
    // Separate, isolated ledger for MLB so its (hardest-to-beat, low-volume) results
    // never touch the main bankroll. Its own CSV, starting units and webhooks.
    mlb: {
      enabled: config.bankrollTracker?.mlb?.enabled !== false,
      csvFile: resolveWorkspacePath(config.bankrollTracker?.mlb?.csvFile || 'automation/discord-webhooks/bot-bankroll-tracker-mlb.csv'),
      startingBankrollUnits: numberOrFallback(config.bankrollTracker?.mlb?.startingBankrollUnits, 10),
      unitSizeAud: numberOrFallback(config.bankrollTracker?.mlb?.unitSizeAud ?? config.bankrollTracker?.unitSizeAud, 10),
      settlementWebhook: config.bankrollTracker?.mlb?.settlementWebhook || 'mlbTracking',
      summaryWebhook: config.bankrollTracker?.mlb?.summaryWebhook || 'mlbReport',
      losingLegsReportFile: resolveWorkspacePath(config.bankrollTracker?.mlb?.losingLegsReportFile || 'automation/discord-webhooks/bot-losing-legs-report-mlb.md')
    }
  };

  config.analysis = {
    enabled: config.analysis?.enabled !== false,
    engine: normalizeAnalysisEngine(config.analysis?.engine),
    lookaheadHours: numberOrFallback(config.analysis?.lookaheadHours, 36),
    maxEventsPerSport: numberOrFallback(config.analysis?.maxEventsPerSport, 8),
    minCandidateLegsPerEvent: numberOrFallback(config.analysis?.minCandidateLegsPerEvent, 3),
    maxCandidateLegsPerEvent: numberOrFallback(config.analysis?.maxCandidateLegsPerEvent, 14),
    maxPropMarketsPerEvent: numberOrFallback(config.analysis?.maxPropMarketsPerEvent, 10),
    maxPropMarketsPerType: numberOrFallback(config.analysis?.maxPropMarketsPerType, 2),
    includeProps: config.analysis?.includeProps !== false,
    featuredMarkets: Array.isArray(config.analysis?.featuredMarkets) && config.analysis.featuredMarkets.length
      ? config.analysis.featuredMarkets
      : ['h2h', 'spreads', 'totals'],
    propMarketPrefixes: Array.isArray(config.analysis?.propMarketPrefixes) && config.analysis.propMarketPrefixes.length
      ? config.analysis.propMarketPrefixes
      : ['player_', 'batter_', 'pitcher_'],
    propMarketKeywords: Array.isArray(config.analysis?.propMarketKeywords) && config.analysis.propMarketKeywords.length
      ? config.analysis.propMarketKeywords
      : ['points', 'rebounds', 'assists', 'threes', 'disposals', 'shots_on_goal', 'goals', 'hits', 'total_bases', 'strikeouts', 'rushing', 'receiving', 'passing'],
    propMarketPriority: Array.isArray(config.analysis?.propMarketPriority) && config.analysis.propMarketPriority.length
      ? config.analysis.propMarketPriority
      : [
        'batter_hits',
        'pitcher_strikeouts',
        'batter_total_bases',
        'player_points_rebounds_assists',
        'player_points_assists',
        'player_points_rebounds',
        'player_rebounds_assists',
        'player_points',
        'player_rebounds',
        'player_assists',
        'player_threes',
        'player_disposals',
        'player_shots_on_goal',
        'player_goals',
        'player_pass_yds',
        'player_pass_tds',
        'player_rush_yds',
        'player_reception_yds'
      ],
    generator: {
      minBooks: numberOrFallback(config.analysis?.generator?.minBooks, 1),
      stakeUnits: numberOrFallback(config.analysis?.generator?.stakeUnits, 1),
      maxStakeUnits: Math.min(2, numberOrFallback(config.analysis?.generator?.maxStakeUnits, 2)),
      teamSportsH2hPolicy: normalizeTeamSportsH2hPolicy(config.analysis?.generator?.teamSportsH2hPolicy)
    },
    // Deep per-leg analysis (rules-layer research evidence). When enabled, every
    // candidate leg is graded against real form/matchup data and, when
    // requireLegEvidence is on, only evidence-"supported" legs survive — so the
    // engine posts researched slips or NO BET. See docs/DEEP-ANALYSIS.md.
    deepAnalysis: {
      enabled: Boolean(config.analysis?.deepAnalysis?.enabled),
      requireLegEvidence: config.analysis?.deepAnalysis?.requireLegEvidence !== false,
      recentGames: numberOrFallback(config.analysis?.deepAnalysis?.recentGames, 5),
      minGames: numberOrFallback(config.analysis?.deepAnalysis?.minGames, 4),
      minHitRate: numberOrFallback(config.analysis?.deepAnalysis?.minHitRate, 0.6)
    },
    // Cross-game multis: combine evidence-supported legs from DIFFERENT games into
    // one multi (e.g. 3 teams' total corners). Off by default. Each leg is graded
    // against its own game at settlement. See cross-game-multis.mjs.
    crossGameMultis: {
      enabled: Boolean(config.analysis?.crossGameMultis?.enabled),
      legCount: numberOrFallback(config.analysis?.crossGameMultis?.legCount, 3),
      minOdds: numberOrFallback(config.analysis?.crossGameMultis?.minOdds, 2.0),
      maxOdds: numberOrFallback(config.analysis?.crossGameMultis?.maxOdds, 3.0),
      maxPicksPerSport: numberOrFallback(config.analysis?.crossGameMultis?.maxPicksPerSport, 1),
      stakeUnits: numberOrFallback(config.analysis?.crossGameMultis?.stakeUnits, 1)
    }
  };

  config.sports = config.sports.map((sport) => ({
    ...sport,
    marketKey: sport.marketKey || sport.key,
    marketPageUrl: sport.marketPageUrl || sport.marketScrape?.marketPageUrl || '',
    eventPathPrefix: sport.eventPathPrefix || sport.marketScrape?.eventPathPrefix || '',
    sportsGameOddsLeagueId: sport.sportsGameOddsLeagueId || DEFAULT_SPORTS_GAME_ODDS_LEAGUE_IDS[sport.key] || ''
  }));

  config.__paths = {
    workspaceRoot: getResolvedWorkspaceRoot(),
    configPath,
    picksFeedFile: resolveWorkspacePath(config.picksFeedFile || 'automation/discord-webhooks/picks-feed.json'),
    stateFile: resolveWorkspacePath(config.stateFile || 'automation/discord-webhooks/state.json'),
    snapshotFile: resolveWorkspacePath(config.marketScrape.snapshotFile),
    tabMarketMenuFile: resolveWorkspacePath(config.tab?.menuFile || 'automation/discord-webhooks/tab-market-menu.json'),
    runtimeStatusFile: resolveWorkspacePath(config.runtimeStatusFile || 'automation/discord-webhooks/runtime-status.json'),
    profitTrackerFile: resolveWorkspacePath(config.profitTrackerFile || config.weeklyProfitTrackerFile || '30-day-profit-tracker.md'),
    weeklyProfitTrackerFile: resolveWorkspacePath(config.profitTrackerFile || config.weeklyProfitTrackerFile || '30-day-profit-tracker.md'),
    bankrollTrackerFile: resolveWorkspacePath(config.bankrollTracker?.csvFile || 'automation/discord-webhooks/bot-bankroll-tracker.csv'),
    losingLegsReportFile: resolveWorkspacePath(config.bankrollTracker?.losingLegsReportFile || 'automation/discord-webhooks/bot-losing-legs-report.md'),
    evidenceLogFile: resolveWorkspacePath(config.evidenceLogFile || 'automation/discord-webhooks/bot-evidence-log.csv'),
    referralsCatalogFile: resolveWorkspacePath(config.referrals.catalogFile),
    referralsHistoryFile: resolveWorkspacePath(config.referrals.historyFile)
  };

  return config;
}

export async function loadRawConfigFile(configPathArg) {
  const configPath = resolveWorkspacePath(configPathArg || 'automation/discord-webhooks/config.json');
  const raw = await fs.readFile(configPath, 'utf8');
  return {
    configPath,
    config: JSON.parse(raw)
  };
}

export async function saveRawConfigFile(configPathArg, nextConfig) {
  const configPath = resolveWorkspacePath(configPathArg || 'automation/discord-webhooks/config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  return configPath;
}