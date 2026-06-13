import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendPostedTrackerEntries } from '../src/bot-tracker.mjs';
import { __testables as picksTestables, runPicksJob } from '../src/jobs/picks.mjs';
import { runSlatesJob } from '../src/jobs/slates.mjs';
import { __testables as sportsGameOddsTestables } from '../src/providers/sports-game-odds.mjs';

const { buildFreshSnapshotReplacementOptions } = picksTestables;

function getDateKeyForZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function getNextLocalDateIso(timeZone) {
  const now = new Date();
  const currentDateKey = getDateKeyForZone(now, timeZone);
  let candidate = new Date(now.getTime() + 60 * 60 * 1000);

  for (let attempt = 0; attempt < 48; attempt += 1) {
    const candidateDateKey = getDateKeyForZone(candidate, timeZone);

    if (candidateDateKey !== currentDateKey) {
      return {
        iso: candidate.toISOString(),
        dateKey: candidateDateKey
      };
    }

    candidate = new Date(candidate.getTime() + 60 * 60 * 1000);
  }

  return {
    iso: candidate.toISOString(),
    dateKey: getDateKeyForZone(candidate, timeZone)
  };
}

function buildBaseConfig(workspaceRoot) {
  return {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      username: 'SportsTips',
      avatarUrl: '',
      webhooks: {
        slates: '',
        picks: '',
        picksNba: '',
        picksMlb: '',
        picksAfl: '',
        picksNrl: '',
        picksNfl: '',
        picksEpl: '',
        picksOther: '',
        results: '',
        unitTracking: '',
        unitReport: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    benchmarkFilters: {
      requireSupportData: false,
      significantSupportScore: 5,
      strongSupportScore: 8,
      minBooksAtOrAbove: 2
    },
    jobs: {
      picks: {
        enabled: true,
        time: '00:00',
        intervalMinutes: 15,
        shortlistHours: 24,
        postWindowHours: 12,
        pregameRecheckHours: [3, 1],
        pregameRecheckMinutes: 60,
        preWindowCheckMinutes: 60,
        inWindowCheckMinutes: 15,
        holdIfSupportRulesFail: true,
        replacementCutoffMinutes: 15
      },
      slates: {
        enabled: true,
        time: '00:00'
      }
    },
    marketScrape: {
      enabled: true,
      maxSnapshotAgeMinutes: 180
    },
    sportsGameOdds: {
      enabled: true,
      apiKey: 'test-key',
      reserveObjects: 100,
      usageTtlMinutes: 720,
      cacheTtlMinutes: 360,
      eventCacheTtlMinutes: 180,
      bookmakers: [],
      useForPicksWhenSnapshotMissing: true,
      useForSlatesWhenScrapeMissing: true
    },
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'snapshot',
      path: 'basketball_nba',
      marketKey: 'nba',
      enabled: true,
      sportsGameOddsLeagueId: 'NBA'
    }],
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
    __paths: {
      picksFeedFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json'),
      stateFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'state.json'),
      bankrollTrackerFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv'),
      losingLegsReportFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md')
    }
  };
}

function buildBaseState() {
  return {
    jobs: {},
    posts: {
      slates: {},
      picks: {},
      results: {}
    },
    cache: {
      oddsValidation: {}
    },
    providers: {
      marketScrape: {},
      sportsGameOdds: {}
    },
    tracking: {
      picks: {}
    }
  };
}

function slugifyTestKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildAflResearchOverrides(teamPlayersByName) {
  const clubSiteToTeamName = new Map();
  const playerIdToTeamName = new Map();

  return {
    fetchAflOfficialTeams: async () => Object.keys(teamPlayersByName).map((teamName) => {
      const clubSiteUrl = `https://example.test/${slugifyTestKey(teamName)}`;
      clubSiteToTeamName.set(clubSiteUrl, teamName);

      return {
        id: slugifyTestKey(teamName),
        name: teamName,
        teamType: 'men',
        metadata: {
          clubSiteUrl
        }
      };
    }),
    fetchAflClubTeamRoster: async (clubSiteUrl) => {
      const teamName = clubSiteToTeamName.get(clubSiteUrl) || '';
      const players = Array.isArray(teamPlayersByName[teamName]) ? teamPlayersByName[teamName] : [];

      for (const player of players) {
        if (player?.playerId) {
          playerIdToTeamName.set(player.playerId, teamName);
        }
      }

      return {
        status: 'ok',
        players
      };
    },
    fetchAflOfficialPlayer: async (playerId) => ({
      player: {
        providerId: playerId
      }
    }),
    fetchAflStatsProPlayerProfile: async (providerId) => ({
      team: {
        teamName: playerIdToTeamName.get(providerId) || ''
      }
    })
  };
}

async function readTrackerCsvOrEmpty(config) {
  try {
    return await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }

    throw error;
  }
}

test('runPicksJob holds a generated pick when final price validation is temporarily unavailable', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-fallback-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:test-event',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'rules-generator',
      analysisChecklist: {
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
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          booksChecked: 1,
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }]
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({ status: 'snapshot_stale' })
  });

  assert.equal(result.posted, 0);
  assert.equal(result.watched, 1);
  assert.equal(state.tracking.picks['auto-generator:nba:test-event']?.status, 'waiting_for_support');
});

test('runPicksJob drops started pending picks instead of keeping them watched forever', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-started-pending-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:started-pending',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      analysisChecklist: {
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
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          booksChecked: 1,
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }]
    }]
  }, null, 2));

  state.tracking.picks['auto-generator:nba:started-pending'] = {
    shortlistedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    status: 'waiting_for_window',
    nextCheckAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
  };

  const result = await runPicksJob({ config, state, dryRun: true }, {
    forcePostNow: true,
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.9,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 0);
  assert.equal(result.watched, 0);
  assert.equal(state.tracking.picks['auto-generator:nba:started-pending'], undefined);
  assert.equal(state.posts.picks['auto-generator:nba:started-pending'], undefined);
});

test('runPicksJob includes total validated odds in the dry-run pick embed', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-price-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'manual:nba:priced-event',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5 + Jalen Williams Over 19.5',
      betType: 'sgm',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
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
        label: 'Jalen Williams Over 19.5',
        status: 'active',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Jalen Williams',
          point: 19.5
        }
      }]
    }]
  }, null, 2));

  const originalConsoleLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    const result = await runPicksJob({ config, state, dryRun: true }, {
      resolveOddsValidation: async (_context, oddsCheck) => ({
        status: 'ok',
        bestOdds: oddsCheck.description === 'Shai Gilgeous-Alexander' ? 1.5 : 2,
        bestBookmaker: 'Sportsbet'
      })
    });

    assert.equal(result.posted, 1);
    assert.match(logs.join('\n'), /Price: x3\.00/);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('runPicksJob can force post a future pick outside the normal posting window', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-force-window-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 13 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'manual:nba:force-window',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'manual placement',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const baselineState = buildBaseState();
  const baseline = await runPicksJob({ config, state: baselineState, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.9,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(baseline.posted, 0);
  assert.equal(baseline.watched, 1);
  assert.equal(baselineState.tracking.picks['manual:nba:force-window']?.status, 'waiting_for_window');

  const result = await runPicksJob({ config, state, dryRun: true }, {
    forcePostNow: true,
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.9,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].event, 'San Antonio Spurs vs Oklahoma City Thunder');
  assert.equal(result.postedDetails[0].legCount, 1);
  assert.equal(state.posts.picks['manual:nba:force-window'], undefined);
});

test('runPicksJob posts a generated future pick once it enters the 12-hour window', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-immediate-generated-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 11 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:immediate-window',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.9,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.watched, 0);
  assert.equal(state.posts.picks['auto-generator:nba:immediate-window'], undefined);
  const trackerCsv = await readTrackerCsvOrEmpty(config);
  assert.doesNotMatch(trackerCsv, /post:auto-generator:nba:immediate-window/);
});

test('runPicksJob records a posted generated pick as an open tracker position when not in dry-run mode', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-posted-tracker-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.dryRun = false;
  config.discord.webhooks.picks = 'https://discord.com/api/webhooks/shared/test';
  config.discord.webhooks.picksNba = 'https://discord.com/api/webhooks/nba/test';
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:posted-tracker',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.63,
      supportScore: 6.8,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'rules-generator',
      publicationValidation: {
        totalOdds: 1.9
      },
      analysisChecklist: {
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
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }]
    }]
  }, null, 2));

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 204,
    text: async () => ''
  });

  let result;

  try {
    result = await runPicksJob({ config, state, dryRun: false }, {
      resolveOddsValidation: async () => ({
        status: 'ok',
        bestOdds: 1.9,
        bestBookmaker: 'Sportsbet'
      })
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(result.posted, 1);
  assert.ok(state.posts.picks['auto-generator:nba:posted-tracker']);
  assert.equal(state.tracking.picks['auto-generator:nba:posted-tracker']?.postedWebhookChannel, 'picksNba');

  const trackerCsv = await readTrackerCsvOrEmpty(config);
  assert.match(trackerCsv, /post:auto-generator:nba:posted-tracker/);
  assert.match(trackerCsv, /Shai Gilgeous-Alexander Over 29\.5/);
});

test('runPicksJob deletes the old Discord message before posting a replacement slip in non-dry-run mode', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-replacement-delete-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.dryRun = false;
  config.discord.webhooks.picks = 'https://discord.com/api/webhooks/shared/test';
  config.discord.webhooks.picksNba = 'https://discord.com/api/webhooks/nba/test';
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:nba:replacement-delete'] = postedAt;
  state.tracking.picks['auto-generator:nba:replacement-delete'] = {
    postedAt,
    postedMessageId: 'old-message-1',
    postedWebhookChannel: 'picksNba',
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nba:replacement-delete',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], postedAt);

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:replacement-delete',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      replacementOptions: [{
        id: 'backup-delete-1',
        summary: 'Jalen Williams Over 19.5',
        event: 'San Antonio Spurs vs Oklahoma City Thunder',
        betType: 'single',
        stakeUnits: 1,
        rationale: 'Fallback leg stays live.',
        replacementReason: 'Original player was ruled out during the late recheck.',
        legs: [{
          id: 'leg-2',
          label: 'Jalen Williams Over 19.5',
          status: 'active',
          rationale: 'Fallback leg.',
          source: {
            type: 'web-scrape',
            market: 'player_points',
            outcomeName: 'Over',
            description: 'Jalen Williams',
            point: 19.5
          }
        }],
        analysisChecklist: {
          actionableSlate: 'pass',
          marketDepth: 'pass',
          selectionSupport: 'pass',
          playerAvailability: 'pass',
          roleStability: 'pass',
          externalConditions: 'pass',
          researchConfidence: 'pass',
          correlation: 'pass',
          ticketIntegrity: 'pass',
          bankrollFit: 'pass'
        }
      }],
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'fail',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const fetchCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), method: options.method || 'GET' });

    if ((options.method || 'GET') === 'DELETE') {
      return {
        ok: true,
        status: 204,
        text: async () => ''
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'new-message-1' }),
      text: async () => ''
    };
  };

  let result;

  try {
    result = await runPicksJob({ config, state, dryRun: false }, {
      resolveOddsValidation: async () => ({
        status: 'ok',
        bestOdds: 1.9,
        bestBookmaker: 'Sportsbet'
      })
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'replacement');
  assert.equal(fetchCalls[0]?.method, 'DELETE');
  assert.equal(fetchCalls[0]?.url, 'https://discord.com/api/webhooks/nba/test/messages/old-message-1');
  assert.equal(fetchCalls[1]?.method, 'POST');
  assert.equal(fetchCalls[1]?.url, 'https://discord.com/api/webhooks/nba/test?wait=true');
  assert.equal(state.tracking.picks['auto-generator:nba:replacement-delete']?.postedMessageId, 'new-message-1');
  assert.equal(state.tracking.picks['auto-generator:nba:replacement-delete']?.postedWebhookChannel, 'picksNba');

  const trackerCsv = await readTrackerCsvOrEmpty(config);
  assert.match(trackerCsv, /replacement:auto-generator:nba:replacement-delete:backup-delete-1/);
});

test('runPicksJob deletes legacy shared-channel messages but reposts replacements to the sport webhook', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-replacement-legacy-channel-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.dryRun = false;
  config.discord.webhooks.picks = 'https://discord.com/api/webhooks/shared/test';
  config.discord.webhooks.picksNba = 'https://discord.com/api/webhooks/nba/test';
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:nba:replacement-legacy-channel'] = postedAt;
  state.tracking.picks['auto-generator:nba:replacement-legacy-channel'] = {
    postedAt,
    postedMessageId: 'old-message-legacy',
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nba:replacement-legacy-channel',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], postedAt);

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:replacement-legacy-channel',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      replacementOptions: [{
        id: 'backup-legacy-1',
        summary: 'Jalen Williams Over 19.5',
        event: 'San Antonio Spurs vs Oklahoma City Thunder',
        betType: 'single',
        stakeUnits: 1,
        rationale: 'Fallback leg stays live.',
        replacementReason: 'Original player was ruled out during the late recheck.',
        legs: [{
          id: 'leg-2',
          label: 'Jalen Williams Over 19.5',
          status: 'active',
          rationale: 'Fallback leg.',
          source: {
            type: 'web-scrape',
            market: 'player_points',
            outcomeName: 'Over',
            description: 'Jalen Williams',
            point: 19.5
          }
        }],
        analysisChecklist: {
          actionableSlate: 'pass',
          marketDepth: 'pass',
          selectionSupport: 'pass',
          playerAvailability: 'pass',
          roleStability: 'pass',
          externalConditions: 'pass',
          researchConfidence: 'pass',
          correlation: 'pass',
          ticketIntegrity: 'pass',
          bankrollFit: 'pass'
        }
      }],
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'fail',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const fetchCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), method: options.method || 'GET' });

    if ((options.method || 'GET') === 'DELETE') {
      return {
        ok: true,
        status: 204,
        text: async () => ''
      };
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'new-message-legacy' }),
      text: async () => ''
    };
  };

  let result;

  try {
    result = await runPicksJob({ config, state, dryRun: false }, {
      resolveOddsValidation: async () => ({
        status: 'ok',
        bestOdds: 1.9,
        bestBookmaker: 'Sportsbet'
      })
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'replacement');
  assert.equal(fetchCalls[0]?.method, 'DELETE');
  assert.equal(fetchCalls[0]?.url, 'https://discord.com/api/webhooks/shared/test/messages/old-message-legacy');
  assert.equal(fetchCalls[1]?.method, 'POST');
  assert.equal(fetchCalls[1]?.url, 'https://discord.com/api/webhooks/nba/test?wait=true');
  assert.equal(state.tracking.picks['auto-generator:nba:replacement-legacy-channel']?.postedMessageId, 'new-message-legacy');
  assert.equal(state.tracking.picks['auto-generator:nba:replacement-legacy-channel']?.postedWebhookChannel, 'picksNba');
});

test('runPicksJob rebuilds posted state from the tracker after restart and does not repost the same slip', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-restart-recovery-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 11 * 60 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nba:restart-recovery',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], postedAt);

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:restart-recovery',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.9,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 0);
  assert.equal(state.posts.picks['auto-generator:nba:restart-recovery'], postedAt);
  assert.equal(state.tracking.picks['auto-generator:nba:restart-recovery']?.status, 'posted_waiting_for_pregame_recheck');

  const trackerCsv = await readTrackerCsvOrEmpty(config);
  const postMatches = trackerCsv.match(/post:auto-generator:nba:restart-recovery/g) || [];
  assert.equal(postMatches.length, 1);
});

test('runPicksJob blocks an initial AFL generated pick when the player is still listed on the ESPN injuries page', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-afl-injury-block-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'afl',
    label: 'AFL',
    provider: 'espn',
    path: 'australian-football/afl',
    marketKey: 'afl',
    enabled: true,
    sportsGameOddsLeagueId: 'AFL'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:afl:test-injury-block',
      status: 'pending',
      sport: 'afl',
      sportLabel: 'AFL',
      event: 'Richmond vs Essendon',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      startTime,
      summary: 'Archer May 10+ Disposals + Over 168.5',
      rationale: 'Structured test pick.',
      betType: 'sgm',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Archer May 10+ Disposals',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '10+ Disposals',
          description: 'Archer May',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Over 168.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'totals',
          outcomeName: 'Over',
          description: '',
          point: 168.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async (_context, oddsCheck) => ({
      status: 'ok',
      bestOdds: oddsCheck.market === 'player_disposals' ? 1.65 : 1.9,
      bestBookmaker: 'Sportsbet'
    }),
    fetchEspnSlate: async () => ({
      events: [{
        id: '401999001',
        startTime,
        homeTeam: 'Richmond',
        awayTeam: 'Essendon',
        homeTeamId: '1',
        awayTeamId: '2',
        venue: {}
      }]
    }),
    fetchEspnTeamInjuries: async (_sport, teamId) => ({
      teamId,
      injuries: teamId === '1'
        ? [{
          playerName: 'Archer May',
          status: 'Active',
          note: 'Expected to return tomorrow from injury.'
        }]
        : []
    })
  });

  assert.equal(result.posted, 0);
  assert.equal(result.watched, 0);
  assert.equal(state.posts.picks['auto-generator:afl:test-injury-block'], undefined);
});

test('runPicksJob holds a generated future pick until the 12-hour posting window opens', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-generated-window-hold-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 13 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:wait-for-12h-window',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.9,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 0);
  assert.equal(result.watched, 1);
  assert.equal(state.tracking.picks['auto-generator:nba:wait-for-12h-window']?.status, 'waiting_for_window');
});

test('runPicksJob rejects a generated pick when validated total odds are too aggressive for its support tier', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-odds-profile-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:odds-profile',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5 + Jalen Williams Over 19.5',
      rationale: 'Structured test pick.',
      betType: 'sgm',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }, {
        id: 'leg-2',
        label: 'Jalen Williams Over 19.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Jalen Williams',
          point: 19.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async (_context, oddsCheck) => ({
      status: 'ok',
      bestOdds: oddsCheck.description === 'Shai Gilgeous-Alexander' ? 2.2 : 2.1,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 0);
  assert.equal(result.watched, 0);
  assert.equal(state.posts.picks['auto-generator:nba:odds-profile'], undefined);
});

test('runPicksJob cancels a posted generated pick when the 1-hour recheck fails with no valid replacement', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-cancel-recheck-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:nba:cancel-recheck'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nba:cancel-recheck'] = {
    postedAt: state.posts.picks['auto-generator:nba:cancel-recheck'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nba:cancel-recheck',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:cancel-recheck',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({ status: 'snapshot_stale' })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'cancellation');
  assert.equal(state.tracking.picks['auto-generator:nba:cancel-recheck']?.status, 'posted_waiting_for_pregame_recheck');

  const trackerCsv = await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
  assert.doesNotMatch(trackerCsv, /cancel:auto-generator:nba:cancel-recheck/);
});

test('runPicksJob cancels a posted generated MLB side-plus-total slip when it fails the MLB structure guard', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-mlb-hit-led-guard-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'mlb',
    label: 'MLB',
    provider: 'snapshot',
    path: 'baseball_mlb',
    marketKey: 'mlb',
    enabled: true,
    sportsGameOddsLeagueId: 'MLB'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:mlb:bad-structure'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:mlb:bad-structure'] = {
    postedAt: state.posts.picks['auto-generator:mlb:bad-structure'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:mlb:bad-structure',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Tampa Bay Rays vs New York Yankees',
    startTime,
    summary: 'Tampa Bay Rays +1.5 + Over 7',
    stakeUnits: 0.5,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.78
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:mlb:bad-structure',
      status: 'pending',
      sport: 'mlb',
      sportLabel: 'MLB',
      event: 'Tampa Bay Rays vs New York Yankees',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      startTime,
      summary: 'Tampa Bay Rays +1.5 + Over 7',
      rationale: 'Structured test pick.',
      betType: 'sgm',
      modelProbability: 0.58,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 0.5,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Tampa Bay Rays +1.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'spreads',
          outcomeName: 'Tampa Bay Rays',
          description: '',
          point: 1.5
        }
      }, {
        id: 'leg-2',
        label: 'Over 7',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'totals',
          outcomeName: 'Over',
          description: '',
          point: 7
        }
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.4,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'cancellation');
});

test('runPicksJob keeps a posted generated MLB hit-plus-strikeout slip when it passes the new MLB structure guard', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-mlb-strikeout-total-guard-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'mlb',
    label: 'MLB',
    provider: 'snapshot',
    path: 'baseball_mlb',
    marketKey: 'mlb',
    enabled: true,
    sportsGameOddsLeagueId: 'MLB'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:mlb:allowed-structure'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:mlb:allowed-structure'] = {
    postedAt: state.posts.picks['auto-generator:mlb:allowed-structure'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:mlb:allowed-structure',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Cleveland Guardians vs Philadelphia Phillies',
    startTime,
    summary: 'Jose Ramirez 1+ Hit + Tanner Bibee 4+ Strikeouts',
    stakeUnits: 0.5,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.1
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:mlb:allowed-structure',
      status: 'pending',
      sport: 'mlb',
      sportLabel: 'MLB',
      mlbStructureProfile: 'mlb-hit-priority-v2',
      event: 'Cleveland Guardians vs Philadelphia Phillies',
      homeTeam: 'Cleveland Guardians',
      awayTeam: 'Philadelphia Phillies',
      startTime,
      summary: 'Jose Ramirez 1+ Hit + Tanner Bibee 4+ Strikeouts',
      rationale: 'Structured test pick.',
      betType: 'sgm',
      modelProbability: 0.58,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 0.5,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Jose Ramirez 1+ Hit',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'batter_hits',
          outcomeName: '1+ Hit',
          description: 'Jose Ramirez',
          point: null,
          teamSide: 'home',
          teamName: 'Cleveland Guardians'
        }
      }, {
        id: 'leg-2',
        label: 'Tanner Bibee 4+ Strikeouts',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'pitcher_strikeouts',
          outcomeName: '4+ Strikeouts',
          description: 'Tanner Bibee',
          point: null,
          teamSide: 'home',
          teamName: 'Cleveland Guardians'
        }
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.45,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 0);
  assert.equal(state.tracking.picks['auto-generator:mlb:allowed-structure']?.status, 'pregame_recheck_passed');
  assert.equal(state.tracking.picks['auto-generator:mlb:allowed-structure']?.lastDecision, 'pregame_recheck_passed');
});

test('runPicksJob keeps a posted generated MLB 2-hit slip when live recheck odds drift above the generic soft cap', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-mlb-hit-soft-cap-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'mlb',
    label: 'MLB',
    provider: 'snapshot',
    path: 'baseball_mlb',
    marketKey: 'mlb',
    enabled: true,
    sportsGameOddsLeagueId: 'MLB'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:mlb:hit-soft-cap'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:mlb:hit-soft-cap'] = {
    postedAt: state.posts.picks['auto-generator:mlb:hit-soft-cap'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:mlb:hit-soft-cap',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Tampa Bay Rays vs New York Yankees',
    startTime,
    summary: 'Carson Williams 1+ Hit + Cedric Mullins 1+ Hit',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 3.35
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:mlb:hit-soft-cap',
      status: 'pending',
      sport: 'mlb',
      sportLabel: 'MLB',
      mlbStructureProfile: 'mlb-hit-priority-v2',
      event: 'Tampa Bay Rays vs New York Yankees',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      startTime,
      summary: 'Carson Williams 1+ Hit + Cedric Mullins 1+ Hit',
      rationale: 'Structured test pick.',
      betType: 'sgm',
      modelProbability: 0.58,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Carson Williams 1+ Hit',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'batter_hits',
          outcomeName: '1+ Hit',
          description: 'Carson Williams',
          point: 0.5,
          teamName: 'Tampa Bay Rays'
        }
      }, {
        id: 'leg-2',
        label: 'Cedric Mullins 1+ Hit',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'batter_hits',
          outcomeName: '1+ Hit',
          description: 'Cedric Mullins',
          point: 0.5,
          teamName: 'New York Yankees'
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async (_context, oddsCheck) => ({
      status: 'ok',
      bestOdds: oddsCheck.description === 'Carson Williams' ? 1.83 : 1.83,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 0);
  assert.equal(state.tracking.picks['auto-generator:mlb:hit-soft-cap']?.status, 'pregame_recheck_passed');
  assert.equal(state.tracking.picks['auto-generator:mlb:hit-soft-cap']?.lastDecision, 'pregame_recheck_passed');
});

test('runPicksJob cancels an unmarked current MLB strikeout-plus-total slip under the legacy structure guard', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-mlb-legacy-strikeout-total-guard-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'mlb',
    label: 'MLB',
    provider: 'snapshot',
    path: 'baseball_mlb',
    marketKey: 'mlb',
    enabled: true,
    sportsGameOddsLeagueId: 'MLB'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:mlb:legacy-structure'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:mlb:legacy-structure'] = {
    postedAt: state.posts.picks['auto-generator:mlb:legacy-structure'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:mlb:legacy-structure',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Tampa Bay Rays vs New York Yankees',
    startTime,
    summary: 'Drew Rasmussen Over 4.5 Strikeouts + Over 7',
    stakeUnits: 0.5,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.1
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:mlb:legacy-structure',
      status: 'pending',
      sport: 'mlb',
      sportLabel: 'MLB',
      event: 'Tampa Bay Rays vs New York Yankees',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      startTime,
      summary: 'Drew Rasmussen Over 4.5 Strikeouts + Over 7',
      rationale: 'Structured test pick.',
      betType: 'sgm',
      modelProbability: 0.58,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 0.5,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Drew Rasmussen Over 4.5 Strikeouts',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'pitcher_strikeouts',
          outcomeName: 'Over',
          description: 'Drew Rasmussen',
          point: 4.5
        }
      }, {
        id: 'leg-2',
        label: 'Over 7',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'totals',
          outcomeName: 'Over',
          description: '',
          point: 7
        }
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.45,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'cancellation');
});

test('runPicksJob replaces a posted generated pick when the 1-hour recheck fails but a valid fallback remains', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-replace-recheck-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:nba:replace-recheck'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nba:replace-recheck'] = {
    postedAt: state.posts.picks['auto-generator:nba:replace-recheck'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nba:replace-recheck',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:replace-recheck',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      replacementOptions: [{
        id: 'backup-1',
        summary: 'Jalen Williams Over 19.5',
        event: 'San Antonio Spurs vs Oklahoma City Thunder',
        betType: 'single',
        stakeUnits: 1,
        rationale: 'Fallback leg stays live.',
        replacementReason: 'Original leg failed the late availability check.',
        legs: [{
          id: 'leg-2',
          label: 'Jalen Williams Over 19.5',
          status: 'active',
          rationale: 'Fallback leg.',
          source: {
            type: 'web-scrape',
            market: 'player_points',
            outcomeName: 'Over',
            description: 'Jalen Williams',
            point: 19.5
          }
        }],
        analysisChecklist: {
          actionableSlate: 'pass',
          marketDepth: 'pass',
          selectionSupport: 'pass',
          playerAvailability: 'pass',
          roleStability: 'pass',
          externalConditions: 'pass',
          researchConfidence: 'pass',
          correlation: 'pass',
          ticketIntegrity: 'pass',
          bankrollFit: 'pass'
        }
      }],
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'fail',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.9,
      bestBookmaker: 'Sportsbet'
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'replacement');
  assert.equal(state.tracking.picks['auto-generator:nba:replace-recheck']?.status, 'posted_waiting_for_pregame_recheck');

  const trackerCsv = await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
  assert.doesNotMatch(trackerCsv, /replacement:auto-generator:nba:replace-recheck:backup-1/);
});

test('runPicksJob cancels a posted generated prop pick when the late ESPN injury recheck marks the player unavailable', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-injury-cancel-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'nba',
    label: 'NBA',
    provider: 'espn',
    path: 'basketball/nba',
    marketKey: 'nba',
    enabled: true,
    sportsGameOddsLeagueId: 'NBA'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:nba:401000111'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nba:401000111'] = {
    postedAt: state.posts.picks['auto-generator:nba:401000111'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nba:401000111',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:401000111',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.35,
      bestBookmaker: 'Sportsbet'
    }),
    fetchEspnSlate: async () => ({
      events: [{
        id: '401000111',
        startTime,
        homeTeam: 'Oklahoma City Thunder',
        awayTeam: 'San Antonio Spurs',
        homeTeamId: '25',
        awayTeamId: '24',
        venue: {}
      }]
    }),
    fetchEspnTeamInjuries: async (_sport, teamId) => ({
      teamId,
      injuries: teamId === '25'
        ? [{
          playerName: 'Shai Gilgeous-Alexander',
          status: 'Out',
          note: 'Ruled out pregame.'
        }]
        : []
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'cancellation');
  assert.equal(state.tracking.picks['auto-generator:nba:401000111']?.status, 'posted_waiting_for_pregame_recheck');

  const trackerCsv = await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
  assert.doesNotMatch(trackerCsv, /cancel:auto-generator:nba:401000111/);
});

test('runPicksJob replaces a posted generated prop pick when the late ESPN injury recheck rules out the original player', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-injury-replace-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'nba',
    label: 'NBA',
    provider: 'espn',
    path: 'basketball/nba',
    marketKey: 'nba',
    enabled: true,
    sportsGameOddsLeagueId: 'NBA'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();
  state.posts.picks['auto-generator:nba:401000112'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nba:401000112'] = {
    postedAt: state.posts.picks['auto-generator:nba:401000112'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nba:401000112',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:401000112',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      replacementOptions: [{
        id: 'backup-1',
        summary: 'Jalen Williams Over 19.5',
        event: 'San Antonio Spurs vs Oklahoma City Thunder',
        betType: 'single',
        stakeUnits: 1,
        rationale: 'Fallback leg stays live.',
        replacementReason: 'Original player was ruled out during the late recheck.',
        legs: [{
          id: 'leg-2',
          label: 'Jalen Williams Over 19.5',
          status: 'active',
          rationale: 'Fallback leg.',
          source: {
            type: 'web-scrape',
            market: 'player_points',
            outcomeName: 'Over',
            description: 'Jalen Williams',
            point: 19.5
          }
        }],
        analysisChecklist: {
          actionableSlate: 'pass',
          marketDepth: 'pass',
          selectionSupport: 'pass',
          playerAvailability: 'pass',
          roleStability: 'pass',
          externalConditions: 'pass',
          researchConfidence: 'pass',
          correlation: 'pass',
          ticketIntegrity: 'pass',
          bankrollFit: 'pass'
        }
      }],
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.35,
      bestBookmaker: 'Sportsbet'
    }),
    fetchEspnSlate: async () => ({
      events: [{
        id: '401000112',
        startTime,
        homeTeam: 'Oklahoma City Thunder',
        awayTeam: 'San Antonio Spurs',
        homeTeamId: '25',
        awayTeamId: '24',
        venue: {}
      }]
    }),
    fetchEspnTeamInjuries: async (_sport, teamId) => ({
      teamId,
      injuries: teamId === '25'
        ? [{
          playerName: 'Shai Gilgeous-Alexander',
          status: 'Out',
          note: 'Ruled out pregame.'
        }]
        : []
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'replacement');
  assert.equal(state.tracking.picks['auto-generator:nba:401000112']?.status, 'posted_waiting_for_pregame_recheck');

  const trackerCsv = await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
  assert.doesNotMatch(trackerCsv, /replacement:auto-generator:nba:401000112:backup-1/);
});

test('runPicksJob cancels a posted generated pick when ESPN marks the event postponed during the late recheck', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-postponed-cancel-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'mlb',
    label: 'MLB',
    provider: 'espn',
    path: 'baseball/mlb',
    marketKey: 'mlb',
    enabled: true,
    sportsGameOddsLeagueId: 'MLB'
  }];

  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:mlb:401815462'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:mlb:401815462'] = {
    postedAt: state.posts.picks['auto-generator:mlb:401815462'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:mlb:401815462',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Tampa Bay Rays vs New York Yankees',
    startTime,
    summary: 'Tampa Bay Rays ML',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.82
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:mlb:401815462',
      status: 'pending',
      sport: 'mlb',
      sportLabel: 'MLB',
      event: 'Tampa Bay Rays vs New York Yankees',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      startTime,
      summary: 'Tampa Bay Rays ML',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Tampa Bay Rays ML',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Tampa Bay Rays'
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.82,
      bestBookmaker: 'Sportsbet'
    }),
    fetchEspnSlate: async () => ({
      events: [{
        id: '401815462',
        startTime,
        homeTeam: 'New York Yankees',
        awayTeam: 'Tampa Bay Rays',
        homeTeamId: '10',
        awayTeamId: '30',
        state: 'post',
        shortStatus: 'Postponed',
        venue: {
          name: 'Yankee Stadium',
          city: 'Bronx',
          state: 'New York',
          country: 'United States',
          indoor: false,
          roofType: 'Outdoor'
        }
      }]
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'cancellation');
  assert.equal(state.tracking.picks['auto-generator:mlb:401815462']?.status, 'posted_waiting_for_pregame_recheck');

  const trackerCsv = await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
  assert.doesNotMatch(trackerCsv, /cancel:auto-generator:mlb:401815462/);
});

test('runPicksJob posts a sport cancellation and a refund settlement message for a pregame cancellation', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-cancel-refund-webhooks-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.dryRun = false;
  config.discord.webhooks.picksMlb = 'https://discord.com/api/webhooks/mlb/test';
  config.discord.webhooks.unitTracking = 'https://discord.com/api/webhooks/unit/test';
  config.sports = [{
    key: 'mlb',
    label: 'MLB',
    provider: 'espn',
    path: 'baseball/mlb',
    marketKey: 'mlb',
    enabled: true,
    sportsGameOddsLeagueId: 'MLB'
  }];

  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:mlb:401815463'] = postedAt;
  state.tracking.picks['auto-generator:mlb:401815463'] = {
    postedAt,
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:mlb:401815463',
    sport: 'mlb',
    sportLabel: 'MLB',
    event: 'Tampa Bay Rays vs New York Yankees',
    startTime,
    summary: 'Carson Williams 1+ Hit + Cedric Mullins 1+ Hit',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.82
    }
  }], postedAt);

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:mlb:401815463',
      status: 'pending',
      sport: 'mlb',
      sportLabel: 'MLB',
      event: 'Tampa Bay Rays vs New York Yankees',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      startTime,
      summary: 'Carson Williams 1+ Hit + Cedric Mullins 1+ Hit',
      rationale: 'Structured test pick.',
      betType: 'same_game_multi',
      modelProbability: 0.67,
      supportScore: 9.1,
      confidenceTier: 'high',
      supportProjection: 'strong',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      mlbStructureProfile: 'mlb-hit-priority-v2',
      legs: [{
        id: 'leg-1',
        label: 'Carson Williams 1+ Hit',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'batter_hits',
          outcomeName: '1+ Hit',
          description: 'Carson Williams',
          point: 0.5
        }
      }, {
        id: 'leg-2',
        label: 'Cedric Mullins 1+ Hit',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'batter_hits',
          outcomeName: '1+ Hit',
          description: 'Cedric Mullins',
          point: 0.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const fetchCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), method: options.method || 'GET' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: `message-${fetchCalls.length}` }),
      text: async () => ''
    };
  };

  let result;

  try {
    result = await runPicksJob({ config, state, dryRun: false }, {
      resolveOddsValidation: async () => ({
        status: 'ok',
        bestOdds: 1.82,
        bestBookmaker: 'Sportsbet'
      }),
      fetchEspnSlate: async () => ({
        events: [{
          id: '401815463',
          startTime,
          homeTeam: 'New York Yankees',
          awayTeam: 'Tampa Bay Rays',
          homeTeamId: '10',
          awayTeamId: '30',
          state: 'post',
          shortStatus: 'Postponed',
          venue: {
            name: 'Yankee Stadium',
            city: 'Bronx',
            state: 'New York',
            country: 'United States',
            indoor: false,
            roofType: 'Outdoor'
          }
        }]
      })
    });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'cancellation');
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0]?.method, 'POST');
  assert.equal(fetchCalls[0]?.url, 'https://discord.com/api/webhooks/mlb/test?wait=true');
  assert.equal(fetchCalls[1]?.method, 'POST');
  assert.equal(fetchCalls[1]?.url, 'https://discord.com/api/webhooks/unit/test?wait=true');
  assert.equal(state.tracking.picks['auto-generator:mlb:401815463']?.status, 'cancelled');

  const trackerCsv = await readTrackerCsvOrEmpty(config);
  assert.match(trackerCsv, /cancel:auto-generator:mlb:401815463/);
});

test('runPicksJob uses persisted ESPN ids during the late recheck instead of relying on team-name matching alone', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-espn-id-recheck-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'nba',
    label: 'NBA',
    provider: 'espn',
    path: 'basketball/nba',
    marketKey: 'nba',
    enabled: true,
    sportsGameOddsLeagueId: 'NBA'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:nba:snapshot:event-1'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nba:snapshot:event-1'] = {
    postedAt: state.posts.picks['auto-generator:nba:snapshot:event-1'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nba:snapshot:event-1',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'San Antonio Spurs vs Oklahoma City Thunder',
    startTime,
    summary: 'Shai Gilgeous-Alexander Over 29.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:snapshot:event-1',
      eventId: 'snapshot:event-1',
      espnEventId: '401000113',
      homeTeamId: '25',
      awayTeamId: '24',
      venue: {
        id: '1',
        name: 'Paycom Center',
        city: 'Oklahoma City',
        state: 'OK',
        country: 'United States',
        indoor: true,
        roofType: 'Arena'
      },
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.9,
      bestBookmaker: 'Sportsbet'
    }),
    fetchEspnSlate: async () => ({
      events: [{
        id: '401000113',
        startTime,
        homeTeam: 'OKC Thunder',
        awayTeam: 'Spurs',
        homeTeamId: '25',
        awayTeamId: '24',
        venue: {}
      }]
    }),
    fetchEspnTeamInjuries: async (_sport, teamId) => ({
      teamId,
      injuries: teamId === '25'
        ? [{
          playerName: 'Shai Gilgeous-Alexander',
          status: 'Out',
          note: 'Ruled out pregame.'
        }]
        : []
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'cancellation');
  assert.equal(state.tracking.picks['auto-generator:nba:snapshot:event-1']?.status, 'posted_waiting_for_pregame_recheck');
});

test('runPicksJob rebuilds a malformed posted generated slip from the latest same-event snapshot when a clean replacement is available', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-malformed-rebuild-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:nba:malformed-rebuild'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nba:malformed-rebuild'] = {
    postedAt: state.posts.picks['auto-generator:nba:malformed-rebuild'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nba:malformed-rebuild',
    sport: 'nba',
    sportLabel: 'NBA',
    event: 'Oklahoma City Thunder vs San Antonio Spurs',
    startTime,
    summary: 'Shai Gilgeous Shai Gilgeous-Alexander Over + Victor Wembanyama Over',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 3.58
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:malformed-rebuild',
      eventId: 'snapshot:nba:oklahoma-city-thunder-vs-san-antonio-spurs',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'Oklahoma City Thunder vs San Antonio Spurs',
      homeTeam: 'San Antonio Spurs',
      awayTeam: 'Oklahoma City Thunder',
      startTime,
      summary: 'Shai Gilgeous Shai Gilgeous-Alexander Over + Victor Wembanyama Over',
      rationale: 'Malformed parser regression example.',
      betType: 'sgm',
      modelProbability: 0.54,
      supportScore: 8.7,
      confidenceTier: 'high',
      supportProjection: 'strong',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous Shai Gilgeous-Alexander Over',
        status: 'active',
        rationale: 'Bad parser output.',
        source: {
          type: 'web-scrape',
          market: 'player_assists',
          outcomeName: 'Shai Gilgeous-Alexander Over',
          description: 'Shai Gilgeous',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Victor Wembanyama Over',
        status: 'active',
        rationale: 'Bad parser output.',
        source: {
          type: 'web-scrape',
          market: 'player_assists',
          outcomeName: 'Over',
          description: 'Victor Wembanyama',
          point: null
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes: [{
      sportKey: 'nba',
      homeTeam: 'San Antonio Spurs',
      awayTeam: 'Oklahoma City Thunder',
      displayName: 'Oklahoma City Thunder vs San Antonio Spurs',
      startTime,
      market: 'player_assists',
      outcomeName: 'Over',
      description: 'Shai Gilgeous-Alexander',
      point: 7.5,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/nba-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.9 }]
    }, {
      sportKey: 'nba',
      homeTeam: 'San Antonio Spurs',
      awayTeam: 'Oklahoma City Thunder',
      displayName: 'Oklahoma City Thunder vs San Antonio Spurs',
      startTime,
      market: 'player_rebounds',
      outcomeName: 'Over',
      description: 'Victor Wembanyama',
      point: 11.5,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/nba-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.85 }]
    }, {
      sportKey: 'nba',
      homeTeam: 'San Antonio Spurs',
      awayTeam: 'Oklahoma City Thunder',
      displayName: 'Oklahoma City Thunder vs San Antonio Spurs',
      startTime,
      market: 'player_points',
      outcomeName: 'Over',
      description: 'Jalen Williams',
      point: 18.5,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/nba-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.8 }]
    }]
  };

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.35,
      bestBookmaker: 'Sportsbet'
    }),
    replacementSnapshot: snapshot,
    fetchEspnSlate: async () => ({ events: [] }),
    fetchEspnTeamInjuries: async () => ({ injuries: [] }),
    ...buildAflResearchOverrides({
      Richmond: [{ playerId: 'rich-dion', playerName: 'Dion Prestia', position: 'MID' }],
      Essendon: [{ playerId: 'ess-zach', playerName: 'Zach Merrett', position: 'MID' }]
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'replacement');
  assert.equal(state.tracking.picks['auto-generator:nba:malformed-rebuild']?.status, 'posted_waiting_for_pregame_recheck');
  assert.equal(state.tracking.picks['auto-generator:nba:malformed-rebuild']?.activeReplacement, undefined);

  const trackerCsv = await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
  assert.doesNotMatch(trackerCsv, /replacement:auto-generator:nba:malformed-rebuild:fresh-snapshot-rebuild/);
});

test('runPicksJob rebuilds a malformed posted AFL slip from two clean disposal legs in the latest snapshot', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-afl-malformed-rebuild-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'afl',
    label: 'AFL',
    provider: 'espn',
    path: 'australian-football/afl',
    marketKey: 'afl',
    enabled: true,
    sportsGameOddsLeagueId: 'AFL'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:afl:malformed-rebuild'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:afl:malformed-rebuild'] = {
    postedAt: state.posts.picks['auto-generator:afl:malformed-rebuild'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:afl:malformed-rebuild',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Richmond vs Essendon',
    startTime,
    summary: 'Home Team 10+ Disposals + Away Team 10+ Disposals',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.18
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:afl:malformed-rebuild',
      eventId: 'snapshot:afl:richmond-vs-essendon',
      status: 'pending',
      sport: 'afl',
      sportLabel: 'AFL',
      event: 'Richmond vs Essendon',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      startTime,
      summary: 'Home Team 10+ Disposals + Away Team 10+ Disposals',
      rationale: 'Malformed AFL parser regression example.',
      betType: 'sgm',
      modelProbability: 0.53,
      supportScore: 7.6,
      confidenceTier: 'high',
      supportProjection: 'strong',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Home Team 10+ Disposals',
        status: 'active',
        rationale: 'Bad parser output.',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '10+ Disposals',
          description: 'Home Team',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Away Team 10+ Disposals',
        status: 'active',
        rationale: 'Bad parser output.',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '10+ Disposals',
          description: 'Away Team',
          point: null
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes: [{
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Zach Merrett',
      point: null,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/afl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.34 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Dion Prestia',
      point: null,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/afl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.31 }]
    }]
  };

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.35,
      bestBookmaker: 'Sportsbet'
    }),
    replacementSnapshot: snapshot,
    fetchEspnSlate: async () => ({ events: [] }),
    fetchEspnTeamInjuries: async () => ({ injuries: [] }),
    ...buildAflResearchOverrides({
      Richmond: [
        { playerId: 'rich-dion', playerName: 'Dion Prestia', position: 'MID' }
      ],
      Essendon: [
        { playerId: 'ess-zach', playerName: 'Zach Merrett', position: 'MID' }
      ]
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'replacement');
  assert.equal(state.tracking.picks['auto-generator:afl:malformed-rebuild']?.status, 'posted_waiting_for_pregame_recheck');
});

test('runPicksJob rebuilds a posted AFL slip when it uses off-step disposal ladders', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-afl-invalid-ladder-rebuild-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'afl',
    label: 'AFL',
    provider: 'espn',
    path: 'australian-football/afl',
    marketKey: 'afl',
    enabled: true,
    sportsGameOddsLeagueId: 'AFL'
  }];
  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:afl:invalid-ladder-rebuild'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:afl:invalid-ladder-rebuild'] = {
    postedAt: state.posts.picks['auto-generator:afl:invalid-ladder-rebuild'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:afl:invalid-ladder-rebuild',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'North Melbourne vs Gold Coast Suns',
    startTime,
    summary: 'Cameron Zurhaar 14+ Disposals + Charlie Comben 11+ Disposals',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.04
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:afl:invalid-ladder-rebuild',
      eventId: 'snapshot:afl:north-melbourne-vs-gold-coast-suns',
      status: 'pending',
      sport: 'afl',
      sportLabel: 'AFL',
      event: 'North Melbourne vs Gold Coast Suns',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      startTime,
      summary: 'Cameron Zurhaar 14+ Disposals + Charlie Comben 11+ Disposals',
      rationale: 'Posted before AFL disposal ladder guard tightened.',
      betType: 'sgm',
      modelProbability: 0.51,
      supportScore: 7.4,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Cameron Zurhaar 14+ Disposals',
        status: 'active',
        rationale: 'Invalid rung from stale generated feed.',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '14+ Disposals',
          description: 'Cameron Zurhaar',
          point: null
        }
      }, {
        id: 'leg-2',
        label: 'Charlie Comben 11+ Disposals',
        status: 'active',
        rationale: 'Invalid rung from stale generated feed.',
        source: {
          type: 'web-scrape',
          market: 'player_disposals',
          outcomeName: '11+ Disposals',
          description: 'Charlie Comben',
          point: null
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes: [{
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Cameron Zurhaar',
      point: null,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/afl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.35 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Charlie Comben',
      point: null,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/afl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.33 }]
    }]
  };

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.34,
      bestBookmaker: 'Sportsbet'
    }),
    replacementSnapshot: snapshot,
    fetchEspnSlate: async () => ({ events: [] }),
    fetchEspnTeamInjuries: async () => ({ injuries: [] }),
    ...buildAflResearchOverrides({
      'North Melbourne': [
        { playerId: 'nm-zurhaar', playerName: 'Cameron Zurhaar', position: 'FWD' },
        { playerId: 'nm-comben', playerName: 'Charlie Comben', position: 'FWD' }
      ],
      'Gold Coast Suns': []
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'replacement');
  assert.match(result.postedDetails[0].summary, /15\+ Disposals/);
  assert.doesNotMatch(result.postedDetails[0].summary, /11\+ Disposals|14\+ Disposals/);
  assert.equal(state.tracking.picks['auto-generator:afl:invalid-ladder-rebuild']?.status, 'posted_waiting_for_pregame_recheck');
});

test('buildFreshSnapshotReplacementOptions reuses AFL research filtering and attaches weather to rebuilt slips', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-afl-rebuild-weather-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'afl',
    label: 'AFL',
    provider: 'espn',
    path: 'australian-football/afl',
    marketKey: 'afl',
    enabled: true,
    sportsGameOddsLeagueId: 'AFL'
  }];

  const context = {
    config,
    state: buildBaseState(),
    dryRun: true
  };
  const startTime = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  const replacementOptions = await buildFreshSnapshotReplacementOptions(context, {
    id: 'auto-generator:afl:west-coast-weather-rebuild',
    eventId: 'snapshot:afl:west-coast-eagles-vs-essendon',
    status: 'pending',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'West Coast Eagles vs Essendon',
    homeTeam: 'West Coast Eagles',
    awayTeam: 'Essendon',
    startTime,
    summary: 'Legacy AFL slip without weather',
    rationale: 'Legacy rebuild target.',
    betType: 'sgm',
    modelProbability: 0.41,
    supportScore: 7.9,
    confidenceTier: 'high',
    supportProjection: 'strong',
    dataConfidence: 'medium',
    correlationRisk: 'low',
    correlationJustified: true,
    stakeUnits: 1,
    source: 'auto-generator',
    legs: [{
      id: 'leg-1',
      label: 'Legacy AFL Slip',
      status: 'active',
      rationale: 'Legacy placeholder',
      source: {
        type: 'web-scrape',
        market: 'player_disposals',
        outcomeName: '10+ Disposals',
        description: 'Legacy Player',
        point: null
      }
    }]
  }, new Date(), {
    replacementSnapshot: {
      updatedAt: new Date().toISOString(),
      quotes: [{
        sportKey: 'afl',
        homeTeam: 'West Coast Eagles',
        awayTeam: 'Essendon',
        displayName: 'West Coast Eagles vs Essendon',
        startTime,
        market: 'player_disposals',
        outcomeName: '10+ Disposals',
        description: 'Made Up Player',
        point: null,
        fetchedAt: new Date().toISOString(),
        source: 'web-scrape',
        sourceUrl: 'https://example.test/afl-event',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.16 }]
      }, {
        sportKey: 'afl',
        homeTeam: 'West Coast Eagles',
        awayTeam: 'Essendon',
        displayName: 'West Coast Eagles vs Essendon',
        startTime,
        market: 'player_disposals',
        outcomeName: '15+ Disposals',
        description: 'Archie Perkins',
        point: null,
        fetchedAt: new Date().toISOString(),
        source: 'web-scrape',
        sourceUrl: 'https://example.test/afl-event',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.36 }]
      }, {
        sportKey: 'afl',
        homeTeam: 'West Coast Eagles',
        awayTeam: 'Essendon',
        displayName: 'West Coast Eagles vs Essendon',
        startTime,
        market: 'player_disposals',
        outcomeName: '10+ Disposals',
        description: 'Brady Hough',
        point: null,
        fetchedAt: new Date().toISOString(),
        source: 'web-scrape',
        sourceUrl: 'https://example.test/afl-event',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.24 }]
      }]
    },
    fetchEspnSlate: async () => ({
      events: [{
        id: '1133588',
        homeTeam: 'West Coast Eagles',
        awayTeam: 'Essendon',
        homeTeamId: '3',
        awayTeamId: '16',
        startTime,
        venue: {
          id: '77',
          name: 'Optus Stadium',
          city: 'Perth',
          state: 'WA',
          country: 'Australia',
          latitude: -31.95079,
          longitude: 115.807236,
          indoor: false,
          roofType: ''
        }
      }]
    }),
    fetchEspnTeamInjuries: async () => ({ status: 'ok', injuries: [] }),
    fetchAflOfficialTeams: async () => [{
      id: 'west-coast',
      name: 'West Coast Eagles',
      teamType: 'men',
      metadata: {
        clubSiteUrl: 'https://example.test/west-coast'
      }
    }, {
      id: 'essendon',
      name: 'Essendon',
      teamType: 'men',
      metadata: {
        clubSiteUrl: 'https://example.test/essendon'
      }
    }],
    fetchAflClubTeamRoster: async (clubSiteUrl) => ({
      status: 'ok',
      players: clubSiteUrl.includes('essendon')
        ? [{ playerId: 'ess-archie', playerName: 'Archie Perkins', position: 'MID' }]
        : [{ playerId: 'wce-brady', playerName: 'Brady Hough', position: 'DEF' }]
    }),
    fetchAflOfficialPlayer: async (playerId) => ({
      player: {
        providerId: playerId
      }
    }),
    fetchAflStatsProPlayerProfile: async (providerId) => ({
      team: {
        teamName: providerId === 'ess-archie' ? 'Essendon' : 'West Coast Eagles'
      }
    }),
    geocodeOpenMeteoLocation: async () => {
      throw new Error('geocode should not be called for venues with coordinates');
    },
    fetchOpenMeteoForecast: async () => ({
      status: 'ok',
      forecast: {
        utc_offset_seconds: 0,
        hourly: {
          time: [startTime.slice(0, 16)],
          temperature_2m: [17.4],
          precipitation_probability: [68],
          precipitation: [1.2],
          wind_speed_10m: [24.8],
          wind_gusts_10m: [36.1],
          weather_code: [61]
        }
      }
    })
  });

  assert.equal(replacementOptions.length, 1);
  assert.equal(replacementOptions[0].weather?.summary, 'Rain');
  assert.match(replacementOptions[0].weather?.details || '', /68% rain/);
  assert.equal(replacementOptions[0].legs.length, 2);
  assert.deepEqual(
    replacementOptions[0].legs.map((leg) => leg.label),
    ['Archie Perkins 15+ Disposals', 'Brady Hough 10+ Disposals']
  );
  assert.equal(replacementOptions[0].espnEventId, '1133588');
});

test('runPicksJob cancels an outdoor generated pick when the late weather recheck flags severe conditions', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-weather-cancel-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'nfl',
    label: 'NFL',
    provider: 'espn',
    path: 'football/nfl',
    marketKey: 'nfl',
    enabled: true,
    sportsGameOddsLeagueId: 'NFL'
  }];

  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();
  const forecastTime = new Date(startTime);
  forecastTime.setUTCMinutes(0, 0, 0);
  const forecastLabel = forecastTime.toISOString().slice(0, 16);

  state.posts.picks['auto-generator:nfl:401000210'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nfl:401000210'] = {
    postedAt: state.posts.picks['auto-generator:nfl:401000210'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nfl:401000210',
    sport: 'nfl',
    sportLabel: 'NFL',
    event: 'Kansas City Chiefs vs Buffalo Bills',
    startTime,
    summary: 'Buffalo Bills ML',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 1.9
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nfl:401000210',
      status: 'pending',
      sport: 'nfl',
      sportLabel: 'NFL',
      event: 'Kansas City Chiefs vs Buffalo Bills',
      homeTeam: 'Buffalo Bills',
      awayTeam: 'Kansas City Chiefs',
      startTime,
      summary: 'Buffalo Bills ML',
      rationale: 'Structured test pick.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Buffalo Bills ML',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Buffalo Bills'
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.9,
      bestBookmaker: 'Sportsbet'
    }),
    fetchEspnSlate: async () => ({
      events: [{
        id: '401000210',
        startTime,
        homeTeam: 'Buffalo Bills',
        awayTeam: 'Kansas City Chiefs',
        homeTeamId: '2',
        awayTeamId: '12',
        venue: {
          name: 'Highmark Stadium',
          city: 'Orchard Park',
          state: 'NY',
          country: 'United States',
          latitude: 42.7738,
          longitude: -78.7868,
          indoor: false,
          roofType: 'Outdoor'
        }
      }]
    }),
    geocodeOpenMeteoLocation: async () => {
      throw new Error('geocode should not be called for venues with coordinates');
    },
    fetchOpenMeteoForecast: async () => ({
      status: 'ok',
      forecast: {
        utc_offset_seconds: 0,
        hourly: {
          time: [forecastLabel],
          temperature_2m: [16],
          precipitation_probability: [90],
          precipitation: [3.4],
          wind_speed_10m: [28],
          wind_gusts_10m: [72],
          weather_code: [95]
        }
      }
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'cancellation');
  assert.equal(state.tracking.picks['auto-generator:nfl:401000210']?.status, 'posted_waiting_for_pregame_recheck');

  const trackerCsv = await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
  assert.doesNotMatch(trackerCsv, /cancel:auto-generator:nfl:401000210/);
});

test('runPicksJob cancels an outdoor NRL pick when wet conditions make player-points legs too fragile', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-nrl-wet-points-cancel-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'nrl',
    label: 'NRL',
    provider: 'espn',
    path: 'rugby-league/3',
    marketKey: 'nrl',
    enabled: true,
    sportsGameOddsLeagueId: 'NRL'
  }];

  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();
  const forecastTime = new Date(startTime);
  forecastTime.setUTCMinutes(0, 0, 0);
  const forecastLabel = forecastTime.toISOString().slice(0, 16);

  state.posts.picks['auto-generator:nrl:401000310'] = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nrl:401000310'] = {
    postedAt: state.posts.picks['auto-generator:nrl:401000310'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nrl:401000310',
    sport: 'nrl',
    sportLabel: 'NRL',
    event: 'Canterbury Bulldogs vs Melbourne Storm',
    startTime,
    summary: 'Matt Burton 6+ Points + Under 47.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.1
    }
  }], new Date(Date.now() - 30 * 60 * 1000).toISOString());

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nrl:401000310',
      status: 'pending',
      sport: 'nrl',
      sportLabel: 'NRL',
      event: 'Canterbury Bulldogs vs Melbourne Storm',
      homeTeam: 'Melbourne Storm',
      awayTeam: 'Canterbury Bulldogs',
      startTime,
      summary: 'Matt Burton 6+ Points + Under 47.5',
      rationale: 'Structured test pick.',
      betType: 'same_game_multi',
      modelProbability: 0.59,
      supportScore: 6.4,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Matt Burton 6+ Points',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: '6+ Points',
          description: 'Matt Burton',
          point: 6
        }
      }, {
        id: 'leg-2',
        label: 'Under 47.5',
        status: 'active',
        rationale: 'Test leg.',
        source: {
          type: 'web-scrape',
          market: 'totals',
          outcomeName: 'Under',
          point: 47.5
        }
      }],
      analysisChecklist: {
        actionableSlate: 'pass',
        marketDepth: 'pass',
        selectionSupport: 'pass',
        playerAvailability: 'pass',
        roleStability: 'pass',
        externalConditions: 'pass',
        researchConfidence: 'pass',
        correlation: 'pass',
        ticketIntegrity: 'pass',
        bankrollFit: 'pass'
      }
    }]
  }, null, 2));

  const originalConsoleLog = console.log;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    const result = await runPicksJob({ config, state, dryRun: true }, {
      resolveOddsValidation: async () => ({
        status: 'ok',
        bestOdds: 1.45,
        bestBookmaker: 'Sportsbet'
      }),
      fetchEspnSlate: async () => ({
        events: [{
          id: '401000310',
          startTime,
          homeTeam: 'Melbourne Storm',
          awayTeam: 'Canterbury Bulldogs',
          homeTeamId: '1',
          awayTeamId: '2',
          venue: {
            name: 'AAMI Park',
            city: 'Melbourne',
            state: 'VIC',
            country: 'Australia',
            indoor: false,
            roofType: 'Outdoor'
          }
        }]
      }),
      fetchNrlOfficialSlate: async () => ({
        events: [{
          id: 'official-nrl-1',
          startTime,
          homeTeam: 'Melbourne Storm',
          awayTeam: 'Canterbury Bulldogs',
          matchCentreUrl: 'https://www.nrl.com/match-centre/test-match'
        }]
      }),
      fetchNrlOfficialSummary: async () => ({
        summary: {
          match: {
            weather: 'Fine',
            groundConditions: 'Good',
            venue: 'AAMI Park',
            venueCity: 'Melbourne'
          }
        }
      }),
      geocodeOpenMeteoLocation: async () => [{
        latitude: -37.8183,
        longitude: 144.9835
      }],
      fetchOpenMeteoForecast: async () => ({
        status: 'ok',
        forecast: {
          utc_offset_seconds: 0,
          hourly: {
            time: [forecastLabel],
            temperature_2m: [13],
            precipitation_probability: [70],
            precipitation: [0.8],
            wind_speed_10m: [18],
            wind_gusts_10m: [29],
            weather_code: [61]
          }
        }
      })
    });

    assert.equal(result.posted, 1);
    assert.equal(result.postedDetails[0].kind, 'cancellation');
    assert.match(logs.join('\n'), /Weather: Fine/);
    assert.match(logs.join('\n'), /Forecast: Ground Good \| AAMI Park, Melbourne \| 13C \| 70% rain \| 0\.8mm \| Wind 18 km\/h/);

    const trackerCsv = await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
    assert.doesNotMatch(trackerCsv, /cancel:auto-generator:nrl:401000310/);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('runSlatesJob uses SportsGameOdds fallback when the scraper has no slate events', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-slates-fallback-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes: []
  };

  const result = await runSlatesJob({ config, state, dryRun: true }, {
    snapshot,
    canUseSportsGameOdds: async () => true,
    fetchSportsGameOddsSlate: async () => ({
      status: 'ok',
      events: [{
        id: 'event-1',
        name: 'San Antonio Spurs vs Oklahoma City Thunder',
        startTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        state: 'pre',
        shortStatus: 'Upcoming'
      }],
      objectCost: 1
    })
  });

  assert.equal(result.posted, 1);
  assert.equal(state.jobs.slates.source, 'sports-game-odds-fallback');
  assert.equal(state.providers.sportsGameOdds.lastObjectCost, 1);
});

test('runSlatesJob picks the next actionable local slate date when today is empty', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-slates-next-date-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const nextLocalSlate = getNextLocalDateIso(config.timezone);
  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes: [{
      sportKey: 'nba',
      homeTeam: 'Oklahoma City Thunder',
      awayTeam: 'San Antonio Spurs',
      displayName: 'San Antonio Spurs vs Oklahoma City Thunder',
      startTime: nextLocalSlate.iso,
      fetchedAt: new Date().toISOString(),
      prices: [{
        bookmakerKey: 'sportsbet-web',
        bookmakerTitle: 'Sportsbet Web',
        price: 1.9
      }]
    }]
  };

  const result = await runSlatesJob({ config, state, dryRun: true }, {
    snapshot,
    canUseSportsGameOdds: async () => false
  });

  assert.equal(result.posted, 1);
  assert.equal(result.targetDateKey, nextLocalSlate.dateKey);
  assert.equal(state.jobs.slates.targetDateKey, nextLocalSlate.dateKey);
  assert.equal(state.jobs.slates.source, 'market-scrape');
});

test('SportsGameOdds team normalization strips scraper-added pitcher tags', () => {
  assert.equal(
    sportsGameOddsTestables.normalizeComparableTeamName('Miami Marlins (M Meyer)'),
    sportsGameOddsTestables.normalizeComparableTeamName('Miami Marlins')
  );

  assert.equal(
    sportsGameOddsTestables.normalizeComparableTeamName('Atlanta Braves (J Ritchie)'),
    sportsGameOddsTestables.normalizeComparableTeamName('Atlanta Braves')
  );
});

test('runPicksJob forces a fresh 3-leg NRL replacement rebuild during a late recheck', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-nrl-fresh-rebuild-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'nrl',
    label: 'NRL',
    provider: 'espn',
    path: 'rugbyleague_nrl',
    marketKey: 'nrl',
    enabled: true,
    sportsGameOddsLeagueId: 'NRL'
  }];

  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:nrl:fresh-rebuild'] = postedAt;
  state.tracking.picks['auto-generator:nrl:fresh-rebuild'] = {
    postedAt,
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nrl:fresh-rebuild',
    sport: 'nrl',
    sportLabel: 'NRL',
    event: 'Manly SEA Eagles vs Gold Coast Titans',
    startTime,
    summary: 'Jayden Campbell 6+ Points + 1st Half Under 24.5',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.86
    }
  }], postedAt);

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nrl:fresh-rebuild',
      eventId: 'snapshot:nrl:manly-sea-eagles-vs-gold-coast-titans',
      status: 'pending',
      sport: 'nrl',
      sportLabel: 'NRL',
      event: 'Manly SEA Eagles vs Gold Coast Titans',
      homeTeam: 'Manly SEA Eagles',
      awayTeam: 'Gold Coast Titans',
      startTime,
      summary: 'Jayden Campbell 6+ Points + 1st Half Under 24.5',
      rationale: 'Original NRL late-recheck example.',
      betType: 'sgm',
      modelProbability: 0.4,
      supportScore: 6.3,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Jayden Campbell 6+ Points',
        status: 'active',
        rationale: 'Original player-points leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: '6+ Points',
          description: 'Jayden Campbell',
          point: null
        }
      }, {
        id: 'leg-2',
        label: '1st Half Under 24.5',
        status: 'active',
        rationale: 'Original first-half total leg.',
        source: {
          type: 'web-scrape',
          market: 'first_half_totals',
          outcomeName: 'Under',
          description: '',
          point: 24.5
        }
      }],
      replacementTemplate: {
        candidateLegs: [{
          id: 'backup-1',
          label: 'Jayden Campbell 4+ Points',
          rationale: 'Template backup leg that should be ignored for forced fresh NRL rebuilds.',
          source: {
            type: 'web-scrape',
            market: 'player_points',
            outcomeName: '4+ Points',
            description: 'Jayden Campbell',
            point: null
          }
        }],
        maxOptions: 1
      },
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes: [{
      sportKey: 'nrl',
      homeTeam: 'Manly SEA Eagles',
      awayTeam: 'Gold Coast Titans',
      displayName: 'Manly SEA Eagles vs Gold Coast Titans',
      startTime,
      market: 'first_half_totals',
      outcomeName: 'Under',
      description: '',
      point: 26.5,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/nrl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.34 }]
    }, {
      sportKey: 'nrl',
      homeTeam: 'Manly SEA Eagles',
      awayTeam: 'Gold Coast Titans',
      displayName: 'Manly SEA Eagles vs Gold Coast Titans',
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      description: '',
      point: 52.5,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/nrl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.47 }]
    }, {
      sportKey: 'nrl',
      homeTeam: 'Manly SEA Eagles',
      awayTeam: 'Gold Coast Titans',
      displayName: 'Manly SEA Eagles vs Gold Coast Titans',
      startTime,
      market: 'first_half_spreads',
      outcomeName: 'Gold Coast Titans',
      description: '',
      point: 6.5,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/nrl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.58 }]
    }]
  };

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async (_context, oddsCheck) => {
      if (oddsCheck.market === 'first_half_totals' && Number(oddsCheck.point) === 24.5) {
        return { status: 'budget_guard', source: 'snapshot' };
      }

      return {
        status: 'ok',
        bestOdds: 1.45,
        bestBookmaker: 'Sportsbet',
        source: 'snapshot'
      };
    },
    replacementSnapshot: snapshot,
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-nrl-fresh-rebuild',
        homeTeam: 'Manly SEA Eagles',
        homeTeamId: 'manly',
        awayTeam: 'Gold Coast Titans',
        awayTeamId: 'titans',
        venue: {
          name: '4 Pines Park',
          indoor: false,
          roofType: ''
        }
      }]
    }),
    fetchEspnTeamInjuries: async () => ({ injuries: [] })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'replacement');
  assert.equal(result.postedDetails[0].legCount, 3);
  assert.match(result.postedDetails[0].summary, / \+ .* \+ /);

  const trackerCsv = await fs.readFile(config.__paths.bankrollTrackerFile, 'utf8');
  assert.doesNotMatch(trackerCsv, /replacement:auto-generator:nrl:fresh-rebuild:backup-1/);
});

test('runPicksJob supports a fresh 3-leg NRL replacement rebuild with one kicker-points leg', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-nrl-kicker-rebuild-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  config.sports = [{
    key: 'nrl',
    label: 'NRL',
    provider: 'espn',
    path: 'rugbyleague_nrl',
    marketKey: 'nrl',
    enabled: true,
    sportsGameOddsLeagueId: 'NRL'
  }];

  const state = buildBaseState();
  const startTime = new Date(Date.now() + 50 * 60 * 1000).toISOString();
  const postedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  state.posts.picks['auto-generator:nrl:kicker-rebuild'] = postedAt;
  state.tracking.picks['auto-generator:nrl:kicker-rebuild'] = {
    postedAt,
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(Date.now() - 60 * 1000).toISOString()
  };

  await appendPostedTrackerEntries(config, [{
    id: 'auto-generator:nrl:kicker-rebuild',
    sport: 'nrl',
    sportLabel: 'NRL',
    event: 'Manly SEA Eagles vs Gold Coast Titans',
    startTime,
    summary: '1st Half Under 24.5 + Gold Coast Titans H2H',
    stakeUnits: 1,
    source: 'auto-generator',
    publicationValidation: {
      totalOdds: 2.31
    }
  }], postedAt);

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nrl:kicker-rebuild',
      eventId: 'snapshot:nrl:manly-sea-eagles-vs-gold-coast-titans-kicker',
      status: 'pending',
      sport: 'nrl',
      sportLabel: 'NRL',
      event: 'Manly SEA Eagles vs Gold Coast Titans',
      homeTeam: 'Manly SEA Eagles',
      awayTeam: 'Gold Coast Titans',
      startTime,
      summary: '1st Half Under 24.5 + Gold Coast Titans H2H',
      rationale: 'Original NRL late-recheck example.',
      betType: 'sgm',
      modelProbability: 0.4,
      supportScore: 6.1,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: '1st Half Under 24.5',
        status: 'active',
        rationale: 'Original first-half total leg.',
        source: {
          type: 'web-scrape',
          market: 'first_half_totals',
          outcomeName: 'Under',
          description: '',
          point: 24.5
        }
      }, {
        id: 'leg-2',
        label: 'Gold Coast Titans H2H',
        status: 'active',
        rationale: 'Original H2H leg.',
        source: {
          type: 'web-scrape',
          market: 'h2h',
          outcomeName: 'Gold Coast Titans',
          description: '',
          point: null
        }
      }],
      replacementTemplate: {
        candidateLegs: [],
        maxOptions: 1
      },
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes: [{
      sportKey: 'nrl',
      homeTeam: 'Manly SEA Eagles',
      awayTeam: 'Gold Coast Titans',
      displayName: 'Manly SEA Eagles vs Gold Coast Titans',
      startTime,
      market: 'first_half_totals',
      outcomeName: 'Under',
      description: '',
      point: 26.5,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/nrl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.34 }]
    }, {
      sportKey: 'nrl',
      homeTeam: 'Manly SEA Eagles',
      awayTeam: 'Gold Coast Titans',
      displayName: 'Manly SEA Eagles vs Gold Coast Titans',
      startTime,
      market: 'first_half_spreads',
      outcomeName: 'Gold Coast Titans',
      description: '',
      point: 6.5,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/nrl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.58 }]
    }, {
      sportKey: 'nrl',
      homeTeam: 'Manly SEA Eagles',
      awayTeam: 'Gold Coast Titans',
      displayName: 'Manly SEA Eagles vs Gold Coast Titans',
      startTime,
      market: 'player_points',
      outcomeName: '6+ Points',
      description: 'Jayden Campbell',
      point: null,
      fetchedAt: new Date().toISOString(),
      source: 'web-scrape',
      sourceUrl: 'https://example.test/nrl-event',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.42 }]
    }]
  };

  const result = await runPicksJob({ config, state, dryRun: true }, {
    resolveOddsValidation: async (_context, oddsCheck) => {
      if (oddsCheck.market === 'first_half_totals' && Number(oddsCheck.point) === 24.5) {
        return { status: 'budget_guard', source: 'snapshot' };
      }

      return {
        status: 'ok',
        bestOdds: 1.45,
        bestBookmaker: 'Sportsbet',
        source: 'snapshot'
      };
    },
    replacementSnapshot: snapshot,
    fetchEspnSlate: async () => ({
      events: [{
        id: 'event-nrl-kicker-rebuild',
        homeTeam: 'Manly SEA Eagles',
        homeTeamId: 'manly',
        awayTeam: 'Gold Coast Titans',
        awayTeamId: 'titans',
        venue: {
          name: '4 Pines Park',
          indoor: false,
          roofType: ''
        }
      }]
    }),
    fetchEspnTeamInjuries: async () => ({ injuries: [] })
  });

  assert.equal(result.posted, 1);
  assert.equal(result.postedDetails[0].kind, 'replacement');
  assert.equal(result.postedDetails[0].legCount, 3);
  assert.match(result.postedDetails[0].summary, /Jayden Campbell 6\+ Points/);
});

test('runPicksJob skips posting a replacement once the event has already started by send time', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-replacement-post-start-skip-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const runStartedAt = new Date();
  const startTime = new Date(runStartedAt.getTime() + 5 * 60 * 1000).toISOString();
  const afterStart = new Date(new Date(startTime).getTime() + 60 * 1000);
  let currentTimeCall = 0;

  state.posts.picks['auto-generator:nba:post-start-replacement-skip'] = new Date(runStartedAt.getTime() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nba:post-start-replacement-skip'] = {
    postedAt: state.posts.picks['auto-generator:nba:post-start-replacement-skip'],
    status: 'replacement_watch',
    nextCheckAt: new Date(runStartedAt.getTime() - 60 * 1000).toISOString()
  };

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:post-start-replacement-skip',
      status: 'pending',
      replacementStatus: 'replacement_needed',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'San Antonio Spurs',
      awayTeam: 'Oklahoma City Thunder',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Replacement skip timing test.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Original test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      replacementOptions: [{
        variantId: 'backup-1',
        summary: 'Jalen Williams Over 19.5',
        betType: 'single',
        modelProbability: 0.61,
        supportScore: 6.2,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        rationale: 'Fallback leg stays live.',
        replacementReason: 'Original player was ruled out during the late recheck.',
        legs: [{
          id: 'leg-1',
          label: 'Jalen Williams Over 19.5',
          status: 'active',
          rationale: 'Fallback leg stays live.',
          source: {
            type: 'web-scrape',
            market: 'player_points',
            outcomeName: 'Over',
            description: 'Jalen Williams',
            point: 19.5
          }
        }]
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    getCurrentTime: () => {
      currentTimeCall += 1;
      return currentTimeCall === 1 ? new Date(runStartedAt) : new Date(afterStart);
    },
    resolveOddsValidation: async () => ({
      status: 'ok',
      bestOdds: 1.35,
      bestBookmaker: 'Sportsbet',
      source: 'snapshot'
    })
  });

  assert.equal(result.posted, 0);
  assert.deepEqual(result.postedDetails || [], []);
});

test('runPicksJob skips posting a cancellation once the event has already started by send time', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-picks-cancellation-post-start-skip-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const config = buildBaseConfig(workspaceRoot);
  const state = buildBaseState();
  const runStartedAt = new Date();
  const startTime = new Date(runStartedAt.getTime() + 5 * 60 * 1000).toISOString();
  const afterStart = new Date(new Date(startTime).getTime() + 60 * 1000);
  let currentTimeCall = 0;

  state.posts.picks['auto-generator:nba:post-start-cancel-skip'] = new Date(runStartedAt.getTime() - 30 * 60 * 1000).toISOString();
  state.tracking.picks['auto-generator:nba:post-start-cancel-skip'] = {
    postedAt: state.posts.picks['auto-generator:nba:post-start-cancel-skip'],
    status: 'posted_waiting_for_pregame_recheck',
    nextCheckAt: new Date(runStartedAt.getTime() - 60 * 1000).toISOString()
  };

  await fs.mkdir(path.dirname(config.__paths.picksFeedFile), { recursive: true });
  await fs.writeFile(config.__paths.picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:nba:post-start-cancel-skip',
      status: 'pending',
      sport: 'nba',
      sportLabel: 'NBA',
      event: 'San Antonio Spurs vs Oklahoma City Thunder',
      homeTeam: 'San Antonio Spurs',
      awayTeam: 'Oklahoma City Thunder',
      startTime,
      summary: 'Shai Gilgeous-Alexander Over 29.5',
      rationale: 'Cancellation skip timing test.',
      betType: 'single',
      modelProbability: 0.61,
      supportScore: 6.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      stakeUnits: 1,
      source: 'auto-generator',
      legs: [{
        id: 'leg-1',
        label: 'Shai Gilgeous-Alexander Over 29.5',
        status: 'active',
        rationale: 'Original test leg.',
        source: {
          type: 'web-scrape',
          market: 'player_points',
          outcomeName: 'Over',
          description: 'Shai Gilgeous-Alexander',
          point: 29.5
        }
      }],
      analysisChecklist: {
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
      }
    }]
  }, null, 2));

  const result = await runPicksJob({ config, state, dryRun: true }, {
    getCurrentTime: () => {
      currentTimeCall += 1;
      return currentTimeCall === 1 ? new Date(runStartedAt) : new Date(afterStart);
    },
    resolveOddsValidation: async () => ({ status: 'snapshot_stale' })
  });

  assert.equal(result.posted, 0);
  assert.deepEqual(result.postedDetails || [], []);
});