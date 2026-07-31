'use strict';

/**
 * Phase 20 plan 05: the wiring half of SC1, and the closure of FF-B214.
 *
 * ─── THE DEFECT, AND THE MECHANISM THE BACKLOG ROW GETS WRONG ────────────────
 *
 * FF-B214 says a node whose worker keeps failing HOLDS THE CAPACITY. That is
 * false and was verified false: `scripts/fleet-loop.cjs:1476` calls
 * `releaseLease` on every `worker_ended`, so the capacity IS freed the moment the
 * worker exits. What the failing node holds is its POSITION. It is earliest in the
 * total order, it is ready on every pass, and `src/fleet-manager.cts:242-245`
 * truncates the ordered candidate list to free capacity in that order, so it wins
 * the slot again immediately, forever, and the nodes behind it never reach the
 * front. Parking is what takes it out of the ready set.
 *
 * ─── THE REPRODUCTION IS HALF THE PROOF ──────────────────────────────────────
 *
 * The FF-B214 case below drives ONE fixture graph TWICE and changes exactly 1
 * knob between the 2 arms:
 *
 *   ceiling raised beyond the pass budget   the failing nodes monopolize and the 3
 *                                           behind them are asserted NEVER
 *                                           dispatched
 *   ceiling at its default of 3             the failing nodes park and all 3 behind
 *                                           them are asserted dispatched
 *
 * An arm that only asserts the second half proves the loop dispatches nodes, which
 * it already did. The pair is what proves the ceiling is the thing that changed
 * the outcome, and both arms print their measured dispatch counts as diagnostics
 * so the closure is a measurement rather than a claim.
 *
 * ─── WHY CAPACITY 2 CARRIES 2 FAILING NODES ──────────────────────────────────
 *
 * The measured defect was 2 failing nodes at capacity 2: 21-01 and 21-02 each took
 * 16 rounds while 21-03, 21-04 and 21-05 were never dispatched once. One failing
 * node at capacity 2 does NOT starve anything, because the second slot stays free
 * and every node behind it is dispatched through it. The fixture reproduces the
 * shape that was actually observed rather than a smaller one that cannot starve.
 *
 * ─── NOTHING HERE SPAWNS AN AGENT OR CREATES A WORKTREE ──────────────────────
 *
 * Every arm injects `spawnWorker` and an already allowed `preflight`, and the
 * malformed flag arm injects the control plane itself, so the check that proves a
 * bad argument mints no cards cannot itself mint one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const loop = require('../scripts/fleet-loop.cjs');
const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');

/** The pass budget every arm runs under. A bound, never a search. */
const MAX_PASSES = 20;

/** A ceiling far past the pass budget, so no node can ever reach it. */
const UNREACHABLE_CEILING = 100000;

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-loop-park-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here, following tests/roadmap-index.test.cjs:885
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

/**
 * A scratch project holding 1 phase of plan files, built by this test.
 *
 * BUILT AND NEVER BORROWED. An empty untracked directory does not exist in any
 * git checkout, so a fixture phase that was borrowed rather than written passes on
 * 1 machine and nowhere else. That is FF-B217, paid once already.
 *
 * `plans` is a list of `[n, dependsOn]`, so a fixture can carry a genuine chain.
 */
function makeProject(label, { phase, plans }) {
  const root = scratch(label);
  const phaseDir = path.join(root, '.planning', 'phases', `${phase}-synth`);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const [n, dependsOn] of plans) {
    const plan = String(n).padStart(2, '0');
    const id = `${phase}-${plan}`;
    fs.writeFileSync(path.join(phaseDir, `${id}-PLAN.md`), [
      '---',
      `phase: ${phase}-synth`,
      `plan: ${plan}`,
      'type: execute',
      'wave: 1',
      `depends_on: [${dependsOn.map((d) => JSON.stringify(d)).join(', ')}]`,
      'files_modified:',
      `  - src/node-${plan}.cts`,
      'autonomous: true',
      '---',
      '',
      '<tasks>',
      '<task type="auto">',
      `  <name>node ${plan}</name>`,
      '</task>',
      '</tasks>',
      '',
    ].join('\n'));
  }
  return { root, phase, planning: path.join(root, '.planning') };
}

/**
 * The stub worker: a REAL script run as a REAL child process.
 *
 * It counts its own attempts on disk, so a node can be told to fail its first N
 * attempts and land afterwards. That is what lets the "a node that lands is never
 * parked" arm be driven rather than argued.
 *
 * argv: markerDir nodeId failTimes
 */
const WORKER_SOURCE = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [markerDir, nodeId, failTimes] = process.argv.slice(2);
fs.mkdirSync(markerDir, { recursive: true });
const marker = path.join(markerDir, 'n-' + nodeId.replace(/[^A-Za-z0-9_.-]/g, '_'));
let count = 0;
try { count = Number(fs.readFileSync(marker, 'utf8')) || 0; } catch { count = 0; }
count += 1;
fs.writeFileSync(marker, String(count));
if (count <= Number(failTimes)) process.exitCode = 1;
`;

function writeWorkerScript(project) {
  const scriptPath = path.join(project.root, 'stub-worker.cjs');
  fs.writeFileSync(scriptPath, WORKER_SOURCE);
  return scriptPath;
}

/** A land seam that always reports green, so a clean delivery really lands. */
function greenLand() {
  const calls = [];
  const seam = (ctx) => {
    calls.push({ node_id: ctx.nodeId, attempt_id: ctx.attemptId });
    return { code: 0, verdict: 'green', result: 'landed' };
  };
  seam.calls = calls;
  return seam;
}

function allowedPreflight() {
  return {
    checks: loop.CHECK_NAMES.map((name) => ({ name, ok: true, observed: {}, refused_because: null })),
    check_names: [...loop.CHECK_NAMES],
    dispatch_allowed: true,
  };
}

/**
 * Drive 1 whole run against a fixture and hand back everything observed.
 *
 * `failTimes` maps a node id to how many of its attempts fail. A very large number
 * is a node that never lands.
 */
async function drive(project, {
  arm,
  capacity,
  failTimes = {},
  parkAfterAttempts,
  parkBudget,
  maxPasses = MAX_PASSES,
}) {
  const scriptPath = writeWorkerScript(project);
  const markerDir = path.join(project.root, `markers-${arm}`);
  const land = greenLand();
  const stderrLines = [];

  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: path.join(project.planning, `runlog-${arm}.jsonl`),
    projectionPath: path.join(project.planning, `board-${arm}.json`),
    tokenDir: project.planning,
    repoKey: `loop-park/${arm}`,
    runId: `run-${arm}`,
    capacity,
    clock: () => Date.now(),
    ttlMs: 3600000,
    heartbeatMs: 60,
    // The pass wakes on a WORKER EXIT, and the tick is only the bound that keeps a
    // hung worker from stalling the run. A short tick here would spend the pass
    // budget on waiting rather than on dispatching, which would make every count
    // below a measurement of the timer instead of a measurement of the schedule.
    waitTickMs: 2000,
    maxPasses,
    parkAfterAttempts,
    parkBudget,
    preflight: allowedPreflight(),
    landCommand: land,
    writeErr: (s) => stderrLines.push(s),
    spawnWorker: (ctx) => spawn(process.execPath, [
      scriptPath,
      markerDir,
      String(ctx.nodeId),
      String(failTimes[ctx.nodeId] ?? 0),
    ], { stdio: ['ignore', 'pipe', 'pipe'] }),
  });

  const events = runlog.readFleetRunlog({ path: result.log_path });
  return { result, events, land, stderrLines };
}

/** How many times each node was dispatched, from the events the DRIVER wrote. */
function dispatchCounts(events) {
  const counts = new Map();
  for (const event of events) {
    if (event.kind !== 'worker_started') continue;
    const id = String(event.node_id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function countOf(counts, id) {
  return counts.get(id) ?? 0;
}

function parkedIds(events) {
  return events.filter((e) => e.kind === 'node_parked').map((e) => String(e.node_id));
}

/** The 5 node fixture the FF-B214 arm drives twice: 2 that fail, 3 behind them. */
const STARVE_PHASE = '31';
const STARVE_FAILING = ['31-01', '31-02'];
const STARVE_BEHIND = ['31-03', '31-04', '31-05'];

function makeStarveProject() {
  return makeProject('starve', {
    phase: STARVE_PHASE,
    plans: [[1, []], [2, []], [3, []], [4, []], [5, []]],
  });
}

/** Every attempt of the 2 head nodes fails, forever. */
const STARVE_FAIL_TIMES = { '31-01': 1e9, '31-02': 1e9 };

// ── the fixture itself, asserted before anything is concluded from it ────────

test('the starvation fixture really puts the 2 failing nodes at the front of the total order', () => {
  const project = makeStarveProject();
  const scan = require('../ferrox-core/bin/lib/workgraph-scan.cjs');
  const built = scan.buildWorkgraph({ cwd: project.root, phase: project.phase });

  assert.equal(built.ok, true, `the fixture phase did not scan: ${built.message}`);
  const order = new Map(built.document.nodes.map((n) => [n.id, n.schedule_order]));
  assert.equal(order.size, 5);
  // The whole mechanism is POSITION, so a fixture whose failing nodes are not at
  // the front cannot starve anything and the arm below would pass for the wrong
  // reason.
  for (const failing of STARVE_FAILING) {
    for (const behind of STARVE_BEHIND) {
      assert.ok(
        order.get(failing) < order.get(behind),
        `${failing} must sort before ${behind} or the fixture cannot reproduce FF-B214`,
      );
    }
  }
});

// ── FF-B214: reproduced, then closed, over 1 fixture ────────────────────────

test('FF-B214 REPRODUCED: with the ceiling raised past the pass budget the 2 failing nodes take every slot and the 3 behind them are NEVER dispatched', async (t) => {
  const project = makeStarveProject();
  const { result, events } = await drive(project, {
    arm: 'raised',
    capacity: 2,
    failTimes: STARVE_FAIL_TIMES,
    parkAfterAttempts: UNREACHABLE_CEILING,
  });

  const counts = dispatchCounts(events);
  t.diagnostic(
    `ceiling raised: ${STARVE_FAILING.concat(STARVE_BEHIND)
      .map((id) => `${id}=${countOf(counts, id)}`).join(' ')} stopped_by=${result.stopped_by}`,
  );

  assert.equal(result.stopped_by, 'pass_ceiling', 'the run must have run out of budget, not drained');
  assert.equal(parkedIds(events).length, 0, 'nothing may park when the ceiling is unreachable');

  for (const failing of STARVE_FAILING) {
    assert.ok(
      countOf(counts, failing) >= 3,
      `${failing} monopolized nothing: it was dispatched ${countOf(counts, failing)} times`,
    );
  }
  for (const behind of STARVE_BEHIND) {
    assert.equal(
      countOf(counts, behind), 0,
      `${behind} was dispatched ${countOf(counts, behind)} times, so this arm did not reproduce the starvation `
      + 'and the closure arm below proves nothing',
    );
  }
});

test('FF-B214 CLOSED: the same fixture with the ceiling at its default parks the 2 failing nodes and every node behind them is dispatched', async (t) => {
  const project = makeStarveProject();
  // parkAfterAttempts is deliberately NOT passed. The default is the thing under
  // test: a bound that only holds when a caller states it is not a default.
  const { result, events } = await drive(project, {
    arm: 'closed',
    capacity: 2,
    failTimes: STARVE_FAIL_TIMES,
  });

  const counts = dispatchCounts(events);
  t.diagnostic(
    `ceiling default: ${STARVE_FAILING.concat(STARVE_BEHIND)
      .map((id) => `${id}=${countOf(counts, id)}`).join(' ')} stopped_by=${result.stopped_by}`,
  );

  assert.deepEqual(parkedIds(events).sort(), [...STARVE_FAILING].sort());
  for (const failing of STARVE_FAILING) {
    assert.equal(
      countOf(counts, failing), loop.DEFAULT_PARK_AFTER_ATTEMPTS,
      `${failing} was dispatched past its ceiling, so the park did not remove it from the ready set`,
    );
  }
  for (const behind of STARVE_BEHIND) {
    assert.ok(
      countOf(counts, behind) >= 1,
      `${behind} was still never dispatched, so parking did not free the position`,
    );
  }
  assert.equal(result.stopped_by, 'drained');
});

test('a parked node appears in NO later pass dispatch list', async () => {
  const project = makeStarveProject();
  const { result, events } = await drive(project, {
    arm: 'nolater',
    capacity: 2,
    failTimes: STARVE_FAIL_TIMES,
  });

  const parkedAt = new Map();
  for (const [index, pass] of result.passes.entries()) {
    for (const id of pass.decided) {
      if (!STARVE_FAILING.includes(id)) continue;
      parkedAt.set(id, index);
    }
  }
  for (const failing of STARVE_FAILING) {
    const last = parkedAt.get(failing);
    assert.equal(typeof last, 'number', `${failing} was never dispatched at all`);
    const later = result.passes.slice(last + 1).filter((p) => p.decided.includes(failing));
    assert.deepEqual(later, [], `${failing} was decided again after it parked`);
  }
  assert.equal(parkedIds(events).length, 2);
});

// ── the boundary: 1 below the ceiling is not a park ──────────────────────────

test('a node at the ceiling MINUS 1 is not parked, and the same node at the ceiling is', async (t) => {
  const boundary = { phase: '35', plans: [[1, []], [2, []]] };
  // Both arms run the same fixture at the same capacity under the same pass
  // budget. The ONLY difference is the ceiling, so the outcome cannot be
  // attributed to anything else. Pass 3 is the decisive instant in both: 35-01
  // stands at 3 attempts, which is the ceiling minus 1 below and the ceiling at.
  const shared = { capacity: 1, failTimes: { '35-01': 1e9 }, maxPasses: 4 };

  const below = makeProject('below', boundary);
  const belowRun = await drive(below, { ...shared, arm: 'below', parkAfterAttempts: 4 });
  const belowAttempts = countOf(dispatchCounts(belowRun.events), '35-01');
  t.diagnostic(`ceiling 4: 35-01 reached ${belowAttempts} attempts, parks ${parkedIds(belowRun.events).length}`);
  // BOTH halves. Without the first the arm is vacuous: a node that reached 0
  // attempts also fails to park.
  assert.equal(belowAttempts, 4, 'the arm must reach the ceiling minus 1 and be DISPATCHED there');
  assert.deepEqual(parkedIds(belowRun.events), []);

  const at = makeProject('at', boundary);
  const atRun = await drive(at, { ...shared, arm: 'at', parkAfterAttempts: 3 });
  const atAttempts = countOf(dispatchCounts(atRun.events), '35-01');
  t.diagnostic(`ceiling 3: 35-01 reached ${atAttempts} attempts, parks ${parkedIds(atRun.events).length}`);
  assert.equal(atAttempts, 3, 'the ceiling must stop the node at exactly its ceiling');
  assert.deepEqual(parkedIds(atRun.events), ['35-01']);
});

test('the node_parked record names the node, the reason, the attempt count and the critical path fact', async () => {
  const project = makeStarveProject();
  const { events } = await drive(project, {
    arm: 'record',
    capacity: 2,
    failTimes: STARVE_FAIL_TIMES,
  });

  const parks = events.filter((e) => e.kind === 'node_parked');
  assert.equal(parks.length, 2);
  for (const park of parks) {
    assert.ok(STARVE_FAILING.includes(String(park.node_id)));
    assert.equal(park.reason, 'attempt_ceiling');
    assert.equal(park.attempts, loop.DEFAULT_PARK_AFTER_ATTEMPTS);
    assert.equal(typeof park.on_critical_path, 'boolean');
    assert.equal(park.run_id, 'run-record');
  }
});

// ── a node that lands is never parked ───────────────────────────────────────

test('a node that lands is NEVER parked, however many attempts it took', async (t) => {
  const project = makeProject('lands', { phase: '36', plans: [[1, []], [2, []]] });
  // 36-01 fails 2 attempts and lands on its 3rd, so it stands AT its ceiling of 3
  // when the next pass reads the log. The land is what must take it out of the
  // park test, and the land is derived from the log rather than from an exit code.
  const { result, events } = await drive(project, {
    arm: 'lands',
    capacity: 1,
    failTimes: { '36-01': 2 },
    parkAfterAttempts: 3,
    maxPasses: 12,
  });

  const attempts = countOf(dispatchCounts(events), '36-01');
  t.diagnostic(`36-01 took ${attempts} attempts, parks ${parkedIds(events).length}, stopped_by ${result.stopped_by}`);
  assert.equal(attempts, 3, 'the arm must leave the node standing AT its ceiling, or it proves nothing');
  assert.deepEqual(parkedIds(events), [], 'a node that landed was parked anyway');
  assert.ok(
    events.some((e) => e.kind === 'land_completed' && String(e.node_id) === '36-01'),
    'the arm never actually landed the node it claims landed',
  );
});

// ── the 2 alarm routes, CONTEXT D7.5 ────────────────────────────────────────

/**
 * The fixture that carries a GENUINE critical path node AND a GENUINE off path
 * node, both of which park in 1 run.
 *
 * CONTEXT D8: a fixture in which everything is on the path cannot fail. So this
 * one has a real chain, 33-01 into 33-02 into 33-03, and 6 nodes that are not on
 * it. 33-01 and 33-04 are the 2 that never land, so the run parks 1 node on the
 * path and 1 node off it.
 *
 * The 5 landing nodes are not decoration either. They are what guarantees the
 * park pass STILL DISPATCHES something, which is the only way the queued alarm's
 * position can be told apart from the synchronous one's.
 */
const ROUTE_PHASE = '33';

function makeRouteProject() {
  return makeProject('routes', {
    phase: ROUTE_PHASE,
    plans: [
      [1, []], [2, ['33-01']], [3, ['33-02']],
      [4, []], [5, []], [6, []], [7, []], [8, []], [9, []],
    ],
  });
}

const ROUTE_FAIL_TIMES = { '33-01': 1e9, '33-04': 1e9 };

let routeRun = null;

async function driveRoutes() {
  if (routeRun !== null) return routeRun;
  const project = makeRouteProject();
  routeRun = await drive(project, {
    arm: 'routes',
    capacity: 3,
    failTimes: ROUTE_FAIL_TIMES,
    maxPasses: 30,
  });
  routeRun.project = project;
  return routeRun;
}

test('the route fixture carries a genuine critical path node AND a genuine off path node', async () => {
  const { project, events } = await driveRoutes();
  const scan = require('../ferrox-core/bin/lib/workgraph-scan.cjs');
  const parkLib = require('../ferrox-core/bin/lib/fleet-park.cjs');
  const built = scan.buildWorkgraph({ cwd: project.root, phase: project.phase });

  const chain = parkLib.criticalPath(built.document);
  assert.deepEqual(chain, ['33-01', '33-02', '33-03'], 'the fixture lost its chain');
  assert.ok(!chain.includes('33-04'), '33-04 must be genuinely OFF the path');

  // And the run recorded the same 2 facts, at the moment of each park.
  const parks = new Map(events.filter((e) => e.kind === 'node_parked').map((e) => [String(e.node_id), e]));
  assert.equal(parks.size, 2);
  assert.equal(parks.get('33-01').on_critical_path, true);
  assert.equal(parks.get('33-04').on_critical_path, false);
});

test('both alarm routes occur in 1 run and are distinguishable by the route FIELD', async () => {
  const { events } = await driveRoutes();
  const alarms = events.filter((e) => e.kind === 'park_alarm' && e.scope === 'node');

  assert.equal(alarms.length, 2, 'exactly 1 node scoped alarm per park');
  const sync = alarms.find((a) => a.route === 'synchronous');
  const queued = alarms.find((a) => a.route === 'queued');
  assert.ok(sync !== undefined, 'the critical path park did not alarm synchronously');
  assert.ok(queued !== undefined, 'the off path park did not alarm through the queue');
  assert.equal(String(sync.node_id), '33-01');
  assert.equal(String(queued.node_id), '33-04');

  // The 2 records differ ONLY in what distinguishes them. Everything else, the
  // scope, the budget and the run, is identical, so a reader branching on `route`
  // is branching on the only thing that carries the routing decision.
  assert.equal(sync.scope, queued.scope);
  assert.equal(sync.budget, queued.budget);
  assert.equal(sync.run_id, queued.run_id);
  assert.deepEqual(
    Object.keys(sync).sort(),
    ['budget', 'kind', 'node_id', 'parked_count', 'route', 'run_id', 'scope', 'ts'],
  );
  assert.deepEqual(Object.keys(sync).sort(), Object.keys(queued).sort());
});

/**
 * ─── WHY THIS ARM MEASURES EACH ALARM AGAINST ITS OWN PARK ───────────────────
 *
 * It used to measure the DISTANCE BETWEEN THE 2 ALARMS, and that arm could not
 * fire. `33-01` and `33-04` reach their ceilings on different passes, so an
 * entire intervening pass sat between the 2 alarms whatever the routing did, and
 * raising the off path alarm inline instead of queueing it left the file 21/21
 * green. The threshold was satisfied by the fixture's pass structure rather than
 * by the queue drain, which is precisely the defect class this phase exists to
 * remove. It also sliced with an index of `-1` when no queued alarm existed at
 * all, so it was vacuously true of an ABSENT payload as well.
 *
 * The distance from each alarm to ITS OWN park is a different quantity and the
 * mutant cannot fake it. A synchronous alarm is written inside the park loop, so
 * it lands at its park's index plus 1 and nothing can be interposed. A queued
 * alarm is drained after the pass's dispatch bookkeeping, so records the pass
 * wrote AFTER that park separate the 2. An implementation that wrote both alarms
 * at the same instant and merely relabelled them puts the queued alarm at its own
 * park plus 1 too, and that collapse is what this arm refuses. The only way to
 * satisfy it is to actually defer, which is the behaviour.
 */
test('each alarm route is ALSO distinguishable by its POSITION relative to its OWN park', async (t) => {
  const { events } = await driveRoutes();
  const indexOfKind = (pred) => events.findIndex(pred);

  const syncParkAt = indexOfKind((e) => e.kind === 'node_parked' && String(e.node_id) === '33-01');
  const syncAlarmAt = indexOfKind((e) => e.kind === 'park_alarm' && e.route === 'synchronous' && e.scope === 'node');
  const queuedParkAt = indexOfKind((e) => e.kind === 'node_parked' && String(e.node_id) === '33-04');
  const queuedAlarmAt = indexOfKind((e) => e.kind === 'park_alarm' && e.route === 'queued');

  // EVERY INDEX IS PROVED PRESENT BEFORE IT IS USED. `findIndex` answers -1 for
  // an absent record, and `slice(a, -1)` slices from the END rather than
  // returning empty, so an arm that skipped this would read as satisfied by a
  // run that raised no queued alarm at all.
  for (const [label, at] of [
    ['33-01 node_parked', syncParkAt],
    ['the synchronous node alarm', syncAlarmAt],
    ['33-04 node_parked', queuedParkAt],
    ['the queued alarm', queuedAlarmAt],
  ]) {
    assert.ok(at >= 0, `${label} is ABSENT from the run, so this arm has nothing to position`);
  }

  // The synchronous alarm is written AT THE MOMENT OF THE PARK, so nothing the
  // pass wrote afterwards comes between the 2 records.
  assert.equal(
    syncAlarmAt, syncParkAt + 1,
    'the synchronous alarm did not fire at the moment of the park',
  );

  // The queued alarm is drained AFTER the pass did its work, so the pass's own
  // dispatch bookkeeping sits between the off path node's park and its alarm.
  // This is the half a `route` field alone cannot prove.
  const afterQueuedPark = events.slice(queuedParkAt + 1, queuedAlarmAt);
  t.diagnostic(
    `33-04 parked at ${queuedParkAt}, alarmed at ${queuedAlarmAt}, `
      + `${afterQueuedPark.length} records between them: `
      + `${JSON.stringify(afterQueuedPark.map((e) => e.kind))}`,
  );
  assert.ok(
    queuedAlarmAt > queuedParkAt + 1,
    'the queued alarm sits immediately after its own park, exactly where a SYNCHRONOUS alarm '
      + 'sits. The 2 routes have collapsed into 1 with 2 labels.',
  );
  assert.ok(
    afterQueuedPark.some((e) => e.kind === 'worker_started'),
    'the records separating the off path park from its alarm are not the pass\'s own dispatch '
      + 'bookkeeping, so the deferral this arm claims to observe is not the queue drain',
  );
});

test('the synchronous route is LOUD on stderr and the queued route is not', async () => {
  const { stderrLines } = await driveRoutes();
  const loud = stderrLines.filter((line) => line.includes(loop.PARK_ALARM_MARKER));

  assert.ok(
    loud.some((line) => line.includes('33-01')),
    'a human watching the fleet saw nothing when a critical path node parked',
  );
  assert.ok(
    !loud.some((line) => line.includes('33-04')),
    'the off path park was loud too, so the 2 routes are the same route with 2 labels',
  );
});

// ── the budget alarm, 3 observations ────────────────────────────────────────

test('the budget alarm is ABSENT in a run that parked the budget MINUS 1 nodes', async (t) => {
  // The route fixture parks exactly 2 nodes and the default budget is 3.
  const { events } = await driveRoutes();
  const parks = events.filter((e) => e.kind === 'node_parked');
  const budgetAlarms = events.filter((e) => e.kind === 'park_alarm' && e.scope === 'budget');

  t.diagnostic(`${parks.length} parks against a budget of ${loop.DEFAULT_PARK_AFTER_ATTEMPTS}`);
  assert.equal(parks.length, 2, 'the arm must really sit at the budget minus 1');
  assert.deepEqual(
    budgetAlarms, [],
    'an alarm that fires below its budget is an always on alarm, which is the trivial pass D8 names',
  );
});

test('the budget alarm is PRESENT exactly once in a run that parked BUDGET nodes', async (t) => {
  const project = makeProject('atbudget', {
    phase: '37', plans: [[1, []], [2, []], [3, []], [4, []], [5, []]],
  });
  const { events, stderrLines } = await drive(project, {
    arm: 'atbudget',
    capacity: 3,
    failTimes: { '37-01': 1e9, '37-02': 1e9, '37-03': 1e9 },
    maxPasses: 30,
  });

  const parks = events.filter((e) => e.kind === 'node_parked');
  const budgetAlarms = events.filter((e) => e.kind === 'park_alarm' && e.scope === 'budget');
  t.diagnostic(`${parks.length} parks, ${budgetAlarms.length} budget alarms`);

  assert.equal(parks.length, 3);
  assert.equal(budgetAlarms.length, 1, 'exactly 1 loud alarm at the budget');
  assert.equal(budgetAlarms[0].route, 'synchronous');
  assert.equal(budgetAlarms[0].parked_count, 3);
  assert.equal(budgetAlarms[0].budget, 3);
  assert.ok(
    stderrLines.some((line) => line.includes(loop.PARK_ALARM_MARKER) && line.includes('budget')),
    'the budget alarm was not loud, so a fleet stalls quietly at its budget',
  );
});

test('a run that parks PAST its budget does not write a second budget alarm', async (t) => {
  const project = makeProject('overbudget', {
    phase: '38', plans: [[1, []], [2, []], [3, []], [4, []], [5, []]],
  });
  const { events } = await drive(project, {
    arm: 'overbudget',
    capacity: 4,
    failTimes: { '38-01': 1e9, '38-02': 1e9, '38-03': 1e9, '38-04': 1e9 },
    maxPasses: 30,
  });

  const parks = events.filter((e) => e.kind === 'node_parked');
  const budgetAlarms = events.filter((e) => e.kind === 'park_alarm' && e.scope === 'budget');
  t.diagnostic(`${parks.length} parks, ${budgetAlarms.length} budget alarms`);

  assert.equal(parks.length, 4, 'the arm must really park past its budget');
  assert.equal(budgetAlarms.length, 1, 'the alarm repeated, so it would fire on every pass afterwards');
  // D7.1 says the fleet raises 1 loud alarm at the budget. It does NOT say the
  // run ends, so the run must have kept going and drained on its own terms.
  assert.equal(events.filter((e) => e.kind === 'run_closed').length, 1);
});

// ── the blocked subtree, on a REAL run ──────────────────────────────────────

test('the summary carries parked, blocked_on_human and park_alarms', async () => {
  const { result } = await driveRoutes();

  assert.deepEqual(result.parked, ['33-01', '33-04']);
  assert.equal(result.park_budget, 3);
  assert.equal(result.park_after_attempts, loop.DEFAULT_PARK_AFTER_ATTEMPTS);
  assert.equal(result.park_alarms.length, 2);
  for (const alarm of result.park_alarms) {
    assert.equal(alarm.scope, 'node');
    assert.equal(alarm.budget, 3);
  }
});

test('blocked_on_human is the EXACT descendant set, and a named non descendant is ABSENT', async (t) => {
  const { result, events } = await driveRoutes();
  const blocked = result.blocked_on_human;
  t.diagnostic(`parked ${result.parked.join(',')} blocked ${blocked.join(',')}`);

  // Every descendant of the parked node, by id.
  assert.deepEqual(blocked, ['33-02', '33-03']);

  // CONTEXT D7.3: over marking is as wrong as under marking. 33-05 through 33-09
  // are real, reachable work that landed in this very run, and a run record
  // reporting them as blocked on a human would send somebody to look at nothing.
  for (const notDescendant of ['33-05', '33-06', '33-07', '33-08', '33-09']) {
    assert.ok(
      !blocked.includes(notDescendant),
      `${notDescendant} is not a descendant of any parked node and must not be marked blocked`,
    );
    assert.ok(
      events.some((e) => e.kind === 'land_completed' && String(e.node_id) === notDescendant),
      `${notDescendant} did not actually land, so calling it reachable work proves nothing`,
    );
  }

  // The parked nodes themselves are parked, not blocked. They are 2 different
  // states and a reader has to be able to tell them apart.
  for (const parked of result.parked) assert.ok(!blocked.includes(parked));

  // And the blocked nodes really were undispatchable, rather than merely labelled.
  for (const id of blocked) {
    assert.ok(
      !events.some((e) => e.kind === 'worker_started' && String(e.node_id) === id),
      `${id} is reported blocked but was dispatched`,
    );
  }
});

// ── the flags, validated BEFORE anything with a side effect ─────────────────

/**
 * Every flag arm below drives `main` against a SCRATCH FIXTURE with an INJECTED
 * control plane, and never against this repository.
 *
 * That is not tidiness. Driving a malformed flag at the real tree would mint real
 * cards and real git worktrees in the primary tree before refusing IF the argument
 * ordering ever regressed, which is exactly the failure these arms exist to catch.
 * A check must not be able to cause the damage it is testing for.
 */
const FLAG_PHASE = '39';

function makeFlagProject(label) {
  return makeProject(label, { phase: FLAG_PHASE, plans: [[1, []], [2, []], [3, []]] });
}

test('a malformed park flag refuses BEFORE the control plane is reached, and mints nothing', async () => {
  const project = makeFlagProject('flags');
  const logPath = path.join(project.planning, 'flags.jsonl');

  for (const [flag, bad] of [
    ['park-budget', 'four'],
    ['park-budget', '0'],
    ['park-budget', '2.5'],
    ['park-after-attempts', 'zero'],
    ['park-after-attempts', '-1'],
    ['park-after-attempts', ''],
  ]) {
    let planeCalls = 0;
    await assert.rejects(
      () => loop.main({
        argv: [project.phase, '--run', `--log=${logPath}`, `--${flag}=${bad}`],
        repoRoot: project.root,
        ensureControlPlane: () => { planeCalls += 1; return { cards: {}, home: '' }; },
        runLoop: () => { throw new Error('the loop must never be reached on a refused argument'); },
        write: () => {},
        writeErr: () => {},
      }),
      new RegExp(`--${flag} must be a positive whole number`),
      `--${flag}=${JSON.stringify(bad)} did not refuse`,
    );
    assert.equal(
      planeCalls, 0,
      `--${flag}=${JSON.stringify(bad)} reached the control plane before it was validated, which is `
      + 'how --capacity=four once minted work cards and real git worktrees before refusing',
    );
  }

  // The fixture's own ratchet home and card store were never created.
  assert.equal(fs.existsSync(path.join(project.root, '.ferrox')), false);
  assert.equal(fs.existsSync(logPath), false);
});

test('a VALID park flag does reach the control plane and the loop, so the refusal arm discriminates', async () => {
  const project = makeFlagProject('flagsok');
  const logPath = path.join(project.planning, 'flagsok.jsonl');
  let planeCalls = 0;
  let seen = null;

  const code = await loop.main({
    argv: [
      project.phase, '--run', '--raw', `--log=${logPath}`,
      '--park-budget=5', '--park-after-attempts=2',
    ],
    repoRoot: project.root,
    // Phase 20 SC2 made the dispatch branch run the preflight BEFORE the control
    // plane, and its fourth check probes the adapters this project declares in
    // `fleet.adapters` by SPAWNING each one with a real prompt.
    //
    // This comment used to say "this repository declares none, so the real
    // preflight refuses". That was true when it was written and is FALSE now:
    // phase 23 configured `claude`, `codex`, `gemini` for the live A/B and left
    // them configured. The injection below is therefore load bearing for SPEND
    // and not only for the question being asked. See FF-B470 for the producer
    // defect that makes the roster reachable from a run targeting another root,
    // and FF-B469 for this class of stale justification.
    //
    // The question this arm asks is whether a VALID flag travels to the plane
    // and the loop, so the verdict is injected rather than earned.
    runPreflight: async () => ({
      checks: loop.CHECK_NAMES.map((name) => ({ name, ok: true, observed: {}, refused_because: null })),
      check_names: [...loop.CHECK_NAMES],
      dispatch_allowed: true,
    }),
    ensureControlPlane: () => { planeCalls += 1; return { cards: {}, home: '' }; },
    runLoop: (opts) => {
      seen = opts;
      return {
        run_id: 'run-flagsok', dispatch_allowed: true, stopped_by: 'drained',
        passes: [], dispatched: [], parked: [], blocked_on_human: [], park_alarms: [],
      };
    },
    write: () => {},
    writeErr: () => {},
  });

  assert.equal(code, 0);
  assert.equal(planeCalls, 1, 'a valid value never reached the control plane, so the arm above is vacuous');
  assert.equal(seen.parkBudget, 5, 'the flag never reached the loop');
  assert.equal(seen.parkAfterAttempts, 2, 'the flag never reached the loop');
});

test('the 2 park flags are read from argv and are separate knobs', () => {
  const parsed = loop.readArgv(['20', '--run', '--park-budget=7', '--park-after-attempts=9']);
  assert.equal(parsed.parkBudget, '7');
  assert.equal(parsed.parkAfterAttempts, '9');
  const absent = loop.readArgv(['20', '--run']);
  assert.equal(absent.parkBudget, null);
  assert.equal(absent.parkAfterAttempts, null);
});

// ── the exit code ───────────────────────────────────────────────────────────

/** Drive `main` over a fixture with the REAL loop behind an injected seam. */
async function driveMain(project, { arm, capacity, failTimes = {}, argv = [] }) {
  const scriptPath = writeWorkerScript(project);
  const markerDir = path.join(project.root, `markers-${arm}`);
  const logPath = path.join(project.planning, `main-${arm}.jsonl`);
  const stdout = [];
  const stderr = [];

  const code = await loop.main({
    argv: [project.phase, '--run', '--raw', `--log=${logPath}`, ...argv],
    repoRoot: project.root,
    // ── THE PREFLIGHT IS INJECTED HERE BECAUSE THE REAL ONE SPENDS, FF-B470 ──
    //
    // `main` runs the preflight before the control plane, and its fourth check
    // probes every identity in `fleet.adapters` by SPAWNING IT with a real
    // prompt. `runPreflight` does not thread this run's `repoRoot` into that
    // check, so `checkAdapters` falls back to the module level `REPO_ROOT` and
    // reads THIS repository's live roster no matter which project the run
    // targets. Phase 23 configured that roster to `claude`, `codex`, `gemini`
    // for the live A/B and left it configured.
    //
    // MEASURED, not supposed: with the 3 adapters shadowed by counting shims,
    // this file attempted 6 real paid calls per run, 2 nonces across 3 vendors,
    // every one with `cwd` at the real repository. `driveMain` is called twice
    // and was the whole of it.
    //
    // The arms below ask what a run does once dispatch is ALLOWED, so the
    // verdict is injected rather than bought. The producer defect is FF-B470
    // and is not fixed here.
    runPreflight: async () => allowedPreflight(),
    ensureControlPlane: () => ({ cards: {}, home: '' }),
    // The REAL driver, with the seams every arm in this file uses, so the exit
    // code below is computed from a real run rather than from a shape.
    runLoop: (opts) => loop.runLoop({
      ...opts,
      projectionPath: path.join(project.planning, `main-board-${arm}.json`),
      tokenDir: project.planning,
      repoKey: `loop-park-main/${arm}`,
      runId: `run-main-${arm}`,
      capacity,
      clock: () => Date.now(),
      ttlMs: 3600000,
      heartbeatMs: 60,
      waitTickMs: 2000,
      maxPasses: 30,
      preflight: allowedPreflight(),
      landCommand: greenLand(),
      writeErr: (s) => stderr.push(s),
      spawnWorker: (ctx) => spawn(process.execPath, [
        scriptPath, markerDir, String(ctx.nodeId), String(failTimes[ctx.nodeId] ?? 0),
      ], { stdio: ['ignore', 'pipe', 'pipe'] }),
    }),
    write: (s) => stdout.push(s),
    writeErr: (s) => stderr.push(s),
  });

  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

test('a drained run that PARKED work does not exit 0, and names the parked nodes', async (t) => {
  const project = makeProject('exitparked', { phase: '40', plans: [[1, []], [2, ['40-01']], [3, []]] });
  const run = await driveMain(project, {
    arm: 'parked', capacity: 2, failTimes: { '40-01': 1e9 },
  });
  t.diagnostic(`exit ${run.code}`);

  const printed = JSON.parse(run.stdout);
  assert.equal(printed.summary.stopped_by, 'drained');
  assert.deepEqual(printed.summary.parked, ['40-01']);
  assert.deepEqual(printed.summary.blocked_on_human, ['40-02']);

  // A truncated run that exited 0 reads as a green fleet to any caller that
  // checks only the status, which is the same defect as a guard that cannot fire.
  assert.notEqual(run.code, 0, 'a run that abandoned work reported success');
  assert.match(run.stderr, /40-01/);
  assert.match(run.stderr, /parked/);
});

test('a drained run that parked NOTHING still exits 0', async (t) => {
  const project = makeProject('exitclean', { phase: '41', plans: [[1, []], [2, ['41-01']], [3, []]] });
  const run = await driveMain(project, { arm: 'clean', capacity: 2 });
  t.diagnostic(`exit ${run.code}`);

  const printed = JSON.parse(run.stdout);
  assert.equal(printed.summary.stopped_by, 'drained');
  assert.deepEqual(printed.summary.parked, []);
  assert.deepEqual(printed.summary.blocked_on_human, []);
  // THE DISCRIMINATING ARM. Without it the change above is indistinguishable from
  // making the command fail more often.
  assert.equal(run.code, 0, 'a run that finished its graph was reported as a failure');
  // THE LOUD CHANNEL CARRIES EXACTLY 1 LINE, AND IT IS NOT AN ALARM ABOUT THIS
  // RUN. Plan 23-01 wired `--verify-post-land` and made a dispatching run that
  // wired no verifier say so on this channel, because `unknown` is a legal member
  // of the classification vocabulary and a reader otherwise cannot tell a
  // verifier that was never wired from one that ran and abstained.
  //
  // This arm's own question is unchanged and the assertion is still exact rather
  // than a loosened match: strip that 1 known line and what remains must be
  // empty, so a park alarm or a bounded stop notice would still turn it red.
  assert.match(run.stderr, /wired NO post land verifier/);
  assert.equal(run.stderr.replace(`${loop.VERIFY_POST_LAND_ABSENT_WARNING}\n`, ''), '');
});
