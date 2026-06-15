# Implemented Features Reference

> Reflects the actual current system (rules-primary; AI optional). Updated 2026-06-15.
> Deeper design docs: `DEEP-ANALYSIS.md` (per-leg research gate), `DATA-SOURCES.md`
> (scrapeable sources), `PROMO_SYSTEM_IMPLEMENTATION.md` (promos).

## Engine model (rules-primary)

- **The rules engine dictates picks.** `src/ai-pick-generator.mjs` builds candidate
  pools from the live market snapshot, scores combos against structural + benchmark
  rules per sport, and selects slips. The OpenAI engine is an **optional backup**
  (`config.analysis.engine`), only used when an API key is present; today it has no
  key, so everything runs on rules. A FREE AI backup (Gemini/Groq) can be wired via
  the OpenAI-compatible `config.openai.baseUrl` if desired (chat-completions adapter).
- **Deep per-leg analysis** (`config.analysis.deepAnalysis`, ENABLED): every candidate
  leg is graded against real recent data before it can appear in a slip —
  `src/research/player-form.mjs` (player rolling form: hit-rate / safe buffer vs the
  line) and `src/research/matchup.mjs` (team form / H2H / home-away / spread / totals).
  When `requireLegEvidence` is on, only evidence-`supported` legs survive → the engine
  posts a researched slip or NO BET (quality over volume). See `DEEP-ANALYSIS.md`.
- **Evidence transparency**: every posted slip's per-leg reasoning is sent to the
  `evidence` Discord webhook and logged to `bot-evidence-log.csv`
  (`src/evidence-log.mjs`), with outcome (and CLV when available) back-filled at
  settlement for review.
- **Dynamic staking** (`getRecommendedStakeUnits`): units scale with support score,
  confidence, correlation, bankroll, AND deep-analysis evidence strength.

## Sports + market intake

- Sportsbet snapshot via `src/web-market-intake.mjs`; ESPN/AFL-official/NRL-official/
  Flashscore/TAB providers in `src/providers/`. TAB market menu drives a soft
  "placeable on TAB" preference. Sports: AFL, NRL, NBA, MLB, NHL, NFL, EPL, UCL,
  World Cup, Tennis.

## Settlement / results (`src/jobs/results.mjs`)

- Multi-source consensus grading (ESPN + AFL/NRL official + Flashscore). Tennis now
  settles (ESPN athlete-name fix + orientation-agnostic matching). **TheSportsDB**
  (`src/providers/thesportsdb.mjs`) is a consensus-safe FALLBACK
  (`config.jobs.results.fallbackSettlement`) consulted only when no primary source
  matched, so "Other" sports (tennis/NHL/non-EPL soccer) settle without raising the
  agreement bar. Posted slips are kept through odds movement and only dropped on real
  availability/integrity failures.

## Promo system (real, runs in the daemon)

- `src/promos-config.{mjs,json}` (config + validation), `src/promos-candidates.mjs`
  (real legs from the snapshot), `src/promos-generator.mjs` (type/market-aware leg
  selection), `src/promos-settlement.mjs` + `src/promos-grading.mjs` (rule engines:
  standard / leg-insurance / margin-forgiveness), `src/promos-formatter.mjs`,
  `src/jobs/promos.mjs` (daemon generation/settlement/report, per-promo webhooks).
  NOTE: `src/promos-research.mjs` is legacy MOCK data and is bypassed — promo leg
  confidence is market-derived. Gated by `config.jobs.promos.enabled` (default off).

## Desktop app (`desktop/`)

- Electron app ("Tipping Bot", portable build). Settings cover all webhooks
  (incl. per-promo + evidence). Spawns the daemon. **Code/GUI changes require a
  rebuild** (`npm run build`) — the running app uses a bundled snapshot.

## Notes

- The `docs/agents/*.agent.md` specs describe the *AI-mode* multi-agent vision (never
  run — no key). They inform what evidence matters; the rules layer implements that
  evidence deterministically. `reports/stats/*-reference.md` are empty templates for
  that unbuilt AI workflow.
