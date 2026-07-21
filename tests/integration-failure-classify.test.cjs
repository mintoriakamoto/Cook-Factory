'use strict';

/**
 * INTG-03 red-green tests — aggregate-head failure classifier (v1.6, from the WLD field report #3).
 *
 * After landing a wave, the FULL suite runs at the exact merged SHA. This classifies every failure so
 * cross-cutting regressions (invisible to per-packet verify) block, while env/flake noise is quarantined
 * — never the reverse. Verdicts per failure:
 *   - pre-existing  : already failing at the baseline SHA (not a NEW regression; doesn't block)
 *   - env-artifact  : matches a declared env signature (e.g. duplicate-React symlink) — quarantine
 *   - known-flake   : matches a declared flake signature
 *   - regression    : a NEW failure matching nothing above — REAL, blocks the wave
 *
 * FAIL-TOWARD-REGRESSION: a new failure is a regression unless it EXPLICITLY matches an env/flake
 * signature. Noise never silently passes as env; only a declared pattern quarantines. Never throws.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFailures } = require('../ferrox-core/bin/lib/integration-failure-classify.cjs');

test('a new failure matching nothing is a REGRESSION and blocks (INTG-03)', () => {
  const r = classifyFailures({ failures: ['test_send_fails_closed'], baseline: [], envPatterns: [], flakePatterns: [] });
  assert.equal(r.classified[0].verdict, 'regression');
  assert.equal(r.summary.regression, 1);
  assert.equal(r.blocks, true);
});

test('a failure already red at baseline is pre-existing, not a regression', () => {
  const r = classifyFailures({ failures: ['old_broken'], baseline: ['old_broken'], envPatterns: [], flakePatterns: [] });
  assert.equal(r.classified[0].verdict, 'pre-existing');
  assert.equal(r.blocks, false);
});

test('env-artifact quarantine: 347 duplicate-React failures do NOT block (the real WLD case)', () => {
  const failures = Array.from({ length: 347 }, (_, i) => `render_${i}: Invalid hook call / duplicate React`);
  const r = classifyFailures({ failures, baseline: [], envPatterns: ['duplicate React', 'Invalid hook call'], flakePatterns: [] });
  assert.equal(r.summary.env, 347);
  assert.equal(r.summary.regression, 0);
  assert.equal(r.blocks, false);
});

test('the 12 real regressions are caught alongside 347 env artifacts (mixed head)', () => {
  const env = Array.from({ length: 347 }, (_, i) => `render_${i}: duplicate React`);
  const regs = Array.from({ length: 12 }, (_, i) => `wcore_send_${i}: expected fail-closed`);
  const r = classifyFailures({ failures: [...env, ...regs], baseline: [], envPatterns: ['duplicate React'], flakePatterns: [] });
  assert.equal(r.summary.env, 347);
  assert.equal(r.summary.regression, 12);
  assert.equal(r.blocks, true);   // the 12 real ones still block despite the noise
});

test('known-flake quarantine (declared pattern)', () => {
  const r = classifyFailures({ failures: ['test_timeout_parallel_load'], baseline: [], envPatterns: [], flakePatterns: ['timeout_parallel_load'] });
  assert.equal(r.classified[0].verdict, 'known-flake');
  assert.equal(r.blocks, false);
});

test('precedence: pre-existing wins over env/flake (already-red is not new noise to re-explain)', () => {
  const r = classifyFailures({ failures: ['x duplicate React'], baseline: ['x duplicate React'], envPatterns: ['duplicate React'], flakePatterns: [] });
  assert.equal(r.classified[0].verdict, 'pre-existing');
});

test('FAIL-TOWARD-REGRESSION: an env-LOOKING failure without a declared pattern still blocks', () => {
  // no envPatterns declared -> the "duplicate React"-ish text is NOT auto-quarantined
  const r = classifyFailures({ failures: ['looks like duplicate React'], baseline: [], envPatterns: [], flakePatterns: [] });
  assert.equal(r.classified[0].verdict, 'regression');
  assert.equal(r.blocks, true);
});

test('empty head is clean, does not block', () => {
  const r = classifyFailures({ failures: [], baseline: [], envPatterns: [], flakePatterns: [] });
  assert.equal(r.blocks, false);
  assert.equal(r.summary.regression, 0);
});

test('never throws on garbage input; garbage failures are treated as blocking regressions', () => {
  assert.doesNotThrow(() => classifyFailures(undefined));
  assert.equal(classifyFailures(undefined).blocks, false); // no failures listed -> nothing to block
  const r = classifyFailures({ failures: ['real'], baseline: null, envPatterns: 'notarray', flakePatterns: 42 });
  assert.equal(r.classified[0].verdict, 'regression');
  assert.equal(r.blocks, true);
});
