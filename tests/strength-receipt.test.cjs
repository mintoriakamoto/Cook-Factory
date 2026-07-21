'use strict';

/**
 * STRONG-02 red-green tests for the strength.receipt / strength.verify-receipt
 * cores.
 *
 * A green-only test proves nothing (it may pass trivially). STRONG-02 requires a
 * CAPTURED failing run (non-zero exit + a log digest) before the fix commit — that
 * is what makes "the test actually tests the requirement" evidence, not assertion.
 *
 * Invariants under test:
 *   record: persists { requirement, test, failing_run:{exit_code,log_digest}, commit }
 *     keyed by requirement via atomic-state; a re-record supersedes (one entry);
 *     the store (with parent dir) is created on first write.
 *   verify: missing (no receipt) / never-red (exit 0, no digest, or no commit) /
 *     valid (non-zero exit + non-empty digest + commit). Fails CLOSED.
 *
 * The store targets a hermetic temp file under <tmp>/.planning/strength/receipts.json
 * via fs.mkdtempSync — no real project state is touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  recordReceipt,
  verifyReceipt,
} = require('../ferrox-core/bin/lib/strength-receipt.cjs');

// A well-formed VALID receipt built directly into a store file, so verify tests do
// not depend on record's write path (they exercise the read/validate guard).
function writeStore(statePath, receipts) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ receipts }, null, 2) + '\n');
}

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-strength-receipt-'));
  return path.join(dir, '.planning', 'strength', 'receipts.json');
}

function readStore(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- recordReceipt: persist via atomic-state (STRONG-02) ---------------------

test('recordReceipt persists a receipt keyed by requirement and creates the store', () => {
  const statePath = tmpStatePath();
  assert.equal(fs.existsSync(statePath), false, 'precondition: store absent');

  const rec = recordReceipt({
    statePath,
    requirement: 'STRONG-02',
    test: 'tests/foo.test.cjs',
    failing_run: { exit_code: 1, log_digest: 'sha256:deadbeef' },
    commit: 'abc1234',
  });

  assert.deepEqual(rec, {
    requirement: 'STRONG-02',
    test: 'tests/foo.test.cjs',
    failing_run: { exit_code: 1, log_digest: 'sha256:deadbeef' },
    commit: 'abc1234',
  }, 'returns the stored record');

  assert.equal(fs.existsSync(statePath), true, 'store created on first write');
  const store = readStore(statePath);
  assert.deepEqual(store.receipts['STRONG-02'], rec, 'receipt persisted under its requirement key');
});

test('a second recordReceipt for the same requirement supersedes (exactly one entry)', () => {
  const statePath = tmpStatePath();
  recordReceipt({
    statePath,
    requirement: 'STRONG-02',
    test: 'tests/old.test.cjs',
    failing_run: { exit_code: 1, log_digest: 'sha256:old' },
    commit: 'old1111',
  });
  const second = recordReceipt({
    statePath,
    requirement: 'STRONG-02',
    test: 'tests/new.test.cjs',
    failing_run: { exit_code: 2, log_digest: 'sha256:new' },
    commit: 'new2222',
  });

  const store = readStore(statePath);
  assert.equal(Object.keys(store.receipts).length, 1, 'exactly one entry for the requirement');
  assert.deepEqual(store.receipts['STRONG-02'], second, 'last red-green wins');
  assert.equal(store.receipts['STRONG-02'].commit, 'new2222');
});

test('recordReceipt keeps distinct requirements as separate entries', () => {
  const statePath = tmpStatePath();
  recordReceipt({ statePath, requirement: 'A-1', test: 't1', failing_run: { exit_code: 1, log_digest: 'd1' }, commit: 'c1' });
  recordReceipt({ statePath, requirement: 'B-2', test: 't2', failing_run: { exit_code: 1, log_digest: 'd2' }, commit: 'c2' });

  const store = readStore(statePath);
  assert.deepEqual(Object.keys(store.receipts).sort(), ['A-1', 'B-2']);
});

// --- verifyReceipt: missing / never-red / valid (STRONG-02) ------------------

test('verifyReceipt returns missing for an absent store', () => {
  const statePath = tmpStatePath();
  assert.equal(fs.existsSync(statePath), false, 'precondition: store absent');
  assert.deepEqual(verifyReceipt({ statePath, requirement: 'X-1' }), { decision: 'missing', requirement: 'X-1' });
});

test('verifyReceipt returns missing for a requirement with no entry', () => {
  const statePath = tmpStatePath();
  writeStore(statePath, { 'OTHER-1': { requirement: 'OTHER-1', test: 't', failing_run: { exit_code: 1, log_digest: 'd' }, commit: 'c' } });
  assert.deepEqual(verifyReceipt({ statePath, requirement: 'X-1' }), { decision: 'missing', requirement: 'X-1' });
});

test('verifyReceipt returns valid for a captured failing run + commit (round-trips record)', () => {
  const statePath = tmpStatePath();
  recordReceipt({ statePath, requirement: 'STRONG-02', test: 't', failing_run: { exit_code: 1, log_digest: 'sha256:x' }, commit: 'abc1234' });
  assert.deepEqual(verifyReceipt({ statePath, requirement: 'STRONG-02' }), { decision: 'valid', requirement: 'STRONG-02' });
});

test('verifyReceipt returns never-red when the captured run exited 0 (never failed)', () => {
  const statePath = tmpStatePath();
  writeStore(statePath, { 'R-1': { requirement: 'R-1', test: 't', failing_run: { exit_code: 0, log_digest: 'sha256:x' }, commit: 'abc1234' } });
  assert.deepEqual(verifyReceipt({ statePath, requirement: 'R-1' }), { decision: 'never-red', requirement: 'R-1' });
});

test('verifyReceipt returns never-red when the log_digest is empty/absent', () => {
  const statePath = tmpStatePath();
  writeStore(statePath, {
    'R-empty': { requirement: 'R-empty', test: 't', failing_run: { exit_code: 1, log_digest: '' }, commit: 'abc1234' },
    'R-absent': { requirement: 'R-absent', test: 't', failing_run: { exit_code: 1 }, commit: 'abc1234' },
  });
  assert.equal(verifyReceipt({ statePath, requirement: 'R-empty' }).decision, 'never-red');
  assert.equal(verifyReceipt({ statePath, requirement: 'R-absent' }).decision, 'never-red');
});

test('verifyReceipt returns never-red when the commit is empty/absent', () => {
  const statePath = tmpStatePath();
  writeStore(statePath, {
    'R-nc': { requirement: 'R-nc', test: 't', failing_run: { exit_code: 1, log_digest: 'sha256:x' }, commit: '' },
  });
  assert.equal(verifyReceipt({ statePath, requirement: 'R-nc' }).decision, 'never-red');
});

test('verifyReceipt fails closed on a malformed receipt (missing failing_run)', () => {
  const statePath = tmpStatePath();
  writeStore(statePath, { 'R-bad': { requirement: 'R-bad', test: 't', commit: 'abc1234' } });
  assert.equal(verifyReceipt({ statePath, requirement: 'R-bad' }).decision, 'never-red');
});

// --- Fix 5: commit-existence check (a fabricated commit is not valid) ---------

/** A real git repo with one commit; returns { dir, head }. */
function makeGitRepoWithCommit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-receipt-git-'));
  const git = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  return { dir, head };
}

test('verifyReceipt rejects a fabricated commit as fabricated-commit (Fix 5, in a git repo)', () => {
  const { dir } = makeGitRepoWithCommit();
  const statePath = tmpStatePath();
  writeStore(statePath, {
    'R-fake': { requirement: 'R-fake', test: 't', failing_run: { exit_code: 1, log_digest: 'sha256:x' }, commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
  });
  const r = verifyReceipt({ statePath, requirement: 'R-fake', repoDir: dir });
  assert.notEqual(r.decision, 'valid', 'a fabricated commit must not validate');
  assert.equal(r.decision, 'fabricated-commit');
});

test('verifyReceipt accepts a receipt whose commit is the real HEAD (Fix 5)', () => {
  const { dir, head } = makeGitRepoWithCommit();
  const statePath = tmpStatePath();
  writeStore(statePath, {
    'R-real': { requirement: 'R-real', test: 't', failing_run: { exit_code: 1, log_digest: 'sha256:x' }, commit: head },
  });
  const r = verifyReceipt({ statePath, requirement: 'R-real', repoDir: dir });
  assert.equal(r.decision, 'valid', 'a receipt referencing a real commit validates');
});

test('verifyReceipt SKIPS the commit check when repoDir is not a git repo (hermetic default → valid)', () => {
  const statePath = tmpStatePath();
  writeStore(statePath, {
    'R-nc': { requirement: 'R-nc', test: 't', failing_run: { exit_code: 1, log_digest: 'sha256:x' }, commit: 'deadbeef' },
  });
  // No repoDir at all → check skipped.
  assert.equal(verifyReceipt({ statePath, requirement: 'R-nc' }).decision, 'valid');
  // A repoDir that is not a git repo → check skipped (unknown), still valid.
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-receipt-nonrepo-'));
  assert.equal(verifyReceipt({ statePath, requirement: 'R-nc', repoDir: notRepo }).decision, 'valid');
});
