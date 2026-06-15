import test from 'node:test';
import assert from 'node:assert';
import { gradePlayerMarketLeg } from '../src/jobs/results.mjs';

const leg = {
  label: 'John Doe Over 15.5 Points',
  source: { market: 'player_points', description: 'John Doe', outcomeName: 'Over', point: 15.5 }
};

function propContext({ rows = null, summaryFetched = true, refundNonParticipants = true } = {}) {
  const playerStatsByName = new Map();
  if (rows) {
    playerStatsByName.set('john doe', rows);
  }
  return { sportKey: 'nba', sourceLabel: 'ESPN', playerStatsByName, summaryFetched, refundNonParticipants };
}

test('#33 DNP / pulled-early refund', async (t) => {
  await t.test('DNP (absent from a fetched box score) → refund (push) when enabled', () => {
    const result = gradePlayerMarketLeg(leg, {}, propContext({ rows: null }));
    assert.equal(result.outcome, 'push');
  });

  await t.test('DNP is deferred (not refunded) when the flag is off', () => {
    const result = gradePlayerMarketLeg(leg, {}, propContext({ rows: null, refundNonParticipants: false }));
    assert.equal(result.outcome, null);
    assert.ok(result.unresolvedReason);
  });

  await t.test('pulled early (low minutes) + would lose → refund (push)', () => {
    const result = gradePlayerMarketLeg(leg, {}, propContext({ rows: [{ playerName: 'John Doe', points: 8, minutes: 5 }] }));
    assert.equal(result.outcome, 'push');
  });

  await t.test('low minutes but already hit the line → still a win', () => {
    const result = gradePlayerMarketLeg(leg, {}, propContext({ rows: [{ playerName: 'John Doe', points: 20, minutes: 5 }] }));
    assert.equal(result.outcome, 'win');
  });

  await t.test('full minutes underperformance → normal loss (not refunded)', () => {
    const result = gradePlayerMarketLeg(leg, {}, propContext({ rows: [{ playerName: 'John Doe', points: 8, minutes: 31 }] }));
    assert.equal(result.outcome, 'loss');
  });

  await t.test('full minutes over the line → win', () => {
    const result = gradePlayerMarketLeg(leg, {}, propContext({ rows: [{ playerName: 'John Doe', points: 20, minutes: 31 }] }));
    assert.equal(result.outcome, 'win');
  });
});
