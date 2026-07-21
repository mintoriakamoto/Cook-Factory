'use strict';

/**
 * INTG-01/04/05 red-green tests — integration-landing, blocker-policy, authority-fence (v1.6).
 * The three pure safety cores adopted from the WLD Desktop field report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideIntegrationLanding } = require('../ferrox-core/bin/lib/integration-landing.cjs');
const { decideBlockerAction } = require('../ferrox-core/bin/lib/blocker-policy.cjs');
const { checkAuthority, assertInvariants } = require('../ferrox-core/bin/lib/authority-fence.cjs');

// ── INTG-01 integration landing ───────────────────────────────────────────────
test('land only when head proven + ff-only + protected clean (INTG-01)', () => {
  const r = decideIntegrationLanding({ mergedHeadProven: true, ffOnlyPossible: true, protectedPathsClean: true });
  assert.equal(r.action, 'land');
});
test('unproven merged head -> reprove (prove the exact SHA first)', () => {
  const r = decideIntegrationLanding({ mergedHeadProven: false, ffOnlyPossible: true, protectedPathsClean: true });
  assert.equal(r.action, 'reprove');
});
test('candidate diverged (not ff) -> block', () => {
  const r = decideIntegrationLanding({ mergedHeadProven: true, ffOnlyPossible: false, protectedPathsClean: true });
  assert.equal(r.action, 'block');
  assert.match(r.reason, /fast-forward/);
});
test('dirtied protected path -> block, before anything else', () => {
  const r = decideIntegrationLanding({ mergedHeadProven: false, ffOnlyPossible: false, protectedPathsClean: false });
  assert.equal(r.action, 'block');
  assert.match(r.reason, /protected/);
});
test('fail-closed: garbage/empty -> block, never throws', () => {
  assert.doesNotThrow(() => decideIntegrationLanding(undefined));
  assert.equal(decideIntegrationLanding(undefined).action, 'block');
  assert.equal(decideIntegrationLanding({ mergedHeadProven: 1, ffOnlyPossible: 1, protectedPathsClean: 1 }).action, 'block');
});

// ── INTG-04 park-and-continue ─────────────────────────────────────────────────
test('independent work remaining -> park-and-continue, always surfaces (INTG-04)', () => {
  const r = decideBlockerAction({ independentWorkRemaining: true, requiresHumanAuthority: false });
  assert.equal(r.action, 'park-and-continue');
  assert.equal(r.surface, true);
});
test('no work left -> halt cleanly (bounded), still surfaces', () => {
  const r = decideBlockerAction({ independentWorkRemaining: false });
  assert.equal(r.action, 'halt');
  assert.equal(r.surface, true);
});
test('human-authority blocker is flagged needsHuman but does NOT halt a busy fleet', () => {
  const r = decideBlockerAction({ independentWorkRemaining: true, requiresHumanAuthority: true });
  assert.equal(r.action, 'park-and-continue');
  assert.equal(r.needsHuman, true);
});
test('blocker is NEVER silently dropped (surface always true); garbage -> halt+surface', () => {
  assert.doesNotThrow(() => decideBlockerAction(undefined));
  const r = decideBlockerAction(undefined);
  assert.equal(r.action, 'halt');
  assert.equal(r.surface, true);
});

// ── INTG-05 authority fence ───────────────────────────────────────────────────
test('denied ops are refused; a normal op is allowed (INTG-05)', () => {
  for (const op of ['push', 'merge-main', 'release', 'deploy', 'canary', 'issue-close', 'lifecycle-cleanup']) {
    assert.equal(checkAuthority({ op }).allowed, false, op);
  }
  assert.equal(checkAuthority({ op: 'run-tests' }).allowed, true);
});
test('fail-closed: non-string/empty op -> deny', () => {
  assert.equal(checkAuthority({ op: '' }).allowed, false);
  assert.equal(checkAuthority({}).allowed, false);
  assert.doesNotThrow(() => checkAuthority(undefined));
  assert.equal(checkAuthority(undefined).allowed, false);
});
test('custom deny-set overrides the default', () => {
  assert.equal(checkAuthority({ op: 'push', denied: ['only-this'] }).allowed, true);
  assert.equal(checkAuthority({ op: 'only-this', denied: ['only-this'] }).allowed, false);
});
test('assertInvariants: stable candidate + clean protected = ok', () => {
  const r = assertInvariants({ candidateShaBefore: 'abc', candidateShaAfter: 'abc', protectedPathsDirty: false });
  assert.equal(r.ok, true);
});
test('assertInvariants flags a moved pointer and a dirtied protected path', () => {
  const r = assertInvariants({ candidateShaBefore: 'abc', candidateShaAfter: 'def', protectedPathsDirty: true });
  assert.equal(r.ok, false);
  assert.ok(r.violations.includes('candidate-pointer-moved'));
  assert.ok(r.violations.includes('protected-path-dirtied'));
});
test('assertInvariants: unverifiable SHA is a violation (never assume stability), never throws', () => {
  assert.doesNotThrow(() => assertInvariants(undefined));
  assert.equal(assertInvariants(undefined).ok, false);
});
