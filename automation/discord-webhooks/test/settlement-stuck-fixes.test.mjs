import test from 'node:test';
import assert from 'node:assert';
import { resolveConsensusOutcome, buildAutoSettledPick } from '../src/jobs/results.mjs';

// FIX 1: a leg only one source can grade (e.g. AFL/NRL player props, whose player
// box scores come only from the official feed) must still settle, instead of the
// whole slip sticking pending forever because it can never reach 2 agreeing sources.
test('resolveConsensusOutcome settles a single authoritative grade below the bar', () => {
  // Official AFL alone grades the player prop (ESPN/Flashscore carry no AFL player
  // stats) -> settles on the authoritative source.
  assert.equal(
    resolveConsensusOutcome(
      [{ outcome: 'win', sourceKey: 'official_afl' }, { outcome: null, sourceKey: 'espn' }],
      2,
      ['official_afl']
    ),
    'win'
  );
});

test('resolveConsensusOutcome refuses a single NON-authoritative grade below the bar', () => {
  // ESPN alone is not trusted for AFL player props -> stays unresolved (waits for
  // the official feed) rather than settling on a possibly-wrong source.
  assert.equal(
    resolveConsensusOutcome(
      [{ outcome: 'win', sourceKey: 'espn' }, { outcome: null, sourceKey: 'official_afl' }],
      2,
      ['official_afl']
    ),
    null
  );
});

test('resolveConsensusOutcome still settles a team market on the majority', () => {
  // Team markets have no single-source restriction (trusted = null): 2 of 3 agree.
  assert.equal(
    resolveConsensusOutcome(
      [
        { outcome: 'win', sourceKey: 'espn' },
        { outcome: 'win', sourceKey: 'official_afl' },
        { outcome: 'loss', sourceKey: 'flashscore' }
      ],
      2,
      null
    ),
    'win'
  );
});

test('resolveConsensusOutcome still blocks a genuine two-source disagreement', () => {
  assert.equal(
    resolveConsensusOutcome(
      [{ outcome: 'win', sourceKey: 'espn' }, { outcome: 'loss', sourceKey: 'official_afl' }],
      2,
      null
    ),
    null
  );
});

test('resolveConsensusOutcome settles a single-source sport (requiredAgreements 1) as before', () => {
  assert.equal(
    resolveConsensusOutcome([{ outcome: 'win', sourceKey: 'espn' }], 1, ['espn']),
    'win'
  );
});

// FIX 2: a multi where one leg pushes/voids (e.g. the DNP/pulled-early refund) and
// the rest win used to stick pending forever ("needs reduced-odds repricing"). It now
// re-prices like a bookmaker voids a leg: divide the total price by the voided odds.
const event = { homeTeam: 'Home', awayTeam: 'Away', homeScore: 30, awayScore: 20, state: 'post' };
const sourceContexts = [{
  sourceKey: 'espn',
  sourceLabel: 'ESPN',
  event,
  propContext: { sportKey: 'nrl', sourceLabel: 'ESPN', playerStatsByName: new Map() }
}];

test('buildAutoSettledPick re-prices a partial push (one voided leg) onto the winners', () => {
  const pick = {
    sport: 'nrl',
    homeTeam: 'Home',
    awayTeam: 'Away',
    stakeUnits: 1,
    legs: [
      { id: 'l1', label: 'Home H2H', odds: 2.0, source: { market: 'h2h', outcomeName: 'Home' } },
      { id: 'l2', label: 'Over 50.0', odds: 1.5, source: { market: 'totals', outcomeName: 'Over', point: 50 } }
    ]
  };

  // Home win (30 > 20); total 50 lands exactly on the 50 line -> push.
  const { settledPick, unresolvedReason } = buildAutoSettledPick(pick, sourceContexts, '2026-06-15T00:00:00.000Z', 3.0, 1);

  assert.equal(unresolvedReason, null);
  assert.equal(settledPick.status, 'win');
  // 3.00 total / 1.50 voided leg = 2.00 on the remaining winner.
  assert.equal(settledPick.priceDecimal, 2.0);
  assert.equal(settledPick.returnUnits, 2.0);
  assert.equal(settledPick.netUnits, 1.0);
  assert.match(String(settledPick.resultNotes || ''), /re-priced to 2\.00/i);
});

test('buildAutoSettledPick refunds a partial push when the voided leg has no odds', () => {
  const pick = {
    sport: 'nrl',
    homeTeam: 'Home',
    awayTeam: 'Away',
    stakeUnits: 1,
    legs: [
      { id: 'l1', label: 'Home H2H', odds: 2.0, source: { market: 'h2h', outcomeName: 'Home' } },
      { id: 'l2', label: 'Over 50.0', source: { market: 'totals', outcomeName: 'Over', point: 50 } }
    ]
  };

  const { settledPick, unresolvedReason } = buildAutoSettledPick(pick, sourceContexts, '2026-06-15T00:00:00.000Z', 3.0, 1);

  assert.equal(unresolvedReason, null);
  assert.equal(settledPick.status, 'return');
  assert.equal(settledPick.returnUnits, 1.0);
  assert.equal(settledPick.netUnits, 0);
});
