function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
}

export function getDateKey(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getMinutesInZone(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function parseMinutes(clockValue) {
  const [hours, minutes] = clockValue.split(':').map(Number);
  return hours * 60 + minutes;
}

export function getDueJobs(config, state, date = new Date()) {
  const due = [];
  const dateKey = getDateKey(date, config.timezone);
  const currentMinutes = getMinutesInZone(date, config.timezone);
  let analysisDue = false;

  if (config.jobs?.slates?.enabled) {
    const scheduled = parseMinutes(config.jobs.slates.time);
    const alreadyRan = state.jobs?.slates?.lastRunDate === dateKey;

    if (!alreadyRan && currentMinutes >= scheduled) {
      due.push('slates');
    }
  }

  if (config.jobs?.analysis?.enabled && config.analysis?.enabled) {
    const scheduled = parseMinutes(config.jobs.analysis.time);
    const lastRunAt = state.jobs?.analysis?.lastRunAt ? new Date(state.jobs.analysis.lastRunAt).getTime() : 0;
    const intervalMs = Number(config.jobs.analysis.intervalMinutes || 180) * 60 * 1000;

    if (currentMinutes >= scheduled && (!lastRunAt || date.getTime() - lastRunAt >= intervalMs)) {
      due.push('analysis');
      analysisDue = true;
    }
  }

  if (config.jobs?.picks?.enabled) {
    const scheduled = parseMinutes(config.jobs.picks.time);
    const lastRunAt = state.jobs?.picks?.lastRunAt ? new Date(state.jobs.picks.lastRunAt).getTime() : 0;
    const intervalMs = Number(config.jobs.picks.intervalMinutes || 15) * 60 * 1000;

    if (currentMinutes >= scheduled && (analysisDue || !lastRunAt || date.getTime() - lastRunAt >= intervalMs)) {
      due.push('picks');
    }
  }

  if (config.jobs?.referrals?.enabled) {
    const scheduled = parseMinutes(config.jobs.referrals.time);
    const lastRunAt = state.jobs?.referrals?.lastRunAt ? new Date(state.jobs.referrals.lastRunAt).getTime() : 0;
    const intervalMs = Number(config.jobs.referrals.intervalMinutes || 360) * 60 * 1000;

    if (currentMinutes >= scheduled && (!lastRunAt || date.getTime() - lastRunAt >= intervalMs)) {
      due.push('referrals');
    }
  }

  if (config.jobs?.results?.enabled) {
    const lastRunAt = state.jobs?.results?.lastRunAt ? new Date(state.jobs.results.lastRunAt).getTime() : 0;
    const intervalMs = Number(config.jobs.results.intervalMinutes || 15) * 60 * 1000;

    if (!lastRunAt || date.getTime() - lastRunAt >= intervalMs) {
      due.push('results');
    }
  }

  if (config.bankrollTracker?.enabled !== false && config.bankrollTracker?.summaryTime) {
    const scheduled = parseMinutes(config.bankrollTracker.summaryTime);
    const alreadyRan = state.jobs?.trackerSummary?.lastRunDate === dateKey;

    if (!alreadyRan && currentMinutes >= scheduled) {
      due.push('trackerSummary');
    }
  }

  // TAB market-menu refresh: once daily, only when the TAB feature is enabled.
  if (config.jobs?.tabMenu?.enabled && config.tab?.enabled !== false) {
    const scheduled = parseMinutes(config.jobs.tabMenu.time);
    const alreadyRan = state.jobs?.tabMenu?.lastRunDate === dateKey;

    if (!alreadyRan && currentMinutes >= scheduled) {
      due.push('tabMenu');
    }
  }

  // Promos: daily slip generation, periodic settlement, and an end-of-day report.
  if (config.jobs?.promos?.enabled) {
    const generationScheduled = parseMinutes(config.jobs.promos.generationTime || '09:30');
    const generationRan = state.jobs?.promosGeneration?.lastRunDate === dateKey;

    if (!generationRan && currentMinutes >= generationScheduled) {
      due.push('promosGeneration');
    }

    const settlementLastRunAt = state.jobs?.promosSettlement?.lastRunAt
      ? new Date(state.jobs.promosSettlement.lastRunAt).getTime()
      : 0;
    const settlementIntervalMs = Number(config.jobs.promos.settlementIntervalMinutes || 30) * 60 * 1000;

    if (!settlementLastRunAt || date.getTime() - settlementLastRunAt >= settlementIntervalMs) {
      due.push('promosSettlement');
    }

    const reportScheduled = parseMinutes(config.jobs.promos.reportTime || '23:30');
    const reportRan = state.jobs?.promosReport?.lastRunDate === dateKey;

    if (!reportRan && currentMinutes >= reportScheduled) {
      due.push('promosReport');
    }
  }

  return due;
}