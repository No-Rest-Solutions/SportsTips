import test from 'node:test';
import assert from 'node:assert';
import { __testables } from '../src/promos-candidates.mjs';

const {
  isPlayerPropMarket,
  candidateMatchesPromoMarket,
  deriveMarketConfidence,
  mapCandidateToPromoLeg
} = __testables;

test('Promos Candidates Module', async (t) => {
  await t.test('isPlayerPropMarket recognises player markets', () => {
    assert.equal(isPlayerPropMarket('player_disposals'), true);
    assert.equal(isPlayerPropMarket('batter_hits'), true);
    assert.equal(isPlayerPropMarket('pitcher_strikeouts'), true);
    assert.equal(isPlayerPropMarket('h2h'), false);
    assert.equal(isPlayerPropMarket('totals'), false);
  });

  await t.test('candidateMatchesPromoMarket filters head2head', () => {
    assert.equal(candidateMatchesPromoMarket('head2head', { market: 'h2h' }), true);
    assert.equal(candidateMatchesPromoMarket('head2head', { market: 'player_disposals', point: 20 }), false);
  });

  await t.test('candidateMatchesPromoMarket filters player-props (needs a line)', () => {
    assert.equal(candidateMatchesPromoMarket('player-props', { market: 'player_disposals', point: 20 }), true);
    assert.equal(candidateMatchesPromoMarket('player-props', { market: 'player_disposals', point: null }), false);
    assert.equal(candidateMatchesPromoMarket('player-props', { market: 'h2h' }), false);
  });

  await t.test('candidateMatchesPromoMarket supports an explicit market key', () => {
    assert.equal(candidateMatchesPromoMarket('player_disposals', { market: 'player_disposals' }), true);
    assert.equal(candidateMatchesPromoMarket('player_disposals', { market: 'player_goals' }), false);
  });

  await t.test('deriveMarketConfidence rewards favourites and consensus', () => {
    // 1/1.5 = 0.667 -> 66.7 base, +3 consensus -> 70
    assert.equal(deriveMarketConfidence(1.5, 3), 70);
    // 1/2.0 = 0.5 -> 50 base, +1 consensus -> 51
    assert.equal(deriveMarketConfidence(2.0, 1), 51);
    // A heavy favourite is capped, never reaching 100
    assert.ok(deriveMarketConfidence(1.01, 10) <= 99);
    // Invalid odds score zero
    assert.equal(deriveMarketConfidence(1, 5), 0);
    assert.equal(deriveMarketConfidence(NaN, 5), 0);
  });

  await t.test('mapCandidateToPromoLeg maps an h2h candidate', () => {
    const eventContext = {
      eventId: 'e1',
      eventName: 'Carlton vs Geelong',
      homeTeam: 'Carlton',
      awayTeam: 'Geelong',
      startTime: '2026-06-14T08:00:00.000Z'
    };
    const candidate = {
      market: 'h2h',
      outcomeName: 'Carlton',
      description: '',
      point: null,
      bestPrice: 1.5,
      booksChecked: 3,
      candidateId: 'c1',
      label: 'Carlton H2H'
    };

    const leg = mapCandidateToPromoLeg(candidate, eventContext, 'afl');
    assert.equal(leg.sport, 'afl');
    assert.equal(leg.matchId, 'e1');
    assert.equal(leg.market, 'h2h');
    assert.equal(leg.team, 'Carlton');
    assert.equal(leg.player, '');
    assert.equal(leg.odds, 1.5);
    assert.equal(leg.homeTeam, 'Carlton');
    assert.equal(leg.confidence, 70);
  });

  await t.test('mapCandidateToPromoLeg maps a player-prop candidate', () => {
    const eventContext = { eventId: 'e2', eventName: 'A vs B', homeTeam: 'A', awayTeam: 'B', startTime: '' };
    const candidate = {
      market: 'player_disposals',
      outcomeName: 'Over',
      description: 'Sam Walsh',
      point: 24.5,
      bestPrice: 1.8,
      booksChecked: 2,
      candidateId: 'c2'
    };

    const leg = mapCandidateToPromoLeg(candidate, eventContext, 'afl');
    assert.equal(leg.player, 'Sam Walsh');
    assert.equal(leg.team, '');
    assert.equal(leg.market, 'player_disposals');
    assert.equal(leg.point, 24.5);
    assert.equal(leg.side, 'over');
    assert.equal(leg.odds, 1.8);
  });

  await t.test('mapCandidateToPromoLeg rejects priceless candidates', () => {
    const leg = mapCandidateToPromoLeg({ market: 'h2h', bestPrice: null }, { eventId: 'e' }, 'afl');
    assert.equal(leg, null);
  });
});
