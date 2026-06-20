import path from 'node:path';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, Menu, Tray, ipcMain, shell } from 'electron';

import { buildDailyTrackerSummary, appendSettlementTrackerEntries } from '../src/bot-tracker.mjs';
import { writeSettlementsToWorkspace } from '../src/settlement-writeback.mjs';
import { buildAnalysisCandidatePool, analyzeEventWithRules, buildPickFromAnalysisDecision } from '../src/ai-pick-generator.mjs';
import { buildSnapshotEvents, loadSnapshotFile } from '../src/web-market-intake.mjs';
import { loadTabMarketMenu, getTabCanonicalMarkets } from '../src/providers/tab.mjs';
import { loadConfig, loadRawConfigFile, saveRawConfigFile } from '../src/config.mjs';
import { buildAutomatedMessage, sendWebhookMessage } from '../src/discord.mjs';
import { runForcedDailyCheck } from '../src/forced-daily-check.mjs';
import { formatPicksMessages } from '../src/formatters.mjs';
import { runAnalysisJob } from '../src/jobs/analysis.mjs';
import { runPicksJob, resolvePickWebhookChannel } from '../src/jobs/picks.mjs';
import { buildReferralCapitalPlan, runReferralsJob, setReferralVerification } from '../src/jobs/referrals.mjs';
import { runResultsJob } from '../src/jobs/results.mjs';
import { runTrackerSummaryJob } from '../src/jobs/tracker-summary.mjs';
import { runSlatesJob } from '../src/jobs/slates.mjs';
import { loadRuntimeStatus } from '../src/runtime-status.mjs';
import { getDateKey } from '../src/scheduler.mjs';
import { loadState, saveState } from '../src/state.mjs';
import { loadRawPicksFeed, saveRawPicksFeed } from '../src/picks-feed.mjs';
import { createAppIcon } from './icon.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererHtml = path.join(here, 'renderer.html');
const preloadPath = path.join(here, 'preload.mjs');
const smokeTest = process.argv.includes('--smoke-test');
const runtimeFreshMs = 150000;
const ANALYSIS_ENGINES = new Set(['rules', 'auto', 'openai']);
const ROLE_MENTION_PICK_FIELDS = ['shared', 'nba', 'mlb', 'afl', 'nrl', 'nfl', 'epl', 'other'];
const WEBHOOK_FIELDS = [
  'slates',
  'picks',
  'picksNba',
  'picksMlb',
  'picksAfl',
  'picksNrl',
  'picksNfl',
  'picksEpl',
  'picksOther',
  'referralsNew',
  'referralsUpdatedTerms',
  'referralsCancelled',
  'referralsMasterlist',
  'unitTracking',
  'unitReport',
  'mlbTracking',
  'mlbReport',
  'promoAfl',
  'promoNrl',
  'promoTennis',
  'promoSoccer',
  'evidence'
];
const WEBHOOK_LABELS = {
  slates: 'Slates webhook',
  picks: 'Shared picks fallback webhook',
  picksNba: 'NBA picks webhook',
  picksMlb: 'MLB picks webhook',
  picksAfl: 'AFL picks webhook',
  picksNrl: 'NRL picks webhook',
  picksNfl: 'NFL picks webhook',
  picksEpl: 'EPL picks webhook',
  picksOther: 'Other picks webhook',
  referralsNew: 'New referrals webhook',
  referralsUpdatedTerms: 'Updated referral terms webhook',
  referralsCancelled: 'Cancelled referrals webhook',
  referralsMasterlist: 'Referral masterlist webhook',
  unitTracking: 'Results / Unit Tracking webhook',
  unitReport: 'Unit Report webhook',
  mlbTracking: 'MLB unit tracking webhook (separate bankroll)',
  mlbReport: 'MLB unit report webhook (separate bankroll)',
  promoAfl: 'AFL promo webhook',
  promoNrl: 'NRL promo webhook',
  promoTennis: 'Tennis promo webhook',
  promoSoccer: 'Soccer promo webhook',
  evidence: 'Evidence / analysis webhook'
};
const APP_NAME = 'Tipping Bot';
const DEV_WORKSPACE_ROOT = path.resolve(here, '../../../');
const PORTABLE_BOOTSTRAP_FILES = [
  'automation/discord-webhooks/config.json',
  'automation/discord-webhooks/picks-feed.json',
  'automation/discord-webhooks/bookmaker-snapshots.json'
];

let mainWindow = null;
let tray = null;
let quitRequested = false;
let daemonProcess = null;
let refreshTimer = null;

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRuntimeLive(runtimeStatus) {
  if (!runtimeStatus?.running) {
    return false;
  }

  const heartbeatMs = runtimeStatus.heartbeatAt ? new Date(runtimeStatus.heartbeatAt).getTime() : 0;

  return isPidRunning(runtimeStatus.pid) && Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs <= runtimeFreshMs;
}

function getDaemonEntryPath() {
  if (!app.isPackaged) {
    return path.join(here, '../src/index.mjs');
  }

  const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'automation', 'discord-webhooks', 'src', 'index.mjs');

  if (existsSync(unpackedPath)) {
    return unpackedPath;
  }

  return path.join(app.getAppPath(), 'automation', 'discord-webhooks', 'src', 'index.mjs');
}

function getExplicitWorkspaceRoot() {
  const configuredRoot = String(process.env.SPORTSTIPS_WORKSPACE_ROOT || '').trim();
  return configuredRoot ? path.resolve(configuredRoot) : null;
}

function getPortableExecutableDir() {
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim();
  return portableDir ? path.resolve(portableDir) : null;
}

function looksLikeWorkspaceRoot(candidateRoot) {
  if (!candidateRoot) {
    return false;
  }

  return existsSync(path.join(candidateRoot, 'automation', 'discord-webhooks', 'config.json'));
}

function findWorkspaceRootFromExecutable() {
  // Portable builds can run from a temp extraction path, so prefer the original wrapper directory when it exists.
  let currentDir = getPortableExecutableDir() || path.dirname(process.execPath);

  while (true) {
    if (looksLikeWorkspaceRoot(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (!parentDir || parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function getPortableDataRoot() {
  return path.join(getPortableExecutableDir() || path.dirname(process.execPath), 'data');
}

function getWritableWorkspaceRoot() {
  if (!app.isPackaged) {
    return DEV_WORKSPACE_ROOT;
  }

  return getExplicitWorkspaceRoot() || findWorkspaceRootFromExecutable() || getPortableDataRoot();
}

function getBundledWorkspaceRoot() {
  if (!app.isPackaged) {
    return DEV_WORKSPACE_ROOT;
  }

  return app.getAppPath();
}

async function ensurePortableDataFiles() {
  const workspaceRoot = getWritableWorkspaceRoot();
  process.env.SPORTSTIPS_WORKSPACE_ROOT = workspaceRoot;

  if (!app.isPackaged) {
    return;
  }

  if (path.resolve(workspaceRoot) !== path.resolve(getPortableDataRoot())) {
    return;
  }

  for (const relativePath of PORTABLE_BOOTSTRAP_FILES) {
    const sourcePath = path.join(getBundledWorkspaceRoot(), relativePath);
    const destinationPath = path.join(workspaceRoot, relativePath);

    if (existsSync(destinationPath) || !existsSync(sourcePath)) {
      continue;
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
  }
}

function sanitizeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isPendingWatchPick(trackedPick) {
  const status = String(trackedPick?.status || '').toLowerCase();

  if (trackedPick?.postedAt || trackedPick?.replacementPostedAt || trackedPick?.pregameRecheckedAt) {
    return false;
  }

  return ![
    'posted_waiting_for_pregame_recheck',
    'pregame_recheck_passed',
    'replacement_posted',
    'replacement_expired',
    'cancelled'
  ].includes(status);
}

function isActiveTrackedPick(trackedPick) {
  const status = String(trackedPick?.status || '').toLowerCase();

  return ![
    'pregame_recheck_passed',
    'replacement_expired',
    'cancelled'
  ].includes(status);
}

function getWatchedTrackedPickEntries(state) {
  const trackedPickEntries = Object.entries(state.tracking?.picks || {});
  const activeTrackedPickEntries = trackedPickEntries.filter(([, trackedPick]) => isActiveTrackedPick(trackedPick));

  if (activeTrackedPickEntries.length > 0) {
    return activeTrackedPickEntries;
  }

  return trackedPickEntries.filter(([, trackedPick]) => isPendingWatchPick(trackedPick));
}

function getWatchedPickCount(state) {
  return getWatchedTrackedPickEntries(state).length;
}

function getSortableTimestamp(...values) {
  for (const value of values) {
    const parsed = Date.parse(value || '');

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.POSITIVE_INFINITY;
}

function buildPickSummaryFromLegs(legs) {
  if (!Array.isArray(legs) || !legs.length) {
    return '';
  }

  const labels = legs
    .map((leg) => sanitizeText(leg?.label))
    .filter(Boolean);

  return labels.join(' + ');
}

function buildWatchedPickDetails(state, feed) {
  const picksById = new Map((Array.isArray(feed?.picks) ? feed.picks : [])
    .map((pick) => [sanitizeText(pick?.id), pick])
    .filter(([pickId]) => pickId));

  return getWatchedTrackedPickEntries(state)
    .map(([pickId, trackedPick]) => {
      const basePick = picksById.get(pickId) || null;
      const activeReplacement = trackedPick?.activeReplacement && typeof trackedPick.activeReplacement === 'object'
        ? trackedPick.activeReplacement
        : null;
      const publishedPick = activeReplacement
        ? {
            ...(basePick || {}),
            ...activeReplacement,
            legs: Array.isArray(activeReplacement.legs) && activeReplacement.legs.length
              ? activeReplacement.legs
              : (Array.isArray(basePick?.legs) ? basePick.legs : [])
          }
        : basePick;
      const legs = sanitizeLegs(Array.isArray(publishedPick?.legs) ? publishedPick.legs : [], { includeStatus: true });
      const sport = sanitizeText(publishedPick?.sport || basePick?.sport);

      return {
        id: pickId,
        sport,
        sportLabel: sanitizeText(publishedPick?.sportLabel || basePick?.sportLabel) || (sport ? sport.toUpperCase() : 'PICK'),
        event: sanitizeText(publishedPick?.event || basePick?.event) || pickId,
        summary: sanitizeText(publishedPick?.summary || basePick?.summary) || buildPickSummaryFromLegs(legs),
        betType: sanitizeText(publishedPick?.betType || basePick?.betType) || 'pick',
        status: sanitizeText(trackedPick?.status || publishedPick?.status || 'watching').toLowerCase() || 'watching',
        startTime: publishedPick?.startTime || basePick?.startTime || null,
        postedAt: trackedPick?.postedAt || null,
        replacementPostedAt: trackedPick?.replacementPostedAt || null,
        nextCheckAt: trackedPick?.nextCheckAt || publishedPick?.startTime || basePick?.startTime || null,
        lastCheckedAt: trackedPick?.lastCheckedAt || null,
        lastDecision: sanitizeText(trackedPick?.lastDecision) || null,
        lastValidationStatus: sanitizeText(trackedPick?.lastValidationStatus) || null,
        stakeUnits: sanitizeNumber(publishedPick?.stakeUnits ?? basePick?.stakeUnits),
        priceDecimal: sanitizeNumber(publishedPick?.priceDecimal ?? publishedPick?.totalOdds ?? basePick?.priceDecimal ?? basePick?.totalOdds),
        confidenceTier: sanitizeText(publishedPick?.confidenceTier || basePick?.confidenceTier).toLowerCase() || null,
        supportProjection: sanitizeText(publishedPick?.supportProjection || basePick?.supportProjection).toLowerCase() || null,
        isReplacement: Boolean(activeReplacement),
        legs
      };
    })
    .sort((left, right) => {
      const leftTime = getSortableTimestamp(left.startTime, left.nextCheckAt, left.postedAt);
      const rightTime = getSortableTimestamp(right.startTime, right.nextCheckAt, right.postedAt);

      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }

      return String(left.event || left.id || '').localeCompare(String(right.event || right.id || ''));
    });
}

function sanitizeText(value) {
  return String(value || '').trim();
}

async function loadJsonFile(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return fallbackValue;
    }

    throw error;
  }
}

function buildRoleMentionSettings(roleMentions = {}) {
  const picks = roleMentions?.picks && typeof roleMentions.picks === 'object' ? roleMentions.picks : {};

  return {
    enabled: Boolean(roleMentions?.enabled),
    slates: sanitizeText(roleMentions?.slates),
    picks: Object.fromEntries(ROLE_MENTION_PICK_FIELDS.map((field) => [field, sanitizeText(picks?.[field])]))
  };
}

function normalizeAnalysisEngine(value) {
  const normalized = String(value || 'rules').trim().toLowerCase();
  return ANALYSIS_ENGINES.has(normalized) ? normalized : 'rules';
}

function buildWebhookConfiguredState(webhooks = {}) {
  return Object.fromEntries(WEBHOOK_FIELDS.map((field) => [field, Boolean(webhooks?.[field]) ]));
}

function buildWebhookSettings(webhooks = {}) {
  return Object.fromEntries(WEBHOOK_FIELDS.map((field) => [field, webhooks?.[field] || '' ]));
}

function getWebhookUrlByChannel(webhooks = {}, channel) {
  return webhooks?.[channel] || webhooks?.picks || '';
}

function getReferralVerificationStatus(offer) {
  if (sanitizeText(offer?.verificationStatus)) {
    return sanitizeText(offer.verificationStatus).toLowerCase();
  }

  return String(offer?.sourceId || '').startsWith('search:') ? 'pending' : 'verified';
}

function buildReferralReviewState(referralCatalog) {
  const offers = Array.isArray(referralCatalog?.offers) ? referralCatalog.offers : [];
  const counts = referralCatalog?.counts && typeof referralCatalog.counts === 'object'
    ? referralCatalog.counts
    : {
        total: offers.length,
        verifiedActive: offers.filter((offer) => offer?.status === 'active' && getReferralVerificationStatus(offer) === 'verified').length,
        pendingActive: offers.filter((offer) => offer?.status === 'active' && getReferralVerificationStatus(offer) !== 'verified').length,
        inactive: offers.filter((offer) => offer?.status === 'inactive').length,
        reviewRequired: offers.filter((offer) => offer?.status === 'review_required').length
      };

  const items = offers
    .filter((offer) => offer?.status === 'active' && getReferralVerificationStatus(offer) !== 'verified')
    .sort((left, right) => Number(right?.scores?.overall || 0) - Number(left?.scores?.overall || 0))
    .map((offer) => ({
      id: sanitizeText(offer.id),
      brand: sanitizeText(offer.brand) || 'Unknown brand',
      title: sanitizeText(offer.title) || 'Referral offer',
      rewardSummary: sanitizeText(offer.rewardSummary) || 'See official page',
      requirementSummary: Array.isArray(offer.qualificationSteps) && offer.qualificationSteps.length
        ? offer.qualificationSteps.join(' | ')
        : 'See official page',
      status: sanitizeText(offer.status) || 'review_required',
      confidence: sanitizeText(offer.confidence) || 'medium',
      discoverySource: sanitizeText(offer.discoverySource) || 'curated',
      score: sanitizeNumber(offer?.scores?.overall),
      officialOfferUrl: sanitizeText(offer.officialOfferUrl) || null,
      officialTermsUrl: sanitizeText(offer.officialTermsUrl) || null,
      lastSuccessfulSyncAt: sanitizeText(offer.lastSuccessfulSyncAt) || null
    }));

  return {
    counts,
    items
  };
}

function validateWebhookSettings(payloadWebhooks = {}, existingWebhooks = {}) {
  const nextWebhooks = { ...(existingWebhooks || {}) };

  for (const field of WEBHOOK_FIELDS) {
    nextWebhooks[field] = validateWebhookUrl(payloadWebhooks?.[field], WEBHOOK_LABELS[field] || field);
  }

  return nextWebhooks;
}

function sanitizeLegs(legs, { includeStatus = false } = {}) {
  if (!Array.isArray(legs)) {
    return [];
  }

  return legs
    .map((leg, index) => {
      const label = sanitizeText(leg.label || leg.summary);

      if (!label) {
        return null;
      }

      const sanitized = {
        id: sanitizeText(leg.id) || `leg-${index + 1}`,
        label,
        modelProbability: sanitizeNumber(leg.modelProbability),
        supportScore: sanitizeNumber(leg.supportScore),
        supportProjection: sanitizeText(leg.supportProjection).toLowerCase() || null,
        confidenceTier: sanitizeText(leg.confidenceTier).toLowerCase() || null,
        locked: Boolean(leg.locked),
        rationale: sanitizeText(leg.rationale),
        source: sanitizeText(leg.source) || null
      };

      if (includeStatus) {
        sanitized.status = sanitizeText(leg.status || 'active').toLowerCase() || 'active';
      }

      return sanitized;
    })
    .filter(Boolean);
}

async function settlePickManually(payload) {
  const { pickId, result, notes } = payload || {};

  if (!pickId) {
    throw new Error('No pick ID provided.');
  }

  if (!['win', 'loss', 'return'].includes(String(result || '').toLowerCase())) {
    throw new Error('Result must be win, loss, or return.');
  }

  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const feed = await loadRawPicksFeed(config.__paths.picksFeedFile);
  const pickIndex = feed.picks.findIndex((p) => p.id === pickId);

  if (pickIndex === -1) {
    throw new Error('Pick not found in active picks feed.');
  }

  const now = new Date().toISOString();
  const settledPick = {
    ...feed.picks[pickIndex],
    status: result.toLowerCase(),
    settledAt: now,
    settlementNotes: notes || 'Manually settled from desktop app.'
  };

  if (!state.posts) { state.posts = {}; }
  if (!state.posts.results) { state.posts.results = {}; }
  state.posts.results[pickId] = now;

  const context = { config, state, dryRun: Boolean(config.dryRun) };

  if (!context.dryRun) {
    await writeSettlementsToWorkspace(context, [settledPick], feed);
    await appendSettlementTrackerEntries(config, [settledPick], now);
    feed.picks.splice(pickIndex, 1);
    await saveRawPicksFeed(config.__paths.picksFeedFile, feed);
    await saveState(config.__paths.stateFile, state);
  }

  await refreshUi();

  return { success: true, dryRun: context.dryRun };
}

async function getDesktopStatus() {
  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const runtime = await loadRuntimeStatus(config.__paths.runtimeStatusFile);
  const watchedPickDetails = getWatchedPickCount(state) > 0
    ? buildWatchedPickDetails(state, await loadRawPicksFeed(config.__paths.picksFeedFile))
    : [];
  const trackerSummary = await buildDailyTrackerSummary(config);
  const referralCatalog = await loadJsonFile(config.__paths.referralsCatalogFile, { offers: [], updatedAt: null, fetchFailures: [], capitalPlan: null });
  const referralPlan = referralCatalog?.capitalPlan || buildReferralCapitalPlan(referralCatalog?.offers || [], { startingCapitalAud: 10 });
  const referralReview = buildReferralReviewState(referralCatalog);
  const running = isRuntimeLive(runtime);
  const configuredWebhooks = buildWebhookConfiguredState(config.discord.webhooks);
  const runtimeWebhooks = running
    ? buildWebhookConfiguredState(runtime.webhooks || {})
    : configuredWebhooks;
  const configuredDryRun = Boolean(config.dryRun);
  const runtimeDryRun = running ? Boolean(runtime.dryRun) : configuredDryRun;
  const settingsApplyRequiresRestart = running && (
    runtimeDryRun !== configuredDryRun
    || Object.keys(configuredWebhooks).some((channel) => runtimeWebhooks[channel] !== configuredWebhooks[channel])
  );

  return {
    appName: APP_NAME,
    running,
    pid: running ? runtime.pid : null,
    startedAt: runtime.startedAt || null,
    heartbeatAt: runtime.heartbeatAt || null,
    status: running ? runtime.status || 'running' : 'stopped',
    stopReason: running ? null : runtime.stopReason || null,
    watchedPicks: watchedPickDetails.length,
    activePicks: watchedPickDetails,
    lastMarketQuoteCount: Number.isFinite(Number(state.providers?.marketScrape?.lastQuoteCount))
      ? Number(state.providers.marketScrape.lastQuoteCount)
      : null,
    lastMarketRefreshAt: state.providers?.marketScrape?.lastRefreshAt || null,
    webhookConfigured: configuredWebhooks,
    runtimeWebhookConfigured: runtimeWebhooks,
    dryRun: runtimeDryRun,
    configuredDryRun,
    timezone: config.timezone,
    configPath: config.__paths.configPath,
    automationFolder: path.dirname(config.__paths.configPath),
    picksFeedPath: config.__paths.picksFeedFile,
    runtimeStatusFile: config.__paths.runtimeStatusFile,
    snapshotFile: config.__paths.snapshotFile,
    analysisEngine: config.analysis?.engine || 'rules',
    roleMentionsEnabled: Boolean(config.discord.roleMentions?.enabled),
    referralPlan: referralPlan
      ? {
          ...referralPlan,
          updatedAt: referralCatalog?.updatedAt || null,
          trackedOffers: Array.isArray(referralCatalog?.offers) ? referralCatalog.offers.length : 0,
          fetchFailures: Array.isArray(referralCatalog?.fetchFailures) ? referralCatalog.fetchFailures.length : 0
        }
      : null,
    referralReview,
    trackerSummary: trackerSummary
      ? {
          startingBankrollUnits: trackerSummary.startingBankrollUnits,
          currentUnits: trackerSummary.currentUnits,
          openExposureUnits: trackerSummary.openExposureUnits,
          lifetimePlacedUnits: trackerSummary.lifetimePlacedUnits,
          totalNetUnits: trackerSummary.totalNetUnits,
          rollingBankrollRoiPercent: trackerSummary.rollingBankrollRoiPercent,
          rollingHitRatePercent: trackerSummary.rollingHitRatePercent,
          rollingRecord: trackerSummary.rollingRecord,
          sportTotals: trackerSummary.sportTotals,
          trackerDayNumber: trackerSummary.trackerDayNumber,
          currentDayDateKey: trackerSummary.currentDayDateKey,
          currentDaySettledCount: trackerSummary.currentDaySettledCount,
          currentDayNetUnits: trackerSummary.currentDayNetUnits
        }
      : null,
    lastRuns: state.jobs || {},
    settings: {
      dryRun: Boolean(config.dryRun),
      analysis: {
        engine: config.analysis?.engine || 'rules'
      },
      webhooks: buildWebhookSettings(config.discord.webhooks),
      roleMentions: buildRoleMentionSettings(config.discord.roleMentions)
    },
    settingsApplyRequiresRestart
  };
}

function validateWebhookUrl(value, label) {
  const trimmed = String(value || '').trim();

  if (!trimmed) {
    return '';
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (!/discord\.com$|discordapp\.com$/.test(parsedUrl.hostname) || !parsedUrl.pathname.includes('/api/webhooks/')) {
    throw new Error(`${label} must be a Discord webhook URL.`);
  }

  return trimmed;
}

async function saveDesktopSettings(payload) {
  const { configPath, config } = await loadRawConfigFile();
  const nextWebhooks = validateWebhookSettings(payload?.webhooks, config.discord?.webhooks);
  const settlementWebhook = String(config.bankrollTracker?.settlementWebhook || 'unitTracking').trim() || 'unitTracking';
  const summaryWebhook = String(config.bankrollTracker?.summaryWebhook || 'unitReport').trim() || 'unitReport';

  delete nextWebhooks.results;

  const nextConfig = {
    ...config,
    dryRun: Boolean(payload?.dryRun),
    analysis: {
      ...(config.analysis || {}),
      engine: normalizeAnalysisEngine(payload?.analysis?.engine)
    },
    bankrollTracker: {
      ...(config.bankrollTracker || {}),
      settlementWebhook: settlementWebhook === 'results' ? 'unitTracking' : settlementWebhook,
      summaryWebhook: summaryWebhook === 'results' ? 'unitReport' : summaryWebhook
    },
    discord: {
      ...(config.discord || {}),
      webhooks: nextWebhooks,
      roleMentions: buildRoleMentionSettings(payload?.roleMentions)
    }
  };

  await saveRawConfigFile(configPath, nextConfig);
  return getDesktopStatus();
}

async function refreshUi() {
  const status = await getDesktopStatus();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:status-updated', status);
  }

  if (tray) {
    tray.setToolTip(`${APP_NAME} ${status.running ? 'running' : 'stopped'}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: status.running ? 'Daemon Running' : 'Daemon Stopped',
        enabled: false
      },
      {
        type: 'separator'
      },
      {
        label: status.running ? 'Stop Automation' : 'Start Automation',
        click: async () => {
          if (status.running) {
            await stopDaemon();
          } else {
            await startDaemon();
          }
        }
      },
      {
        label: 'Show Window',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: 'Open Config',
        click: async () => {
          const latest = await getDesktopStatus();
          await shell.openPath(latest.configPath);
        }
      },
      {
        label: 'Quit App',
        click: () => {
          quitRequested = true;
          app.quit();
        }
      }
    ]));
  }

  return status;
}

async function startDaemon() {
  const status = await getDesktopStatus();

  if (status.running) {
    return status;
  }

  const config = await loadConfig();
  const child = spawn(process.execPath, [getDaemonEntryPath(), 'daemon'], {
    cwd: config.__paths.workspaceRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      SPORTSTIPS_WORKSPACE_ROOT: config.__paths.workspaceRoot,
      ELECTRON_RUN_AS_NODE: '1'
    }
  });

  child.unref();
  daemonProcess = child;
  
  child.on('exit', () => {
    daemonProcess = null;
  });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const nextStatus = await getDesktopStatus();

    if (nextStatus.running) {
      await refreshUi();
      return nextStatus;
    }
  }

  return refreshUi();
}

async function stopDaemon() {
  const status = await getDesktopStatus();

  if (daemonProcess) {
    daemonProcess.kill();
    daemonProcess = null;
  } else if (!status.running || !status.pid) {
    return status;
  }

  try {
    process.kill(status.pid);
  } catch (error) {
    return {
      ...(await refreshUi()),
      stopError: String(error.message || error)
    };
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const nextStatus = await getDesktopStatus();

    if (!nextStatus.running) {
      await refreshUi();
      return nextStatus;
    }
  }

  return refreshUi();
}

async function forcePostSlates() {
  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const context = {
    config,
    state,
    dryRun: Boolean(config.dryRun)
  };
  const result = await runSlatesJob(context, {
    forceSnapshotRefresh: true
  });

  await saveState(config.__paths.stateFile, state);
  await refreshUi();

  return {
    posted: Number(result?.posted || 0),
    dryRun: context.dryRun,
    lastRunAt: state.jobs?.slates?.lastRunAt || null,
    source: state.jobs?.slates?.source || null,
    targetDateKey: result?.targetDateKey || state.jobs?.slates?.targetDateKey || null
  };
}

async function forcePostApprovedPicks() {
  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const context = {
    config,
    state,
    dryRun: Boolean(config.dryRun)
  };
  const analysisResult = config.analysis?.enabled && config.jobs?.analysis?.enabled
    ? await runAnalysisJob(context)
    : null;
  const result = await runPicksJob(context, {
    forcePostNow: true
  });

  await saveState(config.__paths.stateFile, state);
  await refreshUi();

  return {
    posted: Number(result?.posted || 0),
    watched: Number(result?.watched || 0),
    dryRun: context.dryRun,
    analysisGenerated: Number(analysisResult?.generated || 0),
    analysisConsidered: Number(analysisResult?.considered || 0),
    lastRunAt: state.jobs?.picks?.lastRunAt || null,
    picks: Array.isArray(result?.postedDetails) ? result.postedDetails : []
  };
}

async function forceDailyCheck() {
  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const context = {
    config,
    state,
    dryRun: Boolean(config.dryRun)
  };
  const result = await runForcedDailyCheck(context);

  await saveState(config.__paths.stateFile, state);
  await refreshUi();

  return {
    dryRun: context.dryRun,
    prepare: {
      removedGeneratedFeedPicks: Number(result.prepareResult?.removedGeneratedFeedPicks || 0),
      removedPostedPickIds: Array.isArray(result.prepareResult?.removedPostedPickIds) ? result.prepareResult.removedPostedPickIds.length : 0,
      removedTrackingPickIds: Array.isArray(result.prepareResult?.removedTrackingPickIds) ? result.prepareResult.removedTrackingPickIds.length : 0,
      remainingFeedPicks: result.prepareResult?.remainingFeedPicks ?? null
    },
    slates: {
      posted: Number(result.slates?.posted || 0),
      targetDateKey: result.slates?.targetDateKey || state.jobs?.slates?.targetDateKey || null
    },
    analysis: {
      generated: Number(result.analysis?.generated || 0),
      considered: Number(result.analysis?.considered || 0)
    },
    picks: {
      posted: Number(result.picks?.posted || 0),
      watched: Number(result.picks?.watched || 0),
      picks: Array.isArray(result.picks?.postedDetails) ? result.picks.postedDetails : []
    }
  };
}

// Full Scan: one button that runs a complete cycle — refresh + post daily slates
// (all enabled sports incl. soccer/tennis), generate + re-evaluate picks against
// the current rules, and settle + post any results. Each job is fault-isolated so
// one failure doesn't abort the rest.
async function fullScan() {
  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const context = { config, state, dryRun: Boolean(config.dryRun) };
  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (error) {
      console.error(`[full-scan] ${label} failed: ${error.message}`);
      return { error: error.message };
    }
  };

  const slates = await safe('slates', () => runSlatesJob(context, { forceSnapshotRefresh: true }));
  const analysis = config.analysis?.enabled && config.jobs?.analysis?.enabled
    ? await safe('analysis', () => runAnalysisJob(context))
    : null;
  const picks = await safe('picks', () => runPicksJob(context, { forcePostNow: true }));
  const results = await safe('results', () => runResultsJob(context));
  const trackerSummary = await safe('tracker-summary', () => runTrackerSummaryJob(context));

  await saveState(config.__paths.stateFile, state);
  await refreshUi();

  return {
    dryRun: context.dryRun,
    slatesPosted: Number(slates?.posted || 0),
    analysisGenerated: Number(analysis?.generated || 0),
    analysisConsidered: Number(analysis?.considered || 0),
    picksPosted: Number(picks?.posted || 0),
    picksWatched: Number(picks?.watched || 0),
    resultsPosted: Number(results?.posted || 0),
    autoSettled: Number(results?.autoSettled || 0),
    pendingReview: Number(results?.pendingReview || 0),
    unitReportPosted: Number(trackerSummary?.posted || 0),
    errors: [slates, analysis, picks, results, trackerSummary].filter((r) => r?.error).map((r) => r.error)
  };
}

async function updateTrackedUnits() {
  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const context = {
    config,
    state,
    dryRun: Boolean(config.dryRun)
  };
  const results = await runResultsJob(context);
  const trackerSummary = await runTrackerSummaryJob(context);

  await saveState(config.__paths.stateFile, state);
  const status = await refreshUi();

  return {
    dryRun: context.dryRun,
    settlementsPosted: Number(results?.posted || 0),
    autoSettled: Number(results?.autoSettled || 0),
    pendingReview: Number(results?.pendingReview || 0),
    unitReportPosted: Number(trackerSummary?.posted || 0),
    trackerSummary: status.trackerSummary || null
  };
}

async function reviewResults() {
  return updateTrackedUnits();
}

async function runReferralsNow() {
  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const context = {
    config,
    state,
    dryRun: Boolean(config.dryRun)
  };
  const result = await runReferralsJob(context);

  await saveState(config.__paths.stateFile, state);
  await refreshUi();

  return {
    dryRun: context.dryRun,
    posted: Number(result?.posted || 0),
    offers: Number(result?.offers || 0),
    changes: Number(result?.changes || 0),
    lastRunAt: state.jobs?.referrals?.lastRunAt || null,
    newCount: Number(state.jobs?.referrals?.newCount || 0),
    updatedCount: Number(state.jobs?.referrals?.updatedCount || 0),
    cancelledCount: Number(state.jobs?.referrals?.cancelledCount || 0),
    fetchFailureCount: Number(state.jobs?.referrals?.fetchFailureCount || 0),
    masterlistUpdatedAt: state.posts?.referrals?.masterlistUpdatedAt || null
  };
}

async function verifyReferralOffer(payload) {
  const config = await loadConfig();
  const state = await loadState(config.__paths.stateFile);
  const context = {
    config,
    state,
    dryRun: Boolean(config.dryRun)
  };
  const result = await setReferralVerification(context, {
    offerId: payload?.offerId,
    verificationStatus: 'verified'
  });

  await saveState(config.__paths.stateFile, state);
  await refreshUi();

  return {
    dryRun: context.dryRun,
    ...result
  };
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 470,
    height: 940,
    minWidth: 420,
    minHeight: 780,
    show: false,
    title: APP_NAME,
    backgroundColor: '#09111f',
    autoHideMenuBar: true,
    icon: createAppIcon(256),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.on('close', (event) => {
    if (!quitRequested && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  await mainWindow.loadFile(rendererHtml);

  if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

async function createTray() {
  tray = new Tray(createAppIcon(32));
  tray.on('click', () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isVisible()) {
      mainWindow.focus();
      return;
    }

    mainWindow.show();
    mainWindow.focus();
  });

  await refreshUi();
}

async function reanalyzePickAgainstSnapshot(config, snapshot, pick, now, tabMenu = null) {
  const sport = (config.sports || []).find((s) => {
    const sk = String(s.key || '').toLowerCase();
    const pk = String(pick.sport || '').toLowerCase();
    return sk === pk || String(s.marketKey || '').toLowerCase() === pk;
  });

  if (!sport) {
    throw new Error(`No sport config found for sport "${pick.sport}".`);
  }

  const snapshotEvents = buildSnapshotEvents(snapshot, config, sport, now);
  const pickName = String(pick.event || pick.summary || '').toLowerCase().trim();
  const matchedEvent = snapshotEvents.find((ev) => {
    const evName = String(ev.displayName || `${ev.home_team} vs ${ev.away_team}`).toLowerCase().trim();
    return evName === pickName || evName.includes(pickName) || pickName.includes(evName);
  }) || snapshotEvents[0];

  if (!matchedEvent) {
    throw new Error('No matching event found in the current snapshot. The snapshot may be stale or the event may have started.');
  }

  const eventContext = {
    sportKey: sport.key,
    sportLabel: sport.label,
    marketSportKey: sport.marketKey || sport.key,
    eventId: matchedEvent.id,
    espnEventId: matchedEvent.espnEventId || '',
    eventName: matchedEvent.displayName || `${matchedEvent.away_team} vs ${matchedEvent.home_team}`,
    homeTeam: matchedEvent.home_team,
    homeTeamId: matchedEvent.homeTeamId || '',
    awayTeam: matchedEvent.away_team,
    awayTeamId: matchedEvent.awayTeamId || '',
    startTime: matchedEvent.commence_time,
    venue: matchedEvent.venue || null,
    weather: pick.weather || null,
    generatorConfig: config.analysis.generator,
    tabMarkets: tabMenu ? getTabCanonicalMarkets(tabMenu, sport.key) : null
  };

  const allQuotes = matchedEvent.snapshotQuotes || [];
  const candidatePool = buildAnalysisCandidatePool(eventContext, allQuotes, Number(config.analysis?.maxCandidateLegsPerEvent || 14));

  if (candidatePool.length === 0) {
    return {
      originalPickId: pick.id,
      originalSummary: pick.summary || null,
      hasNewPick: false,
      newSummary: null,
      rationale: 'No market-backed candidates found in the current snapshot.',
      newPick: null
    };
  }

  const context = { config, state: {}, dryRun: Boolean(config.dryRun) };
  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, {
    availableUnits: pick.stakeUnits ? Number(pick.stakeUnits) : undefined
  });
  const newPick = buildPickFromAnalysisDecision(eventContext, candidatePool, decision);

  return {
    originalPickId: pick.id,
    originalSummary: pick.summary || null,
    hasNewPick: Boolean(newPick?.summary),
    newSummary: newPick?.summary || null,
    rationale: decision?.rationale || decision?.summary || decision?.noBetReason || null,
    newPick: newPick || null
  };
}

async function reanalyzeSlip(payload) {
  const { pickId } = payload || {};

  if (!pickId) {
    throw new Error('No pick ID provided.');
  }

  const config = await loadConfig();
  const feed = await loadRawPicksFeed(config.__paths.picksFeedFile);
  const pick = feed.picks.find((p) => p.id === pickId);

  if (!pick) {
    throw new Error('Pick not found in feed.');
  }

  const snapshot = await loadSnapshotFile(config.__paths.snapshotFile);
  const tabMenu = config.tab?.enabled === false ? null : await loadTabMarketMenu(config.__paths.tabMarketMenuFile);
  return reanalyzePickAgainstSnapshot(config, snapshot, pick, new Date(), tabMenu);
}

function applyReanalyzedPickFields(existing, newPick) {
  return {
    ...existing,
    summary: newPick.summary,
    rationale: newPick.rationale || existing.rationale,
    legs: newPick.legs || existing.legs,
    betType: newPick.betType || existing.betType,
    modelProbability: newPick.modelProbability ?? existing.modelProbability,
    supportScore: newPick.supportScore ?? existing.supportScore,
    confidenceTier: newPick.confidenceTier || existing.confidenceTier,
    reanalyzedAt: new Date().toISOString()
  };
}

async function reanalyzeAllSlips() {
  const config = await loadConfig();
  const feed = await loadRawPicksFeed(config.__paths.picksFeedFile);
  const snapshot = await loadSnapshotFile(config.__paths.snapshotFile);
  const tabMenu = config.tab?.enabled === false ? null : await loadTabMarketMenu(config.__paths.tabMarketMenuFile);
  const now = new Date();
  const dryRun = Boolean(config.dryRun);

  // Active + pre-game = pending status and a start time still in the future.
  const pregameSlips = (feed.picks || []).filter((pick) => {
    if (String(pick.status || '').toLowerCase() !== 'pending') {
      return false;
    }

    const start = pick.startTime ? new Date(pick.startTime) : null;
    return start && !Number.isNaN(start.getTime()) && start.getTime() > now.getTime();
  });

  const results = [];
  let changed = 0;
  let unchanged = 0;
  let noBet = 0;
  let failed = 0;
  let applied = 0;

  for (const pick of pregameSlips) {
    try {
      const analysis = await reanalyzePickAgainstSnapshot(config, snapshot, pick, now, tabMenu);
      const originalSummary = pick.summary || '';
      const isDifferent = Boolean(analysis.hasNewPick && analysis.newSummary && analysis.newSummary !== originalSummary);
      let didApply = false;

      if (isDifferent && analysis.newPick?.summary && !dryRun) {
        const index = feed.picks.findIndex((p) => p.id === pick.id);

        if (index !== -1) {
          feed.picks[index] = applyReanalyzedPickFields(feed.picks[index], analysis.newPick);
          didApply = true;
          applied += 1;
        }
      }

      if (!analysis.hasNewPick) {
        noBet += 1;
      } else if (isDifferent) {
        changed += 1;
      } else {
        unchanged += 1;
      }

      results.push({
        pickId: pick.id,
        sport: pick.sportLabel || pick.sport || '',
        event: pick.event || pick.summary || '',
        originalSummary,
        newSummary: analysis.newSummary,
        qualifies: analysis.hasNewPick,
        changed: isDifferent,
        applied: didApply,
        rationale: analysis.rationale || null
      });
    } catch (error) {
      failed += 1;
      results.push({
        pickId: pick.id,
        sport: pick.sportLabel || pick.sport || '',
        event: pick.event || pick.summary || '',
        error: error.message
      });
    }
  }

  if (applied > 0 && !dryRun) {
    await saveRawPicksFeed(config.__paths.picksFeedFile, feed);
  }

  await refreshUi();

  return { total: pregameSlips.length, changed, unchanged, noBet, failed, applied, dryRun, results };
}

async function applyReanalyzedPick(payload) {
  const { pickId, newPick } = payload || {};

  if (!pickId) {
    throw new Error('No pick ID provided.');
  }

  if (!newPick?.summary) {
    throw new Error('No new pick data to apply.');
  }

  const config = await loadConfig();
  const feed = await loadRawPicksFeed(config.__paths.picksFeedFile);
  const pickIndex = feed.picks.findIndex((p) => p.id === pickId);

  if (pickIndex === -1) {
    throw new Error('Pick not found in feed.');
  }

  const dryRun = Boolean(config.dryRun);

  if (!dryRun) {
    feed.picks[pickIndex] = applyReanalyzedPickFields(feed.picks[pickIndex], newPick);
    await saveRawPicksFeed(config.__paths.picksFeedFile, feed);
  }

  await refreshUi();
  return { success: true, dryRun };
}


ipcMain.handle('desktop:get-status', () => getDesktopStatus());
ipcMain.handle('desktop:start-daemon', () => startDaemon());
ipcMain.handle('desktop:stop-daemon', () => stopDaemon());
ipcMain.handle('desktop:update-tracked-units', () => updateTrackedUnits());
ipcMain.handle('desktop:review-results', () => reviewResults());
ipcMain.handle('desktop:force-daily-check', () => forceDailyCheck());
ipcMain.handle('desktop:force-post-slates', () => forcePostSlates());
ipcMain.handle('desktop:force-post-picks', () => forcePostApprovedPicks());
ipcMain.handle('desktop:run-referrals-now', () => runReferralsNow());
ipcMain.handle('desktop:verify-referral', (_, payload) => verifyReferralOffer(payload));
ipcMain.handle('desktop:save-settings', (_, payload) => saveDesktopSettings(payload));
ipcMain.handle('desktop:settle-pick-manually', (_, payload) => settlePickManually(payload));
ipcMain.handle('desktop:reanalyze-slip', (_, payload) => reanalyzeSlip(payload));
ipcMain.handle('desktop:analyze-all-slips', () => reanalyzeAllSlips());
ipcMain.handle('desktop:full-scan', () => fullScan());
ipcMain.handle('desktop:apply-reanalyzed-pick', (_, payload) => applyReanalyzedPick(payload));
ipcMain.handle('desktop:open-config', async () => {
  const status = await getDesktopStatus();
  return shell.openPath(status.configPath);
});
ipcMain.handle('desktop:open-automation-folder', async () => {
  const status = await getDesktopStatus();
  return shell.openPath(status.automationFolder);
});

app.setAppUserModelId('com.redemptory.tippingbot');
app.on('window-all-closed', (event) => {
  if (!quitRequested && tray) {
    event.preventDefault();
  }
});

app.whenReady().then(async () => {
  await ensurePortableDataFiles();

  if (smokeTest) {
    const status = await getDesktopStatus();
    console.log(JSON.stringify({ ok: true, running: status.running, configPath: status.configPath }, null, 2));
    app.quit();
    return;
  }

  await createMainWindow();

  try {
    await createTray();
  } catch (error) {
    console.error(`Tray setup failed: ${error.message}`);
  }

  await refreshUi();

  const runRefresh = async () => {
    try {
      await refreshUi();
    } catch (error) {
      console.error(`UI Refresh failed: ${error.message}`);
    } finally {
      refreshTimer = setTimeout(runRefresh, 5000);
    }
  };
  runRefresh();
});

app.on('before-quit', () => {
  quitRequested = true;
  if (daemonProcess) {
    daemonProcess.kill();
  }

  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
});
