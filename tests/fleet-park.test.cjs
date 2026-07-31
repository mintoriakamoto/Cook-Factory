'use strict';

/**
 * Phase 20 plan 03 task 2: the exact downstream subtree and deterministic
 * critical path membership.
 *
 * CONTEXT D8 is the design of this file. Four of its rows name a trivial pass
 * that this exact subject matter invites, and each of the 4 has a REQUIRED
 * FAILING ARM below. A battery that only drives the green path is the defect this
 * phase exists to remove, so every one of the 4 is written as an observed refusal
 * or an observed discrimination rather than as an absence of a throw:
 *
 *   the subtree arm       every descendant asserted PRESENT by id AND a named non
 *                         descendant asserted ABSENT. Over marking is as wrong as
 *                         under marking, so both halves are assertions.
 *   the critical path arm the fixture carries a genuine chain AND a genuine off
 *                         chain node, and membership is asserted true for the
 *                         first and FALSE for the second. A fixture where
 *                         everything is on the path cannot fail.
 *   the shuffle arm       24 seeded permutations of BOTH the node array and the
 *                         edge array, with the variation itself asserted. Driving
 *                         the same input twice proves 1 serialization repeats and
 *                         proves nothing about independence.
 *   the cycle arm         a declared cycle is asserted to REFUSE with its code,
 *                         under a bounded timeout, so a regression to an
 *                         unbounded walk fails rather than hangs.
 *
 * EDGE DIRECTION IS ASSERTED, NOT ASSUMED. The `workgraph/v1` document emits an
 * edge as `{ from, to, declared }` where `from` is the DEPENDENT and `to` is the
 * PREREQUISITE (`src/workgraph.cts:644-652`), so the DOWNSTREAM subtree walks
 * edges backwards. Getting that inverted produces a plausible looking answer that
 * is exactly wrong, so the fixture's 2 sides are deliberately not symmetric and
 * the mid chain case below would go red under an inversion.
 *
 * THE SCHEDULE ORDER IS THE EXACT REVERSE OF THE NATURAL ID ORDER, following the
 * shape `tests/fleet-manager.test.cjs:95` established, so a tie break that fell
 * back to sorting by id would be caught here too.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const park = require('../ferrox-core/bin/lib/fleet-park.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-park.cjs');
const TS_SOURCE = path.join(REPO_ROOT, 'src', 'fleet-park.cts');

const CODES = park.FLEET_PARK_ERROR_CODES;

/** Run `fn`, return the thrown error, and fail loudly when nothing was thrown. */
function thrown(fn, why) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail(`expected a throw: ${why}`);
}

// ---------------------------------------------------------------------------
// The seeded permutation machinery, copied from tests/fleet-manager.test.cjs:72
// so the battery is reproducible and the module under test cannot be the thing
// supplying the randomness.
// ---------------------------------------------------------------------------

/** A Lehmer generator, pinned. The multiplier keeps every product exact in a double. */
function lcg(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function next() {
    s = (s * 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Fisher and Yates over a copy, driven by the seeded generator. */
function shuffled(list, rand) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The shared fixture.
//
//   a-root ── b-mid ── c-deep ── d-tip     the genuine critical path, 3 edges
//      └───── x-branch                     a genuine descendant that is OFF it
//   s-lone                                 a genuine NON descendant sibling
//
// Read prerequisite to dependent. Every schedule_order is the reverse of the id
// order, so an implementation that sorted by id would disagree with every tie
// break assertion below.
// ---------------------------------------------------------------------------

const BASE_NODES = Object.freeze([
  Object.freeze({ id: 'a-root', schedule_order: 5 }),
  Object.freeze({ id: 'b-mid', schedule_order: 4 }),
  Object.freeze({ id: 'c-deep', schedule_order: 3 }),
  Object.freeze({ id: 'd-tip', schedule_order: 2 }),
  Object.freeze({ id: 'x-branch', schedule_order: 1 }),
  Object.freeze({ id: 's-lone', schedule_order: 0 }),
]);

const BASE_EDGES = Object.freeze([
  Object.freeze({ from: 'b-mid', to: 'a-root', declared: true }),
  Object.freeze({ from: 'c-deep', to: 'b-mid', declared: true }),
  Object.freeze({ from: 'd-tip', to: 'c-deep', declared: true }),
  Object.freeze({ from: 'x-branch', to: 'a-root', declared: true }),
]);

/** The fixture as a document, optionally with permuted arrays. */
function doc(nodes = BASE_NODES, edges = BASE_EDGES) {
  return { nodes, edges };
}

const CRITICAL_CHAIN = ['a-root', 'b-mid', 'c-deep', 'd-tip'];

// ─── the built artifact exists at all ────────────────────────────────────────

test('the park library is built and committed, because every caller loads the artifact', () => {
  assert.ok(fs.existsSync(BUILT_LIB), `${BUILT_LIB} must be built and committed`);
  assert.equal(park.DEFAULT_PARK_BUDGET, 3, 'CONTEXT D7.1 fixes the default park budget at 3');
  assert.ok(Object.isFrozen(CODES), 'callers branch on a code, so the code map is frozen');
  assert.equal(CODES.E_FLEET_PARK_UNKNOWN_NODE, 'E_FLEET_PARK_UNKNOWN_NODE');
  assert.equal(CODES.E_FLEET_PARK_CYCLE, 'E_FLEET_PARK_CYCLE');
});

// ─── the subtree arm: REQUIRED FAILING ARM 1 of 4 ────────────────────────────

test('descendantSubtree names every transitive dependent by id AND excludes a named non descendant', () => {
  const found = park.descendantSubtree(doc(), 'a-root');
  assert.deepEqual(found, ['b-mid', 'c-deep', 'd-tip', 'x-branch'], 'sorted, and transitive: d-tip is 3 edges away');

  // Both halves are assertions. The first alone passes for a walk that returns
  // every node in the graph; the second alone passes for a walk that returns
  // nothing at all.
  for (const descendant of ['b-mid', 'c-deep', 'd-tip', 'x-branch']) {
    assert.ok(found.includes(descendant), `${descendant} is a transitive dependent of a-root and must be marked`);
  }
  assert.ok(
    !found.includes('s-lone'),
    's-lone depends on nothing and nothing depends on it. Over marking is as wrong as under marking, because the '
      + 'point of the mark is that the graph shows the truly reachable work (CONTEXT D7.3).',
  );
  assert.ok(!found.includes('a-root'), 'the parked node itself is parked, not one of its own descendants');
});

test('the walk follows the DEPENDENT direction: the subtree of a mid node excludes its prerequisite and its cousin', () => {
  // This case is what an inverted edge reading fails on. Under an inversion the
  // answer would be ['a-root'], which is a plausible looking non empty list.
  assert.deepEqual(park.descendantSubtree(doc(), 'b-mid'), ['c-deep', 'd-tip']);
  assert.deepEqual(park.descendantSubtree(doc(), 'x-branch'), [], 'nothing declares a dependency on x-branch');
});

test('a leaf returns an empty list and IS found, while an unknown id REFUSES, so the 2 are distinguishable', () => {
  // The vacuous empty payload this repository has already been bitten by: a
  // caller that cannot tell a leaf from a typo marks nothing blocked and reports
  // success.
  assert.deepEqual(park.descendantSubtree(doc(), 'd-tip'), [], 'd-tip is a real node with no dependents');

  const err = thrown(
    () => park.descendantSubtree(doc(), 'd-tipp'),
    'd-tipp is not a node of the graph, and an empty array is what a leaf returns',
  );
  assert.equal(err.code, CODES.E_FLEET_PARK_UNKNOWN_NODE, 'callers branch on the code, never on the prose');
  assert.match(err.message, /d-tipp/, 'the refusal names the id it could not find');

  const empty = thrown(() => park.descendantSubtree({ nodes: [], edges: [] }, 'a-root'), 'an empty graph knows no ids');
  assert.equal(empty.code, CODES.E_FLEET_PARK_UNKNOWN_NODE, 'an empty graph answers no differently from a typo');
});

test('an edge whose declared field is not true is ignored by the walk', () => {
  const edges = [
    { from: 'b-mid', to: 'a-root', declared: true },
    { from: 'c-deep', to: 'b-mid', declared: false },
    { from: 'd-tip', to: 'c-deep', declared: true },
    { from: 'x-branch', to: 'a-root', declared: true },
  ];
  assert.deepEqual(
    park.descendantSubtree(doc(BASE_NODES, edges), 'a-root'),
    ['b-mid', 'x-branch'],
    'the undeclared edge severs c-deep and d-tip, matching graphInputs at scripts/fleet-loop.cjs:978',
  );
});

test('blockedSubtree unions the descendants and EXCLUDES the parked ids, because parked is not blocked', () => {
  assert.deepEqual(park.blockedSubtree(doc(), ['b-mid']), ['c-deep', 'd-tip']);
  assert.deepEqual(
    park.blockedSubtree(doc(), ['a-root', 'b-mid']),
    ['c-deep', 'd-tip', 'x-branch'],
    'b-mid IS a descendant of a-root, but it is parked, so it is not also blocked. Counting it in both would '
      + 'double it in every figure phase 22 derives.',
  );
  assert.deepEqual(park.blockedSubtree(doc(), []), [], 'no parks, nothing blocked');
  const err = thrown(() => park.blockedSubtree(doc(), ['b-mid', 'nope']), 'nope is not a node');
  assert.equal(err.code, CODES.E_FLEET_PARK_UNKNOWN_NODE);
});

// ─── the critical path arm: REQUIRED FAILING ARM 2 of 4 ──────────────────────

test('criticalPath returns the longest chain, and membership is TRUE on it and FALSE for a named off chain node', () => {
  assert.deepEqual(park.criticalPath(doc()), CRITICAL_CHAIN, 'deepest prerequisite first, final dependent last');

  for (const onChain of CRITICAL_CHAIN) {
    assert.equal(park.onCriticalPath(doc(), onChain), true, `${onChain} is on the chain`);
  }
  // The half that makes the arm able to fire. A fixture where everything is on
  // the path cannot fail, so 2 genuine off chain nodes are asserted false.
  assert.equal(park.onCriticalPath(doc(), 'x-branch'), false, 'x-branch is a real descendant that is OFF the chain');
  assert.equal(park.onCriticalPath(doc(), 's-lone'), false, 's-lone is off the chain and off the subtree');

  const err = thrown(() => park.onCriticalPath(doc(), 'x-branchh'), 'a typo must not quietly answer false');
  assert.equal(err.code, CODES.E_FLEET_PARK_UNKNOWN_NODE);
});

test('an empty graph returns an empty chain, and any non empty graph returns a chain of at least 1 node', () => {
  assert.deepEqual(park.criticalPath({ nodes: [], edges: [] }), [], 'the empty chain occurs for the empty graph only');
  assert.deepEqual(
    park.criticalPath({ nodes: [{ id: 'only', schedule_order: 0 }], edges: [] }),
    ['only'],
    'a graph with 1 node and no edges has a chain of 1 node, which a caller tells apart from the empty answer',
  );
});

test('an edge whose declared field is not true is ignored by criticalPath', () => {
  const nodes = [
    { id: 'u-first', schedule_order: 0 },
    { id: 'v-second', schedule_order: 1 },
  ];
  const edges = [{ from: 'v-second', to: 'u-first', declared: false }];
  assert.deepEqual(
    park.criticalPath({ nodes, edges }),
    ['u-first'],
    'with no declared edge the longest chain is 1 node, and the tie falls to the smallest schedule_order',
  );
  assert.equal(park.onCriticalPath({ nodes, edges }, 'v-second'), false);
});

test('a tie between 2 chains of equal length breaks on schedule_order, not on input order and not on id', () => {
  // Two disjoint chains of exactly 1 edge each. The LATER id carries the SMALLER
  // schedule order, and its edge is supplied SECOND, so an implementation that
  // took the first chain it found, or that sorted by id, disagrees with this.
  const nodes = [
    { id: 'a-hi', schedule_order: 3 },
    { id: 'b-hi', schedule_order: 2 },
    { id: 'y-lo', schedule_order: 1 },
    { id: 'z-lo', schedule_order: 0 },
  ];
  const edges = [
    { from: 'b-hi', to: 'a-hi', declared: true },
    { from: 'z-lo', to: 'y-lo', declared: true },
  ];
  assert.deepEqual(
    park.criticalPath({ nodes, edges }),
    ['y-lo', 'z-lo'],
    'orders [1,0] read left to right beat [3,2]; src/workgraph.cts:669 is the total order this honours',
  );
});

test('a tie inside a chain breaks on the SUFFIX schedule_order, so the branch chosen is deterministic', () => {
  // One shared prerequisite, 2 dependents, neither extending. The 2 candidate
  // chains share their first element, so the decision is made entirely on the
  // suffix, which is where a naive first-match implementation leaks input order.
  const nodes = [
    { id: 'm-head', schedule_order: 0 },
    { id: 'n-alpha', schedule_order: 2 },
    { id: 'n-beta', schedule_order: 1 },
  ];
  const edges = [
    { from: 'n-alpha', to: 'm-head', declared: true },
    { from: 'n-beta', to: 'm-head', declared: true },
  ];
  assert.deepEqual(park.criticalPath({ nodes, edges }), ['m-head', 'n-beta']);
  assert.equal(park.onCriticalPath({ nodes, edges }, 'n-alpha'), false);
});

test('a node with no numeric schedule_order is REFUSED rather than defaulted', () => {
  const nodes = [
    { id: 'a-root', schedule_order: 0 },
    { id: 'b-mid' },
  ];
  const edges = [{ from: 'b-mid', to: 'a-root', declared: true }];
  const err = thrown(
    () => park.criticalPath({ nodes, edges }),
    'any fallback silently reintroduces input order, exactly as src/fleet-manager.cts:215 refuses',
  );
  assert.equal(err.code, CODES.E_FLEET_PARK_NO_SCHEDULE_ORDER);
  assert.match(err.message, /b-mid/, 'the refusal names the node so the repair is obvious');
});

// ─── the shuffle arm: REQUIRED FAILING ARM 3 of 4 ────────────────────────────

test('24 shuffled permutations of BOTH the node array and the edge array yield an identical chain', () => {
  const chains = [];
  const nodeOrderings = new Set();
  const edgeOrderings = new Set();

  for (let seed = 1; seed <= 24; seed++) {
    const rand = lcg(seed * 7919);
    const nodesPerm = shuffled(BASE_NODES, rand);
    const edgesPerm = shuffled(BASE_EDGES, rand);
    nodeOrderings.add(nodesPerm.map((n) => n.id).join(','));
    edgeOrderings.add(edgesPerm.map((e) => `${e.from}<-${e.to}`).join(','));
    chains.push(park.criticalPath(doc(nodesPerm, edgesPerm)));
  }

  // A shuffle that returned its input would make this a battery of 24 identical
  // cases, which is the "drive the same input twice" shape D6 rejects.
  assert.ok(nodeOrderings.size > 8, `the node array must genuinely vary, saw ${nodeOrderings.size} orderings`);
  assert.ok(edgeOrderings.size > 8, `the edge array must genuinely vary, saw ${edgeOrderings.size} orderings`);

  for (let p = 0; p < chains.length; p++) {
    assert.deepEqual(
      chains[p], CRITICAL_CHAIN,
      `permutation ${p} returned ${JSON.stringify(chains[p])}, so 2 runs over the same document disagree and the `
        + 'synchronous alarm route is unauditable',
    );
  }
});

test('24 shuffled permutations agree about the descendant subtree too', () => {
  const answers = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const rand = lcg(seed * 104729);
    answers.add(JSON.stringify(park.descendantSubtree(doc(shuffled(BASE_NODES, rand), shuffled(BASE_EDGES, rand)), 'a-root')));
  }
  assert.equal(answers.size, 1, `every permutation must name the same subtree, saw ${[...answers].join(' | ')}`);
  assert.deepEqual(JSON.parse([...answers][0]), ['b-mid', 'c-deep', 'd-tip', 'x-branch']);
});

// ─── the cycle arm: REQUIRED FAILING ARM 4 of 4 ──────────────────────────────

const CYCLE_NODES = Object.freeze([
  Object.freeze({ id: 'c-one', schedule_order: 0 }),
  Object.freeze({ id: 'c-two', schedule_order: 1 }),
  Object.freeze({ id: 'c-three', schedule_order: 2 }),
]);

const CYCLE_EDGES = Object.freeze([
  Object.freeze({ from: 'c-two', to: 'c-one', declared: true }),
  Object.freeze({ from: 'c-three', to: 'c-two', declared: true }),
  Object.freeze({ from: 'c-one', to: 'c-three', declared: true }),
]);

test('a declared cycle is REFUSED by descendantSubtree with its own code, not traversed', { timeout: 5000 }, () => {
  const err = thrown(
    () => park.descendantSubtree({ nodes: CYCLE_NODES, edges: CYCLE_EDGES }, 'c-one'),
    'a cycle walked until the process gives up is the denial of service in T-20-13',
  );
  assert.equal(err.code, CODES.E_FLEET_PARK_CYCLE);
  assert.match(err.message, /c-one|c-two|c-three/, 'the refusal names the nodes on the cycle');
});

test('a declared cycle is REFUSED by criticalPath with its own code, not traversed', { timeout: 5000 }, () => {
  const err = thrown(
    () => park.criticalPath({ nodes: CYCLE_NODES, edges: CYCLE_EDGES }),
    'a longest chain is undefined over a cycle, so the answer must be a refusal',
  );
  assert.equal(err.code, CODES.E_FLEET_PARK_CYCLE);
});

test('a cycle OUTSIDE the reachable region does not refuse a query about an acyclic region', { timeout: 5000 }, () => {
  const nodes = [...BASE_NODES, ...CYCLE_NODES];
  const edges = [...BASE_EDGES, ...CYCLE_EDGES];
  assert.deepEqual(
    park.descendantSubtree({ nodes, edges }, 'b-mid'),
    ['c-deep', 'd-tip'],
    'the cycle is detected on the walk, so a walk that never reaches it answers normally',
  );
});

test('a self edge is a cycle of length 1 and is refused rather than looping', { timeout: 5000 }, () => {
  const nodes = [{ id: 'self', schedule_order: 0 }];
  const edges = [{ from: 'self', to: 'self', declared: true }];
  const err = thrown(() => park.descendantSubtree({ nodes, edges }, 'self'), 'a self edge reaches its own start');
  assert.equal(err.code, CODES.E_FLEET_PARK_CYCLE);
});

// ─── purity, which is what makes every determinism claim above meaningful ────

/** Strip line and block comments, string aware. Copied from tests/fleet-manager.test.cjs:406. */
function stripComments(source) {
  let out = '';
  let state = 'code';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const d = source[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1; continue;
    }
    out += c;
    if (c === '\\') { out += (source[i + 1] === undefined ? '' : source[i + 1]); i += 2; continue; }
    if (c === state) state = 'code';
    i += 1;
  }
  return out;
}

const FORBIDDEN_ACCESSORS = Object.freeze([
  'Date',
  'performance',
  'hrtime',
  'process',
  'Math.random',
  'crypto',
  'randomUUID',
  'globalThis',
  'hostname',
  'require(',
  'import ',
]);

test('the park predicate reads no clock, no task identity and no entropy, in the source and in the artifact', () => {
  const strippedSource = stripComments(fs.readFileSync(TS_SOURCE, 'utf8'));
  // An over aggressive strip would make this scan vacuously true, which is the
  // "nothing is missing because the payload is absent entirely" shape D7 records.
  for (const anchor of ['descendantSubtree', 'criticalPath', 'E_FLEET_PARK_CYCLE', 'export =']) {
    assert.ok(strippedSource.includes(anchor), `the stripped source must still contain ${anchor}`);
  }
  assert.ok(
    strippedSource.split(/\r?\n/).filter((l) => l.trim() !== '').length > 60,
    'the stripped source must still be a whole module',
  );
  assert.deepEqual(
    FORBIDDEN_ACCESSORS.filter((name) => strippedSource.includes(name)), [],
    'CONTEXT D7.4 requires the predicate read no clock and no task identity, or the determinism claim is a claim '
      + 'about a function with a hidden input, which is a claim about nothing',
  );

  const strippedBuilt = stripComments(fs.readFileSync(BUILT_LIB, 'utf8'));
  assert.deepEqual(FORBIDDEN_ACCESSORS.filter((name) => strippedBuilt.includes(name)), []);
});
