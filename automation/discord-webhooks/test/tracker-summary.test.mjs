import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendManualSettlementTrackerEntries,
  appendPostedTrackerEntries,
  appendSettlementTrackerEntries,
  buildDailyTrackerSummary,
  buildMlbLedgerConfig,
  readBankrollTrackerRows
} from '../src/bot-tracker.mjs';
import { runTrackerSummaryJob } from '../src/jobs/tracker-summary.mjs';
import { getDueJobs } from '../src/scheduler.mjs';

function buildConfig(workspaceRoot) {
  return {
    timezone: 'Australia/Sydney',
    dryRun: true,
    bankrollTracker: {
      enabled: true,
      csvFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv'),
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md')
    },
    discord: {
      username: 'SportsTips',
      avatarUrl: '',
      webhooks: {
        slates: '',
        picks: '',
        results: '',
        unitTracking: '',
        unitReport: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    jobs: {
      picks: {
        enabled: true,
        time: '09:00',
        intervalMinutes: 15,
        shortlistHours: 24,
        postWindowHours: 8,
        pregameRecheckMinutes: 60,
        preWindowCheckMinutes: 60,
        inWindowCheckMinutes: 15,
        holdIfSupportRulesFail: true,
        replacementCutoffMinutes: 15
      },
      results: {
        enabled: true,
        intervalMinutes: 15
      }
    },
    __paths: {
      bankrollTrackerFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv'),
      losingLegsReportFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md')
    }
  };
}

test('getDueJobs schedules the daily tracker summary once after the configured time', () => {
  const config = buildConfig('C:/tmp/sportstips');
  const due = getDueJobs(config, { jobs: {} }, new Date('2026-05-22T22:00:00.000Z'));

  assert.ok(due.includes('trackerSummary'));

  const alreadyRan = getDueJobs(config, {
    jobs: {
      trackerSummary: {
        lastRunDate: '2026-05-23'
      }
    }
  }, new Date('2026-05-22T22:30:00.000Z'));

  assert.ok(!alreadyRan.includes('trackerSummary'));
});

test('getDueJobs forces a same-cycle picks run when analysis is due after picks start time', () => {
  const config = buildConfig('C:/tmp/sportstips');
  config.analysis = { enabled: true };
  config.jobs.analysis = {
    enabled: true,
    time: '08:30',
    intervalMinutes: 60
  };

  const due = getDueJobs(config, {
    jobs: {
      analysis: {
        lastRunAt: '2026-05-22T22:00:00.000Z'
      },
      picks: {
        lastRunAt: '2026-05-22T23:25:00.000Z'
      }
    }
  }, new Date('2026-05-22T23:30:00.000Z'));

  assert.ok(due.includes('analysis'));
  assert.ok(due.includes('picks'));
  assert.ok(due.indexOf('analysis') < due.indexOf('picks'));
});

test('runTrackerSummaryJob posts the simplified tracker-day bankroll summary from the CSV ledger', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-tracker-summary-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildConfig(workspaceRoot);
  const state = { jobs: {} };
  const postedAt = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const settledAt = new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString();

  await appendPostedTrackerEntries(config, [{
    id: 'pick-1',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime: postedAt,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    source: 'auto-generator'
  }], postedAt);

  await appendSettlementTrackerEntries(config, [{
    id: 'pick-1',
    status: 'win',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime: postedAt,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    returnUnits: 1.92,
    netUnits: 0.92,
    settledAt,
    source: 'auto-generator'
  }], settledAt);

  const originalConsoleLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    const result = await runTrackerSummaryJob({ config, state, dryRun: true });

    assert.equal(result.posted, 1);
    assert.ok(state.jobs.trackerSummary?.sourceDateKey);
    assert.match(logs.join('\n'), /Unit Report/);
    assert.match(logs.join('\n'), /Day \d+/);
    assert.match(logs.join('\n'), /Starting Bankroll/);
    assert.match(logs.join('\n'), /Current Bankroll/);
    assert.match(logs.join('\n'), /Net Profit\/Loss/);
    assert.match(logs.join('\n'), /Hit Rate/);
    assert.match(logs.join('\n'), /30 Day ROI/);
    assert.match(logs.join('\n'), /By Sport/);
    assert.match(logs.join('\n'), /NBA: \+0\.92u \| 1W \/ 0L \| 100\.00%/);
    assert.match(logs.join('\n'), /Extra Info/);
    assert.match(logs.join('\n'), /Lifetime Placed/);
    assert.match(logs.join('\n'), /Lifetime Settled/);
    assert.doesNotMatch(logs.join('\n'), /Recent Settlements/);
    assert.doesNotMatch(logs.join('\n'), /Repeat Losing Legs/);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('buildDailyTrackerSummary includes per-sport open exposure, lifetime placed, and lifetime net totals', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-tracker-sport-totals-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildConfig(workspaceRoot);
  const postedAt = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const settledAt = new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString();

  await appendPostedTrackerEntries(config, [{
    id: 'afl-pick-1',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Hawthorn vs Adelaide Crows',
    startTime: postedAt,
    summary: 'Hawthorn Head to Head',
    stakeUnits: 1,
    source: 'auto-generator'
  }, {
    id: 'nrl-pick-1',
    sport: 'nrl',
    sportLabel: 'NRL',
    event: 'Canterbury Bulldogs vs Melbourne Storm',
    startTime: postedAt,
    summary: 'Matt Burton 6+ Points + 1st Half Over 23.5',
    stakeUnits: 2,
    source: 'auto-generator'
  }], postedAt);

  await appendSettlementTrackerEntries(config, [{
    id: 'afl-pick-1',
    status: 'win',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Hawthorn vs Adelaide Crows',
    startTime: postedAt,
    summary: 'Hawthorn Head to Head',
    stakeUnits: 1,
    returnUnits: 1.9,
    netUnits: 0.9,
    settledAt,
    source: 'auto-generator'
  }], settledAt);

  const summary = await buildDailyTrackerSummary(config, new Date());
  const aflTotals = summary.sportTotals.find((item) => item.sport === 'AFL');
  const nrlTotals = summary.sportTotals.find((item) => item.sport === 'NRL');

  assert.equal(summary.lifetimePlacedUnits, 3);
  assert.equal(summary.openExposureUnits, 2);
  assert.equal(aflTotals?.lifetimePlacedUnits, 1);
  assert.equal(aflTotals?.openExposureUnits, 0);
  assert.equal(aflTotals?.totalNetUnits, 0.9);
  assert.equal(aflTotals?.wins, 1);
  assert.equal(aflTotals?.losses, 0);
  assert.equal(aflTotals?.returns, 0);
  assert.equal(aflTotals?.winLossPercent, 100);
  assert.equal(nrlTotals?.lifetimePlacedUnits, 2);
  assert.equal(nrlTotals?.openExposureUnits, 2);
  assert.equal(nrlTotals?.totalNetUnits, 0);
  assert.equal(nrlTotals?.wins, 0);
  assert.equal(nrlTotals?.losses, 0);
  assert.equal(nrlTotals?.returns, 0);
  assert.equal(nrlTotals?.winLossPercent, null);
});

test('buildDailyTrackerSummary counts manual settlements in bankroll and sport records without creating open exposure', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-tracker-manual-settlements-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildConfig(workspaceRoot);
  const openPostedAt = '2026-05-24T01:00:00.000Z';
  const manualSettledAt = '2026-05-10T09:00:00.000Z';

  await appendPostedTrackerEntries(config, [{
    id: 'nrl-open-1',
    sport: 'nrl',
    sportLabel: 'NRL',
    event: 'Manly Sea Eagles vs Cronulla Sharks',
    startTime: openPostedAt,
    summary: 'Open NRL slip',
    stakeUnits: 2,
    source: 'auto-generator'
  }], openPostedAt);

  await appendManualSettlementTrackerEntries(config, [{
    id: 'manual:afl:carlton-geelong',
    status: 'win',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Carlton vs Geelong Cats',
    startTime: '2026-05-10T06:00:00.000Z',
    summary: 'User-reported same-game multi',
    stakeUnits: 2.5,
    returnUnits: 5.12,
    netUnits: 2.62,
    settledAt: manualSettledAt,
    source: 'manual settlement',
    priceDecimal: 2.05,
    resultNotes: 'User confirmed a $51.215 return from a $25 stake.'
  }], manualSettledAt);

  const summary = await buildDailyTrackerSummary(config, new Date('2026-05-24T12:00:00.000Z'));
  const aflTotals = summary.sportTotals.find((item) => item.sport === 'AFL');
  const nrlTotals = summary.sportTotals.find((item) => item.sport === 'NRL');

  assert.equal(summary.currentUnits, 10.62);
  assert.equal(summary.openExposureUnits, 2);
  assert.equal(summary.totalSettledStakeUnits, 2.5);
  assert.equal(summary.totalNetUnits, 2.62);
  assert.equal(summary.rollingRecord.wins, 1);
  assert.equal(summary.rollingRecord.losses, 0);
  assert.equal(aflTotals?.openExposureUnits, 0);
  assert.equal(aflTotals?.totalNetUnits, 2.62);
  assert.equal(aflTotals?.wins, 1);
  assert.equal(aflTotals?.losses, 0);
  assert.equal(aflTotals?.returns, 0);
  assert.equal(aflTotals?.winLossPercent, 100);
  assert.equal(nrlTotals?.openExposureUnits, 2);
  assert.equal(nrlTotals?.totalNetUnits, 0);
});

test('buildDailyTrackerSummary tracks local day numbers and cumulative settled totals', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-tracker-day-summary-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildConfig(workspaceRoot);
  const dayOnePostedAt = '2026-05-22T01:00:00.000Z';
  const dayOneSettledAt = '2026-05-22T03:00:00.000Z';
  const dayTwoPostedAt = '2026-05-23T01:00:00.000Z';
  const dayTwoSettledAt = '2026-05-23T03:00:00.000Z';

  await appendPostedTrackerEntries(config, [{
    id: 'day-one-pick',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'Day One Event',
    startTime: dayOnePostedAt,
    summary: 'Day One Slip',
    stakeUnits: 1,
    source: 'auto-generator'
  }], dayOnePostedAt);

  await appendSettlementTrackerEntries(config, [{
    id: 'day-one-pick',
    status: 'win',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'Day One Event',
    startTime: dayOnePostedAt,
    summary: 'Day One Slip',
    stakeUnits: 1,
    returnUnits: 1.9,
    netUnits: 0.9,
    settledAt: dayOneSettledAt,
    source: 'auto-generator'
  }], dayOneSettledAt);

  await appendPostedTrackerEntries(config, [{
    id: 'day-two-pick',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Day Two Event',
    startTime: dayTwoPostedAt,
    summary: 'Day Two Slip',
    stakeUnits: 1,
    source: 'auto-generator'
  }], dayTwoPostedAt);

  await appendSettlementTrackerEntries(config, [{
    id: 'day-two-pick',
    status: 'loss',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Day Two Event',
    startTime: dayTwoPostedAt,
    summary: 'Day Two Slip',
    stakeUnits: 1,
    returnUnits: 0,
    netUnits: -1,
    settledAt: dayTwoSettledAt,
    source: 'auto-generator'
  }], dayTwoSettledAt);

  const summary = await buildDailyTrackerSummary(config, new Date('2026-05-23T12:00:00.000Z'));

  assert.equal(summary.trackerStartDateKey, '2026-05-22');
  assert.equal(summary.currentDayDateKey, '2026-05-23');
  assert.equal(summary.trackerDayNumber, 2);
  assert.equal(summary.currentDaySettledCount, 1);
  assert.equal(summary.currentDayNetUnits, -1);
  assert.equal(summary.totalNetUnits, -0.1);
  assert.equal(summary.totalRoiPercent, -5);
  assert.equal(summary.bankrollRoiPercent, -1);
  assert.equal(summary.rollingBankrollRoiPercent, -1);
  assert.equal(summary.rollingHitRatePercent, 50);
});

test('appendPostedTrackerEntries skips exact duplicate slips while keeping distinct slips on the same game', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-tracker-duplicate-slip-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildConfig(workspaceRoot);
  const postedAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  const first = await appendPostedTrackerEntries(config, [{
    id: 'afl-pick-1',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Geelong Cats vs Sydney Swans',
    startTime: postedAt,
    summary: 'Tom Atkins 20+ Disposals + Max Holmes 20+ Disposals',
    stakeUnits: 1,
    source: 'auto-generator'
  }], postedAt);

  const duplicate = await appendPostedTrackerEntries(config, [{
    id: 'afl-pick-2',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Geelong Cats vs Sydney Swans',
    startTime: postedAt,
    summary: 'Tom Atkins 20+ Disposals + Max Holmes 20+ Disposals',
    stakeUnits: 1,
    source: 'auto-generator'
  }], postedAt);

  const distinct = await appendPostedTrackerEntries(config, [{
    id: 'afl-pick-3',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Geelong Cats vs Sydney Swans',
    startTime: postedAt,
    summary: 'Tom Atkins 15+ Disposals + Isaac Heeney 20+ Disposals',
    stakeUnits: 1,
    source: 'auto-generator'
  }], postedAt);

  const rows = await readBankrollTrackerRows(config);
  const summary = await buildDailyTrackerSummary(config, new Date());

  assert.equal(first.length, 1);
  assert.equal(duplicate.length, 0);
  assert.equal(distinct.length, 1);
  assert.equal(rows.filter((row) => row.transaction_type === 'post').length, 2);
  assert.equal(summary.openExposureUnits, 2);
  assert.equal(summary.lifetimePlacedUnits, 2);
});

test('runTrackerSummaryJob does not throw when the MLB ledger has activity but its webhook is unset (daemon-crash regression)', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-tracker-mlb-unset-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildConfig(workspaceRoot);
  config.bankrollTracker.mlb = {
    csvFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker-mlb.csv'),
    startingBankrollUnits: 10,
    unitSizeAud: 10,
    settlementWebhook: 'mlbTracking',
    summaryWebhook: 'mlbReport'
  };
  config.discord.webhooks.mlbTracking = '';
  config.discord.webhooks.mlbReport = '';

  // Give the MLB ledger an open position so its daily summary is non-null and the
  // post path is reached.
  const postedAt = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  await appendPostedTrackerEntries(buildMlbLedgerConfig(config), [{
    id: 'mlb-open-1',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'MLB Game',
    startTime: postedAt,
    summary: 'MLB Game Run Line',
    stakeUnits: 1,
    source: 'auto-generator'
  }], postedAt);

  // Real mode (dryRun:false) with an unset MLB report webhook must SKIP the post,
  // not throw — an unhandled throw here exits the daemon ("turns off automatically").
  const state = { jobs: {} };
  await assert.doesNotReject(runTrackerSummaryJob({ config, state, dryRun: false }));
});