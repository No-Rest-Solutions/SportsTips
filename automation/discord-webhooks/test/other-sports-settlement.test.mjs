import test from 'node:test';
import assert from 'node:assert';
import { parseEvent } from '../src/providers/espn.mjs';
import { eventMatchesPick } from '../src/jobs/results.mjs';

test('ESPN parseEvent reads athlete names for individual sports (tennis)', () => {
  // Tennis events have no homeAway and competitors carry .athlete, not .team.
  const tennisEvent = {
    id: 't1',
    date: '2026-06-14T10:00:00Z',
    competitions: [{
      competitors: [
        { athlete: { displayName: 'Carlos Alcaraz', id: 'a1' }, score: '3' },
        { athlete: { displayName: 'Jannik Sinner', id: 'a2' }, score: '2' }
      ],
      status: { type: { state: 'post' } }
    }]
  };

  const parsed = parseEvent(tennisEvent);
  assert.equal(parsed.homeTeam, 'Carlos Alcaraz');
  assert.equal(parsed.awayTeam, 'Jannik Sinner');
  assert.equal(parsed.state, 'post');
  assert.equal(parsed.homeScore, 3);
});

test('ESPN parseEvent still uses team names + homeAway for team sports', () => {
  const teamEvent = {
    id: 'n1',
    date: '2026-06-14T10:00:00Z',
    competitions: [{
      competitors: [
        { homeAway: 'home', team: { displayName: 'Storm', id: 'h1' }, score: '24' },
        { homeAway: 'away', team: { displayName: 'Broncos', id: 'a1' }, score: '12' }
      ],
      status: { type: { state: 'post' } }
    }]
  };

  const parsed = parseEvent(teamEvent);
  assert.equal(parsed.homeTeam, 'Storm');
  assert.equal(parsed.awayTeam, 'Broncos');
  assert.equal(parsed.homeScore, 24);
});

test('eventMatchesPick matches tennis in either orientation', () => {
  const event = { homeTeam: 'Carlos Alcaraz', awayTeam: 'Jannik Sinner', startTime: '2026-06-14T10:00:00Z' };
  // Pick stored the players in the opposite order to ESPN.
  const pick = {
    sport: 'tennis_atp',
    homeTeam: 'Jannik Sinner',
    awayTeam: 'Carlos Alcaraz',
    startTime: '2026-06-14T10:30:00Z'
  };
  assert.equal(eventMatchesPick(event, pick), true);
});

test('eventMatchesPick does NOT swap orientation for team sports', () => {
  const event = { homeTeam: 'Storm', awayTeam: 'Broncos', startTime: '2026-06-14T10:00:00Z' };
  const swappedPick = {
    sport: 'nrl',
    homeTeam: 'Broncos',
    awayTeam: 'Storm',
    startTime: '2026-06-14T10:00:00Z'
  };
  // Team sports keep strict orientation (a swapped match here would be a different fixture framing).
  assert.equal(eventMatchesPick(event, swappedPick), false);
});
