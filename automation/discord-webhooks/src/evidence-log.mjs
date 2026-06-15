/**
 * Evidence Log
 *
 * Turns a posted slip's per-leg deep-analysis evidence into (a) a Discord embed
 * for the dedicated evidence channel and (b) rows for a reviewable CSV, so the
 * reasoning behind every leg is visible and the user can review patterns over
 * time. Evidence is only present when analysis.deepAnalysis is enabled.
 */

import fs from 'node:fs/promises';

const STATUS_EMOJI = {
  supported: '✅',
  weak: '⚠️',
  contra: '❌',
  unknown: '❔'
};

const STATUS_COLOR = {
  supported: 0x2ecc71, // green
  mixed: 0xf1c40f,     // amber
  weak: 0xe67e22,      // orange
  none: 0x95a5a6       // grey
};

export const EVIDENCE_CSV_HEADERS = [
  'timestamp', 'slipId', 'sport', 'event', 'betType', 'combinedOdds', 'stakeUnits',
  'legLabel', 'market', 'subject', 'line', 'side', 'odds', 'closingOdds', 'clv',
  'evidenceType', 'evidenceStatus', 'evidenceScore', 'reason', 'outcome'
];

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function combinedOdds(legs) {
  const prices = legs.map((leg) => toNumber(leg.odds)).filter((value) => value !== null && value > 1);
  if (!prices.length) {
    return null;
  }
  return Math.round(prices.reduce((product, price) => product * price, 1) * 100) / 100;
}

function hasAnyEvidence(pick) {
  return (Array.isArray(pick?.legs) ? pick.legs : []).some((leg) => leg?.evidence?.status);
}

/**
 * Build a Discord embed summarising a slip's evidence, or null when the slip
 * carries no deep-analysis evidence (so nothing is posted).
 * @param {Object} pick
 * @returns {Object|null}
 */
export function buildEvidenceEmbed(pick) {
  if (!hasAnyEvidence(pick)) {
    return null;
  }

  const legs = Array.isArray(pick.legs) ? pick.legs : [];
  const odds = combinedOdds(legs);
  const statuses = legs.map((leg) => leg?.evidence?.status).filter(Boolean);
  const allSupported = statuses.length > 0 && statuses.every((status) => status === 'supported');
  const anyWeakOrContra = statuses.some((status) => status === 'weak' || status === 'contra');
  const color = allSupported ? STATUS_COLOR.supported : anyWeakOrContra ? STATUS_COLOR.mixed : STATUS_COLOR.weak;

  const descriptionParts = [
    String(pick.betType || 'single').toUpperCase(),
    odds ? `${odds.toFixed(2)}x` : null,
    pick.stakeUnits ? `${pick.stakeUnits}u` : null
  ].filter(Boolean);

  const fields = legs.map((leg) => {
    const evidence = leg?.evidence || {};
    const emoji = STATUS_EMOJI[evidence.status] || STATUS_EMOJI.unknown;
    const price = toNumber(leg.odds);
    const name = `${emoji} ${leg.label || leg.source?.description || 'Leg'}${price ? ` @ ${price.toFixed(2)}` : ''}`;
    const reason = String(evidence.reason || 'No evidence reason recorded.').slice(0, 1000);
    return {
      name: name.slice(0, 256),
      value: `**${evidence.status || 'unknown'}** — ${reason}`.slice(0, 1024)
    };
  });

  return {
    title: `🧾 ${pick.sportLabel || pick.sport || 'Slip'} — ${pick.event || ''}`.slice(0, 256),
    description: descriptionParts.join(' • '),
    color,
    fields,
    footer: { text: `slip ${pick.id || ''}` }
  };
}

/**
 * Build CSV rows (one per leg) for the evidence review log.
 * @param {Object} pick
 * @param {string} postedAt - ISO timestamp
 * @returns {Array<Object>}
 */
export function buildEvidenceCsvRows(pick, postedAt = new Date().toISOString()) {
  const legs = Array.isArray(pick?.legs) ? pick.legs : [];
  const odds = combinedOdds(legs);

  return legs.map((leg) => {
    const evidence = leg?.evidence || {};
    const source = leg?.source || {};
    return {
      timestamp: postedAt,
      slipId: pick.id || '',
      sport: pick.sport || '',
      event: pick.event || '',
      betType: pick.betType || '',
      combinedOdds: odds ?? '',
      stakeUnits: pick.stakeUnits ?? '',
      legLabel: leg.label || '',
      market: source.market || '',
      subject: source.description || source.outcomeName || '',
      line: source.point ?? '',
      side: source.outcomeName || '',
      odds: toNumber(leg.odds) ?? '',
      closingOdds: toNumber(leg.closingOdds) ?? '',
      clv: '', // back-filled at settlement from posted vs closing odds
      evidenceType: evidence.type || '',
      evidenceStatus: evidence.status || '',
      evidenceScore: evidence.score ?? '',
      reason: evidence.reason || '',
      outcome: '' // back-filled at settlement
    };
  });
}

function escapeCsv(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv(rows, includeHeader) {
  const lines = [];
  if (includeHeader) {
    lines.push(EVIDENCE_CSV_HEADERS.join(','));
  }
  for (const row of rows) {
    lines.push(EVIDENCE_CSV_HEADERS.map((key) => escapeCsv(row[key])).join(','));
  }
  return lines.join('\n');
}

/**
 * Append evidence rows to the CSV log, writing the header if the file is new.
 * Never throws (logging must not break posting).
 * @param {string} filePath
 * @param {Array<Object>} rows
 */
export async function appendEvidenceCsv(filePath, rows) {
  if (!filePath || !rows?.length) {
    return;
  }

  try {
    let exists = true;
    try {
      await fs.access(filePath);
    } catch {
      exists = false;
    }

    await fs.appendFile(filePath, `${rowsToCsv(rows, !exists)}\n`);
  } catch (error) {
    console.error(`[evidence-log] Failed to append CSV: ${error.message}`);
  }
}

/**
 * Closing-line value: how much better (or worse) the posted price was vs the
 * closing price, as a percentage. Positive = beat the close.
 */
export function computeClv(postedOdds, closingOdds) {
  const posted = toNumber(postedOdds);
  const closing = toNumber(closingOdds);
  if (posted === null || closing === null || closing <= 1) {
    return null;
  }
  return Math.round((posted / closing - 1) * 1000) / 10;
}

/**
 * Parse one CSV line into fields, honouring quoted fields and escaped quotes.
 */
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Back-fill a settled slip's outcome (and CLV when closing odds are known) into
 * the evidence CSV. Rows for the slip are matched in leg order. Never throws.
 * @param {string} filePath
 * @param {Object} pick - { id, status, legs:[{ odds, closingOdds }] }
 * @returns {Promise<number>} rows updated
 */
export async function updateEvidenceOutcome(filePath, pick) {
  if (!filePath || !pick?.id) {
    return 0;
  }

  try {
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return 0; // no log yet
    }

    const lines = content.split('\n');
    if (lines.length < 2) {
      return 0;
    }

    const header = parseCsvLine(lines[0]);
    const col = (name) => header.indexOf(name);
    const slipIdIdx = col('slipId');
    const outcomeIdx = col('outcome');
    const oddsIdx = col('odds');
    const closingIdx = col('closingOdds');
    const clvIdx = col('clv');
    if (slipIdIdx < 0 || outcomeIdx < 0) {
      return 0;
    }

    const legs = Array.isArray(pick.legs) ? pick.legs : [];
    let legCursor = 0;
    let updated = 0;

    for (let i = 1; i < lines.length; i += 1) {
      if (!lines[i].trim()) {
        continue;
      }
      const fields = parseCsvLine(lines[i]);
      if (fields[slipIdIdx] !== pick.id || (fields[outcomeIdx] || '').trim()) {
        continue;
      }

      fields[outcomeIdx] = String(pick.status || '');

      const leg = legs[legCursor];
      legCursor += 1;
      const closing = toNumber(leg?.closingOdds);
      if (closing !== null && closingIdx >= 0 && clvIdx >= 0) {
        fields[closingIdx] = String(closing);
        const clv = computeClv(fields[oddsIdx], closing);
        fields[clvIdx] = clv === null ? '' : String(clv);
      }

      lines[i] = EVIDENCE_CSV_HEADERS.map((name) => escapeCsv(fields[header.indexOf(name)])).join(',');
      updated += 1;
    }

    if (updated) {
      await fs.writeFile(filePath, lines.join('\n'));
    }
    return updated;
  } catch (error) {
    console.error(`[evidence-log] Failed to back-fill outcome: ${error.message}`);
    return 0;
  }
}

export const __testables = {
  buildEvidenceEmbed,
  buildEvidenceCsvRows,
  combinedOdds,
  computeClv,
  parseCsvLine,
  escapeCsv,
  rowsToCsv,
  updateEvidenceOutcome,
  EVIDENCE_CSV_HEADERS
};
