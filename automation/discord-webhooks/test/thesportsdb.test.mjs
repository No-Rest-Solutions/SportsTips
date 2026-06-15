import test from 'node:test';
import assert from 'node:assert';
import { fetchTheSportsDbSlate, __testables } from '../src/providers/thesportsdb.mjs';

const { mapSportToTheSportsDb, normalizeTheSportsDbEvent } = __testables;

test('thesportsdb: sport key mapping', () => {
  assert.equal(mapSportToTheSportsDb('nhl'), 'Ice Hockey');
  assert.equal(mapSportToTheSportsDb('soccer_epl'), 'Soccer');
  assert.equal(mapSportToTheSportsDb('soccer_fifa_world_cup'), 'Soccer');
  assert.equal(mapSportToTheSportsDb('tennis_atp'), 'Tennis');
  assert.equal(mapSportToTheSportsDb('afl'), 'Australian Football');
  assert.equal(mapSportToTheSportsDb('nrl'), 'Rugby League');
  assert.equal(mapSportToTheSportsDb('cricket'), '');
});

test('thesportsdb: normalize finished + not-started events', async (t) => {
  await t.test('finished event becomes state post with scores', () => {
    const ev = normalizeTheSportsDbEvent({
      idEvent: '1', strEvent: 'Dunedin Thunder vs Canterbury Red Devils',
      strHomeTeam: 'Dunedin Thunder', strAwayTeam: 'Canterbury Red Devils',
      intHomeScore: '5', intAwayScore: '6', strStatus: 'FT',
      strTimestamp: '2026-06-13T06:30:00', strLeague: 'NZIHL'
    });
    assert.equal(ev.state, 'post');
    assert.equal(ev.homeTeam, 'Dunedin Thunder');
    assert.equal(ev.homeScore, 5);
    assert.equal(ev.awayScore, 6);
    assert.equal(ev.league, 'NZIHL');
  });

  await t.test('not-started event stays pre', () => {
    const ev = normalizeTheSportsDbEvent({
      idEvent: '2', strHomeTeam: 'A', strAwayTeam: 'B',
      intHomeScore: null, intAwayScore: null, strStatus: 'NS', strTimestamp: '2026-06-14T10:00:00'
    });
    assert.equal(ev.state, 'pre');
  });

  await t.test('missing teams returns null', () => {
    assert.equal(normalizeTheSportsDbEvent({ idEvent: '3', strStatus: 'FT' }), null);
  });
});

test('thesportsdb: fetchTheSportsDbSlate normalizes via injected fetch', async (t) => {
  await t.test('returns normalized finished events', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        events: [
          { idEvent: '1', strHomeTeam: 'Rangers', strAwayTeam: 'Panthers', intHomeScore: '3', intAwayScore: '2', strStatus: 'FT', strTimestamp: '2026-06-13T20:00:00' },
          { idEvent: '2', strHomeTeam: 'Kings', strAwayTeam: 'Ducks', strStatus: 'NS', strTimestamp: '2026-06-14T20:00:00' }
        ]
      })
    });
    const slate = await fetchTheSportsDbSlate('nhl', '2026-06-13', { fetchImpl });
    assert.equal(slate.events.length, 2);
    assert.equal(slate.events[0].state, 'post');
    assert.equal(slate.events[1].state, 'pre');
  });

  await t.test('non-ok response yields empty slate', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const slate = await fetchTheSportsDbSlate('nhl', '2026-06-13', { fetchImpl });
    assert.deepEqual(slate.events, []);
  });

  await t.test('unknown sport yields empty slate without fetching', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
    const slate = await fetchTheSportsDbSlate('cricket', '2026-06-13', { fetchImpl });
    assert.deepEqual(slate.events, []);
    assert.equal(called, false);
  });
});
