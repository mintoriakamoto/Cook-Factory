/**
 * STRONG-02 strength.receipt (record) + strength.verify-receipt (validate) core.
 *
 * A committed red-green receipt is the evidence that a test ACTUALLY tests its
 * requirement: before the fix commit, the mapped test was observed FAILING (a
 * non-zero exit code plus a captured log digest). A green-only test proves nothing
 * — it may pass trivially. This core records that evidence and validates it:
 *   - recordReceipt persists { requirement, test, failing_run:{ exit_code,
 *     log_digest }, commit } keyed by requirement, via the atomic-state lock.
 *   - verifyReceipt returns 'missing' (no receipt) / 'never-red' (the captured run
 *     was not a real failure) / 'valid' (captured failing run + commit). The
 *     merge-gate (Plan 06) treats anything but 'valid' as blocking.
 *
 * The receipt store path is taken EXPLICITLY (the Plan 07 router resolves
 * strength.receipt_store → that path) so every test is hermetic — mirrors
 * coord-migration.cts. Writes go through atomicState.updateJsonFileAtomic
 * (temp + rename under the O_EXCL lock), never a bare writeFileSync, so two
 * interleaved recorders cannot clobber each other. No Date.now.
 *
 * Commit-existence (Fix 5): verifyReceipt takes an OPTIONAL `repoDir`. When given
 * AND that dir is a git repo, an otherwise-valid receipt whose `commit` does not
 * resolve (`git cat-file -e <commit>^{commit}` fails) is rejected as
 * 'fabricated-commit' — a receipt cannot claim a commit that does not exist. When
 * `repoDir` is omitted, or is not a git repo (hermetic unit fixtures), the check is
 * SKIPPED (it cannot be verified), preserving existing pure-store tests.
 *
 * Fail CLOSED: any malformed / partial receipt resolves to never-red or missing,
 * never valid.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/strength-receipt.cjs. `export =` CJS shape; no stdout.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import atomicState = require('./atomic-state.cjs');
import { spawnSync } from 'node:child_process';

/** The captured failing run: a non-zero exit and a log digest are what make it real. */
interface FailingRun {
  exit_code: number;
  log_digest: string;
}

/** A single red-green receipt keyed by requirement in the store. */
interface Receipt {
  requirement: string;
  test: string;
  failing_run: FailingRun;
  commit: string;
}

/** The receipt store: receipts keyed by requirement id. */
interface ReceiptStore {
  receipts: Record<string, Receipt>;
}

/** A verify-receipt decision. */
interface VerifyReceiptResult {
  decision: 'missing' | 'never-red' | 'valid' | 'fabricated-commit';
  requirement: string;
}

/**
 * Does `commit` resolve to a real commit object in the git repo at `repoDir`?
 * Returns 'unknown' when `repoDir` is not given / not a git repo / git is
 * unavailable (the check cannot run and must not manufacture a failure); 'present'
 * or 'absent' otherwise. Uses `git cat-file -e <commit>^{commit}` so only a real
 * commit-ish (not an arbitrary blob/tree) counts.
 */
function commitExists(repoDir: string | undefined, commit: string): 'unknown' | 'present' | 'absent' {
  if (typeof repoDir !== 'string' || repoDir === '') return 'unknown';
  try {
    const inRepo = spawnSync('git', ['-C', repoDir, 'rev-parse', '--git-dir'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    if (inRepo.status !== 0) return 'unknown'; // not a repo → cannot verify
    const res = spawnSync('git', ['-C', repoDir, 'cat-file', '-e', `${commit}^{commit}`], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    if (res.error) return 'unknown'; // git spawn failed → cannot verify
    return res.status === 0 ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

/**
 * Coerce arbitrary parsed JSON into a well-formed ReceiptStore. A missing /
 * blank / malformed store (or one whose `receipts` is not a plain object)
 * collapses to the safe default { receipts: {} } — so a corrupt file can never
 * let a bogus receipt look valid.
 */
function normalizeStore(raw: unknown): ReceiptStore {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
  const receiptsRaw = obj.receipts;
  const receipts = (receiptsRaw && typeof receiptsRaw === 'object' && !Array.isArray(receiptsRaw))
    ? (receiptsRaw as Record<string, Receipt>)
    : {};
  return { receipts };
}

/**
 * Record a red-green receipt under the atomic-state lock. Reads the store fresh
 * INSIDE the lock, sets receipts[requirement] to the new receipt (last red-green
 * wins — a re-record supersedes), writes atomically, and returns the stored
 * record. The store (with parent dir) is created on first write by
 * updateJsonFileAtomic.
 */
function recordReceipt(opts: {
  statePath: string;
  requirement: string;
  test: string;
  failing_run: { exit_code: number; log_digest: string };
  commit: string;
}): Receipt {
  const receipt: Receipt = {
    requirement: opts.requirement,
    test: opts.test,
    failing_run: { exit_code: opts.failing_run.exit_code, log_digest: opts.failing_run.log_digest },
    commit: opts.commit,
  };
  return atomicState.updateJsonFileAtomic<Receipt>(
    opts.statePath,
    (currentRaw: unknown) => {
      const store = normalizeStore(currentRaw);
      const nextStore: ReceiptStore = {
        receipts: { ...store.receipts, [opts.requirement]: receipt },
      };
      return { next: nextStore, changed: true, result: receipt };
    },
  );
}

/**
 * Validate the receipt for a requirement. A read-only guard: reads the SAME store
 * recordReceipt writes (a missing/blank store yields an empty receipts map),
 * looks up receipts[requirement].
 *   - Absent → 'missing'.
 *   - Present but the captured run was not a real failure — exit_code not a finite
 *     non-zero number, OR log_digest empty/absent, OR commit empty/absent →
 *     'never-red'.
 *   - Only a finite non-zero exit_code + non-empty log_digest + non-empty commit
 *     → 'valid'.
 * Fails CLOSED: any partial/malformed receipt resolves to never-red, never valid.
 */
function verifyReceipt(opts: { statePath: string; requirement: string; repoDir?: string }): VerifyReceiptResult {
  const store = normalizeStore(atomicState.readJsonOrEmpty(opts.statePath));
  const receipt = store.receipts[opts.requirement];
  if (!receipt || typeof receipt !== 'object') {
    return { decision: 'missing', requirement: opts.requirement };
  }

  const run = receipt.failing_run;
  const exit = run && typeof run === 'object' ? run.exit_code : undefined;
  const digest = run && typeof run === 'object' ? run.log_digest : undefined;

  const exitIsRealFailure = typeof exit === 'number' && Number.isFinite(exit) && exit !== 0;
  const digestPresent = typeof digest === 'string' && digest.trim() !== '';
  const commitPresent = typeof receipt.commit === 'string' && receipt.commit.trim() !== '';

  const valid = exitIsRealFailure && digestPresent && commitPresent;
  if (!valid) {
    return { decision: 'never-red', requirement: opts.requirement };
  }

  // Fix 5: a red-green receipt that is otherwise valid must reference a REAL commit.
  // The check only runs when repoDir is a git repo (otherwise it is 'unknown' and
  // skipped — a fabricated commit only fails in a verifiable git context).
  if (commitExists(opts.repoDir, receipt.commit.trim()) === 'absent') {
    return { decision: 'fabricated-commit', requirement: opts.requirement };
  }
  return { decision: 'valid', requirement: opts.requirement };
}

export = { recordReceipt, verifyReceipt, normalizeStore };
