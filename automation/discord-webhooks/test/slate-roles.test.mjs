import test from 'node:test';
import assert from 'node:assert';
import { buildAutomatedMessage } from '../src/discord.mjs';

const config = {
  discord: {
    roleMentions: {
      enabled: true,
      slates: '111',
      picks: { nba: '222', afl: '444', other: '333' }
    }
  }
};

const slate = { content: 'Daily slate', embeds: [] };

test('per-sport slate pings reuse the sport picks role', async (t) => {
  await t.test('NBA slate tags the NBA picks role', () => {
    const msg = buildAutomatedMessage(config, 'slates', slate, { sport: 'nba' });
    assert.ok(msg.content.includes('<@&222>'));
    assert.deepEqual(msg.allowedMentions.roles, ['222']);
  });

  await t.test('AFL slate tags the AFL picks role', () => {
    const msg = buildAutomatedMessage(config, 'slates', slate, { sport: 'afl' });
    assert.deepEqual(msg.allowedMentions.roles, ['444']);
  });

  await t.test('tennis/nhl/UCL slates tag the Other picks role', () => {
    assert.deepEqual(buildAutomatedMessage(config, 'slates', slate, { sport: 'tennis_atp' }).allowedMentions.roles, ['333']);
    assert.deepEqual(buildAutomatedMessage(config, 'slates', slate, { sport: 'nhl' }).allowedMentions.roles, ['333']);
    assert.deepEqual(buildAutomatedMessage(config, 'slates', slate, { sport: 'soccer_uefa_champs_league' }).allowedMentions.roles, ['333']);
  });

  await t.test('a sport with no specific picks role falls back to the slates role', () => {
    const msg = buildAutomatedMessage(config, 'slates', slate, { sport: 'mlb' });
    assert.deepEqual(msg.allowedMentions.roles, ['111']);
  });

  await t.test('no sport context falls back to the slates role', () => {
    const msg = buildAutomatedMessage(config, 'slates', slate, {});
    assert.deepEqual(msg.allowedMentions.roles, ['111']);
  });
});
