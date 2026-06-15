/**
 * Promos Candidate Builder
 *
 * Turns the live market snapshot (the same one the analysis job scrapes) into
 * promo candidate legs. Each leg carries real odds, a market-derived confidence
 * signal, and enough event identity to settle it later.
 *
 * This deliberately reuses the main pipeline's candidate pool
 * (buildAnalysisCandidatePool) so promo legs are drawn from the exact same
 * filtered, ranked market quotes the bot already trusts for picks.
 */

import { buildAnalysisCandidatePool } from './ai-pick-generator.mjs';
import { buildSnapshotEvents, getSnapshotEventQuotes } from './web-market-intake.mjs';

const PLAYER_PROP_MARKET_PREFIXES = ['player_', 'batter_', 'pitcher_'];

/**
 * Replicates the analysis job's event context just enough to drive
 * buildAnalysisCandidatePool, without pulling in its ESPN/weather enrichment.
 * @param {Object} config
 * @param {Object} sport - config.sports entry
 * @param {Object} event - snapshot event
 * @returns {Object}
 */
export function buildPromoEventContext(config, sport, event) {
  return {
    sportKey: sport.key,
    sportLabel: sport.label,
    marketSportKey: sport.marketKey || sport.key,
    eventId: event.id,
    eventName: event.displayName || `${event.away_team} vs ${event.home_team}`,
    homeTeam: event.home_team,
    awayTeam: event.away_team,
    startTime: event.commence_time,
    venue: event.venue || null,
    timezone: config.timezone,
    bookmakerFallbackProviders: Array.isArray(config.bookmakerFallback?.providers)
      ? config.bookmakerFallback.providers
      : [],
    generatorConfig: config.analysis.generator
  };
}

/**
 * Is this a player-prop market (has a player subject and a line)?
 * @param {string} market
 * @returns {boolean}
 */
export function isPlayerPropMarket(market) {
  const value = String(market || '').toLowerCase();
  return PLAYER_PROP_MARKET_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Does an analysis candidate satisfy a promo's configured market filter?
 *  - 'head2head' / 'h2h'  => match-winner legs only
 *  - 'player-props'       => player line props only
 *  - anything else        => exact market-key match (e.g. 'player_disposals')
 * @param {string} promoMarket
 * @param {Object} candidate
 * @returns {boolean}
 */
export function candidateMatchesPromoMarket(promoMarket, candidate) {
  const promoKey = String(promoMarket || '').toLowerCase();
  const market = String(candidate?.market || '').toLowerCase();

  if (promoKey === 'head2head' || promoKey === 'h2h') {
    return market === 'h2h';
  }

  if (promoKey === 'player-props' || promoKey === 'player_props' || promoKey === 'props') {
    return isPlayerPropMarket(market) && candidate?.point !== null && candidate?.point !== undefined;
  }

  // Specific market key (e.g. a promo that only wants 'player_disposals').
  return market === promoKey;
}

/**
 * Market-derived confidence (0-100) for a leg, from the best available price.
 *  - Implied probability is the spine (favourites score higher).
 *  - A small consensus bonus rewards legs seen across multiple books.
 * This replaces the placeholder form/injury research with a real market signal.
 * @param {number} odds
 * @param {number} booksChecked
 * @returns {number}
 */
export function deriveMarketConfidence(odds, booksChecked = 1) {
  const price = Number(odds);
  if (!Number.isFinite(price) || price <= 1) {
    return 0;
  }

  const impliedProbability = 1 / price;
  const base = Math.min(95, impliedProbability * 100);
  const consensusBonus = Math.min(5, Math.max(0, Number(booksChecked) || 0));

  return Math.round(Math.min(99, base + consensusBonus));
}

/**
 * Map one analysis-pool candidate into a promo leg.
 * @param {Object} candidate - from buildAnalysisCandidatePool
 * @param {Object} eventContext - from buildPromoEventContext
 * @param {string} sport - promo sport key
 * @returns {Object|null}
 */
export function mapCandidateToPromoLeg(candidate, eventContext, sport) {
  if (!candidate) {
    return null;
  }

  const odds = Number(candidate.bestPrice ?? candidate.averagePrice);
  if (!Number.isFinite(odds) || odds <= 1) {
    return null;
  }

  const isH2h = String(candidate.market || '').toLowerCase() === 'h2h';
  const player = isH2h ? '' : String(candidate.description || '').trim();
  const team = isH2h ? String(candidate.outcomeName || '').trim() : '';

  return {
    id: `${eventContext.eventId || 'event'}:${candidate.candidateId || candidate.key}`,
    sport,
    matchId: eventContext.eventId || '',
    eventName: eventContext.eventName,
    homeTeam: eventContext.homeTeam,
    awayTeam: eventContext.awayTeam,
    commenceTime: eventContext.startTime || '',
    market: candidate.market,
    family: candidate.family,
    label: candidate.label,
    player,
    team,
    selection: candidate.outcomeName || '',
    side: String(candidate.outcomeName || '').toLowerCase(),
    point: candidate.point ?? null,
    odds: Math.round(odds * 100) / 100,
    booksChecked: candidate.booksChecked || 0,
    conflictGroup: candidate.conflictGroup || '',
    confidence: deriveMarketConfidence(odds, candidate.booksChecked)
  };
}

/**
 * Build promo candidate legs from a market snapshot for the given sports.
 * @param {Object} config - daemon config
 * @param {Object} snapshot - scraped market snapshot ({ quotes, ... })
 * @param {Object} options
 * @param {string[]} options.sports - sport keys to build for (e.g. ['afl','tennis'])
 * @param {Date} [options.now]
 * @param {number} [options.maxEventsPerSport]
 * @returns {Array} flat array of promo legs across all events/sports
 */
export function buildPromoCandidatesFromSnapshot(config, snapshot, options = {}) {
  if (!snapshot?.quotes?.length || !config?.sports?.length) {
    return [];
  }

  const now = options.now || new Date();
  const wantedSports = new Set((options.sports || []).map((value) => String(value).toLowerCase()));
  const maxEventsPerSport = Number(options.maxEventsPerSport || 12);
  const legs = [];

  for (const sport of config.sports) {
    const sportKey = String(sport.key || sport.marketKey || '').toLowerCase();

    if (!sportKey || (wantedSports.size && !wantedSports.has(sportKey))) {
      continue;
    }

    const events = buildSnapshotEvents(snapshot, config, sport, now).slice(0, maxEventsPerSport);

    for (const event of events) {
      const eventContext = buildPromoEventContext(config, sport, event);
      const quotes = Array.isArray(event.snapshotQuotes) && event.snapshotQuotes.length
        ? event.snapshotQuotes
        : getSnapshotEventQuotes(snapshot, config, sport.marketKey || sport.key, event);

      if (!quotes?.length) {
        continue;
      }

      const pool = buildAnalysisCandidatePool(
        eventContext,
        quotes,
        Number(config.analysis?.maxCandidateLegsPerEvent || 14)
      );

      for (const candidate of pool) {
        const leg = mapCandidateToPromoLeg(candidate, eventContext, sportKey);
        if (leg) {
          legs.push(leg);
        }
      }
    }
  }

  return legs;
}

export const __testables = {
  isPlayerPropMarket,
  candidateMatchesPromoMarket,
  deriveMarketConfidence,
  mapCandidateToPromoLeg
};
