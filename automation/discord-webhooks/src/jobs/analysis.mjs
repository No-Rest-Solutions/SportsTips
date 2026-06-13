import fs from 'node:fs/promises';

import { analyzeEventWithOpenAi, analyzeEventWithRules, buildAnalysisCandidatePool, buildPickFromAnalysisDecision } from '../ai-pick-generator.mjs';
import { buildDailyTrackerSummary } from '../bot-tracker.mjs';
import { mergeGeneratedPicks, mergeQuoteEntries } from '../pick-generator.mjs';
import { loadRawPicksFeed, saveRawPicksFeed } from '../picks-feed.mjs';
import { fetchAflClubTeamRoster, fetchAflOfficialPlayer, fetchAflOfficialTeams, fetchAflStatsProPlayerProfile } from '../providers/afl-official.mjs';
import { fetchEspnSlate } from '../providers/espn.mjs';
import { fetchEspnTeamInjuries } from '../providers/espn-injuries.mjs';
import { fetchRotowireMlbDailyLineups, fetchRotowireMlbNews, findMatchingRotowireMlbGame, getRotowireMlbLineupsPageKey } from '../providers/mlb-rotowire.mjs';
import { extractMlbGameResearch, fetchMlbGameFeed, fetchMlbSchedule } from '../providers/mlb-statsapi.mjs';
import { fetchNrlOfficialSlate, fetchNrlOfficialSummary } from '../providers/nrl-official.mjs';
import { buildOpenMeteoEventWeatherSnapshot, fetchOpenMeteoForecast, geocodeOpenMeteoLocation } from '../providers/open-meteo.mjs';
import { getDateKey } from '../scheduler.mjs';
import { teamNamesMatch, textMentionsTeam } from '../team-name-matching.mjs';
import { buildSnapshotEvents, ensureFreshScrapedSnapshot, fetchSportsbetEventTargetBetQuotes, getSnapshotEventQuotes } from '../web-market-intake.mjs';

const AVAILABLE_INJURY_STATUSES = new Set(['available', 'active', 'probable']);
const NON_FATAL_INJURY_RESEARCH_STATUSES = new Set(['injury link missing']);
const ESPN_PREVIOUS_DAY_SCOREBOARD_FALLBACK_SPORTS = new Set(['mlb', 'nba', 'nfl', 'nhl']);
const ESPN_PREVIOUS_DAY_SCOREBOARD_MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;
const NRL_OFFICIAL_TIMEZONE = 'Australia/Sydney';
const NRL_OFFICIAL_EVENT_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;
const OUTDOOR_WEATHER_RESEARCH_SPORTS = new Set(['afl', 'mlb', 'nfl', 'nrl', 'soccer_epl', 'soccer_uefa_champs_league']);
const CLOSED_ROOF_MARKERS = ['closed', 'dome', 'indoors'];
const SEVERE_WEATHER_CODES = new Set([95, 96, 99]);
const WET_WEATHER_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 85, 86]);
const THUNDER_WEATHER_CODES = new Set([95, 96, 99]);
const SNOW_WEATHER_CODES = new Set([71, 73, 75, 77, 85, 86]);
const FOG_WEATHER_CODES = new Set([45, 48]);
const MLB_BATTER_RESEARCH_MARKETS = new Set(['batter_hits', 'batter_rbis', 'batter_total_bases']);
const MLB_PROP_RESEARCH_MARKETS = new Set([...MLB_BATTER_RESEARCH_MARKETS, 'pitcher_strikeouts']);
const MLB_LINEUP_LOCK_HOURS = 4;
const MLB_SAFE_BATTER_ORDER_MAX = 5;
const MLB_SUPPORTING_NEWS_MARKERS = [
  'injury',
  'tightness',
  'soreness',
  'scratched',
  'scratch',
  'not starting',
  'sits',
  'sitting',
  'exits',
  'leaves',
  'illness',
  'rest',
  'returns',
  'return',
  'debut',
  'starts',
  'starting',
  'activated',
  'rehab',
  'trade',
  'traded',
  'optioned',
  'promoted'
];
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
const FORM_RECENT_GAME_TARGET = 5;
const FORM_MIN_RECENT_GAMES = 2;
const FORM_LOOKBACK_DAYS_BY_SPORT = {
  afl: 45,
  mlb: 14,
  nba: 21,
  nfl: 150,
  nhl: 21,
  nrl: 45,
  soccer_epl: 45,
  soccer_uefa_champs_league: 120,
  tennis_atp: 60
};
const DEFAULT_FORM_LOOKBACK_DAYS = 30;
const TAB_BOOKMAKER_MARKERS = ['tab'];
const SPORTSBET_BOOKMAKER_MARKERS = ['sportsbet', 'sportsbet web'];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripTrailingParentheticalLabel(value) {
  return String(value || '')
    .replace(/\s+\([^)]*\)\s*$/u, '')
    .trim();
}

function normalizeMlbTeamName(value) {
  return normalizeText(stripTrailingParentheticalLabel(value));
}

function normalizeEventTeamNameForProviderMatch(sport, value) {
  return normalizeText(normalizeText(sport?.key || sport?.marketKey) === 'mlb'
    ? stripTrailingParentheticalLabel(value)
    : value);
}

function buildMlbResearchEventContext(eventContext) {
  if (normalizeText(eventContext?.sportKey) !== 'mlb') {
    return eventContext;
  }

  return {
    ...eventContext,
    homeTeam: stripTrailingParentheticalLabel(eventContext?.homeTeam),
    awayTeam: stripTrailingParentheticalLabel(eventContext?.awayTeam)
  };
}

function normalizeMarketKey(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

function normalizePlayerName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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

function getUtcDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString().slice(0, 10);
}

function getHoursUntilStart(startTime) {
  const startMs = Date.parse(startTime);

  if (!Number.isFinite(startMs)) {
    return null;
  }

  return (startMs - Date.now()) / (60 * 60 * 1000);
}

function isFinalScoreboardEvent(scoreboardEvent) {
  const state = normalizeText(scoreboardEvent?.state);
  const shortStatus = normalizeText(scoreboardEvent?.shortStatus);

  return state === 'post'
    || shortStatus.includes('final')
    || shortStatus === 'ft';
}

function getFormLookbackDays(sportKey) {
  return Number(FORM_LOOKBACK_DAYS_BY_SPORT[normalizeText(sportKey)] || DEFAULT_FORM_LOOKBACK_DAYS);
}

function buildRecentFormDateKeys(sport, eventContext) {
  const eventDate = new Date(eventContext?.startTime || '');

  if (Number.isNaN(eventDate.getTime())) {
    return [];
  }

  const timezone = eventContext?.timezone || 'Australia/Sydney';
  const dateKeys = [];
  const seen = new Set();

  for (let dayOffset = 1; dayOffset <= getFormLookbackDays(sport?.key || eventContext?.sportKey); dayOffset += 1) {
    const baseDate = new Date(eventDate.getTime() - dayOffset * 24 * 60 * 60 * 1000);
    const candidates = [getDateKey(baseDate, timezone)];

    if (shouldTryPreviousEspnScoreboardDate(sport)) {
      candidates.push(getDateKey(new Date(baseDate.getTime() - 24 * 60 * 60 * 1000), timezone));
    }

    for (const dateKey of candidates) {
      if (!dateKey || seen.has(dateKey)) {
        continue;
      }

      seen.add(dateKey);
      dateKeys.push(dateKey);
    }
  }

  return dateKeys;
}

function matchEventTeamSide(scoreboardEvent, teamName, teamId) {
  const normalizedTeamId = String(teamId || '').trim();

  if (normalizedTeamId) {
    if (String(scoreboardEvent?.homeTeamId || '').trim() === normalizedTeamId) {
      return 'home';
    }

    if (String(scoreboardEvent?.awayTeamId || '').trim() === normalizedTeamId) {
      return 'away';
    }
  }

  if (teamNamesMatch(scoreboardEvent?.homeTeam, teamName)) {
    return 'home';
  }

  if (teamNamesMatch(scoreboardEvent?.awayTeam, teamName)) {
    return 'away';
  }

  return null;
}

function buildRecentFormEntry(scoreboardEvent, matchedSide) {
  const teamScore = toNumber(matchedSide === 'home' ? scoreboardEvent?.homeScore : scoreboardEvent?.awayScore);
  const opponentScore = toNumber(matchedSide === 'home' ? scoreboardEvent?.awayScore : scoreboardEvent?.homeScore);

  if (teamScore === null || opponentScore === null) {
    return null;
  }

  return {
    eventId: String(scoreboardEvent?.id || ''),
    startTime: scoreboardEvent?.startTime || '',
    teamScore,
    opponentScore,
    won: teamScore > opponentScore,
    margin: teamScore - opponentScore,
    combinedTotal: teamScore + opponentScore
  };
}

function summarizeRecentForm(history) {
  const entries = Array.isArray(history) ? history.slice(0, FORM_RECENT_GAME_TARGET) : [];

  if (entries.length < FORM_MIN_RECENT_GAMES) {
    return null;
  }

  const wins = entries.filter((entry) => entry.won).length;
  const losses = entries.length - wins;

  return {
    games: entries.length,
    wins,
    losses,
    winRate: wins / entries.length,
    averageMargin: entries.reduce((sum, entry) => sum + entry.margin, 0) / entries.length,
    averageCombinedTotal: entries.reduce((sum, entry) => sum + entry.combinedTotal, 0) / entries.length
  };
}

async function loadEventFormResearch(sport, eventContext, researchCaches, overrides = {}) {
  const fetchScoreboard = overrides.fetchEspnSlate || fetchEspnSlate;
  const formCache = researchCaches?.form instanceof Map ? researchCaches.form : new Map();
  const homeHistory = [];
  const awayHistory = [];
  const seenHomeEvents = new Set();
  const seenAwayEvents = new Set();

  if (!sport?.path || !eventContext?.homeTeam || !eventContext?.awayTeam || !eventContext?.startTime) {
    return {
      status: 'not_available',
      teamFormBySide: new Map(),
      reasons: ['Recent form needs an ESPN-backed event with both sides and a start time.']
    };
  }

  for (const dateKey of buildRecentFormDateKeys(sport, eventContext)) {
    const cacheKey = `${sport.key}:${dateKey}`;

    if (!formCache.has(cacheKey)) {
      formCache.set(cacheKey, fetchScoreboard(sport, dateKey));
    }

    let scoreboard;

    try {
      scoreboard = await formCache.get(cacheKey);
    } catch {
      continue;
    }

    const events = Array.isArray(scoreboard?.events) ? scoreboard.events : [];

    for (const scoreboardEvent of events) {
      if (!isFinalScoreboardEvent(scoreboardEvent)) {
        continue;
      }

      const scoreboardStartMs = Date.parse(scoreboardEvent?.startTime || '');
      const eventStartMs = Date.parse(eventContext.startTime || '');

      if (Number.isFinite(scoreboardStartMs) && Number.isFinite(eventStartMs) && scoreboardStartMs >= eventStartMs) {
        continue;
      }

      const homeMatchedSide = matchEventTeamSide(scoreboardEvent, eventContext.homeTeam, eventContext.homeTeamId);

      if (homeMatchedSide && !seenHomeEvents.has(scoreboardEvent.id)) {
        const entry = buildRecentFormEntry(scoreboardEvent, homeMatchedSide);

        if (entry) {
          homeHistory.push(entry);
          seenHomeEvents.add(scoreboardEvent.id);
        }
      }

      const awayMatchedSide = matchEventTeamSide(scoreboardEvent, eventContext.awayTeam, eventContext.awayTeamId);

      if (awayMatchedSide && !seenAwayEvents.has(scoreboardEvent.id)) {
        const entry = buildRecentFormEntry(scoreboardEvent, awayMatchedSide);

        if (entry) {
          awayHistory.push(entry);
          seenAwayEvents.add(scoreboardEvent.id);
        }
      }
    }

    if (homeHistory.length >= FORM_RECENT_GAME_TARGET && awayHistory.length >= FORM_RECENT_GAME_TARGET) {
      break;
    }
  }

  const homeSummary = summarizeRecentForm(homeHistory);
  const awaySummary = summarizeRecentForm(awayHistory);

  if (!homeSummary || !awaySummary) {
    return {
      status: 'not_available',
      teamFormBySide: new Map(),
      reasons: ['Not enough finalized ESPN history to score recent team form for both sides.']
    };
  }

  return {
    status: 'ok',
    teamFormBySide: new Map([
      ['home', homeSummary],
      ['away', awaySummary]
    ]),
    reasons: [`Recent form uses up to the last ${Math.min(homeSummary.games, awaySummary.games)} finalized ESPN games per side.`]
  };
}

function buildSignalCandidateKey(item) {
  return JSON.stringify([
    normalizeMarketKey(item?.market),
    normalizeText(item?.outcomeName),
    normalizeText(item?.description),
    toNumber(item?.point)
  ]);
}

async function loadEventExternalSignalResearch(sport, eventContext, candidatePool, researchCaches, overrides = {}) {
  const fetchTargetBetQuotes = overrides.fetchSportsbetEventTargetBetQuotes || fetchSportsbetEventTargetBetQuotes;
  const targetBetCache = researchCaches?.sportsbetTargetBet instanceof Map ? researchCaches.sportsbetTargetBet : new Map();
  const sourceUrl = candidatePool.find((candidate) => /sportsbet\.com\.au/i.test(String(candidate?.sourceUrl || '')))?.sourceUrl || '';
  const targetBetCandidateKeys = new Set();

  if (!sourceUrl || !eventContext?.homeTeam || !eventContext?.awayTeam || !eventContext?.startTime) {
    return {
      status: 'not_available',
      targetBetCandidateKeys,
      reasons: ['No Sportsbet event page was available for embedded targetBet signals.']
    };
  }

  if (!targetBetCache.has(sourceUrl)) {
    targetBetCache.set(sourceUrl, fetchTargetBetQuotes({
      sportKey: sport.marketKey || sport.key,
      displayName: eventContext.eventName,
      homeTeam: eventContext.homeTeam,
      awayTeam: eventContext.awayTeam,
      startTime: eventContext.startTime,
      sourceUrl
    }));
  }

  let targetBetQuotes = [];

  try {
    targetBetQuotes = await targetBetCache.get(sourceUrl);
  } catch {
    targetBetQuotes = [];
  }

  for (const quote of targetBetQuotes) {
    targetBetCandidateKeys.add(buildSignalCandidateKey(quote));
  }

  return {
    status: targetBetQuotes.length ? 'ok' : 'not_available',
    targetBetCandidateKeys,
    reasons: targetBetQuotes.length
      ? ['Sportsbet targetBet insight entries were matched for this event page.']
      : ['The Sportsbet event page exposed no embedded targetBet entries for this event.']
  };
}

function resolveCandidateSelectedSide(candidate, eventContext) {
  const texts = [candidate?.outcomeName, candidate?.description, candidate?.label].filter(Boolean);
  const mentionsHome = texts.some((text) => textMentionsTeam(text, eventContext?.homeTeam));
  const mentionsAway = texts.some((text) => textMentionsTeam(text, eventContext?.awayTeam));

  if (mentionsHome && !mentionsAway) {
    return 'home';
  }

  if (mentionsAway && !mentionsHome) {
    return 'away';
  }

  return null;
}

function buildCandidateFormSignal(candidate, eventContext, formResearch) {
  if (formResearch?.status !== 'ok') {
    return {
      score: 0,
      reason: '',
      label: 'not_available'
    };
  }

  const homeForm = formResearch.teamFormBySide.get('home');
  const awayForm = formResearch.teamFormBySide.get('away');

  if (!homeForm || !awayForm) {
    return {
      score: 0,
      reason: '',
      label: 'not_available'
    };
  }

  const selectedSide = resolveCandidateSelectedSide(candidate, eventContext);
  let score = 0;
  let reason = '';

  if (candidate?.family === 'side' && selectedSide) {
    const selectedForm = selectedSide === 'home' ? homeForm : awayForm;
    const opposingForm = selectedSide === 'home' ? awayForm : homeForm;
    const winRateEdge = selectedForm.winRate - opposingForm.winRate;
    const marginEdge = selectedForm.averageMargin - opposingForm.averageMargin;

    if (winRateEdge >= 0.25) {
      score += 0.018;
    } else if (winRateEdge >= 0.1) {
      score += 0.01;
    } else if (winRateEdge <= -0.25) {
      score -= 0.018;
    } else if (winRateEdge <= -0.1) {
      score -= 0.01;
    }

    if (marginEdge >= 8) {
      score += 0.012;
    } else if (marginEdge >= 3) {
      score += 0.006;
    } else if (marginEdge <= -8) {
      score -= 0.012;
    } else if (marginEdge <= -3) {
      score -= 0.006;
    }

    score = Math.max(-0.03, Math.min(0.03, score));

    if (score !== 0) {
      const selectedTeamName = selectedSide === 'home' ? eventContext?.homeTeam : eventContext?.awayTeam;
      reason = `Recent ESPN form ${score > 0 ? 'supports' : 'leans against'} ${selectedTeamName}: ${selectedForm.wins}-${selectedForm.losses} in the last ${selectedForm.games}, avg margin ${selectedForm.averageMargin.toFixed(1)}.`;
    }
  } else if (candidate?.family === 'total') {
    const normalizedOutcome = normalizeText(candidate?.outcomeName || candidate?.label);
    const line = toNumber(candidate?.point);
    const averageCombinedTotal = (homeForm.averageCombinedTotal + awayForm.averageCombinedTotal) / 2;
    const totalEdge = line === null ? 0 : averageCombinedTotal - line;

    if (normalizedOutcome.includes('over')) {
      if (totalEdge >= 6) {
        score = 0.018;
      } else if (totalEdge >= 3) {
        score = 0.01;
      } else if (totalEdge <= -6) {
        score = -0.018;
      } else if (totalEdge <= -3) {
        score = -0.01;
      }
    } else if (normalizedOutcome.includes('under')) {
      if (totalEdge <= -6) {
        score = 0.018;
      } else if (totalEdge <= -3) {
        score = 0.01;
      } else if (totalEdge >= 6) {
        score = -0.018;
      } else if (totalEdge >= 3) {
        score = -0.01;
      }
    }

    if (score !== 0 && line !== null) {
      reason = `Recent ESPN scoring trend ${score > 0 ? 'supports' : 'leans against'} ${candidate.label}: combined total trend ${averageCombinedTotal.toFixed(1)} versus line ${line.toFixed(1)}.`;
    }
  }

  return {
    score,
    reason,
    label: score > 0 ? 'supportive' : score < 0 ? 'against' : 'neutral'
  };
}

function hasBookmakerMarker(prices, markers) {
  return Array.isArray(prices) && prices.some((price) => {
    const normalizedKey = normalizeText(price?.bookmakerKey);
    const normalizedTitle = normalizeText(price?.bookmakerTitle);
    return markers.some((marker) => normalizedKey.includes(marker) || normalizedTitle.includes(marker));
  });
}

function buildCandidateExternalSignal(candidate, externalSignalResearch) {
  let score = 0;
  const sources = [];
  const reasons = [];

  if (hasBookmakerMarker(candidate?.prices, TAB_BOOKMAKER_MARKERS)) {
    score += 0.008;
    sources.push('tab-market');
    reasons.push('TAB is carrying the same market in the current provider set.');
  }

  if (externalSignalResearch?.targetBetCandidateKeys instanceof Set
    && externalSignalResearch.targetBetCandidateKeys.has(buildSignalCandidateKey(candidate))) {
    score += 0.012;
    sources.push('sportsbet-targetbet');
    reasons.push('Sportsbet embedded targetBet insight aligns with this leg.');
  }

  if (!sources.length && hasBookmakerMarker(candidate?.prices, SPORTSBET_BOOKMAKER_MARKERS)) {
    sources.push('sportsbet-market');
  }

  return {
    score: Math.min(0.025, score),
    sources,
    reason: reasons.join(' ')
  };
}

function buildEventContext(config, sport, event) {
  return {
    sportKey: sport.key,
    sportLabel: sport.label,
    marketSportKey: sport.marketKey || sport.key,
    eventId: event.id,
    espnEventId: event.espnEventId || '',
    eventName: event.displayName || `${event.away_team} vs ${event.home_team}`,
    homeTeam: event.home_team,
    homeTeamId: event.homeTeamId || '',
    awayTeam: event.away_team,
    awayTeamId: event.awayTeamId || '',
    startTime: event.commence_time,
    venue: event.venue || null,
    weather: event.weather || null,
    timezone: config.timezone,
    bookmakerFallbackProviders: Array.isArray(config.bookmakerFallback?.providers) ? config.bookmakerFallback.providers : [],
    generatorConfig: config.analysis.generator
  };
}

function scoreboardTeamsMatch(scoreboardEvent, event) {
  return teamNamesMatch(scoreboardEvent?.homeTeam, event?.home_team)
    && teamNamesMatch(scoreboardEvent?.awayTeam, event?.away_team);
}

function scoreboardTeamPairsMatch(scoreboardEvent, event) {
  return scoreboardTeamsMatch(scoreboardEvent, event)
    || (
      teamNamesMatch(scoreboardEvent?.homeTeam, event?.away_team)
      && teamNamesMatch(scoreboardEvent?.awayTeam, event?.home_team)
    );
}

function shouldTryPreviousEspnScoreboardDate(sport) {
  return [sport?.key, sport?.marketKey]
    .map((value) => normalizeText(value))
    .some((value) => ESPN_PREVIOUS_DAY_SCOREBOARD_FALLBACK_SPORTS.has(value));
}

function buildEspnScoreboardDateKeys(config, sport, event) {
  const eventDate = new Date(event?.commence_time || '');

  if (Number.isNaN(eventDate.getTime())) {
    return [];
  }

  const dateKeys = [getDateKey(eventDate, config.timezone)];

  if (shouldTryPreviousEspnScoreboardDate(sport)) {
    const previousDateKey = getDateKey(new Date(eventDate.getTime() - 24 * 60 * 60 * 1000), config.timezone);

    if (previousDateKey && !dateKeys.includes(previousDateKey)) {
      dateKeys.push(previousDateKey);
    }
  }

  return dateKeys;
}

function findMatchingScoreboardEvent(scoreboard, event, options = {}) {
  const targetStartTime = event.commence_time ? new Date(event.commence_time).toISOString() : '';
  const targetStartMs = Date.parse(event.commence_time || '');
  const fallbackWindowMs = Number(options.fallbackWindowMs);
  const scoreboardEvents = Array.isArray(scoreboard?.events) ? scoreboard.events : [];
  const matchedEvent = scoreboardEvents.find((scoreboardEvent) => {
    if (!scoreboardEvent) {
      return false;
    }

    const sameTeams = scoreboardTeamsMatch(scoreboardEvent, event);
    const sameTeamPair = scoreboardTeamPairsMatch(scoreboardEvent, event);
    const sameStartTime = scoreboardEvent.startTime
      ? new Date(scoreboardEvent.startTime).toISOString() === targetStartTime
      : false;

    return sameTeams || (sameStartTime && sameTeamPair);
  });

  if (matchedEvent || !Number.isFinite(fallbackWindowMs) || !Number.isFinite(targetStartMs)) {
    return matchedEvent || null;
  }

  let bestFallbackMatch = null;

  for (const scoreboardEvent of scoreboardEvents) {
    if (!scoreboardEvent) {
      continue;
    }

    const sameTeamPair = scoreboardTeamPairsMatch(scoreboardEvent, event);

    if (!sameTeamPair) {
      continue;
    }

    const scoreboardStartMs = Date.parse(scoreboardEvent.startTime || '');

    if (!Number.isFinite(scoreboardStartMs)) {
      continue;
    }

    const startDelta = Math.abs(scoreboardStartMs - targetStartMs);

    if (startDelta > fallbackWindowMs) {
      continue;
    }

    if (!bestFallbackMatch || startDelta < bestFallbackMatch.startDelta) {
      bestFallbackMatch = {
        scoreboardEvent,
        startDelta
      };
    }
  }

  return bestFallbackMatch?.scoreboardEvent || null;
}

export async function enrichEventWithEspnMetadata(config, sport, event, scoreboardCache, overrides = {}) {
  if (!sport?.path || !event?.commence_time) {
    return event;
  }

  const fetchScoreboard = overrides.fetchEspnSlate || fetchEspnSlate;
  const scoreboardDateKeys = buildEspnScoreboardDateKeys(config, sport, event);
  let matchedEvent = null;

  for (const [index, dateKey] of scoreboardDateKeys.entries()) {
    const cacheKey = `${sport.key}:${dateKey}`;

    if (!scoreboardCache.has(cacheKey)) {
      scoreboardCache.set(cacheKey, fetchScoreboard(sport, dateKey));
    }

    let scoreboard;

    try {
      scoreboard = await scoreboardCache.get(cacheKey);
    } catch {
      if (index === 0) {
        return event;
      }

      continue;
    }

    matchedEvent = findMatchingScoreboardEvent(scoreboard, event, {
      sport,
      fallbackWindowMs: index > 0 ? ESPN_PREVIOUS_DAY_SCOREBOARD_MATCH_WINDOW_MS : null
    });

    if (matchedEvent) {
      break;
    }
  }

  if (!matchedEvent) {
    return event;
  }

  return {
    ...event,
    espnEventId: matchedEvent.id || '',
    homeTeamId: matchedEvent.homeTeamId || '',
    awayTeamId: matchedEvent.awayTeamId || '',
    venue: matchedEvent.venue || null
  };
}

async function loadBankrollContext(config) {
  try {
    const summary = await buildDailyTrackerSummary(config);

    return {
      currentBankroll: summary.currentAud ?? null,
      pendingStakeExposure: summary.openExposureUnits ?? null,
      trackerDateKey: getDateKey(new Date(), config.timezone),
      availableUnits: summary.availableUnits ?? null,
      unitSizeAud: summary.unitSizeAud ?? null
    };
  } catch {
    // Fall through to the legacy markdown summary when the tracker CSV is unavailable.
  }

  try {
    const raw = await fs.readFile(config.__paths.profitTrackerFile, 'utf8');
    const currentBankroll = raw.match(/Current Bankroll:\s*\$([\d.]+)/i);
    const pendingStake = raw.match(/Pending Stake Exposure:\s*([\d.]+)/i);

    return {
      currentBankroll: currentBankroll ? Number(currentBankroll[1]) : null,
      pendingStakeExposure: pendingStake ? Number(pendingStake[1]) : null,
      trackerDateKey: getDateKey(new Date(), config.timezone),
      availableUnits: null,
      unitSizeAud: null
    };
  } catch {
    return {
      currentBankroll: null,
      pendingStakeExposure: null,
      trackerDateKey: getDateKey(new Date(), config.timezone),
      availableUnits: null,
      unitSizeAud: null
    };
  }
}

function getMinimumCandidateLegsForSport(config, sportKey) {
  const configuredMinimum = Number(config.analysis.minCandidateLegsPerEvent || 3);
  const normalizedSportKey = String(sportKey || '').toLowerCase();

  if (normalizedSportKey === 'nrl') {
    return Math.min(configuredMinimum, 2);
  }

  if (normalizedSportKey === 'mlb') {
    return Math.min(configuredMinimum, 2);
  }

  if (normalizedSportKey.startsWith('tennis')) {
    return Math.min(configuredMinimum, 1);
  }

  return (normalizedSportKey === 'afl' || normalizedSportKey.startsWith('soccer'))
    ? Math.min(configuredMinimum, 2)
    : configuredMinimum;
}

function buildManualEventKey(sportKey, pick) {
  const eventName = pick?.event || `${pick?.awayTeam || ''} vs ${pick?.homeTeam || ''}`;
  return `${sportKey}::${normalizeText(eventName)}::${pick?.startTime || ''}`;
}

function buildEventKey(sportKey, eventName, startTime) {
  return `${sportKey}::${normalizeText(eventName)}::${startTime || ''}`;
}

function isAvailableInjuryStatus(status) {
  return AVAILABLE_INJURY_STATUSES.has(normalizeText(status));
}

function hasReturnRiskInjuryNote(note) {
  const normalized = normalizeText(note);
  return Boolean(normalized) && RETURN_RISK_NOTE_MARKERS.some((marker) => normalized.includes(marker));
}

function shouldRejectInjuryEntry(injury) {
  if (!injury) {
    return false;
  }

  if (!isAvailableInjuryStatus(injury.status)) {
    return true;
  }

  return hasReturnRiskInjuryNote(injury.note);
}

function buildEmptyResearchMaps() {
  return {
    injuryByPlayer: new Map(),
    playerTeamByName: new Map(),
    unavailableCountByTeam: new Map()
  };
}

function buildInjuryResearchResult(status, reports = [], reasons = []) {
  const { injuryByPlayer, playerTeamByName, unavailableCountByTeam } = buildEmptyResearchMaps();

  for (const report of reports) {
    const normalizedTeamName = normalizeText(report?.teamName);

    for (const injury of report?.injuries || []) {
      const playerName = normalizeText(injury?.playerName);

      if (!playerName) {
        continue;
      }

      injuryByPlayer.set(playerName, injury);

      if (normalizedTeamName) {
        playerTeamByName.set(playerName, report.teamName || '');

        if (shouldRejectInjuryEntry(injury)) {
          unavailableCountByTeam.set(normalizedTeamName, (unavailableCountByTeam.get(normalizedTeamName) || 0) + 1);
        }
      }
    }
  }

  return {
    status,
    reports,
    reasons,
    injuryByPlayer,
    playerTeamByName,
    unavailableCountByTeam
  };
}

function buildEmptyMlbResearchResult(status, reasons = []) {
  return {
    status,
    reasons,
    playersByName: new Map(),
    probablePitcherNames: new Set(),
    teamResearchBySide: new Map(),
    projectedLineupStatus: 'not_requested',
    projectedLineupReasons: [],
    projectedTeamResearchBySide: new Map(),
    playerNewsStatus: 'not_requested',
    playerNewsReasons: [],
    playerNewsByName: new Map()
  };
}

function buildEmptyAflResearchResult(status, reasons = []) {
  return {
    status,
    reasons,
    playerIdsByName: new Map()
  };
}

function findMatchingAflOfficialTeam(teams, teamName) {
  const normalizedTeamName = normalizeText(teamName);

  if (!normalizedTeamName) {
    return null;
  }

  const candidates = (Array.isArray(teams) ? teams : []).filter((team) => {
    if (normalizeText(team?.teamType) !== 'men') {
      return false;
    }

    return normalizeText(team?.name) === normalizedTeamName
      || normalizeText(team?.club?.name) === normalizedTeamName
      || normalizeText(team?.nickname) === normalizedTeamName
      || (normalizedTeamName.length > 3 && normalizeText(team?.name).includes(normalizedTeamName))
      || (normalizedTeamName.length > 3 && normalizeText(team?.club?.name).includes(normalizedTeamName))
      || (normalizedTeamName.length > 3 && normalizeText(team?.nickname).includes(normalizedTeamName));
  });

  if (!candidates.length) {
    return null;
  }

  return candidates.sort((left, right) => {
    const leftExact = normalizeText(left?.name) === normalizedTeamName ? 0 : 1;
    const rightExact = normalizeText(right?.name) === normalizedTeamName ? 0 : 1;
    return leftExact - rightExact;
  })[0];
}

async function loadEventAflResearch(sport, eventContext, researchCaches, overrides = {}) {
  if (normalizeText(sport?.key || eventContext?.sportKey) !== 'afl') {
    return buildEmptyAflResearchResult('not_applicable');
  }

  const aflEventCache = researchCaches?.afl instanceof Map
    ? researchCaches.afl
    : new Map();
  const aflTeamDirectoryCache = researchCaches?.aflTeamDirectory instanceof Map
    ? researchCaches.aflTeamDirectory
    : new Map();
  const aflRosterCache = researchCaches?.aflRoster instanceof Map
    ? researchCaches.aflRoster
    : new Map();
  const cacheKey = `${sport.key}:${normalizeText(eventContext?.homeTeam)}:${normalizeText(eventContext?.awayTeam)}`;

  if (!aflEventCache.has(cacheKey)) {
    const loadTeams = overrides.fetchAflOfficialTeams || fetchAflOfficialTeams;
    const loadRoster = overrides.fetchAflClubTeamRoster || fetchAflClubTeamRoster;
    aflEventCache.set(cacheKey, (async () => {
      if (!aflTeamDirectoryCache.has('teams')) {
        aflTeamDirectoryCache.set('teams', loadTeams());
      }

      let teams;

      try {
        teams = await aflTeamDirectoryCache.get('teams');
      } catch (error) {
        return buildEmptyAflResearchResult('team_directory_error', [error.message]);
      }

      const requestedTeams = [eventContext?.homeTeam, eventContext?.awayTeam]
        .filter(Boolean)
        .map((teamName) => ({
          teamName,
          officialTeam: findMatchingAflOfficialTeam(teams, teamName)
        }));
      const playerIdsByName = new Map();
      const reasons = [];

      for (const requestedTeam of requestedTeams) {
        if (!requestedTeam.officialTeam) {
          reasons.push(`Official AFL team lookup could not match ${requestedTeam.teamName || 'the requested side'}.`);
          continue;
        }

        const clubSiteUrl = String(requestedTeam.officialTeam?.metadata?.clubSiteUrl || '').trim();

        if (!clubSiteUrl) {
          reasons.push(`Official AFL club site URL is missing for ${requestedTeam.teamName || 'the requested side'}.`);
          continue;
        }

        const rosterCacheKey = String(requestedTeam.officialTeam.id || clubSiteUrl);

        if (!aflRosterCache.has(rosterCacheKey)) {
          aflRosterCache.set(rosterCacheKey, loadRoster(clubSiteUrl));
        }

        let roster;

        try {
          roster = await aflRosterCache.get(rosterCacheKey);
        } catch (error) {
          reasons.push(`${requestedTeam.teamName || 'AFL team'} roster lookup failed: ${error.message}`);
          continue;
        }

        if (roster?.status !== 'ok') {
          reasons.push(`${requestedTeam.teamName || 'AFL team'} roster lookup returned ${roster?.status || 'unknown_status'}.`);
        }

        for (const player of Array.isArray(roster?.players) ? roster.players : []) {
          const normalizedPlayerName = normalizePlayerName(player?.playerName);

          if (!normalizedPlayerName) {
            continue;
          }

          const existing = playerIdsByName.get(normalizedPlayerName) || [];

          if (!existing.some((entry) => entry.playerId === player.playerId)) {
            existing.push({
              playerId: String(player.playerId || '').trim(),
              listedTeamName: requestedTeam.teamName || '',
              playerName: player.playerName || '',
              position: player.position || ''
            });
            playerIdsByName.set(normalizedPlayerName, existing);
          }
        }
      }

      return {
        ...(playerIdsByName.size > 0
          ? buildEmptyAflResearchResult('ok', reasons.length ? reasons : [])
          : buildEmptyAflResearchResult(reasons.length ? 'lookup_error' : 'empty_roster', reasons)),
        playerIdsByName
      };
    })());
  }

  return aflEventCache.get(cacheKey);
}

async function enrichAflCandidateConfirmation(candidate, sport, eventContext, aflResearch, researchCaches, overrides = {}) {
  if (normalizeText(sport?.key || eventContext?.sportKey) !== 'afl' || candidate?.family !== 'prop') {
    return candidate;
  }

  const candidateName = normalizePlayerName(candidate?.description);

  if (!candidateName) {
    return {
      ...candidate,
      aflConfirmationBlocked: true,
      aflConfirmationResearchGap: false,
      aflConfirmationReasons: ['AFL prop is missing a player name, so the player-team confirmation check failed.']
    };
  }

  if (aflResearch.status !== 'ok') {
    return {
      ...candidate,
      aflConfirmationBlocked: true,
      aflConfirmationResearchGap: true,
      aflConfirmationReasons: [`Official AFL player-team confirmation is unavailable: ${(aflResearch.reasons || []).join(', ') || aflResearch.status}.`]
    };
  }

  const rosterEntries = Array.isArray(aflResearch.playerIdsByName.get(candidateName))
    ? aflResearch.playerIdsByName.get(candidateName)
    : [];

  if (!rosterEntries.length) {
    return {
      ...candidate,
      aflConfirmationBlocked: true,
      aflConfirmationResearchGap: false,
      aflConfirmationReasons: [`Official AFL club roster pages do not currently list ${candidate.description || candidate.label} for ${eventContext?.eventName || 'this event'}.`]
    };
  }

  const playerCache = researchCaches?.aflPlayer instanceof Map
    ? researchCaches.aflPlayer
    : new Map();
  const profileCache = researchCaches?.aflProfile instanceof Map
    ? researchCaches.aflProfile
    : new Map();
  const loadPlayer = overrides.fetchAflOfficialPlayer || fetchAflOfficialPlayer;
  const loadProfile = overrides.fetchAflStatsProPlayerProfile || fetchAflStatsProPlayerProfile;
  const expectedTeams = new Set([
    normalizeText(eventContext?.homeTeam),
    normalizeText(eventContext?.awayTeam)
  ].filter(Boolean));
  const confirmedMatches = [];
  const resolvedMismatchTeams = [];
  const errors = [];

  for (const rosterEntry of rosterEntries) {
    if (!rosterEntry?.playerId) {
      continue;
    }

    if (!playerCache.has(rosterEntry.playerId)) {
      playerCache.set(rosterEntry.playerId, loadPlayer(rosterEntry.playerId));
    }

    let playerRecord;

    try {
      playerRecord = await playerCache.get(rosterEntry.playerId);
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    const playerProviderId = String(playerRecord?.player?.providerId || '').trim();

    if (!playerProviderId) {
      errors.push(`Official AFL player lookup did not return a provider id for ${rosterEntry.playerName || candidate.description || candidate.label}.`);
      continue;
    }

    if (!profileCache.has(playerProviderId)) {
      profileCache.set(playerProviderId, loadProfile(playerProviderId));
    }

    let playerProfile;

    try {
      playerProfile = await profileCache.get(playerProviderId);
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    const confirmedTeamName = String(playerProfile?.team?.teamName || '').trim();

    if (!confirmedTeamName) {
      errors.push(`Official AFL stats profile did not return a current team for ${rosterEntry.playerName || candidate.description || candidate.label}.`);
      continue;
    }

    if (expectedTeams.has(normalizeText(confirmedTeamName))) {
      confirmedMatches.push({
        teamName: confirmedTeamName,
        playerName: rosterEntry.playerName || candidate.description || candidate.label
      });
      continue;
    }

    resolvedMismatchTeams.push(confirmedTeamName);
  }

  if (confirmedMatches.length) {
    const confirmedMatch = confirmedMatches[0];

    return {
      ...candidate,
      aflConfirmationBlocked: false,
      aflConfirmationResearchGap: false,
      aflConfirmationReasons: [`Official AFL player profile confirms ${confirmedMatch.playerName} is currently listed for ${confirmedMatch.teamName}.`],
      aflConfirmedTeamName: confirmedMatch.teamName
    };
  }

  const mismatchTeams = [...new Set(resolvedMismatchTeams.map((teamName) => String(teamName || '').trim()).filter(Boolean))];

  if (mismatchTeams.length) {
    return {
      ...candidate,
      aflConfirmationBlocked: true,
      aflConfirmationResearchGap: false,
      aflConfirmationReasons: [`Official AFL player profile lists ${candidate.description || candidate.label} on ${mismatchTeams.join(', ')}, not ${eventContext?.homeTeam || 'the home team'} or ${eventContext?.awayTeam || 'the away team'}.`]
    };
  }

  return {
    ...candidate,
    aflConfirmationBlocked: true,
    aflConfirmationResearchGap: true,
    aflConfirmationReasons: errors.length
      ? [`Official AFL player confirmation could not complete for ${candidate.description || candidate.label}: ${errors.join('; ')}`]
      : [`Official AFL player confirmation could not resolve ${candidate.description || candidate.label} for ${eventContext?.eventName || 'this event'}.`]
  };
}

function buildProjectedMlbTeamResearch(lineup, teamSide, fallbackTeamName) {
  const teamName = lineup?.teamName || fallbackTeamName || '';
  const players = Array.isArray(lineup?.players)
    ? lineup.players
      .filter((player) => player?.normalizedPlayerName)
      .map((player) => ({
        ...player,
        teamName,
        teamSide
      }))
    : [];

  return {
    teamName,
    teamSide,
    lineupStatus: lineup?.lineupStatus || null,
    hasProjectedBattingOrder: players.length > 0,
    players,
    playersByName: new Map(players.map((player) => [player.normalizedPlayerName, player]))
  };
}

function buildPlayerNewsMap(entries = []) {
  const newsByPlayerName = new Map();

  for (const entry of entries) {
    if (!entry?.normalizedPlayerName) {
      continue;
    }

    const existing = newsByPlayerName.get(entry.normalizedPlayerName) || [];
    existing.push(entry);
    newsByPlayerName.set(entry.normalizedPlayerName, existing);
  }

  return newsByPlayerName;
}

function buildMlbScheduleDateKeys(startTime) {
  const baseDate = new Date(startTime);

  if (Number.isNaN(baseDate.getTime())) {
    return [];
  }

  return [...new Set([-1, 0, 1]
    .map((offset) => getUtcDateKey(new Date(baseDate.getTime() + offset * 24 * 60 * 60 * 1000)))
    .filter(Boolean))];
}

function findMatchingMlbScheduledGame(scheduleResponses, eventContext) {
  const normalizedHomeTeam = normalizeMlbTeamName(eventContext?.homeTeam);
  const normalizedAwayTeam = normalizeMlbTeamName(eventContext?.awayTeam);
  const targetStartMs = Date.parse(eventContext?.startTime);
  let bestMatch = null;

  for (const schedule of scheduleResponses) {
    for (const dateEntry of schedule?.dates || []) {
      for (const game of dateEntry?.games || []) {
        const homeTeam = normalizeMlbTeamName(game?.teams?.home?.team?.name);
        const awayTeam = normalizeMlbTeamName(game?.teams?.away?.team?.name);

        if (homeTeam !== normalizedHomeTeam || awayTeam !== normalizedAwayTeam) {
          continue;
        }

        const gameStartMs = Date.parse(game?.gameDate);
        const startDelta = Number.isFinite(targetStartMs) && Number.isFinite(gameStartMs)
          ? Math.abs(gameStartMs - targetStartMs)
          : Number.MAX_SAFE_INTEGER;

        if (!bestMatch || startDelta < bestMatch.startDelta) {
          bestMatch = {
            game,
            startDelta
          };
        }
      }
    }
  }

  return bestMatch?.game || null;
}

async function loadEventInjuryResearch(sport, eventContext, injuryCache, overrides = {}) {
  if (!sport?.path || (!eventContext?.homeTeamId && !eventContext?.awayTeamId)) {
    return buildInjuryResearchResult('not_available', [], ['ESPN team metadata is missing for pre-pick injury research.']);
  }

  const cacheKey = `${sport.key}:${eventContext.homeTeamId || ''}:${eventContext.awayTeamId || ''}`;

  if (!injuryCache.has(cacheKey)) {
    const loadTeamInjuries = overrides.fetchEspnTeamInjuries || fetchEspnTeamInjuries;
    injuryCache.set(cacheKey, Promise.all([
      eventContext.homeTeamId ? loadTeamInjuries(sport, eventContext.homeTeamId) : Promise.resolve({ injuries: [], status: 'ok' }),
      eventContext.awayTeamId ? loadTeamInjuries(sport, eventContext.awayTeamId) : Promise.resolve({ injuries: [], status: 'ok' })
    ]).then((reports) => {
      const unavailableReports = reports.filter((report) => {
        const normalizedStatus = normalizeText(report?.status);
        return normalizedStatus && normalizedStatus !== 'ok';
      });
      const coverageReasons = unavailableReports
        .map((report) => `${report?.teamName || report?.teamId || 'team'} returned ${report?.status || 'unknown_status'}`);

      if (coverageReasons.length) {
        const hasOnlyNonFatalStatuses = unavailableReports.length > 0
          && unavailableReports.every((report) => NON_FATAL_INJURY_RESEARCH_STATUSES.has(normalizeText(report?.status)));

        if (hasOnlyNonFatalStatuses) {
          return buildInjuryResearchResult('not_available', reports, coverageReasons);
        }

        return buildInjuryResearchResult('coverage_missing', reports, coverageReasons);
      }

      return buildInjuryResearchResult('ok', reports, []);
    }).catch((error) => buildInjuryResearchResult('lookup_error', [], [error.message])));
  }

  return injuryCache.get(cacheKey);
}

async function loadEventMlbResearch(sport, eventContext, researchCaches, overrides = {}) {
  if (normalizeText(sport?.key || eventContext?.sportKey) !== 'mlb') {
    return buildEmptyMlbResearchResult('not_applicable');
  }

  const researchEventContext = buildMlbResearchEventContext(eventContext);

  const mlbCache = researchCaches?.mlb instanceof Map
    ? researchCaches.mlb
    : new Map();
  const mlbSupportCache = researchCaches?.mlbSupport instanceof Map
    ? researchCaches.mlbSupport
    : new Map();
  const cacheKey = `${sport.key}:${normalizeMlbTeamName(researchEventContext?.homeTeam)}:${normalizeMlbTeamName(researchEventContext?.awayTeam)}:${researchEventContext?.startTime || ''}`;

  if (!mlbCache.has(cacheKey)) {
    const loadSchedule = overrides.fetchMlbSchedule || fetchMlbSchedule;
    const loadGameFeed = overrides.fetchMlbGameFeed || fetchMlbGameFeed;
    const loadRotowireLineups = overrides.fetchRotowireMlbDailyLineups || fetchRotowireMlbDailyLineups;
    const loadRotowireNews = overrides.fetchRotowireMlbNews || fetchRotowireMlbNews;
    mlbCache.set(cacheKey, (async () => {
      const scheduleDateKeys = buildMlbScheduleDateKeys(researchEventContext?.startTime);

      if (!scheduleDateKeys.length) {
        return buildEmptyMlbResearchResult('invalid_start_time', ['MLB start time is missing or invalid for official research.']);
      }

      let schedules;

      try {
        schedules = await Promise.all(scheduleDateKeys.map((dateKey) => loadSchedule(dateKey, {
          hydrate: 'probablePitcher'
        })));
      } catch (error) {
        return buildEmptyMlbResearchResult('schedule_error', [error.message]);
      }

      const matchedGame = findMatchingMlbScheduledGame(schedules, researchEventContext);

      if (!matchedGame?.gamePk) {
        return buildEmptyMlbResearchResult('game_not_found', [`Official MLB schedule could not match ${eventContext?.eventName || 'the current event'}.`]);
      }

      let feed;

      try {
        feed = await loadGameFeed(matchedGame.gamePk);
      } catch (error) {
        return buildEmptyMlbResearchResult('feed_error', [error.message]);
      }

      const lineupPageKey = getRotowireMlbLineupsPageKey(researchEventContext?.startTime);
      const lineupCacheKey = `rotowire-lineups:${lineupPageKey}`;
      const newsCacheKey = 'rotowire-news';

      if (!mlbSupportCache.has(lineupCacheKey)) {
        mlbSupportCache.set(lineupCacheKey, loadRotowireLineups(lineupPageKey)
          .then((data) => ({
            status: 'ok',
            reasons: [],
            ...data
          }))
          .catch((error) => ({
            status: 'lookup_error',
            reasons: [error.message],
            games: []
          })));
      }

      if (!mlbSupportCache.has(newsCacheKey)) {
        mlbSupportCache.set(newsCacheKey, loadRotowireNews()
          .then((data) => ({
            status: 'ok',
            reasons: [],
            ...data
          }))
          .catch((error) => ({
            status: 'lookup_error',
            reasons: [error.message],
            entries: []
          })));
      }

      const [lineupSupport, newsSupport] = await Promise.all([
        mlbSupportCache.get(lineupCacheKey),
        mlbSupportCache.get(newsCacheKey)
      ]);
      const matchedRotowireGame = lineupSupport?.status === 'ok'
        ? findMatchingRotowireMlbGame(lineupSupport, researchEventContext)
        : null;
      const projectedTeamResearchBySide = new Map();

      if (matchedRotowireGame) {
        projectedTeamResearchBySide.set('away', buildProjectedMlbTeamResearch(matchedRotowireGame.away, 'away', researchEventContext?.awayTeam));
        projectedTeamResearchBySide.set('home', buildProjectedMlbTeamResearch(matchedRotowireGame.home, 'home', researchEventContext?.homeTeam));
      }

      return {
        status: 'ok',
        reasons: [],
        ...extractMlbGameResearch(feed),
        projectedLineupStatus: lineupSupport?.status === 'ok'
          ? (matchedRotowireGame ? 'ok' : 'game_not_found')
          : (lineupSupport?.status || 'lookup_error'),
        projectedLineupReasons: lineupSupport?.status === 'ok'
          ? (matchedRotowireGame ? [] : [`RotoWire MLB projected lineups did not list ${eventContext?.eventName || 'this event'}.`])
          : (lineupSupport?.reasons || []),
        projectedTeamResearchBySide,
        playerNewsStatus: newsSupport?.status || 'lookup_error',
        playerNewsReasons: newsSupport?.reasons || [],
        playerNewsByName: buildPlayerNewsMap(newsSupport?.entries || [])
      };
    })());
  }

  return mlbCache.get(cacheKey);
}

function isOutdoorWeatherEligibleEvent(sportKey, venue) {
  if (!OUTDOOR_WEATHER_RESEARCH_SPORTS.has(String(sportKey || '').toLowerCase().trim())) {
    return false;
  }

  const roofType = normalizeText(venue?.roofType);

  if (venue?.indoor === true) {
    return false;
  }

  return !CLOSED_ROOF_MARKERS.some((marker) => roofType.includes(marker));
}

function buildVenueLookupQuery(venue) {
  return [
    venue?.name,
    venue?.city,
    venue?.state,
    venue?.country
  ].filter(Boolean).join(', ');
}

function buildDirectWeatherLocation(venue) {
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

function buildSoftWeatherConcernParts(snapshot) {
  const parts = [];

  if ((Number(snapshot?.precipitationProbability) || 0) >= 55 && (Number(snapshot?.precipitationMm) || 0) >= 0.5) {
    parts.push(`${snapshot.precipitationProbability}% precipitation probability with ${snapshot.precipitationMm}mm forecast precipitation`);
  }

  if ((Number(snapshot?.windSpeedKmh) || 0) >= 28) {
    parts.push(`${snapshot.windSpeedKmh} km/h sustained wind`);
  }

  if ((Number(snapshot?.windGustsKmh) || 0) >= 40) {
    parts.push(`${snapshot.windGustsKmh} km/h wind gusts`);
  }

  return parts;
}

function getWeatherSummaryLabel(snapshot) {
  const weatherCode = Number(snapshot?.weatherCode);
  const precipitationProbability = toNumber(snapshot?.precipitationProbability) ?? 0;
  const precipitationMm = toNumber(snapshot?.precipitationMm) ?? 0;

  if (THUNDER_WEATHER_CODES.has(weatherCode)) {
    return 'Thunderstorms';
  }

  if (SNOW_WEATHER_CODES.has(weatherCode)) {
    return 'Snow';
  }

  if (FOG_WEATHER_CODES.has(weatherCode)) {
    return 'Fog';
  }

  if (WET_WEATHER_CODES.has(weatherCode)) {
    return precipitationMm >= 0.2 || precipitationProbability >= 70 || weatherCode >= 63 || weatherCode >= 80
      ? 'Rain'
      : 'Expected Rain';
  }

  if (precipitationProbability >= 55) {
    return 'Expected Rain';
  }

  if (weatherCode === 1) {
    return 'Mostly Clear';
  }

  if (weatherCode === 2) {
    return 'Partly Cloudy';
  }

  if (weatherCode === 3) {
    return 'Cloudy';
  }

  return 'Clear';
}

export function buildEventWeatherDisplay(weatherResearch) {
  const officialDisplay = weatherResearch?.officialDisplay;
  const snapshot = weatherResearch?.snapshot;

  if (!snapshot) {
    return officialDisplay || null;
  }

  const details = [];
  const temperatureC = toNumber(snapshot.temperatureC);
  const precipitationProbability = toNumber(snapshot.precipitationProbability);
  const precipitationMm = toNumber(snapshot.precipitationMm);
  const windSpeedKmh = toNumber(snapshot.windSpeedKmh);
  const windGustsKmh = toNumber(snapshot.windGustsKmh);

  if (temperatureC !== null) {
    details.push(`${Math.round(temperatureC)}C`);
  }

  if (precipitationProbability !== null && precipitationProbability >= 25) {
    details.push(`${Math.round(precipitationProbability)}% rain`);
  }

  if (precipitationMm !== null && precipitationMm >= 0.2) {
    details.push(`${precipitationMm.toFixed(precipitationMm >= 10 ? 0 : 1)}mm`);
  }

  if (windSpeedKmh !== null) {
    details.push(`Wind ${Math.round(windSpeedKmh)} km/h`);
  }

  if (windGustsKmh !== null && (windSpeedKmh === null || windGustsKmh >= windSpeedKmh + 8)) {
    details.push(`Gusts ${Math.round(windGustsKmh)} km/h`);
  }

  const snapshotDisplay = {
    summary: getWeatherSummaryLabel(snapshot),
    details: details.join(' | '),
    forecastTime: snapshot.forecastTime || '',
    temperatureC,
    precipitationProbability,
    precipitationMm,
    windSpeedKmh,
    windGustsKmh,
    weatherCode: toNumber(snapshot.weatherCode)
  };

  if (!officialDisplay) {
    return snapshotDisplay;
  }

  return {
    ...snapshotDisplay,
    ...officialDisplay,
    details: [officialDisplay.details, snapshotDisplay.details].filter(Boolean).join(' | ')
  };
}

function isNrlSportKey(value) {
  return normalizeText(value) === 'nrl';
}

function nrlOfficialTeamPairsMatch(scoreboardEvent, eventContext) {
  return (
    teamNamesMatch(scoreboardEvent?.homeTeam, eventContext?.homeTeam)
    && teamNamesMatch(scoreboardEvent?.awayTeam, eventContext?.awayTeam)
  ) || (
    teamNamesMatch(scoreboardEvent?.homeTeam, eventContext?.awayTeam)
    && teamNamesMatch(scoreboardEvent?.awayTeam, eventContext?.homeTeam)
  );
}

function findMatchingNrlOfficialEvent(scoreboard, eventContext) {
  const targetStartMs = Date.parse(eventContext?.startTime || '');
  let bestMatch = null;

  for (const officialEvent of Array.isArray(scoreboard?.events) ? scoreboard.events : []) {
    if (!officialEvent || !nrlOfficialTeamPairsMatch(officialEvent, eventContext)) {
      continue;
    }

    const officialStartMs = Date.parse(officialEvent.startTime || '');
    const startDelta = Number.isFinite(targetStartMs) && Number.isFinite(officialStartMs)
      ? Math.abs(officialStartMs - targetStartMs)
      : 0;

    if (Number.isFinite(targetStartMs) && Number.isFinite(officialStartMs) && startDelta > NRL_OFFICIAL_EVENT_MATCH_WINDOW_MS) {
      continue;
    }

    if (!bestMatch || startDelta < bestMatch.startDelta) {
      bestMatch = {
        event: officialEvent,
        startDelta
      };
    }
  }

  return bestMatch?.event || null;
}

function buildNrlOfficialWeatherDisplay(summaryResponse) {
  const match = summaryResponse?.summary?.match || {};
  const summary = String(match?.weather || '').trim();
  const groundConditions = String(match?.groundConditions || '').trim();
  const venueName = String(match?.venue || '').trim();
  const venueCity = String(match?.venueCity || '').trim();
  const details = [];

  if (groundConditions) {
    details.push(`Ground ${groundConditions}`);
  }

  const venueLabel = [venueName, venueCity].filter(Boolean).join(', ');

  if (venueLabel) {
    details.push(venueLabel);
  }

  if (!summary && !details.length) {
    return null;
  }

  return {
    summary: summary || (groundConditions ? `Ground ${groundConditions}` : 'Conditions Available'),
    details: details.join(' | '),
    groundConditions,
    venueName,
    venueCity,
    source: 'official_nrl'
  };
}

export async function loadNrlOfficialWeatherDisplay(sport, eventContext, weatherCache, overrides = {}) {
  if (!isNrlSportKey(sport?.key || eventContext?.sportKey) || !eventContext?.startTime) {
    return null;
  }

  const dateKey = getDateKey(new Date(eventContext.startTime), NRL_OFFICIAL_TIMEZONE);

  if (!dateKey) {
    return null;
  }

  const slateCacheKey = `nrl-official-slate:${dateKey}`;

  if (!weatherCache.has(slateCacheKey)) {
    const loadSlate = overrides.fetchNrlOfficialSlate || fetchNrlOfficialSlate;
    weatherCache.set(slateCacheKey, loadSlate(sport, dateKey, NRL_OFFICIAL_TIMEZONE));
  }

  let slate;

  try {
    slate = await weatherCache.get(slateCacheKey);
  } catch {
    return null;
  }

  const matchedEvent = findMatchingNrlOfficialEvent(slate, eventContext);

  if (!matchedEvent) {
    return null;
  }

  const summaryCacheKey = `nrl-official-summary:${String(matchedEvent.matchCentreUrl || matchedEvent.sourceUrl || matchedEvent.id || '').trim()}`;

  if (!weatherCache.has(summaryCacheKey)) {
    const loadSummary = overrides.fetchNrlOfficialSummary || fetchNrlOfficialSummary;
    weatherCache.set(summaryCacheKey, loadSummary(sport, matchedEvent));
  }

  try {
    return buildNrlOfficialWeatherDisplay(await weatherCache.get(summaryCacheKey));
  } catch {
    return null;
  }
}

function buildWetFieldPlayerPointsRiskParts(candidate, snapshot) {
  if (normalizeText(candidate?.market) !== 'player points') {
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

async function loadEventWeatherResearch(sport, eventContext, weatherCache, overrides = {}) {
  const officialDisplay = await loadNrlOfficialWeatherDisplay(sport, eventContext, weatherCache, overrides);

  if (!isOutdoorWeatherEligibleEvent(sport?.key || eventContext?.sportKey, eventContext?.venue)) {
    return {
      status: 'not_applicable',
      snapshot: null,
      reasons: [],
      officialDisplay
    };
  }

  const directLocation = buildDirectWeatherLocation(eventContext?.venue);
  const venueQuery = buildVenueLookupQuery(eventContext?.venue);

  if (!directLocation && !venueQuery) {
    return {
      status: 'venue_missing',
      snapshot: null,
      reasons: ['Venue metadata is missing for outdoor weather research.'],
      officialDisplay
    };
  }

  const lookupKey = directLocation
    ? `${directLocation.latitude},${directLocation.longitude}`
    : normalizeText(venueQuery);
  const cacheKey = `${sport.key}:${lookupKey}:${eventContext?.startTime || ''}`;

  if (!weatherCache.has(cacheKey)) {
    const geocodeLocation = overrides.geocodeOpenMeteoLocation || geocodeOpenMeteoLocation;
    const fetchForecast = overrides.fetchOpenMeteoForecast || fetchOpenMeteoForecast;
    weatherCache.set(cacheKey, (async () => {
      let location = directLocation;

      if (!location) {
        let locations;

        try {
          locations = await geocodeLocation(venueQuery, {
            count: 1,
            language: 'en'
          });
        } catch (error) {
          return {
            status: 'geocode_error',
            snapshot: null,
            reasons: [error.message],
            officialDisplay
          };
        }

        if (!Array.isArray(locations) || !locations.length) {
          return {
            status: 'location_not_found',
            snapshot: null,
            reasons: [`Open-Meteo could not resolve ${venueQuery}.`],
            officialDisplay
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
        return {
          status: 'forecast_error',
          snapshot: null,
          reasons: [error.message],
          officialDisplay
        };
      }

      const snapshot = buildOpenMeteoEventWeatherSnapshot(forecastResponse?.forecast, eventContext?.startTime);

      if (!snapshot) {
        return {
          status: 'snapshot_missing',
          snapshot: null,
          reasons: ['Open-Meteo did not return a usable event-time weather snapshot.'],
          officialDisplay
        };
      }

      const riskParts = buildWeatherRiskParts(snapshot);

      if (riskParts.length) {
        return {
          status: 'severe_weather',
          snapshot,
          reasons: [riskParts.join(', ')],
          officialDisplay
        };
      }

      return {
        status: 'ok',
        snapshot,
        reasons: [],
        officialDisplay
      };
    })());
  }

  return weatherCache.get(cacheKey);
}

function buildInjuryResearchReason(candidate, injury) {
  const note = String(injury?.note || '').trim();

  if (!isAvailableInjuryStatus(injury?.status)) {
    return `${candidate.description || candidate.label} is ${injury.status}${note ? ` (${note})` : ''} on the ESPN injuries page`;
  }

  return `${candidate.description || candidate.label} still carries a return-risk injury note${note ? ` (${note})` : ''} on the ESPN injuries page`;
}

function isMlbResearchCandidate(sport, candidate) {
  return normalizeText(sport?.key) === 'mlb'
    && candidate?.family === 'prop'
    && MLB_PROP_RESEARCH_MARKETS.has(normalizeMarketKey(candidate?.market));
}

function buildMissingMlbLineupReason(teamName) {
  return `Official MLB batting order is not posted yet for ${teamName || 'the relevant side'}.`;
}

function buildMissingProjectedMlbLineupReason(teamName) {
  return `RotoWire projected MLB lineup is not posted yet for ${teamName || 'the relevant side'}.`;
}

function buildMlbStarterReason(candidate, eventContext) {
  return `${candidate.description || candidate.label} is not listed as an official probable starter for ${eventContext?.eventName || 'this MLB event'}.`;
}

function buildProjectedMlbExclusionReason(candidate, teamResearch) {
  const lineupLabel = teamResearch?.lineupStatus === 'confirmed' ? 'confirmed' : 'expected';
  return `${candidate.description || candidate.label} is not listed in the RotoWire ${lineupLabel} lineup for ${teamResearch?.teamName || 'the relevant side'}.`;
}

function buildProjectedMlbSupportReason(candidate, projectedPlayer, teamResearch) {
  const lineupLabel = teamResearch?.lineupStatus === 'confirmed' ? 'confirmed' : 'expected';
  const battingOrderLabel = projectedPlayer?.battingOrderIndex ? ` batting ${projectedPlayer.battingOrderIndex}` : '';
  return `RotoWire ${lineupLabel} lineup lists ${candidate.description || candidate.label}${battingOrderLabel} for ${teamResearch?.teamName || 'the relevant side'}.`;
}

function buildMlbBottomOrderReason(candidate, battingOrderIndex, teamName, lineupLabel) {
  return `${candidate.description || candidate.label} is batting ${battingOrderIndex} in the ${lineupLabel} lineup for ${teamName || 'the relevant side'}, and safer MLB hit props stay capped to the top ${MLB_SAFE_BATTER_ORDER_MAX}.`;
}

function shouldIncludeMlbSupportingNews(entry) {
  const normalizedHeadline = normalizeText(entry?.headline);
  const normalizedNote = normalizeText(entry?.note);
  const statusTags = Array.isArray(entry?.statusTags) ? entry.statusTags.map((tag) => normalizeText(tag)) : [];

  if (statusTags.some((tag) => tag.includes('injured'))) {
    return true;
  }

  return MLB_SUPPORTING_NEWS_MARKERS.some((marker) => normalizedHeadline.includes(marker) || normalizedNote.includes(marker));
}

function buildMlbSupportingNewsReason(candidate, entry) {
  const headline = entry?.headline || entry?.note || 'Recent update available';
  const timestamp = entry?.timestamp ? ` (${entry.timestamp})` : '';
  return `Recent RotoWire MLB context for ${candidate.description || candidate.label}: ${headline}${timestamp}.`;
}

function buildCandidateResearch(candidate, sport, eventContext, injuryResearch, weatherResearch, mlbResearch, formResearch, externalSignalResearch) {
  const reasons = [];
  let blocked = false;
  let hasVerifiedResearch = false;
  let hasResearchGap = false;
  let hasSoftResearchGap = false;
  let mlbTeamSide = '';
  let mlbTeamName = '';
  let mlbBattingOrderIndex = null;
  let mlbLineupSource = '';

  if (candidate?.family === 'prop') {
    if (injuryResearch.status === 'coverage_missing' || injuryResearch.status === 'lookup_error') {
      blocked = true;
      hasResearchGap = true;
      reasons.push(`Pre-pick ESPN injury research is unavailable: ${(injuryResearch.reasons || []).join(', ') || injuryResearch.status}.`);
    } else if (injuryResearch.status === 'ok') {
      hasVerifiedResearch = true;
      const playerName = normalizeText(candidate?.description);
      const injury = injuryResearch.injuryByPlayer.get(playerName);

      if (shouldRejectInjuryEntry(injury)) {
        blocked = true;
        reasons.push(buildInjuryResearchReason(candidate, injury));
      }

      const playerTeamName = injuryResearch.playerTeamByName.get(playerName);
      const normalizedTeamName = normalizeText(playerTeamName);
      const unavailableTeammates = normalizedTeamName
        ? Math.max(0, (injuryResearch.unavailableCountByTeam.get(normalizedTeamName) || 0) - (shouldRejectInjuryEntry(injury) ? 1 : 0))
        : 0;

      if (unavailableTeammates >= 2) {
        blocked = true;
        reasons.push(`${unavailableTeammates} teammates on ${playerTeamName || 'the same side'} are currently listed unavailable or limited, making the role context too volatile for ${candidate.label}.`);
      }
    } else {
      // ESPN has no injury feed for AFL or NRL, so the gap is structural, not a
      // red flag on the player. Treating it as hard was forcing dataConfidence
      // to low for every NRL kicker-points combo, leaving H2H+total as the only
      // acceptable build. NRL kickers keep the wet-weather block as their guard.
      const researchSportKey = normalizeText(sport?.key || eventContext?.sportKey);

      if (researchSportKey === 'afl' || researchSportKey === 'nrl') {
        hasSoftResearchGap = true;
      } else {
        hasResearchGap = true;
      }
      reasons.push('Pre-pick ESPN injury research is not configured for this event.');
    }
  }

  if (normalizeText(sport?.key || eventContext?.sportKey) === 'afl' && candidate?.family === 'prop') {
    if (candidate?.aflConfirmationBlocked) {
      blocked = true;
      hasResearchGap = hasResearchGap || Boolean(candidate?.aflConfirmationResearchGap);
      reasons.push(...(Array.isArray(candidate?.aflConfirmationReasons) ? candidate.aflConfirmationReasons : []));
    } else if (Array.isArray(candidate?.aflConfirmationReasons) && candidate.aflConfirmationReasons.length) {
      hasVerifiedResearch = true;
      reasons.push(...candidate.aflConfirmationReasons);
    }
  }

  if (isMlbResearchCandidate(sport, candidate)) {
    if (mlbResearch.status !== 'ok') {
      blocked = true;
      hasResearchGap = true;
      reasons.push(`Official MLB starter/lineup research is unavailable: ${(mlbResearch.reasons || []).join(', ') || mlbResearch.status}.`);
    } else {
      hasVerifiedResearch = true;
      const playerName = normalizePlayerName(candidate?.description);
      const matchingPlayers = Array.isArray(mlbResearch.playersByName.get(playerName))
        ? mlbResearch.playersByName.get(playerName)
        : [];
      const normalizedMarket = normalizeMarketKey(candidate?.market);

      if (!matchingPlayers.length) {
        blocked = true;
        reasons.push(`${candidate.description || candidate.label} is not on the official MLB game roster for ${eventContext?.eventName || 'this event'}.`);
      } else if (matchingPlayers.length > 1) {
        blocked = true;
        reasons.push(`Official MLB roster lookup is ambiguous for ${candidate.description || candidate.label}, so the prop cannot be safely validated.`);
      } else {
        const player = matchingPlayers[0];
        const teamResearch = mlbResearch.teamResearchBySide.get(player.teamSide);
        const projectedTeamResearch = mlbResearch.projectedTeamResearchBySide.get(player.teamSide);
        mlbTeamSide = player.teamSide || '';
        mlbTeamName = player.teamName || teamResearch?.teamName || projectedTeamResearch?.teamName || '';

        if (normalizedMarket === 'pitcher_strikeouts') {
          if (!mlbResearch.probablePitcherNames.size) {
            blocked = true;
            hasResearchGap = true;
            reasons.push('Official MLB probable starters are not posted yet for this event.');
          } else if (!mlbResearch.probablePitcherNames.has(player.normalizedPlayerName)) {
            blocked = true;
            reasons.push(buildMlbStarterReason(candidate, eventContext));
          }
        }

        if (MLB_BATTER_RESEARCH_MARKETS.has(normalizedMarket)) {
          if (teamResearch?.hasConfirmedBattingOrder) {
            if (!player.inBattingOrder) {
              blocked = true;
              reasons.push(`${candidate.description || candidate.label} is not in the official batting order for ${player.teamName || 'the relevant side'}.`);
            } else if (player.battingOrderIndex && player.battingOrderIndex > MLB_SAFE_BATTER_ORDER_MAX) {
              blocked = true;
              reasons.push(buildMlbBottomOrderReason(candidate, player.battingOrderIndex, player.teamName, 'official'));
            } else {
              mlbBattingOrderIndex = player.battingOrderIndex || null;
              mlbLineupSource = 'official';
            }
          } else if (projectedTeamResearch?.hasProjectedBattingOrder) {
            const projectedPlayer = projectedTeamResearch.playersByName.get(player.normalizedPlayerName);

            if (!projectedPlayer) {
              blocked = true;
              reasons.push(buildProjectedMlbExclusionReason(candidate, projectedTeamResearch));
            } else {
              reasons.push(buildProjectedMlbSupportReason(candidate, projectedPlayer, projectedTeamResearch));
              mlbTeamName = projectedTeamResearch.teamName || mlbTeamName;
              mlbBattingOrderIndex = projectedPlayer.battingOrderIndex || null;
              mlbLineupSource = projectedTeamResearch.lineupStatus === 'confirmed' ? 'confirmed' : 'projected';

              if (projectedPlayer.battingOrderIndex && projectedPlayer.battingOrderIndex > MLB_SAFE_BATTER_ORDER_MAX) {
                blocked = true;
                reasons.push(buildMlbBottomOrderReason(
                  candidate,
                  projectedPlayer.battingOrderIndex,
                  projectedTeamResearch.teamName,
                  projectedTeamResearch.lineupStatus === 'confirmed' ? 'confirmed' : 'projected'
                ));
              }
            }
          } else {
            const hoursUntilStart = getHoursUntilStart(eventContext?.startTime);
            const missingLineupReason = buildMissingMlbLineupReason(player.teamName);
            const missingProjectedLineupReason = mlbResearch.projectedLineupStatus === 'lookup_error'
              ? `RotoWire projected MLB lineups are unavailable: ${(mlbResearch.projectedLineupReasons || []).join(', ') || mlbResearch.projectedLineupStatus}.`
              : buildMissingProjectedMlbLineupReason(player.teamName);
            hasResearchGap = true;

            if (hoursUntilStart !== null && hoursUntilStart <= MLB_LINEUP_LOCK_HOURS) {
              blocked = true;
              reasons.push(`${missingLineupReason} ${missingProjectedLineupReason} MLB batter props stay closed inside ${MLB_LINEUP_LOCK_HOURS}h of first pitch.`);
            } else {
              reasons.push(missingLineupReason);
              reasons.push(missingProjectedLineupReason);
            }
          }
        }

        const supportingNews = Array.isArray(mlbResearch.playerNewsByName.get(player.normalizedPlayerName))
          ? mlbResearch.playerNewsByName.get(player.normalizedPlayerName).filter((entry) => shouldIncludeMlbSupportingNews(entry)).slice(0, 1)
          : [];

        for (const newsEntry of supportingNews) {
          reasons.push(buildMlbSupportingNewsReason(candidate, newsEntry));
        }
      }
    }
  }

  if (isOutdoorWeatherEligibleEvent(sport?.key || eventContext?.sportKey, eventContext?.venue)) {
    const normalizedSportKey = normalizeText(sport?.key || eventContext?.sportKey);

    if (weatherResearch.status === 'ok') {
      hasVerifiedResearch = true;
      const wetFieldRiskParts = normalizedSportKey === 'nrl'
        ? buildWetFieldPlayerPointsRiskParts(candidate, weatherResearch.snapshot)
        : [];

      if (wetFieldRiskParts.length) {
        blocked = true;
        reasons.push(`Open-Meteo flags wet-field risk for ${candidate.label}: ${wetFieldRiskParts.join(', ')}.`);
      }

      const softWeatherConcernParts = normalizedSportKey === 'mlb' && candidate?.family === 'prop'
        ? buildSoftWeatherConcernParts(weatherResearch.snapshot)
        : [];

      if (softWeatherConcernParts.length) {
        blocked = true;
        reasons.push(`Open-Meteo flags unstable MLB prop weather for ${candidate.label}: ${softWeatherConcernParts.join(', ')}.`);
      }
    } else if (weatherResearch.status === 'geocode_error'
      || weatherResearch.status === 'location_not_found'
      || weatherResearch.status === 'forecast_error'
      || weatherResearch.status === 'snapshot_missing') {
      if (normalizedSportKey === 'mlb') {
        hasResearchGap = true;
        blocked = true;
        reasons.push(`Pre-pick outdoor weather research is unavailable or unsafe: ${(weatherResearch.reasons || []).join(', ') || weatherResearch.status}.`);
      } else {
        hasSoftResearchGap = true;
        reasons.push('Outdoor weather research could not be fully verified before pick generation.');
      }
    } else if (weatherResearch.status === 'severe_weather') {
      blocked = true;
      hasResearchGap = true;
      reasons.push(`Pre-pick outdoor weather research is unavailable or unsafe: ${(weatherResearch.reasons || []).join(', ') || weatherResearch.status}.`);
    } else if (weatherResearch.status === 'venue_missing') {
      // Missing venue metadata should not poison otherwise valid market-structure tickets.
    } else {
      hasResearchGap = true;
      reasons.push('Outdoor weather research could not be fully verified before pick generation.');
    }
  }

  const researchStatus = blocked
    ? 'blocked'
    : hasVerifiedResearch && !hasResearchGap && !hasSoftResearchGap
      ? 'verified'
      : hasVerifiedResearch || hasResearchGap || hasSoftResearchGap
        ? 'partial'
        : (reasons.length ? 'unverified' : 'not_applicable');

  if (researchStatus === 'verified' && !reasons.length) {
    reasons.push('Pre-pick research cleared the currently wired research checks.');
  }

  const formSignal = buildCandidateFormSignal(candidate, eventContext, formResearch);
  const externalSignal = buildCandidateExternalSignal(candidate, externalSignalResearch);

  return {
    ...candidate,
    rationale: researchStatus === 'verified'
      ? `${candidate.rationale} Pre-pick research cleared the currently wired research checks.`
      : candidate.rationale,
    mlbTeamSide,
    mlbTeamName,
    mlbBattingOrderIndex,
    mlbLineupSource,
    researchStatus,
    researchGapSeverity: hasResearchGap ? 'hard' : hasSoftResearchGap ? 'soft' : 'none',
    researchReasons: reasons,
    formSignalScore: formSignal.score,
    formSignalLabel: formSignal.label,
    formSignalReason: formSignal.reason,
    externalSignalScore: externalSignal.score,
    externalSignalSources: externalSignal.sources,
    externalSignalReason: externalSignal.reason
  };
}

export async function filterCandidatePoolForResearch(sport, eventContext, candidatePool, researchCaches, overrides = {}) {
  const injuryCache = researchCaches?.injury instanceof Map
    ? researchCaches.injury
    : (researchCaches instanceof Map ? researchCaches : new Map());
  const weatherCache = researchCaches?.weather instanceof Map
    ? researchCaches.weather
    : new Map();
  const injuryResearch = await loadEventInjuryResearch(sport, eventContext, injuryCache, overrides);
  const mlbResearch = await loadEventMlbResearch(sport, eventContext, researchCaches, overrides);
  const weatherResearch = await loadEventWeatherResearch(sport, eventContext, weatherCache, overrides);
  const formResearch = await loadEventFormResearch(sport, eventContext, researchCaches, overrides);
  eventContext.weather = buildEventWeatherDisplay(weatherResearch) || eventContext.weather || null;
  const aflResearch = await loadEventAflResearch(sport, eventContext, researchCaches, overrides);
  const aflConfirmedPool = await Promise.all(candidatePool.map((candidate) => enrichAflCandidateConfirmation(candidate, sport, eventContext, aflResearch, researchCaches, overrides)));
  const externalSignalResearch = await loadEventExternalSignalResearch(sport, eventContext, aflConfirmedPool, researchCaches, overrides);
  const researchedPool = aflConfirmedPool.map((candidate) => buildCandidateResearch(candidate, sport, eventContext, injuryResearch, weatherResearch, mlbResearch, formResearch, externalSignalResearch));

  return researchedPool.filter((candidate) => candidate.researchStatus !== 'blocked');
}

function getProtectedManualEvents(feed) {
  return new Set((feed?.pending || [])
    .filter((pick) => pick?.source !== 'generated')
    .map((pick) => buildManualEventKey(pick.sportKey || 'unknown', pick)));
}

function isOpenAiQuotaError(error) {
  const status = Number(error?.status);
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return status === 429
    || code.includes('rate_limit')
    || code.includes('insufficient_quota')
    || message.includes('quota')
    || message.includes('rate limit');
}

function resolveAnalysisEngine(config) {
  if (config.analysis.engine === 'auto') {
    return config.openai?.apiKey ? 'openai' : 'rules';
  }

  return config.analysis?.engine || 'rules';
}

export async function runAnalysisJob(context, overrides = {}) {
  const { config, state } = context;
  const now = new Date();
  const loadFeed = overrides.loadFeed || loadRawPicksFeed;
  const saveFeed = overrides.saveFeed || saveRawPicksFeed;
  const analyzeEvent = overrides.analyzeEvent;
  const activeAnalysisEngine = resolveAnalysisEngine(config);

  if (!config.analysis.enabled) {
    state.jobs.analysis = {
      lastRunAt: now.toISOString(),
      skippedReason: 'analysis_disabled'
    };

    return {
      job: 'analysis',
      posted: 0,
      generated: 0,
      considered: 0
    };
  }

  if (activeAnalysisEngine === 'openai' && !config.openai?.apiKey && !analyzeEvent) {
    state.jobs.analysis = {
      lastRunAt: now.toISOString(),
      skippedReason: 'openai_not_configured'
    };

    return {
      job: 'analysis',
      posted: 0,
      generated: 0,
      considered: 0
    };
  }

  const feed = await loadFeed(config.__paths.picksFeedFile);
  const bankrollContext = await loadBankrollContext(config);
  const protectedManualEvents = getProtectedManualEvents(feed);
  const snapshot = overrides.snapshot || await ensureFreshScrapedSnapshot(context, now, {
    force: overrides.forceSnapshotRefresh
  });

  if (!snapshot?.quotes?.length) {
    state.jobs.analysis = {
      lastRunAt: now.toISOString(),
      skippedReason: 'market_scrape_no_quotes'
    };

    return {
      job: 'analysis',
      posted: 0,
      generated: 0,
      considered: 0
    };
  }

  const generatedPicks = [];
  let considered = 0;
  let quotaExceeded = false;
  const scoreboardCache = new Map();
  const researchCaches = {
    afl: new Map(),
    aflPlayer: new Map(),
    aflProfile: new Map(),
    aflRoster: new Map(),
    aflTeamDirectory: new Map(),
    form: new Map(),
    injury: new Map(),
    mlb: new Map(),
    mlbSupport: new Map(),
    sportsbetTargetBet: new Map(),
    weather: new Map()
  };

  for (const sport of config.sports.filter((item) => item.enabled && (item.marketKey || item.key))) {
    const isAfl = normalizeText(sport.key) === 'afl';
    const maxEvents = isAfl ? 10 : Number(config.analysis.maxEventsPerSport || 8);
    const events = buildSnapshotEvents(snapshot, config, sport, now)
      .slice(0, maxEvents);

    if (!events.length) {
      continue;
    }

    for (const event of events) {
      if (quotaExceeded) {
        break;
      }

      const enrichedEvent = await enrichEventWithEspnMetadata(config, sport, event, scoreboardCache, overrides);
      const eventContext = buildEventContext(config, sport, enrichedEvent);
      const eventKey = buildEventKey(sport.key, eventContext.eventName, event.commence_time);

      if (protectedManualEvents.has(eventKey)) {
        continue;
      }

      const snapshotQuotes = Array.isArray(event.snapshotQuotes) && event.snapshotQuotes.length
        ? event.snapshotQuotes
        : getSnapshotEventQuotes(snapshot, config, sport.marketKey || sport.key, event);
      const mergedQuotes = mergeQuoteEntries(snapshotQuotes);
      const isAfl = normalizeText(sport.key) === 'afl';
      const maxCandidateLegs = isAfl ? 24 : Number(config.analysis.maxCandidateLegsPerEvent || 14);
      let candidatePool = buildAnalysisCandidatePool(
        eventContext,
        mergedQuotes,
        maxCandidateLegs
      );
      candidatePool = await filterCandidatePoolForResearch(sport, eventContext, candidatePool, researchCaches, overrides);

      if (candidatePool.length < getMinimumCandidateLegsForSport(config, sport.key)) {
        continue;
      }

      considered += 1;

      try {
        let decision;
        const eventBankrollContext = bankrollContext;

        if (analyzeEvent) {
          decision = await analyzeEvent({
            config,
            eventContext,
            bankrollContext: eventBankrollContext,
            candidatePool,
            activeAnalysisEngine
          });
        } else if (activeAnalysisEngine === 'openai') {
          try {
            decision = await analyzeEventWithOpenAi(context, eventContext, candidatePool, eventBankrollContext);
          } catch (error) {
            if (!isOpenAiQuotaError(error)) {
              throw error;
            }

            quotaExceeded = true;
            console.log(`[analysis] OpenAI quota/rate limit hit for ${eventContext.eventName}; switching to rules fallback for remaining events.`);
            decision = await analyzeEventWithRules(context, eventContext, candidatePool, eventBankrollContext);
          }
        } else if (activeAnalysisEngine === 'rules_priority' || activeAnalysisEngine === 'dual') {
          // Execute Rules Engine first to save tokens
          decision = await analyzeEventWithRules(context, eventContext, candidatePool, eventBankrollContext);
          
          const sportKey = normalizeText(eventContext.sportKey);
          const isAiEligibleSport = sportKey !== 'mlb';
          const needsAiReview = !decision.qualifies || ['low', 'medium'].includes(decision.confidenceTier);

          // Only call OpenAI if rules failed/were weak AND we have a key AND it's a priority sport
          if (needsAiReview && isAiEligibleSport && config.openai?.apiKey && !quotaExceeded) {
            console.log(`[analysis] Rules result for ${eventContext.eventName} was weak/none; elevating to AI review.`);
            try {
              decision = await analyzeEventWithOpenAi(context, eventContext, candidatePool, eventBankrollContext);
            } catch (error) {
              if (isOpenAiQuotaError(error)) quotaExceeded = true;
              // Stay with the rules decision if AI fails
            }
          }
        } else {
          decision = await analyzeEventWithRules(context, eventContext, candidatePool, eventBankrollContext);
        }

        const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

        if (pick) {
          generatedPicks.push(pick);
        }
      } catch (error) {
        console.log(`[analysis] skipped ${eventContext.eventName}: ${error.message}`);
      }
    }
  }

  const mergedFeed = mergeGeneratedPicks(feed, generatedPicks, state);
  await saveFeed(config.__paths.picksFeedFile, mergedFeed);

  state.jobs.analysis = {
    lastRunAt: now.toISOString(),
    generated: generatedPicks.length,
    considered,
    pendingAfterMerge: Array.isArray(mergedFeed.picks) ? mergedFeed.picks.length : 0,
    analysisEngine: activeAnalysisEngine,
    quotaFallbackUsed: quotaExceeded
  };

  return {
    job: 'analysis',
    posted: generatedPicks.length,
    generated: generatedPicks.length,
    considered
  };
}