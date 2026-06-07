import {
  analyzeEventWithRules,
  buildAnalysisCandidatePool,
  buildPickFromAnalysisDecision
} from '../ai-pick-generator.mjs';
import {
  appendCancellationTrackerEntries,
  appendPostedTrackerEntries,
  appendReplacementTrackerEntries,
  readBankrollTrackerRows
} from '../bot-tracker.mjs';
import { evaluatePickAgainstBenchmarks } from '../benchmarks.mjs';
import { buildAutomatedMessage, deleteWebhookMessage, sendWebhookMessage } from '../discord.mjs';
import { formatCancellationPickMessages, formatPicksMessages, formatReplacementPickMessages, formatUnitTrackingMessages } from '../formatters.mjs';
import {
  buildEventWeatherDisplay,
  enrichEventWithEspnMetadata,
  filterCandidatePoolForResearch,
  loadNrlOfficialWeatherDisplay
} from './analysis.mjs';
import { resolveOddsValidation } from '../odds-validation.mjs';
import { loadPicksFeed } from '../picks-feed.mjs';
import { mergeQuoteEntries } from '../pick-generator.mjs';
import { fetchEspnSlate } from '../providers/espn.mjs';
import { fetchEspnTeamInjuries } from '../providers/espn-injuries.mjs';
import { buildOpenMeteoEventWeatherSnapshot, fetchOpenMeteoForecast, geocodeOpenMeteoLocation } from '../providers/open-meteo.mjs';
import { generateReplacementOptionsFromTemplate } from '../replacement-generator.mjs';
import { getDateKey } from '../scheduler.mjs';
import { buildSnapshotEvents, ensureFreshScrapedSnapshot } from '../web-market-intake.mjs';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const REPLACEMENT_STATUSES = new Set(['leg_cancelled', 'leg_canceled', 'leg_refunded', 'replacement_needed']);
const PLAYER_PROP_MARKET_PREFIXES = ['player_', 'batter_', 'pitcher_'];
const AVAILABLE_INJURY_STATUSES = new Set(['available', 'active', 'probable']);
const OUTDOOR_WEATHER_RECHECK_SPORTS = new Set(['afl', 'mlb', 'nfl', 'nrl', 'soccer_epl', 'soccer_uefa_champs_league']);
const CLOSED_ROOF_MARKERS = ['closed', 'dome', 'indoor'];
const SEVERE_WEATHER_CODES = new Set([95, 96, 99]);
const WET_WEATHER_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 85, 86]);
const NON_ACTIONABLE_EVENT_STATUS_MARKERS = ['postponed', 'cancelled', 'canceled'];
const DEFAULT_PREGAME_RECHECK_HOURS = [3, 1];
const RETURN_RISK_NOTE_MARKERS = [
  'restricted',
  'restriction',
  'managed',
  'monitor',
  'minutes restriction',
  'pitch count',
  'snap count',
  'workload',
  'expected to return',
  'targeting return',
  'return tomorrow',
  'game time decision'
];
const SAFE_GENERATED_TOTAL_ODDS_SOFT_MAX = 3.25;
const SAFE_GENERATED_TOTAL_ODDS_HARD_MAX = 5;
const MLB_STRUCTURE_PROFILE_LEGACY = 'mlb-hit-led-v1';
const MLB_STRUCTURE_PROFILE_HIT_PRIORITY = 'mlb-hit-priority-v2';
const SPORT_PICK_WEBHOOK_CHANNELS = new Map([
  ['nba', 'picksNba'],
  ['mlb', 'picksMlb'],
  ['afl', 'picksAfl'],
  ['nrl', 'picksNrl'],
  ['nfl', 'picksNfl'],
  ['soccer_epl', 'picksEpl']
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeSportKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function cloneSerializable(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function isGeneratedPick(pick) {
  return /generator/.test(String(pick?.source || ''));
}

function isUnsupportedGeneratedLegText(value) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return false;
  }

  return /\b(head to head|winning margin|margin|race(?: to)?|same game|team total|total match points|exact points?)\b/.test(normalized)
    || /\bdouble\b/.test(normalized)
    || /\b(home|away|[1-4](st|nd|rd|th)) team\b/.test(normalized);
}

function isTeamLikeLegDescription(pick, description) {
  const normalized = normalizeText(description);

  if (!normalized) {
    return true;
  }

  if (/^(head|draw|yes|no|over|under)$/i.test(String(description || '').trim())) {
    return true;
  }

  if (/\b(home|away|[1-4](st|nd|rd|th)) team\b/.test(normalized)) {
    return true;
  }

  const teamNames = new Set([
    pick?.homeTeam,
    pick?.awayTeam
  ].map((teamName) => normalizeText(teamName)).filter(Boolean));

  return teamNames.has(normalized);
}

function validateGeneratedLegSource(pick, leg) {
  const source = leg?.source;

  if (!isPlayerPropMarket(source?.market)) {
    return [];
  }

  const reasons = [];

  if (isTeamLikeLegDescription(pick, source?.description)) {
    reasons.push('player prop source uses a team or placeholder description');
  }

  if ([leg?.label, source?.outcomeName, source?.description].some((value) => isUnsupportedGeneratedLegText(value))) {
    reasons.push('player prop maps to an unsupported combo or team market');
  }

  if (toNumber(source?.point) === null && /^(Over|Under)$/i.test(String(source?.outcomeName || '').trim())) {
    reasons.push('player prop over/under leg is missing its threshold');
  }

  return reasons;
}

function isUnsupportedRacePointsLeg(leg) {
  const normalized = normalizeText([
    leg?.label,
    leg?.source?.market,
    leg?.source?.outcomeName,
    leg?.source?.point
  ].filter((value) => value !== undefined && value !== null && String(value).trim()).join(' '));

  return /\brace(?:\s+to)?\b/.test(normalized) && /\bpoints?\b/.test(normalized);
}

function getAflDisposalLine(leg) {
  const text = String(leg?.label || leg?.source?.outcomeName || '').trim();
  const match = text.match(/(\d+)\s*\+\s*disposals?/i);

  if (!match) {
    return null;
  }

  const line = Number(match[1]);
  return Number.isFinite(line) ? line : null;
}

function isAllowedAflDisposalLeg(leg) {
  const line = getAflDisposalLine(leg);
  return line !== null && line >= 10 && (line - 10) % 5 === 0;
}

function hasMalformedGeneratedLegs(pick) {
  return Array.isArray(pick?.legs)
    && pick.legs.some((leg) => validateGeneratedLegSource(pick, leg).length > 0
      || (normalizeText(pick?.sport) === 'afl' && isAflDisposalLeg(leg) && !isAllowedAflDisposalLeg(leg)));
}

function requiresFreshReplacementRebuild(pick) {
  return isGeneratedPick(pick) && normalizeText(pick?.sport) === 'nrl';
}

function prefersFreshReplacementRebuild(pick) {
  return requiresFreshReplacementRebuild(pick)
    || (isGeneratedPick(pick) && normalizeText(pick?.sport) === 'afl');
}

function getConfiguredSport(config, sportKey) {
  return (config.sports || []).find((sport) => {
    const normalizedSportKey = normalizeText(sportKey);
    return normalizeText(sport?.key) === normalizedSportKey || normalizeText(sport?.marketKey) === normalizedSportKey;
  }) || null;
}

function isOtherSportWebhookBucket(sportKey) {
  if (!sportKey) {
    return false;
  }

  return sportKey === 'nhl'
    || sportKey.startsWith('tennis')
    || (sportKey.startsWith('soccer') && sportKey !== 'soccer_epl');
}

export function resolvePickWebhookChannel(config, pick) {
  const sportKey = normalizeSportKey(pick?.sport);
  const configuredWebhooks = config.discord?.webhooks || {};
  const preferredChannel = SPORT_PICK_WEBHOOK_CHANNELS.get(sportKey);

  if (preferredChannel && configuredWebhooks[preferredChannel]) {
    return preferredChannel;
  }

  if (isOtherSportWebhookBucket(sportKey) && configuredWebhooks.picksOther) {
    return 'picksOther';
  }

  return 'picks';
}

function resolveTrackedPickMessageWebhookChannel(trackedPick) {
  const explicitChannel = String(trackedPick?.postedWebhookChannel || '').trim();

  if (explicitChannel) {
    return explicitChannel;
  }

  if (trackedPick?.postedMessageId || trackedPick?.postedAt || trackedPick?.replacementPostedAt) {
    return 'picks';
  }

  return '';
}

function resolveTrackedPickNotificationWebhookChannel(config, trackedPick, pick = null) {
  const messageChannel = resolveTrackedPickMessageWebhookChannel(trackedPick);

  if (messageChannel) {
    const explicitChannel = String(trackedPick?.postedWebhookChannel || '').trim();

    if (explicitChannel) {
      return explicitChannel;
    }
  }

  return resolvePickWebhookChannel(config, pick);
}

function getWebhookUrlByChannel(config, channel) {
  return config.discord?.webhooks?.[channel] || config.discord?.webhooks?.picks || '';
}

function buildTeamPairKey(teamOne, teamTwo) {
  return [normalizeText(teamOne), normalizeText(teamTwo)]
    .filter(Boolean)
    .sort()
    .join('::');
}

function getMinimumCandidateLegsForSport(config, sportKey) {
  const configuredMinimum = Number(config.analysis?.minCandidateLegsPerEvent || 3);
  const normalizedSportKey = normalizeText(sportKey);

  if (normalizedSportKey === 'nrl') {
    return Math.min(configuredMinimum, 3);
  }

  if (normalizedSportKey.startsWith('tennis')) {
    return Math.min(configuredMinimum, 1);
  }

  if (normalizedSportKey === 'afl' || normalizedSportKey.startsWith('soccer')) {
    return Math.min(configuredMinimum, 2);
  }

  return configuredMinimum;
}

function findMatchingSnapshotEvent(snapshotEvents, pick) {
  const normalizedEventName = normalizeText(pick?.event || `${pick?.awayTeam || ''} vs ${pick?.homeTeam || ''}`);
  const pickTeamPair = buildTeamPairKey(pick?.homeTeam, pick?.awayTeam);

  return snapshotEvents.find((event) => {
    const eventName = normalizeText(event?.displayName || `${event?.away_team || ''} vs ${event?.home_team || ''}`);
    const eventTeamPair = buildTeamPairKey(event?.home_team, event?.away_team);
    return eventName === normalizedEventName || eventTeamPair === pickTeamPair;
  }) || null;
}

function buildTrackerRowMaps(rows) {
  const latestByPickId = new Map();
  const lastPostedByPickId = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.pick_id) {
      continue;
    }

    latestByPickId.set(row.pick_id, row);

    if (row.transaction_type === 'post' || row.transaction_type === 'replacement') {
      lastPostedByPickId.set(row.pick_id, row);
    }
  }

  const openByPickId = new Map(
    [...latestByPickId.entries()].filter(([, row]) => row.transaction_type === 'post' || row.transaction_type === 'replacement')
  );

  return {
    latestByPickId,
    lastPostedByPickId,
    openByPickId
  };
}

function hydratePostedPickStateFromTracker(state, trackerRowMaps) {
  state.posts ??= {};
  state.posts.picks ??= {};

  for (const [pickId, row] of trackerRowMaps.openByPickId.entries()) {
    if (!state.posts.picks[pickId]) {
      state.posts.picks[pickId] = row.timestamp || new Date().toISOString();
    }
  }
}

async function buildFreshSnapshotReplacementOptions(context, pick, now, overrides = {}) {
  if (!isGeneratedPick(pick)) {
    return [];
  }

  const sport = getConfiguredSport(context.config, pick?.sport);

  if (!sport) {
    return [];
  }

  const loadSnapshot = overrides.ensureFreshScrapedSnapshot || ensureFreshScrapedSnapshot;
  const snapshot = overrides.replacementSnapshot || await loadSnapshot(context, now, { force: true });
  const analysisConfig = context.config.analysis || {};
  const effectiveConfig = {
    ...context.config,
    analysis: {
      ...analysisConfig,
      lookaheadHours: Number(analysisConfig.lookaheadHours || 36),
      maxEventsPerSport: Number(analysisConfig.maxEventsPerSport || 8),
      maxCandidateLegsPerEvent: Number(analysisConfig.maxCandidateLegsPerEvent || 14),
      minCandidateLegsPerEvent: Number(analysisConfig.minCandidateLegsPerEvent || 3),
      generator: {
        stakeUnits: Number(analysisConfig.generator?.stakeUnits || 1),
        maxStakeUnits: Number(analysisConfig.generator?.maxStakeUnits || 5),
        minBooks: Number(analysisConfig.generator?.minBooks || 1),
        teamSportsH2hPolicy: analysisConfig.generator?.teamSportsH2hPolicy || 'fallback_only'
      }
    }
  };

  if (!snapshot?.quotes?.length) {
    return [];
  }

  const snapshotEvents = buildSnapshotEvents(snapshot, effectiveConfig, sport, now);
  const matchedEvent = findMatchingSnapshotEvent(snapshotEvents, pick);

  if (!matchedEvent) {
    return [];
  }

  const mergedQuotes = mergeQuoteEntries(Array.isArray(matchedEvent.snapshotQuotes) ? matchedEvent.snapshotQuotes : []);
  const scoreboardCache = overrides.scoreboardCache instanceof Map ? overrides.scoreboardCache : new Map();
  const researchCaches = overrides.researchCaches && typeof overrides.researchCaches === 'object'
    ? overrides.researchCaches
    : {
        injury: new Map(),
        weather: new Map(),
        mlb: new Map(),
        mlbSupport: new Map(),
        afl: new Map(),
        aflTeamDirectory: new Map(),
        aflRoster: new Map(),
        aflPlayer: new Map(),
        aflProfile: new Map()
      };
  const enrichedMatchedEvent = await enrichEventWithEspnMetadata(effectiveConfig, sport, matchedEvent, scoreboardCache, overrides);
  const eventContext = {
    sportKey: sport.key,
    sportLabel: sport.label,
    marketSportKey: sport.marketKey || sport.key,
    eventId: enrichedMatchedEvent.id,
    espnEventId: enrichedMatchedEvent.espnEventId || '',
    eventName: enrichedMatchedEvent.displayName || `${enrichedMatchedEvent.away_team} vs ${enrichedMatchedEvent.home_team}`,
    homeTeam: enrichedMatchedEvent.home_team,
    homeTeamId: enrichedMatchedEvent.homeTeamId || '',
    awayTeam: enrichedMatchedEvent.away_team,
    awayTeamId: enrichedMatchedEvent.awayTeamId || '',
    startTime: enrichedMatchedEvent.commence_time,
    venue: enrichedMatchedEvent.venue || null,
    weather: pick.weather || null,
    ...(normalizeText(sport.key) === 'mlb' ? { mlbStructureProfile: getMlbStructureProfile(pick) } : {}),
    generatorConfig: effectiveConfig.analysis.generator
  };
  const candidatePool = buildAnalysisCandidatePool(
    eventContext,
    mergedQuotes,
    Number(effectiveConfig.analysis.maxCandidateLegsPerEvent || 14)
  );

  if (candidatePool.length < getMinimumCandidateLegsForSport(effectiveConfig, sport.key)) {
    return [];
  }

  const researchedCandidatePool = await filterCandidatePoolForResearch(
    sport,
    eventContext,
    candidatePool,
    researchCaches,
    overrides
  );

  if (researchedCandidatePool.length < getMinimumCandidateLegsForSport(effectiveConfig, sport.key)) {
    return [];
  }

  const decision = await analyzeEventWithRules(context, eventContext, researchedCandidatePool, {
    availableUnits: toNumber(pick?.stakeUnits)
  });
  const replacementPick = buildPickFromAnalysisDecision(eventContext, researchedCandidatePool, decision);

  if (!replacementPick || normalizeText(replacementPick.summary) === normalizeText(pick?.summary)) {
    return [];
  }

  return [{
    variantId: 'fresh-snapshot-rebuild',
    eventId: replacementPick.eventId,
    espnEventId: replacementPick.espnEventId,
    event: replacementPick.event,
    homeTeam: replacementPick.homeTeam,
    homeTeamId: replacementPick.homeTeamId,
    awayTeam: replacementPick.awayTeam,
    awayTeamId: replacementPick.awayTeamId,
    venue: replacementPick.venue,
    weather: replacementPick.weather || pick.weather || null,
    startTime: replacementPick.startTime,
    summary: replacementPick.summary,
    rationale: replacementPick.rationale,
    replacementReason: 'Rebuilt from the latest same-event market snapshot.',
    betType: replacementPick.betType,
    modelProbability: replacementPick.modelProbability,
    supportScore: replacementPick.supportScore,
    confidenceTier: replacementPick.confidenceTier,
    supportProjection: replacementPick.supportProjection,
    dataConfidence: replacementPick.dataConfidence,
    correlationRisk: replacementPick.correlationRisk,
    correlationJustified: replacementPick.correlationJustified,
    exceptionalSupport: replacementPick.exceptionalSupport,
    strongSupport: replacementPick.strongSupport,
    stakeUnits: replacementPick.stakeUnits,
    source: replacementPick.source,
    analysisEngine: replacementPick.analysisEngine,
    mlbStructureProfile: replacementPick.mlbStructureProfile,
    analysisChecklist: replacementPick.analysisChecklist,
    analysisNotes: replacementPick.analysisNotes,
    legs: replacementPick.legs,
    replacementTemplate: replacementPick.replacementTemplate
  }];
}

function ensurePickTracking(state) {
  state.tracking ??= {};
  state.tracking.picks ??= {};
  return state.tracking.picks;
}

export const __testables = {
  buildFreshSnapshotReplacementOptions
};

function getStartTimeMs(pick) {
  const parsed = pick.startTime ? new Date(pick.startTime).getTime() : null;
  return Number.isFinite(parsed) ? parsed : null;
}

function isWithinShortlistWindow(pick, now, config) {
  const startTimeMs = getStartTimeMs(pick);

  if (startTimeMs === null) {
    return true;
  }

  const diffMs = startTimeMs - now.getTime();
  return diffMs >= 0 && diffMs <= Number(config.jobs.picks.shortlistHours || 24) * HOUR_MS;
}

function getTimeUntilStartMs(pick, now) {
  const startTimeMs = getStartTimeMs(pick);
  return startTimeMs === null ? null : startTimeMs - now.getTime();
}

function getReplacementCandidateId(basePick, option, index) {
  return option.id || option.variantId || `${basePick.id}::replacement::${index + 1}`;
}

function hasPostedPick(state, pickId) {
  return Boolean(state.posts?.picks?.[pickId]);
}

function needsReplacement(pick, state) {
  return hasPostedPick(state, pick.id) && REPLACEMENT_STATUSES.has(String(pick.replacementStatus || '').toLowerCase());
}

function isBeforeReplacementCutoff(pick, now, config) {
  const diffMs = getTimeUntilStartMs(pick, now);

  if (diffMs === null) {
    return true;
  }

  return diffMs >= Number(config.jobs.picks.replacementCutoffMinutes || 15) * MINUTE_MS;
}

function buildReplacementCandidate(basePick, option, index) {
  return {
    ...basePick,
    ...option,
    id: basePick.id,
    candidateId: getReplacementCandidateId(basePick, option, index),
    originalSummary: basePick.summary,
    replacementReason: option.replacementReason || basePick.replacementReason || basePick.replacementStatus,
    eventId: option.eventId || basePick.eventId,
    espnEventId: option.espnEventId || basePick.espnEventId,
    event: option.event || basePick.event,
    homeTeam: option.homeTeam || basePick.homeTeam,
    homeTeamId: option.homeTeamId || basePick.homeTeamId,
    awayTeam: option.awayTeam || basePick.awayTeam,
    awayTeamId: option.awayTeamId || basePick.awayTeamId,
    venue: option.venue || basePick.venue || null,
    weather: option.weather || basePick.weather || null,
    startTime: option.startTime || basePick.startTime,
    sport: option.sport || basePick.sport,
    sportLabel: option.sportLabel || basePick.sportLabel,
    stakeUnits: option.stakeUnits ?? basePick.stakeUnits,
    source: option.source || basePick.source
  };
}

function isWithinPostingWindow(pick, now, config) {
  const diffMs = getTimeUntilStartMs(pick, now);

  if (diffMs === null) {
    return true;
  }

  return diffMs >= 0 && diffMs <= Number(config.jobs.picks.postWindowHours || 4) * HOUR_MS;
}

function isBeforeStartTime(pick, now) {
  const diffMs = getTimeUntilStartMs(pick, now);
  return diffMs === null || diffMs >= 0;
}

function shouldUseImmediateGeneratedPosting(pick, overrides = {}) {
  return Boolean(overrides.forcePostNow);
}

function getPregameRecheckHours(config) {
  const configured = Array.isArray(config.jobs?.picks?.pregameRecheckHours)
    ? config.jobs.picks.pregameRecheckHours
    : [];
  const normalized = configured
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => right - left);

  return normalized.length ? [...new Set(normalized)] : DEFAULT_PREGAME_RECHECK_HOURS;
}

function getNextPregameRecheckAt(pick, now, config) {
  const startTimeMs = getStartTimeMs(pick);

  if (startTimeMs === null) {
    return null;
  }

  const diffMs = startTimeMs - now.getTime();
  const nextCheckpointHours = getPregameRecheckHours(config).find((hours) => diffMs > hours * HOUR_MS);

  if (!nextCheckpointHours) {
    return null;
  }

  return new Date(startTimeMs - nextCheckpointHours * HOUR_MS).toISOString();
}

function shouldSchedulePregameRecheck(pick, now, config) {
  return isGeneratedPick(pick) && Boolean(getNextPregameRecheckAt(pick, now, config));
}

function findSportConfig(config, sportKey) {
  return (config.sports || []).find((sport) => sport.key === sportKey || sport.marketKey === sportKey) || null;
}

function getEffectivePickTeams(pick) {
  if (pick?.homeTeam && pick?.awayTeam) {
    return {
      homeTeam: pick.homeTeam,
      awayTeam: pick.awayTeam
    };
  }

  const event = String(pick?.event || '');
  const parts = event.split(/\s+vs\s+/iu);

  if (parts.length === 2) {
    return {
      awayTeam: parts[0].trim(),
      homeTeam: parts[1].trim()
    };
  }

  return {
    homeTeam: '',
    awayTeam: ''
  };
}

function getScoreboardEventKey(homeTeam, awayTeam) {
  return `${normalizeText(homeTeam)}::${normalizeText(awayTeam)}`;
}

function getPickEventId(pick) {
  const explicitEspnEventId = String(pick?.espnEventId || '').trim();

  if (explicitEspnEventId) {
    return explicitEspnEventId;
  }

  const explicitEventId = String(pick?.eventId || '').trim();

  if (explicitEventId && !explicitEventId.startsWith('snapshot:')) {
    return explicitEventId;
  }

  const parts = String(pick?.id || '').trim().split(':');
  return parts.length >= 3 && /generator/iu.test(parts[0]) ? parts[2] : '';
}

async function resolveEspnEventForPick(context, pick, overrides = {}) {
  const sport = findSportConfig(context.config, pick?.sport);

  if (!sport || sport.provider !== 'espn' || !sport.path) {
    return {
      status: 'unsupported_sport',
      sport: null,
      event: null
    };
  }

  const fetchScoreboard = overrides.fetchEspnSlate || fetchEspnSlate;
  const dateKeys = [];

  if (pick?.startTime) {
    dateKeys.push(getDateKey(new Date(pick.startTime), context.config.timezone));
  }

  const currentDateKey = getDateKey(new Date(), context.config.timezone);

  if (!dateKeys.includes(currentDateKey)) {
    dateKeys.push(currentDateKey);
  }

  const eventId = getPickEventId(pick);
  const { homeTeam, awayTeam } = getEffectivePickTeams(pick);
  const eventKey = getScoreboardEventKey(homeTeam, awayTeam);

  for (const dateKey of dateKeys) {
    const slate = await fetchScoreboard(sport, dateKey);
    const events = Array.isArray(slate?.events) ? slate.events : [];
    const event = events.find((item) => {
      if (eventId && String(item?.id || '') === eventId) {
        return true;
      }

      return getScoreboardEventKey(item?.homeTeam, item?.awayTeam) === eventKey;
    });

    if (event) {
      return {
        status: 'ok',
        sport,
        event
      };
    }
  }

  return {
    status: 'event_not_found',
    sport,
    event: null
  };
}

function buildLateEventStatusReason(event) {
  const shortStatus = String(event?.shortStatus || '').trim();
  const normalizedShortStatus = normalizeText(shortStatus);

  if (!normalizedShortStatus) {
    return '';
  }

  if (NON_ACTIONABLE_EVENT_STATUS_MARKERS.some((marker) => normalizedShortStatus.includes(marker))) {
    return `event is ${shortStatus} on the ESPN scoreboard`;
  }

  return '';
}

function validateLateEventStatus(resolvedEvent) {
  if (!resolvedEvent) {
    return {
      status: 'not_applicable',
      reasons: []
    };
  }

  if (resolvedEvent.status !== 'ok') {
    return {
      status: resolvedEvent.status,
      reasons: []
    };
  }

  const reason = buildLateEventStatusReason(resolvedEvent.event);

  return {
    status: reason ? 'event_not_actionable' : 'ok',
    reasons: reason ? [reason] : []
  };
}

function isPlayerPropMarket(market) {
  return PLAYER_PROP_MARKET_PREFIXES.some((prefix) => String(market || '').toLowerCase().startsWith(prefix));
}

function getPlayerPropTargets(pick) {
  const seen = new Set();
  const targets = [];

  for (const leg of Array.isArray(pick?.legs) ? pick.legs : []) {
    if (!isPlayerPropMarket(leg?.source?.market)) {
      continue;
    }

    const playerName = String(leg?.source?.description || '').trim();
    const normalizedPlayerName = normalizeText(playerName);

    if (!normalizedPlayerName || seen.has(normalizedPlayerName)) {
      continue;
    }

    seen.add(normalizedPlayerName);
    targets.push({
      playerName,
      normalizedPlayerName,
      label: String(leg?.label || '').trim() || playerName
    });
  }

  return targets;
}

function isUnavailableInjuryStatus(status) {
  const normalizedStatus = normalizeText(status);
  return Boolean(normalizedStatus) && !AVAILABLE_INJURY_STATUSES.has(normalizedStatus);
}

function findInjuryMatch(teamReports, target) {
  for (const report of teamReports) {
    for (const injury of Array.isArray(report?.injuries) ? report.injuries : []) {
      if (normalizeText(injury?.playerName) === target.normalizedPlayerName) {
        return injury;
      }
    }
  }

  return null;
}

function hasReturnRiskInjuryNote(note) {
  const normalizedNote = normalizeText(note);

  if (!normalizedNote) {
    return false;
  }

  return RETURN_RISK_NOTE_MARKERS.some((marker) => normalizedNote.includes(marker));
}

function shouldRejectInjuryEntry(pick, injury) {
  if (!injury) {
    return false;
  }

  if (String(pick?.sport || '').toLowerCase() === 'afl') {
    return true;
  }

  if (isUnavailableInjuryStatus(injury.status)) {
    return true;
  }

  return hasReturnRiskInjuryNote(injury.note);
}

function buildInjuryAvailabilityReason(pick, target, injury) {
  const note = String(injury?.note || '').trim();

  if (String(pick?.sport || '').toLowerCase() === 'afl' && !isUnavailableInjuryStatus(injury?.status)) {
    return `${target.playerName} is still listed on the ESPN injuries page${note ? ` (${note})` : ''}`;
  }

  if (!isUnavailableInjuryStatus(injury?.status) && hasReturnRiskInjuryNote(note)) {
    return `${target.playerName} still carries a return-risk injury note${note ? ` (${note})` : ''} on the ESPN injuries page`;
  }

  return `${target.playerName} is ${injury.status}${note ? ` (${note})` : ''} on the ESPN injuries page`;
}

async function validateLatePlayerAvailability(context, pick, overrides = {}) {
  const playerTargets = getPlayerPropTargets(pick);

  if (!playerTargets.length) {
    return {
      status: 'not_applicable',
      reasons: []
    };
  }

  let resolvedEvent = overrides.resolvedEspnEvent;

  if (!resolvedEvent) {
    try {
      resolvedEvent = await resolveEspnEventForPick(context, pick, overrides);
    } catch (error) {
      console.warn(`[picks] late availability lookup failed for ${pick.id}: ${error.message}`);
      return {
        status: 'lookup_error',
        reasons: []
      };
    }
  }

  if (resolvedEvent.status !== 'ok' || !resolvedEvent.event?.homeTeamId || !resolvedEvent.event?.awayTeamId) {
    return {
      status: resolvedEvent.status,
      reasons: []
    };
  }

  const fetchTeamInjuries = overrides.fetchEspnTeamInjuries || fetchEspnTeamInjuries;
  let teamReports;

  try {
    teamReports = await Promise.all([
      fetchTeamInjuries(resolvedEvent.sport, resolvedEvent.event.homeTeamId),
      fetchTeamInjuries(resolvedEvent.sport, resolvedEvent.event.awayTeamId)
    ]);
  } catch (error) {
    console.warn(`[picks] injury recheck failed for ${pick.id}: ${error.message}`);
    return {
      status: 'injury_fetch_error',
      reasons: []
    };
  }

  const reasons = [];

  for (const target of playerTargets) {
    const injury = findInjuryMatch(teamReports, target);

    if (!shouldRejectInjuryEntry(pick, injury)) {
      continue;
    }

    reasons.push(buildInjuryAvailabilityReason(pick, target, injury));
  }

  return {
    status: reasons.length ? 'player_unavailable' : 'ok',
    reasons
  };
}

function isOutdoorWeatherEligibleEvent(pick, event) {
  const venue = event?.venue || pick?.venue || null;

  if (!OUTDOOR_WEATHER_RECHECK_SPORTS.has(String(pick?.sport || '').toLowerCase())) {
    return false;
  }

  const roofType = normalizeText(venue?.roofType);

  if (venue?.indoor === true) {
    return false;
  }

  return !CLOSED_ROOF_MARKERS.some((marker) => roofType.includes(marker));
}

function buildVenueLookupQuery(event, pick) {
  const venue = event?.venue || pick?.venue || null;

  return [
    venue?.name,
    venue?.city,
    venue?.state,
    venue?.country
  ].filter(Boolean).join(', ');
}

function buildDirectWeatherLocation(event, pick) {
  const venue = event?.venue || pick?.venue || null;
  const latitude = toNumber(venue?.latitude);
  const longitude = toNumber(venue?.longitude);

  if (latitude === null || longitude === null) {
    return null;
  }

  return {
    latitude,
    longitude,
    name: String(venue?.name || '').trim()
  };
}

function buildWeatherRiskParts(snapshot) {
  const parts = [];

  if (SEVERE_WEATHER_CODES.has(Number(snapshot?.weatherCode))) {
    parts.push(`weather code ${snapshot.weatherCode}`);
  }

  if ((Number(snapshot?.precipitationProbability) || 0) >= 75 && (Number(snapshot?.precipitationMm) || 0) >= 1.5) {
    parts.push(`${snapshot.precipitationProbability}% precipitation probability with ${snapshot.precipitationMm}mm forecast precipitation`);
  }

  if ((Number(snapshot?.windGustsKmh) || 0) >= 60) {
    parts.push(`${snapshot.windGustsKmh} km/h wind gusts`);
  }

  return parts;
}

function pickHasNrlPlayerPointsLeg(pick) {
  return normalizeText(pick?.sport) === 'nrl'
    && Array.isArray(pick?.legs)
    && pick.legs.some((leg) => normalizeSportKey(leg?.source?.market) === 'player_points');
}

function buildWetFieldPlayerPointsRiskParts(pick, snapshot) {
  if (!pickHasNrlPlayerPointsLeg(pick)) {
    return [];
  }

  const precipitationProbability = Number(snapshot?.precipitationProbability) || 0;
  const precipitationMm = Number(snapshot?.precipitationMm) || 0;
  const weatherCode = Number(snapshot?.weatherCode);
  const hasWetCode = WET_WEATHER_CODES.has(weatherCode);

  if (!hasWetCode && precipitationProbability < 60 && precipitationMm < 0.75) {
    return [];
  }

  const parts = [];

  if (hasWetCode) {
    parts.push(`weather code ${weatherCode}`);
  }

  if (precipitationProbability >= 40) {
    parts.push(`${precipitationProbability}% precipitation probability`);
  }

  if (precipitationMm >= 0.5) {
    parts.push(`${precipitationMm}mm forecast precipitation`);
  }

  const triggersWetFieldRisk = parts.length >= 2 || (hasWetCode && precipitationProbability >= 55) || precipitationMm >= 1;
  return triggersWetFieldRisk ? parts : [];
}

async function validateLateWeatherConditions(context, pick, overrides = {}) {
  const existingWeather = pick?.weather || null;

  if (!overrides.lateContextRecheck) {
    return {
      status: 'skipped',
      reasons: [],
      weather: existingWeather
    };
  }

  let resolvedEvent = overrides.resolvedEspnEvent;

  if (!resolvedEvent) {
    try {
      resolvedEvent = await resolveEspnEventForPick(context, pick, overrides);
    } catch (error) {
      console.warn(`[picks] late weather lookup failed for ${pick.id}: ${error.message}`);
      return {
        status: 'lookup_error',
        reasons: [],
        weather: existingWeather
      };
    }
  }

  if (resolvedEvent.status !== 'ok' || !isOutdoorWeatherEligibleEvent(pick, resolvedEvent.event)) {
    return {
      status: resolvedEvent.status === 'ok' ? 'not_applicable' : resolvedEvent.status,
      reasons: [],
      weather: existingWeather
    };
  }

  const weatherCache = overrides.weatherCache instanceof Map ? overrides.weatherCache : new Map();
  const sport = Array.isArray(context?.config?.sports)
    ? context.config.sports.find((item) => normalizeText(item?.key) === normalizeText(pick?.sport)) || null
    : null;
  const weatherEventContext = {
    sportKey: pick?.sport,
    startTime: resolvedEvent.event?.startTime || pick?.startTime || null,
    homeTeam: resolvedEvent.event?.homeTeam || pick?.homeTeam || null,
    awayTeam: resolvedEvent.event?.awayTeam || pick?.awayTeam || null
  };
  const officialDisplay = await loadNrlOfficialWeatherDisplay(sport, weatherEventContext, weatherCache, overrides);
  const fallbackWeather = buildEventWeatherDisplay({ officialDisplay }) || existingWeather;

  const directLocation = buildDirectWeatherLocation(resolvedEvent.event, pick);
  const venueQuery = buildVenueLookupQuery(resolvedEvent.event, pick);

  if (!directLocation && !venueQuery) {
    return {
      status: 'venue_missing',
      reasons: [],
      weather: fallbackWeather
    };
  }

  const geocodeLocation = overrides.geocodeOpenMeteoLocation || geocodeOpenMeteoLocation;
  const fetchForecast = overrides.fetchOpenMeteoForecast || fetchOpenMeteoForecast;
  let location = directLocation;

  if (!location) {
    let locations;

    try {
      locations = await geocodeLocation(venueQuery, {
        count: 1,
        language: 'en'
      });
    } catch (error) {
      console.warn(`[picks] weather geocode failed for ${pick.id}: ${error.message}`);
      return {
        status: 'geocode_error',
        reasons: [],
        weather: fallbackWeather
      };
    }

    if (!Array.isArray(locations) || !locations.length) {
      return {
        status: 'location_not_found',
        reasons: [],
        weather: fallbackWeather
      };
    }

    [location] = locations;
  }

  let forecastResponse;

  try {
    forecastResponse = await fetchForecast(location, {
      timezone: 'auto'
    });
  } catch (error) {
    console.warn(`[picks] weather forecast failed for ${pick.id}: ${error.message}`);
    return {
      status: 'forecast_error',
      reasons: [],
      weather: fallbackWeather
    };
  }

  const snapshot = buildOpenMeteoEventWeatherSnapshot(forecastResponse?.forecast, pick?.startTime);
  const weather = buildEventWeatherDisplay({ snapshot, officialDisplay }) || fallbackWeather;
  const riskParts = buildWeatherRiskParts(snapshot);
  const wetFieldPlayerPointsRiskParts = buildWetFieldPlayerPointsRiskParts(pick, snapshot);

  const venueName = resolvedEvent.event?.venue?.name || pick?.venue?.name || `${resolvedEvent.event?.awayTeam} vs ${resolvedEvent.event?.homeTeam}`;

  if (!riskParts.length && !wetFieldPlayerPointsRiskParts.length) {
    return {
      status: 'ok',
      reasons: [],
      weather
    };
  }

  if (riskParts.length) {
    return {
      status: 'severe_weather',
      reasons: [`Open-Meteo flags severe outdoor weather risk at ${venueName}: ${riskParts.join(', ')}`],
      weather
    };
  }

  return {
    status: 'wet_field_player_points',
    reasons: [`Open-Meteo flags wet-field risk that is too fragile for NRL player-points legs at ${venueName}: ${wetFieldPlayerPointsRiskParts.join(', ')}`],
    weather
  };
}

function getCheckIntervalMs(pick, now, config) {
  const diffMs = getTimeUntilStartMs(pick, now);

  if (diffMs === null) {
    return Number(config.jobs.picks.inWindowCheckMinutes || 15) * MINUTE_MS;
  }

  if (diffMs <= Number(config.jobs.picks.postWindowHours || 4) * HOUR_MS) {
    return Number(config.jobs.picks.inWindowCheckMinutes || 15) * MINUTE_MS;
  }

  return Number(config.jobs.picks.preWindowCheckMinutes || 60) * MINUTE_MS;
}

function shouldCheckPick(trackedPick, now) {
  if (!trackedPick?.nextCheckAt) {
    return true;
  }

  return new Date(trackedPick.nextCheckAt).getTime() <= now.getTime();
}

function getPickDateKey(pick, fallbackDateKey, timeZone) {
  if (!pick?.startTime) {
    return fallbackDateKey;
  }

  return getDateKey(new Date(pick.startTime), timeZone);
}

function getPublishedPick(pick, trackedPick) {
  if (!trackedPick?.activeReplacement) {
    return {
      ...pick,
      benchmark: trackedPick?.benchmark ?? pick?.benchmark,
      publicationValidation: trackedPick?.publicationValidation ?? pick?.publicationValidation,
      totalOdds: trackedPick?.totalOdds ?? pick?.totalOdds,
      priceDecimal: trackedPick?.priceDecimal ?? pick?.priceDecimal
    };
  }

  return {
    ...pick,
    ...trackedPick.activeReplacement,
    id: pick.id,
    status: pick.status,
    settledAt: pick.settledAt,
    returnUnits: pick.returnUnits,
    netUnits: pick.netUnits,
    closingOdds: pick.closingOdds,
    resultNotes: pick.resultNotes
  };
}

function buildImmediateCancellationSettlementPick(item, trackerRow) {
  const pick = item?.pick || item;
  const stakeUnits = toNumber(trackerRow?.stake_units) ?? toNumber(item?.stakeUnits ?? pick?.stakeUnits) ?? 0;
  const returnUnits = toNumber(trackerRow?.return_units) ?? stakeUnits;
  const netUnits = toNumber(trackerRow?.net_units) ?? 0;

  return {
    ...pick,
    status: 'return',
    settledAt: trackerRow?.timestamp || new Date().toISOString(),
    stakeUnits,
    returnUnits,
    netUnits,
    stakeAud: toNumber(trackerRow?.stake_aud),
    returnAud: toNumber(trackerRow?.return_aud),
    netAud: toNumber(trackerRow?.net_aud),
    totalUnits: toNumber(trackerRow?.units_remaining),
    totalAud: toNumber(trackerRow?.units_remaining_aud),
    totalSettledStakeUnits: toNumber(trackerRow?.total_settled_stake_units),
    totalSettledStakeAud: toNumber(trackerRow?.total_settled_stake_aud),
    priceDecimal: toNumber(trackerRow?.price_decimal)
      ?? toNumber(pick?.priceDecimal)
      ?? toNumber(pick?.publicationValidation?.totalOdds)
      ?? null,
    resultNotes: `Refunded after a pregame cancellation. ${String(item?.reason || 'Cancelled after the late pregame recheck failed.').trim()}`
  };
}

async function sendCancellationSettlementMessages(config, cancellations, trackerRows, dateKey, dryRun) {
  if (!Array.isArray(cancellations) || !cancellations.length || !Array.isArray(trackerRows) || !trackerRows.length) {
    return;
  }

  const configuredWebhook = String(config.bankrollTracker?.settlementWebhook || 'unitTracking').trim() || 'unitTracking';
  const settlementWebhook = configuredWebhook === 'results' ? 'unitTracking' : configuredWebhook;
  const settlementWebhookUrl = config.discord?.webhooks?.[settlementWebhook] || config.discord?.webhooks?.results;

  if (!settlementWebhookUrl) {
    return;
  }

  const trackerRowByPickId = new Map(trackerRows.map((row) => [String(row?.pick_id || ''), row]));
  const refundPicks = cancellations
    .map((item) => buildImmediateCancellationSettlementPick(item, trackerRowByPickId.get(String(item?.pick?.id || '')) || null));

  const messages = formatUnitTrackingMessages(refundPicks, dateKey);

  for (const message of messages) {
    const automatedMessage = buildAutomatedMessage(config, settlementWebhook, message);

    await sendWebhookMessage(
      settlementWebhookUrl,
      {
        content: automatedMessage.content,
        embeds: automatedMessage.embeds,
        username: config.discord.username,
        avatar_url: config.discord.avatarUrl || undefined,
        allowed_mentions: automatedMessage.allowedMentions
      },
      {
        dryRun,
        label: 'unit tracking refund'
      }
    );
  }
}

async function deleteTrackedPickMessage(config, trackedPick, dryRun, pickId) {
  const messageId = String(trackedPick?.postedMessageId || '').trim();

  if (!messageId) {
    return false;
  }

  const webhookChannel = resolveTrackedPickMessageWebhookChannel(trackedPick) || 'picks';
  const webhookUrl = getWebhookUrlByChannel(config, webhookChannel);

  try {
    await deleteWebhookMessage(webhookUrl, messageId, {
      dryRun,
      label: `delete pick message ${pickId || ''}`.trim()
    });
    return true;
  } catch (error) {
    console.warn(`[picks] failed to delete previous Discord message for ${pickId || 'pick'}: ${error.message}`);
    return false;
  }
}

function validateBasicPublicationFields(pick) {
  const reasons = [];

  if (!String(pick?.id || '').trim()) {
    reasons.push('pick id is missing');
  }

  if (!String(pick?.sport || '').trim()) {
    reasons.push('sport is missing');
  }

  if (!String(pick?.event || '').trim()) {
    reasons.push('event is missing');
  }

  if (!String(pick?.summary || '').trim()) {
    reasons.push('summary is missing');
  }

  const stakeUnits = toNumber(pick?.stakeUnits);

  if (stakeUnits === null || stakeUnits <= 0) {
    reasons.push('stake units must be a positive number');
  }

  if (pick?.startTime && getStartTimeMs(pick) === null) {
    reasons.push('start time is invalid');
  }

  return reasons;
}

function validateLegPublication(pick) {
  const reasons = [];
  const legPublicationValidations = [];
  const legs = Array.isArray(pick?.legs) ? pick.legs : [];
  const summaryText = normalizeText(pick?.summary);
  const betType = String(pick?.betType || '').toLowerCase();
  const seenLabels = new Set();

  if (!legs.length) {
    if (isGeneratedPick(pick)) {
      reasons.push('generated pick has no structured legs');
    }

    return {
      reasons,
      legPublicationValidations
    };
  }

  if (betType === 'single' && legs.length !== 1) {
    reasons.push('single pick must contain exactly one leg');
  }

  if (betType === 'sgm' && legs.length < 2) {
    reasons.push('same-game multi must contain at least two legs');
  }

  for (const [index, leg] of legs.entries()) {
    const legReasons = [];
    const label = String(leg?.label || '').trim();
    const normalizedLabel = normalizeText(label);
    const status = String(leg?.status || 'active').toLowerCase();

    if (!label) {
      legReasons.push('missing leg label');
    }

    if (normalizedLabel) {
      if (seenLabels.has(normalizedLabel)) {
        legReasons.push('duplicate leg label');
      }

      seenLabels.add(normalizedLabel);

      if (summaryText && !summaryText.includes(normalizedLabel)) {
        legReasons.push('leg label is not reflected in the slip summary');
      }
    }

    if (status !== 'active') {
      legReasons.push(`leg status is ${status}`);
    }

    if (isGeneratedPick(pick) && !String(leg?.rationale || '').trim()) {
      legReasons.push('missing leg rationale');
    }

    if (isGeneratedPick(pick)) {
      legReasons.push(...validateGeneratedLegSource(pick, leg));

      if (isUnsupportedRacePointsLeg(leg)) {
        legReasons.push('generated leg uses an unsupported race-to-points market');
      }

      if (normalizeText(pick?.sport) === 'afl' && isAflDisposalLeg(leg) && !isAllowedAflDisposalLeg(leg)) {
        legReasons.push('AFL disposal legs must use 10+ / 15+ / 20+ style rungs only');
      }
    }

    legPublicationValidations.push({
      legId: String(leg?.id || `leg-${index + 1}`),
      label: label || `Leg ${index + 1}`,
      status: legReasons.length ? 'fail' : 'pass',
      reasons: legReasons
    });
  }

  if (legPublicationValidations.some((item) => item.status === 'fail')) {
    reasons.push('one or more legs failed publication validation');
  }

  return {
    reasons,
    legPublicationValidations
  };
}

function validateAnalysisChecklist(pick) {
  if (!pick?.analysisChecklist || typeof pick.analysisChecklist !== 'object') {
    return [];
  }

  const failingItems = Object.entries(pick.analysisChecklist)
    .filter(([, value]) => String(value || '').toLowerCase() === 'fail')
    .map(([key]) => key);

  return failingItems.length
    ? [`analysis checklist still fails: ${failingItems.join(', ')}`]
    : [];
}

function buildLegOddsCheck(pick, leg, config) {
  const source = leg?.source;

  if (!source?.market || !pick?.sport || !pick?.homeTeam || !pick?.awayTeam) {
    return null;
  }

  return {
    sportKey: pick.sport,
    market: source.market,
    homeTeam: pick.homeTeam,
    awayTeam: pick.awayTeam,
    outcomeName: source.outcomeName || '',
    description: source.description || '',
    point: source.point ?? null,
    startTime: pick.startTime || null,
    minimumOdds: 1.01,
    minimumBooksAtOrAbove: 0,
    bookmakers: Array.isArray(config.sportsGameOdds?.bookmakers) ? config.sportsGameOdds.bookmakers : []
  };
}

function shouldHoldForOddsStatus(status) {
  return new Set(['snapshot_stale', 'budget_guard', 'error', 'usage_error']).has(String(status || '').toLowerCase());
}

function isAflDisposalLeg(leg) {
  return /\bdisposals?\b/.test(normalizeText(leg?.label || leg?.source?.outcomeName || ''));
}

function isAflGoalLeg(leg) {
  return /\bgoals?\b/.test(normalizeText(leg?.label || leg?.source?.outcomeName || ''));
}

function isSpreadLeg(leg) {
  return /\b(spreads?|handicap)\b/.test(normalizeText(leg?.source?.market || leg?.label || ''));
}

function isH2hLeg(leg) {
  return normalizeText(leg?.source?.market) === 'h2h' || /\bh2h\b|head to head/.test(normalizeText(leg?.label || ''));
}

function isTotalLeg(leg) {
  return /\btotals?\b/.test(normalizeText(leg?.source?.market || '')) || /^(1st half\s+)?(over|under)\b/.test(normalizeText(leg?.label || ''));
}

function isFirstHalfTotalLeg(leg) {
  return normalizeText(leg?.source?.market) === 'first_half_totals' || /^1st half\s+(over|under)\b/.test(normalizeText(leg?.label || ''));
}

function isFullGameTotalLeg(leg) {
  return normalizeText(leg?.source?.market) === 'totals';
}

function isFirstHalfSpreadLeg(leg) {
  return normalizeText(leg?.source?.market) === 'first_half_spreads' || /^1st half\b/.test(normalizeText(leg?.label || '')) && isSpreadLeg(leg);
}

function isFullGameSpreadLeg(leg) {
  return isSpreadLeg(leg) && !isFirstHalfSpreadLeg(leg);
}

function getLegNumericPoint(leg) {
  const point = toNumber(leg?.source?.point);

  if (point !== null) {
    return point;
  }

  const match = String(leg?.label || '').match(/([+-]\d+(?:\.\d+)?)/);

  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function isPositiveNrlSpreadLeg(leg) {
  if (!isSpreadLeg(leg)) {
    return false;
  }
  const point = getLegNumericPoint(leg);
  const label = normalizeText(leg?.label || leg?.source?.outcomeName);
  // Stricter check: must have a numeric point > 0 AND no negative symbols in the string
  return point !== null && point > 0 && !label.includes('-') && !label.includes('minus');
}

function getNrlLegMarketKey(leg) {
  if (isH2hLeg(leg)) {
    return 'h2h';
  }

  if (normalizeText(leg?.source?.market) === 'player points') {
    return 'player_points';
  }

  if (isFirstHalfTotalLeg(leg)) {
    return 'first_half_total';
  }

  if (isFullGameTotalLeg(leg)) {
    return 'total';
  }

  if (isFirstHalfSpreadLeg(leg)) {
    return 'first_half_spread';
  }

  if (isFullGameSpreadLeg(leg)) {
    return 'spread';
  }

  return '';
}

function getMlbLegSubtype(leg) {
  const normalizedMarket = normalizeText(leg?.source?.market);

  if (/\b(hits?\s*runs?\s*rbi|hits\+runs\+rbi|hits runs rbi)\b/.test(normalizeText([
    leg?.label,
    leg?.source?.outcomeName,
    leg?.source?.description
  ].filter((value) => value !== undefined && value !== null).join(' ')))) {
    return 'hrr';
  }

  if (/\btotal bases?\b/.test(normalizeText([
    leg?.label,
    leg?.source?.outcomeName,
    leg?.source?.description
  ].filter((value) => value !== undefined && value !== null).join(' ')))) {
    return 'total_bases';
  }

  if (normalizedMarket === 'batter_hits') {
    return 'hit';
  }

  if (normalizedMarket === 'pitcher_strikeouts') {
    return 'strikeout';
  }

  if (normalizedMarket === 'batter_rbis' || normalizedMarket === 'batter_rbi') {
    return 'rbi';
  }

  const text = normalizeText([
    leg?.label,
    leg?.source?.outcomeName,
    leg?.source?.description
  ].filter((value) => value !== undefined && value !== null).join(' '));

  if (/\b1\+\s+hit\b|\bhits?\b/.test(text)) {
    return 'hit';
  }

  if (/\bstrikeouts?\b/.test(text)) {
    return 'strikeout';
  }

  if (/\brbis?\b|\bruns\s+batted\s+in\b/.test(text)) {
    return 'rbi';
  }

  return null;
}

function getMlbStructureProfile(pick) {
  const explicitProfile = String(pick?.mlbStructureProfile || '').trim();

  if (explicitProfile) {
    return explicitProfile;
  }

  return normalizeText(pick?.sport) === 'mlb' ? MLB_STRUCTURE_PROFILE_LEGACY : '';
}

function getGeneratedLegProfile(pick) {
  const legs = Array.isArray(pick?.legs) ? pick.legs : [];

  return {
    legCount: legs.length,
    totalCount: legs.filter((leg) => isTotalLeg(leg)).length,
    fullGameTotalCount: legs.filter((leg) => isFullGameTotalLeg(leg)).length,
    h2hCount: legs.filter((leg) => isH2hLeg(leg)).length,
    spreadCount: legs.filter((leg) => isSpreadLeg(leg)).length,
    firstHalfTotalCount: legs.filter((leg) => isFirstHalfTotalLeg(leg)).length,
    firstHalfSpreadCount: legs.filter((leg) => isFirstHalfSpreadLeg(leg)).length,
    fullGameSpreadCount: legs.filter((leg) => isFullGameSpreadLeg(leg)).length,
    invalidNrlSpreadCount: legs.filter((leg) => isSpreadLeg(leg) && !isPositiveNrlSpreadLeg(leg)).length,
    aflDisposalsCount: legs.filter((leg) => isAflDisposalLeg(leg)).length,
    aflGoalCount: legs.filter((leg) => isAflGoalLeg(leg)).length,
    mlbHitCount: legs.filter((leg) => getMlbLegSubtype(leg) === 'hit').length,
    mlbStrikeoutCount: legs.filter((leg) => getMlbLegSubtype(leg) === 'strikeout').length,
    mlbRbiCount: legs.filter((leg) => getMlbLegSubtype(leg) === 'rbi').length,
    mlbHrrCount: legs.filter((leg) => getMlbLegSubtype(leg) === 'hrr').length,
    mlbTotalBasesCount: legs.filter((leg) => getMlbLegSubtype(leg) === 'total_bases').length,
    mlbFullGameTotalCount: legs.filter((leg) => isFullGameTotalLeg(leg)).length
  };
}

function getNrlGeneratedLegProfile(pick, legProfile = getGeneratedLegProfile(pick)) {
  const legs = Array.isArray(pick?.legs) ? pick.legs : [];
  const safeMarketKeys = legs.map((leg) => getNrlLegMarketKey(leg)).filter(Boolean);

  return {
    ...legProfile,
    playerPointsCount: safeMarketKeys.filter((marketKey) => marketKey === 'player_points').length,
    uniqueSafeMarketCount: new Set(safeMarketKeys.filter((marketKey) => marketKey !== 'h2h')).size,
    unsupportedLegCount: legProfile.legCount - safeMarketKeys.length
  };
}

function hasSameTeamMlbHitPair(pick) {
  const mlbHitTeamKeys = Array.isArray(pick?.legs)
    ? pick.legs
      .filter((leg) => getMlbLegSubtype(leg) === 'hit')
      .map((leg) => normalizeText(leg?.source?.teamSide || leg?.source?.teamName || ''))
      .filter(Boolean)
    : [];

  return mlbHitTeamKeys.length > 1 && new Set(mlbHitTeamKeys).size !== mlbHitTeamKeys.length;
}

function getMlbLegTeamKey(leg) {
  return normalizeText(leg?.source?.teamSide || leg?.source?.teamName || '');
}

function isSupportedCurrentMlbProfileBuild(pick, legProfile = getGeneratedLegProfile(pick)) {
  const supportedMlbPropCount = legProfile.mlbHitCount + legProfile.mlbStrikeoutCount;
  const unsupportedMlbLegCount = legProfile.legCount - supportedMlbPropCount;

  return getMlbStructureProfile(pick) === MLB_STRUCTURE_PROFILE_HIT_PRIORITY
    && legProfile.legCount >= 2 && legProfile.legCount <= 5
    && legProfile.h2hCount === 0
    && legProfile.spreadCount === 0
    && legProfile.totalCount === 0
    && legProfile.mlbRbiCount === 0
    && legProfile.mlbHrrCount === 0
    && legProfile.mlbTotalBasesCount === 0
    && unsupportedMlbLegCount === 0
    && (
      (legProfile.mlbHitCount === 2 && legProfile.mlbStrikeoutCount === 0 && !hasSameTeamMlbHitPair(pick))
      || (
        legProfile.mlbHitCount === 1
        && legProfile.mlbStrikeoutCount === 1
        && (() => {
          const hitLeg = Array.isArray(pick?.legs) ? pick.legs.find((leg) => getMlbLegSubtype(leg) === 'hit') : null;
          const strikeoutLeg = Array.isArray(pick?.legs) ? pick.legs.find((leg) => getMlbLegSubtype(leg) === 'strikeout') : null;
          const hitTeamKey = getMlbLegTeamKey(hitLeg);
          const strikeoutTeamKey = getMlbLegTeamKey(strikeoutLeg);

          return Boolean(hitTeamKey) && Boolean(strikeoutTeamKey) && hitTeamKey === strikeoutTeamKey;
        })()
      )
    );
}

function isCleanNrlTwoLegFallbackBuild(pick, legProfile = getGeneratedLegProfile(pick)) {
  const sportKey = normalizeText(pick?.sport);
  const nrlProfile = getNrlGeneratedLegProfile(pick, legProfile);

  if (sportKey !== 'nrl'
    || nrlProfile.legCount !== 2
    || nrlProfile.unsupportedLegCount > 0
    || nrlProfile.invalidNrlSpreadCount > 0) {
    return false;
  }

  if (nrlProfile.h2hCount === 1) {
    return nrlProfile.totalCount === 1
      && nrlProfile.spreadCount === 0
      && nrlProfile.playerPointsCount === 0
      && nrlProfile.uniqueSafeMarketCount === 1;
  }

  return nrlProfile.h2hCount === 0
    && nrlProfile.uniqueSafeMarketCount === 2
    && (
      (nrlProfile.totalCount === 1 && nrlProfile.spreadCount === 1 && nrlProfile.playerPointsCount === 0)
      || (nrlProfile.totalCount === 1 && nrlProfile.spreadCount === 0 && nrlProfile.playerPointsCount === 1)
      || (nrlProfile.totalCount === 0 && nrlProfile.spreadCount === 1 && nrlProfile.playerPointsCount === 1)
    );
}

function isSupportedNrlGeneratedBuild(pick, legProfile = getGeneratedLegProfile(pick)) {
  const sportKey = normalizeText(pick?.sport);
  const nrlProfile = getNrlGeneratedLegProfile(pick, legProfile);

  if (sportKey !== 'nrl'
    || nrlProfile.unsupportedLegCount > 0
    || nrlProfile.invalidNrlSpreadCount > 0
    || nrlProfile.firstHalfTotalCount > 1
    || nrlProfile.fullGameTotalCount > 1
    || nrlProfile.firstHalfSpreadCount > 1
    || nrlProfile.fullGameSpreadCount > 1
    || nrlProfile.h2hCount > 1
    || nrlProfile.playerPointsCount > 1) {
    return false;
  }

  if (nrlProfile.legCount === 2) {
    return isCleanNrlTwoLegFallbackBuild(pick, legProfile);
  }

  return nrlProfile.legCount === 3
    && nrlProfile.h2hCount === 0
    && nrlProfile.totalCount >= 1
    && nrlProfile.spreadCount >= 1
    && nrlProfile.uniqueSafeMarketCount === 3;
}

function supportsSportSpecificGeneratedOdds(pick, totalOdds, legProfile = getGeneratedLegProfile(pick)) {
  const numericTotalOdds = toNumber(totalOdds);
  const sportKey = normalizeText(pick?.sport);

  if (numericTotalOdds === null) {
    return false;
  }

  if (sportKey === 'mlb' && isSupportedCurrentMlbProfileBuild(pick, legProfile)) {
    return true;
  }

  if (sportKey === 'nrl' && isCleanNrlTwoLegFallbackBuild(pick, legProfile) && numericTotalOdds <= 3.5) {
    return true;
  }

  return false;
}

function supportsSportSpecificGeneratedHighOdds(pick, totalOdds, legProfile = getGeneratedLegProfile(pick)) {
  return false;
}

function supportsExtendedGeneratedOdds(pick) {
  const supportScore = toNumber(pick?.supportScore) || 0;
  const confidenceTier = String(pick?.confidenceTier || '').toLowerCase();
  const supportProjection = String(pick?.supportProjection || '').toLowerCase();
  const dataConfidence = String(pick?.dataConfidence || '').toLowerCase();
  const correlationRisk = String(pick?.correlationRisk || '').toLowerCase();

  return supportScore >= 7.5
    && (confidenceTier === 'high' || confidenceTier === 'extreme')
    && supportProjection === 'strong'
    && dataConfidence !== 'low'
    && correlationRisk === 'low'
    && (Boolean(pick?.strongSupport) || Boolean(pick?.exceptionalSupport));
}

function validateGeneratedTotalOddsProfile(pick, totalOdds) {
  const numericTotalOdds = toNumber(totalOdds);
  const legProfile = getGeneratedLegProfile(pick);
  const supportsSportSpecificOdds = supportsSportSpecificGeneratedOdds(pick, numericTotalOdds, legProfile);
  const sportKey = normalizeText(pick?.sport);

  if (!isGeneratedPick(pick) || numericTotalOdds === null) {
    return [];
  }

  if (sportKey === 'afl') {
    if (legProfile.legCount < 2 || legProfile.legCount > 3 || legProfile.totalCount > 0 || legProfile.h2hCount > 0 || legProfile.spreadCount > 0 || legProfile.aflDisposalsCount < 2 || legProfile.aflGoalCount > 1) {
      return ['generated AFL slips must stay in the safer 2-3 leg disposal-led structure with no totals, H2H, or line fillers'];
    }

    const aflCeiling = supportsExtendedGeneratedOdds(pick) ? 4.00 : SAFE_GENERATED_TOTAL_ODDS_SOFT_MAX;

    if (numericTotalOdds > aflCeiling) {
      return [`validated total odds x${numericTotalOdds.toFixed(2)} exceed the safer AFL ceiling (x${aflCeiling.toFixed(2)}) for generated picks`];
    }
  }

  if (sportKey === 'mlb') {
    const mlbStructureProfile = getMlbStructureProfile(pick);

    if (mlbStructureProfile === MLB_STRUCTURE_PROFILE_LEGACY) {
      const supportedMlbPropCount = legProfile.mlbHitCount + legProfile.mlbStrikeoutCount;

      if (legProfile.legCount < 2
        || legProfile.legCount > 3
        || legProfile.totalCount > 0
        || legProfile.h2hCount > 0
        || legProfile.spreadCount > 0
        || legProfile.mlbHitCount < 2
        || legProfile.mlbRbiCount > 0
        || legProfile.mlbHrrCount > 0
        || legProfile.mlbTotalBasesCount > 0
        || supportedMlbPropCount !== legProfile.legCount) {
        return ['generated MLB slips must stay hit-led with at least two batter hit props, no totals/H2H/line fillers, and only a soft strikeout leg as the optional third piece'];
      }

      return [];
    }

    const hasMlbSideMarket = legProfile.totalCount > 0 || legProfile.spreadCount > 0;
    const supportScore = toNumber(pick?.supportScore) || 0;

    if (!isSupportedCurrentMlbProfileBuild(pick, legProfile) && (!hasMlbSideMarket || supportScore < 8.5)) {
      return ['generated MLB slips must stay in 2-5 leg hit-only or hit-plus-strikeout builds; side markets (totals/lines) are only permitted with exceptionally high support (>8.5)'];
    }
  }

  if (sportKey === 'nrl' && !isSupportedNrlGeneratedBuild(pick, legProfile)) {
    return ['generated NRL slips must stay in the clean 2-3 leg total-and-plus-line structure, with H2H only as a 2-leg totals fallback and no negative line legs'];
  }

  if (numericTotalOdds > SAFE_GENERATED_TOTAL_ODDS_HARD_MAX && !supportsSportSpecificGeneratedHighOdds(pick, numericTotalOdds, legProfile)) {
    return [`validated total odds x${numericTotalOdds.toFixed(2)} exceed the safe-value ceiling for generated picks`];
  }

  if (numericTotalOdds > SAFE_GENERATED_TOTAL_ODDS_SOFT_MAX && !supportsExtendedGeneratedOdds(pick) && !supportsSportSpecificOdds) {
    return [`validated total odds x${numericTotalOdds.toFixed(2)} sit above the safe target range without enough support to justify the stretch`];
  }

  return [];
}

function validateNrlIndividualLegPricing(pick, matchedLegPrices) {
  if (normalizeText(pick?.sport) !== 'nrl') return [];
  
  const overpricedLegs = pick.legs.filter(leg => {
    const isPrimary = isTotalLeg(leg) || isSpreadLeg(leg);
    if (!isPrimary) return false;
    const price = matchedLegPrices.find(p => p.legId === leg.id)?.bestOdds;
    return price > 1.90;
  });

  return overpricedLegs.length > 0 
    ? [`NRL primary lines/totals must use safer rungs (max 1.90 odds); ${overpricedLegs[0].label} is too aggressive`] 
    : [];
}

async function validateLivePricing(context, pick, overrides = {}) {
  const legs = Array.isArray(pick?.legs) ? pick.legs : [];
  const reasons = [];
  let holdRecommended = false;
  let checkedLegCount = 0;
  const matchedLegPrices = [];
  const resolveValidation = overrides.resolveOddsValidation || resolveOddsValidation;

  for (const leg of legs) {
    const oddsCheck = buildLegOddsCheck(pick, leg, context.config);

    if (!oddsCheck) {
      continue;
    }

    checkedLegCount += 1;

    const result = await resolveValidation(context, oddsCheck, {
      maxAgeMinutes: context.config.marketScrape.maxSnapshotAgeMinutes
    });

    if (result?.status === 'ok') {
      const bestOdds = Number(result.bestOdds);

      if (Number.isFinite(bestOdds) && bestOdds > 0) {
        matchedLegPrices.push({
          legId: String(leg?.id || ''),
          label: String(leg?.label || '').trim(),
          bestOdds,
          bestBookmaker: result.bestBookmaker || null,
          source: result.source || null
        });
      }

      continue;
    }

    reasons.push(`live price validation failed for ${leg.label}: ${result?.status || 'unknown_status'}`);
    holdRecommended ||= shouldHoldForOddsStatus(result?.status);
  }

  const totalOdds = checkedLegCount > 0 && matchedLegPrices.length === checkedLegCount
    ? matchedLegPrices.reduce((product, leg) => product * leg.bestOdds, 1)
    : null;

  return {
    reasons,
    holdRecommended,
    totalOdds,
    matchedLegPrices
  };
}

async function evaluatePublicationChecks(context, pick, overrides = {}) {
  const basicReasons = validateBasicPublicationFields(pick);
  const legValidation = validateLegPublication(pick);
  const checklistReasons = isGeneratedPick(pick) ? validateAnalysisChecklist(pick) : [];
  const livePriceValidation = await validateLivePricing(context, pick, overrides);
  let resolvedEspnEvent = null;

  if (isGeneratedPick(pick) && overrides.lateContextRecheck) {
    try {
      resolvedEspnEvent = await resolveEspnEventForPick(context, pick, overrides);
    } catch (error) {
      console.warn(`[picks] late event resolution failed for ${pick.id}: ${error.message}`);
    }
  }

  const lateEventStatusValidation = isGeneratedPick(pick)
    ? validateLateEventStatus(overrides.lateContextRecheck ? resolvedEspnEvent : null)
    : { status: 'not_applicable', reasons: [] };
  const skipFurtherLateChecks = lateEventStatusValidation.reasons.length > 0;

  const lateAvailabilityValidation = isGeneratedPick(pick) && !skipFurtherLateChecks
    ? await validateLatePlayerAvailability(context, pick, { ...overrides, resolvedEspnEvent })
    : { status: skipFurtherLateChecks ? 'skipped' : 'not_applicable', reasons: [] };
  const lateWeatherValidation = isGeneratedPick(pick) && !skipFurtherLateChecks
    ? await validateLateWeatherConditions(context, pick, { ...overrides, resolvedEspnEvent })
    : { status: skipFurtherLateChecks ? 'skipped' : 'not_applicable', reasons: [] };
  const oddsProfileReasons = validateGeneratedTotalOddsProfile(pick, livePriceValidation.totalOdds);
  const nrlPriceReasons = validateNrlIndividualLegPricing(pick, livePriceValidation.matchedLegPrices);
  const correlationReasons = String(pick?.correlationRisk || '').toLowerCase() === 'high' && !pick?.correlationJustified
    ? ['correlation risk remains unjustified at publication time']
    : [];
  const reasons = [
    ...basicReasons,
    ...legValidation.reasons,
    ...checklistReasons,
    ...lateEventStatusValidation.reasons,
    ...lateAvailabilityValidation.reasons,
    ...lateWeatherValidation.reasons,
    ...oddsProfileReasons,
    ...nrlPriceReasons,
    ...correlationReasons,
    ...livePriceValidation.reasons
  ];
  const status = reasons.length === 0
    ? 'ok'
    : basicReasons.length > 0
      ? 'invalid_basic_fields'
      : checklistReasons.length > 0
        ? 'checklist_failed'
        : lateAvailabilityValidation.reasons.length > 0
          ? 'player_availability_failed'
        : lateEventStatusValidation.reasons.length > 0 || lateWeatherValidation.reasons.length > 0
          ? 'external_conditions_failed'
        : oddsProfileReasons.length > 0
          ? 'odds_profile_failed'
        : livePriceValidation.reasons.length > 0
          ? 'live_price_unverified'
        : 'ticket_integrity_failed';

  return {
    qualifies: reasons.length === 0,
    publicationValidation: {
      status,
      reasons,
      holdRecommended: livePriceValidation.holdRecommended,
      totalOdds: livePriceValidation.totalOdds,
      matchedLegPrices: livePriceValidation.matchedLegPrices,
      lateEventStatus: lateEventStatusValidation.status,
      lateAvailabilityStatus: lateAvailabilityValidation.status,
      lateWeatherStatus: lateWeatherValidation.status,
      lateWeatherDisplay: lateWeatherValidation.weather || null,
      mode: isGeneratedPick(pick) ? 'generated' : 'manual_or_hybrid'
    },
    legPublicationValidations: legValidation.legPublicationValidations
  };
}

async function evaluateCandidate(context, pick, now, nextIntervalMs, overrides = {}) {
  const benchmark = evaluatePickAgainstBenchmarks(pick, context.config.benchmarkFilters);
  const publicationChecks = await evaluatePublicationChecks(context, pick, overrides);
  const postingWindow = shouldUseImmediateGeneratedPosting(pick, overrides)
    ? isBeforeStartTime(pick, now)
    : isWithinPostingWindow(pick, now, context.config);

  return {
    benchmark,
    publicationValidation: publicationChecks.publicationValidation,
    publicationResult: {
      qualifies: publicationChecks.qualifies,
      publicationValidation: publicationChecks.publicationValidation
    },
    legPublicationValidations: publicationChecks.legPublicationValidations,
    postingWindow
  };
}

function updateTrackedPick(tracking, pickId, trackedPick, now, nextIntervalMs, patch = {}) {
  tracking[pickId] = {
    ...trackedPick,
    ...patch,
    lastCheckedAt: now.toISOString(),
    nextCheckAt: patch.nextCheckAt ?? new Date(now.getTime() + nextIntervalMs).toISOString()
  };
}

function summarizePostedPick(pick, kind = 'pick') {
  return {
    id: String(pick?.id || ''),
    kind,
    event: String(pick?.event || '').trim() || 'Unknown event',
    summary: String(pick?.summary || '').trim() || 'Unknown pick',
    legCount: Array.isArray(pick?.legs)
      ? pick.legs.filter((leg) => String(leg?.label || '').trim()).length
      : 0,
    legs: Array.isArray(pick?.legs)
      ? pick.legs.map((leg) => String(leg?.label || '').trim()).filter(Boolean)
      : []
  };
}

function buildCancellationReason(evaluation) {
  const reasons = evaluation?.benchmark?.accepted === false
    ? evaluation?.benchmark?.reasons
    : evaluation?.publicationValidation?.reasons;

  if (!Array.isArray(reasons) || !reasons.length) {
    return 'Cancelled after the late pregame recheck failed.';
  }

  return `Cancelled after the late pregame recheck: ${reasons.join('; ')}`;
}

function getPersistentTrackedIds(tracking) {
  return Object.entries(tracking)
    .filter(([, trackedPick]) => trackedPick?.activeReplacement || trackedPick?.pregameRecheckedAt || trackedPick?.status === 'cancelled')
    .map(([pickId]) => pickId);
}

async function selectReplacementCandidate(context, pick, now, nextIntervalMs, overrides = {}) {
  const forceFreshReplacement = requiresFreshReplacementRebuild(pick);
  const preferFreshReplacement = prefersFreshReplacementRebuild(pick);
  const explicitReplacementOptions = Array.isArray(pick.replacementOptions) && pick.replacementOptions.length
    ? pick.replacementOptions
    : [];
  const shouldBuildFreshSnapshot = forceFreshReplacement || preferFreshReplacement || !explicitReplacementOptions.length && hasMalformedGeneratedLegs(pick);
  const freshSnapshotOptions = shouldBuildFreshSnapshot
    ? await buildFreshSnapshotReplacementOptions(context, pick, now, overrides)
    : [];
  const replacementOptions = forceFreshReplacement
    ? freshSnapshotOptions
    : preferFreshReplacement
      ? [...freshSnapshotOptions, ...explicitReplacementOptions, ...generateReplacementOptionsFromTemplate(pick)]
      : explicitReplacementOptions.length
        ? explicitReplacementOptions
        : [...freshSnapshotOptions, ...generateReplacementOptionsFromTemplate(pick)];

  if (!replacementOptions.length) {
    return {
      status: 'missing_options',
      replacement: null
    };
  }

  for (const [index, option] of replacementOptions.entries()) {
    const candidate = buildReplacementCandidate(pick, option, index);
    const evaluation = await evaluateCandidate(context, candidate, now, nextIntervalMs, overrides);

    if (!evaluation.benchmark.accepted) {
      continue;
    }

    if (!evaluation.postingWindow) {
      continue;
    }

    if (!evaluation.publicationResult.qualifies) {
      continue;
    }

    return {
      status: 'selected',
      replacement: {
        ...candidate,
        benchmark: evaluation.benchmark,
        publicationValidation: evaluation.publicationValidation,
        legPublicationValidations: evaluation.legPublicationValidations
      }
    };
  }

  return {
    status: 'no_valid_replacement',
    replacement: null
  };
}

export async function runPicksJob(context, overrides = {}) {
  const { config, state, dryRun } = context;
  const forcePostNow = Boolean(overrides.forcePostNow);
  const getCurrentTime = overrides.getCurrentTime || (() => new Date());
  const now = getCurrentTime();
  const dateKey = getDateKey(now, config.timezone);
  const feed = await loadPicksFeed(config.__paths.picksFeedFile);
  const trackerRows = await readBankrollTrackerRows(config, now.toISOString());
  const trackerRowMaps = buildTrackerRowMaps(trackerRows);
  hydratePostedPickStateFromTracker(state, trackerRowMaps);
  const pending = feed.picks.filter((pick) => pick.status === 'pending' && !state.posts.picks[pick.id]);
  const replacementTargets = feed.picks.filter((pick) => needsReplacement(pick, state));
  const tracking = ensurePickTracking(state);
  const postedPregameTargets = forcePostNow
    ? []
    : feed.picks.filter((pick) => (
      String(pick.status || '').toLowerCase() === 'pending'
      && hasPostedPick(state, pick.id)
      && isGeneratedPick(pick)
      && !needsReplacement(pick, state)
      && isBeforeStartTime(pick, now)
    ));
  const trackedIds = new Set([
    ...pending.map((pick) => pick.id),
    ...replacementTargets.map((pick) => pick.id),
    ...postedPregameTargets.map((pick) => pick.id),
    ...getPersistentTrackedIds(tracking)
  ]);

  for (const trackedId of Object.keys(tracking)) {
    if (!trackedIds.has(trackedId)) {
      delete tracking[trackedId];
    }
  }

  for (const pick of pending) {
    if (!isWithinShortlistWindow(pick, now, config)) {
      continue;
    }

    tracking[pick.id] ??= {
      shortlistedAt: now.toISOString(),
      status: 'watching',
      nextCheckAt: now.toISOString()
    };
  }

  for (const pick of postedPregameTargets) {
    const trackedPick = tracking[pick.id];
    const publishedPick = getPublishedPick(pick, trackedPick);
    const nextPregameCheckAt = trackedPick?.nextCheckAt
      || (!trackedPick ? now.toISOString() : getNextPregameRecheckAt(publishedPick, now, config));

    if (trackedPick?.status === 'cancelled' || trackedPick?.pregameRecheckedAt) {
      continue;
    }

    tracking[pick.id] = {
      ...trackedPick,
      shortlistedAt: trackedPick?.shortlistedAt || state.posts.picks[pick.id] || now.toISOString(),
      postedAt: trackedPick?.postedAt || state.posts.picks[pick.id] || now.toISOString(),
      postedPickSnapshot: trackedPick?.postedPickSnapshot || cloneSerializable(publishedPick),
      status: trackedPick?.status || (nextPregameCheckAt ? 'posted_waiting_for_pregame_recheck' : 'pregame_recheck_passed'),
      nextCheckAt: nextPregameCheckAt || publishedPick.startTime || null,
      ...(nextPregameCheckAt ? {} : { pregameRecheckedAt: trackedPick?.pregameRecheckedAt || now.toISOString() })
    };
  }

  const approved = [];
  const replacements = [];
  const cancellations = [];
  let watched = 0;

  for (const pick of pending) {
    const trackedPick = tracking[pick.id];

    if (!trackedPick) {
      continue;
    }

    if (!forcePostNow && !shouldCheckPick(trackedPick, now)) {
      watched += 1;
      continue;
    }

    const nextIntervalMs = getCheckIntervalMs(pick, now, config);
    const evaluation = await evaluateCandidate(context, pick, now, nextIntervalMs, overrides);
    const { benchmark, publicationValidation, publicationResult, postingWindow } = evaluation;

    if (!benchmark.accepted) {
      console.log(`[picks] skipped ${pick.id}: ${benchmark.reasons.join('; ')}`);
      delete tracking[pick.id];
      continue;
    }

    if (!postingWindow) {
      if (!isBeforeStartTime(pick, now)) {
        console.log(`[picks] skipped ${pick.id}: start time passed before publication`);
        delete tracking[pick.id];
        continue;
      }

      updateTrackedPick(tracking, pick.id, trackedPick, now, nextIntervalMs, {
        status: 'waiting_for_window',
        lastValidationStatus: publicationValidation?.status || null,
        lastDecision: 'held_outside_post_window'
      });
      watched += 1;
      continue;
    }

    if (!publicationResult.qualifies) {
      const shouldHold = config.jobs.picks.holdIfSupportRulesFail && Boolean(publicationValidation?.holdRecommended);

      if (shouldHold) {
        updateTrackedPick(tracking, pick.id, trackedPick, now, nextIntervalMs, {
          status: 'waiting_for_support',
          lastValidationStatus: publicationValidation?.status || 'unknown',
          lastDecision: 'held_waiting_for_support_rules'
        });
        watched += 1;
        continue;
      }

      console.log(`[picks] skipped ${pick.id}: ${(publicationValidation?.reasons || ['publication validation failed']).join('; ')}`);
      delete tracking[pick.id];
      continue;
    }

    approved.push({
      ...pick,
      benchmark,
      publicationValidation,
      legPublicationValidations: evaluation.legPublicationValidations
    });
  }

  for (const pick of replacementTargets) {
    const trackedPick = tracking[pick.id] || {
      shortlistedAt: state.posts.picks[pick.id],
      status: 'replacement_watch',
      nextCheckAt: now.toISOString()
    };
    const publishedPick = getPublishedPick(pick, trackedPick);
    tracking[pick.id] = trackedPick;

    if (trackedPick.status === 'cancelled') {
      continue;
    }

    if (!forcePostNow && !shouldCheckPick(trackedPick, now)) {
      watched += 1;
      continue;
    }

    const nextIntervalMs = getCheckIntervalMs(pick, now, config);

    if (!isBeforeReplacementCutoff(pick, now, config)) {
      updateTrackedPick(tracking, pick.id, trackedPick, now, nextIntervalMs, {
        status: 'replacement_expired',
        lastDecision: 'replacement_window_closed'
      });
      watched += 1;
      continue;
    }

    const replacementSelection = await selectReplacementCandidate(context, publishedPick, now, nextIntervalMs, overrides);

    if (replacementSelection.status === 'missing_options') {
      updateTrackedPick(tracking, pick.id, trackedPick, now, nextIntervalMs, {
        status: 'waiting_for_replacement_option',
        lastDecision: 'replacement_options_missing'
      });
      watched += 1;
      continue;
    }

    if (replacementSelection.status !== 'selected') {
      updateTrackedPick(tracking, pick.id, trackedPick, now, nextIntervalMs, {
        status: 'waiting_for_replacement_review',
        lastDecision: 'no_valid_replacement_yet'
      });
      watched += 1;
      continue;
    }

    const selectedReplacement = replacementSelection.replacement;

    if (trackedPick.lastReplacementOptionId === selectedReplacement.candidateId && trackedPick.lastReplacementStatus === pick.replacementStatus) {
      const nextPregameCheckAt = getNextPregameRecheckAt(selectedReplacement, now, config);
      updateTrackedPick(tracking, pick.id, trackedPick, now, nextIntervalMs, {
        status: nextPregameCheckAt ? 'posted_waiting_for_pregame_recheck' : 'pregame_recheck_passed',
        activeReplacement: selectedReplacement,
        nextCheckAt: nextPregameCheckAt || selectedReplacement.startTime || null,
        lastDecision: 'replacement_already_posted'
      });
      watched += 1;
      continue;
    }

    replacements.push({
      original: publishedPick,
      replacement: selectedReplacement,
      trackedPick,
      nextIntervalMs
    });
  }

  for (const pick of postedPregameTargets) {
    const trackedPick = tracking[pick.id];
    const publishedPick = getPublishedPick(pick, trackedPick);

    if (!trackedPick || trackedPick.status === 'cancelled' || trackedPick.pregameRecheckedAt) {
      continue;
    }

    if (!shouldCheckPick(trackedPick, now)) {
      watched += 1;
      continue;
    }

    const nextIntervalMs = getCheckIntervalMs(pick, now, config);
    const evaluation = await evaluateCandidate(context, publishedPick, now, nextIntervalMs, {
      ...overrides,
      forcePostNow: true,
      lateContextRecheck: true
    });

    const nextPregameCheckAt = getNextPregameRecheckAt(publishedPick, now, config);

    if (evaluation.benchmark.accepted && evaluation.publicationResult.qualifies) {
      updateTrackedPick(tracking, pick.id, trackedPick, now, nextIntervalMs, {
        status: nextPregameCheckAt ? 'posted_waiting_for_pregame_recheck' : 'pregame_recheck_passed',
        pregameRecheckedAt: nextPregameCheckAt ? null : now.toISOString(),
        nextCheckAt: nextPregameCheckAt || publishedPick.startTime || null,
        lastValidationStatus: evaluation.publicationValidation?.status || null,
        lastDecision: nextPregameCheckAt ? 'pregame_recheck_passed_waiting_next_checkpoint' : 'pregame_recheck_passed'
      });
      continue;
    }

    const replacementSelection = await selectReplacementCandidate(context, publishedPick, now, nextIntervalMs, {
      ...overrides,
      forcePostNow: true,
      lateContextRecheck: true
    });

    if (replacementSelection.status === 'selected') {
      replacements.push({
        original: publishedPick,
        replacement: replacementSelection.replacement,
        trackedPick,
        nextIntervalMs
      });
      continue;
    }

    cancellations.push({
      pick: evaluation.publicationValidation?.lateWeatherDisplay
        ? {
            ...publishedPick,
            weather: evaluation.publicationValidation.lateWeatherDisplay
          }
        : publishedPick,
      trackedPick,
      stakeUnits: toNumber(trackedPick?.activeReplacement?.stakeUnits) ?? toNumber(publishedPick?.stakeUnits) ?? 0,
      reason: buildCancellationReason(evaluation)
    });
  }

  if ((!pending.length && !replacementTargets.length && !postedPregameTargets.length) || (!approved.length && !replacements.length && !cancellations.length)) {
    state.jobs.picks = {
      lastRunDate: dateKey,
      lastRunAt: now.toISOString()
    };

    return {
      job: 'picks',
      posted: 0,
      watched
    };
  }

  const postedMessageMetaByPickId = new Map();
  const replacementMessageMetaByPickId = new Map();
  const sentReplacements = [];
  const sentCancellations = [];

  for (const pick of approved) {
    const pickMessages = formatPicksMessages([pick], getPickDateKey(pick, dateKey, config.timezone), config.timezone);
    const webhookChannel = resolvePickWebhookChannel(config, pick);
    const webhookUrl = getWebhookUrlByChannel(config, webhookChannel);

    for (const message of pickMessages) {
      const automatedMessage = buildAutomatedMessage(config, 'picks', message, { sport: pick?.sport });
      const response = await sendWebhookMessage(
        webhookUrl,
        {
          content: automatedMessage.content,
          embeds: automatedMessage.embeds,
          username: config.discord.username,
          avatar_url: config.discord.avatarUrl || undefined,
          allowed_mentions: automatedMessage.allowedMentions
        },
        {
          dryRun,
          label: 'best picks'
        }
      );

      if (!dryRun && response?.id) {
        postedMessageMetaByPickId.set(pick.id, {
          messageId: String(response.id),
          webhookChannel
        });
      }
    }
  }

  for (const item of replacements) {
    const sendTime = getCurrentTime();

    if (!isBeforeStartTime(item.original, sendTime) || !isBeforeStartTime(item.replacement, sendTime)) {
      console.log(`[picks] skipped replacement ${item.original.id}: start time passed before replacement notification`);
      continue;
    }

    await deleteTrackedPickMessage(config, tracking[item.original.id] || item.trackedPick, dryRun, item.original.id);
    const webhookChannel = resolveTrackedPickNotificationWebhookChannel(config, tracking[item.original.id] || item.trackedPick, item.original);
    const webhookUrl = getWebhookUrlByChannel(config, webhookChannel);

    const replacementMessages = formatReplacementPickMessages(
      item.original,
      item.replacement,
      getPickDateKey(item.replacement, dateKey, config.timezone)
    );

    for (const message of replacementMessages) {
      const automatedMessage = buildAutomatedMessage(config, 'picks', message, { sport: item.original?.sport || item.replacement?.sport });
      const response = await sendWebhookMessage(
        webhookUrl,
        {
          content: automatedMessage.content,
          embeds: automatedMessage.embeds,
          username: config.discord.username,
          avatar_url: config.discord.avatarUrl || undefined,
          allowed_mentions: automatedMessage.allowedMentions
        },
        {
          dryRun,
          label: 'replacement pick'
        }
      );

      if (!dryRun && response?.id) {
        replacementMessageMetaByPickId.set(item.original.id, {
          messageId: String(response.id),
          webhookChannel
        });
      }
    }

    sentReplacements.push(item);
  }

  for (const item of cancellations) {
    const sendTime = getCurrentTime();

    if (!isBeforeStartTime(item.pick, sendTime)) {
      console.log(`[picks] skipped cancellation ${item.pick.id}: start time passed before cancellation notification`);
      continue;
    }

    await deleteTrackedPickMessage(config, tracking[item.pick.id] || item.trackedPick, dryRun, item.pick.id);
    const webhookChannel = resolveTrackedPickNotificationWebhookChannel(config, tracking[item.pick.id] || item.trackedPick, item.pick);
    const webhookUrl = getWebhookUrlByChannel(config, webhookChannel);

    const cancellationMessages = formatCancellationPickMessages(
      item.pick,
      item.reason,
      getPickDateKey(item.pick, dateKey, config.timezone)
    );

    for (const message of cancellationMessages) {
      const automatedMessage = buildAutomatedMessage(config, 'picks', message, { sport: item.pick?.sport });
      await sendWebhookMessage(
        webhookUrl,
        {
          content: automatedMessage.content,
          embeds: automatedMessage.embeds,
          username: config.discord.username,
          avatar_url: config.discord.avatarUrl || undefined,
          allowed_mentions: automatedMessage.allowedMentions
        },
        {
          dryRun,
          label: 'pick cancellation'
        }
      );
    }

    sentCancellations.push(item);
  }

  if (!dryRun) {
    await appendPostedTrackerEntries(config, approved, now.toISOString());
    await appendReplacementTrackerEntries(config, sentReplacements, now.toISOString());
    const appendedCancellationRows = await appendCancellationTrackerEntries(config, sentCancellations, now.toISOString());

    await sendCancellationSettlementMessages(config, sentCancellations, appendedCancellationRows, dateKey, dryRun);

    for (const pick of approved) {
      state.posts.picks[pick.id] = now.toISOString();

      if (!isGeneratedPick(pick)) {
        delete tracking[pick.id];
        continue;
      }

      tracking[pick.id] = {
        shortlistedAt: tracking[pick.id]?.shortlistedAt || now.toISOString(),
        postedAt: now.toISOString(),
        postedPickSnapshot: cloneSerializable(pick),
        postedMessageId: postedMessageMetaByPickId.get(pick.id)?.messageId || tracking[pick.id]?.postedMessageId || null,
        postedWebhookChannel: postedMessageMetaByPickId.get(pick.id)?.webhookChannel || tracking[pick.id]?.postedWebhookChannel || resolvePickWebhookChannel(config, pick),
        status: shouldSchedulePregameRecheck(pick, now, config)
          ? 'posted_waiting_for_pregame_recheck'
          : 'pregame_recheck_passed',
        nextCheckAt: shouldSchedulePregameRecheck(pick, now, config)
          ? getNextPregameRecheckAt(pick, now, config)
          : pick.startTime || null,
        lastCheckedAt: now.toISOString(),
        ...(shouldSchedulePregameRecheck(pick, now, config) ? {} : { pregameRecheckedAt: now.toISOString() }),
        benchmark: pick.benchmark || tracking[pick.id]?.benchmark || null,
        publicationValidation: pick.publicationValidation || tracking[pick.id]?.publicationValidation || null,
        totalOdds: pick.publicationValidation?.totalOdds ?? pick.totalOdds ?? tracking[pick.id]?.totalOdds ?? null,
        priceDecimal: pick.publicationValidation?.totalOdds ?? pick.priceDecimal ?? tracking[pick.id]?.priceDecimal ?? null,
        lastDecision: shouldSchedulePregameRecheck(pick, now, config)
          ? 'posted_waiting_for_pregame_recheck'
          : 'posted_inside_pregame_window'
      };
    }

    for (const item of sentReplacements) {
      const nextPregameCheckAt = getNextPregameRecheckAt(item.replacement, now, config);
      updateTrackedPick(tracking, item.original.id, item.trackedPick, now, item.nextIntervalMs, {
        status: nextPregameCheckAt ? 'posted_waiting_for_pregame_recheck' : 'pregame_recheck_passed',
        activeReplacement: item.replacement,
        postedMessageId: replacementMessageMetaByPickId.get(item.original.id)?.messageId || item.trackedPick?.postedMessageId || null,
        postedWebhookChannel: replacementMessageMetaByPickId.get(item.original.id)?.webhookChannel || resolveTrackedPickNotificationWebhookChannel(config, item.trackedPick, item.original),
        replacementPostedAt: now.toISOString(),
        lastReplacementOptionId: item.replacement.candidateId,
        lastReplacementStatus: item.original.replacementStatus,
        pregameRecheckedAt: nextPregameCheckAt ? null : now.toISOString(),
        nextCheckAt: nextPregameCheckAt || item.replacement.startTime || null,
        lastDecision: 'replacement_posted'
      });
    }

    for (const item of sentCancellations) {
      tracking[item.pick.id] = {
        ...item.trackedPick,
        postedAt: item.trackedPick?.postedAt || state.posts.picks[item.pick.id] || now.toISOString(),
        postedMessageId: null,
        postedWebhookChannel: null,
        status: 'cancelled',
        nextCheckAt: item.pick.startTime || null,
        lastCheckedAt: now.toISOString(),
        cancellationPostedAt: now.toISOString(),
        lastDecision: 'cancellation_posted',
        lastCancellationReason: item.reason
      };
    }
  }

  state.jobs.picks = {
    lastRunDate: dateKey,
    lastRunAt: now.toISOString()
  };

  return {
    job: 'picks',
    posted: approved.length + sentReplacements.length + sentCancellations.length,
    watched,
    postedDetails: [
      ...approved.map((pick) => summarizePostedPick(pick, 'pick')),
      ...sentReplacements.map((item) => summarizePostedPick(item.replacement, 'replacement')),
      ...sentCancellations.map((item) => summarizePostedPick(item.pick, 'cancellation'))
    ]
  };
}