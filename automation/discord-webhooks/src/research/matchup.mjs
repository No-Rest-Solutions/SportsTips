/**
 * Matchup Research
 *
 * Builds REAL per-leg evidence for TEAM markets (head-to-head, totals) from
 * finalised game results: recent form differential, head-to-head record,
 * home/away strength, and scoring trends. A team-market leg is only "supported"
 * when the chosen side/total has a clear, consistent edge — otherwise it is weak
 * or contra, which (after the hard gate is wired) keeps generic H2H/totals legs
 * like "Wests Tigers H2H" out of slips. See docs/DEEP-ANALYSIS.md.
 *
 * Pure scoring helpers are unit-tested offline; the network loader is injectable.
 */

export const MATCHUP_EVIDENCE_STATUS = {
  SUPPORTED: 'supported',
  WEAK: 'weak',
  CONTRA: 'contra',
  UNKNOWN: 'unknown'
};

const DEFAULT_MIN_GAMES = 3;
// Form edge (win-rate difference) needed to back a side on H2H.
const DEFAULT_MIN_WINRATE_EDGE = 0.2;

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function average(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

/**
 * Summarise a team's recent finalised games.
 * @param {Array} games - [{ scored, conceded, won }] most-recent first
 * @returns {Object|null}
 */
export function computeTeamFormSummary(games) {
  const rows = (Array.isArray(games) ? games : [])
    .map((game) => ({
      scored: toNumber(game?.scored),
      conceded: toNumber(game?.conceded)
    }))
    .filter((game) => game.scored !== null && game.conceded !== null);

  if (!rows.length) {
    return null;
  }

  const wins = rows.filter((game) => game.scored > game.conceded).length;
  const avgFor = average(rows.map((game) => game.scored));
  const avgAgainst = average(rows.map((game) => game.conceded));

  return {
    games: rows.length,
    wins,
    winRate: wins / rows.length,
    avgFor,
    avgAgainst,
    avgMargin: avgFor - avgAgainst,
    avgTotal: avgFor + avgAgainst
  };
}

/**
 * Summarise a head-to-head record for the picked team.
 * @param {Array} meetings - [{ pickedWon: boolean }]
 * @returns {Object} { games, pickedWins, pickedWinRate }
 */
export function computeH2hRecord(meetings) {
  const rows = Array.isArray(meetings) ? meetings : [];
  const pickedWins = rows.filter((meeting) => meeting?.pickedWon).length;
  return {
    games: rows.length,
    pickedWins,
    pickedWinRate: rows.length ? pickedWins / rows.length : null
  };
}

/**
 * Evidence for a head-to-head (match-winner) leg.
 * @param {Object} input - { teamForm, oppForm, h2h, isHome, options }
 * @returns {Object} evidence
 */
export function computeH2hEvidence({ teamForm, oppForm, h2h = null, isHome = null, options = {} }) {
  const minGames = Number(options.minGames ?? DEFAULT_MIN_GAMES);
  const minEdge = Number(options.minWinRateEdge ?? DEFAULT_MIN_WINRATE_EDGE);

  const base = {
    status: MATCHUP_EVIDENCE_STATUS.UNKNOWN,
    formEdge: null,
    marginEdge: null,
    h2hWinRate: h2h?.pickedWinRate ?? null,
    score: 0,
    reason: ''
  };

  if (!teamForm || !oppForm || teamForm.games < minGames || oppForm.games < minGames) {
    return { ...base, reason: 'Not enough finalised games for both teams.' };
  }

  const formEdge = teamForm.winRate - oppForm.winRate;
  const marginEdge = teamForm.avgMargin - oppForm.avgMargin;
  const evidence = { ...base, formEdge, marginEdge };

  // Contra: we'd be backing the clearly weaker side.
  if (formEdge <= -minEdge && marginEdge < 0) {
    return {
      ...evidence,
      status: MATCHUP_EVIDENCE_STATUS.CONTRA,
      score: -3,
      reason: `Backs the weaker side (form edge ${(formEdge * 100).toFixed(0)}%, margin edge ${marginEdge.toFixed(1)}).`
    };
  }

  const h2hFavours = h2h?.pickedWinRate === null || h2h?.pickedWinRate === undefined
    ? true
    : h2h.pickedWinRate >= 0.5;
  const homePenalty = isHome === false ? minEdge / 2 : 0; // away sides need a bigger edge

  // Supported: clear form + margin edge, H2H not against us, edge survives away penalty.
  if (formEdge >= (minEdge + homePenalty) && marginEdge > 0 && h2hFavours) {
    const score = 2 + Math.min(2, formEdge / Math.max(minEdge, 0.01)) + (isHome ? 0.5 : 0);
    return {
      ...evidence,
      status: MATCHUP_EVIDENCE_STATUS.SUPPORTED,
      score: Math.min(5, Number(score.toFixed(2))),
      reason: `Form edge ${(formEdge * 100).toFixed(0)}%, margin edge ${marginEdge.toFixed(1)}${isHome ? ', at home' : ''}.`
    };
  }

  return {
    ...evidence,
    status: MATCHUP_EVIDENCE_STATUS.WEAK,
    score: formEdge > 0 ? 0.5 : -0.5,
    reason: `No clear edge (form ${(formEdge * 100).toFixed(0)}%, margin ${marginEdge.toFixed(1)}).`
  };
}

/**
 * Evidence for a totals (over/under) leg.
 * @param {Object} input - { homeForm, awayForm, line, side, options }
 * @returns {Object} evidence
 */
export function computeTotalsEvidence({ homeForm, awayForm, line, side, options = {} }) {
  const minGames = Number(options.minGames ?? DEFAULT_MIN_GAMES);
  const buffer = Number(options.totalsBuffer ?? 0);
  const lineValue = toNumber(line);
  const normalizedSide = String(side || '').toLowerCase();

  const base = {
    status: MATCHUP_EVIDENCE_STATUS.UNKNOWN,
    projectedTotal: null,
    score: 0,
    reason: ''
  };

  if (!homeForm || !awayForm || homeForm.games < minGames || awayForm.games < minGames || lineValue === null) {
    return { ...base, reason: 'Not enough finalised games or no line.' };
  }
  if (normalizedSide !== 'over' && normalizedSide !== 'under') {
    return { ...base, reason: `Unsupported totals side: ${side}.` };
  }

  // Projected total blends each team's recent game totals.
  const projectedTotal = average([homeForm.avgTotal, awayForm.avgTotal]);
  const margin = normalizedSide === 'over' ? projectedTotal - lineValue : lineValue - projectedTotal;
  const evidence = { ...base, projectedTotal };

  if (margin <= -Math.max(buffer, 1)) {
    return {
      ...evidence,
      status: MATCHUP_EVIDENCE_STATUS.CONTRA,
      score: -3,
      reason: `Recent scoring opposes ${normalizedSide} ${lineValue} (projected ${projectedTotal.toFixed(1)}).`
    };
  }

  if (margin >= Math.max(buffer, 1)) {
    return {
      ...evidence,
      status: MATCHUP_EVIDENCE_STATUS.SUPPORTED,
      score: 2 + Math.min(2, margin / 10),
      reason: `Projected total ${projectedTotal.toFixed(1)} vs ${lineValue} favours ${normalizedSide}.`
    };
  }

  return {
    ...evidence,
    status: MATCHUP_EVIDENCE_STATUS.WEAK,
    score: 0,
    reason: `Projected total ${projectedTotal.toFixed(1)} sits near the ${lineValue} line.`
  };
}

/**
 * Evidence for a spread / line leg (e.g. NRL "protected plus line").
 * @param {Object} input - { teamForm, oppForm, line, isHome, options }
 *   line is the picked side's handicap (e.g. +4.5 protects a 4-point loss).
 * @returns {Object} evidence
 */
export function computeSpreadEvidence({ teamForm, oppForm, line, isHome = null, options = {} }) {
  const minGames = Number(options.minGames ?? DEFAULT_MIN_GAMES);
  const buffer = Number(options.spreadBuffer ?? 2);
  const lineValue = toNumber(line);

  const base = {
    status: MATCHUP_EVIDENCE_STATUS.UNKNOWN,
    expectedMargin: null,
    coverMargin: null,
    score: 0,
    reason: ''
  };

  if (!teamForm || !oppForm || teamForm.games < minGames || oppForm.games < minGames || lineValue === null) {
    return { ...base, reason: 'Not enough finalised games or no line.' };
  }

  // Expected margin for the picked team vs this opponent, with a small home tilt.
  const expectedMargin = (teamForm.avgMargin - oppForm.avgMargin) / 2 + (isHome === true ? 1.5 : isHome === false ? -1.5 : 0);
  const coverMargin = expectedMargin + lineValue;
  const evidence = { ...base, expectedMargin, coverMargin };

  if (coverMargin <= -buffer) {
    return {
      ...evidence,
      status: MATCHUP_EVIDENCE_STATUS.CONTRA,
      score: -3,
      reason: `Expected margin ${expectedMargin.toFixed(1)} doesn't cover the ${lineValue} line.`
    };
  }

  if (coverMargin >= buffer) {
    return {
      ...evidence,
      status: MATCHUP_EVIDENCE_STATUS.SUPPORTED,
      score: 2 + Math.min(2, coverMargin / 6),
      reason: `Expected margin ${expectedMargin.toFixed(1)} covers the ${lineValue} line with room.`
    };
  }

  return {
    ...evidence,
    status: MATCHUP_EVIDENCE_STATUS.WEAK,
    score: coverMargin > 0 ? 0.5 : -0.5,
    reason: `Cover margin ${coverMargin.toFixed(1)} is too thin for the ${lineValue} line.`
  };
}

/**
 * Load matchup inputs (team form + H2H) for an event.
 * Injectable: pass overrides.loadMatchupInputs in tests.
 * @returns {Promise<Object|null>} { homeForm, awayForm, h2hByTeam }
 */
export async function loadEventMatchupInputs(sport, eventContext, deps = {}) {
  if (typeof deps.loadMatchupInputs === 'function') {
    return deps.loadMatchupInputs(sport, eventContext, deps);
  }
  return null;
}

export const __testables = {
  computeTeamFormSummary,
  computeH2hRecord,
  computeH2hEvidence,
  computeTotalsEvidence,
  computeSpreadEvidence,
  MATCHUP_EVIDENCE_STATUS
};
