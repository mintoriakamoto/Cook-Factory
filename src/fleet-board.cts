/**
 * The blackboard: a PURE projection of the fleet run log, the lease predicates
 * the wave shares, and the lease WRITE verbs above them (phase 19, D4 and SC1).
 *
 * THIS MODULE HAS 2 HALVES AND THE SPLIT IS THE POINT.
 *
 *   THE PURE HALF (`projectBoard`, `isLeaseExpired`, `isReclaimable`,
 *   `nextLeaseEpoch`) reads no file, no environment and no clock. Every input
 *   arrives as an argument.
 *
 *   THE WRITE HALF (`claimNode`, `renewLease`, `releaseLease`, `reclaimLease`,
 *   `reconcileBoard`) is where the input and output live. It still takes every
 *   INSTANT as a caller supplied `nowMs`, per D2's rule that time comes from the
 *   `ferrox-core/bin/lib/clock.cjs` seam and never from the platform directly,
 *   and it decides using the pure predicates rather than inferring a second set
 *   of rules. A verb and the predicate it enforces disagreeing is the failure a
 *   split into 2 modules would invite, so they live in 1 file.
 *
 * WHY THIS IS A FOLD AND NOT A FILE. D4 is explicit that there are 2 stores and
 * they are not the same thing. The event log is the source of truth. The
 * blackboard's current state is a DERIVED PROJECTION of that log, and when the 2
 * disagree the log wins and the projection is rebuilt. That rule is only
 * enforceable if the projection is a pure fold with no hidden state.
 * `projectBoard` over the same events always yields the same board, on any
 * machine, at any time. A materialised board file is therefore always disposable,
 * which is what makes the design recoverable after a crash.
 *
 * WHY THE PREDICATES LIVE HERE RATHER THAN IN THEIR CALLERS. Plan 03 owns the
 * lease write side and plan 04 owns the land queue, and both must answer the same
 * question: may this holder be displaced. If each writes its own answer the fleet
 * has 2 reclaim rules, and 2 rules that agree today diverge on the first edit. So
 * the answer is computed once here and imported by both. `src/fleet-landqueue.cts`
 * judges a stuck land holder with the identical predicate that judges a stuck node
 * lease.
 *
 * LIVENESS IS AN EXPLICIT INPUT, NEVER A PROBE THIS MODULE RUNS. `isReclaimable`
 * takes `{ alive: boolean }` as an argument. A module that probes its own liveness
 * cannot be tested against the arm that does not happen on the test machine, and
 * D7 requires that every guard be driven against a case where the thing it detects
 * IS present. Passing the verdict in is what lets plan 03 drive both arms of the
 * crash reclaim case without killing anything, and what lets its real process test
 * drive the same predicate with a real verdict.
 *
 * WHY RECLAIM HAS 2 ARMS. An expired lease means the worker stopped renewing. A
 * dead holder means the worker stopped existing. They are different failures. A
 * fleet that waits out the whole TTL on a process it can see is gone wastes the
 * whole TTL, and a fleet that reclaims only on a liveness verdict cannot reclaim a
 * wedged process that is still running. Both arms exist because neither covers the
 * other.
 *
 * EVERY ARRAY THIS MODULE RETURNS IS SORTED BEFORE IT IS RETURNED: completed by
 * node id, tickets by ticket number, attempts by attempt id. Insertion order never
 * reaches the output, for the same reason D6 gives about the manager pass. A
 * JavaScript `Map` and `Set` preserve insertion order, so an unsorted output leaks
 * the order events happened to arrive in, and arrival order is exactly what varies
 * when N workers complete concurrently.
 *
 * WHY THE LEASE LIVES ABOVE `atomic-state` AND NEVER INSIDE IT. The locked
 * context's D2 correction is the load bearing line of this whole phase.
 * `src/atomic-state.cts` is a SINGLE SHOT TRANSACTION LOCK and not a renewable
 * lease: it has no renew and no heartbeat, its hold budget defaults to half its
 * stale window at `:193`, and `verifyFence` THROWS `E_LOCK_HOLD_EXPIRED` at
 * `:308-311` once that budget passes. Renewal cannot be faked either, because
 * reacquiring mints a fresh inode and nonce at `:289` and invalidates the previous
 * fence. That absence is the DESIGN, it scopes the lock to 1 claim transaction,
 * and a cross audit confirmed that changing it would regress the bounded hold
 * invariant phase 16 shipped deliberately.
 *
 * So the LOGICAL lease lives here, carrying its own monotonic `lease_epoch` that
 * survives renewal and advances only on reclaim, and `atomic-state` is used ONLY
 * for the short atomic update of the lease record. Each verb holds the lock for 1
 * read, 1 append and 1 write, which is milliseconds against a default budget of
 * half of the 30 second stale window, so `E_LOCK_HOLD_EXPIRED` is unreachable by
 * construction on this path. A heartbeat takes the lock and drops it again; the
 * lock is NEVER stretched across a worker's lifetime, which is the shape that
 * would expire mid work and refuse the write.
 *
 * THE LOCK ORDER IS FIXED: the projection lock is always OUTER and the log lock,
 * taken inside `appendFleetEvent`, is always INNER. They are different paths so
 * they cannot deadlock against each other, and stating the order here is what
 * keeps a later caller from inverting it.
 *
 * ADR-457 build-at-publish: this TS source compiles to the artifact
 * ferrox-core/bin/lib/fleet-board.cjs, which is TRACKED and committed (the
 * gitignore at `.gitignore:68` lists artifacts per file, so a NEW lib is tracked
 * by default). CJS module shape (`export =`) matches `src/fleet-runlog.cts` and
 * `src/fleet-runfold.cts`. The module owns NO stdout.
 */

import { spawnSync } from 'node:child_process';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import runlog = require('./fleet-runlog.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import atomicState = require('./atomic-state.cjs');

/**
 * The lease state vocabulary, frozen.
 *
 * The projection emits `held` after a claim or a reclaim and `released` after a
 * release. `reclaimed` is in the vocabulary because a consumer that branches on
 * state must have the complete set to branch on, and because plan 03 writes it
 * onto the displaced holder's record when it performs the reclaim. The board keeps
 * exactly 1 lease per node, which is the current one, so the displaced record is
 * not what this fold returns.
 */
const LEASE_STATES = Object.freeze({
  HELD: 'held',
  RELEASED: 'released',
  RECLAIMED: 'reclaimed',
} as const);

/**
 * The separator for composite keys is an explicit NUL escape, never a printable
 * character.
 *
 * Joining on a printable separator COLLIDES: node `nA x` with attempt `aB` and
 * node `nA` with attempt `x aB` produce the same joined string on a space, so a
 * completion would close a different attempt's ticket. NUL cannot occur inside a
 * JSON string value, so it cannot collide. This is the same defect
 * `src/fleet-runfold.cts:269-274` records, reached from a different direction.
 */
const NUL = '\u0000';

/** The holder identity carried on a lease, when the claim event supplied one. */
interface LeaseHolder {
  pid: unknown;
  pid_start: unknown;
}

/**
 * The 2 fields the reclaim predicates read, and the only 2 they read.
 *
 * A node lease and a land token holder are DIFFERENT records that must be judged
 * by the SAME rule, per D5's reading of SC4 and the wedge hazard T-19-11. Stating
 * the shared shape here rather than typing the predicates against `Lease` is what
 * makes that literal: `src/fleet-landqueue.cts` hands its holder to the identical
 * function, so a stuck lander and a stuck node cannot drift onto 2 rules.
 */
interface Expirable {
  state: string;
  expires_at_ms: number | null;
}

/** One node's current lease, as projected from the log. */
interface Lease extends Expirable {
  node_id: string;
  worker_id: unknown;
  lease_epoch: number;
  acquired_at_ms: number | null;
  renewed_at_ms: number | null;
  holder: LeaseHolder | null;
}

/** One land queue ticket, as projected from the log. */
interface QueueTicket {
  node_id: string;
  attempt_id: unknown;
  ticket: number;
  worker_id: unknown;
  entered_at: number | null;
  acquired_at: number | null;
  completed_at: number | null;
}

/**
 * Who currently holds the single repo scoped land token, or null.
 *
 * It carries `state` and `expires_at_ms` because it is an `Expirable`: a crashed
 * lander that could never be judged expired would wedge the trunk for the whole
 * run, which is T-19-11 and is the denial of service D5 refuses to ship.
 */
interface QueueHolder extends Expirable {
  node_id: string;
  attempt_id: unknown;
  ticket: number;
  worker_id: unknown;
  acquired_at: number | null;
}

/** The land queue slice of the board. */
interface QueueProjection {
  tickets: QueueTicket[];
  held_by: QueueHolder | null;
}

/** The whole derived blackboard. */
interface Board {
  completed: string[];
  leases: Record<string, Lease>;
  queue: QueueProjection;
  attempts: Record<string, string[]>;
}

/** A liveness verdict supplied BY THE CALLER. Never probed in this module. */
interface LivenessVerdict {
  alive: boolean;
}

/** One append-only fleet run record, as read back from the log. */
interface FleetEventLike {
  ts?: unknown;
  kind?: unknown;
  [k: string]: unknown;
}

/**
 * An identifier as a key string that cannot collide across types.
 *
 * A bare `String(value)` maps every object to `[object Object]`, so 2 different
 * object valued ids would join to the SAME key. Strings pass through unchanged, so
 * the normal path and every existing key are untouched; anything else is
 * serialized, which keeps a number, a boolean and an object distinguishable from
 * each other and from the strings that spell them. Copied deliberately from
 * `src/fleet-runfold.cts:161`, because the 2 folds must key identically or the
 * board and the run record can describe different runs.
 */
function _idString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A timestamp as epoch milliseconds, or null when it cannot be read as one.
 *
 * null is a real answer here rather than a substituted 0. A lease whose acquire
 * time is unreadable has an UNKNOWN acquire time, and treating unknown as the
 * epoch would make it look infinitely old and therefore reclaimable.
 */
function _toMs(ts: unknown): number | null {
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** A lease epoch as a positive integer, or null when the field is not one. */
function _toEpoch(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

/** A ticket number as a non-negative integer, or null. */
function _toTicket(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/** The holder identity an event carried, or null when it carried none. */
function _toHolder(value: unknown): LeaseHolder | null {
  if (value === null || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec.pid === undefined && rec.pid_start === undefined) return null;
  return { pid: rec.pid, pid_start: rec.pid_start };
}

/**
 * The kinds that carry BOTH a node and an attempt, derived from the writer's
 * required-field map rather than listed here.
 *
 * A kind added in plan 03 or 04 is therefore folded into `attempts` with no edit
 * to this file, which is the mechanism that stops the writer and the projection
 * drifting apart. Same construction as `src/fleet-runfold.cts:184`.
 */
function _kindsCarryingAttempt(): ReadonlySet<string> {
  const out = new Set<string>();
  const map = runlog.FLEET_EVENT_REQUIRED_FIELDS as unknown as Record<string, readonly string[]>;
  for (const kind of runlog.FLEET_EVENT_KINDS as readonly string[]) {
    const fields = map[kind] ?? [];
    if (fields.includes('node_id') && fields.includes('attempt_id')) out.add(kind);
  }
  return out;
}

/** The composite (node, attempt) key, joined on NUL. */
function _attemptKey(nodeId: unknown, attemptId: unknown): string {
  return `${_idString(nodeId)}${NUL}${_idString(attemptId)}`;
}

/**
 * Fold the run log into the current blackboard.
 *
 * Pure over its argument. Reads no file, no environment and no clock.
 *
 * The lease rules, stated once so plan 03 and plan 04 cannot each infer their own:
 *
 *   - `claim_acquired` and `lease_reclaimed` install a HELD lease at the event's
 *     epoch, but ONLY when that epoch is at or above the node's current epoch. An
 *     event at a LOWER epoch is a stale writer that has already been displaced,
 *     and honouring it would roll the node back to a holder that no longer owns
 *     it, which is a double holder.
 *   - `lease_renewed` extends the CURRENT lease and never changes its epoch. A
 *     renewal whose epoch does not match the current lease is ignored for the same
 *     reason: it is a worker that was reclaimed and does not know it yet, and
 *     letting it extend the lease would resurrect a dead holder.
 *   - `lease_released` moves the lease to `released` and leaves the record in
 *     place. The record is kept ON PURPOSE, because `nextLeaseEpoch` reads it: a
 *     node whose lease was released cleanly must hand the next holder epoch N + 1,
 *     not epoch 1, or 2 different holders across time share an epoch and the
 *     renewal rule above stops distinguishing them.
 *
 * A node is `completed` when a `worker_ended` event records outcome `completed`.
 * That enum is fixed by `src/fleet-runlog.cts:106-109` to `completed`, `failed`,
 * `abnormal`, so the rule reads a closed vocabulary. `land_completed` carries a
 * free-form `result` this module deliberately does not interpret: a projection
 * that guesses at an open string is a projection that changes meaning the first
 * time a caller invents a new one.
 */
function projectBoard(events: readonly FleetEventLike[]): Board {
  const list = Array.isArray(events) ? events : [];
  const attemptKinds = _kindsCarryingAttempt();

  const completed = new Set<string>();
  const leases: Record<string, Lease> = Object.create(null) as Record<string, Lease>;
  const attempts = new Map<string, Set<string>>();
  const ticketsByKey = new Map<string, QueueTicket>();
  let heldBy: QueueHolder | null = null;

  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue;
    const event = raw as FleetEventLike;
    const kind = typeof event.kind === 'string' ? event.kind : '';
    const ts = _toMs(event.ts);

    if (attemptKinds.has(kind) && event.node_id !== undefined && event.attempt_id !== undefined) {
      const nodeKey = _idString(event.node_id);
      let seen = attempts.get(nodeKey);
      if (seen === undefined) {
        seen = new Set<string>();
        attempts.set(nodeKey, seen);
      }
      seen.add(_idString(event.attempt_id));
    }

    switch (kind) {
      case 'worker_ended': {
        if (event.outcome === 'completed' && event.node_id !== undefined) {
          completed.add(_idString(event.node_id));
        }
        break;
      }

      case 'claim_acquired':
      case 'lease_reclaimed': {
        if (event.node_id === undefined) break;
        const nodeKey = _idString(event.node_id);
        const epoch = _toEpoch(event.lease_epoch);
        if (epoch === null) break;
        const current = leases[nodeKey];
        if (current !== undefined && epoch < current.lease_epoch) break;
        leases[nodeKey] = {
          node_id: nodeKey,
          worker_id: event.worker_id,
          lease_epoch: epoch,
          state: LEASE_STATES.HELD,
          acquired_at_ms: ts,
          renewed_at_ms: ts,
          expires_at_ms: _toMs(event.expires_at_ms),
          holder: _toHolder(event.holder),
        };
        break;
      }

      case 'lease_renewed': {
        if (event.node_id === undefined) break;
        const nodeKey = _idString(event.node_id);
        const current = leases[nodeKey];
        if (current === undefined) break;
        if (current.state !== LEASE_STATES.HELD) break;
        const renewEpoch = _toEpoch(event.lease_epoch);
        if (renewEpoch !== current.lease_epoch) break;
        current.renewed_at_ms = ts;
        const nextExpiry = _toMs(event.expires_at_ms);
        if (nextExpiry !== null) current.expires_at_ms = nextExpiry;
        break;
      }

      case 'lease_released': {
        if (event.node_id === undefined) break;
        const nodeKey = _idString(event.node_id);
        const current = leases[nodeKey];
        if (current === undefined) break;
        const releaseEpoch = _toEpoch(event.lease_epoch);
        if (releaseEpoch !== current.lease_epoch) break;
        current.state = LEASE_STATES.RELEASED;
        break;
      }

      case 'queue_entered': {
        if (event.node_id === undefined) break;
        const ticket = _toTicket(event.ticket);
        if (ticket === null) break;
        const key = _attemptKey(event.node_id, event.attempt_id);
        if (ticketsByKey.has(key)) break;
        ticketsByKey.set(key, {
          node_id: _idString(event.node_id),
          attempt_id: event.attempt_id,
          ticket,
          worker_id: null,
          entered_at: ts,
          acquired_at: null,
          completed_at: null,
        });
        break;
      }

      case 'queue_acquired': {
        if (event.node_id === undefined) break;
        const key = _attemptKey(event.node_id, event.attempt_id);
        const row = ticketsByKey.get(key);
        if (row === undefined) break;
        row.acquired_at = ts;
        row.worker_id = event.worker_id;
        if (row.completed_at === null) {
          heldBy = {
            node_id: row.node_id,
            attempt_id: row.attempt_id,
            ticket: row.ticket,
            worker_id: row.worker_id,
            acquired_at: ts,
            state: LEASE_STATES.HELD,
            expires_at_ms: _toMs(event.expires_at_ms),
          };
        }
        break;
      }

      case 'land_completed': {
        if (event.node_id === undefined) break;
        const key = _attemptKey(event.node_id, event.attempt_id);
        const row = ticketsByKey.get(key);
        if (row === undefined) break;
        row.completed_at = ts;
        if (heldBy !== null && heldBy.ticket === row.ticket && heldBy.node_id === row.node_id) {
          heldBy = null;
        }
        break;
      }

      default:
        break;
    }
  }

  const tickets = [...ticketsByKey.values()].sort((a, b) => a.ticket - b.ticket);

  const attemptsOut: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [nodeKey, ids] of attempts) {
    attemptsOut[nodeKey] = [...ids].sort();
  }

  return {
    completed: [...completed].sort(),
    leases,
    queue: { tickets, held_by: heldBy },
    attempts: attemptsOut,
  };
}

/**
 * Is this lease past its deadline at the supplied instant.
 *
 * Exactly the time comparison and nothing else: true when `expires_at_ms` is a
 * real number and `nowMs` is AT OR PAST it. The boundary is `>=` rather than `>`
 * on purpose. An off by 1 at the TTL boundary is the difference between a reclaim
 * and a double holder, and a lease that has reached its own stated deadline has
 * reached it.
 *
 * A lease with no readable deadline returns FALSE, which is the safe direction and
 * not an oversight. Returning true would make a freshly claimed lease whose
 * expiry field was lost immediately reclaimable, and a double holder corrupts a
 * worktree unrecoverably. Returning false wedges the node instead, which is
 * visible, and the liveness arm of `isReclaimable` still frees it the moment the
 * holder is known to be gone. A wedge is recoverable; a double holder is not.
 *
 * `nowMs` is a PARAMETER. This module never reaches for the platform time source.
 */
function isLeaseExpired(lease: Expirable | null | undefined, nowMs: number): boolean {
  if (lease === null || lease === undefined) return false;
  const expires = _toMs(lease.expires_at_ms);
  if (expires === null) return false;
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return false;
  return nowMs >= expires;
}

/**
 * May this lease be taken from its current holder at the supplied instant.
 *
 * True when the lease is expired, OR when the supplied liveness verdict says the
 * holder is dead. False when the lease is live and the holder is alive.
 *
 * A lease that is not HELD is NOT reclaimable, because there is nothing to
 * reclaim: a released lease has no holder, and the node is ACQUIRED rather than
 * reclaimed. The caller distinguishes the 2, and the distinction matters because a
 * reclaim advances the epoch and writes a `lease_reclaimed` event naming a prior
 * holder that in this case does not exist.
 *
 * An ABSENT liveness verdict is not a dead verdict. When `liveness` is not
 * supplied, only the expiry arm applies, so a caller that cannot probe gets the
 * conservative answer rather than an accidental reclaim.
 */
function isReclaimable(
  lease: Expirable | null | undefined,
  nowMs: number,
  liveness?: LivenessVerdict | null,
): boolean {
  if (lease === null || lease === undefined) return false;
  if (lease.state !== LEASE_STATES.HELD) return false;
  if (isLeaseExpired(lease, nowMs)) return true;
  if (liveness !== null && typeof liveness === 'object' && liveness.alive === false) return true;
  return false;
}

/**
 * The epoch the next holder of this node must take.
 *
 * The node's current epoch plus 1, or 1 for a node that has never been leased. The
 * epoch is read from the projection rather than from a maintained counter, per D4:
 * a derived counter cannot drift from its events and a maintained one always
 * eventually does. It is also the 1 field that tells a renewal apart from a
 * reclaim after a crash, which is why D3 requires it in the run record.
 */
function nextLeaseEpoch(board: Board | null | undefined, nodeId: unknown): number {
  if (board === null || board === undefined) return 1;
  const leases = board.leases;
  if (leases === null || typeof leases !== 'object') return 1;
  const lease = leases[_idString(nodeId)];
  if (lease === undefined) return 1;
  const epoch = _toEpoch(lease.lease_epoch);
  if (epoch === null) return 1;
  return epoch + 1;
}

// ─── the write half ──────────────────────────────────────────────────────────

/**
 * The coded refusals the write verbs raise. Frozen: callers branch on a code and
 * never on prose, exactly as `src/atomic-state.cts:85` and
 * `src/fleet-runlog.cts:143` already establish.
 *
 * `E_FLEET_BAD_IDENTIFIER` is not in the plan's list of 4 and it is here for the
 * reason plan 02 added `E_FLEET_BAD_NODE_ID` to the manager. A bare coercion maps
 * every object onto `[object Object]`, so 2 distinct nodes collapse onto 1 key.
 * On the read side that silently loses a dispatch; on the WRITE side it hands 2
 * different nodes the same lease, which is a double holder. Refusing at the door
 * is what makes the rest of this file able to compare identities with plain
 * string equality.
 */
const FLEET_BOARD_ERROR_CODES = Object.freeze({
  E_FLEET_NODE_HELD: 'E_FLEET_NODE_HELD',
  E_FLEET_STALE_EPOCH: 'E_FLEET_STALE_EPOCH',
  E_FLEET_NOT_HOLDER: 'E_FLEET_NOT_HOLDER',
  E_FLEET_NOT_RECLAIMABLE: 'E_FLEET_NOT_RECLAIMABLE',
  E_FLEET_BAD_IDENTIFIER: 'E_FLEET_BAD_IDENTIFIER',
});

/** Attach a code to an Error so callers branch on a code rather than on prose. */
function _codedError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/**
 * Refuse an identifier that is not a non-empty string, rather than coercing it.
 *
 * See `FLEET_BOARD_ERROR_CODES`. This is the door, and everything past it may
 * compare identities with `===`.
 */
function _requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw _codedError(
      FLEET_BOARD_ERROR_CODES.E_FLEET_BAD_IDENTIFIER,
      `fleet-board: ${label} must be a non-empty string, received ${typeof value} `
        + `${JSON.stringify(value)}. Coercing it would map every object onto the same key, `
        + 'which hands 2 different nodes the same lease.',
    );
  }
  return value;
}

/** Refuse an instant that is not a finite number. Time always arrives as an argument. */
function _requireNowMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw _codedError(
      FLEET_BOARD_ERROR_CODES.E_FLEET_BAD_IDENTIFIER,
      `fleet-board: nowMs must be a finite number, received ${JSON.stringify(value)}. `
        + 'Time arrives from ferrox-core/bin/lib/clock.cjs through the caller, never from the platform here.',
    );
  }
  return value;
}

/** Refuse a TTL that is not a positive finite number. */
function _requireTtlMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw _codedError(
      FLEET_BOARD_ERROR_CODES.E_FLEET_BAD_IDENTIFIER,
      `fleet-board: ttlMs must be a positive finite number, received ${JSON.stringify(value)}. `
        + 'A lease with no positive deadline can never expire, so its node would wedge for the whole run.',
    );
  }
  return value;
}

/**
 * The process start stamp for a pid, or null when it cannot be read.
 *
 * `ps -o lstart=` is the same probe the vendored engine uses at `ratchet:1480`,
 * and the binding it produces is what makes the liveness verdict pid REUSE safe:
 * `os.kill(pid, 0)` alone says "a process exists", never "THE process exists".
 *
 * null means UNREADABLE, and every caller treats unreadable as alive. A probe
 * that cannot answer must never authorise stealing a live worker's lease.
 */
function _readPidStart(pid: number): string | null {
  try {
    const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (out.error !== undefined && out.error !== null) return null;
    if (out.status !== 0) return null;
    const stamp = typeof out.stdout === 'string' ? out.stdout.trim() : '';
    return stamp === '' ? null : stamp;
  } catch {
    return null;
  }
}

/**
 * Does a process with this pid exist right now: true, false, or null for
 * unknowable.
 *
 * Signal 0 performs the permission and existence checks without delivering a
 * signal. `ESRCH` is the only answer that means ABSENT. `EPERM` means the process
 * exists and belongs to somebody else, which is still existence, so it reports
 * true rather than being mistaken for a dead holder.
 */
function _pidExists(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

/**
 * This process's own claimant identity, as recorded on a lease at claim time.
 *
 * A worker calls this once and passes the result to `claimNode`. `claimNode`
 * defaults to it, because a lease with no holder record can never be crash
 * reclaimed at all: the liveness arm would have nothing to probe and the node
 * would wait out the whole TTL on a worker that is provably gone.
 */
function currentHolder(): LeaseHolder {
  return { pid: process.pid, pid_start: _readPidStart(process.pid) ?? '' };
}

/** Injectable halves of the liveness probe, so both arms are drivable in a test. */
interface LivenessDeps {
  pidExists?: (pid: number) => boolean | null;
  readPidStart?: (pid: number) => string | null;
}

/** A liveness verdict, with the reason it was reached. */
interface LivenessResult extends LivenessVerdict {
  reason: string;
}

/**
 * Is the process that made this claim still running.
 *
 * THIS SEAM FAILS CLOSED TOWARD THE HOLDER. Only 2 answers are dead: the pid is
 * absent, or the pid is present wearing a DIFFERENT start stamp, which is a
 * recycled number rather than the claimant. Every other outcome, including an
 * unreadable holder record, an unreadable pid, an unknowable presence check and
 * an unreadable start stamp, reports ALIVE. An unreadable probe must never
 * authorise stealing a live worker's lease, and a wedge is recoverable through
 * the TTL arm while a double holder is not recoverable at all.
 *
 * A recorded stamp that is absent or blank also reports alive, matching the
 * conservative branch the vendored engine takes at `ratchet:1499`: with no
 * binding recorded there is nothing to disprove, so a live pid is treated as the
 * claimant.
 */
function probeLiveness(holder: unknown, deps: LivenessDeps = {}): LivenessResult {
  const pidExists = deps.pidExists ?? _pidExists;
  const readPidStart = deps.readPidStart ?? _readPidStart;

  if (holder === null || typeof holder !== 'object') {
    return { alive: true, reason: 'holder_record_unreadable' };
  }
  const rec = holder as Record<string, unknown>;
  const pid = rec.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) {
    return { alive: true, reason: 'pid_unreadable' };
  }

  const exists = pidExists(pid);
  if (exists === false) return { alive: false, reason: 'pid_absent' };
  if (exists !== true) return { alive: true, reason: 'pid_presence_unknowable' };

  const recorded = rec.pid_start;
  if (typeof recorded !== 'string' || recorded.trim() === '') {
    return { alive: true, reason: 'no_start_binding_recorded' };
  }
  const actual = readPidStart(pid);
  if (actual === null) return { alive: true, reason: 'start_stamp_unreadable' };
  if (actual.trim() !== recorded.trim()) return { alive: false, reason: 'start_stamp_mismatch' };
  return { alive: true, reason: 'pid_and_start_stamp_match' };
}

/**
 * Read the projection file without ever throwing.
 *
 * An unreadable projection is a DISAGREEING projection, never a fatal one,
 * because the projection is derived and the log is the truth. This read exists to
 * report the disagreement and to let `reconcileBoard` repair it; no decision is
 * ever taken from its result.
 */
function _readProjectionTolerant(projectionPath: string): { readable: boolean; value: unknown } {
  try {
    return { readable: true, value: atomicState.readJsonOrEmpty(projectionPath) };
  } catch {
    return { readable: false, value: null };
  }
}

/**
 * A stable serialization with every object key sorted, for COMPARISON only.
 *
 * Two boards folded from the same events carry the same keys, but a board that
 * made a round trip through a file can order integer-like node ids differently
 * from one built in memory. Sorting before comparing removes that from the
 * question entirely, so a reported disagreement is always a real disagreement.
 */
function _canonical(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const rec = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort()) out[key] = walk(rec[key]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/** The exact bytes a materialised projection carries. 1 producer, 1 format. */
function _serializeBoard(board: Board): string {
  return JSON.stringify(board, null, 2) + '\n';
}

/**
 * The transaction every write verb runs, stated once so 4 verbs cannot each
 * infer their own ordering.
 *
 * 1. Take the PROJECTION lock. It is the outer lock; see the header.
 * 2. Read the LOG fresh, inside the lock, and fold it. Reading inside the lock is
 *    what defeats the check then act race, and it is the same reason
 *    `updateJsonFileAtomic` reads inside too.
 *
 *    THE DECISION IS TAKEN FROM THE LOG AND NOT FROM THE MATERIALISED
 *    PROJECTION, and that is load bearing rather than a preference. The whole
 *    point of the log first ordering below is that a crash between the append and
 *    the projection write leaves the log AHEAD. A verb that decided from the
 *    projection would then find a claimed node free and grant a SECOND claim at
 *    the same epoch, which `projectBoard` honours, which is 2 workers holding 1
 *    node. Deciding from the log is what makes the ordering recoverable instead
 *    of merely tidy. The projection is still read fresh here, to report whether
 *    it agreed, which is what `reconcileBoard` repairs.
 * 3. Decide with the pure predicates. On a refusal, throw a coded error and write
 *    NOTHING, so a refused claim leaves no evidence of a grant.
 * 4. APPEND THE EVENT, inside the projection lock and BEFORE the projection
 *    write.
 * 5. Write the next projection, passing the lock handle so the fence is verified
 *    immediately before the rename.
 *
 * STEPS 4 AND 5 MUST NOT BE REVERSED. If the log is written first and the process
 * dies before step 5, the log says claimed and the projection does not, and
 * folding the log produces the truth. If the projection were written first and
 * the process died, the projection would claim a hold the log never recorded, and
 * a rebuild would silently free a node a live worker believes it owns. One
 * ordering is recoverable and the other is a double holder.
 *
 * HOLD TIME. 1 log read, 1 fold, 1 append with an fsync, 1 atomic write with an
 * fsync. Milliseconds against a default budget of half of the 30 second stale
 * window, so `E_LOCK_HOLD_EXPIRED` is unreachable by construction here. No verb
 * accepts a caller supplied handle to keep open, which is what stops this
 * property from being an accident of the current call sites.
 */
function _runLeaseTransaction<T>(
  logPath: string,
  projectionPath: string,
  decide: (board: Board, projection: { readable: boolean; value: unknown }) => {
    event: Record<string, unknown>;
    result: (next: Board) => T;
  },
): T {
  if (typeof logPath !== 'string' || logPath === '') {
    throw new Error('fleet-board: logPath is required');
  }
  if (typeof projectionPath !== 'string' || projectionPath === '') {
    throw new Error('fleet-board: projectionPath is required');
  }
  return atomicState.withFileLock(projectionPath, (handle) => {
    const events = runlog.readFleetRunlog({ path: logPath });
    const current = projectBoard(events);
    const projection = _readProjectionTolerant(projectionPath);

    const { event, result } = decide(current, projection);

    runlog.appendFleetEvent(event as never, { path: logPath });
    const next = projectBoard([...events, event]);
    atomicState.atomicWriteFileSync(projectionPath, _serializeBoard(next), handle);
    return result(next);
  });
}

/** The options every lease verb shares. */
interface LeaseVerbOptions {
  logPath: string;
  projectionPath: string;
  runId: string;
  nodeId: unknown;
  workerId: unknown;
  nowMs: number;
  ttlMs?: number;
  leaseEpoch?: unknown;
  holder?: unknown;
}

/**
 * Claim a free node.
 *
 * A node with NO lease takes epoch 1. A node whose lease was RELEASED takes
 * `nextLeaseEpoch`, which is N plus 1, because 2 different holders across time
 * sharing an epoch is exactly what stops the renewal rule distinguishing them.
 *
 * A node whose lease is HELD is refused, WHETHER OR NOT that lease has expired.
 * The plan's row names the live case; the expired case is refused here too and
 * that is deliberate. Displacing a holder has exactly 1 path, `reclaimLease`,
 * and that path writes `prior_worker_id`, `prior_lease_epoch` and a reason into
 * the run record. Letting a claim quietly overwrite an expired holder would take
 * a node away from a worker while recording nothing about who lost it, which D3
 * needs and which no later reader could reconstruct.
 */
function claimNode(opts: LeaseVerbOptions): Lease {
  const nodeId = _requireId(opts.nodeId, 'nodeId');
  const workerId = _requireId(opts.workerId, 'workerId');
  const runId = _requireId(opts.runId, 'runId');
  const nowMs = _requireNowMs(opts.nowMs);
  const ttlMs = _requireTtlMs(opts.ttlMs);
  // Resolved BEFORE the lock: reading the start stamp spawns a process listing,
  // and there is no reason to spend that inside a held transaction.
  const holder = opts.holder === undefined ? currentHolder() : opts.holder;

  return _runLeaseTransaction<Lease>(opts.logPath, opts.projectionPath, (current) => {
    const lease = current.leases[nodeId];
    if (lease !== undefined && lease.state === LEASE_STATES.HELD) {
      throw _codedError(
        FLEET_BOARD_ERROR_CODES.E_FLEET_NODE_HELD,
        `fleet-board: node ${nodeId} is held by ${JSON.stringify(lease.worker_id)} at epoch `
          + `${lease.lease_epoch}. Displace a holder with reclaimLease, which records who lost the `
          + 'node and why; a claim that overwrote a holder would record neither.',
      );
    }
    const epoch = nextLeaseEpoch(current, nodeId);
    return {
      event: {
        ts: nowMs,
        kind: 'claim_acquired',
        run_id: runId,
        node_id: nodeId,
        worker_id: workerId,
        lease_epoch: epoch,
        expires_at_ms: nowMs + ttlMs,
        holder,
      },
      result: (next: Board) => next.leases[nodeId],
    };
  });
}

/**
 * Resolve the current lease for a write that requires the caller to BE the
 * holder, refusing in a FIXED order: epoch first, then identity.
 *
 * The order is not cosmetic. After a reclaim the displaced worker mismatches on
 * BOTH the epoch and the identity, and the required answer is
 * `E_FLEET_STALE_EPOCH`, because that is the fence: it tells the worker its lease
 * was taken rather than that it was never the holder. Only a fixed order makes
 * the emitted code deterministic enough for a caller, or a test, to assert on.
 * Same construction as `verifyFence` at `src/atomic-state.cts:304`.
 */
function _requireHolder(current: Board, nodeId: string, workerId: string, leaseEpoch: unknown): Lease {
  const lease = current.leases[nodeId];
  if (lease === undefined || lease.state !== LEASE_STATES.HELD) {
    throw _codedError(
      FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_HOLDER,
      `fleet-board: node ${nodeId} carries no held lease, so ${workerId} cannot be its holder`,
    );
  }
  if (lease.lease_epoch !== leaseEpoch) {
    throw _codedError(
      FLEET_BOARD_ERROR_CODES.E_FLEET_STALE_EPOCH,
      `fleet-board: node ${nodeId} is at lease epoch ${lease.lease_epoch} and the caller presented `
        + `${JSON.stringify(leaseEpoch)}. The lease was reclaimed, so this worker no longer owns it.`,
    );
  }
  if (lease.worker_id !== workerId) {
    throw _codedError(
      FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_HOLDER,
      `fleet-board: node ${nodeId} at epoch ${lease.lease_epoch} is held by `
        + `${JSON.stringify(lease.worker_id)}, not by ${workerId}`,
    );
  }
  return lease;
}

/**
 * Renew a lease by heartbeat. THE EPOCH NEVER CHANGES.
 *
 * A renewal moves `renewed_at_ms` and `expires_at_ms` and nothing else. That
 * single rule is what makes `lease_epoch` able to tell a renewal apart from a
 * reclaim after a crash, which D3 lists as a required field for exactly that
 * reason. Advance the epoch on a heartbeat and the field stops meaning anything.
 *
 * This is also the verb SC1 exists for. A worker heartbeats for as long as it
 * works, and each heartbeat takes the transaction lock and drops it again, so the
 * worker's lifetime is never inside a lock hold.
 */
function renewLease(opts: LeaseVerbOptions): Lease {
  const nodeId = _requireId(opts.nodeId, 'nodeId');
  const workerId = _requireId(opts.workerId, 'workerId');
  const runId = _requireId(opts.runId, 'runId');
  const nowMs = _requireNowMs(opts.nowMs);
  const ttlMs = _requireTtlMs(opts.ttlMs);

  return _runLeaseTransaction<Lease>(opts.logPath, opts.projectionPath, (current) => {
    const lease = _requireHolder(current, nodeId, workerId, opts.leaseEpoch);
    return {
      event: {
        ts: nowMs,
        kind: 'lease_renewed',
        run_id: runId,
        node_id: nodeId,
        worker_id: workerId,
        lease_epoch: lease.lease_epoch,
        expires_at_ms: nowMs + ttlMs,
      },
      result: (next: Board) => next.leases[nodeId],
    };
  });
}

/**
 * Release a lease cleanly, freeing the node for the next claim.
 *
 * The record survives the release rather than being deleted, because
 * `nextLeaseEpoch` reads it: a node released cleanly must hand the next holder N
 * plus 1, never 1.
 */
function releaseLease(opts: LeaseVerbOptions): Lease {
  const nodeId = _requireId(opts.nodeId, 'nodeId');
  const workerId = _requireId(opts.workerId, 'workerId');
  const runId = _requireId(opts.runId, 'runId');
  const nowMs = _requireNowMs(opts.nowMs);

  return _runLeaseTransaction<Lease>(opts.logPath, opts.projectionPath, (current) => {
    const lease = _requireHolder(current, nodeId, workerId, opts.leaseEpoch);
    return {
      event: {
        ts: nowMs,
        kind: 'lease_released',
        run_id: runId,
        node_id: nodeId,
        worker_id: workerId,
        lease_epoch: lease.lease_epoch,
      },
      result: (next: Board) => next.leases[nodeId],
    };
  });
}

/** What `reclaimLease` adds on top of the shared verb options. */
interface ReclaimOptions extends LeaseVerbOptions {
  /** Injectable liveness halves, so both arms are drivable without killing anything. */
  deps?: LivenessDeps;
}

/**
 * Take a node away from a holder that can no longer have it.
 *
 * RECLAIM HAS 2 ARMS AND NEITHER COVERS THE OTHER. An EXPIRED lease means the
 * worker stopped renewing, which catches a wedged process that is still running.
 * A DEAD holder means the worker stopped existing, which is what stops a crashed
 * worker starving its node for the rest of the run: waiting out the whole TTL on
 * a process the fleet can see is gone wastes the whole TTL, and at width 1 nobody
 * noticed because there was no second worker to starve.
 *
 * The gate is `isReclaimable`, the SAME predicate plan 02 exports and plan 04's
 * land queue consumes, rather than a rule restated here. Two rules that agree
 * today diverge on the first edit, so a stuck lander and a stuck node lease are
 * judged by 1 function or the fleet has 2 reclaim policies.
 *
 * THE PROBE IS SKIPPED WHEN THE LEASE HAS ALREADY EXPIRED. The expiry arm has
 * already answered, and a process listing inside a held transaction is work with
 * no question attached. That also makes the recorded `reason` deterministic when
 * both arms would fire.
 *
 * On success the epoch advances to `nextLeaseEpoch`, which is prior plus 1. THAT
 * ADVANCE IS THE FENCE: the displaced worker's next renewal presents the prior
 * epoch and is refused, which is the 1 mechanism stopping it from resuming as if
 * it still held the lease. `prior_worker_id`, `prior_lease_epoch` and `reason`
 * go into the run record, because a node taken from somebody with no record of
 * who lost it or why is a figure phase 22 cannot reconstruct.
 */
function reclaimLease(opts: ReclaimOptions): Lease {
  const nodeId = _requireId(opts.nodeId, 'nodeId');
  const workerId = _requireId(opts.workerId, 'workerId');
  const runId = _requireId(opts.runId, 'runId');
  const nowMs = _requireNowMs(opts.nowMs);
  const ttlMs = _requireTtlMs(opts.ttlMs);
  const holder = opts.holder === undefined ? currentHolder() : opts.holder;

  return _runLeaseTransaction<Lease>(opts.logPath, opts.projectionPath, (current) => {
    const lease = current.leases[nodeId];
    if (lease === undefined || lease.state !== LEASE_STATES.HELD) {
      throw _codedError(
        FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_RECLAIMABLE,
        `fleet-board: node ${nodeId} carries no held lease, so there is nothing to reclaim. `
          + 'A free node is CLAIMED rather than reclaimed, and the 2 are different because a '
          + 'reclaim advances the epoch and names a prior holder.',
      );
    }

    const expired = isLeaseExpired(lease, nowMs);
    const verdict = expired
      ? { alive: true, reason: 'not_probed_the_lease_had_already_expired' }
      : probeLiveness(lease.holder, opts.deps ?? {});

    if (!isReclaimable(lease, nowMs, verdict)) {
      throw _codedError(
        FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_RECLAIMABLE,
        `fleet-board: node ${nodeId} is held by ${JSON.stringify(lease.worker_id)} at epoch `
          + `${lease.lease_epoch}, its lease has not expired, and the liveness probe answered `
          + `${verdict.reason}. Taking it now would produce 2 holders.`,
      );
    }

    return {
      event: {
        ts: nowMs,
        kind: 'lease_reclaimed',
        run_id: runId,
        node_id: nodeId,
        worker_id: workerId,
        lease_epoch: nextLeaseEpoch(current, nodeId),
        prior_worker_id: lease.worker_id,
        prior_lease_epoch: lease.lease_epoch,
        reason: expired ? 'expired' : 'holder_dead',
        expires_at_ms: nowMs + ttlMs,
        holder,
      },
      result: (next: Board) => next.leases[nodeId],
    };
  });
}

/** What a reconcile pass found and what it did about it. */
interface ReconcileOutcome {
  agreed: boolean;
  rebuilt: boolean;
  board: Board;
}

/**
 * THE LOG WINS. Rebuild the projection whenever it disagrees with the fold.
 *
 * D4 states the rule plainly: if the projection and the log ever disagree, the
 * log wins and the projection is rebuilt. This is the verb that enforces it, and
 * it is what makes the log first write ordering RECOVERABLE rather than merely
 * tidy. A crash between the append and the projection write leaves the log ahead;
 * this call brings the projection back to the truth, and no event is ever
 * invented to do it.
 *
 * Comparison runs over a key sorted serialization, so a board that made a round
 * trip through a file and one built in memory are compared on content alone and
 * a reported disagreement is always a real one. An ABSENT or UNPARSEABLE
 * projection is a disagreeing projection rather than a fatal one, for the same
 * reason: the projection is derived, and a derived artifact that cannot be read
 * is simply one that has to be rebuilt.
 *
 * Everything happens under the projection lock, including the read, because a
 * compare outside the lock and a write inside it is the check then act race with
 * extra steps.
 */
function reconcileBoard(opts: { logPath: string; projectionPath: string }): ReconcileOutcome {
  const logPath = opts.logPath;
  const projectionPath = opts.projectionPath;
  if (typeof logPath !== 'string' || logPath === '') {
    throw new Error('reconcileBoard: logPath is required');
  }
  if (typeof projectionPath !== 'string' || projectionPath === '') {
    throw new Error('reconcileBoard: projectionPath is required');
  }

  return atomicState.withFileLock(projectionPath, (handle) => {
    const truth = projectBoard(runlog.readFleetRunlog({ path: logPath }));
    const materialized = _readProjectionTolerant(projectionPath);
    const agreed = materialized.readable && _canonical(materialized.value) === _canonical(truth);
    if (agreed) return { agreed: true, rebuilt: false, board: truth };
    atomicState.atomicWriteFileSync(projectionPath, _serializeBoard(truth), handle);
    return { agreed: false, rebuilt: true, board: truth };
  });
}

export = {
  LEASE_STATES,
  FLEET_BOARD_ERROR_CODES,
  projectBoard,
  isLeaseExpired,
  isReclaimable,
  nextLeaseEpoch,
  currentHolder,
  probeLiveness,
  claimNode,
  renewLease,
  releaseLease,
  reclaimLease,
  reconcileBoard,
};
