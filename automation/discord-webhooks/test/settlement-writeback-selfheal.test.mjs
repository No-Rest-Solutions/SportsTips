import test from 'node:test';
import assert from 'node:assert/strict';

import { __testables } from '../src/settlement-writeback.mjs';

const { replaceSectionBody } = __testables;

// Regression: a reset/older profit tracker that is MISSING the "Pending Bet Notes" section
// used to throw "Missing section: Pending Bet Notes" — an unhandled error that crashed the
// whole daemon. The writeback must now SELF-HEAL by inserting the section instead.
test('replaceSectionBody inserts a missing section instead of throwing', () => {
  const stripped = [
    '# 30-Day Profit Tracker',
    '',
    '## Current Position',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    '| Current Bankroll | 10.00u |',
    '',
    '## Settled Bet Log',
    '',
    '| Date | Result |',
    '| --- | --- |',
    '',
    '## Tracker Notes',
    '- note',
    ''
  ].join('\n');

  let out;
  assert.doesNotThrow(() => {
    out = replaceSectionBody(stripped, 'Pending Bet Notes', 'Settled Bet Log', '_No pending bets._');
  });

  assert.match(out, /## Pending Bet Notes/, 'the missing section is inserted');
  assert.match(out, /_No pending bets\._/, 'the section body is written');
  // It is inserted BEFORE the next heading, and the existing sections survive.
  assert.ok(out.indexOf('## Pending Bet Notes') < out.indexOf('## Settled Bet Log'), 'inserted before next heading');
  assert.match(out, /## Current Position/);
  assert.match(out, /## Tracker Notes/);
});

test('replaceSectionBody still replaces an existing section body', () => {
  const withSection = '## Pending Bet Notes\n\nOLD BODY\n\n## Settled Bet Log\n\nrows\n';
  const out = replaceSectionBody(withSection, 'Pending Bet Notes', 'Settled Bet Log', 'NEW BODY');
  assert.match(out, /NEW BODY/);
  assert.doesNotMatch(out, /OLD BODY/);
});

test('replaceSectionBody appends when neither heading is present', () => {
  const out = replaceSectionBody('# Title\n\n## Other\n\nx\n', 'Pending Bet Notes', 'Settled Bet Log', 'body');
  assert.match(out, /## Pending Bet Notes\n\nbody/);
});
