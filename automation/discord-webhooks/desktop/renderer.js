const elements = {
  toggleButton: document.getElementById('toggle-button'),
  daemonState: document.getElementById('daemon-state'),
  daemonMeta: document.getElementById('daemon-meta'),
  creditsValue: document.getElementById('credits-value'),
  watchedPicks: document.getElementById('watched-picks'),
  watchedPicksMeta: document.getElementById('watched-picks-meta'),
  activePicksPanel: document.getElementById('active-picks-panel'),
  activePicksDetails: document.getElementById('active-picks-details'),
  activePicksList: document.getElementById('active-picks-list'),
  timezoneValue: document.getElementById('timezone-value'),
  dryRunValue: document.getElementById('dry-run-value'),
  trackerUnitsValue: document.getElementById('tracker-units-value'),
  trackerUnitsMeta: document.getElementById('tracker-units-meta'),
  trackerSportBreakdown: document.getElementById('tracker-sport-breakdown'),
  webhookSlates: document.getElementById('webhook-slates'),
  webhookPicks: document.getElementById('webhook-picks'),
  webhookPicksNba: document.getElementById('webhook-picks-nba'),
  webhookPicksMlb: document.getElementById('webhook-picks-mlb'),
  webhookPicksAfl: document.getElementById('webhook-picks-afl'),
  webhookPicksNrl: document.getElementById('webhook-picks-nrl'),
  webhookPicksNfl: document.getElementById('webhook-picks-nfl'),
  webhookPicksEpl: document.getElementById('webhook-picks-epl'),
  webhookPicksOther: document.getElementById('webhook-picks-other'),
  webhookReferralsNew: document.getElementById('webhook-referrals-new'),
  webhookReferralsUpdatedTerms: document.getElementById('webhook-referrals-updated-terms'),
  webhookReferralsCancelled: document.getElementById('webhook-referrals-cancelled'),
  webhookReferralsMasterlist: document.getElementById('webhook-referrals-masterlist'),
  quickWebhookReferralsNew: document.getElementById('quick-webhook-referrals-new'),
  quickWebhookReferralsUpdatedTerms: document.getElementById('quick-webhook-referrals-updated-terms'),
  quickWebhookReferralsCancelled: document.getElementById('quick-webhook-referrals-cancelled'),
  quickWebhookReferralsMasterlist: document.getElementById('quick-webhook-referrals-masterlist'),
  saveReferralWebhooks: document.getElementById('save-referral-webhooks'),
  referralWebhookFeedback: document.getElementById('referral-webhook-feedback'),
  webhookUnitTracking: document.getElementById('webhook-unit-tracking'),
  webhookUnitReport: document.getElementById('webhook-unit-report'),
  referralReviewSummary: document.getElementById('referral-review-summary'),
  referralReviewList: document.getElementById('referral-review-list'),
  referralReviewFeedback: document.getElementById('referral-review-feedback'),
  referralPlanSummary: document.getElementById('referral-plan-summary'),
  referralPlanSteps: document.getElementById('referral-plan-steps'),
  referralPlanDeferredSummary: document.getElementById('referral-plan-deferred-summary'),
  referralPlanDeferred: document.getElementById('referral-plan-deferred'),
  forceDailyCheck: document.getElementById('force-daily-check'),
  forcePostPicks: document.getElementById('force-post-picks'),
  reviewResults: document.getElementById('review-results'),
  reanalyzeSlipBtn: document.getElementById('reanalyze-slip-btn'),
  analyzeAllSlipsBtn: document.getElementById('analyze-all-slips-btn'),
  fullScanBtn: document.getElementById('full-scan-btn'),
  runReferralsNow: document.getElementById('run-referrals-now'),
  runReferralsFeedback: document.getElementById('run-referrals-feedback'),
  quickActionsFeedback: document.getElementById('quick-actions-feedback'),
  reanalyzePickSelect: document.getElementById('reanalyze-pick-select'),
  reanalyzeRunBtn: document.getElementById('reanalyze-run-btn'),
  reanalyzeResult: document.getElementById('reanalyze-result'),
  reanalyzeCurrentPick: document.getElementById('reanalyze-current-pick'),
  reanalyzeNewPick: document.getElementById('reanalyze-new-pick'),
  reanalyzeRationale: document.getElementById('reanalyze-rationale'),
  applyReanalyzedPickBtn: document.getElementById('apply-reanalyzed-pick-btn'),
  reanalyzeFeedback: document.getElementById('reanalyze-feedback'),
  configPath: document.getElementById('config-path'),
  saveSettings: document.getElementById('save-settings'),
  settingsFeedback: document.getElementById('settings-feedback'),
  settingDryRun: document.getElementById('setting-dry-run'),
  settingAnalysisEngine: document.getElementById('setting-analysis-engine'),
  settingWebhookSlates: document.getElementById('setting-webhook-slates'),
  settingWebhookPicks: document.getElementById('setting-webhook-picks'),
  settingWebhookPicksNba: document.getElementById('setting-webhook-picks-nba'),
  settingWebhookPicksMlb: document.getElementById('setting-webhook-picks-mlb'),
  settingWebhookPicksAfl: document.getElementById('setting-webhook-picks-afl'),
  settingWebhookPicksNrl: document.getElementById('setting-webhook-picks-nrl'),
  settingWebhookPicksNfl: document.getElementById('setting-webhook-picks-nfl'),
  settingWebhookPicksEpl: document.getElementById('setting-webhook-picks-epl'),
  settingWebhookPicksOther: document.getElementById('setting-webhook-picks-other'),
  settingWebhookReferralsNew: document.getElementById('setting-webhook-referrals-new'),
  settingWebhookReferralsUpdatedTerms: document.getElementById('setting-webhook-referrals-updated-terms'),
  settingWebhookReferralsCancelled: document.getElementById('setting-webhook-referrals-cancelled'),
  settingWebhookReferralsMasterlist: document.getElementById('setting-webhook-referrals-masterlist'),
  settingWebhookUnitTracking: document.getElementById('setting-webhook-unit-tracking'),
  settingWebhookUnitReport: document.getElementById('setting-webhook-unit-report'),
  settingWebhookPromoAfl: document.getElementById('setting-webhook-promo-afl'),
  settingWebhookPromoNrl: document.getElementById('setting-webhook-promo-nrl'),
  settingWebhookPromoTennis: document.getElementById('setting-webhook-promo-tennis'),
  settingWebhookPromoSoccer: document.getElementById('setting-webhook-promo-soccer'),
  settingWebhookEvidence: document.getElementById('setting-webhook-evidence'),
  settingRoleEnabled: document.getElementById('setting-role-enabled'),
  settingRoleText: document.getElementById('setting-role-text'),
  settingRoleSlates: document.getElementById('setting-role-slates'),
  settingRolePicksNba: document.getElementById('setting-role-picks-nba'),
  settingRolePicksMlb: document.getElementById('setting-role-picks-mlb'),
  settingRolePicksAfl: document.getElementById('setting-role-picks-afl'),
  settingRolePicksNrl: document.getElementById('setting-role-picks-nrl'),
  settingRolePicksNfl: document.getElementById('setting-role-picks-nfl'),
  settingRolePicksEpl: document.getElementById('setting-role-picks-epl'),
  settingRolePicksOther: document.getElementById('setting-role-picks-other'),
  openConfig: document.getElementById('open-config'),
  settlementPickSelect: document.getElementById('settlement-pick-select'),
  settlementPickMeta: document.getElementById('settlement-pick-meta'),
  settlementLegsList: document.getElementById('settlement-legs-list'),
  settlementResult: document.getElementById('settlement-result'),
  settlementNotes: document.getElementById('settlement-notes'),
  submitSettlement: document.getElementById('submit-settlement'),
  settlementFeedback: document.getElementById('settlement-feedback')
};

let busy = false;
let settingsDirty = false;
let settingsLoaded = false;
let refreshTimer = null;
let currentStatus = null;
let activePicksExpanded = false;
let settlementActivePicks = [];

const referralWebhookInputPairs = [
  ['settingWebhookReferralsNew', 'quickWebhookReferralsNew'],
  ['settingWebhookReferralsUpdatedTerms', 'quickWebhookReferralsUpdatedTerms'],
  ['settingWebhookReferralsCancelled', 'quickWebhookReferralsCancelled'],
  ['settingWebhookReferralsMasterlist', 'quickWebhookReferralsMasterlist']
];

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatDate(value) {
  if (!value) {
    return 'Never';
  }

  return new Date(value).toLocaleString();
}

function formatUnits(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}u` : '0.00u';
}

function formatAudAmount(value) {
  return Number.isFinite(Number(value))
    ? `$${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 2)} AUD`
    : 'Unknown';
}

function formatAudGain(value) {
  return Number.isFinite(Number(value))
    ? `+$${Number(value).toFixed(Number(value) % 1 === 0 ? 0 : 2)} AUD`
    : 'Unknown';
}

function formatSignedUnits(value) {
  return Number.isFinite(Number(value)) ? `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}u` : '0.00u';
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}%` : 'N/A';
}

function formatSportPerformanceLines(summary) {
  if (!Array.isArray(summary?.sportTotals) || !summary.sportTotals.length) {
    return [];
  }

  return summary.sportTotals
    .filter((item) => Number(item?.wins || 0) + Number(item?.losses || 0) + Number(item?.returns || 0) > 0 || Number(item?.totalNetUnits || 0) !== 0)
    .map((item) => {
      const record = `${Number(item.wins || 0)}W / ${Number(item.losses || 0)}L${Number(item.returns || 0) > 0 ? ` / ${Number(item.returns || 0)}R` : ''}`;
      return `${item.sport}: ${formatSignedUnits(item.totalNetUnits)} | ${record} | ${formatPercent(item.winLossPercent)}`;
    });
}

function formatTrackerBreakdown(summary) {
  const record = summary?.rollingRecord || {};
  const wins = Number(record.wins || 0);
  const losses = Number(record.losses || 0);
  const returns = Number(record.returns || 0);
  const sportLines = formatSportPerformanceLines(summary);
  const overallLine = `Record ${wins}W / ${losses}L / ${returns}R | Hit Rate ${formatPercent(summary?.rollingHitRatePercent)} | Day ${summary?.trackerDayNumber || 1}`;

  return sportLines.length ? [overallLine, ...sportLines].join('\n') : overallLine;
}

function markSettingsDirty(referralOnly = false) {
  settingsDirty = true;
  elements.settingsFeedback.textContent = 'Unsaved changes.';

  if (referralOnly) {
    elements.referralWebhookFeedback.textContent = 'Unsaved referral webhook changes.';
  }
}

function setInputValue(element, value) {
  if (element) {
    element.value = value;
  }
}

function bindMirroredInputs(settingKey, quickKey) {
  const settingInput = elements[settingKey];
  const quickInput = elements[quickKey];

  if (!settingInput || !quickInput) {
    return;
  }

  const syncInputs = (source, target) => {
    if (target.value !== source.value) {
      target.value = source.value;
    }

    markSettingsDirty(true);
  };

  settingInput.addEventListener('input', () => syncInputs(settingInput, quickInput));
  settingInput.addEventListener('change', () => syncInputs(settingInput, quickInput));
  quickInput.addEventListener('input', () => syncInputs(quickInput, settingInput));
  quickInput.addEventListener('change', () => syncInputs(quickInput, settingInput));
}

function setWebhookState(element, configured) {
  element.textContent = configured ? 'Configured' : 'Missing';
  element.className = configured ? 'state-ok' : 'state-danger';
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function appendMetaMessage(container, message) {
  const paragraph = document.createElement('p');
  paragraph.className = 'meta';
  paragraph.textContent = message;
  container.append(paragraph);
}

function formatDecimalOdds(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : null;
}

function getStatusToneClass(status) {
  const normalized = String(status || '').toLowerCase();

  if (['active', 'ok', 'posted_waiting_for_pregame_recheck', 'pregame_recheck_passed'].includes(normalized)) {
    return 'state-ok';
  }

  if (['replacement_posted', 'watching', 'pending'].includes(normalized)) {
    return 'state-warn';
  }

  if (['cancelled', 'canceled', 'blocked', 'failed'].includes(normalized)) {
    return 'state-danger';
  }

  return '';
}

function hasRenderableActivePicks() {
  return Array.isArray(currentStatus?.activePicks) && currentStatus.activePicks.length > 0;
}

function setActivePicksExpanded(nextExpanded) {
  const expanded = Boolean(nextExpanded) && hasRenderableActivePicks();

  activePicksExpanded = expanded;
  elements.activePicksDetails.hidden = !expanded;
  elements.activePicksPanel.setAttribute('aria-expanded', String(expanded));
  elements.activePicksPanel.tabIndex = hasRenderableActivePicks() ? 0 : -1;
  elements.activePicksPanel.classList.toggle('is-open', expanded);
  elements.activePicksPanel.classList.toggle('is-disabled', !hasRenderableActivePicks());
}

function toggleActivePicks() {
  if (!hasRenderableActivePicks()) {
    return;
  }

  setActivePicksExpanded(!activePicksExpanded);
}

function createStatusBadge(text, toneClass) {
  const badge = document.createElement('span');
  badge.className = `tracked-pick-badge${toneClass ? ` ${toneClass}` : ''}`;
  badge.textContent = text;
  return badge;
}

function createActivePickCard(pick) {
  const card = document.createElement('article');
  card.className = 'tracked-pick-card';

  const header = document.createElement('div');
  header.className = 'tracked-pick-header';

  const heading = document.createElement('div');

  const title = document.createElement('h3');
  title.textContent = pick.event || 'Unknown event';
  heading.append(title);

  const summary = document.createElement('p');
  summary.className = 'tracked-pick-summary';
  summary.textContent = pick.summary || 'No slip summary available.';
  heading.append(summary);

  const badges = document.createElement('div');
  badges.className = 'tracked-pick-badges';
  badges.append(createStatusBadge(pick.sportLabel || 'Pick', ''));
  badges.append(createStatusBadge(formatStatusLabel(pick.status || 'watching'), getStatusToneClass(pick.status)));

  if (pick.isReplacement) {
    badges.append(createStatusBadge('Replacement Live', 'state-warn'));
  }

  header.append(heading, badges);
  card.append(header);

  const primaryMetaParts = [
    pick.betType ? String(pick.betType).toUpperCase() : '',
    Number.isFinite(Number(pick.stakeUnits)) ? `Stake ${Number(pick.stakeUnits).toFixed(2)}u` : '',
    formatDecimalOdds(pick.priceDecimal) ? `Odds ${formatDecimalOdds(pick.priceDecimal)}` : '',
    pick.confidenceTier ? `${formatStatusLabel(pick.confidenceTier)} confidence` : '',
    pick.supportProjection ? `${formatStatusLabel(pick.supportProjection)} support` : ''
  ].filter(Boolean);

  if (primaryMetaParts.length) {
    const primaryMeta = document.createElement('p');
    primaryMeta.className = 'tracked-pick-meta';
    primaryMeta.textContent = primaryMetaParts.join(' | ');
    card.append(primaryMeta);
  }

  const secondaryMetaParts = [
    pick.postedAt ? `Posted ${formatDate(pick.postedAt)}` : '',
    pick.nextCheckAt ? `Next check ${formatDate(pick.nextCheckAt)}` : '',
    pick.lastCheckedAt ? `Last checked ${formatDate(pick.lastCheckedAt)}` : ''
  ].filter(Boolean);

  if (secondaryMetaParts.length) {
    const secondaryMeta = document.createElement('p');
    secondaryMeta.className = 'tracked-pick-meta';
    secondaryMeta.textContent = secondaryMetaParts.join(' | ');
    card.append(secondaryMeta);
  }

  if (pick.lastDecision || pick.lastValidationStatus) {
    const decisionMeta = document.createElement('p');
    decisionMeta.className = 'tracked-pick-meta';
    decisionMeta.textContent = [
      pick.lastDecision ? `Last decision ${formatStatusLabel(pick.lastDecision)}` : '',
      pick.lastValidationStatus ? `Validation ${formatStatusLabel(pick.lastValidationStatus)}` : ''
    ].filter(Boolean).join(' | ');
    card.append(decisionMeta);
  }

  if (Array.isArray(pick.legs) && pick.legs.length) {
    const legs = document.createElement('div');
    legs.className = 'tracked-pick-legs';

    for (const leg of pick.legs) {
      const legRow = document.createElement('div');
      legRow.className = 'tracked-pick-leg';

      const legLabel = document.createElement('span');
      legLabel.className = 'tracked-pick-leg-label';
      legLabel.textContent = leg.label || 'Unnamed leg';
      legRow.append(legLabel);

      if (leg.status) {
        const legStatus = document.createElement('span');
        legStatus.className = `tracked-pick-leg-status${getStatusToneClass(leg.status) ? ` ${getStatusToneClass(leg.status)}` : ''}`;
        legStatus.textContent = formatStatusLabel(leg.status);
        legRow.append(legStatus);
      }

      legs.append(legRow);
    }

    card.append(legs);
  } else {
    appendMetaMessage(card, 'Structured leg details are unavailable for this tracked slip.');
  }

  return card;
}

function renderActivePicks(picks) {
  clearNode(elements.activePicksList);

  if (!Array.isArray(picks) || !picks.length) {
    appendMetaMessage(elements.activePicksList, 'No picks currently under watch.');
    return;
  }

  for (const pick of picks) {
    elements.activePicksList.append(createActivePickCard(pick));
  }
}

function createPlanItem(title, badgeText, metaText, noteText) {
  const card = document.createElement('article');
  card.className = 'plan-item';

  const header = document.createElement('div');
  header.className = 'plan-item-header';

  const titleElement = document.createElement('strong');
  titleElement.textContent = title;
  header.append(titleElement);

  if (badgeText) {
    const badge = document.createElement('span');
    badge.className = 'plan-badge';
    badge.textContent = badgeText;
    header.append(badge);
  }

  const meta = document.createElement('p');
  meta.className = 'plan-item-meta';
  meta.textContent = metaText;

  card.append(header, meta);

  if (noteText) {
    const note = document.createElement('p');
    note.className = 'plan-item-note';
    note.textContent = noteText;
    card.append(note);
  }

  return card;
}

function renderReferralPlan(plan) {
  clearNode(elements.referralPlanSteps);
  clearNode(elements.referralPlanDeferred);

  if (!plan?.steps?.length) {
    elements.referralPlanSummary.textContent = 'Run the referrals job once to build the current ladder.';
    elements.referralPlanDeferredSummary.textContent = 'Offers land here when value is unclear, capital is still too high, or the public-sharing policy is restrictive.';
    appendMetaMessage(elements.referralPlanSteps, 'No referral capital plan available yet.');
    appendMetaMessage(elements.referralPlanDeferred, 'No deferred offers yet.');
    return;
  }

  const trackedOffers = Number(plan.trackedOffers || 0);
  const fetchFailures = Number(plan.fetchFailures || 0);
  elements.referralPlanSummary.textContent = `Start ${formatAudAmount(plan.startingCapitalAud)} | Est. finish ${formatAudAmount(plan.projectedEndingCapitalAud)} | ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} | ~${Number(plan.totalEstimatedDays || 0).toFixed(Number(plan.totalEstimatedDays || 0) % 1 === 0 ? 0 : 1)} day${Number(plan.totalEstimatedDays || 0) === 1 ? '' : 's'}${trackedOffers > 0 ? ` | ${trackedOffers} tracked offer${trackedOffers === 1 ? '' : 's'}` : ''}${plan.updatedAt ? ` | Synced ${formatDate(plan.updatedAt)}` : ''}`;
  elements.referralPlanDeferredSummary.textContent = fetchFailures > 0
    ? `${fetchFailures} referral source${fetchFailures === 1 ? '' : 's'} failed on the last sync, so stale entries may remain in the deferred list.`
    : 'Offers land here when value is unclear, capital is still too high, or the public-sharing policy is restrictive.';

  for (const step of plan.steps) {
    elements.referralPlanSteps.append(createPlanItem(
      `${step.order}. ${step.brand} - ${step.title}`,
      formatAudGain(step.combinedAdvertisedValueAud),
      `Bank ${formatAudAmount(step.startingCapitalAud)} -> ${formatAudAmount(step.projectedEndingCapitalAud)} | Need ${formatAudAmount(step.activationCapitalAud)} working capital | Payout ~${Number(step.estimatedPayoutDays || 0).toFixed(Number(step.estimatedPayoutDays || 0) % 1 === 0 ? 0 : 1)} day${Number(step.estimatedPayoutDays || 0) === 1 ? '' : 's'}`,
      step.rationale || ''
    ));
  }

  if (Array.isArray(plan.deferred) && plan.deferred.length) {
    for (const item of plan.deferred) {
      elements.referralPlanDeferred.append(createPlanItem(
        `${item.brand} - ${item.title}`,
        item.combinedAdvertisedValueAud ? formatAudGain(item.combinedAdvertisedValueAud) : formatStatusLabel(item.status || 'review_required'),
        `Capital gate ${formatAudAmount(item.activationCapitalAud)} | Status ${formatStatusLabel(item.status || 'review_required')}`,
        item.reason || ''
      ));
    }
  } else {
    appendMetaMessage(elements.referralPlanDeferred, 'No deferred offers yet.');
  }
}

function createReferralReviewItem(item) {
  const card = document.createElement('article');
  card.className = 'plan-item';

  const header = document.createElement('div');
  header.className = 'plan-item-header';

  const title = document.createElement('strong');
  title.textContent = `${item.brand} - ${item.title}`;
  header.append(title);

  const badge = document.createElement('span');
  badge.className = 'plan-badge';
  badge.textContent = Number.isFinite(Number(item.score)) ? `${Number(item.score)}/100` : formatStatusLabel(item.confidence || 'medium');
  header.append(badge);

  const meta = document.createElement('p');
  meta.className = 'plan-item-meta';
  meta.textContent = `${item.rewardSummary} | ${item.requirementSummary}`;

  const note = document.createElement('p');
  note.className = 'plan-item-note';
  note.textContent = `${formatStatusLabel(item.status)} | ${formatStatusLabel(item.confidence)} confidence | ${formatStatusLabel(item.discoverySource)} | Last checked ${item.lastSuccessfulSyncAt ? formatDate(item.lastSuccessfulSyncAt) : 'Never'}`;

  card.append(header, meta, note);

  const sourceUrls = [item.officialOfferUrl, item.officialTermsUrl].filter(Boolean);

  if (sourceUrls.length) {
    const sources = document.createElement('p');
    sources.className = 'plan-item-meta';

    for (const [index, sourceUrl] of sourceUrls.entries()) {
      const link = document.createElement('a');
      link.className = 'referral-review-link';
      link.href = sourceUrl;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = index === 0 ? 'Offer page' : 'Terms page';
      sources.append(link);

      if (index < sourceUrls.length - 1) {
        sources.append(document.createTextNode(' | '));
      }
    }

    card.append(sources);
  }

  const actions = document.createElement('div');
  actions.className = 'referral-review-actions';

  const verifyButton = document.createElement('button');
  verifyButton.type = 'button';
  verifyButton.className = 'secondary-button compact-action';
  verifyButton.textContent = 'Verify';
  verifyButton.dataset.referralVerify = item.id;
  actions.append(verifyButton);

  card.append(actions);
  return card;
}

function renderReferralReview(review) {
  clearNode(elements.referralReviewList);

  const counts = review?.counts || {};
  elements.referralReviewSummary.textContent = `${Number(counts.pendingActive || 0)} pending active | ${Number(counts.verifiedActive || 0)} verified | ${Number(counts.inactive || 0)} inactive`;

  if (!Array.isArray(review?.items) || !review.items.length) {
    appendMetaMessage(elements.referralReviewList, 'No pending referrals right now.');
    return;
  }

  for (const item of review.items) {
    elements.referralReviewList.append(createReferralReviewItem(item));
  }
}

function formatStatusLabel(value) {
  return String(value || 'review_required')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatSlateSourceLabel(source) {
  if (source === 'sports-game-odds-fallback') {
    return 'SportsGameOdds fallback';
  }

  if (source === 'market-scrape') {
    return 'market scrape';
  }

  return source || 'manual run';
}

function formatForcedPickList(picks) {
  if (!Array.isArray(picks) || !picks.length) {
    return '';
  }

  const labels = picks.slice(0, 3).map((pick) => {
    const event = pick?.event || 'Unknown event';
    const legCount = Number(pick?.legCount || 0);
    return legCount > 0 ? `${event} (${legCount} legs)` : event;
  });

  if (picks.length > 3) {
    labels.push(`+${picks.length - 3} more`);
  }

  return labels.join(' | ');
}

function renderSettings(settings) {
  if (!settings) {
    return;
  }
  const pickRoles = settings.roleMentions?.picks || {};

  elements.settingDryRun.checked = Boolean(settings.dryRun);
  elements.settingAnalysisEngine.value = settings.analysis?.engine || 'rules';
  elements.settingWebhookSlates.value = settings.webhooks?.slates || '';
  elements.settingWebhookPicks.value = settings.webhooks?.picks || '';
  elements.settingWebhookPicksNba.value = settings.webhooks?.picksNba || '';
  elements.settingWebhookPicksMlb.value = settings.webhooks?.picksMlb || '';
  elements.settingWebhookPicksAfl.value = settings.webhooks?.picksAfl || '';
  elements.settingWebhookPicksNrl.value = settings.webhooks?.picksNrl || '';
  elements.settingWebhookPicksNfl.value = settings.webhooks?.picksNfl || '';
  elements.settingWebhookPicksEpl.value = settings.webhooks?.picksEpl || '';
  elements.settingWebhookPicksOther.value = settings.webhooks?.picksOther || '';
  elements.settingWebhookReferralsNew.value = settings.webhooks?.referralsNew || '';
  elements.settingWebhookReferralsUpdatedTerms.value = settings.webhooks?.referralsUpdatedTerms || '';
  elements.settingWebhookReferralsCancelled.value = settings.webhooks?.referralsCancelled || '';
  elements.settingWebhookReferralsMasterlist.value = settings.webhooks?.referralsMasterlist || '';
  setInputValue(elements.quickWebhookReferralsNew, settings.webhooks?.referralsNew || '');
  setInputValue(elements.quickWebhookReferralsUpdatedTerms, settings.webhooks?.referralsUpdatedTerms || '');
  setInputValue(elements.quickWebhookReferralsCancelled, settings.webhooks?.referralsCancelled || '');
  setInputValue(elements.quickWebhookReferralsMasterlist, settings.webhooks?.referralsMasterlist || '');
  elements.settingWebhookUnitTracking.value = settings.webhooks?.unitTracking || '';
  elements.settingWebhookUnitReport.value = settings.webhooks?.unitReport || '';
  elements.settingWebhookPromoAfl.value = settings.webhooks?.promoAfl || '';
  elements.settingWebhookPromoNrl.value = settings.webhooks?.promoNrl || '';
  elements.settingWebhookPromoTennis.value = settings.webhooks?.promoTennis || '';
  elements.settingWebhookPromoSoccer.value = settings.webhooks?.promoSoccer || '';
  elements.settingWebhookEvidence.value = settings.webhooks?.evidence || '';
  elements.settingRoleEnabled.checked = Boolean(settings.roleMentions?.enabled);
  elements.settingRoleText.value = settings.roleMentions?.slates || '';
  elements.settingRoleSlates.value = pickRoles.shared || '';
  elements.settingRolePicksNba.value = pickRoles.nba || '';
  elements.settingRolePicksMlb.value = pickRoles.mlb || '';
  elements.settingRolePicksAfl.value = pickRoles.afl || '';
  elements.settingRolePicksNrl.value = pickRoles.nrl || '';
  elements.settingRolePicksNfl.value = pickRoles.nfl || '';
  elements.settingRolePicksEpl.value = pickRoles.epl || '';
  elements.settingRolePicksOther.value = pickRoles.other || '';
  settingsLoaded = true;
}

function renderSettlementPickSelect(activePicks) {
  settlementActivePicks = Array.isArray(activePicks) ? activePicks : [];
  clearNode(elements.settlementPickSelect);

  if (!settlementActivePicks.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No active slips to settle';
    elements.settlementPickSelect.append(opt);
    elements.settlementPickMeta.textContent = 'No active slips. Active slips appear here once the daemon has posted bets.';
    clearNode(elements.settlementLegsList);
    return;
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a slip...';
  elements.settlementPickSelect.append(placeholder);

  for (const pick of settlementActivePicks) {
    const opt = document.createElement('option');
    opt.value = pick.id;
    opt.textContent = `${pick.event || 'Unknown event'}${pick.sportLabel ? ` â€” ${pick.sportLabel}` : ''}`;
    elements.settlementPickSelect.append(opt);
  }

  renderSettlementPickInfo(elements.settlementPickSelect.value);
}

function renderSettlementPickInfo(pickId) {
  const pick = settlementActivePicks.find((p) => p.id === pickId);
  clearNode(elements.settlementLegsList);

  if (!pick) {
    elements.settlementPickMeta.textContent = 'Select an active slip above.';
    return;
  }

  elements.settlementPickMeta.textContent = [
    pick.summary || pick.event,
    pick.postedAt ? `Posted ${formatDate(pick.postedAt)}` : '',
    pick.stakeUnits ? `${formatUnits(pick.stakeUnits)} stake` : ''
  ].filter(Boolean).join(' | ');

  if (Array.isArray(pick.legs) && pick.legs.length) {
    for (const leg of pick.legs) {
      const row = document.createElement('div');
      row.className = 'settlement-leg-row';
      row.textContent = leg.label || 'Unnamed leg';
      elements.settlementLegsList.append(row);
    }
  }
}

async function submitSettlement() {
  const pickId = elements.settlementPickSelect.value;
  const result = elements.settlementResult.value;

  if (!pickId) {
    elements.settlementFeedback.textContent = 'Select an active slip first.';
    return;
  }

  if (!result) {
    elements.settlementFeedback.textContent = 'Choose a result (Win, Loss, or Void) before submitting.';
    return;
  }

  elements.submitSettlement.disabled = true;
  elements.settlementFeedback.textContent = 'Settling...';

  try {
    const response = await window.sportsTipsDesktop.settlePickManually({
      pickId,
      result,
      notes: elements.settlementNotes.value.trim()
    });

    elements.settlementFeedback.textContent = response.dryRun
      ? 'Dry-run: settlement simulated but not written to disk.'
      : 'Settlement recorded. The slip has been removed from the active list.';

    elements.settlementResult.value = '';
    elements.settlementNotes.value = '';
    await refresh();
  } catch (error) {
    elements.settlementFeedback.textContent = error.message;
  } finally {
    elements.submitSettlement.disabled = false;
  }
}

function collectSettings() {
  return {
    dryRun: elements.settingDryRun.checked,
    analysis: {
      engine: elements.settingAnalysisEngine.value
    },
    webhooks: {
      slates: elements.settingWebhookSlates.value.trim(),
      picks: elements.settingWebhookPicks.value.trim(),
      picksNba: elements.settingWebhookPicksNba.value.trim(),
      picksMlb: elements.settingWebhookPicksMlb.value.trim(),
      picksAfl: elements.settingWebhookPicksAfl.value.trim(),
      picksNrl: elements.settingWebhookPicksNrl.value.trim(),
      picksNfl: elements.settingWebhookPicksNfl.value.trim(),
      picksEpl: elements.settingWebhookPicksEpl.value.trim(),
      picksOther: elements.settingWebhookPicksOther.value.trim(),
      referralsNew: elements.settingWebhookReferralsNew.value.trim(),
      referralsUpdatedTerms: elements.settingWebhookReferralsUpdatedTerms.value.trim(),
      referralsCancelled: elements.settingWebhookReferralsCancelled.value.trim(),
      referralsMasterlist: elements.settingWebhookReferralsMasterlist.value.trim(),
      unitTracking: elements.settingWebhookUnitTracking.value.trim(),
      unitReport: elements.settingWebhookUnitReport.value.trim(),
      promoAfl: elements.settingWebhookPromoAfl.value.trim(),
      promoNrl: elements.settingWebhookPromoNrl.value.trim(),
      promoTennis: elements.settingWebhookPromoTennis.value.trim(),
      promoSoccer: elements.settingWebhookPromoSoccer.value.trim(),
      evidence: elements.settingWebhookEvidence.value.trim()
    },
    roleMentions: {
      enabled: elements.settingRoleEnabled.checked,
      slates: elements.settingRoleText.value.trim(),
      picks: {
        shared: elements.settingRoleSlates.value.trim(),
        nba: elements.settingRolePicksNba.value.trim(),
        mlb: elements.settingRolePicksMlb.value.trim(),
        afl: elements.settingRolePicksAfl.value.trim(),
        nrl: elements.settingRolePicksNrl.value.trim(),
        nfl: elements.settingRolePicksNfl.value.trim(),
        epl: elements.settingRolePicksEpl.value.trim(),
        other: elements.settingRolePicksOther.value.trim()
      }
    }
  };
}

function render(status) {
  currentStatus = status;
  const running = Boolean(status.running);
  elements.toggleButton.textContent = running ? 'Turn Off' : 'Turn On';
  elements.toggleButton.classList.toggle('is-running', running);
  elements.toggleButton.disabled = busy;

  elements.daemonState.textContent = running ? 'Running' : 'Stopped';
  elements.daemonState.className = running ? 'value state-ok' : 'value state-danger';
  elements.daemonMeta.textContent = running
    ? `PID ${status.pid} | Heartbeat ${formatDate(status.heartbeatAt)}`
    : `Last stop reason: ${status.stopReason || 'Not recorded'}`;

  elements.creditsValue.textContent = status.lastMarketQuoteCount === null ? 'Unknown' : String(status.lastMarketQuoteCount);
  elements.watchedPicks.textContent = String(status.watchedPicks || 0);
  elements.watchedPicksMeta.textContent = Number(status.watchedPicks || 0) > 0
    ? `${Number(status.watchedPicks || 0)} tracked slip${Number(status.watchedPicks || 0) === 1 ? '' : 's'} currently under watch. Click to ${activePicksExpanded ? 'hide' : 'show'} the games and legs.`
    : 'No picks are currently under watch.';
  elements.timezoneValue.textContent = status.timezone || '-';
  elements.dryRunValue.textContent = `${status.running ? 'Daemon' : 'Saved config'} ${status.dryRun ? 'dry run is ON' : 'dry run is OFF'}${status.settingsApplyRequiresRestart ? ' | Restart needed to apply saved webhook/live-mode changes' : ''} | Analysis ${String(status.analysisEngine || 'rules').toUpperCase()}${status.lastMarketRefreshAt ? ` | Scrape ${formatDate(status.lastMarketRefreshAt)}` : ''}`;
  renderActivePicks(status.activePicks || []);
  setActivePicksExpanded(activePicksExpanded);
  renderSettlementPickSelect(status.activePicks || []);
  renderReanalyzePickSelect(status.activePicks || []);

  if (status.trackerSummary) {
    elements.trackerUnitsValue.textContent = `Bankroll ${formatUnits(status.trackerSummary.currentUnits)}`;
    elements.trackerUnitsMeta.textContent = `Start ${formatUnits(status.trackerSummary.startingBankrollUnits)} | Net ${formatSignedUnits(status.trackerSummary.totalNetUnits)} | Open ${formatUnits(status.trackerSummary.openExposureUnits)} | 30 Day ROI ${formatPercent(status.trackerSummary.rollingBankrollRoiPercent)}`;
    elements.trackerSportBreakdown.textContent = formatTrackerBreakdown(status.trackerSummary);
  } else {
    elements.trackerUnitsValue.textContent = '0.00u';
    elements.trackerUnitsMeta.textContent = 'Current bankroll, open exposure, and 30-day ROI from the bankroll tracker.';
    elements.trackerSportBreakdown.textContent = 'No tracked bankroll performance yet.';
  }

  setWebhookState(elements.webhookSlates, status.webhookConfigured?.slates);
  setWebhookState(elements.webhookPicks, status.webhookConfigured?.picks);
  setWebhookState(elements.webhookPicksNba, status.webhookConfigured?.picksNba);
  setWebhookState(elements.webhookPicksMlb, status.webhookConfigured?.picksMlb);
  setWebhookState(elements.webhookPicksAfl, status.webhookConfigured?.picksAfl);
  setWebhookState(elements.webhookPicksNrl, status.webhookConfigured?.picksNrl);
  setWebhookState(elements.webhookPicksNfl, status.webhookConfigured?.picksNfl);
  setWebhookState(elements.webhookPicksEpl, status.webhookConfigured?.picksEpl);
  setWebhookState(elements.webhookPicksOther, status.webhookConfigured?.picksOther);
  setWebhookState(elements.webhookReferralsNew, status.webhookConfigured?.referralsNew);
  setWebhookState(elements.webhookReferralsUpdatedTerms, status.webhookConfigured?.referralsUpdatedTerms);
  setWebhookState(elements.webhookReferralsCancelled, status.webhookConfigured?.referralsCancelled);
  setWebhookState(elements.webhookReferralsMasterlist, status.webhookConfigured?.referralsMasterlist);
  setWebhookState(elements.webhookUnitTracking, status.webhookConfigured?.unitTracking);
  setWebhookState(elements.webhookUnitReport, status.webhookConfigured?.unitReport);
  renderReferralReview(status.referralReview);
  renderReferralPlan(status.referralPlan);

  elements.configPath.textContent = status.configPath || '';

  if (!settingsLoaded || !settingsDirty) {
    renderSettings(status.settings);
  }

  if (!settingsDirty) {
    elements.settingsFeedback.textContent = status.settingsApplyRequiresRestart
      ? 'Daemon is running on older settings. Restart it to apply saved webhook/live-mode changes.'
      : status.running
        ? 'Daemon is using the current saved settings.'
        : 'Settings are loaded from config.json.';

    elements.referralWebhookFeedback.textContent = status.settingsApplyRequiresRestart
      ? 'Saved referral webhook changes need a daemon restart to go live.'
      : 'Paste matching referral webhook URLs here and save.';
  }
}

async function refresh() {
  const status = await window.sportsTipsDesktop.getStatus();
  render(status);
  return status;
}

async function toggleDaemon() {
  busy = true;
  elements.toggleButton.disabled = true;

  try {
    const status = await window.sportsTipsDesktop.getStatus();

    if (status.running) {
      render(await window.sportsTipsDesktop.stopDaemon());
    } else {
      render(await window.sportsTipsDesktop.startDaemon());
    }
  } finally {
    busy = false;
    await refresh();
  }
}

async function saveSettings(feedbackTargets = [elements.settingsFeedback]) {
  const targets = [...new Set(feedbackTargets.filter(Boolean))];

  elements.saveSettings.disabled = true;
  elements.saveReferralWebhooks.disabled = true;

  for (const target of targets) {
    target.textContent = 'Saving settings...';
  }

  try {
    const status = await window.sportsTipsDesktop.saveSettings(collectSettings());
    settingsDirty = false;
    render(status);
    const successMessage = status.settingsApplyRequiresRestart
      ? 'Saved. Restart the daemon to use the new settings.'
      : 'Saved.';

    for (const target of targets) {
      target.textContent = successMessage;
    }
  } catch (error) {
    for (const target of targets) {
      target.textContent = error.message;
    }
  } finally {
    elements.saveSettings.disabled = false;
    elements.saveReferralWebhooks.disabled = false;
  }
}

async function forceDailyCheck() {
  elements.forceDailyCheck.disabled = true;
  elements.quickActionsFeedback.textContent = 'Resetting today\'s generated state, refreshing the market snapshot, and running slates, analysis, and picks...';

  try {
    const result = await window.sportsTipsDesktop.forceDailyCheck();
    const postedPickList = formatForcedPickList(result.picks?.picks);
    const pickSummary = result.picks?.posted > 0
      ? `${result.dryRun ? 'Prepared' : 'Posted'} ${result.picks.posted} pick${result.picks.posted === 1 ? '' : 's'}${postedPickList ? `: ${postedPickList}` : '.'}`
      : `Posted 0 picks${result.picks?.watched ? `, ${result.picks.watched} watched` : ''}.`;

    elements.quickActionsFeedback.textContent = `${result.dryRun ? 'Dry-run daily check completed.' : 'Force daily check completed.'} Cleared ${result.prepare.removedGeneratedFeedPicks} generated feed picks, ${result.prepare.removedPostedPickIds} posted pick ids, and ${result.prepare.removedTrackingPickIds} tracked generated entries. Slate messages: ${result.slates.posted}. Analysis generated ${result.analysis.generated} from ${result.analysis.considered} events. ${pickSummary}`;

    await refresh();
  } catch (error) {
    elements.quickActionsFeedback.textContent = error.message;
  } finally {
    elements.forceDailyCheck.disabled = false;
  }
}

async function reviewResults() {
  elements.reviewResults.disabled = true;
  elements.quickActionsFeedback.textContent = 'Reviewing open bets, settling anything final, refreshing tracked units, and posting the current unit report...';

  try {
    const result = await window.sportsTipsDesktop.reviewResults();
    const trackerSummary = result.trackerSummary;
    const dayLabel = trackerSummary?.trackerDayNumber ? `Day ${trackerSummary.trackerDayNumber}` : 'the current tracker day';
    const bankrollSummary = trackerSummary
      ? `${formatSignedUnits(trackerSummary.totalNetUnits)} total | Bankroll ${formatUnits(trackerSummary.currentUnits)}`
      : 'Tracker summary unavailable.';

    elements.quickActionsFeedback.textContent = `${result.dryRun ? 'Dry-run results review complete.' : 'Results review complete.'} Settlements posted: ${result.settlementsPosted}. Auto-settled: ${result.autoSettled}. Pending review: ${result.pendingReview}. ${result.dryRun ? 'Prepared' : 'Posted'} ${result.unitReportPosted} unit report message${result.unitReportPosted === 1 ? '' : 's'} for ${dayLabel}. ${bankrollSummary}`;

    await refresh();
  } catch (error) {
    elements.quickActionsFeedback.textContent = error.message;
  } finally {
    elements.reviewResults.disabled = false;
  }
}

async function forcePostPicks() {
  elements.forcePostPicks.disabled = true;
  elements.quickActionsFeedback.textContent = 'Posting currently approved picks now...';

  try {
    const result = await window.sportsTipsDesktop.forcePostPicks();
    const pickList = formatForcedPickList(result.picks);

    elements.quickActionsFeedback.textContent = result.posted > 0
      ? `${result.dryRun ? 'Prepared' : 'Posted'} ${result.posted} approved pick${result.posted === 1 ? '' : 's'}${pickList ? `: ${pickList}` : '.'}${result.dryRun ? ' Dry-run mode kept Discord unchanged.' : ''}`
      : `No current approved picks were ready to force post.${result.watched ? ` ${result.watched} watched pick${result.watched === 1 ? '' : 's'} remain under the normal scheduler.` : ''}`;

    await refresh();
  } catch (error) {
    elements.quickActionsFeedback.textContent = error.message;
  } finally {
    elements.forcePostPicks.disabled = false;
  }
}

async function runReferralsNow() {
  elements.runReferralsNow.disabled = true;
  elements.runReferralsFeedback.textContent = 'Running the referrals monitor now, refreshing the ladder, and publishing any referral changes...';

  try {
    const result = await window.sportsTipsDesktop.runReferralsNow();
    const changeSummary = `${result.newCount} new, ${result.updatedCount} updated, ${result.cancelledCount} cancelled`;
    const fetchFailureSummary = result.fetchFailureCount > 0
      ? ` ${result.fetchFailureCount} fetch failure${result.fetchFailureCount === 1 ? '' : 's'} need review.`
      : '';

    elements.runReferralsFeedback.textContent = result.changes > 0
      ? `${result.dryRun ? 'Prepared' : 'Processed'} ${result.changes} referral change${result.changes === 1 ? '' : 's'} across ${result.offers} tracked offer${result.offers === 1 ? '' : 's'} (${changeSummary}). ${result.dryRun ? 'Dry-run kept Discord unchanged.' : `Posted ${result.posted} referral webhook message${result.posted === 1 ? '' : 's'} and refreshed the masterlist.`}${fetchFailureSummary}`
      : `${result.dryRun ? 'Dry-run' : 'Referrals run'} completed. No referral changes were detected across ${result.offers} tracked offer${result.offers === 1 ? '' : 's'}; the masterlist was refreshed.${fetchFailureSummary}`;

    await refresh();
  } catch (error) {
    elements.runReferralsFeedback.textContent = error.message;
  } finally {
    elements.runReferralsNow.disabled = false;
  }
}

let reanalyzeLastResult = null;

function renderReanalyzePickSelect(activePicks) {
  const now = Date.now();
  const pregame = (activePicks || []).filter((pick) => {
    const start = pick.startTime ? new Date(pick.startTime).getTime() : Number.NaN;
    return Number.isFinite(start) && start > now;
  });

  elements.reanalyzePickSelect.innerHTML = pregame.length === 0
    ? '<option value="">No pre-game slips available</option>'
    : ['<option value="">Select a pre-game slip...</option>',
        ...pregame.map((pick) => {
          const label = pick.event || pick.summary || pick.id;
          const sport = pick.sport ? ` (${pick.sport.toUpperCase()})` : '';
          return `<option value="${pick.id}">${label}${sport}</option>`;
        })
      ].join('');
}

async function reanalyzeSlip() {
  const pickId = elements.reanalyzePickSelect.value;

  if (!pickId) {
    elements.reanalyzeFeedback.textContent = 'Select a pre-game slip first.';
    return;
  }

  elements.reanalyzeRunBtn.disabled = true;
  elements.reanalyzeResult.hidden = true;
  elements.reanalyzeFeedback.textContent = 'Running rules engine against current snapshot data...';
  reanalyzeLastResult = null;

  try {
    const result = await window.sportsTipsDesktop.reanalyzeSlip({ pickId });
    reanalyzeLastResult = result;

    elements.reanalyzeCurrentPick.textContent = result.originalSummary || '(no summary)';
    elements.reanalyzeNewPick.textContent = result.newSummary || 'No qualifying pick found.';
    elements.reanalyzeRationale.textContent = result.rationale || '';
    elements.reanalyzeResult.hidden = false;

    if (result.hasNewPick && result.newSummary !== result.originalSummary) {
      elements.applyReanalyzedPickBtn.hidden = false;
      elements.reanalyzeFeedback.textContent = 'New pick found — review and apply if it looks better.';
    } else {
      elements.applyReanalyzedPickBtn.hidden = true;
      elements.reanalyzeFeedback.textContent = result.hasNewPick
        ? 'Rules engine produced the same pick as the current one. No change needed.'
        : 'Rules engine found no qualifying pick for this event.';
    }
  } catch (error) {
    elements.reanalyzeFeedback.textContent = error.message;
  } finally {
    elements.reanalyzeRunBtn.disabled = false;
  }
}

async function applyReanalyzedPick() {
  if (!reanalyzeLastResult) {
    elements.reanalyzeFeedback.textContent = 'Run a re-analysis first.';
    return;
  }

  elements.applyReanalyzedPickBtn.disabled = true;
  elements.reanalyzeFeedback.textContent = 'Applying new pick...';

  try {
    const response = await window.sportsTipsDesktop.applyReanalyzedPick({
      pickId: reanalyzeLastResult.originalPickId,
      newPick: reanalyzeLastResult.newPick
    });

    elements.reanalyzeFeedback.textContent = response.dryRun
      ? 'Dry-run: new pick simulated, picks feed unchanged.'
      : 'New pick applied. Picks feed updated.';

    elements.applyReanalyzedPickBtn.hidden = true;
    elements.reanalyzeResult.hidden = true;
    reanalyzeLastResult = null;
    await refresh();
  } catch (error) {
    elements.reanalyzeFeedback.textContent = error.message;
  } finally {
    elements.applyReanalyzedPickBtn.disabled = false;
  }
}

async function analyzeAllSlips() {
  elements.analyzeAllSlipsBtn.disabled = true;
  elements.quickActionsFeedback.textContent = 'Re-analyzing all pre-game slips against the current rules...';

  try {
    const result = await window.sportsTipsDesktop.analyzeAllSlips();
    const { total, changed, unchanged, noBet, failed, applied, dryRun, results } = result;

    if (!total) {
      elements.quickActionsFeedback.textContent = 'No active pre-game slips to analyze (all current slips have already started or settled).';
      return;
    }

    const verb = dryRun ? 'would be rebuilt' : 'rebuilt';
    const parts = [
      `Analyzed ${total} pre-game slip${total === 1 ? '' : 's'}:`,
      `${changed} ${verb}`,
      `${unchanged} unchanged`
    ];
    if (noBet) parts.push(`${noBet} no longer qualify`);
    if (failed) parts.push(`${failed} failed`);
    if (dryRun) parts.push('(dry run — nothing saved)');

    const rebuilt = (results || []).filter((r) => r.changed);
    const detail = rebuilt.length
      ? ' ' + rebuilt.map((r) => `${r.sport}: "${r.originalSummary}" → "${r.newSummary}"`).join('; ')
      : '';

    elements.quickActionsFeedback.textContent = parts.join(', ') + '.' + detail;
  } catch (error) {
    elements.quickActionsFeedback.textContent = error.message;
  } finally {
    elements.analyzeAllSlipsBtn.disabled = false;
  }
}

async function fullScan() {
  elements.fullScanBtn.disabled = true;
  elements.quickActionsFeedback.textContent = 'Full scan: posting daily slates, generating + re-evaluating picks, settling results...';

  try {
    const r = await window.sportsTipsDesktop.fullScan();
    const parts = [
      `Full scan complete${r.dryRun ? ' (dry run)' : ''}`,
      `${r.slatesPosted} slate post${r.slatesPosted === 1 ? '' : 's'}`,
      `${r.analysisGenerated} generated / ${r.analysisConsidered} considered`,
      `${r.picksPosted} pick${r.picksPosted === 1 ? '' : 's'} posted`,
      `${r.resultsPosted} result${r.resultsPosted === 1 ? '' : 's'} (${r.autoSettled} settled, ${r.pendingReview} pending)`
    ];
    if (Array.isArray(r.errors) && r.errors.length) {
      parts.push(`${r.errors.length} job error${r.errors.length === 1 ? '' : 's'}: ${r.errors.join('; ')}`);
    }
    elements.quickActionsFeedback.textContent = parts.join(' · ') + '.';
  } catch (error) {
    elements.quickActionsFeedback.textContent = error.message;
  } finally {
    elements.fullScanBtn.disabled = false;
  }
}

async function verifyReferral(offerId) {
  if (!offerId) {
    return;
  }

  elements.referralReviewFeedback.textContent = 'Verifying referral, removing it from New Referrals, and refreshing the masterlist...';

  try {
    const result = await window.sportsTipsDesktop.verifyReferral({ offerId });
    elements.referralReviewFeedback.textContent = result.dryRun
      ? 'Dry-run verification completed. Discord was not changed.'
      : 'Referral verified and promoted into the masterlist.';
    await refresh();
  } catch (error) {
    elements.referralReviewFeedback.textContent = error.message;
  }
}

for (const input of [
  elements.settingDryRun,
  elements.settingAnalysisEngine,
  elements.settingWebhookSlates,
  elements.settingWebhookPicks,
  elements.settingWebhookPicksNba,
  elements.settingWebhookPicksMlb,
  elements.settingWebhookPicksAfl,
  elements.settingWebhookPicksNrl,
  elements.settingWebhookPicksNfl,
  elements.settingWebhookPicksEpl,
  elements.settingWebhookPicksOther,
  elements.settingWebhookUnitTracking,
  elements.settingWebhookUnitReport,
  elements.settingWebhookPromoAfl,
  elements.settingWebhookPromoNrl,
  elements.settingWebhookPromoTennis,
  elements.settingWebhookPromoSoccer,
  elements.settingWebhookEvidence,
  elements.settingRoleEnabled,
  elements.settingRoleText,
  elements.settingRoleSlates,
  elements.settingRolePicksNba,
  elements.settingRolePicksMlb,
  elements.settingRolePicksAfl,
  elements.settingRolePicksNrl,
  elements.settingRolePicksNfl,
  elements.settingRolePicksEpl,
  elements.settingRolePicksOther
]) {
  input.addEventListener('input', () => {
    markSettingsDirty();
  });
  input.addEventListener('change', () => {
    markSettingsDirty();
  });
}

for (const [settingKey, quickKey] of referralWebhookInputPairs) {
  bindMirroredInputs(settingKey, quickKey);
}

elements.toggleButton.addEventListener('click', () => {
  toggleDaemon().catch((error) => {
    elements.daemonMeta.textContent = error.message;
    busy = false;
    elements.toggleButton.disabled = false;
  });
});

elements.activePicksPanel.addEventListener('click', () => {
  toggleActivePicks();
});

elements.activePicksPanel.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggleActivePicks();
  }
});

elements.saveSettings.addEventListener('click', () => {
  saveSettings([elements.settingsFeedback]);
});

elements.saveReferralWebhooks.addEventListener('click', () => {
  saveSettings([elements.settingsFeedback, elements.referralWebhookFeedback]);
});

elements.openConfig.addEventListener('click', () => {
  window.sportsTipsDesktop.openConfig();
});

elements.forceDailyCheck.addEventListener('click', () => {
  forceDailyCheck();
});

elements.forcePostPicks.addEventListener('click', () => {
  forcePostPicks();
});

elements.reviewResults.addEventListener('click', () => {
  reviewResults();
});

elements.reanalyzeSlipBtn.addEventListener('click', () => {
  const panel = elements.reanalyzeSlipBtn.closest('details');
  if (panel && !panel.open) {
    panel.open = true;
  }
  reanalyzeSlip();
});

elements.reanalyzeRunBtn.addEventListener('click', () => {
  reanalyzeSlip();
});

elements.applyReanalyzedPickBtn.addEventListener('click', () => {
  applyReanalyzedPick();
});

elements.analyzeAllSlipsBtn.addEventListener('click', () => {
  analyzeAllSlips();
});

elements.fullScanBtn.addEventListener('click', () => {
  fullScan();
});

elements.runReferralsNow.addEventListener('click', () => {
  runReferralsNow();
});

elements.referralReviewList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-referral-verify]');

  if (!button) {
    return;
  }

  verifyReferral(button.dataset.referralVerify);
});

elements.settlementPickSelect.addEventListener('change', () => {
  renderSettlementPickInfo(elements.settlementPickSelect.value);
});

elements.submitSettlement.addEventListener('click', () => {
  submitSettlement();
});

refresh().catch((error) => {
  elements.daemonMeta.textContent = error.message;
});

async function runRefreshLoop() {
  try {
    await refresh();
  } catch (error) {
    elements.daemonMeta.textContent = error.message;
  } finally {
    refreshTimer = setTimeout(runRefreshLoop, 5000);
  }
}
runRefreshLoop();

window.addEventListener('beforeunload', () => {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
});
