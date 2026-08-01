'use strict';

/**
 * Phase 26 plan 01 (v1.17 GRAPH ENGINEERING): v1.17 REPORTS, IT DOES NOT
 * REORDER, stated as a PROPERTY rather than as an absence.
 *
 * Success criterion 2 of this phase is that `computeSchedule` is UNCHANGED, and
 * the milestone calls that a criterion rather than an omission. A source hash
 * pin over the function would prove the BYTES did not move and would say
 * nothing about what the bytes DO, while the risk the criterion exists to catch
 * is somebody WIRING an edge verdict into scheduling. A pin is green for a
 * scheduler that reads a verdict through a helper in another file.
 *
 * So the property is asserted directly: the SAME node set, scheduled 3 times
 * with every edge labelled `backed`, then `unbacked`, then `unproven` and
 * nothing else changed, must produce 1 schedule. An `unbacked` verdict is a
 * statement about the SCAN and not about intent (`src/workgraph.cts:1224-1227`),
 * and the corpus adjudicates COMPLETED phases against TODAY's tree while the
 * scheduler acts BEFORE a phase executes, so a verdict reaching the scheduler
 * would reorder live work on the strength of a retrospective measurement.
 *
 * THE ARM IS KNOWN TO BE ABLE TO FIRE. The same comparison is driven against
 * `scheduleFilteringUnbacked`, a WRONG scheduler built in this file as a wrapper
 * over the real function, which drops every edge that is not `backed` and
 * re-derives the waves from what survives. That is the most likely wrong
 * implementation somebody would reach for, and it is OBSERVED failing the
 * comparison here. `src/workgraph.cts` is not edited to produce it: a guard that
 * needs the source bent to fire is a guard that has changed the subject.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB_DIR = path.join(path.resolve(__dirname, '..'), 'ferrox-core', 'bin', 'lib');
const lib = require(path.join(LIB_DIR, 'workgraph.cjs'));

/* ------------------------------------------------------------------------ *
 * The fixture
 * ------------------------------------------------------------------------ */

/**
 * A node set whose DECLARED waves and whose ID ORDER disagree, which is what
 * makes the wrong scheduler observable. `26-04` runs first and sorts last, so a
 * scheduler that loses the wave information falls back to the id compare and
 * emits a visibly different order.
 *
 * It spans 3 waves on purpose. A SINGLE WAVE SCHEDULE IS INVARIANT TO
 * EVERYTHING, so proving invariance over one would prove nothing at all.
 */
function fixtureNodes() {
  return [
    { id: '26-04', kind: 'plan', wave: 1, write_lane: ['scripts/a.cjs'], task_count: 2 },
    { id: '26-02', kind: 'seam', wave: 2, write_lane: ['scripts/b.cjs'], task_count: 2 },
    { id: '26-01', kind: 'plan', wave: 2, write_lane: ['scripts/c.cjs'], task_count: 2 },
    { id: '26-03', kind: 'plan', wave: 3, write_lane: ['scripts/d.cjs'], task_count: 2 },
  ];
}

/** The declared dependencies, as (dependent, prerequisite) pairs. */
const DECLARED_PAIRS = [
  ['26-01', '26-04'],
  ['26-02', '26-04'],
  ['26-03', '26-01'],
];

/**
 * The whole document, with every edge carrying the verdict given. THE VERDICT
 * IS THE ONLY THING THAT VARIES between the 3 runs.
 */
function documentWith(verdict) {
  return {
    schema: 'workgraph/v1',
    phase: '26',
    nodes: fixtureNodes(),
    edges: DECLARED_PAIRS.map(([from, to]) => ({
      from,
      to,
      declared: true,
      verdict,
      backing: [],
      evidence: [],
      unproven_reason: verdict === 'unproven' ? 'out-of-scan-scope' : '',
    })),
    seam_violations: [],
    seam_gaps: [],
    warnings: [],
  };
}

/* ------------------------------------------------------------------------ *
 * The 2 schedulers
 * ------------------------------------------------------------------------ */

/** The SHIPPED seam, given the whole document so both schedulers see the same input. */
function scheduleShipped(document) {
  return lib.computeSchedule(document.nodes);
}

/**
 * THE WRONG IMPLEMENTATION, built here and never in the source. It keeps only
 * `backed` edges, re-derives each wave as 1 plus the deepest surviving
 * prerequisite, and schedules that. Under an all `backed` labelling it agrees
 * with the declared waves; under any other labelling every edge is discarded,
 * the graph flattens to 1 wave and the order collapses onto the id compare.
 */
function scheduleFilteringUnbacked(document) {
  const kept = document.edges.filter((edge) => edge.verdict === 'backed');
  const prerequisites = new Map(document.nodes.map((node) => [node.id, []]));
  for (const edge of kept) {
    if (prerequisites.has(edge.from)) prerequisites.get(edge.from).push(edge.to);
  }

  const depths = new Map();
  const depthOf = (id, seen) => {
    if (depths.has(id)) return depths.get(id);
    if (seen.has(id)) return 1;
    seen.add(id);
    let deepest = 1;
    for (const prerequisite of prerequisites.get(id) ?? []) {
      deepest = Math.max(deepest, depthOf(prerequisite, seen) + 1);
    }
    depths.set(id, deepest);
    return deepest;
  };

  const rewritten = document.nodes.map((node) => ({
    ...node,
    wave: depthOf(node.id, new Set()),
  }));
  return lib.computeSchedule(rewritten);
}

/* ------------------------------------------------------------------------ *
 * The property
 * ------------------------------------------------------------------------ */

/**
 * The comparison itself, so the shipped scheduler and the wrong one are put
 * through the IDENTICAL check. It throws when the 3 labellings disagree.
 */
function assertScheduleIsInvariant(scheduler) {
  const backed = scheduler(documentWith('backed'));
  const unbacked = scheduler(documentWith('unbacked'));
  const unproven = scheduler(documentWith('unproven'));

  assert.ok(backed.schedule.length > 0, 'NON ZERO schedule before any equality claim');
  assert.deepEqual(backed, unbacked, 'a backed labelling and an unbacked one schedule identically');
  assert.deepEqual(backed, unproven, 'a backed labelling and an unproven one schedule identically');
  return backed;
}

test('the fixture spans MORE THAN 1 WAVE, so the invariance claim is not vacuous', () => {
  const { schedule } = scheduleShipped(documentWith('backed'));
  const waveById = new Map(fixtureNodes().map((node) => [node.id, node.wave]));
  const wavesInOrder = schedule.map((id) => waveById.get(id));

  assert.equal(schedule.length, 4, 'every fixture node reaches the schedule');
  assert.ok(
    new Set(wavesInOrder).size >= 2,
    'a single wave schedule is invariant to everything and would prove nothing',
  );
  for (let i = 1; i < wavesInOrder.length; i++) {
    assert.ok(
      wavesInOrder[i] >= wavesInOrder[i - 1],
      'the schedule runs the waves in order, so the wave carries real ordering information',
    );
  }
  // The id order and the wave order genuinely disagree, which is what makes a
  // scheduler that loses the wave information observable at all.
  assert.notDeepEqual(
    schedule,
    schedule.slice().sort(),
    'the schedule is not merely the ids sorted, so an id fallback is detectable',
  );
});

test('THE PROPERTY: backed, unbacked and unproven produce 1 IDENTICAL schedule', () => {
  const result = assertScheduleIsInvariant(scheduleShipped);
  assert.deepEqual(
    result.schedule,
    ['26-04', '26-02', '26-01', '26-03'],
    'and it is the declared order: wave ascending, seam before plan, then id',
  );
  // The order map is compared too, not only the id list, because a consumer
  // reads the order and a schedule that agrees on ids can still disagree there.
  assert.deepEqual(
    result.order,
    { '26-04': 0, '26-02': 1, '26-01': 2, '26-03': 3 },
    'the rank of every node is invariant as well as the sequence',
  );
});

test('THE REQUIRED FAILING ARM: the same comparison FIRES against a verdict aware scheduler', () => {
  // Observed failing before it was wrapped in this expectation, and recorded
  // verbatim in 26-01-SUMMARY.md. A guard that has never been seen failing is
  // not known to be able to fire.
  assert.throws(
    () => assertScheduleIsInvariant(scheduleFilteringUnbacked),
    (error) => error instanceof assert.AssertionError,
    'a scheduler that drops unbacked edges must FAIL the invariance comparison',
  );

  // And the difference is named rather than merely counted, so this arm cannot
  // pass on a wrapper that throws for some unrelated reason.
  const backed = scheduleFilteringUnbacked(documentWith('backed'));
  const unbacked = scheduleFilteringUnbacked(documentWith('unbacked'));
  assert.deepEqual(
    backed.schedule,
    ['26-04', '26-02', '26-01', '26-03'],
    'with every edge backed the wrong scheduler still agrees with the declared waves',
  );
  assert.deepEqual(
    unbacked.schedule,
    ['26-02', '26-01', '26-03', '26-04'],
    'and with them unbacked it reorders live work on a retrospective measurement',
  );
});

test('the shipped scheduler MUTATES NOTHING it is handed', () => {
  const document = documentWith('unbacked');
  const before = JSON.stringify(document);
  scheduleShipped(document);
  assert.equal(JSON.stringify(document), before, 'the document is unchanged by scheduling it');
});
