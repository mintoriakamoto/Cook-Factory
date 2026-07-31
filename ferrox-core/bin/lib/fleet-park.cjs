"use strict";
/**
 * SC1, the pure half: the exact downstream subtree, deterministic critical path
 * membership, and the park state folded out of the run log (phase 20, D7 and D8).
 *
 * THIS MODULE IMPORTS NOTHING. Not the graph library, not the log, not the board.
 * Every input arrives as an argument, it reads no clock and no task identity, and
 * it owns no stdout. That is not minimalism for its own sake, and it is the same
 * discipline `src/fleet-manager.cts` states in its own header: the shuffled
 * permutation battery in `tests/fleet-park.test.cjs` asserts that 2 runs over the
 * same document agree, and a determinism claim about a function with a hidden
 * input is a claim about nothing.
 *
 * WHAT SC1 ACTUALLY REQUIRES. "A parked task marks its downstream subtree blocked
 * on human, and a critical path park alarms synchronously." Both halves are
 * claims about the GRAPH, so neither can be wired into the driver until the graph
 * answers them the same way twice. This module is that answer.
 *
 * EDGE DIRECTION, STATED ONCE SO NOTHING DOWNSTREAM GUESSES IT. The `workgraph/v1`
 * document emits an edge as `{ from, to, declared }` where `from` is the
 * DEPENDENT and `to` is the PREREQUISITE (`src/workgraph.cts:644-652`; phase 19
 * emits `{ from: "19-02", to: "19-01" }` and 19-02 is the plan that declares
 * `depends_on: [19-01]`, and `scripts/fleet-loop.cjs:977` reads it the same way).
 * So the DOWNSTREAM subtree of node X is every node reachable from X by walking
 * edges BACKWARDS, from `to` to `from`. Getting this inverted produces a
 * plausible looking answer that is exactly wrong, which is why the battery's
 * fixture has 2 sides that are not symmetric.
 *
 * AN EMPTY ANSWER IS NEVER A SUBSTITUTE FOR A REFUSAL. An unknown node id is
 * refused with a code rather than answered with an empty array, because an empty
 * array is what a LEAF returns, and a caller that cannot tell a leaf from a typo
 * marks nothing blocked and reports success. That is the vacuous empty payload
 * this repository has already been bitten by twice, and CONTEXT D8 names it as a
 * trivial pass with a required failing arm.
 *
 * MARKING IS EXACT IN BOTH DIRECTIONS (D7.3). Every transitive descendant is
 * named and nothing that is not a descendant is named. Over marking is as wrong
 * as under marking, because the point of the mark is that the graph shows the
 * truly reachable work.
 *
 * THE TIE BREAK HONOURS AN EXISTING TOTAL ORDER RATHER THAN INVENTING A SECOND
 * ONE (D7.4). `src/workgraph.cts:669` already establishes a total order over
 * wave, then seam before plan, then id, and it reaches this module as each node's
 * `schedule_order` field. Among all chains of maximal length the selected one is
 * the chain whose sequence of `schedule_order` values is smallest read left to
 * right.
 *
 * ADR-457 build-at-publish: this TS source compiles to the artifact
 * ferrox-core/bin/lib/fleet-park.cjs, which is TRACKED and committed (the
 * gitignore at `.gitignore:68` lists artifacts per file, so a NEW lib is tracked
 * by default). CJS module shape (`export =`). The module owns NO stdout.
 */
/**
 * The coded refusals, frozen. Callers branch on a code, never on prose.
 *
 * `E_FLEET_PARK_UNKNOWN_NODE` is the refusal that keeps a typo from reading as a
 * leaf. It also fires for an edge naming an endpoint the document does not carry:
 * an edge into nowhere cannot contribute a descendant a caller could act on, and
 * dropping it quietly would shrink the subject set the way CONTEXT C2 records a
 * live lint doing today.
 *
 * `E_FLEET_PARK_CYCLE` is the T-20-13 refusal. A cycle in the declared edges is
 * refused rather than walked until the runtime gives up.
 *
 * `E_FLEET_PARK_NO_SCHEDULE_ORDER` refuses a node with no numeric
 * `schedule_order` rather than defaulting one, for the reason
 * `src/fleet-manager.cts:215` already gives: any fallback silently reintroduces
 * input order, and a silent reorder is not recoverable while a loud refusal is.
 */
const FLEET_PARK_ERROR_CODES = Object.freeze({
    E_FLEET_PARK_UNKNOWN_NODE: 'E_FLEET_PARK_UNKNOWN_NODE',
    E_FLEET_PARK_CYCLE: 'E_FLEET_PARK_CYCLE',
    E_FLEET_PARK_NO_SCHEDULE_ORDER: 'E_FLEET_PARK_NO_SCHEDULE_ORDER',
});
/**
 * The park budget, from CONTEXT D7.1. At the budget the fleet raises 1 loud alarm
 * rather than stalling quietly, which is the livelock the brainstorm's audit
 * found.
 */
const DEFAULT_PARK_BUDGET = 3;
/**
 * Attach a code to an Error so callers branch on a code rather than matching on
 * prose. Shape copied from `src/fleet-runlog.cts:174`.
 */
function _codedError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}
/**
 * A supplied value as a read only list, or an empty one.
 *
 * Every list here arrives from a caller and is therefore untrusted in both shape
 * and order, which is the trust boundary the plan's threat model names. A missing
 * list is an empty list, never a throw: a document with no edges is a completely
 * normal document.
 */
function _asArray(value) {
    return Array.isArray(value) ? value : [];
}
/** A plain string compare, the same one the total order in workgraph.cts uses. */
function _compareStrings(a, b) {
    if (a < b)
        return -1;
    if (a > b)
        return 1;
    return 0;
}
/**
 * Build the derived view of a document, once.
 *
 * Two things happen here that make every later answer independent of the order
 * the input arrived in: the id list is sorted, and every adjacency list is
 * sorted. JavaScript's collections are insertion ordered, so without both of
 * those a walk leaks the order of the arrays it was handed, which is the exact
 * property the shuffled permutation battery exists to catch.
 *
 * Only edges with `declared === true` are followed, matching `graphInputs` at
 * `scripts/fleet-loop.cjs:978`.
 */
function _index(document) {
    const source = (document === null || document === undefined) ? {} : document;
    const ids = new Set();
    const scheduleOrder = new Map();
    for (const raw of _asArray(source.nodes)) {
        if (raw === null || typeof raw !== 'object')
            continue;
        const node = raw;
        if (typeof node.id !== 'string' || node.id === '')
            continue;
        if (ids.has(node.id))
            continue;
        ids.add(node.id);
        scheduleOrder.set(node.id, node.schedule_order);
    }
    const dependents = new Map();
    for (const id of ids)
        dependents.set(id, []);
    for (const raw of _asArray(source.edges)) {
        if (raw === null || typeof raw !== 'object')
            continue;
        const edge = raw;
        if (edge.declared !== true)
            continue;
        for (const endpoint of [edge.from, edge.to]) {
            if (typeof endpoint !== 'string' || !ids.has(endpoint)) {
                throw _codedError(FLEET_PARK_ERROR_CODES.E_FLEET_PARK_UNKNOWN_NODE, `fleet-park: a declared edge names ${JSON.stringify(endpoint)}, which is not a node of this document. `
                    + 'An edge into nowhere cannot contribute a descendant a caller could act on, and dropping it quietly '
                    + 'would shrink the subject set without saying so.');
            }
        }
        dependents.get(edge.to).push(edge.from);
    }
    for (const list of dependents.values())
        list.sort(_compareStrings);
    return {
        ids,
        sortedIds: [...ids].sort(_compareStrings),
        dependents,
        scheduleOrder,
    };
}
/** Refuse an id the document does not carry. See the header. */
function _requireKnown(index, nodeId) {
    if (typeof nodeId === 'string' && index.ids.has(nodeId))
        return nodeId;
    throw _codedError(FLEET_PARK_ERROR_CODES.E_FLEET_PARK_UNKNOWN_NODE, `fleet-park: ${JSON.stringify(nodeId)} is not a node of this document. An empty subtree is what a LEAF `
        + 'returns, so answering with one here would let a typo read as success and mark nothing blocked.');
}
const _WHITE = 0;
const _GREY = 1;
const _BLACK = 2;
/**
 * Walk the downstream adjacency from `roots`, refusing a cycle rather than
 * traversing it.
 *
 * Iterative and over an explicit colour map, so a cycle terminates the walk with
 * a refusal instead of recursing until the runtime gives up (T-20-13). GREY means
 * "on the current stack": reaching a GREY node is by definition a cycle, and the
 * refusal names the nodes on it so the repair is obvious.
 *
 * The post order is recorded because it is exactly the order the longest chain
 * arithmetic needs: a node turns BLACK only after every 1 of its dependents has,
 * so reading the list left to right visits children before parents.
 */
function _walk(index, roots) {
    const colour = new Map();
    const reached = new Set();
    const postorder = [];
    for (const root of roots) {
        if ((colour.get(root) ?? _WHITE) !== _WHITE)
            continue;
        const stack = [{ id: root, next: 0 }];
        colour.set(root, _GREY);
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const kids = index.dependents.get(frame.id) ?? [];
            if (frame.next >= kids.length) {
                colour.set(frame.id, _BLACK);
                postorder.push(frame.id);
                stack.pop();
                continue;
            }
            const kid = kids[frame.next];
            frame.next += 1;
            const seen = colour.get(kid) ?? _WHITE;
            if (seen === _GREY) {
                const at = stack.findIndex((f) => f.id === kid);
                const loop = stack.slice(at < 0 ? 0 : at).map((f) => f.id).concat([kid]);
                throw _codedError(FLEET_PARK_ERROR_CODES.E_FLEET_PARK_CYCLE, `fleet-park: the declared edges carry a cycle, ${loop.join(' -> ')}. A longest chain is undefined over `
                    + 'a cycle and a descendant set over one is unbounded, so this is refused at the door rather than '
                    + 'walked until the runtime gives up.');
            }
            reached.add(kid);
            if (seen === _BLACK)
                continue;
            colour.set(kid, _GREY);
            stack.push({ id: kid, next: 0 });
        }
    }
    return { reached, postorder };
}
/**
 * Every transitive DEPENDENT of `nodeId`, by id, sorted.
 *
 * This is the "downstream subtree" of SC1 and D7.3: exact in both directions.
 * The parked node itself is never in its own subtree.
 *
 * Refuses `E_FLEET_PARK_UNKNOWN_NODE` for an id the document does not carry, and
 * `E_FLEET_PARK_CYCLE` for a cycle reached on the walk. A cycle somewhere else in
 * the document does not refuse a query over an acyclic region, because the
 * detection happens on the walk rather than over the whole graph.
 */
function descendantSubtree(document, nodeId) {
    const index = _index(document);
    const root = _requireKnown(index, nodeId);
    const walked = _walk(index, [root]);
    walked.reached.delete(root);
    return [...walked.reached].sort(_compareStrings);
}
/**
 * The union of the descendant subtrees of every parked id, EXCLUDING the parked
 * ids themselves.
 *
 * A parked node is PARKED, not blocked. Folding it into the blocked set would
 * double count it in every figure phase 22 derives from these 2 numbers, so the
 * exclusion is part of the contract rather than a convenience.
 */
function blockedSubtree(document, parkedIds) {
    const index = _index(document);
    const parked = [];
    for (const raw of _asArray(parkedIds))
        parked.push(_requireKnown(index, raw));
    parked.sort(_compareStrings);
    const walked = _walk(index, parked);
    for (const id of parked)
        walked.reached.delete(id);
    return [...walked.reached].sort(_compareStrings);
}
/** The numeric schedule order of a node, or a refusal. */
function _orderOf(index, id) {
    const value = index.scheduleOrder.get(id);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw _codedError(FLEET_PARK_ERROR_CODES.E_FLEET_PARK_NO_SCHEDULE_ORDER, `fleet-park: node ${JSON.stringify(id)} carries no numeric schedule_order, so the tie break has no total `
            + 'order to read. Defaulting one would silently reintroduce the order the input happened to arrive in, '
            + 'which is the 1 property this predicate exists to be free of.');
    }
    return value;
}
/**
 * Is chain `a` better than chain `b`: longer first, then the smallest order
 * sequence read left to right.
 *
 * The 2 sequences are only ever compared when they are of equal length, so the
 * element by element read is well defined. D7.4 fixes this rule, and the order it
 * reads is the one `src/workgraph.cts:669` already computed.
 */
function _better(a, b) {
    if (a.orders.length !== b.orders.length)
        return a.orders.length > b.orders.length;
    for (let i = 0; i < a.orders.length; i++) {
        if (a.orders[i] !== b.orders[i])
            return a.orders[i] < b.orders[i];
    }
    return false;
}
/**
 * A longest chain of declared edges, ordered from the deepest prerequisite to the
 * final dependent.
 *
 * The arithmetic, in this order and no other:
 *
 *   1. Every node is checked for a numeric `schedule_order` FIRST, over the
 *      sorted id list, so the refusal a malformed document produces is the same
 *      one whatever order its nodes arrived in.
 *   2. The whole graph is walked for a cycle, so a chain is only computed over a
 *      document where "longest" is defined at all.
 *   3. The best chain STARTING at each node is built in reverse topological
 *      order: the best chain from n is n followed by the best chain from
 *      whichever of its dependents wins `_better`. Every candidate suffix shares
 *      the same first element, so comparing whole sequences reduces to comparing
 *      suffixes, and the local decision is the global one.
 *   4. The answer is the best chain over every starting node.
 *
 * An empty document returns an empty chain. That answer is distinguishable from
 * a real one: a document with any node at all returns a chain of at least 1 node,
 * because a single node is a chain of 0 edges.
 */
function criticalPath(document) {
    const index = _index(document);
    if (index.sortedIds.length === 0)
        return [];
    const orders = new Map();
    for (const id of index.sortedIds)
        orders.set(id, _orderOf(index, id));
    const walked = _walk(index, index.sortedIds);
    const best = new Map();
    for (const id of walked.postorder) {
        let winner = null;
        for (const kid of index.dependents.get(id) ?? []) {
            const candidate = best.get(kid);
            if (winner === null || _better(candidate, winner))
                winner = candidate;
        }
        const order = orders.get(id);
        best.set(id, winner === null
            ? { ids: [id], orders: [order] }
            : { ids: [id, ...winner.ids], orders: [order, ...winner.orders] });
    }
    let answer = null;
    for (const id of index.sortedIds) {
        const candidate = best.get(id);
        if (answer === null || _better(candidate, answer))
            answer = candidate;
    }
    return [...answer.ids];
}
/**
 * Is `nodeId` on the critical path of this document.
 *
 * The chain is computed ONCE and membership is tested against it, rather than
 * recomputed per node, so 2 calls inside 1 pass cannot disagree.
 *
 * An unknown id is REFUSED rather than answered false, for the same reason
 * `descendantSubtree` refuses one: a typo that quietly answers false routes a
 * critical path park through the queue and the synchronous alarm never fires.
 */
function onCriticalPath(document, nodeId) {
    const index = _index(document);
    const target = _requireKnown(index, nodeId);
    return criticalPath(document).includes(target);
}
/**
 * The park state of a run, recomputed from its events on every call.
 *
 * THE COUNT IS DERIVED, NEVER MAINTAINED (D7.2, and phase 19's D4 applied without
 * amendment). Nothing in this module and nothing in the driver keeps a running
 * total: the number is recomputed from the events every pass. A derived counter
 * cannot drift from its events; a maintained one eventually always does.
 *
 * SCOPED BY RUN ID, following `scopedToRun` at `scripts/fleet-loop.cjs:1031`. A
 * log holding 2 runs whose park counts were merged would describe no run that
 * happened, which is the FF-B121 shape that file already documents on the write
 * side. An absent run id folds EVERYTHING, which is what a caller inspecting a
 * log holding exactly 1 run wants.
 *
 * A NODE PARKED TWICE IS 1 PARKED NODE. The budget is a budget over PARKED NODES,
 * so `parked` is a set. A count over raw events would silently double a retry.
 *
 * `budget_alarm_due` is true when the count is AT OR ABOVE the budget AND no
 * `park_alarm` with scope `budget` already exists for this run. That second half
 * is what makes the alarm fire once rather than on every pass afterwards, and it
 * is derived from the log for the same reason the count is. A `node` scoped alarm
 * never silences it: the 2 scopes answer different questions.
 *
 * `on_critical_path` is READ OFF the recorded `node_parked` event and is NEVER
 * recomputed from a graph here, which is why this function takes no document at
 * all. The graph at fold time may not be the graph at park time, and a figure that
 * changes when you re read it is not evidence. The writer computes it once, at the
 * park, with `onCriticalPath` above. A node parked twice with a changed flag
 * reports the LAST recorded value, so the answer is a function of the log rather
 * than of which record happened to be looked at first.
 *
 * A budget that is not a finite number falls back to `DEFAULT_PARK_BUDGET`. That
 * is a default over an ABSENT input rather than over a wrong one, which is the
 * distinction `_orderOf` above refuses on: there is no order to silently
 * reintroduce here, only a policy number the caller may decline to state.
 */
function foldParkState(events, options = {}) {
    const opts = (options === null || options === undefined) ? {} : options;
    const runId = typeof opts.runId === 'string' && opts.runId !== '' ? opts.runId : null;
    const budget = typeof opts.budget === 'number' && Number.isFinite(opts.budget)
        ? opts.budget
        : DEFAULT_PARK_BUDGET;
    const critical = new Map();
    let alarmed = false;
    for (const raw of _asArray(events)) {
        if (raw === null || typeof raw !== 'object')
            continue;
        const event = raw;
        if (runId !== null && event.run_id !== runId)
            continue;
        if (event.kind === 'node_parked') {
            if (typeof event.node_id !== 'string')
                continue;
            critical.set(event.node_id, event.on_critical_path === true);
            continue;
        }
        if (event.kind === 'park_alarm' && event.scope === 'budget')
            alarmed = true;
    }
    const parked = [...critical.keys()].sort(_compareStrings);
    const on = [];
    const off = [];
    for (const id of parked) {
        if (critical.get(id) === true)
            on.push(id);
        else
            off.push(id);
    }
    return {
        parked,
        park_count: parked.length,
        budget,
        budget_alarm_due: parked.length >= budget && !alarmed,
        alarmed,
        on_critical_path: { on, off },
    };
}
module.exports = {
    FLEET_PARK_ERROR_CODES,
    DEFAULT_PARK_BUDGET,
    descendantSubtree,
    blockedSubtree,
    criticalPath,
    onCriticalPath,
    foldParkState,
};
