import test from 'node:test';
import assert from 'node:assert';
import { getBoxscoreProvider, loadEventDeepEvidenceInputs } from '../src/jobs/analysis.mjs';

test('getBoxscoreProvider routes player box scores per sport', () => {
  assert.equal(getBoxscoreProvider('afl').label, 'afl-official');
  assert.equal(getBoxscoreProvider('afl').summaryByEvent, true);
  assert.equal(getBoxscoreProvider('nrl').label, 'nrl-official');
  assert.equal(getBoxscoreProvider('nba').label, 'espn');
  assert.equal(getBoxscoreProvider('mlb').summaryByEvent, false);
});

test('loadEventDeepEvidenceInputs pulls NRL box scores from the official provider', async () => {
  const sport = { key: 'nrl', path: 'rugby-league/nrl' };
  const eventContext = {
    sportKey: 'nrl',
    homeTeam: 'Storm',
    awayTeam: 'Broncos',
    homeTeamId: '',
    awayTeamId: '',
    startTime: '2026-06-14T08:00:00.000Z',
    timezone: 'Australia/Sydney',
    deepAnalysis: { enabled: true, requireLegEvidence: true, recentGames: 3, minGames: 3 }
  };

  // ESPN slate feeds the matchup (team form) scan.
  const fetchEspnSlate = async () => ({
    events: [
      { id: 'e1', state: 'post', startTime: '2026-06-07T08:00:00Z', homeTeam: 'Storm', awayTeam: 'Sharks', homeScore: 24, awayScore: 10 },
      { id: 'e2', state: 'post', startTime: '2026-06-06T08:00:00Z', homeTeam: 'Eels', awayTeam: 'Broncos', homeScore: 18, awayScore: 22 }
    ]
  });

  // Official NRL slate + summary feed the player box scores.
  let summaryCalls = 0;
  const fetchNrlOfficialSlate = async () => ({
    events: [{ id: 'o1', state: 'post', startTime: '2026-06-07T08:00:00Z', homeTeam: 'Storm', awayTeam: 'Sharks', homeTeamId: '', awayTeamId: '' }]
  });
  const fetchNrlOfficialSummary = async (_sport, event) => {
    summaryCalls += 1;
    return { event, playerStats: [{ playerName: 'Harry Grant', points: 14, statValues: { points: 14 } }] };
  };

  const inputs = await loadEventDeepEvidenceInputs(sport, eventContext, {}, {
    fetchEspnSlate,
    fetchNrlOfficialSlate,
    fetchNrlOfficialSummary
  }, { fetchBoxscores: true });

  const homeBoxscores = inputs.boxscoresBySide.get('home');
  assert.ok(Array.isArray(homeBoxscores) && homeBoxscores.length >= 1, 'official box scores were fetched for the home team');
  assert.equal(homeBoxscores[0][0].playerName, 'Harry Grant');
  assert.ok(summaryCalls >= 1, 'official summary provider was used');
});

test('loadEventDeepEvidenceInputs pulls AFL box scores from the official provider', async () => {
  const sport = { key: 'afl', path: 'australian-football/afl' };
  const eventContext = {
    sportKey: 'afl',
    homeTeam: 'Carlton',
    awayTeam: 'Geelong',
    homeTeamId: '',
    awayTeamId: '',
    startTime: '2026-06-14T08:00:00.000Z',
    timezone: 'Australia/Melbourne',
    deepAnalysis: { enabled: true, requireLegEvidence: true, recentGames: 3, minGames: 3 }
  };

  const fetchEspnSlate = async () => ({ events: [] });
  const fetchAflOfficialSlate = async () => ({
    events: [{ id: 'a1', state: 'post', startTime: '2026-06-07T08:00:00Z', homeTeam: 'Carlton', awayTeam: 'Sydney', homeTeamId: '', awayTeamId: '' }]
  });
  const fetchAflOfficialSummary = async (_sport, event) => ({
    event,
    playerStats: [{ playerName: 'Sam Walsh', disposals: 30, statValues: { disposals: 30 } }]
  });

  const inputs = await loadEventDeepEvidenceInputs(sport, eventContext, {}, {
    fetchEspnSlate,
    fetchAflOfficialSlate,
    fetchAflOfficialSummary
  }, { fetchBoxscores: true });

  const homeBoxscores = inputs.boxscoresBySide.get('home');
  assert.ok(Array.isArray(homeBoxscores) && homeBoxscores.length >= 1);
  assert.equal(homeBoxscores[0][0].playerName, 'Sam Walsh');
});
