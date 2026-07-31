/**
 * SC2: the deterministic, level triggered manager pass (phase 19, D1 item 2 and
 * D6).
 *
 * THIS MODULE IMPORTS NOTHING. Not the graph library, not the board, not the log.
 * Every input arrives as an argument. That is not minimalism for its own sake: it
 * is what makes the shuffled permutation battery meaningful. A pass that reaches
 * out for anything at all can be influenced by something the battery did not vary,
 * and a determinism claim about a function with a hidden input is a claim about
 * nothing.
 *
 * WHAT SC2 ACTUALLY REQUIRES. "The same graph generation plus the same completion
 * events yields an identical dispatch order." D6 is explicit that driving the pass
 * twice with identical inputs is NOT enough: that proves 1 concrete serialization
 * repeats, and proves nothing about independence from the order the inputs
 * happened to arrive in, which is the property that matters when N workers
 * complete concurrently. The hidden inputs are completion event arrival order,
 * active lease state, worker capacity and ready set insertion order, and
 * JavaScript's insertion ordered collections leak the first of those unless the
 * pass sorts explicitly.
 *
 * THE SORT IS THE ENTIRE POINT. `src/workgraph.cts:669` already establishes a
 * total order over wave, kind and id, and `src/workgraph-scan.cts:248` and `:281`
 * already sort their sources, so the graph side is sound. This pass's ONLY
 * ordering job is to honour that order rather than to invent one, and its only way
 * to fail SC2 is to undo it. The supplied `schedule_order` IS that total order,
 * reaching the pass as an explicit input.
 *
 * A READY NODE WITH NO SCHEDULE ORDER IS REFUSED, NEVER DISPATCHED. Not appended,
 * not sorted last, not left where it sat in the input. Every one of those
 * fallbacks is a silent reintroduction of arrival order, which is the exact
 * property SC2 forbids. A loud refusal is recoverable and a silent reorder is not,
 * so the node goes onto `refused` with a code and the pass keeps going.
 *
 * TIME REACHES THIS MODULE ONLY AS THE `now_ms` ARGUMENT. The module holds no
 * reference to any platform instant source, to the identity of the running task,
 * or to any source of entropy, and a committed test reads this very file with its
 * comments stripped and asserts that none of those accessor names appear. Callers
 * take their instant from the injected seam the milestone already uses and pass it
 * through, exactly as `src/fleet-runlog.cts` requires of its own callers.
 *
 * LEVEL TRIGGERED, NOT EDGE TRIGGERED. The pass takes the whole world as it is now
 * and decides what should be running, rather than reacting to the event that just
 * arrived. That is why a node already held by a live lease is simply not ready:
 * re-running the pass after a lost event, a crash or a restart produces the same
 * answer as running it once, so a dropped notification costs nothing.
 *
 * ADR-457 build-at-publish: this TS source compiles to the artifact
 * ferrox-core/bin/lib/fleet-manager.cjs, which is TRACKED and committed. CJS
 * module shape (`export =`). The module owns NO stdout.
 */

/**
 * The coded refusals, frozen. Callers branch on a code, never on prose.
 *
 * `E_FLEET_NO_SCHEDULE_ORDER` is the SC2 refusal: the node is ready but the caller
 * supplied no position for it, and inventing one is the leak.
 *
 * `E_FLEET_BAD_NODE_ID` refuses a node id that is not a string rather than
 * coercing it. A bare coercion maps every object onto the same key, so 2 distinct
 * nodes would collapse into 1 and the second would silently never be dispatched.
 * That defect is invisible in the output, which is why it is refused at the door.
 */
const FLEET_MANAGER_ERROR_CODES = Object.freeze({
  E_FLEET_NO_SCHEDULE_ORDER: 'E_FLEET_NO_SCHEDULE_ORDER',
  E_FLEET_BAD_NODE_ID: 'E_FLEET_BAD_NODE_ID',
});

/** One node of the graph generation the pass is deciding over. */
interface ManagerNode {
  id: unknown;
  depends_on?: unknown;
}

/** One active lease, reduced to the 2 fields the pass reads. */
interface ManagerLease {
  node_id: unknown;
  expires_at_ms?: unknown;
}

/** Everything the pass is allowed to know. */
interface ManagerInput {
  nodes?: readonly ManagerNode[];
  schedule_order?: Record<string, unknown> | null;
  completed?: readonly unknown[];
  leases?: readonly ManagerLease[];
  capacity?: unknown;
  now_ms?: unknown;
}

/** A node the pass declined to dispatch, and why. */
interface Refusal {
  node_id: string;
  code: string;
}

/** What the pass decided. */
interface ManagerResult {
  dispatch: string[];
  free_capacity: number;
  refused: Refusal[];
}

/** A ready node paired with its position in the supplied total order. */
interface Candidate {
  id: string;
  order: number;
}

/**
 * Is this lease still live at the supplied instant.
 *
 * Live means the instant has NOT reached the deadline. The boundary is the same
 * one `src/fleet-board.cts` uses: a lease is expired AT its stated deadline, not 1
 * millisecond after it, because an off by 1 here is the difference between a
 * reclaim and 2 workers on 1 node.
 *
 * A lease with no readable deadline counts as LIVE, which is the safe direction
 * and matches the board. Treating an unreadable deadline as already past would
 * dispatch a second worker onto a node somebody is holding, and that corrupts a
 * worktree unrecoverably, while treating it as live merely wedges the node, which
 * is visible and is what the reclaim path exists to clear.
 */
function _isLive(lease: ManagerLease, nowMs: number): boolean {
  const expires = lease.expires_at_ms;
  if (typeof expires !== 'number' || !Number.isFinite(expires)) return true;
  return nowMs < expires;
}

/**
 * A supplied value as a read only list, or an empty one.
 *
 * Every list this module reads arrives from a caller and is therefore untrusted in
 * both shape and order. Funnelling them through 1 helper keeps the element type
 * `unknown`, which forces every field read below to be checked rather than
 * assumed. A missing list is an empty list, never a throw: a pass over a graph
 * with no leases is a completely normal pass.
 */
function _asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** A capacity as a non-negative integer count, defaulting to 0. */
function _toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const floored = value < 0 ? 0 : value - (value % 1);
  return floored;
}

/**
 * Run 1 manager pass.
 *
 * The rules, in this order and no other:
 *
 *   1. Compute the live lease set using only `now_ms` against `expires_at_ms`.
 *   2. Compute the ready set: every node not in `completed`, not held by a live
 *      lease, all of whose `depends_on` entries are in `completed`.
 *   3. Refuse any ready node with no entry in `schedule_order`.
 *   4. Sort the remaining ready set by `schedule_order`, breaking ties by node id
 *      as a plain string compare.
 *   5. Truncate to `capacity` minus the live lease count, floored at 0.
 *
 * Pure over its argument. It mutates neither its input nor any module state, and
 * 2 calls on the same input return equal results because there is no state for the
 * first call to leave behind.
 */
function managerPass(input: ManagerInput | null | undefined): ManagerResult {
  const source = (input === null || input === undefined) ? {} : input;
  const nodes = _asArray(source.nodes);
  const scheduleOrder = (source.schedule_order !== null && typeof source.schedule_order === 'object')
    ? source.schedule_order
    : {};
  const leases = _asArray(source.leases);
  const nowMs = typeof source.now_ms === 'number' && Number.isFinite(source.now_ms)
    ? source.now_ms
    : 0;

  const completed = new Set<string>();
  for (const id of _asArray(source.completed)) {
    if (typeof id === 'string') completed.add(id);
  }

  const heldByLiveLease = new Set<string>();
  let liveLeaseCount = 0;
  for (const raw of leases) {
    if (raw === null || typeof raw !== 'object') continue;
    const lease = raw as ManagerLease;
    if (!_isLive(lease, nowMs)) continue;
    liveLeaseCount += 1;
    if (typeof lease.node_id === 'string') heldByLiveLease.add(lease.node_id);
  }

  const candidates: Candidate[] = [];
  const refused: Refusal[] = [];

  for (const raw of nodes) {
    if (raw === null || typeof raw !== 'object') continue;
    const node = raw as ManagerNode;
    const id = node.id;
    if (typeof id !== 'string') {
      refused.push({ node_id: _describe(id), code: FLEET_MANAGER_ERROR_CODES.E_FLEET_BAD_NODE_ID });
      continue;
    }
    if (completed.has(id)) continue;
    if (heldByLiveLease.has(id)) continue;

    let ready = true;
    for (const dep of _asArray(node.depends_on)) {
      if (typeof dep !== 'string' || !completed.has(dep)) { ready = false; break; }
    }
    if (!ready) continue;

    const position = scheduleOrder[id];
    if (typeof position !== 'number' || !Number.isFinite(position)) {
      refused.push({ node_id: id, code: FLEET_MANAGER_ERROR_CODES.E_FLEET_NO_SCHEDULE_ORDER });
      continue;
    }
    candidates.push({ id, order: position });
  }

  // The sort SC2 lives or dies on. Explicit, total, and over the supplied order
  // rather than over the order the candidates were collected in.
  candidates.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  refused.sort((a, b) => {
    if (a.node_id < b.node_id) return -1;
    if (a.node_id > b.node_id) return 1;
    if (a.code < b.code) return -1;
    if (a.code > b.code) return 1;
    return 0;
  });

  const capacity = _toCount(source.capacity);
  const freeCapacity = capacity - liveLeaseCount < 0 ? 0 : capacity - liveLeaseCount;

  const dispatch: string[] = [];
  for (const candidate of candidates) {
    if (dispatch.length >= freeCapacity) break;
    dispatch.push(candidate.id);
  }

  return { dispatch, free_capacity: freeCapacity, refused };
}

/**
 * A stable label for a node id that is not a string, used ONLY in a refusal row.
 *
 * It never becomes a dispatch key. A refusal has to say WHICH node it refused or
 * it is not diagnostic, and 2 different malformed ids must not print the same
 * label, or the refusal list silently collapses the way the ids themselves would
 * have.
 */
function _describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded === 'string') return encoded;
  } catch {
    /* fall through to the typeof label below */
  }
  return `<${typeof value}>`;
}

export = {
  FLEET_MANAGER_ERROR_CODES,
  managerPass,
};
