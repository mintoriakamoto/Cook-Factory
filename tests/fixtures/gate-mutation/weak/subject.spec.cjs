'use strict';

/**
 * The WEAK arm of the mutation gate fixture.
 *
 * It calls both functions and asserts almost nothing: the boundary is never
 * pinned and the arithmetic is never checked against a known value. Mutants of
 * `>=` and of `-` therefore survive, and the fixture scores below any real floor.
 *
 * Named `.spec.cjs`, NOT `.test.cjs`, on purpose. scripts/run-tests.cjs walks
 * tests/ recursively and collects every `*.test.cjs`, so a fixture named
 * `.test.cjs` would join the everyday suite. This file is driven only by the
 * gate, through `node --test <path>`, which runs a file passed explicitly
 * regardless of its name.
 */

const test = require('node:test');
const assert = require('node:assert');

const { overBudget, remaining } = require('./subject.cjs');

test('overBudget returns a boolean', () => {
  assert.strictEqual(typeof overBudget(10, 5), 'boolean');
});

test('remaining returns a number', () => {
  assert.strictEqual(typeof remaining(0, 1, 2), 'number');
});
