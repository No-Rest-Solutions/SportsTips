import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyzeEventWithRules, buildAnalysisCandidatePool, buildPickFromAnalysisDecision } from '../src/ai-pick-generator.mjs';
import { appendPostedTrackerEntries } from '../src/bot-tracker.mjs';
import { filterCandidatePoolForResearch, runAnalysisJob } from '../src/jobs/analysis.mjs';
import { extractRotowireMlbDailyLineups, extractRotowireMlbNews, findMatchingRotowireMlbGame, getRotowireMlbLineupsPageKey } from '../src/providers/mlb-rotowire.mjs';
import { parseFeaturedMarketsFromText } from '../src/web-market-intake.mjs';

const PASSING_CHECKLIST = {
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
};

test('filterCandidatePoolForResearch uses official NRL weather and ground conditions when venue weather lookup is unavailable', async () => {
  const sport = {
    key: 'nrl',
    label: 'NRL',
    marketKey: 'nrl'
  };
  const eventContext = {
    sportKey: 'nrl',
    sportLabel: 'NRL',
    marketSportKey: 'nrl',
    eventId: 'snapshot:nrl:broncos-v-dragons-weather',
    eventName: 'St George Illawarra Dragons vs Brisbane Broncos',
    homeTeam: 'Brisbane Broncos',
    homeTeamId: '',
    awayTeam: 'St George Illawarra Dragons',
    awayTeamId: '',
    startTime: '2026-05-31T04:00:00Z',
    venue: null,
    weather: null,
    generatorConfig: {
      stakeUnits: 1
    }
  };
  const researchedPool = await filterCandidatePoolForResearch(
    sport,
    eventContext,
    [],
    {
      injury: new Map(),
      weather: new Map()
    },
    {
      fetchNrlOfficialSlate: async () => ({
        sourceUrl: 'https://example.test/nrl-draw',
        events: [{
          id: 'nrl-official-weather-1',
          startTime: '2026-05-31T04:00:00Z',
          homeTeam: 'Brisbane Broncos',
          awayTeam: 'St George Illawarra Dragons',
          matchCentreUrl: '/draw/nrl-premiership/2026/round-13/broncos-v-dragons/',
          sourceUrl: 'https://www.nrl.com/draw/nrl-premiership/2026/round-13/broncos-v-dragons/'
        }]
      }),
      fetchNrlOfficialSummary: async () => ({
        summary: {
          match: {
            weather: 'Fine',
            groundConditions: 'Good',
            venue: 'Suncorp Stadium',
            venueCity: 'Brisbane'
          }
        }
      })
    }
  );

  assert.deepEqual(researchedPool, []);
  assert.equal(eventContext.weather?.summary, 'Fine');
  assert.match(eventContext.weather?.details || '', /Ground Good/);
  assert.match(eventContext.weather?.details || '', /Suncorp Stadium, Brisbane/);
});

test('runAnalysisJob generates a pending pick from scraped snapshot quotes', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    benchmarkFilters: {
      requireSupportData: false,
      significantSupportScore: 5,
      strongSupportScore: 8
    },
    discord: {
      webhooks: {
        slates: '',
        picks: '',
        results: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    openai: {
      enabled: false,
      apiKey: '',
      model: 'gpt-5.4'
    },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'afl',
      label: 'AFL',
      enabled: true,
      marketKey: 'afl'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
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
      marketScrape: {}
    },
    tracking: {
      picks: {}
    }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'James Worpel',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.38 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Jordan Dawson',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.42 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_goals',
      outcomeName: '1+ Goal',
      description: 'Mabior Chol',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.56 }]
    }]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    analyzeEvent: ({ candidatePool }) => ({
      qualifies: true,
      recommendation: 'bet',
      selectedLegs: [
        {
          candidateId: candidatePool[0].candidateId,
          modelProbability: 0.64,
          rationale: 'Primary support leg.'
        },
        {
          candidateId: candidatePool[1].candidateId,
          modelProbability: 0.61,
          rationale: 'Secondary support leg.'
        }
      ],
      backupLeg: {
        candidateId: candidatePool[2].candidateId,
        modelProbability: 0.58,
        rationale: 'Backup support leg.'
      },
      combinedModelProbability: 0.39,
      supportScore: 7.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      exceptionalSupport: false,
      strongSupport: false,
      stakeUnits: 4,
      rationale: 'Scraped market test pick.',
      notes: 'Rules stub.',
      checklist: PASSING_CHECKLIST,
      generatedSource: 'rules-generator',
      analysisEngine: 'rules'
    })
  });

  assert.equal(result.generated, 1);
  assert.equal(state.jobs.analysis.generated, 1);

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 1);
  assert.equal(savedFeed.picks[0].status, 'pending');
  assert.equal(savedFeed.picks[0].analysisEngine, 'rules');
  assert.equal(savedFeed.picks[0].dataConfidence, 'medium');
  assert.equal(savedFeed.picks[0].stakeUnits, 2);
  assert.equal(savedFeed.picks[0].legs.length, 2);
  assert.ok(savedFeed.picks[0].summary.length > 0);
  assert.ok(savedFeed.picks[0].legs.every((leg) => leg.label.length > 0));
});

test('runAnalysisJob keeps AFL props eligible when ESPN injury pages are unavailable', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-afl-injuries-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    benchmarkFilters: {
      requireSupportData: false,
      significantSupportScore: 5,
      strongSupportScore: 8
    },
    discord: {
      webhooks: {
        slates: '',
        picks: '',
        results: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    openai: {
      enabled: false,
      apiKey: '',
      model: 'gpt-5.4'
    },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'afl',
      label: 'AFL',
      enabled: true,
      path: 'australian-football/afl',
      marketKey: 'afl'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
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
      marketScrape: {}
    },
    tracking: {
      picks: {}
    }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'afl',
      homeTeam: 'St Kilda',
      awayTeam: 'Hawthorn',
      displayName: 'St Kilda vs Hawthorn',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Jack Macrae',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.45 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'St Kilda',
      awayTeam: 'Hawthorn',
      displayName: 'St Kilda vs Hawthorn',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'James Worpel',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.46 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'St Kilda',
      awayTeam: 'Hawthorn',
      displayName: 'St Kilda vs Hawthorn',
      startTime,
      market: 'player_goals',
      outcomeName: '1+ Goal',
      description: 'Mabior Chol',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.55 }]
    }]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async () => ({
      sourceUrl: 'test://espn/afl',
      events: [{
        id: 'afl-event-1',
        name: 'Hawthorn vs St Kilda',
        startTime,
        homeTeamId: '18',
        homeTeam: 'St Kilda',
        awayTeamId: '13',
        awayTeam: 'Hawthorn',
        venue: {
          id: '79',
          name: 'Marvel Stadium',
          city: '',
          state: '',
          country: '',
          indoor: true,
          roofType: 'closed'
        },
        state: 'pre',
        shortStatus: 'Scheduled'
      }]
    }),
    fetchEspnTeamInjuries: async (_sport, teamId) => ({
      teamId,
      teamName: teamId === '18' ? 'St Kilda' : 'Hawthorn',
      sourceUrl: '',
      status: 'injury_link_missing',
      injuries: []
    }),
    analyzeEvent: ({ candidatePool }) => ({
      qualifies: true,
      recommendation: 'build_2_leg_multi',
      selectedLegs: [
        {
          candidateId: candidatePool[0].candidateId,
          modelProbability: 0.64,
          rationale: 'Primary support leg.'
        },
        {
          candidateId: candidatePool[1].candidateId,
          modelProbability: 0.62,
          rationale: 'Secondary support leg.'
        }
      ],
      backupLeg: {
        candidateId: candidatePool[2].candidateId,
        modelProbability: 0.58,
        rationale: 'Backup support leg.'
      },
      combinedModelProbability: 0.4,
      supportScore: 7.3,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      exceptionalSupport: false,
      strongSupport: false,
      stakeUnits: 1,
      rationale: 'AFL injury-link fallback test pick.',
      notes: 'Rules stub.',
      checklist: PASSING_CHECKLIST,
      noBetReason: null,
      summary: null
    })
  });

  assert.equal(result.generated, 1);
  assert.equal(state.jobs.analysis.generated, 1);

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 1);
  assert.equal(savedFeed.picks[0].sport, 'afl');
  assert.equal(savedFeed.picks[0].status, 'pending');
});

test('runAnalysisJob still builds an AFL pick when pre-pick weather lookup falls back', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-afl-weather-lookup-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    benchmarkFilters: {
      requireSupportData: false,
      significantSupportScore: 5,
      strongSupportScore: 8
    },
    discord: {
      webhooks: {
        slates: '',
        picks: '',
        results: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    openai: {
      enabled: false,
      apiKey: '',
      model: 'gpt-5.4'
    },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'afl',
      label: 'AFL',
      enabled: true,
      path: 'australian-football/afl',
      marketKey: 'afl'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
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
      marketScrape: {}
    },
    tracking: {
      picks: {}
    }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'afl',
      homeTeam: 'Sydney Swans',
      awayTeam: 'Richmond',
      displayName: 'Sydney Swans vs Richmond',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'James Rowbottom',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.42 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Sydney Swans',
      awayTeam: 'Richmond',
      displayName: 'Sydney Swans vs Richmond',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Sam Wicks',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.47 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Sydney Swans',
      awayTeam: 'Richmond',
      displayName: 'Sydney Swans vs Richmond',
      startTime,
      market: 'player_goals',
      outcomeName: '1+ Goal',
      description: 'James Rowbottom',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.58 }]
    }]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async () => ({
      sourceUrl: 'test://espn/afl-weather',
      events: [{
        id: 'afl-weather-1',
        name: 'Richmond vs Sydney Swans',
        startTime,
        homeTeamId: '4',
        homeTeam: 'Sydney Swans',
        awayTeamId: '12',
        awayTeam: 'Richmond',
        venue: {
          id: '84',
          name: 'SCG',
          city: 'Sydney',
          state: 'NSW',
          country: 'Australia',
          indoor: false,
          roofType: ''
        },
        state: 'pre',
        shortStatus: 'Scheduled'
      }]
    }),
    fetchEspnTeamInjuries: async (_sport, teamId) => ({
      teamId,
      teamName: teamId === '4' ? 'Sydney Swans' : 'Richmond',
      sourceUrl: '',
      status: 'ok',
      injuries: []
    }),
    geocodeOpenMeteoLocation: async () => {
      throw new Error('weather lookup timeout');
    },
    fetchAflOfficialTeams: async () => ([{
      id: 'syd',
      teamType: 'men',
      name: 'Sydney Swans',
      club: { name: 'Sydney Swans' },
      nickname: 'Swans',
      metadata: { clubSiteUrl: 'https://example.test/sydney-swans' }
    }, {
      id: 'ric',
      teamType: 'men',
      name: 'Richmond',
      club: { name: 'Richmond' },
      nickname: 'Tigers',
      metadata: { clubSiteUrl: 'https://example.test/richmond' }
    }]),
    fetchAflClubTeamRoster: async (clubSiteUrl) => ({
      status: 'ok',
      players: clubSiteUrl.includes('sydney-swans')
        ? [{ playerId: '1001', playerName: 'James Rowbottom' }, { playerId: '1002', playerName: 'Sam Wicks' }]
        : []
    }),
    fetchAflOfficialPlayer: async (playerId) => ({
      player: { providerId: playerId === '1001' ? 'prov-1001' : 'prov-1002' }
    }),
    fetchAflStatsProPlayerProfile: async (providerId) => ({
      team: { teamName: providerId === 'prov-1001' || providerId === 'prov-1002' ? 'Sydney Swans' : '' }
    })
  });

  assert.equal(result.generated, 1);
  assert.equal(state.jobs.analysis.generated, 1);

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 1);
  assert.equal(savedFeed.picks[0].sport, 'afl');
  assert.equal(savedFeed.picks[0].status, 'pending');
});

test('runAnalysisJob allows EPL two-leg candidate pools when the global minimum is three', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-epl-two-leg-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: {
        slates: '',
        picks: '',
        results: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    openai: {
      enabled: false,
      apiKey: '',
      model: 'gpt-5.4'
    },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'soccer_epl',
      label: 'EPL',
      enabled: true,
      marketKey: 'soccer_epl'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
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
      marketScrape: {}
    },
    tracking: {
      picks: {}
    }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'soccer_epl',
      homeTeam: 'Liverpool',
      awayTeam: 'Brentford',
      displayName: 'Liverpool vs Brentford',
      startTime,
      market: 'player_goals',
      outcomeName: '& O/U 2.5 Goals',
      description: 'Both Teams',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.83 }]
    }, {
      sportKey: 'soccer_epl',
      homeTeam: 'Liverpool',
      awayTeam: 'Brentford',
      displayName: 'Liverpool vs Brentford',
      startTime,
      market: 'player_goals',
      outcomeName: 'the First Goal',
      description: 'Team',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.72 }]
    }]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async () => ({
      events: [{
        id: 'espn-ucl-1',
        homeTeam: 'Real Madrid',
        awayTeam: 'Inter Milan',
        homeTeamId: 'team-home-1',
        awayTeamId: 'team-away-1',
        startTime,
        venue: {
          name: 'Santiago Bernabeu',
          city: 'Madrid',
          country: 'Spain',
          indoor: false
        }
      }]
    }),
    geocodeOpenMeteoLocation: async () => ([{
      latitude: 40.4531,
      longitude: -3.6883
    }]),
    fetchOpenMeteoForecast: async () => ({
      status: 'ok',
      forecast: {
        utc_offset_seconds: 0,
        hourly: {
          time: [startTime],
          temperature_2m: [18],
          precipitation_probability: [5],
          precipitation: [0],
          wind_speed_10m: [14],
          wind_gusts_10m: [21],
          weather_code: [0]
        }
      }
    }),
    analyzeEvent: ({ candidatePool }) => {
      assert.equal(candidatePool.length, 2);

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: [
          {
            candidateId: candidatePool[0].candidateId,
            modelProbability: 0.62,
            rationale: 'Primary EPL support leg.'
          },
          {
            candidateId: candidatePool[1].candidateId,
            modelProbability: 0.59,
            rationale: 'Secondary EPL support leg.'
          }
        ],
        backupLeg: null,
        combinedModelProbability: 0.37,
        supportScore: 6.4,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 2,
        rationale: 'Two-leg EPL markets should still be analyzable.',
        notes: 'Regression coverage for EPL minimum candidate legs.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(result.generated, 1);
  assert.equal(result.considered, 1);
  assert.equal(state.jobs.analysis.generated, 1);
  assert.equal(state.jobs.analysis.considered, 1);

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 1);
  assert.equal(savedFeed.picks[0].status, 'pending');
  assert.equal(savedFeed.picks[0].sport, 'soccer_epl');
  assert.equal(savedFeed.picks[0].legs.length, 2);
});

test('runAnalysisJob allows non-EPL soccer two-leg candidate pools when the global minimum is three', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-soccer-two-leg-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: {
        slates: '',
        picks: '',
        results: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    openai: {
      enabled: false,
      apiKey: '',
      model: 'gpt-5.4'
    },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'soccer_uefa_champs_league',
      label: 'Soccer / UCL',
      enabled: true,
      marketKey: 'soccer_uefa_champs_league',
      path: 'soccer/uefa.champions'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
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
      marketScrape: {}
    },
    tracking: {
      picks: {}
    }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'soccer_uefa_champs_league',
      homeTeam: 'Real Madrid',
      awayTeam: 'Inter Milan',
      displayName: 'Real Madrid vs Inter Milan',
      startTime,
      market: 'totals',
      outcomeName: 'Over',
      description: '',
      point: 2.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.83 }]
    }, {
      sportKey: 'soccer_uefa_champs_league',
      homeTeam: 'Real Madrid',
      awayTeam: 'Inter Milan',
      displayName: 'Real Madrid vs Inter Milan',
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      description: '',
      point: 2.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.97 }]
    }]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    analyzeEvent: ({ candidatePool }) => {
      assert.equal(candidatePool.length, 2);

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: [{
          candidateId: candidatePool[0].candidateId,
          modelProbability: 0.61,
          rationale: 'Primary totals leg.'
        }, {
          candidateId: candidatePool[1].candidateId,
          modelProbability: 0.58,
          rationale: 'Secondary totals leg.'
        }],
        backupLeg: null,
        combinedModelProbability: 0.35,
        supportScore: 6.1,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 2,
        rationale: 'Two-leg non-EPL soccer markets should still be analyzable.',
        notes: 'Regression coverage for generic soccer minimum candidate legs.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(result.generated, 1);
  assert.equal(result.considered, 1);

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 1);
  assert.equal(savedFeed.picks[0].sport, 'soccer_uefa_champs_league');
  assert.equal(savedFeed.picks[0].legs.length, 2);
});

test('runAnalysisJob allows tennis single-leg h2h builds when the global minimum is three', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-tennis-single-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: {
        slates: '',
        picks: '',
        results: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    openai: {
      enabled: false,
      apiKey: '',
      model: 'gpt-5.4'
    },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'tennis_atp',
      label: 'Tennis / ATP',
      enabled: true,
      marketKey: 'tennis_atp'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
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
      marketScrape: {}
    },
    tracking: {
      picks: {}
    }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'tennis_atp',
      homeTeam: 'Carlos Alcaraz',
      awayTeam: 'Jannik Sinner',
      displayName: 'Carlos Alcaraz vs Jannik Sinner',
      startTime,
      market: 'h2h',
      outcomeName: 'Carlos Alcaraz',
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.85 }]
    }, {
      sportKey: 'tennis_atp',
      homeTeam: 'Carlos Alcaraz',
      awayTeam: 'Jannik Sinner',
      displayName: 'Carlos Alcaraz vs Jannik Sinner',
      startTime,
      market: 'h2h',
      outcomeName: 'Jannik Sinner',
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.95 }]
    }]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    analyzeEvent: ({ candidatePool }) => {
      assert.equal(candidatePool.length, 2);

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: [{
          candidateId: candidatePool[0].candidateId,
          modelProbability: 0.59,
          rationale: 'Tennis should allow a single H2H leg.'
        }],
        backupLeg: null,
        combinedModelProbability: 0.59,
        supportScore: 5.8,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 1,
        rationale: 'Single-leg tennis H2H should remain publishable.',
        notes: 'Regression coverage for tennis leg floor.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(result.generated, 1);
  assert.equal(result.considered, 1);

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 1);
  assert.equal(savedFeed.picks[0].sport, 'tennis_atp');
  assert.equal(savedFeed.picks[0].legs.length, 1);
  assert.equal(savedFeed.picks[0].betType, 'single');
});

test('runAnalysisJob removes injured AFL player props before analysis', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-afl-injury-filter-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'afl',
      label: 'AFL',
      provider: 'espn',
      path: 'australian-football/afl',
      enabled: true,
      marketKey: 'afl'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'player_disposals',
      outcomeName: '10+ Disposals',
      description: 'Archer May',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.58 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Zach Merrett',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.32 }]
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
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.28 }]
    }]
  };
  let analyzedCandidates = [];

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
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
    }),
    analyzeEvent: ({ candidatePool }) => {
      analyzedCandidates = candidatePool.map((candidate) => candidate.description);

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: candidatePool.slice(0, 2).map((candidate) => ({
          candidateId: candidate.candidateId,
          modelProbability: 0.63,
          rationale: 'Research-cleared AFL disposal leg.'
        })),
        backupLeg: null,
        combinedModelProbability: 0.4,
        supportScore: 7.1,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 1,
        rationale: 'AFL research filter test.',
        notes: 'Rules stub.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(result.generated, 1);
  assert.deepEqual([...analyzedCandidates].sort(), ['Dion Prestia', 'Zach Merrett']);
});

test('runAnalysisJob persists matched ESPN event metadata onto generated picks', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-espn-metadata-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: {
        slates: '',
        picks: '',
        results: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    openai: {
      enabled: false,
      apiKey: '',
      model: 'gpt-5.4'
    },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba',
      enabled: true,
      marketKey: 'nba'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
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
      marketScrape: {}
    },
    tracking: {
      picks: {}
    }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes: parseFeaturedMarketsFromText({
      sportKey: 'nba',
      displayName: 'San Antonio Spurs vs Oklahoma City Thunder',
      startTime,
      sourceUrl: 'https://www.sportsbet.com.au/betting/basketball-us/nba/spurs-v-thunder-1',
      fetchedAt: new Date().toISOString(),
      text: 'San Antonio Spurs Oklahoma City Thunder Head to Head 3.10 1.40 Total Match Points Over (O 215.5) 1.90 Under (U 215.5) 1.90 Shai Gilgeous-Alexander Points Over 29.5 1.90 Under 29.5 1.90'
    })
  };

  await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async () => ({
      events: [{
        id: '401999111',
        homeTeam: 'Oklahoma City Thunder',
        awayTeam: 'San Antonio Spurs',
        startTime,
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
        }
      }]
    }),
    analyzeEvent: ({ candidatePool }) => ({
      qualifies: true,
      recommendation: 'bet',
      selectedLegs: [
        {
          candidateId: candidatePool[0].candidateId,
          modelProbability: 0.64,
          rationale: 'Primary support leg.'
        },
        {
          candidateId: candidatePool[1].candidateId,
          modelProbability: 0.61,
          rationale: 'Secondary support leg.'
        }
      ],
      backupLeg: {
        candidateId: candidatePool[2].candidateId,
        modelProbability: 0.58,
        rationale: 'Backup support leg.'
      },
      combinedModelProbability: 0.39,
      supportScore: 7.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      exceptionalSupport: false,
      strongSupport: false,
      stakeUnits: 1,
      rationale: 'Scraped market test pick.',
      notes: 'Rules stub.',
      checklist: PASSING_CHECKLIST,
      generatedSource: 'rules-generator',
      analysisEngine: 'rules'
    })
  });

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 1);
  assert.equal(savedFeed.picks[0].eventId.startsWith('snapshot:'), true);
  assert.equal(savedFeed.picks[0].espnEventId, '401999111');
  assert.equal(savedFeed.picks[0].homeTeamId, '25');
  assert.equal(savedFeed.picks[0].awayTeamId, '24');
  assert.deepEqual(savedFeed.picks[0].venue, {
    id: '1',
    name: 'Paycom Center',
    city: 'Oklahoma City',
    state: 'OK',
    country: 'United States',
    indoor: true,
    roofType: 'Arena'
  });
});

test('runAnalysisJob retries the previous official ESPN date for NBA event metadata', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-espn-date-fallback-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: {
        slates: '',
        picks: '',
        results: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    openai: {
      enabled: false,
      apiKey: '',
      model: 'gpt-5.4'
    },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'nba',
      label: 'NBA',
      provider: 'espn',
      path: 'basketball/nba',
      enabled: true,
      marketKey: 'nba'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
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
      marketScrape: {}
    },
    tracking: {
      picks: {}
    }
  };
  const startTime = '2026-05-26T00:10:00.000Z';
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'nba',
      homeTeam: 'Cleveland Cavaliers',
      awayTeam: 'New York Knicks',
      displayName: 'New York Knicks vs Cleveland Cavaliers',
      startTime,
      market: 'player_assists',
      outcomeName: '4+ Assists',
      description: 'Donovan Mitchell',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.55 }]
    }, {
      sportKey: 'nba',
      homeTeam: 'Cleveland Cavaliers',
      awayTeam: 'New York Knicks',
      displayName: 'New York Knicks vs Cleveland Cavaliers',
      startTime,
      market: 'player_assists',
      outcomeName: '4+ Assists',
      description: 'Jalen Brunson',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.57 }]
    }, {
      sportKey: 'nba',
      homeTeam: 'Cleveland Cavaliers',
      awayTeam: 'New York Knicks',
      displayName: 'New York Knicks vs Cleveland Cavaliers',
      startTime,
      market: 'player_rebounds',
      outcomeName: '8+ Rebounds',
      description: 'Josh Hart',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.62 }]
    }]
  };
  const fetchDateKeys = [];

  await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async (_sport, dateKey) => {
      fetchDateKeys.push(dateKey);

      if (dateKey === '2026-05-25') {
        return {
          events: [{
            id: '401999222',
            homeTeam: 'Cleveland Cavaliers',
            awayTeam: 'New York Knicks',
            startTime: '2026-05-26T00:00:00.000Z',
            homeTeamId: '5',
            awayTeamId: '18',
            venue: {
              id: '2',
              name: 'Rocket Arena',
              city: 'Cleveland',
              state: 'OH',
              country: 'United States',
              indoor: true,
              roofType: 'Arena'
            }
          }]
        };
      }

      return { events: [] };
    },
    analyzeEvent: ({ candidatePool }) => ({
      qualifies: true,
      recommendation: 'bet',
      selectedLegs: [
        {
          candidateId: candidatePool[0].candidateId,
          modelProbability: 0.64,
          rationale: 'Primary support leg.'
        },
        {
          candidateId: candidatePool[1].candidateId,
          modelProbability: 0.61,
          rationale: 'Secondary support leg.'
        }
      ],
      backupLeg: {
        candidateId: candidatePool[2].candidateId,
        modelProbability: 0.58,
        rationale: 'Backup support leg.'
      },
      combinedModelProbability: 0.39,
      supportScore: 7.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      exceptionalSupport: false,
      strongSupport: false,
      stakeUnits: 1,
      rationale: 'Scraped market test pick.',
      notes: 'Rules stub.',
      checklist: PASSING_CHECKLIST,
      generatedSource: 'rules-generator',
      analysisEngine: 'rules'
    })
  });

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.deepEqual(fetchDateKeys, ['2026-05-26', '2026-05-25']);
  assert.equal(savedFeed.picks.length, 1);
  assert.equal(savedFeed.picks[0].espnEventId, '401999222');
  assert.equal(savedFeed.picks[0].homeTeamId, '5');
  assert.equal(savedFeed.picks[0].awayTeamId, '18');
  assert.deepEqual(savedFeed.picks[0].venue, {
    id: '2',
    name: 'Rocket Arena',
    city: 'Cleveland',
    state: 'OH',
    country: 'United States',
    indoor: true,
    roofType: 'Arena'
  });
});

test('runAnalysisJob merges against an existing generated pick feed without crashing', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-merge-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({
    picks: [{
      id: 'auto-generator:afl:existing',
      source: 'auto-generator',
      status: 'pending',
      sport: 'afl',
      event: 'Old Event',
      startTime: '2026-05-21T00:00:00.000Z',
      legs: []
    }]
  }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: {
        slates: '',
        picks: '',
        results: ''
      },
      roleMentions: {
        enabled: false,
        channels: []
      }
    },
    openai: {
      enabled: false,
      apiKey: '',
      model: 'gpt-5.4'
    },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 5,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'afl',
      label: 'AFL',
      enabled: true,
      marketKey: 'afl'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
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
      marketScrape: {}
    },
    tracking: {
      picks: {}
    }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'James Worpel',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.38 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Jordan Dawson',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.42 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_goals',
      outcomeName: '1+ Goal',
      description: 'Mabior Chol',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.56 }]
    }]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    analyzeEvent: ({ candidatePool }) => ({
      qualifies: true,
      recommendation: 'bet',
      selectedLegs: [
        {
          candidateId: candidatePool[0].candidateId,
          modelProbability: 0.64,
          rationale: 'Primary support leg.'
        },
        {
          candidateId: candidatePool[1].candidateId,
          modelProbability: 0.61,
          rationale: 'Secondary support leg.'
        }
      ],
      backupLeg: {
        candidateId: candidatePool[2].candidateId,
        modelProbability: 0.58,
        rationale: 'Backup support leg.'
      },
      combinedModelProbability: 0.39,
      supportScore: 7.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      exceptionalSupport: false,
      strongSupport: false,
      stakeUnits: 1,
      rationale: 'Scraped market test pick.',
      notes: 'Rules stub.',
      checklist: PASSING_CHECKLIST,
      generatedSource: 'rules-generator',
      analysisEngine: 'rules'
    })
  });

  assert.equal(result.generated, 1);

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 1);
  assert.notEqual(savedFeed.picks[0].id, 'auto-generator:afl:existing');
  assert.equal(savedFeed.picks[0].source, 'rules-generator');
});

test('runAnalysisJob passes live available units from the bankroll tracker summary into analysis', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-bankroll-context-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 2,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{ key: 'afl', label: 'AFL', enabled: true, marketKey: 'afl' }],
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      unitSizeAud: 10,
      startingBankrollUnits: 10,
      settlementWebhook: 'unitTracking',
      summaryWebhook: 'unitReport',
      summaryTime: '07:45',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
    },
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json'),
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();

  await appendPostedTrackerEntries(config, [{
    id: 'existing-open-position',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Existing AFL Event',
    startTime,
    summary: 'Existing position',
    stakeUnits: 1,
    source: 'manual',
    totalOdds: 1.9,
    legs: [{ label: 'Existing leg' }]
  }], new Date().toISOString());

  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'James Worpel',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.38 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Jordan Dawson',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.42 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_goals',
      outcomeName: '1+ Goal',
      description: 'Mabior Chol',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.56 }]
    }]
  };
  let capturedBankrollContext = null;

  await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    analyzeEvent: ({ candidatePool, bankrollContext }) => {
      capturedBankrollContext = bankrollContext;

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: [
          {
            candidateId: candidatePool[0].candidateId,
            modelProbability: 0.64,
            rationale: 'Primary support leg.'
          },
          {
            candidateId: candidatePool[1].candidateId,
            modelProbability: 0.61,
            rationale: 'Secondary support leg.'
          }
        ],
        backupLeg: null,
        combinedModelProbability: 0.39,
        supportScore: 7.2,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 2,
        rationale: 'Tracker bankroll test pick.',
        notes: 'Rules stub.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(capturedBankrollContext?.availableUnits, 9);
});

test('runAnalysisJob uses bankroll context for sizing without suppressing later events', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-shared-bankroll-budget-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  const bankrollTrackerFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-bankroll-tracker.csv');
  const losingLegsReportFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bot-losing-legs-report.md');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 2,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{ key: 'afl', label: 'AFL', enabled: true, marketKey: 'afl' }],
    bankrollTracker: {
      enabled: true,
      csvFile: bankrollTrackerFile,
      unitSizeAud: 10,
      startingBankrollUnits: 5,
      settlementWebhook: 'unitTracking',
      summaryWebhook: 'unitReport',
      summaryTime: '07:45',
      rollingWindowDays: 30,
      repeatLossThreshold: 2,
      losingLegsReportFile
    },
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json'),
      bankrollTrackerFile,
      losingLegsReportFile
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const firstStartTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const secondStartTime = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();

  await appendPostedTrackerEntries(config, [{
    id: 'existing-open-position',
    sport: 'afl',
    sportLabel: 'AFL',
    event: 'Existing AFL Event',
    startTime: firstStartTime,
    summary: 'Existing position',
    stakeUnits: 2,
    source: 'manual',
    totalOdds: 1.9,
    legs: [{ label: 'Existing leg' }]
  }], new Date().toISOString());

  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [
      {
        sportKey: 'afl',
        homeTeam: 'Hawthorn',
        awayTeam: 'Adelaide Crows',
        displayName: 'Hawthorn vs Adelaide Crows',
        startTime: firstStartTime,
        market: 'player_disposals',
        outcomeName: '15+ Disposals',
        description: 'James Worpel',
        point: null,
        fetchedAt,
        source: 'snapshot',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.38 }]
      },
      {
        sportKey: 'afl',
        homeTeam: 'Hawthorn',
        awayTeam: 'Adelaide Crows',
        displayName: 'Hawthorn vs Adelaide Crows',
        startTime: firstStartTime,
        market: 'player_disposals',
        outcomeName: '15+ Disposals',
        description: 'Jordan Dawson',
        point: null,
        fetchedAt,
        source: 'snapshot',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.42 }]
      },
      {
        sportKey: 'afl',
        homeTeam: 'Hawthorn',
        awayTeam: 'Adelaide Crows',
        displayName: 'Hawthorn vs Adelaide Crows',
        startTime: firstStartTime,
        market: 'player_goals',
        outcomeName: '1+ Goal',
        description: 'Mabior Chol',
        point: null,
        fetchedAt,
        source: 'snapshot',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.56 }]
      },
      {
        sportKey: 'afl',
        homeTeam: 'Richmond',
        awayTeam: 'Essendon',
        displayName: 'Richmond vs Essendon',
        startTime: secondStartTime,
        market: 'player_disposals',
        outcomeName: '15+ Disposals',
        description: 'Zach Merrett',
        point: null,
        fetchedAt,
        source: 'snapshot',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.32 }]
      },
      {
        sportKey: 'afl',
        homeTeam: 'Richmond',
        awayTeam: 'Essendon',
        displayName: 'Richmond vs Essendon',
        startTime: secondStartTime,
        market: 'player_disposals',
        outcomeName: '15+ Disposals',
        description: 'Dion Prestia',
        point: null,
        fetchedAt,
        source: 'snapshot',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.28 }]
      },
      {
        sportKey: 'afl',
        homeTeam: 'Richmond',
        awayTeam: 'Essendon',
        displayName: 'Richmond vs Essendon',
        startTime: secondStartTime,
        market: 'player_goals',
        outcomeName: '1+ Goal',
        description: 'Sam Durham',
        point: null,
        fetchedAt,
        source: 'snapshot',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.54 }]
      }
    ]
  };
  const capturedAvailableUnits = [];

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    analyzeEvent: ({ candidatePool, bankrollContext }) => {
      capturedAvailableUnits.push(bankrollContext?.availableUnits);

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: [
          {
            candidateId: candidatePool[0].candidateId,
            modelProbability: 0.64,
            rationale: 'Primary support leg.'
          },
          {
            candidateId: candidatePool[1].candidateId,
            modelProbability: 0.61,
            rationale: 'Secondary support leg.'
          }
        ],
        backupLeg: null,
        combinedModelProbability: 0.39,
        supportScore: 7.2,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 2,
        rationale: 'Shared bankroll budget test pick.',
        notes: 'Rules stub.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(result.generated, 2);
  assert.deepEqual(capturedAvailableUnits, [3, 3]);

  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 2);
  assert.equal(savedFeed.picks[0].stakeUnits, 2);
  assert.equal(savedFeed.picks[1].stakeUnits, 2);
});

test('runAnalysisJob skips a 2-candidate NRL event because the safe NRL pool is too thin to analyze', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-nrl-two-leg-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 2,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{ key: 'nrl', label: 'NRL', enabled: true, marketKey: 'nrl' }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const snapshot = {
    updatedAt: new Date().toISOString(),
    quotes: [
      {
        sportKey: 'nrl',
        homeTeam: 'St George Illawarra Dragons',
        awayTeam: 'New Zealand Warriors',
        displayName: 'St George Illawarra Dragons vs New Zealand Warriors',
        startTime,
        market: 'totals',
        outcomeName: 'Over',
        point: 42.5,
        fetchedAt: new Date().toISOString(),
        source: 'web-scrape',
        sourceUrl: 'https://example.test/nrl-event',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.9 }]
      },
      {
        sportKey: 'nrl',
        homeTeam: 'St George Illawarra Dragons',
        awayTeam: 'New Zealand Warriors',
        displayName: 'St George Illawarra Dragons vs New Zealand Warriors',
        startTime,
        market: 'spreads',
        outcomeName: 'New Zealand Warriors',
        point: 5.5,
        fetchedAt: new Date().toISOString(),
        source: 'web-scrape',
        sourceUrl: 'https://example.test/nrl-event',
        prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.9 }]
      }
    ]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    analyzeEvent: () => {
      throw new Error('NRL thin-pool event should be skipped before analysis is invoked');
    }
  });

  assert.equal(result.generated, 0);
  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 0);
});

test('runAnalysisJob allows a 2-leg AFL build when two clean disposal legs are available', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-afl-weekend-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 2,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{ key: 'afl', label: 'AFL', enabled: true, marketKey: 'afl' }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const startTime = new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'James Worpel',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.38 }]
    }, {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Jordan Dawson',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.42 }]
    }]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    analyzeEvent: ({ candidatePool }) => ({
      qualifies: true,
      recommendation: 'bet',
      selectedLegs: [
        {
          candidateId: candidatePool[0].candidateId,
          modelProbability: 0.64,
          rationale: 'Primary support leg.'
        },
        {
          candidateId: candidatePool[1].candidateId,
          modelProbability: 0.61,
          rationale: 'Secondary support leg.'
        }
      ],
      backupLeg: null,
      combinedModelProbability: 0.39,
      supportScore: 7.2,
      confidenceTier: 'medium',
      supportProjection: 'moderate',
      dataConfidence: 'medium',
      correlationRisk: 'low',
      correlationJustified: true,
      exceptionalSupport: false,
      strongSupport: false,
      stakeUnits: 2,
      rationale: 'Weekend AFL structure test.',
      notes: 'Rules stub.',
      checklist: PASSING_CHECKLIST,
      generatedSource: 'rules-generator',
      analysisEngine: 'rules'
    })
  });

  assert.equal(result.generated, 1);
  const savedFeed = JSON.parse(await fs.readFile(picksFeedFile, 'utf8'));
  assert.equal(savedFeed.picks.length, 1);
  assert.equal(savedFeed.picks[0].legs.length, 2);
});

test('analyzeEventWithRules prefers 3-leg disposal-heavy AFL combos over totals and H2H fallbacks', async () => {
  const startTime = '2026-05-23T09:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'afl',
    sportLabel: 'AFL',
    marketSportKey: 'afl',
    eventId: 'snapshot:afl:richmond-vs-essendon',
    eventName: 'Richmond vs Essendon',
    homeTeam: 'Richmond',
    awayTeam: 'Essendon',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Zach Merrett',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.25 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Dion Prestia',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.22 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Tim Taranto',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.28 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Darcy Parish',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.3 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'player_goals',
      outcomeName: '1+ Goal',
      description: 'Archer Day-Wicks',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.8 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'totals',
      outcomeName: 'Over',
      description: '',
      point: 168.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.9 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Richmond',
      awayTeam: 'Essendon',
      displayName: 'Richmond vs Essendon',
      startTime,
      market: 'h2h',
      outcomeName: 'Essendon',
      description: '',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.72 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  assert.ok(pick);

  const disposalLegs = pick.legs.filter((leg) => /disposals?/i.test(leg.label));
  const goalLegs = pick.legs.filter((leg) => /goals?/i.test(leg.label));
  const sideOrTotalLegs = pick.legs.filter((leg) => /head to head|h2h|over|under/i.test(leg.label));

  assert.equal(pick.legs.length, 3);
  assert.equal(disposalLegs.length, 3);
  assert.equal(goalLegs.length, 0);
  assert.equal(sideOrTotalLegs.length, 0);
});

test('buildAnalysisCandidatePool keeps deeper AFL-safe disposal legs after filtering', () => {
  const startTime = '2026-05-30T03:15:44.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'afl',
    sportLabel: 'AFL',
    marketSportKey: 'afl',
    eventId: 'snapshot:afl:sydney-swans-vs-richmond',
    eventName: 'Sydney Swans vs Richmond',
    homeTeam: 'Sydney Swans',
    awayTeam: 'Richmond',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const makeQuote = (description, line, price) => ({
    sportKey: 'afl',
    homeTeam: 'Sydney Swans',
    awayTeam: 'Richmond',
    displayName: 'Sydney Swans vs Richmond',
    startTime,
    market: 'player_disposals',
    outcomeName: `${line}+ Disposals`,
    description,
    point: null,
    fetchedAt,
    source: 'snapshot',
    prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price }]
  });
  const frontLoadedPlayers = ['Charlie Curnow', 'Harry Cunningham'];
  const deeperSafePlayers = [
    'James Rowbottom',
    'James Trezise',
    'Lewis Melican',
    'Luke Trainor',
    'Nathan Broad',
    'Nick Vlastuin'
  ];
  const quotes = [
    ...frontLoadedPlayers.flatMap((player, playerIndex) => [10, 11, 12, 13, 14, 16, 17].map((line, lineIndex) => makeQuote(
      player,
      line,
      1.03 + (playerIndex * 0.02) + (lineIndex * 0.01)
    ))),
    ...deeperSafePlayers.map((player, index) => makeQuote(player, 15, 1.28 + (index * 0.03)))
  ];

  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);

  assert.ok(candidatePool.length >= 8);
  assert.ok(candidatePool.some((candidate) => candidate.label === 'James Rowbottom 15+ Disposals'));
  assert.ok(candidatePool.some((candidate) => candidate.label === 'Nick Vlastuin 15+ Disposals'));
  assert.ok(candidatePool.every((candidate) => !/\b(11|12|13|14|16|17)\+ Disposals\b/.test(candidate.label)));
});

test('buildAnalysisCandidatePool keeps supported AFL 20+ and 25+ disposal ladders ahead of low-rung filler', () => {
  const startTime = '2026-05-30T03:15:44.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'afl',
    sportLabel: 'AFL',
    marketSportKey: 'afl',
    eventId: 'snapshot:afl:hawks-vs-cats-high-volume',
    eventName: 'Hawthorn vs Geelong Cats',
    homeTeam: 'Hawthorn',
    awayTeam: 'Geelong Cats',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const makeQuote = (description, line, price) => ({
    sportKey: 'afl',
    homeTeam: 'Hawthorn',
    awayTeam: 'Geelong Cats',
    displayName: 'Hawthorn vs Geelong Cats',
    startTime,
    market: 'player_disposals',
    outcomeName: `${line}+ Disposals`,
    description,
    point: null,
    fetchedAt,
    source: 'snapshot',
    prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price }]
  });

  const fillerQuotes = [
    makeQuote('Fringe Winger 1', 10, 1.19),
    makeQuote('Fringe Winger 2', 10, 1.22),
    makeQuote('Depth Mid 1', 10, 1.24),
    makeQuote('Depth Mid 2', 10, 1.28),
    makeQuote('Pocket Runner 1', 10, 1.31),
    makeQuote('Pocket Runner 2', 10, 1.34)
  ];
  const stableFifteenQuotes = [
    makeQuote('James Worpel', 15, 1.34),
    makeQuote('Massimo D\'Ambrosio', 15, 1.31),
    makeQuote('Jordan Clark', 15, 1.38),
    makeQuote('Tom Stewart', 15, 1.36)
  ];
  const highVolumeQuotes = [
    makeQuote('Jordan Dawson', 20, 1.58),
    makeQuote('Zak Butters', 20, 1.63),
    makeQuote('Caleb Serong', 25, 1.82),
    makeQuote('Lachie Neale', 25, 1.9),
    makeQuote('Nick Daicos', 30, 1.92)
  ];

  const candidatePool = buildAnalysisCandidatePool(eventContext, [
    ...fillerQuotes,
    ...stableFifteenQuotes,
    ...highVolumeQuotes
  ], 7);

  assert.ok(candidatePool.some((candidate) => candidate.label === 'Jordan Dawson 20+ Disposals'));
  assert.ok(candidatePool.some((candidate) => candidate.label === 'Zak Butters 20+ Disposals'));
  assert.ok(candidatePool.some((candidate) => candidate.label === 'Caleb Serong 25+ Disposals'));
  assert.ok(candidatePool.some((candidate) => candidate.label === 'Lachie Neale 25+ Disposals'));
  assert.equal(candidatePool.some((candidate) => candidate.label === 'Nick Daicos 30+ Disposals'), false);
  assert.equal(candidatePool.some((candidate) => /Fringe Winger|Depth Mid|Pocket Runner/.test(candidate.label)), false);
});

test('buildAnalysisCandidatePool (v3) keeps the MLB favourite moneyline and +1.5 run line and drops props/totals', () => {
  const startTime = '2026-05-30T23:11:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'mlb',
    sportLabel: 'MLB',
    marketSportKey: 'mlb',
    eventId: 'snapshot:mlb:angels-vs-rays',
    eventName: 'Los Angeles Angels vs Tampa Bay Rays',
    homeTeam: 'Tampa Bay Rays',
    awayTeam: 'Los Angeles Angels',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const base = {
    sportKey: 'mlb',
    homeTeam: 'Tampa Bay Rays',
    awayTeam: 'Los Angeles Angels',
    displayName: 'Los Angeles Angels vs Tampa Bay Rays',
    startTime,
    fetchedAt,
    source: 'snapshot'
  };
  const px = (price) => [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price }];
  const quotes = [
    { ...base, market: 'h2h', outcomeName: 'Tampa Bay Rays', description: '', point: null, prices: px(1.55) },
    { ...base, market: 'h2h', outcomeName: 'Los Angeles Angels', description: '', point: null, prices: px(2.45) },
    { ...base, market: 'spreads', outcomeName: 'Tampa Bay Rays', description: '', point: -1.5, prices: px(2.5) },
    { ...base, market: 'spreads', outcomeName: 'Los Angeles Angels', description: '', point: 1.5, prices: px(1.52) },
    { ...base, market: 'totals', outcomeName: 'Over', description: '', point: 8.5, prices: px(1.9) },
    { ...base, market: 'batter_hits', outcomeName: '1+ Hit', description: 'Yandy Diaz', point: null, prices: px(1.4) }
  ];

  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);

  // Favourite moneyline (≤1.65) kept; underdog moneyline (2.45) dropped.
  const isH2h = (c) => String(c.market).toLowerCase() === 'h2h';
  assert.ok(candidatePool.some((c) => isH2h(c) && /Tampa Bay Rays/.test(c.label)));
  assert.equal(candidatePool.some((c) => isH2h(c) && /Los Angeles Angels/.test(c.label)), false);
  // Protected +1.5 run line kept; the -1.5 favourite line dropped.
  assert.ok(candidatePool.some((c) => Number(c.point) === 1.5));
  assert.equal(candidatePool.some((c) => Number(c.point) === -1.5), false);
  // Props and totals are not part of the v3 featured-single pool.
  assert.equal(candidatePool.some((c) => c.family === 'prop'), false);
  assert.equal(candidatePool.some((c) => c.family === 'total'), false);
});

test('buildPickFromAnalysisDecision adds two AFL bonus disposal options without changing the main slip', async () => {
  const startTime = '2026-05-23T09:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'afl',
    sportLabel: 'AFL',
    marketSportKey: 'afl',
    eventId: 'snapshot:afl:hawks-vs-crows-bonus-options',
    eventName: 'Hawthorn vs Adelaide Crows',
    homeTeam: 'Hawthorn',
    awayTeam: 'Adelaide Crows',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'James Worpel',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.28 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Jordan Dawson',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.31 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Massimo D\'Ambrosio',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.33 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Connor Macdonald',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.35 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Hawthorn',
      awayTeam: 'Adelaide Crows',
      displayName: 'Hawthorn vs Adelaide Crows',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Matt Crouch',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.37 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);
  const selectedLabels = new Set(pick.legs.map((leg) => leg.label));

  assert.equal(decision.qualifies, true);
  assert.ok(pick);
  assert.equal(pick.betType, 'sgm');
  assert.equal(pick.legs.length, 3);
  assert.equal(pick.bonusLegOptions.length, 2);
  assert.ok(pick.bonusLegOptions.every((leg) => /disposals?/i.test(leg.label)));
  assert.ok(pick.bonusLegOptions.every((leg) => !selectedLabels.has(leg.label)));
});

test('buildPickFromAnalysisDecision persists event weather metadata onto generated picks', () => {
  const startTime = '2026-05-23T19:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'soccer_uefa_champs_league',
    sportLabel: 'Soccer / UCL',
    marketSportKey: 'soccer_uefa_champs_league',
    eventId: 'snapshot:ucl:weather-persistence',
    eventName: 'Real Madrid vs Inter Milan',
    homeTeam: 'Real Madrid',
    awayTeam: 'Inter Milan',
    startTime,
    weather: {
      summary: 'Clear',
      details: '18C | Wind 14 km/h'
    },
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const candidatePool = buildAnalysisCandidatePool(eventContext, [{
    sportKey: 'soccer_uefa_champs_league',
    homeTeam: 'Real Madrid',
    awayTeam: 'Inter Milan',
    displayName: 'Real Madrid vs Inter Milan',
    startTime,
    market: 'totals',
    outcomeName: 'Under',
    description: '',
    point: 2.5,
    fetchedAt,
    source: 'snapshot',
    prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.97 }]
  }, {
    sportKey: 'soccer_uefa_champs_league',
    homeTeam: 'Real Madrid',
    awayTeam: 'Inter Milan',
    displayName: 'Real Madrid vs Inter Milan',
    startTime,
    market: 'totals',
    outcomeName: 'Over',
    description: '',
    point: 2.5,
    fetchedAt,
    source: 'snapshot',
    prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.83 }]
  }], 14);
  const decision = {
    qualifies: true,
    recommendation: 'bet',
    selectedLegs: [{
      candidateId: candidatePool[0].candidateId,
      modelProbability: 0.61,
      rationale: 'Primary totals leg.'
    }, {
      candidateId: candidatePool[1].candidateId,
      modelProbability: 0.58,
      rationale: 'Secondary totals leg.'
    }],
    backupLeg: null,
    combinedModelProbability: 0.35,
    supportScore: 6.1,
    confidenceTier: 'medium',
    supportProjection: 'moderate',
    dataConfidence: 'medium',
    correlationRisk: 'low',
    correlationJustified: true,
    exceptionalSupport: false,
    strongSupport: false,
    stakeUnits: 1,
    rationale: 'Weather persistence test.',
    notes: 'Carry event weather into the generated pick payload.',
    checklist: PASSING_CHECKLIST,
    generatedSource: 'rules-generator',
    analysisEngine: 'rules'
  };

  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  assert.ok(pick);
  assert.deepEqual(pick.weather, eventContext.weather);
});

test('buildPickFromAnalysisDecision rejects single-leg AFL decisions because AFL is same-game-multi only', () => {
  const startTime = '2026-05-23T09:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'afl',
    sportLabel: 'AFL',
    marketSportKey: 'afl',
    eventId: 'snapshot:afl:single-leg-guard',
    eventName: 'Carlton vs Collingwood',
    homeTeam: 'Carlton',
    awayTeam: 'Collingwood',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const candidatePool = buildAnalysisCandidatePool(eventContext, [{
    sportKey: 'afl',
    homeTeam: 'Carlton',
    awayTeam: 'Collingwood',
    displayName: 'Carlton vs Collingwood',
    startTime,
    market: 'player_disposals',
    outcomeName: '20+ Disposals',
    description: 'Sam Walsh',
    point: null,
    fetchedAt,
    source: 'snapshot',
    prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.34 }]
  }], 14);
  const decision = {
    qualifies: true,
    recommendation: 'build_single',
    summary: 'Single-leg AFL test',
    rationale: 'Should not serialize as a pick.',
    noBetReason: null,
    confidenceTier: 'medium',
    supportProjection: 'moderate',
    dataConfidence: 'high',
    correlationRisk: 'low',
    correlationJustified: true,
    exceptionalSupport: false,
    strongSupport: false,
    combinedModelProbability: 0.71,
    supportScore: 7.2,
    stakeUnits: 1,
    checklist: PASSING_CHECKLIST,
    selectedLegs: [{
      candidateId: candidatePool[0].candidateId,
      modelProbability: 0.71,
      rationale: 'Clean disposal leg.'
    }],
    backupLeg: null,
    notes: ''
  };

  assert.equal(buildPickFromAnalysisDecision(eventContext, candidatePool, decision), null);
});

test('analyzeEventWithRules rejects long-odds AFL combos when a safer build is available', async () => {
  const startTime = '2026-05-23T09:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'afl',
    sportLabel: 'AFL',
    marketSportKey: 'afl',
    eventId: 'snapshot:afl:north-vs-suns',
    eventName: 'North Melbourne vs Gold Coast Suns',
    homeTeam: 'North Melbourne',
    awayTeam: 'Gold Coast Suns',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '20+ Disposals',
      description: 'Touk Miller',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.62 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '20+ Disposals',
      description: 'Noah Anderson',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.58 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Harry Sheezel',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.72 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '20+ Disposals',
      description: 'Ben Ainsworth',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 2.48 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });

  assert.equal(decision.qualifies, true);

  const selectedCandidates = decision.selectedLegs
    .map((leg) => candidatePool.find((candidate) => candidate.candidateId === leg.candidateId))
    .filter(Boolean);
  const selectedOdds = selectedCandidates.reduce((product, candidate) => product * Number(candidate.bestPrice), 1);

  assert.ok(selectedCandidates.length >= 2);
  assert.ok(selectedCandidates.length <= 3);
  assert.ok(selectedOdds <= 3.25);
  assert.ok(selectedCandidates.every((candidate) => candidate.market === 'player_disposals'));
  assert.ok(selectedCandidates.every((candidate) => Number(candidate.bestPrice) <= 2.05));
});

test('analyzeEventWithRules prefers AFL disposal combos that land near x2 total odds', async () => {
  const startTime = '2026-05-23T09:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'afl',
    sportLabel: 'AFL',
    marketSportKey: 'afl',
    eventId: 'snapshot:afl:fremantle-vs-st-kilda',
    eventName: 'Fremantle vs ST Kilda',
    homeTeam: 'Fremantle',
    awayTeam: 'ST Kilda',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'afl',
      homeTeam: 'Fremantle',
      awayTeam: 'ST Kilda',
      displayName: 'Fremantle vs ST Kilda',
      startTime,
      market: 'player_disposals',
      outcomeName: '20+ Disposals',
      description: 'Andrew Brayshaw',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.32 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Fremantle',
      awayTeam: 'ST Kilda',
      displayName: 'Fremantle vs ST Kilda',
      startTime,
      market: 'player_disposals',
      outcomeName: '20+ Disposals',
      description: 'Luke Ryan',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.34 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Fremantle',
      awayTeam: 'ST Kilda',
      displayName: 'Fremantle vs ST Kilda',
      startTime,
      market: 'player_disposals',
      outcomeName: '25+ Disposals',
      description: 'Jack Sinclair',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.16 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'Fremantle',
      awayTeam: 'ST Kilda',
      displayName: 'Fremantle vs ST Kilda',
      startTime,
      market: 'player_disposals',
      outcomeName: '25+ Disposals',
      description: 'Caleb Serong',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.72 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);
  const selectedCandidates = decision.selectedLegs
    .map((leg) => candidatePool.find((candidate) => candidate.candidateId === leg.candidateId))
    .filter(Boolean);
  const selectedNames = selectedCandidates.map((candidate) => candidate.description).sort();
  const selectedOdds = selectedCandidates.reduce((product, candidate) => product * Number(candidate.bestPrice), 1);

  assert.equal(decision.qualifies, true);
  assert.equal(pick?.stakeUnits, 1);
  assert.deepEqual(selectedNames, ['Andrew Brayshaw', 'Jack Sinclair', 'Luke Ryan']);
  assert.ok(selectedOdds >= 1.9 && selectedOdds <= 2.35);
});

test('buildAnalysisCandidatePool rejects off-step AFL disposal ladders outside 10 or 15 or 20 style intervals', () => {
  const startTime = '2026-05-23T09:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'afl',
    sportLabel: 'AFL',
    marketSportKey: 'afl',
    eventId: 'snapshot:afl:off-step-disposals',
    eventName: 'North Melbourne vs Gold Coast Suns',
    homeTeam: 'North Melbourne',
    awayTeam: 'Gold Coast Suns',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '10+ Disposals',
      description: 'Harry Sheezel',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.42 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '11+ Disposals',
      description: 'Luke Davies-Uniacke',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.38 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '15+ Disposals',
      description: 'Noah Anderson',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.55 }]
    },
    {
      sportKey: 'afl',
      homeTeam: 'North Melbourne',
      awayTeam: 'Gold Coast Suns',
      displayName: 'North Melbourne vs Gold Coast Suns',
      startTime,
      market: 'player_disposals',
      outcomeName: '14+ Disposals',
      description: 'Touk Miller',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.49 }]
    }
  ];

  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const outcomeNames = candidatePool.map((candidate) => candidate.outcomeName).sort();

  assert.deepEqual(outcomeNames, ['10+ Disposals', '15+ Disposals']);
});

test('analyzeEventWithRules (v3) returns no_bet for MLB when only late props and totals are available', async () => {
  const startTime = '2026-05-23T17:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'mlb',
    sportLabel: 'MLB',
    marketSportKey: 'mlb',
    eventId: 'snapshot:mlb:yankees-vs-rays',
    eventName: 'Tampa Bay Rays vs New York Yankees',
    homeTeam: 'New York Yankees',
    awayTeam: 'Tampa Bay Rays',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      displayName: 'Tampa Bay Rays vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hit',
      description: 'Aaron Judge',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.52 }]
    },
    {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      displayName: 'Tampa Bay Rays vs New York Yankees',
      startTime,
      market: 'totals',
      outcomeName: 'Over',
      description: '',
      point: 8.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.68 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);
  assert.equal(decision.qualifies, false);
  assert.equal(decision.recommendation, 'no_bet');
  assert.equal(pick, null);
  assert.match(decision.noBetReason, /favourite moneyline|\+1\.5 run.?line|market-backed candidates/i);
});

test('analyzeEventWithRules keeps legacy MLB rebuilds on the old hit-led structure', async () => {
  const startTime = '2026-05-23T17:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'mlb',
    sportLabel: 'MLB',
    marketSportKey: 'mlb',
    eventId: 'snapshot:mlb:yankees-vs-rays-legacy',
    eventName: 'Tampa Bay Rays vs New York Yankees',
    homeTeam: 'New York Yankees',
    awayTeam: 'Tampa Bay Rays',
    startTime,
    mlbStructureProfile: 'mlb-hit-led-v1',
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      displayName: 'Tampa Bay Rays vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hit',
      description: 'Aaron Judge',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.52 }]
    },
    {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      displayName: 'Tampa Bay Rays vs New York Yankees',
      startTime,
      market: 'pitcher_strikeouts',
      outcomeName: 'Over',
      description: 'Drew Rasmussen',
      point: 4.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.64 }]
    },
    {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Tampa Bay Rays',
      displayName: 'Tampa Bay Rays vs New York Yankees',
      startTime,
      market: 'totals',
      outcomeName: 'Over',
      description: '',
      point: 8.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.68 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });

  assert.equal(decision.qualifies, false);
  assert.equal(decision.recommendation, 'no_bet');
  assert.match(decision.noBetReason, /at least two clean hit props/i);
});

test('analyzeEventWithRules (v3) posts a single MLB favourite-moneyline leg and ignores props/totals', async () => {
  const startTime = '2026-05-23T19:05:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'mlb',
    sportLabel: 'MLB',
    marketSportKey: 'mlb',
    eventId: 'snapshot:mlb:phillies-vs-guardians',
    eventName: 'Philadelphia Phillies vs Cleveland Guardians',
    homeTeam: 'Cleveland Guardians',
    awayTeam: 'Philadelphia Phillies',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const base = {
    sportKey: 'mlb',
    homeTeam: 'Cleveland Guardians',
    awayTeam: 'Philadelphia Phillies',
    displayName: 'Philadelphia Phillies vs Cleveland Guardians',
    startTime,
    fetchedAt,
    source: 'snapshot'
  };
  const px = (price) => [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price }];
  const quotes = [
    { ...base, market: 'h2h', outcomeName: 'Cleveland Guardians', description: '', point: null, prices: px(1.58) },
    { ...base, market: 'h2h', outcomeName: 'Philadelphia Phillies', description: '', point: null, prices: px(2.4) },
    { ...base, market: 'totals', outcomeName: 'Over', description: '', point: 8.5, prices: px(1.41) },
    { ...base, market: 'batter_hits', outcomeName: '1+ Hit', description: 'Jose Ramirez', point: null, prices: px(1.44) }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  assert.equal(decision.qualifies, true);
  assert.equal(decision.recommendation, 'build_single');
  assert.ok(pick);
  assert.equal(pick.mlbStructureProfile, 'mlb-featured-single-v3');
  assert.equal(pick.legs.length, 1);
  assert.match(pick.legs[0].label, /Cleveland Guardians/);
  assert.ok(pick.legs.every((leg) => leg.source?.family !== 'prop' && leg.source?.family !== 'total'));
});

test('analyzeEventWithRules (v3) posts a single MLB +1.5 run line when no moneyline favourite qualifies', async () => {
  const startTime = '2026-05-23T20:10:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'mlb',
    sportLabel: 'MLB',
    marketSportKey: 'mlb',
    eventId: 'snapshot:mlb:mets-vs-dodgers',
    eventName: 'Los Angeles Dodgers vs New York Mets',
    homeTeam: 'New York Mets',
    awayTeam: 'Los Angeles Dodgers',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const base = {
    sportKey: 'mlb',
    homeTeam: 'New York Mets',
    awayTeam: 'Los Angeles Dodgers',
    displayName: 'Los Angeles Dodgers vs New York Mets',
    startTime,
    fetchedAt,
    source: 'snapshot'
  };
  const px = (price) => [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price }];
  const quotes = [
    // Near-even game: neither moneyline is ≤1.65, so the protected +1.5 is the only qualifying single.
    { ...base, market: 'h2h', outcomeName: 'New York Mets', description: '', point: null, prices: px(1.8) },
    { ...base, market: 'h2h', outcomeName: 'Los Angeles Dodgers', description: '', point: null, prices: px(2.05) },
    { ...base, market: 'spreads', outcomeName: 'New York Mets', description: '', point: -1.5, prices: px(2.7) },
    { ...base, market: 'spreads', outcomeName: 'Los Angeles Dodgers', description: '', point: 1.5, prices: px(1.5) },
    { ...base, market: 'batter_hits', outcomeName: '1+ Hit', description: 'Mookie Betts', point: null, prices: px(1.44) }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  assert.equal(decision.qualifies, true);
  assert.equal(decision.recommendation, 'build_single');
  assert.ok(pick);
  assert.equal(pick.mlbStructureProfile, 'mlb-featured-single-v3');
  assert.equal(pick.legs.length, 1);
  assert.match(pick.legs[0].label, /Los Angeles Dodgers \+1\.5/);
  assert.ok(pick.legs.every((leg) => leg.source?.family !== 'prop' && leg.source?.family !== 'total'));
});

test('analyzeEventWithRules (v3) skips MLB hit-plus-strikeout prop boards with no featured single', async () => {
  const startTime = '2026-05-23T20:10:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'mlb',
    sportLabel: 'MLB',
    marketSportKey: 'mlb',
    eventId: 'snapshot:mlb:guardians-vs-phillies-mixed',
    eventName: 'Philadelphia Phillies vs Cleveland Guardians',
    homeTeam: 'Cleveland Guardians',
    awayTeam: 'Philadelphia Phillies',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'mlb',
      homeTeam: 'Cleveland Guardians',
      awayTeam: 'Philadelphia Phillies',
      displayName: 'Philadelphia Phillies vs Cleveland Guardians',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hit',
      description: 'Jose Ramirez',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.46 }]
    },
    {
      sportKey: 'mlb',
      homeTeam: 'Cleveland Guardians',
      awayTeam: 'Philadelphia Phillies',
      displayName: 'Philadelphia Phillies vs Cleveland Guardians',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hit',
      description: 'Alec Bohm',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.44 }]
    },
    {
      sportKey: 'mlb',
      homeTeam: 'Cleveland Guardians',
      awayTeam: 'Philadelphia Phillies',
      displayName: 'Philadelphia Phillies vs Cleveland Guardians',
      startTime,
      market: 'pitcher_strikeouts',
      outcomeName: '4+ Strikeouts',
      description: 'Tanner Bibee',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.48 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14).map((candidate) => {
    if (candidate.description === 'Jose Ramirez' || candidate.description === 'Tanner Bibee') {
      return { ...candidate, mlbTeamSide: 'home', mlbTeamName: 'Cleveland Guardians' };
    }

    return { ...candidate, mlbTeamSide: 'away', mlbTeamName: 'Philadelphia Phillies' };
  });
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  // v3 no longer builds hit+strikeout prop multis; with no featured single available the
  // event is skipped.
  assert.equal(decision.qualifies, false);
  assert.equal(decision.recommendation, 'no_bet');
  assert.equal(pick, null);
});

test('analyzeEventWithRules (v3) skips MLB when only hit props are available (no featured single)', async () => {
  const startTime = '2026-05-23T20:25:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'mlb',
    sportLabel: 'MLB',
    marketSportKey: 'mlb',
    eventId: 'snapshot:mlb:braves-vs-phillies',
    eventName: 'Philadelphia Phillies vs Atlanta Braves',
    homeTeam: 'Atlanta Braves',
    awayTeam: 'Philadelphia Phillies',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'mlb',
      homeTeam: 'Atlanta Braves',
      awayTeam: 'Philadelphia Phillies',
      displayName: 'Philadelphia Phillies vs Atlanta Braves',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hit',
      description: 'Ronald Acuna Jr.',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.46 }]
    },
    {
      sportKey: 'mlb',
      homeTeam: 'Atlanta Braves',
      awayTeam: 'Philadelphia Phillies',
      displayName: 'Philadelphia Phillies vs Atlanta Braves',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hit',
      description: 'Austin Riley',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.48 }]
    },
    {
      sportKey: 'mlb',
      homeTeam: 'Atlanta Braves',
      awayTeam: 'Philadelphia Phillies',
      displayName: 'Philadelphia Phillies vs Atlanta Braves',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hit',
      description: 'Trea Turner',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.47 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14).map((candidate) => {
    if (candidate.description === 'Ronald Acuna Jr.' || candidate.description === 'Austin Riley') {
      return { ...candidate, mlbTeamSide: 'home', mlbTeamName: 'Atlanta Braves' };
    }

    return { ...candidate, mlbTeamSide: 'away', mlbTeamName: 'Philadelphia Phillies' };
  });
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  // v3 drops props from the MLB pool entirely, so a hits-only board offers no qualifying
  // featured single and the event is skipped.
  assert.equal(decision.qualifies, false);
  assert.equal(decision.recommendation, 'no_bet');
  assert.equal(pick, null);
});

test('analyzeEventWithRules keeps accepted 3-leg NRL combos publishable through pick construction', async () => {
  const startTime = '2026-05-23T10:00:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'nrl',
    sportLabel: 'NRL',
    marketSportKey: 'nrl',
    eventId: 'snapshot:nrl:bulldogs-vs-storm',
    eventName: 'Canterbury Bulldogs vs Melbourne Storm',
    homeTeam: 'Canterbury Bulldogs',
    awayTeam: 'Melbourne Storm',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      description: '',
      point: 52.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.48 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'first_half_totals',
      outcomeName: 'Under',
      description: '',
      point: 26.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.42 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'spreads',
      outcomeName: 'Canterbury Bulldogs',
      description: '',
      point: 10.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.52 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  assert.equal(decision.qualifies, true);
  assert.equal(decision.checklist.selectionSupport, 'pass');
  assert.ok(pick);
  assert.equal(pick.sport, 'nrl');
  assert.equal(pick.betType, 'sgm');
  assert.equal(decision.recommendation, 'build_3_leg_multi');
  assert.equal(pick.legs.length, 3);
});

test('analyzeEventWithRules accepts a 3-leg NRL build with one genuine kicker-points leg', async () => {
  const startTime = '2026-05-23T10:00:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'nrl',
    sportLabel: 'NRL',
    marketSportKey: 'nrl',
    eventId: 'snapshot:nrl:bulldogs-vs-storm-kicker-points',
    eventName: 'Canterbury Bulldogs vs Melbourne Storm',
    homeTeam: 'Canterbury Bulldogs',
    awayTeam: 'Melbourne Storm',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      description: '',
      point: 52.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.44 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'first_half_spreads',
      outcomeName: 'Melbourne Storm',
      description: '',
      point: 0.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.52 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'player_points',
      outcomeName: '6+ Points',
      description: 'Matt Burton',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.46 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'h2h',
      outcomeName: 'Melbourne Storm',
      description: '',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.59 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  assert.ok(candidatePool.some((candidate) => candidate.label === 'Matt Burton 6+ Points'));

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  assert.equal(decision.qualifies, true);
  assert.ok(pick);
  assert.equal(pick.legs.length, 3);
  assert.ok(pick.legs.some((leg) => leg.label === 'Matt Burton 6+ Points'));
  assert.ok(pick.legs.some((leg) => leg.label === 'Under 52.5'));
  assert.ok(pick.legs.some((leg) => leg.label === '1st Half Melbourne Storm +0.5'));
  assert.ok(pick.legs.every((leg) => !/head to head|h2h/i.test(leg.label)));
});

test('analyzeEventWithRules accepts a realistic-priced 3-leg NRL kicker build instead of the H2H and under fallback', async () => {
  const startTime = '2026-06-13T09:35:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'nrl',
    sportLabel: 'NRL',
    marketSportKey: 'nrl',
    eventId: 'snapshot:nrl:eels-vs-raiders-realistic-prices',
    eventName: 'Parramatta Eels vs Canberra Raiders',
    homeTeam: 'Parramatta Eels',
    awayTeam: 'Canberra Raiders',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'nrl',
      homeTeam: 'Parramatta Eels',
      awayTeam: 'Canberra Raiders',
      displayName: 'Parramatta Eels vs Canberra Raiders',
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      description: '',
      point: 52.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.84 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Parramatta Eels',
      awayTeam: 'Canberra Raiders',
      displayName: 'Parramatta Eels vs Canberra Raiders',
      startTime,
      market: 'spreads',
      outcomeName: 'Parramatta Eels',
      description: '',
      point: 2.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.89 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Parramatta Eels',
      awayTeam: 'Canberra Raiders',
      displayName: 'Parramatta Eels vs Canberra Raiders',
      startTime,
      market: 'player_points',
      outcomeName: '4+ Points',
      description: 'Ethan Sanders',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.18 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Parramatta Eels',
      awayTeam: 'Canberra Raiders',
      displayName: 'Parramatta Eels vs Canberra Raiders',
      startTime,
      market: 'h2h',
      outcomeName: 'Canberra Raiders',
      description: '',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.45 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14)
    .map((candidate) => (candidate.family === 'prop'
      ? {
        ...candidate,
        researchStatus: 'partial',
        researchGapSeverity: 'soft',
        researchReasons: ['Pre-pick ESPN injury research is not configured for this event.']
      }
      : candidate));
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  // Real NRL anchors price ~1.8-1.9, so this build lands ~4.1x: above the
  // generic 3.25x target but inside the NRL 3-leg ceiling. It must be accepted
  // outright rather than losing to the short H2H + total fallback.
  assert.equal(decision.qualifies, true);
  assert.equal(decision.recommendation, 'build_3_leg_multi');
  assert.ok(pick);
  assert.equal(pick.legs.length, 3);
  assert.ok(pick.legs.some((leg) => leg.label === 'Under 52.5'));
  assert.ok(pick.legs.some((leg) => leg.label === 'Parramatta Eels +2.5'));
  assert.ok(pick.legs.some((leg) => leg.label === 'Ethan Sanders 4+ Points'));
  assert.ok(pick.legs.every((leg) => !/head to head|h2h/i.test(leg.label)));
  assert.ok(!/fallback forced/.test(String(decision.notes || '')));
});

test('analyzeEventWithRules prefers the NRL first-half total and plus-line mix over moneyline fallbacks', async () => {
  const startTime = '2026-05-23T10:00:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'nrl',
    sportLabel: 'NRL',
    marketSportKey: 'nrl',
    eventId: 'snapshot:nrl:bulldogs-vs-storm-first-half',
    eventName: 'Canterbury Bulldogs vs Melbourne Storm',
    homeTeam: 'Canterbury Bulldogs',
    awayTeam: 'Melbourne Storm',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      description: '',
      point: 52.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.44 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'first_half_totals',
      outcomeName: 'Under',
      description: '',
      point: 26.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.46 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'first_half_spreads',
      outcomeName: 'Melbourne Storm',
      description: '',
      point: 0.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.52 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'h2h',
      outcomeName: 'Melbourne Storm',
      description: '',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.59 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'spreads',
      outcomeName: 'Canterbury Bulldogs',
      description: '',
      point: -2.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.4 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  assert.equal(decision.qualifies, true);
  assert.ok(pick);
  assert.equal(pick.legs.length, 3);
  assert.ok(pick.legs.some((leg) => leg.label === 'Under 52.5'));
  assert.ok(pick.legs.some((leg) => leg.label === '1st Half Under 26.5'));
  assert.ok(pick.legs.some((leg) => leg.label === '1st Half Melbourne Storm +0.5'));
  assert.ok(pick.legs.every((leg) => !/head to head|h2h/i.test(leg.label)));
  assert.ok(pick.legs.every((leg) => !/-2\.5/.test(leg.label)));
});

test('analyzeEventWithRules forces the safest available 2-leg NRL combo when benchmark acceptance would otherwise return no_bet', async () => {
  const startTime = '2026-05-23T07:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'nrl',
    sportLabel: 'NRL',
    marketSportKey: 'nrl',
    eventId: 'snapshot:nrl:dragons-vs-warriors-safe-two-leg',
    eventName: 'St George Illawarra Dragons vs New Zealand Warriors',
    homeTeam: 'St George Illawarra Dragons',
    awayTeam: 'New Zealand Warriors',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'nrl',
      homeTeam: 'St George Illawarra Dragons',
      awayTeam: 'New Zealand Warriors',
      displayName: 'St George Illawarra Dragons vs New Zealand Warriors',
      startTime,
      market: 'first_half_totals',
      outcomeName: 'Under',
      description: '',
      point: 24.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.89 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'St George Illawarra Dragons',
      awayTeam: 'New Zealand Warriors',
      displayName: 'St George Illawarra Dragons vs New Zealand Warriors',
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      description: '',
      point: 52.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.9 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'St George Illawarra Dragons',
      awayTeam: 'New Zealand Warriors',
      displayName: 'St George Illawarra Dragons vs New Zealand Warriors',
      startTime,
      market: 'first_half_spreads',
      outcomeName: 'St George Illawarra Dragons',
      description: '',
      point: 6.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.81 }]
    }
  ];
  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);
  const context = {
    config: {
      benchmarkFilters: {
        requireSupportData: false,
        significantSupportScore: 5,
        strongSupportScore: 8
      }
    }
  };

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, { availableUnits: 10 });
  const pick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  assert.equal(decision.qualifies, true);
  assert.equal(decision.recommendation, 'build_2_leg_multi');
  assert.equal(pick?.sport, 'nrl');
  assert.equal(pick?.betType, 'sgm');
  assert.equal(pick?.legs.length, 2);
  assert.equal(pick?.legs.filter((leg) => /totals/.test(String(leg?.source?.market || ''))).length, 1);
  assert.equal(pick?.legs.filter((leg) => /spread/.test(String(leg?.source?.market || ''))).length, 1);
  assert.ok(pick?.legs.every((leg) => !/head to head|h2h/i.test(leg.label)));
});

test('buildAnalysisCandidatePool removes race-to-points markets, negative lines, and coin-flip NRL totals while keeping genuine kicker points', () => {
  const startTime = '2026-05-23T09:30:00.000Z';
  const fetchedAt = new Date().toISOString();
  const eventContext = {
    sportKey: 'nrl',
    sportLabel: 'NRL',
    marketSportKey: 'nrl',
    eventId: 'snapshot:nrl:bulldogs-vs-storm',
    eventName: 'Canterbury Bulldogs vs Melbourne Storm',
    homeTeam: 'Canterbury Bulldogs',
    awayTeam: 'Melbourne Storm',
    startTime,
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const quotes = [
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'totals',
      outcomeName: 'Race',
      description: '',
      point: '10 Points',
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.9 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'totals',
      outcomeName: 'Over',
      description: '',
      point: 48.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.9 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      description: '',
      point: 50.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.85 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'totals',
      outcomeName: 'Under',
      description: '',
      point: 52.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.85 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'spreads',
      outcomeName: 'Canterbury Bulldogs',
      description: '',
      point: -2.5,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.9 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'player_points',
      outcomeName: '6+ Points',
      description: 'Matt Burton',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.44 }]
    },
    {
      sportKey: 'nrl',
      homeTeam: 'Canterbury Bulldogs',
      awayTeam: 'Melbourne Storm',
      displayName: 'Canterbury Bulldogs vs Melbourne Storm',
      startTime,
      market: 'player_points',
      outcomeName: '4+ Points',
      description: 'Canterbury Bulldogs',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.38 }]
    }
  ];

  const candidatePool = buildAnalysisCandidatePool(eventContext, quotes, 14);

  assert.equal(candidatePool.some((candidate) => /race/i.test(candidate.label)), false);
  // Soft overs (line above 40.5) and shallow unders (line below 51.5) are near
  // coin flips, so neither side of a mid-40s total may enter the pool.
  assert.equal(candidatePool.some((candidate) => /over 48\.5/i.test(candidate.label)), false);
  assert.equal(candidatePool.some((candidate) => /under 50\.5/i.test(candidate.label)), false);
  assert.equal(candidatePool.some((candidate) => /under 52\.5/i.test(candidate.label)), true);
  assert.equal(candidatePool.some((candidate) => candidate.point === -2.5), false);
  assert.equal(candidatePool.some((candidate) => candidate.label === 'Matt Burton 6+ Points'), true);
  assert.equal(candidatePool.some((candidate) => candidate.label === 'Canterbury Bulldogs 4+ Points'), false);
});

test('runAnalysisJob blocks MLB prop analysis when pre-pick weather research flags unstable outdoor conditions', async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-mlb-weather-block-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 2,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'mlb',
      label: 'MLB',
      provider: 'espn',
      path: 'baseball/mlb',
      enabled: true,
      marketKey: 'mlb'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const startTime = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Aaron Judge',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.45 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Rafael Devers',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.49 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Rafael Devers',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.49 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Juan Soto',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.48 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'pitcher_strikeouts',
      outcomeName: '5+ Strikeouts',
      description: 'Gerrit Cole',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.62 }]
    }]
  };

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async () => ({
      events: [{
        id: '401999200',
        startTime,
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        homeTeamId: '10',
        awayTeamId: '11',
        venue: {
          name: 'Yankee Stadium',
          city: 'Bronx',
          state: 'NY',
          country: 'USA',
          indoor: false,
          roofType: 'open'
        }
      }]
    }),
    fetchEspnTeamInjuries: async (sport, teamId) => ({
      sport,
      teamId,
      status: 'ok',
      injuries: []
    }),
    geocodeOpenMeteoLocation: async () => [{ latitude: 40.8296, longitude: -73.9262 }],
    fetchOpenMeteoForecast: async () => ({
      forecast: {
        utc_offset_seconds: 0,
        hourly: {
          time: [startTime],
          temperature_2m: [22],
          precipitation_probability: [70],
          precipitation: [0.8],
          wind_speed_10m: [32],
          wind_gusts_10m: [46],
          weather_code: [61]
        }
      }
    }),
    analyzeEvent: () => {
      throw new Error('Weather-blocked MLB event should be skipped before analysis is invoked');
    }
  });

  assert.equal(result.generated, 0);
  assert.equal(result.considered, 0);
});

test('runAnalysisJob removes non-starter MLB strikeout props and non-roster MLB props before analysis', { skip: 'Obsolete under MLB v3 featured-single profile: props are dropped from the MLB pool, so the prop-research lineup path is dormant. Rewrite or remove in a follow-up.' }, async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-mlb-official-filter-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 3,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 2,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'mlb',
      label: 'MLB',
      provider: 'espn',
      path: 'baseball/mlb',
      enabled: true,
      marketKey: 'mlb'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const startTime = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Aaron Judge',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.45 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Rafael Devers',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.49 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'pitcher_strikeouts',
      outcomeName: '5+ Strikeouts',
      description: 'Gerrit Cole',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.62 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'pitcher_strikeouts',
      outcomeName: '5+ Strikeouts',
      description: 'Nestor Cortes',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.58 }]
    }]
  };
  let analyzedCandidates = [];

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async () => ({
      events: [{
        id: '401999210',
        startTime,
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        homeTeamId: '10',
        awayTeamId: '11',
        venue: {
          name: 'Yankee Stadium',
          city: 'Bronx',
          state: 'NY',
          country: 'USA',
          indoor: false,
          roofType: 'open'
        }
      }]
    }),
    fetchEspnTeamInjuries: async () => ({
      status: 'ok',
      injuries: []
    }),
    geocodeOpenMeteoLocation: async () => [{ latitude: 40.8296, longitude: -73.9262 }],
    fetchOpenMeteoForecast: async () => ({
      forecast: {
        utc_offset_seconds: 0,
        hourly: {
          time: [startTime],
          temperature_2m: [22],
          precipitation_probability: [10],
          precipitation: [0],
          wind_speed_10m: [12],
          wind_gusts_10m: [18],
          weather_code: [1]
        }
      }
    }),
    fetchMlbSchedule: async () => ({
      dates: [{
        games: [{
          gamePk: 123456,
          gameDate: startTime,
          teams: {
            away: {
              team: { name: 'Boston Red Sox' },
              probablePitcher: { fullName: 'Brayan Bello' }
            },
            home: {
              team: { name: 'New York Yankees' },
              probablePitcher: { fullName: 'Gerrit Cole' }
            }
          }
        }]
      }]
    }),
    fetchMlbGameFeed: async () => ({
      gameData: {
        probablePitchers: {
          away: { fullName: 'Brayan Bello' },
          home: { fullName: 'Gerrit Cole' }
        },
        teams: {
          away: { name: 'Boston Red Sox' },
          home: { name: 'New York Yankees' }
        }
      },
      liveData: {
        boxscore: {
          teams: {
            away: {
              team: { name: 'Boston Red Sox' },
              battingOrder: [2],
              players: {
                ID2: {
                  person: { id: 2, fullName: 'Rafael Devers' }
                },
                ID3: {
                  person: { id: 3, fullName: 'Brayan Bello' }
                }
              }
            },
            home: {
              team: { name: 'New York Yankees' },
              battingOrder: [1],
              players: {
                ID1: {
                  person: { id: 1, fullName: 'Aaron Judge' }
                },
                ID4: {
                  person: { id: 4, fullName: 'Gerrit Cole' }
                },
                ID5: {
                  person: { id: 5, fullName: 'Nestor Cortes' }
                }
              }
            }
          }
        }
      }
    }),
    fetchRotowireMlbDailyLineups: async () => ({
      pageKey: 'today',
      games: []
    }),
    fetchRotowireMlbNews: async () => ({
      entries: []
    }),
    analyzeEvent: ({ candidatePool }) => {
      analyzedCandidates = candidatePool.map((candidate) => candidate.description);

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: candidatePool.slice(0, 2).map((candidate) => ({
          candidateId: candidate.candidateId,
          modelProbability: 0.63,
          rationale: 'Official MLB research cleared this prop.'
        })),
        backupLeg: null,
        combinedModelProbability: 0.4,
        supportScore: 7.2,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 1,
        rationale: 'Official MLB context filter test.',
        notes: 'Rules stub.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(result.generated, 1);
  assert.deepEqual([...analyzedCandidates].sort(), ['Aaron Judge', 'Gerrit Cole', 'Rafael Devers']);
});

test('runAnalysisJob blocks late MLB batter props when the official batting order is still missing', { skip: 'Obsolete under MLB v3 featured-single profile: MLB no longer uses batter props, so the lineup-lock path is dormant. Rewrite or remove in a follow-up.' }, async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-mlb-lineup-lock-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 2,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 2,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'mlb',
      label: 'MLB',
      provider: 'espn',
      path: 'baseball/mlb',
      enabled: true,
      marketKey: 'mlb'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const startTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Aaron Judge',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.45 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Rafael Devers',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.49 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'pitcher_strikeouts',
      outcomeName: '5+ Strikeouts',
      description: 'Gerrit Cole',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.62 }]
    }]
  };
  let analyzedCandidates = [];

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async () => ({
      events: [{
        id: '401999211',
        startTime,
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        homeTeamId: '10',
        awayTeamId: '11',
        venue: {
          name: 'Yankee Stadium',
          city: 'Bronx',
          state: 'NY',
          country: 'USA',
          indoor: false,
          roofType: 'open'
        }
      }]
    }),
    fetchEspnTeamInjuries: async () => ({
      status: 'ok',
      injuries: []
    }),
    geocodeOpenMeteoLocation: async () => [{ latitude: 40.8296, longitude: -73.9262 }],
    fetchOpenMeteoForecast: async () => ({
      forecast: {
        utc_offset_seconds: 0,
        hourly: {
          time: [startTime],
          temperature_2m: [22],
          precipitation_probability: [10],
          precipitation: [0],
          wind_speed_10m: [12],
          wind_gusts_10m: [18],
          weather_code: [1]
        }
      }
    }),
    fetchMlbSchedule: async () => ({
      dates: [{
        games: [{
          gamePk: 123457,
          gameDate: startTime,
          teams: {
            away: {
              team: { name: 'Boston Red Sox' },
              probablePitcher: { fullName: 'Brayan Bello' }
            },
            home: {
              team: { name: 'New York Yankees' },
              probablePitcher: { fullName: 'Gerrit Cole' }
            }
          }
        }]
      }]
    }),
    fetchMlbGameFeed: async () => ({
      gameData: {
        probablePitchers: {
          away: { fullName: 'Brayan Bello' },
          home: { fullName: 'Gerrit Cole' }
        },
        teams: {
          away: { name: 'Boston Red Sox' },
          home: { name: 'New York Yankees' }
        }
      },
      liveData: {
        boxscore: {
          teams: {
            away: {
              team: { name: 'Boston Red Sox' },
              battingOrder: [2],
              players: {
                ID2: {
                  person: { id: 2, fullName: 'Rafael Devers' }
                },
                ID3: {
                  person: { id: 3, fullName: 'Brayan Bello' }
                }
              }
            },
            home: {
              team: { name: 'New York Yankees' },
              battingOrder: [],
              players: {
                ID1: {
                  person: { id: 1, fullName: 'Aaron Judge' }
                },
                ID4: {
                  person: { id: 4, fullName: 'Gerrit Cole' }
                }
              }
            }
          }
        }
      }
    }),
    fetchRotowireMlbDailyLineups: async () => ({
      pageKey: 'today',
      games: []
    }),
    fetchRotowireMlbNews: async () => ({
      entries: []
    }),
    analyzeEvent: ({ candidatePool }) => {
      analyzedCandidates = candidatePool.map((candidate) => candidate.description);

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: candidatePool.slice(0, 2).map((candidate) => ({
          candidateId: candidate.candidateId,
          modelProbability: 0.63,
          rationale: 'Official MLB research cleared this prop.'
        })),
        backupLeg: null,
        combinedModelProbability: 0.4,
        supportScore: 7.2,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 1,
        rationale: 'Late MLB lineup lock test.',
        notes: 'Rules stub.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(result.generated, 1);
  assert.deepEqual([...analyzedCandidates].sort(), ['Gerrit Cole', 'Rafael Devers']);
});

test('runAnalysisJob allows late MLB batter props when the official batting order is missing but RotoWire projects the batter to start', { skip: 'Obsolete under MLB v3 featured-single profile: MLB no longer uses batter props, so the RotoWire projection path is dormant. Rewrite or remove in a follow-up.' }, async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-mlb-rotowire-allow-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 2,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 2,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'mlb',
      label: 'MLB',
      provider: 'espn',
      path: 'baseball/mlb',
      enabled: true,
      marketKey: 'mlb'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const startTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Aaron Judge',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.45 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'pitcher_strikeouts',
      outcomeName: '5+ Strikeouts',
      description: 'Gerrit Cole',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.62 }]
    }]
  };
  let analyzedCandidates = [];

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async () => ({
      events: [{
        id: '401999212',
        startTime,
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        homeTeamId: '10',
        awayTeamId: '11',
        venue: {
          name: 'Yankee Stadium',
          city: 'Bronx',
          state: 'NY',
          country: 'USA',
          indoor: false,
          roofType: 'open'
        }
      }]
    }),
    fetchEspnTeamInjuries: async () => ({
      status: 'ok',
      injuries: []
    }),
    geocodeOpenMeteoLocation: async () => [{ latitude: 40.8296, longitude: -73.9262 }],
    fetchOpenMeteoForecast: async () => ({
      forecast: {
        utc_offset_seconds: 0,
        hourly: {
          time: [startTime],
          temperature_2m: [22],
          precipitation_probability: [10],
          precipitation: [0],
          wind_speed_10m: [12],
          wind_gusts_10m: [18],
          weather_code: [1]
        }
      }
    }),
    fetchMlbSchedule: async () => ({
      dates: [{
        games: [{
          gamePk: 123458,
          gameDate: startTime,
          teams: {
            away: {
              team: { name: 'Boston Red Sox' },
              probablePitcher: { fullName: 'Brayan Bello' }
            },
            home: {
              team: { name: 'New York Yankees' },
              probablePitcher: { fullName: 'Gerrit Cole' }
            }
          }
        }]
      }]
    }),
    fetchMlbGameFeed: async () => ({
      gameData: {
        probablePitchers: {
          away: { fullName: 'Brayan Bello' },
          home: { fullName: 'Gerrit Cole' }
        },
        teams: {
          away: { name: 'Boston Red Sox' },
          home: { name: 'New York Yankees' }
        }
      },
      liveData: {
        boxscore: {
          teams: {
            away: {
              team: { name: 'Boston Red Sox' },
              battingOrder: [],
              players: {
                ID2: {
                  person: { id: 2, fullName: 'Rafael Devers' }
                },
                ID3: {
                  person: { id: 3, fullName: 'Brayan Bello' }
                }
              }
            },
            home: {
              team: { name: 'New York Yankees' },
              battingOrder: [],
              players: {
                ID1: {
                  person: { id: 1, fullName: 'Aaron Judge' }
                },
                ID4: {
                  person: { id: 4, fullName: 'Gerrit Cole' }
                }
              }
            }
          }
        }
      }
    }),
    fetchRotowireMlbDailyLineups: async () => ({
      pageKey: 'today',
      games: [{
        awayTeam: 'Boston Red Sox',
        normalizedAwayTeam: 'boston red sox',
        homeTeam: 'New York Yankees',
        normalizedHomeTeam: 'new york yankees',
        away: {
          teamName: 'Boston Red Sox',
          lineupStatus: 'expected',
          players: [{
            playerName: 'Rafael Devers',
            normalizedPlayerName: 'rafael devers',
            battingOrderIndex: 2
          }]
        },
        home: {
          teamName: 'New York Yankees',
          lineupStatus: 'expected',
          players: [{
            playerName: 'Aaron Judge',
            normalizedPlayerName: 'aaron judge',
            battingOrderIndex: 2
          }]
        }
      }]
    }),
    fetchRotowireMlbNews: async () => ({
      entries: [{
        playerName: 'Aaron Judge',
        normalizedPlayerName: 'aaron judge',
        headline: 'Starting Sunday',
        note: 'Judge is expected to start Sunday against Boston.',
        timestamp: 'May 24, 2026',
        statusTags: []
      }]
    }),
    analyzeEvent: ({ candidatePool }) => {
      analyzedCandidates = candidatePool.map((candidate) => ({
        description: candidate.description,
        researchStatus: candidate.researchStatus,
        researchReasons: candidate.researchReasons
      }));

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: candidatePool.map((candidate) => ({
          candidateId: candidate.candidateId,
          modelProbability: 0.63,
          rationale: 'Projected MLB lineup support cleared this prop.'
        })),
        backupLeg: null,
        combinedModelProbability: 0.4,
        supportScore: 7.2,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 1,
        rationale: 'Projected MLB lineup allow test.',
        notes: 'Rules stub.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(result.generated, 1);
  assert.deepEqual(analyzedCandidates.map((candidate) => candidate.description).sort(), ['Aaron Judge', 'Gerrit Cole']);
  assert.equal(analyzedCandidates.find((candidate) => candidate.description === 'Aaron Judge')?.researchStatus, 'verified');
  assert.match(analyzedCandidates.find((candidate) => candidate.description === 'Aaron Judge')?.researchReasons?.join(' | ') || '', /RotoWire expected lineup/i);
});

test('runAnalysisJob blocks MLB batter props when RotoWire projected lineup excludes the batter inside the lineup lock window', { skip: 'Obsolete under MLB v3 featured-single profile: MLB no longer uses batter props, so the RotoWire exclusion path is dormant. Rewrite or remove in a follow-up.' }, async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sportstips-analysis-mlb-rotowire-block-'));
  t.after(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const picksFeedFile = path.join(workspaceRoot, 'automation', 'discord-webhooks', 'picks-feed.json');
  await fs.mkdir(path.dirname(picksFeedFile), { recursive: true });
  await fs.writeFile(picksFeedFile, JSON.stringify({ picks: [] }, null, 2));

  const config = {
    timezone: 'Australia/Sydney',
    dryRun: true,
    discord: {
      webhooks: { slates: '', picks: '', results: '' },
      roleMentions: { enabled: false, channels: [] }
    },
    openai: { enabled: false, apiKey: '', model: 'gpt-5.4' },
    analysis: {
      enabled: true,
      engine: 'rules',
      lookaheadHours: 36,
      maxEventsPerSport: 8,
      minCandidateLegsPerEvent: 1,
      maxCandidateLegsPerEvent: 14,
      generator: {
        minBooks: 1,
        stakeUnits: 1,
        maxStakeUnits: 2,
        teamSportsH2hPolicy: 'fallback_only'
      }
    },
    sports: [{
      key: 'mlb',
      label: 'MLB',
      provider: 'espn',
      path: 'baseball/mlb',
      enabled: true,
      marketKey: 'mlb'
    }],
    __paths: {
      picksFeedFile,
      profitTrackerFile: path.join(workspaceRoot, '30-day-profit-tracker.md'),
      snapshotFile: path.join(workspaceRoot, 'automation', 'discord-webhooks', 'bookmaker-snapshots.json')
    }
  };
  const state = {
    jobs: {},
    posts: { slates: {}, picks: {}, results: {} },
    cache: { oddsValidation: {} },
    providers: { marketScrape: {} },
    tracking: { picks: {} }
  };
  const startTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const fetchedAt = new Date().toISOString();
  const snapshot = {
    updatedAt: fetchedAt,
    quotes: [{
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Aaron Judge',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.45 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'batter_hits',
      outcomeName: '1+ Hits',
      description: 'Rafael Devers',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.49 }]
    }, {
      sportKey: 'mlb',
      homeTeam: 'New York Yankees',
      awayTeam: 'Boston Red Sox',
      displayName: 'Boston Red Sox vs New York Yankees',
      startTime,
      market: 'pitcher_strikeouts',
      outcomeName: '5+ Strikeouts',
      description: 'Gerrit Cole',
      point: null,
      fetchedAt,
      source: 'snapshot',
      prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.62 }]
    }]
  };
  let analyzedCandidates = [];

  const result = await runAnalysisJob({ config, state, dryRun: true }, {
    snapshot,
    fetchEspnSlate: async () => ({
      events: [{
        id: '401999213',
        startTime,
        homeTeam: 'New York Yankees',
        awayTeam: 'Boston Red Sox',
        homeTeamId: '10',
        awayTeamId: '11',
        venue: {
          name: 'Yankee Stadium',
          city: 'Bronx',
          state: 'NY',
          country: 'USA',
          indoor: false,
          roofType: 'open'
        }
      }]
    }),
    fetchEspnTeamInjuries: async () => ({
      status: 'ok',
      injuries: []
    }),
    geocodeOpenMeteoLocation: async () => [{ latitude: 40.8296, longitude: -73.9262 }],
    fetchOpenMeteoForecast: async () => ({
      forecast: {
        utc_offset_seconds: 0,
        hourly: {
          time: [startTime],
          temperature_2m: [22],
          precipitation_probability: [10],
          precipitation: [0],
          wind_speed_10m: [12],
          wind_gusts_10m: [18],
          weather_code: [1]
        }
      }
    }),
    fetchMlbSchedule: async () => ({
      dates: [{
        games: [{
          gamePk: 123459,
          gameDate: startTime,
          teams: {
            away: {
              team: { name: 'Boston Red Sox' },
              probablePitcher: { fullName: 'Brayan Bello' }
            },
            home: {
              team: { name: 'New York Yankees' },
              probablePitcher: { fullName: 'Gerrit Cole' }
            }
          }
        }]
      }]
    }),
    fetchMlbGameFeed: async () => ({
      gameData: {
        probablePitchers: {
          away: { fullName: 'Brayan Bello' },
          home: { fullName: 'Gerrit Cole' }
        },
        teams: {
          away: { name: 'Boston Red Sox' },
          home: { name: 'New York Yankees' }
        }
      },
      liveData: {
        boxscore: {
          teams: {
            away: {
              team: { name: 'Boston Red Sox' },
              battingOrder: [],
              players: {
                ID2: {
                  person: { id: 2, fullName: 'Rafael Devers' }
                },
                ID3: {
                  person: { id: 3, fullName: 'Brayan Bello' }
                }
              }
            },
            home: {
              team: { name: 'New York Yankees' },
              battingOrder: [],
              players: {
                ID1: {
                  person: { id: 1, fullName: 'Aaron Judge' }
                },
                ID4: {
                  person: { id: 4, fullName: 'Gerrit Cole' }
                }
              }
            }
          }
        }
      }
    }),
    fetchRotowireMlbDailyLineups: async () => ({
      pageKey: 'today',
      games: [{
        awayTeam: 'Boston Red Sox',
        normalizedAwayTeam: 'boston red sox',
        homeTeam: 'New York Yankees',
        normalizedHomeTeam: 'new york yankees',
        away: {
          teamName: 'Boston Red Sox',
          lineupStatus: 'expected',
          players: [{
            playerName: 'Rafael Devers',
            normalizedPlayerName: 'rafael devers',
            battingOrderIndex: 2
          }]
        },
        home: {
          teamName: 'New York Yankees',
          lineupStatus: 'expected',
          players: [{
            playerName: 'Giancarlo Stanton',
            normalizedPlayerName: 'giancarlo stanton',
            battingOrderIndex: 4
          }]
        }
      }]
    }),
    fetchRotowireMlbNews: async () => ({
      entries: []
    }),
    analyzeEvent: ({ candidatePool }) => {
      analyzedCandidates = candidatePool.map((candidate) => candidate.description);

      return {
        qualifies: true,
        recommendation: 'bet',
        selectedLegs: candidatePool.map((candidate) => ({
          candidateId: candidate.candidateId,
          modelProbability: 0.63,
          rationale: 'Projected MLB lineup exclusion test.'
        })),
        backupLeg: null,
        combinedModelProbability: 0.4,
        supportScore: 7.2,
        confidenceTier: 'medium',
        supportProjection: 'moderate',
        dataConfidence: 'medium',
        correlationRisk: 'low',
        correlationJustified: true,
        exceptionalSupport: false,
        strongSupport: false,
        stakeUnits: 1,
        rationale: 'Projected MLB lineup block test.',
        notes: 'Rules stub.',
        checklist: PASSING_CHECKLIST,
        generatedSource: 'rules-generator',
        analysisEngine: 'rules'
      };
    }
  });

  assert.equal(result.considered, 1);
  assert.equal(result.generated, 1);
  assert.deepEqual([...analyzedCandidates].sort(), ['Gerrit Cole', 'Rafael Devers']);
});

test('extractRotowireMlbDailyLineups parses full team names, batting orders, and lineup status', () => {
  const html = `
    <div class="lineup is-mlb">
      <div class="lineup__box">
        <div class="lineup__team is-visit"><div class="lineup__abbr">BOS</div></div>
        <div class="lineup__team is-home"><div class="lineup__abbr">NYY</div></div>
        <div class="lineup__mteam is-visit">Red Sox <span class="lineup__wl">(20-10)</span></div>
        <div class="lineup__mteam is-home">Yankees <span class="lineup__wl">(22-8)</span></div>
        <ul class="lineup__list is-visit">
          <li class="lineup__player-highlight mb-0"><div class="lineup__player-highlight-name"><a>Brayan Bello</a></div></li>
          <li class="lineup__status is-expected">Expected Lineup</li>
          <li class="lineup__player"><div class="lineup__pos">3B</div><a title="Rafael Devers">R. Devers</a></li>
        </ul>
        <ul class="lineup__list is-home">
          <li class="lineup__player-highlight mb-0"><div class="lineup__player-highlight-name"><a>Gerrit Cole</a></div></li>
          <li class="lineup__status is-expected">Expected Lineup</li>
          <li class="lineup__player"><div class="lineup__pos">RF</div><a title="Aaron Judge">A. Judge</a></li>
          <li class="lineup__player"><div class="lineup__pos">DH</div><a title="Giancarlo Stanton">G. Stanton</a></li>
        </ul>
      </div>
    </div>
  `;

  const data = extractRotowireMlbDailyLineups(html);
  const game = findMatchingRotowireMlbGame(data, {
    homeTeam: 'New York Yankees',
    awayTeam: 'Boston Red Sox'
  });

  assert.equal(data.games.length, 1);
  assert.ok(game);
  assert.equal(game.homeTeam, 'New York Yankees');
  assert.equal(game.awayTeam, 'Boston Red Sox');
  assert.equal(game.home.lineupStatus, 'expected');
  assert.equal(game.home.players[0].playerName, 'Aaron Judge');
  assert.equal(game.home.players[1].battingOrderIndex, 2);
});

test('extractRotowireMlbNews keeps player headlines and date markers', () => {
  const html = `
    <div class="news-update is-injured">
      <div class="news-update__playerhead">
        <a class="news-update__player-link" href="/baseball/player/nolan-schanuel-18903">Nolan Schanuel</a>
        <a class="news-update__headline" href="/baseball/headlines/example">Leaves with calf tightness</a>
      </div>
      <div class="news-update__main">
        <div class="news-update__timestamp">May 23, 2026</div>
        <div class="news-update__news">Schanuel exited Saturday's game with left calf tightness.</div>
      </div>
    </div>
  `;

  const data = extractRotowireMlbNews(html);

  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].playerName, 'Nolan Schanuel');
  assert.equal(data.entries[0].headline, 'Leaves with calf tightness');
  assert.equal(data.entries[0].timestamp, 'May 23, 2026');
  assert.ok(data.entries[0].statusTags.includes('injured'));
});

test('getRotowireMlbLineupsPageKey switches to tomorrow for next-day ET starts', () => {
  const now = new Date('2026-05-24T18:00:00.000Z');

  assert.equal(getRotowireMlbLineupsPageKey('2026-05-24T23:00:00.000Z', now), 'today');
  assert.equal(getRotowireMlbLineupsPageKey('2026-05-25T18:00:00.000Z', now), 'tomorrow');
});

test('analyzeEventWithRules rejects prop combos when candidate research is still unverified', async () => {
  const startTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const eventContext = {
    sportKey: 'mlb',
    sportLabel: 'MLB',
    eventId: 'event-mlb-research-gate',
    eventName: 'Boston Red Sox vs New York Yankees',
    startTime,
    homeTeam: 'New York Yankees',
    awayTeam: 'Boston Red Sox',
    generatorConfig: {
      minBooks: 1,
      stakeUnits: 1,
      maxStakeUnits: 2,
      teamSportsH2hPolicy: 'fallback_only'
    }
  };
  const fetchedAt = new Date().toISOString();
  const candidatePool = buildAnalysisCandidatePool(eventContext, [{
    sportKey: 'mlb',
    homeTeam: 'New York Yankees',
    awayTeam: 'Boston Red Sox',
    displayName: 'Boston Red Sox vs New York Yankees',
    startTime,
    market: 'batter_hits',
    outcomeName: '1+ Hits',
    description: 'Aaron Judge',
    point: null,
    fetchedAt,
    source: 'snapshot',
    prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.46 }]
  }, {
    sportKey: 'mlb',
    homeTeam: 'New York Yankees',
    awayTeam: 'Boston Red Sox',
    displayName: 'Boston Red Sox vs New York Yankees',
    startTime,
    market: 'batter_hits',
    outcomeName: '1+ Hits',
    description: 'Juan Soto',
    point: null,
    fetchedAt,
    source: 'snapshot',
    prices: [{ bookmakerKey: 'sportsbet-web', bookmakerTitle: 'Sportsbet Web', price: 1.52 }]
  }]).map((candidate) => ({
    ...candidate,
    researchStatus: 'unverified',
    researchReasons: ['Pre-pick research is missing for this candidate.']
  }));

  const decision = await analyzeEventWithRules({ config: { benchmarkFilters: {} } }, eventContext, candidatePool, {
    availableUnits: 5
  });

  assert.equal(decision.qualifies, false);
  assert.equal(decision.recommendation, 'no_bet');
  assert.equal(decision.dataConfidence, 'low');
});