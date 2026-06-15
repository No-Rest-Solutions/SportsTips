# Data Sources Inventory (per sport)

> Deep scan of scrapeable sources for results, player box scores, form/stats,
> availability, and SECONDARY sentiment (Reddit / tipping sites) to back up
> primary stats. Feeds the deep-analysis research layer (docs/DEEP-ANALYSIS.md),
> the smarter scraper (#32), and the Other-sports settlement fix (#38).
> Started 2026-06-14. Access notes reflect best knowledge; verify from the AU
> machine (some sources geo/Cloudflare-gate).

Legend: **P** = primary (used to grade/settle + drive picks), **S** = secondary
(soft confirmation only). Access: `api` = public JSON, `html` = scrape markup,
`auth` = needs token/headers, `geo` = region-gated.

## Currently wired (in repo)

- `providers/espn.mjs` — ESPN hidden API (`site.api.espn.com`): scores, box
  scores, venues. Used as the default settlement + form source for all sports.
- `providers/afl-official.mjs` — AFL.com (Stats Pro / MIS, `auth` token) — AFL
  player box scores + teams/rosters.
- `providers/nrl-official.mjs` — NRL.com (embedded `q-data` JSON) — NRL fixtures
  + player box scores.
- `providers/flashscore.mjs` — Flashscore — finalized results (AFL/NRL today).
- `providers/espn-injuries.mjs` — ESPN injuries.
- `providers/open-meteo.mjs` — weather (outdoor sports).
- `providers/tab.mjs` — TAB market menu (availability only).
- `web-market-intake.mjs` — Sportsbet (odds/markets, the betting snapshot).
- `providers/sports-game-odds.mjs` — odds API.

## Probe results (2026-06-14, from the AU machine via plain fetch)

- ✅ **NHL official** `api-web.nhle.com/v1/score/<date>` + `/schedule/<date>` — 200, public, clean.
- ✅ **Squiggle AFL** `api.squiggle.com.au/?q=games;year=YYYY` — 200, public (needs UA).
- ✅ **TheSportsDB** `…/api/v1/json/3/eventsday.php?d=<date>&s=<Sport>` — 200, returns
  finalized events (`strStatus:"FT"`, `intHomeScore/AwayScore`, teams, `strTimestamp`,
  `strLeague`) across ALL sports → broad results fallback. **BUILT** as
  `providers/thesportsdb.mjs`.
- ❌ **Sofascore** `api.sofascore.com` — 403 (Cloudflare). Needs the heavy intermittent
  headless-Edge path like TAB (+ residential-IP risk). Deferred.
- ❌ **Reddit** `reddit.com/r/<sub>/.json` — 403 (now auth/OAuth-gated). Secondary signal
  needs OAuth or is impractical for now. Deferred.

> CONSENSUS CAVEAT for wiring new settlement sources: `autoSettlePendingPicks` sets
> `requiredAgreements = sources.length > 1 ? 2 : 1`. Naively adding a source to a
> 1-source sport (e.g. tennis = ESPN only) raises the bar to 2 → if the new source
> lacks the event, settlement BREAKS. Wire fallbacks as a separate tier that does
> NOT raise requiredAgreements (settle on 1 reliable match; require agreement only
> when 2+ sources actually matched and disagree).

## High-value sources to ADD (cross-sport)

- **Sofascore** (`api.sofascore.com`, `api`/`geo`) — ⭐ the biggest win. Rich JSON
  for ALL sports: results, lineups (who started / subbed / DNP), player ratings &
  stat lines, head-to-head, recent form, incidents (injuries, cards, subs).
  Strong P for results + box scores + availability across soccer/tennis/NHL/
  basketball, and good for AFL/NRL. Cloudflare can gate — verify from AU.
- **TheSportsDB** (`thesportsdb.com/api`, `api`, free key) — scores/events/players
  across many leagues; good fallback (S→P).
- **api-football / api-sports** (RapidAPI free tier, `auth`) — soccer + other
  sports fixtures, lineups, injuries, stats. Free tier rate-limited.
- **NHL official** (`api-web.nhle.com`, `api`, public) — ⭐ richer + more reliable
  than ESPN for NHL box scores/results. P for NHL.

## Per-sport

### Tennis (the current settlement hole)
- Results/scores: **ESPN tennis** (P, `api`) — but athlete-based events need the
  parseEvent fix (#38); **Sofascore tennis** (P, `api`), **Flashscore tennis**
  (P, `html`). Match by player name in EITHER orientation (no real home/away).
- Form/stats: Sofascore (recent matches, surface splits), **Tennis Abstract /
  Jeff Sackmann GitHub** (historical, `api`/csv), ATP/WTA sites (`html`).
- Availability: withdrawals/retirements via Sofascore incidents, ATP/WTA news.
- Secondary: Reddit r/tennis, r/tennisbetting; tipping sites.

### Soccer (EPL / UCL / World Cup / general)
- Results: **ESPN soccer** (P), **Sofascore** (P), **Flashscore** (P),
  api-football (P). For internationals, query each team's recent matches across
  competitions (fixes the WC "no form" gap, #26).
- Stats/form: Sofascore (xG, ratings), **Understat** (xG, `html`), **FBref**
  (`html`), WhoScored.
- Markets beyond 1X2: corners/cards/totals — Sofascore + bookmaker pages.
- Availability: Sofascore lineups, api-football injuries, official club sites,
  **physioroom** (S).
- Secondary: Reddit r/soccer, r/footballbetting; tipping/consensus sites.

### AFL
- Results + box scores: **AFL.com official** (P, `auth`, wired), **ESPN AFL** (P),
  **Flashscore** (P). Squiggle API (`api`, free — tips/ratings/results, ⭐ easy add).
- Form/stats: AFL Stats Pro, **footywire / afltables** (`html`, deep history).
- Availability: AFL.com team lists (named ~Thu night), **footywire** late changes.
- Secondary: Reddit r/AFL; Squiggle model tips (S).

### NRL
- Results + box scores: **NRL.com official** (P, wired), **ESPN rugby-league** (P),
  Flashscore (P).
- Form/stats: NRL.com, **Champion Data** (limited public).
- Availability: NRL.com team lists (Tue), late changes; **Reddit r/nrl** team-list
  threads (S, useful for late mail).
- Secondary: Reddit r/nrl, r/nrlbetting.

### NBA
- Results + box scores: **ESPN NBA** (P), **stats.nba.com** (P, `auth` headers,
  rate-limited), **NBA api** via `cdn.nba.com` (P), Sofascore (P).
- Form/stats: ESPN athlete gamelogs, basketball-reference (`html`).
- Availability: **ESPN injuries** (wired), official injury report (`html`),
  Rotowire, Twitter beat writers (hard).
- Secondary: Reddit r/nba, r/sportsbook.

### MLB
- Results + box scores: **statsapi.mlb.com** (P, `api`, public — note: MLB
  research was removed earlier; statsapi is still the best source if revisited),
  ESPN MLB (P), Sofascore (P).
- Availability: lineups (statsapi / Rotowire) confirm ~hours before first pitch.
- Secondary: Reddit r/mlb, r/baseball.

### NFL
- Results + box scores: **ESPN NFL** (P), nflverse/nextgenstats (`html`/data).
- Availability: official injury reports (Wed–Fri), ESPN injuries.
- Secondary: Reddit r/NFL, r/sportsbook.

### NHL
- Results + box scores: **api-web.nhle.com** (P, ⭐ add), ESPN NHL (P), Sofascore.
- Availability: NHL official, dailyfaceoff (lines/scratches, `html`).
- Secondary: Reddit r/hockey, r/sportsbook.

## Secondary signal layer (all sports)
Use only to *back up* primary stats (a soft confirmation/penalty, never to grade):
- **Reddit** (`https://www.reddit.com/r/<sub>/.json`, `api`, no auth for read) —
  team-list/late-mail threads (esp. NRL/AFL), injury chatter, consensus. Rate-limit
  + user-agent required.
- **Tipping / consensus sites** — Covers consensus, Action Network public %,
  Squiggle (AFL), OddsPortal movement, Pickswise/WinnersAndWhiners previews.
- Treat as a small evidence nudge; weight far below box-score data.

## Recommended build order (for #32)
1. **Sofascore adapter** — one provider unlocks results + box scores + lineups +
   h2h for tennis/soccer/NHL/NBA → fixes most of the Other-sports settlement hole
   and feeds deep analysis broadly.
2. **api-web.nhle.com** (NHL) + **Squiggle** (AFL) — cheap, public, high quality.
3. **Reddit secondary** signal (NRL/AFL late mail) — soft confirmation.
4. Soccer cross-competition form (Understat/FBref/Sofascore) → closes #26.

## Risks / guardrails
- Respect rate limits + set a descriptive User-Agent; cache aggressively
  (`research-cache/`). Residential-IP flagging is a real concern (see TAB notes).
- Every new source must fail safe: on error/empty, fall back to the next source;
  never block settlement or post a falsely-confident pick.
- Verify geo/Cloudflare behaviour from the AU machine (my fetches are US/geo-limited).
