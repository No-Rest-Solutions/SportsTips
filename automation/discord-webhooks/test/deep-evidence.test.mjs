import test from 'node:test';
import assert from 'node:assert';
import { attachDeepEvidence, computeCandidateDeepEvidence } from '../src/jobs/analysis.mjs';

const strong = { games: 5, wins: 4, winRate: 0.8, avgFor: 28, avgAgainst: 18, avgMargin: 10, avgTotal: 46 };
const weak = { games: 5, wins: 1, winRate: 0.2, avgFor: 16, avgAgainst: 26, avgMargin: -10, avgTotal: 42 };

const eventContext = {
  sportKey: 'nrl',
  homeTeam: 'Storm',
  awayTeam: 'Broncos',
  deepAnalysis: { minGames: 4, minHitRate: 0.6, recentGames: 5 }
};

// Player A (home) clears a 12.5 points line comfortably; Player B (away) does not.
const inputs = {
  homeForm: strong,
  awayForm: weak,
  h2hForHome: { games: 2, pickedWins: 2, pickedWinRate: 1 },
  h2hForAway: { games: 2, pickedWins: 0, pickedWinRate: 0 },
  boxscoresBySide: new Map([
    ['home', [
      [{ playerName: 'Player A', points: 20 }],
      [{ playerName: 'Player A', points: 18 }],
      [{ playerName: 'Player A', points: 22 }],
      [{ playerName: 'Player A', points: 16 }],
      [{ playerName: 'Player A', points: 20 }]
    ]],
    ['away', [
      [{ playerName: 'Player B', points: 6 }],
      [{ playerName: 'Player B', points: 8 }],
      [{ playerName: 'Player B', points: 4 }],
      [{ playerName: 'Player B', points: 7 }],
      [{ playerName: 'Player B', points: 5 }]
    ]]
  ])
};

test('deep-evidence: per-candidate grading', async (t) => {
  await t.test('player prop with a safe buffer is supported', () => {
    const ev = computeCandidateDeepEvidence('nrl', eventContext, {
      family: 'prop', market: 'player_points', description: 'Player A', point: 12.5, outcomeName: 'Over'
    }, inputs);
    assert.equal(ev.status, 'supported');
    assert.equal(ev.type, 'player-form');
  });

  await t.test('player prop above the player\'s range is contra', () => {
    const ev = computeCandidateDeepEvidence('nrl', eventContext, {
      family: 'prop', market: 'player_points', description: 'Player B', point: 12.5, outcomeName: 'Over'
    }, inputs);
    assert.equal(ev.status, 'contra');
  });

  await t.test('player with no box-score history is unknown', () => {
    const ev = computeCandidateDeepEvidence('nrl', eventContext, {
      family: 'prop', market: 'player_points', description: 'Ghost', point: 12.5, outcomeName: 'Over'
    }, inputs);
    assert.equal(ev.status, 'unknown');
  });

  await t.test('h2h backing the stronger home side is supported', () => {
    const ev = computeCandidateDeepEvidence('nrl', eventContext, {
      family: 'side', market: 'h2h', outcomeName: 'Storm'
    }, inputs);
    assert.equal(ev.status, 'supported');
    assert.equal(ev.type, 'matchup-h2h');
  });

  await t.test('h2h backing the weaker away side is contra (the Wests-Tigers case)', () => {
    const ev = computeCandidateDeepEvidence('nrl', eventContext, {
      family: 'side', market: 'h2h', outcomeName: 'Broncos'
    }, inputs);
    assert.equal(ev.status, 'contra');
  });

  await t.test('unmodelled markets resolve to unknown', () => {
    const ev = computeCandidateDeepEvidence('nrl', eventContext, {
      family: 'side', market: 'double_chance', outcomeName: 'Storm'
    }, inputs);
    assert.equal(ev.status, 'unknown');
    assert.equal(ev.type, 'none');
  });
});

test('deep-evidence: attach + supported-only filter (the gate)', async (t) => {
  await t.test('attachDeepEvidence tags every candidate and the gate keeps only supported', () => {
    const pool = [
      { key: 'k1', family: 'prop', market: 'player_points', description: 'Player A', point: 12.5, outcomeName: 'Over' },
      { key: 'k2', family: 'side', market: 'h2h', outcomeName: 'Broncos' },
      { key: 'k3', family: 'side', market: 'double_chance', outcomeName: 'Storm' }
    ];

    const tagged = attachDeepEvidence({ key: 'nrl' }, eventContext, pool, inputs);
    assert.equal(tagged.length, 3);
    assert.ok(tagged.every((candidate) => typeof candidate.evidenceStatus === 'string'));

    const gated = tagged.filter((candidate) => candidate.evidenceStatus === 'supported');
    assert.deepEqual(gated.map((candidate) => candidate.key), ['k1']);
  });
});
