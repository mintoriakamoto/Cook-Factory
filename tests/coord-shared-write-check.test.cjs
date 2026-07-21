'use strict';

/**
 * Red-green tests for the COORD-05 coord.shared-write-check core.
 *
 * The orchestrator is the SOLE writer of shared planning state (STATE.md /
 * ROADMAP.md / BACKLOG.md); executors emit changes to it and never write it
 * directly. Invariants under test:
 *   1. A NON-orchestrator actor targeting a shared path -> forbidden, with the
 *      matched shared pattern returned.
 *   2. The orchestrator targeting a shared path -> allowed (the sole writer).
 *   3. A non-orchestrator actor targeting a NON-shared path -> allowed.
 *   4. A basename glob (a double-star-slash before STATE.md) matches a nested
 *      'sub/STATE.md' too, so a path prefix cannot smuggle a shared write
 *      through (threat T-04-10).
 *
 * The DEFAULT shared_state_paths list is read from the shipped config-defaults
 * manifest so the decision is deterministic and tied to the real registry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  evaluateSharedWrite,
} = require('../ferrox-core/bin/lib/coord-shared-write-check.cjs');

const MANIFEST_PATH = path.join(__dirname, '..', 'ferrox-core', 'bin', 'shared', 'config-defaults.manifest.json');
const DEFAULT = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).coordination.shared_state_paths;

// --- forbidden: a non-orchestrator write to shared state --------------------

test('a non-orchestrator (executor) write to STATE.md is forbidden', () => {
  const result = evaluateSharedWrite({ actor: 'executor', targetPath: '.planning/STATE.md', sharedPaths: DEFAULT });
  assert.equal(result.decision, 'forbidden');
  assert.ok(DEFAULT.includes(result.matched), 'the matched shared pattern is returned');
});

test('a non-orchestrator write to ROADMAP.md and BACKLOG.md is forbidden', () => {
  for (const file of ['.planning/ROADMAP.md', '.planning/BACKLOG.md']) {
    const result = evaluateSharedWrite({ actor: 'executor', targetPath: file, sharedPaths: DEFAULT });
    assert.equal(result.decision, 'forbidden', `${file} write by an executor is forbidden`);
    assert.ok(DEFAULT.includes(result.matched));
  }
});

test('a basename glob forbids a NESTED shared path (prefix cannot smuggle it through)', () => {
  const result = evaluateSharedWrite({ actor: 'executor', targetPath: 'some/nested/dir/STATE.md', sharedPaths: DEFAULT });
  assert.equal(result.decision, 'forbidden');
  assert.equal(result.matched, '**/STATE.md', 'matched the basename glob, not the exact path');
});

// --- case-insensitive matching: the dev/target FS is case-insensitive -------
// Regression (Phase-4 cross-audit Fix 1): the anchored matchers used a
// case-SENSITIVE RegExp, so on a case-insensitive FS (APFS/Windows) an executor
// could smuggle a shared write through by varying case — '.planning/state.md'
// and '.planning/STATE.MD' both resolve to the same shared file and MUST be
// forbidden.

test('a non-orchestrator write to a lowercase-cased shared path is forbidden (case-insensitive FS)', () => {
  const result = evaluateSharedWrite({ actor: 'executor', targetPath: '.planning/state.md', sharedPaths: DEFAULT });
  assert.equal(result.decision, 'forbidden', '.planning/state.md must be forbidden on a case-insensitive FS');
  assert.ok(DEFAULT.includes(result.matched));
});

test('a non-orchestrator write to an upper-cased shared path (STATE.MD) is forbidden (case-insensitive FS)', () => {
  const result = evaluateSharedWrite({ actor: 'executor', targetPath: '.planning/STATE.MD', sharedPaths: DEFAULT });
  assert.equal(result.decision, 'forbidden', '.planning/STATE.MD must be forbidden on a case-insensitive FS');
  assert.ok(DEFAULT.includes(result.matched));
});

// --- allowed: orchestrator (sole writer) or a non-shared path ---------------

test('the orchestrator may write shared state (sole writer) -> allowed', () => {
  const result = evaluateSharedWrite({ actor: 'orchestrator', targetPath: '.planning/STATE.md', sharedPaths: DEFAULT });
  assert.equal(result.decision, 'allowed');
});

test('a non-orchestrator write to a NON-shared path -> allowed', () => {
  const result = evaluateSharedWrite({ actor: 'executor', targetPath: 'src/feature.ts', sharedPaths: DEFAULT });
  assert.equal(result.decision, 'allowed');
});

test('only the literal "orchestrator" actor is the sole writer; any other role is non-orchestrator', () => {
  // A role that is not exactly 'orchestrator' is treated as non-orchestrator (T-04-11).
  const result = evaluateSharedWrite({ actor: 'orchestrator-ish', targetPath: '.planning/STATE.md', sharedPaths: DEFAULT });
  assert.equal(result.decision, 'forbidden');
});
