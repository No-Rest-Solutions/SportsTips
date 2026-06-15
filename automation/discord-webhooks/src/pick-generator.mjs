const FEATURED_MARKETS = new Set(['h2h', 'spreads', 'totals']);
export const GENERATED_SOURCE = 'auto-generator';
export const AI_GENERATED_SOURCE = 'ai-generator';
const GENERATED_SOURCES = new Set([GENERATED_SOURCE, AI_GENERATED_SOURCE]);

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function formatSignedPoint(point) {
  const numeric = toNumber(point);

  if (numeric === null) {
    return '';
  }

  return `${numeric >= 0 ? '+' : ''}${numeric}`;
}

function computeAverage(values) {
  const numeric = values.map(toNumber).filter((value) => value !== null);

  if (!numeric.length) {
    return null;
  }

  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function buildQuoteKey(quote) {
  return JSON.stringify([
    quote.market || '',
    quote.outcomeName || '',
    quote.description || '',
    quote.point ?? null
  ]);
}

function isSideMarket(market) {
  const normalized = normalizeText(market);
  return /\b(h2h|head to head|moneyline|spreads?|handicap|double chance)\b/.test(normalized);
}

function isSpreadMarket(market) {
  const normalized = normalizeText(market);
  return /\b(spreads?|handicap)\b/.test(normalized);
}

function isTotalMarket(market) {
  const normalized = normalizeText(market);
  return /\b(team totals?|totals?)\b/.test(normalized);
}

function getMarketFamily(market) {
  if (isSideMarket(market)) {
    return 'side';
  }

  if (isTotalMarket(market)) {
    return 'total';
  }

  return 'prop';
}

function isTennisSport(sportKey) {
  return String(sportKey || '').toLowerCase().startsWith('tennis');
}

function shouldPreferPlayerProps(eventContext) {
  return eventContext?.generatorConfig?.teamSportsH2hPolicy === 'fallback_only'
    && !isTennisSport(eventContext?.sportKey);
}

function isSport(eventContext, key) {
  return String(eventContext?.sportKey || '').toLowerCase() === key;
}

function getCandidateSearchText(candidate) {
  return normalizeText([
    candidate?.market,
    candidate?.label,
    candidate?.description,
    candidate?.outcomeName
  ].filter(Boolean).join(' '));
}

function getNbaPropSubtype(candidate) {
  if (candidate?.family !== 'prop') {
    return null;
  }

  const text = ` ${getCandidateSearchText(candidate)} `;

  if (/\b(pra|pa|ra|rp|points rebounds assists|points assists|rebounds assists|rebounds points)\b/.test(text)) {
    return 'combo';
  }

  if (/\bassists?\b/.test(text)) {
    return 'assist';
  }

  if (/\brebounds?\b/.test(text)) {
    return 'rebound';
  }

  if (/\b(3pt|3pts|3 point|3 points|three point|three points|threes?)\b/.test(text)) {
    return 'three';
  }

  if (/\bsteals?\b/.test(text)) {
    return 'steal';
  }

  if (/\bblocks?\b/.test(text)) {
    return 'block';
  }

  if (/\b(2pt|2pts|points?)\b/.test(text)) {
    return 'points';
  }

  return null;
}

function getMlbPropSubtype(candidate) {
  if (candidate?.family !== 'prop') {
    return null;
  }

  const text = ` ${getCandidateSearchText(candidate)} `;

  if (/\b(hits?\s*runs?\s*rbi|hits\+runs\+rbi|hits runs rbi)\b/.test(text)) {
    return 'hrr';
  }

  if (/\btotal bases?\b/.test(text)) {
    return 'total_bases';
  }

  if (/\b(rbi|rbis|runs batted in)\b/.test(text)) {
    return 'rbi';
  }

  if (/\bstrikeouts?\b/.test(text)) {
    return 'strikeout';
  }

  if (/\bhits?\b/.test(text)) {
    return 'hit';
  }

  return null;
}

function getAflPropSubtype(candidate) {
  if (candidate?.family !== 'prop') {
    return null;
  }

  const normalizedMarket = normalizeText(candidate?.market);

  if (normalizedMarket === 'player_disposals') {
    return 'disposal';
  }

  if (normalizedMarket === 'player_goals') {
    return 'goal';
  }

  const text = ` ${getCandidateSearchText(candidate)} `;

  if (/\bdisposals?\b/.test(text)) {
    return 'disposal';
  }

  if (/\bgoals?\b/.test(text)) {
    return 'goal';
  }

  return null;
}

function getAflDisposalLine(candidate) {
  if (getAflPropSubtype(candidate) !== 'disposal') {
    return null;
  }

  const text = String(candidate?.outcomeName || candidate?.label || '').trim();
  const match = text.match(/(\d+)\s*\+\s*disposals?/i);

  if (!match) {
    return null;
  }

  const line = toNumber(match[1]);
  return Number.isFinite(line) ? line : null;
}

function getAflDisposalProfileBonus(candidate) {
  const line = getAflDisposalLine(candidate);
  const bestPrice = toNumber(candidate?.bestPrice);

  if (line === null || bestPrice === null) {
    return 0;
  }

  if (line >= 30) {
    return bestPrice <= 1.75 ? 3.2 : -2.8;
  }

  if (line >= 25) {
    if (bestPrice <= 1.3) {
      return 2.2;
    }

    return bestPrice <= 2.15 ? 1.35 : -1.5;
  }

  if (line >= 20) {
    return bestPrice <= 2.05 ? 1.9 : -0.8;
  }

  if (line >= 15) {
    if (bestPrice <= 1.8) {
      return 0.85;
    }

    return bestPrice > 1.95 ? -0.5 : 0.25;
  }

  // Line 10-14: scale penalty by price — cheaper = likely starter, pricier = bench/rotation risk
  if (bestPrice <= 1.35) return -1.2;
  if (bestPrice <= 1.55) return -2.5;
  return -4.5;
}

function isTeamLikeCandidateDescription(candidate, eventContext) {
  const description = normalizeText(candidate?.description);

  if (!description) {
    return true;
  }

  if (/\b(home|away|[1-4](st|nd|rd|th)) team\b/.test(description)) {
    return true;
  }

  return new Set([
    eventContext?.homeTeam,
    eventContext?.awayTeam
  ].map((teamName) => normalizeText(teamName)).filter(Boolean)).has(description);
}

function getNrlSpreadPoint(candidate) {
  if (!isSpreadMarket(candidate?.market)) {
    return null;
  }

  const point = toNumber(candidate?.point);

  if (point !== null) {
    return point;
  }

  const text = ` ${String(candidate?.label || candidate?.outcomeName || '').trim()} `;
  const match = text.match(/([+-]\d+(?:\.\d+)?)/);

  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function getNrlPlayerPointsLine(candidate) {
  if (normalizeText(candidate?.market) !== 'player points') {
    return null;
  }

  const point = toNumber(candidate?.point);

  if (point !== null) {
    return point;
  }

  const text = ` ${String([
    candidate?.label,
    candidate?.outcomeName,
    candidate?.description
  ].filter(Boolean).join(' ')).trim()} `;
  const match = text.match(/\b(\d+(?:\.\d+)?)\s*\+\s*points?\b/i)
    || text.match(/\bover\s+(\d+(?:\.\d+)?)\b/i);

  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function isLikelyNrlKickerPointsCandidate(candidate, eventContext) {
  if (candidate?.family !== 'prop' || normalizeText(candidate?.market) !== 'player points') {
    return false;
  }

  if (isTeamLikeCandidateDescription(candidate, eventContext)) {
    return false;
  }

  const line = getNrlPlayerPointsLine(candidate);
  const bestPrice = toNumber(candidate?.bestPrice);

  // Max line capped at 6 — lines 8-10 have ~40% hit rate and consistently lose
  if (line === null || bestPrice === null || line < 4 || line > 6) {
    return false;
  }

  if (line >= 6) {
    return bestPrice <= 1.75;
  }

  return bestPrice <= 1.55;
}

function getNrlSpreadProtectionBonus(candidate) {
  const point = getNrlSpreadPoint(candidate);

  if (point === null || point <= 0) {
    return -6;
  }

  if (point >= 10) {
    return 2.4;
  }

  if (point >= 6) {
    return 1.8;
  }

  if (point >= 2) {
    return 1.15;
  }

  return 0.65;
}

function isExtremeProtectionNrlSpread(candidate) {
  if (candidate?.market !== 'spreads') {
    return false;
  }

  const point = toNumber(candidate.point);
  return point !== null && point >= 24.5;
}

function buildLegLabel(quote) {
  if (quote.market === 'h2h') {
    return `${quote.outcomeName} H2H`;
  }

  if (quote.market === 'double_chance') {
    return `${quote.outcomeName} Double Chance`.trim();
  }

  if (quote.market === 'spreads') {
    return `${quote.outcomeName} ${formatSignedPoint(quote.point)}`.trim();
  }

  if (quote.market === 'first_half_spreads') {
    return `1st Half ${quote.outcomeName} ${formatSignedPoint(quote.point)}`.trim();
  }

  if (quote.market === 'totals') {
    return `${quote.outcomeName} ${quote.point}${quote.description ? ` ${quote.description}` : ''}`.trim();
  }

  if (quote.market === 'first_half_totals') {
    return `1st Half ${quote.outcomeName} ${quote.point}${quote.description ? ` ${quote.description}` : ''}`.trim();
  }

  if (quote.description) {
    return `${quote.description} ${quote.outcomeName}${quote.point === undefined || quote.point === null ? '' : ` ${quote.point}`}`.trim();
  }

  if (quote.point !== undefined && quote.point !== null) {
    return `${quote.outcomeName} ${quote.point}`.trim();
  }

  return String(quote.outcomeName || '').trim();
}

function buildConflictGroup(quote) {
  return JSON.stringify([
    quote.market || '',
    quote.description || '',
    quote.point ?? null
  ]);
}

function buildSubjectKey(quote) {
  if (quote.market === 'h2h') {
    return 'market:h2h';
  }

  if (quote.market === 'spreads') {
    return 'market:spreads';
  }

  if (quote.market === 'totals') {
    return 'market:totals';
  }

  if (quote.description) {
    return `subject:${normalizeText(quote.description)}`;
  }

  return `market:${quote.market}`;
}

function computeCandidateScore(candidate, generatorConfig, eventContext = null) {
  let score = candidate.booksChecked * 3;
  const preferPlayerProps = shouldPreferPlayerProps(eventContext);
  const bestPrice = toNumber(candidate.bestPrice);

  if (candidate.family === 'prop') {
    score += preferPlayerProps ? 3.2 : 1.2;
  } else if (candidate.family === 'total') {
    score += 1.0;
  } else if (candidate.market === 'h2h') {
    score += preferPlayerProps ? -2.4 : 0.8;
  }

  if (candidate.source === 'snapshot' || candidate.source === 'web-scrape') {
    score += 0.6;
  }

  if (candidate.booksChecked >= Number(generatorConfig.minBooks || 1)) {
    score += 1.5;
  }

  if (bestPrice !== null) {
    if (isSport(eventContext, 'afl') && getAflPropSubtype(candidate) === 'disposal') {
      score += getAflDisposalProfileBonus(candidate);
    } else if (bestPrice >= 1.45 && bestPrice <= 1.95) {
      score += 0.6;
    } else if (bestPrice > 2.25) {
      score -= Math.min(3.4, (bestPrice - 2.25) * 1.7);
    }
  }

  if (isSport(eventContext, 'nba')) {
    const subtype = getNbaPropSubtype(candidate);

    if (subtype === 'assist' || subtype === 'rebound') {
      score += 2.2;
    } else if (subtype === 'combo') {
      score += 2.6;
    } else if (subtype === 'points') {
      score -= 0.8;
    } else if (subtype === 'three' || subtype === 'steal' || subtype === 'block') {
      score -= 2.4;
    }
  }

  if (isSport(eventContext, 'mlb')) {
    const subtype = getMlbPropSubtype(candidate);

    if (subtype === 'hit') {
      score += 3.1;
    } else if (subtype === 'strikeout') {
      score += 1.9;
    } else if (subtype === 'hrr') {
      score += 1.2;
    } else if (subtype === 'total_bases') {
      score += 0.4;
    } else if (subtype === 'rbi') {
      score -= 1.2;
    }

    if (candidate.family === 'total') {
      score -= 1.4;
    }
  }

  if (isSport(eventContext, 'afl')) {
    const subtype = getAflPropSubtype(candidate);

    if (subtype === 'disposal') {
      score += 3.4;
    } else if (subtype === 'goal') {
      score -= 1.4;
    }
  }

  if (isSport(eventContext, 'nrl')) {
    if (isSpreadMarket(candidate.market)) {
      score += getNrlSpreadProtectionBonus(candidate);

      if (candidate.market === 'spreads' && isExtremeProtectionNrlSpread(candidate)) {
        score += 0.6;
      }
    }

    if (isLikelyNrlKickerPointsCandidate(candidate, eventContext)) {
      score += 2.2;
    } else if (normalizeText(candidate.market) === 'player points') {
      score -= 4.5;
    }

    if (candidate.market === 'h2h') {
      score -= 1.1;
    }

    // Score NRL totals by line quality — replaces the flat +1.0 from the base family bonus
    if (candidate.family === 'total') {
      const totalLine = toNumber(candidate?.point);
      const totalDirection = normalizeText(candidate?.outcomeName);
      const isFirstHalf = /first.half|1st.half/.test(normalizeText(candidate?.market));

      if (isFirstHalf) {
        if (totalDirection === 'over' && totalLine !== null && totalLine >= 23) {
          score -= 8.0; // Statistically implausible — hard downrank
        } else if (totalDirection === 'under' && totalLine !== null && totalLine >= 26.5) {
          score += 1.0; // Conservative anchor bonus
        }
      }
    }
  }

  return score;
}

function rankCandidates(candidates, generatorConfig, eventContext = null) {
  return [...candidates].sort((left, right) => {
    const scoreDiff = computeCandidateScore(right, generatorConfig, eventContext) - computeCandidateScore(left, generatorConfig, eventContext);

    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    const booksDiff = right.booksChecked - left.booksChecked;

    if (booksDiff !== 0) {
      return booksDiff;
    }

    return String(left.label || '').localeCompare(String(right.label || ''));
  });
}

function buildReplacementCandidate(candidate) {
  return {
    id: `backup-${candidate.key}`,
    label: candidate.label,
    rationale: candidate.rationale,
    source: {
      type: candidate.source,
      market: candidate.market,
      booksChecked: candidate.booksChecked,
      outcomeName: candidate.outcomeName,
      description: candidate.description,
      point: candidate.point ?? null
    }
  };
}

function normalizeBookmakerKey(price) {
  return normalizeText(price.bookmakerKey || price.bookmakerTitle || 'unknown');
}

export function mergeQuoteEntries(quotes) {
  const grouped = new Map();

  for (const quote of quotes || []) {
    if (!quote) {
      continue;
    }

    const key = buildQuoteKey(quote);
    const existing = grouped.get(key);
    const mergedPrices = [...(existing?.prices || []), ...(Array.isArray(quote.prices) ? quote.prices : [])];
    const dedupedPrices = new Map();

    for (const price of mergedPrices) {
      if (!price || !Number.isFinite(Number(price.price))) {
        continue;
      }

      const bookmakerKey = normalizeBookmakerKey(price);
      const current = dedupedPrices.get(bookmakerKey);

      if (!current || Number(price.price) > Number(current.price)) {
        dedupedPrices.set(bookmakerKey, {
          bookmakerKey: price.bookmakerKey || bookmakerKey,
          bookmakerTitle: price.bookmakerTitle || price.bookmakerKey || bookmakerKey,
          price: Number(price.price)
        });
      }
    }

    grouped.set(key, {
      ...(existing || quote),
      ...quote,
      prices: [...dedupedPrices.values()],
      source: quote.source || existing?.source || 'web-scrape'
    });
  }

  return [...grouped.values()];
}

export function buildCandidateFromQuote(quote, eventContext) {
  const prices = Array.isArray(quote.prices) ? quote.prices.map((item) => toNumber(item.price)).filter((value) => value !== null) : [];

  if (!prices.length) {
    return null;
  }

  const booksChecked = prices.length;

  if (booksChecked < Number(eventContext.generatorConfig.minBooks || 1)) {
    return null;
  }

  const label = buildLegLabel(quote);

  if (!label) {
    return null;
  }

  const family = getMarketFamily(quote.market);
  const bestPrice = Math.max(...prices);
  const averagePrice = computeAverage(prices);
  const rationale = `${label} was available across ${booksChecked} book${booksChecked === 1 ? '' : 's'} in the current market scan.`;

  return {
    key: buildQuoteKey(quote),
    label,
    market: quote.market,
    family,
    outcomeName: quote.outcomeName,
    description: quote.description || '',
    point: quote.point ?? null,
    booksChecked,
    bestPrice,
    averagePrice,
    prices: Array.isArray(quote.prices) ? quote.prices.map((item) => ({ ...item })) : [],
    sourceUrl: quote.sourceUrl || '',
    source: quote.source || 'web-scrape',
    conflictGroup: buildConflictGroup(quote),
    subjectKey: buildSubjectKey(quote),
    rationale
  };
}

export function buildCandidatePoolForEvent(eventContext, quotes, maxCandidates = 14) {
  return rankCandidates(
    mergeQuoteEntries(quotes)
      .map((quote) => buildCandidateFromQuote(quote, eventContext))
      .filter(Boolean),
    eventContext.generatorConfig,
    eventContext
  )
    .slice(0, maxCandidates)
    .map((candidate, index) => ({
      ...candidate,
      candidateId: `candidate-${index + 1}`
    }));
}

export function mergeGeneratedPicks(existingFeed, generatedPicks, state) {
  const nextGeneratedById = new Map(generatedPicks.map((pick) => [pick.id, pick]));
  const merged = [];

  for (const pick of existingFeed.picks || []) {
    const isGenerated = GENERATED_SOURCES.has(String(pick.source || ''))
      || String(pick.id || '').startsWith(`${GENERATED_SOURCE}:`)
      || String(pick.id || '').startsWith(`${AI_GENERATED_SOURCE}:`);

    if (!isGenerated) {
      merged.push(pick);
      continue;
    }

    const isPosted = Boolean(state.posts?.picks?.[pick.id]);
    const isSettled = ['win', 'loss', 'return'].includes(String(pick.status || '').toLowerCase());

    if (isPosted || isSettled) {
      merged.push(pick);
      nextGeneratedById.delete(pick.id);
      continue;
    }

    const replacement = nextGeneratedById.get(pick.id);

    if (replacement) {
      merged.push({
        ...replacement,
        status: pick.status || replacement.status
      });
      nextGeneratedById.delete(pick.id);
    }
  }

  for (const pick of nextGeneratedById.values()) {
    merged.push(pick);
  }

  merged.sort((left, right) => String(left.startTime || '').localeCompare(String(right.startTime || '')));

  return {
    picks: merged
  };
}