/**
 * Promos Grading Module
 *
 * Grades promo legs against finalized event results and produces the
 * `legResults` array that promos-settlement consumes.
 *
 * Grading is split into two layers:
 *  1. Pure graders (fully unit-tested): given a leg + a normalized event
 *     summary, decide win/loss/push and (for player lines) the miss margin.
 *  2. A provider-backed fetcher: reuses the same result providers the main
 *     results job uses. On ANY uncertainty it returns no result, so the leg
 *     stays unresolved rather than being mis-graded.
 */

import { fetchAflOfficialSlate, fetchAflOfficialSummary } from './providers/afl-official.mjs';
import { fetchNrlOfficialSlate, fetchNrlOfficialSummary } from './providers/nrl-official.mjs';
import { fetchEspnSlate } from './providers/espn.mjs';
import { fetchFlashscoreSlate } from './providers/flashscore.mjs';
import { getDateKey } from './scheduler.mjs';
import { teamNamesMatch } from './team-name-matching.mjs';

export const LEG_RESULT = {
  WIN: 'win',
  LOSS: 'loss',
  VOID: 'void'
};

const OVER_SIDES = new Set(['over', 'at least', 'at_least', 'plus']);
const UNDER_SIDES = new Set(['under']);

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Grade a head-to-head (match-winner) leg.
 * @param {Object} leg - promo leg with `.team` (or `.selection`)
 * @param {Object} summary - { status:'final', homeTeam, awayTeam, homeScore, awayScore }
 * @returns {{ outcome: string }|null} null when not yet gradable
 */
export function gradeH2hLeg(leg, summary) {
  if (!leg || !summary || String(summary.status || '').toLowerCase() !== 'final') {
    return null;
  }

  const homeScore = toNumber(summary.homeScore);
  const awayScore = toNumber(summary.awayScore);
  if (homeScore === null || awayScore === null) {
    return null;
  }

  const pick = String(leg.team || leg.selection || '').trim();
  if (!pick) {
    return null;
  }

  if (homeScore === awayScore) {
    // A drawn match voids a 2-way match-winner leg (stake returned for that leg).
    return { outcome: LEG_RESULT.VOID };
  }

  const winner = homeScore > awayScore ? summary.homeTeam : summary.awayTeam;
  const picksWinner = teamNamesMatch(pick, winner);

  return { outcome: picksWinner ? LEG_RESULT.WIN : LEG_RESULT.LOSS };
}

/**
 * Grade a player line prop (over/under/at-least a number).
 * Also reports `missBy` for losses so margin-forgiveness rules can regrade.
 * @param {Object} leg - { player, side, point }
 * @param {Object} summary - { status:'final', players:[{ name, value }] } OR a stat lookup
 * @returns {{ outcome: string, missBy?: number }|null}
 */
export function gradePlayerTotalLeg(leg, summary) {
  if (!leg || !summary || String(summary.status || '').toLowerCase() !== 'final') {
    return null;
  }

  const line = toNumber(leg.point);
  if (line === null) {
    return null;
  }

  const actual = toNumber(resolvePlayerStatValue(leg, summary));
  if (actual === null) {
    return null;
  }

  const side = String(leg.side || '').toLowerCase();
  const isUnder = UNDER_SIDES.has(side);
  const isOver = OVER_SIDES.has(side) || (!isUnder);

  if (isUnder) {
    if (actual < line) {
      return { outcome: LEG_RESULT.WIN };
    }
    if (actual === line) {
      return { outcome: LEG_RESULT.VOID };
    }
    return { outcome: LEG_RESULT.LOSS, missBy: actual - line };
  }

  // Over / at-least.
  if (side === 'at least' || side === 'at_least') {
    return actual >= line
      ? { outcome: LEG_RESULT.WIN }
      : { outcome: LEG_RESULT.LOSS, missBy: line - actual };
  }

  if (isOver) {
    if (actual > line) {
      return { outcome: LEG_RESULT.WIN };
    }
    if (actual === line) {
      return { outcome: LEG_RESULT.VOID };
    }
    return { outcome: LEG_RESULT.LOSS, missBy: line - actual };
  }

  return null;
}

/**
 * Pull a player's stat value out of a normalized summary.
 * Accepts either a players array ([{ name, value }]) or a name->value map.
 */
function resolvePlayerStatValue(leg, summary) {
  const playerName = String(leg.player || '').trim().toLowerCase();
  if (!playerName) {
    return null;
  }

  if (Array.isArray(summary.players)) {
    const match = summary.players.find((entry) =>
      String(entry?.name || '').trim().toLowerCase() === playerName);
    return match ? (match.value ?? match.stat ?? null) : null;
  }

  if (summary.playerStats && typeof summary.playerStats === 'object') {
    return summary.playerStats[leg.player] ?? summary.playerStats[playerName] ?? null;
  }

  return null;
}

/**
 * Grade any promo leg against a normalized summary.
 * @param {Object} leg
 * @param {Object} summary
 * @returns {{ outcome: string, missBy?: number }|null}
 */
export function gradePromoLeg(leg, summary) {
  if (String(leg?.market || '').toLowerCase() === 'h2h') {
    return gradeH2hLeg(leg, summary);
  }
  return gradePlayerTotalLeg(leg, summary);
}

/**
 * Fetch finalized results for a set of promo legs and grade them.
 * Reuses the main result providers; designed to fail safe (unknown => skip).
 *
 * @param {Object} context - { config }
 * @param {Array} legs - slip legs (carry market/player/team/point/side/odds + event identity)
 * @param {Object} [overrides] - { fetchSummaryForLeg } injectable for tests
 * @returns {Promise<Array>} legResults consumable by settlePromoSlip
 */
export async function fetchPromoLegResults(context, legs = [], overrides = {}) {
  const fetchSummaryForLeg = overrides.fetchSummaryForLeg
    || ((leg) => resolveLegSummary(context, leg, overrides));

  const results = [];

  for (const leg of legs) {
    try {
      const summary = await fetchSummaryForLeg(leg);
      if (!summary) {
        continue;
      }

      const graded = gradePromoLeg(leg, summary);
      if (!graded || !graded.outcome) {
        continue;
      }

      results.push({
        player: leg.player || '',
        team: leg.team || '',
        market: leg.market,
        odds: leg.odds,
        outcome: graded.outcome,
        missBy: graded.missBy,
        source: summary.source || 'provider'
      });
    } catch (error) {
      // Fail safe: an errored fetch leaves the leg unresolved.
      console.error(`[promos-grading] Failed to grade leg ${leg?.id || ''}: ${error.message}`);
    }
  }

  return results;
}

/**
 * Map a sport + market to the official box-score stat key (mirrors results.mjs).
 * @param {string} sport
 * @param {string} market
 * @returns {string}
 */
export function promoStatKeyFor(sport, market) {
  const sportKey = String(sport || '').toLowerCase();
  const marketKey = String(market || '').toLowerCase();

  if (sportKey === 'afl' && marketKey === 'player_disposals') {
    return 'disposals';
  }
  if (sportKey === 'nrl' && marketKey === 'player_points') {
    return 'points';
  }
  return '';
}

/**
 * Does a finalized scoreboard event correspond to this leg's match?
 * Matches on team names in either orientation.
 */
function scoreboardEventMatchesLeg(event, leg) {
  if (!event) {
    return false;
  }
  const straight = teamNamesMatch(event.homeTeam, leg.homeTeam) && teamNamesMatch(event.awayTeam, leg.awayTeam);
  const swapped = teamNamesMatch(event.homeTeam, leg.awayTeam) && teamNamesMatch(event.awayTeam, leg.homeTeam);
  return straight || swapped;
}

/**
 * Candidate result sources per sport, mirroring jobs/results.mjs wiring.
 * Each source: { fetchScoreboard, fetchSummary? }.
 */
function buildPromoSettlementSources(sport, overrides = {}) {
  const espn = { fetchScoreboard: overrides.fetchEspnSlate || fetchEspnSlate };
  const flashscore = { fetchScoreboard: overrides.fetchFlashscoreSlate || fetchFlashscoreSlate };

  switch (String(sport || '').toLowerCase()) {
    case 'afl':
      return [
        {
          fetchScoreboard: overrides.fetchAflOfficialSlate || fetchAflOfficialSlate,
          fetchSummary: overrides.fetchAflOfficialSummary || fetchAflOfficialSummary,
          label: 'Official AFL'
        },
        { ...flashscore, label: 'Flashscore' },
        { ...espn, label: 'ESPN' }
      ];
    case 'nrl':
      return [
        {
          fetchScoreboard: overrides.fetchNrlOfficialSlate || fetchNrlOfficialSlate,
          fetchSummary: overrides.fetchNrlOfficialSummary || fetchNrlOfficialSummary,
          label: 'Official NRL'
        },
        { ...flashscore, label: 'Flashscore' },
        { ...espn, label: 'ESPN' }
      ];
    default:
      return [{ ...espn, label: 'ESPN' }, { ...flashscore, label: 'Flashscore' }];
  }
}

/**
 * Date keys to probe for a leg's result (event day, plus the next day to cover
 * late finishes crossing midnight in the configured timezone).
 */
function buildLegDateKeys(commenceTime, timezone) {
  const eventDate = new Date(commenceTime || '');
  if (Number.isNaN(eventDate.getTime())) {
    return [getDateKey(new Date(), timezone)];
  }
  const keys = [getDateKey(eventDate, timezone)];
  const nextDay = getDateKey(new Date(eventDate.getTime() + 24 * 60 * 60 * 1000), timezone);
  if (!keys.includes(nextDay)) {
    keys.push(nextDay);
  }
  return keys;
}

/**
 * Normalize an official summary's player stat rows into [{ name, value }] for a stat key.
 */
function buildPlayersForStat(playerStats, statKey) {
  const rows = Array.isArray(playerStats) ? playerStats : [];
  return rows
    .map((row) => ({
      name: row?.playerName || row?.name || '',
      value: row?.[statKey] ?? row?.statValues?.[statKey] ?? null
    }))
    .filter((entry) => entry.name && entry.value !== null);
}

/**
 * Resolve a finalized, normalized event summary for a leg by reusing the same
 * result providers as the main results job. Returns null on any uncertainty
 * (no finalized match, ambiguous teams, missing stats) so the leg stays
 * unresolved rather than being mis-graded.
 * Network-bound; only invoked on the daemon path (tests inject summaries).
 */
async function resolveLegSummary(context, leg, overrides = {}) {
  const config = context?.config;
  const sport = String(leg?.sport || '').toLowerCase();
  if (!config || !sport) {
    return null;
  }

  const sportConfig = (config.sports || []).find((entry) =>
    String(entry.key || entry.marketKey || '').toLowerCase() === sport) || { key: sport, label: sport };
  const isH2h = String(leg.market || '').toLowerCase() === 'h2h';
  const statKey = isH2h ? '' : promoStatKeyFor(sport, leg.market);

  // A player-prop leg we can't map to a known stat key is left for manual review.
  if (!isH2h && !statKey) {
    return null;
  }

  const dateKeys = buildLegDateKeys(leg.commenceTime, config.timezone);

  for (const source of buildPromoSettlementSources(sport, overrides)) {
    for (const dateKey of dateKeys) {
      let scoreboard;
      try {
        scoreboard = await source.fetchScoreboard(sportConfig, dateKey, config.timezone);
      } catch {
        continue;
      }

      const event = (scoreboard?.events || []).find((candidate) =>
        scoreboardEventMatchesLeg(candidate, leg) && String(candidate.state || '').toLowerCase() === 'post');

      if (!event) {
        continue;
      }

      const base = {
        status: 'final',
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        homeScore: event.homeScore,
        awayScore: event.awayScore,
        source: source.label
      };

      if (isH2h) {
        return base;
      }

      // Player prop: pull the box score from this source's summary.
      if (!source.fetchSummary) {
        continue;
      }

      let summary;
      try {
        summary = await source.fetchSummary(sportConfig, event, config.timezone);
      } catch {
        return null;
      }

      const players = buildPlayersForStat(summary?.playerStats, statKey);
      if (!players.length) {
        return null;
      }

      return { ...base, players };
    }
  }

  return null;
}

export const __testables = {
  gradeH2hLeg,
  gradePlayerTotalLeg,
  gradePromoLeg,
  resolvePlayerStatValue,
  promoStatKeyFor,
  buildPlayersForStat,
  scoreboardEventMatchesLeg,
  LEG_RESULT
};
