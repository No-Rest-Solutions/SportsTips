// Team same-game-multi (SGM) builder.
//
// Implements the user's proven structure: HEAD-TO-HEAD (favourite) + a near-certain
// "max line" (favourite + big handicap) + TOTAL over/under, as one same-game multi.
//
// Why this works and how it is priced (robust model, no live SGM API):
//   * The safe "max line" is a handicap the favourite covers in essentially every
//     scenario where it also wins the h2h, so in an SGM it adds almost no extra RISK
//     beyond the h2h leg — the user calls it "acts as a 2-leg". It does add a small
//     price multiplier (~1.05-1.15), which is what makes the treble clear ~2x while
//     staying high-probability.
//   * Because the anchor line is near-certain (~1.05-1.15), the plain leg-product
//     (h2h x line x total) lands very close to what Sportsbet's SGM builder actually
//     prices the slip at — the naive product only badly overshoots when you multiply
//     two ~1.9 legs (h2h + the MAIN line). So the existing product-based slip pricing
//     is a sound estimate here. The exact price is confirmed in Sportsbet's builder.
//   * Game margin is modelled as Normal(mu, sigma): mu comes from the scraped main
//     line (the handicap set at ~even money is the expected margin), sigma is a
//     per-sport constant. From that we can price ANY alternate handicap analytically,
//     so the safe line is chosen to be the largest cushion that still keeps the slip
//     at/above the 2x floor.

import { GENERATED_SOURCE } from './pick-generator.mjs';

// Typical full-game winning-margin standard deviations (points / goals).
const MARGIN_SIGMA_BY_SPORT = {
  afl: 36,
  nrl: 13.5,
  nba: 13,
  nfl: 13.8,
  nhl: 2.2
};
const DEFAULT_MARGIN_SIGMA = 14;

// Largest realistic alternate handicap Sportsbet's "Pick Your Own Line" actually offers,
// so the synthesized safe line is placeable (a +53.5 AFL line would exceed the menu).
const MAX_SAFE_LINE_BY_SPORT = {
  afl: 55.5,
  nrl: 32.5,
  nba: 26.5,
  nfl: 22.5,
  nhl: 3.5
};
const DEFAULT_MAX_SAFE_LINE = 24.5;

const SGM_MIN_TOTAL_ODDS = 2.0;
// A genuine favourite only. Above this the h2h is essentially a coin-flip and the
// structure loses its edge, so we decline rather than force it (props become the fallback).
const FAVOURITE_MAX_H2H = 1.80;
// Keep the anchor line genuinely safe (cover probability band) while still letting it
// carry enough price to reach the 2x floor.
const ANCHOR_MIN_COVER = 0.80;
const ANCHOR_MAX_COVER = 0.93;
// ~4% margin baked into the modelled anchor price (you are paid slightly under fair).
const ANCHOR_FAIR_HAIRCUT = 0.96;
const ANCHOR_MIN_PRICE = 1.04;

const SGM_MAX_TOTAL_ODDS = 5.0;
// Filler props must still clear the normal per-leg value floor (the anchor line is the
// only sub-1.15 leg, and it's the deliberate near-certain pad).
const PROP_MIN_LEG_PRICE = 1.15;
// Total legs allowed per slip per sport.
const SGM_MAX_LEGS_BY_SPORT = { nrl: 3 };
const DEFAULT_SGM_MAX_LEGS = 5;
// Evidence-supported props clear their line more often than the price implies; credit a
// modest edge over implied probability so a supported prop is ranked as the genuinely
// safer leg it is (used for SAFETY ranking only — never changes the posted odds).
const SUPPORTED_PROP_EDGE = 0.10;
const SUPPORTED_PROP_MAX_WINPROB = 0.92;

// Typical full-game TOTAL-points standard deviations, used to model near-certain "safe"
// alternate totals (Over a low number / Under a high number) instead of the coin-flip
// main total. The main over/under is variance/weather-driven, so we treat it as RISKY:
// its win probability is penalised for SAFETY ranking, making it a last resort behind a
// safe alternate total, a line, or supported props.
const TOTAL_SIGMA_BY_SPORT = {
  afl: 28,
  nrl: 9,
  nba: 18,
  nfl: 10,
  nhl: 2
};
const DEFAULT_TOTAL_SIGMA = 12;
// The bookmaker offers a WIDE range of alternate lines/totals (e.g. NRL lines to +20/+30,
// totals from Over ~30 up to Under ~65/70) and the point is chosen by team averages. We model
// that range at several safety levels — a moderate ~1.33 stacking leg up to a near-certain
// ~1.04 pad — anchored on the main line/total (which already reflects the teams' expected
// margin/scoring). The optimiser then picks the point that lands the safest 2x slip.
const ALT_COVER_TARGETS = [0.68, 0.80, 0.92];
// A near-certain line at/above this cover is a "pad" (the user's "max line" that acts as a
// 2-leg): it sits in its OWN group so it can pad an h2h, while still never stacking with
// another live favourite leg.
const PAD_COVER_THRESHOLD = 0.90;

const TEAM_SGM_SPORTS = new Set(['afl', 'nrl', 'nba', 'nhl', 'nfl']);

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundTo(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation.
function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Inverse standard normal CDF (Acklam's rational approximation). Used only to recover an
// expected margin from the h2h price when no main line is available.
function invNormal(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export function isTeamSgmSport(sportKey) {
  return TEAM_SGM_SPORTS.has(normalizeText(sportKey).replace(/\s+/g, '_').split('_')[0]);
}

export function getMarginSigma(sportKey) {
  const key = normalizeText(sportKey).split(' ')[0];
  return MARGIN_SIGMA_BY_SPORT[key] || DEFAULT_MARGIN_SIGMA;
}

function bestQuotePrice(quote) {
  const prices = Array.isArray(quote?.prices) ? quote.prices.map((p) => toNumber(p?.price)).filter((p) => p !== null && p > 1) : [];
  return prices.length ? Math.max(...prices) : null;
}

function isFullGameMarket(quote) {
  // Exclude first-half / quarter variants — full-game markets only.
  return !/\b(1st|first|2nd|second|3rd|third|4th|fourth|half|quarter|qtr)\b/.test(normalizeText(quote?.market || ''))
    && !/\b(1st|first|2nd|second|3rd|third|4th|fourth|half|quarter|qtr)\b/.test(normalizeText(quote?.outcomeName || ''));
}

// Pull the h2h / main-line / total picture out of an event's scraped quotes.
export function extractTeamMarkets(eventContext, quotes) {
  const homeTeam = eventContext?.homeTeam || '';
  const awayTeam = eventContext?.awayTeam || '';
  const h2h = [];
  const spreads = [];
  const totals = [];

  for (const quote of Array.isArray(quotes) ? quotes : []) {
    if (!isFullGameMarket(quote)) {
      continue;
    }
    const market = normalizeText(quote?.market);
    const price = bestQuotePrice(quote);
    if (price === null) {
      continue;
    }
    if (market === 'h2h') {
      h2h.push({ outcomeName: quote.outcomeName, price });
    } else if (market === 'spreads') {
      const point = toNumber(quote?.point);
      if (point !== null) {
        spreads.push({ outcomeName: quote.outcomeName, point, price });
      }
    } else if (market === 'totals') {
      const point = toNumber(quote?.point);
      const side = normalizeText(quote?.outcomeName);
      if (point !== null && (side === 'over' || side === 'under')) {
        totals.push({ side: side === 'over' ? 'Over' : 'Under', point, price });
      }
    }
  }

  return { homeTeam, awayTeam, h2h, spreads, totals };
}

function matchTeam(outcomeName, team) {
  const a = normalizeText(outcomeName);
  const b = normalizeText(team);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

// Modelled price for the favourite getting +L points: covers when margin > -L.
function anchorPriceForCover(coverProb) {
  return Math.max(ANCHOR_MIN_PRICE, roundTo((1 / coverProb) * ANCHOR_FAIR_HAIRCUT, 2));
}

function coverProbForLine(mu, sigma, line) {
  return normalCdf((mu + line) / sigma);
}

// Round a raw handicap up onto the X.5 grid (avoids pushes, errs slightly safer).
function toHalfPointLine(rawLine) {
  const floored = Math.max(0, rawLine);
  return Math.ceil(floored - 0.5 + 1e-9) + 0.5;
}

function maxLegsForSport(sportKey) {
  return SGM_MAX_LEGS_BY_SPORT[normalizeText(sportKey).split(' ')[0]] || DEFAULT_SGM_MAX_LEGS;
}

function combinations(items, size) {
  if (size <= 0) return [[]];
  if (size > items.length) return [];
  const result = [];
  const recurse = (start, picked) => {
    if (picked.length === size) {
      result.push(picked.slice());
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      picked.push(items[i]);
      recurse(i + 1, picked);
      picked.pop();
    }
  };
  recurse(0, []);
  return result;
}

const approxEq = (left, right) => Math.abs(left - right) < 1e-9;

// The SAFEST 2x slip. Among every leg combination that takes AT MOST ONE leg per
// correlation group — so we never multiply two correlated legs (e.g. favourite h2h AND the
// favourite's main line), which would fake a 2x the real same-game price pays UNDER — keep
// the combinations whose product sits in [minOdds, maxOdds] and choose the one with the
// highest combined win probability. Tiebreak: more TAB-placeable legs (the user prefers the
// main TAB markets), then fewer legs, then lower summed odds.
// options.requireKind: only consider combos containing at least one leg of that kind (used to
// make analytics-backed PROPS the thesis of the slip, with modelled legs as fillers).
function chooseSafestSlip(legPool, minOdds, maxOdds, maxLegs, minLegs = 2, options = {}) {
  let best = null;
  const maxK = Math.min(maxLegs, legPool.length);
  const requireKind = options.requireKind || null;

  for (let k = minLegs; k <= maxK; k += 1) {
    for (const combo of combinations(legPool, k)) {
      const groups = new Set(combo.map((leg) => leg.group));
      if (groups.size !== combo.length) {
        continue; // two legs share a correlation group — skip
      }

      // PLACEABILITY: you cannot stack two legs from the same TEAM market in one same-game
      // multi — e.g. two favourite LINES (you pick one point) or two totals. (Player props
      // are per-player, so two props from the same market but different players are fine.)
      const teamMarketKeys = combo.filter((leg) => leg.kind !== 'prop').map((leg) => leg.market);
      if (new Set(teamMarketKeys).size !== teamMarketKeys.length) {
        continue;
      }

      if (requireKind && !combo.some((leg) => leg.kind === requireKind)) {
        continue; // this combo lacks the required leg kind (e.g. a stats-backed prop)
      }

      const slipOdds = roundTo(combo.reduce((acc, leg) => acc * leg.odds, 1), 2);
      if (slipOdds < minOdds - 1e-9 || slipOdds > maxOdds + 1e-9) {
        continue;
      }

      const safety = combo.reduce((acc, leg) => acc * leg.winProb, 1);
      const onTabCount = combo.filter((leg) => leg.onTab).length;
      const sumOdds = combo.reduce((acc, leg) => acc + leg.odds, 0);
      // ANALYTICS LEAD: the bet's substance is the evidence-backed legs (props), so the
      // modelled max-line/safe-total are only fillers to reach 2x. Prefer the slip with the
      // FEWEST modelled legs (i.e. the most stats-backed substance), then highest safety.
      const modelLegs = combo.filter((leg) => leg.source === 'model').length;
      const candidate = { combo, slipOdds, safety, legs: k, onTabCount, sumOdds, modelLegs };

      const better = !best
        || candidate.modelLegs < best.modelLegs
        || (candidate.modelLegs === best.modelLegs && candidate.safety > best.safety + 1e-9)
        || (candidate.modelLegs === best.modelLegs && approxEq(candidate.safety, best.safety) && candidate.onTabCount > best.onTabCount)
        || (candidate.modelLegs === best.modelLegs && approxEq(candidate.safety, best.safety) && candidate.onTabCount === best.onTabCount && candidate.legs < best.legs)
        || (candidate.modelLegs === best.modelLegs && approxEq(candidate.safety, best.safety) && candidate.onTabCount === best.onTabCount && candidate.legs === best.legs && candidate.sumOdds < best.sumOdds);

      if (better) {
        best = candidate;
      }
    }
  }

  return best ? best.combo : null;
}

/**
 * Build the team SGM structure from scraped quotes. Returns a plain description of the
 * three legs + the modelled slip odds, or null when the markets/structure are missing.
 *
 * options.totalLean: 'over' | 'under' | null — preferred total side (e.g. evidence-led).
 */
export function buildTeamSgm(eventContext, quotes, options = {}) {
  const sportKey = eventContext?.sportKey;
  const markets = extractTeamMarkets(eventContext, quotes);

  // Need both h2h prices to identify a favourite to anchor the slip. The total is optional
  // now (supported props can carry the slip), and chooseSafestSlip declines if nothing reaches 2x.
  if (markets.h2h.length < 2) {
    return null;
  }

  // Favourite = shortest-priced h2h side, and it must be a genuine favourite.
  const sortedH2h = [...markets.h2h].sort((left, right) => left.price - right.price);
  const favourite = sortedH2h[0];
  const underdog = sortedH2h[1];
  if (!favourite || favourite.price > FAVOURITE_MAX_H2H) {
    return null;
  }

  const favouriteTeam = matchTeam(favourite.outcomeName, markets.homeTeam)
    ? markets.homeTeam
    : matchTeam(favourite.outcomeName, markets.awayTeam)
      ? markets.awayTeam
      : favourite.outcomeName;

  // Expected favourite winning margin (mu): from the favourite's main line if present
  // (the handicap set at ~even money is the expected margin), else inferred from h2h.
  const sigma = getMarginSigma(sportKey);
  const favSpread = markets.spreads.find((s) => matchTeam(s.outcomeName, favouriteTeam));
  let mu;
  if (favSpread && favSpread.point < 0) {
    mu = Math.abs(favSpread.point);
  } else if (favSpread && favSpread.point > 0) {
    // Favourite is getting points on the main line (pick'em-ish) — small expected margin.
    mu = -favSpread.point;
  } else {
    const favImplied = 1 / favourite.price;
    const dogImplied = underdog ? 1 / underdog.price : 1 - favImplied;
    const pWin = clamp(favImplied / (favImplied + dogImplied), 0.5, 0.95);
    mu = sigma * invNormal(pWin);
  }

  // Build the full candidate-leg pool, each tagged with a correlation GROUP (at most one
  // leg per group survives into a slip), a win probability (for SAFETY ranking), and
  // whether it is a standard TAB-placeable market (the user prefers the main TAB markets).
  const legPool = [];

  // Favourite-cover legs (h2h + modelled positive head-start lines) all share ONE group
  // ('fav-cover') because they are the same wager on the favourite — a slip never takes more
  // than one of them (so e.g. an h2h and a line are never both in, which would mean both legs
  // miss together if the favourite loses). We do NOT add the scraped "main line" (a favourite
  // -X handicap): it is a negative line (the user never backs those) and a coin-flip.
  legPool.push({
    kind: 'h2h', group: 'fav-cover', market: 'h2h', outcomeName: favouriteTeam, point: null,
    odds: roundTo(favourite.price, 2), winProb: 1 / favourite.price, onTab: true, source: 'web-scrape'
  });

  // Modelled alternate FAVOURITE LINES (head start +L) across a range of safety levels — a
  // moderate ~1.33 stacking line up to a near-certain ~1.04 pad. All sit in the 'fav-cover'
  // group (correlated with h2h/main line → at most one is ever picked). NOT TAB markets.
  const maxSafeLine = MAX_SAFE_LINE_BY_SPORT[normalizeText(sportKey).split(' ')[0]] || DEFAULT_MAX_SAFE_LINE;
  const seenLinePoints = new Set();
  for (const cover of ALT_COVER_TARGETS) {
    const point = Math.min(toHalfPointLine(sigma * invNormal(cover) - mu), maxSafeLine);
    if (point <= 0 || seenLinePoints.has(point)) {
      continue; // extreme favourite already covers at 0, or this point duplicates a higher tier
    }
    seenLinePoints.add(point);
    const actualCover = clamp(coverProbForLine(mu, sigma, point), 0.5, 0.999);
    // A near-certain line is a 'fav-pad' (can pad the h2h — the user's "max line"); a more
    // moderate line is 'fav-cover' (a primary favourite backing, mutually exclusive with h2h).
    const group = actualCover >= PAD_COVER_THRESHOLD ? 'fav-pad' : 'fav-cover';
    legPool.push({
      kind: 'maxline', group, market: 'spreads', outcomeName: favouriteTeam, point,
      odds: anchorPriceForCover(actualCover), winProb: actualCover, coverProbability: roundTo(actualCover, 4),
      onTab: false, source: 'model'
    });
  }

  // We do NOT add the coin-flip MAIN over/under as a leg — it is variance/weather driven and
  // too risky (the user: "totals are risky… that's how you lose money"). We only read its
  // point to anchor the modelled SAFE totals below. A game with no stats-backed safe path to
  // 2x simply produces no slip.
  const lean = normalizeText(options.totalLean);
  let totalSide = null;
  if (lean === 'over' || lean === 'under') {
    totalSide = markets.totals.find((t) => normalizeText(t.side) === lean) || null;
  }
  if (!totalSide && markets.totals.length) {
    totalSide = [...markets.totals].sort((left, right) => right.price - left.price)[0];
  }

  // Modelled alternate SAFE TOTALS (Over a low number / Under a high number) across the same
  // range of safety levels, anchored on the main total. An evidence lean fixes the side.
  const mainTotalPoint = toNumber(totalSide?.point);
  if (mainTotalPoint !== null) {
    const sigmaTotal = TOTAL_SIGMA_BY_SPORT[normalizeText(sportKey).split(' ')[0]] || DEFAULT_TOTAL_SIGMA;
    const seenTotals = new Set();
    for (const cover of ALT_COVER_TARGETS) {
      const cushion = sigmaTotal * invNormal(cover);
      const price = anchorPriceForCover(cover);
      const overPoint = Math.round((mainTotalPoint - cushion) * 2) / 2;
      const underPoint = Math.round((mainTotalPoint + cushion) * 2) / 2;
      if (overPoint > 0 && lean !== 'under' && !seenTotals.has(`O${overPoint}`)) {
        seenTotals.add(`O${overPoint}`);
        legPool.push({
          kind: 'safetotal', group: 'total', market: 'totals', outcomeName: 'Over', point: overPoint,
          odds: price, winProb: cover, coverProbability: cover, onTab: false, source: 'model'
        });
      }
      if (lean !== 'over' && !seenTotals.has(`U${underPoint}`)) {
        seenTotals.add(`U${underPoint}`);
        legPool.push({
          kind: 'safetotal', group: 'total', market: 'totals', outcomeName: 'Under', point: underPoint,
          odds: price, winProb: cover, coverProbability: cover, onTab: false, source: 'model'
        });
      }
    }
  }

  // Evidence-supported player props — genuinely safe legs (credited an edge over implied),
  // each its own group ('prop-<player>', so two props from the SAME player never combine).
  for (const candidate of (Array.isArray(options.supportedFillers) ? options.supportedFillers : [])) {
    const odds = toNumber(candidate?.bestPrice);
    if (odds === null || odds < PROP_MIN_LEG_PRICE) {
      continue;
    }
    const subject = normalizeText(candidate?.description) || candidate?.candidateId || `${legPool.length}`;
    // STATS-DRIVEN safety: rank the prop on its ACTUAL recent hit-rate (past performance vs the
    // line), not its price. Only fall back to a price proxy when the analytics are missing.
    const hitRate = toNumber(candidate?.evidenceHitRate);
    const winProb = hitRate !== null
      ? clamp(hitRate, 0.5, SUPPORTED_PROP_MAX_WINPROB)
      : Math.min(SUPPORTED_PROP_MAX_WINPROB, (1 / odds) + SUPPORTED_PROP_EDGE);
    legPool.push({
      kind: 'prop', group: `prop-${subject}`, candidate, market: candidate.market,
      outcomeName: candidate.outcomeName, point: candidate.point ?? null, odds: roundTo(odds, 2),
      winProb, hitRate, onTab: candidate.onTab !== false, source: candidate.source || 'web-scrape'
    });
  }

  // STATS LEAD, model fills the gap. chooseSafestSlip prefers the FEWEST modelled legs (the
  // most analytics-backed substance), so supported props anchor the slip whenever they exist
  // and the modelled max-line/safe-total only top it up to 2x. With no props it naturally
  // falls back to the pure modelled structure (h2h + max line + safe total).
  const legs = chooseSafestSlip(legPool, SGM_MIN_TOTAL_ODDS, SGM_MAX_TOTAL_ODDS, maxLegsForSport(sportKey));
  if (!legs || legs.length < 2) {
    return null;
  }

  const modeledOdds = roundTo(legs.reduce((acc, leg) => acc * leg.odds, 1), 2);
  if (modeledOdds < SGM_MIN_TOTAL_ODDS - 1e-9) {
    return null;
  }

  return {
    sportKey,
    favouriteTeam,
    underdogTeam: favouriteTeam === markets.homeTeam ? markets.awayTeam : markets.homeTeam,
    sigma,
    expectedMargin: roundTo(mu, 1),
    legs,
    modeledOdds
  };
}

let sgmCandidateCounter = 0;

function buildSgmCandidate({ market, family, outcomeName, description, point, price, source, evidenceReason, sgmRole }) {
  sgmCandidateCounter += 1;
  const label = market === 'h2h'
    ? `${outcomeName} H2H`
    : market === 'spreads'
      ? `${outcomeName} ${point > 0 ? '+' : ''}${point}`.trim()
      : `${outcomeName} ${point}`.trim();

  return {
    key: `sgm:${sgmRole}:${outcomeName}:${point ?? ''}`,
    candidateId: `sgm-${sgmRole}-${sgmCandidateCounter}`,
    label,
    market,
    family,
    outcomeName,
    description: description || '',
    point: point ?? null,
    booksChecked: 1,
    bestPrice: price,
    averagePrice: price,
    prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price }],
    sourceUrl: '',
    source: source || 'web-scrape',
    conflictGroup: `sgm:${market}:${outcomeName}`,
    subjectKey: `sgm:${outcomeName}`,
    rationale: evidenceReason,
    evidenceStatus: 'supported',
    evidenceScore: 3,
    evidenceReason,
    evidenceType: 'team-sgm',
    sgmRole,
    sgmFloorExempt: Number(price) < 1.15
  };
}

function buildRecommendationForLegs(legCount) {
  if (legCount <= 2) return 'build_2_leg_multi';
  if (legCount === 3) return 'build_3_leg_multi';
  return 'build_4_leg_multi';
}

const signedPoint = (point) => `${Number(point) > 0 ? '+' : ''}${point}`;
// Modelled near-certain legs (max line, safe total) carry a coverProbability; everything
// else uses honest implied probability (1/odds) for the displayed model probability.
const legWinProbability = (leg) => (leg.coverProbability
  ? roundTo(leg.coverProbability, 4)
  : roundTo(1 / leg.odds, 4));
const describeLeg = (leg) => (leg.market === 'totals'
  ? `${leg.outcomeName} ${leg.point}`
  : `${leg.outcomeName} ${signedPoint(leg.point)}`);

/**
 * Build a finished rules-style decision + its candidate pool for the safest 2x same-game
 * slip, or null. The slip is whatever combination of the available markets (favourite h2h,
 * main line, total, evidence-supported player props, and the modelled near-certain "max
 * line" as a fallback safe leg) is SAFEST while clearing 2x — biased to the standard
 * TAB-placeable markets. The returned candidatePool is self-contained and is what
 * buildPickFromAnalysisDecision should receive.
 */
export function buildTeamSgmDecision(eventContext, quotes, options = {}) {
  const sgm = buildTeamSgm(eventContext, quotes, options);
  if (!sgm) {
    return null;
  }

  const fav = sgm.favouriteTeam;
  const familyForMarket = (market) => (market === 'totals' ? 'total' : 'side');

  // Reuse real evidence-supported prop candidates as-is (keep candidateId + evidence +
  // settlement identity); synthesize the team-market legs (h2h / main line / max line / total).
  const candidatePool = sgm.legs.map((leg) => {
    if (leg.kind === 'prop') {
      return leg.candidate;
    }

    let evidenceReason;
    if (leg.kind === 'h2h') {
      evidenceReason = options.favouriteEvidenceReason || `${fav} is the market favourite (h2h ${leg.odds.toFixed(2)}).`;
    } else if (leg.kind === 'maxline') {
      evidenceReason = `Near-certain anchor: ${fav} ${signedPoint(leg.point)} covers in ~${Math.round(legWinProbability(leg) * 100)}% of modelled outcomes.`;
    } else if (leg.kind === 'mainline') {
      evidenceReason = `${fav} ${signedPoint(leg.point)} main line.`;
    } else if (leg.kind === 'safetotal') {
      evidenceReason = `Near-certain ${leg.outcomeName} ${leg.point} (~${Math.round(legWinProbability(leg) * 100)}% — modelled safe total).`;
    } else {
      evidenceReason = `${leg.outcomeName} ${leg.point} total${options.totalLean ? ' (evidence lean)' : ''}.`;
    }

    return buildSgmCandidate({
      market: leg.market, family: familyForMarket(leg.market), outcomeName: leg.outcomeName,
      point: leg.point, price: leg.odds, source: leg.source, evidenceReason, sgmRole: leg.kind
    });
  });

  const combinedModelProbability = roundTo(sgm.legs.reduce((acc, leg) => acc * legWinProbability(leg), 1), 4);
  const favH2hOdds = Number(sgm.legs.find((leg) => leg.kind === 'h2h')?.odds) || 0;
  const confidenceTier = favH2hOdds && favH2hOdds <= 1.5 ? 'high' : 'medium';

  const selectedLegs = candidatePool.map((candidate, index) => ({
    candidateId: candidate.candidateId,
    modelProbability: legWinProbability(sgm.legs[index]),
    rationale: candidate.evidenceReason || candidate.rationale || candidate.label
  }));

  const summary = candidatePool.map((candidate) => candidate.label).join(' + ');
  const tabLegCount = sgm.legs.filter((leg) => leg.onTab).length;
  const modelledLegs = sgm.legs.filter((leg) => leg.source === 'model');
  const maxLineNote = modelledLegs.length
    ? ` Includes ${modelledLegs.length} modelled near-certain leg${modelledLegs.length === 1 ? '' : 's'} (${modelledLegs.map(describeLeg).join(', ')}) — confirm exact price(s) in the SGM builder.`
    : '';
  const stakeUnits = clamp(
    Number(options.stakeUnits || eventContext?.generatorConfig?.stakeUnits || 1),
    0.5,
    Number(eventContext?.generatorConfig?.maxStakeUnits || 2)
  );

  const decision = {
    qualifies: true,
    recommendation: buildRecommendationForLegs(candidatePool.length),
    summary,
    rationale: `Safest 2x same-game slip (${tabLegCount}/${sgm.legs.length} legs on TAB): ${summary}, modelled at ${sgm.modeledOdds.toFixed(2)}x.${maxLineNote}`,
    noBetReason: null,
    confidenceTier,
    supportProjection: 'strong',
    dataConfidence: 'medium',
    correlationRisk: 'low',
    correlationJustified: true,
    exceptionalSupport: false,
    strongSupport: confidenceTier === 'high',
    combinedModelProbability,
    supportScore: 7.5,
    stakeUnits: roundTo(stakeUnits, 2),
    checklist: {
      actionableSlate: 'pass',
      marketDepth: 'pass',
      selectionSupport: 'pass',
      playerAvailability: 'not_applicable',
      roleStability: 'not_applicable',
      externalConditions: 'not_applicable',
      researchConfidence: 'pass',
      correlation: 'pass',
      ticketIntegrity: 'pass',
      bankrollFit: 'pass'
    },
    selectedLegs,
    backupLeg: null,
    notes: `Safest 2x same-game multi from the available markets, biased to the main TAB markets.${maxLineNote}`,
    generatedSource: GENERATED_SOURCE,
    analysisEngine: 'team-sgm',
    teamSgm: true
  };

  return { decision, candidatePool, sgm };
}
