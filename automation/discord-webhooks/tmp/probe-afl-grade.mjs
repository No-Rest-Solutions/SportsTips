import fs from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
import { mergeQuoteEntries } from '../src/pick-generator.mjs';
import { buildAnalysisCandidatePool } from '../src/ai-pick-generator.mjs';
import { loadEventDeepEvidenceInputs, attachDeepEvidence } from '../src/jobs/analysis.mjs';

const config = await loadConfig();
const sport = config.sports.find((s) => s.key === 'afl');
const snap = JSON.parse(await fs.readFile('bookmaker-snapshots.json', 'utf8'));

// Adelaide Crows vs Melbourne — group its quotes.
const name = 'Adelaide Crows vs Melbourne';
const quotes = snap.quotes.filter((q) => q.sportKey === 'afl' && q.displayName === name);
const first = quotes[0];
const eventContext = {
  sportKey: 'afl', sportLabel: 'AFL',
  homeTeam: first.homeTeam, awayTeam: first.awayTeam,
  eventName: name, startTime: first.startTime, timezone: config.timezone,
  deepAnalysis: config.analysis.deepAnalysis,
  generatorConfig: { minBooks: 1, stakeUnits: 1, maxStakeUnits: 2 }
};
console.log('event:', name, '| start:', first.startTime, '| deepAnalysis:', JSON.stringify(config.analysis.deepAnalysis));

const merged = mergeQuoteEntries(quotes);
const pool = buildAnalysisCandidatePool(eventContext, merged, 60);
const props = pool.filter((c) => c.family === 'prop');
console.log(`candidate pool: ${pool.length} (${props.length} props after the 1.15 floor + AFL caps)`);

const caches = { injury: new Map(), weather: new Map(), form: new Map(), boxscore: new Map(), officialSlate: new Map() };
const inputs = await loadEventDeepEvidenceInputs(sport, eventContext, caches, {}, { fetchBoxscores: true });
const home = inputs.boxscoresBySide?.get('home') || [];
const away = inputs.boxscoresBySide?.get('away') || [];
console.log(`boxscore games loaded: home=${home.length}, away=${away.length}`);
const sampleNames = [...(home[0] || []), ...(away[0] || [])].slice(0, 6).map((r) => r.playerName);
console.log('sample boxscore playerNames:', JSON.stringify(sampleNames));
console.log('sample snapshot prop players:', JSON.stringify(props.slice(0, 6).map((c) => c.description)));

const graded = attachDeepEvidence(sport, eventContext, pool, inputs);
const gp = graded.filter((c) => c.family === 'prop');
const tally = {};
for (const c of gp) tally[c.evidenceStatus] = (tally[c.evidenceStatus] || 0) + 1;
console.log('\nprop grade tally:', JSON.stringify(tally));
console.log('\nsample graded disposals:');
for (const c of gp.filter((c) => c.market === 'player_disposals').slice(0, 12)) {
  console.log(`  ${c.description} ${c.outcomeName} @${c.bestPrice} -> ${c.evidenceStatus} (hr=${c.evidenceHitRate}, games=${c.evidenceGames}) ${c.evidenceReason}`);
}

// Now replicate the analysis.mjs SGM build with the supported props as fillers.
const { buildTeamSgmDecision } = await import('../src/team-sgm.mjs');
const supportedFillers = graded.filter((c) => c.family === 'prop' && c.evidenceStatus === 'supported');
console.log(`\nsupported fillers passed to SGM builder: ${supportedFillers.length}`);
const sgmResult = buildTeamSgmDecision(eventContext, merged, { supportedFillers, stakeUnits: 1 });
if (!sgmResult) {
  console.log('\nSGM RESULT: null (no slip built)');
} else {
  const legs = sgmResult.decision?.legs || sgmResult.sgm?.legs || [];
  console.log(`\nSGM SLIP -> ${legs.length} legs @ combined ${sgmResult.sgm?.modeledOdds || sgmResult.decision?.totalOdds}`);
  for (const leg of legs) {
    console.log(`  - ${leg.description || leg.selection || leg.market} ${leg.outcomeName || ''} @${leg.price || leg.odds} [${leg.source?.type || leg.source || leg.kind}]`);
  }
}
