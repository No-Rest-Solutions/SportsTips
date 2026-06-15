# Deep Per-Leg Analysis — Design & Status

> Living design doc for the "every leg must be deeply analysed" initiative.
> Started 2026-06-14. Keep this current as the system is built.

## Problem & root cause

User reported the picks are generic / unresearched — e.g. NRL posting
**"Under 49.5 + Wests Tigers H2H"**, and soccer slips that feel like no analysis
was done. Confirmed root cause:

- `config.analysis.engine = 'rules'` and `openai.enabled = true` **but no
  `OPENAI_API_KEY` is loaded**, so `analyzeEventWithOpenAi` never runs and every
  event silently falls through to `analyzeEventWithRules`.
- The rules engine self-documents the gap — accepted picks carry the note
  *"Rules mode inferred structural checks from market data only; player, role,
  and external-condition checks remain unverified."*
- NRL/soccer emit generic H2H+totals because the `bestAcceptedCombo` chain in
  `analyzeEventWithRules` falls through to `acceptedCombos[0]` (H2H allowed) and
  a `forcedFallbackCombo` when no clean structured combo passes.
- The intended deep-analysis design lived as an **AI multi-agent workflow**
  (`docs/agents/*.agent.md` + `reports/stats/*-reference.md`) that was never run
  (no key) — the reference files are still empty templates.

## Decisions (user, 2026-06-14)

1. **Build a real rules research layer** (free / no OpenAI). Implement the
   evidence the agents were meant to provide as deterministic code fed by real
   data.
2. **Quality over volume** — return **NO BET** when a slip's legs aren't
   genuinely supported. Zero picks for a sport on a given day is acceptable.
3. **Switch behaviour over once, when the full system is ready** — do NOT
   suppress fallbacks piecemeal now. Keep current behaviour until the gate is
   validated, then flip it all together.

## Intended philosophy (from `docs/agents/conservative-sgm-quant.agent.md`)

- **Target ~2.00x, then prioritise safety over extra value. Never force legs.**
  User's north star: **consistent 2–3x WINS; ROI follows.**
- **NRL:** no negative-line (spread against the team) legs; primary lines/totals
  max odds `1.90`.
- **AFL:** prioritise 'Star' players (25+ disposal avg) for safe buffer rungs
  (e.g. 20+ line) — big buffer ⇒ high hit-rate.
- **NBA:** combos first, then Points/Rebounds/Assists; star (20+ PPG) points
  floors (15+/20+).
- **MLB:** hit-only or hit+strikeout multis to reach ~2.00x safely.
- Availability must be confirmed; outdoor games weather-checked; final leg set
  challenged (devil's advocate) and correlation-controlled.

## Architecture

Each candidate leg gets a real **evidence** object, attached where the existing
research signals are attached (`buildCandidateResearch` in
`src/jobs/analysis.mjs`), then fed into combo scoring + a hard gate.

### Per-leg evidence model

- **Player prop legs** (`evidenceStatus`: `supported | weak | contra | unknown`)
  - Recent rolling series for the player's stat (last N finalised games).
  - `average`, `hitRate` vs the candidate's line, `buffer = average - line`,
    `gamesPlayed` / recency (role + availability proxy), recent trend.
  - **Supported** ⇔ enough sample AND average clears the line by a safe buffer
    AND hit-rate ≥ threshold AND played recently.
- **Team markets** (h2h / totals / lines)
  - Recent team form (already computed), head-to-head history, home/away record,
    scoring/conceding trend.
  - **Supported** ⇔ a clear, consistent edge for the chosen side/total.

### Data sources (free, reuse trusted providers)

- `fetchEspnSlate` + `fetchEspnSummary` (`extractEspnPlayerBoxscoreStats`) — per
  game player box scores for ESPN-covered sports (NBA/MLB/NFL/NHL/soccer/tennis).
- `fetchAflOfficialSlate` + `fetchAflOfficialSummary` — AFL player box scores.
- `fetchNrlOfficialSlate` + `fetchNrlOfficialSummary` — NRL player box scores.
- All cached (`research-cache/`) and fetched once per team (shared across that
  team's prop players for the event).

### Integration points

1. `src/research/player-form.mjs` (NEW) — assemble player rolling series + hit-rate.
2. `src/research/matchup.mjs` (NEW) — team H2H / form-diff / home-away edge.
3. `buildCandidateResearch` (analysis.mjs) — attach `evidence` + `evidenceScore`
   + `evidenceStatus` to each candidate.
4. `computeSupportScore` / `getDataConfidence` (ai-pick-generator.mjs) — supported
   evidence raises confidence; weak/contra lowers it.
5. `evaluateRulesCandidateCombo` / `analyzeEventWithRules` — **HARD GATE**: every
   leg must be `supported` (or above threshold) or the combo is rejected; remove
   the generic `acceptedCombos[0]` H2H fallback + `forcedFallbackCombo`.

## Rollout (no live behaviour change until the final step)

1. [in progress] Map research layer + confirm data feasibility. ✅ feasible.
2. Build `player-form.mjs` (+ tests, offline with injected summaries).
3. Build `matchup.mjs` (+ tests).
4. Attach evidence in `buildCandidateResearch` (no gating yet).
5. Wire evidence into scoring + add the hard gate + remove fallback (THE FLIP).
6. Per-sport live-snapshot validation (NRL & soccer first — the complaints).
7. Update docs + memory; restart daemon.

## Thresholds (initial, tune with live data)

- Player prop: `gamesPlayed ≥ 4`, `hitRate ≥ 0.6`, `buffer ≥` sport-specific
  floor (AFL disposals ≥ 3, NRL points ≥ 2, NBA points ≥ 3), played in the last
  ~2 weeks.
- Team h2h: form-diff + H2H both favour the side; not an away underdog on poor form.
- Total: both teams' recent scoring trend on the chosen side of the line.
- These live in config so they're tunable without code edits (planned).

## Status

| Step | State |
|------|-------|
| Root-cause + feasibility | done |
| player-form provider (`src/research/player-form.mjs`, 17 tests) | done |
| matchup provider (`src/research/matchup.mjs`, 18 tests incl. spread) | done |
| live evidence loader + attach + gate (analysis.mjs, 9 tests) | done |
| per-sport box-score routing: AFL/NRL→official, others→ESPN (3 tests) | done |
| hard gate + fallback disabled when gate on | done |
| config flag `analysis.deepAnalysis` + doctor line | done — **ENABLED in config.json** |
| **THE FLIP (activate)** | **staged — needs `daemon restart` to take effect** |
| live validation | partial: MLB ESPN path ✅; AFL/NRL pending a match day; soccer WC abstains (no form source) |

**To activate:** restart the daemon. Doctor shows `Deep analysis: enabled | HARD GATE`.
To ease in instead, set `analysis.deepAnalysis.requireLegEvidence: false` (observe mode:
evidence computed + logged, no gating). Re-probe any time with `node tmp/deep-probe.mjs`
(read-only). Known gap: international soccer has no form source yet → abstains.

## Live validation findings (2026-06-14, read-only probe vs cached snapshot)

- Gate runs end-to-end on live data, fails safe (no crashes); abstains when data absent.
- **MLB**: ESPN form (5g) + box scores (5g) load fine → grading works.
- **Soccer World Cup**: ESPN `soccer/fifa.world` path returns NO recent form (international
  sides play across competitions, not the tournament path) → all legs `unknown` → NO BET.
  Needs a cross-competition soccer form source (Flashscore?) — known gap.
- **AFL/NRL**: no fixtures in snapshot at probe time. Player box scores almost certainly
  need the OFFICIAL providers (settlement already uses them; ESPN likely doesn't carry
  AFL/NRL player stats). Player-form loader must route AFL→official, NRL→official before
  the gate is safe for these sports, or their props all gate out.
- **Implication**: do NOT flip `requireLegEvidence` globally yet — it would silence
  NRL/AFL props + soccer due to data coverage, not bet quality.

**Next session resumes at:** build the live loaders (reuse `loadEventFormResearch`'s
scoreboard scan + `fetchEspnSummary`/official summaries per finalised game) → attach
evidence in `buildCandidateResearch` (additive, no behaviour change) → THEN the flip
(wire into `computeSupportScore` + hard gate in `analyzeEventWithRules`, delete the
`acceptedCombos[0]`/`forcedFallbackCombo` generic fallback). The pure evidence cores
are done and tested; only the live wiring + flip remain.

## Notes / guardrails

- Do not break the working market-scrape → candidate-pool → settlement paths.
- All new fetches must fail safe: missing data ⇒ leg `unknown` ⇒ (after the flip)
  NO BET, never a falsely-confident pick.
- This is rules-only; if the user later adds an `OPENAI_API_KEY`, the AI engine
  can layer on top — the evidence here also makes a great prompt context.
