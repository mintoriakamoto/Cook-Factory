'use strict';

/**
 * ANV-03 red-green tests — the Anvil candidate decision (v1.4 Anvil Executor).
 *
 * THE SAFETY INVARIANT of the whole milestone: an Anvil result is only ever a
 * *candidate*. Anvil-green means "worth handing to Factory's verify + merge-gate" —
 * it NEVER waives receipts, mutation, coverage, or any merge-gate criterion. The
 * candidate is exactly as untrusted as any other diff.
 *
 * decideAnvilCandidate({ parsed, candidatePresent }) -> { action, reason }
 *   candidatePresent && parsed.green  -> 'accept-candidate'  (goes to the unchanged merge-gate)
 *   candidatePresent && !parsed.green -> 'reject'            (partial climb; normal executor builds it)
 *   !candidatePresent                 -> 'fallback-normal'   (empty/silent burn; normal executor)
 *
 * PURE. Never throws. Fail-toward-normal on any garbage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { decideAnvilCandidate } = require('../ferrox-core/bin/lib/anvil-candidate-gate.cjs');

test('green candidate present -> accept-candidate (still faces the merge-gate) (ANV-03)', () => {
  const r = decideAnvilCandidate({ parsed: { green: true }, candidatePresent: true });
  assert.equal(r.action, 'accept-candidate');
});

test('partial (not green) but candidate present -> reject, normal executor takes over', () => {
  const r = decideAnvilCandidate({ parsed: { green: false }, candidatePresent: true });
  assert.equal(r.action, 'reject');
});

test('no candidate written (empty/silent burn) -> fallback-normal', () => {
  const r = decideAnvilCandidate({ parsed: { green: true }, candidatePresent: false });
  assert.equal(r.action, 'fallback-normal');
  assert.ok(/candidate/i.test(r.reason));
});

test('SAFETY: accept-candidate never signals a waiver of any gate criterion', () => {
  const r = decideAnvilCandidate({ parsed: { green: true }, candidatePresent: true });
  // the decision object must not carry any waiver/skip flag — it only routes to the gate
  assert.equal(r.waive, undefined);
  assert.equal(r.skipMergeGate, undefined);
  assert.equal(r.action, 'accept-candidate');
});

test('fail-toward-normal: missing parsed / garbage -> fallback-normal, never throws', () => {
  assert.doesNotThrow(() => decideAnvilCandidate(undefined));
  assert.equal(decideAnvilCandidate(undefined).action, 'fallback-normal');
  assert.equal(decideAnvilCandidate({}).action, 'fallback-normal');
  assert.equal(decideAnvilCandidate({ parsed: null, candidatePresent: true }).action, 'reject');
});

test('green must be exactly true — a truthy non-true does not accept', () => {
  const r = decideAnvilCandidate({ parsed: { green: 1 }, candidatePresent: true });
  assert.equal(r.action, 'reject');
});
