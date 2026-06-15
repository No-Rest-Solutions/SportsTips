import test from 'node:test';
import assert from 'node:assert';
import {
  gradeH2hLeg,
  gradePlayerTotalLeg,
  gradePromoLeg,
  fetchPromoLegResults,
  __testables
} from '../src/promos-grading.mjs';

const { promoStatKeyFor, buildPlayersForStat, scoreboardEventMatchesLeg, LEG_RESULT } = __testables;

test('Promos Grading - h2h', async (t) => {
  const summary = { status: 'final', homeTeam: 'Carlton', awayTeam: 'Geelong', homeScore: 100, awayScore: 80 };

  await t.test('winner picked wins', () => {
    assert.deepEqual(gradeH2hLeg({ market: 'h2h', team: 'Carlton' }, summary), { outcome: LEG_RESULT.WIN });
  });

  await t.test('loser picked loses', () => {
    assert.deepEqual(gradeH2hLeg({ market: 'h2h', team: 'Geelong' }, summary), { outcome: LEG_RESULT.LOSS });
  });

  await t.test('a draw voids the leg', () => {
    const draw = { ...summary, homeScore: 90, awayScore: 90 };
    assert.deepEqual(gradeH2hLeg({ market: 'h2h', team: 'Carlton' }, draw), { outcome: LEG_RESULT.VOID });
  });

  await t.test('non-final summary is not gradable', () => {
    assert.equal(gradeH2hLeg({ market: 'h2h', team: 'Carlton' }, { ...summary, status: 'in' }), null);
  });
});

test('Promos Grading - player totals (with missBy)', async (t) => {
  const summaryFor = (value) => ({ status: 'final', players: [{ name: 'Sam Walsh', value }] });
  const baseLeg = { market: 'player_disposals', player: 'Sam Walsh', point: 24.5, side: 'over' };

  await t.test('over the line wins', () => {
    assert.deepEqual(gradePlayerTotalLeg(baseLeg, summaryFor(26)), { outcome: LEG_RESULT.WIN });
  });

  await t.test('under the line loses and reports the miss margin', () => {
    assert.deepEqual(gradePlayerTotalLeg(baseLeg, summaryFor(22)), { outcome: LEG_RESULT.LOSS, missBy: 2.5 });
  });

  await t.test('under side wins below the line', () => {
    assert.deepEqual(
      gradePlayerTotalLeg({ ...baseLeg, side: 'under' }, summaryFor(22)),
      { outcome: LEG_RESULT.WIN }
    );
  });

  await t.test('at-least win/loss with missBy', () => {
    const leg = { market: 'player_points', player: 'Sam Walsh', point: 25, side: 'at least' };
    assert.deepEqual(gradePlayerTotalLeg(leg, summaryFor(25)), { outcome: LEG_RESULT.WIN });
    assert.deepEqual(gradePlayerTotalLeg(leg, summaryFor(24)), { outcome: LEG_RESULT.LOSS, missBy: 1 });
  });

  await t.test('landing exactly on a whole line voids', () => {
    const leg = { market: 'player_disposals', player: 'Sam Walsh', point: 24, side: 'over' };
    assert.deepEqual(gradePlayerTotalLeg(leg, summaryFor(24)), { outcome: LEG_RESULT.VOID });
  });

  await t.test('missing player stat is not gradable', () => {
    assert.equal(gradePlayerTotalLeg(baseLeg, { status: 'final', players: [] }), null);
  });
});

test('Promos Grading - dispatch & helpers', async (t) => {
  await t.test('gradePromoLeg routes by market', () => {
    const h2h = gradePromoLeg({ market: 'h2h', team: 'A' }, { status: 'final', homeTeam: 'A', awayTeam: 'B', homeScore: 2, awayScore: 1 });
    assert.equal(h2h.outcome, LEG_RESULT.WIN);
  });

  await t.test('promoStatKeyFor maps known markets', () => {
    assert.equal(promoStatKeyFor('afl', 'player_disposals'), 'disposals');
    assert.equal(promoStatKeyFor('nrl', 'player_points'), 'points');
    assert.equal(promoStatKeyFor('afl', 'player_goals'), '');
  });

  await t.test('buildPlayersForStat normalizes box-score rows', () => {
    const players = buildPlayersForStat(
      [{ playerName: 'Sam Walsh', disposals: 28 }, { playerName: 'No Stat' }],
      'disposals'
    );
    assert.deepEqual(players, [{ name: 'Sam Walsh', value: 28 }]);
  });

  await t.test('scoreboardEventMatchesLeg matches either orientation', () => {
    const leg = { homeTeam: 'Carlton', awayTeam: 'Geelong' };
    assert.equal(scoreboardEventMatchesLeg({ homeTeam: 'Carlton', awayTeam: 'Geelong' }, leg), true);
    assert.equal(scoreboardEventMatchesLeg({ homeTeam: 'Geelong', awayTeam: 'Carlton' }, leg), true);
    assert.equal(scoreboardEventMatchesLeg({ homeTeam: 'Sydney', awayTeam: 'Carlton' }, leg), false);
  });
});

test('fetchPromoLegResults grades via an injected summary fetcher', async (t) => {
  await t.test('produces leg results and skips unresolved legs', async () => {
    const legs = [
      { id: 'L1', sport: 'tennis', market: 'h2h', team: 'P1', odds: 1.5, homeTeam: 'P1', awayTeam: 'P2' },
      { id: 'L2', sport: 'afl', market: 'player_disposals', player: 'Sam Walsh', point: 24.5, side: 'over', odds: 1.8 },
      { id: 'L3', sport: 'afl', market: 'player_disposals', player: 'Ghost', point: 20, side: 'over', odds: 2.0 }
    ];

    const summaries = {
      L1: { status: 'final', homeTeam: 'P1', awayTeam: 'P2', homeScore: 2, awayScore: 0, source: 'ESPN' },
      L2: { status: 'final', players: [{ name: 'Sam Walsh', value: 20 }], source: 'Official AFL' },
      L3: null
    };

    const results = await fetchPromoLegResults({}, legs, {
      fetchSummaryForLeg: async (leg) => summaries[leg.id]
    });

    assert.equal(results.length, 2, 'unresolved L3 is omitted');

    const byMarket = Object.fromEntries(results.map((r) => [r.market, r]));
    assert.equal(byMarket.h2h.outcome, 'win');
    assert.equal(byMarket.h2h.team, 'P1');
    assert.equal(byMarket.player_disposals.outcome, 'loss');
    assert.equal(byMarket.player_disposals.missBy, 4.5);
    assert.equal(byMarket.player_disposals.source, 'Official AFL');
  });
});
