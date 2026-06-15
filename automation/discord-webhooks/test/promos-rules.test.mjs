import test from 'node:test';
import assert from 'node:assert/strict';

import { applyPromoSettlementRule, LEG_OUTCOME } from '../src/promos-settlement.mjs';

const legs = (...outcomes) => outcomes.map((o, i) => ({ id: `leg-${i + 1}`, outcome: o }));
const W = LEG_OUTCOME.WIN;
const L = LEG_OUTCOME.LOSS;
const U = LEG_OUTCOME.UNRESOLVED;

test('standard rule: all win => win, any loss => loss', () => {
  assert.equal(applyPromoSettlementRule({ type: 'standard' }, legs(W, W, W)).outcome, 'win');
  assert.equal(applyPromoSettlementRule({ type: 'standard' }, legs(W, L, W)).outcome, 'loss');
  assert.equal(applyPromoSettlementRule(undefined, legs(W, W)).outcome, 'win'); // defaults to standard
});

test('leg-insurance: up to insuredLegs losses => refund, more => loss', () => {
  const rule = { type: 'leg-insurance', insuredLegs: 1 };
  assert.deepEqual(
    { o: applyPromoSettlementRule(rule, legs(W, W, W)).outcome, r: applyPromoSettlementRule(rule, legs(W, W, W)).refund },
    { o: 'win', r: false }
  );
  const oneLoss = applyPromoSettlementRule(rule, legs(W, L, W));
  assert.equal(oneLoss.outcome, 'refund');
  assert.equal(oneLoss.refund, true);
  assert.equal(applyPromoSettlementRule(rule, legs(W, L, L)).outcome, 'loss'); // 2 losses > 1 insured
});

test('leg-insurance honours a higher insuredLegs count', () => {
  const rule = { type: 'leg-insurance', insuredLegs: 2 };
  assert.equal(applyPromoSettlementRule(rule, legs(W, L, L, W)).outcome, 'refund');
  assert.equal(applyPromoSettlementRule(rule, legs(L, L, L)).outcome, 'loss');
});

test('margin-forgiveness: a loss within tolerance is regraded to win', () => {
  const rule = { type: 'margin-forgiveness', marginTolerance: 1 };
  // Leg missed its line by 1 (e.g. 19 on a 20+ disposals line) => forgiven => win.
  const forgiven = applyPromoSettlementRule(rule, [
    { id: 'a', outcome: W },
    { id: 'b', outcome: L, missBy: 1 },
    { id: 'c', outcome: W }
  ]);
  assert.equal(forgiven.outcome, 'win');
  assert.equal(forgiven.legs[1].forgiven, true);

  // Missed by 2 (> tolerance) => stays a loss => slip loses.
  const tooFar = applyPromoSettlementRule(rule, [
    { id: 'a', outcome: W },
    { id: 'b', outcome: L, missBy: 2 }
  ]);
  assert.equal(tooFar.outcome, 'loss');
});

test('unresolved legs keep the slip pending under any rule', () => {
  assert.equal(applyPromoSettlementRule({ type: 'standard' }, legs(W, U)).outcome, 'pending');
  assert.equal(applyPromoSettlementRule({ type: 'leg-insurance', insuredLegs: 1 }, legs(W, U, L)).outcome, 'pending');
});
