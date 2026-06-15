import { getDateKey } from './scheduler.mjs';

const EMBED_COLORS = {
  slate: 0x1f2937,
  picks: 0x14532d,
  replacement: 0x7c5c1b,
  cancellation: 0x991b1b,
  results: 0x374151
};

const MAX_EMBED_FIELDS = 25;
const MAX_EMBED_TITLE = 256;
const MAX_EMBED_DESCRIPTION = 4096;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;

function timestampTag(isoString, style = 'F') {
  if (!isoString) {
    return 'TBD';
  }

  const unixSeconds = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${unixSeconds}:${style}>`;
}

function formatStartTime(isoString) {
  return timestampTag(isoString, 'R');
}

function formatStake(units) {
  return Number.isFinite(Number(units)) ? `${Number(units).toFixed(2)}u` : 'TBD';
}

function formatPriceMultiplier(value) {
  return Number.isFinite(Number(value)) ? `x${Number(value).toFixed(2)}` : 'TBD';
}

function formatAud(value) {
  return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)} AUD` : 'TBD';
}

function formatSignedUnits(value) {
  return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}u` : 'TBD';
}

function formatSignedAud(value) {
  return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : '-'}$${Math.abs(Number(value)).toFixed(2)} AUD` : 'TBD';
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : 'TBD';
}

function getPickDisplayTotalOdds(pick) {
  const candidateValues = [
    pick?.publicationValidation?.totalOdds,
    pick?.benchmark?.totalOdds,
    pick?.totalOdds,
    pick?.priceDecimal,
    pick?.originalPick?.publicationValidation?.totalOdds,
    pick?.originalPick?.benchmark?.totalOdds,
    pick?.originalPick?.totalOdds,
    pick?.originalPick?.priceDecimal
  ];

  for (const value of candidateValues) {
    const numericValue = Number(value);

    if (Number.isFinite(numericValue) && numericValue > 1) {
      return numericValue;
    }
  }

  return null;
}

function truncate(value, maxLength) {
  const text = String(value || '');

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getSportLabel(item) {
  return item?.sportLabel || item?.sport?.toUpperCase() || 'General';
}

function getPickLegLabels(pick) {
  const structuredLegs = Array.isArray(pick?.legs)
    ? pick.legs
        .map((leg) => String(leg?.label || leg?.description || leg?.name || '').trim())
        .filter(Boolean)
    : [];

  if (structuredLegs.length) {
    return structuredLegs;
  }

  const summary = String(pick?.summary || '').trim();

  if (!summary) {
    return [];
  }

  return summary
    .split(/\s+\+\s+/)
    .map((leg) => leg.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function formatLegList(pick) {
  const legLabels = getPickLegLabels(pick);

  if (!legLabels.length) {
    return '';
  }

  return legLabels
    .map((label) => `- ${label}`)
    .join('\n');
}

function formatBonusLegList(pick) {
  const bonusLegLabels = Array.isArray(pick?.bonusLegOptions)
    ? pick.bonusLegOptions
        .map((leg) => String(leg?.label || '').trim())
        .filter(Boolean)
        .slice(0, 2)
    : [];

  if (!bonusLegLabels.length) {
    return '';
  }

  return [
    'Optional AFL bonus disposals:',
    ...bonusLegLabels.map((label) => `- ${label}`)
  ].join('\n');
}

function getWeatherSummary(pick) {
  return String(pick?.weather?.summary || pick?.weatherSummary || '').trim();
}

function getWeatherDetails(pick) {
  return String(pick?.weather?.details || pick?.weatherDetails || '').trim();
}

function appendWeatherLines(lines, pick) {
  const weatherSummary = getWeatherSummary(pick);

  if (!weatherSummary) {
    return;
  }

  lines.push(`Weather: ${weatherSummary}`);

  const weatherDetails = getWeatherDetails(pick);

  if (weatherDetails) {
    lines.push(`Forecast: ${weatherDetails}`);
  }
}

function getTabAvailabilityLine(pick) {
  switch (pick?.tabAvailability) {
    case 'all':
      return 'TAB: ✅ All legs available on TAB';
    case 'partial':
      return 'TAB: ⚠️ Partly on TAB — some legs Sportsbet-only';
    case 'none':
      return 'TAB: ❌ Sportsbet-only (not offered on TAB)';
    default:
      return null; // 'unknown' / uncaptured — show nothing rather than mislead.
  }
}

function buildSlipDetailLines(pick, options = {}) {
  const lines = [];
  const totalOdds = getPickDisplayTotalOdds(pick);
  const legList = formatLegList(pick);
  const bonusLegList = formatBonusLegList(pick);
  const unitsLabel = options.unitsLabel || 'Units';

  if (pick?.startTime) {
    lines.push(`Starts: ${formatStartTime(pick.startTime)}`);
  }

  appendWeatherLines(lines, pick);

  if (totalOdds !== null) {
    lines.push(`Price: ${formatPriceMultiplier(totalOdds)}`);
  }

  lines.push(`${unitsLabel}: ${formatStake(pick?.stakeUnits)}`);

  const tabLine = getTabAvailabilityLine(pick);
  if (tabLine) {
    lines.push(tabLine);
  }

  if (legList) {
    lines.push('Legs:');
    lines.push(legList);
  }

  if (bonusLegList) {
    lines.push('');
    lines.push(bonusLegList);
  }

  return lines;
}

function formatReplacementDetail(pick) {
  const rationale = String(pick?.rationale || '').trim();

  if (!rationale) {
    return 'The replacement kept the cleanest same-event structure still passing the late publication checks.';
  }

  if (/^Fallback leg stays live\.?$/iu.test(rationale)) {
    return 'This was the cleanest remaining same-event leg that stayed available and still passed the late publication checks.';
  }

  if (/^Rules engine approved a \d+-leg build/iu.test(rationale)) {
    return 'Rebuilt from the latest same-event board and kept the cleanest available legs that still passed the live publication checks.';
  }

  if (/^Rules engine forced the safest available/iu.test(rationale)) {
    return 'The original slip needed a full same-event rebuild, and this was the safest available version still passing the late publication checks.';
  }

  if (/^Rules engine kept /iu.test(rationale)) {
    return 'The replacement leg still matched the preferred market shape and passed the late publication checks.';
  }

  return rationale;
}

function buildField(name, lines) {
  const value = truncate(lines.filter((line) => line !== null && line !== undefined).join('\n') || 'TBD', MAX_FIELD_VALUE);

  return {
    name: truncate(name || 'Details', MAX_FIELD_NAME),
    value,
    inline: false
  };
}

function chunkFields(fields) {
  const chunks = [];

  for (let index = 0; index < fields.length; index += MAX_EMBED_FIELDS) {
    chunks.push(fields.slice(index, index + MAX_EMBED_FIELDS));
  }

  return chunks;
}

function withPageSuffix(title, index, total) {
  if (total <= 1) {
    return truncate(title, MAX_EMBED_TITLE);
  }

  return truncate(`${title} | Page ${index + 1}/${total}`, MAX_EMBED_TITLE);
}

function createEmbedMessage({ title, color, description, fields, footerText }) {
  return {
    content: '',
    embeds: [{
      title: truncate(title, MAX_EMBED_TITLE),
      color,
      ...(description ? { description: truncate(description, MAX_EMBED_DESCRIPTION) } : {}),
      ...(Array.isArray(fields) && fields.length ? { fields } : {}),
      ...(footerText ? { footer: { text: footerText } } : {})
    }]
  };
}

function groupBySport(items) {
  const groups = [];
  const groupMap = new Map();

  for (const item of items) {
    const label = getSportLabel(item);

    if (groupMap.has(label)) {
      groupMap.get(label).push(item);
      continue;
    }

    const nextGroup = [item];
    groupMap.set(label, nextGroup);
    groups.push({ label, items: nextGroup });
  }

  return groups;
}

function buildGroupedEmbedMessages(items, options) {
  if (!Array.isArray(items) || !items.length) {
    return [];
  }

  const groups = groupBySport(items);
  const messages = [];

  for (const group of groups) {
    const fields = group.items
      .map((item, index) => options.buildField(item, index))
      .filter(Boolean);

    const chunks = chunkFields(fields);

    for (const [chunkIndex, chunk] of chunks.entries()) {
      messages.push(createEmbedMessage({
        title: withPageSuffix(`${group.label} ${options.titleSuffix} | ${options.dateKey}`, chunkIndex, chunks.length),
        color: options.color,
        description: options.description,
        fields: chunk,
        footerText: options.footerText
      }));
    }
  }

  return messages;
}

export function formatSlateMessages(sport, dateKey, events) {
  if (!Array.isArray(events) || !events.length) {
    return [];
  }

  const fields = events.map((event) => {
    const status = String(event.state || 'pre').toLowerCase();

    if (status === 'pre') {
      return buildField(event.name, [`Starts: ${formatStartTime(event.startTime)}`]);
    }

    if (status === 'in') {
      return buildField(event.name, [
        'Status: Live now',
        `Update: ${event.shortStatus || 'In progress'}`
      ]);
    }

    return buildField(event.name, [
      'Status: Final',
      `Update: ${event.shortStatus || 'Completed'}`
    ]);
  });

  const chunks = chunkFields(fields);

  return chunks.map((chunk, index) => createEmbedMessage({
    title: withPageSuffix(`${sport.label} Slate | ${dateKey}`, index, chunks.length),
    color: EMBED_COLORS.slate,
    description: 'Current actionable board.',
    fields: chunk,
    footerText: 'Times shown as relative Discord timestamps.'
  }));
}

export function formatPicksMessages(picks, dateKey) {
  const timeZone = arguments[2] || 'UTC';

  if (!Array.isArray(picks) || !picks.length) {
    return [];
  }

  const groups = [];
  const groupMap = new Map();

  for (const pick of picks) {
    const sportLabel = getSportLabel(pick);
    const groupDateKey = pick?.startTime
      ? getDateKey(new Date(pick.startTime), timeZone)
      : dateKey;
    const groupKey = `${sportLabel}::${groupDateKey}`;

    if (groupMap.has(groupKey)) {
      groupMap.get(groupKey).items.push(pick);
      continue;
    }

    const nextGroup = {
      label: sportLabel,
      dateKey: groupDateKey,
      items: [pick]
    };

    groupMap.set(groupKey, nextGroup);
    groups.push(nextGroup);
  }

  const messages = [];

  for (const group of groups) {
    const fields = group.items.map((pick) => {
      return buildField(pick.event || 'Pick', buildSlipDetailLines(pick));
    });

    const chunks = chunkFields(fields);

    for (const [chunkIndex, chunk] of chunks.entries()) {
      messages.push(createEmbedMessage({
        title: withPageSuffix(`${group.label} Best Picks | ${group.dateKey}`, chunkIndex, chunks.length),
        color: EMBED_COLORS.picks,
        fields: chunk
      }));
    }
  }

  return messages;
}

export function formatReplacementPickMessages(originalPick, replacementPick, dateKey) {
  return buildGroupedEmbedMessages([
    {
      ...replacementPick,
      originalPick
    }
  ], {
    dateKey,
    titleSuffix: 'Replacement Picks',
    color: EMBED_COLORS.replacement,
    description: 'Updated slips replacing previously posted picks.',
    footerText: 'Times shown as relative Discord timestamps.',
    buildField: (pick) => {
      const reason = pick.replacementReason || pick.originalPick?.replacementReason || pick.originalPick?.replacementStatus || 'Updated slip';
      const lines = buildSlipDetailLines(pick);

      lines.push('');
      lines.push(`Previous slip: ${pick.originalPick?.summary || 'TBD'}`);
      lines.push(`Why replaced: ${reason}`);
      lines.push(`Replacement detail: ${formatReplacementDetail(pick)}`);

      return buildField(pick.event || 'Replacement pick', lines);
    }
  });
}

export function formatCancellationPickMessages(pick, reason, dateKey) {
  return buildGroupedEmbedMessages([
    {
      ...pick,
      cancellationReason: reason
    }
  ], {
    dateKey,
    titleSuffix: 'Pick Cancellations',
    color: EMBED_COLORS.cancellation,
    description: 'Posted slips cancelled after the late recheck.',
    footerText: 'Times shown as relative Discord timestamps.',
    buildField: (cancelledPick) => {
      const lines = buildSlipDetailLines(cancelledPick);

      lines.push(`Stake returned: ${formatStake(cancelledPick.stakeUnits)}`);
      lines.push('');
      lines.push(`Reason: ${cancelledPick.cancellationReason || 'Late recheck failed.'}`);

      return buildField(cancelledPick.event || 'Cancelled pick', lines);
    }
  });
}

function getSettlementOrderTime(value) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getUnitTrackingEmbedColor(status) {
  const normalized = String(status || '').toLowerCase();

  if (normalized === 'win') {
    return EMBED_COLORS.picks;
  }

  if (normalized === 'loss') {
    return EMBED_COLORS.cancellation;
  }

  if (normalized === 'return') {
    return EMBED_COLORS.replacement;
  }

  return EMBED_COLORS.results;
}

export function formatUnitTrackingMessages(results, dateKey) {
  if (!Array.isArray(results) || !results.length) {
    return [];
  }

  const orderedResults = [...results].sort((left, right) => {
    const leftTime = getSettlementOrderTime(left?.settledAt) ?? getSettlementOrderTime(left?.startTime) ?? Number.POSITIVE_INFINITY;
    const rightTime = getSettlementOrderTime(right?.settledAt) ?? getSettlementOrderTime(right?.startTime) ?? Number.POSITIVE_INFINITY;

    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return String(left?.event || left?.id || '').localeCompare(String(right?.event || right?.id || ''));
  });

  return orderedResults.map((pick) => {
    const result = String(pick.status || '').toUpperCase() || 'RESULT';
    const sportLabel = getSportLabel(pick);
    const lines = [];
    const missedLegs = Array.isArray(pick.missedLegs) ? pick.missedLegs.filter(Boolean) : [];
    const hitLegs = Array.isArray(pick.hitLegs) ? pick.hitLegs.filter(Boolean) : [];
    const priceDecimal = Number(pick.priceDecimal);

    if (pick.settledAt) {
      lines.push(`Settled: ${formatStartTime(pick.settledAt)}`);
    } else if (pick.startTime) {
      lines.push(`Started: ${formatStartTime(pick.startTime)}`);
    }

    lines.push(`Slip: ${pick.summary || 'TBD'}`);
    appendWeatherLines(lines, pick);

    if (Number.isFinite(priceDecimal) && priceDecimal > 1) {
      lines.push(`Price: ${formatPriceMultiplier(priceDecimal)}`);
    }

    lines.push(`Stake -> Return: ${formatStake(pick.stakeUnits)} -> ${formatStake(pick.returnUnits)} | ${formatAud(pick.stakeAud)} -> ${formatAud(pick.returnAud)}`);
    lines.push(`Net / Bankroll: ${formatSignedUnits(pick.netUnits)} | ${formatSignedAud(pick.netAud)} | ${formatStake(pick.totalUnits)} | ${formatAud(pick.totalAud)}`);
    lines.push(`Settled Stake: ${formatStake(pick.totalSettledStakeUnits)} | ${formatAud(pick.totalSettledStakeAud)}`);

    if (missedLegs.length) {
      lines.push(`Missed: ${missedLegs.join('; ')}`);
    } else if (result === 'WIN' && hitLegs.length) {
      lines.push(`Legs hit: ${hitLegs.length}`);
    }

    if (pick.resultNotes) {
      lines.push(`Notes: ${pick.resultNotes}`);
    }

    return createEmbedMessage({
      title: `${sportLabel} ${result} | Unit Tracking | ${dateKey}`,
      color: getUnitTrackingEmbedColor(pick.status),
      description: 'Chronological settlement with bankroll update after this slip.',
      fields: [buildField(pick.event || 'Pick', lines)],
    footerText: 'Tracker totals reflect the CSV ledger in settlement order.'
    });
  });
}