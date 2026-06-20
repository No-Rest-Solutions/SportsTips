import fs from 'node:fs/promises';
import path from 'node:path';

const SPORT_FOLDER_OVERRIDES = new Map([
  ['soccer_epl', 'soccer'],
  ['soccer', 'soccer'],
  ['tennis_atp', 'tennis'],
  ['tennis_wta', 'tennis']
]);

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundToTwo(value) {
  return Number(Number(value || 0).toFixed(2));
}

function parseUnits(value) {
  const match = String(value || '').match(/(-?\d+(?:\.\d+)?)u/i);
  return match ? Number(match[1]) : null;
}

function parseAud(value) {
  const match = String(value || '').match(/\$\s*(-?\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : null;
}

function formatUnitsAud(units, unitSize, { signed = false } = {}) {
  const numericUnits = roundToTwo(units);
  const numericAud = roundToTwo(numericUnits * unitSize);
  const unitPrefix = numericUnits < 0 ? '-' : signed && numericUnits > 0 ? '+' : '';
  const audPrefix = numericAud < 0 ? '-' : signed && numericAud > 0 ? '+' : '';
  return `${unitPrefix}${Math.abs(numericUnits).toFixed(2)}u / ${audPrefix}$${Math.abs(numericAud).toFixed(2)} AUD`;
}

function formatUnitsOnly(units, { signed = false } = {}) {
  const numeric = roundToTwo(units);
  const prefix = numeric < 0 ? '-' : signed && numeric > 0 ? '+' : '';
  return `${prefix}${Math.abs(numeric).toFixed(2)}u`;
}

function getTimezoneShortName(dateLike, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    timeZoneName: 'short'
  });
  const parts = formatter.formatToParts(new Date(dateLike));
  return parts.find((part) => part.type === 'timeZoneName')?.value || timeZone;
}

function formatDisplayDate(dateLike, timeZone) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date(dateLike));
}

function formatSummaryTimestamp(dateLike, timeZone) {
  return `${formatDisplayDate(dateLike, timeZone)} ${getTimezoneShortName(dateLike, timeZone)}`;
}

function formatCsvDate(dateLike, timeZone) {
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

function resolveSportFolderKey(sportKey) {
  const normalized = String(sportKey || '').toLowerCase();

  if (SPORT_FOLDER_OVERRIDES.has(normalized)) {
    return SPORT_FOLDER_OVERRIDES.get(normalized);
  }

  if (normalized.startsWith('soccer')) {
    return 'soccer';
  }

  if (normalized.startsWith('tennis')) {
    return 'tennis';
  }

  return normalized;
}

function derivePlacedDate(pick, state, timeZone, fallbackIso) {
  return formatCsvDate(state?.posts?.picks?.[pick.id] || pick.startTime || fallbackIso, timeZone);
}

function deriveSettledDate(pick, timeZone, fallbackIso) {
  return formatCsvDate(pick.settledAt || fallbackIso, timeZone);
}

function deriveReturnUnits(pick) {
  const explicit = toNumber(pick.returnUnits);

  if (explicit !== null) {
    return explicit;
  }

  const stakeUnits = toNumber(pick.stakeUnits) || 0;
  const netUnits = toNumber(pick.netUnits);
  const result = String(pick.status || '').toLowerCase();

  if (result === 'return') {
    return stakeUnits;
  }

  if (result === 'loss') {
    return 0;
  }

  if (netUnits !== null) {
    return roundToTwo(stakeUnits + netUnits);
  }

  return null;
}

function deriveNetUnits(pick) {
  const explicit = toNumber(pick.netUnits);

  if (explicit !== null) {
    return explicit;
  }

  const stakeUnits = toNumber(pick.stakeUnits) || 0;
  const returnUnits = deriveReturnUnits(pick);
  const result = String(pick.status || '').toLowerCase();

  if (result === 'return') {
    return 0;
  }

  if (result === 'loss') {
    return roundToTwo(-stakeUnits);
  }

  if (returnUnits !== null) {
    return roundToTwo(returnUnits - stakeUnits);
  }

  return null;
}

function buildSourceIdNote(pick) {
  return `Source pick id: ${pick.id}.`;
}

function stripSourceIdNote(text) {
  return String(text || '')
    .replace(/\s*Source pick id:\s*[^.]+\./gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSettlementNotes(pick) {
  const notes = [String(pick.resultNotes || '').trim(), String(pick.rationale || '').trim()]
    .filter(Boolean);
  notes.push(buildSourceIdNote(pick));
  return notes.join(' ').trim();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inQuotes) {
      if (char === '"') {
        if (raw[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }

      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      if (row.length > 1 || row[0] !== '') {
        rows.push(row);
      }
      row = [];
      field = '';
      continue;
    }

    if (char !== '\r') {
      field += char;
    }
  }

  row.push(field);
  if (row.length > 1 || row[0] !== '') {
    rows.push(row);
  }

  return rows;
}

function readMetricValue(content, label) {
  const match = content.match(new RegExp(`\\|\\s*${escapeRegex(label)}\\s*\\|\\s*([^|\\n]+?)\\s*\\|`));
  return match ? match[1].trim() : null;
}

function replaceMetricValue(content, label, nextValue) {
  return content.replace(
    new RegExp(`(\\|\\s*${escapeRegex(label)}\\s*\\|\\s*)([^|\\n]+?)(\\s*\\|)`),
    (_, prefix, __currentValue, suffix) => `${prefix}${nextValue}${suffix}`
  );
}

function replaceMetricLabel(content, currentLabel, nextLabel) {
  return content.replace(
    new RegExp(`(\\|\\s*)${escapeRegex(currentLabel)}(\\s*\\|)`),
    (_, prefix, suffix) => `${prefix}${nextLabel}${suffix}`
  );
}

function replaceSectionBody(content, heading, nextHeading, nextBody) {
  const pattern = new RegExp(`(## ${escapeRegex(heading)}\\r?\\n\\r?\\n)([\\s\\S]*?)(?=\\r?\\n## ${escapeRegex(nextHeading)}\\r?\\n|$)`);

  if (pattern.test(content)) {
    return content.replace(pattern, (_, prefix) => `${prefix}${nextBody.trimEnd()}\n`);
  }

  // Section missing (e.g. a reset/older template that doesn't include it). SELF-HEAL by
  // inserting it rather than throwing — an unhandled throw here used to crash the daemon.
  // Prefer inserting just before the next heading; otherwise append at the end.
  const section = `## ${heading}\n\n${nextBody.trimEnd()}\n`;
  const nextHeadingPattern = new RegExp(`\\r?\\n## ${escapeRegex(nextHeading)}\\r?\\n`);

  if (nextHeadingPattern.test(content)) {
    return content.replace(nextHeadingPattern, (match) => `\n\n${section}${match}`);
  }

  return `${content.trimEnd()}\n\n${section}`;
}

export const __testables = { replaceSectionBody };

function appendRowsToTableSection(content, heading, nextHeading, rows) {
  return replaceSectionBody(content, heading, nextHeading, (() => {
    const pattern = new RegExp(`## ${escapeRegex(heading)}\\r?\\n\\r?\\n([\\s\\S]*?)(?=\\r?\\n## ${escapeRegex(nextHeading)}\\r?\\n|$)`);
    const body = content.match(pattern)?.[1] || '';
    const trimmed = body.trimEnd();
    return rows.length ? `${trimmed}\n${rows.join('\n')}\n` : `${trimmed}\n`;
  })());
}

function parseCsvFile(raw) {
  const rows = parseCsv(raw);

  if (!rows.length) {
    return {
      header: [],
      records: []
    };
  }

  const [header, ...dataRows] = rows;
  const records = dataRows.map((values) => Object.fromEntries(header.map((key, index) => [key, values[index] ?? ''])));
  return {
    header,
    records
  };
}

function serializeCsvFile(header, records) {
  const lines = [header.map(csvEscape).join(',')];

  for (const record of records) {
    lines.push(header.map((key) => csvEscape(record[key] ?? '')).join(','));
  }

  return `${lines.join('\n')}\n`;
}

function buildSportCsvRecord(pick, state, config, fallbackIso) {
  const sportFolder = resolveSportFolderKey(pick.sport);
  const notes = buildSettlementNotes(pick);

  return {
    sportFolder,
    record: {
      placed_date: derivePlacedDate(pick, state, config.timezone, fallbackIso),
      settled_date: deriveSettledDate(pick, config.timezone, fallbackIso),
      sport: pick.sportLabel || sportFolder.toUpperCase(),
      league: pick.league || pick.sportLabel || '',
      event: pick.event || '',
      market: String(pick.betType || '').toUpperCase() || 'PICK',
      selection: pick.summary || '',
      stake_units: (toNumber(pick.stakeUnits) ?? 0).toFixed(2),
      result: String(pick.status || '').toLowerCase(),
      net_units: (deriveNetUnits(pick) ?? 0).toFixed(2),
      bookmaker: pick.bookmaker || '',
      notes
    }
  };
}

async function ensureCsvRecord(filePath, record) {
  let raw;

  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    raw = 'placed_date,settled_date,sport,league,event,market,selection,stake_units,result,net_units,bookmaker,notes\n';
  }

  const parsed = parseCsvFile(raw);
  const header = parsed.header.length
    ? parsed.header
    : ['placed_date', 'settled_date', 'sport', 'league', 'event', 'market', 'selection', 'stake_units', 'result', 'net_units', 'bookmaker', 'notes'];
  const sourceIdMatch = String(record.notes || '').match(/Source pick id: ([^.]+)/);
  const sourceIdNote = sourceIdMatch ? `Source pick id: ${sourceIdMatch[1]}.` : null;
  const existing = sourceIdNote
    ? parsed.records.some((row) => String(row.notes || '').includes(sourceIdNote))
    : false;

  if (existing) {
    return false;
  }

  parsed.records.push(record);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, serializeCsvFile(header, parsed.records), 'utf8');
  return true;
}

function sortRecordsByDate(records) {
  return [...records].sort((left, right) => {
    const leftDate = new Date(left.settled_date || left.placed_date || 0).getTime();
    const rightDate = new Date(right.settled_date || right.placed_date || 0).getTime();
    return rightDate - leftDate;
  });
}

async function rebuildSportSummary(filePath, csvPath, sportLabel, timeZone, fallbackIso) {
  const raw = await fs.readFile(csvPath, 'utf8');
  const { records } = parseCsvFile(raw);
  const settled = records.filter((row) => ['win', 'loss', 'return'].includes(String(row.result || '').toLowerCase()));
  const wins = settled.filter((row) => row.result === 'win').length;
  const losses = settled.filter((row) => row.result === 'loss').length;
  const returns = settled.filter((row) => row.result === 'return').length;
  const netUnits = roundToTwo(settled.reduce((sum, row) => sum + (toNumber(row.net_units) || 0), 0));
  const winRate = wins + losses > 0 ? `${((wins / (wins + losses)) * 100).toFixed(2)}%` : 'N/A';
  const latest = sortRecordsByDate(settled)[0];
  const lastUpdated = latest?.settled_date
    ? formatSummaryTimestamp(latest.settled_date, timeZone)
    : formatSummaryTimestamp(fallbackIso, timeZone);
  const recentResults = sortRecordsByDate(settled).slice(0, 6).map((row) => {
    const result = String(row.result || '').toLowerCase();
    const displayResult = result === 'return' ? 'Return' : result.charAt(0).toUpperCase() + result.slice(1);
    const netUnitsText = formatUnitsOnly(toNumber(row.net_units) || 0, { signed: true });
    const notes = stripSourceIdNote(row.notes || '') || 'Logged via Discord automation.';
    return `- ${formatDisplayDate(row.settled_date || row.placed_date || fallbackIso, timeZone)} | ${row.event} | ${displayResult} | ${netUnitsText} | ${notes}`;
  });
  const content = [
    `# ${sportLabel} Tracker`,
    '',
    '## Current Totals',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Wins | ${wins} |`,
    `| Losses | ${losses} |`,
    `| Returns/Voided | ${returns} |`,
    `| Settled Bets | ${settled.length} |`,
    `| Win % | ${winRate} |`,
    `| Net Units | ${netUnits.toFixed(2)} |`,
    `| Last Updated | ${lastUpdated} |`,
    '',
    '## Notes',
    '',
    '- Only `win` and `loss` results count toward Win %.',
    '- Cash `return` results are tracked separately and excluded from Win %.',
    '- Bet-return tokens or bonus-bet refunds are logged as `loss`, with the notes stating that the loss was a return-token settlement.',
    '',
    '## Recent Results',
    '',
    ...(recentResults.length ? recentResults : ['- No settled results logged yet.']),
    ''
  ].join('\n');

  await fs.writeFile(filePath, content, 'utf8');
}

function deriveLossLogDetails(pick) {
  const notes = stripSourceIdNote(buildSettlementNotes(pick));

  if (/declined leg tracking|did not want the missed legs recorded|not track/i.test(notes)) {
    return {
      knownMissedLegs: 'User declined leg tracking',
      patternTag: 'Untracked loss details',
      followUpStatus: 'Closed without leg detail'
    };
  }

  if (/not supplied|not re-confirmed|not yet|not known|not tracked/i.test(notes)) {
    return {
      knownMissedLegs: 'Not yet supplied',
      patternTag: 'Awaiting leg detail',
      followUpStatus: 'Need user leg detail'
    };
  }

  return {
    knownMissedLegs: 'Needs review',
    patternTag: 'Pending review',
    followUpStatus: 'Ready for review'
  };
}

async function appendLossLogRows(filePath, picks, timeZone) {
  if (!picks.length) {
    return;
  }

  const raw = await fs.readFile(filePath, 'utf8');
  const fresh = picks.filter((pick) => !raw.includes(buildSourceIdNote(pick)));

  if (!fresh.length) {
    return;
  }

  const rows = fresh.map((pick) => {
    const details = deriveLossLogDetails(pick);
    const resultContext = /bet-return|return token/i.test(buildSettlementNotes(pick)) ? 'Bet-return loss' : 'Cash loss';
    const notes = `${stripSourceIdNote(buildSettlementNotes(pick)) || 'Logged via Discord automation.'} ${buildSourceIdNote(pick)}`.trim();

    return `| ${formatDisplayDate(pick.settledAt || new Date().toISOString(), timeZone)} | ${pick.sportLabel || String(pick.sport || '').toUpperCase()} | ${pick.event} | ${(toNumber(pick.stakeUnits) || 0).toFixed(2)}u | ${resultContext} | ${details.knownMissedLegs} | ${details.patternTag} | ${details.followUpStatus} | ${notes} |`;
  });

  const updated = appendRowsToTableSection(raw, 'Open Loss Follow-Up', 'Unreconciled User-Reported Loss Notes', rows);
  await fs.writeFile(filePath, updated, 'utf8');
}

function buildPendingBetNotes(pendingPicks, currentBankrollUnits, availableUnits, unsettledExposureUnits, unitSize) {
  const lines = [];

  if (!pendingPicks.length) {
    lines.push('No open positions currently.');
  } else {
    lines.push(`${pendingPicks.length} open position${pendingPicks.length === 1 ? '' : 's'} currently.`);
    lines.push('');

    for (const pick of pendingPicks) {
      lines.push(`- ${pick.event}: ${pick.summary} | Stake \`${formatUnitsAud(toNumber(pick.stakeUnits) || 0, unitSize)}\``);
    }
  }

  lines.push('');
  lines.push(`Available to deploy now sits at \`${formatUnitsAud(availableUnits, unitSize)}\`, with \`${formatUnitsAud(unsettledExposureUnits, unitSize)}\` tied up in unsettled exposure. Current bankroll snapshot is \`${formatUnitsAud(currentBankrollUnits, unitSize)}\`.`);
  return lines.join('\n');
}

function buildTrackerSettlementRow(pick, timeZone, unitSize, closingBankUnits) {
  const settledDate = pick.settledAt || new Date().toISOString();
  const stakeUnits = toNumber(pick.stakeUnits) || 0;
  const returnUnits = deriveReturnUnits(pick) || 0;
  const netUnits = deriveNetUnits(pick) || 0;
  const notes = `${stripSourceIdNote(buildSettlementNotes(pick)) || 'Logged via Discord automation.'} ${buildSourceIdNote(pick)}`.trim();
  const result = String(pick.status || '').toLowerCase();
  const resultLabel = result === 'return' ? 'Return' : result.charAt(0).toUpperCase() + result.slice(1);

  return `| ${formatDisplayDate(settledDate, timeZone)} | ${pick.sportLabel || String(pick.sport || '').toUpperCase()} | ${pick.event} | ${pick.summary} | ${stakeUnits.toFixed(2)} | ${(stakeUnits * unitSize).toFixed(2)} | ${resultLabel} | ${returnUnits.toFixed(2)} | ${(returnUnits * unitSize).toFixed(2)} | ${netUnits.toFixed(2)} | ${(netUnits * unitSize).toFixed(2)} | ${formatUnitsAud(closingBankUnits, unitSize)} | ${notes} |`;
}

async function updateProfitTracker(filePath, picks, feed, timeZone) {
  let raw = await fs.readFile(filePath, 'utf8');
  const freshPicks = picks.filter((pick) => !raw.includes(buildSourceIdNote(pick)));
  const unitSize = parseAud(readMetricValue(raw, 'Unit Size')) || 10;
  const startingBankrollUnits = parseUnits(readMetricValue(raw, 'Starting Bankroll')) || 0;
  const roiMetricLabel = 'Current ROI (vs Starting Bankroll)';
  let currentBankrollUnits = parseUnits(readMetricValue(raw, 'Current Bankroll')) || startingBankrollUnits;
  let totalSettledCashStakeUnits = parseUnits(readMetricValue(raw, 'Total Settled Cash Stake')) || 0;
  const settledRecordMatch = raw.match(/\|\s*Settled Record\s*\|\s*(\d+)\s+Wins\s*\/\s*(\d+)\s+Losses\s*\/\s*(\d+)\s+(?:Refund|Refunds|Return|Returns)\s*\|/i);
  let wins = settledRecordMatch ? Number(settledRecordMatch[1]) : 0;
  let losses = settledRecordMatch ? Number(settledRecordMatch[2]) : 0;
  let returns = settledRecordMatch ? Number(settledRecordMatch[3]) : 0;
  const appendedRows = [];

  for (const pick of freshPicks) {
    const netUnits = deriveNetUnits(pick) || 0;
    currentBankrollUnits = roundToTwo(currentBankrollUnits + netUnits);
    totalSettledCashStakeUnits = roundToTwo(totalSettledCashStakeUnits + (toNumber(pick.stakeUnits) || 0));

    if (pick.status === 'win') {
      wins += 1;
    } else if (pick.status === 'loss') {
      losses += 1;
    } else if (pick.status === 'return') {
      returns += 1;
    }

    appendedRows.push(buildTrackerSettlementRow(pick, timeZone, unitSize, currentBankrollUnits));
  }

  const pendingPicks = (feed.picks || []).filter((pick) => String(pick.status || '').toLowerCase() === 'pending');
  const unsettledExposureUnits = roundToTwo(pendingPicks.reduce((sum, pick) => sum + (toNumber(pick.stakeUnits) || 0), 0));
  const availableUnits = roundToTwo(currentBankrollUnits - unsettledExposureUnits);
  const netProfitUnits = roundToTwo(currentBankrollUnits - startingBankrollUnits);
  const winRate = wins + losses > 0 ? `${((wins / (wins + losses)) * 100).toFixed(2)}%` : 'N/A';
  const roi = startingBankrollUnits > 0 ? `${((netProfitUnits / startingBankrollUnits) * 100).toFixed(2)}%` : 'N/A';

  if (raw.includes('| Current ROI |')) {
    raw = replaceMetricLabel(raw, 'Current ROI', roiMetricLabel);
  }

  raw = replaceMetricValue(raw, 'Current Bankroll', formatUnitsAud(currentBankrollUnits, unitSize));
  raw = replaceMetricValue(raw, 'Available To Deploy', formatUnitsAud(availableUnits, unitSize));
  raw = replaceMetricValue(raw, 'Unsettled Exposure', formatUnitsAud(unsettledExposureUnits, unitSize));
  raw = replaceMetricValue(raw, 'Net Profit/Loss', formatUnitsAud(netProfitUnits, unitSize, { signed: true }));
  raw = replaceMetricValue(raw, 'Total Settled Cash Stake', formatUnitsAud(totalSettledCashStakeUnits, unitSize));
  raw = replaceMetricValue(raw, roiMetricLabel, roi);
  raw = replaceMetricValue(raw, 'Settled Record', `${wins} Wins / ${losses} Losses / ${returns} ${returns === 1 ? 'Refund' : 'Refunds'}`);
  raw = replaceMetricValue(raw, 'Win Rate', winRate);
  raw = replaceSectionBody(raw, 'Pending Bet Notes', 'Settled Bet Log', buildPendingBetNotes(pendingPicks, currentBankrollUnits, availableUnits, unsettledExposureUnits, unitSize));

  if (appendedRows.length) {
    raw = appendRowsToTableSection(raw, 'Settled Bet Log', 'User-Reported Overnight Settlements', appendedRows);
  }

  await fs.writeFile(filePath, raw, 'utf8');
}

export async function writeSettlementsToWorkspace(context, settledPicks, feed) {
  const { config, state } = context;
  const fallbackIso = new Date().toISOString();
  const touchedSports = new Map();

  for (const pick of settledPicks) {
    const { sportFolder, record } = buildSportCsvRecord(pick, state, config, fallbackIso);
    const csvPath = path.join(config.__paths.workspaceRoot, 'sports', sportFolder, 'bets.csv');
    const added = await ensureCsvRecord(csvPath, record);

    if (added) {
      touchedSports.set(sportFolder, {
        csvPath,
        summaryPath: path.join(config.__paths.workspaceRoot, 'sports', sportFolder, 'summary.md'),
        sportLabel: pick.sportLabel || sportFolder.toUpperCase()
      });
    }
  }

  for (const { csvPath, summaryPath, sportLabel } of touchedSports.values()) {
    await rebuildSportSummary(summaryPath, csvPath, sportLabel, config.timezone, fallbackIso);
  }

  await updateProfitTracker(config.__paths.profitTrackerFile, settledPicks, feed, config.timezone);
  await appendLossLogRows(
    path.join(config.__paths.workspaceRoot, 'loss-tracking', 'rolling-loss-log.md'),
    settledPicks.filter((pick) => String(pick.status || '').toLowerCase() === 'loss'),
    config.timezone
  );
}