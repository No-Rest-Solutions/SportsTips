import { parseSportsbetLeagueHtml } from '../src/web-market-intake.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const url = 'https://www.sportsbet.com.au/betting/tennis/atp';

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30000);
let html = '';
try {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-AU,en;q=0.9' },
    signal: controller.signal
  });
  console.log('HTTP status:', res.status);
  html = await res.text();
} catch (e) {
  console.log('FETCH ERROR:', e.message);
  process.exit(0);
} finally {
  clearTimeout(timer);
}

console.log('HTML length:', html.length);
const count = (re) => (html.match(re) || []).length;
console.log('occurrences "Head to Head":', count(/Head to Head/gi));
console.log('occurrences "Match Betting":', count(/Match Betting/gi));
console.log('occurrences "Money Line":', count(/Money Line/gi));
console.log('occurrences "Match Result":', count(/Match Result/gi));
console.log('occurrences "To Win":', count(/To Win/gi));
console.log('occurrences "Winner":', count(/\bWinner\b/gi));
console.log('event-like links (-v- / -vs-):', count(/href="[^"]*-v-[^"]*"/gi) + count(/href="[^"]*-vs-[^"]*"/gi));

// What does the production parser get?
const sport = { key: 'tennis_atp', marketKey: 'tennis_atp' };
const quotes = parseSportsbetLeagueHtml(html, sport, new Date().toISOString());
console.log('parseSportsbetLeagueHtml quotes:', quotes.length);

// Show context around the first market label to see the real format.
for (const label of ['Head to Head', 'Match Result', 'Match Betting', 'To Win Match', 'Winner']) {
  const idx = html.search(new RegExp(label, 'i'));
  if (idx >= 0) {
    const visible = html.slice(idx, idx + 400).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(`\n--- context after "${label}" (idx ${idx}):\n`, visible.slice(0, 300));
    break;
  }
}
