#!/usr/bin/env node
'use strict';

/**
 * bench-schedule-sim: what the SCHEDULER cost, replayed at ZERO SPEND.
 *
 * WHY THIS EXISTS. Two adversarial audits of the phase 23 fleet proof concluded
 * that the published 1.33x measured a SCHEDULER DEFECT rather than a fleet. The
 * only way to test that without paying for another run is to take the per node
 * durations the paid run already measured and replay them through a scheduler
 * that has been fixed. This script does exactly that and nothing else.
 *
 * IT DISPATCHES NOTHING. It reads a committed `.jsonl` run record and the
 * corpus's own `structure.json` files, and it computes. There is no adapter, no
 * network, no child process and no builder anywhere in this file. That is not a
 * convention, it is the point: the number has to be free or it cannot inform the
 * decision about whether to pay for another run.
 *
 * WHAT IT IS NOT. It is not a measurement and it never becomes one. Its output
 * carries no `provenance`, is never written as a run record, and cannot be read
 * as an arm. A simulated wall clock is a PREDICTION about a scheduler, and the
 * distinction between that and a measured one is the distinction the whole
 * phase 22 apparatus exists to hold.
 *
 * THE GRAPH IS THE RUNNER'S OWN. `expandNodes`, `buildOrder` and
 * `availableWidth` are imported from `scripts/bench-run.cjs` rather than
 * reimplemented, so the shape this predicts over is the shape the runner builds.
 *
 * THE 4 SCHEDULERS, and why all 4 are here rather than only the fixed one:
 *
 *   shipped   head of line scan, batch barrier   what 23-05 actually ran
 *   readyset  ready set scan,   batch barrier    FF-B343 alone
 *   pool      head of line scan, rolling pool    FF-B344 alone
 *   fixed     ready set scan,   rolling pool     FF-B343 and FF-B344 together
 *
 * A table with only the last row cannot say which fix bought what, and a reader
 * who cannot attribute the gain cannot check the claim.
 *
 * THE CALIBRATION ARM. The scheduler the record's own run used must reproduce
 * that run's own build span. If it does not, the inputs are wrong and every
 * other row is worthless, so the script reports that comparison first and
 * refuses when it drifts past the declared tolerance.
 *
 * It is a CROSS CHECK and not a self consistency test. The observed span comes
 * from a real runner spawning real child processes; the prediction comes from
 * this file. They are 2 independent implementations of 1 schedule, so agreement
 * is evidence and disagreement is a defect in one of them. `--calibrate` names
 * WHICH scheduler wrote the record, because a record produced by the fixed
 * runner calibrated against `shipped` compares 2 different schedulers and means
 * nothing.
 *
 * usage:
 *   node scripts/bench-schedule-sim.cjs
 *   node scripts/bench-schedule-sim.cjs --json
 *   node scripts/bench-schedule-sim.cjs --record PATH --caps 1-8
 *
 * flags:
 *   --record PATH   the run record to take durations from. EXACTLY 1: the
 *                   durations and the span they are calibrated against must
 *                   come from the same run. Default is the first
 *                   .planning/proof/fleet-within-live-*.jsonl
 *   --durations recorded|observed
 *                   `recorded` reads worker_ended.recorded_runtime_ms, the
 *                   builder's own measurement of the child. `observed` reads
 *                   the interval between the worker's start and end events,
 *                   which includes the runner's own dispatch overhead. Default
 *                   recorded, which is what the audits used.
 *   --caps A-B      the dispatch caps to report, default 1-8
 *   --shape within-task|across-task    default within-task
 *   --tolerance F   the fraction the calibration arm may drift, default 0.01
 *   --calibrate S   which scheduler wrote the record, or `off`. Default
 *                   `shipped`, which is what wrote the committed 23-05 records
 *   --calibrate-cap N   the cap that run used. Default the declared width
 *   --json          print the whole result as JSON instead of a table
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const runner = require('./bench-run.cjs');

const CORPUS_ROOT = process.env.FERROX_BENCH_CORPUS_ROOT
  ? path.resolve(process.env.FERROX_BENCH_CORPUS_ROOT)
  : path.join(REPO_ROOT, '.planning', 'bench-harness');
const PROOF_DIR = path.join(REPO_ROOT, '.planning', 'proof');

const SCHEDULERS = ['shipped', 'readyset', 'pool', 'fixed'];
const SCAN_OF = {
  shipped: 'head-of-line', readyset: 'ready-set', pool: 'head-of-line', fixed: 'ready-set',
};
const DISPATCH_OF = {
  shipped: 'barrier', readyset: 'barrier', pool: 'rolling-pool', fixed: 'rolling-pool',
};

class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

// ─── the corpus, read through the runner's own expansion ─────────────────────

/**
 * The node ids and declared edges of the corpus, keyed exactly as a run record
 * keys them. Read from `structure.json` rather than from the record, so a node
 * the record never reached is still in the graph and is visible as missing.
 */
function readGraph() {
  const multiRoot = path.join(CORPUS_ROOT, 'multi');
  if (!fs.existsSync(multiRoot)) {
    throw new ExitError(1, `[E_SIM_NO_CORPUS] ${path.relative(REPO_ROOT, multiRoot)} does not exist.`);
  }
  const tasks = [];
  for (const id of fs.readdirSync(multiRoot).sort()) {
    const structureFile = path.join(multiRoot, id, 'structure.json');
    if (!fs.existsSync(structureFile)) continue;
    tasks.push({ id, kind: 'multi', structure: JSON.parse(fs.readFileSync(structureFile, 'utf8')) });
  }
  if (tasks.length === 0) {
    throw new ExitError(1, '[E_SIM_NO_TASKS] the corpus expanded to 0 multi module tasks.');
  }
  return runner.expandNodes(tasks);
}

// ─── the durations, read out of a committed record ───────────────────────────

/**
 * Per node durations in milliseconds, plus the record's own build span.
 *
 * A node whose `worker_ended` carries a null duration is NOT defaulted to 0 and
 * NOT dropped in silence: it is returned in `missing`, and the caller refuses
 * rather than predicting over a graph with holes in it. A fabricated 0 is how a
 * simulation flatters a scheduler, because a node that takes no time cannot
 * block a lane.
 */
function readDurations(file, mode) {
  const durations = new Map();
  const missing = [];
  const starts = new Map();
  let first = null;
  let last = null;
  let attempts = 0;
  let completed = 0;

  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const event = JSON.parse(line);
    if (event.kind === 'worker_started') {
      starts.set(String(event.attempt_id), event.ts);
      if (first === null || event.ts < first) first = event.ts;
      continue;
    }
    if (event.kind !== 'worker_ended') continue;
    attempts += 1;
    if (last === null || event.ts > last) last = event.ts;
    // ONLY A COMPLETED ATTEMPT CARRIES A DURATION. A refused or abnormal attempt
    // measured no build and its `recorded_runtime_ms` is null by design, so
    // reading one would put a null where a duration belongs. Where a node was
    // retried it is the attempt that BUILT the candidate whose time the schedule
    // has to reserve, and that is the completed one.
    if (event.outcome !== 'completed') continue;
    completed += 1;
    const id = String(event.node_id);
    const started = starts.get(String(event.attempt_id));
    const value = mode === 'observed'
      ? (started === undefined ? null : event.ts - started)
      : event.recorded_runtime_ms;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      missing.push({ node: id, attempt_id: String(event.attempt_id) });
      continue;
    }
    durations.set(id, value);
  }

  return {
    durations,
    missing,
    attempts,
    completed,
    spanMs: first === null || last === null ? null : last - first,
  };
}

// ─── the 4 schedulers ────────────────────────────────────────────────────────

/**
 * 1 simulated run. Returns the wall clock and the time spent at each width.
 *
 * The width profile is computed from the simulated intervals in exactly the way
 * `foldDemonstratedWidth` computes it from real ones: a running count over the
 * start and end instants. A summary that reported only the wall clock could not
 * distinguish a schedule that saturated its lanes from one that got lucky on the
 * critical path.
 */
function simulate(opts) {
  const {
    order, prereqs, durations, cap, scan, dispatch,
  } = opts;

  const queue = order.slice();
  const done = new Set();
  const present = new Set(order);
  const intervals = [];
  let now = 0;

  const isReady = (id) => {
    for (const p of prereqs.get(id)) {
      if (present.has(p) && !done.has(p)) return false;
    }
    return true;
  };

  /** The nodes a scan would fill, given the free lane count. */
  const pick = (freeLanes, running) => {
    const picked = [];
    for (const id of queue) {
      if (picked.length >= freeLanes) break;
      if (running.has(id)) continue;
      if (!isReady(id)) {
        if (scan === 'head-of-line') break;
        continue;
      }
      picked.push(id);
    }
    return picked;
  };

  const running = new Map();
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > order.length * 8 + 16) {
      throw new ExitError(1, '[E_SIM_STUCK] the simulated schedule made no progress.');
    }

    // THE FILL IS UNCONDITIONAL, and the barrier is expressed ONLY in the drain
    // below. This carried a `dispatch === 'rolling-pool' || running.size === 0`
    // guard, which a mutation battery showed to be DEAD: the barrier drain
    // clears every lane before the loop comes back here, so `running.size` is
    // already 0 on every barrier iteration and the guard could never be false.
    // A branch no input can take is a branch no test can cover, so it is gone
    // rather than left to read as though it were doing something.
    for (const id of pick(cap - running.size, running)) {
      running.set(id, now + durations.get(id));
      intervals.push({ node: id, from: now, to: now + durations.get(id) });
    }

    if (running.size === 0) {
      if (queue.length === 0) break;
      throw new ExitError(
        1,
        `[E_SIM_STUCK] ${queue.length} nodes remain and none is ready under the ${scan} scan.`,
      );
    }

    if (dispatch === 'barrier') {
      // The batch ends when its SLOWEST member ends, and no lane is refilled
      // before then. The lanes that finished early are idle, which is what the
      // width profile below then shows.
      const end = Math.max(...running.values());
      for (const id of running.keys()) {
        done.add(id);
        queue.splice(queue.indexOf(id), 1);
      }
      running.clear();
      now = end;
      continue;
    }

    const next = Math.min(...running.values());
    for (const [id, end] of [...running.entries()]) {
      if (end !== next) continue;
      running.delete(id);
      done.add(id);
      queue.splice(queue.indexOf(id), 1);
    }
    now = next;
  }

  return { wallMs: now, widthProfile: profileOf(intervals), intervals };
}

/** Milliseconds spent at each simultaneous width, keyed by the width. */
function profileOf(intervals) {
  const events = [];
  for (const row of intervals) {
    events.push({ ts: row.from, delta: 1 });
    events.push({ ts: row.to, delta: -1 });
  }
  events.sort((a, b) => a.ts - b.ts || a.delta - b.delta);
  const profile = {};
  let width = 0;
  let last = events.length === 0 ? 0 : events[0].ts;
  for (const event of events) {
    if (event.ts > last) {
      if (width > 0) profile[width] = (profile[width] || 0) + (event.ts - last);
      last = event.ts;
    }
    width += event.delta;
  }
  return profile;
}

/** The longest chain of durations through the declared edges. It bounds every schedule. */
function criticalPathMs(order, prereqs, durations) {
  const memo = new Map();
  const walk = (id) => {
    if (memo.has(id)) return memo.get(id);
    let longest = 0;
    for (const p of prereqs.get(id)) {
      if (!durations.has(p)) continue;
      const value = walk(p);
      if (value > longest) longest = value;
    }
    const total = longest + durations.get(id);
    memo.set(id, total);
    return total;
  };
  let best = 0;
  for (const id of order) {
    const value = walk(id);
    if (value > best) best = value;
  }
  return best;
}

// ─── argv ────────────────────────────────────────────────────────────────────

function readArgv(argv) {
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 || index + 1 >= argv.length ? null : argv[index + 1];
  };
  const records = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--record' && i + 1 < argv.length) records.push(argv[i + 1]);
  }
  const caps = value('caps');
  let capFrom = 1;
  let capTo = 8;
  if (caps !== null) {
    const match = /^(\d+)-(\d+)$/.exec(caps);
    if (match === null) throw new ExitError(1, '[E_SIM_CAPS] --caps takes a range such as 1-8.');
    capFrom = Number(match[1]);
    capTo = Number(match[2]);
    if (capFrom < 1 || capTo < capFrom) throw new ExitError(1, '[E_SIM_CAPS] --caps must be an ascending range starting at 1 or more.');
  }
  const durations = value('durations') === null ? 'recorded' : value('durations');
  if (durations !== 'recorded' && durations !== 'observed') {
    throw new ExitError(1, '[E_SIM_DURATIONS] --durations takes recorded or observed.');
  }
  const shape = value('shape') === null ? 'within-task' : value('shape');
  if (shape !== 'within-task' && shape !== 'across-task') {
    throw new ExitError(1, '[E_SIM_SHAPE] --shape takes within-task or across-task.');
  }
  const tolerance = value('tolerance') === null ? 0.01 : Number(value('tolerance'));
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new ExitError(1, '[E_SIM_TOLERANCE] --tolerance takes a non negative fraction.');
  }
  // WHICH SCHEDULER THE RECORD CAME FROM. The committed 23-05 records were
  // produced by the shipped one, which is why that is the default, but a record
  // written by the FIXED runner has to be calibrated against `fixed` or the
  // comparison is between 2 different schedulers and means nothing. Naming it is
  // what turns the calibration into a cross check of the simulator against the
  // real runner rather than a self consistency test.
  const calibrate = value('calibrate') === null ? 'shipped' : value('calibrate');
  if (calibrate !== 'off' && !SCHEDULERS.includes(calibrate)) {
    throw new ExitError(1, `[E_SIM_CALIBRATE] --calibrate takes off or 1 of ${SCHEDULERS.join(', ')}.`);
  }
  const rawCap = value('calibrate-cap');
  const calibrateCap = rawCap === null ? null : Number(rawCap);
  if (rawCap !== null && (!Number.isInteger(calibrateCap) || calibrateCap < 1)) {
    throw new ExitError(1, '[E_SIM_CALIBRATE] --calibrate-cap takes a whole number of at least 1.');
  }
  return {
    records,
    capFrom,
    capTo,
    durations,
    shape,
    tolerance,
    calibrate,
    calibrateCap,
    json: argv.includes('--json'),
  };
}

function defaultRecords() {
  if (!fs.existsSync(PROOF_DIR)) return [];
  return fs.readdirSync(PROOF_DIR)
    .filter((name) => name.startsWith('fleet-within-live-') && name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(PROOF_DIR, name));
}

// ─── the report ──────────────────────────────────────────────────────────────

function fmtSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderTable(result) {
  const lines = [];
  lines.push('| cap | shipped | + ready set (B343) | + rolling pool (B344) | both (B343+B344) |');
  lines.push('|---|---|---|---|---|');
  for (const row of result.rows) {
    lines.push(`| ${row.cap} | ${fmtSeconds(row.shipped)} | ${fmtSeconds(row.readyset)} `
      + `| ${fmtSeconds(row.pool)} | ${fmtSeconds(row.fixed)} |`);
  }
  return lines.join('\n');
}

function main() {
  const argv = readArgv(process.argv.slice(2));
  const records = argv.records.length > 0 ? argv.records : defaultRecords().slice(0, 1);
  if (records.length === 0) {
    throw new ExitError(1, '[E_SIM_NO_RECORDS] no run record was named and none was found in .planning/proof/.');
  }
  // EXACTLY 1 RECORD. The durations and the build span they are calibrated
  // against have to come from the SAME run, and pooling 2 runs would calibrate a
  // prediction built from one against a span belonging to both. Run the script
  // twice to cover 2 records.
  if (records.length > 1) {
    throw new ExitError(
      1,
      `[E_SIM_ONE_RECORD] ${records.length} records were named. The durations and the observed span `
        + 'must come from the same run, so this script takes exactly 1. Run it once per record.',
    );
  }
  for (const file of records) {
    if (!fs.existsSync(file)) throw new ExitError(1, `[E_SIM_NO_RECORDS] ${file} does not exist.`);
  }

  const { nodes, edges } = readGraph();
  const order = runner.buildOrder(argv.shape, nodes, edges);
  const prereqs = runner.prerequisiteMap(nodes, edges);
  const read = readDurations(records[0], argv.durations);

  // NON ZERO FIRST, AND COMPLETE. A prediction over a graph with holes in it is
  // a prediction about a different graph, so the missing nodes are NAMED and the
  // script refuses rather than filling them with a 0.
  if (read.durations.size === 0) {
    throw new ExitError(1, '[E_SIM_NO_DURATIONS] the named records carry no usable per node duration.');
  }
  const absent = order.filter((id) => !read.durations.has(id));
  if (absent.length > 0) {
    throw new ExitError(
      1,
      `[E_SIM_INCOMPLETE] ${absent.length} of ${order.length} nodes carry no duration in the named `
        + `records: ${absent.join(', ')}. A missing duration is NOT 0: a node that takes no time `
        + 'cannot block a lane, so defaulting it would flatter every schedule below.',
    );
  }

  const available = runner.availableWidth(order, edges);
  const declared = runner.permittedWidth(argv.shape, [...new Set(nodes.map((n) => n.task))].map((id) => {
    const structure = JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, 'multi', id, 'structure.json'), 'utf8'));
    return { id, kind: 'multi', structure };
  }));
  const critical = criticalPathMs(order, prereqs, read.durations);
  const serialMs = order.reduce((total, id) => total + read.durations.get(id), 0);

  const rows = [];
  const profiles = {};
  for (let cap = argv.capFrom; cap <= argv.capTo; cap++) {
    const row = { cap };
    for (const scheduler of SCHEDULERS) {
      const run = simulate({
        order,
        prereqs,
        durations: read.durations,
        cap,
        scan: SCAN_OF[scheduler],
        dispatch: DISPATCH_OF[scheduler],
      });
      row[scheduler] = run.wallMs;
      profiles[`${scheduler}@${cap}`] = run.widthProfile;
    }
    rows.push(row);
  }

  // THE CALIBRATION ARM. The named scheduler, at the cap the record's own run
  // used, has to reproduce that run's own build span. If it does not, the
  // durations feeding every other row do not describe the run they came from and
  // no row is usable. It is CHECKED rather than asserted, and it is a cross check
  // rather than a self consistency test: the observed span comes from a real
  // runner, the prediction from this file, and they are 2 independent
  // implementations of the same schedule.
  const calibrationCap = argv.calibrateCap === null
    ? Math.min(declared, argv.capTo)
    : argv.calibrateCap;
  const calibrationRow = rows.find((r) => r.cap === calibrationCap);
  const calibration = {
    scheduler: argv.calibrate,
    cap: calibrationCap,
    predicted_ms: calibrationRow === undefined || argv.calibrate === 'off'
      ? null
      : calibrationRow[argv.calibrate],
    observed_span_ms: read.spanMs,
    drift: null,
    within_tolerance: null,
    tolerance: argv.tolerance,
  };
  if (calibration.predicted_ms !== null && read.spanMs !== null && read.spanMs > 0) {
    calibration.drift = Math.abs(calibration.predicted_ms - read.spanMs) / read.spanMs;
    calibration.within_tolerance = calibration.drift <= argv.tolerance;
  }

  const result = {
    schema: 'bench-schedule-sim/v1',
    // NOT a provenance. This is a PREDICTION and it never becomes a measurement,
    // so it carries no member of the record vocabulary that a reader could
    // mistake for one.
    kind: 'simulation',
    dispatched: 0,
    records: records.map((f) => path.relative(REPO_ROOT, f)),
    durations_from: argv.durations,
    shape: argv.shape,
    nodes: order.length,
    attempts_read: read.attempts,
    completed_attempts: read.completed,
    serial_sum_ms: serialMs,
    critical_path_ms: critical,
    available_width: available,
    declared_permitted_width: declared,
    calibration,
    rows,
    width_profiles: profiles,
  };

  if (argv.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${[
      'bench-schedule-sim: a PREDICTION, not a measurement. 0 dispatches, 0 spend.',
      '',
      `records:            ${result.records.join(', ')}`,
      `durations:          ${argv.durations}`,
      `nodes:              ${result.nodes}`,
      `sum of durations:   ${fmtSeconds(serialMs)}  (a perfectly serial arm)`,
      `critical path:      ${fmtSeconds(critical)}  (no schedule can beat this)`,
      `available width:    ${available}`,
      `declared width:     ${declared}`,
      '',
      `calibration: ${calibration.scheduler} at cap ${calibration.cap} predicts `
        + `${calibration.predicted_ms === null ? 'nothing' : fmtSeconds(calibration.predicted_ms)} `
        + `against an observed build span of ${read.spanMs === null ? 'nothing' : fmtSeconds(read.spanMs)}`,
      `             drift ${calibration.drift === null ? 'unknown' : `${(calibration.drift * 100).toFixed(2)}%`} `
        + `against a tolerance of ${(argv.tolerance * 100).toFixed(2)}%`,
      '',
      renderTable(result),
      '',
    ].join('\n')}`);
  }

  if (calibration.within_tolerance === false) {
    process.stderr.write(
      `[E_SIM_UNCALIBRATED] the ${calibration.scheduler} scheduler at cap ${calibration.cap} predicts `
        + `${calibration.predicted_ms} ms against an observed span of ${read.spanMs} ms, a drift of `
        + `${(calibration.drift * 100).toFixed(2)}% past the ${(argv.tolerance * 100).toFixed(2)}% `
        + 'tolerance. The inputs do not reproduce the run they came from, so no row above is usable.\n',
    );
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof ExitError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      throw error;
    }
  }
}

module.exports = {
  readArgv, readDurations, simulate, profileOf, criticalPathMs, SCHEDULERS, SCAN_OF, DISPATCH_OF,
};
