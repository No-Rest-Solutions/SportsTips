import test from 'node:test';
import assert from 'node:assert';
import { settleCrossGameMultiPick } from '../src/jobs/results.mjs';

const config = {
  timezone: 'UTC',
  jobs: { results: {} },
  sports: [{ key: 'soccer_epl', marketKey: 'soccer_epl', path: 'soccer/eng.1' }],
  sportsGameOdds: { bookmakers: [] }
};

function leg(eventId, home, away, backed, odds, startTime) {
  return {
    id: `leg-${eventId}`,
    label: `${backed} H2H`,
    odds,
    eventId,
    homeTeam: home,
    awayTeam: away,
    startTime,
    legSport: 'soccer_epl',
    source: { type: 'web-scrape', market: 'h2h', outcomeName: backed, description: '', point: null }
  };
}

function crossGamePick(legs) {
  return { id: 'cross:soccer_epl:x', crossGame: true, betType: 'cross_game_multi', sport: 'soccer_epl', stakeUnits: 1, legs };
}

// ESPN slate returning both finalized matches.
const fetchEspnSlate = async () => ({
  events: [
    { id: 'e1', homeTeam: 'Arsenal', awayTeam: 'Chelsea', homeScore: 2, awayScore: 0, state: 'post', startTime: '2026-06-15T10:00:00Z' },
    { id: 'e2', homeTeam: 'Liverpool', awayTeam: 'Everton', homeScore: 3, awayScore: 1, state: 'post', startTime: '2026-06-15T12:00:00Z' }
  ]
});

test('cross-game settlement: all legs win → slip win on combined odds', async () => {
  const pick = crossGamePick([
    leg('e1', 'Arsenal', 'Chelsea', 'Arsenal', 1.5, '2026-06-15T10:00:00Z'),
    leg('e2', 'Liverpool', 'Everton', 'Liverpool', 1.6, '2026-06-15T12:00:00Z')
  ]);
  const result = await settleCrossGameMultiPick(pick, { config }, { scoreboardCache: new Map(), summaryCache: new Map() }, { fetchEspnSlate }, '2026-06-15T15:00:00Z');
  assert.equal(result.settledPick.status, 'win');
  assert.ok(Math.abs(result.settledPick.returnUnits - 2.4) < 1e-9);
});

test('cross-game settlement: one leg loses → slip loss', async () => {
  const pick = crossGamePick([
    leg('e1', 'Arsenal', 'Chelsea', 'Arsenal', 1.5, '2026-06-15T10:00:00Z'),
    leg('e2', 'Liverpool', 'Everton', 'Everton', 1.6, '2026-06-15T12:00:00Z') // backed the loser
  ]);
  const result = await settleCrossGameMultiPick(pick, { config }, { scoreboardCache: new Map(), summaryCache: new Map() }, { fetchEspnSlate }, '2026-06-15T15:00:00Z');
  assert.equal(result.settledPick.status, 'loss');
  assert.equal(result.settledPick.returnUnits, 0);
});

test('cross-game settlement: a leg with no finalized result defers the whole slip', async () => {
  const pick = crossGamePick([
    leg('e1', 'Arsenal', 'Chelsea', 'Arsenal', 1.5, '2026-06-15T10:00:00Z'),
    leg('e3', 'Spurs', 'United', 'Spurs', 1.6, '2026-06-15T12:00:00Z') // not in the slate
  ]);
  const result = await settleCrossGameMultiPick(pick, { config }, { scoreboardCache: new Map(), summaryCache: new Map() }, { fetchEspnSlate }, '2026-06-15T15:00:00Z');
  assert.equal(result.settledPick, null);
  assert.match(result.unresolvedReason, /pending/i);
});
