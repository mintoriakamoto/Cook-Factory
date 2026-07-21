'use strict';

/**
 * FAST-03b red-green tests — cross-audit waiver on the merge gate (v1.2).
 *
 * On the HIGH-RISK path (audit_tier === 'cross') the increment runs a 3-eye
 * parallel panel (codex ∥ gemini ∥ an internal adversarial subagent) INSTEAD of
 * RED-first + mutation — the 5-lane benchmark proved RED+mutation stacked on top
 * of a cross-audit bought zero correctness (B4==B5==19/19). So a passing
 * cross-audit REPLACES receipts + mutation, exactly as the fast path's
 * depth_decision does:
 *   - audit_tier === 'cross' + cross_audit === 'passed' -> receipts+mutation waived;
 *   - audit_tier === 'cross' WITHOUT a passed panel -> block 'cross-audit-not-passed';
 *   - every cheap gate (coverage, ownership, hot-seam, burndown, security counts,
 *     errors) stays required on BOTH paths;
 *   - a garbage audit_tier falls to the STRICTEST full semantics (receipts+mutation
 *     required) — fail closed;
 *   - the full-internal path (audit_tier 'internal', no fast depth) is unchanged:
 *     receipts + mutation still required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateMergeGate } = require('../ferrox-core/bin/lib/strength-merge-gate.cjs');

/** Affirmative cheap-gate evidence, no receipts/mutation (the cross path supplies neither). */
function crossGreen() {
  return {
    audit_tier: 'cross',
    cross_audit: 'passed',
    coverage: 'landed',
    ownership: 'ok',
    hot_seam: 'serialized',
    burndown: 'ok',
    open_security_count: 0,
    open_critical_high_count: 0,
    errors: [],
  };
}

/** The pre-v1.2 full-green set (receipts + mutation present). */
function fullGreen() {
  return {
    receipts: 'valid', coverage: 'landed', mutation: 'killed', ownership: 'ok',
    hot_seam: 'serialized', burndown: 'ok', open_security_count: 0,
    open_critical_high_count: 0, errors: [],
  };
}

test('cross + passed panel passes WITHOUT receipts or mutation (FAST-03b)', () => {
  assert.deepEqual(evaluateMergeGate(crossGreen()), { decision: 'pass', reasons: [] });
});

test('cross WITHOUT a cross_audit verdict blocks: cross-audit-not-passed', () => {
  const ev = crossGreen();
  delete ev.cross_audit;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['cross-audit-not-passed']);
});

test('cross with a non-"passed" panel blocks (strict equality, no coercion)', () => {
  const r = evaluateMergeGate({ ...crossGreen(), cross_audit: 'partial' });
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['cross-audit-not-passed']);
});

test('the cheap gates are NEVER waived on the cross path: missing burndown blocks', () => {
  const ev = crossGreen();
  delete ev.burndown;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['burndown-not-ok']);
});

test('cross with an open security finding blocks: security-open', () => {
  const r = evaluateMergeGate({ ...crossGreen(), open_security_count: 1 });
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['security-open']);
});

test('a garbage audit_tier ("triple") falls to FULL semantics — receipts+mutation required', () => {
  // crossGreen has no receipts/mutation; under full semantics that must block.
  const r = evaluateMergeGate({ ...crossGreen(), audit_tier: 'triple' });
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('receipts-not-valid'));
  assert.ok(r.reasons.includes('mutation-survived'));
});

test('full-internal path (audit_tier "internal") is unchanged — receipts+mutation still required', () => {
  const ev = fullGreen();
  delete ev.receipts;
  const r = evaluateMergeGate({ ...ev, audit_tier: 'internal' });
  assert.equal(r.decision, 'block');
  assert.ok(r.reasons.includes('receipts-not-valid'));
});

test('cross + passed still passes even with receipts/mutation fields ABSENT', () => {
  const ev = crossGreen();
  assert.equal(ev.receipts, undefined);
  assert.equal(ev.mutation, undefined);
  assert.equal(evaluateMergeGate(ev).decision, 'pass');
});

test('an errored input verb still blocks on the cross path', () => {
  const r = evaluateMergeGate({ ...crossGreen(), errors: ['trident.audit: boom'] });
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['input-verb-error']);
});

test('cross collects ALL failing reasons, cross-audit reason first', () => {
  const ev = crossGreen();
  delete ev.cross_audit;
  delete ev.coverage;
  ev.open_critical_high_count = 3;
  const r = evaluateMergeGate(ev);
  assert.equal(r.decision, 'block');
  assert.deepEqual(r.reasons, ['cross-audit-not-passed', 'coverage-not-landed', 'critical-high-open']);
});

test('pre-v1.2 full-green evidence (no audit_tier) still passes — zero regression', () => {
  assert.deepEqual(evaluateMergeGate(fullGreen()), { decision: 'pass', reasons: [] });
});
