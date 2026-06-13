import { parseSportsbetEventPageHtml } from '../src/web-market-intake.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const sport = { key: 'tennis_atp', marketKey: 'tennis_atp' };

async function get(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-AU,en;q=0.9' }, signal: c.signal });
    return { status: res.status, html: await res.text() };
  } finally { clearTimeout(t); }
}

const league = await get('https://www.sportsbet.com.au/betting/tennis/atp');
console.log('league status:', league.status, 'len:', league.html.length);

// Find event links with -v- / -vs- slugs.
const links = [...league.html.matchAll(/href="(\/betting\/tennis\/[^"]*?-v-[^"]*?)"/gi)].map((m) => m[1]);
const uniq = [...new Set(links)].map((p) => 'https://www.sportsbet.com.au' + p);
console.log('tennis event links found:', uniq.length);
uniq.slice(0, 4).forEach((u) => console.log('  ', u));

if (!uniq.length) { console.log('No event links — cannot test event page.'); process.exit(0); }

const ev = await get(uniq[0]);
console.log('\nevent page status:', ev.status, 'len:', ev.html.length);
const quotes = parseSportsbetEventPageHtml(ev.html, sport, new Date().toISOString(), uniq[0]);
console.log('parseSportsbetEventPageHtml quotes:', quotes.length);
const byMarket = {};
for (const q of quotes) byMarket[q.market] = (byMarket[q.market] || 0) + 1;
console.log('by market:', JSON.stringify(byMarket));
for (const q of quotes.slice(0, 8)) {
  console.log(`   ${String(q.market).padEnd(10)} | ${String(q.outcomeName).padEnd(28)} | px:${(q.prices || []).map((p) => p.price).join('/')}`);
}
