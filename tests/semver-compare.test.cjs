'use strict';

/**
 * semverSatisfies range semantics — locks in npm-compatible desugaring for the
 * load-time engines gate, in particular the partial-zero caret forms that
 * previously computed a too-narrow upper bound (^0.0 → <0.0.1 instead of
 * <0.1.0, ^0 → <0.0.1 instead of <1.0.0). A too-narrow bound fails closed, so
 * it silently rejected legitimately-compatible capability versions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { semverSatisfies } = require('../ferrox-core/bin/lib/semver-compare.cjs');

test('caret ranges desugar per npm for major>0 and minor>0', () => {
  assert.equal(semverSatisfies('1.2.3', '^1.2.3'), true);
  assert.equal(semverSatisfies('1.9.0', '^1.2.3'), true);
  assert.equal(semverSatisfies('2.0.0', '^1.2.3'), false);
  assert.equal(semverSatisfies('1.2.2', '^1.2.3'), false);

  assert.equal(semverSatisfies('0.2.3', '^0.2.3'), true);
  assert.equal(semverSatisfies('0.2.9', '^0.2.3'), true);
  assert.equal(semverSatisfies('0.3.0', '^0.2.3'), false);
});

test('caret with full 0.0.z pins the patch (npm: ^0.0.3 → >=0.0.3 <0.0.4)', () => {
  assert.equal(semverSatisfies('0.0.3', '^0.0.3'), true);
  assert.equal(semverSatisfies('0.0.4', '^0.0.3'), false);
  assert.equal(semverSatisfies('0.0.2', '^0.0.3'), false);
});

test('PARTIAL zero carets widen to the next unspecified part (the regression)', () => {
  // ^0.0 → >=0.0.0 <0.1.0
  assert.equal(semverSatisfies('0.0.0', '^0.0'), true);
  assert.equal(semverSatisfies('0.0.5', '^0.0'), true);
  assert.equal(semverSatisfies('0.1.0', '^0.0'), false);
  // ^0 → >=0.0.0 <1.0.0
  assert.equal(semverSatisfies('0.0.5', '^0'), true);
  assert.equal(semverSatisfies('0.9.9', '^0'), true);
  assert.equal(semverSatisfies('1.0.0', '^0'), false);
});

test('tilde, bare-partial, and comparator forms are unchanged', () => {
  assert.equal(semverSatisfies('1.2.9', '~1.2.3'), true);
  assert.equal(semverSatisfies('1.3.0', '~1.2.3'), false);
  assert.equal(semverSatisfies('1.9.0', '~1'), true);
  assert.equal(semverSatisfies('1.5.0', '1.5'), true);
  assert.equal(semverSatisfies('1.6.0', '1.5'), false);
  assert.equal(semverSatisfies('2.0.0', '>=1.0.0'), true);
  assert.equal(semverSatisfies('1.0.0', '>=1.0.0 <2.0.0'), true);
  assert.equal(semverSatisfies('2.0.0', '>=1.0.0 <2.0.0'), false);
  assert.equal(semverSatisfies('3.1.0', '^1.0.0 || ^3.0.0'), true);
});

test('fail-closed behavior is preserved for unparseable/empty ranges', () => {
  assert.equal(semverSatisfies('1.0.0', ''), false);
  assert.equal(semverSatisfies('1.0.0', 'not-a-range'), false);
  assert.equal(semverSatisfies('1.0.0', '>=*'), false);
  assert.equal(semverSatisfies('1.0.0', null), false);
});
