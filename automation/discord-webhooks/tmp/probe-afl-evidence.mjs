import { fetchAflOfficialSlate, fetchAflOfficialSummary } from '../src/providers/afl-official.mjs';

const tz = 'Australia/Sydney';
// Scan the last few weeks for finalised AFL games (rounds are weekly).
const today = new Date();
const dateKeys = [];
for (let d = 1; d <= 24; d += 1) {
  const dt = new Date(today.getTime() - d * 86400000);
  dateKeys.push(dt.toISOString().slice(0, 10));
}

let foundFinal = null;
for (const dateKey of dateKeys) {
  let slate;
  try {
    slate = await fetchAflOfficialSlate(null, dateKey, tz);
  } catch (e) {
    console.log(`  slate ${dateKey} ERROR: ${e.message}`);
    continue;
  }
  const events = Array.isArray(slate?.events) ? slate.events : [];
  const finals = events.filter((e) => String(e?.state || '').toLowerCase() === 'post' || /final|ft/i.test(String(e?.shortStatus || e?.status || '')));
  if (events.length) {
    console.log(`  ${dateKey}: ${events.length} events, ${finals.length} final — sample: ${events.slice(0, 2).map((e) => `${e.homeTeam} v ${e.awayTeam} [${e.state || e.shortStatus || '?'}] id=${e.id}`).join(' | ')}`);
  }
  if (!foundFinal && finals.length) foundFinal = finals[0];
}

console.log('\n=== box score test ===');
if (!foundFinal) {
  console.log('No finalised AFL game found in the last 24 days via fetchAflOfficialSlate — that alone would starve the evidence gate.');
} else {
  console.log(`Pulling summary for: ${foundFinal.homeTeam} v ${foundFinal.awayTeam} (id=${foundFinal.id})`);
  try {
    const summary = await fetchAflOfficialSummary(null, foundFinal);
    const stats = Array.isArray(summary?.playerStats) ? summary.playerStats : [];
    console.log(`playerStats rows: ${stats.length}`);
    console.log('sample rows:', JSON.stringify(stats.slice(0, 3), null, 2));
    const withDisposals = stats.filter((s) => Number.isFinite(Number(s?.disposals)) || Number.isFinite(Number(s?.stats?.disposals)));
    console.log(`rows with a numeric disposals field: ${withDisposals.length}`);
  } catch (e) {
    console.log(`fetchAflOfficialSummary ERROR: ${e.message}`);
  }
}
