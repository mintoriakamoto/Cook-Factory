/**
 * Atomic on-disk state primitive (MEDIUM-4 fix).
 *
 * A generic, dependency-free helper for lost-update-safe JSON state files. Two
 * guarantees:
 *   1. Mutual exclusion — `withFileLock` wraps a critical section in a
 *      cross-process O_EXCL lockfile with bounded retry, so two interleaved
 *      read-modify-write cycles on the same file cannot both read a stale value
 *      and clobber each other (the TOCTOU lost-update in rescope-state and the
 *      human-SLA park writer).
 *   2. Crash-safe writes — `atomicWriteFileSync` writes to a unique temp file
 *      then `fs.renameSync`s it over the target (atomic on POSIX), so a reader
 *      never observes a half-written file and a crash mid-write can't truncate
 *      the state.
 *      Phase 16 (FF-B30) makes that claim stronger. The temp file is fsynced
 *      before the rename and the parent directory is fsynced after it, so a
 *      rename that is visible to a reader implies the bytes it names are durable
 *      on the medium rather than merely present in the page cache.
 *   3. Fenced writes (phase 16, FF-B27). Every acquisition carries a handle with
 *      the lockfile inode, a per-acquisition random nonce, and a token that is
 *      strictly greater than the token of any lock it reaped. `verifyFence` runs
 *      immediately before every rename and before every unlink, so a holder
 *      whose lockfile was reaped and recreated by another acquirer can neither
 *      write over the live holder's state nor delete the live holder's lockfile.
 *      A monotonic token alone is not enough: in the real race both waiters read
 *      the same predecessor stamp and allocate the same successor value, so the
 *      token orders a reap chain while the inode and the nonce are what
 *      establish identity.
 *
 * `updateJsonFileAtomic` composes both into a locked read → mutate → atomic
 * write cycle — the idiom the halting cap cores use.
 *
 * NOTE ON TIME: the stale-lock reaper reads wall-clock (`Date.now`) purely to
 * decide when a lockfile left by a crashed holder may be reclaimed. This is
 * infrastructure liveness, NOT a halting decision — the cap cores still receive
 * every decision timestamp as an explicit input (the deterministic-time
 * invariant is untouched).
 *
 * The phase 16 hold budget is a second read of that same clock and it is the
 * same kind of read: it decides only how long 1 holder may keep infrastructure
 * state locked before any reaper becomes entitled to take it. The cap cores
 * still receive every decision timestamp as an explicit input.
 *
 * WHY THE REAP HARDENING IS NOT SUFFICIENT ON ITS OWN: a reap by path can never
 * be atomic. Between the stat that confirms a lockfile is stale and the detach
 * that removes it, another acquirer may reap and recreate a file at that same
 * path, and the detach names a path rather than an inode. Re-reading the stat
 * immediately before the detach narrows that window from the whole retry loop
 * to 2 adjacent syscalls, which is what stops the realistic interleaving. The
 * fence closes what remains, by detecting the loss after the fact and refusing
 * the write and the unlink. Both are needed and neither replaces the other.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/atomic-state.cjs,
 * which is TRACKED rather than gitignored, so a rebuild must be committed.
 * `export =` CJS shape; no stdout.
 */

import fs from 'node:fs';
import path from 'node:path';
// randomBytes is a Node builtin, so the dependency-free property above is unchanged.
import { randomBytes } from 'node:crypto';

/** Tunables for lock acquisition. All optional with safe defaults. */
interface LockOptions {
  /** Max acquire retries before giving up (default 100000). */
  retries?: number;
  /** Synchronous spin delay between retries, ms (default 2). */
  retryDelayMs?: number;
  /** Reclaim a lockfile whose mtime is older than this, ms (default 30000). */
  staleMs?: number;
  /**
   * Longest a claim transaction may hold the lock before its write is refused,
   * ms. Defaults to half of `staleMs`, with a floor of 1. The half is not a
   * taste call: at `staleMs` exactly, any other acquirer is already entitled to
   * reap this lock, so a write attempted at that boundary is by definition a
   * stale holder's write. Half leaves room for the write itself to complete
   * inside the safe window. This is what scopes the lock to a claim transaction
   * by a mechanism rather than by advice: a caller who holds it across a long
   * operation gets a loud coded refusal instead of a silent race.
   */
  maxHoldMs?: number;
}

/** The 3 coded failures this module raises. Frozen: consumers branch on these. */
const ATOMIC_STATE_ERROR_CODES = Object.freeze({
  E_FENCE_LOST: 'E_FENCE_LOST',
  E_LOCK_HOLD_EXPIRED: 'E_LOCK_HOLD_EXPIRED',
  E_LOCK_UNAVAILABLE: 'E_LOCK_UNAVAILABLE',
});

/** What an acquisition hands back. The fence is checked against these fields. */
interface LockHandle {
  /** Open descriptor for the lockfile, held until release. */
  fd: number;
  /** Path of the lockfile this handle owns. */
  lockPath: string;
  /** Inode of the file this acquisition created. */
  ino: number;
  /** Per-acquisition random nonce. This is what establishes identity. */
  nonce: string;
  /** Strictly greater than the token of any lock this acquisition reaped. */
  token: number;
  /** Wall clock at acquisition, for the hold budget. */
  acquiredAtMs: number;
  /** Resolved hold budget for this acquisition, ms. */
  maxHoldMs: number;
}

/** What a lockfile stamp says. A foreign or unreadable stamp reads as token 0. */
interface LockStamp {
  pid: number | null;
  nonce: string | null;
  token: number;
}

const FOREIGN_STAMP: LockStamp = Object.freeze({ pid: null, nonce: null, token: 0 });

/** Attach a code to an Error so callers can branch without matching on prose. */
function _codedError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * Read a lockfile stamp. Anything absent, empty or unparseable reads as a
 * foreign holder with token 0 and no nonce, and this NEVER throws: a lockfile
 * written by an older build, or by a test simulating another holder, carries
 * arbitrary bytes and must not take the reaper down with it.
 */
function _readLockStamp(lockPath: string): LockStamp {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    if (raw === '') return FOREIGN_STAMP;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return FOREIGN_STAMP;
    const rec = parsed as Record<string, unknown>;
    const token = typeof rec.token === 'number' && Number.isFinite(rec.token) ? rec.token : 0;
    return {
      pid: typeof rec.pid === 'number' ? rec.pid : null,
      nonce: typeof rec.nonce === 'string' ? rec.nonce : null,
      token,
    };
  } catch {
    return FOREIGN_STAMP;
  }
}

/**
 * Detach a confirmed-stale lockfile by renaming it to a unique sibling and then
 * removing that sibling. A reaper that dies between the 2 steps leaves NO file
 * at the lock path, so the line still makes progress; the orphaned sibling ends
 * in `.reaped`, which is neither the temp suffix nor the lock suffix, so it can
 * never be mistaken for either by a residue check.
 *
 * `confirmed` is the stat the caller took immediately before calling, and it is
 * re-checked before every RETRY. W-1 / DEFECT.WINDOWS-FS-OPS: renameSync can
 * transiently fail on Windows when a scanner or a reader briefly holds the file,
 * so the detach needs the same bounded retry the atomic write uses. But every
 * backoff reopens the very window the caller's re-stat just closed, so a retry
 * that finds a different inode or mtime abandons the detach rather than removing
 * a lockfile that by then belongs to somebody else.
 */
function _detachLockFile(lockPath: string, confirmed: fs.Stats): void {
  const detached = `${lockPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.reaped`;
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      fs.renameSync(lockPath, detached);
      try { fs.rmSync(detached, { force: true }); } catch { /* best-effort cleanup */ }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt < RENAME_MAX_ATTEMPTS && RENAME_RETRY_ERRNOS.has(code)) {
        _sleepSync(RENAME_RETRY_BACKOFF_MS);
        let again: fs.Stats;
        try {
          again = fs.statSync(lockPath);
        } catch {
          return; // vanished under us
        }
        if (again.ino !== confirmed.ino || again.mtimeMs !== confirmed.mtimeMs) return;
        continue;
      }
      // Already gone, another reaper won the rename, or a hard error: in every
      // one of those cases there is nothing this call should remove.
      return;
    }
  }
}

/** Resolve the hold budget: explicit wins, else half of staleMs, floor of 1. */
function _resolveMaxHoldMs(opts: LockOptions, staleMs: number): number {
  return opts.maxHoldMs ?? Math.max(1, Math.floor(staleMs / 2));
}

// W-1 / DEFECT.WINDOWS-FS-OPS: renameSync can transiently fail on Windows when
// an AV scanner / file indexer / concurrent reader briefly holds the target
// (EPERM/EBUSY/EACCES). Retry a few times with a short backoff before giving up.
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_RETRY_BACKOFF_MS = 25;

// FF-B30: the 2 syncs have DIFFERENT failure policies and the difference is the
// point. A failure of the FILE sync is FATAL, because it means the bytes are not
// durable and the write must not proceed to the rename. A failure of the
// DIRECTORY sync is tolerated ONLY for the codes below, which are what a
// filesystem or a platform returns when it simply does not implement syncing a
// directory handle. Every other code propagates. This is a declared allowlist
// rather than a bare catch on purpose: a blanket swallow is a guard that cannot
// fire, and it would hide a real EIO on the medium behind a shrug.
const DIRECTORY_FSYNC_TOLERATED_ERRNOS = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);

/** Synchronous sleep without a hot CPU spin (Atomics.wait on a throwaway SAB). */
function _sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer/Atomics unavailable — fall back to a bounded busy wait.
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Acquire an exclusive lock by atomically creating `lockPath` (O_EXCL). Returns
 * a handle (held until release) carrying the descriptor, the inode, a random
 * nonce, the acquisition token and the acquisition time. On contention it
 * retries up to `retries` times, reaping a stale lock (holder mtime older than
 * `staleMs`) so a crashed holder can never deadlock the line forever. Throws if
 * the lock can't be taken within the retry budget, because a fired trigger must
 * never silently continue.
 *
 * The reap is hardened: the staleness stat is re-read immediately before the
 * detach and the detach is refused when the inode or the modification time
 * changed in between, because another acquirer may have reaped and recreated a
 * file at this same path. A refusal consumes a retry instead of reaping.
 */
function acquireLock(lockPath: string, opts: LockOptions = {}): LockHandle {
  const retries = opts.retries ?? 100_000;
  const retryDelayMs = opts.retryDelayMs ?? 2;
  const staleMs = opts.staleMs ?? 30_000;
  const maxHoldMs = _resolveMaxHoldMs(opts, staleMs);
  // Highest token seen in a lock this call reaped. The acquisition takes 1 more,
  // so 2 holders in 1 reap chain are totally ordered.
  let reapedToken = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let fd: number;
    try {
      // 'wx' == O_CREAT | O_EXCL | O_WRONLY — atomic create-if-absent.
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Reap a stale lock left by a crashed holder.
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          // Read the doomed holder's token BEFORE detaching, so this acquisition
          // can order itself strictly after it.
          const doomed = _readLockStamp(lockPath);
          const confirm = fs.statSync(lockPath);
          if (confirm.ino === st.ino && confirm.mtimeMs === st.mtimeMs) {
            _detachLockFile(lockPath, confirm);
            if (doomed.token > reapedToken) reapedToken = doomed.token;
            continue; // retry immediately after reaping (does not consume the budget)
          }
          // Identity changed under us: another acquirer already took this path.
          // Fall through to the retry rather than detaching a live lockfile.
        }
      } catch {
        // Lock vanished between EEXIST and stat — loop and retry the create.
      }
      if (attempt >= retries) {
        throw _codedError(
          ATOMIC_STATE_ERROR_CODES.E_LOCK_UNAVAILABLE,
          `atomic-state: could not acquire lock ${lockPath} after ${retries} retries`,
        );
      }
      _sleepSync(retryDelayMs);
      continue;
    }
    // Created it. Stamp the identity that the fence will check.
    const nonce = randomBytes(12).toString('hex');
    const token = reapedToken + 1;
    const ino = fs.fstatSync(fd).ino;
    const stamp: LockStamp = { pid: process.pid, nonce, token };
    try { fs.writeSync(fd, JSON.stringify(stamp) + '\n'); } catch { /* stamp best-effort */ }
    return { fd, lockPath, ino, nonce, token, acquiredAtMs: Date.now(), maxHoldMs };
  }
  throw _codedError(
    ATOMIC_STATE_ERROR_CODES.E_LOCK_UNAVAILABLE,
    `atomic-state: could not acquire lock ${lockPath}`,
  );
}

/**
 * Throw unless `handle` still owns its lockfile. Returns nothing on success.
 *
 * The check order is FIXED and load bearing: hold budget, then presence, then
 * inode, then nonce and token. In the runaway-hold case both the budget and the
 * identity have failed, and only a fixed order makes the emitted code
 * deterministic enough for a caller (or a test) to assert on.
 */
function verifyFence(handle: LockHandle, opts: LockOptions = {}): void {
  const maxHoldMs = opts.maxHoldMs ?? handle.maxHoldMs;
  const heldMs = Date.now() - handle.acquiredAtMs;
  if (heldMs >= maxHoldMs) {
    throw _codedError(
      ATOMIC_STATE_ERROR_CODES.E_LOCK_HOLD_EXPIRED,
      `atomic-state: lock ${handle.lockPath} held ${heldMs} ms, past its ${maxHoldMs} ms hold budget`,
    );
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(handle.lockPath);
  } catch {
    throw _codedError(
      ATOMIC_STATE_ERROR_CODES.E_FENCE_LOST,
      `atomic-state: lock ${handle.lockPath} is gone; this holder no longer owns it`,
    );
  }
  if (st.ino !== handle.ino) {
    throw _codedError(
      ATOMIC_STATE_ERROR_CODES.E_FENCE_LOST,
      `atomic-state: lock ${handle.lockPath} was reaped and recreated; this holder no longer owns it`,
    );
  }
  const stamp = _readLockStamp(handle.lockPath);
  if (stamp.nonce !== handle.nonce || stamp.token !== handle.token) {
    throw _codedError(
      ATOMIC_STATE_ERROR_CODES.E_FENCE_LOST,
      `atomic-state: lock ${handle.lockPath} carries another holder's stamp`,
    );
  }
}

/**
 * Release a previously acquired lock: always close the descriptor, and unlink
 * the lockfile ONLY when it still exists and its inode and nonce still match.
 * Never throws.
 *
 * The condition is the second half of FF-B27 and it is the half most likely to
 * be missed: an unconditional unlink by a holder that already lost the lock
 * deletes the LIVE holder's lockfile, which manufactures a fresh double hold out
 * of the recovery path itself.
 */
function releaseLock(handle: LockHandle): void {
  try { fs.closeSync(handle.fd); } catch { /* already closed */ }
  try {
    const st = fs.statSync(handle.lockPath);
    if (st.ino !== handle.ino) return;
    if (_readLockStamp(handle.lockPath).nonce !== handle.nonce) return;
    fs.rmSync(handle.lockPath, { force: true });
  } catch { /* already gone, or unreadable: a release never throws */ }
}

/**
 * Run `fn` while holding an exclusive lock on `${targetPath}.lock`. The lock is
 * always released (finally), even if `fn` throws.
 */
function withFileLock<T>(targetPath: string, fn: (handle: LockHandle) => T, opts?: LockOptions): T {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const lockPath = targetPath + '.lock';
  const handle = acquireLock(lockPath, opts);
  try {
    // The handle is passed to the callback so a fenced write can be threaded
    // through. An existing zero-argument callback is unaffected.
    return fn(handle);
  } finally {
    releaseLock(handle);
  }
}

/**
 * Write `data` through a descriptor and fsync it BEFORE the caller renames it
 * into place. This is the half of FF-B30 that makes a visible rename imply
 * durable bytes. `fs.writeFileSync` over a descriptor loops internally until the
 * whole payload has landed, so no partial-write loop is needed here. The close
 * is in a finally, so a throw between the write and the sync still releases the
 * descriptor.
 */
function _writeAndSyncFile(tmpPath: string, data: string): void {
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Fsync the directory that holds `targetPath`, AFTER a successful rename.
 * Without this the rename itself may be visible in the page cache and absent
 * from the medium, which is the other half of FF-B30.
 */
function _syncParentDirectory(targetPath: string): void {
  // Opening a directory descriptor is not permitted on Windows. This skip is a
  // platform FACT, not a tolerance, so it is an explicit platform check rather
  // than an errno that happens to sit on the allowlist.
  if (process.platform === 'win32') return;
  try {
    const dfd = fs.openSync(path.dirname(targetPath), 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      try { fs.closeSync(dfd); } catch { /* already closed */ }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (DIRECTORY_FSYNC_TOLERATED_ERRNOS.has(code)) return;
    // The rename already landed, so the data IS in place. Propagating anyway is
    // deliberate: an untolerated code here means the medium is in trouble and a
    // durability primitive must not report success it cannot vouch for.
    throw err;
  }
}

/**
 * Write `data` to `targetPath` atomically: temp file in the SAME directory (so
 * the rename stays on one filesystem) then `fs.renameSync` over the target.
 *
 * `fence` is OPTIONAL. With 2 arguments this behaves exactly as before. With a
 * lock handle as the third argument, `verifyFence` runs immediately before every
 * rename attempt, including every retry, so a holder that lost its lock cannot
 * clobber the live holder's state. A failed fence check leaves no temp file
 * behind, because it throws inside the try that cleans one up.
 */
function atomicWriteFileSync(targetPath: string, data: string, fence?: LockHandle): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    _writeAndSyncFile(tmp, data);
    // W-1: bounded retry on the transient Windows rename errnos (see above).
    let renameErr: Error | null = null;
    for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
      try {
        if (fence !== undefined) verifyFence(fence);
        fs.renameSync(tmp, targetPath);
        renameErr = null;
        break;
      } catch (err) {
        renameErr = err instanceof Error ? err : new Error(String(err));
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (attempt < RENAME_MAX_ATTEMPTS && RENAME_RETRY_ERRNOS.has(code)) {
          _sleepSync(RENAME_RETRY_BACKOFF_MS);
          continue;
        }
        break;
      }
    }
    if (renameErr !== null) throw renameErr;
    _syncParentDirectory(targetPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** Read a JSON file, returning `{}` for a missing or blank file (no throw on ENOENT). */
function readJsonOrEmpty(targetPath: string): unknown {
  try {
    const raw = fs.readFileSync(targetPath, 'utf8').trim();
    return raw === '' ? {} : JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

/** Result of a mutate step: the next state, a return value, and a dirty flag. */
interface MutateResult<T> {
  next: unknown;
  result: T;
  /** When false, skip the write (nothing changed). Defaults to true. */
  changed?: boolean;
}

/**
 * Locked, atomic read-modify-write of a JSON state file. Acquires the lock,
 * reads current state (fresh, INSIDE the lock — this is what defeats the
 * TOCTOU), applies `mutate`, atomically writes the next state when
 * `changed !== false`, releases the lock, and returns `mutate`'s result.
 */
function updateJsonFileAtomic<T>(
  targetPath: string,
  mutate: (current: unknown) => MutateResult<T>,
  opts?: LockOptions,
): T {
  return withFileLock(targetPath, (handle) => {
    const current = readJsonOrEmpty(targetPath);
    const { next, result, changed } = mutate(current);
    if (changed !== false) {
      atomicWriteFileSync(targetPath, JSON.stringify(next, null, 2) + '\n', handle);
    }
    return result;
  }, opts);
}

export = {
  acquireLock,
  releaseLock,
  verifyFence,
  withFileLock,
  atomicWriteFileSync,
  readJsonOrEmpty,
  updateJsonFileAtomic,
  ATOMIC_STATE_ERROR_CODES,
};
