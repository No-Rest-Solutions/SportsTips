const USER_AGENT = 'SportsTipsDiscordWebhook/1.0';
const PICK_ROLE_CHANNEL_MAP = new Map([
  ['picks', 'shared'],
  ['picksNba', 'nba'],
  ['picksMlb', 'mlb'],
  ['picksAfl', 'afl'],
  ['picksNrl', 'nrl'],
  ['picksNfl', 'nfl'],
  ['picksEpl', 'epl'],
  ['picksOther', 'other']
]);

function buildWebhookApiUrl(webhookUrl, messageId = '') {
  const url = new URL(webhookUrl);
  const trimmedPath = url.pathname.replace(/\/$/, '');

  if (messageId) {
    url.pathname = `${trimmedPath}/messages/${encodeURIComponent(messageId)}`;
    url.search = '';
    return url;
  }

  url.pathname = trimmedPath;
  url.searchParams.set('wait', 'true');
  return url;
}

function normalizeRoleMentionText(value) {
  const trimmed = String(value || '').trim();

  if (!trimmed) {
    return '';
  }

  if (/^\d+$/.test(trimmed)) {
    return `<@&${trimmed}>`;
  }

  return trimmed;
}

function normalizeSportRoleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function extractRoleMentionIds(value) {
  const matches = String(value || '').matchAll(/<@&(\d+)>/g);
  return [...new Set([...matches].map((match) => match[1]).filter(Boolean))];
}

function isOtherSportRoleBucket(sportKey) {
  if (!sportKey) {
    return false;
  }

  return sportKey === 'nhl'
    || sportKey.startsWith('tennis')
    || (sportKey.startsWith('soccer') && sportKey !== 'soccer_epl');
}

function resolvePickRoleKey(channel, context = {}) {
  if (channel !== 'picks' && PICK_ROLE_CHANNEL_MAP.has(channel)) {
    return PICK_ROLE_CHANNEL_MAP.get(channel);
  }

  if (channel !== 'picks') {
    return null;
  }

  const sportKey = normalizeSportRoleKey(context.sport);

  if (!sportKey) {
    return 'shared';
  }

  if (['nba', 'mlb', 'afl', 'nrl', 'nfl'].includes(sportKey)) {
    return sportKey;
  }

  if (sportKey === 'soccer_epl' || sportKey === 'epl') {
    return 'epl';
  }

  if (isOtherSportRoleBucket(sportKey)) {
    return 'other';
  }

  return 'shared';
}

function resolveRoleMentionText(roleMentions, channel, context = {}) {
  const pickRoleKey = resolvePickRoleKey(channel, context);

  if (pickRoleKey) {
    const picks = roleMentions?.picks;

    if (picks && typeof picks === 'object') {
      const specificMention = pickRoleKey === 'shared'
        ? ''
        : normalizeRoleMentionText(picks[pickRoleKey]);
      const sharedMention = normalizeRoleMentionText(picks.shared);

      if (specificMention || sharedMention) {
        return specificMention || sharedMention;
      }
    }
  }

  if (channel === 'slates') {
    // Per-sport daily-slate pings reuse that sport's PICKS role (e.g. the NBA
    // slate tags the NBA picks role), falling back to the single slates role.
    const sportRoleKey = context.sport ? resolvePickRoleKey('picks', context) : null;
    const picks = roleMentions?.picks;

    if (sportRoleKey && picks && typeof picks === 'object') {
      const specificMention = sportRoleKey === 'shared' ? '' : normalizeRoleMentionText(picks[sportRoleKey]);
      const sharedMention = normalizeRoleMentionText(picks.shared);

      if (specificMention || sharedMention) {
        return specificMention || sharedMention;
      }
    }

    const slateMention = normalizeRoleMentionText(roleMentions?.slates);

    if (slateMention) {
      return slateMention;
    }
  }

  const legacyChannels = Array.isArray(roleMentions?.channels) ? roleMentions.channels : [];
  const legacyChannel = pickRoleKey
    ? 'picks'
    : (channel === 'unitTracking' ? 'results' : channel);

  if (!legacyChannels.includes(legacyChannel)) {
    return '';
  }

  return normalizeRoleMentionText(roleMentions?.text);
}

function normalizeMessagePayload(message) {
  if (typeof message === 'string') {
    return {
      content: message,
      embeds: undefined
    };
  }

  if (message && typeof message === 'object') {
    return {
      content: String(message.content || ''),
      embeds: Array.isArray(message.embeds) && message.embeds.length ? message.embeds : undefined
    };
  }

  return {
    content: '',
    embeds: undefined
  };
}

export function buildAutomatedMessage(config, channel, message, context = {}) {
  const normalized = normalizeMessagePayload(message);
  const roleMentions = config.discord?.roleMentions;

  if (!roleMentions?.enabled) {
    return {
      content: normalized.content,
      embeds: normalized.embeds,
      allowedMentions: { parse: [] }
    };
  }

  const mentionText = resolveRoleMentionText(roleMentions, channel, context);

  if (!mentionText) {
    return {
      content: normalized.content,
      embeds: normalized.embeds,
      allowedMentions: { parse: [] }
    };
  }

  return {
    content: normalized.content ? `${mentionText}\n${normalized.content}` : mentionText,
    embeds: normalized.embeds,
    allowedMentions: extractRoleMentionIds(mentionText).length
      ? {
        parse: [],
        roles: extractRoleMentionIds(mentionText)
      }
      : { parse: [] }
  };
}

export async function sendWebhookMessage(webhookUrl, payload, options = {}) {
  const finalPayload = {
    ...payload,
    allowed_mentions: payload.allowed_mentions || {
      parse: []
    }
  };

  if (options.dryRun) {
    console.log(`\n[dry-run] ${options.label || 'webhook message'}`);

    if (finalPayload.content) {
      console.log(finalPayload.content);
    }

    if (Array.isArray(finalPayload.embeds) && finalPayload.embeds.length) {
      console.log(JSON.stringify({ embeds: finalPayload.embeds }, null, 2));
    }

    return null;
  }

  if (!webhookUrl) {
    throw new Error(`Missing webhook URL for ${options.label || 'message'}.`);
  }

  const url = buildWebhookApiUrl(webhookUrl);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify(finalPayload)
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed (${response.status}): ${await response.text()}`);
  }

  return response.status === 204 ? null : response.json();
}

export async function deleteWebhookMessage(webhookUrl, messageId, options = {}) {
  if (!messageId) {
    return null;
  }

  if (options.dryRun) {
    console.log(`\n[dry-run] ${options.label || 'delete webhook message'}`);
    console.log(`Delete message: ${messageId}`);
    return null;
  }

  if (!webhookUrl) {
    throw new Error(`Missing webhook URL for ${options.label || 'message delete'}.`);
  }

  const response = await fetch(buildWebhookApiUrl(webhookUrl, messageId), {
    method: 'DELETE',
    headers: {
      'User-Agent': USER_AGENT
    }
  });

  if (!response.ok) {
    throw new Error(`Discord webhook delete failed (${response.status}): ${await response.text()}`);
  }

  return null;
}