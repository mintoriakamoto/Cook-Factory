'use strict';

/**
 * STRONG-03 red-green tests for the strength.mutation-check decision core.
 *
 * A test that passes whether or not the code is correct is FAKE coverage. The
 * mutation gate mutates the mapped code and confirms the mapped test flips to
 * failing; a test that survives mutation of its own target is rejected.
 *   - mapped_test_flipped_to_red === true (with a real test mapping) → killed.
 *   - false → survived (the test survived its own target's mutation → fake).
 *   - missing evidence / missing test mapping → survived (fail CLOSED: unproven
 *     coverage is treated as fake, never silently killed).
 *
 * PURE decision core: no fs, no clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateMutationCheck } = require('../ferrox-core/bin/lib/strength-mutation-check.cjs');

test('a mapped test that flipped to red kills the mutant → killed', () => {
  const r = evaluateMutationCheck({ requirement: 'STRONG-03', test: 'tests/t.cjs', mapped_test_flipped_to_red: true });
  assert.equal(r.decision, 'killed');
  assert.equal(r.requirement, 'STRONG-03');
  assert.equal(r.test, 'tests/t.cjs');
});

test('a mapped test that stayed green survived the mutant → survived (fake coverage)', () => {
  const r = evaluateMutationCheck({ requirement: 'STRONG-03', test: 'tests/t.cjs', mapped_test_flipped_to_red: false });
  assert.equal(r.decision, 'survived');
});

test('missing mapped_test_flipped_to_red fails closed → survived', () => {
  const r = evaluateMutationCheck({ requirement: 'STRONG-03', test: 'tests/t.cjs' });
  assert.equal(r.decision, 'survived');
});

test('a non-boolean flip value fails closed → survived', () => {
  const r = evaluateMutationCheck({ requirement: 'STRONG-03', test: 'tests/t.cjs', mapped_test_flipped_to_red: 'true' });
  assert.equal(r.decision, 'survived', 'only the boolean true kills; a truthy string does not');
});

test('a missing/blank test mapping fails closed → survived even if flip is true', () => {
  assert.equal(evaluateMutationCheck({ requirement: 'STRONG-03', mapped_test_flipped_to_red: true }).decision, 'survived');
  assert.equal(evaluateMutationCheck({ requirement: 'STRONG-03', test: '', mapped_test_flipped_to_red: true }).decision, 'survived');
  assert.equal(evaluateMutationCheck({ requirement: 'STRONG-03', test: '   ', mapped_test_flipped_to_red: true }).decision, 'survived');
});
