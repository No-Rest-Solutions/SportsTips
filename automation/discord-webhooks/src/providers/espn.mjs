const SITE_API_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB_API_BASE_URL = 'https://site.web.api.espn.com/apis/site/v2/sports';
const USER_AGENT = 'SportsTipsDiscordWebhook/1.0';
const KNOWN_VENUE_LOCATION_OVERRIDES = new Map([
  ['optus stadium', {
    city: 'Perth',
    state: 'WA',
    country: 'Australia',
    latitude: -31.95079,
    longitude: 115.807236
  }]
]);

function toScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseMadeAttempts(value) {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/u);
  return match ? Number(match[1]) : null;
}

function parseStatValue(value) {
  const madeAttempts = parseMadeAttempts(value);

  if (madeAttempts !== null) {
    return madeAttempts;
  }

  return toNumber(value);
}

function getEspnBaseUrl(sport) {
  return sport?.apiVariant === 'web' ? WEB_API_BASE_URL : SITE_API_BASE_URL;
}

function getVenueLocationOverride(venue) {
  const venueName = normalizeText(venue?.fullName || venue?.name || '');
  return KNOWN_VENUE_LOCATION_OVERRIDES.get(venueName) || null;
}

function parseLinescores(competitor) {
  return Array.isArray(competitor?.linescores)
    ? competitor.linescores.map((entry) => ({
        period: toNumber(entry?.period),
        value: toScore(entry?.value ?? entry?.displayValue),
        cumulativeValue: toScore(entry?.cumulativeDisplayValue ?? entry?.value ?? entry?.displayValue),
        displayValue: entry?.displayValue || ''
      }))
    : [];
}

function competitorName(competitor) {
  return competitor?.team?.displayName
    || competitor?.athlete?.displayName
    || competitor?.athlete?.fullName
    || competitor?.athlete?.shortName
    || '';
}

function competitorId(competitor) {
  return competitor?.team?.id || competitor?.athlete?.id || '';
}

export function parseEvent(event) {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  // Team sports tag competitors home/away; individual sports (tennis) don't, so
  // fall back to positional order and read athlete names — without this, tennis
  // events have no team names and never match a pick at settlement time.
  const home = competitors.find((item) => item.homeAway === 'home') || competitors[0];
  const away = competitors.find((item) => item.homeAway === 'away') || competitors[1];
  const name = home && away
    ? `${competitorName(away)} vs ${competitorName(home)}`
    : event.name;
  const venue = competition?.venue || {};
  const venueAddress = venue.address || {};
  const venueLocationOverride = getVenueLocationOverride(venue);

  return {
    id: event.id,
    name,
    startTime: event.date,
    homeTeamId: competitorId(home),
    homeTeam: competitorName(home),
    awayTeamId: competitorId(away),
    awayTeam: competitorName(away),
    homeScore: toScore(home?.score),
    awayScore: toScore(away?.score),
    homeLinescores: parseLinescores(home),
    awayLinescores: parseLinescores(away),
    venue: {
      id: venue.id || '',
      name: venue.fullName || venue.name || '',
      city: venueAddress.city || venueLocationOverride?.city || '',
      state: venueAddress.state || venueLocationOverride?.state || '',
      country: venueAddress.country || venueLocationOverride?.country || '',
      latitude: toNumber(venue.latitude) ?? venueLocationOverride?.latitude ?? null,
      longitude: toNumber(venue.longitude) ?? venueLocationOverride?.longitude ?? null,
      indoor: venue.indoor === true,
      roofType: venue.roofType || ''
    },
    state: competition?.status?.type?.state || event.status?.type?.state || 'pre',
    shortStatus: competition?.status?.type?.shortDetail || competition?.status?.type?.detail || event.status?.type?.detail || ''
  };
}

export async function fetchEspnSlate(sport, dateKey) {
  const dateParam = dateKey.replaceAll('-', '');
  const url = `${getEspnBaseUrl(sport)}/${sport.path}/scoreboard?dates=${dateParam}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`${sport.label} scoreboard request failed (${response.status}).`);
  }

  const data = await response.json();

  return {
    sourceUrl: url,
    events: Array.isArray(data.events) ? data.events.map(parseEvent) : []
  };
}

function normalizeStatKey(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  const lookup = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  switch (lookup) {
    case 'disposals':
      return 'disposals';
    case 'kicks':
      return 'kicks';
    case 'handballs':
      return 'handballs';
    case 'points':
      return 'points';
    case 'rebounds':
      return 'rebounds';
    case 'assists':
      return 'assists';
    case 'tries':
      return 'tries';
    case 'conversion goals':
      return 'conversionGoals';
    case 'penalty goals':
      return 'penaltyGoals';
    case 'drop goals converted':
      return 'dropGoalsConverted';
    case 'passing yards':
      return 'passingYards';
    case 'rushing yards':
      return 'rushingYards';
    case 'strikeouts':
      return 'strikeouts';
    case 'hits':
      return 'hits';
    default:
      return text;
  }
}

function createPlayerStats(playerName, teamName) {
  return {
    playerName,
    teamName,
    statValues: {},
    points: null,
    rebounds: null,
    assists: null,
    threesMade: null,
    disposals: null
  };
}

function buildPlayerStatsKey(playerName, teamName) {
  const normalizedPlayerName = normalizeText(playerName);
  const normalizedTeamName = normalizeText(teamName);

  if (!normalizedPlayerName) {
    return '';
  }

  return normalizedTeamName
    ? `${normalizedPlayerName}::${normalizedTeamName}`
    : normalizedPlayerName;
}

function finalizePlayerStats(existing) {
  const derivedPoints = [
    toNumber(existing.statValues.tries),
    toNumber(existing.statValues.conversionGoals),
    toNumber(existing.statValues.penaltyGoals),
    toNumber(existing.statValues.dropGoalsConverted)
  ].every((value) => value === null)
    ? null
    : (
        (toNumber(existing.statValues.tries) ?? 0) * 4
        + (toNumber(existing.statValues.conversionGoals) ?? 0) * 2
        + (toNumber(existing.statValues.penaltyGoals) ?? 0) * 2
        + (toNumber(existing.statValues.dropGoalsConverted) ?? 0)
      );

  existing.points = toNumber(existing.statValues.points);

  if ((existing.points === null || (existing.points === 0 && (derivedPoints ?? 0) > 0)) && derivedPoints !== null) {
    existing.points = derivedPoints;
    existing.statValues.points = derivedPoints;
  }

  existing.rebounds = toNumber(existing.statValues.rebounds);
  existing.assists = toNumber(existing.statValues.assists);
  existing.threesMade = toNumber(existing.statValues['threePointFieldGoalsMade-threePointFieldGoalsAttempted']);

  const disposals = toNumber(existing.statValues.disposals);
  const kicks = toNumber(existing.statValues.kicks);
  const handballs = toNumber(existing.statValues.handballs);
  existing.disposals = disposals ?? (kicks !== null && handballs !== null ? kicks + handballs : null);
}

export function extractEspnPlayerBoxscoreStats(summary) {
  const byPlayer = new Map();
  const teams = Array.isArray(summary?.boxscore?.players) ? summary.boxscore.players : [];

  for (const team of teams) {
    const teamName = team?.team?.displayName || team?.team?.name || '';

    for (const group of Array.isArray(team?.statistics) ? team.statistics : []) {
      const keys = Array.isArray(group?.keys)
        ? group.keys
        : (Array.isArray(group?.descriptions) ? group.descriptions.map((description) => normalizeStatKey(description)) : []);

      if (!keys.length) {
        continue;
      }

      for (const athlete of Array.isArray(group?.athletes) ? group.athletes : []) {
        const playerName = athlete?.athlete?.displayName || '';
        const normalizedName = normalizeText(playerName);
        const playerKey = buildPlayerStatsKey(playerName, teamName);

        if (!normalizedName || !playerKey) {
          continue;
        }

        const stats = Array.isArray(athlete?.stats) ? athlete.stats : [];
        const existing = byPlayer.get(playerKey) || createPlayerStats(playerName, teamName);

        for (const [index, key] of keys.entries()) {
          if (!key) {
            continue;
          }

          const statValue = parseStatValue(stats[index]);

          if (statValue !== null) {
            existing.statValues[key] = statValue;
          }
        }

        finalizePlayerStats(existing);
        byPlayer.set(playerKey, existing);
      }
    }

    for (const group of Array.isArray(team?.statistics) ? team.statistics : []) {
      for (const athlete of Array.isArray(group?.athletes) ? group.athletes : []) {
        const playerName = athlete?.athlete?.displayName || athlete?.athlete?.fullName || '';
        const normalizedName = normalizeText(playerName);
        const playerKey = buildPlayerStatsKey(playerName, teamName);

        if (!normalizedName || !playerKey) {
          continue;
        }

        const existing = byPlayer.get(playerKey) || createPlayerStats(playerName, teamName);

        for (const statGroup of Array.isArray(athlete?.statistics) ? athlete.statistics : []) {
          for (const stat of Array.isArray(statGroup?.stats) ? statGroup.stats : []) {
            const key = normalizeStatKey(stat?.type || stat?.name || stat?.displayName || '');
            const statValue = parseStatValue(stat?.value ?? stat?.displayValue);

            if (key && statValue !== null) {
              existing.statValues[key] = statValue;
            }
          }
        }

        finalizePlayerStats(existing);
        byPlayer.set(playerKey, existing);
      }
    }
  }

  return [...byPlayer.values()];
}

export async function fetchEspnSummary(sport, eventId) {
  const resolvedEventId = typeof eventId === 'object' && eventId !== null
    ? String(eventId.providerId || eventId.id || '').trim()
    : String(eventId || '').trim();
  const url = `${getEspnBaseUrl(sport)}/${sport.path}/summary?event=${resolvedEventId}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`${sport.label} summary request failed (${response.status}).`);
  }

  const data = await response.json();

  return {
    sourceUrl: url,
    playerStats: extractEspnPlayerBoxscoreStats(data),
    summary: data
  };
}