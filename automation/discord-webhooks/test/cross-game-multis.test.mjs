import test from 'node:test';
import assert from 'node:assert';
import { __testables } from '../src/cross-game-multis.mjs';

const { pickBestLegPerEvent, selectCrossGameMulti, buildCrossGameMultiPick, buildCrossGameMultisForSport } = __testables;

function leg(eventId, odds, evidenceScore, extra = {}) {
  return {
    eventId,
    eventName: `Event ${eventId}`,
    homeTeam: `${eventId}H`,
    awayTeam: `${eventId}A`,
    startTime: '2026-06-15T10:00:00Z',
    sport: 'soccer_epl',
    market: 'totals',
    outcomeName: 'Over',
    point: 9.5,
    odds,
    evidenceScore,
    evidenceStatus: 'supported',
    label: `${eventId} Over 9.5 corners`,
    ...extra
  };
}

test('cross-game: pickBestLegPerEvent keeps one strongest leg per event', () => {
  const best = pickBestLegPerEvent([
    leg('e1', 1.4, 2),
    leg('e1', 1.5, 4), // stronger evidence for e1
    leg('e2', 1.3, 3)
  ]);
  assert.equal(best.length, 2);
  const e1 = best.find((l) => l.eventId === 'e1');
  assert.equal(e1.odds, 1.5);
  assert.equal(best[0].eventId, 'e1'); // sorted by evidence desc
});

test('cross-game: selectCrossGameMulti hits the odds band', async (t) => {
  await t.test('combines 3 favourites into the band', () => {
    const selected = selectCrossGameMulti([leg('e1', 1.3, 4), leg('e2', 1.3, 3), leg('e3', 1.3, 3)], { legCount: 3, minOdds: 2.0, maxOdds: 3.0 });
    assert.equal(selected.length, 3);
    const combined = selected.reduce((p, l) => p * l.odds, 1);
    assert.ok(combined >= 2.0 && combined <= 3.0);
  });

  await t.test('returns empty when it cannot reach the band', () => {
    const selected = selectCrossGameMulti([leg('e1', 1.1, 4), leg('e2', 1.1, 3)], { legCount: 3, minOdds: 2.0, maxOdds: 3.0 });
    assert.equal(selected.length, 0);
  });
});

test('cross-game: buildCrossGameMultiPick keeps per-leg event identity', () => {
  const pick = buildCrossGameMultiPick({ key: 'soccer_epl', label: 'EPL' }, [leg('e1', 1.4, 4), leg('e2', 1.5, 3)]);
  assert.equal(pick.crossGame, true);
  assert.equal(pick.betType, 'cross_game_multi');
  assert.equal(pick.legs.length, 2);
  assert.equal(pick.legs[0].eventId, 'e1');
  assert.equal(pick.legs[0].homeTeam, 'e1H');
  assert.equal(pick.legs[0].source.market, 'totals');
  assert.ok(Math.abs(pick.combinedOdds - 2.1) < 1e-9);
});

test('cross-game: buildCrossGameMultisForSport respects the gate', async (t) => {
  const legPool = [leg('e1', 1.3, 4), leg('e2', 1.3, 3), leg('e3', 1.3, 3), leg('e4', 1.3, 2)];

  await t.test('disabled → no picks', () => {
    assert.deepEqual(buildCrossGameMultisForSport({ key: 'soccer_epl', label: 'EPL' }, legPool, { analysis: { crossGameMultis: { enabled: false } } }), []);
  });

  await t.test('enabled → builds a 3-leg cross-game multi', () => {
    const picks = buildCrossGameMultisForSport(
      { key: 'soccer_epl', label: 'EPL' },
      legPool,
      { analysis: { crossGameMultis: { enabled: true, legCount: 3, minOdds: 2.0, maxOdds: 3.0, maxPicksPerSport: 1 } } }
    );
    assert.equal(picks.length, 1);
    assert.equal(picks[0].legs.length, 3);
    const events = new Set(picks[0].legs.map((l) => l.eventId));
    assert.equal(events.size, 3);
  });
});
