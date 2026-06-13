import fs from 'node:fs/promises';

import { loadConfig } from '../src/config.mjs';
import { buildAnalysisCandidatePool, analyzeEventWithRules } from '../src/ai-pick-generator.mjs';
import { mergeQuoteEntries } from '../src/pick-generator.mjs';
import { buildSnapshotEvents, getSnapshotEventQuotes } from '../src/web-market-intake.mjs';

const config = await loadConfig();
const snapshot = JSON.parse(await fs.readFile(new URL('../bookmaker-snapshots.json', import.meta.url), 'utf8'));
const now = new Date();
const mlb = config.sports.find((s) => String(s.key).toLowerCase() === 'mlb');
const events = buildSnapshotEvents(snapshot, config, mlb, now);
console.log(`MLB events in window: ${events.length}`);

const context = { config, state: { jobs: {} } };
const bankroll = { currentBankroll: 100, pendingStakeExposure: 0, trackerDateKey: '2026-06-13', availableUnits: 10, unitSizeAud: 10 };

let posted = 0; let noBet = 0;
const sample = [];
for (const event of events) {
  const eventContext = {
    sportKey: mlb.key, sportLabel: mlb.label, marketSportKey: mlb.marketKey || mlb.key,
    eventId: event.id, eventName: event.displayName || `${event.away_team} vs ${event.home_team}`,
    homeTeam: event.home_team, awayTeam: event.away_team, startTime: event.commence_time,
    venue: event.venue || null, generatorConfig: config.analysis.generator
  };
  const snapshotQuotes = Array.isArray(event.snapshotQuotes) && event.snapshotQuotes.length
    ? event.snapshotQuotes
    : getSnapshotEventQuotes(snapshot, config, mlb.marketKey || mlb.key, event);
  const mergedQuotes = mergeQuoteEntries(snapshotQuotes);
  // NOTE: research filtering (filterCandidatePoolForResearch) is BYPASSED here — this
  // shows what the RULES alone produce, before live lineup/pitcher verification.
  const candidatePool = buildAnalysisCandidatePool(eventContext, mergedQuotes, Number(config.analysis.maxCandidateLegsPerEvent || 14));
  const decision = await analyzeEventWithRules(context, eventContext, candidatePool, bankroll);
  if (decision.qualifies) posted += 1; else noBet += 1;
  if (sample.length < 6) {
    sample.push({ ev: eventContext.eventName, pool: candidatePool, decision });
  }
}

console.log(`\nRULES-ONLY (no live research): qualifies=${posted}  no_bet=${noBet}  of ${events.length} events\n`);
for (const s of sample) {
  console.log(`===== ${s.ev}`);
  const hits = s.pool.filter((c) => /hit/i.test(c.label));
  const ks = s.pool.filter((c) => /strikeout/i.test(c.label));
  console.log(`  pool ${s.pool.length} | hit candidates ${hits.length} | strikeout candidates ${ks.length}`);
  for (const c of s.pool.slice(0, 10)) {
    console.log(`    ${String(c.market).padEnd(18)} | ${String(c.label).slice(0,40).padEnd(40)} | px:${c.bestPrice}`);
  }
  console.log(`  -> qualifies=${s.decision.qualifies} rec=${s.decision.recommendation}`);
  console.log(`     summary: ${s.decision.summary}`);
  if (s.decision.noBetReason) console.log(`     noBetReason: ${s.decision.noBetReason}`);
}
