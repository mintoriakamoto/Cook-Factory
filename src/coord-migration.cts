/**
 * COORD-04 coord-migration core (allocMigration + checkMigration).
 *
 * The orchestrator-only monotonic migration/sequence allocator, backed by a
 * CENTRAL store, plus the guard that rejects any number a worktree self-assigned.
 * Migration numbers must be handed out by one central authority — never chosen
 * inside a worktree — so a self-assigned number is rejected simply because it is
 * absent from the central `allocated` set.
 *
 * allocMigration runs its whole read-modify-write inside
 * atomicState.updateJsonFileAtomic: the store is read fresh INSIDE an exclusive
 * O_EXCL file lock and written atomically (temp + rename). This is the FF-B12
 * atomic primitive applied to shared coord state, so two interleaved allocators
 * cannot both read the same `next` and mint a duplicate (lost-update, T-04-08).
 *
 * The central store is `.planning/coord/migration-seq.json` in production; the
 * core takes `statePath` EXPLICITLY (the Plan 05 router resolves cwd -> that
 * path) so every test is deterministic. No Date.now, no hidden git.
 *
 * ADR-457 build-at-publish: this TS source compiles to the gitignored artifact
 * ferrox-core/bin/lib/coord-migration.cjs. `export =` CJS shape; no stdout.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import atomicState = require('./atomic-state.cjs');

/** The central migration store: the next number to hand out + every allocated. */
interface MigrationStore {
  /** The next number allocMigration will return (defaults to 1). */
  next: number;
  /** Every centrally-allocated number, in allocation order. */
  allocated: number[];
  /** FF-B15: every number that has been consumed (validated once), in order. */
  consumed: number[];
}

/** A checkMigration decision. */
interface CheckMigrationResult {
  /** 'valid' iff the number is in the central allocated set, else rejected. */
  decision: 'valid' | 'rejected-uncentral';
}

/** FF-B15 consumeMigration decision. */
interface ConsumeMigrationResult {
  /**
   * 'consumed' on the first valid consumption; 'rejected-replay' for an already
   * consumed number; 'rejected-uncentral' for a never-allocated number.
   */
  decision: 'consumed' | 'rejected-replay' | 'rejected-uncentral';
}

/**
 * Coerce arbitrary parsed JSON into a well-formed MigrationStore. A missing /
 * blank / malformed store (or one missing either field) collapses to the safe
 * default { next: 1, allocated: [] } — so a corrupt file can never let a
 * self-assigned number look centrally allocated.
 */
function normalizeStore(raw: unknown): MigrationStore {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? (raw as Record<string, unknown>) : {};
  const next = typeof obj.next === 'number' && Number.isFinite(obj.next) ? obj.next : 1;
  const allocated = Array.isArray(obj.allocated)
    ? obj.allocated.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  // FF-B15: a corrupt/absent store yields an empty consumed set (nothing consumed).
  const consumed = Array.isArray(obj.consumed)
    ? obj.consumed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  return { next, allocated, consumed };
}

/**
 * Allocate the next migration number from the central store under the
 * atomic-state lock. Reads the current store fresh inside the lock, returns
 * `current = next`, advances `next` to `current + 1`, appends `current` to
 * `allocated`, and writes the mutated store atomically. Returns `current`.
 */
function allocMigration(opts: { statePath: string }): number {
  return atomicState.updateJsonFileAtomic<number>(
    opts.statePath,
    (currentRaw: unknown) => {
      const store = normalizeStore(currentRaw);
      const current = store.next;
      const nextStore: MigrationStore = {
        next: current + 1,
        allocated: [...store.allocated, current],
        // FF-B15: preserve the consumed set across an allocation (do not wipe it).
        consumed: [...store.consumed],
      };
      return { next: nextStore, changed: true, result: current };
    },
  );
}

/**
 * Guard a migration number against the central store. A read-only check: reads
 * the SAME central store allocMigration writes (a missing/blank store yields an
 * empty allocated set) and returns 'valid' iff the number is a member of the
 * allocated set, else 'rejected-uncentral' (a self-assigned / never-allocated
 * number, T-04-07).
 */
function checkMigration(opts: { statePath: string; number: number }): CheckMigrationResult {
  const store = normalizeStore(atomicState.readJsonOrEmpty(opts.statePath));
  return {
    decision: store.allocated.includes(opts.number) ? 'valid' : 'rejected-uncentral',
  };
}

/**
 * FF-B15 consume-once guard. Runs its read-modify-write inside the atomic-state
 * lock. Inside the lock: if `number` is not in the central `allocated` set →
 * `rejected-uncentral` (no write); else if it is already in `consumed` →
 * `rejected-replay` (no write — a previously-allocated number no longer
 * validates); else append it to `consumed`, write atomically, and return
 * `consumed`. This ADDS consume-once semantics without touching COORD-04's
 * alloc/check behavior (a consumed number is still a member of `allocated`).
 */
function consumeMigration(opts: { statePath: string; number: number }): ConsumeMigrationResult {
  return atomicState.updateJsonFileAtomic<ConsumeMigrationResult>(
    opts.statePath,
    (currentRaw: unknown) => {
      const store = normalizeStore(currentRaw);
      if (!store.allocated.includes(opts.number)) {
        return { next: store, changed: false, result: { decision: 'rejected-uncentral' } };
      }
      if (store.consumed.includes(opts.number)) {
        return { next: store, changed: false, result: { decision: 'rejected-replay' } };
      }
      const nextStore: MigrationStore = {
        next: store.next,
        allocated: [...store.allocated],
        consumed: [...store.consumed, opts.number],
      };
      return { next: nextStore, changed: true, result: { decision: 'consumed' } };
    },
  );
}

export = { allocMigration, checkMigration, consumeMigration, normalizeStore };
