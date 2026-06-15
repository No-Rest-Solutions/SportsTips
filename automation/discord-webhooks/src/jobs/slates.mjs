import { buildAutomatedMessage, sendWebhookMessage } from '../discord.mjs';
import { formatSlateMessages } from '../formatters.mjs';
import { fetchSportsGameOddsSlate } from '../providers/sports-game-odds.mjs';
import { getDateKey } from '../scheduler.mjs';
import { canUseSportsGameOdds, recordSportsGameOddsUsage } from '../sports-game-odds-fallback.mjs';
import { buildSnapshotSlateEvents, ensureFreshScrapedSnapshot } from '../web-market-intake.mjs';

function getSlateEventDateKey(startTime, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(startTime));
}

function selectActionableSlate(events, config, preferredDateKey, now) {
  const lookaheadHours = Number(config.analysis?.lookaheadHours || 36);
  const latestStartMs = now.getTime() + lookaheadHours * 60 * 60 * 1000;
  const upcoming = Array.isArray(events)
    ? events.filter((event) => {
        const startMs = new Date(event?.startTime || '').getTime();
        const state = String(event?.state || 'pre').toLowerCase();

        if (!Number.isFinite(startMs) || startMs < now.getTime() || startMs > latestStartMs) {
          return false;
        }

        return state !== 'in' && state !== 'post';
      })
    : [];

  if (!upcoming.length) {
    return {
      dateKey: preferredDateKey,
      events: []
    };
  }

  const grouped = new Map();

  for (const event of upcoming) {
    const eventDateKey = getSlateEventDateKey(event.startTime, config.timezone);
    const bucket = grouped.get(eventDateKey);

    if (bucket) {
      bucket.push(event);
      continue;
    }

    grouped.set(eventDateKey, [event]);
  }

  if (grouped.has(preferredDateKey)) {
    return {
      dateKey: preferredDateKey,
      events: grouped.get(preferredDateKey)
    };
  }

  const nextDateKey = [...grouped.keys()].sort()[0] || preferredDateKey;

  return {
    dateKey: nextDateKey,
    events: grouped.get(nextDateKey) || []
  };
}

export async function runSlatesJob(context, overrides = {}) {
  const { config, state, dryRun } = context;
  const now = new Date();
  const dateKey = getDateKey(now, config.timezone);
  const snapshot = overrides.snapshot || await ensureFreshScrapedSnapshot(context, now, {
    force: overrides.forceSnapshotRefresh
  });
  let posted = 0;
  let fallbackUsed = false;
  let targetDateKey = dateKey;
  const canUseFallback = overrides.canUseSportsGameOdds || canUseSportsGameOdds;
  const fetchFallbackSlate = overrides.fetchSportsGameOddsSlate || fetchSportsGameOddsSlate;

  for (const sport of config.sports.filter((item) => item.enabled && (item.marketKey || item.key))) {
    const snapshotEvents = snapshot?.quotes?.length
      ? buildSnapshotSlateEvents(snapshot, config, sport)
      : [];
    let selectedSlate = selectActionableSlate(snapshotEvents, config, dateKey, now);
    let events = selectedSlate.events;

    if (!events.length && await canUseFallback(context, 'slates')) {
      const fallbackSlate = await fetchFallbackSlate(config.sportsGameOdds, {
        leagueId: sport.sportsGameOddsLeagueId,
        timeZone: config.timezone
      });

      recordSportsGameOddsUsage(state, fallbackSlate);

      if (fallbackSlate.status === 'ok' && Array.isArray(fallbackSlate.events) && fallbackSlate.events.length) {
        selectedSlate = selectActionableSlate(fallbackSlate.events, config, dateKey, now);

        if (selectedSlate.events.length) {
          events = selectedSlate.events;
          fallbackUsed = true;
        }
      }
    }

    if (!events.length) {
      continue;
    }

    targetDateKey = selectedSlate.dateKey;

    const messages = formatSlateMessages(sport, selectedSlate.dateKey, events);

    for (const message of messages) {
      const automatedMessage = buildAutomatedMessage(config, 'slates', message, { sport: sport.key });

      await sendWebhookMessage(
        config.discord.webhooks.slates,
        {
          content: automatedMessage.content,
          embeds: automatedMessage.embeds,
          username: config.discord.username,
          avatar_url: config.discord.avatarUrl || undefined,
          allowed_mentions: automatedMessage.allowedMentions
        },
        {
          dryRun,
          label: `${sport.label} slate`
        }
      );

      posted += 1;
    }
  }

  state.jobs.slates = {
    lastRunDate: dateKey,
    lastRunAt: now.toISOString(),
    targetDateKey,
    source: fallbackUsed ? 'sports-game-odds-fallback' : 'market-scrape',
    skippedReason: posted === 0
      ? (snapshot?.quotes?.length ? 'no_actionable_slate_events' : 'market_scrape_no_quotes')
      : undefined
  };

  return {
    job: 'slates',
    posted,
    targetDateKey
  };
}