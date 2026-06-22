import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTeamSgm, buildTeamSgmDecision, isTeamSgmSport, getMarginSigma } from '../src/team-sgm.mjs';
import { buildPickFromAnalysisDecision, decisionPassesChecklist } from '../src/ai-pick-generator.mjs';
import { __testables as picksTestables } from '../src/jobs/picks.mjs';

const startTime = '2026-06-18T09:00:00.000Z';

function px(price) {
  return [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price }];
}

function q(overrides) {
  return {
    sportKey: 'afl', homeTeam: 'Fremantle', awayTeam: 'Geelong Cats',
    displayName: 'Fremantle vs Geelong Cats', startTime,
    market: 'h2h', outcomeName: 'Fremantle', point: null, source: 'web-scrape',
    ...overrides,
    prices: px(overrides.price)
  };
}

// A realistic AFL market: Fremantle clear favourite, main line -18.5, total O/U 176.5.
function aflQuotes() {
  return [
    q({ market: 'h2h', outcomeName: 'Fremantle', price: 1.40 }),
    q({ market: 'h2h', outcomeName: 'Geelong Cats', price: 2.90 }),
    q({ market: 'spreads', outcomeName: 'Fremantle', point: -18.5, price: 1.90 }),
    q({ market: 'spreads', outcomeName: 'Geelong Cats', point: 18.5, price: 1.90 }),
    q({ market: 'totals', outcomeName: 'Over', point: 176.5, price: 1.91 }),
    q({ market: 'totals', outcomeName: 'Under', point: 176.5, price: 1.89 })
  ];
}

// A supported player-prop candidate, shaped like a gated pool candidate.
function makeProp(player, line, price, market = 'player_disposals', statLabel = 'Disposals') {
  return {
    candidateId: `prop-${player.replace(/\s+/g, '')}-${line}`,
    key: `prop:${player}:${line}`,
    label: `${player} ${line}+ ${statLabel}`,
    market,
    family: 'prop',
    outcomeName: `${line}+ ${statLabel}`,
    description: player,
    point: null,
    booksChecked: 1,
    bestPrice: price,
    averagePrice: price,
    prices: px(price),
    source: 'snapshot',
    rationale: `${player} form supports ${line}+ disposals.`,
    evidenceStatus: 'supported',
    evidenceScore: 3,
    evidenceReason: `${player} cleared ${line}+ disposals in 5 of 5 recent games.`,
    evidenceType: 'player-form'
  };
}

function aflContext() {
  return {
    sportKey: 'afl', sportLabel: 'AFL', marketSportKey: 'afl',
    eventId: 'snapshot:afl:sgm-test', eventName: 'Fremantle vs Geelong Cats',
    homeTeam: 'Fremantle', awayTeam: 'Geelong Cats', startTime,
    generatorConfig: { minBooks: 1, stakeUnits: 1, maxStakeUnits: 2, teamSportsH2hPolicy: 'fallback_only' },
    deepAnalysis: { requireLegEvidence: true }
  };
}

const kinds = (sgm) => sgm.legs.map((leg) => leg.kind);

test('isTeamSgmSport covers the named team sports only', () => {
  for (const sport of ['afl', 'nrl', 'nba', 'nhl', 'nfl']) {
    assert.equal(isTeamSgmSport(sport), true, `${sport} should be a team SGM sport`);
  }
  assert.equal(isTeamSgmSport('mlb'), false);
  assert.equal(isTeamSgmSport('soccer_fifa_world_cup'), false);
  assert.equal(isTeamSgmSport('tennis_atp'), false);
});

test('no props: declines — safe team markets alone cannot reach a safe 2x', () => {
  // With no supported props, the only safe legs are h2h (≤1.40) + a near-certain pad line
  // (~1.04) + a genuinely safe total (≥0.80 cover, ~1.17). Those top out ~1.70x — well under
  // the 2x floor — and the builder will NOT reach for a risky over/h2h to scrape over the line.
  // So it declines. A safe 2x needs evidence-backed props to anchor it.
  assert.equal(buildTeamSgm(aflContext(), aflQuotes(), {}), null);
});

test('never stacks two legs from the same correlation group (no fake 2x)', () => {
  // Each leg must be from a distinct correlation group, so two correlated legs never multiply
  // into a fake 2x. h2h + a near-certain PAD line MAY coexist (different groups, and they do
  // not both miss together), but two LIVE favourite legs may not.
  const scenarios = [
    aflQuotes(),
    [...aflQuotes(), q({ market: 'spreads', outcomeName: 'Fremantle', point: -5.5, price: 1.95 })]
  ];
  for (const quotes of scenarios) {
    const sgm = buildTeamSgm(aflContext(), quotes, {});
    if (!sgm) continue;
    const groups = sgm.legs.map((leg) => leg.group);
    assert.equal(new Set(groups).size, groups.length, `distinct groups only (got ${groups.join(',')})`);
    assert.ok(sgm.legs.filter((leg) => leg.group === 'fav-cover').length <= 1, 'at most one live favourite leg');
  }
});

test('uses a supported player prop instead of the coin-flip total when it is safer', () => {
  const sgm = buildTeamSgm(aflContext(), aflQuotes(), { supportedFillers: [makeProp('Caleb Serong', 25, 1.45)] });
  assert.ok(sgm);
  assert.ok(kinds(sgm).includes('prop'), 'the safe prop is used');
  assert.ok(!kinds(sgm).includes('total'), 'the coin-flip total is dropped');
  const propLeg = sgm.legs.find((leg) => leg.kind === 'prop');
  assert.equal(propLeg.candidate.description, 'Caleb Serong');
  assert.ok(sgm.modeledOdds >= 2.0);
});

test('builds from safe legs (props / safe total), never the coin-flip total', () => {
  const sgm = buildTeamSgm(aflContext(), aflQuotes(), {
    supportedFillers: [makeProp('P1', 20, 1.30), makeProp('P2', 20, 1.32)]
  });
  assert.ok(sgm);
  assert.ok(sgm.legs.some((leg) => leg.kind === 'prop'), 'supported props are used as safe legs');
  assert.ok(!sgm.legs.some((leg) => leg.kind === 'total'), 'the coin-flip main total is never used');
  // every leg is genuinely safe (each ~>= 0.7 win prob)
  assert.ok(sgm.legs.every((leg) => leg.winProb >= 0.5), 'no coin-flip legs');
  assert.ok(sgm.modeledOdds >= 2.0);
});

test('h2h (win-outright) leg only joins the slip for a STRONG favourite (<=1.40)', () => {
  // Strong favourite (1.30) + one supported prop: the h2h is a genuine ~77% lock, so it is a
  // safe leg and anchors the slip (h2h 1.30 x prop = 2x).
  const strongQuotes = [
    q({ market: 'h2h', outcomeName: 'Fremantle', price: 1.30 }),
    q({ market: 'h2h', outcomeName: 'Geelong Cats', price: 3.40 }),
    q({ market: 'spreads', outcomeName: 'Fremantle', point: -24.5, price: 1.90 }),
    q({ market: 'totals', outcomeName: 'Over', point: 176.5, price: 1.91 }),
    q({ market: 'totals', outcomeName: 'Under', point: 176.5, price: 1.89 })
  ];
  const strong = buildTeamSgm(aflContext(), strongQuotes, { supportedFillers: [makeProp('P1', 20, 1.55)] });
  assert.ok(strong && strong.legs.some((leg) => leg.kind === 'h2h'), 'strong favourite uses the h2h leg');

  // Mid favourite (1.55 > 1.40): the h2h is too coin-flip to be "safe", so it is NEVER a leg —
  // the slip is built from props (here two of them) instead.
  const midQuotes = [
    q({ market: 'h2h', outcomeName: 'Fremantle', price: 1.55 }),
    q({ market: 'h2h', outcomeName: 'Geelong Cats', price: 2.45 }),
    q({ market: 'spreads', outcomeName: 'Fremantle', point: -10.5, price: 1.90 }),
    q({ market: 'totals', outcomeName: 'Over', point: 176.5, price: 1.91 }),
    q({ market: 'totals', outcomeName: 'Under', point: 176.5, price: 1.89 })
  ];
  const mid = buildTeamSgm(aflContext(), midQuotes, { supportedFillers: [makeProp('P1', 20, 1.55), makeProp('P2', 20, 1.45)] });
  assert.ok(mid, 'mid favourite still builds from props');
  assert.ok(!mid.legs.some((leg) => leg.kind === 'h2h'), 'mid favourite never uses the h2h leg');
});

test('never puts two lines (same market) in one slip — e.g. +0.5 AND +32.5', () => {
  // Strong favourite (1.36, main line -19.5) generates both a moderate line (~+0.5) and a
  // near-certain pad line (~+32.5). They are the SAME market (you pick one point) and must
  // never both appear — across with/without props.
  const ctx = {
    sportKey: 'afl', homeTeam: 'Adelaide Crows', awayTeam: 'Melbourne', eventName: 'Adelaide Crows vs Melbourne',
    startTime, generatorConfig: { minBooks: 1, stakeUnits: 1, maxStakeUnits: 2 }
  };
  const aq = (o) => ({ sportKey: 'afl', homeTeam: 'Adelaide Crows', awayTeam: 'Melbourne', displayName: 'Adelaide Crows vs Melbourne', startTime, point: null, ...o, prices: px(o.price) });
  const quotes = [
    aq({ market: 'h2h', outcomeName: 'Adelaide Crows', price: 1.36 }),
    aq({ market: 'h2h', outcomeName: 'Melbourne', price: 3.10 }),
    aq({ market: 'spreads', outcomeName: 'Adelaide Crows', point: -19.5, price: 1.91 }),
    aq({ market: 'totals', outcomeName: 'Over', point: 178.5, price: 1.90 }),
    aq({ market: 'totals', outcomeName: 'Under', point: 178.5, price: 1.90 })
  ];
  for (const fillers of [[], [makeProp('Crow', 20, 1.4)], [makeProp('C1', 20, 1.3), makeProp('C2', 20, 1.33)]]) {
    const sgm = buildTeamSgm(ctx, quotes, { supportedFillers: fillers });
    if (!sgm) continue;
    const spreadLegs = sgm.legs.filter((leg) => leg.market === 'spreads');
    assert.ok(spreadLegs.length <= 1, `at most one line leg (got ${spreadLegs.map((l) => l.outcomeName + ' ' + l.point).join(', ')})`);
    // no two non-prop legs share a market at all
    const teamMarkets = sgm.legs.filter((leg) => leg.kind !== 'prop').map((leg) => leg.market);
    assert.equal(new Set(teamMarkets).size, teamMarkets.length, 'no duplicate team markets');
  }
});

test('declines when the favourite is essentially a coin-flip (h2h > 1.80)', () => {
  const quotes = [
    q({ market: 'h2h', outcomeName: 'Fremantle', price: 1.88 }),
    q({ market: 'h2h', outcomeName: 'Geelong Cats', price: 1.92 }),
    q({ market: 'totals', outcomeName: 'Over', point: 176.5, price: 1.91 }),
    q({ market: 'totals', outcomeName: 'Under', point: 176.5, price: 1.89 })
  ];
  assert.equal(buildTeamSgm(aflContext(), quotes, {}), null);
});

test('declines when nothing safe can reach 2x (no total, no props)', () => {
  const quotes = [
    q({ market: 'h2h', outcomeName: 'Fremantle', price: 1.40 }),
    q({ market: 'h2h', outcomeName: 'Geelong Cats', price: 2.90 }),
    q({ market: 'spreads', outcomeName: 'Fremantle', point: -18.5, price: 1.90 }),
    q({ market: 'spreads', outcomeName: 'Geelong Cats', point: 18.5, price: 1.90 })
  ];
  // h2h + main line are correlated (same group); h2h + max line = ~1.46 < 2x. Nothing clears 2x.
  assert.equal(buildTeamSgm(aflContext(), quotes, {}), null);
});

test('respects an explicit total lean for the safe total side', () => {
  // One short prop leaves the slip needing a safe total to clear 2x, so the lean fixes its side.
  const fillers = [makeProp('P1', 20, 1.25)];
  const over = buildTeamSgm(aflContext(), aflQuotes(), { supportedFillers: fillers, totalLean: 'over' });
  const under = buildTeamSgm(aflContext(), aflQuotes(), { supportedFillers: fillers, totalLean: 'under' });
  const overTotal = over.legs.find((leg) => leg.market === 'totals');
  const underTotal = under.legs.find((leg) => leg.market === 'totals');
  assert.equal(overTotal.outcomeName, 'Over');
  assert.equal(underTotal.outcomeName, 'Under');
});

test('decision builds a real pick through the standard pipeline', () => {
  const result = buildTeamSgmDecision(aflContext(), aflQuotes(), { supportedFillers: [makeProp('Caleb Serong', 25, 1.45)] });
  assert.ok(result, 'a decision should be produced');
  assert.equal(result.decision.qualifies, true);
  assert.ok(result.decision.selectedLegs.length >= 2);

  assert.equal(decisionPassesChecklist(result.decision, aflContext()), true);

  const pick = buildPickFromAnalysisDecision(aflContext(), result.candidatePool, result.decision);
  assert.ok(pick, 'a pick should be built');
  assert.equal(pick.teamSgm, true);

  const slip = pick.legs.reduce((product, leg) => product * Number(leg.odds), 1);
  assert.ok(slip >= 2.0, `posted slip ${slip.toFixed(2)} must be >= 2.0`);
});

test('decision puts a supported prop in the pick in place of the total', () => {
  const result = buildTeamSgmDecision(aflContext(), aflQuotes(), { supportedFillers: [makeProp('Caleb Serong', 25, 1.45)] });
  const pick = buildPickFromAnalysisDecision(aflContext(), result.candidatePool, result.decision);
  assert.ok(pick);

  const markets = pick.legs.map((leg) => leg.source.market);
  assert.ok(markets.includes('player_disposals'), 'the safe prop is a leg');
  assert.ok(!markets.includes('totals'), 'the coin-flip total was replaced');

  const propLeg = pick.legs.find((leg) => leg.source.market === 'player_disposals');
  assert.equal(propLeg.source.description, 'Caleb Serong');
  assert.ok(propLeg.evidence, 'prop leg keeps its evidence');
});

test('SGM pick clears the publication validators, incl. the modelled legs', async () => {
  const { validateLegPublication, validateGeneratedTotalOddsProfile, validateLivePricing } = picksTestables;

  // h2h (strong fav) + one short prop still needs a modelled safe total to clear 2x, so the
  // pick carries a modelled leg that must survive live-price revalidation as locked.
  const result = buildTeamSgmDecision(aflContext(), aflQuotes(), { supportedFillers: [makeProp('Caleb Serong', 25, 1.30)] });
  const pick = buildPickFromAnalysisDecision(aflContext(), result.candidatePool, result.decision);
  assert.equal(pick.teamSgm, true);
  assert.equal(pick.betType, 'sgm');
  assert.deepEqual(validateLegPublication(pick).reasons, []);
  const slip = pick.legs.reduce((p, leg) => p * Number(leg.odds), 1);
  assert.deepEqual(validateGeneratedTotalOddsProfile(pick, slip), []);

  // The modelled legs (max-line pad + safe total) must survive live-price revalidation as
  // locked, always-available legs (they are not in the featured-market snapshot).
  assert.ok(pick.legs.some((leg) => leg.source.type === 'model'), 'pick has modelled legs');
  const context = { config: { marketScrape: { maxSnapshotAgeMinutes: 180 }, sportsGameOdds: { bookmakers: [] } } };
  const live = await validateLivePricing(context, pick, {
    resolveOddsValidation: async (_ctx, oddsCheck) => ({
      status: 'ok',
      bestOdds: oddsCheck.market === 'h2h' ? 1.40 : 1.91,
      bestBookmaker: 'sportsbet-web'
    })
  });
  assert.deepEqual(live.reasons, [], 'no leg should fail live-price validation');
  assert.ok(live.matchedLegPrices.some((leg) => leg.source === 'model'), 'modelled legs matched as locked');
});

test('NRL uses a tighter margin model and still builds a safe 2x slip', () => {
  assert.ok(getMarginSigma('nrl') < getMarginSigma('afl'));
  const ctx = {
    sportKey: 'nrl', homeTeam: 'Penrith Panthers', awayTeam: 'Gold Coast Titans',
    eventName: 'Penrith Panthers vs Gold Coast Titans', startTime,
    generatorConfig: { minBooks: 1, stakeUnits: 1, maxStakeUnits: 2 }
  };
  const nrlQ = (o) => ({ sportKey: 'nrl', homeTeam: 'Penrith Panthers', awayTeam: 'Gold Coast Titans', displayName: 'Penrith Panthers vs Gold Coast Titans', startTime, point: null, ...o, prices: px(o.price) });
  const quotes = [
    nrlQ({ market: 'h2h', outcomeName: 'Penrith Panthers', price: 1.50 }),
    nrlQ({ market: 'h2h', outcomeName: 'Gold Coast Titans', price: 2.60 }),
    nrlQ({ market: 'spreads', outcomeName: 'Penrith Panthers', point: -6.5, price: 1.9 }),
    nrlQ({ market: 'totals', outcomeName: 'Over', point: 49.5, price: 1.9 }),
    nrlQ({ market: 'totals', outcomeName: 'Under', point: 49.5, price: 1.9 })
  ];
  // Penrith 1.50 is a mid favourite (>1.40) so no h2h leg — two supported points props anchor it.
  const sgm = buildTeamSgm(ctx, quotes, {
    supportedFillers: [
      makeProp('Nathan Cleary', 18, 1.45, 'player_points', 'Points'),
      makeProp('Brian To’o', 12, 1.42, 'player_points', 'Points')
    ]
  });
  assert.ok(sgm);
  assert.ok(!sgm.legs.some((leg) => leg.kind === 'h2h'), 'mid favourite gets no h2h leg');
  assert.ok(sgm.modeledOdds >= 2.0);
  assert.ok(sgm.legs.length <= 3, 'NRL slip stays within its 3-leg budget');
  // NRL margin sigma is much smaller than AFL, so any modelled line is far shorter.
  const line = sgm.legs.find((leg) => leg.kind === 'maxline');
  if (line) assert.ok(line.point <= 32.5, 'NRL line within the realistic cap');
});
