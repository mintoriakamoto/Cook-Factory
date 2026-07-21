'use strict';

/**
 * FAST-02 red-green tests — depth-aware merge gate (v1.2 Fast Path).
 *
 * The fail-closed contract, extended:
 *   - depth ABSENT or anything other than the exact string 'fast' -> the
 *     original full semantics, bit-for-bit (zero regression; garbage enums
 *     fall to the STRICTEST path, the Phase-3 cap_outcome lesson);
 *   - depth === 'fast' -> receipts + mutation criteria are WAIVED and
 *     REPLACED by depth_decision === 'valid' (the router only says 'valid'
 *     after verifying the persisted decision record AND re-grading the
 *     actual diff against the risk boundaries — anti-gaming);
 *   - every cheap gate stays required on the fast path: coverage, ownership,
 *     hot-seam, burndown, zero security/critical counts, empty errors[].
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateMergeGate } = require('../ferrox-core/bin/lib/strength-merge-gate.cjs');

/** A fully-affirmative FULL-path evidence set (the pre-v1.2 green baseline). */
function fullGreen() {
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

/** A fully-affirmative FAST-path evidence set: no receipts, no mutation. */
function fastGreen() {
  return {
    depth: 'fast',
    depth_decision: 'valid',
    coverage: 'landed',
    ownership: 'ok',
    hot_seam: 'serialized',
    burndown: 'ok',
    open_security_count: 0,
    open_critical_high_count: 0,
    errors: [],
  };
}

test('depth absent -> original full semantics still pass on full-green evidence', () => {
  assert.deepEqual(evaluateMergeGate(fullGreen()), { decision: 'pass', reasons: [] });
});

test('depth absent -> missing receipts still blocks (zero regression)', () => {
  const ev = fullGreen();
  delete ev.receipts;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('receipts-not-valid'));
});

test('fast + valid depth decision passes WITHOUT receipts or mutation (FAST-02)', () => {
  assert.deepEqual(evaluateMergeGate(fastGreen()), { decision: 'pass', reasons: [] });
});

test('fast WITHOUT a depth decision blocks: depth-decision-not-valid', () => {
  const ev = fastGreen();
  delete ev.depth_decision;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['depth-decision-not-valid']);
});

test('fast with a non-"valid" depth decision blocks (strict equality, no coercion)', () => {
  const r = evaluateMergeGate({ ...fastGreen(), depth_decision: 'probably-fine' });
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['depth-decision-not-valid']);
});

test('the cheap gates are NEVER waived on fast: missing burndown blocks', () => {
  const ev = fastGreen();
  delete ev.burndown;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['burndown-not-ok']);
});

test('fast with an open security finding blocks: security-open', () => {
  const r = evaluateMergeGate({ ...fastGreen(), open_security_count: 1 });
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['security-open']);
});

test('fast with an errored input verb blocks: input-verb-error', () => {
  const r = evaluateMergeGate({ ...fastGreen(), errors: ['coord.ownership-check: boom'] });
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['input-verb-error']);
});

test('a garbage depth enum ("turbo") falls to FULL semantics, not fast (fail-closed)', () => {
  // fastGreen has no receipts/mutation — under full semantics that must block.
  const r = evaluateMergeGate({ ...fastGreen(), depth: 'turbo' });
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('receipts-not-valid'));
  assert.ok(r.reasons.includes('mutation-survived'));
});

test('explicit depth:"full" is identical to depth absent', () => {
  assert.deepEqual(
    evaluateMergeGate({ ...fullGreen(), depth: 'full' }),
    { decision: 'pass', reasons: [] },
  );
});

test('on the FULL path a depth_decision field is ignored — receipts still required', () => {
  const ev = fullGreen();
  delete ev.receipts;
  const r = evaluateMergeGate({ ...ev, depth: 'full', depth_decision: 'valid' });
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('receipts-not-valid'));
});

test('fast collects ALL failing reasons, never just the first', () => {
  const ev = fastGreen();
  delete ev.depth_decision;
  delete ev.coverage;
  ev.open_critical_high_count = 2;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, [
    'depth-decision-not-valid',
    'coverage-not-landed',
    'critical-high-open',
  ]);
});
