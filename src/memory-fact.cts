/**
 * MEM-01 bi-temporal fact store core.
 *
 * The knowledge-graph primitive the whole Phase-7 memory seam stands on. Facts
 * carry `{subject, predicate, object, valid_from, valid_to|null, confidence,
 * recorded_at}`. Four operations: add, get-valid-at, history, invalidate. The
 * core invariant is SUPERSEDE-DON'T-DELETE: updating a fact sets the old one's
 * `valid_to` and adds a new one; the old fact is RETAINED, never overwritten or
 * removed.
 *
 * Validity windows are HALF-OPEN `[valid_from, valid_to)`: a fact is valid at
 * `ts` iff `valid_from <= ts && (valid_to === null || ts < valid_to)`. The
 * `valid_to` instant belongs to the SUCCESSOR, not the predecessor.
 *
 * Modeled on src/coord-migration.cts: every mutation runs its read-modify-write
 * inside atomicState.updateJsonFileAtomic (O_EXCL lock + atomic temp-rename), so
 * two interleaved add/invalidate cycles cannot lost-update the facts array. The
 * core takes `statePath` EXPLICITLY (the Plan 04 router resolves cwd +
 * memory.fact_store) and every timestamp is an EXPLICIT input — no Date.now in
 * any operation path, so every test is deterministic.
 *
 * ADR-457 build-at-publish: this TS source compiles to the gitignored artifact
 * ferrox-core/bin/lib/memory-fact.cjs. `export =` CJS shape; no stdout.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import atomicState = require('./atomic-state.cjs');

/** A single bi-temporal fact. */
interface Fact {
  subject: string;
  predicate: string;
  object: string;
  valid_from: number;
  valid_to: number | null;
  confidence: number;
  recorded_at: number;
}

/** The on-disk fact store shape. */
interface FactStore {
  facts: Fact[];
}

/** Type guard: a well-formed persisted Fact. */
function _isFact(x: unknown): x is Fact {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.subject === 'string' &&
    typeof f.predicate === 'string' &&
    typeof f.object === 'string' &&
    typeof f.valid_from === 'number' && Number.isFinite(f.valid_from) &&
    (f.valid_to === null || (typeof f.valid_to === 'number' && Number.isFinite(f.valid_to))) &&
    typeof f.confidence === 'number' && Number.isFinite(f.confidence) &&
    typeof f.recorded_at === 'number' && Number.isFinite(f.recorded_at)
  );
}

/**
 * Coerce arbitrary PARSED JSON into a well-formed FactStore. A parsed value that
 * is missing / blank / structurally malformed (not an object, or missing/`facts`
 * not an array) collapses to the safe default `{ facts: [] }`, filtering
 * non-object/malformed entries — so a corrupt file can never fabricate a valid
 * fact (T-07-07). NOTE: this operates on already-parsed input; syntactically
 * corrupt JSON (unparseable bytes) is handled by `readStoreForRead` on the READ
 * path (degrade to empty) and fails closed on the WRITE path — see below (M-1).
 */
function normalizeStore(raw: unknown): FactStore {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
  const facts = Array.isArray(obj.facts) ? (obj.facts as unknown[]).filter(_isFact) : [];
  return { facts };
}

/**
 * READ-path store load (M-1 fail-safe). Like `readJsonOrEmpty` but ALSO degrades
 * a SYNTACTICALLY corrupt store — bad JSON, git merge-conflict markers, a
 * truncated write — to the empty default instead of throwing. Reads must fail
 * SAFE: recall / get-valid-at / history over a corrupt store return empty (the
 * caller exits 0), never crash.
 *
 * WRITES deliberately do NOT use this. The mutation path
 * (`atomicState.updateJsonFileAtomic`) reads via `readJsonOrEmpty`, which throws
 * on unparseable JSON — so a write over a corrupt store FAILS CLOSED before any
 * atomic rename: the corrupt file is preserved (no silent clobber, no data loss),
 * and a human is signalled loudly rather than losing the store's history.
 */
function readStoreForRead(statePath: string): FactStore {
  let raw: unknown;
  try {
    raw = atomicState.readJsonOrEmpty(statePath);
  } catch {
    // ENOENT is already swallowed by readJsonOrEmpty; reaching here means the
    // file exists but is unparseable — degrade to empty for reads (M-1).
    raw = {};
  }
  return normalizeStore(raw);
}

/**
 * Append a new fact with `valid_to: null` (currently valid) under the atomic
 * lock. `confidence` defaults to 1. Returns the appended fact. MUTATION.
 */
function addFact(opts: {
  statePath: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: number;
  recordedAt: number;
  confidence?: number;
}): Fact {
  const fact: Fact = {
    subject: opts.subject,
    predicate: opts.predicate,
    object: opts.object,
    valid_from: opts.validFrom,
    valid_to: null,
    confidence: typeof opts.confidence === 'number' ? opts.confidence : 1,
    recorded_at: opts.recordedAt,
  };
  return atomicState.updateJsonFileAtomic<Fact>(
    opts.statePath,
    (currentRaw: unknown) => {
      const store = normalizeStore(currentRaw);
      const nextStore: FactStore = { facts: [...store.facts, fact] };
      return { next: nextStore, changed: true, result: fact };
    },
  );
}

/**
 * Read-only: return every fact valid at `ts` under the half-open window
 * `valid_from <= ts && (valid_to === null || ts < valid_to)`, optionally
 * filtered by subject. The `valid_to` instant belongs to the SUCCESSOR.
 */
function getValidAt(opts: { statePath: string; ts: number; subject?: string }): Fact[] {
  const store = readStoreForRead(opts.statePath);
  return store.facts.filter((f) => {
    if (opts.subject !== undefined && f.subject !== opts.subject) return false;
    return f.valid_from <= opts.ts && (f.valid_to === null || opts.ts < f.valid_to);
  });
}

/**
 * Read-only: return every fact for `subject` (both superseded and current),
 * sorted by `recorded_at` ascending (stable).
 */
function history(opts: { statePath: string; subject: string }): Fact[] {
  const store = readStoreForRead(opts.statePath);
  return store.facts
    .filter((f) => f.subject === opts.subject)
    .sort((a, b) => a.recorded_at - b.recorded_at);
}

/**
 * Supersede EVERY currently-valid fact matching subject+predicate (+object when
 * `matchObject` given): set each one's `valid_to = validTo`, leaving the records
 * otherwise intact (NEVER splices/deletes). Only facts with `valid_to === null`
 * are eligible — an already-superseded fact is untouched (no double-close).
 *
 * H-1a fix: this closes ALL open matches, not just the first. A store that (for
 * any reason — a legacy double-append, a crash-interrupted write) already holds
 * two open facts for one subject+predicate is fully reconciled to zero open in a
 * single atomic write, upholding the "at most one valid-now per subject+predicate"
 * invariant. Returns the LAST fact closed (or null if none matched). MUTATION.
 */
function invalidateFact(opts: {
  statePath: string;
  subject: string;
  predicate: string;
  validTo: number;
  matchObject?: string;
}): Fact | null {
  return atomicState.updateJsonFileAtomic<Fact | null>(
    opts.statePath,
    (currentRaw: unknown) => {
      const store = normalizeStore(currentRaw);
      let lastClosed: Fact | null = null;
      const facts = store.facts.map((f) => {
        if (
          f.valid_to === null &&
          f.subject === opts.subject &&
          f.predicate === opts.predicate &&
          (opts.matchObject === undefined || f.object === opts.matchObject)
        ) {
          // Retain the record; only set valid_to (supersede, never delete).
          const mutated: Fact = { ...f, valid_to: opts.validTo };
          lastClosed = mutated;
          return mutated;
        }
        return f;
      });
      if (lastClosed === null) {
        return { next: store, changed: false, result: null };
      }
      return { next: { facts }, changed: true, result: lastClosed };
    },
  );
}

/**
 * Atomically SUPERSEDE-AND-ADD in ONE locked read-modify-write: close every
 * currently-open (`valid_to === null`) fact matching subject+predicate by setting
 * `valid_to = validFrom`, THEN append the new fact (`valid_to: null`).
 *
 * This is the single-transaction primitive behind capture's supersede-by-default
 * (H-1b/H-1c): because the close and the append share one atomic write, a
 * concurrent reader never observes a transient empty recall, and two concurrent
 * captures can never both leave an open fact for the same subject+predicate.
 * Returns the appended fact. MUTATION.
 */
function supersedeAndAddFact(opts: {
  statePath: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: number;
  recordedAt: number;
  confidence?: number;
}): Fact {
  const fact: Fact = {
    subject: opts.subject,
    predicate: opts.predicate,
    object: opts.object,
    valid_from: opts.validFrom,
    valid_to: null,
    confidence: typeof opts.confidence === 'number' ? opts.confidence : 1,
    recorded_at: opts.recordedAt,
  };
  return atomicState.updateJsonFileAtomic<Fact>(
    opts.statePath,
    (currentRaw: unknown) => {
      const store = normalizeStore(currentRaw);
      const facts = store.facts.map((f) =>
        f.valid_to === null && f.subject === opts.subject && f.predicate === opts.predicate
          ? { ...f, valid_to: opts.validFrom }
          : f,
      );
      facts.push(fact);
      return { next: { facts }, changed: true, result: fact };
    },
  );
}

export = { addFact, getValidAt, history, invalidateFact, supersedeAndAddFact, normalizeStore };
