import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendPostedTrackerEntries, buildMlbLedgerConfig } from '../src/bot-tracker.mjs';
import { formatUnitTrackingMessages } from '../src/formatters.mjs';
import { runResultsJob } from '../src/jobs/results.mjs';
import { extractEspnPlayerBoxscoreStats, fetchEspnSummary } from '../src/providers/espn.mjs';

const PROFIT_TRACKER_TEMPLATE = `# 30 Day Profit Tracker

## Bankroll Snapshot

| Metric | Value |
| --- | ---: |
| Unit Size | $10.00 |
| Starting Bankroll | 100.00u / $1000.00 AUD |
| Current Bankroll | 100.00u / $1000.00 AUD |
| Available To Deploy | 100.00u / $1000.00 AUD |
| Unsettled Exposure | 0.00u / $0.00 AUD |
| Net Profit/Loss | +0.00u / +$0.00 AUD |
| Total Settled Cash Stake | 0.00u / $0.00 AUD |
| Current ROI | 0.00% |
| Settled Record | 0 Wins / 0 Losses / 0 Refunds |
| Win Rate | N/A |

## Pending Bet Notes

No open positions currently.

## Settled Bet Log

| Date | Sport | Event | Slip | Stake (u) | Stake (AUD) | Result | Return (u) | Return (AUD) | Net (u) | Net (AUD) | Closing Bankroll | Notes |
| --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- |

## User-Reported Overnight Settlements

None.
`;

const LOSS_LOG_TEMPLATE = `# Rolling Loss Log

## Open Loss Follow-Up

| Date | Sport | Event | Stake | Result Context | Known Missed Legs | Pattern Tag | Follow-Up Status | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Unreconciled User-Reported Loss Notes

- None.
`;

test('extractEspnPlayerBoxscoreStats handles AFL labelled boxscores and derives NRL scorer points', () => {
  const aflPlayers = extractEspnPlayerBoxscoreStats({
    boxscore: {
      players: [{
        team: {
          displayName: 'Hawthorn'
        },
        statistics: [{
          descriptions: ['Disposals', 'Kicks', 'Handballs'],
          athletes: [{
            athlete: {
              displayName: 'Josh Ward'
            },
            stats: ['24', '8', '16']
          }]
        }]
      }]
    }
  });
  const nrlPlayers = extractEspnPlayerBoxscoreStats({
    boxscore: {
      players: [{
        team: {
          displayName: 'Dolphins'
        },
        statistics: [{
          athletes: [{
            athlete: {
              displayName: 'Jamayne Isaako'
            },
            statistics: [{
              stats: [{
                type: 'tries',
                value: 1
              }, {
                type: 'conversionGoals',
                value: 4
              }, {
                type: 'penaltyGoals',
                value: 1
              }, {
                type: 'points',
                value: 0
              }]
            }]
          }]
        }]
      }]
    }
  });

  assert.equal(aflPlayers[0]?.playerName, 'Josh Ward');
  assert.equal(aflPlayers[0]?.disposals, 24);
  assert.equal(aflPlayers[0]?.statValues?.disposals, 24);
  assert.equal(nrlPlayers[0]?.playerName, 'Jamayne Isaako');
  assert.equal(nrlPlayers[0]?.points, 14);
  assert.equal(nrlPlayers[0]?.statValues?.points, 14);
});

test('fetchEspnSummary accepts an event object and extracts its ESPN event id', async (t) => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];

  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));

    return {
      ok: true,
      json: async () => ({
        boxscore: {
          players: []
        }
      })
    };
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const summary = await fetchEspnSummary({
    label: 'MLB',
    path: 'baseball/mlb',
    apiVariant: 'web'
  }, {
    id: 'event-mlb-1'
  });

  assert.equal(fetchCalls[0], 'https://site.web.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=event-mlb-1');
  assert.deepEqual(summary.playerStats, []);
});

test('formatUnitTrackingMessages emits separate chronological embeds with result colors', () => {
  const messages = formatUnitTrackingMessages([
    {
      sport: 'mlb',
      sportLabel: 'MLB',
      status: 'loss',
      event: 'Late Game',
      summary: 'Late Game Under 8.5',
      stakeUnits: 1,
      stakeAud: 10,
      returnUnits: 0,
      returnAud: 0,
      netUnits: -1,
      netAud: -10,
      totalUnits: 9.9,
      totalAud: 99,
      totalSettledStakeUnits: 2,
      totalSettledStakeAud: 20,
      missedLegs: ['Late Game Under 8.5'],
      hitLegs: [],
      settledAt: '2026-05-23T03:00:00.000Z'
    },
    {
      sport: 'nba',
      sportLabel: 'NBA',
      status: 'win',
      event: 'Early Game',
      summary: 'Early Game Head to Head',
      stakeUnits: 1,
      stakeAud: 10,
      returnUnits: 1.9,
      returnAud: 19,
      netUnits: 0.9,
      netAud: 9,
      totalUnits: 10.9,
      totalAud: 109,
      totalSettledStakeUnits: 1,
      totalSettledStakeAud: 10,
      missedLegs: [],
      hitLegs: ['Early Game Head to Head'],
      settledAt: '2026-05-23T01:00:00.000Z'
    }
  ], '2026-05-23');

  assert.equal(messages.length, 2);
  assert.equal(messages[0].embeds[0].title, 'NBA WIN | Unit Tracking | 2026-05-23');
  assert.equal(messages[0].embeds[0].color, 0x14532d);
  assert.equal(messages[1].embeds[0].title, 'MLB LOSS | Unit Tracking | 2026-05-23');
  assert.equal(messages[1].embeds[0].color, 0x991b1b);
});

test('runResultsJob writes settled picks back into workspace trackers and sport logs', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-'));
  const postedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  const startTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const settledAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-1',
      status: 'loss',
      sport: 'afl',
      sportLabel: 'AFL',
      league: 'AFL',
      event: 'Hawthorn vs Adelaide Crows',
      summary: 'Hawthorn Head to Head + Under 168.5',
      betType: 'sgm',
      stakeUnits: 1,
      returnUnits: 0,
      netUnits: -1,
      resultNotes: 'Late injury swing.',
      failedLegs: ['Hawthorn Head to Head'],
      legs: [{
        id: 'leg-1',
        label: 'Hawthorn Head to Head',
        status: 'loss'
      }, {
        id: 'leg-2',
        label: 'Under 168.5',
        status: 'win'
      }],
      startTime,
      settledAt
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    jobs: {
      results: {
        settlementSweepHours: 3
      }
    },
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba',
      marketKey: 'nba'
    }],
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-1': postedAt
      },
      results: {}
    },
    tracking: {
      picks: {}
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-1',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Hawthorn vs Adelaide Crows',
    startTime,
    summary: 'Hawthorn Head to Head + Under 168.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.92
    }
  }], postedAt);

  const originalConsoleLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  let result;

  try {
    result = await runResultsJob({ config, state, dryRun: true });
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(result.posted, 1);
  assert.ok(state.posts.results['pick-1']);

  const sportCsv = await fs.readFile(path.join(workspaceRoot, 'sports', 'afl', 'bets.csv'), 'utf8');
  const sportSummary = await fs.readFile(path.join(workspaceRoot, 'sports', 'afl', 'summary.md'), 'utf8');
  const updatedTracker = await fs.readFile(trackerFile, 'utf8');
  const updatedLossLog = await fs.readFile(lossLogFile, 'utf8');
  const bankrollTrackerCsv = await fs.readFile(bankrollTrackerFile, 'utf8');
  const losingLegsReport = await fs.readFile(losingLegsReportFile, 'utf8');

  assert.match(sportCsv, /Hawthorn vs Adelaide Crows/);
  assert.match(sportCsv, /Source pick id: pick-1/);
  assert.match(sportSummary, /# AFL Tracker/);
  assert.match(sportSummary, /\| Losses \| 1 \|/);
  assert.match(updatedTracker, /\| Current Bankroll \| 99\.00u \/ \$990\.00 AUD \|/);
  assert.match(updatedTracker, /\| Current ROI \(vs Starting Bankroll\) \| -1\.00% \|/);
  assert.match(updatedTracker, /\| Settled Record \| 0 Wins \/ 1 Losses \/ 0 Refunds \|/);
  assert.match(updatedLossLog, /Hawthorn vs Adelaide Crows/);
  assert.match(bankrollTrackerCsv, /settle:pick-1/);
  assert.match(bankrollTrackerCsv, /Hawthorn Head to Head/);
  assert.match(losingLegsReport, /Hawthorn Head to Head/);
  assert.match(logs.join('\n'), /Unit Tracking/);
  assert.match(logs.join('\n'), /Settled Stake/);
  assert.match(logs.join('\n'), /Net \/ Bankroll/);
  assert.match(logs.join('\n'), /Missed:/);
});

test('runResultsJob appends settlement ledger rows in settled order even when the feed order is reversed', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-settlement-order-'));
  const postedAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const earlySettledAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const lateSettledAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const earlyStartTime = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const lateStartTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-late',
      status: 'loss',
      sport: 'nba',
      sportLabel: 'NBA',
      league: 'NBA',
      event: 'Late Game',
      summary: 'Late Game Under 8.5',
      betType: 'single',
      stakeUnits: 1,
      returnUnits: 0,
      netUnits: -1,
      legs: [{ id: 'leg-late', label: 'Late Game Under 8.5', status: 'loss' }],
      startTime: lateStartTime,
      settledAt: lateSettledAt
    }, {
      id: 'pick-early',
      status: 'win',
      sport: 'nba',
      sportLabel: 'NBA',
      league: 'NBA',
      event: 'Early Game',
      summary: 'Early Game Head to Head',
      betType: 'single',
      stakeUnits: 1,
      returnUnits: 1.9,
      netUnits: 0.9,
      legs: [{ id: 'leg-early', label: 'Early Game Head to Head', status: 'win' }],
      startTime: earlyStartTime,
      settledAt: earlySettledAt
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    jobs: {
      results: {
        settlementSweepHours: 3
      }
    },
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba',
      marketKey: 'nba'
    }],
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-late': postedAt,
        'pick-early': postedAt
      },
      results: {}
    },
    tracking: {
      picks: {}
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-late',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'Late Game',
    startTime: lateStartTime,
    summary: 'Late Game Under 8.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }, {
    id: 'pick-early',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'Early Game',
    startTime: earlyStartTime,
    summary: 'Early Game Head to Head',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true });

  assert.equal(result.posted, 2);

  const bankrollTrackerCsv = await fs.readFile(bankrollTrackerFile, 'utf8');
  const earlyIndex = bankrollTrackerCsv.indexOf('settle:pick-early');
  const lateIndex = bankrollTrackerCsv.indexOf('settle:pick-late');

  assert.notEqual(earlyIndex, -1);
  assert.notEqual(lateIndex, -1);
  assert.ok(earlyIndex < lateIndex);
});

test('runResultsJob rebuilds posted state from the tracker after restart and still auto-settles the slip', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-restart-recovery-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'restart-pick-1',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      league: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      summary: 'Oklahoma City Thunder Head to Head',
      betType: 'single',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 1.9
      },
      legs: [{
        id: 'leg-1',
        label: 'Oklahoma City Thunder Head to Head',
        status: 'active',
        source: {
          market: 'h2h',
          outcomeName: 'Oklahoma City Thunder',
          description: '',
          point: null
        }
      }],
      startTime,
      source: 'auto-generator'
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
    },
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba',
      marketKey: 'nba',
      enabled: true
    }],
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {},
      results: {}
    },
    tracking: {
      picks: {}
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'restart-pick-1',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Oklahoma City Thunder Head to Head',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: '401000999',
        startTime,
        homeTeam: 'Oklahoma City Thunder',
        awayTeam: 'San Antonio Spurs',
        homeScore: 112,
        awayScore: 101,
        state: 'post'
      }]
    })
  });

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.equal(state.posts.picks['restart-pick-1'], postedAt);
  assert.ok(state.posts.results['restart-pick-1']);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(updatedFeed.picks[0].status, 'win');
});

test('runResultsJob auto-settles from cached publication odds when the saved pick and tracker row have no usable price', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-cached-odds-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const pickId = 'cached-odds-pick-1';
  const cacheKey = JSON.stringify({
    sportKey: 'nba',
    market: 'h2h',
    homeTeam: 'oklahoma city thunder',
    awayTeam: 'san antonio spurs',
    outcomeName: 'oklahoma city thunder',
    description: '',
    point: null,
    minimumOdds: 1.01,
    minimumBooksAtOrAbove: 0,
    regions: '',
    bookmakers: []
  });

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: pickId,
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      league: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      summary: 'Oklahoma City Thunder Head to Head',
      betType: 'single',
      stakeUnits: 1,
      legs: [{
        id: 'leg-1',
        label: 'Oklahoma City Thunder Head to Head',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Oklahoma City Thunder',
          description: '',
          point: null
        }
      }],
      startTime,
      source: 'auto-generator'
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        [pickId]: postedAt
      },
      results: {}
    },
    cache: {
      oddsValidation: {
        [cacheKey]: {
          cachedAt: new Date().toISOString(),
          result: {
            status: 'ok',
            bestOdds: 1.9,
            bestBookmaker: 'Sportsbet Web',
            booksChecked: 1,
            booksAtOrAbove: 1,
            minimumOdds: 1.01,
            source: 'snapshot',
            sourceLabel: 'bookmaker snapshot'
          }
        }
      }
    },
    tracking: {
      picks: {
        [pickId]: {
          postedAt,
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: pickId,
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Oklahoma City Thunder Head to Head',
    stakeUnits: 1,
    source: 'auto-generator'
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-cache-1',
        name: 'San Antonio Spurs vs Oklahoma City Thunder',
        homeTeam: 'Oklahoma City Thunder',
        awayTeam: 'San Antonio Spurs',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 110,
        awayScore: 100
      }]
    })
  });

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.ok(state.posts.results[pickId]);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === pickId);
  assert.equal(settledPick?.status, 'win');
  assert.equal(settledPick?.priceDecimal, 1.9);
});

test('runResultsJob auto-settles a posted supported team-market slip after the delayed final-score sweep', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-1',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      league: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      summary: 'Oklahoma City Thunder Head to Head + Under 215.5',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 1.92
      },
      legs: [{
        id: 'leg-1',
        label: 'Oklahoma City Thunder Head to Head',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Oklahoma City Thunder',
          description: '',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Under 215.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'totals',
          outcomeName: 'Under',
          description: '',
          point: 215.5
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-1': new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-1': {
          postedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-1',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Oklahoma City Thunder Head to Head + Under 215.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.92
    }
  }], new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  const originalConsoleLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  let result;

  try {
    result = await runResultsJob({ config, state, dryRun: true }, {
      fetchEspnSlate: async () => ({
        events: [{
          id: 'event-1',
          name: 'San Antonio Spurs vs Oklahoma City Thunder',
          homeTeam: 'Oklahoma City Thunder',
          awayTeam: 'San Antonio Spurs',
          startTime,
          state: 'post',
          shortStatus: 'Final',
          homeScore: 110,
          awayScore: 100
        }]
      })
    });
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.ok(state.posts.results['pick-auto-1']);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-1');
  const bankrollTrackerCsv = await fs.readFile(bankrollTrackerFile, 'utf8');

  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 1.92);
  assert.equal(settledPick.netUnits, 0.92);
  assert.match(String(settledPick.resultNotes || ''), /Auto-settled from ESPN scoreboard final score/);
  assert.match(bankrollTrackerCsv, /settle:pick-auto-1/);
  assert.match(logs.join('\n'), /Unit Tracking/);
  assert.match(logs.join('\n'), /Oklahoma City Thunder Head to Head/);
});

test('runResultsJob auto-settles MLB totals when generated team names include probable pitcher suffixes', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-mlb-pitcher-suffix-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const pickId = 'pick-auto-mlb-pitcher-suffix-1';

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: pickId,
      status: 'pending',
      sport: 'mlb',
      sportLabel: 'MLB',
      league: 'MLB',
      event: 'Houston Astros S Arrighetti vs Chicago Cubs J Taillon',
      homeTeam: 'Chicago Cubs J Taillon',
      awayTeam: 'Houston Astros S Arrighetti',
      summary: 'Over 8.5',
      betType: 'single',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 1.91
      },
      legs: [{
        id: 'leg-1',
        label: 'Over 8.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'totals',
          outcomeName: 'Over',
          description: '',
          point: 8.5
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'mlb',
      label: 'MLB',
      provider: 'espn',
      path: 'baseball/mlb'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {},
      results: {}
    },
    tracking: {
      picks: {}
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: pickId,
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Houston Astros S Arrighetti vs Chicago Cubs J Taillon',
    startTime,
    summary: 'Over 8.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.91
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-mlb-1',
        name: 'Houston Astros vs Chicago Cubs',
        homeTeam: 'Chicago Cubs',
        awayTeam: 'Houston Astros',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 6,
        awayScore: 4
      }]
    })
  });

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.ok(state.posts.results[pickId]);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === pickId);
  assert.equal(settledPick?.status, 'win');
  assert.equal(settledPick?.returnUnits, 1.91);
  assert.equal(settledPick?.netUnits, 0.91);
});

test('runResultsJob auto-settles MLB results when ESPN files the final under the previous league date', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-mlb-date-window-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = '2026-05-22T23:05:00.000Z';
  const postedAt = '2026-05-22T22:00:00.000Z';
  const pickId = 'pick-auto-mlb-date-window-1';

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: pickId,
      status: 'pending',
      sport: 'mlb',
      sportLabel: 'MLB',
      league: 'MLB',
      event: 'Tampa BAY Rays N Martinez vs NEW York Yankees G Cole',
      homeTeam: 'NEW York Yankees G Cole',
      awayTeam: 'Tampa BAY Rays N Martinez',
      summary: 'Over 8.5',
      betType: 'single',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 1.88
      },
      legs: [{
        id: 'leg-1',
        label: 'Over 8.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'totals',
          outcomeName: 'Over',
          description: '',
          point: 8.5
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'mlb',
      label: 'MLB',
      provider: 'espn',
      path: 'baseball/mlb'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {},
      results: {}
    },
    tracking: {
      picks: {}
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: pickId,
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Tampa BAY Rays N Martinez vs NEW York Yankees G Cole',
    startTime,
    summary: 'Over 8.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.88
    }
  }], postedAt);

  const requestedDateKeys = [];
  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async (_sport, dateKey) => {
      requestedDateKeys.push(dateKey);

      if (dateKey === '2026-05-22') {
        return {
          events: [{
            id: 'event-mlb-date-window-1',
            name: 'Tampa Bay Rays vs New York Yankees',
            homeTeam: 'New York Yankees',
            awayTeam: 'Tampa Bay Rays',
            startTime,
            state: 'post',
            shortStatus: 'Final',
            homeScore: 6,
            awayScore: 4
          }]
        };
      }

      if (dateKey === '2026-05-23') {
        return {
          events: [{
            id: 'event-mlb-date-window-2',
            name: 'Tampa Bay Rays vs New York Yankees',
            homeTeam: 'New York Yankees',
            awayTeam: 'Tampa Bay Rays',
            startTime: '2026-05-23T17:35:00.000Z',
            state: 'pre',
            shortStatus: 'Scheduled',
            homeScore: null,
            awayScore: null
          }]
        };
      }

      return { events: [] };
    }
  });

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.ok(requestedDateKeys.includes('2026-05-22'));
  assert.ok(requestedDateKeys.includes('2026-05-23'));
  assert.ok(state.posts.results[pickId]);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === pickId);
  assert.equal(settledPick?.status, 'win');
  assert.equal(settledPick?.returnUnits, 1.88);
  assert.equal(settledPick?.netUnits, 0.88);
});

test('runResultsJob does not settle the wrong same-team event when only team identity matches but the scheduled start time does not', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-wrong-event-guard-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const wrongEventStartTime = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-wrong-event-1',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      league: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      homeTeamId: '25',
      awayTeam: 'San Antonio Spurs',
      awayTeamId: '24',
      summary: 'Oklahoma City Thunder Head to Head',
      betType: 'single',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 1.9
      },
      legs: [{
        id: 'leg-1',
        label: 'Oklahoma City Thunder Head to Head',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Oklahoma City Thunder',
          description: '',
          point: null
        }
      }],
      startTime,
      source: 'auto-generator'
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-wrong-event-1': new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-wrong-event-1': {
          postedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-wrong-event-1',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Oklahoma City Thunder Head to Head',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-wrong-time-1',
        name: 'San Antonio Spurs vs Oklahoma City Thunder',
        homeTeam: 'Oklahoma City Thunder',
        homeTeamId: '25',
        awayTeam: 'San Antonio Spurs',
        awayTeamId: '24',
        startTime: wrongEventStartTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 110,
        awayScore: 100
      }]
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const unresolvedPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-wrong-event-1');

  assert.equal(result.autoSettled, 0);
  assert.equal(unresolvedPick.status, 'pending');
  assert.equal(state.posts.results['pick-auto-wrong-event-1'], undefined);
});

test('runResultsJob auto-settles a posted AFL slip with disposals props from the ESPN summary boxscore', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-afl-disposals-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-afl-disposals-1',
      status: 'pending',
      sport: 'afl',
      sportLabel: 'AFL',
      league: 'AFL',
      event: 'Adelaide Crows vs Hawthorn',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      summary: 'Josh Ward 20+ Disposals + Hawthorn Head to Head',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 2.1
      },
      legs: [{
        id: 'leg-1',
        label: 'Josh Ward 20+ Disposals',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '20+ Disposals',
          description: 'Josh Ward',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Hawthorn Head to Head',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Hawthorn',
          description: '',
          point: null
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'afl',
      label: 'AFL',
      provider: 'espn',
      path: 'australian-football/afl'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-afl-disposals-1': new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-afl-disposals-1': {
          postedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-afl-disposals-1',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Adelaide Crows vs Hawthorn',
    startTime,
    summary: 'Josh Ward 20+ Disposals + Hawthorn Head to Head',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.1
    }
  }], new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-afl-1',
        name: 'Adelaide Crows at Hawthorn',
        homeTeam: 'Hawthorn',
        awayTeam: 'Adelaide Crows',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 75,
        awayScore: 66
      }]
    }),
    fetchEspnSummary: async () => ({
      playerStats: extractEspnPlayerBoxscoreStats({
        boxscore: {
          players: [{
            team: {
              displayName: 'Hawthorn'
            },
            statistics: [{
              descriptions: ['Disposals', 'Kicks', 'Handballs'],
              athletes: [{
                athlete: {
                  displayName: 'Josh Ward'
                },
                stats: ['24', '8', '16']
              }]
            }]
          }]
        }
      }),
      sourceUrl: 'https://example.test/afl-summary'
    }),
    fetchAflOfficialSlate: async () => ({
      events: [{
        id: 'CD_M20260141101',
        providerId: 'CD_M20260141101',
        homeTeam: 'Hawthorn',
        awayTeam: 'Adelaide Crows',
        startTime,
        state: 'post',
        shortStatus: 'CONCLUDED',
        homeScore: 75,
        awayScore: 66
      }]
    }),
    fetchFlashscoreSlate: async () => ({
      events: []
    }),
    fetchAflOfficialSummary: async () => ({
      playerStats: [{
        playerName: 'Josh Ward',
        teamName: 'Hawthorn',
        statValues: {
          disposals: 24,
          kicks: 8,
          handballs: 16
        },
        disposals: 24
      }],
      sourceUrl: 'https://example.test/afl-official-summary'
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-afl-disposals-1');

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 2.1);
  assert.equal(settledPick.netUnits, 1.1);
});

test('runResultsJob recovers a tracker-only MLB hit slip when the feed record is missing', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-missing-feed-mlb-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const postedAt = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  const startTime = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const pickId = 'pick-missing-feed-mlb-1';

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(losingLegsReportFile, '# Bot Losing Legs Report\n');
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'mlb',
      label: 'MLB',
      provider: 'espn',
      path: 'baseball/mlb'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        [pickId]: postedAt
      },
      results: {}
    },
    tracking: {
      picks: {}
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: pickId,
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Los Angeles Angels (J Kochanowicz) vs Tampa Bay Rays (S McClanahan)',
    startTime,
    summary: 'Jo Adell 1+ Hit + Richie Palacios 1+ Hit',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.26
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-mlb-missing-feed-1',
        name: 'Los Angeles Angels vs Tampa Bay Rays',
        homeTeam: 'Tampa Bay Rays',
        awayTeam: 'Los Angeles Angels',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 5,
        awayScore: 2
      }]
    }),
    fetchEspnSummary: async () => ({
      event: {
        id: 'event-mlb-missing-feed-1',
        name: 'Los Angeles Angels vs Tampa Bay Rays',
        homeTeam: 'Tampa Bay Rays',
        awayTeam: 'Los Angeles Angels',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 5,
        awayScore: 2
      },
      playerStats: [{
        playerName: 'Jo Adell',
        teamName: 'Los Angeles Angels',
        statValues: {
          hits: 1
        }
      }, {
        playerName: 'Richie Palacios',
        teamName: 'Tampa Bay Rays',
        statValues: {
          hits: 0
        }
      }]
    })
  });

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === pickId);

  assert.ok(settledPick);
  assert.equal(settledPick.status, 'loss');
  assert.equal(settledPick.legs[0].status, 'win');
  assert.equal(settledPick.legs[1].status, 'loss');
});

test('runResultsJob keeps an AFL disposal slip pending when the official player summary fetch fails after ESPN grades it as a win', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-afl-summary-retry-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-afl-disposals-retry-1',
      status: 'pending',
      sport: 'afl',
      sportLabel: 'AFL',
      league: 'AFL',
      event: 'Adelaide Crows vs Hawthorn',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      summary: 'Josh Ward 20+ Disposals + Hawthorn Head to Head',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 2.1
      },
      legs: [{
        id: 'leg-1',
        label: 'Josh Ward 20+ Disposals',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '20+ Disposals',
          description: 'Josh Ward',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Hawthorn Head to Head',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Hawthorn',
          description: '',
          point: null
        }
      }],
      startTime,
      source: 'auto-generator'
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'afl',
      label: 'AFL',
      provider: 'espn',
      path: 'australian-football/afl'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-afl-disposals-retry-1': postedAt
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-afl-disposals-retry-1': {
          postedAt,
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-afl-disposals-retry-1',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Adelaide Crows vs Hawthorn',
    startTime,
    summary: 'Josh Ward 20+ Disposals + Hawthorn Head to Head',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.1
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-afl-retry-1',
        name: 'Adelaide Crows at Hawthorn',
        homeTeam: 'Hawthorn',
        awayTeam: 'Adelaide Crows',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 75,
        awayScore: 66
      }]
    }),
    fetchEspnSummary: async () => ({
      playerStats: extractEspnPlayerBoxscoreStats({
        boxscore: {
          players: [{
            team: {
              displayName: 'Hawthorn'
            },
            statistics: [{
              descriptions: ['Disposals', 'Kicks', 'Handballs'],
              athletes: [{
                athlete: {
                  displayName: 'Josh Ward'
                },
                stats: ['24', '8', '16']
              }]
            }]
          }]
        }
      }),
      sourceUrl: 'https://example.test/afl-summary'
    }),
    fetchAflOfficialSlate: async () => ({
      events: [{
        id: 'CD_M20260141101',
        providerId: 'CD_M20260141101',
        homeTeam: 'Hawthorn',
        awayTeam: 'Adelaide Crows',
        startTime,
        state: 'post',
        shortStatus: 'CONCLUDED',
        homeScore: 75,
        awayScore: 66
      }]
    }),
    fetchAflOfficialSummary: async () => {
      throw new Error('temporary token failure');
    },
    fetchFlashscoreSlate: async () => ({
      events: []
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const pendingPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-afl-disposals-retry-1');

  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  assert.equal(result.posted, 0);
  assert.equal(pendingPick.status, 'pending');
  assert.equal(state.posts.results['pick-auto-afl-disposals-retry-1'], undefined);
  assert.match(String(state.tracking.picks['pick-auto-afl-disposals-retry-1']?.settlementPendingReason || ''), /Only 1 source confirmed Josh Ward 20\+ Disposals/i);
  assert.match(String(state.tracking.picks['pick-auto-afl-disposals-retry-1']?.settlementPendingReason || ''), /Official AFL player stats request failed/i);
});

test('runResultsJob settles an AFL team-market slip when Official AFL and Flashscore outvote an ESPN score disagreement', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-afl-flashscore-consensus-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-afl-flashscore-consensus-1',
      status: 'pending',
      sport: 'afl',
      sportLabel: 'AFL',
      league: 'AFL',
      event: 'Adelaide Crows vs Hawthorn',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      summary: 'Hawthorn Head to Head',
      betType: 'single',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 1.95
      },
      legs: [{
        id: 'leg-1',
        label: 'Hawthorn Head to Head',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Hawthorn',
          description: '',
          point: null
        }
      }],
      startTime,
      source: 'auto-generator'
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'afl',
      label: 'AFL',
      provider: 'espn',
      path: 'australian-football/afl'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-afl-flashscore-consensus-1': new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-afl-flashscore-consensus-1': {
          postedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-afl-flashscore-consensus-1',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Adelaide Crows vs Hawthorn',
    startTime,
    summary: 'Hawthorn Head to Head',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.95
    }
  }], new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-afl-flashscore-consensus-1',
        name: 'Adelaide Crows at Hawthorn',
        homeTeam: 'Hawthorn',
        awayTeam: 'Adelaide Crows',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 60,
        awayScore: 90
      }]
    }),
    fetchAflOfficialSlate: async () => ({
      events: [{
        id: 'CD_M20260141102',
        providerId: 'CD_M20260141102',
        homeTeam: 'Hawthorn',
        awayTeam: 'Adelaide Crows',
        startTime,
        state: 'post',
        shortStatus: 'CONCLUDED',
        homeScore: 75,
        awayScore: 66
      }]
    }),
    fetchFlashscoreSlate: async () => ({
      events: [{
        id: 'h8jZNQOb',
        providerId: 'h8jZNQOb',
        homeTeam: 'Hawthorn Hawks',
        awayTeam: 'Adelaide Crows',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 75,
        awayScore: 66
      }]
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-afl-flashscore-consensus-1');

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 1.95);
  assert.equal(settledPick.netUnits, 0.95);
  assert.match(String(settledPick.resultNotes || ''), /Official AFL, Flashscore/);
  assert.match(String(settledPick.resultNotes || ''), /Adelaide Crows 66 - Hawthorn 75/);
  assert.ok(!/ESPN/.test(String(settledPick.resultNotes || '')));
});

test('runResultsJob treats AFL 10+ disposal ladders with null source.point as real thresholds, not zero-line wins', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-afl-threshold-loss-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-afl-threshold-loss-1',
      status: 'pending',
      sport: 'afl',
      sportLabel: 'AFL',
      league: 'AFL',
      event: 'Richmond vs Essendon',
      homeTeam: 'Richmond',
      homeTeamId: '12',
      awayTeam: 'Essendon',
      awayTeamId: '16',
      espnEventId: '1133574',
      summary: 'Archer Day-Wicks 10+ Disposals + Archie Perkins 13+ Disposals + Ben Miller 12+ Disposals',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 2.21
      },
      legs: [{
        id: 'leg-1',
        label: 'Archer Day-Wicks 10+ Disposals',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '10+ Disposals',
          description: 'Archer Day-Wicks',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Archie Perkins 13+ Disposals',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '13+ Disposals',
          description: 'Archie Perkins',
          point: null
        }
      }, {
        id: 'leg-3',
        label: 'Ben Miller 12+ Disposals',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '12+ Disposals',
          description: 'Ben Miller',
          point: null
        }
      }],
      startTime,
      source: 'auto-generator'
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'afl',
      label: 'AFL',
      provider: 'espn',
      path: 'australian-football/afl'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-afl-threshold-loss-1': new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-afl-threshold-loss-1': {
          postedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-afl-threshold-loss-1',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Richmond vs Essendon',
    startTime,
    summary: 'Archer Day-Wicks 10+ Disposals + Archie Perkins 13+ Disposals + Ben Miller 12+ Disposals',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.21
    }
  }], new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-afl-threshold-loss-1',
        name: 'Richmond vs Essendon',
        homeTeam: 'Richmond',
        awayTeam: 'Essendon',
        homeTeamId: '12',
        awayTeamId: '16',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 74,
        awayScore: 56
      }]
    }),
    fetchEspnSummary: async () => ({
      playerStats: extractEspnPlayerBoxscoreStats({
        boxscore: {
          players: [{
            team: {
              displayName: 'Richmond'
            },
            statistics: [{
              descriptions: ['Disposals', 'Kicks', 'Handballs'],
              athletes: [{
                athlete: {
                  displayName: 'Archer Day-Wicks'
                },
                stats: ['8', '3', '5']
              }, {
                athlete: {
                  displayName: 'Ben Miller'
                },
                stats: ['17', '16', '1']
              }]
            }]
          }, {
            team: {
              displayName: 'Essendon'
            },
            statistics: [{
              descriptions: ['Disposals', 'Kicks', 'Handballs'],
              athletes: [{
                athlete: {
                  displayName: 'Archie Perkins'
                },
                stats: ['19', '10', '9']
              }]
            }]
          }]
        }
      }),
      sourceUrl: 'https://example.test/afl-summary-threshold-loss'
    }),
    fetchAflOfficialSlate: async () => ({
      events: [{
        id: 'CD_M20260141255',
        providerId: 'CD_M20260141255',
        homeTeam: 'Richmond',
        awayTeam: 'Essendon',
        startTime,
        state: 'post',
        shortStatus: 'CONCLUDED',
        homeScore: 74,
        awayScore: 56
      }]
    }),
    fetchFlashscoreSlate: async () => ({
      events: []
    }),
    fetchAflOfficialSummary: async () => ({
      playerStats: [{
        playerName: 'Archer Day-Wicks',
        teamName: 'Richmond',
        statValues: {
          disposals: 8,
          kicks: 3,
          handballs: 5
        },
        disposals: 8
      }, {
        playerName: 'Ben Miller',
        teamName: 'Richmond',
        statValues: {
          disposals: 17,
          kicks: 16,
          handballs: 1
        },
        disposals: 17
      }, {
        playerName: 'Archie Perkins',
        teamName: 'Essendon',
        statValues: {
          disposals: 19,
          kicks: 10,
          handballs: 9
        },
        disposals: 19
      }],
      sourceUrl: 'https://example.test/afl-official-threshold-loss'
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-afl-threshold-loss-1');

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.equal(settledPick.status, 'loss');
  assert.equal(settledPick.returnUnits, 0);
  assert.equal(settledPick.netUnits, -1);
  assert.equal(settledPick.legs[0].status, 'loss');
  assert.equal(settledPick.legs[1].status, 'win');
  assert.equal(settledPick.legs[2].status, 'win');
});

test('runResultsJob keeps duplicate-name player prop ambiguity pending for review instead of forcing a loss', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-ambiguous-player-prop-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const postedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-ambiguous-player-1',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      league: 'NBA',
      event: 'Home Team vs Away Team',
      homeTeam: 'Home Team',
      awayTeam: 'Away Team',
      summary: 'Alex Smith Over 19.5 Points',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 1.95
      },
      legs: [{
        id: 'leg-1',
        label: 'Alex Smith Over 19.5 Points',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Alex Smith',
          point: 19.5
        }
      }],
      startTime,
      source: 'auto-generator'
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-ambiguous-player-1': postedAt
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-ambiguous-player-1': {
          postedAt,
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-ambiguous-player-1',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'Home Team vs Away Team',
    startTime,
    summary: 'Alex Smith Over 19.5 Points',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.95
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-ambiguous-player-1',
        name: 'Away Team vs Home Team',
        homeTeam: 'Home Team',
        awayTeam: 'Away Team',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 101,
        awayScore: 99
      }]
    }),
    fetchEspnSummary: async () => ({
      playerStats: extractEspnPlayerBoxscoreStats({
        boxscore: {
          players: [{
            team: {
              displayName: 'Home Team'
            },
            statistics: [{
              descriptions: ['Points'],
              athletes: [{
                athlete: {
                  displayName: 'Alex Smith'
                },
                stats: ['22']
              }]
            }]
          }, {
            team: {
              displayName: 'Away Team'
            },
            statistics: [{
              descriptions: ['Points'],
              athletes: [{
                athlete: {
                  displayName: 'Alex Smith'
                },
                stats: ['9']
              }]
            }]
          }]
        }
      }),
      sourceUrl: 'https://example.test/nba-summary-ambiguous-player'
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const pendingPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-ambiguous-player-1');

  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  assert.equal(result.posted, 0);
  assert.equal(pendingPick.status, 'pending');
  assert.equal(state.posts.results['pick-auto-ambiguous-player-1'], undefined);
  assert.match(String(state.tracking.picks['pick-auto-ambiguous-player-1']?.settlementPendingReason || ''), /multiple player stat rows/i);
});

test('runResultsJob auto-settles a posted NRL slip with player points and first-half totals', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-nrl-props-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-nrl-props-1',
      status: 'pending',
      sport: 'nrl',
      sportLabel: 'NRL',
      league: 'NRL',
      event: 'Canterbury Bulldogs vs Melbourne Storm',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      summary: 'Matt Burton 6+ Points + Nick Meaney 4+ Points + 1st Half Over 23.5',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 2.24
      },
      legs: [{
        id: 'leg-1',
        label: 'Matt Burton 6+ Points',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: '6+ Points',
          description: 'Matt Burton',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Nick Meaney 4+ Points',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: '4+ Points',
          description: 'Nick Meaney',
          point: null
        }
      }, {
        id: 'leg-3',
        label: '1st Half Over 23.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'first_half_totals',
          outcomeName: 'Over',
          description: '',
          point: 23.5
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nrl',
      label: 'NRL',
      provider: 'snapshot',
      path: 'rugbyleague_nrl'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-nrl-props-1': new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-nrl-props-1': {
          postedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-nrl-props-1',
    sport: 'nrl',
    sportLabel: 'NRL',
    event: 'Canterbury Bulldogs vs Melbourne Storm',
    startTime,
    summary: 'Matt Burton 6+ Points + Nick Meaney 4+ Points + 1st Half Over 23.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.24
    }
  }], new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async (sport) => {
      assert.equal(sport.apiVariant, 'web');
      assert.equal(sport.path, 'rugby-league/3');

      return {
        events: [{
          id: 'event-nrl-1',
          name: 'Storm vs Bulldogs',
          homeTeam: 'Bulldogs',
          awayTeam: 'Storm',
          startTime,
          state: 'post',
          shortStatus: 'Final',
          homeScore: 30,
          awayScore: 20,
          homeLinescores: [{
            period: 1,
            value: 6
          }],
          awayLinescores: [{
            period: 1,
            value: 18
          }]
        }]
      };
    },
    fetchNrlOfficialSlate: async () => ({
      events: [{
        id: '20261111210',
        matchCentreUrl: '/draw/nrl-premiership/2026/round-12/bulldogs-v-storm/',
        homeTeam: 'Canterbury Bulldogs',
        awayTeam: 'Melbourne Storm',
        startTime,
        state: 'post',
        shortStatus: 'FullTime',
        homeScore: 30,
        awayScore: 20,
        homeLinescores: [],
        awayLinescores: []
      }]
    }),
    fetchFlashscoreSlate: async () => ({
      events: []
    }),
    fetchEspnSummary: async (sport) => {
      assert.equal(sport.apiVariant, 'web');

      return {
        playerStats: extractEspnPlayerBoxscoreStats({
          boxscore: {
            players: [{
              team: {
                displayName: 'Canterbury Bulldogs'
              },
              statistics: [{
                athletes: [{
                  athlete: {
                    displayName: 'Matt Burton'
                  },
                  statistics: [{
                    stats: [{
                      type: 'tries',
                      value: 1
                    }, {
                      type: 'conversionGoals',
                      value: 1
                    }, {
                      type: 'penaltyGoals',
                      value: 0
                    }, {
                      type: 'dropGoalsConverted',
                      value: 0
                    }, {
                      type: 'points',
                      value: 0
                    }]
                  }]
                }]
              }]
            }, {
              team: {
                displayName: 'Melbourne Storm'
              },
              statistics: [{
                athletes: [{
                  athlete: {
                    displayName: 'Nick Meaney'
                  },
                  statistics: [{
                    stats: [{
                      type: 'tries',
                      value: 0
                    }, {
                      type: 'conversionGoals',
                      value: 2
                    }, {
                      type: 'penaltyGoals',
                      value: 0
                    }, {
                      type: 'dropGoalsConverted',
                      value: 0
                    }, {
                      type: 'points',
                      value: 0
                    }]
                  }]
                }]
              }]
            }]
          }
        }),
        sourceUrl: 'https://example.test/nrl-summary'
      };
    },
    fetchNrlOfficialSummary: async () => ({
      playerStats: [{
        playerName: 'Matt Burton',
        teamName: 'Canterbury Bulldogs',
        statValues: {
          points: 6
        },
        points: 6
      }, {
        playerName: 'Nick Meaney',
        teamName: 'Melbourne Storm',
        statValues: {
          points: 4
        },
        points: 4
      }],
      event: {
        homeLinescores: [{
          period: 1,
          value: 12,
          cumulativeValue: 12,
          displayValue: '12'
        }],
        awayLinescores: [{
          period: 1,
          value: 12,
          cumulativeValue: 12,
          displayValue: '12'
        }]
      },
      sourceUrl: 'https://example.test/nrl-official-summary'
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-nrl-props-1');

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 2.24);
  assert.equal(settledPick.netUnits, 1.24);
});

test('runResultsJob auto-settles an NRL team-market slip when scoreboards use nickname-only team names', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-nrl-nicknames-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-nrl-team-nicknames-1',
      status: 'pending',
      sport: 'nrl',
      sportLabel: 'NRL',
      league: 'NRL',
      event: 'Penrith Panthers vs New Zealand Warriors',
      homeTeam: 'Penrith Panthers',
      awayTeam: 'New Zealand Warriors',
      summary: '1st Half Under 22.5 + Penrith Panthers H2H',
      betType: 'sgm',
      stakeUnits: 0.5,
      publicationValidation: {
        totalOdds: 3.15
      },
      legs: [{
        id: 'leg-1',
        label: '1st Half Under 22.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'first_half_totals',
          outcomeName: 'Under',
          description: '',
          point: 22.5
        }
      }, {
        id: 'leg-2',
        label: 'Penrith Panthers H2H',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Penrith Panthers',
          description: '',
          point: null
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nrl',
      label: 'NRL',
      provider: 'snapshot',
      path: 'rugbyleague_nrl'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-nrl-team-nicknames-1': postedAt
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-nrl-team-nicknames-1': {
          postedAt,
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-nrl-team-nicknames-1',
    sport: 'nrl',
    sportLabel: 'NRL',
    event: 'Penrith Panthers vs New Zealand Warriors',
    startTime,
    summary: '1st Half Under 22.5 + Penrith Panthers H2H',
    stakeUnits: 0.5,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 3.15
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-nrl-nickname-1',
        name: 'Warriors vs Panthers',
        homeTeam: 'Panthers',
        awayTeam: 'Warriors',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 20,
        awayScore: 18,
        homeLinescores: [{
          period: 1,
          value: 16,
          cumulativeValue: 16,
          displayValue: '16'
        }],
        awayLinescores: [{
          period: 1,
          value: 6,
          cumulativeValue: 6,
          displayValue: '6'
        }]
      }]
    }),
    fetchNrlOfficialSlate: async () => ({
      events: [{
        id: '/draw/nrl-premiership/2026/round-13/panthers-v-warriors/',
        matchCentreUrl: '/draw/nrl-premiership/2026/round-13/panthers-v-warriors/',
        homeTeam: 'Panthers',
        awayTeam: 'Warriors',
        startTime,
        state: 'post',
        shortStatus: 'FullTime',
        homeScore: 20,
        awayScore: 18,
        homeLinescores: [],
        awayLinescores: []
      }]
    }),
    fetchNrlOfficialSummary: async () => ({
      playerStats: [],
      event: {
        homeLinescores: [{
          period: 1,
          value: 16,
          cumulativeValue: 16,
          displayValue: '16'
        }],
        awayLinescores: [{
          period: 1,
          value: 6,
          cumulativeValue: 6,
          displayValue: '6'
        }]
      },
      sourceUrl: 'https://example.test/nrl-nickname-summary'
    }),
    fetchFlashscoreSlate: async () => ({
      events: []
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-nrl-team-nicknames-1');

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 1.58);
  assert.equal(settledPick.netUnits, 1.08);
});

test('runResultsJob keeps an unresolved NRL supported prop disagreement pending for review instead of forcing a loss', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-nrl-consensus-pending-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-nrl-consensus-pending-1',
      status: 'pending',
      sport: 'nrl',
      sportLabel: 'NRL',
      league: 'NRL',
      event: 'Canterbury Bulldogs vs Melbourne Storm',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      summary: 'Matt Burton 6+ Points + Nick Meaney 4+ Points + 1st Half Over 23.5',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 2.24
      },
      legs: [{
        id: 'leg-1',
        label: 'Matt Burton 6+ Points',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: '6+ Points',
          description: 'Matt Burton',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Nick Meaney 4+ Points',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: '4+ Points',
          description: 'Nick Meaney',
          point: null
        }
      }, {
        id: 'leg-3',
        label: '1st Half Over 23.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'first_half_totals',
          outcomeName: 'Over',
          description: '',
          point: 23.5
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nrl',
      label: 'NRL',
      provider: 'snapshot',
      path: 'rugbyleague_nrl'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-nrl-consensus-pending-1': postedAt
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-nrl-consensus-pending-1': {
          postedAt,
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-nrl-consensus-pending-1',
    sport: 'nrl',
    sportLabel: 'NRL',
    event: 'Canterbury Bulldogs vs Melbourne Storm',
    startTime,
    summary: 'Matt Burton 6+ Points + Nick Meaney 4+ Points + 1st Half Over 23.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.24
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-nrl-consensus-pending-1',
        name: 'Storm vs Bulldogs',
        homeTeam: 'Bulldogs',
        awayTeam: 'Storm',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 30,
        awayScore: 20,
        homeLinescores: [{
          period: 1,
          value: 12,
          cumulativeValue: 12,
          displayValue: '12'
        }],
        awayLinescores: [{
          period: 1,
          value: 12,
          cumulativeValue: 12,
          displayValue: '12'
        }]
      }]
    }),
    fetchEspnSummary: async () => ({
      playerStats: extractEspnPlayerBoxscoreStats({
        boxscore: {
          players: [{
            team: {
              displayName: 'Canterbury Bulldogs'
            },
            statistics: [{
              athletes: [{
                athlete: {
                  displayName: 'Matt Burton'
                },
                statistics: [{
                  stats: [{
                    type: 'tries',
                    value: 1
                  }, {
                    type: 'conversionGoals',
                    value: 1
                  }, {
                    type: 'penaltyGoals',
                    value: 0
                  }, {
                    type: 'dropGoalsConverted',
                    value: 0
                  }, {
                    type: 'points',
                    value: 0
                  }]
                }]
              }]
            }]
          }, {
            team: {
              displayName: 'Melbourne Storm'
            },
            statistics: [{
              athletes: [{
                athlete: {
                  displayName: 'Nick Meaney'
                },
                statistics: [{
                  stats: [{
                    type: 'tries',
                    value: 0
                  }, {
                    type: 'conversionGoals',
                    value: 2
                  }, {
                    type: 'penaltyGoals',
                    value: 0
                  }, {
                    type: 'dropGoalsConverted',
                    value: 0
                  }, {
                    type: 'points',
                    value: 0
                  }]
                }]
              }]
            }]
          }]
        }
      }),
      sourceUrl: 'https://example.test/nrl-summary-consensus-pending'
    }),
    fetchNrlOfficialSlate: async () => ({
      events: [{
        id: '20261111210',
        matchCentreUrl: '/draw/nrl-premiership/2026/round-12/bulldogs-v-storm/',
        homeTeam: 'Canterbury Bulldogs',
        awayTeam: 'Melbourne Storm',
        startTime,
        state: 'post',
        shortStatus: 'FullTime',
        homeScore: 30,
        awayScore: 20,
        homeLinescores: [],
        awayLinescores: []
      }]
    }),
    fetchFlashscoreSlate: async () => ({
      events: []
    }),
    fetchNrlOfficialSummary: async () => ({
      playerStats: [{
        playerName: 'Matt Burton',
        teamName: 'Canterbury Bulldogs',
        statValues: {
          points: 6
        },
        points: 6
      }, {
        playerName: 'Nick Meaney',
        teamName: 'Melbourne Storm',
        statValues: {
          points: 2
        },
        points: 2
      }],
      event: {
        homeLinescores: [{
          period: 1,
          value: 12,
          cumulativeValue: 12,
          displayValue: '12'
        }],
        awayLinescores: [{
          period: 1,
          value: 12,
          cumulativeValue: 12,
          displayValue: '12'
        }]
      },
      sourceUrl: 'https://example.test/nrl-official-summary-consensus-pending'
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const pendingPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-nrl-consensus-pending-1');

  assert.equal(result.autoSettled, 0);
  assert.equal(result.pendingReview, 1);
  assert.equal(result.posted, 0);
  assert.equal(pendingPick.status, 'pending');
  assert.equal(state.posts.results['pick-auto-nrl-consensus-pending-1'], undefined);
  assert.match(String(state.tracking.picks['pick-auto-nrl-consensus-pending-1']?.settlementPendingReason || ''), /disagreed on Nick Meaney|agreeing sources/i);
});

test('runResultsJob auto-settles a posted NBA same-game slip with a supported player prop from the ESPN summary boxscore', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-prop-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-prop-1',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      league: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      summary: 'Shai Gilgeous-Alexander Over 29.5 + Oklahoma City Thunder Head to Head',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 2.35
      },
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }, {
        id: 'leg-2',
        label: 'Oklahoma City Thunder Head to Head',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Oklahoma City Thunder',
          description: '',
          point: null
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-prop-1': new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-prop-1': {
          postedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-prop-1',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Shai Gilgeous-Alexander Over 29.5 + Oklahoma City Thunder Head to Head',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.35
    }
  }], new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  const originalConsoleLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  let result;

  try {
    result = await runResultsJob({ config, state, dryRun: true }, {
      fetchEspnSlate: async () => ({
        events: [{
          id: 'event-prop-1',
          name: 'San Antonio Spurs vs Oklahoma City Thunder',
          homeTeam: 'Oklahoma City Thunder',
          awayTeam: 'San Antonio Spurs',
          startTime,
          state: 'post',
          shortStatus: 'Final',
          homeScore: 110,
          awayScore: 100
        }]
      }),
      fetchEspnSummary: async () => ({
        sourceUrl: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=event-prop-1',
        playerStats: [{
          playerName: 'Shai Gilgeous-Alexander',
          teamName: 'Oklahoma City Thunder',
          points: 32,
          rebounds: 7,
          assists: 5,
          threesMade: 2
        }]
      })
    });
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.ok(state.posts.results['pick-auto-prop-1']);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-prop-1');
  const bankrollTrackerCsv = await fs.readFile(bankrollTrackerFile, 'utf8');

  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 2.35);
  assert.equal(settledPick.netUnits, 1.35);
  assert.equal(settledPick.legs[0].status, 'win');
  assert.equal(settledPick.legs[1].status, 'win');
  assert.match(String(settledPick.resultNotes || ''), /Auto-settled from ESPN scoreboard final score/);
  assert.match(bankrollTrackerCsv, /settle:pick-auto-prop-1/);
  assert.match(logs.join('\n'), /Unit Tracking/);
  assert.match(logs.join('\n'), /Shai Gilgeous-Alexander Over 29.5/);
});

test('runResultsJob auto-settles a posted UCL slip with double chance when team names use scoreboard aliases', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-ucl-double-chance-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-ucl-double-chance-1',
      status: 'pending',
      sport: 'soccer_uefa_champs_league',
      sportLabel: 'Soccer / UCL',
      league: 'UEFA Champions League',
      event: 'Paris St-G vs Arsenal',
      homeTeam: 'Paris St-G',
      awayTeam: 'Arsenal',
      summary: 'Under 2.5 + Arsenal And Draw Double Chance',
      betType: 'sgm',
      stakeUnits: 0.5,
      publicationValidation: {
        totalOdds: 2.08
      },
      legs: [{
        id: 'leg-1',
        label: 'Under 2.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'totals',
          outcomeName: 'Under',
          description: '',
          point: 2.5
        }
      }, {
        id: 'leg-2',
        label: 'Arsenal And Draw Double Chance',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'double_chance',
          outcomeName: 'Arsenal And Draw',
          description: '',
          point: null
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'soccer_uefa_champs_league',
      label: 'Soccer / UCL',
      provider: 'espn',
      path: 'soccer/uefa.champions'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-ucl-double-chance-1': new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-ucl-double-chance-1': {
          postedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-ucl-double-chance-1',
    sport: 'soccer_uefa_champs_league',
    sportLabel: 'Soccer / UCL',
    event: 'Paris St-G vs Arsenal',
    startTime,
    summary: 'Under 2.5 + Arsenal And Draw Double Chance',
    stakeUnits: 0.5,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.08
    }
  }], new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString());

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-ucl-1',
        name: 'Arsenal at Paris Saint-Germain',
        homeTeam: 'Paris Saint-Germain',
        awayTeam: 'Arsenal',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 0,
        awayScore: 1
      }]
    })
  });

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.ok(state.posts.results['pick-auto-ucl-double-chance-1']);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-ucl-double-chance-1');

  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.legs[0].status, 'win');
  assert.equal(settledPick.legs[1].status, 'win');
  assert.equal(state.tracking.picks['pick-auto-ucl-double-chance-1']?.settlementPendingReason ?? null, null);
  assert.match(String(settledPick.resultNotes || ''), /Auto-settled from ESPN scoreboard final score/);
});

test('runResultsJob auto-settles a posted Tennis ATP single from the generic ESPN team-market path', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-tennis-atp-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-tennis-atp-1',
      status: 'pending',
      sport: 'tennis_atp',
      sportLabel: 'Tennis / ATP',
      league: 'ATP',
      event: 'Jannik Sinner vs Carlos Alcaraz',
      homeTeam: 'Carlos Alcaraz',
      awayTeam: 'Jannik Sinner',
      summary: 'Carlos Alcaraz Head to Head',
      betType: 'single',
      stakeUnits: 0.5,
      publicationValidation: {
        totalOdds: 2.0
      },
      legs: [{
        id: 'leg-1',
        label: 'Carlos Alcaraz Head to Head',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Carlos Alcaraz',
          description: '',
          point: null
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'tennis_atp',
      label: 'Tennis / ATP',
      provider: 'espn',
      path: 'tennis/atp'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-tennis-atp-1': postedAt
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-tennis-atp-1': {
          postedAt,
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-tennis-atp-1',
    sport: 'tennis_atp',
    sportLabel: 'Tennis / ATP',
    event: 'Jannik Sinner vs Carlos Alcaraz',
    startTime,
    summary: 'Carlos Alcaraz Head to Head',
    stakeUnits: 0.5,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.0
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-tennis-atp-1',
        name: 'Jannik Sinner at Carlos Alcaraz',
        homeTeam: 'Carlos Alcaraz',
        awayTeam: 'Jannik Sinner',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 2,
        awayScore: 1
      }]
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-tennis-atp-1');

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.ok(state.posts.results['pick-auto-tennis-atp-1']);
  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 1);
  assert.equal(settledPick.netUnits, 0.5);
  assert.equal(settledPick.legs[0].status, 'win');
  assert.match(String(settledPick.resultNotes || ''), /Auto-settled from ESPN scoreboard final score/);
});

test('runResultsJob auto-settles a posted NHL same-game slip from the generic ESPN team-market path', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-nhl-team-markets-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-nhl-team-markets-1',
      status: 'pending',
      sport: 'nhl',
      sportLabel: 'NHL',
      league: 'NHL',
      event: 'Toronto Maple Leafs vs New York Rangers',
      homeTeam: 'New York Rangers',
      awayTeam: 'Toronto Maple Leafs',
      summary: 'New York Rangers Head to Head + Over 5.5',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 2.7
      },
      legs: [{
        id: 'leg-1',
        label: 'New York Rangers Head to Head',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'New York Rangers',
          description: '',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Over 5.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'totals',
          outcomeName: 'Over',
          description: '',
          point: 5.5
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nhl',
      label: 'NHL',
      provider: 'espn',
      path: 'hockey/nhl'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-nhl-team-markets-1': postedAt
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-nhl-team-markets-1': {
          postedAt,
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-nhl-team-markets-1',
    sport: 'nhl',
    sportLabel: 'NHL',
    event: 'Toronto Maple Leafs vs New York Rangers',
    startTime,
    summary: 'New York Rangers Head to Head + Over 5.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.7
    }
  }], postedAt);

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-nhl-1',
        name: 'Toronto Maple Leafs at New York Rangers',
        homeTeam: 'New York Rangers',
        awayTeam: 'Toronto Maple Leafs',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 4,
        awayScore: 2
      }]
    })
  });

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-nhl-team-markets-1');

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.ok(state.posts.results['pick-auto-nhl-team-markets-1']);
  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 2.7);
  assert.equal(settledPick.netUnits, 1.7);
  assert.equal(settledPick.legs[0].status, 'win');
  assert.equal(settledPick.legs[1].status, 'win');
  assert.match(String(settledPick.resultNotes || ''), /Auto-settled from ESPN scoreboard final score/);
});

test('runResultsJob auto-settles a posted MLB same-game slip with supported batter and pitcher props from the ESPN summary boxscore', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-mlb-props-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-mlb-prop-1',
      status: 'pending',
      sport: 'mlb',
      sportLabel: 'MLB',
      league: 'MLB',
      event: 'Cleveland Guardians vs Minnesota Twins',
      homeTeam: 'Minnesota Twins',
      awayTeam: 'Cleveland Guardians',
      summary: 'Steven Kwan Over 1.5 Hits + Bailey Ober Over 5.5 Strikeouts',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 2.8
      },
      legs: [{
        id: 'leg-1',
        label: 'Steven Kwan Over 1.5 Hits',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'batter_hits',
          outcomeName: 'Over',
          description: 'Steven Kwan',
          point: 1.5
        }
      }, {
        id: 'leg-2',
        label: 'Bailey Ober Over 5.5 Strikeouts',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'pitcher_strikeouts',
          outcomeName: 'Over',
          description: 'Bailey Ober',
          point: 5.5
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'mlb',
      label: 'MLB',
      provider: 'espn',
      path: 'baseball/mlb'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-mlb-prop-1': new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-mlb-prop-1': {
          postedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-mlb-prop-1',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Cleveland Guardians vs Minnesota Twins',
    startTime,
    summary: 'Steven Kwan Over 1.5 Hits + Bailey Ober Over 5.5 Strikeouts',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.8
    }
  }], new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  let result;

  try {
    result = await runResultsJob({ config, state, dryRun: true }, {
      fetchEspnSlate: async () => ({
        events: [{
          id: 'event-mlb-1',
          name: 'Cleveland Guardians vs Minnesota Twins',
          homeTeam: 'Minnesota Twins',
          awayTeam: 'Cleveland Guardians',
          startTime,
          state: 'post',
          shortStatus: 'Final',
          homeScore: 5,
          awayScore: 3
        }]
      }),
      fetchEspnSummary: async () => ({
        sourceUrl: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=event-mlb-1',
        playerStats: [{
          playerName: 'Steven Kwan',
          teamName: 'Cleveland Guardians',
          statValues: {
            hits: 2
          }
        }, {
          playerName: 'Bailey Ober',
          teamName: 'Minnesota Twins',
          statValues: {
            strikeouts: 7
          }
        }]
      })
    });
  } finally {
    // no-op
  }

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-mlb-prop-1');

  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 2.8);
  assert.equal(settledPick.netUnits, 1.8);
  assert.equal(settledPick.legs[0].status, 'win');
  assert.equal(settledPick.legs[1].status, 'win');
});

test('runResultsJob auto-settles a posted NFL same-game slip with supported passing and rushing props from the ESPN summary boxscore', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-auto-settle-nfl-props-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  const startTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-auto-nfl-prop-1',
      status: 'pending',
      sport: 'nfl',
      sportLabel: 'NFL',
      league: 'NFL',
      event: 'Washington Commanders vs Philadelphia Eagles',
      homeTeam: 'Philadelphia Eagles',
      awayTeam: 'Washington Commanders',
      summary: 'Jayden Daniels Over 220.5 Passing Yards + Saquon Barkley Over 80.5 Rushing Yards',
      betType: 'sgm',
      stakeUnits: 1,
      publicationValidation: {
        totalOdds: 2.6
      },
      legs: [{
        id: 'leg-1',
        label: 'Jayden Daniels Over 220.5 Passing Yards',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_pass_yds',
          outcomeName: 'Over',
          description: 'Jayden Daniels',
          point: 220.5
        }
      }, {
        id: 'leg-2',
        label: 'Saquon Barkley Over 80.5 Rushing Yards',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_rush_yds',
          outcomeName: 'Over',
          description: 'Saquon Barkley',
          point: 80.5
        }
      }],
      startTime
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    sports: [{
      key: 'nfl',
      label: 'NFL',
      provider: 'espn',
      path: 'football/nfl'
    }],
    jobs: {
      results: {
        enabled: true,
        intervalMinutes: 15,
        settlementSweepHours: 3
      }
    },
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-auto-nfl-prop-1': new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-auto-nfl-prop-1': {
          postedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  await appendPostedTrackerEntries(config, [{
    id: 'pick-auto-nfl-prop-1',
    sport: 'nfl',
    sportLabel: 'NFL',
    event: 'Washington Commanders vs Philadelphia Eagles',
    startTime,
    summary: 'Jayden Daniels Over 220.5 Passing Yards + Saquon Barkley Over 80.5 Rushing Yards',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.6
    }
  }], new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-nfl-1',
        name: 'Washington Commanders vs Philadelphia Eagles',
        homeTeam: 'Philadelphia Eagles',
        awayTeam: 'Washington Commanders',
        startTime,
        state: 'post',
        shortStatus: 'Final',
        homeScore: 28,
        awayScore: 24
      }]
    }),
    fetchEspnSummary: async () => ({
      sourceUrl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=event-nfl-1',
      playerStats: [{
        playerName: 'Jayden Daniels',
        teamName: 'Washington Commanders',
        statValues: {
          passingYards: 255
        }
      }, {
        playerName: 'Saquon Barkley',
        teamName: 'Philadelphia Eagles',
        statValues: {
          rushingYards: 118
        }
      }]
    })
  });

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-auto-nfl-prop-1');

  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 2.6);
  assert.equal(settledPick.netUnits, 1.6);
  assert.equal(settledPick.legs[0].status, 'win');
  assert.equal(settledPick.legs[1].status, 'win');
});

test('runResultsJob backfills missing tracker posts before auto-settling a posted pick', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-results-backfill-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');

  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(losingLegsReportFile, '# Bot Losing Legs Report\n');
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'pick-unplaced',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'Oklahoma City Thunder vs San Antonio Spurs',
      homeTeam: 'San Antonio Spurs',
      awayTeam: 'Oklahoma City Thunder',
      summary: 'Ajay Mitchell 4+ Rebounds + Cason Wallace 2+ Assists',
      betType: 'sgm',
      stakeUnits: 2,
      publicationValidation: {
        totalOdds: 2.4
      },
      legs: [{
        id: 'leg-1',
        label: 'Ajay Mitchell 4+ Rebounds',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_rebounds',
          outcomeName: '4+ Rebounds',
          description: 'Ajay Mitchell',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Cason Wallace 2+ Assists',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_assists',
          outcomeName: '2+ Assists',
          description: 'Cason Wallace',
          point: null
        }
      }],
      startTime: '2026-05-21T09:30:00.000Z'
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    jobs: {
      results: {
        settlementSweepHours: 3
      }
    },
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba',
      marketKey: 'nba'
    }],
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      startingBankrollUnits: 10,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryTime: '07:45',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
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
    __paths: {
      workspaceRoot,
      picksFeedFile,
      profitTrackerFile: trackerFile,
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: {
      slates: {},
      picks: {
        'pick-unplaced': '2026-05-21T07:00:00.000Z'
      },
      results: {}
    },
    tracking: {
      picks: {
        'pick-unplaced': {
          postedAt: '2026-05-21T07:00:00.000Z',
          status: 'pregame_recheck_passed'
        }
      }
    }
  };

  const result = await runResultsJob({ config, state, dryRun: true }, {
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-nba-1',
        name: 'Oklahoma City Thunder vs San Antonio Spurs',
        homeTeam: 'San Antonio Spurs',
        awayTeam: 'Oklahoma City Thunder',
        startTime: '2026-05-21T09:30:00.000Z',
        state: 'post',
        shortStatus: 'Final',
        homeScore: 101,
        awayScore: 110
      }]
    }),
    fetchEspnSummary: async () => ({
      event: {
        id: 'event-nba-1',
        name: 'Oklahoma City Thunder vs San Antonio Spurs',
        homeTeam: 'San Antonio Spurs',
        awayTeam: 'Oklahoma City Thunder',
        startTime: '2026-05-21T09:30:00.000Z',
        state: 'post',
        shortStatus: 'Final',
        homeScore: 101,
        awayScore: 110
      },
      playerStats: [{
        playerName: 'Ajay Mitchell',
        teamName: 'Oklahoma City Thunder',
        statValues: {
          rebounds: 5
        }
      }, {
        playerName: 'Cason Wallace',
        teamName: 'Oklahoma City Thunder',
        statValues: {
          assists: 3
        }
      }]
    })
  });
  const bankrollTrackerRaw = await fs.readFile(bankrollTrackerFile, 'utf8');

  assert.equal(result.autoSettled, 1);
  assert.equal(result.posted, 1);
  assert.doesNotMatch(bankrollTrackerRaw, /post:pick-unplaced/);

  const updatedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  const settledPick = updatedFeed.picks.find((pick) => pick.id === 'pick-unplaced');

  assert.equal(settledPick.status, 'win');
  assert.equal(settledPick.returnUnits, 4.8);
  assert.equal(settledPick.netUnits, 2.8);
});

test('runResultsJob routes MLB settlements to the isolated MLB ledger and never the main bankroll', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-mlb-ledger-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const mainCsv = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const mlbCsv = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker-mlb.csv');
  const trackerFile = path.join(workspaceRoot, '30-day-profit-tracker.md');
  const start = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  const lossLogFile = path.join(workspaceRoot, 'loss-tracking', 'rolling-loss-log.md');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.mkdir(path.dirname(lossLogFile), { recursive: true });
  await fs.writeFile(trackerFile, PROFIT_TRACKER_TEMPLATE);
  await fs.writeFile(lossLogFile, LOSS_LOG_TEMPLATE);
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [
      { id: 'pick-mlb', status: 'win', sport: 'mlb', sportLabel: 'MLB', league: 'MLB', event: 'MLB Game', summary: 'MLB Game Run Line', betType: 'single', stakeUnits: 1, returnUnits: 2, netUnits: 1, priceDecimal: 2.0, legs: [{ id: 'leg-mlb', label: 'MLB Game Run Line', status: 'win' }], startTime: start, settledAt: start },
      { id: 'pick-nba', status: 'loss', sport: 'nba', sportLabel: 'NBA', league: 'NBA', event: 'NBA Game', summary: 'NBA Game H2H', betType: 'single', stakeUnits: 1, returnUnits: 0, netUnits: -1, legs: [{ id: 'leg-nba', label: 'NBA Game H2H', status: 'loss' }], startTime: start, settledAt: start }
    ]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    jobs: { results: { settlementSweepHours: 3 } },
    sports: [{ key: 'mlb', label: 'MLB' }, { key: 'nba', label: 'NBA' }],
    bankrollTracker: {
      enabled: true,
      csvFile: mainCsv,
      startingBankrollUnits: 100,
      unitSizeAud: 10,
      settlementWebhook: 'unitTracking',
      summaryWebhook: 'unitReport',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      mlb: { csvFile: mlbCsv, startingBankrollUnits: 10, unitSizeAud: 10, settlementWebhook: 'mlbTracking', summaryWebhook: 'mlbReport' }
    },
    discord: { username: 'SportsTips', avatarUrl: '', webhooks: { unitTracking: '', mlbTracking: '', results: '' }, roleMentions: { enabled: false, channels: [] } },
    __paths: { workspaceRoot, picksFeedFile, profitTrackerFile: trackerFile, bankrollTrackerFile: mainCsv }
  };

  const state = {
    jobs: {},
    posts: { slates: {}, picks: { 'pick-mlb': start, 'pick-nba': start }, referrals: {}, results: {} },
    tracking: { picks: { 'pick-mlb': { postedAt: start, status: 'pregame_recheck_passed' }, 'pick-nba': { postedAt: start, status: 'pregame_recheck_passed' } } }
  };

  // Seed open positions on the correct ledgers: MLB on the MLB CSV, NBA on the main CSV.
  await appendPostedTrackerEntries(buildMlbLedgerConfig(config), [{ id: 'pick-mlb', sport: 'mlb', sportLabel: 'MLB', event: 'MLB Game', startTime: start, summary: 'MLB Game Run Line', stakeUnits: 1, source: 'auto-generator', publicationValidation: { totalOdds: 2.0 } }], start);
  await appendPostedTrackerEntries(config, [{ id: 'pick-nba', sport: 'nba', sportLabel: 'NBA', event: 'NBA Game', startTime: start, summary: 'NBA Game H2H', stakeUnits: 1, source: 'auto-generator', publicationValidation: { totalOdds: 1.9 } }], start);

  const result = await runResultsJob({ config, state, dryRun: true });
  assert.equal(result.posted, 2);

  const mainCsvText = await fs.readFile(mainCsv, 'utf8');
  const mlbCsvText = await fs.readFile(mlbCsv, 'utf8');

  // MLB settles on the MLB ledger only — the main bankroll never sees an MLB row.
  assert.ok(mlbCsvText.includes('settle:pick-mlb'));
  assert.equal(mainCsvText.includes('pick-mlb'), false);
  // NBA settles on the main ledger only.
  assert.ok(mainCsvText.includes('settle:pick-nba'));
  assert.equal(mlbCsvText.includes('pick-nba'), false);
});