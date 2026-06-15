```markdown
# Daemon Architecture Overview

> Engine model: **rules-primary**. The deterministic rules engine
> (`src/ai-pick-generator.mjs`) + deep-analysis research gate
> (`src/research/`, see DEEP-ANALYSIS.md) dictate the picks. OpenAI is an
> OPTIONAL backup (no key today; a free Gemini/Groq backup can be wired via
> `config.openai.baseUrl`). See implemented-features.md for the current state.

## Core Components
1. **Daemon Scheduler**
   - Entry `automation/discord-webhooks/src/index.mjs`; due-job logic in
     `src/scheduler.mjs` (`getDueJobs`); jobs in `src/jobs/`.
   - Runs scheduled tasks every 60s; posts via Discord webhooks.

2. **Agent specs (AI-mode vision, not currently run)**
   - `docs/agents/*.agent.md` describe a multi-agent OpenAI workflow that was
     never run (no key). They inform WHAT evidence matters; the rules layer
     implements that evidence deterministically in code. `reports/stats/*` are
     empty templates for that unbuilt workflow.

3. **Job System**
   - Located in `automation/discord-webhooks/src/jobs/` folder
   - Contains:
     - `analysis.mjs` - Core analysis job
     - `promos.mjs` - Promo generation/settlement jobs
     - `settlement-logger.mjs` - Settlement tracking

4. **Configuration System**
   - Central config in `automation/discord-webhooks/config.json`
   - Sport-specific rules in `sports/` directory
   - Promo configurations in `promos-config.json`

5. **Data Storage**
   - State tracking in `state.json`
   - Research cache in `research-cache/`
   - Settlement logs in `settlements/`
   - Backup system in `backups/`

6. **Integration Points**
   - Discord Webhooks in `discord-webhooks/`
   - Sports data in `sports/` directory
   - Reporting system in `reports/` folder
```