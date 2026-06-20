/**
 * Player Form Research
 *
 * Builds REAL per-leg evidence for player-prop candidates by assembling each
 * player's recent box-score series (last N finalised games) and measuring it
 * against the candidate's line: rolling average, hit-rate, safe buffer, and
 * recent availability. This is the deterministic, rules-engine equivalent of the
 * "Sport Stats Librarian" + "Conservative SGM Quant" analysis — a prop leg is
 * only "supported" when a high-average player clears the line with a safe buffer
 * and a strong hit-rate (see docs/DEEP-ANALYSIS.md).
 *
 * Pure scoring helpers are fully unit-tested offline; the network loader that
 * fetches box scores is injectable so tests run without hitting providers.
 */

export const PROP_EVIDENCE_STATUS = {
  SUPPORTED: 'supported',
  WEAK: 'weak',
  CONTRA: 'contra',
  UNKNOWN: 'unknown'
};

// Minimum finalised games before a prop can be graded "supported". AFL/NRL run weekly with
// bye rounds + rotation, so even a regular only shows ~3 games in the recent window — 4 was
// throwing out most of the board. The hit-rate + buffer still guard quality.
const DEFAULT_MIN_GAMES = 3;
// Share of recent games the player must have cleared the line.
const DEFAULT_MIN_HIT_RATE = 0.6;

// Safe buffer (average minus line) required per sport+stat — enough that the player clears
// the line comfortably rather than sitting right on it, WITHOUT demanding they smash it.
// (The old AFL disposals floor of 3 meant an 80%-hit-rate 15+ player who averaged 16.4 was
// rejected as "weak" — selection should lean on the hit-rate, with the buffer as a guard.)
const BUFFER_FLOOR = {
  afl: { disposals: 1, goals: 0.5 },
  nrl: { points: 1, tries: 0.5 },
  nba: { points: 1.5, rebounds: 1, assists: 1, threesMade: 0.5, combo: 2 },
  mlb: { hits: 0.3, strikeouts: 0.75 },
  nfl: { passingYards: 12, rushingYards: 8 }
};

/**
 * Map a sport + market to the box-score stat key(s). Combos return several keys
 * that are summed per game (e.g. NBA Points+Rebounds+Assists).
 * @param {string} sport
 * @param {string} market
 * @returns {string[]} stat keys (empty when unsupported)
 */
export function getStatKeysForMarket(sport, market) {
  const sportKey = String(sport || '').toLowerCase();
  const marketKey = String(market || '').toLowerCase();

  switch (sportKey) {
    case 'afl':
      if (marketKey === 'player_disposals') return ['disposals'];
      if (marketKey === 'player_goals') return ['goals'];
      return [];
    case 'nrl':
      if (marketKey === 'player_points') return ['points'];
      if (marketKey === 'player_tries') return ['tries'];
      return [];
    case 'nba':
      switch (marketKey) {
        case 'player_points': return ['points'];
        case 'player_rebounds': return ['rebounds'];
        case 'player_assists': return ['assists'];
        case 'player_threes': return ['threesMade'];
        case 'player_points_rebounds_assists': return ['points', 'rebounds', 'assists'];
        case 'player_points_assists': return ['points', 'assists'];
        case 'player_points_rebounds': return ['points', 'rebounds'];
        case 'player_rebounds_assists': return ['rebounds', 'assists'];
        default: return [];
      }
    case 'mlb':
      if (marketKey === 'batter_hits') return ['hits'];
      if (marketKey === 'pitcher_strikeouts') return ['strikeouts'];
      return [];
    case 'nfl':
      if (marketKey === 'player_pass_yds') return ['passingYards'];
      if (marketKey === 'player_rush_yds') return ['rushingYards'];
      return [];
    default:
      return [];
  }
}

/**
 * Resolve the buffer floor for a sport + stat keys (combos use the 'combo' floor).
 */
function getBufferFloor(sport, statKeys) {
  const sportFloors = BUFFER_FLOOR[String(sport || '').toLowerCase()] || {};
  if (statKeys.length > 1) {
    return Number(sportFloors.combo ?? 2);
  }
  return Number(sportFloors[statKeys[0]] ?? 1);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Pull a player's combined stat value from one game's box-score rows.
 * Returns null if the player isn't found or any component stat is missing.
 * @param {Array} playerRows - one game's playerStats (array of { playerName, ...stats })
 * @param {string} playerName
 * @param {string[]} statKeys
 * @returns {number|null}
 */
export function extractPlayerGameValue(playerRows, playerName, statKeys) {
  const wanted = String(playerName || '').trim().toLowerCase();
  if (!wanted || !Array.isArray(playerRows) || !statKeys.length) {
    return null;
  }

  const row = playerRows.find((entry) =>
    String(entry?.playerName || entry?.name || '').trim().toLowerCase() === wanted);
  if (!row) {
    return null;
  }

  let total = 0;
  for (const key of statKeys) {
    const value = toNumber(row[key] ?? row.statValues?.[key]);
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

/**
 * Build a player's stat series (most-recent first) from ordered game box scores.
 * @param {Array<Array>} gameBoxscores - most-recent-first list of per-game playerStats arrays
 * @param {string} playerName
 * @param {string[]} statKeys
 * @returns {number[]}
 */
export function buildPlayerStatSeries(gameBoxscores, playerName, statKeys) {
  const series = [];
  for (const playerRows of Array.isArray(gameBoxscores) ? gameBoxscores : []) {
    const value = extractPlayerGameValue(playerRows, playerName, statKeys);
    if (value !== null) {
      series.push(value);
    }
  }
  return series;
}

function average(values) {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Compute prop evidence for a player series vs a line.
 * @param {Object} input
 * @param {number[]} input.series - stat values, most-recent first
 * @param {number} input.line - the candidate's line
 * @param {string} input.side - 'over' | 'under' | 'at least'
 * @param {string} input.sport
 * @param {string[]} input.statKeys
 * @param {Object} [input.options] - { minGames, minHitRate }
 * @returns {Object} evidence { status, average, hitRate, buffer, gamesPlayed, trend, score, reason }
 */
export function computePropEvidence({ series = [], line, side, sport, statKeys = [], options = {} }) {
  const minGames = Number(options.minGames ?? DEFAULT_MIN_GAMES);
  const minHitRate = Number(options.minHitRate ?? DEFAULT_MIN_HIT_RATE);
  const lineValue = toNumber(line);
  const gamesPlayed = series.length;

  const base = {
    status: PROP_EVIDENCE_STATUS.UNKNOWN,
    average: average(series),
    hitRate: null,
    buffer: null,
    gamesPlayed,
    trend: null,
    score: 0,
    reason: ''
  };

  if (lineValue === null || !statKeys.length) {
    return { ...base, reason: 'No line or stat mapping for this market.' };
  }

  if (gamesPlayed < minGames) {
    return {
      ...base,
      reason: `Only ${gamesPlayed} finalised game(s) found; need ${minGames} to judge form.`
    };
  }

  const normalizedSide = String(side || '').toLowerCase();
  const isUnder = normalizedSide === 'under';
  const isAtLeast = normalizedSide === 'at least' || normalizedSide === 'at_least';

  // Hit = leg would have won in that game.
  const hits = series.filter((value) => {
    if (isUnder) return value < lineValue;
    if (isAtLeast) return value >= lineValue;
    return value > lineValue; // over
  }).length;
  const hitRate = hits / gamesPlayed;
  const avg = base.average;
  const buffer = isUnder ? lineValue - avg : avg - lineValue;
  const floor = getBufferFloor(sport, statKeys);

  // Recent trend: last 3 vs prior games (positive = improving toward the side).
  const recent = average(series.slice(0, Math.min(3, gamesPlayed)));
  const trendDelta = recent !== null && avg !== null ? recent - avg : 0;
  const trend = isUnder ? -trendDelta : trendDelta;

  const evidence = { ...base, hitRate, buffer, trend };

  // Contra: the data clearly opposes the leg (player typically lands the wrong side).
  if (hitRate <= 0.35 || buffer <= -floor) {
    return {
      ...evidence,
      status: PROP_EVIDENCE_STATUS.CONTRA,
      score: -3,
      reason: `Recent form opposes the line (hit-rate ${(hitRate * 100).toFixed(0)}%, buffer ${buffer.toFixed(1)}).`
    };
  }

  // Supported: comfortable buffer AND strong hit-rate over a real sample.
  if (buffer >= floor && hitRate >= minHitRate) {
    const score = 2 + Math.min(2, buffer / Math.max(floor, 1)) + Math.max(0, trend > 0 ? 0.5 : 0);
    return {
      ...evidence,
      status: PROP_EVIDENCE_STATUS.SUPPORTED,
      score: Math.min(5, Number(score.toFixed(2))),
      reason: `Averages ${avg.toFixed(1)} vs ${lineValue} line (buffer ${buffer.toFixed(1)}), cleared in ${hits}/${gamesPlayed}.`
    };
  }

  // Weak: some support but not enough buffer or hit-rate to lean on.
  return {
    ...evidence,
    status: PROP_EVIDENCE_STATUS.WEAK,
    score: hitRate >= 0.5 ? 0.5 : -0.5,
    reason: `Marginal: hit-rate ${(hitRate * 100).toFixed(0)}%, buffer ${buffer.toFixed(1)} (floor ${floor}).`
  };
}

/**
 * Load each team's recent finalised game box scores (most-recent first).
 * Injectable: pass overrides.loadTeamBoxscores in tests to avoid network.
 * @param {Object} sport - config.sports entry
 * @param {Object} eventContext
 * @param {Object} deps - { providers, cache, now, maxGames, lookbackDays }
 * @returns {Promise<Map<string, Array<Array>>>} side ('home'|'away') -> game box scores
 */
export async function loadEventTeamBoxscores(sport, eventContext, deps = {}) {
  if (typeof deps.loadTeamBoxscores === 'function') {
    return deps.loadTeamBoxscores(sport, eventContext, deps);
  }
  // Default network loader is provided by the analysis wiring (kept out of this
  // module so the pure scoring stays trivially testable). Without it, return
  // empty so every leg resolves "unknown" and (after the flip) NO BET.
  return new Map();
}

/**
 * Build player-form evidence for every prop candidate in the pool.
 * @param {Object} sport
 * @param {Object} eventContext
 * @param {Array} candidatePool
 * @param {Object} deps - { loadTeamBoxscores, sideForCandidate, options }
 * @returns {Promise<Map<string, Object>>} candidate.key -> evidence
 */
export async function loadEventPlayerFormEvidence(sport, eventContext, candidatePool, deps = {}) {
  const evidenceByKey = new Map();
  const propCandidates = (candidatePool || []).filter((candidate) =>
    candidate?.family === 'prop' && getStatKeysForMarket(sport?.key || eventContext?.sportKey, candidate.market).length);

  if (!propCandidates.length) {
    return evidenceByKey;
  }

  const boxscoresBySide = await loadEventTeamBoxscores(sport, eventContext, deps);

  for (const candidate of propCandidates) {
    const statKeys = getStatKeysForMarket(sport?.key || eventContext?.sportKey, candidate.market);
    const side = typeof deps.sideForCandidate === 'function'
      ? deps.sideForCandidate(candidate, eventContext)
      : null;
    const games = side && boxscoresBySide.get(side)
      ? boxscoresBySide.get(side)
      : [...(boxscoresBySide.get('home') || []), ...(boxscoresBySide.get('away') || [])];

    const series = buildPlayerStatSeries(games, candidate.description, statKeys);
    const evidence = computePropEvidence({
      series,
      line: candidate.point,
      side: candidate.outcomeName,
      sport: sport?.key || eventContext?.sportKey,
      statKeys,
      options: deps.options
    });

    evidenceByKey.set(candidate.key, evidence);
  }

  return evidenceByKey;
}

export const __testables = {
  getStatKeysForMarket,
  getBufferFloor,
  extractPlayerGameValue,
  buildPlayerStatSeries,
  computePropEvidence,
  PROP_EVIDENCE_STATUS
};
