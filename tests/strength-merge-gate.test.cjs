'use strict';

/**
 * FF-B10 red-green tests for the strength.merge-gate pure aggregator.
 *
 * This is the fail-CLOSED centerpiece: the single verdict that a candidate merge
 * is genuinely "landed". `pass` is reachable ONLY from a complete, all-affirmative,
 * error-free evidence set. Every other shape — a wrong value, a missing/undefined
 * field, or a non-empty errors[] (an input verb that errored) — MUST block with a
 * named reason, and block MUST list EVERY failing reason (not just the first).
 *
 * Evidence contract (Plan 07 router + Plan 08 hook depend on this):
 *   receipts === 'valid'            else receipts-not-valid
 *   coverage === 'landed'           else coverage-not-landed
 *   mutation === 'killed'           else mutation-survived
 *   ownership === 'ok'              else ownership-not-ok
 *   hot_seam === 'serialized'       else hot-seam-not-serialized
 *   burndown === 'ok'               else burndown-not-ok
 *   open_security_count === 0       else security-open
 *   open_critical_high_count === 0  else critical-high-open
 *   errors is empty array           else input-verb-error
 *
 * PURE core: no fs, no clock, no config.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateMergeGate } = require('../ferrox-core/bin/lib/strength-merge-gate.cjs');

/** A complete, all-affirmative, error-free evidence set (the ONLY pass shape). */
function greenEvidence() {
  return {
    receipts: 'valid',
    coverage: 'landed',
    mutation: 'killed',
    ownership: 'ok',
    hot_seam: 'serialized',
    burndown: 'ok',
    open_security_count: 0,
    open_critical_high_count: 0,
    errors: [],
  };
}

// --- the single pass path ----------------------------------------------------

test('complete all-affirmative error-free evidence → pass with no reasons', () => {
  const r = evaluateMergeGate(greenEvidence());
  assert.equal(r.decision, 'pass');
  assert.deepEqual(r.reasons, []);
});

// --- each wrong value blocks with its named reason ---------------------------

const WRONG_VALUE_CASES = [
  ['receipts', 'invalid', 'receipts-not-valid'],
  ['coverage', 'regressed', 'coverage-not-landed'],
  ['mutation', 'survived', 'mutation-survived'],
  ['ownership', 'conflict', 'ownership-not-ok'],
  ['hot_seam', 'concurrent', 'hot-seam-not-serialized'],
  ['burndown', 'blocked', 'burndown-not-ok'],
  ['open_security_count', 1, 'security-open'],
  ['open_critical_high_count', 1, 'critical-high-open'],
];

for (const [field, wrongValue, reason] of WRONG_VALUE_CASES) {
  test(`wrong ${field}=${JSON.stringify(wrongValue)} → block with ${reason}`, () => {
    const ev = greenEvidence();
    ev[field] = wrongValue;
    const r = evaluateMergeGate(ev);
    assert.equal(r.decision, 'block');
    assert.ok(r.reasons.includes(reason), `expected reason ${reason}, got ${JSON.stringify(r.reasons)}`);
  });
}

// --- FAIL CLOSED: each field individually missing/undefined blocks -----------

const MISSING_FIELD_REASON = {
  receipts: 'receipts-not-valid',
  coverage: 'coverage-not-landed',
  mutation: 'mutation-survived',
  ownership: 'ownership-not-ok',
  hot_seam: 'hot-seam-not-serialized',
  burndown: 'burndown-not-ok',
  open_security_count: 'security-open',
  open_critical_high_count: 'critical-high-open',
};

for (const [field, reason] of Object.entries(MISSING_FIELD_REASON)) {
  test(`FAIL CLOSED: missing ${field} → block with ${reason}`, () => {
    const ev = greenEvidence();
    delete ev[field];
    const r = evaluateMergeGate(ev);
    assert.equal(r.decision, 'block', `missing ${field} must fail closed`);
    assert.ok(r.reasons.includes(reason), `expected reason ${reason}, got ${JSON.stringify(r.reasons)}`);
  });

  test(`FAIL CLOSED: undefined ${field} → block with ${reason}`, () => {
    const ev = greenEvidence();
    ev[field] = undefined;
    const r = evaluateMergeGate(ev);
    assert.equal(r.decision, 'block', `undefined ${field} must fail closed`);
    assert.ok(r.reasons.includes(reason), `expected reason ${reason}, got ${JSON.stringify(r.reasons)}`);
  });
}

// --- counts: wrong-type / non-finite must fail closed (never coerced ok) -----

test('FAIL CLOSED: non-numeric open_security_count → block security-open', () => {
  const ev = greenEvidence();
  ev.open_security_count = 'zero';
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('security-open'));
});

test('FAIL CLOSED: NaN open_critical_high_count → block critical-high-open', () => {
  const ev = greenEvidence();
  ev.open_critical_high_count = NaN;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('critical-high-open'));
});

test('a negative count is not affirmative → block (only exactly 0 is green)', () => {
  const ev = greenEvidence();
  ev.open_security_count = -1;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('security-open'));
});

// --- input-verb error must block, never a silent pass ------------------------

test('non-empty errors[] → block with input-verb-error (never a silent pass)', () => {
  const ev = greenEvidence();
  ev.errors = ['strength.receipt threw ENOENT'];
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('input-verb-error'));
});

test('errors present alongside otherwise-green evidence still blocks (no coercion to ok)', () => {
  const ev = greenEvidence();
  ev.errors = ['coverage-source errored'];
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['input-verb-error']);
});

// --- missing errors field itself fails closed (cannot prove no verb errored) -

test('FAIL CLOSED: missing errors field → block input-verb-error (cannot prove all verbs succeeded)', () => {
  const ev = greenEvidence();
  delete ev.errors;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('input-verb-error'));
});

test('FAIL CLOSED: non-array errors (wrong type) → block input-verb-error', () => {
  const ev = greenEvidence();
  ev.errors = 'boom';
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('input-verb-error'));
});

// --- block lists ALL failing reasons, not just the first (repudiation) -------

test('block returns EVERY failing reason, in stable order', () => {
  const r = evaluateMergeGate({
    receipts: 'invalid',
    coverage: 'regressed',
    mutation: 'survived',
    ownership: 'conflict',
    hot_seam: 'concurrent',
    burndown: 'blocked',
    open_security_count: 3,
    open_critical_high_count: 2,
    errors: ['x'],
  });
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, [
    'receipts-not-valid',
    'coverage-not-landed',
    'mutation-survived',
    'ownership-not-ok',
    'hot-seam-not-serialized',
    'burndown-not-ok',
    'security-open',
    'critical-high-open',
    'input-verb-error',
  ]);
});

// --- fully-empty / undefined evidence: worst case, every reason fires --------

test('FAIL CLOSED: empty evidence object → block with all evidence reasons', () => {
  const r = evaluateMergeGate({});
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, [
    'receipts-not-valid',
    'coverage-not-landed',
    'mutation-survived',
    'ownership-not-ok',
    'hot-seam-not-serialized',
    'burndown-not-ok',
    'security-open',
    'critical-high-open',
    'input-verb-error',
  ]);
});

test('FAIL CLOSED: undefined/null argument → block (no throw, no pass)', () => {
  for (const bad of [undefined, null]) {
    const r = evaluateMergeGate(bad);
    assert.equal(r.decision, 'block', `${bad} arg must fail closed`);
    assert.ok(r.reasons.length > 0);
  }
});
