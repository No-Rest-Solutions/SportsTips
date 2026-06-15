import fs from 'node:fs/promises';
import path from 'node:path';

import { getDateKey } from './scheduler.mjs';

const TRACKER_HEADERS = [
  'timestamp',
  'transaction_key',
  'transaction_type',
  'pick_id',
  'sport',
  'event',
  'start_time',
  'slip',
  'price_decimal',
  'stake_units',
  'stake_aud',
  'bankroll_delta_units',
  'return_units',
  'return_aud',
  'net_units',
  'net_aud',
  'units_remaining',
  'units_remaining_aud',
  'total_settled_stake_units',
  'total_settled_stake_aud',
  'status',
  'legs_hit',
  'legs_missed',
  'specific_leg_lost',
  'source',
  'notes'
];

const SETTLEMENT_TRANSACTION_TYPES = new Set(['settlement', 'manual_settlement']);

const HIT_STATUSES = new Set(['hit', 'hits', 'won', 'win', 'graded_win', 'cashed', 'cash']);
const MISS_STATUSES = new Set(['loss', 'lost', 'miss', 'missed', 'graded_loss', 'failed', 'fail']);
const VOID_STATUSES = new Set(['push', 'pushed', 'void', 'voided', 'refund', 'refunded', 'cancelled', 'canceled', 'removed']);

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundToTwo(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatNumber(value) {
  const numeric = toNumber(value);
  return numeric === null ? '' : numeric.toFixed(2);
}

function normalizeText(value) {
  return String(value || '').replace(/\r?\n/g, ' / ').trim();
}

function normalizeLookupText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isSettlementTransactionType(value) {
  return SETTLEMENT_TRANSACTION_TYPES.has(String(value || ''));
}

function isPlaceholderMissedLegLabel(value) {
  const normalized = normalizeLookupText(value);
  return normalized === 'unknown' || normalized === 'n/a' || normalized === 'na';
}

function dedupeTextList(values) {
  const seen = new Set();
  const unique = [];

  for (const rawValue of values) {
    const value = normalizeText(rawValue);

    if (!value) {
      continue;
    }

    const key = normalizeLookupText(value);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(value);
  }

  return unique;
}

function parsePipeList(value) {
  return dedupeTextList(String(value || '').split('|').map((item) => item.trim()));
}

function joinPipeList(values) {
  const unique = dedupeTextList(values);
  return unique.length ? unique.join(' | ') : '';
}

function formatAudFromUnits(units, unitSizeAud) {
  const numeric = toNumber(units);
  return numeric === null ? '' : roundToTwo(numeric * unitSizeAud).toFixed(2);
}

function getPickPriceDecimal(pick) {
  const candidates = [
    pick?.priceDecimal,
    pick?.publicationValidation?.totalOdds,
    pick?.closingOdds,
    pick?.totalOdds
  ];

  for (const candidate of candidates) {
    const numeric = toNumber(candidate);

    if (numeric !== null && numeric > 0) {
      return numeric;
    }
  }

  return null;
}

function normalizeLegStatus(status) {
  return normalizeLookupText(status).replace(/-/g, '_');
}

function buildTrackerSlipFingerprint(source) {
  const sport = normalizeLookupText(source?.sport || source?.sportLabel || '');
  const event = normalizeLookupText(source?.event || '');
  const startTime = normalizeLookupText(source?.start_time || source?.startTime || '');
  const slip = normalizeLookupText(source?.slip || source?.summary || '');
  const stakeUnits = toNumber(source?.stake_units ?? source?.stakeUnits);

  if (!sport || !event || !startTime || !slip || stakeUnits === null) {
    return '';
  }

  return [sport, event, startTime, slip, formatNumber(roundToTwo(stakeUnits))].join('::');
}

function buildOpenSlipFingerprintSet(rows) {
  const latestByPick = buildLatestPickMap(rows);
  const fingerprints = new Set();

  for (const row of latestByPick.values()) {
    if (!isOpenTransaction(row)) {
      continue;
    }

    const fingerprint = buildTrackerSlipFingerprint(row);

    if (fingerprint) {
      fingerprints.add(fingerprint);
    }
  }

  return fingerprints;
}

function filterDuplicateOpenSlipTransactions(rows, transactions) {
  const openFingerprints = buildOpenSlipFingerprintSet(rows);
  const filtered = [];

  for (const transaction of transactions) {
    if (!isOpenTransaction(transaction)) {
      filtered.push(transaction);
      continue;
    }

    const fingerprint = buildTrackerSlipFingerprint(transaction);

    if (fingerprint && openFingerprints.has(fingerprint)) {
      continue;
    }

    filtered.push(transaction);

    if (fingerprint) {
      openFingerprints.add(fingerprint);
    }
  }

  return filtered;
}

export function deriveLegOutcomeBreakdown(pick) {
  const legLabels = Array.isArray(pick?.legs)
    ? dedupeTextList(pick.legs.map((leg) => leg?.label || leg?.description || leg?.name || ''))
    : [];
  const hitLegs = [];
  const missedLegs = [];
  const voidLegs = [];

  if (Array.isArray(pick?.legs)) {
    for (const leg of pick.legs) {
      const label = normalizeText(leg?.label || leg?.description || leg?.name || '');
      const status = normalizeLegStatus(leg?.status);

      if (!label || !status) {
        continue;
      }

      if (HIT_STATUSES.has(status)) {
        hitLegs.push(label);
        continue;
      }

      if (MISS_STATUSES.has(status)) {
        missedLegs.push(label);
        continue;
      }

      if (VOID_STATUSES.has(status)) {
        voidLegs.push(label);
      }
    }
  }

  const inferredMissedLegs = dedupeTextList([
    ...(Array.isArray(pick?.failedLegs) ? pick.failedLegs : []),
    pick?.failedLeg,
    pick?.failedLegLabel
  ]).filter((label) => normalizeLookupText(label) !== 'unknown');

  if (!missedLegs.length && inferredMissedLegs.length) {
    missedLegs.push(...inferredMissedLegs);
  }

  if (!hitLegs.length && legLabels.length) {
    if (String(pick?.status || '').toLowerCase() === 'win') {
      hitLegs.push(...legLabels);
    } else if (missedLegs.length) {
      const missedLookup = new Set(missedLegs.map((label) => normalizeLookupText(label)));
      hitLegs.push(...legLabels.filter((label) => !missedLookup.has(normalizeLookupText(label))));
    }
  }

  return {
    hitLegs: dedupeTextList(hitLegs),
    missedLegs: dedupeTextList(missedLegs),
    voidLegs: dedupeTextList(voidLegs),
    hasLegData: Boolean(legLabels.length || hitLegs.length || missedLegs.length || voidLegs.length)
  };
}

function escapeCsvValue(value) {
  const normalized = normalizeText(value);

  if (!/[",]/.test(normalized)) {
    return normalized;
  }

  return `"${normalized.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (insideQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          insideQuotes = false;
        }
      } else {
        current += char;
      }

      continue;
    }

    if (char === ',') {
      values.push(current);
      current = '';
      continue;
    }

    if (char === '"') {
      insideQuotes = true;
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsv(raw) {
  const lines = raw.split(/\r?\n/).filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
  });
}

function serializeCsv(rows) {
  const lines = [TRACKER_HEADERS.join(',')];

  for (const row of rows) {
    lines.push(TRACKER_HEADERS.map((header) => escapeCsvValue(row[header] || '')).join(','));
  }

  return `${lines.join('\n')}\n`;
}

function getTrackerConfig(config) {
  const trackerConfig = config.bankrollTracker || {};

  return {
    enabled: trackerConfig.enabled !== false,
    filePath: config.__paths?.bankrollTrackerFile,
    startingBankrollUnits: toNumber(trackerConfig.startingBankrollUnits) ?? 10,
    unitSizeAud: toNumber(trackerConfig.unitSizeAud) ?? 10,
    rollingWindowDays: Math.max(1, toNumber(trackerConfig.rollingWindowDays) ?? 30),
    repeatLossThreshold: Math.max(1, toNumber(trackerConfig.repeatLossThreshold) ?? 2),
    losingLegsReportFile: config.__paths?.losingLegsReportFile || null
  };
}

function buildInitRow(trackerConfig, timestamp) {
  const startingBankrollUnits = roundToTwo(trackerConfig.startingBankrollUnits);
  const bankrollAud = formatAudFromUnits(startingBankrollUnits, trackerConfig.unitSizeAud);

  return {
    timestamp,
    transaction_key: 'init',
    transaction_type: 'init',
    pick_id: '',
    sport: '',
    event: '',
    start_time: '',
    slip: '',
    price_decimal: '',
    stake_units: '',
    stake_aud: '',
    bankroll_delta_units: '0.00',
    return_units: '',
    return_aud: '',
    net_units: '',
    net_aud: '',
    units_remaining: startingBankrollUnits.toFixed(2),
    units_remaining_aud: bankrollAud,
    total_settled_stake_units: '0.00',
    total_settled_stake_aud: '0.00',
    status: 'tracker_started',
    legs_hit: '',
    legs_missed: '',
    specific_leg_lost: '',
    source: 'system',
    notes: `Tracker started at ${startingBankrollUnits.toFixed(2)}u ($${bankrollAud} AUD).`
  };
}

async function ensureTrackerFile(trackerConfig, timestamp) {
  if (!trackerConfig.enabled || !trackerConfig.filePath) {
    return;
  }

  try {
    await fs.access(trackerConfig.filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    await fs.mkdir(path.dirname(trackerConfig.filePath), { recursive: true });
    await fs.writeFile(trackerConfig.filePath, serializeCsv([buildInitRow(trackerConfig, timestamp)]), 'utf8');
  }
}

async function loadTrackerRows(config, timestamp = new Date().toISOString()) {
  const trackerConfig = getTrackerConfig(config);

  if (!trackerConfig.enabled || !trackerConfig.filePath) {
    return {
      trackerConfig,
      rows: []
    };
  }

  await ensureTrackerFile(trackerConfig, timestamp);
  const raw = await fs.readFile(trackerConfig.filePath, 'utf8');

  return {
    trackerConfig,
    rows: parseCsv(raw)
  };
}

function buildPostedTransactions(config, picks, timestamp) {
  const trackerConfig = getTrackerConfig(config);

  return picks.map((pick) => {
    const stakeUnits = roundToTwo(toNumber(pick?.stakeUnits) ?? 0);
    const priceDecimal = getPickPriceDecimal(pick);

    return {
      timestamp,
      transaction_key: `post:${pick.id}`,
      transaction_type: 'post',
      pick_id: String(pick?.id || ''),
      sport: String(pick?.sportLabel || pick?.sport || '').toUpperCase(),
      event: normalizeText(pick?.event || ''),
      start_time: String(pick?.startTime || ''),
      slip: normalizeText(pick?.summary || ''),
      price_decimal: formatNumber(priceDecimal),
      stake_units: formatNumber(stakeUnits),
      stake_aud: formatAudFromUnits(stakeUnits, trackerConfig.unitSizeAud),
      bankroll_delta_units: formatNumber(-stakeUnits),
      return_units: '',
      return_aud: '',
      net_units: '',
      net_aud: '',
      status: 'posted',
      legs_hit: '',
      legs_missed: '',
      specific_leg_lost: '',
      source: normalizeText(pick?.source || 'discord-bot'),
      notes: 'Marked as placed for bankroll tracking.'
    };
  });
}

function buildReplacementTransactions(config, replacements, timestamp) {
  const trackerConfig = getTrackerConfig(config);

  return replacements.map((item) => {
    const originalStakeUnits = roundToTwo(toNumber(item?.original?.stakeUnits) ?? 0);
    const replacementStakeUnits = roundToTwo(toNumber(item?.replacement?.stakeUnits) ?? originalStakeUnits);
    const bankrollDeltaUnits = roundToTwo(originalStakeUnits - replacementStakeUnits);
    const priceDecimal = getPickPriceDecimal(item?.replacement) ?? getPickPriceDecimal(item?.original);
    const replacementReason = normalizeText(
      item?.replacement?.replacementReason
      || item?.original?.replacementReason
      || item?.original?.replacementStatus
      || 'Updated slip'
    );

    return {
      timestamp,
      transaction_key: `replacement:${item.original.id}:${item.replacement.candidateId || 'current'}`,
      transaction_type: 'replacement',
      pick_id: String(item?.original?.id || ''),
      sport: String(item?.replacement?.sportLabel || item?.replacement?.sport || item?.original?.sportLabel || item?.original?.sport || '').toUpperCase(),
      event: normalizeText(item?.replacement?.event || item?.original?.event || ''),
      start_time: String(item?.replacement?.startTime || item?.original?.startTime || ''),
      slip: normalizeText(item?.replacement?.summary || ''),
      price_decimal: formatNumber(priceDecimal),
      stake_units: formatNumber(replacementStakeUnits),
      stake_aud: formatAudFromUnits(replacementStakeUnits, trackerConfig.unitSizeAud),
      bankroll_delta_units: formatNumber(bankrollDeltaUnits),
      return_units: '',
      return_aud: '',
      net_units: '',
      net_aud: '',
      status: 'replacement_posted',
      legs_hit: '',
      legs_missed: '',
      specific_leg_lost: '',
      source: normalizeText(item?.replacement?.source || item?.original?.source || 'discord-bot'),
      notes: `Replacement posted. Replaced: ${normalizeText(item?.original?.summary || '')}. Reason: ${replacementReason}.`
    };
  });
}

function buildCancellationTransactions(config, cancellations, timestamp) {
  const trackerConfig = getTrackerConfig(config);

  return cancellations.map((item) => {
    const pick = item?.pick || item;
    const stakeUnits = roundToTwo(toNumber(item?.stakeUnits ?? pick?.stakeUnits) ?? 0);
    const priceDecimal = getPickPriceDecimal(pick);

    return {
      timestamp,
      transaction_key: `cancel:${pick.id}`,
      transaction_type: 'cancel',
      pick_id: String(pick?.id || ''),
      sport: String(pick?.sportLabel || pick?.sport || '').toUpperCase(),
      event: normalizeText(pick?.event || ''),
      start_time: String(pick?.startTime || ''),
      slip: normalizeText(pick?.summary || ''),
      price_decimal: formatNumber(priceDecimal),
      stake_units: formatNumber(stakeUnits),
      stake_aud: formatAudFromUnits(stakeUnits, trackerConfig.unitSizeAud),
      bankroll_delta_units: formatNumber(stakeUnits),
      return_units: formatNumber(stakeUnits),
      return_aud: formatAudFromUnits(stakeUnits, trackerConfig.unitSizeAud),
      net_units: '0.00',
      net_aud: '0.00',
      status: 'cancelled',
      legs_hit: '',
      legs_missed: '',
      specific_leg_lost: '',
      source: normalizeText(pick?.source || 'discord-bot'),
      notes: normalizeText(item?.reason || 'Cancelled after the late pregame recheck failed.')
    };
  });
}

function buildSettlementTransactions(config, picks, timestamp) {
  const trackerConfig = getTrackerConfig(config);

  return picks.map((pick) => {
    const stakeUnits = roundToTwo(toNumber(pick?.stakeUnits) ?? 0);
    const returnUnits = roundToTwo(
      toNumber(pick?.returnUnits)
      ?? (String(pick?.status || '').toLowerCase() === 'return' ? stakeUnits : 0)
    );
    const netUnits = roundToTwo(toNumber(pick?.netUnits) ?? (returnUnits - stakeUnits));
    const status = String(pick?.status || '').toLowerCase();
    const priceDecimal = getPickPriceDecimal(pick);
    const legOutcomeBreakdown = deriveLegOutcomeBreakdown(pick);
    const missedLegs = legOutcomeBreakdown.missedLegs.length
      ? legOutcomeBreakdown.missedLegs
      : (status === 'loss' ? ['unknown'] : []);

    return {
      timestamp: String(pick?.settledAt || timestamp),
      transaction_key: `settle:${pick.id}`,
      transaction_type: 'settlement',
      pick_id: String(pick?.id || ''),
      sport: String(pick?.sportLabel || pick?.sport || '').toUpperCase(),
      event: normalizeText(pick?.event || ''),
      start_time: String(pick?.startTime || ''),
      slip: normalizeText(pick?.summary || ''),
      price_decimal: formatNumber(priceDecimal),
      stake_units: formatNumber(stakeUnits),
      stake_aud: formatAudFromUnits(stakeUnits, trackerConfig.unitSizeAud),
      bankroll_delta_units: formatNumber(returnUnits),
      return_units: formatNumber(returnUnits),
      return_aud: formatAudFromUnits(returnUnits, trackerConfig.unitSizeAud),
      net_units: formatNumber(netUnits),
      net_aud: formatAudFromUnits(netUnits, trackerConfig.unitSizeAud),
      status,
      legs_hit: joinPipeList(legOutcomeBreakdown.hitLegs),
      legs_missed: joinPipeList(missedLegs),
      specific_leg_lost: joinPipeList(missedLegs),
      source: normalizeText(pick?.source || 'discord-bot'),
      notes: normalizeText(pick?.resultNotes || 'Settled via Discord automation.')
    };
  });
}

function buildManualSettlementTransactions(config, picks, timestamp) {
  const trackerConfig = getTrackerConfig(config);

  return picks.map((pick) => {
    const stakeUnits = roundToTwo(toNumber(pick?.stakeUnits) ?? 0);
    const returnUnits = roundToTwo(
      toNumber(pick?.returnUnits)
      ?? (String(pick?.status || '').toLowerCase() === 'return' ? stakeUnits : 0)
    );
    const netUnits = roundToTwo(
      toNumber(pick?.netUnits)
      ?? (String(pick?.status || '').toLowerCase() === 'return' ? 0 : (returnUnits - stakeUnits))
    );
    const status = String(pick?.status || '').toLowerCase();
    const priceDecimal = getPickPriceDecimal(pick);
    const legOutcomeBreakdown = deriveLegOutcomeBreakdown(pick);
    const missedLegs = legOutcomeBreakdown.missedLegs.length
      ? legOutcomeBreakdown.missedLegs
      : (status === 'loss' ? ['unknown'] : []);

    return {
      timestamp: String(pick?.settledAt || timestamp),
      transaction_key: `manual_settle:${pick.id}`,
      transaction_type: 'manual_settlement',
      pick_id: String(pick?.id || ''),
      sport: String(pick?.sportLabel || pick?.sport || '').toUpperCase(),
      event: normalizeText(pick?.event || ''),
      start_time: String(pick?.startTime || ''),
      slip: normalizeText(pick?.summary || ''),
      price_decimal: formatNumber(priceDecimal),
      stake_units: formatNumber(stakeUnits),
      stake_aud: formatAudFromUnits(stakeUnits, trackerConfig.unitSizeAud),
      bankroll_delta_units: formatNumber(netUnits),
      return_units: formatNumber(returnUnits),
      return_aud: formatAudFromUnits(returnUnits, trackerConfig.unitSizeAud),
      net_units: formatNumber(netUnits),
      net_aud: formatAudFromUnits(netUnits, trackerConfig.unitSizeAud),
      status,
      legs_hit: joinPipeList(legOutcomeBreakdown.hitLegs),
      legs_missed: joinPipeList(missedLegs),
      specific_leg_lost: joinPipeList(missedLegs),
      source: normalizeText(pick?.source || 'manual-settlement'),
      notes: normalizeText(pick?.resultNotes || 'Manual settlement recorded without a corresponding bot placement row; bankroll delta reflects net units only.')
    };
  });
}

async function appendTransactions(config, transactions, timestamp = new Date().toISOString()) {
  if (!transactions.length) {
    return [];
  }

  const { trackerConfig, rows } = await loadTrackerRows(config, timestamp);

  if (!trackerConfig.enabled || !trackerConfig.filePath) {
    return [];
  }

  const seenKeys = new Set(rows.map((row) => row.transaction_key));
  let currentUnits = toNumber(rows.at(-1)?.units_remaining) ?? trackerConfig.startingBankrollUnits;
  let totalSettledStakeUnits = toNumber(rows.at(-1)?.total_settled_stake_units)
    ?? roundToTwo(rows.reduce((sum, row) => sum + (isSettlementTransactionType(row.transaction_type) ? (toNumber(row.stake_units) ?? 0) : 0), 0));
  const nextRows = [...rows];
  const appended = [];
  const filteredTransactions = filterDuplicateOpenSlipTransactions(rows, transactions);

  for (const transaction of filteredTransactions) {
    if (!transaction.transaction_key || seenKeys.has(transaction.transaction_key)) {
      continue;
    }

    currentUnits = roundToTwo(currentUnits + (toNumber(transaction.bankroll_delta_units) ?? 0));

    if (isSettlementTransactionType(transaction.transaction_type)) {
      totalSettledStakeUnits = roundToTwo(totalSettledStakeUnits + (toNumber(transaction.stake_units) ?? 0));
    }

    const row = {
      ...transaction,
      units_remaining: formatNumber(currentUnits),
      units_remaining_aud: formatAudFromUnits(currentUnits, trackerConfig.unitSizeAud),
      total_settled_stake_units: formatNumber(totalSettledStakeUnits),
      total_settled_stake_aud: formatAudFromUnits(totalSettledStakeUnits, trackerConfig.unitSizeAud)
    };

    nextRows.push(row);
    appended.push(row);
    seenKeys.add(transaction.transaction_key);
  }

  if (appended.length) {
    await fs.writeFile(trackerConfig.filePath, serializeCsv(nextRows), 'utf8');
  }

  return appended;
}

function buildLatestPickMap(rows) {
  const latest = new Map();

  for (const row of rows) {
    if (row.pick_id) {
      latest.set(row.pick_id, row);
    }
  }

  return latest;
}

function normalizeSportLabel(value) {
  const sport = String(value || '').trim().toUpperCase();
  return sport || 'UNKNOWN';
}

function buildSportUnitBreakdown(rows) {
  const totals = new Map();

  for (const row of rows) {
    const units = toNumber(row?.stake_units);

    if (units === null) {
      continue;
    }

    const sport = normalizeSportLabel(row?.sport);
    totals.set(sport, roundToTwo((totals.get(sport) || 0) + units));
  }

  return totals;
}

function buildSportNetBreakdown(rows) {
  const totals = new Map();

  for (const row of rows) {
    const units = toNumber(row?.net_units);

    if (units === null) {
      continue;
    }

    const sport = normalizeSportLabel(row?.sport);
    totals.set(sport, roundToTwo((totals.get(sport) || 0) + units));
  }

  return totals;
}

function buildSportRecordBreakdown(rows) {
  const totals = new Map();

  for (const row of rows) {
    const sport = normalizeSportLabel(row?.sport);
    const status = normalizeLookupText(row?.status);
    const current = totals.get(sport) || { wins: 0, losses: 0, returns: 0 };

    if (status === 'win') {
      current.wins += 1;
    } else if (status === 'loss') {
      current.losses += 1;
    } else if (status === 'return') {
      current.returns += 1;
    }

    totals.set(sport, current);
  }

  return totals;
}

function mergeSportTotals(openBreakdown, lifetimeBreakdown, netBreakdown, recordBreakdown) {
  const sports = new Set([...openBreakdown.keys(), ...lifetimeBreakdown.keys(), ...netBreakdown.keys(), ...recordBreakdown.keys()]);

  return [...sports]
    .sort((left, right) => left.localeCompare(right))
    .map((sport) => {
      const record = recordBreakdown.get(sport) || { wins: 0, losses: 0, returns: 0 };
      const wins = Number(record.wins || 0);
      const losses = Number(record.losses || 0);

      return {
        sport,
        openExposureUnits: roundToTwo(openBreakdown.get(sport) || 0),
        lifetimePlacedUnits: roundToTwo(lifetimeBreakdown.get(sport) || 0),
        totalNetUnits: roundToTwo(netBreakdown.get(sport) || 0),
        wins,
        losses,
        returns: Number(record.returns || 0),
        winLossPercent: wins + losses > 0
          ? Number(((wins / (wins + losses)) * 100).toFixed(2))
          : null
      };
    });
}

function isOpenTransaction(row) {
  return row.transaction_type === 'post' || row.transaction_type === 'replacement';
}

function buildRecurringLosingLegs(rows) {
  const counts = new Map();

  for (const row of rows) {
    if (!isSettlementTransactionType(row.transaction_type) || row.status !== 'loss') {
      continue;
    }

    for (const leg of parsePipeList(row.legs_missed || row.specific_leg_lost)) {
      if (!leg || isPlaceholderMissedLegLabel(leg)) {
        continue;
      }

      const key = normalizeLookupText(leg);
      const current = counts.get(key) || {
        leg,
        count: 0,
        lastEvent: '',
        lastTimestamp: '',
        sampleEvents: []
      };

      current.count += 1;
      current.lastEvent = row.event || current.lastEvent;
      current.lastTimestamp = row.timestamp || current.lastTimestamp;

      if (row.event && !current.sampleEvents.includes(row.event) && current.sampleEvents.length < 3) {
        current.sampleEvents.push(row.event);
      }

      counts.set(key, current);
    }
  }

  return [...counts.values()].sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }

    return new Date(right.lastTimestamp || 0).getTime() - new Date(left.lastTimestamp || 0).getTime();
  });
}

function getPreviousDateKey(referenceDate, timeZone) {
  return getDateKey(new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000), timeZone);
}

function parseDateKeyUtcMs(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return null;
  }

  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function getTimestampDateKey(timestamp, timeZone) {
  if (!timestamp) {
    return '';
  }

  const parsed = new Date(timestamp);

  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return getDateKey(parsed, timeZone);
}

function getTrackerStartDateKey(rows, referenceDate, timeZone) {
  for (const row of rows) {
    const dateKey = getTimestampDateKey(row?.timestamp, timeZone);

    if (dateKey) {
      return dateKey;
    }
  }

  return getDateKey(referenceDate, timeZone);
}

function getTrackerDayNumber(startDateKey, currentDateKey) {
  const startMs = parseDateKeyUtcMs(startDateKey);
  const currentMs = parseDateKeyUtcMs(currentDateKey);

  if (startMs === null || currentMs === null || currentMs < startMs) {
    return 1;
  }

  return Math.floor((currentMs - startMs) / (24 * 60 * 60 * 1000)) + 1;
}

export async function appendPostedTrackerEntries(config, picks, timestamp = new Date().toISOString()) {
  return appendTransactions(config, buildPostedTransactions(config, picks, timestamp), timestamp);
}

export async function appendReplacementTrackerEntries(config, replacements, timestamp = new Date().toISOString()) {
  return appendTransactions(config, buildReplacementTransactions(config, replacements, timestamp), timestamp);
}

export async function appendCancellationTrackerEntries(config, cancellations, timestamp = new Date().toISOString()) {
  return appendTransactions(config, buildCancellationTransactions(config, cancellations, timestamp), timestamp);
}

export async function appendSettlementTrackerEntries(config, picks, timestamp = new Date().toISOString()) {
  if (!picks.length) {
    return [];
  }

  const { rows } = await loadTrackerRows(config, timestamp);
  const latestByPick = buildLatestPickMap(rows);
  const filtered = picks.filter((pick) => latestByPick.get(String(pick?.id || ''))?.transaction_type !== 'cancel');
  const appended = await appendTransactions(config, buildSettlementTransactions(config, filtered, timestamp), timestamp);

  if (appended.length) {
    await rebuildLosingLegsReport(config, timestamp);
  }

  return appended;
}

export async function appendManualSettlementTrackerEntries(config, picks, timestamp = new Date().toISOString()) {
  if (!picks.length) {
    return [];
  }

  const appended = await appendTransactions(config, buildManualSettlementTransactions(config, picks, timestamp), timestamp);

  if (appended.length) {
    await rebuildLosingLegsReport(config, timestamp);
  }

  return appended;
}

export async function readBankrollTrackerRows(config, timestamp = new Date().toISOString()) {
  const { rows } = await loadTrackerRows(config, timestamp);
  return rows;
}

export async function buildBankrollTrackerSnapshot(config, referenceDate = new Date()) {
  const { trackerConfig, rows } = await loadTrackerRows(config, referenceDate.toISOString());

  if (!trackerConfig.enabled || !rows.length) {
    return null;
  }

  const currentDateKey = getDateKey(referenceDate, config.timezone);
  const trackerStartDateKey = getTrackerStartDateKey(rows, referenceDate, config.timezone);
  const trackerDayNumber = getTrackerDayNumber(trackerStartDateKey, currentDateKey);
  const startingBankrollUnits = trackerConfig.startingBankrollUnits;
  const startingBankrollAud = roundToTwo(startingBankrollUnits * trackerConfig.unitSizeAud);
  const last24hStartMs = referenceDate.getTime() - 24 * 60 * 60 * 1000;
  const rollingStartMs = referenceDate.getTime() - trackerConfig.rollingWindowDays * 24 * 60 * 60 * 1000;
  const latestByPick = buildLatestPickMap(rows);
  const openPositions = [...latestByPick.values()].filter(isOpenTransaction);
  const lifetimePlacedRows = rows.filter((row) => row.transaction_type === 'post' || row.transaction_type === 'replacement');
  const settlementRows = rows.filter((row) => isSettlementTransactionType(row.transaction_type));
  const currentDayRows = rows.filter((row) => getTimestampDateKey(row.timestamp, config.timezone) === currentDateKey);
  const currentDaySettlements = settlementRows.filter((row) => getTimestampDateKey(row.timestamp, config.timezone) === currentDateKey);
  const last24hRows = rows.filter((row) => row.timestamp && new Date(row.timestamp).getTime() >= last24hStartMs);
  const rollingSettlementRows = settlementRows.filter((row) => row.timestamp && new Date(row.timestamp).getTime() >= rollingStartMs);
  const last24hSettlements = settlementRows.filter((row) => row.timestamp && new Date(row.timestamp).getTime() >= last24hStartMs);
  const currentUnits = toNumber(rows.at(-1)?.units_remaining) ?? trackerConfig.startingBankrollUnits;
  const currentAud = toNumber(rows.at(-1)?.units_remaining_aud) ?? roundToTwo(currentUnits * trackerConfig.unitSizeAud);
  const lifetimePlacedUnits = roundToTwo(lifetimePlacedRows.reduce((sum, row) => sum + (toNumber(row.stake_units) ?? 0), 0));
  const lifetimePlacedAud = roundToTwo(lifetimePlacedUnits * trackerConfig.unitSizeAud);
  const totalSettledStakeUnits = toNumber(rows.at(-1)?.total_settled_stake_units)
    ?? roundToTwo(settlementRows.reduce((sum, row) => sum + (toNumber(row.stake_units) ?? 0), 0));
  const totalSettledStakeAud = roundToTwo(totalSettledStakeUnits * trackerConfig.unitSizeAud);
  const totalNetUnits = roundToTwo(settlementRows.reduce((sum, row) => sum + (toNumber(row.net_units) ?? 0), 0));
  const totalNetAud = roundToTwo(totalNetUnits * trackerConfig.unitSizeAud);
  const totalRoiPercent = totalSettledStakeUnits > 0
    ? Number(((totalNetUnits / totalSettledStakeUnits) * 100).toFixed(2))
    : null;
  const openExposureUnits = roundToTwo(openPositions.reduce((sum, row) => sum + (toNumber(row.stake_units) ?? 0), 0));
  const openExposureAud = roundToTwo(openExposureUnits * trackerConfig.unitSizeAud);
  const sportRecordTotals = buildSportRecordBreakdown(settlementRows);
  const sportTotals = mergeSportTotals(
    buildSportUnitBreakdown(openPositions),
    buildSportUnitBreakdown(lifetimePlacedRows),
    buildSportNetBreakdown(settlementRows),
    sportRecordTotals
  );
  const currentDayNetUnits = roundToTwo(currentDaySettlements.reduce((sum, row) => sum + (toNumber(row.net_units) ?? 0), 0));
  const currentDayGainUnits = roundToTwo(currentDaySettlements.reduce((sum, row) => sum + Math.max(0, toNumber(row.net_units) ?? 0), 0));
  const currentDayLossUnits = roundToTwo(Math.abs(currentDaySettlements.reduce((sum, row) => sum + Math.min(0, toNumber(row.net_units) ?? 0), 0)));
  const currentDayStakeUnits = roundToTwo(currentDaySettlements.reduce((sum, row) => sum + (toNumber(row.stake_units) ?? 0), 0));
  const currentDayStakeAud = roundToTwo(currentDayStakeUnits * trackerConfig.unitSizeAud);
  const currentDayNetAud = roundToTwo(currentDayNetUnits * trackerConfig.unitSizeAud);
  const currentDayRoiPercent = currentDayStakeUnits > 0
    ? Number(((currentDayNetUnits / currentDayStakeUnits) * 100).toFixed(2))
    : null;
  const last24hNetUnits = roundToTwo(last24hSettlements.reduce((sum, row) => sum + (toNumber(row.net_units) ?? 0), 0));
  const last24hGainUnits = roundToTwo(last24hSettlements.reduce((sum, row) => sum + Math.max(0, toNumber(row.net_units) ?? 0), 0));
  const last24hLossUnits = roundToTwo(Math.abs(last24hSettlements.reduce((sum, row) => sum + Math.min(0, toNumber(row.net_units) ?? 0), 0)));
  const last24hStakeUnits = roundToTwo(last24hSettlements.reduce((sum, row) => sum + (toNumber(row.stake_units) ?? 0), 0));
  const last24hStakeAud = roundToTwo(last24hStakeUnits * trackerConfig.unitSizeAud);
  const last24hNetAud = roundToTwo(last24hNetUnits * trackerConfig.unitSizeAud);
  const last24hRoiPercent = last24hStakeUnits > 0
    ? Number(((last24hNetUnits / last24hStakeUnits) * 100).toFixed(2))
    : null;
  const rollingStakeUnits = roundToTwo(rollingSettlementRows.reduce((sum, row) => sum + (toNumber(row.stake_units) ?? 0), 0));
  const rollingNetUnits = roundToTwo(rollingSettlementRows.reduce((sum, row) => sum + (toNumber(row.net_units) ?? 0), 0));
  const rollingRoiPercent = rollingStakeUnits > 0
    ? Number(((rollingNetUnits / rollingStakeUnits) * 100).toFixed(2))
    : null;
  const wins = rollingSettlementRows.filter((row) => row.status === 'win').length;
  const losses = rollingSettlementRows.filter((row) => row.status === 'loss').length;
  const returns = rollingSettlementRows.filter((row) => row.status === 'return').length;
  const rollingHitRatePercent = wins + losses > 0
    ? Number(((wins / (wins + losses)) * 100).toFixed(2))
    : null;
  const bankrollRoiPercent = startingBankrollUnits > 0
    ? Number(((totalNetUnits / startingBankrollUnits) * 100).toFixed(2))
    : null;
  const rollingBankrollRoiPercent = startingBankrollUnits > 0
    ? Number(((rollingNetUnits / startingBankrollUnits) * 100).toFixed(2))
    : null;
  const recurringLosingLegs = buildRecurringLosingLegs(rollingSettlementRows);

  return {
    trackerFile: trackerConfig.filePath,
    losingLegsReportFile: trackerConfig.losingLegsReportFile,
    repeatLossThreshold: trackerConfig.repeatLossThreshold,
    rows,
    unitSizeAud: trackerConfig.unitSizeAud,
    startingBankrollUnits,
    startingBankrollAud,
    currentUnits,
    currentAud,
    lifetimePlacedUnits,
    lifetimePlacedAud,
    totalSettledStakeUnits,
    totalSettledStakeAud,
    totalNetUnits,
    totalNetAud,
    totalRoiPercent,
    openPositions,
    openExposureUnits,
    openExposureAud,
    sportTotals,
    availableUnits: currentUnits,
    trackerStartDateKey,
    currentDayDateKey: currentDateKey,
    trackerDayNumber,
    currentDayRows,
    currentDaySettlements,
    currentDayPostedCount: currentDayRows.filter((row) => row.transaction_type === 'post' || row.transaction_type === 'replacement').length,
    currentDaySettledCount: currentDaySettlements.length,
    currentDayNetUnits,
    currentDayNetAud,
    currentDayGainUnits,
    currentDayLossUnits,
    currentDayStakeUnits,
    currentDayStakeAud,
    currentDayRoiPercent,
    last24hRows,
    last24hSettlements,
    last24hPostedCount: last24hRows.filter((row) => row.transaction_type === 'post' || row.transaction_type === 'replacement').length,
    last24hSettledCount: last24hSettlements.length,
    last24hNetUnits,
    last24hNetAud,
    last24hGainUnits,
    last24hLossUnits,
    last24hStakeUnits,
    last24hStakeAud,
    last24hRoiPercent,
    rollingStakeUnits,
    rollingNetUnits,
    rollingRoiPercent,
    bankrollRoiPercent,
    rollingBankrollRoiPercent,
    rollingHitRatePercent,
    rollingRecord: {
      wins,
      losses,
      returns
    },
    recurringLosingLegs,
    recentSettlements: currentDaySettlements.slice(-5).reverse()
  };
}

export async function buildDailyTrackerSummary(config, referenceDate = new Date()) {
  const snapshot = await buildBankrollTrackerSnapshot(config, referenceDate);

  if (!snapshot) {
    return null;
  }

  return {
    ...snapshot,
    summaryDateKey: snapshot.currentDayDateKey,
    previousDateKey: getPreviousDateKey(referenceDate, config.timezone)
  };
}

async function rebuildLosingLegsReport(config, referenceDate = new Date()) {
  const snapshot = await buildBankrollTrackerSnapshot(config, new Date(referenceDate));

  if (!snapshot?.losingLegsReportFile) {
    return;
  }

  const repeatedLegs = snapshot.recurringLosingLegs.filter((item) => item.count >= snapshot.repeatLossThreshold);
  const lines = [
    '# Bot Losing Legs Report',
    '',
    `Rolling window: last ${config.bankrollTracker?.rollingWindowDays || 30} days.`,
    `Repeat-miss threshold: ${snapshot.repeatLossThreshold}.`,
    ''
  ];

  if (!repeatedLegs.length) {
    lines.push('No recurring losing legs have crossed the report threshold yet.');
  } else {
    lines.push('## Repeat Misses');
    lines.push('');
    lines.push('| Leg | Misses | Last Event | Sample Events |');
    lines.push('| --- | ---: | --- | --- |');

    for (const item of repeatedLegs) {
      lines.push(`| ${item.leg} | ${item.count} | ${item.lastEvent || 'Unknown'} | ${item.sampleEvents.join(' / ') || 'Unknown'} |`);
    }
  }

  lines.push('');
  lines.push('## Recent Missed Legs');
  lines.push('');

  const recentRows = snapshot.recentSettlements
    .filter((row) => row.status === 'loss' && joinPipeList(parsePipeList(row.legs_missed || row.specific_leg_lost)));

  if (!recentRows.length) {
    lines.push('- No settled losing legs recorded in the last 24 hours.');
  } else {
    for (const row of recentRows) {
      lines.push(`- ${row.event} | ${joinPipeList(parsePipeList(row.legs_missed || row.specific_leg_lost))}`);
    }
  }

  await fs.mkdir(path.dirname(snapshot.losingLegsReportFile), { recursive: true });
  await fs.writeFile(snapshot.losingLegsReportFile, `${lines.join('\n')}\n`, 'utf8');
}