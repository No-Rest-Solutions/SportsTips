import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { buildAutomatedMessage, deleteWebhookMessage, sendWebhookMessage } from '../discord.mjs';
import { getDateKey } from '../scheduler.mjs';

const REFERRAL_FETCH_USER_AGENT = 'SportsTipsReferralMonitor/1.0';
const REFERRAL_HISTORY_LIMIT = 250;
const REFERRAL_STATUS_ORDER = {
  active: 0,
  review_required: 1,
  inactive: 2
};
const REFERRAL_WEBHOOK_CHANNELS = {
  new: 'referralsNew',
  updated: 'referralsUpdatedTerms',
  cancelled: 'referralsCancelled',
  masterlist: 'referralsMasterlist'
};
const REFERRAL_MASTERLIST_EMBED_LIMIT = 10;
const REFERRAL_SEARCH_QUERY_DEFINITIONS = [
  'Australia "refer a friend" (cash OR crypto OR stock OR shares)',
  'Australia "invite friends" bonus (cash OR crypto OR stock)',
  'site:com.au referral bonus crypto stock cash'
];
const REFERRAL_SEARCH_RESULT_LIMIT = 5;
const REFERRAL_SEARCH_OFFER_LIMIT = 6;
const REFERRAL_SEARCH_IGNORE_HOSTS = new Set([
  'duckduckgo.com',
  'www.duckduckgo.com',
  'google.com',
  'www.google.com',
  'ozbargain.com.au',
  'www.ozbargain.com.au',
  'reddit.com',
  'www.reddit.com',
  'facebook.com',
  'www.facebook.com',
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'linkedin.com',
  'www.linkedin.com'
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundNumber(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function dedupeList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function formatAudAmount(value) {
  return Number.isFinite(Number(value))
    ? `$${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 2)} AUD`
    : 'Unknown';
}

function formatNumberValue(value) {
  return Number.isFinite(Number(value))
    ? Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 2)
    : 'Unknown';
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeComparableUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    url.hash = '';

    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }

    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function extractUrlHostname(value) {
  try {
    return new URL(String(value || '').trim()).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function buildDuckDuckGoSearchUrl(query) {
  const url = new URL('https://duckduckgo.com/html/');
  url.searchParams.set('q', String(query || '').trim());
  url.searchParams.set('ia', 'web');
  return url.toString();
}

function unwrapDuckDuckGoResultUrl(rawUrl) {
  const resolved = String(rawUrl || '').startsWith('http')
    ? String(rawUrl || '').trim()
    : new URL(String(rawUrl || '').trim(), 'https://duckduckgo.com').toString();

  try {
    const url = new URL(resolved);

    if (url.hostname.endsWith('duckduckgo.com') && url.pathname.startsWith('/l/')) {
      return normalizeComparableUrl(decodeURIComponent(url.searchParams.get('uddg') || ''));
    }

    return normalizeComparableUrl(url.toString());
  } catch {
    return '';
  }
}

function extractDuckDuckGoResultUrls(html) {
  const urls = [];
  const pattern = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/gi;

  for (let match = pattern.exec(String(html || '')); match; match = pattern.exec(String(html || ''))) {
    const candidateUrl = unwrapDuckDuckGoResultUrl(match[1]);
    const hostname = extractUrlHostname(candidateUrl);

    if (!candidateUrl || !hostname || REFERRAL_SEARCH_IGNORE_HOSTS.has(hostname)) {
      continue;
    }

    urls.push(candidateUrl);
  }

  return dedupeList(urls);
}

function extractHtmlTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([^<]+)<\/title>/i);
  return decodeHtmlEntities(match?.[1] || '').replace(/\s+/g, ' ').trim();
}

function humanizeBrandToken(value) {
  return String(value || '')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

function inferBrandFromUrl(urlString) {
  const hostname = extractUrlHostname(urlString);

  if (!hostname) {
    return '';
  }

  const hostWithoutTld = hostname
    .replace(/\.(com|net|org|app|io|co|au|uk|nz)$/i, '')
    .replace(/\.(com|net|org|co)$/i, '');
  const pieces = hostWithoutTld.split('.').filter(Boolean);
  return humanizeBrandToken(pieces[pieces.length - 1] || hostname);
}

function splitIntoSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractMatchingSentences(text, patterns, limit = 4) {
  return dedupeList(splitIntoSentences(text).filter((sentence) => patterns.some((pattern) => pattern.test(sentence))).slice(0, limit));
}

function findLikelyTermsUrl(html, baseUrl) {
  const pattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  for (let match = pattern.exec(String(html || '')); match; match = pattern.exec(String(html || ''))) {
    const href = decodeHtmlEntities(match[1] || '').trim();
    const text = normalizePublicPageText(match[2] || '');

    if (!href || href.startsWith('#') || /^javascript:/i.test(href) || /^mailto:/i.test(href)) {
      continue;
    }

    if (!/(terms|legal|conditions|faq|support|help|promotions?)/i.test(`${href} ${text}`)) {
      continue;
    }

    try {
      return normalizeComparableUrl(new URL(href, baseUrl).toString());
    } catch {
      continue;
    }
  }

  return '';
}

function inferGenericRewardType(text) {
  const source = String(text || '').toLowerCase();

  if (/(crypto|bitcoin|btc|eth|ethereum)/i.test(source)) {
    return 'crypto';
  }

  if (/(stock|share|shares|buying power)/i.test(source)) {
    return 'stock';
  }

  if (/(cash|bonus|credit|aud|\$)/i.test(source)) {
    return 'cash';
  }

  return 'unknown';
}

function inferGenericCategory(urlString, text) {
  const combined = `${extractUrlHostname(urlString)} ${String(text || '').toLowerCase()}`;

  if (/(crypto|bitcoin|btc|exchange|wallet)/i.test(combined)) {
    return 'crypto';
  }

  if (/(stock|share|broker|invest|investing|trading)/i.test(combined)) {
    return 'investing';
  }

  if (/(bank|banking|card|debit|savings|payments)/i.test(combined)) {
    return 'banking';
  }

  return 'other';
}

function looksLikeGenericReferralOffer(text) {
  const source = String(text || '').toLowerCase();

  if (!/(refer a friend|referral|invite friends|invite a friend|invite code)/i.test(source)) {
    return false;
  }

  if (!/(cash|crypto|bitcoin|btc|stock|share|shares|buying power|\$\s*[0-9]+)/i.test(source)) {
    return false;
  }

  return !/(discount|coupon|voucher|promo code|percentage off|free shipping)/i.test(source);
}

function extractGenericRewardSummary(text) {
  return extractMatchingSentences(text, [
    /(receive|get|score|bonus|reward|buying power|free btc|free bitcoin|free stock|share)/i,
    /\$\s*[0-9]+/i
  ], 1)[0] || '';
}

function extractGenericRewardValues(text) {
  const rewardSentence = extractGenericRewardSummary(text) || String(text || '');
  const sharedValue = extractFirstNumber(rewardSentence, [
    /\$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /([0-9]+(?:\.[0-9]+)?)\s*(?:aud|usd)/i
  ]);
  const sharedReward = /\b(?:both|each|you(?:'|’)?ll both|both parties)\b/i.test(rewardSentence);
  const referrerValue = extractFirstNumber(text, [
    /referr(?:er|ing)[^$]{0,80}\$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /inviter[^$]{0,80}\$\s*([0-9]+(?:\.[0-9]+)?)/i
  ]);
  const refereeValue = extractFirstNumber(text, [
    /referr(?:ee|ed person)[^$]{0,80}\$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /invitee[^$]{0,80}\$\s*([0-9]+(?:\.[0-9]+)?)/i
  ]);

  if (sharedReward && Number.isFinite(sharedValue)) {
    return {
      rewardValueReferrerAud: sharedValue,
      rewardValueRefereeAud: sharedValue
    };
  }

  return {
    rewardValueReferrerAud: Number.isFinite(referrerValue) ? referrerValue : null,
    rewardValueRefereeAud: Number.isFinite(refereeValue) ? refereeValue : (Number.isFinite(sharedValue) ? sharedValue : null)
  };
}

function extractGenericMinDeposit(text) {
  return extractFirstNumber(text, [
    /deposit of at least \$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /qualified funding(?: must be| of)? at least \$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /minimum deposit(?: of)? \$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /first deposit(?: of)? \$\s*([0-9]+(?:\.[0-9]+)?)/i
  ]);
}

function extractGenericWindowDays(text) {
  return extractFirstNumber(text, [
    /within\s+([0-9]+)\s+days/i,
    /([0-9]+)\s+day window/i,
    /within\s+([0-9]+)\s+hours/i
  ]);
}

function buildSearchDiscoveredOffer({ page, termsPage, nowIso }) {
  const combinedText = `${page?.text || ''} ${termsPage?.text || ''}`.trim();

  if (!looksLikeGenericReferralOffer(combinedText)) {
    return null;
  }

  const rewardSummary = extractGenericRewardSummary(combinedText);
  const rewardValues = extractGenericRewardValues(combinedText);
  const qualificationSteps = extractMatchingSentences(combinedText, [
    /(verify|kyc|identity|deposit|fund|trade|buy|invest|sign up|register|invite code|referral code|new account|first deposit|first trade|within\s+[0-9]+\s+days)/i
  ], 4);
  const hasTermsEvidence = Boolean(termsPage?.url) || /(terms|conditions|eligible|last updated|program can change|discretion)/i.test(combinedText);

  if (!rewardSummary || (!Number.isFinite(rewardValues.rewardValueRefereeAud) && !Number.isFinite(rewardValues.rewardValueReferrerAud)) || !qualificationSteps.length || !hasTermsEvidence) {
    return null;
  }

  const pageTitle = extractHtmlTitle(page?.html || '') || 'Referral Offer';
  const brand = inferBrandFromUrl(page?.url) || humanizeBrandToken(pageTitle.split(/\s+/).slice(0, 2).join(' ')) || 'Referral Offer';
  const termsText = termsPage?.text || page?.text || '';

  return finalizeReferralOffer({
    id: `search:${hashText(`${page?.url || ''}|${termsPage?.url || ''}`)}`,
    sourceId: `search:${extractUrlHostname(page?.url) || 'unknown'}`,
    brand,
    title: /referr|invite/i.test(pageTitle) ? pageTitle : 'Referral Offer',
    category: inferGenericCategory(page?.url, combinedText),
    status: hasInactiveSignal(combinedText) ? 'inactive' : 'active',
    rewardType: inferGenericRewardType(combinedText),
    rewardSummary,
    rewardValueReferrerAud: rewardValues.rewardValueReferrerAud,
    rewardValueRefereeAud: rewardValues.rewardValueRefereeAud,
    qualificationWindowDays: extractGenericWindowDays(combinedText),
    minDepositAud: extractGenericMinDeposit(combinedText),
    requiresKyc: /(kyc|identity verification|verify your identity|pass id verification)/i.test(combinedText),
    requiresDeposit: /(deposit|fund|top up|add funds|qualified funding)/i.test(combinedText),
    requiresTrade: /(trade|buy crypto|buy shares|place an order|invest)/i.test(combinedText),
    requiresPurchase: /(purchase|shop|spend)/i.test(combinedText) && !/(trade|invest)/i.test(combinedText),
    publicShareability: 'review_required',
    abuseRisk: 'medium',
    shareabilityNote: 'Discovered via broad search. Verify public-sharing restrictions on the official offer and terms pages before approving.',
    confidence: termsPage?.url ? 'medium' : 'low',
    officialOfferUrl: page?.url || '',
    officialTermsUrl: termsPage?.url || page?.url || '',
    termsLastUpdatedText: extractLastUpdatedText(termsText),
    qualificationSteps,
    notes: [
      'Broad-search discovery queued for manual verification before it can enter the masterlist.'
    ],
    termsFingerprintSource: `${page?.text || ''}\n${termsPage?.text || ''}`,
    discoverySource: 'search',
    verificationStatus: 'pending',
    estimatedActivationCapitalAud: extractGenericMinDeposit(combinedText),
    estimatedPayoutDays: extractFirstNumber(combinedText, [
      /paid within\s+([0-9]+)\s+days/i,
      /credited within\s+([0-9]+)\s+days/i
    ])
  }, nowIso);
}

function getOfferDeduplicationKeys(offer) {
  return dedupeList([
    normalizeComparableUrl(offer?.officialOfferUrl),
    normalizeComparableUrl(offer?.officialTermsUrl),
    `${String(offer?.brand || '').trim().toLowerCase()}|${String(offer?.title || '').trim().toLowerCase()}`
  ]);
}

function getConfidenceRank(value) {
  if (value === 'high') {
    return 3;
  }

  if (value === 'medium') {
    return 2;
  }

  return 1;
}

function shouldPreferOffer(candidate, existing) {
  const candidateCurated = candidate?.discoverySource !== 'search';
  const existingCurated = existing?.discoverySource !== 'search';

  if (candidateCurated !== existingCurated) {
    return candidateCurated;
  }

  const confidenceGap = getConfidenceRank(candidate?.confidence) - getConfidenceRank(existing?.confidence);

  if (confidenceGap !== 0) {
    return confidenceGap > 0;
  }

  return Number(candidate?.scores?.overall || 0) > Number(existing?.scores?.overall || 0);
}

function dedupeReferralOffers(offers) {
  const selected = [];
  const keyToIndex = new Map();

  for (const offer of Array.isArray(offers) ? offers : []) {
    const keys = getOfferDeduplicationKeys(offer);
    const matchingIndex = keys.find((key) => key && keyToIndex.has(key));

    if (matchingIndex === undefined) {
      selected.push(offer);
      const nextIndex = selected.length - 1;

      for (const key of keys) {
        if (key) {
          keyToIndex.set(key, nextIndex);
        }
      }

      continue;
    }

    const index = keyToIndex.get(matchingIndex);
    const existing = selected[index];

    if (!shouldPreferOffer(offer, existing)) {
      continue;
    }

    selected[index] = offer;

    for (const key of keys) {
      if (key) {
        keyToIndex.set(key, index);
      }
    }
  }

  return selected;
}

async function collectSearchDiscoveredOffers(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || 30000);
  const nowIso = options.nowIso || new Date().toISOString();
  const queries = Array.isArray(options.queries) && options.queries.length ? options.queries : REFERRAL_SEARCH_QUERY_DEFINITIONS;
  const maxResultsPerQuery = Number(options.maxResultsPerQuery || REFERRAL_SEARCH_RESULT_LIMIT);
  const maxOffers = Number(options.maxOffers || REFERRAL_SEARCH_OFFER_LIMIT);
  const knownUrls = new Set((Array.isArray(options.knownUrls) ? options.knownUrls : []).map(normalizeComparableUrl).filter(Boolean));
  const seenCandidateUrls = new Set();
  const offers = [];

  for (const query of queries) {
    if (offers.length >= maxOffers) {
      break;
    }

    let searchPage;

    try {
      searchPage = await fetchPublicPage(buildDuckDuckGoSearchUrl(query), fetchImpl, timeoutMs);
    } catch {
      continue;
    }

    for (const resultUrl of extractDuckDuckGoResultUrls(searchPage.html).slice(0, maxResultsPerQuery)) {
      const normalizedResultUrl = normalizeComparableUrl(resultUrl);

      if (!normalizedResultUrl || seenCandidateUrls.has(normalizedResultUrl) || knownUrls.has(normalizedResultUrl)) {
        continue;
      }

      seenCandidateUrls.add(normalizedResultUrl);

      let offerPage;

      try {
        offerPage = await fetchPublicPage(resultUrl, fetchImpl, timeoutMs);
      } catch {
        continue;
      }

      const termsUrl = findLikelyTermsUrl(offerPage.html, offerPage.url);
      let termsPage = null;

      if (termsUrl && normalizeComparableUrl(termsUrl) !== normalizeComparableUrl(offerPage.url)) {
        try {
          termsPage = await fetchPublicPage(termsUrl, fetchImpl, timeoutMs);
        } catch {
          termsPage = null;
        }
      }

      const offer = buildSearchDiscoveredOffer({
        page: offerPage,
        termsPage,
        nowIso
      });

      if (!offer) {
        continue;
      }

      const offerKeys = [normalizeComparableUrl(offer.officialOfferUrl), normalizeComparableUrl(offer.officialTermsUrl)].filter(Boolean);

      if (offerKeys.some((key) => knownUrls.has(key))) {
        continue;
      }

      offers.push(offer);
      offerKeys.forEach((key) => knownUrls.add(key));

      if (offers.length >= maxOffers) {
        break;
      }
    }
  }

  return offers;
}

export function normalizePublicPageText(html) {
  return decodeHtmlEntities(String(html || ''))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashText(value) {
  return crypto
    .createHash('sha1')
    .update(String(value || ''))
    .digest('hex');
}

function extractFirstNumber(text, patterns = []) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);

    if (!match) {
      continue;
    }

    for (let index = 1; index < match.length; index += 1) {
      const parsed = Number(match[index]);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function extractLastUpdatedText(text) {
  const source = String(text || '');
  const match = source.match(/last updated[:\s]+([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i)
    || source.match(/last modified[:\s]+([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i)
    || source.match(/published[:\s]+([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i);

  return match ? match[1] : '';
}

function hasInactiveSignal(text) {
  const source = String(text || '').toLowerCase();

  return source.includes('promotion ended')
    || source.includes('no longer available')
    || source.includes('offer has ended')
    || source.includes('program has ended')
    || source.includes('referral program has ended');
}

function compareOffers(left, right) {
  const leftRank = REFERRAL_STATUS_ORDER[left?.status] ?? 9;
  const rightRank = REFERRAL_STATUS_ORDER[right?.status] ?? 9;

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const leftScore = Number(left?.scores?.overall || 0);
  const rightScore = Number(right?.scores?.overall || 0);

  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  return `${left?.brand || ''}${left?.title || ''}`.localeCompare(`${right?.brand || ''}${right?.title || ''}`);
}

function formatVerificationStatusLabel(value) {
  return String(value || 'pending')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatDiscoverySourceLabel(value) {
  if (value === 'search') {
    return 'Broad Search';
  }

  return 'Curated Monitor';
}

function inferLegacyVerificationStatus(offer) {
  if (offer?.verificationStatus) {
    return offer.verificationStatus;
  }

  return String(offer?.sourceId || '').startsWith('search:') ? 'pending' : 'verified';
}

function getMasterlistReferralOffers(catalog) {
  return (Array.isArray(catalog?.offers) ? catalog.offers : [])
    .filter((offer) => offer?.status === 'active' && inferLegacyVerificationStatus(offer) === 'verified')
    .sort(compareOffers);
}

function buildReferralCatalogCounts(offers) {
  const source = Array.isArray(offers) ? offers : [];

  return {
    total: source.length,
    verifiedActive: source.filter((offer) => offer?.status === 'active' && inferLegacyVerificationStatus(offer) === 'verified').length,
    pendingActive: source.filter((offer) => offer?.status === 'active' && inferLegacyVerificationStatus(offer) !== 'verified').length,
    inactive: source.filter((offer) => offer?.status === 'inactive').length,
    reviewRequired: source.filter((offer) => offer?.status === 'review_required').length
  };
}

function deriveRewardScore(offer) {
  if (Number.isFinite(Number(offer?.rewardScoreOverride))) {
    return clamp(Number(offer.rewardScoreOverride), 0, 100);
  }

  const values = [offer?.rewardValueReferrerAud, offer?.rewardValueRefereeAud]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  let score = values.length
    ? Math.min(100, Math.round((Math.max(...values) * 5) + (values.reduce((total, value) => total + value, 0) * 1.5)))
    : (offer?.rewardSummary ? 35 : 10);

  if (offer?.rewardType === 'crypto' || offer?.rewardType === 'stock') {
    score -= 5;
  }

  if (offer?.rewardType === 'brokerage_discount') {
    score -= 18;
  }

  if (offer?.status === 'review_required') {
    score -= 12;
  }

  return clamp(score, 0, 100);
}

function deriveFrictionScore(offer) {
  let score = 100;

  if (offer?.requiresKyc) {
    score -= 20;
  }

  if (offer?.requiresDeposit) {
    score -= 18;
  }

  if (offer?.requiresTrade) {
    score -= 18;
  }

  if (offer?.requiresPurchase) {
    score -= 12;
  }

  if (Number.isFinite(Number(offer?.minDepositAud)) && Number(offer.minDepositAud) > 0) {
    score -= clamp(Math.round(Number(offer.minDepositAud) / 5), 4, 20);
  }

  if (Number.isFinite(Number(offer?.qualificationWindowDays))) {
    const days = Number(offer.qualificationWindowDays);

    if (days <= 1) {
      score -= 15;
    } else if (days <= 14) {
      score -= 8;
    } else if (days <= 30) {
      score -= 4;
    }
  }

  if (offer?.status === 'review_required') {
    score -= 10;
  }

  return clamp(score, 0, 100);
}

function deriveTrustScore(offer) {
  let score = 55;

  if (offer?.confidence === 'high') {
    score += 20;
  } else if (offer?.confidence === 'medium') {
    score += 10;
  } else if (offer?.confidence === 'low') {
    score -= 10;
  }

  if (offer?.officialOfferUrl) {
    score += 5;
  }

  if (offer?.officialTermsUrl) {
    score += 5;
  }

  if (offer?.termsLastUpdatedText) {
    score += 5;
  }

  if (offer?.syncState === 'stale') {
    score -= 25;
  }

  if (offer?.status === 'review_required') {
    score -= 18;
  }

  if (offer?.status === 'inactive') {
    score -= 25;
  }

  return clamp(score, 0, 100);
}

function deriveShareabilityScore(offer) {
  const baseScores = {
    allowed: 85,
    caution: 60,
    risky: 25,
    review_required: 35,
    blocked: 10
  };
  const abusePenalty = {
    low: 0,
    medium: 7,
    high: 15
  };
  const base = baseScores[offer?.publicShareability] ?? 40;
  const penalty = abusePenalty[offer?.abuseRisk] ?? 0;

  return clamp(base - penalty, 0, 100);
}

export function buildReferralScores(offer) {
  const reward = deriveRewardScore(offer);
  const friction = deriveFrictionScore(offer);
  const trust = deriveTrustScore(offer);
  const stability = clamp(Number.isFinite(Number(offer?.stabilityScoreOverride)) ? Number(offer.stabilityScoreOverride) : 60, 0, 100);
  const shareability = deriveShareabilityScore(offer);
  let overall = Math.round((reward * 0.28) + (friction * 0.18) + (trust * 0.22) + (stability * 0.12) + (shareability * 0.20));

  if (offer?.syncState === 'stale') {
    overall = Math.round(overall * 0.75);
  }

  if (offer?.status === 'review_required') {
    overall = Math.round(overall * 0.60);
  }

  if (offer?.status === 'inactive') {
    overall = Math.round(overall * 0.20);
  }

  return {
    reward,
    friction,
    trust,
    stability,
    shareability,
    overall: clamp(overall, 0, 100)
  };
}

function deriveCombinedAdvertisedValueAud(offer) {
  const values = [offer?.rewardValueReferrerAud, offer?.rewardValueRefereeAud]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  return values.length
    ? roundNumber(values.reduce((total, value) => total + value, 0), 2)
    : null;
}

function deriveActivationCapitalAud(offer) {
  if (Number.isFinite(Number(offer?.estimatedActivationCapitalAud))) {
    return Math.max(0, Number(offer.estimatedActivationCapitalAud));
  }

  if (Number.isFinite(Number(offer?.minDepositAud))) {
    return Math.max(0, Number(offer.minDepositAud));
  }

  if (!offer?.requiresDeposit && !offer?.requiresTrade && !offer?.requiresPurchase) {
    return 0;
  }

  if (offer?.category === 'microinvesting') {
    return 5;
  }

  if (offer?.requiresTrade) {
    return 10;
  }

  if (offer?.requiresPurchase) {
    return 10;
  }

  if (offer?.requiresDeposit) {
    return 5;
  }

  return 0;
}

function deriveEstimatedPayoutDays(offer) {
  if (Number.isFinite(Number(offer?.estimatedPayoutDays))) {
    return Math.max(1, Number(offer.estimatedPayoutDays));
  }

  if (offer?.category === 'microinvesting') {
    return 5;
  }

  if (offer?.requiresTrade) {
    return 3;
  }

  if (offer?.requiresDeposit || offer?.requiresPurchase) {
    return 2;
  }

  return 1;
}

function deriveEstimatedSetupMinutes(offer) {
  if (Number.isFinite(Number(offer?.estimatedSetupMinutes))) {
    return Math.max(5, Number(offer.estimatedSetupMinutes));
  }

  let minutes = 8;

  if (offer?.requiresKyc) {
    minutes += 10;
  }

  if (offer?.requiresDeposit) {
    minutes += 4;
  }

  if (offer?.requiresTrade) {
    minutes += 8;
  }

  if (offer?.requiresPurchase) {
    minutes += 5;
  }

  return minutes;
}

function buildCapitalPlanCandidate(offer) {
  const combinedAdvertisedValueAud = deriveCombinedAdvertisedValueAud(offer);
  const activationCapitalAud = deriveActivationCapitalAud(offer);
  const estimatedPayoutDays = deriveEstimatedPayoutDays(offer);
  const estimatedSetupMinutes = deriveEstimatedSetupMinutes(offer);
  const rewardToCapitalRatio = Number.isFinite(Number(combinedAdvertisedValueAud))
    ? roundNumber(Number(combinedAdvertisedValueAud) / Math.max(activationCapitalAud, 1), 2)
    : null;
  const rewardScore = clamp(Math.round((Number(combinedAdvertisedValueAud) || 0) * 4), 0, 100);
  const ratioScore = clamp(Math.round((Number(rewardToCapitalRatio) || 0) * 22), 0, 100);
  const payoutScore = clamp(Math.round(100 - ((estimatedPayoutDays - 1) * 16)), 15, 100);
  const capitalScore = activationCapitalAud <= 0
    ? 100
    : clamp(Math.round(100 - (activationCapitalAud * 1.3)), 5, 100);
  const setupScore = clamp(Math.round(100 - (Math.max(0, estimatedSetupMinutes - 10) * 2.5)), 15, 100);
  const policyPenalty = offer?.publicShareability === 'blocked'
    ? 50
    : offer?.publicShareability === 'risky'
      ? 28
      : offer?.publicShareability === 'review_required'
        ? 15
        : 0;
  const abusePenalty = offer?.abuseRisk === 'high'
    ? 8
    : offer?.abuseRisk === 'medium'
      ? 3
      : 0;
  let scalingScore = Math.round(
    (rewardScore * 0.28)
    + (ratioScore * 0.26)
    + (payoutScore * 0.18)
    + (capitalScore * 0.12)
    + (setupScore * 0.07)
    + (Number(offer?.scores?.trust || 0) * 0.05)
    + (Number(offer?.scores?.friction || 0) * 0.04)
    - policyPenalty
    - abusePenalty
  );

  if (offer?.status !== 'active') {
    scalingScore = Math.round(scalingScore * 0.55);
  }

  return {
    offerId: offer?.id || '',
    brand: offer?.brand || 'Unknown',
    title: offer?.title || 'Unknown offer',
    status: offer?.status || 'review_required',
    rewardType: offer?.rewardType || 'unknown',
    publicShareability: offer?.publicShareability || 'review_required',
    abuseRisk: offer?.abuseRisk || 'medium',
    combinedAdvertisedValueAud,
    activationCapitalAud,
    estimatedPayoutDays,
    estimatedSetupMinutes,
    rewardToCapitalRatio,
    scalingScore: clamp(scalingScore, 0, 100),
    trustScore: Number(offer?.scores?.trust || 0),
    frictionScore: Number(offer?.scores?.friction || 0),
    overallScore: Number(offer?.scores?.overall || 0),
    sortKey: `${offer?.brand || ''}${offer?.title || ''}`,
    offer
  };
}

function compareCapitalPlanCandidates(left, right, availableCapitalAud = 0) {
  const leftEligible = left.status === 'active'
    && Number.isFinite(Number(left.combinedAdvertisedValueAud))
    && Number(left.combinedAdvertisedValueAud) > 0
    && Number(left.activationCapitalAud) <= availableCapitalAud;
  const rightEligible = right.status === 'active'
    && Number.isFinite(Number(right.combinedAdvertisedValueAud))
    && Number(right.combinedAdvertisedValueAud) > 0
    && Number(right.activationCapitalAud) <= availableCapitalAud;

  if (leftEligible !== rightEligible) {
    return leftEligible ? -1 : 1;
  }

  if (left.scalingScore !== right.scalingScore) {
    return right.scalingScore - left.scalingScore;
  }

  if (Number(left.rewardToCapitalRatio || 0) !== Number(right.rewardToCapitalRatio || 0)) {
    return Number(right.rewardToCapitalRatio || 0) - Number(left.rewardToCapitalRatio || 0);
  }

  if (Number(left.activationCapitalAud || 0) !== Number(right.activationCapitalAud || 0)) {
    return Number(left.activationCapitalAud || 0) - Number(right.activationCapitalAud || 0);
  }

  if (Number(left.combinedAdvertisedValueAud || 0) !== Number(right.combinedAdvertisedValueAud || 0)) {
    return Number(right.combinedAdvertisedValueAud || 0) - Number(left.combinedAdvertisedValueAud || 0);
  }

  return left.sortKey.localeCompare(right.sortKey);
}

function buildCapitalPlanRationale(candidate) {
  const notes = [];

  if (Number(candidate.activationCapitalAud || 0) <= 10) {
    notes.push('low cash hurdle');
  } else if (Number(candidate.activationCapitalAud || 0) >= 50) {
    notes.push('higher capital gate');
  }

  if (Number(candidate.rewardToCapitalRatio || 0) >= 2) {
    notes.push('strong reward-to-capital fit');
  }

  if (Number(candidate.estimatedPayoutDays || 0) <= 2) {
    notes.push('fast payout');
  } else if (Number(candidate.estimatedPayoutDays || 0) >= 5) {
    notes.push('slower payout');
  }

  if (Number(candidate.trustScore || 0) >= 75) {
    notes.push('strong official-page confidence');
  }

  if (candidate.publicShareability === 'risky') {
    notes.push('sharing policy is restrictive');
  }

  return notes.join(', ') || 'balanced fit';
}

function buildCapitalPlanDeferredReason(candidate, currentCapitalAud) {
  if (candidate.status !== 'active') {
    return `Status is ${formatStatusLabel(candidate.status)}.`;
  }

  if (!Number.isFinite(Number(candidate.combinedAdvertisedValueAud)) || Number(candidate.combinedAdvertisedValueAud) <= 0) {
    if (candidate.rewardType === 'stock') {
      return 'Reward value is stock-based and too variable for the fixed-cash ladder.';
    }

    return 'No precise public combined cash-equivalent value is published yet.';
  }

  if (Number(candidate.activationCapitalAud || 0) > Number(currentCapitalAud || 0)) {
    return `Needs about ${formatAudAmount(candidate.activationCapitalAud)} of working capital, above the current ladder bank.`;
  }

  if (candidate.publicShareability === 'risky') {
    return 'Restrictive sharing policy keeps it behind cleaner public-share options.';
  }

  return 'Lower capital efficiency than the offers already in the ladder.';
}

export function buildReferralCapitalPlan(offers, options = {}) {
  const startingCapitalAud = Number.isFinite(Number(options.startingCapitalAud))
    ? Math.max(0, Number(options.startingCapitalAud))
    : 10;
  const maxSteps = Number.isFinite(Number(options.maxSteps))
    ? Math.max(1, Number(options.maxSteps))
    : 5;
  const candidates = (Array.isArray(offers) ? offers : [])
    .map((offer) => buildCapitalPlanCandidate(offer));
  const remaining = [...candidates];
  const steps = [];
  let currentCapitalAud = startingCapitalAud;
  let totalEstimatedDays = 0;
  let totalExpectedGainAud = 0;

  while (steps.length < maxSteps) {
    const eligible = remaining
      .filter((candidate) => candidate.status === 'active'
        && Number.isFinite(Number(candidate.combinedAdvertisedValueAud))
        && Number(candidate.combinedAdvertisedValueAud) > 0
        && Number(candidate.activationCapitalAud) <= currentCapitalAud)
      .sort((left, right) => compareCapitalPlanCandidates(left, right, currentCapitalAud));

    if (!eligible.length) {
      break;
    }

    const nextCandidate = eligible[0];
    const nextIndex = remaining.findIndex((candidate) => candidate.offerId === nextCandidate.offerId);

    if (nextIndex >= 0) {
      remaining.splice(nextIndex, 1);
    }

    totalEstimatedDays += Number(nextCandidate.estimatedPayoutDays || 0);
    totalExpectedGainAud += Number(nextCandidate.combinedAdvertisedValueAud || 0);
    currentCapitalAud = roundNumber(currentCapitalAud + Number(nextCandidate.combinedAdvertisedValueAud || 0), 2);
    steps.push({
      order: steps.length + 1,
      offerId: nextCandidate.offerId,
      brand: nextCandidate.brand,
      title: nextCandidate.title,
      activationCapitalAud: nextCandidate.activationCapitalAud,
      combinedAdvertisedValueAud: nextCandidate.combinedAdvertisedValueAud,
      estimatedPayoutDays: nextCandidate.estimatedPayoutDays,
      estimatedSetupMinutes: nextCandidate.estimatedSetupMinutes,
      rewardToCapitalRatio: nextCandidate.rewardToCapitalRatio,
      scalingScore: nextCandidate.scalingScore,
      startingCapitalAud: roundNumber(currentCapitalAud - Number(nextCandidate.combinedAdvertisedValueAud || 0), 2),
      projectedEndingCapitalAud: currentCapitalAud,
      cumulativeExpectedGainAud: roundNumber(totalExpectedGainAud, 2),
      cumulativeEstimatedDays: roundNumber(totalEstimatedDays, 1),
      rationale: buildCapitalPlanRationale(nextCandidate)
    });
  }

  const deferred = remaining
    .sort((left, right) => compareCapitalPlanCandidates(left, right, currentCapitalAud))
    .map((candidate) => ({
      offerId: candidate.offerId,
      brand: candidate.brand,
      title: candidate.title,
      status: candidate.status,
      combinedAdvertisedValueAud: candidate.combinedAdvertisedValueAud,
      activationCapitalAud: candidate.activationCapitalAud,
      reason: buildCapitalPlanDeferredReason(candidate, currentCapitalAud)
    }));

  return {
    startingCapitalAud,
    projectedEndingCapitalAud: roundNumber(currentCapitalAud, 2),
    totalExpectedGainAud: roundNumber(totalExpectedGainAud, 2),
    totalEstimatedDays: roundNumber(totalEstimatedDays, 1),
    assumptions: [
      'Assumes one legitimate referral cycle completes at a time.',
      'Counts only currently published referrer plus referee value.',
      'Uses conservative working-capital estimates where public minimums are not stated.',
      'Excludes variable perks like random stocks or brokerage discounts unless a public AUD amount is explicit.'
    ],
    steps,
    deferred
  };
}

function finalizeReferralOffer(offer, nowIso) {
  const qualificationSteps = dedupeList(offer.qualificationSteps);
  const notes = dedupeList(offer.notes);
  const normalized = {
    id: offer.id,
    sourceId: offer.sourceId,
    brand: offer.brand,
    title: offer.title,
    category: offer.category || 'other',
    status: offer.status || 'review_required',
    rewardType: offer.rewardType || 'unknown',
    rewardSummary: String(offer.rewardSummary || '').trim(),
    rewardValueReferrerAud: Number.isFinite(Number(offer.rewardValueReferrerAud)) ? Number(offer.rewardValueReferrerAud) : null,
    rewardValueRefereeAud: Number.isFinite(Number(offer.rewardValueRefereeAud)) ? Number(offer.rewardValueRefereeAud) : null,
    maxRewardValueAud: Number.isFinite(Number(offer.maxRewardValueAud)) ? Number(offer.maxRewardValueAud) : null,
    qualificationWindowDays: Number.isFinite(Number(offer.qualificationWindowDays)) ? Number(offer.qualificationWindowDays) : null,
    minDepositAud: Number.isFinite(Number(offer.minDepositAud)) ? Number(offer.minDepositAud) : null,
    requiresKyc: Boolean(offer.requiresKyc),
    requiresDeposit: Boolean(offer.requiresDeposit),
    requiresTrade: Boolean(offer.requiresTrade),
    requiresPurchase: Boolean(offer.requiresPurchase),
    publicShareability: offer.publicShareability || 'review_required',
    abuseRisk: offer.abuseRisk || 'medium',
    shareabilityNote: String(offer.shareabilityNote || '').trim(),
    confidence: offer.confidence || 'medium',
    officialOfferUrl: String(offer.officialOfferUrl || '').trim(),
    officialTermsUrl: String(offer.officialTermsUrl || '').trim(),
    termsLastUpdatedText: String(offer.termsLastUpdatedText || '').trim(),
    qualificationSteps,
    notes,
    verificationStatus: offer.verificationStatus || 'pending',
    verificationNotes: String(offer.verificationNotes || '').trim(),
    discoverySource: offer.discoverySource || 'curated',
    discoveredAt: offer.discoveredAt || nowIso,
    verifiedAt: offer.verifiedAt || '',
    lastMaterialChangeAt: offer.lastMaterialChangeAt || '',
    syncState: offer.syncState || 'fresh',
    lastSeenAt: offer.lastSeenAt || nowIso,
    lastSuccessfulSyncAt: offer.lastSuccessfulSyncAt || nowIso,
    lastAttemptAt: offer.lastAttemptAt || nowIso,
    fetchError: offer.fetchError || '',
    rewardScoreOverride: Number.isFinite(Number(offer.rewardScoreOverride)) ? Number(offer.rewardScoreOverride) : null,
    stabilityScoreOverride: Number.isFinite(Number(offer.stabilityScoreOverride)) ? Number(offer.stabilityScoreOverride) : null,
    estimatedActivationCapitalAud: Number.isFinite(Number(offer.estimatedActivationCapitalAud)) ? Number(offer.estimatedActivationCapitalAud) : null,
    estimatedPayoutDays: Number.isFinite(Number(offer.estimatedPayoutDays)) ? Number(offer.estimatedPayoutDays) : null,
    estimatedSetupMinutes: Number.isFinite(Number(offer.estimatedSetupMinutes)) ? Number(offer.estimatedSetupMinutes) : null
  };

  normalized.termsFingerprint = hashText(offer.termsFingerprintSource || [
    normalized.rewardSummary,
    normalized.termsLastUpdatedText,
    normalized.qualificationSteps.join('|'),
    normalized.notes.join('|'),
    normalized.shareabilityNote,
    normalized.status
  ].join('\n'));
  normalized.offerFingerprint = hashText([
    normalized.rewardSummary,
    normalized.status,
    normalized.rewardValueReferrerAud,
    normalized.rewardValueRefereeAud,
    normalized.qualificationWindowDays,
    normalized.minDepositAud,
    normalized.requiresKyc,
    normalized.requiresDeposit,
    normalized.requiresTrade,
    normalized.requiresPurchase,
    normalized.publicShareability,
    normalized.shareabilityNote,
    normalized.qualificationSteps.join('|')
  ].join('\n'));
  normalized.scores = buildReferralScores(normalized);

  return normalized;
}

function getPageText(pages, key) {
  return String(pages?.[key]?.text || '');
}

export function extractUpOfferFromPages({ pages, nowIso = new Date().toISOString() }) {
  const offerText = getPageText(pages, 'offer');
  const termsText = `${offerText} ${getPageText(pages, 'promotions')} ${getPageText(pages, 'terms')}`;
  const reward = extractFirstNumber(offerText, [
    /you(?:'|’)?ll both score \$\s*([0-9]+(?:\.[0-9]+)?)/i,
    /standard bonus is \$\s*([0-9]+(?:\.[0-9]+)?)/i
  ]);
  const maxReward = extractFirstNumber(offerText, [
    /up to \$\s*([0-9]+(?:\.[0-9]+)?)/i
  ]);
  const qualificationWindowDays = extractFirstNumber(offerText, [
    /within\s+([0-9]+)\s+days/i
  ]);

  return [finalizeReferralOffer({
    id: 'up-hook-up-a-mate',
    sourceId: 'up',
    brand: 'Up',
    title: 'Hook Up a Mate',
    category: 'banking',
    status: reward ? 'active' : (hasInactiveSignal(offerText) ? 'inactive' : 'review_required'),
    rewardType: 'cash',
    rewardSummary: reward
      ? `Both parties receive $${formatNumberValue(reward)} AUD when the invitee joins. The bonus steps up with Upsider tenure up to $${formatNumberValue(maxReward || 25)}.`
      : 'Referral amount is controlled by the live Hook Up a Mate page and can vary with inviter tenure.',
    rewardValueReferrerAud: reward,
    rewardValueRefereeAud: reward,
    maxRewardValueAud: maxReward || 25,
    qualificationWindowDays: qualificationWindowDays || 14,
    minDepositAud: 0,
    requiresKyc: true,
    requiresDeposit: false,
    requiresTrade: false,
    requiresPurchase: false,
    publicShareability: 'risky',
    abuseRisk: 'high',
    shareabilityNote: 'Official page says the program is not for spamming strangers, mass-sharing invite codes, or using Up as a side hustle.',
    confidence: 'high',
    officialOfferUrl: 'https://up.com.au/hook_up_a_mate/',
    officialTermsUrl: 'https://up.com.au/hook_up_a_mate/',
    termsLastUpdatedText: extractLastUpdatedText(offerText) || extractLastUpdatedText(getPageText(pages, 'terms')),
    qualificationSteps: [
      `Invitee must sign up through the Up app and pass ID verification within ${qualificationWindowDays || 14} days.`,
      'Inviter must be an active Up customer with a verified email and at least one completed purchase.',
      'Invitee must use the invited phone number during sign-up.'
    ],
    notes: [
      'Bonus funds cannot be sent until the account is funded by the customer.',
      maxReward ? `Reward increases by $1 for each full year of Upsider tenure, up to $${formatNumberValue(maxReward)}.` : '',
      'Up publishes referral conditions through its Promotions and Competitions hub.'
    ],
    termsFingerprintSource: termsText,
    stabilityScoreOverride: 78,
    estimatedActivationCapitalAud: 0,
    estimatedPayoutDays: 1,
    estimatedSetupMinutes: 12
  }, nowIso)];
}

export function extractCoinSpotOfferFromPages({ pages, nowIso = new Date().toISOString() }) {
  const offerText = getPageText(pages, 'offer');
  const termsText = `${offerText} ${getPageText(pages, 'terms')}`;
  const reward = extractFirstNumber(offerText, [
    /both parties will receive \$\s*([0-9]+(?:\.[0-9]+)?)\s*free BTC/i,
    /receive \$\s*([0-9]+(?:\.[0-9]+)?)\s*worth of Bitcoin/i,
    /receive \$\s*([0-9]+(?:\.[0-9]+)?)\s*free BTC/i
  ]);

  return [finalizeReferralOffer({
    id: 'coinspot-referrals',
    sourceId: 'coinspot',
    brand: 'CoinSpot',
    title: 'Referral Program',
    category: 'crypto',
    status: reward ? 'active' : (hasInactiveSignal(offerText) ? 'inactive' : 'review_required'),
    rewardType: 'crypto',
    rewardSummary: reward
      ? `Both parties receive ${formatAudAmount(reward)} worth of BTC after the referred friend completes their first AUD deposit.`
      : 'CoinSpot referral reward is controlled by the live referrals page.',
    rewardValueReferrerAud: reward,
    rewardValueRefereeAud: reward,
    requiresKyc: true,
    requiresDeposit: true,
    requiresTrade: false,
    requiresPurchase: false,
    publicShareability: 'allowed',
    abuseRisk: 'medium',
    shareabilityNote: 'Referral page explicitly supports sharing by email, Twitter, or Facebook. CoinSpot terms still prohibit spam, scraping, and abuse of promotions.',
    confidence: 'high',
    officialOfferUrl: 'https://www.coinspot.com.au/referrals',
    officialTermsUrl: 'https://www.coinspot.com.au/terms',
    termsLastUpdatedText: extractLastUpdatedText(getPageText(pages, 'terms')),
    qualificationSteps: [
      'Referee must sign up using the referral code or invite link at registration.',
      'Both parties must hold verified CoinSpot accounts.',
      'The referred friend must complete their first AUD deposit.'
    ],
    notes: [
      'CoinSpot can suspend or terminate accounts for abuse of promotions or referral programs.',
      'CoinSpot terms prohibit data scraping, collection tools, and other systematic extraction from the platform.'
    ],
    termsFingerprintSource: termsText,
    stabilityScoreOverride: 72,
    estimatedActivationCapitalAud: 5,
    estimatedPayoutDays: 2,
    estimatedSetupMinutes: 18
  }, nowIso)];
}

export function extractSwyftxOfferFromPages({ pages, nowIso = new Date().toISOString() }) {
  const offerText = getPageText(pages, 'offer');
  const termsText = `${offerText} ${getPageText(pages, 'terms')}`;
  const reward = extractFirstNumber(offerText, [
    /both score \$\s*([0-9]+(?:\.[0-9]+)?)\s*AUD of Bitcoin/i,
    /both automatically get \$\s*([0-9]+(?:\.[0-9]+)?)\s*AUD of Bitcoin/i
  ]);
  const qualificationWindowDays = extractFirstNumber(offerText, [
    /within\s+([0-9]+)\s+days of sign up/i,
    /within\s+([0-9]+)\s+days of their account registration/i
  ]);

  return [finalizeReferralOffer({
    id: 'swyftx-refer-a-friend',
    sourceId: 'swyftx',
    brand: 'Swyftx',
    title: 'Refer a Friend',
    category: 'crypto',
    status: reward ? 'active' : (hasInactiveSignal(offerText) ? 'inactive' : 'review_required'),
    rewardType: 'crypto',
    rewardSummary: reward
      ? `Both parties receive ${formatAudAmount(reward)} worth of BTC after the referee verifies, deposits fiat, and trades.`
      : 'Reward amount is controlled by the live Swyftx referral page and platform terms.',
    rewardValueReferrerAud: reward,
    rewardValueRefereeAud: reward,
    qualificationWindowDays: qualificationWindowDays || 30,
    requiresKyc: true,
    requiresDeposit: true,
    requiresTrade: true,
    requiresPurchase: false,
    publicShareability: 'caution',
    abuseRisk: 'medium',
    shareabilityNote: 'Swyftx encourages inviting friends and family, but referral terms ban spam, deceptive marketing, and false or misleading statements.',
    confidence: 'high',
    officialOfferUrl: 'https://swyftx.com/au/refer-a-friend/',
    officialTermsUrl: 'https://swyftx.com/terms-of-use/',
    termsLastUpdatedText: extractLastUpdatedText(getPageText(pages, 'terms')),
    qualificationSteps: [
      'Referee must register using the referrer\'s code.',
      'Both parties must complete identity verification.',
      `The referee must deposit fiat and complete at least one trade within ${qualificationWindowDays || 30} days of registration.`
    ],
    notes: [
      'Swyftx can modify, suspend, or terminate the referral program at any time.',
      'The value and type of the referral bonus is the amount published on the platform when the referee registers.'
    ],
    termsFingerprintSource: termsText,
    stabilityScoreOverride: 68,
    estimatedActivationCapitalAud: 10,
    estimatedPayoutDays: 3,
    estimatedSetupMinutes: 24
  }, nowIso)];
}

export function extractStakeOffersFromPages({ pages, nowIso = new Date().toISOString() }) {
  const supportText = getPageText(pages, 'support');
  const ausText = `${supportText} ${getPageText(pages, 'ausTerms')} ${getPageText(pages, 'landing')}`;
  const wallText = `${supportText} ${getPageText(pages, 'wallTerms')} ${getPageText(pages, 'landing')}`;
  const minFunding = extractFirstNumber(`${ausText} ${wallText}`, [
    /at least \$\s*([0-9]+(?:\.[0-9]+)?)\s*AUD/i,
    /qualified funding is a deposit \(funding\) of at least \$\s*([0-9]+(?:\.[0-9]+)?)\s*AUD/i
  ]);

  return [
    finalizeReferralOffer({
      id: 'stake-aus-referral',
      sourceId: 'stake',
      brand: 'Stake',
      title: 'Stake AUS Referral Rewards',
      category: 'brokerage',
      status: /referring someone to stake aus gives you discounted asx brokerage/i.test(ausText) || /stake rewards allows existing, registered stake aus users/i.test(ausText)
        ? 'active'
        : (hasInactiveSignal(ausText) ? 'inactive' : 'review_required'),
      rewardType: 'mixed',
      rewardSummary: 'Referrer earns $1 off Stake AUS brokerage per trade for 12 months. Referred person can receive A$10 of buying power after a qualified funding.',
      rewardValueReferrerAud: null,
      rewardValueRefereeAud: 10,
      qualificationWindowDays: 1,
      minDepositAud: minFunding || 50,
      requiresKyc: true,
      requiresDeposit: true,
      requiresTrade: false,
      requiresPurchase: false,
      publicShareability: 'caution',
      abuseRisk: 'medium',
      shareabilityNote: 'Stake encourages responsible sharing of referral codes, but retains broad discretion to suspend rewards, accounts, or abusive referral activity.',
      confidence: 'high',
      officialOfferUrl: 'https://hellostake.com/au/support/rewards/referral-reward/26011628598681',
      officialTermsUrl: 'https://hellostake.com/au/legal/stake-aus-rewards-terms-conditions',
      termsLastUpdatedText: extractLastUpdatedText(getPageText(pages, 'ausTerms')),
      qualificationSteps: [
        'Referee must enter the referral code during Stake AUS sign-up.',
        'Referee must create a valid individual account in the same jurisdiction as the referrer.',
        `Referee must make a qualified Stake AUS funding of at least ${formatAudAmount(minFunding || 50)}.`
      ],
      notes: [
        'The referrer\'s discounted brokerage is capped at 10 ASX trades per month.',
        'Additional referrals can be banked once three active discounts are in place.',
        'Stake can refuse rewards where it believes an account or funding was not made for a proper investment purpose.'
      ],
      termsFingerprintSource: ausText,
      rewardScoreOverride: 48,
      stabilityScoreOverride: 65,
      estimatedActivationCapitalAud: minFunding || 50,
      estimatedPayoutDays: 4,
      estimatedSetupMinutes: 24
    }, nowIso),
    finalizeReferralOffer({
      id: 'stake-wall-st-referral',
      sourceId: 'stake',
      brand: 'Stake',
      title: 'Stake Wall St Referral Rewards',
      category: 'brokerage',
      status: /stake wall st users with an individual account/i.test(wallText) || /you\'ll receive a free u\.s\. stock/i.test(wallText)
        ? 'active'
        : (hasInactiveSignal(wallText) ? 'inactive' : 'review_required'),
      rewardType: 'stock',
      rewardSummary: 'Referrer receives a random U.S. stock. Referred person can unlock a starter stock after qualified funding. Most people receive stock worth less than $10 USD.',
      rewardValueReferrerAud: null,
      rewardValueRefereeAud: null,
      qualificationWindowDays: 1,
      minDepositAud: minFunding || 50,
      requiresKyc: true,
      requiresDeposit: true,
      requiresTrade: false,
      requiresPurchase: false,
      publicShareability: 'caution',
      abuseRisk: 'medium',
      shareabilityNote: 'Stake supports responsible sharing of referral codes, but can suspend rewards, accounts, or referral activity it views as abusive or inconsistent with brand values.',
      confidence: 'high',
      officialOfferUrl: 'https://hellostake.com/au/support/rewards/referral-reward/26011628598681',
      officialTermsUrl: 'https://hellostake.com/au/legal/stake-wall-st-rewards-terms-conditions',
      termsLastUpdatedText: extractLastUpdatedText(getPageText(pages, 'wallTerms')),
      qualificationSteps: [
        'Referee must enter the referral code during Stake Wall St sign-up.',
        'Referee must create a valid individual account in the same jurisdiction as the referrer.',
        `Referee must fund the account with at least ${formatAudAmount(minFunding || 50)} to qualify.`
      ],
      notes: [
        'Most people receive a stock worth less than $10 USD.',
        'The referred person typically needs to fund within 24 hours of first viewing the dashboard to receive their free starter stock.',
        'Stake can suspend rewards or accounts for abusive referral activity or reward-only account creation.'
      ],
      termsFingerprintSource: wallText,
      rewardScoreOverride: 55,
      stabilityScoreOverride: 60,
      estimatedActivationCapitalAud: minFunding || 50,
      estimatedPayoutDays: 4,
      estimatedSetupMinutes: 24
    }, nowIso)
  ];
}

export function extractRaizOfferFromPages({ pages, nowIso = new Date().toISOString() }) {
  const termsText = getPageText(pages, 'terms');
  const blogText = getPageText(pages, 'blog');
  const currentTermsSignal = /responsible entity may, in its absolute discretion, determine to pay a referral fee/i.test(termsText);
  const historicalReward = extractFirstNumber(blogText, [
    /referral bonus of \$\s*([0-9]+(?:\.[0-9]+)?)/i
  ]);
  const initialInvestment = extractFirstNumber(blogText, [
    /initial investment of \$\s*([0-9]+(?:\.[0-9]+)?)/i
  ]);

  return [finalizeReferralOffer({
    id: 'raiz-referral-fee',
    sourceId: 'raiz',
    brand: 'Raiz',
    title: 'Referral Fee Monitor',
    category: 'microinvesting',
    status: currentTermsSignal ? 'review_required' : 'inactive',
    rewardType: 'cash',
    rewardSummary: historicalReward
      ? `Raiz still documents a referral-fee framework, but the current live amount is not clearly published on the public site. A historical public example advertised $${formatNumberValue(historicalReward)} each after the referee\'s first ${formatAudAmount(initialInvestment || 5)} investment.`
      : 'Raiz still documents a referral-fee framework, but the current live amount is not clearly published on the public site.',
    rewardValueReferrerAud: null,
    rewardValueRefereeAud: null,
    minDepositAud: initialInvestment || 5,
    requiresKyc: true,
    requiresDeposit: true,
    requiresTrade: false,
    requiresPurchase: false,
    publicShareability: 'review_required',
    abuseRisk: 'medium',
    shareabilityNote: 'Raiz terms say the website and app will publish when referral fees start, their amount, and when they end. The current public amount needs review before posting.',
    confidence: 'low',
    officialOfferUrl: 'https://raizinvest.com.au/blog/share-stories-invite-friends-get-cash/',
    officialTermsUrl: 'https://raizinvest.com.au/terms',
    termsLastUpdatedText: extractLastUpdatedText(termsText),
    qualificationSteps: [
      'Referrer and referee must be separate people.',
      'The referee must open a new Raiz investment account using the referral flow.',
      `Historical public copy required the referee to make an initial investment of at least ${formatAudAmount(initialInvestment || 5)}.`
    ],
    notes: [
      'Raiz terms say the website and app will announce when referral fees commence, the amount, and when they end.',
      'Historical public copy encouraged sharing by social media, email, or text.',
      'Current live reward amount is not clearly exposed on the public website, so this offer should stay in review state until confirmed.'
    ],
    termsFingerprintSource: `${termsText} ${blogText}`,
    rewardScoreOverride: 20,
    stabilityScoreOverride: 35,
    estimatedActivationCapitalAud: initialInvestment || 5,
    estimatedPayoutDays: 5,
    estimatedSetupMinutes: 18
  }, nowIso)];
}

const REFERRAL_SOURCE_DEFINITIONS = [{
  id: 'up',
  pages: [{ key: 'offer', url: 'https://up.com.au/hook_up_a_mate/' }, { key: 'promotions', url: 'https://up.com.au/promotions/' }, { key: 'terms', url: 'https://up.com.au/terms/' }],
  extract: extractUpOfferFromPages
}, {
  id: 'stake',
  pages: [{ key: 'landing', url: 'https://hellostake.com/au/referral-code' }, { key: 'support', url: 'https://hellostake.com/au/support/rewards/referral-reward/26011628598681' }, { key: 'ausTerms', url: 'https://hellostake.com/au/legal/stake-aus-rewards-terms-conditions' }, { key: 'wallTerms', url: 'https://hellostake.com/au/legal/stake-wall-st-rewards-terms-conditions' }],
  extract: extractStakeOffersFromPages
}, {
  id: 'coinspot',
  pages: [{ key: 'offer', url: 'https://www.coinspot.com.au/referrals' }, { key: 'terms', url: 'https://www.coinspot.com.au/terms' }],
  extract: extractCoinSpotOfferFromPages
}, {
  id: 'swyftx',
  pages: [{ key: 'offer', url: 'https://swyftx.com/au/refer-a-friend/' }, { key: 'terms', url: 'https://swyftx.com/terms-of-use/' }],
  extract: extractSwyftxOfferFromPages
}, {
  id: 'raiz',
  pages: [{ key: 'blog', url: 'https://raizinvest.com.au/blog/share-stories-invite-friends-get-cash/' }, { key: 'terms', url: 'https://raizinvest.com.au/terms' }],
  extract: extractRaizOfferFromPages
}];

async function fetchPublicPage(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'User-Agent': REFERRAL_FETCH_USER_AGENT
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url} (${response.status})`);
    }

    const html = await response.text();

    return {
      url: response.url || url,
      html,
      text: normalizePublicPageText(html)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectReferralOffers(options = {}) {
  const nowIso = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || 30000);
  const previousOffers = Array.isArray(options.previousOffers) ? options.previousOffers : [];
  const previousBySource = previousOffers.reduce((map, offer) => {
    const bucket = map.get(offer.sourceId) || [];
    bucket.push(offer);
    map.set(offer.sourceId, bucket);
    return map;
  }, new Map());
  const offers = [];
  const fetchFailures = [];

  for (const sourceDefinition of REFERRAL_SOURCE_DEFINITIONS) {
    const pages = {};
    let fetchError = null;

    for (const page of sourceDefinition.pages) {
      try {
        pages[page.key] = await fetchPublicPage(page.url, fetchImpl, timeoutMs);
      } catch (error) {
        fetchError = error;
        break;
      }
    }

    if (fetchError) {
      const staleOffers = (previousBySource.get(sourceDefinition.id) || []).map((offer) => ({
        ...offer,
        syncState: 'stale',
        lastAttemptAt: nowIso,
        fetchError: String(fetchError.message || fetchError)
      }));

      if (staleOffers.length) {
        offers.push(...staleOffers);
      } else {
        fetchFailures.push({
          sourceId: sourceDefinition.id,
          error: String(fetchError.message || fetchError)
        });
      }

      continue;
    }

    offers.push(...sourceDefinition.extract({ pages, nowIso }));
  }

  const knownUrls = [
    ...previousOffers.flatMap((offer) => [offer?.officialOfferUrl, offer?.officialTermsUrl]),
    ...offers.flatMap((offer) => [offer?.officialOfferUrl, offer?.officialTermsUrl]),
    ...REFERRAL_SOURCE_DEFINITIONS.flatMap((sourceDefinition) => sourceDefinition.pages.map((page) => page.url))
  ].map(normalizeComparableUrl).filter(Boolean);

  offers.push(...await collectSearchDiscoveredOffers({
    nowIso,
    fetchImpl,
    timeoutMs,
    knownUrls
  }));

  return {
    offers: dedupeReferralOffers(offers).sort(compareOffers),
    fetchFailures
  };
}

function offerToComparisonFields(offer) {
  return {
    status: offer.status,
    rewardSummary: offer.rewardSummary,
    rewardValueReferrerAud: offer.rewardValueReferrerAud,
    rewardValueRefereeAud: offer.rewardValueRefereeAud,
    qualificationWindowDays: offer.qualificationWindowDays,
    minDepositAud: offer.minDepositAud,
    requiresKyc: offer.requiresKyc,
    requiresDeposit: offer.requiresDeposit,
    requiresTrade: offer.requiresTrade,
    requiresPurchase: offer.requiresPurchase,
    publicShareability: offer.publicShareability,
    shareabilityNote: offer.shareabilityNote,
    termsLastUpdatedText: offer.termsLastUpdatedText,
    offerFingerprint: offer.offerFingerprint,
    termsFingerprint: offer.termsFingerprint
  };
}

function buildMaterialChangeList(previousOffer, nextOffer) {
  const previous = offerToComparisonFields(previousOffer);
  const next = offerToComparisonFields(nextOffer);
  const changes = [];

  if (previous.status !== next.status) {
    changes.push(`Status changed from ${previous.status} to ${next.status}.`);
  }

  if (previous.rewardSummary !== next.rewardSummary) {
    changes.push(`Reward summary changed to: ${next.rewardSummary}`);
  }

  if (previous.rewardValueReferrerAud !== next.rewardValueReferrerAud || previous.rewardValueRefereeAud !== next.rewardValueRefereeAud) {
    changes.push('Reward values changed.');
  }

  if (previous.qualificationWindowDays !== next.qualificationWindowDays) {
    changes.push(`Qualification window changed to ${next.qualificationWindowDays || 'unspecified'} day(s).`);
  }

  if (previous.minDepositAud !== next.minDepositAud) {
    changes.push(`Minimum deposit changed to ${next.minDepositAud ? formatAudAmount(next.minDepositAud) : 'unspecified'}.`);
  }

  if (previous.requiresTrade !== next.requiresTrade || previous.requiresDeposit !== next.requiresDeposit || previous.requiresKyc !== next.requiresKyc || previous.requiresPurchase !== next.requiresPurchase) {
    changes.push('Qualification steps changed.');
  }

  if (!changes.length && previous.termsFingerprint !== next.termsFingerprint) {
    changes.push('Official terms content changed.');
  }

  if (!changes.length && previous.offerFingerprint !== next.offerFingerprint) {
    changes.push('Offer page content changed.');
  }

  return dedupeList(changes);
}

function mergeReferralLifecycle(previousOffer, nextOffer, nowIso) {
  const previousVerificationStatus = previousOffer ? inferLegacyVerificationStatus(previousOffer) : '';
  const nextVerificationStatus = nextOffer?.verificationStatus || previousVerificationStatus || 'pending';
  const materialChanges = previousOffer ? buildMaterialChangeList(previousOffer, nextOffer) : [];

  return finalizeReferralOffer({
    ...nextOffer,
    verificationStatus: nextVerificationStatus,
    verificationNotes: nextOffer?.verificationNotes || previousOffer?.verificationNotes || '',
    discoverySource: nextOffer?.discoverySource || previousOffer?.discoverySource || 'curated',
    discoveredAt: previousOffer?.discoveredAt || nextOffer?.discoveredAt || nowIso,
    verifiedAt: nextVerificationStatus === 'verified'
      ? (nextOffer?.verifiedAt || previousOffer?.verifiedAt || nowIso)
      : '',
    lastMaterialChangeAt: materialChanges.length
      ? nowIso
      : (nextOffer?.lastMaterialChangeAt || previousOffer?.lastMaterialChangeAt || ''),
    lastSeenAt: nextOffer?.lastSeenAt || nowIso,
    lastSuccessfulSyncAt: nextOffer?.lastSuccessfulSyncAt || nowIso,
    lastAttemptAt: nextOffer?.lastAttemptAt || nowIso
  }, nowIso);
}

export function diffReferralOffers(previousOffers, currentOffers) {
  const previousById = new Map((Array.isArray(previousOffers) ? previousOffers : []).map((offer) => [offer.id, offer]));
  const events = {
    new: [],
    updated_terms: [],
    cancelled: []
  };

  for (const offer of Array.isArray(currentOffers) ? currentOffers : []) {
    const previousOffer = previousById.get(offer.id);

    if (!previousOffer) {
      if (offer.status === 'active') {
        events.new.push({
          type: 'new',
          offer,
          changes: [],
          revived: false
        });
      }

      continue;
    }

    if (previousOffer.status === 'inactive' && offer.status === 'active') {
      events.new.push({
        type: 'new',
        offer,
        previousOffer,
        changes: buildMaterialChangeList(previousOffer, offer),
        revived: true
      });
      continue;
    }

    if (previousOffer.status === 'active' && offer.status === 'inactive') {
      events.cancelled.push({
        type: 'cancelled',
        offer,
        previousOffer,
        changes: buildMaterialChangeList(previousOffer, offer)
      });
      continue;
    }

    const changes = buildMaterialChangeList(previousOffer, offer);

    if (changes.length) {
      events.updated_terms.push({
        type: 'updated_terms',
        offer,
        previousOffer,
        changes
      });
    }
  }

  for (const key of Object.keys(events)) {
    events[key].sort((left, right) => compareOffers(left.offer, right.offer));
  }

  return events;
}

async function loadJsonFile(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return fallbackValue;
    }

    throw error;
  }
}

async function saveJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function formatRequirementSummary(offer) {
  if (Array.isArray(offer?.qualificationSteps) && offer.qualificationSteps.length) {
    return offer.qualificationSteps.join('\n');
  }

  const parts = [];

  if (offer?.requiresKyc) {
    parts.push('KYC required');
  }

  if (offer?.requiresDeposit) {
    parts.push(`Deposit${offer?.minDepositAud ? ` ${formatAudAmount(offer.minDepositAud)}` : ''}`);
  }

  if (offer?.requiresTrade) {
    parts.push('Trade required');
  }

  if (offer?.requiresPurchase) {
    parts.push('Purchase required');
  }

  if (offer?.qualificationWindowDays) {
    parts.push(`${offer.qualificationWindowDays} day window`);
  }

  return parts.join('\n') || 'See official page';
}

function truncateText(value, maxLength) {
  const source = String(value || '').trim();

  if (source.length <= maxLength) {
    return source;
  }

  return `${source.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function formatShareabilityLabel(value) {
  return String(value || 'review_required')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatStatusLabel(value) {
  return String(value || 'review_required')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function buildReferralVerificationField(offer) {
  const lines = [
    `Approval: ${formatVerificationStatusLabel(inferLegacyVerificationStatus(offer))}`,
    `Discovery: ${formatDiscoverySourceLabel(offer.discoverySource)}`,
    `Confidence: ${formatStatusLabel(offer.confidence || 'medium')}`
  ];

  if (offer?.verifiedAt) {
    lines.push(`Verified at: ${offer.verifiedAt}`);
  } else if (offer?.discoveredAt) {
    lines.push(`Discovered at: ${offer.discoveredAt}`);
  }

  if (offer?.lastSuccessfulSyncAt) {
    lines.push(`Last checked: ${offer.lastSuccessfulSyncAt}`);
  }

  return lines.join('\n');
}

function buildReferralNotesField(offer) {
  const lines = [];

  lines.push(`Shareability: ${formatShareabilityLabel(offer.publicShareability)}`);

  if (offer?.shareabilityNote) {
    lines.push(`Policy: ${offer.shareabilityNote}`);
  }

  for (const note of dedupeList(offer?.notes).slice(0, 3)) {
    lines.push(note);
  }

  if (offer?.verificationNotes) {
    lines.push(`Verification note: ${offer.verificationNotes}`);
  }

  return lines.join('\n') || 'No extra notes.';
}

function buildReferralDetailEmbed(offer, options = {}) {
  const fields = [{
    name: 'Reward',
    value: truncateText(offer.rewardSummary || 'See official page', 1000),
    inline: false
  }, {
    name: 'Requirements',
    value: truncateText(formatRequirementSummary(offer), 1000),
    inline: false
  }, {
    name: 'Verification',
    value: truncateText(buildReferralVerificationField(offer), 1000),
    inline: false
  }, {
    name: 'Notes',
    value: truncateText(buildReferralNotesField(offer), 1000),
    inline: false
  }];

  if (Array.isArray(options.changes) && options.changes.length) {
    fields.push({
      name: 'Material Changes',
      value: truncateText(options.changes.join('\n'), 1000),
      inline: false
    });
  }

  fields.push({
    name: 'Official Sources',
    value: truncateText(buildSourcesField(offer), 1000),
    inline: false
  });

  return {
    title: options.title || offer.brand,
    color: options.color || 0x2563eb,
    description: `${offer.title}\nStatus: ${formatStatusLabel(offer.status)} | Approval: ${formatVerificationStatusLabel(inferLegacyVerificationStatus(offer))} | Score: ${offer.scores?.overall ?? 0}/100`,
    fields,
    footer: {
      text: options.footerText || (offer.termsLastUpdatedText ? `Official marker: ${offer.termsLastUpdatedText}` : 'Official public-page monitor')
    }
  };
}

function buildSourcesField(offer) {
  const sources = dedupeList([offer?.officialOfferUrl, offer?.officialTermsUrl]);
  return sources.join('\n') || 'No source captured';
}

function buildReferralEventMessage(event) {
  const colorByType = {
    new: 0x16a34a,
    updated_terms: 0xf59e0b,
    cancelled: 0xdc2626
  };
  const titleByType = {
    new: 'New Referral',
    updated_terms: 'Updated Terms',
    cancelled: 'Cancelled Referral'
  };
  const offer = event.offer;
  const title = event.type === 'new' && event.revived
    ? `Referral Reopened | ${offer.brand}`
    : `${titleByType[event.type]} | ${offer.brand}`;

  return {
    content: '',
    embeds: [buildReferralDetailEmbed(offer, {
      title,
      color: colorByType[event.type] || 0x2563eb,
      changes: event.type === 'updated_terms' || event.type === 'cancelled' ? event.changes : [],
      footerText: offer.termsLastUpdatedText ? `Official marker: ${offer.termsLastUpdatedText}` : 'Official public-page monitor'
    })]
  };
}

export function buildReferralMasterlistMessage(catalog) {
  const offers = getMasterlistReferralOffers(catalog);
  const counts = catalog?.counts || buildReferralCatalogCounts(catalog?.offers || []);
  const overflowCount = Math.max(0, offers.length - REFERRAL_MASTERLIST_EMBED_LIMIT);

  if (!offers.length) {
    return {
      content: `Verified referral masterlist updated ${catalog?.updatedAt || 'just now'} | 0 verified | ${counts.pendingActive} pending review${counts.inactive ? ` | ${counts.inactive} inactive` : ''}`,
      embeds: [buildReferralDetailEmbed({
        brand: 'Referral Masterlist',
        title: 'No verified referrals yet',
        status: 'review_required',
        rewardSummary: 'Verify referrals from the New Referrals queue to promote them into the live masterlist.',
        qualificationSteps: ['Run the referrals monitor to discover offers.', 'Use the desktop verification action to approve valid referrals.'],
        publicShareability: 'review_required',
        shareabilityNote: 'Only verified active offers appear in this masterlist.',
        notes: [],
        officialOfferUrl: '',
        officialTermsUrl: '',
        verificationStatus: 'pending',
        discoverySource: 'curated',
        confidence: 'medium',
        scores: { overall: 0 }
      }, {
        title: 'Referral Masterlist',
        color: 0x1d4ed8,
        footerText: 'Verified offers are promoted here after manual approval.'
      })]
    };
  }

  return {
    content: `Verified referral masterlist updated ${catalog?.updatedAt || 'just now'} | ${offers.length} verified | ${counts.pendingActive} pending review${counts.inactive ? ` | ${counts.inactive} inactive` : ''}${overflowCount > 0 ? ` | Showing top ${REFERRAL_MASTERLIST_EMBED_LIMIT}` : ''}`,
    embeds: offers.slice(0, REFERRAL_MASTERLIST_EMBED_LIMIT).map((offer, index) => buildReferralDetailEmbed(offer, {
      title: `#${index + 1} ${offer.brand} | Verified`,
      color: 0x1d4ed8,
      footerText: overflowCount > 0 && index === REFERRAL_MASTERLIST_EMBED_LIMIT - 1
        ? `Showing ${REFERRAL_MASTERLIST_EMBED_LIMIT} of ${offers.length} verified offers.`
        : (offer.termsLastUpdatedText ? `Official marker: ${offer.termsLastUpdatedText}` : 'Verified referral masterlist entry')
    }))
  };
}

async function sendReferralWebhookMessage(config, channel, message, dryRun, label) {
  const automatedMessage = buildAutomatedMessage(config, channel, message);

  return sendWebhookMessage(
    config.discord?.webhooks?.[channel] || '',
    {
      content: automatedMessage.content,
      embeds: automatedMessage.embeds,
      username: config.discord.username,
      avatar_url: config.discord.avatarUrl || undefined,
      allowed_mentions: automatedMessage.allowedMentions
    },
    {
      dryRun,
      label
    }
  );
}

function getTrackedReferralPost(state, offerId) {
  state.posts ??= {};
  state.posts.referrals ??= {};
  state.posts.referrals.offers ??= {};
  state.posts.referrals.offers[offerId] ??= {
    newMessageId: '',
    cancelledMessageId: ''
  };
  return state.posts.referrals.offers[offerId];
}

async function clearTrackedReferralMessage(config, state, dryRun, offerId, fieldKey, channel, label) {
  const trackedPost = getTrackedReferralPost(state, offerId);
  const messageId = trackedPost[fieldKey] || '';

  if (!messageId) {
    return;
  }

  try {
    await deleteWebhookMessage(config.discord?.webhooks?.[channel] || '', messageId, {
      dryRun,
      label
    });
  } catch (error) {
    console.warn(`Unable to delete tracked referral message (${label}): ${error.message}`);
  }

  trackedPost[fieldKey] = '';
}

async function replaceTrackedReferralMessage(config, state, dryRun, offerId, fieldKey, channel, message, label) {
  await clearTrackedReferralMessage(config, state, dryRun, offerId, fieldKey, channel, `${label} delete`);
  const response = await sendReferralWebhookMessage(config, channel, message, dryRun, label);
  getTrackedReferralPost(state, offerId)[fieldKey] = response?.id || '';
  return response;
}

async function publishReferralLifecycleEvents(config, state, dryRun, diff) {
  let posted = 0;

  for (const event of diff.cancelled) {
    await clearTrackedReferralMessage(config, state, dryRun, event.offer.id, 'newMessageId', REFERRAL_WEBHOOK_CHANNELS.new, `cancelled referral clear new | ${event.offer.brand}`);
    await replaceTrackedReferralMessage(
      config,
      state,
      dryRun,
      event.offer.id,
      'cancelledMessageId',
      REFERRAL_WEBHOOK_CHANNELS.cancelled,
      buildReferralEventMessage(event),
      `cancelled referral | ${event.offer.brand}`
    );
    posted += 1;
  }

  for (const event of diff.new) {
    await clearTrackedReferralMessage(config, state, dryRun, event.offer.id, 'cancelledMessageId', REFERRAL_WEBHOOK_CHANNELS.cancelled, `reopened referral clear cancelled | ${event.offer.brand}`);

    if (inferLegacyVerificationStatus(event.offer) === 'verified') {
      await clearTrackedReferralMessage(config, state, dryRun, event.offer.id, 'newMessageId', REFERRAL_WEBHOOK_CHANNELS.new, `verified referral clear new | ${event.offer.brand}`);
      continue;
    }

    await replaceTrackedReferralMessage(
      config,
      state,
      dryRun,
      event.offer.id,
      'newMessageId',
      REFERRAL_WEBHOOK_CHANNELS.new,
      buildReferralEventMessage(event),
      `${event.revived ? 'reopened' : 'new'} referral | ${event.offer.brand}`
    );
    posted += 1;
  }

  for (const event of diff.updated_terms) {
    await sendReferralWebhookMessage(
      config,
      REFERRAL_WEBHOOK_CHANNELS.updated,
      buildReferralEventMessage(event),
      dryRun,
      `updated referral | ${event.offer.brand}`
    );
    posted += 1;

    if (event.offer.status === 'active' && inferLegacyVerificationStatus(event.offer) !== 'verified') {
      await replaceTrackedReferralMessage(
        config,
        state,
        dryRun,
        event.offer.id,
        'newMessageId',
        REFERRAL_WEBHOOK_CHANNELS.new,
        buildReferralEventMessage({
          type: 'new',
          offer: event.offer,
          changes: [],
          revived: false
        }),
        `refresh new referral | ${event.offer.brand}`
      );
    }
  }

  return posted;
}

async function refreshMasterlist(config, state, dryRun, catalog) {
  state.posts ??= {};
  state.posts.referrals ??= {};
  const previousMessageId = state.posts.referrals.masterlistMessageId || '';
  const webhookKey = REFERRAL_WEBHOOK_CHANNELS.masterlist;
  const webhookUrl = config.discord?.webhooks?.[webhookKey] || '';

  if (!dryRun && !webhookUrl) {
    state.posts.referrals.masterlistUpdatedAt = catalog.updatedAt;
    return;
  }

  if (previousMessageId) {
    try {
      await deleteWebhookMessage(webhookUrl, previousMessageId, {
        dryRun,
        label: 'referrals masterlist delete'
      });
    } catch (error) {
      console.warn(`Unable to delete previous referrals masterlist message: ${error.message}`);
    }
  }

  const response = await sendReferralWebhookMessage(
    config,
    webhookKey,
    buildReferralMasterlistMessage(catalog),
    dryRun,
    'referrals masterlist'
  );

  state.posts.referrals.masterlistMessageId = response?.id || '';
  state.posts.referrals.masterlistUpdatedAt = catalog.updatedAt;
}

export async function setReferralVerification(context, payload = {}) {
  const { config, state, dryRun } = context;
  const offerId = String(payload.offerId || '').trim();

  if (!offerId) {
    throw new Error('A referral offer id is required.');
  }

  const requestedStatus = String(payload.verificationStatus || 'verified').trim().toLowerCase();

  if (requestedStatus !== 'verified' && requestedStatus !== 'pending') {
    throw new Error('Unsupported referral verification status.');
  }

  const now = payload.now instanceof Date ? payload.now : new Date();
  const nowIso = now.toISOString();
  const catalog = await loadJsonFile(config.__paths.referralsCatalogFile, { offers: [], updatedAt: null, fetchFailures: [], capitalPlan: null, counts: buildReferralCatalogCounts([]) });
  const offerIndex = Array.isArray(catalog?.offers) ? catalog.offers.findIndex((offer) => offer.id === offerId) : -1;

  if (offerIndex === -1) {
    throw new Error(`Referral offer not found: ${offerId}`);
  }

  const previousOffer = catalog.offers[offerIndex];
  const updatedOffer = finalizeReferralOffer({
    ...previousOffer,
    verificationStatus: requestedStatus,
    verifiedAt: requestedStatus === 'verified' ? (previousOffer.verifiedAt || nowIso) : '',
    verificationNotes: String(payload.verificationNotes || previousOffer.verificationNotes || '').trim(),
    lastAttemptAt: nowIso,
    lastSuccessfulSyncAt: previousOffer.lastSuccessfulSyncAt || nowIso
  }, nowIso);

  catalog.offers[offerIndex] = updatedOffer;
  catalog.updatedAt = nowIso;
  catalog.counts = buildReferralCatalogCounts(catalog.offers);
  catalog.capitalPlan = buildReferralCapitalPlan(getMasterlistReferralOffers(catalog), { startingCapitalAud: 10 });

  await saveJsonFile(config.__paths.referralsCatalogFile, catalog);

  if (requestedStatus === 'verified') {
    await clearTrackedReferralMessage(config, state, dryRun, offerId, 'newMessageId', REFERRAL_WEBHOOK_CHANNELS.new, `verify referral clear new | ${updatedOffer.brand}`);
  }

  await refreshMasterlist(config, state, dryRun, catalog);

  return {
    offerId,
    verificationStatus: updatedOffer.verificationStatus,
    verifiedAt: updatedOffer.verifiedAt || null,
    masterlistUpdatedAt: state.posts?.referrals?.masterlistUpdatedAt || catalog.updatedAt
  };
}

export async function runReferralsJob(context, overrides = {}) {
  const { config, state, dryRun } = context;
  const now = overrides.now || new Date();
  const nowIso = now.toISOString();
  const dateKey = getDateKey(now, config.timezone);
  const previousCatalog = await loadJsonFile(config.__paths.referralsCatalogFile, { offers: [], updatedAt: null, fetchFailures: [], capitalPlan: null, counts: buildReferralCatalogCounts([]) });
  const previousHistory = await loadJsonFile(config.__paths.referralsHistoryFile, { updatedAt: null, events: [] });
  const collected = await collectReferralOffers({
    now,
    previousOffers: previousCatalog.offers,
    fetchImpl: overrides.fetchImpl,
    timeoutMs: config.referrals?.requestTimeoutMs || 30000
  });
  const offers = collected.offers.map((offer) => mergeReferralLifecycle(previousCatalog.offers.find((candidate) => candidate.id === offer.id), offer, nowIso));
  const fetchFailures = collected.fetchFailures;
  const diff = diffReferralOffers(previousCatalog.offers, offers);
  const counts = buildReferralCatalogCounts(offers);
  const capitalPlan = buildReferralCapitalPlan(getMasterlistReferralOffers({ offers }), { startingCapitalAud: 10 });
  const catalog = {
    updatedAt: nowIso,
    offers,
    fetchFailures,
    capitalPlan,
    counts
  };
  const history = {
    updatedAt: nowIso,
    events: [
      ...diff.new.map((event) => ({ at: nowIso, type: event.type, offerId: event.offer.id, brand: event.offer.brand, title: event.offer.title, changes: event.changes })),
      ...diff.updated_terms.map((event) => ({ at: nowIso, type: event.type, offerId: event.offer.id, brand: event.offer.brand, title: event.offer.title, changes: event.changes })),
      ...diff.cancelled.map((event) => ({ at: nowIso, type: event.type, offerId: event.offer.id, brand: event.offer.brand, title: event.offer.title, changes: event.changes }))
    ].concat(Array.isArray(previousHistory.events) ? previousHistory.events : []).slice(0, REFERRAL_HISTORY_LIMIT)
  };

  await saveJsonFile(config.__paths.referralsCatalogFile, catalog);
  await saveJsonFile(config.__paths.referralsHistoryFile, history);

  let posted = 0;
  posted += await publishReferralLifecycleEvents(config, state, dryRun, diff);
  await refreshMasterlist(config, state, dryRun, catalog);

  state.jobs.referrals = {
    lastRunDate: dateKey,
    lastRunAt: nowIso,
    offersTracked: offers.length,
    newCount: diff.new.length,
    updatedCount: diff.updated_terms.length,
    cancelledCount: diff.cancelled.length,
    fetchFailureCount: fetchFailures.length
  };

  return {
    job: 'referrals',
    posted,
    offers: offers.length,
    changes: diff.new.length + diff.updated_terms.length + diff.cancelled.length
  };
}