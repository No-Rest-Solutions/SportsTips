import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAnalysisCandidatePool, analyzeEventWithRules, buildPickFromAnalysisDecision } from '../src/ai-pick-generator.mjs';

const startTime = '2026-06-18T09:00:00.000Z';

function aflEventContext() {
  return {
    sportKey: 'afl',
    sportLabel: 'AFL',
    marketSportKey: 'afl',
    eventId: 'snapshot:afl:floors',
    eventName: 'Floor Test A vs B',
    homeTeam: 'A',
    awayTeam: 'B',
    startTime,
    generatorConfig: { minBooks: 1, stakeUnits: 1, maxStakeUnits: 2, teamSportsH2hPolicy: 'fallback_only' }
  };
}

const px = (price) => [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price }];
const disposalQuote = (player, line, price) => ({
  sportKey: 'afl', homeTeam: 'A', awayTeam: 'B', displayName: 'Floor Test A vs B', startTime,
  market: 'player_disposals', outcomeName: `${line}+ Disposals`, description: player, point: null,
  source: 'snapshot', prices: px(price)
});

const context = { config: { benchmarkFilters: { requireSupportData: false, significantSupportScore: 5, strongSupportScore: 8 } } };

function markSupported(pool) {
  for (const candidate of pool) {
    candidate.evidenceStatus = 'supported';
    candidate.evidenceScore = 3;
    candidate.evidenceReason = 'test';
    candidate.evidenceType = 'player-form';
  }
  return pool;
}

test('per-leg floor drops any leg priced under 1.15', () => {
  const quotes = [
    disposalQuote('P1', 20, 1.45),
    disposalQuote('P2', 20, 1.30),
    disposalQuote('ShortLock', 15, 1.08)
  ];
  const pool = buildAnalysisCandidatePool(aflEventContext(), quotes, 14);
  assert.equal(pool.some((c) => Number(c.bestPrice) < 1.15), false);
  assert.equal(pool.some((c) => /ShortLock/.test(c.description || '')), false);
});

test('builder reaches a >=2.0 slip from supported >=1.15 legs (no 1.48 trebles)', async () => {
  const quotes = [
    disposalQuote('P1', 20, 1.45),
    disposalQuote('P2', 20, 1.42),
    disposalQuote('P3', 20, 1.30),
    disposalQuote('P4', 20, 1.20)
  ];
  const pool = markSupported(buildAnalysisCandidatePool(aflEventContext(), quotes, 14));

  const decision = await analyzeEventWithRules(context, aflEventContext(), pool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(aflEventContext(), pool, decision);

  assert.ok(pick, 'a pick should be built from supported >=1.15 legs');
  const total = (pick.legs || []).reduce((product, leg) => product * Number(leg.odds || leg.bestPrice || 1), 1);
  assert.ok(total >= 2.0, `slip total ${total.toFixed(2)} must be >= 2.0`);
  assert.ok((pick.legs || []).every((leg) => Number(leg.odds || leg.bestPrice) >= 1.15));
});

test('builder makes NO pick when supported legs cannot combine to 2.0', async () => {
  // Two short supported legs: the only combo (1.20 x 1.25 = 1.50) is below the 2.0 floor.
  const quotes = [
    disposalQuote('P1', 20, 1.20),
    disposalQuote('P2', 20, 1.25)
  ];
  const pool = markSupported(buildAnalysisCandidatePool(aflEventContext(), quotes, 14));

  const decision = await analyzeEventWithRules(context, aflEventContext(), pool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(aflEventContext(), pool, decision);

  // The only possible combo (1.20 x 1.25 = 1.50) is below the 2.0 floor, so nothing posts.
  const total = pick ? (pick.legs || []).reduce((product, leg) => product * Number(leg.odds || leg.bestPrice || 1), 1) : 0;
  assert.ok(!pick || total >= 2.0, 'must not post a sub-2.0 slip');
  assert.ok(!pick, 'no slip should be built when legs cannot reach 2.0');
});
