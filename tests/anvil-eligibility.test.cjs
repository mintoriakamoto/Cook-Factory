'use strict';

/**
 * ANV-01 red-green tests — the Anvil eligibility predicate (v1.4 Anvil Executor).
 *
 * Pure decider: is this increment a candidate for the Anvil gated cheap-loop executor?
 * Eligible ONLY when every condition holds (fail-toward-normal — any doubt → normal executor):
 *   - depth === 'fast'                       (low-risk; the gate carries the quality)
 *   - deliverableKind === 'python-single-file' (Anvil is Python/stdlib single-file LOCKED)
 *   - gatePresent === true                   (a machine gate exists to forge against)
 *   - anvilAvailable === true                (anvil.py + python3 present locally)
 *   - enabled === true                       (operator opted the capability in)
 *
 * `reasons` lists every blocker so the routing decision is auditable. Never throws.
 * PURE: no fs, no env, no clock, no network — availability is passed in explicitly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateAnvilEligibility, evaluateGateFirstEligibility } = require('../ferrox-core/bin/lib/anvil-eligibility.cjs');

const OK = {
  depth: 'fast',
  deliverableKind: 'python-single-file',
  gatePresent: true,
  anvilAvailable: true,
  enabled: true,
};

test('all conditions met -> eligible, no blockers (ANV-01)', () => {
  const r = evaluateAnvilEligibility(OK);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reasons, []);
});

test('full-depth increment is NOT eligible (Anvil is for the fast lane only)', () => {
  const r = evaluateAnvilEligibility({ ...OK, depth: 'full' });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('not-fast-depth'));
});

test('a non-Python deliverable is NOT eligible (Anvil is python-single-file locked)', () => {
  const r = evaluateAnvilEligibility({ ...OK, deliverableKind: 'js-module' });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('not-python-single-file'));
});

test('no gate -> NOT eligible (nothing to forge against)', () => {
  const r = evaluateAnvilEligibility({ ...OK, gatePresent: false });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('no-gate'));
});

test('anvil not available locally -> NOT eligible', () => {
  const r = evaluateAnvilEligibility({ ...OK, anvilAvailable: false });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('anvil-unavailable'));
});

test('capability disabled -> NOT eligible even when everything else fits', () => {
  const r = evaluateAnvilEligibility({ ...OK, enabled: false });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('disabled'));
});

test('multiple blockers are ALL reported (auditable)', () => {
  const r = evaluateAnvilEligibility({
    depth: 'full', deliverableKind: 'rust-crate',
    gatePresent: false, anvilAvailable: false, enabled: false,
  });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('not-fast-depth'));
  assert.ok(r.reasons.includes('not-python-single-file'));
  assert.ok(r.reasons.includes('no-gate'));
  assert.ok(r.reasons.includes('anvil-unavailable'));
  assert.ok(r.reasons.includes('disabled'));
});

test('fail-toward-normal: garbage/undefined inputs are NOT eligible, never throw', () => {
  assert.doesNotThrow(() => evaluateAnvilEligibility(undefined));
  assert.equal(evaluateAnvilEligibility(undefined).eligible, false);
  assert.equal(evaluateAnvilEligibility({}).eligible, false);
  assert.equal(evaluateAnvilEligibility({ depth: 'fast' }).eligible, false);
});

test('truthy-but-not-true booleans do NOT satisfy the gate (strict === true)', () => {
  // fail-toward-normal: only an explicit boolean true counts as availability/consent
  const r = evaluateAnvilEligibility({ ...OK, enabled: 1 });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('disabled'));
});

// ---------------------------------------------------------------------------
// UGE-06 — evaluateGateFirstEligibility: the GENERALIZED gate-first predicate.
//
// python-single-file lock -> gateability: gate_present + selectGate(domain) routes
// 'gate-first' + native executor available + capability enabled. Depth is BROADENED —
// both 'fast' AND 'full' are eligible; depth is passed through so the router can
// prefer frontier-assist on full. route: 'gate-first' when eligible; 'crucible' when
// the ONLY blocker is domain-not-gateable; else 'normal'. Fail-toward-normal always.
// ---------------------------------------------------------------------------

const GF_OK = {
  depth: 'fast',
  domain: 'code',
  gatePresent: true,
  executorAvailable: true,
  enabled: true,
};

test('gate-first: all conditions met -> eligible, route gate-first, no blockers (UGE-06)', () => {
  const r = evaluateGateFirstEligibility(GF_OK);
  assert.equal(r.eligible, true);
  assert.equal(r.route, 'gate-first');
  assert.deepEqual(r.reasons, []);
});

test('gate-first: depth broadened — full depth is ALSO eligible (no depth blocker)', () => {
  const r = evaluateGateFirstEligibility({ ...GF_OK, depth: 'full' });
  assert.equal(r.eligible, true);
  assert.equal(r.route, 'gate-first');
  assert.deepEqual(r.reasons, []);
});

test('gate-first: depth is passed through so the router can prefer frontier-assist on full', () => {
  assert.equal(evaluateGateFirstEligibility({ ...GF_OK, depth: 'full' }).depth, 'full');
  assert.equal(evaluateGateFirstEligibility(GF_OK).depth, 'fast');
  assert.equal(evaluateGateFirstEligibility({ ...GF_OK, depth: 42 }).depth, null);
});

test('gate-first: no gate -> blocked with no-gate, route normal', () => {
  const r = evaluateGateFirstEligibility({ ...GF_OK, gatePresent: false });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('no-gate'));
  assert.equal(r.route, 'normal');
});

test('gate-first: tier-6 domain (writing) -> domain-not-gateable; SOLE blocker routes crucible', () => {
  const r = evaluateGateFirstEligibility({ ...GF_OK, domain: 'writing' });
  assert.equal(r.eligible, false);
  assert.deepEqual(r.reasons, ['domain-not-gateable']);
  assert.equal(r.route, 'crucible');
});

test('gate-first: UNKNOWN domain routes crucible via selectGate fail-safe -> lands domain-not-gateable', () => {
  const r = evaluateGateFirstEligibility({ ...GF_OK, domain: 'interpretive-dance' });
  assert.equal(r.eligible, false);
  assert.deepEqual(r.reasons, ['domain-not-gateable']);
  assert.equal(r.route, 'crucible');
});

test('gate-first: domain aliases resolve through gate-select (sql -> data-sql -> gate-first)', () => {
  const r = evaluateGateFirstEligibility({ ...GF_OK, domain: 'sql' });
  assert.equal(r.eligible, true);
  assert.equal(r.route, 'gate-first');
});

test('gate-first: executor unavailable -> executor-unavailable, route normal', () => {
  const r = evaluateGateFirstEligibility({ ...GF_OK, executorAvailable: false });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('executor-unavailable'));
  assert.equal(r.route, 'normal');
});

test('gate-first: capability disabled -> disabled, route normal', () => {
  const r = evaluateGateFirstEligibility({ ...GF_OK, enabled: false });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('disabled'));
  assert.equal(r.route, 'normal');
});

test('gate-first: domain-not-gateable + ANY other blocker -> route normal (crucible only when sole blocker)', () => {
  const r = evaluateGateFirstEligibility({ ...GF_OK, domain: 'writing', gatePresent: false });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('domain-not-gateable'));
  assert.ok(r.reasons.includes('no-gate'));
  assert.equal(r.route, 'normal');
});

test('gate-first: multiple blockers are ALL reported (auditable)', () => {
  const r = evaluateGateFirstEligibility({ depth: 'full', domain: 'writing', gatePresent: false, executorAvailable: false, enabled: false });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('no-gate'));
  assert.ok(r.reasons.includes('domain-not-gateable'));
  assert.ok(r.reasons.includes('executor-unavailable'));
  assert.ok(r.reasons.includes('disabled'));
  assert.equal(r.route, 'normal');
});

test('gate-first: fail-toward-normal on malformed input — garbage never throws, never eligible', () => {
  assert.doesNotThrow(() => evaluateGateFirstEligibility(undefined));
  for (const garbage of [undefined, null, {}, { domain: 42 }, { domain: ['code'], gatePresent: 'yes' }, 'code']) {
    const r = evaluateGateFirstEligibility(garbage);
    assert.equal(r.eligible, false);
    assert.equal(r.route, ['crucible', 'normal'].includes(r.route) ? r.route : 'FAIL', `route stays fail-safe for ${JSON.stringify(garbage)}`);
  }
});

test('gate-first: truthy-but-not-true booleans do NOT satisfy the gate (strict === true)', () => {
  const r = evaluateGateFirstEligibility({ ...GF_OK, gatePresent: 1, executorAvailable: 'yes' });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.includes('no-gate'));
  assert.ok(r.reasons.includes('executor-unavailable'));
  assert.equal(r.route, 'normal');
});

test('gate-first: back-compat — evaluateAnvilEligibility is untouched and still python-locked', () => {
  const r = evaluateAnvilEligibility({
    depth: 'fast', deliverableKind: 'python-single-file',
    gatePresent: true, anvilAvailable: true, enabled: true,
  });
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reasons, []);
});
