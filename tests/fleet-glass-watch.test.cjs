'use strict';

/**
 * Phase 21 of milestone v1.14 (Fleet Mode): the battery for the LIVE view,
 * `node scripts/fleet-glass.cjs watch <phase>`.
 *
 * THE ONE ARM THIS FILE EXISTS FOR IS THE CONCURRENCY REQUIRED FAILING ARM.
 *
 * The recorded phase 22 defect is a demonstrated width that turned out to be a
 * property of the emit loop rather than a property of the run: the number went
 * up because more work was dispatched, not because more work overlapped. A
 * watch view is exactly the surface where that defect reappears, because the
 * obvious implementation of "how many workers are running" is to count the
 * lanes on the screen.
 *
 * So this file drives 2 fixtures that a LANE COUNT implementation cannot tell
 * apart, and asserts 2 different numbers out of them:
 *
 *   fixture A: 3 workers whose intervals OVERLAP        -> the frame reports 3
 *   fixture B: the same 3 workers taking STRICT TURNS   -> the frame reports 1
 *
 * Both fixtures have 3 lanes. Both fixtures have 3 worker_started events and 3
 * worker_ended events. The ONLY difference between them is whether the
 * intervals overlap, which is the only thing that makes a run parallel. An
 * implementation that painted `lanes.length` passes A and FAILS B, and that is
 * what makes B a required failing arm rather than a second green tick.
 *
 * AND IT ASSERTS A COUNTER, NEVER A FLAG. `assert.match(text, /parallel/)`
 * would pass for a frame that printed the word. The arms below extract the
 * DIGITS out of the painted line and compare them to 3 and to 1, so the only
 * way to pass both is to have measured something.
 *
 * NON ZERO FIRST, EVERYWHERE. "The frame contains no defect" is vacuously true
 * of a frame that rendered nothing, so every arm proves the model folded a non
 * zero number of lanes or nodes before it believes anything the frame says.
 *
 * THE PRODUCER IS THE AUTHORITY. Every fixture is folded by the SHIPPED
 * `foldRunRecord` from `ferrox-core/bin/lib/fleet-runfold.cjs`, called
 * POSITIONALLY, so the view is measured against what the real producer emits
 * rather than against what this file believes it emits. The positional trap
 * itself gets its own arm: `foldRunRecord({ events })` returns an EMPTY record
 * with NO ERROR, and for a live view a blank board that reads as "nothing
 * wrong" is the worst available failure.
 *
 * ZERO AGENT SPEND. Every event in this file is hand built. Nothing here
 * invokes `claude`, `codex` or `gemini`, and nothing here dispatches a paid
 * worker. The fleet being watched is a fixture.
 *
 * THE CLI IS SPAWNED WITH A BOUNDED FRAME COUNT. An unbounded polling loop in a
 * battery is a hung suite, and a hung suite is indistinguishable from a passing
 * one until somebody looks at the clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const glass = require('../scripts/fleet-glass.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GLASS_CLI = path.join(REPO_ROOT, 'scripts', 'fleet-glass.cjs');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

const SCRATCH_ROOTS = [];

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

/** The shipped fold, or a skip note if the lib tree has not been built. */
function loadRunfold() {
  try {
    return require(path.join(LIB_DIR, 'fleet-runfold.cjs'));
  } catch {
    return null;
  }
}

function textOf(lines) {
  assert.ok(Array.isArray(lines), 'a renderer returns an array of lines');
  assert.ok(lines.length > 0, 'NON ZERO output first: an empty frame proves nothing');
  return lines.join('\n');
}

/**
 * The DIGITS the frame paints for a named counter.
 *
 * Returns null when the counter is absent, so an arm can tell a missing line
 * apart from a line that reports 0. Those are 2 different failures and only 1
 * of them is a wrong number.
 */
function counterOnFrame(text, label) {
  const found = new RegExp(`${label}\\s+(\\d+)`).exec(text);
  return found === null ? null : Number(found[1]);
}

const T0 = 1785056400000; // 2026-07-26T09:00:00.000Z, fixed so no arm reads a clock.
const at = (seconds) => T0 + (seconds * 1000);

/** One worker, started and ended, as the 2 events the run log really carries. */
function workerPair(workerId, nodeId, startSeconds, endSeconds) {
  return [
    {
      kind: 'worker_started', ts: at(startSeconds), run_id: 'r1',
      worker_id: workerId, node_id: nodeId, attempt_id: 'a1', lease_epoch: 1,
    },
    {
      kind: 'worker_ended', ts: at(endSeconds), run_id: 'r1',
      worker_id: workerId, node_id: nodeId, attempt_id: 'a1', outcome: 'completed',
    },
  ];
}

/**
 * FIXTURE A. 3 workers whose intervals OVERLAP.
 *   w1 [0,   60]
 *   w2 [10,  70]
 *   w3 [20,  80]
 * At second 20 all 3 are inside their interval, so the width is 3.
 */
function overlappingEvents() {
  return [
    { kind: 'run_started', ts: at(0), run_id: 'r1', graph_generation: 1 },
    ...workerPair('w1', '21-01', 0, 60),
    ...workerPair('w2', '21-02', 10, 70),
    ...workerPair('w3', '21-03', 20, 80),
  ];
}

/**
 * FIXTURE B. The SAME 3 workers taking STRICT TURNS.
 *   w1 [0,   60]
 *   w2 [70, 130]
 *   w3 [140, 200]
 * No 2 intervals share an instant, so the width is 1.
 *
 * 3 lanes, 3 starts, 3 ends, exactly like fixture A. A view that painted the
 * lane count reports 3 here and is WRONG, which is the whole point.
 */
function sequentialEvents() {
  return [
    { kind: 'run_started', ts: at(0), run_id: 'r1', graph_generation: 1 },
    ...workerPair('w1', '21-01', 0, 60),
    ...workerPair('w2', '21-02', 70, 130),
    ...workerPair('w3', '21-03', 140, 200),
  ];
}

/** Fold a fixture through the SHIPPED producer, POSITIONALLY, then watch fold. */
function modelFor(events, now, graph) {
  const runfold = loadRunfold();
  assert.ok(runfold !== null, 'the shipped fleet-runfold lib is present');
  // POSITIONAL. `foldRunRecord({ events })` returns an EMPTY record with NO
  // ERROR; see the dedicated arm below.
  const runRecord = runfold.foldRunRecord(events);
  assert.ok(runRecord.workers.length > 0, 'NON ZERO: the producer really folded worker rows');
  return glass.foldWatch({ events, runRecord, graph: graph ?? null, now });
}

function makeScratchRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-watch-${tag}-`));
  SCRATCH_ROOTS.push(root);
  return root;
}

function planText(plan, wave) {
  return [
    '---',
    'phase: 21-watch-scratch',
    `plan: ${plan}`,
    'type: execute',
    `wave: ${wave}`,
    'depends_on: []',
    'files_modified:',
    `  - scripts/scratch-${plan}.cjs`,
    'autonomous: true',
    '---',
    '',
    '<tasks>',
    '<task type="auto"><name>Task 1: a scratch task</name></task>',
    '</tasks>',
  ].join('\n');
}

/** A scratch project carrying a real run log and a real phase directory. */
function buildScratchTree(tag, events) {
  const root = makeScratchRoot(tag);
  const phaseDir = path.join(root, '.planning', 'phases', '21-watch-scratch');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, '.planning', 'fleet-runlog.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(phaseDir, '21-01-PLAN.md'), planText('01', 1), 'utf8');
  fs.writeFileSync(path.join(phaseDir, '21-02-PLAN.md'), planText('02', 1), 'utf8');
  fs.writeFileSync(path.join(phaseDir, '21-03-PLAN.md'), planText('03', 2), 'utf8');
  return root;
}

function graphDocument() {
  return {
    schema: 'workgraph/v1',
    phase: '21',
    nodes: [
      { id: '21-01', kind: 'leaf', wave: 1, task_count: 2, write_lane: ['a.cjs'] },
      { id: '21-02', kind: 'leaf', wave: 1, task_count: 2, write_lane: ['b.cjs'] },
      { id: '21-03', kind: 'leaf', wave: 2, task_count: 2, write_lane: ['c.cjs'] },
      { id: '21-04', kind: 'leaf', wave: 3, task_count: 2, write_lane: ['d.cjs'] },
    ],
    edges: [],
    warnings: [],
  };
}

/* ------------------------------------------------------------------------ *
 * 1. THE REQUIRED FAILING ARM on the concurrency counter
 * ------------------------------------------------------------------------ */

test('THE REQUIRED FAILING ARM: 3 OVERLAPPING workers make the frame report peak 3', () => {
  const model = modelFor(overlappingEvents(), at(300), graphDocument());
  assert.equal(model.lanes.length, 3, 'NON ZERO: 3 lanes were folded');

  const observed = glass.computeConcurrency(model.lanes, at(300));
  assert.equal(observed.peak, 3, 'the SWEEP measures 3 workers inside their intervals at once');
  assert.equal(observed.unknown_intervals, 0, 'every interval was readable, so the peak is exact');
  assert.equal(observed.peak_exact, true, 'and it is reported as exact');

  const text = textOf(glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }));
  assert.equal(counterOnFrame(text, 'peak so far'), 3, 'the PAINTED FRAME reports 3');
});

test('THE REQUIRED FAILING ARM, other half: the SAME 3 workers taking TURNS report peak 1', () => {
  const model = modelFor(sequentialEvents(), at(300), graphDocument());

  // The lane count is IDENTICAL to fixture A. This assertion is the trap: an
  // implementation that painted the lane count would satisfy the arm above and
  // would report 3 here, and 3 is wrong, because at no instant in this run were
  // 2 workers both inside their interval.
  assert.equal(model.lanes.length, 3, 'NON ZERO, and the SAME 3 lanes as the overlapping fixture');

  const observed = glass.computeConcurrency(model.lanes, at(300));
  assert.equal(observed.peak, 1, 'the SWEEP measures 1, because no 2 intervals ever overlap');
  assert.equal(observed.unknown_intervals, 0, 'and it measured every interval to say so');

  const text = textOf(glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }));
  assert.equal(counterOnFrame(text, 'peak so far'), 1, 'the PAINTED FRAME reports 1, never the lane count');
});

test('the 2 fixtures differ ONLY in overlap: same lane count, same event count, different peak', () => {
  const a = overlappingEvents();
  const b = sequentialEvents();
  assert.equal(a.length, b.length, 'the 2 fixtures carry the SAME number of events');

  const modelA = modelFor(a, at(300), graphDocument());
  const modelB = modelFor(b, at(300), graphDocument());
  assert.equal(modelA.lanes.length, modelB.lanes.length, 'and the SAME number of lanes');

  const peakA = glass.computeConcurrency(modelA.lanes, at(300)).peak;
  const peakB = glass.computeConcurrency(modelB.lanes, at(300)).peak;
  assert.ok(peakA > peakB, `the overlapping run demonstrates more width: ${peakA} against ${peakB}`);
  assert.equal(peakA, 3);
  assert.equal(peakB, 1);
});

test('2 intervals that merely TOUCH demonstrate width 1, because a demonstrated figure never rounds up', () => {
  const lanes = [
    { started_at_ms: at(10), ended_at_ms: at(20) },
    { started_at_ms: at(20), ended_at_ms: at(30) },
  ];
  const observed = glass.computeConcurrency(lanes, at(40));
  assert.equal(observed.peak, 1, 'an END is swept before a START at an equal instant');
  assert.equal(observed.unknown_intervals, 0, 'NON ZERO check: both intervals really were swept');
});

/* ------------------------------------------------------------------------ *
 * 2. The live counter, the number a human watches
 * ------------------------------------------------------------------------ */

test('the LIVE counter reports how many workers are inside their interval at THIS instant', () => {
  // 3 workers still open. At second 300 all 3 have started and none has ended.
  const events = [
    { kind: 'run_started', ts: at(0), run_id: 'r1', graph_generation: 1 },
    { kind: 'worker_started', ts: at(10), run_id: 'r1', worker_id: 'w1', node_id: '21-01', attempt_id: 'a1', lease_epoch: 1 },
    { kind: 'worker_started', ts: at(20), run_id: 'r1', worker_id: 'w2', node_id: '21-02', attempt_id: 'a1', lease_epoch: 1 },
    { kind: 'worker_started', ts: at(30), run_id: 'r1', worker_id: 'w3', node_id: '21-03', attempt_id: 'a1', lease_epoch: 1 },
  ];
  const model = modelFor(events, at(300), graphDocument());
  assert.equal(model.lanes.length, 3, 'NON ZERO lanes');
  assert.equal(model.concurrency.now, 3, 'all 3 are running at the frame instant');

  const text = textOf(glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }));
  assert.equal(counterOnFrame(text, 'running this instant'), 3, 'the frame paints the live count');
});

test('the LIVE counter FALLS as workers end, which is a wave draining', () => {
  const events = [
    { kind: 'run_started', ts: at(0), run_id: 'r1', graph_generation: 1 },
    ...workerPair('w1', '21-01', 10, 100),
    ...workerPair('w2', '21-02', 20, 110),
    { kind: 'worker_started', ts: at(30), run_id: 'r1', worker_id: 'w3', node_id: '21-03', attempt_id: 'a1', lease_epoch: 1 },
  ];
  const model = modelFor(events, at(300), graphDocument());
  assert.equal(model.lanes.length, 3, 'NON ZERO lanes');
  assert.equal(model.concurrency.now, 1, 'only the still open worker is running now');
  assert.equal(model.concurrency.peak, 3, 'and the PEAK still remembers all 3 overlapping');

  const text = textOf(glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }));
  assert.equal(counterOnFrame(text, 'running this instant'), 1, 'the live count is 1');
  assert.equal(counterOnFrame(text, 'peak so far'), 3, 'and the peak is 3, on the SAME frame');
});

test('a lane whose start is AFTER the frame instant is NOT counted as running now', () => {
  // The frame instant is second 50. w1 is inside its interval. w2 has a start
  // stamped at second 90, which is a clock skew or a record read a moment early,
  // and it has NOT started yet as far as this frame can tell.
  const lanes = [
    { started_at_ms: at(10), ended_at_ms: null },
    { started_at_ms: at(90), ended_at_ms: null },
  ];
  const observed = glass.computeConcurrency(lanes, at(50));
  assert.equal(observed.now, 1, 'only the lane that has really started is running now');
  assert.notEqual(observed.now, lanes.length, 'and it is NOT the lane count');
  assert.equal(observed.unknown_intervals, 0, 'NON ZERO check: both lanes were examined');
});

/* ------------------------------------------------------------------------ *
 * 3. UNKNOWN IS NEVER 0
 * ------------------------------------------------------------------------ */

test('a worker whose start cannot be read is COUNTED as unknown and never dropped', () => {
  const lanes = [
    { started_at_ms: at(0), ended_at_ms: at(60) },
    { started_at_ms: null, ended_at_ms: null },
  ];
  const observed = glass.computeConcurrency(lanes, at(30));
  assert.equal(observed.unknown_intervals, 1, 'the unreadable interval is COUNTED');
  assert.equal(observed.peak_exact, false, 'so the peak is a floor rather than a total');
  assert.ok(observed.peak >= 1, 'NON ZERO: the readable interval still contributes');
});

test('an inexact peak SAYS SO on the frame, so a floor is never quoted as a total', () => {
  const events = [
    { kind: 'run_started', ts: at(0), run_id: 'r1', graph_generation: 1 },
    ...workerPair('w1', '21-01', 0, 60),
    // An end with NO start. The producer keeps the row and marks it unknown.
    { kind: 'worker_ended', ts: at(90), run_id: 'r1', worker_id: 'w9', node_id: '21-02', attempt_id: 'a1', outcome: 'completed' },
  ];
  const model = modelFor(events, at(300), graphDocument());
  assert.equal(model.concurrency.unknown_intervals, 1, 'NON ZERO: 1 interval is unknown');
  const text = textOf(glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }));
  assert.ok(text.includes(glass.WATCH_WORDING.PEAK_INEXACT), 'the frame says the peak is a floor');
  assert.equal(counterOnFrame(text, 'unknown intervals'), 1, 'and it paints the unknown COUNT');
});

test('an unreadable elapsed renders UNKNOWN and never 00:00:00', () => {
  assert.equal(glass.shownDuration(null), glass.WATCH_UNKNOWN, 'an absent extent is UNKNOWN');
  assert.equal(glass.shownDuration(-5), glass.WATCH_UNKNOWN, 'a negative extent is UNKNOWN');
  assert.equal(glass.shownDuration(0), '00:00:00', 'and a REAL reading of 0 seconds still prints');
  assert.equal(glass.shownDuration(3661000), '01:01:01', 'a real extent prints as hours, minutes, seconds');
});

test('an absent graph makes the node TOTAL unknown and never 0', () => {
  const model = modelFor(overlappingEvents(), at(300), null);
  assert.equal(model.nodes_total, null, 'the total is null rather than 0');
  const text = textOf(glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }));
  assert.ok(text.includes(glass.WATCH_UNKNOWN), 'the frame prints UNKNOWN for the total');
  assert.ok(text.includes(glass.WATCH_WORDING.TOTAL_UNKNOWN), 'and it says why');
  assert.ok(!/landed of 0/.test(text), '0 of 0 landed would read as a finished run, so it is forbidden');
});

/* ------------------------------------------------------------------------ *
 * 4. A blank board reads as NOTHING LOADED, never as NOTHING WRONG
 * ------------------------------------------------------------------------ */

test('THE POSITIONAL TRAP: foldRunRecord({ events }) returns an EMPTY record with NO ERROR', () => {
  const runfold = loadRunfold();
  assert.ok(runfold !== null, 'the shipped lib is present');
  const events = overlappingEvents();

  const positional = runfold.foldRunRecord(events);
  assert.ok(positional.workers.length > 0, 'NON ZERO: called positionally it folds real rows');

  // The trap, OBSERVED rather than remembered.
  const wrapped = runfold.foldRunRecord({ events });
  assert.equal(wrapped.workers.length, 0, 'called with an object it returns an EMPTY record');
  assert.equal(wrapped.demonstrated_width.value, 0, 'and a width of 0, with NO error raised');

  // And that empty record folds to a watch model that cannot be mistaken for a
  // healthy fleet, because the event count is carried through.
  const blank = glass.foldWatch({ events: [], runRecord: wrapped, graph: null, now: at(300) });
  assert.equal(blank.events_read, 0, 'the model reports that it read NOTHING');
  const text = textOf(glass.renderWatchFrame(blank, { phase: '21', frame: 1, frames: 1 }));
  assert.ok(text.includes(glass.WATCH_WORDING.NO_SIGNAL), 'and the frame says NO SIGNAL');
  assert.ok(!/peak so far/.test(text), 'it paints no counter at all over an empty read');
});

test('a run with no worker yet says NO LANE HAS OPENED, which is not the same as no signal', () => {
  const events = [{ kind: 'run_started', ts: at(0), run_id: 'r1', graph_generation: 1 }];
  const model = modelFor2(events, at(60), graphDocument());
  assert.equal(model.events_read, 1, 'NON ZERO: an event really was read');
  assert.equal(model.lanes.length, 0, 'and no lane has opened');
  const text = textOf(glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }));
  assert.ok(text.includes(glass.WATCH_WORDING.NO_LANES), 'the frame says no lane has opened');
  assert.ok(!text.includes(glass.WATCH_WORDING.NO_SIGNAL), 'and it does NOT say no signal');
  assert.notEqual(
    glass.WATCH_WORDING.NO_LANES,
    glass.WATCH_WORDING.NO_SIGNAL,
    'the 2 wordings are DISTINCT, so collapsing them turns this file red',
  );
});

/** Fold without asserting a non zero worker count, for the no lane arm. */
function modelFor2(events, now, graph) {
  const runfold = loadRunfold();
  assert.ok(runfold !== null, 'the shipped fleet-runfold lib is present');
  return glass.foldWatch({ events, runRecord: runfold.foldRunRecord(events), graph, now });
}

/* ------------------------------------------------------------------------ *
 * 5. Node state across the graph
 * ------------------------------------------------------------------------ */

test('every node carries 1 of the 5 states, and a wave can be watched draining', () => {
  const events = [
    { kind: 'run_started', ts: at(0), run_id: 'r1', graph_generation: 1 },
    ...workerPair('w1', '21-01', 0, 60),
    { kind: 'queue_entered', ts: at(61), run_id: 'r1', node_id: '21-01', attempt_id: 'a1', ticket: 1 },
    { kind: 'land_completed', ts: at(70), run_id: 'r1', node_id: '21-01', attempt_id: 'a1', result: 'landed' },
    ...workerPair('w2', '21-02', 10, 80),
    { kind: 'queue_entered', ts: at(81), run_id: 'r1', node_id: '21-02', attempt_id: 'a1', ticket: 2 },
    { kind: 'worker_started', ts: at(90), run_id: 'r1', worker_id: 'w3', node_id: '21-03', attempt_id: 'a1', lease_epoch: 1 },
    { kind: 'node_parked', ts: at(95), run_id: 'r1', node_id: '21-04', reason: 'the same gate failed 3 times', attempts: 3, on_critical_path: false },
  ];
  const model = modelFor(events, at(300), graphDocument());
  assert.equal(model.nodes.length, 4, 'NON ZERO: all 4 declared nodes are on the board');

  const byId = new Map(model.nodes.map((node) => [node.id, node.state]));
  assert.equal(byId.get('21-01'), glass.WATCH_NODE_STATES.LANDED, '21-01 landed');
  assert.equal(byId.get('21-02'), glass.WATCH_NODE_STATES.GATED, '21-02 is at the gate');
  assert.equal(byId.get('21-03'), glass.WATCH_NODE_STATES.RUNNING, '21-03 is being built');
  assert.equal(byId.get('21-04'), glass.WATCH_NODE_STATES.PARKED, '21-04 is parked');

  assert.equal(model.nodes_landed, 1, 'the landed COUNT is 1');
  assert.equal(model.nodes_total, 4, 'against a total of 4');
  assert.equal(model.parked.length, 1, 'and 1 node is parked');

  const text = textOf(glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }));
  assert.match(text, /1 landed of 4/, 'the frame paints landed against total');
  assert.match(text, /WAVE 1\s+1 of 2 landed/, 'wave 1 is visibly half drained');
  assert.match(text, /21-04\s+parked\s+reason the same gate failed 3 times/, 'the parked node is NAMED with its reason');
  assert.ok(
    text.indexOf('WAVE 1') < text.indexOf('WAVE 2'),
    'waves paint in order, so a wave draining reads top to bottom',
  );
});

test('a node observed in the log but NOT declared in the graph is shown rather than hidden', () => {
  const events = [
    { kind: 'run_started', ts: at(0), run_id: 'r1', graph_generation: 1 },
    ...workerPair('w1', '99-99', 0, 60),
  ];
  const model = modelFor(events, at(300), graphDocument());
  const stray = model.nodes.find((node) => node.id === '99-99');
  assert.ok(stray !== undefined, 'the undeclared node is on the board');
  assert.equal(stray.declared, false, 'and it is marked as undeclared');
  const text = textOf(glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }));
  assert.match(text, /99-99/, 'the frame NAMES it, because a hidden node is a lost node');
});

/* ------------------------------------------------------------------------ *
 * 6. The closing summary
 * ------------------------------------------------------------------------ */

test('the closing summary reports wall clock, max concurrency, landed and parked', () => {
  const events = [
    ...overlappingEvents(),
    { kind: 'node_parked', ts: at(90), run_id: 'r1', node_id: '21-04', reason: 'budget exhausted', attempts: 3, on_critical_path: true },
    { kind: 'land_completed', ts: at(95), run_id: 'r1', node_id: '21-01', attempt_id: 'a1', result: 'landed' },
    { kind: 'run_closed', ts: at(200), run_id: 'r1' },
  ];
  const model = modelFor(events, at(300), graphDocument());
  assert.equal(model.run_closed, true, 'the run really closed');

  const text = textOf(glass.renderWatchSummary(model, { phase: '21', frames_painted: 4 }));
  assert.ok(text.includes(glass.WATCH_WORDING.RUN_CLOSED), 'it says the RUN closed');
  assert.ok(!text.includes(glass.WATCH_WORDING.RUN_OPEN), 'and not that the watch stopped first');
  assert.match(text, /wall clock\s+00:03:20/, 'the wall clock is the run extent, 200 seconds');
  assert.equal(counterOnFrame(text, 'max concurrency observed'), 3, 'the max concurrency is the SWEPT figure');
  assert.match(text, /nodes landed\s+1 of 4/, 'landed against total');
  assert.equal(counterOnFrame(text, 'nodes parked'), 1, 'the parked COUNT');
  assert.match(text, /21-04\s+reason budget exhausted/, 'and the parked node is NAMED');
  assert.equal(counterOnFrame(text, 'frames painted'), 4, 'the frame count is reported');
});

/**
 * THE CLOSING SUMMARY HAS TO REFUSE AS HARD AS THE FRAME DOES.
 *
 * `renderWatchFrame` already paints NO SIGNAL over an empty read and stops. The
 * summary is a second surface reporting the SAME figures, and a summary that
 * closed with `max concurrency observed 0` over a log nobody ever read would
 * publish a measurement that was never taken. 0 is a reading. UNKNOWN is the
 * absence of one, and those are 2 different facts.
 */
test('a summary over a read that loaded NOTHING reports UNKNOWN for every figure, never 0', () => {
  const blank = glass.foldWatch({ events: [], runRecord: null, graph: null, now: at(300) });
  assert.equal(blank.events_read, 0, 'the model really read nothing');

  const text = textOf(glass.renderWatchSummary(blank, { phase: '21', frames_painted: 3 }));
  assert.ok(text.includes(glass.WATCH_WORDING.NO_SIGNAL), 'it says NO SIGNAL');

  // The COUNTERS are absent rather than 0. Asserted as digits, so a summary
  // that printed the word UNKNOWN somewhere and a 0 on the counter line fails.
  assert.equal(counterOnFrame(text, 'max concurrency observed'), null, 'no concurrency figure is quoted');
  assert.equal(counterOnFrame(text, 'nodes landed'), null, 'no landed figure is quoted');
  assert.equal(counterOnFrame(text, 'nodes parked'), null, 'no parked figure is quoted');
  assert.match(text, /max concurrency observed\s+UNKNOWN/, 'the concurrency line reads UNKNOWN');
  assert.match(text, /nodes landed\s+UNKNOWN/, 'the landed line reads UNKNOWN');
  assert.match(text, /nodes parked\s+UNKNOWN/, 'the parked line reads UNKNOWN');

  // The frames really were painted, so THAT figure is a real reading and stays.
  assert.equal(counterOnFrame(text, 'frames painted'), 3, 'the frame count is a real reading and survives');
});

/**
 * UNKNOWN AND AN OBSERVED 0 ARE 2 DIFFERENT FACTS, and the summary has to paint
 * them differently.
 *
 * The arm above proves the unread run reports UNKNOWN. On its own that is not
 * enough: a summary that printed UNKNOWN for every 0 it ever met would satisfy
 * it and would then be unable to report a real, measured, honest 0. So this arm
 * drives a run that WAS read and that genuinely observed 0 parked nodes, and
 * asserts the SAME line paints a DIGIT. The 2 outputs are then compared
 * directly, because the property being proven is that they are DISTINGUISHABLE.
 */
test('an OBSERVED 0 still paints 0: UNKNOWN is distinguishable from a real measurement of none', () => {
  // A real run, really read, with no parked node and nothing landed.
  const observed = modelFor(overlappingEvents(), at(300), graphDocument());
  assert.ok(observed.events_read > 0, 'NON ZERO: this run really was read');
  assert.equal(observed.parked.length, 0, 'and it genuinely observed 0 parked nodes');

  const observedText = textOf(glass.renderWatchSummary(observed, { phase: '21', frames_painted: 2 }));
  const blank = glass.foldWatch({ events: [], runRecord: null, graph: null, now: at(300) });
  const blankText = textOf(glass.renderWatchSummary(blank, { phase: '21', frames_painted: 2 }));

  // The OBSERVED run paints a DIGIT on the very lines the unread run leaves UNKNOWN.
  assert.equal(counterOnFrame(observedText, 'nodes parked'), 0, 'an observed none paints a real 0');
  assert.match(observedText, /nodes landed\s+0 of 4/, 'and an observed 0 landed paints 0 against its total');
  assert.equal(counterOnFrame(observedText, 'max concurrency observed'), 3, 'and the swept peak is a digit');

  // The UNREAD run leaves those same lines UNKNOWN.
  assert.match(blankText, /nodes parked\s+UNKNOWN/, 'the unread run leaves the same line UNKNOWN');
  assert.equal(counterOnFrame(blankText, 'nodes parked'), null, 'with no digit at all');

  // The property, stated directly: the 2 summaries are NOT the same text.
  assert.notEqual(
    observedText,
    blankText,
    'an observed 0 and an absent reading are DISTINGUISHABLE, which is the whole point',
  );
});

/**
 * ZERO AGENT SPEND, as a standing arm rather than a promise.
 *
 * FF-B338: `.planning/config.json` carries a NON EMPTY adapter roster, and any
 * surface that reaches the fleet preflight under it spends real money. Several
 * arms in this file spawn `fleet-glass.cjs` as a CHILD PROCESS, so "this view is
 * read only" is not a sufficient answer on its own.
 *
 * The answer is that the watch view cannot reach a paid surface AT ALL: it
 * loads no adapter module, no preflight, and never loads `child_process`, so
 * there is no path from a painted frame to a billed call. That is asserted here
 * EMPIRICALLY, against the live require graph rather than against a reading of
 * the source, so a future edit that wires an adapter into this view turns this
 * file red instead of quietly billing somebody.
 */
test('ZERO AGENT SPEND: the watch view loads no adapter, no preflight and no child process', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'fleet-glass.cjs'), 'utf8');
  assert.ok(source.length > 0, 'NON ZERO: the module source really was read');

  // No agent binary is NAMED anywhere, comments included.
  for (const binary of ['claude', 'codex', 'gemini']) {
    assert.ok(
      !new RegExp(binary, 'i').test(source),
      `the watch view never names the ${binary} binary`,
    );
  }
  // And it names no process spawning API.
  for (const api of ['child_process', 'spawnSync', 'execSync', 'execFile']) {
    assert.ok(!source.includes(api), `the watch view names no ${api}`);
  }

  // THE EMPIRICAL HALF: the live require graph, taken from this process, which
  // has already loaded the glass module at the top of this file.
  const loaded = Object.keys(require.cache).filter((p) => !p.includes('node_modules'));
  assert.ok(loaded.length > 0, 'NON ZERO: the require cache really was inspected');
  assert.ok(
    loaded.some((p) => p.endsWith(path.join('scripts', 'fleet-glass.cjs'))),
    'and the glass module really is in it, so this arm is measuring the right graph',
  );

  const glassGraph = loaded.filter((p) => /fleet-glass|fleet-ask|cli-exit/.test(p));
  const paid = glassGraph.filter((p) => /adapter|preflight|dispatch|spend|budget/i.test(p));
  assert.deepEqual(paid, [], 'no module the watch view loads is a paid surface');
});

test('a run log that OPENED and carried nothing exits NON ZERO, because nothing loaded is not nothing wrong', () => {
  const root = makeScratchRoot('cli-blank');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  // The file EXISTS and is READABLE. It simply carries no event. The missing
  // file arm already covers an absent log; this one covers the log that opened.
  fs.writeFileSync(path.join(root, '.planning', 'fleet-runlog.jsonl'), '', 'utf8');

  const run = spawnSync(
    process.execPath,
    [GLASS_CLI, 'watch', '21', '--frames', '2', '--interval', '10'],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, FERROX_GLASS_ROOT: root } },
  );
  assert.equal(run.signal, null, 'BOUNDED');
  assert.ok(run.stdout.length > 0, 'NON ZERO output: it really painted something');
  assert.ok(run.stdout.includes(glass.WATCH_WORDING.NO_SIGNAL), 'it says NO SIGNAL');
  assert.equal(
    run.status,
    1,
    'and it EXITS NON ZERO, so a script reading the exit code is not told everything is fine',
  );
  assert.ok(
    !/max concurrency observed\s+0/.test(run.stdout),
    'it never closes with a concurrency of 0 over a run it never read',
  );
});

test('a summary over a run that is STILL OPEN says so, so a partial figure is never quoted as a total', () => {
  const model = modelFor(overlappingEvents(), at(300), graphDocument());
  assert.equal(model.run_closed, false, 'the run never closed');
  const text = textOf(glass.renderWatchSummary(model, { phase: '21', frames_painted: 2 }));
  assert.ok(text.includes(glass.WATCH_WORDING.RUN_OPEN), 'it says the watch stopped first');
  assert.ok(!text.includes(glass.WATCH_WORDING.RUN_CLOSED), 'and it does not claim the run finished');
  assert.notEqual(
    glass.WATCH_WORDING.RUN_OPEN,
    glass.WATCH_WORDING.RUN_CLOSED,
    'the 2 wordings are DISTINCT',
  );
});

/* ------------------------------------------------------------------------ *
 * 7. The CLI, as a real child process, BOUNDED
 * ------------------------------------------------------------------------ */

test('the watch CLI paints a bounded number of frames and TERMINATES', () => {
  const root = buildScratchTree('cli', overlappingEvents());
  const run = spawnSync(
    process.execPath,
    [GLASS_CLI, 'watch', '21', '--frames', '3', '--interval', '10'],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, FERROX_GLASS_ROOT: root } },
  );

  assert.equal(run.signal, null, 'it was never killed by a timeout, so the loop is BOUNDED');
  assert.equal(run.status, 0, `it exits 0: ${run.stderr}`);
  assert.ok(run.stdout.length > 0, 'NON ZERO output');

  const frames = run.stdout.match(/FLEET GLASS\s+watch/g) ?? [];
  assert.equal(frames.length, 3, 'exactly 3 frames were painted, which is the bound that was asked for');
  assert.match(run.stdout, /frame 3 of 3/, 'the last frame names its own index');
  assert.match(run.stdout, /CLOSING SUMMARY/, 'and the summary is painted once at the end');
  assert.equal(counterOnFrame(run.stdout, 'max concurrency observed'), 3, 'the summary reports the swept peak');
  assert.ok(
    !run.stdout.includes(glass.PANEL_WORDING.UNAVAILABLE),
    'the CLI rendered real data rather than a refusal, so this arm measures a working view',
  );
});

test('the watch CLI over the SEQUENTIAL fixture reports 1, through the SAME code path', () => {
  const root = buildScratchTree('cli-seq', sequentialEvents());
  const run = spawnSync(
    process.execPath,
    [GLASS_CLI, 'watch', '21', '--frames', '2', '--interval', '10'],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, FERROX_GLASS_ROOT: root } },
  );
  assert.equal(run.signal, null, 'BOUNDED');
  assert.equal(run.status, 0, `it exits 0: ${run.stderr}`);
  assert.equal(counterOnFrame(run.stdout, 'peak so far'), 1, 'the real CLI reports 1 for a run that took turns');
  assert.equal(counterOnFrame(run.stdout, 'max concurrency observed'), 1, 'and the summary agrees');
});

test('the watch CLI STOPS EARLY when the run closes, without waiting out its frame budget', () => {
  const events = [...overlappingEvents(), { kind: 'run_closed', ts: at(200), run_id: 'r1' }];
  const root = buildScratchTree('cli-closed', events);
  const run = spawnSync(
    process.execPath,
    [GLASS_CLI, 'watch', '21', '--frames', '50', '--interval', '10'],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, FERROX_GLASS_ROOT: root } },
  );
  assert.equal(run.signal, null, 'BOUNDED');
  assert.equal(run.status, 0, `it exits 0: ${run.stderr}`);
  const frames = run.stdout.match(/FLEET GLASS\s+watch/g) ?? [];
  assert.equal(frames.length, 1, 'it painted 1 frame and stopped, because the run was already closed');
  assert.ok(run.stdout.includes(glass.WATCH_WORDING.RUN_CLOSED), 'and the summary says the RUN closed');
});

test('the watch CLI over a tree with NO run log paints a NAMED unavailable panel', () => {
  const root = makeScratchRoot('cli-empty');
  const run = spawnSync(
    process.execPath,
    [GLASS_CLI, 'watch', '21', '--frames', '2', '--interval', '10'],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, FERROX_GLASS_ROOT: root } },
  );
  assert.equal(run.signal, null, 'BOUNDED even with nothing to read');
  assert.ok(run.stdout.includes(glass.PANEL_WORDING.UNAVAILABLE), 'it says UNAVAILABLE');
  assert.match(run.stdout, /fleet-runlog\.jsonl/, 'and it NAMES the file it could not reach');
  assert.equal(run.status, 1, 'a watch that never read a run exits non zero');
});

test('the watch CLI REFUSES with no phase, naming the usage rather than guessing', () => {
  const run = spawnSync(
    process.execPath,
    [GLASS_CLI, 'watch'],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(run.status, 1, 'it refuses');
  assert.match(run.stderr, /needs a phase/, 'it says what is missing');
  assert.match(run.stderr, /--frames/, 'and it names the usage');
});

/* ------------------------------------------------------------------------ *
 * 8. The frame is PURE
 * ------------------------------------------------------------------------ */

test('2 renders of the SAME model are byte identical, so the frame reads no clock', () => {
  const model = modelFor(overlappingEvents(), at(300), graphDocument());
  const first = glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }).join('\n');
  const second = glass.renderWatchFrame(model, { phase: '21', frame: 1, frames: 1 }).join('\n');
  assert.ok(first.length > 0, 'NON ZERO output');
  assert.equal(first, second, 'the frame is PURE over its model');
});

test('the fold does not MUTATE the events or the run record it was handed', () => {
  const runfold = loadRunfold();
  assert.ok(runfold !== null, 'the shipped lib is present');
  const events = overlappingEvents();
  const runRecord = runfold.foldRunRecord(events);
  const eventsBefore = JSON.stringify(events);
  const recordBefore = JSON.stringify(runRecord);

  const model = glass.foldWatch({ events, runRecord, graph: graphDocument(), now: at(300) });
  assert.ok(model.lanes.length > 0, 'NON ZERO: it really folded something');
  assert.equal(JSON.stringify(events), eventsBefore, 'the event array is untouched');
  assert.equal(JSON.stringify(runRecord), recordBefore, 'the run record is untouched');
});

/* ------------------------------------------------------------------------ *
 * Cleanup, following tests/fleet-glass-readonly.test.cjs
 * ------------------------------------------------------------------------ */

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
