import fs from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
import { mergeQuoteEntries } from '../src/pick-generator.mjs';
import { buildAnalysisCandidatePool } from '../src/ai-pick-generator.mjs';
import { loadEventDeepEvidenceInputs, attachDeepEvidence } from '../src/jobs/analysis.mjs';
import { buildTeamSgmDecision } from '../src/team-sgm.mjs';

const config = await loadConfig();
const snap = JSON.parse(await fs.readFile('bookmaker-snapshots.json', 'utf8'));

// Two events per sport (favourite-ish games) to confirm the prop-led path builds safe slips.
const targets = {
  nrl: ['Newcastle Knights vs Wests Tigers', 'Manly Sea Eagles vs Melbourne Storm'],
  afl: ['Port Adelaide vs Adelaide Crows', 'Brisbane Lions vs Sydney Swans']
};

for (const sportKey of Object.keys(targets)) {
  const sport = config.sports.find((s) => s.key === sportKey);
  console.log(`\n======== ${sportKey.toUpperCase()} ========`);
  for (const name of targets[sportKey]) {
    const quotes = snap.quotes.filter((q) => q.sportKey === sportKey && q.displayName === name);
    if (!quotes.length) { console.log(`  ${name}: (not in snapshot)`); continue; }
    const f = quotes[0];
    const eventContext = {
      sportKey, sportLabel: sportKey.toUpperCase(), homeTeam: f.homeTeam, awayTeam: f.awayTeam,
      eventName: name, startTime: f.startTime, timezone: config.timezone,
      deepAnalysis: config.analysis.deepAnalysis, generatorConfig: { minBooks: 1, stakeUnits: 1, maxStakeUnits: 2 }
    };
    const merged = mergeQuoteEntries(quotes);
    const pool = buildAnalysisCandidatePool(eventContext, merged, sportKey === 'afl' ? 24 : 14);
    const caches = { injury: new Map(), weather: new Map(), form: new Map(), boxscore: new Map(), officialSlate: new Map() };
    let inputs;
    try { inputs = await loadEventDeepEvidenceInputs(sport, eventContext, caches, {}, { fetchBoxscores: true }); }
    catch (e) { console.log(`  ${name}: evidence load ERROR ${e.message}`); continue; }
    const home = inputs.boxscoresBySide?.get('home') || [];
    const away = inputs.boxscoresBySide?.get('away') || [];
    const graded = attachDeepEvidence(sport, eventContext, pool, inputs);
    const gp = graded.filter((c) => c.family === 'prop');
    const tally = {};
    for (const c of gp) tally[c.evidenceStatus] = (tally[c.evidenceStatus] || 0) + 1;
    console.log(`  ${name}: start=${f.startTime} | boxscores home=${home.length}/away=${away.length} | props=${gp.length} ${JSON.stringify(tally)}`);
    for (const c of gp.slice(0, 3)) console.log(`     · ${c.description} ${c.outcomeName} -> ${c.evidenceStatus}: ${c.evidenceReason}`);
    const supported = graded.filter((c) => c.family === 'prop' && c.evidenceStatus === 'supported');
    const r = buildTeamSgmDecision(eventContext, merged, { supportedFillers: supported, stakeUnits: 1 });
    const legLine = r ? r.sgm.legs.map((l) => `${l.outcomeName || l.description || ''} ${l.market}${l.point != null ? ' ' + l.point : ''}@${l.price}[${l.source || l.kind}]`).join('  +  ') : 'NO BET';
    console.log(`  ${name}: ${supported.length} supported props -> ${r ? r.sgm.modeledOdds + 'x' : 'NO BET'}`);
    if (r) console.log(`     ${legLine}`);
  }
}
