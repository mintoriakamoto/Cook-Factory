'use strict';

/**
 * Phase 19 plan 02 task 3: SC2, the deterministic level triggered manager pass.
 *
 * THE PERMUTATION BATTERY SHUFFLES BOTH ARRAYS, AND THAT IS THE WHOLE POINT.
 * `managerPass` builds its ready set by iterating `nodes`, so a battery that
 * shuffles only the completion list leaves the iteration order untouched and all
 * 24 permutations agree EVEN WITH THE SORT REMOVED. That would be 24 assertions
 * that cannot fire, which is D7's defect class wearing a larger number. So the
 * same seeded permutation shuffles `nodes` as well, and the battery additionally
 * asserts that the 24 orderings it produced are genuinely distinct, because a
 * shuffle that returns its input is a battery of 24 identical cases.
 *
 * THE DISAGREEMENT CASE CARRIES THE PROPERTY. The fixture's schedule order is the
 * exact REVERSE of its input array order, so dispatching in insertion order and
 * dispatching in schedule order give different answers. That is the case that goes
 * red the moment the sort is removed. `src/workgraph.cts:669` already establishes
 * a total order over wave, kind and id, and JavaScript's Map and Set preserve
 * insertion order, which is exactly why arrival order leaks unless the pass sorts
 * explicitly by `schedule_order`.
 *
 * THE PURITY GUARD IS AN ASSERTION IN THIS FILE, NOT A SHELL GATE. It runs on
 * every commit and it has no shell quoting to get wrong. It reads the real source,
 * strips comments, and scans for platform accessor names. 19-01's first draft of
 * the equivalent guard fired on a PROSE MENTION inside a comment and had to be
 * rebuilt, so this one is driven both ways before it is trusted: the stripper is
 * self-tested against a sample where the name appears only in a comment (must NOT
 * match) and a sample where it appears in code (MUST match), and the stripped
 * source is asserted to still contain known code anchors so an over-aggressive
 * strip cannot make the scan vacuously true.
 *
 * Every case that involves time pins BOTH `FERROX_TEST_MODE` and `FERROX_NOW_MS`.
 * `ferrox-core/bin/lib/clock.cjs:34-36` returns null unless the test mode flag is
 * set and `:60-64` falls back to the platform clock when the pin is null, so
 * setting 1 of the 2 leaves code reading real time while APPEARING pinned.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const manager = require('../ferrox-core/bin/lib/fleet-manager.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-manager.cjs');
const TS_SOURCE = path.join(REPO_ROOT, 'src', 'fleet-manager.cts');

const PINNED_NOW = 1785000000000;

function withPinnedClock(nowMs, body) {
  const priorMode = process.env.FERROX_TEST_MODE;
  const priorNow = process.env.FERROX_NOW_MS;
  process.env.FERROX_TEST_MODE = '1';
  process.env.FERROX_NOW_MS = String(nowMs);
  try {
    return body();
  } finally {
    if (priorMode === undefined) delete process.env.FERROX_TEST_MODE;
    else process.env.FERROX_TEST_MODE = priorMode;
    if (priorNow === undefined) delete process.env.FERROX_NOW_MS;
    else process.env.FERROX_NOW_MS = priorNow;
  }
}

// ---------------------------------------------------------------------------
// The seeded permutation machinery. Defined here so the battery is reproducible
// and so the module under test cannot be the thing supplying the randomness.
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
// The shared fixture. The schedule order is the exact reverse of the natural id
// order, so a pass that fell back to sorting by id would be caught too.
// ---------------------------------------------------------------------------

const BASE_NODES = Object.freeze([
  { id: 'p1', depends_on: [] },
  { id: 'p2', depends_on: [] },
  { id: 'n1', depends_on: [] },
  { id: 'n2', depends_on: [] },
  { id: 'n3', depends_on: ['p1'] },
  { id: 'n4', depends_on: ['p2'] },
  { id: 'n5', depends_on: ['p1', 'p2'] },
  { id: 'n6', depends_on: [] },
]);

const SCHEDULE = Object.freeze({
  p1: 60, p2: 70, n1: 50, n2: 40, n3: 30, n4: 20, n5: 10, n6: 0,
});

const BASE_COMPLETED = Object.freeze(['p1', 'p2']);

function passOver(nodes, completed, extra) {
  return manager.managerPass(Object.assign({
    nodes,
    schedule_order: SCHEDULE,
    completed,
    leases: [],
    capacity: 4,
    now_ms: PINNED_NOW,
  }, extra || {}));
}

// ---------------------------------------------------------------------------

test('the built artifact exists and exports the SC2 surface', () => {
  assert.ok(fs.existsSync(BUILT_LIB), `${BUILT_LIB} must be built and committed`);
  assert.equal(typeof manager.managerPass, 'function');
  assert.deepEqual(manager.FLEET_MANAGER_ERROR_CODES, {
    E_FLEET_NO_SCHEDULE_ORDER: 'E_FLEET_NO_SCHEDULE_ORDER',
    E_FLEET_BAD_NODE_ID: 'E_FLEET_BAD_NODE_ID',
  });
  assert.ok(Object.isFrozen(manager.FLEET_MANAGER_ERROR_CODES), 'the codes must be frozen');
});

test('a pass with no completed nodes dispatches the ready roots in schedule order, truncated to the free capacity', () => {
  withPinnedClock(PINNED_NOW, () => {
    const result = passOver(BASE_NODES, [], { capacity: 3 });
    // Ready roots are the 5 nodes with no prerequisites. In schedule order:
    // n6(0), n2(40), n1(50), p1(60), p2(70). Truncated to 3.
    assert.deepEqual(result.dispatch, ['n6', 'n2', 'n1']);
    assert.equal(result.free_capacity, 3);
    assert.deepEqual(result.refused, []);
  });
});

test('a node whose prerequisites are not all completed is never dispatched', () => {
  withPinnedClock(PINNED_NOW, () => {
    // p1 is completed, p2 is not. n4 needs p2 and n5 needs both, so neither is
    // ready no matter how early their schedule position is.
    const result = passOver(BASE_NODES, ['p1'], { capacity: 99 });
    assert.ok(!result.dispatch.includes('n4'), 'n4 depends on p2, which is not completed');
    assert.ok(!result.dispatch.includes('n5'), 'n5 depends on p2, which is not completed');
    assert.ok(result.dispatch.includes('n3'), 'n3 depends only on p1, which IS completed');
    assert.ok(!result.dispatch.includes('p1'), 'a completed node is not re-dispatched');
  });
});

test('a node already held by a live lease is never dispatched, so the pass is level triggered', () => {
  withPinnedClock(PINNED_NOW, () => {
    const heldEarly = passOver(BASE_NODES, BASE_COMPLETED, {
      capacity: 4,
      leases: [{ node_id: 'n6', expires_at_ms: PINNED_NOW + 1000 }],
    });
    assert.ok(!heldEarly.dispatch.includes('n6'), 'n6 is held by a live lease');
    assert.equal(heldEarly.free_capacity, 3, '1 live lease consumes 1 of the 4 slots');

    // The SAME lease, expired, no longer holds the node back. Without this arm
    // the case cannot tell "leases are honoured" from "n6 is never dispatched".
    const heldLate = passOver(BASE_NODES, BASE_COMPLETED, {
      capacity: 4,
      leases: [{ node_id: 'n6', expires_at_ms: PINNED_NOW }],
    });
    assert.ok(heldLate.dispatch.includes('n6'), 'a lease AT its deadline is expired and does not hold');
    assert.equal(heldLate.free_capacity, 4);
  });
});

test('free capacity is the supplied capacity minus the live lease count, and a pass at zero dispatches nothing without throwing', () => {
  withPinnedClock(PINNED_NOW, () => {
    const saturated = passOver(BASE_NODES, BASE_COMPLETED, {
      capacity: 2,
      leases: [
        { node_id: 'n1', expires_at_ms: PINNED_NOW + 1000 },
        { node_id: 'n2', expires_at_ms: PINNED_NOW + 1000 },
      ],
    });
    assert.equal(saturated.free_capacity, 0);
    assert.deepEqual(saturated.dispatch, [], 'nothing is dispatched and nothing is thrown');

    const oversubscribed = passOver(BASE_NODES, BASE_COMPLETED, {
      capacity: 1,
      leases: [
        { node_id: 'n1', expires_at_ms: PINNED_NOW + 1000 },
        { node_id: 'n2', expires_at_ms: PINNED_NOW + 1000 },
      ],
    });
    assert.equal(oversubscribed.free_capacity, 0, 'the count is floored at 0, never negative');
    assert.deepEqual(oversubscribed.dispatch, []);

    const zero = passOver(BASE_NODES, BASE_COMPLETED, { capacity: 0 });
    assert.equal(zero.free_capacity, 0);
    assert.deepEqual(zero.dispatch, []);
  });
});

test('24 shuffled permutations of BOTH the node array and the completion list yield a byte identical dispatch order', () => {
  withPinnedClock(PINNED_NOW, () => {
    const rand = lcg(20260726);
    const dispatches = [];
    const nodeOrderings = new Set();
    const completedOrderings = new Set();

    for (let p = 0; p < 24; p++) {
      const nodesPerm = shuffled(BASE_NODES, rand);
      const completedPerm = shuffled(BASE_COMPLETED, rand);
      nodeOrderings.add(nodesPerm.map((n) => n.id).join(','));
      completedOrderings.add(completedPerm.join(','));
      dispatches.push(passOver(nodesPerm, completedPerm).dispatch);
    }

    // A shuffle that returned its input would make this a battery of 24 identical
    // cases, which is the trivially passing shape D7 exists to reject.
    assert.equal(dispatches.length, 24);
    assert.ok(
      nodeOrderings.size >= 20,
      `the node array must genuinely vary across permutations, saw ${nodeOrderings.size} distinct orderings`,
    );
    assert.equal(
      completedOrderings.size, 2,
      'both orderings of the 2 completed nodes must appear',
    );

    for (let p = 1; p < 24; p++) {
      assert.deepEqual(
        dispatches[p], dispatches[0],
        `permutation ${p} dispatched ${JSON.stringify(dispatches[p])} but permutation 0 dispatched ${JSON.stringify(dispatches[0])}`,
      );
    }
    assert.deepEqual(dispatches[0], ['n6', 'n5', 'n4', 'n3']);
  });
});

test('a case where insertion order and schedule order DISAGREE dispatches in schedule order', () => {
  withPinnedClock(PINNED_NOW, () => {
    const nodes = [
      { id: 'alpha', depends_on: [] },
      { id: 'bravo', depends_on: [] },
      { id: 'charlie', depends_on: [] },
    ];
    const schedule = { alpha: 2, bravo: 1, charlie: 0 };

    const insertionOrder = nodes.map((n) => n.id);
    const scheduleOrder = insertionOrder.slice().sort((a, b) => schedule[a] - schedule[b]);
    assert.notDeepEqual(
      insertionOrder, scheduleOrder,
      'the 2 orders must genuinely disagree, or this case cannot fail when the sort is removed',
    );

    const result = manager.managerPass({
      nodes, schedule_order: schedule, completed: [], leases: [], capacity: 3, now_ms: PINNED_NOW,
    });
    assert.deepEqual(result.dispatch, ['charlie', 'bravo', 'alpha']);
    assert.notDeepEqual(result.dispatch, insertionOrder);
  });
});

test('ties in schedule order are broken by a plain node id string compare, not by arrival order', () => {
  withPinnedClock(PINNED_NOW, () => {
    const nodes = [
      { id: 'zulu', depends_on: [] },
      { id: 'mike', depends_on: [] },
      { id: 'alfa', depends_on: [] },
    ];
    const schedule = { zulu: 5, mike: 5, alfa: 5 };
    const result = manager.managerPass({
      nodes, schedule_order: schedule, completed: [], leases: [], capacity: 3, now_ms: PINNED_NOW,
    });
    assert.deepEqual(result.dispatch, ['alfa', 'mike', 'zulu']);
  });
});

test('a ready node absent from the supplied schedule order is REFUSED, never dispatched at the end', () => {
  withPinnedClock(PINNED_NOW, () => {
    const nodes = [
      { id: 'known', depends_on: [] },
      { id: 'orphan', depends_on: [] },
    ];
    const result = manager.managerPass({
      nodes, schedule_order: { known: 0 }, completed: [], leases: [], capacity: 9, now_ms: PINNED_NOW,
    });
    assert.deepEqual(result.dispatch, ['known']);
    assert.ok(
      !result.dispatch.includes('orphan'),
      'appending it, sorting it last, or leaving it where it sat all reintroduce arrival order',
    );
    assert.deepEqual(result.refused, [
      { node_id: 'orphan', code: manager.FLEET_MANAGER_ERROR_CODES.E_FLEET_NO_SCHEDULE_ORDER },
    ]);
  });
});

test('a node id that is not a string is refused rather than coerced onto a shared key', () => {
  withPinnedClock(PINNED_NOW, () => {
    const result = manager.managerPass({
      nodes: [
        { id: 'real', depends_on: [] },
        { id: { a: 1 }, depends_on: [] },
        { id: { a: 2 }, depends_on: [] },
      ],
      schedule_order: { real: 0 },
      completed: [], leases: [], capacity: 9, now_ms: PINNED_NOW,
    });
    assert.deepEqual(result.dispatch, ['real']);
    assert.equal(result.refused.length, 2, 'a bare coercion would collapse both onto 1 key');
    for (const row of result.refused) {
      assert.equal(row.code, manager.FLEET_MANAGER_ERROR_CODES.E_FLEET_BAD_NODE_ID);
    }
    assert.notEqual(
      result.refused[0].node_id, result.refused[1].node_id,
      '2 different malformed ids must not print the same label',
    );
  });
});

test('the refusal list is sorted, so it does not leak arrival order either', () => {
  withPinnedClock(PINNED_NOW, () => {
    const result = manager.managerPass({
      nodes: [
        { id: 'zeta', depends_on: [] },
        { id: 'alpha', depends_on: [] },
        { id: 'mid', depends_on: [] },
      ],
      schedule_order: {},
      completed: [], leases: [], capacity: 9, now_ms: PINNED_NOW,
    });
    assert.deepEqual(result.refused.map((r) => r.node_id), ['alpha', 'mid', 'zeta']);
    assert.deepEqual(result.dispatch, []);
  });
});

test('the pass called twice on the same input returns equal output and mutates neither its input nor any module state', () => {
  withPinnedClock(PINNED_NOW, () => {
    const nodes = BASE_NODES.map((n) => ({ id: n.id, depends_on: n.depends_on.slice() }));
    const completed = BASE_COMPLETED.slice();
    const schedule = Object.assign({}, SCHEDULE);
    const leases = [{ node_id: 'n1', expires_at_ms: PINNED_NOW + 10 }];
    const input = { nodes, schedule_order: schedule, completed, leases, capacity: 4, now_ms: PINNED_NOW };

    const before = JSON.stringify(input);
    const first = manager.managerPass(input);
    const second = manager.managerPass(input);

    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(input), before, 'the pass must not mutate its argument');

    // A third call after a DIFFERENT call proves no module state carried over.
    manager.managerPass({
      nodes: [{ id: 'other', depends_on: [] }],
      schedule_order: { other: 0 }, completed: [], leases: [], capacity: 1, now_ms: PINNED_NOW + 500,
    });
    assert.deepEqual(manager.managerPass(input), first, 'no state survives between passes');
  });
});

test('an empty graph dispatches nothing and refuses nothing', () => {
  const result = manager.managerPass({
    nodes: [], schedule_order: {}, completed: [], leases: [], capacity: 4, now_ms: PINNED_NOW,
  });
  assert.deepEqual(result, { dispatch: [], free_capacity: 4, refused: [] });
});

// ---------------------------------------------------------------------------
// The purity guard.
// ---------------------------------------------------------------------------

/**
 * The accessor names the SC2 module is forbidden to reach for. Named here, in the
 * test, rather than in the module, so the module cannot spell them even by
 * accident and the guard owns its own vocabulary.
 */
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

/**
 * Strip line and block comments, leaving string and template literals intact.
 *
 * Newlines are preserved so a later diagnostic can still count lines. This is a
 * small state machine rather than a regular expression on purpose: a regular
 * expression would eat a comment marker that lives inside a string literal.
 */
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
    // Inside a string or template literal.
    out += c;
    if (c === '\\') { out += (source[i + 1] === undefined ? '' : source[i + 1]); i += 2; continue; }
    if (c === state) state = 'code';
    i += 1;
  }
  return out;
}

/** Every forbidden accessor that appears in the supplied text. */
function scanForAccessors(text) {
  return FORBIDDEN_ACCESSORS.filter((name) => text.includes(name));
}

test('the purity guard itself can tell a comment from code, driven both ways before it is trusted', () => {
  // 19-01's first draft of the equivalent guard went red on a PROSE MENTION of a
  // helper inside a header comment. This is that same trap, so the stripper is
  // driven against the case where the name is present in a comment and MUST NOT
  // match, and against the case where it is present in code and MUST match.
  const inACommentOnly = [
    '/* the injected instant, described here as Date.now for the sake of this case */',
    '// and again in a line comment: process.pid, Math.random, crypto',
    'const injected = 1;',
  ].join('\n');
  assert.deepEqual(
    scanForAccessors(stripComments(inACommentOnly)), [],
    'a name inside a comment is not a name in the code',
  );

  const inCode = 'const t = Date.now();\nconst r = Math.random();\n';
  const found = scanForAccessors(stripComments(inCode));
  assert.ok(found.includes('Date'), 'a platform clock call in code MUST be found');
  assert.ok(found.includes('Math.random'), 'a randomness call in code MUST be found');

  // A comment marker inside a string literal must not start a comment.
  const markerInString = 'const s = "not // a comment";\nconst t = Date.now();\n';
  assert.ok(
    scanForAccessors(stripComments(markerInString)).includes('Date'),
    'a comment marker inside a string must not swallow the rest of the file',
  );
});

test('the SC2 module source contains no platform clock, task identity or entropy accessor', () => {
  const raw = fs.readFileSync(TS_SOURCE, 'utf8');
  const stripped = stripComments(raw);

  // An over-aggressive strip would make the scan vacuously true, which is the
  // "nothing is missing because the payload is absent entirely" shape D7 records.
  // So assert the code really survived the strip before trusting what it says.
  for (const anchor of ['managerPass', 'E_FLEET_NO_SCHEDULE_ORDER', 'candidates.sort', 'export =']) {
    assert.ok(stripped.includes(anchor), `the stripped source must still contain ${anchor}`);
  }
  assert.ok(
    stripped.split(/\r?\n/).filter((l) => l.trim() !== '').length > 60,
    'the stripped source must still be a whole module',
  );

  assert.deepEqual(
    scanForAccessors(stripped), [],
    'SC2 requires the pass be a pure function of its stated inputs, so it reaches for nothing',
  );
});

test('the built SC2 artifact imports nothing at all', () => {
  const built = fs.readFileSync(BUILT_LIB, 'utf8');
  const stripped = stripComments(built);
  assert.ok(
    !stripped.includes('require('),
    'the pass must import nothing, or the permutation battery can be influenced by something it did not vary',
  );
  assert.deepEqual(scanForAccessors(stripped), []);
});
