import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendEvidenceCsv } from '../src/evidence-log.mjs';
import { __testables } from '../src/evidence-log.mjs';

const {
  buildEvidenceEmbed, buildEvidenceCsvRows, combinedOdds, computeClv,
  escapeCsv, rowsToCsv, parseCsvLine, updateEvidenceOutcome, EVIDENCE_CSV_HEADERS
} = __testables;

const pick = {
  id: 'gen:nrl:e1',
  sport: 'nrl',
  sportLabel: 'NRL',
  event: 'Storm vs Broncos',
  betType: 'sgm',
  stakeUnits: 1,
  legs: [
    {
      id: 'leg-1', label: 'Harry Grant 12.5+ points', odds: 1.8,
      source: { market: 'player_points', description: 'Harry Grant', outcomeName: 'Over', point: 12.5 },
      evidence: { status: 'supported', score: 4.2, reason: 'Averages 16.2 vs 12.5 (buffer 3.7), cleared 5/5.', type: 'player-form' }
    },
    {
      id: 'leg-2', label: 'Storm H2H', odds: 1.5,
      source: { market: 'h2h', outcomeName: 'Storm' },
      evidence: { status: 'supported', score: 3.5, reason: 'Form edge +40%, at home.', type: 'matchup-h2h' }
    }
  ]
};

test('evidence-log: embed', async (t) => {
  await t.test('builds an embed with a field per leg', () => {
    const embed = buildEvidenceEmbed(pick);
    assert.ok(embed);
    assert.equal(embed.fields.length, 2);
    assert.match(embed.title, /NRL/);
    assert.match(embed.description, /SGM/);
    assert.match(embed.description, /2\.70x/);
    assert.match(embed.description, /1u/);
    assert.match(embed.fields[0].value, /supported/);
  });

  await t.test('returns null when no leg has evidence', () => {
    const bare = { id: 'x', legs: [{ label: 'A', source: {} }, { label: 'B', source: {} }] };
    assert.equal(buildEvidenceEmbed(bare), null);
  });
});

test('evidence-log: csv rows', async (t) => {
  await t.test('one row per leg with the expected columns', () => {
    const rows = buildEvidenceCsvRows(pick, '2026-06-14T00:00:00Z');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].slipId, 'gen:nrl:e1');
    assert.equal(rows[0].market, 'player_points');
    assert.equal(rows[0].evidenceStatus, 'supported');
    assert.equal(rows[0].combinedOdds, 2.7);
    assert.equal(rows[0].odds, 1.8);
    assert.equal(rows[0].outcome, '');
  });

  await t.test('combinedOdds multiplies leg prices', () => {
    assert.equal(combinedOdds([{ odds: 1.8 }, { odds: 1.5 }]), 2.7);
    assert.equal(combinedOdds([]), null);
  });
});

test('evidence-log: csv formatting', async (t) => {
  await t.test('escapes commas, quotes and newlines', () => {
    assert.equal(escapeCsv('plain'), 'plain');
    assert.equal(escapeCsv('a,b'), '"a,b"');
    assert.equal(escapeCsv('he said "hi"'), '"he said ""hi"""');
  });

  await t.test('rowsToCsv writes a header row when requested', () => {
    const csv = rowsToCsv(buildEvidenceCsvRows(pick, 'T'), true);
    const lines = csv.split('\n');
    assert.equal(lines[0], EVIDENCE_CSV_HEADERS.join(','));
    assert.equal(lines.length, 3); // header + 2 legs
  });
});

test('evidence-log: clv + outcome back-fill', async (t) => {
  await t.test('computeClv reports the edge vs the close', () => {
    assert.equal(computeClv(1.8, 1.6), 12.5); // beat the close
    assert.equal(computeClv(1.5, 1.5), 0);
    assert.equal(computeClv(1.6, 1.8), -11.1); // worse than close
    assert.equal(computeClv(2.0, 1), null);
  });

  await t.test('updateEvidenceOutcome back-fills outcome + CLV by leg order', async () => {
    const file = path.join(os.tmpdir(), `evidence-test-${Date.now()}.csv`);
    try {
      await appendEvidenceCsv(file, buildEvidenceCsvRows(pick, '2026-06-14T00:00:00Z'));

      const updated = await updateEvidenceOutcome(file, {
        id: 'gen:nrl:e1',
        status: 'win',
        legs: [{ odds: 1.8, closingOdds: 1.6 }, { odds: 1.5, closingOdds: 1.5 }]
      });
      assert.equal(updated, 2);

      const content = await fs.readFile(file, 'utf8');
      const lines = content.trim().split('\n');
      const header = parseCsvLine(lines[0]);
      const outcomeIdx = header.indexOf('outcome');
      const clvIdx = header.indexOf('clv');
      const row1 = parseCsvLine(lines[1]);
      const row2 = parseCsvLine(lines[2]);

      assert.equal(row1[outcomeIdx], 'win');
      assert.equal(row2[outcomeIdx], 'win');
      assert.equal(row1[clvIdx], '12.5');
      assert.equal(row2[clvIdx], '0');
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});
