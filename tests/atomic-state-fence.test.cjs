'use strict';

/**
 * Phase 16: the 3 properties the claim primitive must hold under contention.
 *
 *   1. EXCLUSIVITY SURVIVES A REAP. A holder whose lockfile was reaped and
 *      recreated by another acquirer can neither write over the live holder's
 *      state nor unlink the live holder's lockfile.
 *   2. A VISIBLE RENAME IMPLIES DURABLE BYTES. One completed atomic write
 *      fsyncs the temp file before the rename and the parent directory after it.
 *   3. THE LOCK IS SCOPED TO A CLAIM TRANSACTION. A holder that held past its
 *      hold budget is refused, because past that point any reaper is entitled to
 *      reap it.
 *
 * Every case is driven as a CHILD PROCESS through
 * tests/fixtures/atomic-state/fence-probe.cjs. That is not a style choice: the
 * probe patches properties of the node:fs module object to FORCE each
 * interleaving, the patch is process global, and 2 different libraries have to
 * be measured in the same run.
 *
 * Roughly half the rows below assert the defect is PRESENT in
 * tests/fixtures/atomic-state/atomic-state-before-fix.cjs, a frozen byte
 * identical copy of the built lib as it stood at commit 3a597f8. That is the
 * whole reason the copy is committed. Phase 15 produced 6 defects and every one
 * was a guard that could not fire; a concurrency guard is the easiest of all to
 * write in that shape, because a test that spawns 2 processes and happens not to
 * interleave passes trivially and forever. So each guard here is observed
 * FAILING before it is observed passing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'tests', 'fixtures', 'atomic-state', 'fence-probe.cjs');
/** The frozen pre-fix artifact. Every row driven against it asserts a DEFECT. */
const PRE_FIX_LIB = path.join(ROOT, 'tests', 'fixtures', 'atomic-state', 'atomic-state-before-fix.cjs');
/** The shipped built lib. Every row driven against it asserts the defect is gone. */
const BUILT_LIB = path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'atomic-state.cjs');

/** Commit the frozen copy was taken from, and its digest at that commit. */
const BASE_COMMIT = '3a597f8';
const PRE_FIX_SHA256 = '58af7bc7df82be4a6d2857c438570d90a5969279ac279e5ea7ab7696686a5182';

const SCRATCH_ROOTS = [];
function scratchRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-fence-'));
  SCRATCH_ROOTS.push(dir);
  return dir;
}
const SCRATCH = scratchRoot();

/**
 * Spawn 1 probe process for 1 mode against 1 library, returning the exit status
 * and the observation line without throwing. The probe compares every key of
 * `expect` with strict equality and exits 1 on any mismatch, so status 0 IS the
 * assertion and the observation line is what makes a failure readable.
 */
function probe(lib, mode, expect) {
  const args = [PROBE, '--lib', lib, '--mode', mode, '--dir', SCRATCH];
  if (expect !== undefined) args.push('--expect', JSON.stringify(expect));
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
    return { status: 0, out: out.trim() };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : -1,
      out: String(err.stdout === undefined || err.stdout === null ? '' : err.stdout).trim(),
    };
  }
}

// ─── the defect is PRESENT in the frozen pre-fix copy (6 rows) ───────────────

test('pre-fix: the forced double hold lets 2 holders both write', () => {
  const r = probe(PRE_FIX_LIB, 'fence-defeat-reap', {
    b_acquired: true, c_acquired: true, b_write: 'ok', c_write: 'ok', writers: 2,
  });
  assert.equal(r.status, 0, `the pre-fix reap has no identity check, so B and C both hold the lock and both writes return ok; a copy that has been repaired or rebuilt would report 1 writer here. Observed: ${r.out}`);
});

test('pre-fix: the realistic reap race also lets 2 holders both write', () => {
  const r = probe(PRE_FIX_LIB, 'reap-race', {
    b_acquired: true, c_acquired: true, b_write: 'ok', c_write: 'ok', writers: 2,
  });
  assert.equal(r.status, 0, `pre-fix the 2 reap modes are indistinguishable, because the reaper takes only 1 stat and there is no second stat to defeat. Observed: ${r.out}`);
});

test('pre-fix: the losing holder release deletes the winner lockfile', () => {
  const r = probe(PRE_FIX_LIB, 'release-steals', {
    lock_exists_after_b_release: false, c_still_owns: false,
  });
  assert.equal(r.status, 0, `the pre-fix release unlinks unconditionally, so a holder that already lost the lock deletes the LIVE holder's lockfile and manufactures a fresh double hold out of the recovery path. Observed: ${r.out}`);
});

test('pre-fix: a completed atomic write performs no sync at all', () => {
  const r = probe(PRE_FIX_LIB, 'fsync-count', { total: 0, on_file: 0, on_directory: 0 });
  assert.equal(r.status, 0, `the pre-fix write is writeFileSync then renameSync with no sync of either, so the rename can be visible while the data is not durable. A naive reading of 1 here would mean the frozen copy had been rebuilt. Observed: ${r.out}`);
});

test('pre-fix: an injected file sync failure is not even noticed', () => {
  const r = probe(PRE_FIX_LIB, 'fsync-fatal', { threw: false, target_exists: true });
  assert.equal(r.status, 0, `the pre-fix lib never calls the function being made to throw, so it cannot notice the failure and reports a successful write. This is what makes the fixed lib's fatal arm a real check rather than a tautology. Observed: ${r.out}`);
});

test('pre-fix: a holder past the stale threshold and its reaper both write', () => {
  const r = probe(PRE_FIX_LIB, 'slow-hold', {
    holder_acquired: true, reaper_acquired: true, holder_write: 'ok', reaper_write: 'ok', writers: 2,
  });
  assert.equal(r.status, 0, `a live holder slower than staleMs is reaped out from under itself and keeps writing, because nothing checks how long the lock has been held. Observed: ${r.out}`);
});

// ─── the defect is ABSENT in the built lib (8 rows) ──────────────────────────

test('fixed: the fence refuses the stale holder write, so only 1 writer wins', () => {
  const r = probe(BUILT_LIB, 'fence-defeat-reap', {
    b_acquired: true, c_acquired: true, b_write: 'E_FENCE_LOST', c_write: 'ok', writers: 1,
  });
  assert.equal(r.status, 0, `the SAME forced interleaving that produced 2 winners on the frozen copy must now produce 1. B is the stale holder because C reaped B's lockfile, so B is the one that must fail; an implementation that fenced on the token alone would let B through, because both waiters read the same predecessor stamp and allocate the same successor. Observed: ${r.out}`);
});

test('fixed: the reaper refuses to detach a lockfile that changed under it', () => {
  const r = probe(BUILT_LIB, 'reap-race', {
    b_acquired: true, c_acquired: false, c_write: 'skipped', writers: 1,
  });
  assert.equal(r.status, 0, `the realistic interleaving is now stopped EARLIER, at the reaper: C re-stats immediately before detaching, sees a different inode, refuses, exhausts its retry budget and never acquires. An implementation with only the fence would report c_acquired true here. Observed: ${r.out}`);
});

test('fixed: the acquisition token is monotonic across a reap chain', () => {
  const r = probe(BUILT_LIB, 'fence-defeat-reap', { b_token: 1, c_token: 2 });
  assert.equal(r.status, 0, `B reaps the unparseable crashed-holder stamp and takes token 1; C reaps B's stamp, reads token 1 and takes 2, so 2 holders in 1 reap chain are totally ordered. An implementation that did not carry the reaped token forward would read 1 and 1. Observed: ${r.out}`);
});

test('fixed: the losing holder release leaves the winner lockfile byte identical', () => {
  const r = probe(BUILT_LIB, 'release-steals', {
    lock_exists_after_b_release: true, c_still_owns: true,
  });
  assert.equal(r.status, 0, `the unlink is conditional on the inode AND the nonce still matching, so a holder that lost the lock leaves the live holder's lockfile alone. Pre-fix this reads false and false; an implementation that fenced the write but forgot the unlink would too. Observed: ${r.out}`);
});

test('fixed: a completed atomic write syncs the file and the parent directory', () => {
  const r = probe(BUILT_LIB, 'fsync-count', { total: 2, on_file: 1, on_directory: 1 });
  assert.equal(r.status, 0, `counting only a total would be satisfied by syncing the same file twice, which is why the modes are classified by fstatSync(fd).isDirectory(). An implementation that synced the data but not the directory would read total 1 and on_directory 0. Observed: ${r.out}`);
});

test('fixed: a file sync failure aborts the write and leaves no temp residue', () => {
  const r = probe(BUILT_LIB, 'fsync-fatal', { threw: true, code: 'EIO', tmp_residue: 0, target_exists: false });
  assert.equal(r.status, 0, `a sync failure on the DATA means the bytes are not durable, so the write must not proceed to the rename and the existing catch must remove the temp file. An implementation that synced after the rename would report target_exists true. Observed: ${r.out}`);
});

test('fixed: a directory sync rejection is tolerated and the content is correct', () => {
  const r = probe(BUILT_LIB, 'fsync-dir-tolerated', {
    threw: false, content_ok: true, tmp_residue: 0, dir_sync_attempts: 1,
  });
  assert.equal(r.status, 0, `read together with the fatal row this proves the 2 arms carry DIFFERENT policies: the same injected failure is fatal on a file descriptor and tolerated on a directory one, for a declared errno allowlist rather than a blanket catch. dir_sync_attempts is what makes the row discriminate at all: a library that never syncs a directory also reports no throw, correct content and no residue, so without the count this row would stay green against the frozen pre-fix copy. An implementation with a bare swallow would pass this row and fail the fatal one. Observed: ${r.out}`);
});

test('fixed: a holder past its hold budget is refused with a distinct code', () => {
  const r = probe(BUILT_LIB, 'slow-hold', {
    reaper_acquired: true, holder_write: 'E_LOCK_HOLD_EXPIRED', reaper_write: 'ok', writers: 1,
  });
  assert.equal(r.status, 0, `the code is deterministic only because verifyFence checks the budget BEFORE the identity, and in this mode both have failed. An implementation that checked identity first would report E_FENCE_LOST and lose the distinction the hold budget exists to make. Observed: ${r.out}`);
});

// ─── positive controls: identical on BOTH libraries (2 rows) ─────────────────

test('both libs: a holder inside its budget still writes', () => {
  const pre = probe(PRE_FIX_LIB, 'hold-ok', { holder_write: 'ok' });
  const fixed = probe(BUILT_LIB, 'hold-ok', { holder_write: 'ok' });
  assert.equal(pre.status, 0, `the pre-fix baseline for this control. Observed: ${pre.out}`);
  assert.equal(fixed.status, 0, `without this row the hold-budget row above is satisfied by a lock that refuses EVERY write. A budget that discriminates must let a short hold through. Observed: ${fixed.out}`);
});

test('both libs: the happy path reads identically', () => {
  const expected = { threw: false, result_ok: true, content_ok: true, residue: 0 };
  const pre = probe(PRE_FIX_LIB, 'happy-path', expected);
  const fixed = probe(BUILT_LIB, 'happy-path', expected);
  assert.equal(pre.status, 0, `the pre-fix baseline, recorded so the identical post-fix reading means something. Observed: ${pre.out}`);
  assert.equal(fixed.status, 0, `this is the control that proves the phase did not simply disable the write path: a locked read, mutate and atomic write still returns the right value, lands the right content and leaves no lock or temp residue. Observed: ${fixed.out}`);
});

// ─── meta: the battery above is not vacuous (2 rows) ─────────────────────────

test('meta: a knowingly wrong expectation makes the probe exit non-zero', () => {
  const r = probe(BUILT_LIB, 'fsync-count', { total: 99 });
  assert.equal(r.status, 1, `without this row every --expect above could be passing because the comparison never runs, which is the failure that produced 2 of the 6 phase 15 defects. Observed: ${r.out}`);
  assert.ok(r.out.startsWith('MISMATCH'), `a mismatch must name itself, not just exit non-zero. Observed: ${r.out}`);
});

test('meta: the frozen pre-fix copy is byte identical to the base commit artifact', () => {
  const frozen = fs.readFileSync(PRE_FIX_LIB);
  assert.equal(
    crypto.createHash('sha256').update(frozen).digest('hex'),
    PRE_FIX_SHA256,
    `the frozen copy has drifted. It is a byte-pinned artifact, not source: regenerating, reformatting or rebuilding it silently deletes the proof that every guard in this file can fire. Restore it from ${BASE_COMMIT}:ferrox-core/bin/lib/atomic-state.cjs rather than repairing it.`,
  );
  // Strengthened against git when the base commit is reachable. A shallow clone
  // cannot reach it, and the digest above is the guard that always holds.
  let atBase = null;
  try {
    atBase = execFileSync('git', ['show', `${BASE_COMMIT}:ferrox-core/bin/lib/atomic-state.cjs`], {
      cwd: ROOT, maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    atBase = null;
  }
  if (atBase !== null) {
    assert.ok(atBase.equals(frozen), `the frozen copy differs from the artifact committed at ${BASE_COMMIT}`);
  }
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
