import fs from 'node:fs/promises';

import { loadConfig } from '../src/config.mjs';
import { buildAnalysisCandidatePool, analyzeEventWithRules } from '../src/ai-pick-generator.mjs';
import { mergeQuoteEntries } from '../src/pick-generator.mjs';
import { buildSnapshotEvents, getSnapshotEventQuotes } from '../src/web-market-intake.mjs';
import { enrichEventWithEspnMetadata, filterCandidatePoolForResearch } from '../src/jobs/analysis.mjs';

const config = await loadConfig();
const snapshot = JSON.parse(await fs.readFile(new URL('../bookmaker-snapshots.json', import.meta.url), 'utf8'));
const now = new Date();

const nrlSport = config.sports.find((s) => String(s.key).toLowerCase() === 'nrl');
const events = buildSnapshotEvents(snapshot, config, nrlSport, now);
console.log(`NRL events: ${events.length}`);

const context = { config, state: { jobs: {} } };
const bankrollContext = { currentBankroll: 100, pendingStakeExposure: 0, trackerDateKey: '2026-06-13', availableUnits: 10, unitSizeAud: 10 };
const scoreboardCache = new Map();
const researchCaches = { injury: new Map(), mlb: new Map(), mlbSupport: new Map(), weather: new Map(), form: new Map(), externalSignals: new Map() };

for (const event of events) {
  const enriched = await enrichEventWithEspnMetadata(config, nrlSport, event, scoreboardCache);
  const eventContext = {
    sportKey: nrlSport.key,
    sportLabel: nrlSport.label,
    marketSportKey: nrlSport.marketKey || nrlSport.key,
    eventId: enriched.id,
    espnEventId: enriched.espnEventId || '',
    eventName: enriched.displayName || `${enriched.away_team} vs ${enriched.home_team}`,
    homeTeam: enriched.home_team,
    homeTeamId: enriched.homeTeamId || '',
    awayTeam: enriched.away_team,
    awayTeamId: enriched.awayTeamId || '',
    startTime: enriched.commence_time,
    venue: enriched.venue || null,
    generatorConfig: config.analysis.generator
  };

  const snapshotQuotes = Array.isArray(enriched.snapshotQuotes) && enriched.snapshotQuotes.length
    ? enriched.snapshotQuotes
    : getSnapshotEventQuotes(snapshot, config, nrlSport.marketKey || nrlSport.key, enriched);
  const mergedQuotes = mergeQuoteEntries(snapshotQuotes);
  let candidatePool = buildAnalysisCandidatePool(eventContext, mergedQuotes, Number(config.analysis.maxCandidateLegsPerEvent || 14));
  const beforeResearch = candidatePool.map((c) => c.label);
  candidatePool = await filterCandidatePoolForResearch(nrlSport, eventContext, candidatePool, researchCaches);

  console.log(`\n========== ${eventContext.eventName}  (espnId:${eventContext.espnEventId || 'none'} venue:${eventContext.venue?.name || 'none'})`);
  const surviving = new Set(candidatePool.map((c) => c.label));
  for (const label of beforeResearch) {
    console.log(`  ${surviving.has(label) ? 'KEPT   ' : 'BLOCKED'} ${label}`);
  }
  for (const c of candidatePool) {
    if (c.researchStatus && c.researchStatus !== 'unverified') {
      console.log(`    research[${c.label}]: ${c.researchStatus} :: ${(c.researchReasons || []).join(' | ')}`);
    }
  }

  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, bankrollContext);
  console.log(`DECISION: qualifies=${decision.qualifies} rec=${decision.recommendation}`);
  console.log(`  summary: ${decision.summary}`);
  if (decision.noBetReason) console.log(`  noBetReason: ${decision.noBetReason}`);
  if (decision.notes) console.log(`  notes: ${decision.notes}`);
}
