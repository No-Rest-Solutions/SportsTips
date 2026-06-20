import { buildDailyTrackerSummary, buildMlbLedgerConfig } from '../bot-tracker.mjs';
import { buildAutomatedMessage, sendWebhookMessage } from '../discord.mjs';
import { getDateKey } from '../scheduler.mjs';

function formatUnits(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}u` : '0.00u';
}

function formatSignedUnits(value) {
  return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}u` : '0.00u';
}

function formatAud(value) {
  return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)} AUD` : '$0.00 AUD';
}

function formatSignedAud(value) {
  return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}$${Number(value).toFixed(2)} AUD` : '$0.00 AUD';
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : 'N/A';
}

function formatSportPerformanceMessage(summary) {
  if (!Array.isArray(summary?.sportTotals) || !summary.sportTotals.length) {
    return '- No settled sport performance yet.';
  }

  const visibleSportTotals = summary.sportTotals
    .filter((item) => Number(item?.wins || 0) + Number(item?.losses || 0) + Number(item?.returns || 0) > 0 || Number(item?.totalNetUnits || 0) !== 0)
    .slice(0, 12);

  if (!visibleSportTotals.length) {
    return '- No settled sport performance yet.';
  }

  const lines = visibleSportTotals.map((item) => {
    const record = `${Number(item.wins || 0)}W / ${Number(item.losses || 0)}L${Number(item.returns || 0) > 0 ? ` / ${Number(item.returns || 0)}R` : ''}`;
    return `${item.sport}: ${formatSignedUnits(item.totalNetUnits)} | ${record} | ${formatPercent(item.winLossPercent)}`;
  });

  if (summary.sportTotals.length > visibleSportTotals.length) {
    lines.push(`+${summary.sportTotals.length - visibleSportTotals.length} more sports`);
  }

  return lines.join('\n');
}

function buildSummaryMessage(summary) {
  return {
    content: '',
    embeds: [{
      title: `Unit Report | Day ${summary.trackerDayNumber || 1}`,
      color: 0x1d4ed8,
      description: `High-level bankroll test summary through ${summary.currentDayDateKey || 'today'}, focused on bankroll, hit rate, and ROI against the starting bank.`,
      fields: [
        {
          name: 'Overview',
          value: [
            `Starting Bankroll: ${formatUnits(summary.startingBankrollUnits)} | ${formatAud(summary.startingBankrollAud)}`,
            `Current Bankroll: ${formatUnits(summary.currentUnits)} | ${formatAud(summary.currentAud)}`,
            `Net Profit/Loss: ${formatSignedUnits(summary.totalNetUnits)} | ${formatSignedAud(summary.totalNetAud)}`,
            `Open Exposure: ${formatUnits(summary.openExposureUnits)} | ${formatAud(summary.openExposureAud)}`,
            `Day: ${summary.trackerDayNumber || 1} | Date: ${summary.currentDayDateKey || 'Unknown'}`
          ].join('\n'),
          inline: false
        },
        {
          name: 'Performance',
          value: [
            `Record: ${summary.rollingRecord.wins} Wins / ${summary.rollingRecord.losses} Losses / ${summary.rollingRecord.returns} Returns`,
            `Hit Rate: ${formatPercent(summary.rollingHitRatePercent)}`,
            `30 Day ROI: ${formatPercent(summary.rollingBankrollRoiPercent)}`
          ].join('\n'),
          inline: false
        },
        {
          name: 'By Sport',
          value: formatSportPerformanceMessage(summary),
          inline: false
        },
        {
          name: 'Extra Info',
          value: [
            `Lifetime Placed: ${formatUnits(summary.lifetimePlacedUnits)} | ${formatAud(summary.lifetimePlacedAud)}`,
            `Lifetime Settled: ${formatUnits(summary.totalSettledStakeUnits)} | ${formatAud(summary.totalSettledStakeAud)}`
          ].join('\n'),
          inline: false
        }
      ],
      footer: {
        text: `30 Day ROI is net profit divided by the starting bankroll (${formatUnits(summary.startingBankrollUnits)}). Settlements are posted separately in the results channel.`
      }
    }]
  };
}

async function postLedgerSummary(ledgerConfig, now, dryRun, label) {
  const summary = await buildDailyTrackerSummary(ledgerConfig, now);

  if (!summary) {
    return null;
  }

  const webhookChannel = ledgerConfig.bankrollTracker?.summaryWebhook || 'unitReport';
  const webhookUrl = ledgerConfig.discord?.webhooks?.[webhookChannel] || ledgerConfig.discord?.webhooks?.results;

  // The ledger's summary webhook may be unconfigured (e.g. the MLB report channel
  // isn't set yet). Skip the post rather than throwing — an unhandled throw here
  // aborts the daemon's job run (the "turns off automatically" crash).
  if (!dryRun && !webhookUrl) {
    return null;
  }

  const automatedMessage = buildAutomatedMessage(ledgerConfig, webhookChannel, buildSummaryMessage(summary));

  await sendWebhookMessage(
    webhookUrl,
    {
      content: automatedMessage.content,
      embeds: automatedMessage.embeds,
      username: ledgerConfig.discord.username,
      avatar_url: ledgerConfig.discord.avatarUrl || undefined,
      allowed_mentions: automatedMessage.allowedMentions
    },
    {
      dryRun,
      label
    }
  );

  return summary;
}

export async function runTrackerSummaryJob(context) {
  const { config, state, dryRun } = context;
  const now = new Date();
  const dateKey = getDateKey(now, config.timezone);

  // Main bankroll summary, then the isolated MLB ledger summary (only posts once the
  // MLB ledger has activity).
  const summary = await postLedgerSummary(config, now, dryRun, 'daily tracker summary');
  const mlbSummary = await postLedgerSummary(buildMlbLedgerConfig(config), now, dryRun, 'daily MLB tracker summary');

  state.jobs.trackerSummary = {
    lastRunDate: dateKey,
    lastRunAt: now.toISOString(),
    sourceDateKey: summary?.summaryDateKey || null
  };

  return {
    job: 'trackerSummary',
    posted: (summary ? 1 : 0) + (mlbSummary ? 1 : 0)
  };
}