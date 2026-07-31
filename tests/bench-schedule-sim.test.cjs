'use strict';

/**
 * bench-schedule-sim: the properties under lock, not the functions.
 *
 * EVERY case here drives `scripts/bench-schedule-sim.cjs` AS A REAL CHILD
 * PROCESS. A test that imports the module cannot see what `main` does, and what
 * `main` does is the whole subject: which record it reads, whether it refuses,
 * what it prints and what exit code it leaves behind.
 *
 * WHAT IS UNDER LOCK, and why each one exists:
 *
 *   - ZERO SPEND, STRUCTURALLY. The script is driven with an EMPTY PATH. A
 *     script that reached for an adapter, a shell or any external binary would
 *     fail there, so the claim that it dispatches nothing is OBSERVED rather
 *     than asserted in a comment.
 *   - THE CALIBRATION IS A CROSS CHECK, NOT A SELF CONSISTENCY TEST. The
 *     simulator's prediction is compared against a span produced by the REAL
 *     runner spawning REAL child processes, over a corpus whose per node
 *     durations are PINNED. Two independent implementations of one schedule.
 *   - AND IT DISCRIMINATES. The same record calibrated against the scheduler
 *     that did NOT write it is observed to REFUSE. Without that arm an
 *     agreement could just mean the tolerance is wide enough to accept anything.
 *   - A MISSING DURATION IS NOT 0. A node with no usable duration is NAMED and
 *     the run is refused, because a node that takes no time cannot block a lane
 *     and defaulting it would flatter every schedule in the table.
 *   - THE PREDICTION IS NEVER A MEASUREMENT. The output carries no provenance
 *     and no member of the run record vocabulary.
 *
 * ZERO AGENT SPEND. No arm here reaches an adapter, a network or a key. The
 * runner arms use the REFERENCE builder against a scratch corpus.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SIM = path.join(REPO_ROOT, 'scripts', 'bench-schedule-sim.cjs');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'bench-run.cjs');

/**
 * The committed, IRREPLACEABLE paid record. Read only, and never regenerated.
 *
 * It MOVED into `superseded-prefix-walk/` when the re run published, because the
 * scheduler it measured no longer exists and a superseded record must leave the
 * verdict's input set. **It was MOVED and not deleted**, precisely so the
 * calibration below still has the record it calibrates against: this simulator's
 * whole claim is that it reproduces THAT run, and there is no second copy of it.
 * The path is asserted present before any case reads it, so a future move fails
 * loudly here rather than silently calibrating against nothing.
 */
const PAID_FLEET_RECORD = path.join(
  REPO_ROOT, '.planning', 'proof', 'superseded-prefix-walk',
  'fleet-within-live-1785293396634-1.jsonl',
);

test('the paid record this simulator calibrates against is present at its superseded path', () => {
  assert.equal(
    fs.existsSync(PAID_FLEET_RECORD), true,
    `the calibration record is missing at ${PAID_FLEET_RECORD}. It is MOVED, never deleted.`,
  );
});

const SCRATCH_ROOTS = [];
function scratchRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-sim-${tag}-`));
  SCRATCH_ROOTS.push(root);
  return root;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// ─── the scratch corpus ──────────────────────────────────────────────────────

const VISIBLE_TOKENS = ['ALPHA', 'BETA', 'GAMMA'];
const HIDDEN_TOKENS = ['DELTA', 'EPSILON'];

function gateSource(axis, tokens, modules) {
  const label = axis === 'hidden' ? 'hidden' : 'gate';
  const failWord = axis === 'hidden' ? 'HFAIL' : 'FAIL';
  return [
    'import sys, os',
    'p = sys.argv[1]',
    `TOKENS = ${JSON.stringify(tokens)}`,
    `MODULES = ${JSON.stringify(modules || [])}`,
    'if os.path.isdir(p):',
    '    have = sorted(os.listdir(p))',
    '    missing = [m for m in MODULES if m not in have]',
    '    if missing:',
    `        print("${failWord} missing modules: " + ", ".join(missing))`,
    `        print("${label}: 0/%d" % len(TOKENS))`,
    '        sys.exit(0)',
    '    text = "".join(open(os.path.join(p, n), encoding="utf-8").read() for n in have)',
    'else:',
    '    text = open(p, encoding="utf-8").read()',
    'passed = 0',
    'for t in TOKENS:',
    '    if t in text:',
    '        passed += 1',
    '    else:',
    `        print("${failWord} " + t)`,
    `print("${label}: %d/%d" % (passed, len(TOKENS)))`,
    '',
  ].join('\n');
}

/** 1 multi module task: 4 modules, 5 edges, 1 seam, depth 3. */
function writeMultiTask(root, id) {
  const base = path.join(root, 'multi', id);
  const files = ['a.py', 'b.py', 'c.py', 'd.py'];
  writeFile(path.join(base, 'SPEC.md'), `# ${id}\n\n4 modules. The seam is a.py.\n`);
  writeFile(path.join(base, 'structure.json'), `${JSON.stringify({
    task: id,
    files,
    edges: [['b.py', 'a.py'], ['c.py', 'a.py'], ['d.py', 'a.py'], ['d.py', 'b.py'], ['d.py', 'c.py']],
    seam: ['a.py'],
    depth: 3,
    permitted_width: 3,
  }, null, 2)}\n`);
  writeFile(path.join(base, 'gate.py'), gateSource('gate', VISIBLE_TOKENS, files));
  writeFile(path.join(base, 'hidden.py'), gateSource('hidden', HIDDEN_TOKENS, files));
  for (let i = 0; i < files.length; i++) {
    const body = i === 0
      ? '# ALPHA BETA GAMMA DELTA EPSILON\nVALUE = 1\n'
      : `# module ${files[i]}\nVALUE = ${i}\n`;
    writeFile(path.join(base, 'reference', files[i]), body);
  }
}

// ─── the child process seam ──────────────────────────────────────────────────

function run(script, args, options) {
  const o = options || {};
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.FERROX_BENCH_LIVE;
  delete env.FERROX_BENCH_LIVE_ADAPTER;
  delete env.FERROX_BENCH_LIVE_BIN;
  delete env.FERROX_TEST_MODE;
  delete env.FERROX_NOW_MS;
  for (const [k, v] of Object.entries(o.env || {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env,
    cwd: REPO_ROOT,
    timeout: o.timeout === undefined ? 120000 : o.timeout,
    killSignal: 'SIGKILL',
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

const sim = (args, options) => run(SIM, args, options);

/** A stub dispatch entry point standing in for scripts/fleet-loop.cjs. */
function writeStubLoop(root) {
  const file = path.join(root, 'stub-loop.cjs');
  writeFile(file, [
    "'use strict';",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const argv = process.argv.slice(2);',
    'const preflight = { checks: [{ name: "adapters", ok: true, refused_because: "", observed: { roster: [] } }],',
    '  check_names: ["adapters"], dispatch_allowed: true };',
    'if (!argv.includes("--run")) { process.stdout.write(JSON.stringify(preflight) + "\\n"); process.exit(0); }',
    'const logFlag = argv.find((a) => a.startsWith("--log="));',
    'const logPath = logFlag === undefined ? null : logFlag.slice("--log=".length);',
    'if (logPath !== null) {',
    '  fs.mkdirSync(path.dirname(logPath), { recursive: true });',
    '  const now = Date.now();',
    '  fs.writeFileSync(logPath, [',
    '    JSON.stringify({ ts: now, kind: "run_started", run_id: "stub-run", graph_generation: null, phase: "22" }),',
    '    JSON.stringify({ ts: now + 1, kind: "run_closed", run_id: "stub-run", stopped_by: "preflight_refused" }),',
    '  ].join("\\n") + "\\n", "utf8");',
    '}',
    'process.stdout.write(JSON.stringify({ run_id: "stub-run", dispatch_allowed: true }) + "\\n");',
    'process.exit(0);',
    '',
  ].join('\n'));
  return file;
}

/** A stub graph reporter standing in for scripts/gen-workgraph.cjs. */
function writeStubGraph(root, nodeCount) {
  const file = path.join(root, 'stub-graph.cjs');
  const ids = [];
  for (let i = 1; i <= nodeCount; i++) ids.push(`22-0${i}`);
  writeFile(file, [
    "'use strict';",
    `const IDS = ${JSON.stringify(ids)};`,
    'process.stdout.write(JSON.stringify({ schema: "workgraph/v1", phase: "22", schedule: IDS,',
    '  nodes: IDS.map((id, i) => ({ id, schedule_order: i, wave: 1 })), edges: [] }) + "\\n");',
    '',
  ].join('\n'));
  return file;
}

// ─── task 1: it costs nothing, and that is OBSERVED ──────────────────────────

test('the simulator runs with an EMPTY PATH, so it reaches no external binary at all', () => {
  // A script that shelled out to an adapter, a python interpreter or git would
  // fail here. This is the zero spend claim as an observation rather than a
  // comment: there is nothing on PATH for it to spend anything with.
  // The record is PINNED rather than left to the default scan. The default picks
  // whatever fleet record `.planning/proof/` happens to hold, and once the re run
  // landed a record from the FIXED scheduler the shipped model calibrated against
  // it and correctly refused, which had nothing to do with what this case asserts.
  // Pinning is strictly stronger: the case no longer changes meaning when a new
  // measurement lands beside it.
  const result = sim(['--json', '--record', PAID_FLEET_RECORD, '--caps', '1-3'], { env: { PATH: '' } });

  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.schema, 'bench-schedule-sim/v1');
  assert.equal(doc.dispatched, 0, 'it says so, and the empty PATH above shows it could not have');
  assert.equal(doc.kind, 'simulation');
  assert.equal(
    'provenance' in doc, false,
    'a PREDICTION carries no provenance. A simulated wall clock that wore `measured` would be the '
      + 'single easiest way to publish a manufactured result',
  );
});

test('the simulator reproduces the PAID record within 1 percent, which validates its inputs', () => {
  // THE CALIBRATION. The shipped scheduler at the cap the paid run used has to
  // reproduce that run's own build span. Everything else in the table is
  // worthless if this does not hold, so it is asserted before any of it.
  const result = sim(['--json', '--record', PAID_FLEET_RECORD, '--durations', 'recorded']);

  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);

  // NON ZERO FIRST. Every property below is vacuously true of a record that
  // carried nothing, so the counters come before the arithmetic.
  assert.equal(doc.nodes, 26, 'the corpus expands to 26 nodes');
  assert.equal(doc.completed_attempts, 26, 'and the paid record carries 26 completed attempts');

  assert.equal(doc.calibration.scheduler, 'shipped');
  assert.equal(doc.calibration.cap, 3, 'which is the cap the declared width held the paid run to');
  assert.ok(doc.calibration.observed_span_ms > 0, 'NON ZERO FIRST: the record has a build span');
  assert.equal(
    doc.calibration.within_tolerance, true,
    `the shipped model predicts ${doc.calibration.predicted_ms} ms against an observed `
      + `${doc.calibration.observed_span_ms} ms, a drift of ${doc.calibration.drift}`,
  );
  assert.ok(doc.calibration.drift < 0.01, 'within 1 percent');
});

test('REQUIRED FAILING ARM: calibrating against the WRONG scheduler REFUSES', () => {
  // Without this the agreement above could mean nothing but a wide tolerance.
  // The identical record calibrated against the FIXED scheduler, which did not
  // write it, is observed to refuse and to name the drift.
  const result = sim(['--record', PAID_FLEET_RECORD, '--calibrate', 'fixed', '--calibrate-cap', '3']);

  assert.notEqual(result.status, 0, 'a model that does not reproduce its own record is a refusal');
  assert.match(result.stderr, /E_SIM_UNCALIBRATED/);
  assert.match(result.stderr, /the fixed scheduler at cap 3/, 'and it names which model was checked');
});

// ─── task 2: the CROSS CHECK against the real runner ─────────────────────────

test('CROSS CHECK: the simulator predicts a REAL run of the FIXED scheduler', () => {
  // The strongest arm in this file and the reason the simulator is evidence
  // rather than a second guess. A scratch corpus is built by the REAL runner
  // with its per node durations PINNED, and the simulator is then asked to
  // predict the span that run produced. The 2 numbers come from 2 independent
  // implementations of 1 schedule.
  const corpus = scratchRoot('xcheck');
  const stubs = scratchRoot('xcheck-stub');
  const out = scratchRoot('xcheck-out');
  for (const id of ['m1', 'm2', 'm3']) writeMultiTask(corpus, id);

  // UNEQUAL durations, and deliberately so. With every child equally fast a
  // barrier and a pool produce the same span and the check could not
  // discriminate. The seams are slow and the leaves are quick, which is the
  // shape that makes a freed lane worth refilling.
  const profile = {};
  const plan = { a: 900, b: 200, c: 350, d: 150 };
  for (const task of ['m1', 'm2', 'm3']) {
    for (const [module, ms] of Object.entries(plan)) profile[`${task}/${module}.py`] = ms;
  }

  const built = run(RUNNER, [
    '--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference',
    '--width', '2', '--out', out,
  ], {
    env: {
      FERROX_BENCH_CORPUS_ROOT: corpus,
      FERROX_BENCH_FLEET_ENTRY: writeStubLoop(stubs),
      FERROX_BENCH_FLEET_GRAPH: writeStubGraph(stubs, 3),
      FERROX_BENCH_FLEET_PHASE: '22',
      FERROX_BENCH_NODE_MS: JSON.stringify(profile),
    },
  });
  assert.equal(built.status, 0, built.stderr);
  const report = JSON.parse(built.stdout);
  assert.equal(report.records[0].attempted, 12, 'NON ZERO FIRST: the real run built all 12 nodes');
  assert.equal(report.records[0].dispatch_cap, 2, 'at exactly 2 lanes');
  const recordPath = report.records[0].path;

  const ask = (scheduler) => {
    const result = sim([
      '--json', '--record', recordPath, '--durations', 'observed', '--caps', '1-3',
      '--calibrate', scheduler, '--calibrate-cap', '2', '--tolerance', '0.25',
    ], { env: { FERROX_BENCH_CORPUS_ROOT: corpus } });
    return { status: result.status, doc: JSON.parse(result.stdout) };
  };

  const fixed = ask('fixed');
  assert.equal(
    fixed.status, 0,
    `the FIXED model must reproduce a run of the fixed runner. drift ${fixed.doc.calibration.drift}`,
  );
  assert.equal(fixed.doc.calibration.within_tolerance, true);

  // THE DISCRIMINATOR. The same record against the SHIPPED model, which is what
  // the runner no longer is. If the runner had kept the barrier this arm would
  // pass and the one above would fail.
  const shipped = ask('shipped');
  assert.notEqual(shipped.status, 0, 'the SHIPPED model does NOT reproduce a run of the fixed runner');
  assert.ok(
    shipped.doc.calibration.drift > fixed.doc.calibration.drift,
    `the shipped model is further from the observed span (${shipped.doc.calibration.drift}) than the `
      + `fixed model is (${fixed.doc.calibration.drift})`,
  );
  assert.ok(
    shipped.doc.calibration.predicted_ms > fixed.doc.calibration.predicted_ms,
    'and it is further away by predicting a LONGER run, which is the direction the barrier costs',
  );
});

// ─── task 3: the refusals, each driven where its condition IS present ────────

test('REQUIRED FAILING ARM: a node with no usable duration is NAMED and is never a 0', () => {
  const corpus = scratchRoot('hole');
  const records = scratchRoot('hole-rec');
  for (const id of ['m1', 'm2']) writeMultiTask(corpus, id);

  // A record covering every node but one. A simulator that defaulted the hole to
  // 0 would happily predict a faster schedule than any that could ever run,
  // because a node taking no time cannot block a lane.
  const ids = [];
  for (const task of ['m1', 'm2']) for (const m of ['a', 'b', 'c', 'd']) ids.push(`${task}/${m}.py`);
  const withhold = 'm2/d.py';
  const rows = [{ kind: 'run_started', run_id: 'r', ts: 0, arm: 'fleet', provenance: 'measured' }];
  let ts = 1;
  for (const id of ids) {
    if (id === withhold) continue;
    rows.push({
      kind: 'worker_started', run_id: 'r', ts, worker_id: `w${ts}`, node_id: id, attempt_id: `${id}#1`,
    });
    rows.push({
      kind: 'worker_ended',
      run_id: 'r',
      ts: ts + 100,
      worker_id: `w${ts}`,
      node_id: id,
      attempt_id: `${id}#1`,
      outcome: 'completed',
      usd: null,
      recorded_runtime_ms: 100,
    });
    ts += 200;
  }
  rows.push({ kind: 'run_closed', run_id: 'r', ts: ts + 1 });
  const file = path.join(records, 'holed.jsonl');
  writeFile(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const result = sim(['--record', file, '--calibrate', 'off'], {
    env: { FERROX_BENCH_CORPUS_ROOT: corpus },
  });

  assert.notEqual(result.status, 0, 'a graph with a hole in it is a refusal');
  assert.match(result.stderr, /E_SIM_INCOMPLETE/);
  assert.match(result.stderr, /m2\/d\.py/, 'and the missing node is NAMED');
  assert.match(result.stderr, /A missing duration is NOT 0/, 'and the reason is stated');
});

test('the CONTROL: the same corpus with EVERY duration present simulates and exits 0', () => {
  // D8a both directions. Without the hole the identical invocation runs, so the
  // refusal above is a property of the record and not of the corpus.
  const corpus = scratchRoot('whole');
  const records = scratchRoot('whole-rec');
  for (const id of ['m1', 'm2']) writeMultiTask(corpus, id);

  const ids = [];
  for (const task of ['m1', 'm2']) for (const m of ['a', 'b', 'c', 'd']) ids.push(`${task}/${m}.py`);
  const rows = [{ kind: 'run_started', run_id: 'r', ts: 0, arm: 'fleet', provenance: 'measured' }];
  let ts = 1;
  for (const id of ids) {
    rows.push({
      kind: 'worker_started', run_id: 'r', ts, worker_id: `w${ts}`, node_id: id, attempt_id: `${id}#1`,
    });
    rows.push({
      kind: 'worker_ended',
      run_id: 'r',
      ts: ts + 100,
      worker_id: `w${ts}`,
      node_id: id,
      attempt_id: `${id}#1`,
      outcome: 'completed',
      usd: null,
      recorded_runtime_ms: 100,
    });
    ts += 200;
  }
  rows.push({ kind: 'run_closed', run_id: 'r', ts: ts + 1 });
  const file = path.join(records, 'whole.jsonl');
  writeFile(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const result = sim(['--json', '--record', file, '--calibrate', 'off', '--caps', '1-4'], {
    env: { FERROX_BENCH_CORPUS_ROOT: corpus },
  });

  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.nodes, 8, 'NON ZERO FIRST: 8 nodes were simulated');
  assert.equal(doc.serial_sum_ms, 800, '8 nodes at 100 ms each');
  assert.equal(doc.rows.length, 4);
});

test('2 records are REFUSED, because durations and the span must come from 1 run', () => {
  const result = sim(['--record', PAID_FLEET_RECORD, '--record', PAID_FLEET_RECORD]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /E_SIM_ONE_RECORD/);
});

// ─── task 4: the schedule properties, asserted as inequalities ───────────────

test('every fix is a saving and no fix is ever a cost, at every cap the table reports', () => {
  const result = sim(['--json', '--record', PAID_FLEET_RECORD, '--caps', '1-8']);
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);

  assert.equal(doc.rows.length, 8, 'NON ZERO FIRST: 8 caps were simulated');

  for (const row of doc.rows) {
    assert.ok(row.readyset <= row.shipped, `cap ${row.cap}: the ready set never costs time`);
    assert.ok(row.pool <= row.shipped, `cap ${row.cap}: the rolling pool never costs time`);
    assert.ok(row.fixed <= row.readyset, `cap ${row.cap}: both together beat the ready set alone`);
    assert.ok(row.fixed <= row.pool, `cap ${row.cap}: both together beat the pool alone`);
    assert.ok(
      row.fixed >= doc.critical_path_ms,
      `cap ${row.cap}: no schedule beats the critical path, and one that claimed to would be wrong`,
    );
  }

  // A CAP OF 1 IS NOT A FLEET. All 4 schedulers collapse to the serial sum, which
  // is the degenerate control: any of them reading less at width 1 would mean the
  // simulator was overlapping work no lane could hold.
  const one = doc.rows.find((r) => r.cap === 1);
  for (const scheduler of ['shipped', 'readyset', 'pool', 'fixed']) {
    assert.equal(one[scheduler], doc.serial_sum_ms, `${scheduler} at cap 1 is exactly the serial sum`);
  }

  // THE HEAD OF LINE BLOCK IS WHY MORE LANES BOUGHT NOTHING. The shipped model
  // is flat from the declared width upward: raising the cap could not help,
  // because the scan stopped at the first blocked node whatever the cap was.
  const shippedAt = (cap) => doc.rows.find((r) => r.cap === cap).shipped;
  assert.equal(shippedAt(8), shippedAt(3), 'shipped at cap 8 equals shipped at cap 3');
  assert.ok(
    doc.rows.find((r) => r.cap === 8).fixed < doc.rows.find((r) => r.cap === 3).fixed,
    'while the fixed scheduler DOES keep improving, which is the whole difference',
  );
});

test('the width profile is reported, so a saturated schedule is distinguishable from a lucky one', () => {
  const result = sim(['--json', '--record', PAID_FLEET_RECORD, '--caps', '3-3']);
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);

  const shipped = doc.width_profiles['shipped@3'];
  const fixed = doc.width_profiles['fixed@3'];
  assert.ok(shipped !== undefined && fixed !== undefined, 'NON ZERO FIRST: both profiles exist');

  const at = (profile, width) => (profile[String(width)] === undefined ? 0 : profile[String(width)]);
  assert.ok(at(shipped, 1) > 0, 'NON ZERO FIRST: the shipped schedule did spend time at width 1');
  assert.ok(
    at(fixed, 1) < at(shipped, 1),
    `the fixed schedule spends less time at width 1 (${at(fixed, 1)} ms) than the shipped one `
      + `(${at(shipped, 1)} ms), which is the defect stated as a duration`,
  );
  assert.ok(
    at(fixed, 3) > at(shipped, 3),
    'and correspondingly more time at the full width it was allowed',
  );
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
