'use strict';

/**
 * Phase 19 plan 01 task 3: the pure fold that turns the run log into the run
 * record phase 22 reads.
 *
 * THE CASE THAT MATTERS MOST IS `the unterminated interval does NOT extend to run
 * close`. D7's third named trap is a width calculation tested only on closed
 * intervals, and the ordinary way to write that case is worthless: assert the
 * width is 2 on a run where the correct answer and the wrong answer are both 2.
 * So the fixture here is built the only way that can catch the error. The run is
 * constructed so that extending the unterminated interval to `run_closed_at`
 * WOULD RAISE the width, the test COMPUTES that wrong answer with its own
 * independent sweep, asserts the wrong answer really is higher, and only then
 * asserts the fold reported the lower one. If the fold ever starts extending, the
 * numbers cross and this case goes red.
 *
 * The determinism case is shaped the same way. D6 is explicit that driving a pass
 * twice with identical inputs proves 1 concrete serialization repeats and nothing
 * more. So the fixture is expressed as independent CAUSAL STREAMS and folded
 * under many different valid interleavings of those streams, which is the
 * property that actually matters when N workers complete concurrently. A full
 * shuffle would be the wrong test: it would put a worker's end before its start,
 * which is not a permutation of the same run, it is a different run.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fold = require('../ferrox-core/bin/lib/fleet-runfold.cjs');
const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-runfold.cjs');

const RUN = 'run-a';
const UNKNOWN = fold.RUNFOLD_UNKNOWN;

const ev = (kind, ts, extra = {}) => ({ ts, kind, run_id: RUN, ...extra });

const started = (ts, worker, node, attempt, epoch = 1) =>
  ev('worker_started', ts, { worker_id: worker, node_id: node, attempt_id: attempt, lease_epoch: epoch });
const ended = (ts, worker, node, attempt, outcome = 'completed') =>
  ev('worker_ended', ts, { worker_id: worker, node_id: node, attempt_id: attempt, outcome });

/** An independent sweep, written from scratch so it cannot inherit the fold's bug. */
function sweep(intervals) {
  const points = [];
  for (const [a, b] of intervals) { points.push([a, 1]); points.push([b, -1]); }
  points.sort((p, q) => (p[0] - q[0]) || (p[1] - q[1]));
  let running = 0;
  let max = 0;
  for (const [, d] of points) { running += d; if (running > max) max = running; }
  return max;
}

/** A seeded shuffle, so a failure is reproducible rather than a coin toss. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x1_0000_0000; };
}

/**
 * A random VALID interleaving of independent causal streams: within a stream the
 * order is preserved, across streams it is not. This is the permutation D6 asks
 * for, and it is the only kind that describes the same run.
 */
function interleave(streams, rand) {
  const queues = streams.map((s) => [...s]);
  const out = [];
  for (;;) {
    const live = queues.map((q, i) => (q.length > 0 ? i : -1)).filter((i) => i >= 0);
    if (live.length === 0) return out;
    out.push(queues[live[Math.floor(rand() * live.length)]].shift());
  }
}

// ─── width, the headline figure ──────────────────────────────────────────────

test('3 workers overlapping in pairs but never all 3 at once fold to width 2, exact, with no unknowns', () => {
  // Helly's theorem for intervals says pairwise overlap of 3 intervals FORCES a
  // common point, so "all 3 pairs overlap but never all 3 at once" is impossible
  // on a line. The construction that expresses the intent is a chain: A meets B,
  // B meets C, A misses C.
  const record = fold.foldRunRecord([
    ev('run_started', 0, { graph_generation: 7 }),
    started(0, 'wA', 'nA', 'a1'), ended(20, 'wA', 'nA', 'a1'),
    started(10, 'wB', 'nB', 'a1'), ended(30, 'wB', 'nB', 'a1'),
    started(25, 'wC', 'nC', 'a1'), ended(40, 'wC', 'nC', 'a1'),
    ev('run_closed', 100),
  ]);
  assert.equal(sweep([[0, 20], [10, 30], [25, 40]]), 2, 'the fixture really does peak at 2');
  assert.deepEqual(record.demonstrated_width, { value: 2, exact: true, unknown_intervals: 0 });
  assert.equal(record.run_id, RUN);
  assert.equal(record.graph_generation, 7);
  assert.equal(record.run_started_at, 0);
  assert.equal(record.run_closed_at, 100);
  assert.deepEqual(record.workers.map((w) => w.status), ['closed', 'closed', 'closed']);
});

test('a worker with a start and no end folds to UNKNOWN, contributes nothing to the width value, and forces exact false', () => {
  const record = fold.foldRunRecord([
    ev('run_started', 0, { graph_generation: 1 }),
    started(0, 'wA', 'nA', 'a1'), ended(10, 'wA', 'nA', 'a1'),
    started(5, 'wGhost', 'nB', 'a1'), // dies here, no end event, ever
    ev('run_closed', 50),
  ]);
  assert.equal(record.demonstrated_width.value, 1, 'only the 1 closed interval is swept');
  assert.equal(record.demonstrated_width.exact, false, 'a run carrying an unknown is never exact');
  assert.equal(record.demonstrated_width.unknown_intervals, 1);

  const ghost = record.workers.find((w) => w.worker_id === 'wGhost');
  assert.equal(ghost.status, UNKNOWN, 'the status is the explicit unknown, not a guess');
  assert.equal(ghost.ended_at, null, 'no end event means no end time, not the end of the run');
  assert.equal(ghost.outcome, null);
});

test('the unterminated interval does NOT extend to run close, proven on a run where extending it would RAISE the width', () => {
  // wGhost starts at 0 and never ends. Y and Z overlap each other at [55,60].
  // If the fold extended wGhost to run_closed_at (100), all 3 would be live
  // across [55,60] and the width would read 3. The correct answer is 2.
  const events = [
    ev('run_started', 0, { graph_generation: 3 }),
    started(0, 'wGhost', 'nG', 'a1'),
    started(50, 'wY', 'nY', 'a1'), ended(60, 'wY', 'nY', 'a1'),
    started(55, 'wZ', 'nZ', 'a1'), ended(65, 'wZ', 'nZ', 'a1'),
    ev('run_closed', 100),
  ];

  // The WRONG answer, computed independently. The case is only meaningful if the
  // 2 answers actually differ, so that is asserted before anything else.
  const ifExtended = sweep([[0, 100], [50, 60], [55, 65]]);
  const correct = sweep([[50, 60], [55, 65]]);
  assert.equal(ifExtended, 3, 'extending the unterminated interval to run close would read 3');
  assert.equal(correct, 2, 'sweeping only the closed intervals reads 2');
  assert.ok(ifExtended > correct, 'the fixture must be one where the error is VISIBLE, or this case proves nothing');

  const record = fold.foldRunRecord(events);
  assert.equal(
    record.demonstrated_width.value, correct,
    'the fold reported the extended width. D3: a crashed worker with no end event makes width UNKNOWABLE, '
      + 'not approximate, and inflating the headline figure of a milestone about parallelism is the worst '
      + 'thing this module could do.',
  );
  assert.notEqual(record.demonstrated_width.value, ifExtended);
  assert.equal(record.demonstrated_width.exact, false);
  assert.equal(record.demonstrated_width.unknown_intervals, 1);
});

test('a worker ended with outcome abnormal is a CLOSED interval and does contribute to width', () => {
  const record = fold.foldRunRecord([
    started(0, 'wA', 'nA', 'a1'), ended(20, 'wA', 'nA', 'a1', 'abnormal'),
    started(10, 'wB', 'nB', 'a1'), ended(30, 'wB', 'nB', 'a1', 'failed'),
  ]);
  assert.deepEqual(record.demonstrated_width, { value: 2, exact: true, unknown_intervals: 0 },
    'an explicit abnormal end is KNOWLEDGE; the unknown case is the ABSENCE of an end event, not a bad one');
  assert.deepEqual(record.workers.map((w) => [w.outcome, w.status]), [['abnormal', 'closed'], ['failed', 'closed']]);
});

test('at an equal timestamp an end is swept before a start, so 2 touching intervals demonstrate width 1', () => {
  const record = fold.foldRunRecord([
    started(10, 'wA', 'nA', 'a1'), ended(20, 'wA', 'nA', 'a1'),
    started(20, 'wB', 'nB', 'a1'), ended(30, 'wB', 'nB', 'a1'),
  ]);
  assert.equal(record.demonstrated_width.value, 1, 'demonstrated width never rounds up');
  assert.equal(record.demonstrated_width.exact, true);
});

test('an end is matched to a start on the TRIPLE, so a second node taken by the same worker does not close the wrong interval', () => {
  // THE WIDTH CANNOT CATCH THIS, and finding that out is why this case is shaped
  // the way it is. The sweep depends only on the MULTISET of start points and end
  // points, so any pairing that leaves nothing unmatched produces the same width.
  // A first draft of this case asserted the width and survived the mutation.
  //
  // What the pairing does determine is the WORKER ROWS, so that is what is
  // asserted. And the ends are recorded in the OPPOSITE order to the starts,
  // because a FIFO queue keyed on worker_id alone still pairs correctly when the
  // ends arrive in start order, which is the second way this case could have
  // passed while proving nothing.
  const record = fold.foldRunRecord([
    started(0, 'wA', 'nA', 'a1'),
    started(5, 'wA', 'nB', 'a1'),
    ended(10, 'wA', 'nB', 'a1'),   // the SECOND node finishes FIRST
    ended(20, 'wA', 'nA', 'a1'),
  ]);
  const onA = record.workers.find((w) => w.node_id === 'nA');
  const onB = record.workers.find((w) => w.node_id === 'nB');
  assert.deepEqual([onA.started_at, onA.ended_at], [0, 20],
    'matching on worker_id alone would close nA at 10, the time nB finished');
  assert.deepEqual([onB.started_at, onB.ended_at], [5, 10],
    'matching on worker_id alone would close nB at 20, the time nA finished');
  assert.equal(record.demonstrated_width.unknown_intervals, 0);
  for (const w of record.workers) assert.equal(w.status, 'closed');
});

test('a mismatched triple leaves the RIGHT interval unknown, rather than closing a different node', () => {
  // Only 1 end arrives, and it names nB. Under a worker_id-only match the FIFO
  // would hand it to nA, so nA would look closed and nB would look unknown: the
  // unknown COUNT is 1 either way, and only naming which one is unknown catches it.
  const record = fold.foldRunRecord([
    started(0, 'wA', 'nA', 'a1'),
    started(5, 'wA', 'nB', 'a1'),
    ended(10, 'wA', 'nB', 'a1'),
  ]);
  const onA = record.workers.find((w) => w.node_id === 'nA');
  const onB = record.workers.find((w) => w.node_id === 'nB');
  assert.equal(onA.status, UNKNOWN, 'nA never ended, so nA is the unknown one');
  assert.equal(onA.ended_at, null);
  assert.equal(onB.status, 'closed', 'nB ended, so nB is the closed one');
  assert.deepEqual([onB.started_at, onB.ended_at], [5, 10]);
  assert.equal(record.demonstrated_width.unknown_intervals, 1);
});

// ─── per attempt latency ─────────────────────────────────────────────────────

test('queue_wait_ms, gate_ms and land_ms are differences of their own pairs, each null when its pair is incomplete', () => {
  const record = fold.foldRunRecord([
    ev('queue_entered', 100, { node_id: 'n1', attempt_id: 'a1', ticket: 1 }),
    ev('queue_acquired', 130, { node_id: 'n1', attempt_id: 'a1', ticket: 1, worker_id: 'w1' }),
    ev('gate_started', 140, { node_id: 'n1', attempt_id: 'a1' }),
    ev('gate_ended', 190, { node_id: 'n1', attempt_id: 'a1', verdict: 'green' }),
    ev('land_completed', 200, { node_id: 'n1', attempt_id: 'a1', result: 'landed' }),

    // Incomplete on purpose: entered but never acquired, gate started but never ended.
    ev('queue_entered', 300, { node_id: 'n2', attempt_id: 'a1', ticket: 2 }),
    ev('gate_started', 310, { node_id: 'n2', attempt_id: 'a1' }),
  ]);
  const n1 = record.nodes.find((n) => n.node_id === 'n1').attempts[0];
  assert.equal(n1.queue_wait_ms, 30, 'acquired minus entered');
  assert.equal(n1.gate_ms, 50, 'gate ended minus gate started');
  assert.equal(n1.land_ms, 70, 'land WORK is acquired to completed, which is what separates it from the queue wait');

  const n2 = record.nodes.find((n) => n.node_id === 'n2').attempts[0];
  assert.equal(n2.queue_wait_ms, null, 'an incomplete pair is null, never 0');
  assert.equal(n2.gate_ms, null);
  assert.equal(n2.land_ms, null);
  assert.equal(n2.queue_entered_at, 300, 'the endpoint that IS known is still reported');
  assert.equal(n2.gate_ended_at, null);
});

// ─── rounds, folded from events and never from a counter ──────────────────────

test('rounds_per_artifact counts distinct attempt_id values per node_id, folded from events', () => {
  const record = fold.foldRunRecord([
    ev('queue_entered', 1, { node_id: 'n1', attempt_id: 'a1', ticket: 1 }),
    ev('gate_started', 2, { node_id: 'n1', attempt_id: 'a1' }),
    ev('gate_ended', 3, { node_id: 'n1', attempt_id: 'a1', verdict: 'red' }),
    ev('queue_entered', 4, { node_id: 'n1', attempt_id: 'a2', ticket: 2 }),
    ev('queue_entered', 5, { node_id: 'n1', attempt_id: 'a3', ticket: 3 }),
    ev('queue_entered', 6, { node_id: 'n2', attempt_id: 'a1', ticket: 4 }),
    // A node named only by a claim, which carries no attempt at all.
    ev('claim_acquired', 7, { node_id: 'n3', worker_id: 'w1', lease_epoch: 1 }),
  ]);
  assert.deepEqual(record.rounds_per_artifact, { n1: 3, n2: 1, n3: 0 },
    'repeated events for 1 attempt are 1 round, and a node with no attempt is 0 rather than absent');
  assert.deepEqual(record.nodes.map((n) => n.node_id), ['n1', 'n2', 'n3'], 'nodes are sorted by node_id');
  assert.deepEqual(record.nodes[0].attempts.map((a) => a.attempt_id), ['a1', 'a2', 'a3'], 'attempts are sorted by attempt_id');
});

test('nodes and attempts are sorted by id even when they arrive in the OPPOSITE order', () => {
  // The previous case's fixture happened to arrive already sorted, so removing
  // the attempt sort left it green. A sort assertion whose fixture is already
  // sorted asserts nothing, which is D7's defect class exactly. Here arrival
  // order is strictly descending, so insertion order and sorted order differ for
  // every element.
  const record = fold.foldRunRecord([
    ev('queue_entered', 1, { node_id: 'n3', attempt_id: 'a3', ticket: 1 }),
    ev('queue_entered', 2, { node_id: 'n3', attempt_id: 'a2', ticket: 2 }),
    ev('queue_entered', 3, { node_id: 'n3', attempt_id: 'a1', ticket: 3 }),
    ev('queue_entered', 4, { node_id: 'n2', attempt_id: 'a2', ticket: 4 }),
    ev('queue_entered', 5, { node_id: 'n2', attempt_id: 'a1', ticket: 5 }),
    ev('queue_entered', 6, { node_id: 'n1', attempt_id: 'a1', ticket: 6 }),
  ]);
  assert.deepEqual(record.nodes.map((n) => n.node_id), ['n1', 'n2', 'n3'], 'nodes arrived n3, n2, n1');
  assert.deepEqual(record.nodes.find((n) => n.node_id === 'n3').attempts.map((a) => a.attempt_id),
    ['a1', 'a2', 'a3'], 'attempts arrived a3, a2, a1');
  assert.deepEqual(record.nodes.find((n) => n.node_id === 'n2').attempts.map((a) => a.attempt_id), ['a1', 'a2']);
  assert.deepEqual(Object.keys(record.rounds_per_artifact), ['n1', 'n2', 'n3'], 'the rounds map is keyed in sorted order too');
});

test('the worker match key cannot be forged by an id containing the separator', () => {
  // REGRESSION, found during this plan's own mutation battery. The composite key
  // was originally joined on a printable separator, and a printable separator
  // COLLIDES: worker `wA x` on node `nB` and worker `wA` on node `x nB` join to
  // the same string, so an end event would close a completely different worker's
  // interval and 2 short intervals would fold into 1 long one. The key is now
  // joined on NUL, which cannot occur inside a JSON string value.
  // As above, the ends are recorded in the OPPOSITE order to the starts. With the
  // ends in start order a FIFO queue pairs the colliding keys correctly by
  // accident, and the case would pass on the broken separator.
  const record = fold.foldRunRecord([
    ev('worker_started', 0, { worker_id: 'wA x', node_id: 'nB', attempt_id: 'a1', lease_epoch: 1 }),
    ev('worker_started', 5, { worker_id: 'wA', node_id: 'x nB', attempt_id: 'a1', lease_epoch: 1 }),
    ev('worker_ended', 10, { worker_id: 'wA', node_id: 'x nB', attempt_id: 'a1', outcome: 'completed' }),
    ev('worker_ended', 20, { worker_id: 'wA x', node_id: 'nB', attempt_id: 'a1', outcome: 'completed' }),
  ]);
  assert.equal(record.demonstrated_width.unknown_intervals, 0, 'both intervals closed against their OWN start');
  assert.equal(record.demonstrated_width.exact, true);
  const first = record.workers.find((w) => w.worker_id === 'wA x');
  const second = record.workers.find((w) => w.worker_id === 'wA');
  assert.deepEqual([first.started_at, first.ended_at], [0, 20],
    'joined on a space these 2 triples are the same string, and this row would close at 10');
  assert.deepEqual([second.started_at, second.ended_at], [5, 10]);
});

test('the fold reads no maintained counter: a stored count that contradicts the events is ignored', () => {
  // If the fold ever started trusting a carried figure, this record would report
  // 99 instead of 2. D4: a derived counter cannot drift from its events.
  const record = fold.foldRunRecord([
    ev('queue_entered', 1, { node_id: 'n1', attempt_id: 'a1', ticket: 1, rounds: 99, rounds_per_artifact: { n1: 99 } }),
    ev('queue_entered', 2, { node_id: 'n1', attempt_id: 'a2', ticket: 2, rounds: 99 }),
  ]);
  assert.deepEqual(record.rounds_per_artifact, { n1: 2 });
});

// ─── false green, which cannot be inferred from a gate verdict ───────────────

test('false_green counts post_land_truth classifications, and a landed attempt with no post_land_truth counts as unknown, never as held', () => {
  const record = fold.foldRunRecord([
    // held
    ev('land_completed', 10, { node_id: 'n1', attempt_id: 'a1', result: 'landed' }),
    ev('post_land_truth', 11, { node_id: 'n1', attempt_id: 'a1', classification: 'held' }),
    // false green, and note the gate said GREEN. D3: a false green rate cannot be
    // inferred from a green gate by definition, so the verdict is not consulted.
    ev('gate_ended', 19, { node_id: 'n2', attempt_id: 'a1', verdict: 'green' }),
    ev('land_completed', 20, { node_id: 'n2', attempt_id: 'a1', result: 'landed' }),
    ev('post_land_truth', 21, { node_id: 'n2', attempt_id: 'a1', classification: 'false_green' }),
    // explicitly unknown
    ev('land_completed', 30, { node_id: 'n3', attempt_id: 'a1', result: 'landed' }),
    ev('post_land_truth', 31, { node_id: 'n3', attempt_id: 'a1', classification: 'unknown' }),
    // landed, and NOTHING was ever recorded about it
    ev('gate_ended', 39, { node_id: 'n4', attempt_id: 'a1', verdict: 'green' }),
    ev('land_completed', 40, { node_id: 'n4', attempt_id: 'a1', result: 'landed' }),
  ]);
  assert.deepEqual(record.false_green, { landed: 4, later_failed: 1, unknown: 2 },
    'the silent one counts as unknown; counting it as held would let a green gate manufacture a good number');
  assert.equal(record.nodes.find((n) => n.node_id === 'n4').attempts[0].post_land_truth, null,
    'the attempt itself still reports no recorded truth, rather than an invented one');
});

// ─── FF-B121: 2 runs in 1 log ────────────────────────────────────────────────

test('with no filter and more than 1 distinct run_id the fold THROWS rather than folding 2 runs into 1 nonsense record', () => {
  const events = [
    { ts: 0, kind: 'run_started', run_id: 'run-a', graph_generation: 1 },
    { ts: 0, kind: 'worker_started', run_id: 'run-a', worker_id: 'wA', node_id: 'nA', attempt_id: 'a1', lease_epoch: 1 },
    { ts: 10, kind: 'worker_ended', run_id: 'run-a', worker_id: 'wA', node_id: 'nA', attempt_id: 'a1', outcome: 'completed' },
    { ts: 0, kind: 'run_started', run_id: 'run-b', graph_generation: 2 },
    { ts: 5, kind: 'worker_started', run_id: 'run-b', worker_id: 'wB', node_id: 'nB', attempt_id: 'a1', lease_epoch: 1 },
    { ts: 15, kind: 'worker_ended', run_id: 'run-b', worker_id: 'wB', node_id: 'nB', attempt_id: 'a1', outcome: 'completed' },
  ];

  let err = null;
  try { fold.foldRunRecord(events); } catch (e) { err = e; }
  assert.ok(err !== null, 'an unfiltered fold over 2 runs must refuse');
  assert.equal(err.code, fold.RUNFOLD_ERROR_CODES.E_FLEET_MULTIPLE_RUNS, 'callers branch on the code');
  assert.match(err.message, /run-a/);
  assert.match(err.message, /run-b/);

  // Note what the silent alternative would have produced: the 2 runs interleave
  // in wall clock, so folding them together reads width 2 for a pair of runs that
  // each demonstrated width 1. That is the nonsense record the throw prevents.
  const a = fold.foldRunRecord(events, { run_id: 'run-a' });
  const b = fold.foldRunRecord(events, { run_id: 'run-b' });
  assert.equal(a.demonstrated_width.value, 1);
  assert.equal(b.demonstrated_width.value, 1);
  assert.equal(a.graph_generation, 1, 'only run_started carries graph_generation, and the filter picks the right one');
  assert.equal(b.graph_generation, 2);
  assert.equal(a.run_id, 'run-a');
  assert.equal(b.run_id, 'run-b');
  assert.equal(a.workers.length, 1, 'the other run\'s worker is not in this record');
  assert.equal(b.workers.length, 1);
});

test('a single run needs no filter, and a filter naming an absent run folds to a well formed empty record', () => {
  const single = [
    ev('run_started', 0, { graph_generation: 4 }),
    started(0, 'wA', 'nA', 'a1'), ended(10, 'wA', 'nA', 'a1'),
  ];
  assert.equal(fold.foldRunRecord(single).demonstrated_width.value, 1, '1 run means no filter is required');
  const absent = fold.foldRunRecord(single, { run_id: 'run-zzz' });
  assert.equal(absent.run_id, 'run-zzz');
  assert.deepEqual(absent.demonstrated_width, { value: 0, exact: true, unknown_intervals: 0 });
  assert.deepEqual(absent.workers, []);
});

// ─── determinism (T-19-06) ───────────────────────────────────────────────────

test('the fold does not leak the arrival order of its input into its output', () => {
  // Independent causal streams. Within a stream the order is fixed; across
  // streams every interleaving describes the same run.
  const streams = [
    [ev('run_started', 0, { graph_generation: 9 }), ev('run_closed', 500)],
    [started(10, 'wA', 'nA', 'a1'), ended(60, 'wA', 'nA', 'a1', 'completed')],
    [started(20, 'wB', 'nB', 'a1'), ended(70, 'wB', 'nB', 'a1', 'abnormal')],
    [started(30, 'wC', 'nC', 'a1')],
    [
      ev('queue_entered', 100, { node_id: 'nA', attempt_id: 'a1', ticket: 1 }),
      ev('queue_acquired', 140, { node_id: 'nA', attempt_id: 'a1', ticket: 1, worker_id: 'wA' }),
      ev('gate_started', 150, { node_id: 'nA', attempt_id: 'a1' }),
      ev('gate_ended', 200, { node_id: 'nA', attempt_id: 'a1', verdict: 'green' }),
      ev('land_completed', 210, { node_id: 'nA', attempt_id: 'a1', result: 'landed' }),
      ev('post_land_truth', 220, { node_id: 'nA', attempt_id: 'a1', classification: 'false_green' }),
    ],
    [
      ev('queue_entered', 110, { node_id: 'nB', attempt_id: 'a1', ticket: 2 }),
      ev('queue_acquired', 160, { node_id: 'nB', attempt_id: 'a1', ticket: 2, worker_id: 'wB' }),
      ev('land_completed', 230, { node_id: 'nB', attempt_id: 'a1', result: 'landed' }),
    ],
  ];

  const rand = lcg(20260726);
  const baseline = fold.foldRunRecord(interleave(streams, rand));
  let distinctOrders = 0;
  let lastOrder = null;
  for (let i = 0; i < 40; i++) {
    const order = interleave(streams, rand);
    const signature = order.map((e) => `${e.kind}@${e.ts}`).join(',');
    if (signature !== lastOrder) { distinctOrders++; lastOrder = signature; }
    assert.deepEqual(
      fold.foldRunRecord(order), baseline,
      'a figure that changes with the arrival order of its input is not a measurement (D6)',
    );
  }
  assert.ok(distinctOrders > 5, `the permutations must actually differ; saw ${distinctOrders} distinct orders`);

  // And the baseline is the run it claims to be, so the determinism above is not
  // determinism about the wrong answer.
  assert.deepEqual(baseline.demonstrated_width, { value: 2, exact: false, unknown_intervals: 1 });
  assert.deepEqual(baseline.workers.map((w) => w.worker_id), ['wA', 'wB', 'wC'], 'sorted by started_at then worker_id');
  assert.deepEqual(baseline.false_green, { landed: 2, later_failed: 1, unknown: 1 });
  assert.deepEqual(baseline.rounds_per_artifact, { nA: 1, nB: 1, nC: 1 });
});

// ─── the degenerate input ────────────────────────────────────────────────────

test('an empty event array folds to a well formed record with zero values rather than throwing', () => {
  const record = fold.foldRunRecord([]);
  assert.deepEqual(record, {
    run_id: null,
    graph_generation: null,
    run_started_at: null,
    run_closed_at: null,
    workers: [],
    demonstrated_width: { value: 0, exact: true, unknown_intervals: 0 },
    nodes: [],
    rounds_per_artifact: {},
    false_green: { landed: 0, later_failed: 0, unknown: 0 },
  });
  assert.equal(fold.RUNFOLD_UNKNOWN, 'UNKNOWN');
  assert.ok(Object.isFrozen(fold.RUNFOLD_ERROR_CODES));
});

test('the fold never mutates the array it was handed', () => {
  const events = [
    ev('run_started', 0, { graph_generation: 1 }),
    started(0, 'wA', 'nA', 'a1'), ended(10, 'wA', 'nA', 'a1'),
  ];
  const before = JSON.stringify(events);
  fold.foldRunRecord(events);
  assert.equal(JSON.stringify(events), before, 'pure over its arguments means the input is untouched too');
});

// ─── purity and anti-drift, asserted against the artifact callers load ────────

test('the fold is pure: the built artifact reads no file, no clock, no environment and owns no stdout', () => {
  const built = fs.readFileSync(BUILT_LIB, 'utf8');
  for (const forbidden of ['node:fs', 'node:os', 'node:child_process', 'process.env', 'process.stdout', 'Date.now(', 'Math.random(']) {
    assert.ok(
      !built.includes(forbidden),
      `the fold must not reach for ${forbidden}. Phase 22 publishes every number this function returns, and a `
        + 'figure that depends on something the caller cannot see is not a measurement (D6).',
    );
  }
});

test('the fold imports its vocabulary from the writer rather than restating it, so the 2 cannot drift', () => {
  const built = fs.readFileSync(BUILT_LIB, 'utf8');
  assert.ok(built.includes('fleet-runlog.cjs'), 'the kind names and the field map come from the writer');
  // The proof that it is really imported and not copied: which kinds carry an
  // attempt is DERIVED from the writer's field map. Every attempt-bearing kind in
  // the writer is folded into rounds_per_artifact, with no list in the fold.
  const map = runlog.FLEET_EVENT_REQUIRED_FIELDS;
  const attemptKinds = runlog.FLEET_EVENT_KINDS.filter(
    (k) => map[k].includes('node_id') && map[k].includes('attempt_id'),
  );
  assert.ok(attemptKinds.length >= 6, `expected several attempt-bearing kinds, saw ${attemptKinds.join(', ')}`);

  const events = [];
  let ts = 0;
  const bank = {
    worker_started: { worker_id: 'w1', lease_epoch: 1 },
    worker_ended: { worker_id: 'w1', outcome: 'completed' },
    queue_entered: { ticket: 1 },
    queue_acquired: { ticket: 1, worker_id: 'w1' },
    gate_started: {},
    gate_ended: { verdict: 'green' },
    land_completed: { result: 'landed' },
    post_land_truth: { classification: 'held' },
  };
  for (const kind of attemptKinds) {
    events.push(ev(kind, ts++, { node_id: 'n1', attempt_id: `a-${kind}`, ...bank[kind] }));
  }
  const record = fold.foldRunRecord(events);
  assert.equal(
    record.rounds_per_artifact.n1, attemptKinds.length,
    'every attempt-bearing kind the WRITER declares is counted by the fold, because the fold derives the set '
      + 'from the writer instead of carrying its own list',
  );
});
