/**
 * Cross-Game Multis
 *
 * Assembles multis whose legs come from DIFFERENT games (e.g. three teams' total
 * corners across three matches), drawn ONLY from legs that already passed the
 * deep-analysis evidence gate. One leg per event, combined to hit a target odds
 * band. Each leg keeps its own event identity so settlement can grade it against
 * its own game (see jobs/results.mjs cross-game settlement). Config-gated by
 * config.analysis.crossGameMultis.enabled (default off). Pure + unit-tested;
 * the analysis job feeds it the evidence-supported leg pool.
 */

import { randomUUID } from 'node:crypto';

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Keep the single strongest evidence-supported leg per event (favourite/most
 * supported), so a cross-game multi never doubles up on one game.
 * @param {Array} legs - cross-game candidate legs (carry eventId, evidenceScore, odds)
 * @returns {Array} one leg per event, sorted by evidence desc
 */
export function pickBestLegPerEvent(legs) {
  const byEvent = new Map();

  for (const leg of Array.isArray(legs) ? legs : []) {
    const eventId = String(leg?.eventId || leg?.eventName || '');
    const odds = toNumber(leg?.odds);
    if (!eventId || odds === null || odds <= 1) {
      continue;
    }
    const score = toNumber(leg?.evidenceScore) ?? 0;
    const existing = byEvent.get(eventId);
    if (!existing || score > (toNumber(existing.evidenceScore) ?? 0)) {
      byEvent.set(eventId, leg);
    }
  }

  return [...byEvent.values()].sort((a, b) => (toNumber(b.evidenceScore) ?? 0) - (toNumber(a.evidenceScore) ?? 0));
}

/**
 * Greedily combine one-leg-per-event picks into a multi that lands in the target
 * odds band, preferring the strongest evidence.
 * @param {Array} legs - one-per-event legs (already de-duped)
 * @param {Object} opts - { legCount, minOdds, maxOdds }
 * @returns {Array} selected legs (empty if no valid combination)
 */
export function selectCrossGameMulti(legs, { legCount = 3, minOdds = 2.0, maxOdds = 3.0 } = {}) {
  const sorted = [...legs].sort((a, b) => (toNumber(b.evidenceScore) ?? 0) - (toNumber(a.evidenceScore) ?? 0));
  const selected = [];
  let combined = 1;

  for (const leg of sorted) {
    if (selected.length >= legCount) {
      break;
    }
    const next = combined * toNumber(leg.odds);
    if (next <= maxOdds) {
      selected.push(leg);
      combined = next;
    }
  }

  if (selected.length === legCount && combined >= minOdds && combined <= maxOdds) {
    return selected;
  }

  return [];
}

/**
 * Build a cross-game multi pick. Each leg keeps its own event identity for
 * per-leg settlement.
 * @param {Object} sport - { key, label }
 * @param {Array} legs - selected cross-game legs
 * @param {Object} [options] - { stakeUnits, source }
 * @returns {Object|null}
 */
export function buildCrossGameMultiPick(sport, legs, options = {}) {
  if (!Array.isArray(legs) || legs.length < 2) {
    return null;
  }

  const combinedOdds = Math.round(legs.reduce((product, leg) => product * (toNumber(leg.odds) || 1), 1) * 100) / 100;
  const startTimes = legs
    .map((leg) => Date.parse(leg.startTime || ''))
    .filter((value) => Number.isFinite(value));
  const earliestStart = startTimes.length ? new Date(Math.min(...startTimes)).toISOString() : null;
  const evidenceScores = legs.map((leg) => toNumber(leg.evidenceScore)).filter((value) => value !== null);
  const averageEvidence = evidenceScores.length
    ? evidenceScores.reduce((sum, value) => sum + value, 0) / evidenceScores.length
    : null;

  return {
    id: `cross:${sport.key}:${randomUUID()}`,
    status: 'pending',
    sport: sport.key,
    sportLabel: sport.label,
    crossGame: true,
    betType: 'cross_game_multi',
    event: `Cross-Game Multi · ${legs.length} legs (${sport.label})`,
    startTime: earliestStart,
    summary: legs.map((leg) => leg.label).join(' + '),
    rationale: 'Cross-game multi built from evidence-supported legs across separate matches.',
    combinedOdds,
    modelProbability: null,
    confidenceTier: averageEvidence !== null && averageEvidence >= 3 ? 'high' : 'medium',
    stakeUnits: toNumber(options.stakeUnits) ?? 1,
    source: options.source || 'cross-game-generator',
    legs: legs.map((leg, index) => ({
      id: `leg-${index + 1}`,
      label: leg.label,
      odds: toNumber(leg.odds),
      status: 'active',
      locked: false,
      // Each leg keeps its OWN event identity so settlement grades it against
      // its own game.
      eventId: leg.eventId || '',
      espnEventId: leg.espnEventId || '',
      homeTeam: leg.homeTeam || '',
      awayTeam: leg.awayTeam || '',
      startTime: leg.startTime || '',
      legSport: leg.sport || sport.key,
      evidence: leg.evidence || (leg.evidenceStatus
        ? { status: leg.evidenceStatus, score: toNumber(leg.evidenceScore), reason: leg.evidenceReason || '', type: leg.evidenceType || '' }
        : null),
      source: {
        type: leg.source?.type || leg.sourceType || 'web-scrape',
        market: leg.market,
        outcomeName: leg.outcomeName,
        description: leg.description || '',
        point: leg.point ?? null
      }
    }))
  };
}

/**
 * Build cross-game multis for one sport from its evidence-supported leg pool.
 * @param {Object} sport - { key, label }
 * @param {Array} legPool - supported single legs across events
 * @param {Object} config - daemon config (reads analysis.crossGameMultis)
 * @returns {Array} cross-game multi picks (0..maxPicks)
 */
export function buildCrossGameMultisForSport(sport, legPool, config) {
  const settings = config?.analysis?.crossGameMultis || {};
  if (!settings.enabled) {
    return [];
  }

  const legCount = Number(settings.legCount || 3);
  const minOdds = Number(settings.minOdds || 2.0);
  const maxOdds = Number(settings.maxOdds || 3.0);
  const maxPicks = Number(settings.maxPicksPerSport || 1);

  const perEvent = pickBestLegPerEvent(legPool);
  if (perEvent.length < legCount) {
    return [];
  }

  const picks = [];
  let available = [...perEvent];

  for (let i = 0; i < maxPicks; i += 1) {
    const selected = selectCrossGameMulti(available, { legCount, minOdds, maxOdds });
    if (!selected.length) {
      break;
    }
    const pick = buildCrossGameMultiPick(sport, selected, { stakeUnits: settings.stakeUnits });
    if (pick) {
      picks.push(pick);
    }
    const usedEvents = new Set(selected.map((leg) => leg.eventId));
    available = available.filter((leg) => !usedEvents.has(leg.eventId));
    if (available.length < legCount) {
      break;
    }
  }

  return picks;
}

export const __testables = {
  pickBestLegPerEvent,
  selectCrossGameMulti,
  buildCrossGameMultiPick,
  buildCrossGameMultisForSport
};
