import test from 'node:test';
import assert from 'node:assert';
import { __testables } from '../src/research/player-form.mjs';

const {
  getStatKeysForMarket,
  getBufferFloor,
  extractPlayerGameValue,
  buildPlayerStatSeries,
  computePropEvidence,
  PROP_EVIDENCE_STATUS
} = __testables;

test('player-form: stat key mapping', async (t) => {
  await t.test('singles map per sport', () => {
    assert.deepEqual(getStatKeysForMarket('afl', 'player_disposals'), ['disposals']);
    assert.deepEqual(getStatKeysForMarket('nrl', 'player_points'), ['points']);
    assert.deepEqual(getStatKeysForMarket('nba', 'player_points'), ['points']);
    assert.deepEqual(getStatKeysForMarket('mlb', 'batter_hits'), ['hits']);
  });

  await t.test('nba combos return multiple keys', () => {
    assert.deepEqual(getStatKeysForMarket('nba', 'player_points_rebounds_assists'), ['points', 'rebounds', 'assists']);
    assert.deepEqual(getStatKeysForMarket('nba', 'player_points_assists'), ['points', 'assists']);
  });

  await t.test('unknown markets return empty', () => {
    assert.deepEqual(getStatKeysForMarket('afl', 'player_marks'), []);
    assert.deepEqual(getStatKeysForMarket('xyz', 'player_points'), []);
  });

  await t.test('combo floor is used for multi-stat markets', () => {
    assert.equal(getBufferFloor('nba', ['points', 'rebounds', 'assists']), 2);
    assert.equal(getBufferFloor('afl', ['disposals']), 1);
  });
});

test('player-form: box-score extraction', async (t) => {
  await t.test('sums combo components, case-insensitive name match', () => {
    const rows = [{ playerName: 'Nikola Jokic', points: 25, rebounds: 12, assists: 9 }];
    assert.equal(extractPlayerGameValue(rows, 'nikola jokic', ['points', 'rebounds', 'assists']), 46);
  });

  await t.test('reads from statValues fallback', () => {
    const rows = [{ playerName: 'Sam Walsh', statValues: { disposals: 28 } }];
    assert.equal(extractPlayerGameValue(rows, 'Sam Walsh', ['disposals']), 28);
  });

  await t.test('missing player or missing component returns null', () => {
    const rows = [{ playerName: 'Sam Walsh', disposals: 28 }];
    assert.equal(extractPlayerGameValue(rows, 'Ghost', ['disposals']), null);
    assert.equal(extractPlayerGameValue(rows, 'Sam Walsh', ['goals']), null);
  });

  await t.test('buildPlayerStatSeries skips games without the player', () => {
    const games = [
      [{ playerName: 'Sam Walsh', disposals: 30 }],
      [{ playerName: 'Other', disposals: 10 }],
      [{ playerName: 'Sam Walsh', disposals: 26 }]
    ];
    assert.deepEqual(buildPlayerStatSeries(games, 'Sam Walsh', ['disposals']), [30, 26]);
  });
});

test('player-form: prop evidence', async (t) => {
  const aflStatKeys = ['disposals'];

  await t.test('supported: star player clears the line with a safe buffer', () => {
    const ev = computePropEvidence({
      series: [28, 30, 26, 27, 25], line: 20.5, side: 'Over', sport: 'afl', statKeys: aflStatKeys
    });
    assert.equal(ev.status, PROP_EVIDENCE_STATUS.SUPPORTED);
    assert.equal(ev.hitRate, 1);
    assert.ok(ev.buffer >= 3);
    assert.ok(ev.score > 2);
  });

  await t.test('contra: recent form sits well below the over line', () => {
    const ev = computePropEvidence({
      series: [15, 16, 14, 18, 15], line: 20.5, side: 'Over', sport: 'afl', statKeys: aflStatKeys
    });
    assert.equal(ev.status, PROP_EVIDENCE_STATUS.CONTRA);
    assert.ok(ev.score < 0);
  });

  await t.test('weak: marginal buffer even with a coin-flip hit-rate', () => {
    const ev = computePropEvidence({
      series: [21, 22, 19, 20, 23], line: 20.5, side: 'Over', sport: 'afl', statKeys: aflStatKeys
    });
    assert.equal(ev.status, PROP_EVIDENCE_STATUS.WEAK);
  });

  await t.test('unknown: not enough games to judge', () => {
    const ev = computePropEvidence({
      series: [25, 24], line: 20.5, side: 'Over', sport: 'afl', statKeys: aflStatKeys
    });
    assert.equal(ev.status, PROP_EVIDENCE_STATUS.UNKNOWN);
    assert.equal(ev.gamesPlayed, 2);
  });

  await t.test('under side: supported when the player stays below the line', () => {
    const ev = computePropEvidence({
      series: [10, 12, 9, 11, 8], line: 14.5, side: 'Under', sport: 'nba', statKeys: ['points']
    });
    assert.equal(ev.status, PROP_EVIDENCE_STATUS.SUPPORTED);
    assert.equal(ev.hitRate, 1);
  });

  await t.test('at-least side honours >= comparison', () => {
    const ev = computePropEvidence({
      series: [25, 25, 26, 24, 25], line: 20, side: 'at least', sport: 'nba', statKeys: ['points']
    });
    assert.equal(ev.status, PROP_EVIDENCE_STATUS.SUPPORTED);
  });
});
