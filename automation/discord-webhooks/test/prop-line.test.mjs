import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePropLineAndSide } from '../src/jobs/analysis.mjs';

// Regression: bookmaker "N+" threshold props (AFL disposals, NRL points) carry the
// line in the outcome NAME, not candidate.point. If this parser breaks, the deep
// gate marks every AFL/NRL prop "unknown" and posts 0 picks on a live game night.
test('resolvePropLineAndSide parses "N+" threshold markets to an at-least line', () => {
  assert.deepEqual(resolvePropLineAndSide({ outcomeName: '20+ Disposals', point: null }), { line: 20, side: 'at least' });
  assert.deepEqual(resolvePropLineAndSide({ outcomeName: '6+ Points' }), { line: 6, side: 'at least' });
  assert.deepEqual(resolvePropLineAndSide({ outcomeName: '15+ Disposals', point: null }), { line: 15, side: 'at least' });
});

test('resolvePropLineAndSide parses over/under lines and prefers an explicit point', () => {
  assert.deepEqual(resolvePropLineAndSide({ outcomeName: 'Over 19.5 Disposals', point: 19.5 }), { line: 19.5, side: 'over' });
  assert.deepEqual(resolvePropLineAndSide({ outcomeName: 'Under 1.5 Tries', point: null }), { line: 1.5, side: 'under' });
  // Explicit point wins over a stray number in the name.
  assert.deepEqual(resolvePropLineAndSide({ outcomeName: 'Over 2.5', point: 2.5 }), { line: 2.5, side: 'over' });
});
