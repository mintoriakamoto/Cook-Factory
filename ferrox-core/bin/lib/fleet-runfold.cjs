"use strict";
/**
 * The pure fold that turns the fleet run log into the run record (phase 19, D3).
 *
 * `foldRunRecord` is PURE over its arguments. It reads no file, no environment,
 * no process identity and no clock, and it owns no stdout. That is not stylistic:
 * D6 establishes that a figure which changes with something the caller cannot see
 * is not a measurement, and phase 22 Proof publishes every number this function
 * returns.
 *
 * IT FOLDS EVENTS AND NOTHING ELSE. There is no maintained counter anywhere in
 * this module, per D4. A derived counter cannot drift from its events; a
 * maintained one always eventually does. `rounds_per_artifact` in particular is
 * counted out of the events every time it is asked for, never stored.
 *
 * THE 4 JUDGEMENT CALLS, STATED BECAUSE EACH ONE IS A NUMBER SOMEBODY PUBLISHES:
 *
 * 1. AN UNTERMINATED WORKER INTERVAL IS AN EXPLICIT UNKNOWN, AND IT NEVER
 *    EXTENDS TO RUN CLOSE. This is the load bearing rule of the whole module. D3
 *    is explicit: a worker that dies without emitting an end event makes
 *    demonstrated width UNKNOWABLE rather than approximate. Extending such an
 *    interval to `run_closed_at` would silently INFLATE the width, and inflating
 *    the headline figure of a milestone about parallelism is the single worst
 *    thing this file could do. So the interval contributes NOTHING to
 *    `demonstrated_width.value`, it increments `unknown_intervals`, and it forces
 *    `exact` to false. The committed test constructs a run in which extending the
 *    interval WOULD raise the width, and asserts the lower number.
 *
 * 2. AN `abnormal` OUTCOME IS A CLOSED INTERVAL. An explicit abnormal end is
 *    KNOWLEDGE. The unknown case is the ABSENCE of an end event, not a bad one.
 *    That is exactly why the vocabulary carries `abnormal` at all: so a handler
 *    can write the truth instead of leaving a reader to infer it.
 *
 * 3. AT AN EQUAL TIMESTAMP AN END IS SWEPT BEFORE A START. Two intervals that
 *    merely touch, [10,20] and [20,30], do not overlap, so they demonstrate width
 *    1 and not 2. The direction of this tie break is the conservative one, and
 *    "demonstrated" width must never round up.
 *
 * 4. AN END IS MATCHED TO A START ON THE TRIPLE OF `worker_id`, `node_id` AND
 *    `attempt_id`, never on `worker_id` alone. One worker identity may take a
 *    second node after releasing the first, and a match on identity alone would
 *    close the wrong interval, converting 2 short intervals into 1 long one and
 *    inflating overlap.
 *
 * FF-B121, RESOLVED IN THE PLAN BEFORE EXECUTION. `opts.run_id` is an OPTIONAL
 * filter. Every event carries `run_id`; only `run_started` carries
 * `graph_generation`. With the filter supplied only events bearing that id are
 * considered, which is how 2 runs sharing 1 log are told apart. With it omitted
 * and more than 1 distinct `run_id` present, the fold THROWS
 * `E_FLEET_MULTIPLE_RUNS`. A fold that quietly averages 2 runs into 1 record is
 * worse than one that refuses, because the refusal is visible and the average is
 * not.
 *
 * THE KIND NAMES AND THE FIELD MAP ARE IMPORTED FROM `fleet-runlog.cjs`, never
 * restated here, so the writer and the fold CANNOT drift. Which kinds carry an
 * attempt is derived from that imported map rather than hardcoded, so a kind
 * plan 03 or 04 adds is picked up by the attempt fold without editing this file.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/fleet-runfold.cjs,
 * which is TRACKED and committed. `export =` CJS shape; no stdout.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runlog = require("./fleet-runlog.cjs");
/** The status of an interval whose extent is not known. */
const RUNFOLD_UNKNOWN = 'UNKNOWN';
/** The coded refusals this module raises. Frozen: callers branch on the code. */
const RUNFOLD_ERROR_CODES = Object.freeze({
    E_FLEET_MULTIPLE_RUNS: 'E_FLEET_MULTIPLE_RUNS',
});
function _codedError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}
/**
 * A timestamp as epoch milliseconds, or null when it cannot be established.
 *
 * Callers take their time from `ferrox-core/bin/lib/clock.cjs`, which yields
 * epoch ms, so the number branch is the normal path. ISO strings are accepted
 * because the event contract types `ts` as `string | number` and a hand written
 * fixture is more readable as an ISO string. Anything else yields null, and a
 * null endpoint makes an extent unknown rather than assumed.
 */
function _toMs(ts) {
    if (typeof ts === 'number')
        return Number.isFinite(ts) ? ts : null;
    if (typeof ts === 'string') {
        const parsed = Date.parse(ts);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
}
/**
 * An identifier as a key string that cannot collide across types.
 *
 * A bare `String(value)` maps every object to `[object Object]`, so 2 different
 * object valued ids would join to the SAME key and an end event would close a
 * different worker's interval. Strings pass through unchanged, so the normal path
 * and every existing key are untouched; anything else is serialized, which keeps
 * a number, a boolean and an object distinguishable from each other and from the
 * strings that spell them.
 */
function _idString(value) {
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
/** A difference in ms, or null when either endpoint is unknown. */
function _deltaMs(from, to) {
    const a = _toMs(from);
    const b = _toMs(to);
    if (a === null || b === null)
        return null;
    return b - a;
}
/**
 * The kinds that carry BOTH a node and an attempt, derived from the imported
 * required-field map rather than listed here. A kind added in plan 03 or 04 is
 * therefore folded into `rounds_per_artifact` with no edit to this file, which is
 * the mechanism that stops the writer and the fold drifting apart.
 */
function _kindsCarryingAttempt() {
    const out = new Set();
    const map = runlog.FLEET_EVENT_REQUIRED_FIELDS;
    for (const kind of runlog.FLEET_EVENT_KINDS) {
        const fields = map[kind] ?? [];
        if (fields.includes('node_id') && fields.includes('attempt_id'))
            out.add(kind);
    }
    return out;
}
const ATTEMPT_KINDS = _kindsCarryingAttempt();
/** Any kind that names a node at all, attempt or not. */
function _kindsCarryingNode() {
    const out = new Set();
    const map = runlog.FLEET_EVENT_REQUIRED_FIELDS;
    for (const kind of runlog.FLEET_EVENT_KINDS) {
        if ((map[kind] ?? []).includes('node_id'))
            out.add(kind);
    }
    return out;
}
const NODE_KINDS = _kindsCarryingNode();
/** A stable comparator over any 2 values, by their string form. */
function _byString(a, b) {
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}
/** An empty, well formed record. An empty log is an empty run, not an error. */
function _emptyRecord(runId) {
    return {
        run_id: runId,
        graph_generation: null,
        run_started_at: null,
        run_closed_at: null,
        workers: [],
        demonstrated_width: { value: 0, exact: true, unknown_intervals: 0 },
        nodes: [],
        rounds_per_artifact: {},
        false_green: { landed: 0, later_failed: 0, unknown: 0 },
    };
}
/**
 * Fold an event list into the run record phase 22 reads.
 *
 * See the header for the 4 judgement calls and for FF-B121. Pure over its
 * arguments; the input array is never mutated.
 */
function foldRunRecord(events, opts = {}) {
    const source = Array.isArray(events) ? events : [];
    const filter = opts.run_id;
    // FF-B121. A fold with no filter over a log holding 2 runs REFUSES.
    if (filter === undefined) {
        const seen = new Set();
        for (const e of source)
            if (typeof e.run_id === 'string')
                seen.add(e.run_id);
        if (seen.size > 1) {
            throw _codedError(RUNFOLD_ERROR_CODES.E_FLEET_MULTIPLE_RUNS, `foldRunRecord: the log holds ${seen.size} distinct run_id values `
                + `(${[...seen].sort().join(', ')}) and no opts.run_id filter was supplied. `
                + 'Folding them together would produce a width, a round count and a false green rate '
                + 'that describe no run that ever happened. Pass opts.run_id to select one.');
        }
    }
    const scoped = filter === undefined ? source : source.filter((e) => e.run_id === filter);
    if (scoped.length === 0)
        return _emptyRecord(filter ?? null);
    let runId = filter ?? null;
    let graphGeneration = null;
    let runStartedAt = null;
    let runClosedAt = null;
    // ── workers ────────────────────────────────────────────────────────────────
    // Matched on the TRIPLE, and the FIRST still-open start wins, so a worker that
    // takes the same node and attempt twice closes its intervals in order.
    const open = new Map();
    const workers = [];
    // The separator is an explicit NUL escape rather than a punctuation character.
    // A composite key joined on a printable separator can collide: a worker_id of
    // `a b` with node `c` is not the same triple as worker `a` with node `b c`, but
    // joined on a space they are the same string, and the fold would close the wrong
    // interval. NUL cannot occur inside a JSON string value, so it cannot collide.
    const NUL = '\u0000';
    const tripleKey = (e) => [_idString(e.worker_id), _idString(e.node_id), _idString(e.attempt_id)].join(NUL);
    // ── nodes and attempts ─────────────────────────────────────────────────────
    const nodeIds = new Set();
    const attemptsByNode = new Map();
    const attemptIdsByNode = new Map();
    const attemptRow = (nodeId, attemptId) => {
        let byAttempt = attemptsByNode.get(nodeId);
        if (byAttempt === undefined) {
            byAttempt = new Map();
            attemptsByNode.set(nodeId, byAttempt);
        }
        const key = _idString(attemptId);
        let row = byAttempt.get(key);
        if (row === undefined) {
            row = {
                attempt_id: attemptId,
                queue_entered_at: null,
                queue_acquired_at: null,
                gate_started_at: null,
                gate_ended_at: null,
                land_completed_at: null,
                queue_wait_ms: null,
                gate_ms: null,
                land_ms: null,
                post_land_truth: null,
            };
            byAttempt.set(key, row);
        }
        return row;
    };
    /** First occurrence wins. A second event of the same kind for the same attempt
     * is a duplicate, and taking the later one would silently move a boundary. */
    const setOnce = (row, field, value) => {
        if (row[field] === null)
            row[field] = value;
    };
    for (const e of scoped) {
        const kind = typeof e.kind === 'string' ? e.kind : '';
        const ts = e.ts ?? null;
        if (runId === null && typeof e.run_id === 'string')
            runId = e.run_id;
        if (NODE_KINDS.has(kind) && e.node_id !== undefined) {
            const nodeId = _idString(e.node_id);
            nodeIds.add(nodeId);
            if (ATTEMPT_KINDS.has(kind) && e.attempt_id !== undefined) {
                let ids = attemptIdsByNode.get(nodeId);
                if (ids === undefined) {
                    ids = new Set();
                    attemptIdsByNode.set(nodeId, ids);
                }
                ids.add(_idString(e.attempt_id));
            }
        }
        switch (kind) {
            case 'run_started':
                if (runStartedAt === null)
                    runStartedAt = ts;
                if (graphGeneration === null)
                    graphGeneration = e.graph_generation ?? null;
                break;
            case 'run_closed':
                runClosedAt = ts;
                break;
            case 'worker_started': {
                const row = {
                    worker_id: e.worker_id,
                    node_id: e.node_id,
                    attempt_id: e.attempt_id,
                    lease_epoch: e.lease_epoch,
                    started_at: ts,
                    ended_at: null,
                    outcome: null,
                    // Optimistic only until the matching end arrives. Every row that is
                    // still UNKNOWN at the end of the pass stays UNKNOWN.
                    status: RUNFOLD_UNKNOWN,
                };
                workers.push(row);
                const key = tripleKey(e);
                const queue = open.get(key);
                if (queue === undefined)
                    open.set(key, [row]);
                else
                    queue.push(row);
                break;
            }
            case 'worker_ended': {
                const key = tripleKey(e);
                const queue = open.get(key);
                const row = queue !== undefined && queue.length > 0 ? queue.shift() : undefined;
                if (row === undefined) {
                    // An end with no start. The extent is unknown in the other direction,
                    // and dropping it would hide a real defect in the writer.
                    workers.push({
                        worker_id: e.worker_id,
                        node_id: e.node_id,
                        attempt_id: e.attempt_id,
                        lease_epoch: null,
                        started_at: null,
                        ended_at: ts,
                        outcome: e.outcome ?? null,
                        status: RUNFOLD_UNKNOWN,
                    });
                    break;
                }
                row.ended_at = ts;
                row.outcome = e.outcome ?? null;
                // An explicit `abnormal` outcome is a CLOSED interval: an abnormal end is
                // knowledge. The interval is closed only when its extent is actually
                // computable, so a timestamp that will not convert leaves it UNKNOWN
                // rather than silently contributing a garbage endpoint to the sweep.
                row.status = _toMs(row.started_at) !== null && _toMs(row.ended_at) !== null
                    ? 'closed'
                    : RUNFOLD_UNKNOWN;
                break;
            }
            case 'queue_entered':
                setOnce(attemptRow(_idString(e.node_id), e.attempt_id), 'queue_entered_at', ts);
                break;
            case 'queue_acquired':
                setOnce(attemptRow(_idString(e.node_id), e.attempt_id), 'queue_acquired_at', ts);
                break;
            case 'gate_started':
                setOnce(attemptRow(_idString(e.node_id), e.attempt_id), 'gate_started_at', ts);
                break;
            case 'gate_ended':
                setOnce(attemptRow(_idString(e.node_id), e.attempt_id), 'gate_ended_at', ts);
                break;
            case 'land_completed':
                setOnce(attemptRow(_idString(e.node_id), e.attempt_id), 'land_completed_at', ts);
                break;
            case 'post_land_truth': {
                const row = attemptRow(_idString(e.node_id), e.attempt_id);
                // Post land truth is recorded in its own right and NEVER derived from a
                // gate verdict, per D3: a false green rate cannot be inferred from a
                // green gate by definition.
                if (row.post_land_truth === null)
                    row.post_land_truth = e.classification ?? null;
                break;
            }
            default:
                break;
        }
    }
    // ── demonstrated width: CLOSED intervals only ──────────────────────────────
    let unknownIntervals = 0;
    const points = [];
    for (const w of workers) {
        if (w.status !== 'closed') {
            unknownIntervals++;
            continue;
        }
        const a = _toMs(w.started_at);
        const b = _toMs(w.ended_at);
        if (a === null || b === null) {
            unknownIntervals++;
            continue;
        }
        points.push({ t: a, delta: +1 });
        points.push({ t: b, delta: -1 });
    }
    // Judgement call 3: at an equal timestamp an END is swept before a START, so 2
    // intervals that merely touch demonstrate width 1.
    points.sort((p, q) => (p.t - q.t) || (p.delta - q.delta));
    let running = 0;
    let width = 0;
    for (const p of points) {
        running += p.delta;
        if (running > width)
            width = running;
    }
    // ── attempts, rounds and false green ──────────────────────────────────────
    for (const byAttempt of attemptsByNode.values()) {
        for (const row of byAttempt.values()) {
            row.queue_wait_ms = _deltaMs(row.queue_entered_at, row.queue_acquired_at);
            row.gate_ms = _deltaMs(row.gate_started_at, row.gate_ended_at);
            // Land WORK, from the moment the queue was acquired to the moment the land
            // finished. D3 separates queue wait from land work, and the gate sits
            // inside the land work rather than beside it.
            row.land_ms = _deltaMs(row.queue_acquired_at, row.land_completed_at);
        }
    }
    const nodes = [...nodeIds].sort(_byString).map((nodeId) => {
        const byAttempt = attemptsByNode.get(nodeId);
        const attempts = byAttempt === undefined ? [] : [...byAttempt.values()];
        attempts.sort((a, b) => _byString(a.attempt_id, b.attempt_id));
        return { node_id: nodeId, attempts };
    });
    // Counted out of the events every time, never stored (D4).
    const roundsPerArtifact = {};
    for (const nodeId of [...nodeIds].sort(_byString)) {
        roundsPerArtifact[nodeId] = (attemptIdsByNode.get(nodeId) ?? new Set()).size;
    }
    const falseGreen = { landed: 0, later_failed: 0, unknown: 0 };
    for (const node of nodes) {
        for (const attempt of node.attempts) {
            const landed = attempt.land_completed_at !== null;
            if (landed)
                falseGreen.landed++;
            // A landed attempt with NO post_land_truth event counts as unknown, never
            // as held. Assuming it held is exactly the optimism D3 forbids.
            const classification = attempt.post_land_truth ?? (landed ? 'unknown' : null);
            if (classification === 'false_green')
                falseGreen.later_failed++;
            else if (classification === 'unknown')
                falseGreen.unknown++;
        }
    }
    // Deterministic output order. The fold must not leak the arrival order of its
    // input into its output: a figure that changes with arrival order is not a
    // measurement (D6).
    workers.sort((a, b) => {
        const ma = _toMs(a.started_at);
        const mb = _toMs(b.started_at);
        const ka = ma === null ? Number.POSITIVE_INFINITY : ma;
        const kb = mb === null ? Number.POSITIVE_INFINITY : mb;
        return (ka - kb)
            || _byString(a.worker_id, b.worker_id)
            || _byString(a.node_id, b.node_id)
            || _byString(a.attempt_id, b.attempt_id);
    });
    return {
        run_id: runId,
        graph_generation: graphGeneration,
        run_started_at: runStartedAt,
        run_closed_at: runClosedAt,
        workers,
        demonstrated_width: { value: width, exact: unknownIntervals === 0, unknown_intervals: unknownIntervals },
        nodes,
        rounds_per_artifact: roundsPerArtifact,
        false_green: falseGreen,
    };
}
module.exports = { foldRunRecord, RUNFOLD_UNKNOWN, RUNFOLD_ERROR_CODES };
