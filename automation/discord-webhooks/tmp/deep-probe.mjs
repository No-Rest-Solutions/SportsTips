// READ-ONLY validation probe for the deep-analysis gate.
// Reuses the cached market snapshot + live ESPN data; writes nothing.
import fs from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
import { buildSnapshotEvents, getSnapshotEventQuotes } from '../src/web-market-intake.mjs';
import { buildAnalysisCandidatePool } from '../src/ai-pick-generator.mjs';
import { loadEventDeepEvidenceInputs, attachDeepEvidence } from '../src/jobs/analysis.mjs';

const config = await loadConfig();
const snapshot = JSON.parse(await fs.readFile(config.__paths.snapshotFile, 'utf8'));
const now = new Date();

function buildEventContext(sport, event) {
  return {
    sportKey: sport.key,
    sportLabel: sport.label,
    marketSportKey: sport.marketKey || sport.key,
    eventId: event.id,
    eventName: event.displayName || `${event.away_team} vs ${event.home_team}`,
    homeTeam: event.home_team,
    homeTeamId: event.homeTeamId || '',
    awayTeam: event.away_team,
    awayTeamId: event.awayTeamId || '',
    startTime: event.commence_time,
    timezone: config.timezone,
    generatorConfig: config.analysis.generator,
    deepAnalysis: { enabled: true, requireLegEvidence: true, recentGames: 5, minGames: 4, minHitRate: 0.6 }
  };
}

const targets = config.sports.filter((s) => s.enabled && (s.marketKey || s.key));

for (const sport of targets) {
  const events = buildSnapshotEvents(snapshot, config, sport, now).slice(0, 1);
  if (!events.length) {
    console.log(`\n=== ${sport.key} === no events in snapshot`);
    continue;
  }

  for (const event of events) {
    const eventContext = buildEventContext(sport, event);
    const quotes = Array.isArray(event.snapshotQuotes) && event.snapshotQuotes.length
      ? event.snapshotQuotes
      : getSnapshotEventQuotes(snapshot, config, sport.marketKey || sport.key, event);
    const pool = buildAnalysisCandidatePool(eventContext, quotes, 14);

    console.log(`\n=== ${sport.key} === ${eventContext.eventName} | ${pool.length} candidates | path=${sport.path || 'NONE'}`);

    let inputs;
    try {
      inputs = await loadEventDeepEvidenceInputs(sport, eventContext, {}, {}, { fetchBoxscores: true });
    } catch (e) {
      console.log(`  loader error: ${e.message}`);
      continue;
    }
    console.log(`  form: home=${inputs.homeForm ? inputs.homeForm.games + 'g' : 'none'} away=${inputs.awayForm ? inputs.awayForm.games + 'g' : 'none'} | boxscores home=${(inputs.boxscoresBySide.get('home') || []).length} away=${(inputs.boxscoresBySide.get('away') || []).length}`);

    const tagged = attachDeepEvidence(sport, eventContext, pool, inputs);
    const tally = {};
    for (const c of tagged) tally[c.evidenceStatus] = (tally[c.evidenceStatus] || 0) + 1;
    console.log(`  evidence tally:`, tally);

    for (const c of tagged.slice(0, 8)) {
      console.log(`   [${c.evidenceStatus}] ${c.market} ${c.outcomeName || ''} ${c.description || ''} ${c.point ?? ''} -> ${c.evidenceReason}`);
    }
  }
}
console.log('\nprobe done (no state written).');
