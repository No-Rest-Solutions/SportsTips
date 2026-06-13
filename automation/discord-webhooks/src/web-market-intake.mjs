import fs from 'node:fs/promises';
import path from 'node:path';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const DEFAULT_BOOKMAKER_KEY = 'sportsbet-web';
const DEFAULT_BOOKMAKER_TITLE = 'Sportsbet Web';
const DEFAULT_SPORTSBET_SCRAPE_BY_SPORT = {
  afl: {
    marketPageUrl: 'https://www.sportsbet.com.au/betting/australian-rules/afl',
    eventPathPrefix: '/betting/australian-rules/afl/'
  },
  nrl: {
    marketPageUrl: 'https://www.sportsbet.com.au/betting/rugby-league/nrl',
    eventPathPrefix: '/betting/rugby-league/nrl/'
  },
  mlb: {
    marketPageUrl: 'https://www.sportsbet.com.au/betting/baseball/mlb',
    eventPathPrefix: '/betting/baseball/major-league-baseball/'
  },
  nba: {
    marketPageUrl: 'https://www.sportsbet.com.au/betting/basketball-us/nba',
    eventPathPrefix: '/betting/basketball-us/nba/'
  },
  nfl: {
    marketPageUrl: 'https://www.sportsbet.com.au/betting/american-football-us/nfl',
    eventPathPrefix: '/betting/american-football-us/nfl/'
  },
  nhl: {
    marketPageUrl: 'https://www.sportsbet.com.au/betting/ice-hockey-us/nhl',
    eventPathPrefix: '/betting/ice-hockey-us/nhl/'
  },
  tennis_atp: {
    marketPageUrl: 'https://www.sportsbet.com.au/betting/tennis/atp',
    eventPathPrefix: '/betting/tennis/'
  },
  soccer_epl: {
    marketPageUrl: 'https://www.sportsbet.com.au/betting/soccer/united-kingdom/english-premier-league',
    eventPathPrefix: '/betting/soccer/united-kingdom/english-premier-league/'
  },
  soccer_uefa_champs_league: {
    marketPageUrl: 'https://www.sportsbet.com.au/betting/soccer/uefa-competitions/uefa-champions-league',
    eventPathPrefix: '/betting/soccer/uefa-competitions/uefa-champions-league/'
  }
};

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function hasExplicitTimezone(value) {
  return /(?:z|[+-]\d{2}:?\d{2}|gmt|utc)$/i.test(String(value || '').trim());
}

function parseSportsbetDateTime(value) {
  const trimmed = String(value || '').trim();

  if (!trimmed) {
    return null;
  }

  const candidate = hasExplicitTimezone(trimmed)
    ? trimmed
    : /^\d{4}-\d{2}-\d{2}t/i.test(trimmed)
      ? `${trimmed}Z`
      : `${trimmed} UTC`;
  const parsedTime = new Date(candidate).getTime();

  return Number.isFinite(parsedTime)
    ? new Date(parsedTime).toISOString()
    : null;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extractVisibleText(html) {
  return decodeHtmlEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(?:a|div|section|article|li|h\d|p|td|tr|span|button)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBalancedJsonObject(source, startBraceIndex) {
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = startBraceIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === '\\') {
        isEscaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        return source.slice(startBraceIndex, index + 1);
      }
    }
  }

  return null;
}

function parseEmbeddedJsonObject(html, key) {
  const token = `"${key}":{`;
  const tokenIndex = String(html || '').indexOf(token);

  if (tokenIndex < 0) {
    return null;
  }

  const startBraceIndex = tokenIndex + token.length - 1;
  const literal = extractBalancedJsonObject(String(html || ''), startBraceIndex);

  if (!literal) {
    return null;
  }

  try {
    return JSON.parse(literal);
  } catch {
    return null;
  }
}

function parseEmbeddedJsonObjects(html, key) {
  const source = String(html || '');
  const token = `"${key}":{`;
  const objects = [];
  let searchIndex = 0;

  while (searchIndex < source.length) {
    const tokenIndex = source.indexOf(token, searchIndex);

    if (tokenIndex < 0) {
      break;
    }

    const startBraceIndex = tokenIndex + token.length - 1;
    const literal = extractBalancedJsonObject(source, startBraceIndex);

    if (!literal) {
      break;
    }

    try {
      objects.push({
        value: JSON.parse(literal),
        tokenIndex,
        literalLength: literal.length
      });
    } catch {
      // Ignore malformed embedded objects and keep scanning.
    }

    searchIndex = startBraceIndex + literal.length;
  }

  return objects;
}

function parseEmbeddedParentJsonObject(source, tokenIndex, key) {
  const startIndex = Math.max(0, Number(tokenIndex || 0) - 1200);

  for (let index = Number(tokenIndex || 0); index >= startIndex; index -= 1) {
    if (source[index] !== '{') {
      continue;
    }

    const literal = extractBalancedJsonObject(source, index);

    if (!literal || index + literal.length <= tokenIndex) {
      continue;
    }

    try {
      const parsed = JSON.parse(literal);

      if (parsed && typeof parsed === 'object' && parsed[key] && typeof parsed[key] === 'object') {
        return parsed;
      }
    } catch {
      // Ignore malformed parent fragments and keep scanning outward.
    }
  }

  return null;
}

function normalizeSportsbetEventMatchText(value) {
  return normalizeText(value)
    .replace(/\b(vs?|at)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEmbeddedSportsbetEventMetadata(html, fallbackUrl) {
  const embeddedEvents = parseEmbeddedJsonObject(html, 'events');

  if (!embeddedEvents || typeof embeddedEvents !== 'object') {
    return null;
  }

  const displayName = buildDisplayNameFromUrl(fallbackUrl);
  const targetName = normalizeSportsbetEventMatchText(displayName);

  if (!targetName) {
    return null;
  }

  const matchedEvent = Object.values(embeddedEvents).find((entry) => {
    const startTimeMs = toNumber(entry?.startTime?.milliseconds);
    return startTimeMs !== null && normalizeSportsbetEventMatchText(entry?.name) === targetName;
  });
  const startTimeMs = toNumber(matchedEvent?.startTime?.milliseconds);

  if (startTimeMs === null) {
    return null;
  }

  return {
    displayName: decodeHtmlEntities(String(matchedEvent?.name || '').trim()) || displayName,
    startTime: new Date(startTimeMs).toISOString()
  };
}

function normalizeSportsbetUrlPath(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/u, '');
  } catch {
    return '';
  }
}

function extractCanonicalUrl(html) {
  const canonicalMatch = String(html || '').match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);

  if (canonicalMatch?.[1]) {
    return canonicalMatch[1];
  }

  const ogUrlMatch = String(html || '').match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
  return ogUrlMatch?.[1] || '';
}

function getDateKeyForTimezone(dateLike, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(dateLike))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isFresh(isoString, ttlMinutes) {
  if (!isoString) {
    return false;
  }

  const timestamp = new Date(isoString).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= ttlMinutes * 60_000;
}

function getSportScrapeSettings(sport) {
  return {
    ...(DEFAULT_SPORTSBET_SCRAPE_BY_SPORT[sport?.key] || {}),
    ...(sport?.marketScrape || {}),
    marketPageUrl: sport?.marketPageUrl || sport?.marketScrape?.marketPageUrl || DEFAULT_SPORTSBET_SCRAPE_BY_SPORT[sport?.key]?.marketPageUrl || '',
    eventPathPrefix: sport?.eventPathPrefix || sport?.marketScrape?.eventPathPrefix || DEFAULT_SPORTSBET_SCRAPE_BY_SPORT[sport?.key]?.eventPathPrefix || ''
  };
}

function toAbsoluteUrl(url) {
  if (!url) {
    return '';
  }

  return url.startsWith('http') ? url : `https://www.sportsbet.com.au${url}`;
}

function getSportsbetEventIdFromUrl(url) {
  const match = String(url || '').match(/(\d+)(?:\/?(?:[#?].*)?)$/u);

  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function isLikelySportsbetEventUrl(url) {
  if (!url) {
    return false;
  }

  try {
    const pathname = new URL(url).pathname;
    const slug = pathname.split('/').filter(Boolean).pop() || '';
    const normalized = slug.replace(/-+\d+$/u, '');

    return normalized.includes('-v-') || normalized.includes('-vs-') || normalized.includes('-at-');
  } catch {
    return false;
  }
}

function isLikelyWomensTennisEventUrl(url) {
  try {
    return /\b(ladies|women|womens|wta)\b/.test(normalizeText(new URL(url).pathname));
  } catch {
    return false;
  }
}

function shouldIncludeSportsbetEventBlock(sport, eventUrl, blockText) {
  const normalizedSportKey = normalizeText(sport?.marketKey || sport?.key);

  if (normalizedSportKey === 'tennis atp') {
    return !isLikelyWomensTennisEventUrl(eventUrl)
      && !/\b(ladies|women|womens|wta)\b/.test(normalizeText(blockText));
  }

  if (normalizedSportKey === 'tennis wta') {
    return isLikelyWomensTennisEventUrl(eventUrl)
      || /\b(ladies|women|womens|wta)\b/.test(normalizeText(blockText));
  }

  return true;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-AU,en;q=0.9'
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`market page request failed (${response.status})`);
  }

  return response.text();
}

function extractEventMetadata(html, index, fallbackUrl) {
  const embeddedEventMetadata = extractEmbeddedSportsbetEventMetadata(html, fallbackUrl);

  if (embeddedEventMetadata) {
    return embeddedEventMetadata;
  }

  const jsonLdPattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  const jsonLdObjects = [];
  let match = null;

  while ((match = jsonLdPattern.exec(String(html || '')))) {
    try {
      const parsed = JSON.parse(match[1]);

      if (Array.isArray(parsed)) {
        jsonLdObjects.push(...parsed.filter((item) => item && typeof item === 'object'));
      } else if (parsed && typeof parsed === 'object') {
        jsonLdObjects.push(parsed);
      }
    } catch {
      // Ignore malformed JSON-LD fragments and fall back to nearby string matching.
    }
  }

  const eventJsonLd = jsonLdObjects.find((entry) => {
    const types = Array.isArray(entry?.['@type']) ? entry['@type'] : [entry?.['@type']];
    const normalizedTypes = types.map((type) => normalizeText(type));

    if (normalizedTypes.includes('sportsevent')) {
      return true;
    }

    return Boolean(entry?.startDate && entry?.name && (String(entry?.url || '').includes(fallbackUrl) || String(entry?.['@id'] || '').includes(fallbackUrl)));
  }) || jsonLdObjects.find((entry) => entry?.startDate && entry?.name);

  if (eventJsonLd) {
    const startDate = String(eventJsonLd.startDate || '').trim();

    return {
      displayName: decodeHtmlEntities(String(eventJsonLd.name || '').trim()) || buildDisplayNameFromUrl(fallbackUrl),
      startTime: parseSportsbetDateTime(startDate)
    };
  }

  const firstUrlIndex = html.indexOf(fallbackUrl);
  const metadataIndex = firstUrlIndex >= 0 ? firstUrlIndex : index;
  const snippet = html.slice(Math.max(0, metadataIndex - 800), Math.min(html.length, metadataIndex + 4000));
  const name = decodeHtmlEntities(snippet.match(/"name":"([^"]+)"/)?.[1] || '');
  const startDate = snippet.match(/"startDate":"([^"]+)"/)?.[1] || null;

  return {
    displayName: name || buildDisplayNameFromUrl(fallbackUrl),
    startTime: parseSportsbetDateTime(startDate)
  };
}

function toTitleCaseSlug(value) {
  return String(value || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitDisplayName(displayName) {
  const text = String(displayName || '').trim();

  if (!text) {
    return null;
  }

  if (/\s+at\s+/i.test(text)) {
    const [awayTeam, homeTeam] = text.split(/\s+at\s+/i);
    return {
      homeTeam: homeTeam.trim(),
      awayTeam: awayTeam.trim(),
      displayName: `${awayTeam.trim()} vs ${homeTeam.trim()}`,
      teamOne: awayTeam.trim(),
      teamTwo: homeTeam.trim()
    };
  }

  if (/\s+vs\.?\s+/i.test(text)) {
    const [homeTeam, awayTeam] = text.split(/\s+vs\.?\s+/i);
    return {
      homeTeam: homeTeam.trim(),
      awayTeam: awayTeam.trim(),
      displayName: `${homeTeam.trim()} vs ${awayTeam.trim()}`,
      teamOne: homeTeam.trim(),
      teamTwo: awayTeam.trim()
    };
  }

  if (/\s+v\s+/i.test(text)) {
    const [homeTeam, awayTeam] = text.split(/\s+v\s+/i);
    return {
      homeTeam: homeTeam.trim(),
      awayTeam: awayTeam.trim(),
      displayName: `${homeTeam.trim()} vs ${awayTeam.trim()}`,
      teamOne: homeTeam.trim(),
      teamTwo: awayTeam.trim()
    };
  }

  return null;
}

function buildDisplayNameFromUrl(eventUrl) {
  const pathname = new URL(eventUrl).pathname;
  const slug = pathname.split('/').filter(Boolean).pop() || '';
  const normalized = slug.replace(/-+\d+$/u, '');

  if (normalized.includes('-at-')) {
    const [away, home] = normalized.split('-at-');
    return `${toTitleCaseSlug(away)} at ${toTitleCaseSlug(home)}`;
  }

  if (normalized.includes('-v-')) {
    const [home, away] = normalized.split('-v-');
    return `${toTitleCaseSlug(home)} vs ${toTitleCaseSlug(away)}`;
  }

  if (normalized.includes('-vs-')) {
    const [home, away] = normalized.split('-vs-');
    return `${toTitleCaseSlug(home)} vs ${toTitleCaseSlug(away)}`;
  }

  return toTitleCaseSlug(normalized);
}

function buildQuote({
  sportKey,
  teams,
  startTime,
  market,
  outcomeName,
  description = '',
  point = null,
  price,
  fetchedAt,
  sourceUrl,
  bookmakerKey,
  bookmakerTitle
}) {
  return {
    sportKey,
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
    displayName: teams.displayName,
    startTime,
    market,
    outcomeName,
    description,
    point,
    fetchedAt,
    source: 'web-scrape',
    sourceUrl,
    prices: [{
      bookmakerKey,
      bookmakerTitle,
      price
    }]
  };
}

export function parseFeaturedMarketsFromText({
  sportKey,
  displayName,
  startTime,
  text,
  sourceUrl,
  fetchedAt,
  bookmakerKey = DEFAULT_BOOKMAKER_KEY,
  bookmakerTitle = DEFAULT_BOOKMAKER_TITLE
}) {
  const teams = splitDisplayName(displayName);

  if (!teams || !startTime) {
    return [];
  }

  const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
  const quotes = [];
  const moneylineMatch = normalizedText.match(/(?:Head to Head|Match Betting|Money Line)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i);

  if (moneylineMatch) {
    quotes.push(buildQuote({
      sportKey,
      teams,
      startTime,
      market: 'h2h',
      outcomeName: teams.teamOne,
      price: Number(moneylineMatch[1]),
      fetchedAt,
      sourceUrl,
      bookmakerKey,
      bookmakerTitle
    }));
    quotes.push(buildQuote({
      sportKey,
      teams,
      startTime,
      market: 'h2h',
      outcomeName: teams.teamTwo,
      price: Number(moneylineMatch[2]),
      fetchedAt,
      sourceUrl,
      bookmakerKey,
      bookmakerTitle
    }));
  }

  const spreadMatch = normalizedText.match(/(?:Line|Handicap Betting|Run Line)\s+\(([-+]?\d+(?:\.\d+)?)\)\s+(\d+(?:\.\d+)?)\s+\(([-+]?\d+(?:\.\d+)?)\)\s+(\d+(?:\.\d+)?)/i);

  if (spreadMatch) {
    quotes.push(buildQuote({
      sportKey,
      teams,
      startTime,
      market: 'spreads',
      outcomeName: teams.teamOne,
      point: Number(spreadMatch[1]),
      price: Number(spreadMatch[2]),
      fetchedAt,
      sourceUrl,
      bookmakerKey,
      bookmakerTitle
    }));
    quotes.push(buildQuote({
      sportKey,
      teams,
      startTime,
      market: 'spreads',
      outcomeName: teams.teamTwo,
      point: Number(spreadMatch[3]),
      price: Number(spreadMatch[4]),
      fetchedAt,
      sourceUrl,
      bookmakerKey,
      bookmakerTitle
    }));
  }

  const totalMatch = normalizedText.match(/(?:Total Match Points|Total Game Points - Over\/Under|Total Points|Total Runs)\s+Over\s*\((?:O\s*)?([+-]?\d+(?:\.\d+)?)\)\s+(\d+(?:\.\d+)?)\s+Under\s*\((?:U\s*)?([+-]?\d+(?:\.\d+)?)\)\s+(\d+(?:\.\d+)?)/i);

  if (totalMatch) {
    quotes.push(buildQuote({
      sportKey,
      teams,
      startTime,
      market: 'totals',
      outcomeName: 'Over',
      point: Number(totalMatch[1]),
      price: Number(totalMatch[2]),
      fetchedAt,
      sourceUrl,
      bookmakerKey,
      bookmakerTitle
    }));
    quotes.push(buildQuote({
      sportKey,
      teams,
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      point: Number(totalMatch[3]),
      price: Number(totalMatch[4]),
      fetchedAt,
      sourceUrl,
      bookmakerKey,
      bookmakerTitle
    }));
  }

  return quotes;
}

function extractSportsbetEventBlocks(html, sport) {
  const settings = getSportScrapeSettings(sport);

  if (!settings.eventPathPrefix) {
    return [];
  }

  const eventLinkPattern = new RegExp(`href=\"((?:https://www\\.sportsbet\\.com\\.au)?${escapeRegex(settings.eventPathPrefix)}[^\"#?]+?-\\d+)\"`, 'g');
  const rawMatches = [...String(html || '').matchAll(eventLinkPattern)];
  const uniqueMatches = [];
  const seen = new Set();

  for (const match of rawMatches) {
    const eventUrl = toAbsoluteUrl(match[1]);

    if (!eventUrl || seen.has(eventUrl) || !isLikelySportsbetEventUrl(eventUrl)) {
      continue;
    }

    seen.add(eventUrl);
    uniqueMatches.push({
      eventUrl,
      index: match.index || 0
    });
  }

  return uniqueMatches.map((match, index) => {
    const nextIndex = uniqueMatches[index + 1]?.index || html.length;
    const blockText = extractVisibleText(html.slice(match.index, Math.min(nextIndex, match.index + 12_000)));

    if (!shouldIncludeSportsbetEventBlock(sport, match.eventUrl, blockText)) {
      return null;
    }

    const metadata = extractEventMetadata(html, match.index, match.eventUrl);
    return {
      eventUrl: match.eventUrl,
      blockText,
      ...metadata
    };
  }).filter(Boolean);
}

export function parseSportsbetLeagueHtml(html, sport, fetchedAt, options = {}) {
  const blocks = extractSportsbetEventBlocks(html, sport);
  const bookmakerKey = options.bookmakerKey || DEFAULT_BOOKMAKER_KEY;
  const bookmakerTitle = options.bookmakerTitle || DEFAULT_BOOKMAKER_TITLE;
  const sportKey = sport.marketKey || sport.key;
  const quotes = [];

  for (const block of blocks) {
    quotes.push(...parseFeaturedMarketsFromText({
      sportKey,
      displayName: block.displayName,
      startTime: block.startTime,
      text: block.blockText,
      sourceUrl: block.eventUrl,
      fetchedAt,
      bookmakerKey,
      bookmakerTitle
    }));
  }

  return quotes;
}

function priceFromWinPrice(winPrice) {
  const numerator = toNumber(winPrice?.num);
  const denominator = toNumber(winPrice?.den);

  if (numerator === null || denominator === null || denominator <= 0) {
    return null;
  }

  return Number((1 + (numerator / denominator)).toFixed(2));
}

function stripPrefix(text, prefix) {
  const rawText = String(text || '').trim();
  const rawPrefix = String(prefix || '').trim();

  if (!rawText || !rawPrefix) {
    return rawText;
  }

  const pattern = new RegExp(`^${escapeRegex(rawPrefix)}\\s+`, 'i');
  return rawText.replace(pattern, '').trim();
}

function normalizeSportsbetOutcomeLabel(label) {
  return String(label || '')
    .replace(/^to\s+/i, '')
    .replace(/^record\s+/i, '')
    .replace(/^hit\s+/i, '')
    .replace(/^score\s+/i, '')
    .trim();
}

function isUnsupportedSportsbetPropContext(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return false;
  }

  return /\b(quarter race|[1-4](st|nd|rd|th) quarter|[1-4](st|nd|rd|th) qtr|first quarter|second quarter|third quarter|fourth quarter|1st half|2nd half|first half|second half)\b/.test(normalized);
}

function isUnsupportedSportsbetPropLabel(text) {
  const normalized = normalizeText(text);

  if (!normalized) {
    return false;
  }

  if (isUnsupportedSportsbetPropContext(text)) {
    return true;
  }

  return /\b(head to head|same game|winning margin|margin|race to|team total|total match points|exact points?)\b/.test(normalized)
    || /\bdouble\b/.test(normalized)
    || /\b(home|away|[1-4](st|nd|rd|th)) team\b/.test(normalized);
}

function getNormalizedTeamNames(teams) {
  return new Set([
    teams?.homeTeam,
    teams?.awayTeam,
    teams?.teamOne,
    teams?.teamTwo
  ].map((teamName) => normalizeText(teamName)).filter(Boolean));
}

function buildSportsbetTeamContextAliases(teamName) {
  const trimmed = String(teamName || '').trim();
  const stripped = trimmed.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

  return [...new Set([
    normalizeText(trimmed),
    normalizeText(stripped)
  ].filter(Boolean))];
}

function hasSportsbetEventTeamContext(contextText, teams) {
  const normalizedContext = normalizeText(contextText);
  const homeAliases = buildSportsbetTeamContextAliases(teams?.homeTeam);
  const awayAliases = buildSportsbetTeamContextAliases(teams?.awayTeam);

  if (!normalizedContext || !homeAliases.length || !awayAliases.length) {
    return false;
  }

  return homeAliases.some((alias) => normalizedContext.includes(alias))
    && awayAliases.some((alias) => normalizedContext.includes(alias));
}

function hasSportsbetEventTeamTags(tags, teams) {
  const normalizedTags = new Set((Array.isArray(tags) ? tags : [tags]).map((tag) => normalizeText(tag)).filter(Boolean));
  const homeAliases = buildSportsbetTeamContextAliases(teams?.homeTeam);
  const awayAliases = buildSportsbetTeamContextAliases(teams?.awayTeam);

  if (!normalizedTags.size || !homeAliases.length || !awayAliases.length) {
    return false;
  }

  return homeAliases.some((alias) => normalizedTags.has(alias))
    && awayAliases.some((alias) => normalizedTags.has(alias));
}

function isInvalidSportsbetPropDescription(description, teams) {
  const normalized = normalizeText(description);

  if (!normalized) {
    return true;
  }

  if (getNormalizedTeamNames(teams).has(normalized)) {
    return true;
  }

  if (/\b(home|away|[1-4](st|nd|rd|th)) team\b/.test(normalized)) {
    return true;
  }

  return /^(head|draw|over|under|yes|no|race|neither)$/i.test(String(description || '').trim());
}

function isValidSportsbetPropDescriptor(descriptor, teams) {
  if (!descriptor) {
    return false;
  }

  if (isInvalidSportsbetPropDescription(descriptor.description, teams)) {
    return false;
  }

  if (isUnsupportedSportsbetPropLabel(descriptor.description) || isUnsupportedSportsbetPropLabel(descriptor.outcomeName)) {
    return false;
  }

  return !(descriptor.point === null && /^(Over|Under)$/i.test(String(descriptor.outcomeName || '').trim()));
}

function parseSportsbetOverUnderOutcome(outcomeName) {
  const trimmedOutcomeName = String(outcomeName || '').trim();
  const match = trimmedOutcomeName.match(/^(Over|Under)\s+([0-9]+(?:\.[0-9]+)?)$/i);

  if (!match) {
    return {
      outcomeName: trimmedOutcomeName,
      point: null
    };
  }

  return {
    outcomeName: `${match[1].charAt(0).toUpperCase()}${match[1].slice(1).toLowerCase()}`,
    point: Number(match[2])
  };
}

function mapSupportedPropMarketKey(label) {
  const normalized = normalizeText(label);

  if (!normalized) {
    return null;
  }

  if (isUnsupportedSportsbetPropLabel(label)) {
    return null;
  }

  if (normalized.includes('fantasy')) {
    return null;
  }

  if (normalized.includes('passing touchdown')) {
    return 'player_pass_tds';
  }

  if (normalized.includes('passing yards')) {
    return 'player_pass_yds';
  }

  if (normalized.includes('rushing yards')) {
    return 'player_rush_yds';
  }

  if (normalized.includes('receiving yards')) {
    return 'player_reception_yds';
  }

  if (normalized.includes('strikeout')) {
    return 'pitcher_strikeouts';
  }

  if (normalized.includes('total bases')) {
    return 'batter_total_bases';
  }

  if (normalized.includes('rbi') || normalized.includes('runs batted in')) {
    return 'batter_rbis';
  }

  if (normalized.includes('shots on goal') || normalized.includes('shots on target')) {
    return 'player_shots_on_goal';
  }

  if (/(^|\s)shots?(\s|$)/.test(normalized)) {
    return 'player_shots';
  }

  if (/\bdisposals?\b/.test(normalized)) {
    return 'player_disposals';
  }

  if (/\bassists?\b/.test(normalized)) {
    return 'player_assists';
  }

  if (/\brebounds?\b/.test(normalized)) {
    return 'player_rebounds';
  }

  if (/(^|\s)(3|three)\s*(point|pointer|pointers|pt|pts|threes?)(\s|$)/.test(normalized)) {
    return 'player_threes';
  }

  if (normalized.includes('points')) {
    return 'player_points';
  }

  if (/\bgoals?\b/.test(normalized)) {
    return 'player_goals';
  }

  if ((/\bhits?\b/.test(normalized) || normalized.includes('record a hit')) && !normalized.includes('home run')) {
    return 'batter_hits';
  }

  return null;
}

function buildDirectPlayerPropDescriptor(marketName) {
  const trimmedMarketName = String(marketName || '').trim();

  if (isUnsupportedSportsbetPropContext(trimmedMarketName)) {
    return null;
  }

  let match = trimmedMarketName.match(/^(.+?)\s+Points\s+Scored$/i);

  if (match) {
    const playerName = match[1].trim();

    return {
      market: 'player_points',
      description: playerName,
      formatOutcome(outcomeName) {
        const cleaned = normalizeSportsbetOutcomeLabel(stripPrefix(outcomeName, playerName) || outcomeName);

        return {
          outcomeName: cleaned,
          point: null
        };
      }
    };
  }

  match = trimmedMarketName.match(/^(.+?)\s+-\s+Alt\s+(.+)$/i);

  if (match) {
    const playerName = match[1].trim();
    const marketKey = mapSupportedPropMarketKey(match[2]);

    if (!marketKey) {
      return null;
    }

    return {
      market: marketKey,
      description: playerName,
      formatOutcome(outcomeName) {
        const cleaned = stripPrefix(outcomeName, playerName);
        const parsed = parseSportsbetOverUnderOutcome(cleaned || outcomeName);

        return {
          outcomeName: parsed.point === null
            ? (cleaned || normalizeSportsbetOutcomeLabel(match[2]))
            : parsed.outcomeName,
          point: parsed.point
        };
      }
    };
  }

  match = trimmedMarketName.match(/^(.+?)\s+-\s+(.+)$/i);

  if (match) {
    const playerName = match[1].trim();
    const statLabel = normalizeSportsbetOutcomeLabel(match[2]);
    const marketKey = mapSupportedPropMarketKey(statLabel);

    if (!marketKey) {
      return null;
    }

    return {
      market: marketKey,
      description: playerName,
      formatOutcome(outcomeName) {
        const cleaned = stripPrefix(outcomeName, playerName) || outcomeName;
        const parsed = parseSportsbetOverUnderOutcome(cleaned);
        return {
          outcomeName: parsed.outcomeName,
          point: parsed.point
        };
      }
    };
  }

  match = trimmedMarketName.match(/^(.+?)\s+To\s+(.+)$/i);

  if (!match) {
    return null;
  }

  const playerName = match[1].trim();
  const statLabel = normalizeSportsbetOutcomeLabel(match[2]);
  const marketKey = mapSupportedPropMarketKey(statLabel);

  if (!marketKey) {
    return null;
  }

  return {
    market: marketKey,
    description: playerName,
    formatOutcome() {
      return {
        outcomeName: statLabel,
        point: null
      };
    }
  };
}

function buildGroupedPlayerPropDescriptor(marketName, outcomeName) {
  const trimmedMarketName = String(marketName || '').trim();
  const trimmedOutcomeName = String(outcomeName || '').trim();

  if (isUnsupportedSportsbetPropContext(trimmedMarketName) || isUnsupportedSportsbetPropContext(trimmedOutcomeName)) {
    return null;
  }

  let match = trimmedMarketName.match(/^To\s+Record\s+(\d+\+)\s+(.+)$/i);

  if (match) {
    const statLabel = `${match[1]} ${match[2].trim()}`;
    const marketKey = mapSupportedPropMarketKey(match[2]);

    if (!marketKey) {
      return null;
    }

    return {
      market: marketKey,
      description: trimmedOutcomeName,
      outcomeName: statLabel,
      point: null
    };
  }

  match = trimmedMarketName.match(/^To\s+Score\s+(\d+\+)\s+(.+)$/i);

  if (match) {
    const statLabel = `${match[1]} ${match[2].trim()}`;
    const marketKey = mapSupportedPropMarketKey(match[2]);

    if (!marketKey) {
      return null;
    }

    return {
      market: marketKey,
      description: trimmedOutcomeName,
      outcomeName: statLabel,
      point: null
    };
  }

  match = trimmedMarketName.match(/^To\s+Record\s+A\s+(.+)$/i);

  if (match) {
    const singularStat = match[1].trim();
    const marketKey = mapSupportedPropMarketKey(singularStat);

    if (!marketKey) {
      return null;
    }

    return {
      market: marketKey,
      description: trimmedOutcomeName,
      outcomeName: `1+ ${singularStat}`,
      point: null
    };
  }

  match = trimmedMarketName.match(/^To\s+Hit\s+A\s+(.+)$/i);

  if (match) {
    const statLabel = match[1].trim();
    const marketKey = mapSupportedPropMarketKey(statLabel);

    if (!marketKey) {
      return null;
    }

    return {
      market: marketKey,
      description: trimmedOutcomeName,
      outcomeName: normalizeSportsbetOutcomeLabel(statLabel),
      point: null
    };
  }

  match = trimmedMarketName.match(/^(\d+\+)\s+(.+)$/i);

  if (!match) {
    return null;
  }

  const statLabel = match[2].trim();
  const marketKey = mapSupportedPropMarketKey(statLabel);

  if (!marketKey) {
    return null;
  }

  return {
    market: marketKey,
    description: trimmedOutcomeName,
    outcomeName: `${match[1]} ${statLabel}`,
    point: null
  };
}

function buildSportsbetPropDescriptor(marketName, outcomeName, teams) {
  const directDescriptor = buildDirectPlayerPropDescriptor(marketName);

  if (directDescriptor) {
    const formatted = directDescriptor.formatOutcome(outcomeName);

    const descriptor = {
      market: directDescriptor.market,
      description: directDescriptor.description,
      outcomeName: formatted.outcomeName,
      point: formatted.point ?? null
    };

    return isValidSportsbetPropDescriptor(descriptor, teams)
      ? descriptor
      : null;
  }

  const groupedDescriptor = buildGroupedPlayerPropDescriptor(marketName, outcomeName);

  return isValidSportsbetPropDescriptor(groupedDescriptor, teams)
    ? groupedDescriptor
    : null;
}

function buildSportsbetTargetBetDescriptor(marketName, resultName, teams) {
  const trimmedMarketName = String(marketName || '').trim();
  const trimmedResultName = String(resultName || '').trim();

  if (!trimmedMarketName || !trimmedResultName) {
    return null;
  }

  let match = trimmedMarketName.match(/^(.+?)\s+To\s+(.+)$/i);

  if (match) {
    const descriptor = buildGroupedPlayerPropDescriptor(`To ${match[2].trim()}`, match[1].trim());

    return isValidSportsbetPropDescriptor(descriptor, teams)
      ? descriptor
      : null;
  }

  match = trimmedMarketName.match(/^(.+?)\s+-\s+Alt\s+(.+)$/i);

  if (match) {
    const playerName = match[1].trim();
    const cleanedResult = stripPrefix(trimmedResultName, playerName).trim();
    const statLabel = normalizeSportsbetOutcomeLabel(match[2]);
    const syntheticOutcomeName = cleanedResult
      ? `${playerName} ${cleanedResult}${/\b[a-z]/i.test(cleanedResult) ? '' : ` ${statLabel}`}`.trim()
      : `${playerName} ${statLabel}`.trim();

    return buildSportsbetPropDescriptor(trimmedMarketName, syntheticOutcomeName, teams);
  }

  return buildSportsbetPropDescriptor(trimmedMarketName, trimmedResultName, teams);
}

function extractSportsbetTargetBetQuotes(html, options = {}) {
  const source = String(html || '');
  const targetBets = parseEmbeddedJsonObjects(source, 'targetBet');
  const quotes = [];

  for (const targetBetEntry of targetBets) {
    const parentEntry = parseEmbeddedParentJsonObject(source, Number(targetBetEntry?.tokenIndex || 0), 'targetBet');
    const contextSnippet = source.slice(
      Math.max(0, Number(targetBetEntry?.tokenIndex || 0) - 200),
      Math.min(source.length, Number(targetBetEntry?.tokenIndex || 0) + Number(targetBetEntry?.literalLength || 0) + 120)
    );

    if (!hasSportsbetEventTeamTags(parentEntry?.tags, options.teams)
      && !hasSportsbetEventTeamContext(contextSnippet, options.teams)) {
      continue;
    }

    const targetBet = parentEntry?.targetBet || targetBetEntry?.value;
    const descriptor = buildSportsbetTargetBetDescriptor(targetBet?.market, targetBet?.result, options.teams);

    if (!descriptor) {
      continue;
    }

    const price = toNumber(targetBet?.price);

    if (price === null || price <= 1) {
      continue;
    }

    quotes.push(buildQuote({
      sportKey: options.sportKey,
      teams: options.teams,
      startTime: options.startTime,
      market: descriptor.market,
      outcomeName: descriptor.outcomeName,
      description: descriptor.description,
      point: descriptor.point ?? null,
      fetchedAt: options.fetchedAt,
      sourceUrl: options.sourceUrl,
      bookmakerKey: options.bookmakerKey,
      bookmakerTitle: options.bookmakerTitle,
      price
    }));
  }

  return quotes;
}

export async function fetchSportsbetEventTargetBetQuotes(options = {}) {
  const sourceUrl = String(options?.sourceUrl || '').trim();

  if (!sourceUrl) {
    return [];
  }

  const displayName = options.displayName || options.eventName || `${options.awayTeam || ''} vs ${options.homeTeam || ''}`.trim();
  const teams = splitDisplayName(displayName) || {
    homeTeam: options.homeTeam || '',
    awayTeam: options.awayTeam || '',
    displayName,
    teamOne: options.homeTeam || '',
    teamTwo: options.awayTeam || ''
  };

  if (!teams.homeTeam || !teams.awayTeam || !options.startTime) {
    return [];
  }

  const html = await fetchHtml(sourceUrl);

  return extractSportsbetTargetBetQuotes(html, {
    sportKey: options.sportKey,
    teams,
    startTime: options.startTime,
    fetchedAt: options.fetchedAt || new Date().toISOString(),
    sourceUrl,
    bookmakerKey: options.bookmakerKey || DEFAULT_BOOKMAKER_KEY,
    bookmakerTitle: options.bookmakerTitle || DEFAULT_BOOKMAKER_TITLE
  });
}

function getPropMarketPriorityIndex(marketKey, propMarketPriority) {
  const index = Array.isArray(propMarketPriority)
    ? propMarketPriority.findIndex((item) => normalizeText(item) === normalizeText(marketKey))
    : -1;

  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function getAflDisposalMarketLine(marketName) {
  const match = String(marketName || '').match(/\b(\d+)\+\s*disposals?\b/i);

  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseHandicapNumber(value, absolute = false) {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = String(value).trim();

  if (!raw) {
    return null;
  }

  const numeric = toNumber(raw.replace(/^\+/, ''));

  if (numeric === null) {
    return null;
  }

  return absolute ? Math.abs(numeric) : numeric;
}

function getOutcomeHandicapPoint(outcome, absolute = false) {
  const pointFromDisplay = parseHandicapNumber(outcome?.handicap?.display, absolute);

  if (pointFromDisplay !== null) {
    return pointFromDisplay;
  }

  return parseHandicapNumber(outcome?.handicap?.value, absolute);
}

function buildSoccerStructuredMarketDescriptor(marketName, outcome) {
  const normalizedMarketName = normalizeText(marketName);
  const outcomeName = String(outcome?.name || '').trim();

  let match = String(marketName || '').match(/^Over\/Under\s+([0-9]+(?:\.[0-9]+)?)\s+(?:Total\s+)?(Goals|Corners|Shots)$/i);

  if (match) {
    const metric = match[2].toLowerCase();
    const parsedOutcome = parseSportsbetOverUnderOutcome(outcomeName.replace(/\s+(?:Total\s+)?(?:Goals|Corners|Shots)$/i, ''));

    if (!/^(Over|Under)$/i.test(parsedOutcome.outcomeName)) {
      return null;
    }

    return {
      market: 'totals',
      outcomeName: parsedOutcome.outcomeName,
      description: metric === 'goals' ? '' : match[2],
      point: Number(match[1])
    };
  }

  match = String(marketName || '').match(/^1st Half Over\/Under\s+([0-9]+(?:\.[0-9]+)?)\s+(?:Total\s+)?(Goals|Corners|Shots)$/i);

  if (match) {
    const metric = match[2].toLowerCase();
    const parsedOutcome = parseSportsbetOverUnderOutcome(
      outcomeName
        .replace(/^1st Half\s+/i, '')
        .replace(/\s+(?:Total\s+)?(?:Goals|Corners|Shots)$/i, '')
    );

    if (!/^(Over|Under)$/i.test(parsedOutcome.outcomeName)) {
      return null;
    }

    return {
      market: 'first_half_totals',
      outcomeName: parsedOutcome.outcomeName,
      description: metric === 'goals' ? '' : match[2],
      point: Number(match[1])
    };
  }

  if (normalizedMarketName === 'double chance') {
    if (!outcomeName) {
      return null;
    }

    return {
      market: 'double_chance',
      outcomeName,
      description: '',
      point: null
    };
  }

  if (normalizedMarketName.startsWith('alternative handicaps')) {
    if (/^handicap draw$/i.test(outcomeName)) {
      return null;
    }

    const point = getOutcomeHandicapPoint(outcome, false);

    if (point === null) {
      return null;
    }

    return {
      market: 'spreads',
      outcomeName,
      description: '',
      point
    };
  }

  if (normalizedMarketName === 'first half handicap') {
    if (/^handicap draw$/i.test(outcomeName)) {
      return null;
    }

    const point = getOutcomeHandicapPoint(outcome, false);

    if (point === null) {
      return null;
    }

    return {
      market: 'first_half_spreads',
      outcomeName,
      description: '',
      point
    };
  }

  return null;
}

function buildGenericStructuredMarketDescriptor(marketName, outcome) {
  const normalizedMarketName = normalizeText(marketName);
  const outcomeName = String(outcome?.name || '').trim();

  if (['head to head', 'match betting', 'money line'].includes(normalizedMarketName)) {
    if (!outcomeName || /^(over|under)$/i.test(outcomeName)) {
      return null;
    }

    return {
      market: 'h2h',
      outcomeName,
      description: '',
      point: null
    };
  }

  if (['handicap betting', 'line', 'run line', '2 way handicap'].includes(normalizedMarketName)) {
    const point = getOutcomeHandicapPoint(outcome, false);

    if (point === null || !outcomeName) {
      return null;
    }

    return {
      market: 'spreads',
      outcomeName,
      description: '',
      point
    };
  }

  if (['total points', 'total game points over under', 'total match points', 'total runs'].includes(normalizedMarketName)) {
    const parsedOutcome = parseSportsbetOverUnderOutcome(outcomeName);
    const point = parsedOutcome.point ?? getOutcomeHandicapPoint(outcome, true);

    if (!/^(Over|Under)$/i.test(parsedOutcome.outcomeName) || point === null) {
      return null;
    }

    return {
      market: 'totals',
      outcomeName: parsedOutcome.outcomeName,
      description: '',
      point
    };
  }

  return null;
}

function buildSportsbetStructuredMarketDescriptor(sportKey, marketName, outcome) {
  const normalizedSportKey = normalizeText(sportKey);

  if (normalizedSportKey.startsWith('soccer')) {
    return buildSoccerStructuredMarketDescriptor(marketName, outcome);
  }

  if (normalizedSportKey === 'nfl') {
    return buildGenericStructuredMarketDescriptor(marketName, outcome);
  }

  if (normalizedSportKey.startsWith('tennis')) {
    // Tennis renders prices in embedded JSON, not the league-page visible text the
    // featured-market regex scrapes, and its h2h market is labelled "Match Betting".
    // Route to the generic descriptor so tennis h2h is read from the event-page JSON.
    return buildGenericStructuredMarketDescriptor(marketName, outcome);
  }

  if (normalizedSportKey !== 'nrl') {
    return null;
  }

  const genericDescriptor = buildGenericStructuredMarketDescriptor(marketName, outcome);

  if (genericDescriptor) {
    return genericDescriptor;
  }

  const normalizedMarketName = normalizeText(marketName);

  if (normalizedMarketName === '1st half 2 way handicap') {
    const point = getOutcomeHandicapPoint(outcome, false);

    if (point === null) {
      return null;
    }

    return {
      market: 'first_half_spreads',
      outcomeName: String(outcome?.name || '').trim(),
      description: '',
      point
    };
  }

  if (normalizedMarketName === '1st half points') {
    const point = getOutcomeHandicapPoint(outcome, true);

    if (point === null) {
      return null;
    }

    return {
      market: 'first_half_totals',
      outcomeName: String(outcome?.name || '').trim(),
      description: '',
      point
    };
  }

  return null;
}

function isMatchingSportsbetMarketEvent(market, options = {}) {
  if (normalizeText(options.sportKey) !== 'mlb') {
    return true;
  }

  const requestedEventId = toNumber(options.requestedEventId);

  if (requestedEventId === null) {
    return true;
  }

  return toNumber(market?.eventId) === requestedEventId;
}

function extractSupportedStructuredMarketQuotes(markets, outcomes, options) {
  const quotes = [];

  for (const market of Object.values(markets || {})) {
    if (!market?.name || market.displayed === false || market.active === false) {
      continue;
    }

    if (!isMatchingSportsbetMarketEvent(market, options)) {
      continue;
    }

    for (const outcomeId of market.outcomeIds || []) {
      const outcome = outcomes?.[String(outcomeId)] || outcomes?.[outcomeId];

      if (!outcome || outcome.displayed === false || outcome.active === false) {
        continue;
      }

      const descriptor = buildSportsbetStructuredMarketDescriptor(options.sportKey, market.name, outcome);

      if (!descriptor) {
        continue;
      }

      const price = priceFromWinPrice(outcome.winPrice);

      if (price === null || price <= 1) {
        continue;
      }

      quotes.push(buildQuote({
        sportKey: options.sportKey,
        teams: options.teams,
        startTime: options.startTime,
        market: descriptor.market,
        outcomeName: descriptor.outcomeName,
        description: descriptor.description,
        point: descriptor.point,
        fetchedAt: options.fetchedAt,
        sourceUrl: options.sourceUrl,
        bookmakerKey: options.bookmakerKey,
        bookmakerTitle: options.bookmakerTitle,
        price
      }));
    }
  }

  return quotes;
}

function selectSportsbetPropMarkets(markets, outcomes, options = {}) {
  const marketEntries = Object.values(markets || {})
    .filter((market) => market?.displayed !== false
      && market?.active !== false
      && Array.isArray(market?.outcomeIds)
      && market.outcomeIds.length
      && isMatchingSportsbetMarketEvent(market, options))
    .map((market) => {
      const firstActiveOutcome = market.outcomeIds
        .map((outcomeId) => outcomes?.[String(outcomeId)] || outcomes?.[outcomeId])
        .find((outcome) => outcome?.displayed !== false && outcome?.active !== false);
      const descriptor = buildSportsbetPropDescriptor(market.name, firstActiveOutcome?.name || '', options.teams);

      if (!descriptor) {
        return null;
      }

      return {
        market,
        descriptor,
        priorityIndex: getPropMarketPriorityIndex(descriptor.market, options.propMarketPriority),
        sort: Number.isFinite(Number(market.sort)) ? Number(market.sort) : Number.MAX_SAFE_INTEGER
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.priorityIndex !== right.priorityIndex) {
        return left.priorityIndex - right.priorityIndex;
      }

      return left.sort - right.sort;
    });

  const selected = [];
  const selectedByMarketKey = new Map();
  const maxPropMarketsPerEvent = Number(options.maxPropMarketsPerEvent || 6);
  const maxPropMarketsPerType = Math.max(1, Number(options.maxPropMarketsPerType || 2));

  const addEntry = (entry) => {
    if (!entry || selected.length >= maxPropMarketsPerEvent) {
      return false;
    }

    const countForMarket = selectedByMarketKey.get(entry.descriptor.market) || 0;

    if (countForMarket >= maxPropMarketsPerType || selected.includes(entry)) {
      return false;
    }

    selected.push(entry);
    selectedByMarketKey.set(entry.descriptor.market, countForMarket + 1);
    return true;
  };

  if (normalizeText(options.sportKey) === 'afl') {
    const disposalEntries = marketEntries.filter((entry) => entry.descriptor.market === 'player_disposals');
    const reserveDisposals = (predicate, limit) => {
      let count = 0;

      for (const entry of disposalEntries) {
        if (count >= limit) {
          break;
        }

        if (predicate(entry) && addEntry(entry)) {
          count += 1;
        }
      }
    };

    reserveDisposals((entry) => {
      const line = getAflDisposalMarketLine(entry.market?.name);
      return line !== null && line >= 25;
    }, 2);
    reserveDisposals((entry) => getAflDisposalMarketLine(entry.market?.name) === 20, 2);
    reserveDisposals((entry) => getAflDisposalMarketLine(entry.market?.name) === 15, 2);
  }

  for (const entry of marketEntries) {
    if (selected.length >= maxPropMarketsPerEvent) {
      break;
    }

    addEntry(entry);
  }

  return selected;
}

export function parseSportsbetEventPageHtml(html, sport, fetchedAt, eventUrl, options = {}) {
  const sportKey = sport.marketKey || sport.key;
  const bookmakerKey = options.bookmakerKey || DEFAULT_BOOKMAKER_KEY;
  const bookmakerTitle = options.bookmakerTitle || DEFAULT_BOOKMAKER_TITLE;
  const requestedEventId = getSportsbetEventIdFromUrl(eventUrl);
  const canonicalPath = normalizeSportsbetUrlPath(extractCanonicalUrl(html));
  const requestedPath = normalizeSportsbetUrlPath(eventUrl);

  if (canonicalPath && requestedPath && canonicalPath !== requestedPath) {
    return [];
  }

  const eventIndex = Math.max(0, String(html || '').indexOf(eventUrl));
  const metadata = extractEventMetadata(html, eventIndex, eventUrl);
  const teams = splitDisplayName(metadata.displayName);
  const markets = parseEmbeddedJsonObject(html, 'markets');
  const outcomes = parseEmbeddedJsonObject(html, 'outcomes');

  if (!teams || !metadata.startTime || !markets || !outcomes) {
    return [];
  }

  const quotes = [];
  quotes.push(...extractSupportedStructuredMarketQuotes(markets, outcomes, {
    sportKey,
    requestedEventId,
    teams,
    startTime: metadata.startTime,
    fetchedAt,
    sourceUrl: eventUrl,
    bookmakerKey,
    bookmakerTitle
  }));
  const selectedMarkets = selectSportsbetPropMarkets(markets, outcomes, {
    ...options,
    sportKey,
    requestedEventId,
    teams
  });

  for (const selected of selectedMarkets) {
    for (const outcomeId of selected.market.outcomeIds || []) {
      const outcome = outcomes[String(outcomeId)] || outcomes[outcomeId];

      if (!outcome || outcome.displayed === false || outcome.active === false) {
        continue;
      }

      const descriptor = buildSportsbetPropDescriptor(selected.market.name, outcome.name, teams);

      if (!descriptor) {
        continue;
      }

      const price = priceFromWinPrice(outcome.winPrice);

      if (price === null || price <= 1) {
        continue;
      }

      quotes.push(buildQuote({
        sportKey,
        teams,
        startTime: metadata.startTime,
        market: descriptor.market,
        outcomeName: descriptor.outcomeName,
        description: descriptor.description,
        point: descriptor.point ?? null,
        fetchedAt,
        sourceUrl: eventUrl,
        bookmakerKey,
        bookmakerTitle,
        price
      }));
    }
  }

  if (normalizeText(sportKey) === 'mlb' && options.enableMlbTargetBetProps === true) {
    quotes.push(...extractSportsbetTargetBetQuotes(html, {
      sportKey,
      teams,
      startTime: metadata.startTime,
      fetchedAt,
      sourceUrl: eventUrl,
      bookmakerKey,
      bookmakerTitle
    }));
  }

  return quotes;
}

export async function loadSnapshotFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      updatedAt: parsed.updatedAt || null,
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : []
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        updatedAt: null,
        quotes: []
      };
    }

    throw error;
  }
}

async function saveSnapshotFile(filePath, snapshot) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

function dedupeQuotes(quotes) {
  const grouped = new Map();

  for (const quote of quotes) {
    const price = toNumber(quote?.prices?.[0]?.price);

    if (!quote || price === null || price <= 1) {
      continue;
    }

    const key = JSON.stringify([
      quote.sportKey,
      quote.displayName,
      quote.startTime,
      quote.market,
      quote.outcomeName,
      quote.description || '',
      quote.point ?? null
    ]);
    const existing = grouped.get(key);

    if (!existing || price > toNumber(existing.prices?.[0]?.price || 0)) {
      grouped.set(key, quote);
    }
  }

  return [...grouped.values()].sort((left, right) => JSON.stringify([
    left.startTime,
    left.sportKey,
    left.displayName,
    left.market,
    left.outcomeName,
    left.point ?? null
  ]).localeCompare(JSON.stringify([
    right.startTime,
    right.sportKey,
    right.displayName,
    right.market,
    right.outcomeName,
    right.point ?? null
  ])));
}

function getPropScrapeSelectionOptions(config, sport) {
  const maxPropMarketsPerEvent = Number(config.analysis?.maxPropMarketsPerEvent || 6);
  const maxPropMarketsPerType = Math.max(1, Number(config.analysis?.maxPropMarketsPerType || 2));

  if (normalizeText(sport?.key) === 'afl') {
    return {
      maxPropMarketsPerEvent: Math.max(maxPropMarketsPerEvent, 12),
      maxPropMarketsPerType: Math.max(maxPropMarketsPerType, 6)
    };
  }

  return {
    maxPropMarketsPerEvent,
    maxPropMarketsPerType
  };
}

export async function refreshScrapedSnapshot(context, options = {}) {
  const { config, state } = context;
  const fetchedAt = new Date().toISOString();
  const scrapedQuotes = [];
  const perSport = {};

  for (const sport of config.sports.filter((item) => item.enabled)) {
    const settings = getSportScrapeSettings(sport);

    if (!settings.marketPageUrl) {
      continue;
    }

    try {
      const html = await fetchHtml(settings.marketPageUrl);
      const featuredQuotes = parseSportsbetLeagueHtml(html, sport, fetchedAt, options);
      const eventBlocks = extractSportsbetEventBlocks(html, sport);
      const propQuotes = [];

      if (config.analysis?.includeProps !== false) {
        const maxEventPagesPerSport = Math.max(1, Number(config.analysis?.maxEventsPerSport || 8));
        const blocksToFetch = featuredQuotes.length
          ? eventBlocks.slice(0, maxEventPagesPerSport)
          : eventBlocks;
        const propSelectionOptions = getPropScrapeSelectionOptions(config, sport);

        for (const block of blocksToFetch) {
          try {
            const eventHtml = await fetchHtml(block.eventUrl);
            propQuotes.push(...parseSportsbetEventPageHtml(eventHtml, sport, fetchedAt, block.eventUrl, {
              ...options,
              ...propSelectionOptions,
              propMarketPriority: config.analysis?.propMarketPriority || []
            }));
          } catch (error) {
            console.log(`[market-scrape] skipped props for ${block.eventUrl}: ${error.message}`);
          }
        }
      }

      const quotes = [...featuredQuotes, ...propQuotes];

      perSport[sport.key] = {
        lastRefreshAt: fetchedAt,
        lastStatus: quotes.length ? 'ok' : 'no_quotes',
        lastQuoteCount: quotes.length,
        featuredQuoteCount: featuredQuotes.length,
        propQuoteCount: propQuotes.length,
        eventCount: eventBlocks.length,
        marketPageUrl: settings.marketPageUrl
      };

      scrapedQuotes.push(...quotes);
    } catch (error) {
      perSport[sport.key] = {
        lastRefreshAt: fetchedAt,
        lastStatus: 'error',
        lastError: String(error.message || error),
        lastQuoteCount: 0,
        marketPageUrl: settings.marketPageUrl
      };
      console.log(`[market-scrape] skipped ${sport.label}: ${error.message}`);
    }
  }

  const snapshot = {
    updatedAt: fetchedAt,
    quotes: dedupeQuotes(scrapedQuotes)
  };

  await saveSnapshotFile(config.__paths.snapshotFile, snapshot);
  state.providers ??= {};
  state.providers.marketScrape = {
    lastRefreshAt: fetchedAt,
    lastStatus: snapshot.quotes.length ? 'ok' : 'no_quotes',
    lastQuoteCount: snapshot.quotes.length,
    sports: perSport
  };

  return snapshot;
}

export async function ensureFreshScrapedSnapshot(context, now = new Date(), options = {}) {
  const { config } = context;
  const snapshot = await loadSnapshotFile(config.__paths.snapshotFile);

  if (!config.marketScrape?.enabled) {
    return snapshot;
  }

  const refreshIntervalMinutes = Number(config.marketScrape.refreshIntervalMinutes || 60);
  const isSnapshotFresh = snapshot.quotes.length > 0 && isFresh(snapshot.updatedAt, refreshIntervalMinutes);

  if (!options.force && isSnapshotFresh) {
    return snapshot;
  }

  return refreshScrapedSnapshot(context, options);
}

export function getSnapshotQuoteStartTime(quote) {
  return quote.startTime || quote.commence_time || quote.commenceTime || quote.start_time || quote.eventStartTime || null;
}

export function getSnapshotEventQuotes(snapshot, config, sportKey, event) {
  if (!snapshot?.quotes?.length) {
    return [];
  }

  const maxAgeMinutes = Number(config.marketScrape?.maxSnapshotAgeMinutes || config.bookmakerFallback?.maxSnapshotAgeMinutes || 180);
  const fallbackFetchedAt = snapshot.updatedAt || null;

  return snapshot.quotes.filter((quote) => {
    if (normalizeText(quote.sportKey) !== normalizeText(sportKey)) {
      return false;
    }

    if (!isFresh(quote.fetchedAt || fallbackFetchedAt, maxAgeMinutes)) {
      return false;
    }

    const quoteStartTime = getSnapshotQuoteStartTime(quote);

    if (quoteStartTime && event?.commence_time && new Date(quoteStartTime).toISOString() !== new Date(event.commence_time).toISOString()) {
      return false;
    }

    const quoteDisplayName = quote.displayName || `${quote.homeTeam} vs ${quote.awayTeam}`;
    const eventDisplayName = event?.displayName || `${event?.home_team || ''} vs ${event?.away_team || ''}`;

    return normalizeText(quoteDisplayName) === normalizeText(eventDisplayName);
  });
}

export function buildSnapshotEvents(snapshot, config, sport, now) {
  if (!snapshot?.quotes?.length) {
    return [];
  }

  const maxAgeMinutes = Number(config.marketScrape?.maxSnapshotAgeMinutes || config.bookmakerFallback?.maxSnapshotAgeMinutes || 180);
  const fallbackFetchedAt = snapshot.updatedAt || null;
  const cutoffMs = now.getTime() + Number(config.analysis.lookaheadHours || 36) * 60 * 60 * 1000;
  const grouped = new Map();
  const sportKey = sport.marketKey || sport.key;

  for (const quote of snapshot.quotes) {
    const startTime = getSnapshotQuoteStartTime(quote);
    const startTimeMs = startTime ? new Date(startTime).getTime() : Number.NaN;

    if (normalizeText(quote.sportKey) !== normalizeText(sportKey) || !isFresh(quote.fetchedAt || fallbackFetchedAt, maxAgeMinutes)) {
      continue;
    }

    if (!Number.isFinite(startTimeMs) || startTimeMs < now.getTime() || startTimeMs > cutoffMs) {
      continue;
    }

    const displayName = String(quote.displayName || `${quote.homeTeam} vs ${quote.awayTeam}`).trim();
    const key = JSON.stringify([normalizeText(displayName), new Date(startTimeMs).toISOString()]);
    const existing = grouped.get(key);

    if (existing) {
      existing.snapshotQuotes.push(quote);
      continue;
    }

    grouped.set(key, {
      id: `snapshot:${sport.key}:${normalizeText(displayName)}:${new Date(startTimeMs).toISOString()}`,
      home_team: quote.homeTeam || '',
      away_team: quote.awayTeam || '',
      displayName,
      commence_time: new Date(startTimeMs).toISOString(),
      snapshotQuotes: [quote]
    });
  }

  return [...grouped.values()]
    .sort((left, right) => String(left.commence_time || '').localeCompare(String(right.commence_time || '')));
}

export function buildSnapshotSlateEvents(snapshot, config, sport, dateKey) {
  if (!snapshot?.quotes?.length) {
    return [];
  }

  const maxAgeMinutes = Number(config.marketScrape?.maxSnapshotAgeMinutes || config.bookmakerFallback?.maxSnapshotAgeMinutes || 180);
  const fallbackFetchedAt = snapshot.updatedAt || null;
  const grouped = new Map();
  const sportKey = sport.marketKey || sport.key;

  for (const quote of snapshot.quotes) {
    const startTime = getSnapshotQuoteStartTime(quote);

    if (normalizeText(quote.sportKey) !== normalizeText(sportKey) || !startTime || !isFresh(quote.fetchedAt || fallbackFetchedAt, maxAgeMinutes)) {
      continue;
    }

    if (dateKey && getDateKeyForTimezone(startTime, config.timezone) !== dateKey) {
      continue;
    }

    const displayName = String(quote.displayName || `${quote.homeTeam} vs ${quote.awayTeam}`).trim();
    const startIso = new Date(startTime).toISOString();
    const key = JSON.stringify([normalizeText(displayName), startIso]);
    const existing = grouped.get(key);

    if (existing) {
      existing.quoteCount += 1;
      continue;
    }

    grouped.set(key, {
      id: `snapshot:${sport.key}:${normalizeText(displayName)}:${startIso}`,
      name: displayName,
      startTime: startIso,
      state: 'pre',
      shortStatus: 'Scraped market slate',
      quoteCount: 1
    });
  }

  return [...grouped.values()]
    .sort((left, right) => String(left.startTime || '').localeCompare(String(right.startTime || '')))
    .map(({ quoteCount, ...event }) => ({
      ...event,
      shortStatus: `${event.shortStatus} | ${quoteCount} market${quoteCount === 1 ? '' : 's'}`
    }));
}