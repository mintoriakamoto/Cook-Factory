'use strict';

/**
 * The STRONG arm of the mutation gate fixture.
 *
 * It pins the boundary on both sides of the `>=` and checks the arithmetic
 * against known values, so the mutants the weak arm lets live are killed here.
 * It mutates nothing and shares no state with the weak arm; the 2 arms differ
 * only in what they assert about the SAME subject at
 * tests/fixtures/gate-mutation/weak/subject.cjs.
 *
 * Named `.spec.cjs` for the reason recorded in the weak arm's header.
 */

const test = require('node:test');
const assert = require('node:assert');

const { overBudget, remaining } = require('../weak/subject.cjs');

test('overBudget is true exactly AT the budget, which pins >= against >', () => {
  assert.strictEqual(overBudget(5, 5), true);
});

test('overBudget is false one unit below the budget, which pins >= against >=0', () => {
  assert.strictEqual(overBudget(4, 5), false);
});

test('overBudget is true above the budget', () => {
  assert.strictEqual(overBudget(6, 5), true);
});

test('remaining subtracts the elapsed span, which pins - against + and *', () => {
  assert.strictEqual(remaining(2, 5, 10), 7);
});

test('remaining is 0 when the whole budget is spent', () => {
  assert.strictEqual(remaining(0, 10, 10), 0);
});

test('remaining goes negative past the budget, which pins the subtraction order', () => {
  assert.strictEqual(remaining(0, 12, 10), -2);
});
