/**
 * HALT-02 rescope.check core (D-02, D-04).
 *
 * The global per-increment rescope counter that kills the unbounded Stage-4 ->
 * Stage-1 cycle. It caps rescope at `halting.rescope.max_attempts` (default 2),
 * requires each accepted rescope to be STRICTLY SMALLER than the prior scope,
 * and returns `hard-descope-or-kill` on the attempt past the cap.
 *
 * Per D-04 the enforceable core is a REAL persisted state helper, not prose: the
 * attempt count lives in an injectable JSON state file keyed by increment id, so
 * the cap holds across separate verb invocations. The strictly-smaller check is
 * enforced against BOTH the passed prevSize and any stored lastSize, so even a
 * reset/forged count cannot re-grow a scope (T-03-06 defence in depth).
 *
 * Deterministic-time invariant: no Date.now. maxAttempts and nowIso arrive as
 * explicit inputs; the run-log `ts` is the caller's nowIso verbatim.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/rescope-check.cjs. `export =` CJS shape; no stdout.
 */

import fs from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import haltingLog = require('./halting-log.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import atomicState = require('./atomic-state.cjs');

/** Persisted per-increment rescope state. */
interface RescopeRecord {
  attempts: number;
  lastSize: number;
}

/** Whole state file: a map of increment id -> its rescope record. */
type RescopeState = Record<string, RescopeRecord>;

/** Inputs to a single rescope decision. */
interface RescopeInput {
  /** The increment whose rescope budget is being consumed. */
  increment: string;
  /** The scope size before this rescope (caller-supplied). */
  prevSize: number;
  /** The proposed new scope size — must be strictly smaller to be accepted. */
  newSize: number;
  /** Resolved halting.rescope.max_attempts budget (default 2). */
  maxAttempts: number;
  /** Caller-supplied ISO timestamp, recorded verbatim on a cap event. */
  nowIso: string;
}

/** Injectable file locations — both are explicit, never resolved from cwd here. */
interface RescopeOptions {
  statePath: string;
  logPath: string;
}

/** The rescope decision plus the (possibly unchanged) attempt count. */
interface RescopeResult {
  decision: 'rescope-allowed' | 'rejected-not-smaller' | 'hard-descope-or-kill';
  attempt: number;
  increment: string;
}

/** Read the state map; a missing/blank file yields an empty map (no throw). */
function readState(statePath: string): RescopeState {
  if (!fs.existsSync(statePath)) return {};
  const raw = fs.readFileSync(statePath, 'utf8').trim();
  if (raw === '') return {};
  return JSON.parse(raw) as RescopeState;
}

/**
 * Persist the state map atomically (temp file + rename) so a reader never sees a
 * half-written file. NOTE: this is NOT lock-guarded on its own — the whole
 * read-modify-write in runRescopeCheck runs under the atomic-state file lock;
 * this helper only guarantees the write itself is crash-safe.
 */
function writeState(statePath: string, state: RescopeState): void {
  atomicState.atomicWriteFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Evaluate (and, on acceptance, persist) one rescope attempt for an increment.
 *
 * MEDIUM-4: the ENTIRE read-modify-write runs inside an exclusive file lock via
 * updateJsonFileAtomic, so two concurrent invocations for the same increment can
 * no longer both read the same attempt count and lose one write (the TOCTOU
 * lost-update that could silently bypass the rescope cap). The state read now
 * happens INSIDE the lock, and the write is atomic (temp + rename).
 *
 * Order of decision — cap FIRST so the persisted counter is the authority:
 *   1. attempts >= maxAttempts -> hard-descope-or-kill; log one rescope-cap
 *      event; the counter is NOT incremented further (no write).
 *   2. newSize not strictly smaller than prevSize AND any stored lastSize ->
 *      rejected-not-smaller; counter untouched; nothing logged (no write).
 *   3. otherwise -> accept: increment the stored count, persist newSize as the
 *      new lastSize, return rescope-allowed with the new count.
 */
function runRescopeCheck(input: RescopeInput, opts: RescopeOptions): RescopeResult {
  const { increment, prevSize, newSize, maxAttempts, nowIso } = input;

  return atomicState.updateJsonFileAtomic<RescopeResult>(
    opts.statePath,
    (currentRaw: unknown) => {
      const state: RescopeState =
        (currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw))
          ? (currentRaw as RescopeState)
          : {};
      const record: RescopeRecord = state[increment] ?? { attempts: 0, lastSize: Infinity };
      const attempts = record.attempts;

      // 1. Cap reached: refuse further rescope. Nothing to write.
      if (attempts >= maxAttempts) {
        haltingLog.appendHaltingLog(
          {
            ts: nowIso,
            gate: 'rescope',
            trigger: 'rescope-cap',
            cap_outcome: 'hard-descope-or-kill',
            increment,
          },
          { path: opts.logPath },
        );
        return {
          next: state,
          changed: false,
          result: { decision: 'hard-descope-or-kill', attempt: maxAttempts, increment },
        };
      }

      // 2. Strictly-smaller invariant against BOTH prevSize and any stored lastSize.
      const smallerThanPrev = newSize < prevSize;
      const smallerThanStored = newSize < record.lastSize;
      if (!smallerThanPrev || !smallerThanStored) {
        return {
          next: state,
          changed: false,
          result: { decision: 'rejected-not-smaller', attempt: attempts, increment },
        };
      }

      // 3. Accept: bump the persisted global counter and lastSize (atomic write).
      const nextAttempts = attempts + 1;
      state[increment] = { attempts: nextAttempts, lastSize: newSize };
      return {
        next: state,
        changed: true,
        result: { decision: 'rescope-allowed', attempt: nextAttempts, increment },
      };
    },
  );
}

export = { runRescopeCheck, readState, writeState };
