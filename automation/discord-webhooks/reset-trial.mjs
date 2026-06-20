/**
 * Reset the 30-day trial to a clean 10-unit start.
 *
 * RUN WITH THE APP CLOSED (otherwise the running daemon will re-save state.json /
 * the picks feed and clobber the reset):
 *
 *   node automation/discord-webhooks/reset-trial.mjs
 *
 * Wipes (no backup): bankroll tracker CSV, picks feed, daemon state, the 30-day
 * profit tracker, and the repeat-losing-legs report. Webhook URLs are left intact
 * so the same channels post the fresh trial from day 1.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '../../');
const STARTING_UNITS = 10;
const UNIT_AUD = 10;
const today = new Date();
const ddmmyyyy = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
const iso = today.toISOString().slice(0, 10);

const BANKROLL_CSV_HEADER = 'timestamp,transaction_key,transaction_type,pick_id,sport,event,start_time,slip,price_decimal,stake_units,stake_aud,bankroll_delta_units,return_units,return_aud,net_units,net_aud,units_remaining,units_remaining_aud,total_settled_stake_units,total_settled_stake_aud,status,legs_hit,legs_missed,specific_leg_lost,source,notes';

const CLEAN_STATE = {
  jobs: {},
  posts: { slates: {}, picks: {}, referrals: {}, results: {} },
  cache: { oddsValidation: {} },
  providers: { sportsGameOdds: {}, marketScrape: {} },
  tracking: { picks: {} }
};

const PROFIT_TRACKER = `# 30-Day Profit Tracker

## Current Position

| Metric | Value |
| --- | ---: |
| Unit Size | 1.00u = $${UNIT_AUD.toFixed(2)} AUD |
| Starting Bankroll | ${STARTING_UNITS.toFixed(2)}u / $${(STARTING_UNITS * UNIT_AUD).toFixed(2)} AUD |
| Current Bankroll | ${STARTING_UNITS.toFixed(2)}u / $${(STARTING_UNITS * UNIT_AUD).toFixed(2)} AUD |
| Net Profit/Loss | 0.00u |
| Start Date | ${ddmmyyyy} |
| Days Logged | 0 / 30 |

## Pending Bet Notes

_No pending bets._

## Settled Bet Log

| Date | Sport | Event | Bet Type | Stake (u) | Result | P/L (u) | Notes |
| --- | --- | --- | --- | ---: | --- | ---: | --- |

## Tracker Notes
- Fresh 30-day trial on the deep-analysis rules engine. Reset ${ddmmyyyy}.
- Bankroll floors at 0u while positive (no imaginary units / never staked beyond what's left); once it reaches 0u it continues into negative so we can keep observing.
- Stakes scale with evidence strength; protect the bankroll before chasing volume.
`;

const LOSING_LEGS = `# Bot Losing Legs Report

_Reset ${iso} for the fresh 30-day trial. Repeat losing legs (>= 2 losses) are logged here automatically as results settle._
`;

async function writeFile(filePath, contents, label) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
  console.log(`  reset ${label}: ${path.relative(workspaceRoot, filePath)}`);
}

async function main() {
  console.log(`Resetting 30-day trial to ${STARTING_UNITS}u start (${ddmmyyyy})...`);
  await writeFile(path.join(here, 'bot-bankroll-tracker.csv'), `${BANKROLL_CSV_HEADER}\n`, 'bankroll tracker');
  await writeFile(path.join(here, 'picks-feed.json'), `${JSON.stringify({ picks: [] }, null, 2)}\n`, 'picks feed');
  await writeFile(path.join(here, 'state.json'), `${JSON.stringify(CLEAN_STATE, null, 2)}\n`, 'daemon state');
  // Delete (don't empty) the evidence log so its header re-writes on the next post.
  await fs.rm(path.join(here, 'bot-evidence-log.csv'), { force: true });
  console.log('  reset evidence log: bot-evidence-log.csv (removed; recreated on next post)');
  // Delete the isolated MLB ledger + its report so they re-init at the MLB starting
  // bankroll on the next MLB pick.
  await fs.rm(path.join(here, 'bot-bankroll-tracker-mlb.csv'), { force: true });
  await fs.rm(path.join(here, 'bot-losing-legs-report-mlb.md'), { force: true });
  console.log('  reset MLB ledger: bot-bankroll-tracker-mlb.csv + bot-losing-legs-report-mlb.md (removed; re-init on next MLB pick)');
  await writeFile(path.join(here, 'bot-losing-legs-report.md'), LOSING_LEGS, 'losing-legs report');
  await writeFile(path.join(workspaceRoot, '30-day-profit-tracker.md'), PROFIT_TRACKER, 'profit tracker');
  console.log('Done. Webhook URLs were left intact. Launch the new build to start the fresh trial.');
}

main().catch((error) => {
  console.error(`Reset failed: ${error.message}`);
  process.exitCode = 1;
});
