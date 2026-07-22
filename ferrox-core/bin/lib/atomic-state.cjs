"use strict";
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
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/atomic-state.cjs. `export =` CJS shape; no stdout.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// W-1 / DEFECT.WINDOWS-FS-OPS: renameSync can transiently fail on Windows when
// an AV scanner / file indexer / concurrent reader briefly holds the target
// (EPERM/EBUSY/EACCES). Retry a few times with a short backoff before giving up.
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 5;
const RENAME_RETRY_BACKOFF_MS = 25;
/** Synchronous sleep without a hot CPU spin (Atomics.wait on a throwaway SAB). */
function _sleepSync(ms) {
    if (ms <= 0)
        return;
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
    catch {
        // SharedArrayBuffer/Atomics unavailable — fall back to a bounded busy wait.
        const end = Date.now() + ms;
        while (Date.now() < end) { /* spin */ }
    }
}
/**
 * Acquire an exclusive lock by atomically creating `lockPath` (O_EXCL). Returns
 * the open fd (held until release). On contention it retries up to `retries`
 * times, reaping a stale lock (holder mtime older than `staleMs`) so a crashed
 * holder can never deadlock the line forever. Throws if the lock can't be taken
 * within the retry budget — a fired trigger must never silently continue.
 */
function acquireLock(lockPath, opts = {}) {
    const retries = opts.retries ?? 100_000;
    const retryDelayMs = opts.retryDelayMs ?? 2;
    const staleMs = opts.staleMs ?? 30_000;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // 'wx' == O_CREAT | O_EXCL | O_WRONLY — atomic create-if-absent.
            const fd = node_fs_1.default.openSync(lockPath, 'wx');
            try {
                node_fs_1.default.writeSync(fd, String(process.pid));
            }
            catch { /* pid stamp best-effort */ }
            return fd;
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            // Reap a stale lock left by a crashed holder. Reap via rename-then-verify
            // rather than a bare rmSync: between our stat and an unlink, another
            // contender may have reaped the stale lock AND re-created a FRESH one at
            // the same path — a bare unlink would delete the successor's live lock
            // and let two holders in (the same delete-a-successor race
            // capability-lock.cts re-confirms (dev, ino) identity to prevent).
            // renameSync atomically claims exactly one inode, so we can verify the
            // staleness of what we actually captured before destroying it.
            try {
                const st = node_fs_1.default.statSync(lockPath);
                if (Date.now() - st.mtimeMs > staleMs) {
                    const reapPath = `${lockPath}.reap.${process.pid}.${Math.random().toString(36).slice(2)}`;
                    try {
                        // W-1: bounded retry on the transient Windows rename errnos (see
                        // RENAME_RETRY_ERRNOS above); any other failure (e.g. ENOENT —
                        // another contender reaped first) falls through to the outer catch.
                        for (let renameAttempt = 1;; renameAttempt++) {
                            try {
                                node_fs_1.default.renameSync(lockPath, reapPath);
                                break;
                            }
                            catch (renameErr) {
                                const code = renameErr.code ?? '';
                                if (renameAttempt < RENAME_MAX_ATTEMPTS && RENAME_RETRY_ERRNOS.has(code)) {
                                    _sleepSync(RENAME_RETRY_BACKOFF_MS);
                                    continue;
                                }
                                throw renameErr;
                            }
                        }
                        const rst = node_fs_1.default.statSync(reapPath);
                        if (Date.now() - rst.mtimeMs > staleMs) {
                            // Confirmed stale — reaped. Next iteration retries the create.
                            node_fs_1.default.rmSync(reapPath, { force: true });
                        }
                        else {
                            // We raced a successor and captured a FRESH lock: put it back
                            // (same inode, so the holder's release still removes it).
                            // linkSync fails EEXIST if yet another lock appeared meanwhile —
                            // then the path is owned again either way; just drop our ref.
                            try {
                                node_fs_1.default.linkSync(reapPath, lockPath);
                            }
                            catch { /* superseded */ }
                            node_fs_1.default.rmSync(reapPath, { force: true });
                        }
                    }
                    catch { /* another contender reaped it first — retry the create */ }
                    continue; // reap consumes one attempt of the retry budget
                }
            }
            catch {
                // Lock vanished between EEXIST and stat — loop and retry the create.
            }
            if (attempt >= retries) {
                throw new Error(`atomic-state: could not acquire lock ${lockPath} after ${retries} retries`);
            }
            _sleepSync(retryDelayMs);
        }
    }
    throw new Error(`atomic-state: could not acquire lock ${lockPath}`);
}
/** Release a previously acquired lock: close the fd and remove the lockfile. */
function releaseLock(lockPath, fd) {
    try {
        node_fs_1.default.closeSync(fd);
    }
    catch { /* already closed */ }
    try {
        node_fs_1.default.rmSync(lockPath, { force: true });
    }
    catch { /* already gone */ }
}
/**
 * Run `fn` while holding an exclusive lock on `${targetPath}.lock`. The lock is
 * always released (finally), even if `fn` throws.
 */
function withFileLock(targetPath, fn, opts) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(targetPath), { recursive: true });
    const lockPath = targetPath + '.lock';
    const fd = acquireLock(lockPath, opts);
    try {
        return fn();
    }
    finally {
        releaseLock(lockPath, fd);
    }
}
/**
 * Write `data` to `targetPath` atomically: temp file in the SAME directory (so
 * the rename stays on one filesystem) then `fs.renameSync` over the target.
 */
function atomicWriteFileSync(targetPath, data) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        node_fs_1.default.writeFileSync(tmp, data);
        // W-1: bounded retry on the transient Windows rename errnos (see above).
        let renameErr = null;
        for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
            try {
                node_fs_1.default.renameSync(tmp, targetPath);
                renameErr = null;
                break;
            }
            catch (err) {
                renameErr = err instanceof Error ? err : new Error(String(err));
                const code = err.code ?? '';
                if (attempt < RENAME_MAX_ATTEMPTS && RENAME_RETRY_ERRNOS.has(code)) {
                    _sleepSync(RENAME_RETRY_BACKOFF_MS);
                    continue;
                }
                break;
            }
        }
        if (renameErr !== null)
            throw renameErr;
    }
    catch (err) {
        try {
            node_fs_1.default.rmSync(tmp, { force: true });
        }
        catch { /* best-effort cleanup */ }
        throw err;
    }
}
/** Read a JSON file, returning `{}` for a missing or blank file (no throw on ENOENT). */
function readJsonOrEmpty(targetPath) {
    try {
        const raw = node_fs_1.default.readFileSync(targetPath, 'utf8').trim();
        return raw === '' ? {} : JSON.parse(raw);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return {};
        throw err;
    }
}
/**
 * Locked, atomic read-modify-write of a JSON state file. Acquires the lock,
 * reads current state (fresh, INSIDE the lock — this is what defeats the
 * TOCTOU), applies `mutate`, atomically writes the next state when
 * `changed !== false`, releases the lock, and returns `mutate`'s result.
 */
function updateJsonFileAtomic(targetPath, mutate, opts) {
    return withFileLock(targetPath, () => {
        const current = readJsonOrEmpty(targetPath);
        const { next, result, changed } = mutate(current);
        if (changed !== false) {
            atomicWriteFileSync(targetPath, JSON.stringify(next, null, 2) + '\n');
        }
        return result;
    }, opts);
}
module.exports = {
    acquireLock,
    releaseLock,
    withFileLock,
    atomicWriteFileSync,
    readJsonOrEmpty,
    updateJsonFileAtomic,
};
