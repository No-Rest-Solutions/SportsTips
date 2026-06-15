import assert from 'node:assert/strict';
import test from 'node:test';

import { extractAflOfficialPlayerStats, parseAflOfficialMatch } from '../src/providers/afl-official.mjs';
import { extractEspnPlayerBoxscoreStats, fetchEspnSlate } from '../src/providers/espn.mjs';
import { extractEspnTeamInjuries } from '../src/providers/espn-injuries.mjs';
import { extractFlashscoreInitialFeed, parseFlashscoreResultsFeed } from '../src/providers/flashscore.mjs';
import { parseNrlOfficialMatchData } from '../src/providers/nrl-official.mjs';
import { buildOpenMeteoEventWeatherSnapshot } from '../src/providers/open-meteo.mjs';

test('fetchEspnSlate backfills known venue locations when ESPN omits the address', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      events: [{
        id: '1133588',
        name: 'West Coast Eagles vs Essendon',
        date: '2026-05-31T09:20:54.000Z',
        competitions: [{
          competitors: [{
            homeAway: 'home',
            team: {
              id: '3',
              displayName: 'West Coast Eagles'
            },
            score: '0'
          }, {
            homeAway: 'away',
            team: {
              id: '16',
              displayName: 'Essendon'
            },
            score: '0'
          }],
          venue: {
            id: '77',
            fullName: 'Optus Stadium',
            address: {}
          },
          status: {
            type: {
              state: 'pre',
              shortDetail: 'Sun 5:20 PM AEST'
            }
          }
        }],
        status: {
          type: {
            state: 'pre',
            detail: 'Sun 5:20 PM AEST'
          }
        }
      }]
    })
  });

  try {
    const slate = await fetchEspnSlate({
      label: 'AFL',
      path: 'australian-football/afl'
    }, '2026-05-31');

    assert.deepEqual(slate.events[0]?.venue, {
      id: '77',
      name: 'Optus Stadium',
      city: 'Perth',
      state: 'WA',
      country: 'Australia',
      latitude: -31.95079,
      longitude: 115.807236,
      indoor: false,
      roofType: ''
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('extractEspnTeamInjuries parses rendered ESPN injury rows', () => {
  const html = `
    <div class="pb3 bb bb--dotted brdr-clr-gray-07 Injuries__groupDate mb2">May 21</div>
    <div class="ContentList" role="list">
      <div class="ContentList__Item" role="listitem">
        <a href="https://www.espn.com/nba/player/_/id/4593803/jalen-williams" class="Athlete db Athlete__Link clr-gray-01">
          <div class="Athlete__PlayerHeadshotWrapper flex w-100">
            <div class="Athlete__PlayerWrapper flex justify-center flex-column Athlete__PlayerWrapper--minWidth">
              <h3 class="di flex items-baseline Athlete__Text--md">
                <span class="Athlete__PlayerName">Jalen Williams</span>
                <span class="Athlete__NameDetails ml2 clr-gray-04 di Athlete__Text--sm">G</span>
              </h3>
              <div class="flex Athlete__Text--sm"><span class="clr-gray-04">Status</span><span class="TextStatus TextStatus--yellow Athlete__Text--sm-emph ml2">Day-to-day</span></div>
              <div class="pt3 clr-gray-04 Athlete__Text--md">Williams (hamstring) is questionable for Friday&#x27;s game.</div>
            </div>
          </div>
        </a>
      </div>
    </div>
  `;

  const injuries = extractEspnTeamInjuries(html);

  assert.equal(injuries.length, 1);
  assert.deepEqual(injuries[0], {
    dateLabel: 'May 21',
    playerName: 'Jalen Williams',
    position: 'G',
    status: 'Day-to-day',
    note: "Williams (hamstring) is questionable for Friday's game.",
    playerUrl: 'https://www.espn.com/nba/player/_/id/4593803/jalen-williams'
  });
});

test('buildOpenMeteoEventWeatherSnapshot selects the closest hourly forecast row', () => {
  const snapshot = buildOpenMeteoEventWeatherSnapshot({
    utc_offset_seconds: 0,
    hourly: {
      time: ['2026-05-22T17:00', '2026-05-22T18:00', '2026-05-22T19:00'],
      temperature_2m: [16.1, 15.4, 14.8],
      precipitation_probability: [10, 20, 35],
      precipitation: [0, 0.2, 1.1],
      wind_speed_10m: [12.4, 15.2, 18.8],
      wind_gusts_10m: [18.1, 22.3, 28.4],
      weather_code: [1, 2, 61]
    }
  }, '2026-05-22T18:20:00.000Z');

  assert.deepEqual(snapshot, {
    forecastTime: '2026-05-22T18:00',
    temperatureC: 15.4,
    precipitationProbability: 20,
    precipitationMm: 0.2,
    windSpeedKmh: 15.2,
    windGustsKmh: 22.3,
    weatherCode: 2
  });
});

test('extractEspnPlayerBoxscoreStats preserves generic stat keys for MLB and NFL prop grading', () => {
  const playerStats = extractEspnPlayerBoxscoreStats({
    boxscore: {
      players: [{
        team: {
          displayName: 'Cleveland Guardians'
        },
        statistics: [{
          keys: ['hits-atBats', 'atBats', 'runs', 'hits', 'RBIs', 'homeRuns', 'walks', 'strikeouts'],
          athletes: [{
            athlete: {
              displayName: 'Steven Kwan'
            },
            stats: ['2-4', '4', '1', '2', '1', '0', '0', '1']
          }]
        }, {
          keys: ['fullInnings.partInnings', 'hits', 'runs', 'earnedRuns', 'walks', 'strikeouts'],
          athletes: [{
            athlete: {
              displayName: 'Logan Allen'
            },
            stats: ['5.0', '4', '2', '2', '1', '7']
          }]
        }]
      }, {
        team: {
          displayName: 'Philadelphia Eagles'
        },
        statistics: [{
          keys: ['completions/passingAttempts', 'passingYards', 'yardsPerPassAttempt'],
          athletes: [{
            athlete: {
              displayName: 'Jalen Hurts'
            },
            stats: ['20/28', '246', '8.8']
          }]
        }, {
          keys: ['rushingAttempts', 'rushingYards', 'yardsPerRushAttempt'],
          athletes: [{
            athlete: {
              displayName: 'Saquon Barkley'
            },
            stats: ['15', '118', '7.9']
          }]
        }]
      }]
    }
  });

  const byName = new Map(playerStats.map((player) => [player.playerName, player]));

  assert.equal(byName.get('Steven Kwan')?.statValues?.hits, 2);
  assert.equal(byName.get('Logan Allen')?.statValues?.strikeouts, 7);
  assert.equal(byName.get('Jalen Hurts')?.statValues?.passingYards, 246);
  assert.equal(byName.get('Saquon Barkley')?.statValues?.rushingYards, 118);
});

test('extractEspnPlayerBoxscoreStats preserves duplicate player names when they belong to different teams', () => {
  const playerStats = extractEspnPlayerBoxscoreStats({
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
  });

  const alexSmithRows = playerStats
    .filter((player) => player.playerName === 'Alex Smith')
    .map((player) => `${player.teamName}:${player.points}`)
    .sort();

  assert.deepEqual(alexSmithRows, ['Away Team:9', 'Home Team:22']);
});

test('parseNrlOfficialMatchData joins roster names to official player stats and derives first-half scores', () => {
  const parsed = parseNrlOfficialMatchData({
    match: {
      matchId: '20261111210',
      matchMode: 'Post',
      matchState: 'FullTime',
      startTime: '2026-05-22T09:50:00Z',
      segmentDuration: 2400,
      homeTeam: {
        teamId: 500010,
        name: 'Canterbury Bulldogs',
        score: 30,
        players: [{
          playerId: 500101,
          firstName: 'Matt',
          lastName: 'Burton'
        }]
      },
      awayTeam: {
        teamId: 500011,
        name: 'Melbourne Storm',
        score: 20,
        players: [{
          playerId: 500202,
          firstName: 'Nick',
          lastName: 'Meaney'
        }]
      },
      stats: {
        players: {
          homeTeam: [{
            playerId: 500101,
            tries: 1,
            conversions: 1,
            points: 6
          }],
          awayTeam: [{
            playerId: 500202,
            tries: 0,
            conversions: 2,
            points: 4
          }],
          meta: []
        }
      },
      timeline: [{
        gameSeconds: 120,
        homeScore: 4,
        awayScore: 0
      }, {
        gameSeconds: 240,
        homeScore: 6,
        awayScore: 0
      }, {
        gameSeconds: 900,
        homeScore: 6,
        awayScore: 6
      }, {
        gameSeconds: 1800,
        homeScore: 12,
        awayScore: 12
      }, {
        gameSeconds: 2500,
        homeScore: 18,
        awayScore: 12
      }]
    }
  }, 'https://example.test/nrl-match-centre');

  assert.equal(parsed.event.state, 'post');
  assert.equal(parsed.event.homeLinescores[0]?.value, 12);
  assert.equal(parsed.event.awayLinescores[0]?.value, 12);
  assert.equal(parsed.playerStats.find((player) => player.playerName === 'Matt Burton')?.points, 6);
  assert.equal(parsed.playerStats.find((player) => player.playerName === 'Nick Meaney')?.points, 4);
});

test('parseAflOfficialMatch and extractAflOfficialPlayerStats normalize club names and disposals', () => {
  const event = parseAflOfficialMatch({
    id: 8130,
    providerId: 'CD_M20260141101',
    utcStartTime: '2026-05-21T09:30:00.000+0000',
    status: 'CONCLUDED',
    home: {
      team: {
        id: 9,
        providerId: 'CD_T80',
        name: 'Hawthorn',
        club: {
          name: 'Hawthorn'
        }
      },
      score: {
        totalScore: 75
      }
    },
    away: {
      team: {
        id: 1,
        providerId: 'CD_T10',
        name: 'Kuwarna',
        club: {
          name: 'Adelaide Crows'
        }
      },
      score: {
        totalScore: 66
      }
    }
  });
  const playerStats = extractAflOfficialPlayerStats({
    homeTeamPlayerStats: [{
      teamId: 'CD_T80',
      playerStats: {
        player: {
          playerId: 'CD_I298800',
          playerName: {
            givenName: 'Josh',
            surname: 'Ward'
          }
        },
        stats: {
          disposals: 24,
          kicks: 8,
          handballs: 16
        }
      }
    }],
    awayTeamPlayerStats: []
  }, event);

  assert.equal(event.awayTeam, 'Adelaide Crows');
  assert.equal(playerStats[0]?.playerName, 'Josh Ward');
  assert.equal(playerStats[0]?.teamName, 'Hawthorn');
  assert.equal(playerStats[0]?.disposals, 24);
  assert.equal(playerStats[0]?.statValues?.kicks, 8);
  assert.equal(playerStats[0]?.statValues?.handballs, 16);
});

test('extractFlashscoreInitialFeed and parseFlashscoreResultsFeed parse NRL and AFL score rows from summary-results feeds', () => {
  const nrlHtml = [
    '<script>',
    '  cjs.initialFeeds["summary-results"] = {',
    '    data: `SA÷19¬~AA÷bNAvB0TQ¬AD÷1779444000¬AF÷Melbourne Storm¬PY÷A5vFzpKg¬AU÷20¬AH÷20¬WM÷CAN¬PX÷MihOHrkJ¬AE÷Canterbury Bulldogs¬AT÷30¬AG÷30`',
    '  };',
    '</script>'
  ].join('\n');
  const aflFeed = 'SA÷18¬~AA÷h8jZNQOb¬AD÷1779355800¬AF÷Adelaide Crows¬PY÷EkLNcDca¬PRN÷66¬WM÷HAW¬PX÷W29W16Jc¬AE÷Hawthorn Hawks¬PRN÷75';

  const nrlEvents = parseFlashscoreResultsFeed(
    extractFlashscoreInitialFeed(nrlHtml),
    'https://example.test/nrl-results'
  );
  const aflEvents = parseFlashscoreResultsFeed(aflFeed, 'https://example.test/afl-results');

  assert.equal(nrlEvents.length, 1);
  assert.equal(nrlEvents[0]?.awayTeam, 'Melbourne Storm');
  assert.equal(nrlEvents[0]?.awayScore, 20);
  assert.equal(nrlEvents[0]?.homeTeam, 'Canterbury Bulldogs');
  assert.equal(nrlEvents[0]?.homeScore, 30);
  assert.equal(nrlEvents[0]?.state, 'post');

  assert.equal(aflEvents.length, 1);
  assert.equal(aflEvents[0]?.awayTeam, 'Adelaide Crows');
  assert.equal(aflEvents[0]?.awayScore, 66);
  assert.equal(aflEvents[0]?.homeTeam, 'Hawthorn Hawks');
  assert.equal(aflEvents[0]?.homeScore, 75);
  assert.equal(aflEvents[0]?.sourceUrl, 'https://example.test/afl-results');
});