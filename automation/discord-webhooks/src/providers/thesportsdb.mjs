/**
 * TheSportsDB provider — broad, public, free results fallback across all sports.
 *
 * `eventsday.php?d=YYYY-MM-DD&s=<Sport>` returns finalized events with team names,
 * scores, status and timestamp. Used as a SETTLEMENT FALLBACK so "Other" sports
 * (tennis/NHL/non-EPL soccer) and anything ESPN misses can still be graded.
 * See docs/DATA-SOURCES.md. Fetch is injectable so parsing is unit-tested offline.
 */

const API_BASE = 'https://www.thesportsdb.com/api/v1/json/3';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SportsTips/1.0';

// Statuses TheSportsDB uses for a completed match.
const FINISHED_STATUSES = new Set(['ft', 'aet', 'aot', 'ap', 'finished', 'match finished', 'fin']);

/**
 * Map our sport keys to TheSportsDB `s=` sport names.
 * @param {string} sportKey
 * @returns {string}
 */
export function mapSportToTheSportsDb(sportKey) {
  const key = String(sportKey || '').toLowerCase();
  if (key === 'nhl') return 'Ice Hockey';
  if (key === 'nba') return 'Basketball';
  if (key === 'mlb') return 'Baseball';
  if (key === 'nfl') return 'American Football';
  if (key === 'afl') return 'Australian Football';
  if (key === 'nrl') return 'Rugby League';
  if (key.startsWith('soccer')) return 'Soccer';
  if (key.startsWith('tennis')) return 'Tennis';
  return '';
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Normalize a raw TheSportsDB event into the shared scoreboard-event shape used
 * by the results job (state 'post' when finished).
 * @param {Object} raw
 * @returns {Object|null}
 */
export function normalizeTheSportsDbEvent(raw) {
  if (!raw) {
    return null;
  }

  const homeTeam = raw.strHomeTeam || '';
  const awayTeam = raw.strAwayTeam || '';
  if (!homeTeam || !awayTeam) {
    return null;
  }

  const status = String(raw.strStatus || raw.strProgress || '').trim().toLowerCase();
  const homeScore = toNumber(raw.intHomeScore);
  const awayScore = toNumber(raw.intAwayScore);
  const finished = FINISHED_STATUSES.has(status) || (status !== 'ns' && status !== '' && homeScore !== null && awayScore !== null && /(ft|fin|finished|full)/.test(status));

  const startTime = raw.strTimestamp
    || (raw.dateEvent && raw.strTime ? `${raw.dateEvent}T${raw.strTime}` : raw.dateEvent || '');

  return {
    id: String(raw.idEvent || ''),
    name: raw.strEvent || `${awayTeam} vs ${homeTeam}`,
    startTime,
    homeTeam,
    homeTeamId: String(raw.idHomeTeam || ''),
    awayTeam,
    awayTeamId: String(raw.idAwayTeam || ''),
    homeScore,
    awayScore,
    league: raw.strLeague || '',
    state: finished ? 'post' : 'pre',
    shortStatus: raw.strStatus || ''
  };
}

/**
 * Fetch + normalize a day's events for a sport.
 * @param {Object|string} sport - config sport object or sport key
 * @param {string} dateKey - YYYY-MM-DD
 * @param {Object} [options] - { fetchImpl }
 * @returns {Promise<{ events: Array }>}
 */
export async function fetchTheSportsDbSlate(sport, dateKey, options = {}) {
  const sportKey = typeof sport === 'string' ? sport : (sport?.key || sport?.marketKey || '');
  const sportName = mapSportToTheSportsDb(sportKey);
  if (!sportName || !dateKey) {
    return { events: [] };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const url = `${API_BASE}/eventsday.php?d=${encodeURIComponent(dateKey)}&s=${encodeURIComponent(sportName)}`;

  let payload;
  try {
    const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!response.ok) {
      return { events: [] };
    }
    payload = await response.json();
  } catch {
    return { events: [] };
  }

  const events = (Array.isArray(payload?.events) ? payload.events : [])
    .map(normalizeTheSportsDbEvent)
    .filter(Boolean);

  return { events };
}

export const __testables = {
  mapSportToTheSportsDb,
  normalizeTheSportsDbEvent,
  FINISHED_STATUSES
};
