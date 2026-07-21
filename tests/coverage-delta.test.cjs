'use strict';

/**
 * Red-green tests for the HALT-04 coverage.delta core (D-02).
 *
 * The second tooth of the Ship Clock: whether a candidate merge actually
 * advances requirement/VALIDATION coverage. Only a STRICTLY POSITIVE delta
 * counts as landed — a no-op (delta 0) or a regression (delta < 0) is rejected
 * as not-landed, so an inflated 'after' cannot fake a land (T-03-11).
 *
 * Pure arithmetic: no fs, no clock, no log — the decision is a value the caller
 * acts on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateCoverageDelta } = require('../ferrox-core/bin/lib/coverage-delta.cjs');

test('a positive coverage delta is landed', () => {
  assert.deepEqual(evaluateCoverageDelta(5, 7), { decision: 'landed', delta: 2 });
});

test('a zero coverage delta (no-op merge) is not-landed', () => {
  assert.deepEqual(evaluateCoverageDelta(5, 5), { decision: 'not-landed', delta: 0 });
});

test('a negative coverage delta (regression) is not-landed', () => {
  assert.deepEqual(evaluateCoverageDelta(5, 4), { decision: 'not-landed', delta: -1 });
});
