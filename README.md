# Sports Tips Tracker

An automated desktop dashboard and Discord webhook system for tracking, analyzing, and posting sports betting multis with a focus on safety and consistency.

---

## ⚙️ System Architecture

- **Primary Logic (Rules Daemon):** The core decision engine lives in `automation/discord-webhooks/src/`. This handles market filtering, combo prioritization, and benchmark enforcement.
- **Fallback Layer (AI Research):** OpenAI/Gemini agents act as a research layer for deeper context (injuries, usage shifts) but are subject to the hard-coded constraints of the Daemon.

---

## 📖 Documentation

- [Getting Started](./docs/setup.md): How to install and run the Tipping Bot.
- [Model Benchmarks](./reports/model-benchmarks.md): Our standards for support and evaluation.
- [AI Personas](./docs/agents/): View the logic and constraints used by our analysis agents.
- [Profit Tracker Template](./30-day-profit-tracker.example.md): See how we track performance.

## Operating Goal

- The current operating goal is to test `30` days of profitability starting from `5.00u / $50.00 AUD`.
- The default unit size is `1.00u = $10.00 AUD`.
- `1.00u` is the reference unit, not a mandatory default stake on every ticket.
- Stakes should move dynamically with support, robustness, overlap, and bankroll context instead of defaulting every play to `1.00u`.
- `0.50u` is mainly for thinner or higher-variance optional plays where the smaller outlay controls downside; avoid token-sized stakes when the support is strong enough to justify a normal position.
- Larger sizing above `1.00u` is allowed only when support, robustness, and bankroll fit are all unusually strong.
- This `30-day` run is a performance and decision-quality test, not a target-chasing sprint.

## Structure

- `sports/<sport>/bets.csv`: structured result log for that sport.
- `sports/<sport>/summary.md`: readable summary with totals and win rate.
- `loss-tracking/rolling-loss-log.md`: rolling post-mortem log for confirmed losses and missed-leg follow-up.
- `reports/daily/current.md`: rolling daily report for morning sweeps and suggested unit deployment.
- `reports/model-benchmarks.md`: performance benchmarks, support rules, and evaluation standards.
- `automation/discord-webhooks/`: local Node webhook publisher for slates, picks, and results.
- `automation/discord-webhooks/desktop/`: local desktop UI for starting or stopping the automation and checking runtime status.
- `dist/tipping-bot/`: packaged desktop build output when you run the portable packaging script.

## Model Objective

- Do not optimize for raw hit rate.
- Optimize for reliable, stat-backed support and structurally clean tickets.
- Prioritize role stability, matchup discrepancies, injury and weather impact, sentiment overreaction, and dependency control over public consensus.
- Sustainable decision quality matters more than short-term streaks.

## Benchmark Reference

See `reports/model-benchmarks.md` for the detailed support, robustness, ROI, and evaluation rules.
- Default practical filters are:
	- No-bet is preferred when support is unclear.
	- Never force a third or fourth leg when it weakens the build materially.
	- Never stack dependent same-script ladders such as `1st half total + full-game total` in the same direction.
	- Prefer the smallest clean build that still has a strong support case.

## Result Rules

- Valid result values are `win`, `loss`, and `return`.
- `return` means voided, refunded, or pushed back.
- Cash `return` entries are tracked separately, restore the full stake, and do not count as wins or losses.
- Bonus-bet or token-backed bet returns should be logged as `loss` for stats, with the notes stating that the loss was settled via a return token rather than a standard losing ticket.
- Win % is based only on settled win/loss results.

## Win % Formula

- `Win % = wins / (wins + losses) * 100`
- If a sport has no wins or losses yet, show Win % as `N/A`.

## CSV Columns

- `placed_date`: when the bet was placed.
- `settled_date`: when the result was confirmed.
- `sport`: sport name.
- `league`: competition or league.
- `event`: matchup or event name.
- `market`: market type.
- `selection`: tipped side or outcome.
- `stake_units`: size of the bet in units.
- `result`: `win`, `loss`, or `return`.
- `net_units`: net result in units. Use `0.00` for cash returns.
- `bookmaker`: optional bookmaker name.
- `notes`: optional free text.

## Agent Update Flow

1. Use `Settlement Logger` when confirmed results or returns are provided.
2. Append each settled pick to the matching `bets.csv` file.
3. Update the matching `summary.md` file totals.
4. Update `30-day-profit-tracker.md` so bankroll, open exposure, and pending rows stay aligned.
5. Keep cash returns in the tracker and exclude them from Win %, but log bonus-bet or token refunds as losses and state that they were return-token settlements.
6. Update `loss-tracking/rolling-loss-log.md` for every confirmed loss, and if the missed legs are not known yet, ask the user which legs failed before closing the review.

## Agent Workflow

- Start with `Betting Workflow Orchestrator` when you want the full system to handle whatever you send: sport, sports, games, bookmaker menus, injury context, or other betting factors.
- Use `Daily Report Runner` when you want the full morning sweep across main sports with suggested units.
- Use `Game Intake Orchestrator` directly when you already know the specific game and want to skip straight to bet construction.
- Use `Slate Intake Orchestrator` directly when you want a ranked slate report first.
- Default output is every qualified opportunity in ranked order unless you ask for one bet only, one bet per game, or a tighter shortlist.
- Default ticket shape is the smallest clean build for the sport, with a `2-leg` fallback preferred over a fragile forced extra leg when the user allows it.
- Sport-specific defaults are promo-aware: NRL is same-game-multi only and stays `3-leg`, Soccer/EPL stays `3-leg`, AFL is same-game-multi only and stays in safer `2-leg` to `3-leg` disposal-led builds unless the promo setup explicitly requires more, and MLB, NBA, NHL, and similar team sports should stay prop-led without forcing extra legs.
- For MLB in this workspace, the default `3-leg` same-game build should start from `2 x 1+ hit` legs on verified lineup-stable bats, then add one soft third leg only if it is cleaner than forcing a different structure. Valid third-leg paths include another `1+ hit`, a conservative pitcher strikeout rung, or another stable low-volatility supporting prop.
- If the user says "analyze all main sports today," treat the default sweep as AFL, NRL, MLB, NBA, NHL, Soccer/EPL, and Tennis when TAB offers actionable markets.
- If several bets genuinely qualify on the same day, return them; do not artificially cap the list just to keep the card short.
- Rank daily opportunities by support, robustness, structural independence, and bankroll fit, not just by raw hit rate.
- Use `Bankroll Risk Manager` to size stakes after the bet quality is known. There is no fixed standard stake or daily exposure cap; size dynamically off support, robustness, overlap, and bankroll context.
- Available markets help, but they are optional.
- The workflow should optimize for safety and value together without chasing payout targets.
- It should compare several relevant prop markets and choose whichever path is safest while still offering value, rather than forcing one stat family.
- For MLB specifically, do not pivot to totals, team totals, or inning totals just because another market looks more dramatic if the hit-led structure is still viable. Research, lineup stability, pitcher context, and weather should be used first to choose the third leg inside the prop-led build.
- For NBA in this workspace, assume alt assists and rebounds often move only in increments of `2` unless you say otherwise, so the workflow should not suggest invalid odd thresholds.
- For NBA in this workspace, valid market families should include points, `2pts`, `3pts`, `PRA`, `PA`, `RA`, and `RP` whenever those are available on the book, but rebounds, assists, and combo props should be prioritized ahead of pure points ladders in cash-style builds.
- For NBA in this workspace, the 7 core low-volatility markets are: (1) Combos: P+A, P+R, A+R, PRA, and (2) Singles: Points, Rebounds, Assists. Prioritize Combos first for the safest floor.
- For NBA cash-style builds, treat 15+ or 20+ points for "Star" players (20+ PPG average) as high-variety safety rungs.
- For NBA, de-prioritize `3pts`, steals, and blocks due to high volatility unless the matchup is extreme.
- For NRL in this workspace, generated slips are same-game-multi only, keep the `3-leg` promo structure, and treat standard spread or line legs as too volatile by default; only use extreme-protection filler lines, generally `+24.5` or higher, when a third leg is unavoidable.
- For AFL in this workspace, generated slips are same-game-multi only and should stay in safer `2-leg` to `3-leg` disposal-led builds by default rather than drifting into singles or cross-game structures.
- For team sports, same-game multis are the default bet unit. Tennis and other individual sports may use cross-match H2H or prop multis when same-game construction is not a meaningful market format.
- It should not default to ultra-floor stats if those plays strip out too much support or force a fragile extra leg.
- If a floor-heavy build still looks too weak, it should test the smallest justified step up in line or adjacent market that is actually valid on the user's book before adding a flimsy extra leg.
- Never, ever stack dependent same-script legs such as `1st half total + full-game total` in the same direction. If that kind of dependency is the only way to reach a target leg count, return no-bet or a smaller clean build.
- When promo rules force a fixed leg count, prefer no-bet over adding a fragile filler leg that materially weakens the ticket.
- Every player leg must pass a player-verification step before it is considered, including current roster confirmation and availability checks for that event.
- Exact player slips must fail closed unless each player has explicit current-team verification for that event from current sources. Search-engine snippets, generic knowledge, and stale cached summaries are not enough.
- If player verification provenance is incomplete, return the game as menu-pending, watchlist, or no-bet instead of guessing the player leg.
- Every final ticket must pass a ticket-integrity check before recommendation, covering same-game legality by default, player-team-event consistency, book-rule compliance, and whether the game is still actionable.
- After a ticket has been validated, final user-facing slip text must copy the validated leg labels verbatim. Do not manually swap in a different player, team, or market from memory. If any leg needs changing, rerun player verification and ticket integrity first.
- Weather should materially influence outdoor and weather-sensitive sports such as AFL, NRL, MLB, NFL, and Soccer when the conditions affect the market.
- Past performance is useful only when it helps identify repeatable opportunity, role stability, or matchup tendencies.
- H2H and spread or line markets should generally be avoided in team sports unless you explicitly ask for them or the prop menu is too weak. Tennis is the main H2H exception because TAB tennis menus are often H2H-first.
- Avoid overlapping legs across cash and bonus tickets when building multiple slips from the same slate unless the user explicitly asks for reused exposure.
- `Betting Workflow Orchestrator` routes slate-like requests into `Slate Intake Orchestrator` and specific games into `Game Intake Orchestrator`.
- `Betting Workflow Orchestrator` routes morning sweep and all-main-sports requests into `Daily Report Runner`.
- `Game Intake Orchestrator` routes the request to `Conservative SGM Quant`.
- `Conservative SGM Quant` must invoke all support agents before finalizing:
	- `Sport Stats Librarian`
	- `Player Availability Verifier`
	- `Restricted Role Minutes Analyzer`
	- `Match Conditions Scout`
	- `Weather Venue Impact Specialist`
	- `Deep Research Verifier`
	- `Historical Pattern Review`
	- `Market Sentiment Filter`
	- `Correlation Diversification Reviewer`
	- `Ticket Integrity Checker`
	- `Devils Advocate Reviewer`
	- `Bankroll Risk Manager`

## Agent Roles

- `Betting Workflow Orchestrator`: top-level router for sports, games, slates, bookmaker menus, and other betting context.
- `Daily Report Runner`: runs the full morning sweep across main sports, ranks the best actionable bets, and suggests unit deployment.
- `Slate Intake Orchestrator`: turns sports into slate reports and shortlist games.
- `Game Intake Orchestrator`: turns a specific game into a downstream bet-building request.
- `Conservative SGM Quant`: assembles the final sport-appropriate `2-leg` to `4-leg` recommendation, with `3-leg` NRL builds and `4-leg` AFL disposal builds preferred when justified.
- `Bankroll Risk Manager`: converts edge, robustness, and open exposure into unit suggestions.
- `Settlement Logger`: updates `30-day-profit-tracker.md`, `loss-tracking/rolling-loss-log.md`, per-sport `bets.csv`, and per-sport `summary.md` when bets settle or return.
- `Sport Stats Librarian`: updates reusable per-sport reference notes under `reports/stats/`.
- `Current Slate Verifier`: confirms the live board and separates upcoming games from live, final, or postponed ones before ranking.
- `Player Availability Verifier`: confirms the player is on the current roster and actually available for the event.
- `Restricted Role Minutes Analyzer`: checks minute caps, pitch counts, snap counts, easing-in plans, and beneficiary teammates.
- `Match Conditions Scout`: checks schedule fatigue, travel, venue context, and late-breaking team environment changes.
- `Weather Venue Impact Specialist`: evaluates weather and environment effects on markets and legs.
- `Deep Research Verifier`: cross-checks key assumptions across reliable sources.
- `Historical Pattern Review`: tests whether past performance signals are repeatable or just noise.
- `Market Sentiment Filter`: separates useful sentiment from crowd noise.
- `Correlation Diversification Reviewer`: ensures the ticket is not overly concentrated in one market family or same-script dependency.
- `Ticket Integrity Checker`: blocks invalid slips by checking same-game legality, player-team-event consistency, market legality, and whether the game is still actionable.
- `Devils Advocate Reviewer`: argues the strongest case against each leg and the full ticket before finalization.

## Slate Workflow

- Start with `Slate Intake Orchestrator` when you want today's slate for a sport pulled into a readable document.
- Supported sports are AFL, NRL, NBA, NHL, MLB, NFL, Soccer, and Tennis.
- Soccer includes EPL and other TAB-available football competitions.
- "Today" defaults to AEST unless you override the date or timezone.
- For intraday requests, "today's slate" should mean the remaining unstarted playable games by default, not the full already-started board, unless you explicitly ask for the full schedule.
- Intraday slate ranking must verify the live scoreboard or schedule first rather than relying on stale rolling reports alone.
- Slate ranking prefers games that can realistically support a clean multi without needing fragile ladders.
- Slate ranking should prefer games that can support role-backed, non-fragile props rather than ultra-floor-only builds or volatile ladders.
- For Tennis, slate ranking should score head-to-head and prop-multi suitability rather than forcing a same-game model that does not fit the market.
- The rolling slate reports live in `reports/slates/` and update in place per sport.
- `Slate Intake Orchestrator` routes to `Slate Suitability Ranker`.
- `Slate Suitability Ranker` scores every game in today's slate on:
	- market depth
	- data reliability
	- volatility
	- leg opportunity density
	- structure resilience
- `reports/stats/` stores reusable per-sport reference notes for later bet builds.
- It returns a full ranked slate, the top 3 games or events for safe-value construction, and any games that should be excluded entirely.

## Current Sports

- AFL
- NRL
- NBA
- NHL
- MLB
- NFL
- Soccer
- Tennis

---

## 🚀 Roadmap / TODO
- [ ] **Daily Promo System**: Automated generation of Soccer/Tennis H2H multis and specific AFL/NRL promotional slips.
- [ ] **Expanded Sport Coverage**: Integration for NFL and European Basketball.
- [ ] **Advanced Research Layers**: Enhanced role-stability modeling using historical usage-rate trends.
- [ ] **Market Depth Expansion**: Support for "Alternative Player Props" across more global bookmakers.