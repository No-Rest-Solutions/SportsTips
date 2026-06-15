import test from 'node:test';
import assert from 'node:assert';
import { selectPromoLegs } from '../src/promos-generator.mjs';

test('selectPromoLegs - structure & market awareness', async (t) => {
  await t.test('same-game-multi keeps every leg inside one event', () => {
    const promo = { sport: 'afl', type: 'same-game-multi', market: 'player-props', legCount: 2, minOdds: 2.0, maxOdds: 5.0 };
    const candidates = [
      { sport: 'afl', matchId: 'e1', market: 'player_disposals', point: 20, odds: 1.5, confidence: 70, conflictGroup: 'e1-p1', player: 'P1' },
      { sport: 'afl', matchId: 'e1', market: 'player_disposals', point: 15, odds: 1.6, confidence: 65, conflictGroup: 'e1-p2', player: 'P2' },
      { sport: 'afl', matchId: 'e2', market: 'player_disposals', point: 10, odds: 1.4, confidence: 75, conflictGroup: 'e2-p1', player: 'P3' }
    ];

    const selected = selectPromoLegs(promo, candidates);
    assert.equal(selected.length, 2);
    assert.ok(selected.every((leg) => leg.matchId === 'e1'), 'all legs share one event');
    const combined = selected.reduce((acc, leg) => acc * leg.odds, 1);
    assert.ok(combined >= 2.0 && combined <= 5.0, `combined odds ${combined} in band`);
  });

  await t.test('h2h-multi takes one favourite per distinct event and ignores props', () => {
    const promo = { sport: 'tennis', type: 'h2h-multi', market: 'head2head', legCount: 2, minOdds: 2.0, maxOdds: 5.0 };
    const candidates = [
      { sport: 'tennis', matchId: 'e1', market: 'h2h', team: 'P1', odds: 1.5, confidence: 70, conflictGroup: 'h2h-e1' },
      { sport: 'tennis', matchId: 'e1', market: 'h2h', team: 'P2', odds: 2.6, confidence: 38, conflictGroup: 'h2h-e1' },
      { sport: 'tennis', matchId: 'e2', market: 'h2h', team: 'P3', odds: 1.5, confidence: 70, conflictGroup: 'h2h-e2' },
      { sport: 'tennis', matchId: 'e2', market: 'h2h', team: 'P4', odds: 2.6, confidence: 38, conflictGroup: 'h2h-e2' },
      // A stray player prop that must never be chosen for an h2h promo.
      { sport: 'tennis', matchId: 'e1', market: 'player_aces', point: 5, odds: 1.9, confidence: 60, conflictGroup: 'prop-e1', player: 'P1' }
    ];

    const selected = selectPromoLegs(promo, candidates);
    assert.equal(selected.length, 2);
    assert.ok(selected.every((leg) => leg.market === 'h2h'), 'only h2h legs selected');
    const events = new Set(selected.map((leg) => leg.matchId));
    assert.equal(events.size, 2, 'legs span two distinct events');
    assert.ok(selected.every((leg) => leg.odds === 1.5), 'favourites chosen per event');
  });

  await t.test('returns empty when not enough distinct events for an h2h-multi', () => {
    const promo = { sport: 'soccer', type: 'h2h-multi', market: 'head2head', legCount: 3, minOdds: 2.0, maxOdds: 5.0 };
    const candidates = [
      { sport: 'soccer', matchId: 'e1', market: 'h2h', team: 'A', odds: 1.5, confidence: 70, conflictGroup: 'h2h-e1' },
      { sport: 'soccer', matchId: 'e2', market: 'h2h', team: 'B', odds: 1.5, confidence: 70, conflictGroup: 'h2h-e2' }
    ];

    assert.equal(selectPromoLegs(promo, candidates).length, 0);
  });

  await t.test('filters by sport', () => {
    const promo = { sport: 'afl', type: 'h2h-multi', market: 'head2head', legCount: 2, minOdds: 2.0, maxOdds: 5.0 };
    const candidates = [
      { sport: 'nrl', matchId: 'e1', market: 'h2h', team: 'A', odds: 1.5, confidence: 70, conflictGroup: 'h2h-e1' },
      { sport: 'nrl', matchId: 'e2', market: 'h2h', team: 'B', odds: 1.5, confidence: 70, conflictGroup: 'h2h-e2' }
    ];

    assert.equal(selectPromoLegs(promo, candidates).length, 0);
  });
});
