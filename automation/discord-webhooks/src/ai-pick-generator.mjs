import { createStructuredOpenAiResponse } from './openai-client.mjs';
import { evaluatePickAgainstBenchmarks } from './benchmarks.mjs';
import { AI_GENERATED_SOURCE, buildCandidatePoolForEvent } from './pick-generator.mjs';
import { GENERATED_SOURCE } from './pick-generator.mjs';
import { loadAnalysisAgentBundle } from './analysis-agent-bundle.mjs';

const PASSING_CHECKLIST_VALUES = new Set(['pass', 'not_applicable']);
const MLB_STRUCTURE_PROFILE_LEGACY = 'mlb-hit-led-v1';
const MLB_STRUCTURE_PROFILE_HIT_PRIORITY = 'mlb-hit-priority-v2';
// v3 (default): featured-market singles. Sportsbet posts batter/pitcher props only
// near first pitch, so upcoming games carry featured markets only. The old hit-priority
// profile required props -> MLB almost never posted pre-game, and two 1+ hit props are
// negative-EV (~0.62^2 ≈ 38% vs ~42% breakeven at 1.55×1.55). v3 bets the single
// highest-probability featured market that is reliably available: a moneyline favourite
// or the protected +1.5 run line. MLB is the hardest major to beat, so this is harm
// reduction + selectivity, not a guaranteed edge — keep stakes small and forward-test.
const MLB_STRUCTURE_PROFILE_FEATURED_SINGLE = 'mlb-featured-single-v3';
const MLB_SAFE_HIT_RUNG = 1;
// Tightened from 1.72: at 1.55, implied probability ≥65%, filtering out fringe batters.
// A 2-leg hit multi at 1.55×1.55 ≈ 2.4x — still viable odds with much better hit rate.
const MLB_SAFE_HIT_PRICE_MAX = 1.55;
// Tightened from 5.5: quality starters in 5-6 innings average 4-5 Ks; 5.5+ is a stretch line.
const MLB_SAFE_STRIKEOUT_LINE_MAX = 4.5;
const MLB_SAFE_STRIKEOUT_PRICE_MAX = 1.75;
// Featured-single profile (v3) thresholds.
// Moneyline favourite: price ≤1.65 ⇒ implied ≥60%, i.e. only genuine favourites.
const MLB_SAFE_ML_PRICE_MAX = 1.65;
// Protected +1.5 run line (team gets +1.5 runs): floor avoids juiced near-certainties
// that add no value, ceiling keeps it to a real protected line, not a disguised favourite -1.5.
const MLB_PROTECTED_RUNLINE_PRICE_MIN = 1.45;
const MLB_PROTECTED_RUNLINE_PRICE_MAX = 2.05;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildChecklistSchema() {
  const checklistValue = {
    type: 'string',
    enum: ['pass', 'fail', 'not_applicable']
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'actionableSlate',
      'marketDepth',
      'selectionSupport',
      'playerAvailability',
      'roleStability',
      'externalConditions',
      'researchConfidence',
      'correlation',
      'ticketIntegrity',
      'bankrollFit'
    ],
    properties: {
      actionableSlate: checklistValue,
      marketDepth: checklistValue,
      selectionSupport: checklistValue,
      playerAvailability: checklistValue,
      roleStability: checklistValue,
      externalConditions: checklistValue,
      researchConfidence: checklistValue,
      correlation: checklistValue,
      ticketIntegrity: checklistValue,
      bankrollFit: checklistValue
    }
  };
}

function buildSelectionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['candidateId', 'modelProbability', 'rationale'],
    properties: {
      candidateId: { type: 'string' },
      modelProbability: { type: ['number', 'null'] },
      rationale: { type: 'string' }
    }
  };
}

export const ANALYSIS_DECISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'qualifies',
    'recommendation',
    'summary',
    'rationale',
    'noBetReason',
    'confidenceTier',
    'supportProjection',
    'dataConfidence',
    'correlationRisk',
    'correlationJustified',
    'exceptionalSupport',
    'strongSupport',
    'combinedModelProbability',
    'supportScore',
    'stakeUnits',
    'checklist',
    'selectedLegs',
    'backupLeg',
    'notes'
  ],
  properties: {
    qualifies: { type: 'boolean' },
    recommendation: {
      type: 'string',
      enum: ['build_2_leg_multi', 'build_3_leg_multi', 'build_4_leg_multi', 'build_single', 'no_bet']
    },
    summary: { type: ['string', 'null'] },
    rationale: { type: 'string' },
    noBetReason: { type: ['string', 'null'] },
    confidenceTier: { type: 'string', enum: ['low', 'medium', 'high', 'extreme'] },
    supportProjection: { type: 'string', enum: ['weak', 'moderate', 'strong'] },
    dataConfidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    correlationRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
    correlationJustified: { type: 'boolean' },
    exceptionalSupport: { type: 'boolean' },
    strongSupport: { type: 'boolean' },
    combinedModelProbability: { type: ['number', 'null'] },
    supportScore: { type: ['number', 'null'] },
    stakeUnits: { type: 'number' },
    checklist: buildChecklistSchema(),
    selectedLegs: {
      type: 'array',
      minItems: 0,
      maxItems: 4,
      items: buildSelectionSchema()
    },
    backupLeg: {
      anyOf: [
        { type: 'null' },
        buildSelectionSchema()
      ]
    },
    notes: { type: 'string' }
  }
};

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

const ALLOWED_STAKE_UNITS = [0.5, 1, 2];
const MAX_ALLOWED_STAKE_UNITS = ALLOWED_STAKE_UNITS[ALLOWED_STAKE_UNITS.length - 1];

function normalizeStakeUnits(units) {
  const numeric = toNumber(units);

  if (numeric === null || numeric <= ALLOWED_STAKE_UNITS[0]) {
    return ALLOWED_STAKE_UNITS[0];
  }

  if (numeric <= 0.75) {
    return 0.5;
  }

  if (numeric <= 1.5) {
    return 1;
  }

  if (numeric <= 3.5) {
    return 2;
  }

  return 2;
}

function roundStakeUnits(units) {
  return Number(normalizeStakeUnits(Math.round(Number(units) * 2) / 2).toFixed(2));
}

function getBaseStakeUnits(eventContext) {
  return normalizeStakeUnits(toNumber(eventContext?.generatorConfig?.stakeUnits) || 1);
}

function getConfiguredMaxStakeUnits(eventContext) {
  const baseStakeUnits = getBaseStakeUnits(eventContext);
  const configuredMaxStakeUnits = Math.min(
    MAX_ALLOWED_STAKE_UNITS,
    toNumber(eventContext?.generatorConfig?.maxStakeUnits) || MAX_ALLOWED_STAKE_UNITS
  );

  return Math.max(baseStakeUnits, configuredMaxStakeUnits);
}

function getRecommendedStakeUnits(eventContext, bankrollContext, combo) {
  if (!combo) {
    return 0;
  }

  const baseStakeUnits = getBaseStakeUnits(eventContext);
  const configuredMaxStakeUnits = getConfiguredMaxStakeUnits(eventContext);
  const availableUnits = toNumber(bankrollContext?.availableUnits);
  const bankrollCapUnits = availableUnits === null || availableUnits <= 0
    ? configuredMaxStakeUnits
    : Math.min(
      availableUnits,
      Math.max(baseStakeUnits, Math.floor(availableUnits * 0.35))
    );
  const stakeCeiling = Math.max(
    Math.min(configuredMaxStakeUnits, bankrollCapUnits),
    Math.min(baseStakeUnits, bankrollCapUnits)
  );
  const flexibleFloorStakeUnits = availableUnits !== null && availableUnits < 0.5
    ? Math.max(0, Number(availableUnits.toFixed(2)))
    : 0.5;
  const minimumStakeUnits = flexibleFloorStakeUnits;
  const comboProfile = getComboProfile(combo.candidates);
  const supportScore = toNumber(combo.supportScore) || 0;
  const premiumSignals = [
    combo.confidenceTier === 'high' || combo.confidenceTier === 'extreme',
    combo.supportProjection === 'strong',
    combo.dataConfidence === 'high',
    combo.correlationRisk === 'low',
    combo.strongSupport,
    combo.exceptionalSupport
  ].filter(Boolean).length;
  let stakeUnits = baseStakeUnits;

  if (
    supportScore >= 8.5
    && premiumSignals >= 5
    && combo.strongSupport
    && combo.exceptionalSupport
    && combo.supportProjection === 'strong'
    && combo.correlationRisk === 'low'
    && combo.candidates.length <= 3
    && comboProfile.h2hCount === 0
    && comboProfile.nbaVolatilePropCount === 0
  ) {
    stakeUnits = 2;
  }

  if (combo.correlationRisk === 'medium' && stakeUnits > 1) {
    stakeUnits -= 1;
  }

  if (shouldPreferPlayerProps(eventContext) && comboProfile.h2hCount > 0 && stakeUnits > 1) {
    stakeUnits -= 1;
  }

  if (comboProfile.nbaVolatilePropCount > 0 && stakeUnits > 1) {
    stakeUnits -= 1;
  }

  const fragilitySignals = [
    combo.candidates.length >= 4,
    combo.correlationRisk === 'medium',
    shouldPreferPlayerProps(eventContext) && comboProfile.h2hCount > 0,
    comboProfile.nbaVolatilePropCount > 0
  ].filter(Boolean).length;

  if (fragilitySignals >= 2 && stakeUnits > minimumStakeUnits) {
    stakeUnits -= 0.5;
  }

  if (supportScore < 5.5 && stakeUnits > minimumStakeUnits) {
    stakeUnits -= 0.5;
  }

  return roundStakeUnits(Math.max(minimumStakeUnits, Math.min(stakeUnits, stakeCeiling)));
}

function getAflDisposalLine(candidate) {
  const text = String(candidate?.outcomeName || candidate?.label || '').trim();
  const match = text.match(/(\d+)\s*\+\s*disposals?/i);

  if (!match) {
    return null;
  }

  const line = toNumber(match[1]);
  return Number.isFinite(line) ? line : null;
}

function isAllowedAflDisposalLine(candidate) {
  const line = getAflDisposalLine(candidate);

  return line !== null && line >= 10 && (line - 10) % 5 === 0;
}

function isPreferredAflHighVolumeCandidate(candidate) {
  if (getAflPropSubtype(candidate) !== 'disposal') {
    return false;
  }

  const line = getAflDisposalLine(candidate);
  const bestPrice = toNumber(candidate?.bestPrice);

  if (line === null || bestPrice === null) {
    return false;
  }

  if (line >= 30) {
    return bestPrice <= 1.75;
  }

  if (line >= 25) {
    return bestPrice <= 2.15;
  }

  if (line >= 20) {
    return bestPrice <= 2.05;
  }

  return false;
}

function roundMetric(value) {
  return Number(Number(value).toFixed(2));
}

const SAFE_GENERATED_TOTAL_ODDS_TARGET_MAX = 3.25;
const SAFE_GENERATED_TOTAL_ODDS_HARD_MAX = 5;
// NRL anchor legs (protected plus lines, safe totals) price ~1.8-1.9, so even
// the safest 3-leg line+line+kicker mix lands ~3.3-4.6x. Without this ceiling
// the generic 3.25x target makes every NRL 3-leg build unreachable.
const NRL_THREE_LEG_ODDS_MAX = 4.6;

function estimateObservedComboOdds(candidates) {
  const candidatePrices = candidates
    .map((candidate) => toNumber(candidate?.bestPrice))
    .filter((price) => price !== null && price > 0);

  if (candidatePrices.length !== candidates.length) {
    return null;
  }

  return roundMetric(candidatePrices.reduce((product, price) => product * price, 1));
}

function supportsExtendedOdds(combo, observedComboOdds) {
  const supportScore = toNumber(combo?.supportScore) || 0;
  const confidenceTier = String(combo?.confidenceTier || '').toLowerCase();
  const supportProjection = String(combo?.supportProjection || '').toLowerCase();
  const dataConfidence = String(combo?.dataConfidence || '').toLowerCase();
  const correlationRisk = String(combo?.correlationRisk || '').toLowerCase();

  return Number.isFinite(observedComboOdds)
    && observedComboOdds <= 5
    && supportScore >= 7.5
    && (confidenceTier === 'high' || confidenceTier === 'extreme')
    && supportProjection === 'strong'
    && dataConfidence !== 'low'
    && correlationRisk === 'low'
    && (Boolean(combo?.strongSupport) || Boolean(combo?.exceptionalSupport));
}

function isTennisSport(sportKey) {
  return String(sportKey || '').toLowerCase().startsWith('tennis');
}

function shouldPreferPlayerProps(eventContext) {
  // MLB (v3 featured-single profile) intentionally bets the moneyline/run line, so it must
  // NOT prefer props or penalise h2h. Tennis is H2H-first. Both are excluded.
  return eventContext?.generatorConfig?.teamSportsH2hPolicy === 'fallback_only'
    && !isTennisSport(eventContext?.sportKey)
    && !isSport(eventContext, 'mlb');
}

function isSport(eventContext, key) {
  return String(eventContext?.sportKey || '').toLowerCase() === key;
}

function isFirstHalfCandidate(candidate) {
  const text = ` ${getCandidateSearchText(candidate)} `;
  return /\b(1st half|first half)\b/.test(text);
}

function isRaceToPointsCandidate(candidate) {
  const text = ` ${getCandidateSearchText(candidate)} `;
  return /\brace(?:\s+to)?\b/.test(text) && /\bpoints?\b/.test(text);
}

function isTeamLikeCandidateDescription(candidate, eventContext) {
  const description = normalizeText(candidate?.description);

  if (!description) {
    return true;
  }

  if (/\b(home|away|[1-4](st|nd|rd|th)) team\b/.test(description)) {
    return true;
  }

  return new Set([
    eventContext?.homeTeam,
    eventContext?.awayTeam
  ].map((teamName) => normalizeText(teamName)).filter(Boolean)).has(description);
}

function isFirstHalfTotalCandidate(candidate) {
  return candidate?.family === 'total' && isFirstHalfCandidate(candidate);
}

function isFullGameTotalCandidate(candidate) {
  return candidate?.family === 'total' && !isFirstHalfCandidate(candidate);
}

function isFirstHalfSpreadCandidate(candidate) {
  return isSpreadMarket(candidate?.market) && isFirstHalfCandidate(candidate);
}

function isFullGameSpreadCandidate(candidate) {
  return isSpreadMarket(candidate?.market) && !isFirstHalfCandidate(candidate);
}

function getNrlSpreadPoint(candidate) {
  if (!isSpreadMarket(candidate?.market)) {
    return null;
  }

  const point = toNumber(candidate?.point);

  if (point !== null) {
    return point;
  }

  const rawText = ` ${getCandidateRawSearchText(candidate)} `;
  const match = rawText.match(/([+-]\d+(?:\.\d+)?)/);

  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function isNrlPlayerPointsCandidate(candidate) {
  return normalizeText(candidate?.market) === 'player points';
}

function getNrlPlayerPointsLine(candidate) {
  if (!isNrlPlayerPointsCandidate(candidate)) {
    return null;
  }

  const point = toNumber(candidate?.point);

  if (point !== null) {
    return point;
  }

  const rawText = ` ${getCandidateRawSearchText(candidate)} `;
  const normalizedText = ` ${getCandidateSearchText(candidate)} `;
  const plusMatch = rawText.match(/\b(\d+(?:\.\d+)?)\s*\+\s*points?\b/i)
    || normalizedText.match(/\b(\d+(?:\.\d+)?)\s+points?\b/i);

  if (plusMatch) {
    return Number(plusMatch[1]);
  }

  const overMatch = normalizedText.match(/\bover\s+(\d+(?:\.\d+)?)\b/i);

  if (overMatch) {
    return Number(overMatch[1]);
  }

  return null;
}

function isAllowedNrlPlayerPointsCandidate(candidate, eventContext) {
  if (!candidate || candidate.family !== 'prop' || !isNrlPlayerPointsCandidate(candidate)) {
    return false;
  }

  if (isTeamLikeCandidateDescription(candidate, eventContext)) {
    return false;
  }

  const playerPointsLine = getNrlPlayerPointsLine(candidate);
  const bestPrice = toNumber(candidate?.bestPrice);

  // Max line capped at 6: NRL scorers average 4-8ppg, 8+ line hits ~40% of the time — too risky.
  if (playerPointsLine === null || bestPrice === null || playerPointsLine < 4 || playerPointsLine > 6) {
    return false;
  }

  if (playerPointsLine >= 6) {
    return bestPrice <= 1.75;
  }

  return bestPrice <= 1.55;
}

function isAllowedNrlSpreadPoint(candidate) {
  const point = getNrlSpreadPoint(candidate);
  const label = normalizeText(candidate?.label || candidate?.outcomeName);
  // Hard block if point is negative or if the text contains minus markers
  return point !== null && point > 0 && !label.includes('-') && !label.includes('minus');
}

function getNrlSafeMarketKey(candidate) {
  if (normalizeText(candidate?.market) === 'h2h') {
    return 'h2h';
  }

  if (isNrlPlayerPointsCandidate(candidate)) {
    return 'player_points';
  }

  if (isFirstHalfTotalCandidate(candidate)) {
    return 'first_half_total';
  }

  if (isFullGameTotalCandidate(candidate)) {
    return 'total';
  }

  if (isFirstHalfSpreadCandidate(candidate)) {
    return 'first_half_spread';
  }

  if (isFullGameSpreadCandidate(candidate)) {
    return 'spread';
  }

  return '';
}

function getNrlComboProfile(candidates) {
  const safeMarketKeys = candidates.map((candidate) => getNrlSafeMarketKey(candidate)).filter(Boolean);
  const safeMarketKeysWithoutH2h = safeMarketKeys.filter((marketKey) => marketKey !== 'h2h');

  return {
    h2hCount: safeMarketKeys.filter((marketKey) => marketKey === 'h2h').length,
    playerPointsCount: safeMarketKeys.filter((marketKey) => marketKey === 'player_points').length,
    totalCount: safeMarketKeys.filter((marketKey) => marketKey === 'total' || marketKey === 'first_half_total').length,
    spreadCount: safeMarketKeys.filter((marketKey) => marketKey === 'spread' || marketKey === 'first_half_spread').length,
    fullGameTotalCount: safeMarketKeys.filter((marketKey) => marketKey === 'total').length,
    firstHalfTotalCount: safeMarketKeys.filter((marketKey) => marketKey === 'first_half_total').length,
    fullGameSpreadCount: safeMarketKeys.filter((marketKey) => marketKey === 'spread').length,
    firstHalfSpreadCount: safeMarketKeys.filter((marketKey) => marketKey === 'first_half_spread').length,
    uniqueSafeMarketCount: new Set(safeMarketKeysWithoutH2h).size,
    unsupportedCount: candidates.length - safeMarketKeys.length,
    invalidSpreadCount: candidates.filter((candidate) => isSpreadMarket(candidate?.market) && !isAllowedNrlSpreadPoint(candidate)).length
  };
}

function isAllowedNrlTotalCandidate(candidate) {
  const line = toNumber(candidate?.point);
  const direction = normalizeText(candidate?.outcomeName);

  if (isFirstHalfTotalCandidate(candidate)) {
    // NRL 1st half averages ~20-23 combined points.
    // OVER 22.5+ is ≤48% probability — too low for a reliable anchor.
    // UNDER 26.5+ is ~72%+ probability — strong conservative anchor.
    if (direction === 'over') return line !== null && line <= 22.5;
    if (direction === 'under') return line !== null && line >= 26.5;
    return false;
  }

  // Full game totals: NRL avg ~44 points.
  // OVER 40.5+ has <55% probability; UNDER needs a 7+ point cushion above the
  // league average to act as an anchor — sub-51.5 unders (47.5-50.5 lines) are
  // near coin flips and have been repeat losers.
  if (direction === 'over') return line !== null && line <= 40.5;
  if (direction === 'under') return line !== null && line >= 51.5;
  return true;
}

function isAllowedNrlCandidate(candidate, eventContext) {
  if (isRaceToPointsCandidate(candidate)) {
    return false;
  }

  if (candidate.family === 'total') {
    return isAllowedNrlTotalCandidate(candidate);
  }

  if (isSpreadMarket(candidate.market)) {
    return isAllowedNrlSpreadPoint(candidate);
  }

  if (normalizeText(candidate.market) === 'h2h') {
    return true;
  }

  if (isAllowedNrlPlayerPointsCandidate(candidate, eventContext)) {
    return true;
  }

  return false;
}

function isAllowedAflCandidate(candidate) {
  if (candidate?.family !== 'prop') {
    return false;
  }

  const subtype = getAflPropSubtype(candidate);
  const bestPrice = toNumber(candidate?.bestPrice);
  const disposalLine = subtype === 'disposal' ? getAflDisposalLine(candidate) : null;

  if (bestPrice === null) {
    return false;
  }

  if (subtype === 'disposal') {
    if (!isAllowedAflDisposalLine(candidate) || disposalLine === null) {
      return false;
    }

    if (disposalLine >= 30) {
      return bestPrice <= 1.75;
    }

    if (disposalLine >= 25) {
      return bestPrice <= 2.15;
    }

    if (disposalLine >= 20) {
      return bestPrice <= 2.05;
    }

    if (disposalLine >= 15) {
      return bestPrice <= 1.95;
    }

    // Line 10-14: only allow at prices that imply a confirmed starter role (≤1.55)
    // Prices above 1.55 typically indicate bench/rotation players who are far too volatile
    return bestPrice <= 1.55;
  }

  if (subtype === 'goal') {
    return bestPrice <= 1.65;
  }

  return false;
}

function getNbaStatLine(candidate, subtype) {
  if (getNbaPropSubtype(candidate) !== subtype) return null;
  const point = toNumber(candidate?.point);
  if (point !== null) return point;
  const text = ` ${getCandidateRawSearchText(candidate)} `;
  const match = text.match(/\b(\d+)\s*\+\s*(?:rebounds?|assists?|points?|blocks?|steals?)\b/i);
  return match ? toNumber(match[1]) : null;
}

function isAllowedNbaCandidate(candidate) {
  if (candidate?.family !== 'prop') return false;
  const subtype = getNbaPropSubtype(candidate);
  if (!subtype) return false;

  const bestPrice = toNumber(candidate?.bestPrice);
  if (bestPrice === null) return false;

  // Block highly volatile props — threes/steals/blocks have <40% hit rates in most contexts
  if (subtype === 'three' || subtype === 'steal' || subtype === 'block') return false;

  if (subtype === 'rebound') {
    const line = getNbaStatLine(candidate, 'rebound');
    // Hard cap at 8: lines above this occur <30% of the time for most players
    if (line !== null && line > 8) return false;
    // Line 7-8 still requires a tight price to confirm it's a big-man prop
    if (line !== null && line >= 7 && bestPrice > 1.55) return false;
    return true;
  }

  if (subtype === 'assist') {
    const line = getNbaStatLine(candidate, 'assist');
    // 4+ assists: only trust PGs/primary handlers priced as strong favorites (≤1.75)
    // 5+ assists: even stricter — only elite ball-handlers consistently hit this
    if (line !== null && line >= 5 && bestPrice > 1.60) return false;
    if (line !== null && line >= 4 && bestPrice > 1.75) return false;
    return true;
  }

  return true;
}

function getMlbRunLinePoint(candidate) {
  if (!isSpreadMarket(candidate?.market)) {
    return null;
  }

  const point = toNumber(candidate?.point);

  if (point !== null) {
    return point;
  }

  const match = ` ${getCandidateRawSearchText(candidate)} `.match(/([+-]\d+(?:\.\d+)?)/);
  const numeric = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function isMlbFavouriteMoneyline(candidate) {
  if (normalizeText(candidate?.market) !== 'h2h') {
    return false;
  }

  const bestPrice = toNumber(candidate?.bestPrice);
  // Price ≤1.65 ⇒ implied ≥60.6%: only genuine favourites, never coin-flip/underdog moneylines.
  return bestPrice !== null && bestPrice > 1 && bestPrice <= MLB_SAFE_ML_PRICE_MAX;
}

function isMlbProtectedRunLineSingle(candidate) {
  const point = getMlbRunLinePoint(candidate);
  const bestPrice = toNumber(candidate?.bestPrice);

  // Only the team GETTING +1.5 runs (point > 0) — never the -1.5 favourite needing to win by 2+.
  return point !== null
    && point > 0
    && bestPrice !== null
    && bestPrice >= MLB_PROTECTED_RUNLINE_PRICE_MIN
    && bestPrice <= MLB_PROTECTED_RUNLINE_PRICE_MAX;
}

function isAllowedMlbFeaturedSingle(candidate) {
  if (!candidate) {
    return false;
  }

  return isMlbFavouriteMoneyline(candidate) || isMlbProtectedRunLineSingle(candidate);
}

function isAllowedMlbCandidate(candidate) {
  // Default (featured-single v3) profile: bet the reliably-available featured markets,
  // not late-posting props. See MLB_STRUCTURE_PROFILE_FEATURED_SINGLE.
  return isAllowedMlbFeaturedSingle(candidate);
}

function isAllowedLegacyMlbCandidate(candidate) {
  if (!candidate || candidate.family !== 'prop') {
    return false;
  }

  return isConservativeMlbHitCandidate(candidate) || isConservativeMlbStrikeoutCandidate(candidate);
}

function filterCandidatePoolForSport(eventContext, candidatePool) {
  if (isSport(eventContext, 'afl')) {
    return candidatePool.filter((candidate) => isAllowedAflCandidate(candidate));
  }

  if (isSport(eventContext, 'mlb')) {
    return candidatePool.filter((candidate) => (
      usesLegacyMlbStructureProfile(eventContext)
        ? isAllowedLegacyMlbCandidate(candidate)
        : isAllowedMlbCandidate(candidate)
    ));
  }

  if (isSport(eventContext, 'nrl')) {
    return candidatePool.filter((candidate) => isAllowedNrlCandidate(candidate, eventContext));
  }

  if (isSport(eventContext, 'nba')) {
    return candidatePool.filter((candidate) => isAllowedNbaCandidate(candidate));
  }

  return candidatePool;
}

function isAflPromoDay(eventContext) {
  if (!isSport(eventContext, 'afl') || !eventContext?.startTime) {
    return false;
  }

  const start = new Date(eventContext.startTime);

  if (Number.isNaN(start.getTime())) {
    return false;
  }

  const weekday = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    weekday: 'short'
  }).format(start);

  return weekday === 'Sat' || weekday === 'Sun';
}

function isNbaHighStakes(eventContext) {
  const name = normalizeText(eventContext?.eventName);
  return /\b(final|finals|playoff|playoffs|semi|semis|championship)\b/.test(name);
}

function getNbaPointsLine(candidate) {
  if (getNbaPropSubtype(candidate) !== 'points') return null;
  const rawText = ` ${getCandidateRawSearchText(candidate)} `;
  const match = rawText.match(/\b(\d+)\s*\+\s*points?\b/i);
  return match ? toNumber(match[1]) : null;
}

function isNbaStarCandidate(candidate) {
  if (getNbaPropSubtype(candidate) !== 'points') return false;
  const line = getNbaPointsLine(candidate);
  // Using 15+ or 20+ as the proxy for Star Players (20+ PPG avg) as per rules
  return line !== null && line >= 15;
}

function getCandidateSearchText(candidate) {
  return String([
    candidate?.market,
    candidate?.label,
    candidate?.description,
    candidate?.outcomeName
  ].filter(Boolean).join(' ') || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getCandidateRawSearchText(candidate) {
  return String([
    candidate?.market,
    candidate?.label,
    candidate?.description,
    candidate?.outcomeName
  ].filter(Boolean).join(' ') || '');
}

function getNbaPropSubtype(candidate) {
  if (candidate?.family !== 'prop') {
    return null;
  }

  const text = ` ${getCandidateSearchText(candidate)} `;

  if (/\b(pra|pa|ra|rp|points rebounds assists|points assists|rebounds assists|rebounds points)\b/.test(text)) {
    return 'combo';
  }

  if (/\bassists?\b/.test(text)) {
    return 'assist';
  }

  if (/\brebounds?\b/.test(text)) {
    return 'rebound';
  }

  if (/\b(3pt|3pts|3 point|3 points|three point|three points|threes?)\b/.test(text)) {
    return 'three';
  }

  if (/\bsteals?\b/.test(text)) {
    return 'steal';
  }

  if (/\bblocks?\b/.test(text)) {
    return 'block';
  }

  if (/\b(2pt|2pts|points?)\b/.test(text)) {
    return 'points';
  }

  return null;
}

function getMlbPropSubtype(candidate) {
  if (candidate?.family !== 'prop') {
    return null;
  }

  const text = ` ${getCandidateSearchText(candidate)} `;

  if (/\b(hits?\s*runs?\s*rbi|hits\+runs\+rbi|hits runs rbi)\b/.test(text)) {
    return 'hrr';
  }

  if (/\btotal bases?\b/.test(text)) {
    return 'total_bases';
  }

  if (/\b(rbi|rbis|runs batted in)\b/.test(text)) {
    return 'rbi';
  }

  if (/\bstrikeouts?\b/.test(text)) {
    return 'strikeout';
  }

  if (/\bhits?\b/.test(text)) {
    return 'hit';
  }

  return null;
}

function getMlbHitRung(candidate) {
  if (getMlbPropSubtype(candidate) !== 'hit') {
    return null;
  }

  const rawText = ` ${getCandidateRawSearchText(candidate)} `;
  const normalizedText = ` ${getCandidateSearchText(candidate)} `;
  const match = rawText.match(/\b(\d+)\s*\+\s*hits?\b/i) || normalizedText.match(/\b(\d+)\s+hits?\b/i);

  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function getMlbStrikeoutLine(candidate) {
  if (getMlbPropSubtype(candidate) !== 'strikeout') {
    return null;
  }

  const point = toNumber(candidate?.point);

  if (point !== null) {
    return point;
  }

  const rawText = ` ${getCandidateRawSearchText(candidate)} `;
  const normalizedText = ` ${getCandidateSearchText(candidate)} `;
  const plusMatch = rawText.match(/\b(\d+(?:\.\d+)?)\s*\+\s*strikeouts?\b/i)
    || normalizedText.match(/\b(\d+(?:\.\d+)?)\s+strikeouts?\b/i);

  if (plusMatch) {
    return Number(plusMatch[1]);
  }

  const overMatch = normalizedText.match(/\bover\s+(\d+(?:\.\d+)?)\b/i);

  if (overMatch) {
    return Number(overMatch[1]);
  }

  return null;
}

function isConservativeMlbHitCandidate(candidate) {
  if (getMlbPropSubtype(candidate) !== 'hit') {
    return false;
  }

  const rung = getMlbHitRung(candidate);
  const bestPrice = toNumber(candidate?.bestPrice);

  return rung === MLB_SAFE_HIT_RUNG && bestPrice !== null && bestPrice <= MLB_SAFE_HIT_PRICE_MAX;
}

function isConservativeMlbStrikeoutCandidate(candidate) {
  if (getMlbPropSubtype(candidate) !== 'strikeout') {
    return false;
  }

  const strikeoutLine = getMlbStrikeoutLine(candidate);
  const bestPrice = toNumber(candidate?.bestPrice);

  return strikeoutLine !== null
    && strikeoutLine <= MLB_SAFE_STRIKEOUT_LINE_MAX
    && bestPrice !== null
    && bestPrice <= MLB_SAFE_STRIKEOUT_PRICE_MAX;
}

function getMlbCandidateTeamKey(candidate) {
  return normalizeText(candidate?.mlbTeamSide || candidate?.mlbTeamName || '');
}

function getMlbSharedHitTeamCount(candidates) {
  const hitCountsByTeam = new Map();

  for (const candidate of candidates) {
    if (getMlbPropSubtype(candidate) !== 'hit') {
      continue;
    }

    const teamKey = getMlbCandidateTeamKey(candidate);

    if (!teamKey) {
      continue;
    }

    hitCountsByTeam.set(teamKey, (hitCountsByTeam.get(teamKey) || 0) + 1);
  }

  return Math.max(0, ...hitCountsByTeam.values());
}

function hasSameTeamMlbHitPair(candidates) {
  return getMlbSharedHitTeamCount(candidates) >= 2;
}

function getMlbStructureProfile(subject) {
  const explicitProfile = String(subject?.mlbStructureProfile || '').trim();

  if (explicitProfile) {
    return explicitProfile;
  }

  return isSport(subject, 'mlb') ? MLB_STRUCTURE_PROFILE_FEATURED_SINGLE : '';
}

function usesLegacyMlbStructureProfile(subject) {
  return getMlbStructureProfile(subject) === MLB_STRUCTURE_PROFILE_LEGACY;
}

function isSafeFeaturedMlbCombo(candidates) {
  // v3: exactly one reliably-available featured leg — a favourite moneyline or a
  // protected +1.5 run line. No multis (same-game featured legs are correlated) and
  // no late-posting props.
  return candidates.length === 1 && isAllowedMlbFeaturedSingle(candidates[0]);
}

function getAflPropSubtype(candidate) {
  if (candidate?.family !== 'prop') {
    return null;
  }

  const normalizedMarket = normalizeText(candidate?.market);

  if (normalizedMarket === 'player_disposals') {
    return 'disposal';
  }

  if (normalizedMarket === 'player_goals') {
    return 'goal';
  }

  const text = ` ${getCandidateSearchText(candidate)} `;

  if (/\bdisposals?\b/.test(text)) {
    return 'disposal';
  }

  if (/\bgoals?\b/.test(text)) {
    return 'goal';
  }

  return null;
}

function isSideMarket(market) {
  const normalized = normalizeText(market);
  return /\b(h2h|head to head|moneyline|spreads?|handicap)\b/.test(normalized);
}

function isSpreadMarket(market) {
  const normalized = normalizeText(market);
  return /\b(spreads?|handicap)\b/.test(normalized);
}

function getPreferredMinimumPropCount(eventContext, legCount) {
  if (!shouldPreferPlayerProps(eventContext)) {
    return 0;
  }

  if (isSport(eventContext, 'afl')) {
    return Math.max(2, legCount);
  }

  return legCount >= 3 ? 2 : 1;
}

function getComboProfile(candidates) {
  return {
    propCount: candidates.filter((candidate) => candidate.family === 'prop').length,
    totalCount: candidates.filter((candidate) => candidate.family === 'total').length,
    h2hCount: candidates.filter((candidate) => normalizeText(candidate.market) === 'h2h').length,
    spreadCount: candidates.filter((candidate) => isSpreadMarket(candidate.market)).length,
    aflDisposalsCount: candidates.filter((candidate) => getAflPropSubtype(candidate) === 'disposal').length,
    aflGoalCount: candidates.filter((candidate) => getAflPropSubtype(candidate) === 'goal').length,
    mlbHitCount: candidates.filter((candidate) => getMlbPropSubtype(candidate) === 'hit').length,
    mlbStrikeoutCount: candidates.filter((candidate) => getMlbPropSubtype(candidate) === 'strikeout').length,
    mlbTotalCount: candidates.filter((candidate) => candidate.family === 'total').length,
    mlbRbiCount: candidates.filter((candidate) => getMlbPropSubtype(candidate) === 'rbi').length,
    nbaPointsCount: candidates.filter((candidate) => getNbaPropSubtype(candidate) === 'points').length,
    nbaStablePropCount: candidates.filter((candidate) => {
      const subtype = getNbaPropSubtype(candidate);
      return subtype === 'assist' || subtype === 'rebound' || subtype === 'combo';
    }).length,
    nbaVolatilePropCount: candidates.filter((candidate) => {
      const subtype = getNbaPropSubtype(candidate);
      return subtype === 'three' || subtype === 'steal' || subtype === 'block';
    }).length
  };
}

function isSafeMlbCombo(candidates, eventContext) {
  const comboProfile = getComboProfile(candidates);

  if (usesLegacyMlbStructureProfile(eventContext)) {
    if (comboProfile.propCount !== candidates.length) {
      return false;
    }

    if (comboProfile.mlbHitCount < 2 || comboProfile.mlbTotalCount > 0 || comboProfile.mlbRbiCount > 0) {
      return false;
    }

    if (candidates.length <= 2) {
      return true;
    }

    return comboProfile.mlbHitCount + comboProfile.mlbStrikeoutCount === candidates.length;
  }

  // Default featured-single profile (v3).
  return isSafeFeaturedMlbCombo(candidates);
}

function capMlbCandidatePool(candidatePool, candidateLimit) {
  if (candidatePool.length <= candidateLimit) {
    return candidatePool;
  }

  const reservedStrikeouts = candidatePool
    .filter((candidate) => getMlbPropSubtype(candidate) === 'strikeout')
    .slice(0, Math.min(2, Math.max(0, candidateLimit - 1)));

  if (!reservedStrikeouts.length) {
    return candidatePool.slice(0, candidateLimit);
  }

  const reservedIds = new Set(reservedStrikeouts.map((candidate) => candidate.candidateId));
  const remainingCandidates = candidatePool
    .filter((candidate) => !reservedIds.has(candidate.candidateId))
    .slice(0, Math.max(0, candidateLimit - reservedStrikeouts.length));
  const selectedIds = new Set([
    ...remainingCandidates.map((candidate) => candidate.candidateId),
    ...reservedStrikeouts.map((candidate) => candidate.candidateId)
  ]);

  return candidatePool
    .filter((candidate) => selectedIds.has(candidate.candidateId))
    .slice(0, candidateLimit);
}

function capNrlCandidatePool(eventContext, candidatePool, candidateLimit) {
  if (candidatePool.length <= candidateLimit) {
    return candidatePool;
  }

  const selectedIds = new Set();
  const reserve = (predicate, limit, uniquenessSelector = null) => {
    let count = 0;
    const uniqueValues = new Set();

    for (const candidate of candidatePool) {
      if (selectedIds.size >= candidateLimit || count >= limit || selectedIds.has(candidate.candidateId) || !predicate(candidate)) {
        continue;
      }

      const uniqueValue = uniquenessSelector ? uniquenessSelector(candidate) : null;

      if (uniquenessSelector && (!uniqueValue || uniqueValues.has(uniqueValue))) {
        continue;
      }

      selectedIds.add(candidate.candidateId);
      count += 1;

      if (uniqueValue) {
        uniqueValues.add(uniqueValue);
      }
    }
  };

  reserve((candidate) => isFirstHalfTotalCandidate(candidate), 1);
  reserve((candidate) => isFullGameTotalCandidate(candidate), 1);
  reserve((candidate) => isFirstHalfSpreadCandidate(candidate) && isAllowedNrlSpreadPoint(candidate), 2);
  reserve((candidate) => isFullGameSpreadCandidate(candidate) && isAllowedNrlSpreadPoint(candidate), 2);
  reserve(
    (candidate) => isAllowedNrlPlayerPointsCandidate(candidate, eventContext),
    2,
    (candidate) => normalizeText(candidate?.description)
  );
  reserve((candidate) => normalizeText(candidate?.market) === 'h2h', 1);

  const selectedCandidates = candidatePool.filter((candidate) => selectedIds.has(candidate.candidateId));

  if (selectedCandidates.length >= candidateLimit) {
    return selectedCandidates.slice(0, candidateLimit);
  }

  return [
    ...selectedCandidates,
    ...candidatePool.filter((candidate) => !selectedIds.has(candidate.candidateId))
  ].slice(0, candidateLimit);
}

function capAflCandidatePool(candidatePool, candidateLimit) {
  if (candidatePool.length <= candidateLimit) {
    return candidatePool;
  }

  const selectedIds = new Set();
  const reserveDisposals = (predicate, limit) => {
    let count = 0;
    const playerKeys = new Set();

    for (const candidate of candidatePool) {
      if (selectedIds.size >= candidateLimit
        || count >= limit
        || selectedIds.has(candidate.candidateId)
        || getAflPropSubtype(candidate) !== 'disposal'
        || !predicate(candidate)) {
        continue;
      }

      const playerKey = normalizeText(candidate?.description);

      if (!playerKey || playerKeys.has(playerKey)) {
        continue;
      }

      selectedIds.add(candidate.candidateId);
      playerKeys.add(playerKey);
      count += 1;
    }
  };

  reserveDisposals((candidate) => isPreferredAflHighVolumeCandidate(candidate), Math.min(6, candidateLimit));
  reserveDisposals((candidate) => getAflDisposalLine(candidate) === 15, Math.max(0, candidateLimit - selectedIds.size));
  // Line=10 candidates no longer get reserved slots — they compete on raw score only.
  // Reserved slots were causing bench/rotation players to crowd out higher-quality picks.

  const selectedCandidates = candidatePool.filter((candidate) => selectedIds.has(candidate.candidateId));

  if (selectedCandidates.length >= candidateLimit) {
    return selectedCandidates.slice(0, candidateLimit);
  }

  return [
    ...selectedCandidates,
    ...candidatePool.filter((candidate) => !selectedIds.has(candidate.candidateId))
  ].slice(0, candidateLimit);
}

function capCandidatePoolForSport(eventContext, candidatePool, candidateLimit) {
  if (isSport(eventContext, 'afl')) {
    return capAflCandidatePool(candidatePool, candidateLimit);
  }

  if (isSport(eventContext, 'mlb')) {
    return capMlbCandidatePool(candidatePool, candidateLimit);
  }

  if (isSport(eventContext, 'nrl')) {
    return capNrlCandidatePool(eventContext, candidatePool, candidateLimit);
  }

  return candidatePool.slice(0, candidateLimit);
}

function getSideSelectionKey(candidate) {
  if (candidate?.family !== 'side') {
    return '';
  }

  return normalizeText(candidate?.outcomeName || candidate?.description || candidate?.label || '');
}

function isCompatibleNrlTotalPair(left, right, eventContext) {
  if (!isSport(eventContext, 'nrl')) {
    return false;
  }

  const marketKeys = new Set([getNrlSafeMarketKey(left), getNrlSafeMarketKey(right)]);

  return marketKeys.has('total') && marketKeys.has('first_half_total');
}

function isCompatibleNrlSidePair(left, right, eventContext) {
  if (!isSport(eventContext, 'nrl')) {
    return false;
  }

  const marketKeys = new Set([getNrlSafeMarketKey(left), getNrlSafeMarketKey(right)]);

  if (!marketKeys.has('spread') || !marketKeys.has('first_half_spread')) {
    return false;
  }

  if (!isAllowedNrlSpreadPoint(left) || !isAllowedNrlSpreadPoint(right)) {
    return false;
  }

  const leftSideKey = getSideSelectionKey(left);
  const rightSideKey = getSideSelectionKey(right);

  return Boolean(leftSideKey) && leftSideKey === rightSideKey;
}

function isCandidateCompatible(left, right, eventContext = null) {
  if (left.key === right.key) {
    return false;
  }

  if (left.conflictGroup === right.conflictGroup) {
    return false;
  }

  if (left.family === 'side' && right.family === 'side' && !isCompatibleNrlSidePair(left, right, eventContext)) {
    return false;
  }

  if (left.family === 'total' && right.family === 'total') {
    if (!isCompatibleNrlTotalPair(left, right, eventContext)) {
      return false;
    }
  }

  if (left.subjectKey === right.subjectKey && left.family === 'prop' && right.family === 'prop') {
    return false;
  }

  return true;
}

function areComboCompatible(candidates, eventContext = null) {
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      if (!isCandidateCompatible(candidates[leftIndex], candidates[rightIndex], eventContext)) {
        return false;
      }
    }
  }

  return true;
}

function passesSportSpecificComboRules(eventContext, candidates) {
  if (isSport(eventContext, 'nrl')) {
    const nrlProfile = getNrlComboProfile(candidates);

    if (nrlProfile.unsupportedCount > 0 || nrlProfile.invalidSpreadCount > 0) {
      return false;
    }

    if (nrlProfile.fullGameTotalCount > 1
      || nrlProfile.firstHalfTotalCount > 1
      || nrlProfile.fullGameSpreadCount > 1
      || nrlProfile.firstHalfSpreadCount > 1
      || nrlProfile.h2hCount > 1
      || nrlProfile.playerPointsCount > 1) {
      return false;
    }

    if (candidates.length === 3) {
      // Three distinct safe categories, no H2H, anchored by at least one
      // protected plus line. When no safe total line exists (books often sit
      // in the blocked 44-51 under range), the kicker-points leg may stand in
      // as the third category alongside the full-game/first-half line pair.
      return nrlProfile.h2hCount === 0
        && (nrlProfile.totalCount >= 1 || nrlProfile.playerPointsCount === 1)
        && nrlProfile.spreadCount >= 1
        && nrlProfile.uniqueSafeMarketCount === 3;
    }

    if (candidates.length === 2) {
      if (nrlProfile.h2hCount === 1) {
        return nrlProfile.totalCount === 1
          && nrlProfile.spreadCount === 0
          && nrlProfile.playerPointsCount === 0
          && nrlProfile.uniqueSafeMarketCount === 1;
      }

      if (nrlProfile.h2hCount !== 0 || nrlProfile.uniqueSafeMarketCount !== 2) {
        return false;
      }

      return (
        (nrlProfile.totalCount === 1 && nrlProfile.spreadCount === 1 && nrlProfile.playerPointsCount === 0)
        || (nrlProfile.totalCount === 1 && nrlProfile.spreadCount === 0 && nrlProfile.playerPointsCount === 1)
        || (nrlProfile.totalCount === 0 && nrlProfile.spreadCount === 1 && nrlProfile.playerPointsCount === 1)
      );
    }

    return false;
  }

  if (isSport(eventContext, 'afl')) {
    const comboProfile = getComboProfile(candidates);

    if (candidates.length > 3) {
      return false;
    }

    if (comboProfile.totalCount > 0 || comboProfile.h2hCount > 0 || comboProfile.spreadCount > 0) {
      return false;
    }

    if (comboProfile.aflDisposalsCount < 2) {
      return false;
    }

    if (comboProfile.aflGoalCount > 1) {
      return false;
    }

    // Reject all-disposal combos where every leg is line ≤12 (all-10 problem).
    // At least one leg must be at line ≥15 to ensure we're targeting starters.
    if (comboProfile.aflDisposalsCount === candidates.length) {
      const maxLine = getAflMaxDisposalLine(candidates);
      if (maxLine !== null && maxLine < 15) {
        return false;
      }
    }
  }

  if (isSport(eventContext, 'nba') && candidates.length >= 3) {
    // All-same-stat 3-leg combos (e.g. 3 assist legs) are highly correlated:
    // when the game script suppresses one player's stat, it tends to suppress all of them.
    const subtypes = candidates.map((c) => getNbaPropSubtype(c)).filter(Boolean);
    if (subtypes.length === candidates.length && new Set(subtypes).size === 1) {
      return false;
    }
  }

  return true;
}

function getAflMaxDisposalLine(candidates) {
  const lines = candidates
    .filter((c) => getAflPropSubtype(c) === 'disposal')
    .map((c) => getAflDisposalLine(c))
    .filter((v) => v !== null);
  return lines.length ? Math.max(...lines) : null;
}

function buildCandidateCombinations(candidates, minSize, maxSize) {
  const combinations = [];

  function visit(startIndex, current) {
    if (current.length >= minSize) {
      combinations.push([...current]);
    }

    if (current.length === maxSize) {
      return;
    }

    for (let index = startIndex; index < candidates.length; index += 1) {
      current.push(candidates[index]);
      visit(index + 1, current);
      current.pop();
    }
  }

  visit(0, []);
  return combinations;
}

function getCandidateResearchStatus(candidate) {
  return normalizeText(candidate?.researchStatus);
}

function getCandidateResearchGapSeverity(candidate) {
  return normalizeText(candidate?.researchGapSeverity);
}

function isSoftPartialResearchCandidate(candidate) {
  return getCandidateResearchStatus(candidate) === 'partial' && getCandidateResearchGapSeverity(candidate) === 'soft';
}

function getCandidateFormSignalScore(candidate) {
  return Math.max(-0.03, Math.min(0.03, toNumber(candidate?.formSignalScore) || 0));
}

function getCandidateExternalSignalScore(candidate) {
  return Math.max(0, Math.min(0.025, toNumber(candidate?.externalSignalScore) || 0));
}

function summarizeComboResearch(candidates) {
  const actionableResearch = candidates
    .map((candidate) => ({
      status: getCandidateResearchStatus(candidate),
      softPartial: isSoftPartialResearchCandidate(candidate)
    }))
    .filter((entry) => entry.status && entry.status !== 'not applicable' && entry.status !== 'not_applicable');
  const hasResearchAnnotations = actionableResearch.length > 0;
  const hasProp = candidates.some((candidate) => candidate.family === 'prop');
  const allVerified = hasResearchAnnotations && actionableResearch.every((entry) => entry.status === 'verified');
  const allVerifiedOrSoft = hasResearchAnnotations && actionableResearch.every((entry) => entry.status === 'verified' || entry.softPartial);
  const hasResearchGaps = actionableResearch.some((entry) => entry.status === 'blocked' || entry.status === 'unverified' || (entry.status === 'partial' && !entry.softPartial));
  const hasOnlySoftResearchGaps = hasResearchAnnotations && !allVerified && allVerifiedOrSoft;
  const reasons = candidates.flatMap((candidate) => Array.isArray(candidate?.researchReasons) ? candidate.researchReasons : []);
  const researchNote = allVerified
    ? 'Pre-pick research cleared the selected legs.'
    : hasOnlySoftResearchGaps && reasons.length
      ? `Pre-pick research cleared the selected legs with fallback context: ${reasons.slice(0, 3).join(' | ')}`
    : hasResearchGaps && reasons.length
      ? `Research gaps remain: ${reasons.slice(0, 3).join(' | ')}`
      : 'Rules mode used market structure and bookmaker support only.';

  return {
    hasResearchAnnotations,
    allVerified,
    allVerifiedOrSoft,
    hasResearchGaps,
    note: researchNote,
    playerAvailability: hasResearchAnnotations
      ? (allVerifiedOrSoft || !hasProp ? 'pass' : 'fail')
      : (hasProp ? 'not_applicable' : 'pass'),
    roleStability: hasResearchAnnotations
      ? (allVerifiedOrSoft || !hasProp ? 'pass' : 'fail')
      : (hasProp ? 'not_applicable' : 'pass'),
    externalConditions: hasResearchAnnotations ? (allVerifiedOrSoft ? 'pass' : 'fail') : 'not_applicable',
    researchConfidence: hasResearchAnnotations ? (allVerifiedOrSoft ? 'pass' : 'fail') : 'not_applicable'
  };
}

function estimateCandidateModelProbability(candidate, eventContext) {
  const generatorConfig = eventContext?.generatorConfig || {};
  const bestPrice = toNumber(candidate?.bestPrice);
  let probability = 0.56;

  if (candidate.family === 'prop') {
    probability += 0.12;
  } else if (candidate.family === 'total') {
    probability += 0.05;
  } else if (candidate.market === 'h2h' && shouldPreferPlayerProps(eventContext)) {
    probability -= 0.03;
  }

  probability += Math.min(0.06, Math.max(0, candidate.booksChecked - Number(generatorConfig.minBooks || 1)) * 0.02);

  if (candidate.source === 'snapshot' || candidate.source === 'web-scrape') {
    probability += 0.01;
  }

  const nbaSubtype = getNbaPropSubtype(candidate);
  const mlbSubtype = getMlbPropSubtype(candidate);

  if (nbaSubtype === 'assist' || nbaSubtype === 'rebound' || nbaSubtype === 'combo') {
    // Increase probability for 'Combo' markets as they are the safest floors
    probability += nbaSubtype === 'combo' ? 0.09 : 0.05;
  } else if (nbaSubtype === 'points') {
    // Neutralize points penalty for Star players (safety buffer)
    if (isNbaStarCandidate(candidate)) {
      probability += 0.03;
    } else {
      probability -= 0.02;
    }
  } else if (nbaSubtype === 'three' || nbaSubtype === 'steal' || nbaSubtype === 'block') {
    probability -= 0.06;
  }

  if (mlbSubtype === 'hit') {
    probability += 0.08;
  } else if (mlbSubtype === 'strikeout') {
    probability += 0.04;
  } else if (mlbSubtype === 'hrr') {
    probability += 0.01;
  } else if (mlbSubtype === 'total_bases') {
    probability -= 0.01;
  } else if (mlbSubtype === 'rbi') {
    probability -= 0.05;
  }

  if (candidate.family === 'total' && mlbSubtype === null) {
    probability -= 0.02;
  }

  if (isSport(eventContext, 'mlb') && bestPrice !== null) {
    if (mlbSubtype === 'hit') {
      probability = Math.min(
        probability,
        Math.max(0.42, Math.min(0.74, (1 / bestPrice) - 0.035))
      );
    } else if (mlbSubtype === 'strikeout') {
      probability = Math.min(
        probability,
        Math.max(0.38, Math.min(0.68, (1 / bestPrice) - 0.04))
      );
    }
  }

  if (isSport(eventContext, 'afl')) {
    const aflSubtype = getAflPropSubtype(candidate);

    if (aflSubtype === 'disposal') {
      probability += 0.05;
      // Star player role reliability boost
      if (isPreferredAflHighVolumeCandidate(candidate)) {
        probability += 0.08;
      }
    } else if (aflSubtype === 'goal') {
      probability -= 0.04;
    }
  }

  if (isSport(eventContext, 'nrl') && normalizeText(candidate.market) === 'h2h') {
    probability -= 0.03;
  }

  const researchStatus = getCandidateResearchStatus(candidate);
  const isSoftPartialResearch = isSoftPartialResearchCandidate(candidate);

  if (researchStatus === 'verified') {
    probability += 0.03;
  } else if (researchStatus === 'partial') {
    probability -= isSoftPartialResearch ? 0.01 : 0.05;
  } else if (researchStatus === 'unverified') {
    probability -= 0.08;
  } else if (researchStatus === 'blocked') {
    probability -= 0.15;
  }

  probability += getCandidateFormSignalScore(candidate);
  probability += getCandidateExternalSignalScore(candidate);

  return Math.max(0.15, Math.min(0.9, Number(probability.toFixed(4))));
}

function estimateCombinedModelProbability(candidates, eventContext) {
  return candidates.reduce((total, candidate) => {
    const probability = estimateCandidateModelProbability(candidate, eventContext);

    if (total === null || probability === null) {
      return null;
    }

    return total * probability;
  }, 1);
}

function getCorrelationRisk(candidates) {
  const comboProfile = getComboProfile(candidates);
  const familyCounts = new Map();

  for (const candidate of candidates) {
    const count = familyCounts.get(candidate.family) || 0;
    familyCounts.set(candidate.family, count + 1);
  }

  if (comboProfile.mlbHitCount >= 2 && hasSameTeamMlbHitPair(candidates)) {
    return 'high';
  }

  if (comboProfile.mlbHitCount >= 2) {
    return 'medium';
  }

  if ([...familyCounts.values()].some((count) => count >= 3)) {
    return 'medium';
  }

  if (comboProfile.h2hCount > 0 && comboProfile.propCount > 0) {
    return 'medium';
  }

  if (comboProfile.propCount >= 2) {
    return 'low';
  }

  return 'low';
}

function getDataConfidence(candidates) {
  const minBooks = Math.min(...candidates.map((candidate) => candidate.booksChecked));
  const averageBooks = candidates.reduce((sum, candidate) => sum + candidate.booksChecked, 0) / candidates.length;
  const propCount = candidates.filter((candidate) => candidate.family === 'prop').length;
  const isScrapedMarketOnly = candidates.every((candidate) => candidate.source === 'web-scrape' || candidate.source === 'snapshot');
  const researchSignals = candidates
    .map((candidate) => ({
      status: getCandidateResearchStatus(candidate),
      softPartial: isSoftPartialResearchCandidate(candidate)
    }))
    .filter((entry) => Boolean(entry.status));

  if (researchSignals.some((entry) => entry.status === 'blocked' || (entry.status === 'partial' && !entry.softPartial))) {
    return 'low';
  }

  if (propCount > 0 && researchSignals.some((entry) => entry.status === 'unverified')) {
    return 'low';
  }

  if (minBooks >= 3 && averageBooks >= 3 && propCount <= 1) {
    return 'high';
  }

  if (minBooks >= 2 || (isScrapedMarketOnly && minBooks >= 1)) {
    return 'medium';
  }

  return 'low';
}

function computeSupportScore(candidates, eventContext, dataConfidence, correlationRisk) {
  if (!candidates.length) {
    return null;
  }

  const averageProbability = candidates
    .map((candidate) => estimateCandidateModelProbability(candidate, eventContext))
    .reduce((sum, probability) => sum + probability, 0) / candidates.length;
  const comboProfile = getComboProfile(candidates);
  const researchSignals = candidates
    .map((candidate) => ({
      status: getCandidateResearchStatus(candidate),
      softPartial: isSoftPartialResearchCandidate(candidate)
    }))
    .filter((entry) => Boolean(entry.status));
  let score = averageProbability * 10;

  if (candidates.length === 3) {
    score -= 0.4;
  } else if (candidates.length >= 4) {
    score -= 0.8;
  }

  if (dataConfidence === 'high') {
    score += 0.4;
  } else if (dataConfidence === 'low') {
    score -= 0.8;
  }

  if (correlationRisk === 'medium') {
    score -= 0.8;
  } else if (correlationRisk === 'high') {
    score -= 1.8;
  }

  if (researchSignals.length) {
    if (researchSignals.every((entry) => entry.status === 'verified')) {
      score += 0.45;
    } else if (researchSignals.every((entry) => entry.status === 'verified' || entry.softPartial)) {
      score += 0.05;
    } else {
      score -= 0.9;
    }
  }

  if (shouldPreferPlayerProps(eventContext)) {
    if (comboProfile.propCount >= Math.min(2, candidates.length)) {
      score += 0.6;
    }

    if (comboProfile.h2hCount > 0) {
      score -= comboProfile.h2hCount * (comboProfile.propCount > 0 ? 0.6 : 1.0);
    }
  }

  if (isSport(eventContext, 'nba')) {
    // Prioritize actual Combos (PRA, PA, etc) with a higher weight
    const combos = candidates.filter(c => getNbaPropSubtype(c) === 'combo').length;
    score += combos * 0.75;
    score += (comboProfile.nbaStablePropCount - combos) * 0.35;

    // Allow variety for Stars; only penalize multiple role-player points
    const starPoints = candidates.filter(isNbaStarCandidate).length;
    const rolePoints = comboProfile.nbaPointsCount - starPoints;

    if (rolePoints > 1) {
      score -= (rolePoints - 1) * 0.45;
    }
    
    // High-Stakes context (Finals) increases reliability for Stars
    if (isNbaHighStakes(eventContext)) {
      score += starPoints * 0.6;
    }

    score -= comboProfile.nbaVolatilePropCount * 0.5;
  }

  if (isSport(eventContext, 'mlb')) {
    score += comboProfile.mlbHitCount === 2 && candidates.length === 2 ? 0.2 : 0;
    score -= comboProfile.mlbTotalCount * 0.6;
    score -= comboProfile.mlbRbiCount * 0.45;

    if (hasSameTeamMlbHitPair(candidates)) {
      score -= 1.6;
    }
  }

  if (isSport(eventContext, 'nrl')) {
    const nrlProfile = getNrlComboProfile(candidates);

    score -= nrlProfile.h2hCount * 1.8;

    if (nrlProfile.playerPointsCount === 1) {
      score += 0.45;
    }

    if (nrlProfile.totalCount >= 1 && nrlProfile.uniqueSafeMarketCount === candidates.length) {
      score += candidates.length === 3 ? 0.85 : 0.35;
    }
  }

  if (isSport(eventContext, 'afl')) {
    score += comboProfile.aflDisposalsCount * 0.9;
    score -= comboProfile.aflGoalCount * 0.45;
    score -= comboProfile.totalCount * 1.4;
    score -= comboProfile.h2hCount * 1.6;
    score -= comboProfile.spreadCount * 1.6;

    if (comboProfile.aflDisposalsCount === candidates.length) {
      score += 1.1;
    }

    if (comboProfile.propCount === 0) {
      score -= 1.4;
    }

    if (comboProfile.aflDisposalsCount >= 2) {
      score += 0.6;
    }

    if (comboProfile.aflDisposalsCount >= 3) {
      score += 0.9;
    }

    // Reward builds that rely on high-volume reliable roles
    const starCount = candidates.filter(isPreferredAflHighVolumeCandidate).length;
    if (starCount > 0) {
      score += starCount * 1.25;
    }

    if (candidates.length === 2 && comboProfile.aflDisposalsCount === 2) {
      score += 0.35;
    }

    if (comboProfile.aflGoalCount > comboProfile.aflDisposalsCount) {
      score -= 0.6;
    }
  }

  return roundMetric(Math.max(0, Math.min(10, score)));
}

function supportsSportSpecificExtendedOdds(eventContext, candidates, comboProfile, observedComboOdds) {
  if (!Number.isFinite(observedComboOdds)) {
    return false;
  }

  if (isSport(eventContext, 'afl')) {
    return false;
  }

  if (isSport(eventContext, 'nrl')) {
    const nrlProfile = getNrlComboProfile(candidates);

    return candidates.length === 3
      && observedComboOdds <= NRL_THREE_LEG_ODDS_MAX
      && nrlProfile.h2hCount === 0
      && nrlProfile.uniqueSafeMarketCount === 3
      && nrlProfile.unsupportedCount === 0
      && nrlProfile.invalidSpreadCount === 0;
  }

  return false;
}

function supportsSportSpecificHighOddsCeiling(eventContext, candidates, comboProfile, observedComboOdds) {
  if (!Number.isFinite(observedComboOdds)) {
    return false;
  }

  return false;
}

function getSupportProjection(supportScore, dataConfidence) {
  if (supportScore !== null && supportScore >= 7.5 && dataConfidence !== 'low') {
    return 'strong';
  }

  if (supportScore !== null && supportScore >= 5.5) {
    return 'moderate';
  }

  return 'weak';
}

function getConfidenceTier(supportScore, dataConfidence, correlationRisk) {
  if (supportScore !== null && supportScore >= 8 && dataConfidence === 'high' && correlationRisk === 'low') {
    return 'extreme';
  }

  if (supportScore !== null && supportScore >= 7 && dataConfidence !== 'low' && correlationRisk !== 'high') {
    return 'high';
  }

  if (supportScore !== null && supportScore >= 5.5 && dataConfidence !== 'low') {
    return 'medium';
  }

  return 'low';
}

function buildRecommendation(legCount) {
  if (legCount <= 1) {
    return 'build_single';
  }

  if (legCount === 2) {
    return 'build_2_leg_multi';
  }

  if (legCount === 3) {
    return 'build_3_leg_multi';
  }

  return 'build_4_leg_multi';
}

function buildRulesSelectionDecision(candidate, eventContext) {
  return {
    candidateId: candidate.candidateId,
    modelProbability: estimateCandidateModelProbability(candidate, eventContext),
    rationale: `Rules engine kept ${candidate.label} because it matched the preferred market shape and showed support across ${candidate.booksChecked} books.`
  };
}

function evaluateRulesCandidateCombo(context, eventContext, candidates, indexByCandidateId) {
  if (!areComboCompatible(candidates, eventContext)) {
    return null;
  }

  if (!passesSportSpecificComboRules(eventContext, candidates)) {
    return null;
  }

  const combinedModelProbability = estimateCombinedModelProbability(candidates, eventContext);
  const dataConfidence = getDataConfidence(candidates);
  const correlationRisk = getCorrelationRisk(candidates);
  const supportScore = computeSupportScore(candidates, eventContext, dataConfidence, correlationRisk);
  const supportProjection = getSupportProjection(supportScore, dataConfidence);
  const confidenceTier = getConfidenceTier(supportScore, dataConfidence, correlationRisk);
  const exceptionalSupport = supportScore !== null && supportScore >= Number(context.config.benchmarkFilters.significantSupportScore || 5);
  const strongSupport = supportScore !== null && supportScore >= Number(context.config.benchmarkFilters.strongSupportScore || 8);
  const benchmark = evaluatePickAgainstBenchmarks({
    betType: candidates.length > 1 ? 'sgm' : 'single',
    modelProbability: combinedModelProbability,
    supportScore,
    confidenceTier,
    supportProjection,
    dataConfidence,
    correlationRisk,
    correlationJustified: correlationRisk !== 'high',
    exceptionalSupport,
    strongSupport
  }, context.config.benchmarkFilters);
  const rankScore = candidates.reduce((sum, candidate) => sum + Math.max(0, 18 - (indexByCandidateId.get(candidate.candidateId) || 0) * 2), 0);
  const diversityBonus = new Set(candidates.map((candidate) => candidate.family)).size * 1.5;
  const legCountBonus = candidates.length === getLegRange(eventContext).preferred ? 3 : 0;
  const confidenceBonus = dataConfidence === 'high' ? 3 : dataConfidence === 'medium' ? 1.5 : 0;
  const correlationPenalty = correlationRisk === 'high' ? 4 : correlationRisk === 'medium' ? 1.5 : 0;
  const comboProfile = getComboProfile(candidates);
  const observedComboOdds = estimateObservedComboOdds(candidates);
  const extendedOddsSupported = supportsExtendedOdds({
    supportScore,
    confidenceTier,
    supportProjection,
    dataConfidence,
    correlationRisk,
    strongSupport,
    exceptionalSupport
  }, observedComboOdds) || supportsSportSpecificExtendedOdds(eventContext, candidates, comboProfile, observedComboOdds);
  const sportSpecificHighOddsCeiling = supportsSportSpecificHighOddsCeiling(eventContext, candidates, comboProfile, observedComboOdds);
  const allowsSportFallbackOdds = shouldForceSameEventFallback(eventContext);
  let requiresFallbackOdds = false;

  if (observedComboOdds !== null) {
    if (isSport(eventContext, 'afl') && observedComboOdds > SAFE_GENERATED_TOTAL_ODDS_TARGET_MAX && !allowsSportFallbackOdds) {
      return null;
    }

    if (observedComboOdds > SAFE_GENERATED_TOTAL_ODDS_HARD_MAX && !sportSpecificHighOddsCeiling) {
      return null;
    }

    if (observedComboOdds > SAFE_GENERATED_TOTAL_ODDS_TARGET_MAX && !extendedOddsSupported && !allowsSportFallbackOdds) {
      return null;
    }

    if (observedComboOdds > SAFE_GENERATED_TOTAL_ODDS_TARGET_MAX && !extendedOddsSupported && allowsSportFallbackOdds) {
      requiresFallbackOdds = true;
    }
  }

  const propPreferenceBonus = shouldPreferPlayerProps(eventContext)
    ? comboProfile.propCount * 2 + (comboProfile.h2hCount === 0 ? 2.5 : 0)
    : 0;
  const h2hPenalty = shouldPreferPlayerProps(eventContext)
    ? (comboProfile.h2hCount > 0
      ? (comboProfile.propCount > 0 ? comboProfile.h2hCount * 2.5 : comboProfile.h2hCount * 5)
      : 0)
    : 0;
  const nbaStabilityBonus = isSport(eventContext, 'nba') ? comboProfile.nbaStablePropCount * 1.6 : 0;
  const nbaComboPriorityBonus = isSport(eventContext, 'nba') 
    ? (candidates.filter(c => getNbaPropSubtype(c) === 'combo').length * 2.5) 
    : 0;
  const nbaHighStakesBonus = (isSport(eventContext, 'nba') && isNbaHighStakes(eventContext)) ? 3.5 : 0;
  const nbaPointsPenalty = isSport(eventContext, 'nba') && comboProfile.nbaPointsCount > 1 ? (comboProfile.nbaPointsCount - 1) * 2.2 : 0;
  const nbaVolatilityPenalty = isSport(eventContext, 'nba') ? comboProfile.nbaVolatilePropCount * 2 : 0;
  const aflDisposalBonus = isSport(eventContext, 'afl') ? comboProfile.aflDisposalsCount * 1.8 : 0;
  const aflDisposalLedBonus = isSport(eventContext, 'afl') && comboProfile.aflDisposalsCount >= Math.max(1, comboProfile.aflGoalCount)
    ? 2.5
    : 0;
  const aflComboTargetBonus = isSport(eventContext, 'afl') && observedComboOdds !== null
    ? (observedComboOdds >= 1.9 && observedComboOdds <= 2.3
      ? 4.5
      : observedComboOdds >= 1.75 && observedComboOdds <= 2.55
        ? 2
        : 0)
    : 0;
  const aflGoalPenalty = isSport(eventContext, 'afl') ? comboProfile.aflGoalCount * 2.2 : 0;
  const aflComboStretchPenalty = isSport(eventContext, 'afl') && observedComboOdds !== null && observedComboOdds > 2.55
    ? Math.min(3.2, (observedComboOdds - 2.55) * 4.2)
    : 0;
  const aflComboFloorPenalty = isSport(eventContext, 'afl') && observedComboOdds !== null && observedComboOdds < 1.90
    ? 5.0
    : 0;
  const nrlStructureBonus = isSport(eventContext, 'nrl')
    ? (() => {
      const nrlProfile = getNrlComboProfile(candidates);
      let bonus = 0;

      if (candidates.length === 3 && nrlProfile.h2hCount === 0) {
        bonus += 1.1;
      }

      if (nrlProfile.totalCount >= 1 && nrlProfile.spreadCount >= 1) {
        bonus += 0.8;
      }

      if (nrlProfile.playerPointsCount === 1) {
        bonus += 0.9;
      }

      if (nrlProfile.uniqueSafeMarketCount === candidates.length) {
        bonus += 0.6;
      }

      return bonus;
    })()
    : 0;
  // 2-leg builds target the short 2.0-2.3x band; 3-leg line+line+kicker mixes
  // structurally price ~3.3-4.6x, so they get their own band instead of being
  // crushed by the 2-leg stretch penalty.
  const nrlComboOddsCeiling = candidates.length === 3 ? NRL_THREE_LEG_ODDS_MAX : 2.3;
  const nrlComboStretchStart = candidates.length === 3 ? NRL_THREE_LEG_ODDS_MAX : 2.40;
  const nrlComboTargetBonus = isSport(eventContext, 'nrl') && observedComboOdds !== null
    ? (observedComboOdds >= 2.0 && observedComboOdds <= nrlComboOddsCeiling
      ? 5.0
      : 0)
    : 0;
  const nrlComboStretchPenalty = isSport(eventContext, 'nrl') && observedComboOdds !== null && observedComboOdds > nrlComboStretchStart
    ? Math.min(8.0, (observedComboOdds - nrlComboStretchStart) * 12.0)
    : 0;
  const nrlStructurePenalty = isSport(eventContext, 'nrl')
    ? (() => {
      const nrlProfile = getNrlComboProfile(candidates);
      let penalty = nrlProfile.h2hCount * 3.6;
      // Additional penalty for negative lines if they somehow bypassed filters
      if (nrlProfile.invalidSpreadCount > 0) {
        penalty += 10.0;
      }
      return penalty;
    })()
    : 0;
  const legacyMlbProfile = isSport(eventContext, 'mlb') && usesLegacyMlbStructureProfile(eventContext);
  const mlbHitStructureBonus = isSport(eventContext, 'mlb')
    ? (legacyMlbProfile
      ? (comboProfile.mlbHitCount >= 2 ? 4.5 : comboProfile.mlbHitCount === 1 ? 1.5 : 0)
      : (comboProfile.mlbHitCount >= 2 ? 3 : comboProfile.mlbHitCount === 1 ? 1.25 : 0))
    : 0;
  const mlbSameSideHitStrikeoutBonus = isSport(eventContext, 'mlb') && !legacyMlbProfile
    ? (() => {
      if (comboProfile.mlbHitCount !== 1 || comboProfile.mlbStrikeoutCount !== 1) {
        return 0;
      }

      const hitCandidate = candidates.find((candidate) => getMlbPropSubtype(candidate) === 'hit');
      const strikeoutCandidate = candidates.find((candidate) => getMlbPropSubtype(candidate) === 'strikeout');
      const hitTeamKey = getMlbCandidateTeamKey(hitCandidate);
      const strikeoutTeamKey = getMlbCandidateTeamKey(strikeoutCandidate);

      return hitTeamKey && strikeoutTeamKey && hitTeamKey === strikeoutTeamKey ? 2.2 : 0;
    })()
    : 0;
  const mlbSoftThirdLegBonus = isSport(eventContext, 'mlb')
    ? (legacyMlbProfile
      ? (comboProfile.mlbHitCount >= 2
        ? (comboProfile.mlbStrikeoutCount > 0 ? 2.5 : comboProfile.propCount >= 3 ? 1.5 : 0)
        : 0)
      : (comboProfile.mlbHitCount > 0 && comboProfile.mlbStrikeoutCount > 0
        ? 1.4
        : comboProfile.mlbStrikeoutCount > 0 && comboProfile.mlbTotalCount === 0
          ? 0.8
          : 0))
    : 0;
  const mlbNoHitPenalty = isSport(eventContext, 'mlb') && !legacyMlbProfile && comboProfile.mlbHitCount === 0 ? 1.25 : 0;
  const mlbTotalsPenalty = isSport(eventContext, 'mlb')
    ? (legacyMlbProfile
      ? comboProfile.mlbTotalCount * 2.4
      : comboProfile.mlbTotalCount * (comboProfile.mlbHitCount >= 2 ? 3.4 : 0.85))
    : 0;
  const mlbRbiPenalty = isSport(eventContext, 'mlb') ? comboProfile.mlbRbiCount * (legacyMlbProfile ? 1.6 : 1.2) : 0;
  const oddsTargetBonus = observedComboOdds !== null && observedComboOdds >= 2 && observedComboOdds <= 3.25 ? 3 : 0;
  const oddsStretchPenalty = observedComboOdds !== null && observedComboOdds > 3.25
    ? Math.min(extendedOddsSupported ? 2.5 : 7, (observedComboOdds - 3.25) * (extendedOddsSupported ? 0.9 : 1.8))
    : 0;
  const oddsCeilingPenalty = observedComboOdds !== null && observedComboOdds > 5
    ? (extendedOddsSupported ? 2.5 : 5)
    : 0;
  const score = rankScore + diversityBonus + legCountBonus + confidenceBonus + propPreferenceBonus + nbaStabilityBonus + nbaComboPriorityBonus + nbaHighStakesBonus + aflDisposalBonus + aflDisposalLedBonus + aflComboTargetBonus + aflComboFloorPenalty + nrlStructureBonus + nrlComboTargetBonus + mlbHitStructureBonus + mlbSameSideHitStrikeoutBonus + mlbSoftThirdLegBonus + oddsTargetBonus + (supportScore || 0) - correlationPenalty - h2hPenalty - nbaPointsPenalty - nbaVolatilityPenalty - aflGoalPenalty - aflComboStretchPenalty - nrlComboStretchPenalty - nrlStructurePenalty - mlbNoHitPenalty - mlbTotalsPenalty - mlbRbiPenalty - oddsStretchPenalty - oddsCeilingPenalty;

  return {
    candidates,
    combinedModelProbability,
    observedComboOdds,
    supportScore,
    dataConfidence,
    correlationRisk,
    supportProjection,
    confidenceTier,
    exceptionalSupport,
    strongSupport,
    benchmark,
    requiresFallbackOdds,
    score
  };
}

function chooseRulesBackupCandidate(context, eventContext, candidatePool, selectedCandidates) {
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.candidateId));
  const indexByCandidateId = new Map(candidatePool.map((candidate, index) => [candidate.candidateId, index]));
  let bestBackup = null;

  for (const candidate of candidatePool) {
    if (selectedIds.has(candidate.candidateId)) {
      continue;
    }

    for (let replaceIndex = 0; replaceIndex < selectedCandidates.length; replaceIndex += 1) {
      const replacementCombo = selectedCandidates.map((selectedCandidate, index) => index === replaceIndex ? candidate : selectedCandidate);
      const evaluated = evaluateRulesCandidateCombo(context, eventContext, replacementCombo, indexByCandidateId);

      if (!evaluated?.benchmark?.accepted) {
        continue;
      }

      if (!bestBackup || evaluated.score > bestBackup.score) {
        bestBackup = {
          candidate,
          score: evaluated.score
        };
      }
    }
  }

  return bestBackup?.candidate || null;
}

function getCandidateSubjectKey(candidate) {
  return normalizeText(candidate?.subjectKey || candidate?.description || candidate?.label || candidate?.candidateId || '');
}

function chooseAflBonusLegCandidates(candidatePool, selectedCandidates, limit = 2) {
  const selectedIds = new Set(selectedCandidates.map((candidate) => candidate.candidateId));
  const seenSubjects = new Set(selectedCandidates.map((candidate) => getCandidateSubjectKey(candidate)).filter(Boolean));
  const bonusCandidates = [];

  for (const candidate of candidatePool) {
    if (selectedIds.has(candidate.candidateId)) {
      continue;
    }

    if (getAflPropSubtype(candidate) !== 'disposal') {
      continue;
    }

    const subjectKey = getCandidateSubjectKey(candidate);

    if (subjectKey && seenSubjects.has(subjectKey)) {
      continue;
    }

    bonusCandidates.push(candidate);

    if (subjectKey) {
      seenSubjects.add(subjectKey);
    }

    if (bonusCandidates.length >= limit) {
      break;
    }
  }

  return bonusCandidates;
}

function buildStructuredCandidateLeg(candidate, decision, idPrefix) {
  if (!candidate) {
    return null;
  }

  return {
    id: `${idPrefix}-${candidate.candidateId}`,
    label: candidate.label,
    modelProbability: toNumber(decision?.modelProbability),
    rationale: decision?.rationale || candidate.rationale,
    source: {
      type: candidate.source,
      market: candidate.market,
      booksChecked: candidate.booksChecked,
      outcomeName: candidate.outcomeName,
      description: candidate.description,
      point: candidate.point ?? null,
      teamSide: candidate.mlbTeamSide || '',
      teamName: candidate.mlbTeamName || '',
      battingOrderIndex: candidate.mlbBattingOrderIndex ?? null,
      lineupSource: candidate.mlbLineupSource || ''
    }
  };
}

function buildRulesNoBetDecision(eventContext, reason, notes = '') {
  return {
    qualifies: false,
    recommendation: 'no_bet',
    summary: null,
    rationale: reason,
    noBetReason: reason,
    confidenceTier: 'low',
    supportProjection: 'weak',
    dataConfidence: 'low',
    correlationRisk: 'high',
    correlationJustified: false,
    exceptionalSupport: false,
    strongSupport: false,
    combinedModelProbability: null,
    supportScore: null,
    stakeUnits: 0,
    checklist: {
      actionableSlate: 'pass',
      marketDepth: 'fail',
      selectionSupport: 'fail',
      playerAvailability: 'not_applicable',
      roleStability: 'not_applicable',
      externalConditions: 'not_applicable',
      researchConfidence: 'fail',
      correlation: 'fail',
      ticketIntegrity: 'fail',
      bankrollFit: 'pass'
    },
    selectedLegs: [],
    backupLeg: null,
    notes
  };
}

function getLegRange(eventContextOrSportKey) {
  const eventContext = typeof eventContextOrSportKey === 'object' ? eventContextOrSportKey : null;
  const sportKey = typeof eventContextOrSportKey === 'string'
    ? eventContextOrSportKey
    : eventContextOrSportKey?.sportKey;
  const normalizedSportKey = String(sportKey || '').toLowerCase();

  if (normalizedSportKey === 'afl') {
    return { min: 2, max: 3, preferred: 3 };
  }

  if (normalizedSportKey === 'nrl') {
    return { min: 2, max: 3, preferred: 3 };
  }

  if (normalizedSportKey === 'mlb') {
    // v3 featured-single profile: one favourite moneyline or protected +1.5 run line.
    return { min: 1, max: 1, preferred: 1 };
  }

  if (normalizedSportKey.startsWith('soccer')) {
    return { min: 2, max: 3, preferred: 2 };
  }

  if (normalizedSportKey.startsWith('tennis')) {
    return { min: 1, max: 1, preferred: 1 };
  }

  return { min: 2, max: 3, preferred: 2 };
}

function isHardLockedSameGameMultiSport(eventContext) {
  return isSport(eventContext, 'nrl') || isSport(eventContext, 'afl');
}

function shouldForceSameEventFallback(eventContext) {
  return isHardLockedSameGameMultiSport(eventContext);
}

function selectForcedSameEventFallbackCombo(eventContext, evaluatedCombos) {
  if (!shouldForceSameEventFallback(eventContext)) {
    return null;
  }

  const eligibleCombos = evaluatedCombos.filter((combo) => combo.dataConfidence !== 'low' && combo.correlationRisk !== 'high');

  if (!eligibleCombos.length) {
    return null;
  }

  return [...eligibleCombos].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    const rightSupport = Number.isFinite(Number(right.supportScore)) ? Number(right.supportScore) : Number.NEGATIVE_INFINITY;
    const leftSupport = Number.isFinite(Number(left.supportScore)) ? Number(left.supportScore) : Number.NEGATIVE_INFINITY;

    if (rightSupport !== leftSupport) {
      return rightSupport - leftSupport;
    }

    const leftOdds = Number.isFinite(Number(left.observedComboOdds)) ? Number(left.observedComboOdds) : Number.POSITIVE_INFINITY;
    const rightOdds = Number.isFinite(Number(right.observedComboOdds)) ? Number(right.observedComboOdds) : Number.POSITIVE_INFINITY;

    return leftOdds - rightOdds;
  })[0] || null;
}

function buildPromptInput(eventContext, candidatePool, bankrollContext) {
  return {
    objective: 'Evaluate this single sporting event against the SportsTips checklist. Every game that passes will be posted. Do not rank against other games.',
    ticketStylePreference: shouldPreferPlayerProps(eventContext)
      ? 'For team sports, prefer player-prop-led builds and use H2H only as fallback when non-H2H structures are not viable. For AFL, hard-lock generated slips to same-game multis, build only safer 2-3 leg player-prop tickets, require at least two disposal legs, avoid totals, H2H, and spreads entirely, and only use one low-rung goal leg as an optional third complement. If two clean disposal legs are not available, return no_bet. Keep AFL total odds inside the safer 2.0-3.25x range. For MLB, stay fail-closed on a strict 2-leg same-game build: allow either two verified 1+ hit props from separate lineups or one verified 1+ hit plus one conservative strikeout prop from the same side when team metadata confirms the pairing. Skip totals, RBI, H2H, run lines, and total bases in the current profile. If no clean 2-leg hit-led or hit-plus-strikeout structure is available, return no_bet. For NBA, prioritize rebounds, assists, and combo props ahead of pure points ladders and de-prioritize 3pts, steals, and blocks unless the spot is unusually strong. For NRL, hard-lock generated slips to safer 2-3 leg same-game multis, build the cleanest available 3-leg mix first from totals, protected plus lines, and genuine kicker points, then fall back to a clean mixed 2-leg structure only when the third category is missing. Never use negative line legs or race-to-points markets, do not fall back to total-only pairs, and only use H2H as a last-resort fallback when no clean protected-line structure qualifies. Tennis remains H2H-first.'
      : 'Use the standard market mix for this sport.',
    stakeRules: {
      baselineUnits: getBaseStakeUnits(eventContext),
      maxUnits: getConfiguredMaxStakeUnits(eventContext),
      guidance: 'Size dynamically from support, robustness, overlap, and bankroll fit. Do not force every qualifier to 1.00u.'
    },
    event: {
      sportKey: eventContext.sportKey,
      sportLabel: eventContext.sportLabel,
      eventId: eventContext.eventId,
      eventName: eventContext.eventName,
      startTime: eventContext.startTime,
      homeTeam: eventContext.homeTeam,
      awayTeam: eventContext.awayTeam
    },
    sportLegRules: getLegRange(eventContext),
    selectionRules: {
      minimumBooks: eventContext.generatorConfig.minBooks,
      avoidDependentLegs: true,
      rejectSameScriptLadders: true,
      preferSmallerCleanBuilds: true
    },
    bankrollContext,
    candidatePool: candidatePool.map((candidate) => ({
      candidateId: candidate.candidateId,
      label: candidate.label,
      market: candidate.market,
      family: candidate.family,
      outcomeName: candidate.outcomeName,
      description: candidate.description,
      point: candidate.point,
      booksChecked: candidate.booksChecked,
      source: candidate.source,
      rationale: candidate.rationale,
      researchStatus: candidate.researchStatus || 'not_provided',
      researchReasons: Array.isArray(candidate.researchReasons) ? candidate.researchReasons : [],
      formSignalReason: candidate.formSignalReason || '',
      externalSignalReason: candidate.externalSignalReason || '',
      externalSignalSources: Array.isArray(candidate.externalSignalSources) ? candidate.externalSignalSources : []
    }))
  };
}

function buildInstructions(agentBundle, eventContext) {
  const legRange = getLegRange(eventContext);

  return [
    'You are the SportsTips standalone analysis engine.',
    'Emulate the existing SportsTips agent workflow and return JSON only.',
    'Evaluate one event independently. Every event that passes the checklist will be published. Do not rank or compare against other games.',
    'Only use candidateIds from the provided pool. Never invent players, markets, or external facts.',
    'Treat candidate-level researchStatus and researchReasons as mandatory evidence when they are present. Verified candidates are preferred. Partial or unverified prop candidates should normally fail the research checklist.',
    'Treat formSignalReason and externalSignalReason as soft tie-breakers only. They can slightly strengthen or weaken a case, but they must never override hard research failures or structural issues.',
    `This sport should normally land in ${legRange.min === legRange.max ? `${legRange.preferred}` : `${legRange.min}-${legRange.max}`} legs, preferring ${legRange.preferred}.`,
    shouldPreferPlayerProps(eventContext)
      ? 'For team sports, prefer player props when the pool supports them. For AFL, hard-lock generated slips to same-game multis, build only safer 2-3 leg player-prop tickets, require at least two disposal legs, avoid totals, H2H, and spreads entirely, and only use one low-rung goal leg as an optional third complement. If two clean disposal legs are not available, return no_bet. Keep AFL total odds inside the safer 2.0-3.25x range. For MLB, stay fail-closed on a strict 2-leg same-game build: allow either two verified 1+ hit props from separate lineups or one verified 1+ hit plus one conservative strikeout prop from the same side when team metadata confirms the pairing. Skip totals, RBI, H2H, run lines, and total bases in the current profile. If no clean 2-leg hit-led or hit-plus-strikeout structure is available, return no_bet. Use H2H only as fallback when prop-led or other non-H2H builds do not qualify. For NBA, prioritize rebounds, assists, and combo props ahead of pure points ladders and de-prioritize 3pts, steals, and blocks unless the spot is unusually strong. For NRL, hard-lock generated slips to safer 2-3 leg same-game multis, build the cleanest available 3-leg mix first from totals, protected plus lines, and genuine kicker points, then fall back to a clean mixed 2-leg structure only when the third category is missing. Never use negative line legs or race-to-points markets, do not fall back to total-only pairs, and only use H2H as a last-resort fallback when no clean protected-line structure qualifies. Tennis stays H2H-first.'
      : 'Use the normal market mix for this sport.',
    'Treat promo-driven leg counts as optional only unless the input explicitly requires them. For NRL, prefer a clean 3-leg total-line-kicker mix and fall back to 2 legs only when the third category is not safely available; return no_bet when no safe mixed 2-3 leg build qualifies.',
    'If a promo-driven ticket can only reach the required leg count by adding a fragile filler leg, return recommendation=no_bet rather than forcing the structure.',
    'Reject dependent ticket shapes. Never stack laddered legs such as first-half total with full-game total in the same direction, duplicate side ladders, or any pair where one leg failing strongly implies the other likely fails too.',
    'Mark qualifies=true only when every required checklist item is pass or not_applicable, the selected legs form one valid ticket, and the support case is positive.',
    'Use bankroll context for sizing only. Do not fail an otherwise valid event solely because the tracker currently shows zero deployable units.',
    'Use 1.00u as the anchor, not as a mandatory stake on every event. Size dynamically from support, robustness, overlap, and bankroll fit.',
    'If the event is weak, fragile, or structurally invalid, return recommendation=no_bet with qualifies=false.',
    'Agent workflow guidance:',
    agentBundle
  ].join('\n\n');
}

export function buildAnalysisCandidatePool(eventContext, quotes, maxCandidates) {
  const candidateLimit = Math.max(1, Number(maxCandidates || 14));
  const rawCandidateLimit = isSport(eventContext, 'afl')
    ? Math.max(candidateLimit * 4, 60)
    : isSport(eventContext, 'mlb')
      ? Math.max(candidateLimit * 3, 40)
      : isSport(eventContext, 'nrl')
        ? Math.max(candidateLimit * 3, 36)
        : candidateLimit;

  return capCandidatePoolForSport(
    eventContext,
    filterCandidatePoolForSport(
      eventContext,
      buildCandidatePoolForEvent(eventContext, quotes, rawCandidateLimit)
    ),
    candidateLimit
  );
}

export function decisionPassesChecklist(decision, eventContext) {
  const legRange = getLegRange(eventContext);
  const selectedCount = Array.isArray(decision.selectedLegs) ? decision.selectedLegs.length : 0;

  if (!decision?.qualifies || decision.recommendation === 'no_bet') {
    return false;
  }

  if (selectedCount < legRange.min || selectedCount > legRange.max) {
    return false;
  }

  if (isHardLockedSameGameMultiSport(eventContext) && decision.recommendation === 'build_single') {
    return false;
  }

  return Object.values(decision.checklist || {}).every((value) => PASSING_CHECKLIST_VALUES.has(String(value || '').toLowerCase()));
}

export async function analyzeEventWithOpenAi(context, eventContext, candidatePool, bankrollContext) {
  const agentBundle = await loadAnalysisAgentBundle(context.config.__paths.workspaceRoot);
  const promptInput = buildPromptInput(eventContext, candidatePool, bankrollContext);
  const result = await createStructuredOpenAiResponse(context.config.openai, {
    schemaName: 'sports_event_analysis',
    schema: ANALYSIS_DECISION_SCHEMA,
    instructions: buildInstructions(agentBundle, eventContext),
    input: [
      {
        role: 'user',
        content: JSON.stringify(promptInput)
      }
    ],
    metadata: {
      job: 'analysis',
      sport: eventContext.sportKey,
      eventId: eventContext.eventId
    },
    promptCacheKey: `${context.config.openai.promptCachePrefix}:${eventContext.sportKey}`
  });

  if (result.refusal) {
    return {
      qualifies: false,
      recommendation: 'no_bet',
      summary: null,
      rationale: result.refusal,
      noBetReason: result.refusal,
      confidenceTier: 'low',
      supportProjection: 'weak',
      dataConfidence: 'low',
      correlationRisk: 'high',
      correlationJustified: false,
      exceptionalSupport: false,
      strongSupport: false,
      combinedModelProbability: null,
      supportScore: null,
      stakeUnits: 0,
      checklist: {
        actionableSlate: 'fail',
        marketDepth: 'fail',
        selectionSupport: 'fail',
        playerAvailability: 'not_applicable',
        roleStability: 'not_applicable',
        externalConditions: 'not_applicable',
        researchConfidence: 'fail',
        correlation: 'fail',
        ticketIntegrity: 'fail',
        bankrollFit: 'pass'
      },
      selectedLegs: [],
      backupLeg: null,
      notes: 'Model refusal'
    };
  }

  return result.parsed;
}

export async function analyzeEventWithRules(context, eventContext, candidatePool, bankrollContext) {
  const legRange = getLegRange(eventContext);
  const rankedCandidates = shouldForceSameEventFallback(eventContext)
    ? [...candidatePool]
    : isSport(eventContext, 'mlb')
      ? candidatePool.slice(0, Math.min(candidatePool.length, 14))
      : String(eventContext?.sportKey || '').toLowerCase().startsWith('soccer')
        ? candidatePool.slice(0, Math.min(candidatePool.length, 14))
      : candidatePool.slice(0, Math.min(candidatePool.length, 10));

  if (rankedCandidates.length < legRange.min) {
    return buildRulesNoBetDecision(
      eventContext,
      'Not enough market-backed candidates to build a valid ticket.',
      'Rules mode requires a deeper candidate pool before approving an event.'
    );
  }

  const indexByCandidateId = new Map(rankedCandidates.map((candidate, index) => [candidate.candidateId, index]));
  const evaluatedCombos = buildCandidateCombinations(rankedCandidates, legRange.min, legRange.max)
    .map((candidates) => evaluateRulesCandidateCombo(context, eventContext, candidates, indexByCandidateId))
    .filter(Boolean);
  const acceptedCombos = evaluatedCombos
    .filter((combo) => combo.benchmark.accepted && !combo.requiresFallbackOdds)
    .sort((left, right) => right.score - left.score);
  const nrlNonH2hAcceptedCombos = isSport(eventContext, 'nrl')
    ? acceptedCombos.filter((combo) => getComboProfile(combo.candidates).h2hCount === 0)
    : [];
  const aflAllDisposalAcceptedCombos = isSport(eventContext, 'afl')
    ? acceptedCombos.filter((combo) => getComboProfile(combo.candidates).aflDisposalsCount === combo.candidates.length)
    : [];
  const aflDisposalHeavyAcceptedCombos = isSport(eventContext, 'afl')
    ? acceptedCombos.filter((combo) => {
      const comboProfile = getComboProfile(combo.candidates);
      return comboProfile.h2hCount === 0
        && comboProfile.aflDisposalsCount >= Math.max(2, combo.candidates.length - 1);
    })
    : [];
  const aflDisposalLedAcceptedCombos = isSport(eventContext, 'afl')
    ? acceptedCombos.filter((combo) => {
      const comboProfile = getComboProfile(combo.candidates);
      return comboProfile.aflGoalCount <= 1
        && comboProfile.h2hCount === 0
        && comboProfile.aflDisposalsCount >= comboProfile.aflGoalCount
        && comboProfile.aflDisposalsCount > 0;
    })
    : [];
  const aflAnyDisposalAcceptedCombos = isSport(eventContext, 'afl')
    ? acceptedCombos.filter((combo) => {
      const comboProfile = getComboProfile(combo.candidates);
      return comboProfile.aflDisposalsCount > 0 && comboProfile.aflDisposalsCount >= comboProfile.aflGoalCount;
    })
    : [];
  const preferredMinimumPropCount = getPreferredMinimumPropCount(eventContext, legRange.preferred);
  const noH2hAcceptedCombos = shouldPreferPlayerProps(eventContext)
    ? acceptedCombos.filter((combo) => {
      const comboProfile = getComboProfile(combo.candidates);
      return comboProfile.h2hCount === 0 && comboProfile.propCount >= preferredMinimumPropCount;
    })
    : [];
  const mlbSafeAcceptedCombos = isSport(eventContext, 'mlb')
    ? acceptedCombos.filter((combo) => isSafeMlbCombo(combo.candidates, eventContext))
    : [];
  const mlbPreferredAcceptedCombos = isSport(eventContext, 'mlb')
    ? mlbSafeAcceptedCombos.filter((combo) => combo.candidates.length >= legRange.preferred)
    : [];
  const propLedAcceptedCombos = shouldPreferPlayerProps(eventContext)
    ? acceptedCombos.filter((combo) => getComboProfile(combo.candidates).propCount >= preferredMinimumPropCount)
    : [];
  const bestAcceptedCombo = mlbPreferredAcceptedCombos[0]
    || mlbSafeAcceptedCombos[0]
    || nrlNonH2hAcceptedCombos[0]
    || aflAllDisposalAcceptedCombos[0]
    || aflDisposalHeavyAcceptedCombos[0]
    || aflDisposalLedAcceptedCombos[0]
    || aflAnyDisposalAcceptedCombos[0]
    || noH2hAcceptedCombos[0]
    || propLedAcceptedCombos[0]
    || acceptedCombos[0];
  const forcedFallbackCombo = bestAcceptedCombo
    ? null
    : selectForcedSameEventFallbackCombo(eventContext, evaluatedCombos);
  const selectedCombo = bestAcceptedCombo || forcedFallbackCombo;
  const usedForcedFallback = Boolean(forcedFallbackCombo);

  if (isSport(eventContext, 'mlb') && !mlbSafeAcceptedCombos.length) {
    return buildRulesNoBetDecision(
      eventContext,
      usesLegacyMlbStructureProfile(eventContext)
        ? 'MLB rules require at least two clean hit props with no totals, H2H, or RBI fillers.'
        : 'MLB rules require a single favourite moneyline (≤1.65) or a protected +1.5 run-line leg.',
      usesLegacyMlbStructureProfile(eventContext)
        ? 'Rules mode skipped the event because the current market scan did not offer a clean MLB hit-led structure.'
        : 'Rules mode skipped the event because no qualifying favourite moneyline or protected +1.5 run line was available.'
    );
  }

  if (!selectedCombo) {
    const bestRejectedCombo = [...evaluatedCombos].sort((left, right) => right.score - left.score)[0];
    const reason = bestRejectedCombo?.benchmark?.reasons?.[0] || 'No candidate combination passed the benchmark filters.';

    return buildRulesNoBetDecision(
      eventContext,
      reason,
      bestRejectedCombo
        ? `Rules mode reviewed ${evaluatedCombos.length} compatible market-based combinations and rejected them.`
        : 'Rules mode found no compatible candidate combinations.'
    );
  }

  const hasProps = selectedCombo.candidates.some((candidate) => candidate.family === 'prop');
  const stakeUnits = getRecommendedStakeUnits(eventContext, bankrollContext, selectedCombo);
  const backupCandidate = chooseRulesBackupCandidate(context, eventContext, candidatePool, selectedCombo.candidates);
  const researchSummary = summarizeComboResearch(selectedCombo.candidates);
  const baseNotes = researchSummary.hasResearchAnnotations
    ? researchSummary.note
    : hasProps
      ? 'Rules mode inferred structural checks from market data only; player, role, and external-condition checks remain unverified.'
      : 'Rules mode used market structure, support signals, and benchmark filters only.';
  const notes = usedForcedFallback
    ? `${baseNotes} ${String(eventContext?.sportLabel || eventContext?.sportKey || 'This sport')} fallback forced the safest available same-event build after the stricter benchmark pass produced no bet.`
    : baseNotes;

  return {
    qualifies: true,
    recommendation: buildRecommendation(selectedCombo.candidates.length),
    summary: selectedCombo.candidates.map((candidate) => candidate.label).join(' + '),
    rationale: usedForcedFallback
      ? `Rules engine forced the safest available ${selectedCombo.candidates.length}-leg same-event build after the normal benchmark pass returned no bet.`
      : `Rules engine approved a ${selectedCombo.candidates.length}-leg build from market depth, structural fit, and benchmark acceptance.`,
    noBetReason: null,
    confidenceTier: selectedCombo.confidenceTier,
    supportProjection: selectedCombo.supportProjection,
    dataConfidence: selectedCombo.dataConfidence,
    correlationRisk: selectedCombo.correlationRisk,
    correlationJustified: selectedCombo.correlationRisk !== 'high',
    exceptionalSupport: selectedCombo.exceptionalSupport,
    strongSupport: selectedCombo.strongSupport,
    combinedModelProbability: selectedCombo.combinedModelProbability,
    supportScore: selectedCombo.supportScore,
    stakeUnits: Number(stakeUnits.toFixed(2)),
    checklist: {
      actionableSlate: 'pass',
      marketDepth: 'pass',
      selectionSupport: 'pass',
      playerAvailability: researchSummary.hasResearchAnnotations ? researchSummary.playerAvailability : (hasProps ? 'not_applicable' : 'pass'),
      roleStability: researchSummary.hasResearchAnnotations ? researchSummary.roleStability : (hasProps ? 'not_applicable' : 'pass'),
      externalConditions: researchSummary.hasResearchAnnotations ? researchSummary.externalConditions : 'not_applicable',
      researchConfidence: researchSummary.hasResearchAnnotations ? researchSummary.researchConfidence : (selectedCombo.dataConfidence === 'low' ? 'fail' : 'pass'),
      correlation: selectedCombo.correlationRisk === 'high' ? 'fail' : 'pass',
      ticketIntegrity: 'pass',
      bankrollFit: 'pass'
    },
    selectedLegs: selectedCombo.candidates.map((candidate) => buildRulesSelectionDecision(candidate, eventContext)),
    backupLeg: backupCandidate ? buildRulesSelectionDecision(backupCandidate, eventContext) : null,
    notes,
    generatedSource: GENERATED_SOURCE,
    analysisEngine: 'rules'
  };
}

export function buildPickFromAnalysisDecision(eventContext, candidatePool, decision) {
  if (!decisionPassesChecklist(decision, eventContext)) {
    return null;
  }

  const generatedSource = decision.generatedSource || AI_GENERATED_SOURCE;
  const analysisEngine = decision.analysisEngine || (generatedSource === GENERATED_SOURCE ? 'rules' : 'openai');

  const candidateMap = new Map(candidatePool.map((candidate) => [candidate.candidateId, candidate]));
  const seen = new Set();
  const selectedLegs = [];

  for (const legDecision of decision.selectedLegs) {
    const candidate = candidateMap.get(legDecision.candidateId);

    if (!candidate || seen.has(candidate.candidateId)) {
      return null;
    }

    seen.add(candidate.candidateId);
    selectedLegs.push({
      candidate,
      decision: legDecision
    });
  }

  const backupDecision = decision.backupLeg ? candidateMap.get(decision.backupLeg.candidateId) : null;

  if (decision.backupLeg && (!backupDecision || seen.has(decision.backupLeg.candidateId))) {
    return null;
  }

  const legObjects = selectedLegs.map((item, index) => ({
    id: `leg-${index + 1}`,
    label: item.candidate.label,
    modelProbability: toNumber(item.decision.modelProbability),
    status: 'active',
    locked: false,
    rationale: item.decision.rationale || item.candidate.rationale,
    source: {
      type: item.candidate.source,
      market: item.candidate.market,
      booksChecked: item.candidate.booksChecked,
      outcomeName: item.candidate.outcomeName,
      description: item.candidate.description,
      point: item.candidate.point ?? null,
      teamSide: item.candidate.mlbTeamSide || '',
      teamName: item.candidate.mlbTeamName || '',
      battingOrderIndex: item.candidate.mlbBattingOrderIndex ?? null,
      lineupSource: item.candidate.mlbLineupSource || ''
    }
  }));

  const summary = legObjects.map((leg) => leg.label).join(' + ');
  const backupCandidate = decision.backupLeg ? candidateMap.get(decision.backupLeg.candidateId) : null;
  const aflBonusLegOptions = isSport(eventContext, 'afl')
    ? chooseAflBonusLegCandidates(candidatePool, selectedLegs.map((item) => item.candidate), 2)
        .map((candidate) => buildStructuredCandidateLeg(candidate, buildRulesSelectionDecision(candidate, eventContext), 'bonus'))
        .filter(Boolean)
    : [];
  const replacementTemplate = {
    candidateLegs: backupCandidate
      ? [buildStructuredCandidateLeg(backupCandidate, decision.backupLeg, 'backup')]
      : [],
    maxOptions: 1
  };

  if (isHardLockedSameGameMultiSport(eventContext) && legObjects.length < 2) {
    return null;
  }

  return {
    id: `${generatedSource}:${eventContext.sportKey}:${eventContext.eventId}`,
    status: 'pending',
    sport: eventContext.sportKey,
    sportLabel: eventContext.sportLabel,
    eventId: eventContext.eventId,
    espnEventId: eventContext.espnEventId || '',
    event: eventContext.eventName,
    homeTeam: eventContext.homeTeam,
    homeTeamId: eventContext.homeTeamId || '',
    awayTeam: eventContext.awayTeam,
    awayTeamId: eventContext.awayTeamId || '',
    startTime: eventContext.startTime,
    venue: eventContext.venue || null,
    weather: eventContext.weather || null,
    summary,
    rationale: `${decision.rationale}${decision.notes ? ` ${decision.notes}` : ''}`.trim(),
    betType: isHardLockedSameGameMultiSport(eventContext) || legObjects.length > 1 ? 'sgm' : 'single',
    modelProbability: toNumber(decision.combinedModelProbability),
    supportScore: toNumber(decision.supportScore),
    confidenceTier: decision.confidenceTier,
    supportProjection: decision.supportProjection,
    dataConfidence: decision.dataConfidence,
    correlationRisk: decision.correlationRisk,
    correlationJustified: Boolean(decision.correlationJustified),
    exceptionalSupport: Boolean(decision.exceptionalSupport),
    strongSupport: Boolean(decision.strongSupport),
    stakeUnits: normalizeStakeUnits(decision.stakeUnits || eventContext.generatorConfig.stakeUnits || 1),
    source: generatedSource,
    analysisEngine,
    ...(isSport(eventContext, 'mlb') ? { mlbStructureProfile: getMlbStructureProfile(eventContext) } : {}),
    legs: legObjects,
    bonusLegOptions: aflBonusLegOptions,
    replacementTemplate,
    analysisChecklist: decision.checklist,
    analysisNotes: decision.notes || ''
  };
}

export const __testables = {
  estimateCandidateModelProbability
};