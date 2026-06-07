```markdown
# Daemon Architecture Overview

## Core Components
1. **Daemon Scheduler**
   - Located in `automation/discord-webhooks/src/jobs/index.mjs`
   - Manages execution of all scheduled tasks
   - Uses cron-like scheduling for daily/periodic tasks
   - Integrates with Discord Webhooks for notifications

2. **Agent System**
   - Located in `automation/discord-webhooks/agents/` folder
   - Contains specialized agents for:
     - `bankroll-risk-manager.agent.md`
     - `betting-workflow-orchestrator.agent.md`
     - `conservative-sgm-quant.agent.md`
     - `correlation-diversification-reviewer.agent.md`
     - ... (18+ agents total)

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