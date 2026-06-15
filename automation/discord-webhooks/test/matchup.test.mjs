import test from 'node:test';
import assert from 'node:assert';
import { __testables } from '../src/research/matchup.mjs';

const {
  computeTeamFormSummary,
  computeH2hRecord,
  computeH2hEvidence,
  computeTotalsEvidence,
  computeSpreadEvidence,
  MATCHUP_EVIDENCE_STATUS
} = __testables;

const strong = { games: 5, wins: 4, winRate: 0.8, avgFor: 28, avgAgainst: 18, avgMargin: 10, avgTotal: 46 };
const weakTeam = { games: 5, wins: 2, winRate: 0.4, avgFor: 18, avgAgainst: 22, avgMargin: -4, avgTotal: 40 };

test('matchup: team form & h2h summaries', async (t) => {
  await t.test('computeTeamFormSummary aggregates results', () => {
    const summary = computeTeamFormSummary([
      { scored: 24, conceded: 18 },
      { scored: 30, conceded: 10 },
      { scored: 12, conceded: 20 }
    ]);
    assert.equal(summary.games, 3);
    assert.equal(summary.wins, 2);
    assert.equal(summary.avgFor, 22);
    assert.equal(summary.avgAgainst, 16);
    assert.equal(summary.avgMargin, 6);
    assert.equal(summary.avgTotal, 38);
  });

  await t.test('computeTeamFormSummary returns null without data', () => {
    assert.equal(computeTeamFormSummary([]), null);
  });

  await t.test('computeH2hRecord counts picked-team wins', () => {
    const record = computeH2hRecord([{ pickedWon: true }, { pickedWon: false }, { pickedWon: true }]);
    assert.equal(record.games, 3);
    assert.equal(record.pickedWins, 2);
    assert.ok(Math.abs(record.pickedWinRate - 2 / 3) < 1e-9);
  });
});

test('matchup: h2h evidence', async (t) => {
  await t.test('supported when backing the clearly stronger home side', () => {
    const ev = computeH2hEvidence({ teamForm: strong, oppForm: weakTeam, isHome: true });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.SUPPORTED);
    assert.ok(ev.score > 2);
  });

  await t.test('contra when backing the weaker side', () => {
    const ev = computeH2hEvidence({ teamForm: weakTeam, oppForm: strong, isHome: false });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.CONTRA);
  });

  await t.test('weak when there is no clear edge', () => {
    const ev = computeH2hEvidence({
      teamForm: { games: 5, wins: 3, winRate: 0.55, avgMargin: 1 },
      oppForm: { games: 5, wins: 3, winRate: 0.5, avgMargin: 0 },
      isHome: true
    });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.WEAK);
  });

  await t.test('away sides need a bigger edge (penalty applied)', () => {
    const borderline = {
      teamForm: { games: 5, wins: 3, winRate: 0.65, avgMargin: 5 },
      oppForm: { games: 5, wins: 2, winRate: 0.45, avgMargin: -1 }
    };
    assert.equal(computeH2hEvidence({ ...borderline, isHome: true }).status, MATCHUP_EVIDENCE_STATUS.SUPPORTED);
    assert.equal(computeH2hEvidence({ ...borderline, isHome: false }).status, MATCHUP_EVIDENCE_STATUS.WEAK);
  });

  await t.test('unknown without enough games', () => {
    const ev = computeH2hEvidence({ teamForm: { games: 2, winRate: 1, avgMargin: 10 }, oppForm: strong, isHome: true });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.UNKNOWN);
  });
});

test('matchup: totals evidence', async (t) => {
  await t.test('supported over when projected total clears the line', () => {
    const ev = computeTotalsEvidence({ homeForm: { games: 5, avgTotal: 45 }, awayForm: { games: 5, avgTotal: 47 }, line: 40, side: 'Over' });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.SUPPORTED);
    assert.equal(ev.projectedTotal, 46);
  });

  await t.test('contra over when scoring sits well below the line', () => {
    const ev = computeTotalsEvidence({ homeForm: { games: 5, avgTotal: 38 }, awayForm: { games: 5, avgTotal: 42 }, line: 50, side: 'Over' });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.CONTRA);
  });

  await t.test('weak when projected total hugs the line', () => {
    const ev = computeTotalsEvidence({ homeForm: { games: 5, avgTotal: 45 }, awayForm: { games: 5, avgTotal: 46 }, line: 45, side: 'Over' });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.WEAK);
  });

  await t.test('unknown without enough games', () => {
    const ev = computeTotalsEvidence({ homeForm: { games: 2, avgTotal: 45 }, awayForm: { games: 5, avgTotal: 46 }, line: 40, side: 'Over' });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.UNKNOWN);
  });
});

test('matchup: spread / protected-line evidence', async (t) => {
  await t.test('supported when expected margin covers a protective + line', () => {
    // Slightly weaker side but a +6.5 cushion comfortably covers.
    const ev = computeSpreadEvidence({
      teamForm: { games: 5, avgMargin: -2 }, oppForm: { games: 5, avgMargin: 2 }, line: 6.5, isHome: true
    });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.SUPPORTED);
  });

  await t.test('contra when the line cannot cover the gap', () => {
    const ev = computeSpreadEvidence({
      teamForm: { games: 5, avgMargin: -12 }, oppForm: { games: 5, avgMargin: 10 }, line: -2.5, isHome: false
    });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.CONTRA);
  });

  await t.test('unknown without enough games', () => {
    const ev = computeSpreadEvidence({ teamForm: { games: 1, avgMargin: 5 }, oppForm: { games: 5, avgMargin: 0 }, line: 1.5 });
    assert.equal(ev.status, MATCHUP_EVIDENCE_STATUS.UNKNOWN);
  });
});
