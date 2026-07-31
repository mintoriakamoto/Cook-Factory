'use strict';

/**
 * fence-probe.cjs — a pure OBSERVER for the phase 16 atomic-state claim primitive.
 *
 * It asserts nothing of its own accord. It runs 1 mode against 1 library, prints exactly 1 line
 * of JSON describing what happened, and compares that line against an expectation only when one
 * is supplied with --expect. That split is deliberate: the same probe reads the frozen pre-fix
 * copy in tests/fixtures/atomic-state/atomic-state-before-fix.cjs and the shipped lib at
 * ferrox-core/bin/lib/atomic-state.cjs, so every guard can be observed FAILING before it is
 * observed passing.
 *
 * No mode ever waits for a race. Every interleaving is FORCED by patching a property of the
 * node:fs module object at the exact syscall gap. That works because the emitted lib does
 * __importDefault(require("node:fs")) and looks every method up at call time, so the patched
 * function is the one that runs. The patch is process global, so EVERY invocation is 1 process
 * and 1 mode and the probe never loads both libraries.
 *
 * Flags:
 *   --lib <path>     required, resolved against the current working directory
 *   --mode <name>    required, 1 of the 8 modes below
 *   --dir <path>     optional scratch root, defaults to a fresh mkdtemp under os.tmpdir()
 *   --expect <json>  optional, every key in it is compared with strict equality
 *
 * Exit 0 on a match or with no expectation, 1 on a mismatch, 2 on a usage error.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODES = [
  'reap-race',
  'fence-defeat-reap',
  'release-steals',
  'slow-hold',
  'hold-ok',
  'fsync-count',
  'fsync-fatal',
  'fsync-dir-tolerated',
  'happy-path',
];

// runMain from scripts/lib/cli-exit.cjs passes NO argv to its main, so a script written that way
// reads nothing. This is a test fixture rather than a repository script in any case, so it reads
// process.argv directly with a small loop over --flag value pairs.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.slice(0, 2) === '--') {
      out[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/** Synchronous sleep with no hot CPU spin. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function countSuffixes(dir, suffixes) {
  return fs.readdirSync(dir).filter((name) => suffixes.some((s) => name.endsWith(s))).length;
}

function isHandle(h) {
  return h !== null && typeof h === 'object';
}

/** The acquisition token when the library exposes one, null when it does not. */
function tokenOf(h) {
  return isHandle(h) && typeof h.token === 'number' ? h.token : null;
}

const args = parseArgs(process.argv.slice(2));

function usage(message) {
  process.stderr.write('fence-probe: ' + message + '\n');
  process.exitCode = 2;
}

if (!args.lib) {
  usage('--lib <path> is required');
} else if (!args.mode) {
  usage('--mode <name> is required');
} else if (MODES.indexOf(args.mode) === -1) {
  usage('unknown mode ' + args.mode + ', expected 1 of ' + MODES.join(', '));
} else {
  run();
}

function run() {
  const libPath = path.resolve(args.lib);
  let root = os.tmpdir();
  if (args.dir) {
    fs.mkdirSync(args.dir, { recursive: true });
    root = args.dir;
  }
  // 1 unique scratch directory per invocation, so residue counts are scoped to this run even
  // when a caller hands the same scratch root to every mode.
  const dir = fs.mkdtempSync(path.join(root, 'fence-probe-'));
  const lib = require(libPath);

  const target = path.join(dir, 'state.json');
  const lockPath = target + '.lock';

  function release(handle) {
    try {
      if (isHandle(handle)) lib.releaseLock(handle);
      else lib.releaseLock(lockPath, handle);
    } catch {
      // a release that throws is itself an observation the release modes make explicitly
    }
  }

  /**
   * Attempt 1 fenced write. Returns the string ok on success, the thrown error's code property
   * when it has one, or THREW_NO_CODE when the throw carries none.
   */
  function writeWith(data, handle) {
    try {
      lib.atomicWriteFileSync(target, data, handle);
      return 'ok';
    } catch (err) {
      const code = err && typeof err.code === 'string' ? err.code : '';
      return code === '' ? 'THREW_NO_CODE' : code;
    }
  }

  /**
   * Force the FF-B27 double hold. Waiter C's acquisition runs with fs.statSync patched so that
   * C's FIRST stat on the lock path captures the real stale stat, runs waiter B's ENTIRE
   * acquireLock synchronously inside the patch, and then hands C the captured stale stat.
   *
   * When defeatSecondStat is false this is the realistic interleaving: C's second stat, the one
   * a hardened reaper takes immediately before detaching, sees the REAL current file, which is
   * B's fresh lockfile.
   *
   * When defeatSecondStat is true the second stat also returns the captured stale stat. That
   * simulates the residual window no reap-by-path hardening can close: the gap between the
   * confirming stat and the detach itself, in which another acquirer may recreate the file at
   * the same path. It exists so the fence is exercised even though the reap hardening closes
   * the realistic case earlier, because an unexercised guard is exactly the failure this phase
   * must not repeat.
   */
  function forceDoubleHold(defeatSecondStat) {
    fs.mkdirSync(dir, { recursive: true });
    // A crashed holder whose stamp is deliberately unparseable, backdated 60 seconds so it is
    // genuinely stale against a staleMs of 1000.
    fs.writeFileSync(lockPath, 'held-by-a-crashed-holder');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, past, past);

    const opts = { retries: 50, retryDelayMs: 1, staleMs: 1000 };
    const realStat = fs.statSync;
    let passThrough = false;
    let outer = 0;
    let staleStat = null;
    let bHandle = null;
    let bAcquired = false;

    fs.statSync = function patchedStatSync(p, ...rest) {
      if (passThrough || String(p) !== lockPath) return realStat.call(fs, p, ...rest);
      outer += 1;
      if (outer === 1) {
        staleStat = realStat.call(fs, p, ...rest);
        passThrough = true;
        try {
          bHandle = lib.acquireLock(lockPath, opts);
          bAcquired = true;
        } catch {
          bAcquired = false;
        }
        passThrough = false;
        return staleStat;
      }
      if (outer === 2 && defeatSecondStat) return staleStat;
      return realStat.call(fs, p, ...rest);
    };

    let cHandle = null;
    let cAcquired = false;
    try {
      cHandle = lib.acquireLock(lockPath, opts);
      cAcquired = true;
    } catch {
      cAcquired = false;
    }
    fs.statSync = realStat;

    return { bHandle, bAcquired, cHandle, cAcquired };
  }

  function doubleHoldObservation(defeatSecondStat) {
    const h = forceDoubleHold(defeatSecondStat);
    const bWrite = h.bAcquired ? writeWith('B', h.bHandle) : 'skipped';
    const cWrite = h.cAcquired ? writeWith('C', h.cHandle) : 'skipped';
    let writers = 0;
    if (bWrite === 'ok') writers += 1;
    if (cWrite === 'ok') writers += 1;
    return {
      b_acquired: h.bAcquired,
      c_acquired: h.cAcquired,
      b_token: tokenOf(h.bHandle),
      c_token: tokenOf(h.cHandle),
      b_write: bWrite,
      c_write: cWrite,
      writers,
    };
  }

  function releaseStealsObservation() {
    const h = forceDoubleHold(true);
    // Ownership is defined as byte identity rather than as a parsed field, so this single mode
    // reads both libraries: the pre-fix lockfile carries only a bare process id.
    const owned = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null;
    if (h.bAcquired) release(h.bHandle);
    const exists = fs.existsSync(lockPath);
    const after = exists ? fs.readFileSync(lockPath) : null;
    return {
      b_acquired: h.bAcquired,
      c_acquired: h.cAcquired,
      lock_exists_after_b_release: exists,
      c_still_owns: exists && owned !== null && after.equals(owned),
    };
  }

  function holdObservation(staleMs, sleepMs, reap) {
    fs.mkdirSync(dir, { recursive: true });
    const opts = { retries: 50, retryDelayMs: 1, staleMs };
    let holder = null;
    let holderAcquired = false;
    try {
      holder = lib.acquireLock(lockPath, opts);
      holderAcquired = true;
    } catch {
      holderAcquired = false;
    }
    sleepSync(sleepMs);

    let reaper = null;
    let reaperAcquired = false;
    if (reap) {
      try {
        reaper = lib.acquireLock(lockPath, opts);
        reaperAcquired = true;
      } catch {
        reaperAcquired = false;
      }
    }

    const holderWrite = holderAcquired ? writeWith('holder', holder) : 'skipped';
    if (!reap) return { holder_write: holderWrite };

    const reaperWrite = reaperAcquired ? writeWith('reaper', reaper) : 'skipped';
    let writers = 0;
    if (holderWrite === 'ok') writers += 1;
    if (reaperWrite === 'ok') writers += 1;
    return {
      holder_acquired: holderAcquired,
      reaper_acquired: reaperAcquired,
      holder_write: holderWrite,
      reaper_write: reaperWrite,
      writers,
    };
  }

  function patchFsync(handler) {
    const realFsync = fs.fsyncSync;
    const realFstat = fs.fstatSync;
    fs.fsyncSync = function patchedFsyncSync(fd) {
      let isDirectory = false;
      try {
        isDirectory = realFstat.call(fs, fd).isDirectory();
      } catch {
        isDirectory = false;
      }
      return handler(fd, isDirectory, () => realFsync.call(fs, fd));
    };
    return () => { fs.fsyncSync = realFsync; };
  }

  function fsyncCountObservation() {
    fs.mkdirSync(dir, { recursive: true });
    let total = 0;
    let onFile = 0;
    let onDirectory = 0;
    const restore = patchFsync((fd, isDirectory, delegate) => {
      total += 1;
      if (isDirectory) onDirectory += 1;
      else onFile += 1;
      return delegate();
    });
    try {
      lib.atomicWriteFileSync(target, 'payload\n');
    } finally {
      restore();
    }
    return { total, on_file: onFile, on_directory: onDirectory };
  }

  function fsyncFatalObservation() {
    fs.mkdirSync(dir, { recursive: true });
    const restore = patchFsync((fd, isDirectory, delegate) => {
      if (isDirectory) return delegate();
      const err = new Error('injected file sync failure');
      err.code = 'EIO';
      throw err;
    });
    let threw = false;
    let code = null;
    try {
      lib.atomicWriteFileSync(target, 'payload\n');
    } catch (err) {
      threw = true;
      code = err && typeof err.code === 'string' ? err.code : null;
    } finally {
      restore();
    }
    return {
      threw,
      code,
      tmp_residue: countSuffixes(dir, ['.tmp']),
      target_exists: fs.existsSync(target),
    };
  }

  function fsyncDirToleratedObservation() {
    fs.mkdirSync(dir, { recursive: true });
    // dir_sync_attempts is what makes this mode DISCRIMINATE. Without it the
    // reading is identical on a library that tolerates the rejection and on one
    // that never syncs a directory at all, because both end with no throw,
    // correct content and no residue. Counting the injections separates them.
    let dirSyncAttempts = 0;
    const restore = patchFsync((fd, isDirectory, delegate) => {
      if (!isDirectory) return delegate();
      dirSyncAttempts += 1;
      const err = new Error('injected directory sync rejection');
      err.code = 'EINVAL';
      throw err;
    });
    let threw = false;
    try {
      lib.atomicWriteFileSync(target, 'payload\n');
    } catch {
      threw = true;
    } finally {
      restore();
    }
    let contentOk = false;
    try {
      contentOk = fs.readFileSync(target, 'utf8') === 'payload\n';
    } catch {
      contentOk = false;
    }
    return {
      threw,
      content_ok: contentOk,
      tmp_residue: countSuffixes(dir, ['.tmp']),
      dir_sync_attempts: dirSyncAttempts,
    };
  }

  function happyPathObservation() {
    fs.mkdirSync(dir, { recursive: true });
    let threw = false;
    let result = null;
    try {
      result = lib.updateJsonFileAtomic(target, (cur) => {
        const n = cur && typeof cur === 'object' && typeof cur.n === 'number' ? cur.n : 0;
        return { next: { n: n + 1 }, result: n + 1, changed: true };
      });
    } catch {
      threw = true;
    }
    let contentOk = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      contentOk = parsed.n === 1;
    } catch {
      contentOk = false;
    }
    return {
      threw,
      result_ok: result === 1,
      content_ok: contentOk,
      residue: countSuffixes(dir, ['.tmp', '.lock']),
    };
  }

  let observation;
  switch (args.mode) {
    case 'reap-race': observation = doubleHoldObservation(false); break;
    case 'fence-defeat-reap': observation = doubleHoldObservation(true); break;
    case 'release-steals': observation = releaseStealsObservation(); break;
    case 'slow-hold': observation = holdObservation(50, 150, true); break;
    case 'hold-ok': observation = holdObservation(1000, 50, false); break;
    case 'fsync-count': observation = fsyncCountObservation(); break;
    case 'fsync-fatal': observation = fsyncFatalObservation(); break;
    case 'fsync-dir-tolerated': observation = fsyncDirToleratedObservation(); break;
    default: observation = happyPathObservation(); break;
  }

  const line = JSON.stringify(observation);
  if (args.expect === undefined) {
    process.stdout.write(line + '\n');
    return;
  }
  const expected = JSON.parse(args.expect);
  const mismatched = Object.keys(expected).filter((k) => observation[k] !== expected[k]);
  if (mismatched.length > 0) {
    process.stdout.write('MISMATCH ' + JSON.stringify(expected) + ' ' + line + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(line + '\n');
}
