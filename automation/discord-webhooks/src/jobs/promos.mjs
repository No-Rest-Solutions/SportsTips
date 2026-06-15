/**
 * Promos Job - Daemon Integration
 *
 * Handles scheduled promo generation and settlement:
 * 1. Daily promo slip generation from the live market snapshot
 * 2. Continuous settlement checking throughout the day
 * 3. Discord posting of slips and settlements (per-promo webhooks)
 * 4. Report generation and logging
 *
 * Jobs take the standard daemon `context` ({ config, state, dryRun }) and accept
 * an `overrides` bag so tests can inject a snapshot / candidates / leg results
 * and run fully offline.
 */

import { getActivePromos, getPromoById } from '../promos-config.mjs';
import { generatePromoSlip } from '../promos-generator.mjs';
import { buildPromoCandidatesFromSnapshot } from '../promos-candidates.mjs';
import { fetchPromoLegResults } from '../promos-grading.mjs';
import { settlePromoSlip, getUnresolvedSettlements, SETTLEMENT_STATUS } from '../promos-settlement.mjs';
import { buildPromoEmbedMessage, buildSettlementEmbedMessage, buildDailyPromoReport } from '../promos-formatter.mjs';
import { sendWebhookMessage } from '../discord.mjs';
import { ensureFreshScrapedSnapshot } from '../web-market-intake.mjs';
import { getDateKey } from '../scheduler.mjs';
import { loadState } from '../state.mjs';

/**
 * Record a job's run marker on daemon state so the scheduler's daily/interval
 * gating works. No-op when there is no state (e.g. unit tests pass {}).
 * @param {Object} context
 * @param {string} key - state.jobs key (e.g. 'promosGeneration')
 * @param {Object} config
 */
function stampJobRun(context, key, config) {
  if (!context?.state) {
    return;
  }
  context.state.jobs = context.state.jobs || {};
  const now = new Date();
  context.state.jobs[key] = {
    lastRunAt: now.toISOString(),
    lastRunDate: getDateKey(now, config?.timezone || 'UTC')
  };
}

/**
 * Resolve the Discord webhook URL for a promo, by its configured channel key.
 * Falls back to the legacy single promos webhook, then the shared picks webhook.
 * @param {Object} config
 * @param {Object} promo - has optional `webhook` channel key
 * @returns {string}
 */
function resolvePromoWebhookUrl(config, promo) {
  const webhooks = config?.discord?.webhooks || {};
  return (promo?.webhook && webhooks[promo.webhook]) || config?.promosWebhookUrl || webhooks.picks || '';
}

/**
 * Build promo candidate legs from a fresh market snapshot.
 * Returns [] cleanly when market scraping isn't configured (e.g. in tests).
 * @param {Object} context - { config, state }
 * @param {Array} activePromos
 * @param {Object} overrides - { snapshot }
 * @returns {Promise<Array>}
 */
async function buildCandidatesForPromos(context, activePromos, overrides = {}) {
  const config = context?.config;

  if (!config?.marketScrape || !Array.isArray(config?.sports)) {
    return [];
  }

  const snapshot = overrides.snapshot
    || await ensureFreshScrapedSnapshot(context, new Date(), { force: overrides.forceSnapshotRefresh });

  if (!snapshot?.quotes?.length) {
    return [];
  }

  const sports = [...new Set(activePromos.map((promo) => String(promo.sport).toLowerCase()))];
  return buildPromoCandidatesFromSnapshot(config, snapshot, { sports });
}

/**
 * Daily promo generation job.
 * @param {Object} context - Daemon context ({ config, state, dryRun })
 * @param {Object} overrides - Test injection ({ candidates, snapshot })
 * @returns {Promise<Object>} Job result
 */
export async function runPromoGenerationJob(context = {}, overrides = {}) {
  const startTime = Date.now();
  const config = context.config || {};
  const result = {
    jobType: 'promo-generation',
    startedAt: new Date().toISOString(),
    posted: 0,
    slipsGenerated: 0,
    errors: []
  };

  try {
    const activePromos = await getActivePromos();

    if (activePromos.length === 0) {
      result.message = 'No active promos for today';
      result.duration = Date.now() - startTime;
      return result;
    }

    const candidates = overrides.candidates || await buildCandidatesForPromos(context, activePromos, overrides);

    for (const promo of activePromos) {
      try {
        const slip = await generatePromoSlip(promo.id, candidates);
        result.slipsGenerated++;

        // Post to the promo's own Discord channel.
        const webhookUrl = resolvePromoWebhookUrl(config, promo);
        if (webhookUrl && !context.dryRun) {
          const embed = buildPromoEmbedMessage(slip);
          await sendWebhookMessage(webhookUrl, {
            content: `🎯 **New Promo:** ${promo.id}`,
            embeds: [embed]
          });
          result.posted++;
        }

        console.log(`[promos-job] Generated promo slip: ${slip.id}`);
      } catch (err) {
        result.errors.push({ promoId: promo.id, error: err.message });
        console.error(`[promos-job] Failed to generate promo ${promo.id}: ${err.message}`);
      }
    }

    result.message = `Generated ${result.slipsGenerated} promo slips`;
    result.succeeded = true;
  } catch (err) {
    result.error = err.message;
    result.succeeded = false;
    console.error(`[promos-job] Job failed: ${err.message}`);
  } finally {
    stampJobRun(context, 'promosGeneration', config);
  }

  result.duration = Date.now() - startTime;
  return result;
}

/**
 * Promo settlement job - settles generated slips against finalized results.
 * @param {Object} context - Daemon context
 * @param {Object} overrides - Test injection ({ fetchLegResults })
 * @returns {Promise<Object>} Job result
 */
export async function runPromoSettlementJob(context = {}, overrides = {}) {
  const startTime = Date.now();
  const config = context.config || {};
  const fetchLegResults = overrides.fetchLegResults || fetchPromoLegResults;
  const result = {
    jobType: 'promo-settlement',
    startedAt: new Date().toISOString(),
    posted: 0,
    slipsSettled: 0,
    errors: [],
    unresolved: 0
  };

  try {
    const state = await loadState();
    const promoTracking = state.tracking?.promos || {};

    // Settle freshly generated slips (no settlement yet) and any still-partial ones.
    const toSettle = Object.values(promoTracking).filter((entry) => {
      if (!entry?.promoSnapshot) {
        return false;
      }
      const status = entry.settlement?.status;
      return !status || status === SETTLEMENT_STATUS.PARTIAL || status === SETTLEMENT_STATUS.PENDING;
    });

    if (toSettle.length === 0) {
      result.message = 'No unsettled promos to process';
      result.duration = Date.now() - startTime;
      return result;
    }

    for (const entry of toSettle) {
      try {
        const snapshot = entry.promoSnapshot;
        const legResults = await fetchLegResults(context, snapshot.legs || [], overrides);
        const updated = await settlePromoSlip(snapshot.id, snapshot, legResults);
        result.slipsSettled++;

        // Post once the slip resolves (settled or insured-refund).
        const isResolved = updated.status === SETTLEMENT_STATUS.SETTLED
          || updated.status === SETTLEMENT_STATUS.REFUNDED;

        if (isResolved && !context.dryRun) {
          const promo = await getPromoById(updated.promoId);
          const webhookUrl = resolvePromoWebhookUrl(config, promo);
          if (webhookUrl) {
            const embed = buildSettlementEmbedMessage(updated);
            await sendWebhookMessage(webhookUrl, {
              content: `📊 **Promo Settled:** ${String(updated.outcome).toUpperCase()}`,
              embeds: [embed]
            });
            result.posted++;
          }
        }

        console.log(`[promos-job] Settled promo ${snapshot.id}: ${updated.status}/${updated.outcome}`);
      } catch (err) {
        result.errors.push({ slipId: entry.promoSnapshot?.id, error: err.message });
        console.error(`[promos-job] Settlement failed: ${err.message}`);
      }
    }

    const stillUnresolved = await getUnresolvedSettlements();
    result.unresolved = stillUnresolved.length;
    result.message = `Settled ${result.slipsSettled} promos, ${result.unresolved} still unresolved`;
    result.succeeded = true;
  } catch (err) {
    result.error = err.message;
    result.succeeded = false;
    console.error(`[promos-job] Settlement job failed: ${err.message}`);
  } finally {
    stampJobRun(context, 'promosSettlement', config);
  }

  result.duration = Date.now() - startTime;
  return result;
}

/**
 * Daily report generation job.
 * @param {Object} context - Daemon context
 * @returns {Promise<Object>} Job result
 */
export async function runPromoReportJob(context = {}) {
  const startTime = Date.now();
  const config = context.config || {};
  const result = {
    jobType: 'promo-report',
    startedAt: new Date().toISOString(),
    posted: 0
  };

  try {
    const state = await loadState();
    const promoTracking = state.tracking?.promos || {};

    const slips = Object.values(promoTracking)
      .filter((entry) => entry.promoSnapshot)
      .map((entry) => entry.promoSnapshot);

    const settlements = Object.values(promoTracking)
      .filter((entry) => entry.settlement)
      .map((entry) => entry.settlement);

    const report = buildDailyPromoReport(slips, settlements);
    const reportWebhookUrl = config.promosWebhookUrl || config?.discord?.webhooks?.unitReport || '';

    if (reportWebhookUrl && report && !context.dryRun) {
      await sendWebhookMessage(reportWebhookUrl, {
        content: `📋 **Daily Promo Report**\n\`\`\`\n${report}\n\`\`\``
      });
      result.posted++;
    }

    result.message = 'Daily report generated';
    result.slipsCount = slips.length;
    result.settlementsCount = settlements.length;
    result.succeeded = true;
  } catch (err) {
    result.error = err.message;
    result.succeeded = false;
    console.error(`[promos-job] Report job failed: ${err.message}`);
  } finally {
    stampJobRun(context, 'promosReport', config);
  }

  result.duration = Date.now() - startTime;
  return result;
}

export const __testables = {
  runPromoGenerationJob,
  runPromoSettlementJob,
  runPromoReportJob,
  resolvePromoWebhookUrl,
  buildCandidatesForPromos
};
