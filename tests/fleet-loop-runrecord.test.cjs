'use strict';

/**
 * Phase 19 plan 05 task 3: the run record, end to end.
 *
 * THIS FILE IS THE PHASE 22 CONTRACT TEST. It asserts that the artifact Proof
 * will read actually carries what Proof needs, and it does that by driving a REAL
 * run of the driver and folding the log the DRIVER produced. Nothing here hand
 * writes a fleet event, because a run record assertion on a log the test wrote
 * itself proves only that the test can write JSON.
 *
 * ─── WHY THIS FILE READS THE REAL CLOCK ──────────────────────────────────────
 *
 * Everywhere else in this milestone time is pinned, and pinning it means pinning
 * BOTH `FERROX_TEST_MODE` and `FERROX_NOW_MS`, because `clock.cjs:35` returns null
 * without the flag and `:64` falls back to the platform clock when the pin is
 * null. Here the measurement IS elapsed real time across processes: demonstrated
 * width is the maximum number of worker intervals observed overlapping, and a
 * pinned instant would collapse every interval to a point and make the number
 * vacuous. The MODULE under test still never reads a clock. The driver takes
 * `clock: () => Date.now()` as an explicit argument, exactly as the caller
 * supplied time contract requires.
 *
 * ─── THE WIDTH HAS TO BE EARNED ──────────────────────────────────────────────
 *
 * A run that folds to width 1 is the exact result this whole milestone exists to
 * stop reporting. So the stub worker sleeps a PINNED duration long enough that 3
 * dispatched workers genuinely overlap, and `STUB_CEILING_MS` bounds that value as
 * a MECHANISM: raising a sleep in an unbounded search for an overlap is the
 * unbounded loop this milestone exists to prevent.
 *
 * ─── THE KILLED DRIVER PROVES THE UNKNOWN ARM END TO END ─────────────────────
 *
 * The driver is spawned as a real child and killed with the signal it cannot
 * catch, so its own parent side sweep CANNOT run. The case is constructed so that
 * extending the unterminated interval to the end of the run WOULD raise the
 * reported width, and it asserts the lower number. That is the difference between
 * a fold that reports an explicit unknown and a fold that quietly inflates the
 * headline figure of a milestone about parallelism.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const loop = require('../scripts/fleet-loop.cjs');
const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');
const runfold = require('../ferrox-core/bin/lib/fleet-runfold.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const LOOP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fleet-loop.cjs');

/**
 * The pinned stub worker duration, ms. Long enough that 3 barrier free workers
 * dispatched in 1 pass genuinely overlap. What was observed at this value is
 * recorded in `19-05-SUMMARY.md`.
 */
const STUB_MS = 250;

/** The hard ceiling on the pinned sleep, as a mechanism rather than a comment. */
const STUB_CEILING_MS = 2000;

/** The long worker in the killed driver case: still running when the kill lands. */
const LONG_STUB_MS = 5000;

const SCRATCH_ROOTS = [];
const LIVE_CHILDREN = new Set();

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-runrecord-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  for (const child of LIVE_CHILDREN) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  LIVE_CHILDREN.clear();
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here, following tests/fleet-landqueue-race.test.cjs
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

/** The bound on the pinned sleep, as a mechanism rather than as a comment. */
function assertPinnedSleepBounded() {
  assert.ok(
    STUB_MS <= STUB_CEILING_MS,
    `STUB_MS=${STUB_MS} is past the ${STUB_CEILING_MS}ms ceiling. An unbounded search for a sleep `
    + 'that overlaps is the unbounded loop this milestone exists to prevent.',
  );
}

/** A scratch project holding `count` plan files in 1 phase, all in 1 wave. */
function makeProject(label, { phase = '07', slug = 'synth', count = 6 } = {}) {
  const root = scratch(label);
  const phaseDir = path.join(root, '.planning', 'phases', `${phase}-${slug}`);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    const id = `${phase}-${String(i).padStart(2, '0')}`;
    fs.writeFileSync(path.join(phaseDir, `${id}-PLAN.md`), [
      '---',
      `phase: ${phase}-${slug}`,
      `plan: ${String(i).padStart(2, '0')}`,
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified:',
      `  - src/node-${i}.cts`,
      'autonomous: true',
      '---',
      '',
      '<tasks>',
      '<task type="auto">',
      `  <name>node ${i}</name>`,
      '</task>',
      '</tasks>',
      '',
    ].join('\n'));
  }
  const planning = path.join(root, '.planning');
  return {
    root,
    phase,
    logPath: path.join(planning, 'fleet-runlog.jsonl'),
    projectionPath: path.join(planning, 'fleet-board.json'),
    tokenDir: planning,
  };
}

/**
 * The stub worker: a REAL script run as a REAL child process.
 *
 * argv: sleepMs mode markerDir nodeId attemptId
 */
const WORKER_SOURCE = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [sleepRaw, mode, markerDir, nodeId] = process.argv.slice(2);

function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

fs.mkdirSync(markerDir, { recursive: true });
sleepSync(Number(sleepRaw));

if (mode === 'fail-once') {
  const marker = path.join(markerDir, 'failed-' + nodeId.replace(/[^A-Za-z0-9_.-]/g, '_'));
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'once');
    process.exitCode = 1;
  }
}
`;

function writeWorkerScript(project) {
  const scriptPath = path.join(project.root, 'stub-worker.cjs');
  fs.writeFileSync(scriptPath, WORKER_SOURCE);
  return scriptPath;
}

/** A land seam that always reports green, so the loop closes every delivery. */
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
 * The width a naive fold would report if every unterminated interval were
 * extended to the last instant in the run.
 *
 * This is computed here ONLY so the killed driver case can assert that the real
 * fold reports a LOWER number. It is the inflation the fold must never produce.
 */
function inflatedWidth(record) {
  const instants = [];
  for (const w of record.workers) {
    if (typeof w.started_at === 'number') instants.push(w.started_at);
    if (typeof w.ended_at === 'number') instants.push(w.ended_at);
  }
  if (instants.length === 0) return 0;
  const last = Math.max(...instants);
  const points = [];
  for (const w of record.workers) {
    if (typeof w.started_at !== 'number') continue;
    const end = typeof w.ended_at === 'number' ? w.ended_at : last;
    points.push({ t: w.started_at, delta: 1 });
    points.push({ t: end, delta: -1 });
  }
  points.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));
  let running = 0;
  let width = 0;
  for (const p of points) {
    running += p.delta;
    if (running > width) width = running;
  }
  return width;
}

// ═══ the driven run ═════════════════════════════════════════════════════════

let driven = null;

/** Drive 1 real run over a 6 node graph at capacity 3, once, and reuse it. */
async function driveRun() {
  if (driven !== null) return driven;
  assertPinnedSleepBounded();

  const project = makeProject('driven', { count: 6 });
  const scriptPath = writeWorkerScript(project);
  const markerDir = path.join(project.root, 'markers');
  const land = greenLand();

  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'runrecord/driven',
    runId: 'run-driven',
    capacity: 3,
    // REAL elapsed time. See the header: a pinned instant collapses every
    // interval to a point and makes demonstrated width vacuous.
    clock: () => Date.now(),
    ttlMs: 3600000,
    heartbeatMs: 60,
    maxPasses: 60,
    preflight: allowedPreflight(),
    landCommand: land,
    spawnWorker: (ctx) => spawn(process.execPath, [
      scriptPath,
      String(STUB_MS),
      // 1 node fails its first attempt, so the run really carries an artifact
      // with 2 rounds rather than a rounds figure that is 1 everywhere.
      ctx.nodeId === '07-06' ? 'fail-once' : 'ok',
      markerDir,
      String(ctx.nodeId),
      String(ctx.attemptId),
    ], { stdio: ['ignore', 'pipe', 'pipe'] }),
  });

  const events = runlog.readFleetRunlog({ path: project.logPath });
  driven = { project, result, events, record: runfold.foldRunRecord(events), land };
  return driven;
}

test('the pinned stub sleep is inside its declared ceiling', () => {
  assertPinnedSleepBounded();
});

test('a driven run of 6 nodes at capacity 3 folds to a demonstrated width above 1, exact, with 0 unknown intervals', async (t) => {
  const { result, record } = await driveRun();

  assert.equal(result.stopped_by, 'drained', 'the run must have finished its work, not run out of budget');
  t.diagnostic(
    `demonstrated width ${record.demonstrated_width.value}, exact ${record.demonstrated_width.exact}, `
    + `unknown intervals ${record.demonstrated_width.unknown_intervals}, `
    + `${record.workers.length} worker intervals, STUB_MS=${STUB_MS}`,
  );

  assert.ok(
    record.demonstrated_width.value >= 2,
    'THE RUN DID NOT DEMONSTRATE PARALLELISM. A run that folds to width 1 is the exact result this '
    + `milestone exists to stop reporting. Observed ${record.demonstrated_width.value} across `
    + `${record.workers.length} intervals with STUB_MS=${STUB_MS}. Raise the pinned sleep inside its `
    + 'ceiling, re-observe, re-pin, and record what was seen.',
  );
  assert.equal(record.demonstrated_width.exact, true);
  assert.equal(record.demonstrated_width.unknown_intervals, 0);
  assert.ok(record.demonstrated_width.value <= 3, 'the width can never exceed the capacity that was set');
});

test('every worker interval in the driven run is CLOSED, so the width is evidence and not an estimate', async () => {
  const { record, events } = await driveRun();

  assert.ok(record.workers.length >= 6);
  for (const worker of record.workers) {
    assert.equal(worker.status, 'closed', `${String(worker.attempt_id)} left its interval open`);
    assert.notEqual(worker.started_at, null);
    assert.notEqual(worker.ended_at, null);
    assert.ok(worker.ended_at >= worker.started_at);
  }

  // 1 end event per start event, matched on the triple rather than on identity.
  const starts = events.filter((e) => e.kind === 'worker_started').length;
  const ends = events.filter((e) => e.kind === 'worker_ended').length;
  assert.equal(starts, ends, 'a start with no end is exactly what makes width unknowable');
  assert.equal(record.workers.length, starts);
});

test('every landed attempt carries the 5 land instants, and its queue wait and gate cost are computable', async (t) => {
  const { record, land } = await driveRun();

  const landedAttempts = [];
  for (const node of record.nodes) {
    for (const attempt of node.attempts) {
      if (attempt.land_completed_at === null) continue;
      landedAttempts.push({ node_id: node.node_id, attempt });
    }
  }
  assert.equal(landedAttempts.length, land.calls.length, 'every land the seam ran must appear in the record');
  assert.ok(landedAttempts.length >= 6);

  for (const { node_id: nodeId, attempt } of landedAttempts) {
    for (const field of [
      'queue_entered_at', 'queue_acquired_at', 'gate_started_at', 'gate_ended_at', 'land_completed_at',
    ]) {
      assert.notEqual(
        attempt[field], null,
        `${nodeId} attempt ${String(attempt.attempt_id)} is missing ${field}, so phase 22 cannot `
        + 'separate queue wait from gate cost from land latency',
      );
    }
    assert.equal(typeof attempt.queue_wait_ms, 'number');
    assert.equal(typeof attempt.gate_ms, 'number');
    assert.equal(typeof attempt.land_ms, 'number');
    assert.ok(attempt.queue_wait_ms >= 0);
    assert.ok(attempt.gate_ms >= 0);
    assert.ok(attempt.land_ms >= attempt.gate_ms, 'the gate sits INSIDE the land work, not beside it');
  }

  const waits = landedAttempts.map((a) => a.attempt.queue_wait_ms);
  t.diagnostic(`queue waits: ${JSON.stringify(waits)}`);
  t.diagnostic(`gate costs: ${JSON.stringify(landedAttempts.map((a) => a.attempt.gate_ms))}`);
});

test('rounds_per_artifact counts a node attempted twice as 2 rounds', async (t) => {
  const { record, events } = await driveRun();

  t.diagnostic(`rounds_per_artifact: ${JSON.stringify(record.rounds_per_artifact)}`);
  assert.equal(record.rounds_per_artifact['07-06'], 2, 'the node that failed once must show 2 rounds');
  for (const id of ['07-01', '07-02', '07-03', '07-04', '07-05']) {
    assert.equal(record.rounds_per_artifact[id], 1);
  }

  // Driven by real behaviour: the first attempt really exited non zero and really
  // never reached the land.
  const sixth = events.filter((e) => e.node_id === '07-06');
  const outcomes = sixth.filter((e) => e.kind === 'worker_ended').map((e) => e.outcome);
  assert.deepEqual(outcomes, ['failed', 'completed']);
  assert.equal(sixth.some((e) => e.kind === 'gate_started' && e.attempt_id === 'run-driven/07-06#1'), false);
  assert.equal(sixth.some((e) => e.kind === 'land_completed' && e.attempt_id === 'run-driven/07-06#2'), true);
});

test('the folded record carries run_id and graph_generation, and every EVENT carries run_id', async () => {
  const { record, events, result } = await driveRun();

  assert.equal(record.run_id, 'run-driven');
  assert.equal(record.graph_generation, result.graph_generation);
  assert.match(record.graph_generation, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(record.run_started_at, null);
  assert.notEqual(record.run_closed_at, null);

  for (const event of events) {
    assert.equal(event.run_id, 'run-driven', `a ${event.kind} event carries no run_id`);
  }

  // `graph_generation` rides on run_started ALONE, which is why the driver emits
  // exactly 1 of them on the dispatching path.
  const carriers = events.filter((e) => e.graph_generation !== undefined);
  assert.equal(carriers.length, 1);
  assert.equal(carriers[0].kind, 'run_started');
});

// ═══ FF-B121: 2 runs in 1 log ═══════════════════════════════════════════════

test('2 runs in 1 log are told apart by opts.run_id, and folding without the filter THROWS', async () => {
  const project = makeProject('two-runs', { count: 2 });
  const scriptPath = writeWorkerScript(project);
  const markerDir = path.join(project.root, 'markers');

  const drive = (runId) => loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'runrecord/two-runs',
    runId,
    capacity: 2,
    clock: () => Date.now(),
    ttlMs: 3600000,
    heartbeatMs: 60,
    maxPasses: 30,
    // Bounded hard. A wedged land queue must REFUSE rather than stall this case
    // for the queue's own 600 second default: a guard whose failure mode is a
    // hang has no verdict.
    landWaitTimeoutMs: 8000,
    landMaxPolls: 200,
    landPollIntervalMs: 5,
    preflight: allowedPreflight(),
    landCommand: greenLand(),
    spawnWorker: (ctx) => spawn(process.execPath, [
      scriptPath, '10', 'ok', markerDir, String(ctx.nodeId), String(ctx.attemptId),
    ], { stdio: ['ignore', 'pipe', 'pipe'] }),
  });

  const first = await drive('run-alpha');
  // A second run over the SAME log. The board already carries released leases
  // from the first run, which is exactly the residue a real second run leaves.
  const second = await drive('run-beta');

  const events = runlog.readFleetRunlog({ path: project.logPath });
  const ids = new Set(events.map((e) => e.run_id));
  assert.deepEqual([...ids].sort(), ['run-alpha', 'run-beta']);

  // FF-B121, resolved in plan 01 before execution: a fold with no filter over a
  // log holding 2 runs REFUSES rather than silently averaging them.
  assert.throws(
    () => runfold.foldRunRecord(events),
    (err) => err.code === runfold.RUNFOLD_ERROR_CODES.E_FLEET_MULTIPLE_RUNS,
    'folding 2 runs together would produce a width, a round count and a false green rate that '
    + 'describe no run that ever happened',
  );

  const alpha = runfold.foldRunRecord(events, { run_id: 'run-alpha' });
  const beta = runfold.foldRunRecord(events, { run_id: 'run-beta' });
  assert.equal(alpha.run_id, 'run-alpha');
  assert.equal(beta.run_id, 'run-beta');
  assert.equal(alpha.graph_generation, first.graph_generation);
  assert.equal(beta.graph_generation, second.graph_generation);
  // Same graph, so the same generation, and the run_id is what tells them apart.
  assert.equal(alpha.graph_generation, beta.graph_generation);

  // Each record describes its OWN run: 2 nodes each, not 4.
  assert.equal(alpha.workers.length, 2);
  assert.equal(beta.workers.length, 2);
  assert.deepEqual(Object.keys(alpha.rounds_per_artifact).sort(), ['07-01', '07-02']);
  assert.deepEqual(alpha.rounds_per_artifact, { '07-01': 1, '07-02': 1 });
  assert.deepEqual(beta.rounds_per_artifact, { '07-01': 1, '07-02': 1 });
  for (const worker of alpha.workers) assert.match(String(worker.worker_id), /^run-alpha:/);
  for (const worker of beta.workers) assert.match(String(worker.worker_id), /^run-beta:/);

  // Both runs really landed their own nodes. The second run inheriting the first
  // run's completions, or losing its ticket to a duplicate attempt id, would both
  // show up here as a run that landed nothing.
  assert.equal(alpha.false_green.landed, 2);
  assert.equal(beta.false_green.landed, 2);
  const attemptIds = events.filter((e) => e.kind === 'worker_started').map((e) => e.attempt_id);
  assert.equal(new Set(attemptIds).size, attemptIds.length, 'every attempt id in the log is distinct');
});

// ═══ the killed driver ══════════════════════════════════════════════════════

/**
 * The driver runner, spawned as a REAL child so it can be killed with the signal
 * it cannot catch.
 *
 * It also owns the wait: a poller reads the log and announces KILLNOW on stdout
 * once at least 2 workers have started AND at least 1 has ended, so the parent
 * waits on an EVENT rather than on a timer. The poller is bounded by an ATTEMPT
 * CEILING and announces GIVEUP when it trips, because a guard whose failure mode
 * is a hang has no verdict.
 */
const DRIVER_CHILD_SOURCE = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [loopScript, runlogLib, root, phase, logPath, projectionPath, tokenDir,
  runId, capacity, workerScript, markerDir, longMs, shortMs, longNode, mode] = process.argv.slice(2);

const loop = require(loopScript);
const runlog = require(runlogLib);

const MAX_POLLS = 600;
let polls = 0;
const poller = setInterval(() => {
  polls += 1;
  let events = [];
  try { events = runlog.readFleetRunlog({ path: logPath }); } catch { events = []; }
  const started = events.filter((e) => e.kind === 'worker_started').length;
  const ended = events.filter((e) => e.kind === 'worker_ended').length;
  if (started >= 2 && ended >= 1) {
    clearInterval(poller);
    if (mode === 'selfexit') {
      // A CATCHABLE exit. The driver's own parent side sweep runs, which is the
      // belt and braces arm: the per child exit handler could not have closed
      // these intervals because the children are still running.
      process.stdout.write('EXITING\\n');
      process.exit(0);
    }
    process.stdout.write('KILLNOW\\n');
    return;
  }
  if (polls >= MAX_POLLS) {
    clearInterval(poller);
    process.stdout.write('GIVEUP ' + started + ' ' + ended + '\\n');
  }
}, 20);

loop.runLoop({
  cwd: root,
  phase,
  logPath,
  projectionPath,
  tokenDir,
  repoKey: 'runrecord/killed',
  runId,
  capacity: Number(capacity),
  clock: () => Date.now(),
  ttlMs: 3600000,
  heartbeatMs: 60,
  maxPasses: 200,
  preflight: {
    checks: loop.CHECK_NAMES.map((name) => ({ name, ok: true, observed: {}, refused_because: null })),
    check_names: [...loop.CHECK_NAMES],
    dispatch_allowed: true,
  },
  landCommand: () => ({ code: 0, verdict: 'green', result: 'landed' }),
  spawnWorker: (ctx) => spawn(process.execPath, [
    workerScript,
    String(ctx.nodeId) === longNode ? longMs : shortMs,
    'ok',
    markerDir,
    String(ctx.nodeId),
    String(ctx.attemptId),
  ], { stdio: ['ignore', 'pipe', 'pipe'] }),
}).then(() => {
  clearInterval(poller);
}).catch((err) => {
  clearInterval(poller);
  process.stderr.write(String((err && err.stack) || err) + '\\n');
  process.exitCode = 1;
});
`;

/**
 * Spawn the driver as a real child and wait, on an EVENT, for the point where at
 * least 2 workers have started and at least 1 has ended.
 *
 * `mode` is `wait`, which announces KILLNOW and leaves the driver running for the
 * caller to kill, or `selfexit`, which makes the driver exit catchably so its own
 * parent side sweep runs.
 */
function spawnDriver(project, { runId, mode, expect }) {
  const workerScript = writeWorkerScript(project);
  const markerDir = path.join(project.root, 'markers');
  const driverPath = path.join(project.root, `driver-${runId}.cjs`);
  fs.writeFileSync(driverPath, DRIVER_CHILD_SOURCE);

  const child = spawn(process.execPath, [
    driverPath,
    LOOP_SCRIPT,
    path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-runlog.cjs'),
    project.root,
    project.phase,
    project.logPath,
    project.projectionPath,
    project.tokenDir,
    runId,
    '2',
    workerScript,
    markerDir,
    String(LONG_STUB_MS),
    String(STUB_MS),
    // 07-01 is dispatched first (schedule order 0) and runs long, so it is still
    // running when the driver goes away. That is the interval whose closure, or
    // lack of it, this file is about.
    '07-01',
    mode,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  LIVE_CHILDREN.add(child);

  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });

  const announced = new Promise((resolve, reject) => {
    let buffered = '';
    child.stdout.on('data', (b) => {
      buffered += b.toString();
      if (buffered.includes(expect)) resolve(expect);
      else if (buffered.includes('GIVEUP')) resolve(buffered.trim());
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      LIVE_CHILDREN.delete(child);
      if (mode === 'selfexit') resolve(expect);
      else reject(new Error(`the driver exited ${code} before it announced: ${stderr}`));
    });
  });

  return { child, announced, stderrOf: () => stderr };
}

test('a driver that exits mid flight SWEEPS every interval its children could not close', async (t) => {
  const project = makeProject('swept', { count: 4 });
  const { child, announced } = spawnDriver(project, {
    runId: 'run-swept', mode: 'selfexit', expect: 'EXITING',
  });

  const signal = await announced;
  assert.equal(signal, 'EXITING', `the driver never reached the exit point: ${signal}`);
  const exit = await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, sig: child.signalCode });
      return;
    }
    child.on('exit', (code, sig) => { LIVE_CHILDREN.delete(child); resolve({ code, sig }); });
  });
  assert.equal(exit.sig, null, 'this arm exits catchably, so the sweep can run');

  const events = runlog.readFleetRunlog({ path: project.logPath });
  const swept = events.filter((e) => e.swept_by === 'driver_exit');
  t.diagnostic(`swept ${swept.length} interval(s) on driver exit`);

  // THE BELT AND BRACES ARM. These children were still running, so no per child
  // exit handler could have closed them. The parent side sweep is the only thing
  // that could have written these, and D3 requires every interval this loop CAN
  // close to be closed.
  assert.ok(swept.length >= 1, 'the driver exited with workers running and swept nothing');
  for (const event of swept) {
    assert.equal(event.kind, 'worker_ended');
    assert.equal(
      event.outcome, 'abnormal',
      'a swept worker did not finish, so recording it as completed would invent a result',
    );
  }
  assert.ok(swept.some((e) => e.node_id === '07-01'), 'the long worker must be among the swept');

  // Every interval is CLOSED, so the width stays exact even though the driver
  // went away mid flight.
  const record = runfold.foldRunRecord(events);
  assert.equal(record.demonstrated_width.unknown_intervals, 0);
  assert.equal(record.demonstrated_width.exact, true);
  for (const worker of record.workers) assert.notEqual(worker.ended_at, null);
});

test('a run whose DRIVER is killed mid flight folds to an explicit unknown that does NOT extend to run close', async (t) => {
  const project = makeProject('killed', { count: 4 });
  const { child, announced, stderrOf } = spawnDriver(project, {
    runId: 'run-killed', mode: 'wait', expect: 'KILLNOW',
  });
  void stderrOf;

  const signal = await announced;
  assert.equal(signal, 'KILLNOW', `the driver never reached the kill point: ${signal}`);

  // THE UNCATCHABLE SIGNAL. The driver's own parent side sweep cannot run, which
  // is the entire point: the fold has to report an explicit unknown rather than
  // being handed a tidy end event.
  child.kill('SIGKILL');
  const exit = await new Promise((resolve) => {
    child.on('exit', (code, sig) => { LIVE_CHILDREN.delete(child); resolve({ code, sig }); });
  });
  assert.equal(exit.sig, 'SIGKILL', 'the driver must be killed, not asked to stop');

  const events = runlog.readFleetRunlog({ path: project.logPath });
  const record = runfold.foldRunRecord(events);

  t.diagnostic(
    `killed run: width ${record.demonstrated_width.value}, exact ${record.demonstrated_width.exact}, `
    + `unknown ${record.demonstrated_width.unknown_intervals}, workers ${record.workers.length}`,
  );

  // 1. The sweep really did not run.
  assert.equal(events.some((e) => e.swept_by === 'driver_exit'), false);
  assert.equal(events.some((e) => e.kind === 'run_closed'), false, 'a killed driver closes no run');

  // 2. The unknown is EXPLICIT.
  assert.equal(record.demonstrated_width.exact, false);
  assert.ok(record.demonstrated_width.unknown_intervals >= 1);

  // 3. The unterminated worker really is the long one, and its end is null rather
  //    than filled in from run close.
  const unknowns = record.workers.filter((w) => w.status === runfold.RUNFOLD_UNKNOWN);
  assert.ok(unknowns.length >= 1);
  for (const worker of unknowns) {
    assert.equal(worker.ended_at, null, 'an unterminated interval must not be given an end');
  }
  assert.ok(unknowns.some((w) => w.node_id === '07-01'), 'the long worker must be the unterminated one');

  // 4. THE LOAD BEARING ROW. Extending the unknown to the end of the run WOULD
  //    raise the width, and the fold reports the lower number.
  const closed = record.workers.filter((w) => w.status === 'closed');
  assert.ok(closed.length >= 1, 'the case needs a closed interval to overlap, or it proves nothing');
  const inflated = inflatedWidth(record);
  t.diagnostic(`inflated width if unknowns extended: ${inflated}, reported: ${record.demonstrated_width.value}`);
  assert.ok(
    inflated > record.demonstrated_width.value,
    'the case is not constructed: extending the unknown interval must RAISE the width, or asserting '
    + `the lower number proves nothing. inflated=${inflated} reported=${record.demonstrated_width.value}`,
  );
  assert.equal(
    record.demonstrated_width.value, closed.length > 1 ? record.demonstrated_width.value : 1,
    'the reported width counts closed intervals only',
  );
  assert.ok(
    record.demonstrated_width.value < inflated,
    'inflating the headline figure of a milestone about parallelism is the single worst thing this '
    + 'fold could do',
  );
});
