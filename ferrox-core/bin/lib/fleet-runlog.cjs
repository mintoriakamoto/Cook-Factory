"use strict";
/**
 * The fleet run record: event vocabulary, durable concurrent append, strict reader
 * (phase 19, D3 and D4).
 *
 * This module is the whole loop's shared language. Plans 02 through 05 append
 * through it and NONE of them opens `.planning/fleet-runlog.jsonl` directly,
 * which is what makes the append protocol a property of the system rather than a
 * property of 1 call site. The lease layer, the land queue and the fold all read
 * their kind names and required fields from the frozen tables below, so they
 * cannot disagree about what a claim, a queue entry or a worker end is.
 *
 * WHY THIS EXISTS: `.planning/MEASUREMENT-v1.14-PARALLELISM.md` established that
 * no phase in this repository has ever demonstrably executed in parallel except
 * phase 13, and the only reason phase 13 is knowable is that it left timestamps.
 * This module is the timestamps. Phase 22 Proof reads this artifact or it reads
 * nothing, so a figure this file cannot carry is a figure the milestone cannot
 * report. That is why the schema is fixed here, before the first writer exists.
 *
 * THE INHERITED GAP THIS CLOSES. `src/antiloop-log.cts:98` appends with a plain
 * `fs.appendFileSync`. That carries no concurrent writer protocol and no
 * durability guarantee, which was correct for 1 writer and is not correct for a
 * fleet. D4 names it explicitly and refuses to let it be assumed away. Here every
 * append runs inside `withFileLock` from `atomic-state.cjs` and syncs its
 * descriptor before releasing.
 *
 * TWO MECHANISMS, NOT TWO PIECES OF ADVICE:
 *
 *   1. MUTUAL EXCLUSION. The open, write, sync and close sequence runs inside
 *      `withFileLock`, the shipped primitive D2 names. This call site uses it
 *      exactly as phase 16 designed it: a short transaction well inside its hold
 *      budget, never stretched across work. On this platform an `O_APPEND` write
 *      to a regular file was measured NOT to tear even unlocked at 1 MiB with 8
 *      concurrent writers (see `tests/fleet-runlog-concurrent.test.cjs`), so the
 *      lock's load bearing job here is not kernel line atomicity. It is the
 *      mutual exclusion that plans 03 and 04 build their read decide write
 *      transactions on top of, and it is what makes the guarantee a property of
 *      the protocol rather than of an implementation detail that may change.
 *
 *   2. DURABILITY. The descriptor is `fsync`ed before it is closed, so a record
 *      whose append returned is on the medium and not merely in the page cache.
 *      A plain append call gives neither.
 *
 * A RECORD AT OR PAST `FLEET_MAX_RECORD_BYTES` IS REFUSED, NEVER WRITTEN. 4096 is
 * the POSIX atomic append bound. Past it a concurrent append is PERMITTED to
 * interleave, and a torn line in this file is unrecoverable evidence loss.
 * Bounding the record is a mechanism; hoping a small write happens to be atomic
 * is advice, and advice is what D7 exists to reject.
 *
 * TIME IS ALWAYS CALLER SUPPLIED, for the reason `src/antiloop-log.cts:23`
 * already gives: a module that reads the wall clock cannot be driven
 * deterministically by a mutation battery. Callers take their time from
 * `ferrox-core/bin/lib/clock.cjs` and pass it through as `ts`.
 *
 * THE READER THROWS ON A LINE IT CANNOT PARSE, following the deliberate departure
 * argued at `src/antiloop-log.cts:27-34`. This log IS the state. Every figure
 * phase 22 publishes is folded out of it, so a silently skipped line LOWERS a
 * derived count and quietly understates the milestone's own result. An
 * unparseable line names its 1-based line number and its path so the repair is
 * obvious.
 *
 * ADR-457 build-at-publish: this TS source compiles to the artifact
 * ferrox-core/bin/lib/fleet-runlog.cjs, which is TRACKED and committed (the
 * gitignore at `.gitignore:68` lists artifacts per file, so a NEW lib is tracked
 * by default). CJS module shape (`export =`) matches `src/antiloop-log.cts` and
 * `src/fleet-capability.cts`. The module owns NO stdout.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const atomicState = require("./atomic-state.cjs");
/**
 * The 16 event kinds. Frozen because plans 02 through 05 branch on these names
 * and a vocabulary that can be extended at a call site is not a vocabulary.
 *
 * The count moved from 14 to 16 in phase 20 plan 03, which is the sanctioned
 * path: the rule the freeze states is that the vocabulary may not be extended AT
 * A CALL SITE, and `node_parked` and `park_alarm` were added HERE, in the module
 * that owns the vocabulary, so every reader still learns the names from 1 place.
 */
const FLEET_EVENT_KINDS = Object.freeze([
    'run_started',
    'run_closed',
    'worker_started',
    'worker_ended',
    'claim_acquired',
    'lease_renewed',
    'lease_released',
    'lease_reclaimed',
    'queue_entered',
    'queue_acquired',
    'gate_started',
    'gate_ended',
    'land_completed',
    'post_land_truth',
    'node_parked',
    'park_alarm',
]);
/** The 3 keys every record carries, whatever its kind. */
const FLEET_COMMON_FIELDS = Object.freeze(['ts', 'kind', 'run_id']);
/**
 * What each kind adds on top of the common 3.
 *
 * `lease_epoch` is a monotonic integer per node. It survives renewal and advances
 * only on reclaim, which is the 1 field that tells a renewal apart from a reclaim
 * after a crash. Plan 03 owns that arithmetic; this module only insists the field
 * is present.
 *
 * `outcome` on `worker_ended` is 1 of `completed`, `failed`, `abnormal`. D3
 * requires an explicit end event INCLUDING on abnormal exit, so `abnormal` exists
 * to be written by a handler rather than inferred by a reader. A worker that dies
 * without one makes demonstrated width unknowable rather than approximate.
 *
 * `classification` on `post_land_truth` is 1 of `held`, `false_green`, `unknown`.
 * D3 states that a false green rate cannot be inferred from a green gate BY
 * DEFINITION, so post land truth is recorded in its own right and the fold never
 * derives it from a gate verdict.
 *
 * `scope` on `park_alarm` is 1 of `node`, `budget`. `route` on `park_alarm` is 1
 * of `synchronous`, `queued`. Phase 20 D7.5 requires the 2 alarm routes to be
 * distinguishable IN THE RUN RECORD or the criterion is unobservable, and a field
 * the reader branches on is the only shape that satisfies that.
 *
 * `parked_count` and `budget` are required on EVERY `park_alarm`, a `node` scoped
 * one included, so the record answers "how close was this run to its budget" at
 * every alarm rather than only at the last one. Populating them is free; needing
 * them later and not having them costs a re run.
 *
 * NEITHER PARK KIND CARRIES `attempt_id`, and that is load bearing rather than a
 * preference. A park is a statement about a NODE across all of its attempts, so
 * `attempts` carries the count instead. It also avoids a real breakage:
 * `src/fleet-runfold.cts:184` and `src/fleet-board.cts:271` DERIVE the set of
 * attempt bearing kinds from this exact field map, and a kind carrying both
 * `node_id` and `attempt_id` would join that set. Both kinds DO carry `node_id`,
 * so they join `NODE_KINDS` at `src/fleet-runfold.cts:198` and a run that parked
 * a node does not fold to a record in which that node never appears.
 */
const FLEET_EVENT_REQUIRED_FIELDS = Object.freeze({
    run_started: Object.freeze(['graph_generation']),
    run_closed: Object.freeze([]),
    worker_started: Object.freeze(['worker_id', 'node_id', 'attempt_id', 'lease_epoch']),
    worker_ended: Object.freeze(['worker_id', 'node_id', 'attempt_id', 'outcome']),
    claim_acquired: Object.freeze(['node_id', 'worker_id', 'lease_epoch']),
    lease_renewed: Object.freeze(['node_id', 'worker_id', 'lease_epoch']),
    lease_released: Object.freeze(['node_id', 'worker_id', 'lease_epoch']),
    lease_reclaimed: Object.freeze([
        'node_id', 'worker_id', 'lease_epoch', 'prior_worker_id', 'prior_lease_epoch', 'reason',
    ]),
    queue_entered: Object.freeze(['node_id', 'attempt_id', 'ticket']),
    queue_acquired: Object.freeze(['node_id', 'attempt_id', 'ticket', 'worker_id']),
    gate_started: Object.freeze(['node_id', 'attempt_id']),
    gate_ended: Object.freeze(['node_id', 'attempt_id', 'verdict']),
    land_completed: Object.freeze(['node_id', 'attempt_id', 'result']),
    post_land_truth: Object.freeze(['node_id', 'attempt_id', 'classification']),
    node_parked: Object.freeze(['node_id', 'reason', 'attempts', 'on_critical_path']),
    park_alarm: Object.freeze(['node_id', 'scope', 'route', 'parked_count', 'budget']),
});
/**
 * The POSIX atomic append bound. A serialized line (including its newline) at or
 * PAST this is refused rather than written. See the header: past the bound a
 * concurrent append is permitted to interleave.
 */
const FLEET_MAX_RECORD_BYTES = 4096;
/** The 4 coded refusals. Frozen: callers branch on a code, never on prose. */
const FLEET_RUNLOG_ERROR_CODES = Object.freeze({
    E_FLEET_UNKNOWN_KIND: 'E_FLEET_UNKNOWN_KIND',
    E_FLEET_MISSING_FIELD: 'E_FLEET_MISSING_FIELD',
    E_FLEET_RECORD_TOO_LARGE: 'E_FLEET_RECORD_TOO_LARGE',
    E_FLEET_LOG_UNPARSEABLE: 'E_FLEET_LOG_UNPARSEABLE',
});
/** The kind names, as a lookup set, built once from the frozen array. */
const _KIND_SET = new Set(FLEET_EVENT_KINDS);
/**
 * Attach a code to an Error so callers branch on a code rather than matching on
 * prose. Shape copied from `src/atomic-state.cts:119-123`.
 */
function _codedError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}
/**
 * Resolve the canonical run log path for a project:
 * <cwd>/.planning/fleet-runlog.jsonl.
 *
 * This is a CONVENIENCE for a caller that wants the canonical location. Neither
 * verb below calls it: `opts.path` is required on both, because a log written to
 * a path nobody asked for is evidence nobody will find.
 */
function fleetRunlogPath(cwd) {
    return node_path_1.default.join(cwd, '.planning', 'fleet-runlog.jsonl');
}
/** Every field name a record of this kind must carry, common 3 included. */
function _requiredFieldsFor(kind) {
    const extra = FLEET_EVENT_REQUIRED_FIELDS[kind] ?? [];
    return [...FLEET_COMMON_FIELDS, ...extra];
}
/**
 * Append exactly 1 JSONL record, durably, under mutual exclusion.
 *
 * Validation runs BEFORE anything is opened and NOTHING is written on any
 * refusal, in this fixed order:
 *   1. the kind is 1 of the 16                    -> E_FLEET_UNKNOWN_KIND
 *   2. every common and kind specific field is
 *      present and not undefined                  -> E_FLEET_MISSING_FIELD
 *   3. the serialized line plus its newline is
 *      under FLEET_MAX_RECORD_BYTES               -> E_FLEET_RECORD_TOO_LARGE
 *
 * The order is fixed so a record that is both an unknown kind and oversized
 * produces a deterministic code, which is what lets a test assert on it.
 *
 * The write itself: create the parent directory, then run open, write, sync and
 * close inside `withFileLock`. The descriptor is closed in a `finally` so a throw
 * between the write and the sync cannot leak it. The convenience append helper is
 * deliberately NOT used: it gives neither mutual exclusion nor durability, and
 * that is the inherited gap D4 names at `src/antiloop-log.cts:98`.
 */
function appendFleetEvent(entry, opts = {}) {
    const target = opts.path;
    if (typeof target !== 'string' || target === '') {
        throw new Error('appendFleetEvent: opts.path is required');
    }
    const kind = entry.kind;
    if (typeof kind !== 'string' || !_KIND_SET.has(kind)) {
        throw _codedError(FLEET_RUNLOG_ERROR_CODES.E_FLEET_UNKNOWN_KIND, `appendFleetEvent: unknown kind ${JSON.stringify(kind)}. `
            + `The vocabulary is fixed at ${FLEET_EVENT_KINDS.length} kinds: ${FLEET_EVENT_KINDS.join(', ')}.`);
    }
    for (const field of _requiredFieldsFor(kind)) {
        const value = entry[field];
        if (value === undefined) {
            throw _codedError(FLEET_RUNLOG_ERROR_CODES.E_FLEET_MISSING_FIELD, `appendFleetEvent: kind ${kind} requires field ${field}, which is absent. `
                + 'Every figure phase 22 publishes is folded out of these fields, so a record '
                + 'missing one is a figure that cannot be computed.');
        }
    }
    const line = JSON.stringify(entry) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes >= FLEET_MAX_RECORD_BYTES) {
        throw _codedError(FLEET_RUNLOG_ERROR_CODES.E_FLEET_RECORD_TOO_LARGE, `appendFleetEvent: record serializes to ${bytes} bytes, at or past the `
            + `${FLEET_MAX_RECORD_BYTES} byte atomic append bound. Past that bound a concurrent `
            + 'append is permitted to interleave, and a torn line in this log is unrecoverable.');
    }
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(target), { recursive: true });
    atomicState.withFileLock(target, () => {
        const fd = node_fs_1.default.openSync(target, 'a');
        try {
            node_fs_1.default.writeFileSync(fd, line);
            node_fs_1.default.fsyncSync(fd);
        }
        finally {
            try {
                node_fs_1.default.closeSync(fd);
            }
            catch { /* already closed */ }
        }
    });
}
/**
 * Read the log in append order.
 *
 * A missing file returns [] rather than throwing, because a run that has not
 * started yet has an empty history, not a broken one. Blank and whitespace-only
 * lines are skipped, so a trailing newline never yields a phantom record. A line
 * that will not parse THROWS `E_FLEET_LOG_UNPARSEABLE`, naming the 1-based line
 * number and the path (see the departure note in the header).
 *
 * Splitting uses the carriage-return-tolerant pattern because
 * `local/no-crlf-fragile-split` rejects the bare newline literal over a
 * `readFileSync` result.
 */
function readFleetRunlog(opts = {}) {
    const target = opts.path;
    if (typeof target !== 'string' || target === '') {
        throw new Error('readFleetRunlog: opts.path is required');
    }
    if (!node_fs_1.default.existsSync(target))
        return [];
    const raw = node_fs_1.default.readFileSync(target, 'utf8');
    const lines = raw.split(/\r?\n/);
    const events = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '')
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            throw _codedError(FLEET_RUNLOG_ERROR_CODES.E_FLEET_LOG_UNPARSEABLE, `readFleetRunlog: line ${i + 1} of ${target} is not valid JSON. `
                + 'Every figure in the run record is folded out of this file, so a skipped line '
                + 'would silently lower a published number. Repair that line by hand, then re-run.');
        }
        events.push(parsed);
    }
    return events;
}
module.exports = {
    FLEET_EVENT_KINDS,
    FLEET_COMMON_FIELDS,
    FLEET_EVENT_REQUIRED_FIELDS,
    FLEET_MAX_RECORD_BYTES,
    FLEET_RUNLOG_ERROR_CODES,
    fleetRunlogPath,
    appendFleetEvent,
    readFleetRunlog,
};
