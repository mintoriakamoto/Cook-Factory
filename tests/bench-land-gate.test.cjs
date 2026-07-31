'use strict';

/**
 * bench-land-gate: the harness under lock, driven as a REAL CHILD PROCESS.
 *
 *   - NEVER IMPORTED. Every arm below runs `node scripts/bench-land-gate.cjs`
 *     through `spawnSync`. A test that imported the module could not see the argv
 *     wiring, the exit codes, the child spawning or the reaping, and those 4 are
 *     most of what this script is.
 *   - CONCURRENCY IS OBSERVED, NEVER ASSUMED. The staggered arm asserts the
 *     recorded values are MIXED and STRICTLY BELOW the requested count. An
 *     implementation that wrote the requested `K` onto every `gate_started` fails
 *     it, and that implementation is the one that quietly buckets a contended
 *     measurement into the baseline and flattens the curve it was built to find.
 *   - THE REFUSAL IS OBSERVED, AND SO IS THE ABSENCE OF THE FILE. Asserting a
 *     non zero exit alone would pass for an emitter that reports a refusal and
 *     writes the record anyway. Every refusal arm asserts the output path does
 *     NOT exist afterwards.
 *   - NON ZERO BEFORE EVERY PROPERTY. `every bucket passed` is vacuously true of
 *     0 buckets, so each arm asserts a count first and the property second.
 *   - THE SEEDED COUNT IS CHOSEN HERE. The false green arms pick the number of
 *     broken increments and then check the imported fold against it. A rate
 *     folded from a corpus whose true rate is unknown cannot be validated by
 *     anything.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bench-land-gate.cjs');
const LIB_PATH = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs');
const lib = require(LIB_PATH);

const SCRATCH_ROOTS = [];

/** A fresh scratch directory. Built here, never borrowed: an empty untracked directory exists in no checkout. */
function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-blg-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/** The environment every driver run gets: the parent's, with both clock pin variables REMOVED. */
function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.FERROX_TEST_MODE;
  delete env.FERROX_NOW_MS;
  return env;
}

function runDriver(args, options) {
  const opts = options || {};
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || REPO_ROOT,
    env: cleanEnv(opts.env),
    timeout: 60000,
  });
}

/** Read a written run record back as a parsed event array. */
function readRecord(outPath) {
  const text = fs.readFileSync(outPath, 'utf8');
  return text.split(/\r?\n/).filter((l) => l !== '').map((l) => JSON.parse(l));
}

function ofKind(events, kind) {
  return events.filter((e) => e.kind === kind);
}

/**
 * Write a stand in under its OWN name. A single shared filename would let a load
 * fixture silently overwrite a gate fixture, and the run would hang rather than
 * fail, which is a slower and less legible failure than the one being tested.
 */
function writeFixture(dir, name, body) {
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/** A gate stand in: sleeps, then exits with the code it was told to. Finishes in milliseconds. */
function writeGateFixture(dir, body) {
  return writeFixture(dir, 'gate-fixture', body);
}

const SLEEP_GATE = [
  "'use strict';",
  'const ms = Number(process.argv[2] || 0);',
  'const code = Number(process.argv[3] || 0);',
  'setTimeout(() => { process.exitCode = code; }, ms);',
  '',
].join('\n');

/** Gate 0 is long lived, every other gate is short. The staggered mix depends on this asymmetry. */
const INDEXED_GATE = [
  "'use strict';",
  'const i = Number(process.argv[2] || 0);',
  'setTimeout(() => { process.exitCode = 0; }, i === 0 ? 600 : 40);',
  '',
].join('\n');

/** Records the 2 clock pin variables as the child actually saw them. */
function envProbeGate(outFile) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
    '  mode: process.env.FERROX_TEST_MODE === undefined ? null : process.env.FERROX_TEST_MODE,',
    '  now: process.env.FERROX_NOW_MS === undefined ? null : process.env.FERROX_NOW_MS,',
    '}));',
    'setTimeout(() => { process.exitCode = 0; }, 30);',
    '',
  ].join('\n');
}

const FOREVER_LOAD = [
  "'use strict';",
  'setInterval(() => {}, 1000);',
  '',
].join('\n');

function q(s) {
  return `"${s}"`;
}

function cmd(parts) {
  return parts.map(q).join(' ');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Parse the operator facing bucket table out of stdout. */
function parseTable(stdout) {
  const rows = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|$/.exec(line);
    if (m === null) continue;
    rows.push({
      concurrency: Number(m[1]),
      n: Number(m[2]),
      median_ms: Number(m[3]),
      max_ms: Number(m[4]),
    });
  }
  return rows;
}

function fieldOf(stdout, key) {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(stdout);
  return m === null ? null : m[1].trim();
}

// ─── task 1: the load driver, the curve, and the self validating emitter ─────

test('a cohort of 3 gates emits every kind in the count the cohort implies', () => {
  const dir = scratch('counts');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '3', '--load', '0',
    '--gate-cmd', cmd([process.execPath, fx, '120', '0']),
    '--out', out,
  ]);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

  const events = readRecord(out);
  assert.equal(ofKind(events, 'run_started').length, 1, '1 run_started');
  assert.equal(ofKind(events, 'run_closed').length, 1, '1 run_closed');
  assert.equal(ofKind(events, 'gate_started').length, 3, '3 gate_started');
  assert.equal(ofKind(events, 'gate_ended').length, 3, '3 gate_ended');
  assert.equal(ofKind(events, 'worker_started').length, 3, '3 worker_started');
  assert.equal(ofKind(events, 'worker_ended').length, 3, '3 worker_ended');
});

test('the written record validates through the imported validator with 0 errors', () => {
  const dir = scratch('valid');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '2', '--load', '1',
    '--gate-cmd', cmd([process.execPath, fx, '80', '0']),
    '--load-cmd', cmd([process.execPath, writeFixture(dir, 'load-fixture', FOREVER_LOAD)]),
    '--out', out,
  ]);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

  // Folded from the FILE, never from the driver's own claim about the file.
  const result = lib.validateRunRecord(readRecord(out));
  assert.deepEqual(result.errors.map((e) => e.code), [], 'no code is reported');
  assert.equal(result.ok, true, 'the emitted record validates');
});

test('the emitter refuses to write a record its own reader rejects, and writes nothing', () => {
  const dir = scratch('refuse');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '1', '--load', '0',
    '--gate-cmd', cmd([process.execPath, fx, '20', '0']),
    '--out', out,
    '--suppress-run-closed',
  ]);
  assert.notEqual(r.status, 0, 'the refusal is a non zero exit');
  assert.match(r.stderr, /E_PR_RUN_NOT_CLOSED/, 'the refusal names the code');
  // A flag assertion would pass for an emitter that reports the refusal and writes anyway.
  assert.equal(fs.existsSync(out), false, 'nothing was written');
});

test('concurrency is 1 for a lone gate and 3 for a cohort of 3', () => {
  const dir = scratch('conc');
  const fx = writeGateFixture(dir, SLEEP_GATE);

  const one = path.join(dir, 'one.jsonl');
  const r1 = runDriver([
    '--gates', '1', '--load', '0',
    '--gate-cmd', cmd([process.execPath, fx, '150', '0']),
    '--out', one,
  ]);
  assert.equal(r1.status, 0, `driver failed: ${r1.stderr}`);
  const starts1 = ofKind(readRecord(one), 'gate_started');
  assert.equal(starts1.length, 1, '1 gate_started before any property over them');
  assert.deepEqual(starts1.map((e) => e.concurrency), [1], 'a lone gate ran at concurrency 1');

  const three = path.join(dir, 'three.jsonl');
  const r3 = runDriver([
    '--gates', '3', '--load', '0',
    '--gate-cmd', cmd([process.execPath, fx, '400', '0']),
    '--out', three,
  ]);
  assert.equal(r3.status, 0, `driver failed: ${r3.stderr}`);
  const starts3 = ofKind(readRecord(three), 'gate_started');
  assert.equal(starts3.length, 3, '3 gate_started before any property over them');
  assert.deepEqual(starts3.map((e) => e.concurrency), [3, 3, 3], 'a simultaneous cohort of 3 ran at 3');
});

test('a staggered cohort records mixed concurrency strictly below the requested count', () => {
  const dir = scratch('stagger');
  const fx = writeGateFixture(dir, INDEXED_GATE);
  const out = path.join(dir, 'record.jsonl');

  // Gate 0 lives 600 ms. Gate 1 launches at 400 ms, INSIDE it. Gate 2 launches at
  // 800 ms, AFTER it. An implementation that wrote the requested 3 cannot produce
  // this shape, and neither can one that wrote a constant.
  const r = runDriver([
    '--gates', '3', '--load', '0', '--stagger', '400',
    '--gate-cmd', `${cmd([process.execPath, fx])} {i}`,
    '--out', out,
  ]);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

  const starts = ofKind(readRecord(out), 'gate_started');
  assert.equal(starts.length, 3, '3 gate_started before any property over them');
  const values = starts.map((e) => e.concurrency);
  const distinct = [...new Set(values)];
  assert.ok(distinct.length >= 2, `the recorded values are mixed, got ${JSON.stringify(values)}`);
  assert.ok(Math.max(...values) < 3, `the peak is below the requested 3, got ${JSON.stringify(values)}`);
  assert.ok(Math.min(...values) >= 1, `every recorded value is a usable concurrency, got ${JSON.stringify(values)}`);
});

test('a gate that exits non zero is a measurement, not an error', () => {
  const dir = scratch('red');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '1', '--load', '0',
    '--gate-cmd', cmd([process.execPath, fx, '60', '3']),
    '--out', out,
  ]);
  assert.equal(r.status, 0, 'the measurement completed, so the driver exits 0');

  const events = readRecord(out);
  const ends = ofKind(events, 'gate_ended');
  assert.equal(ends.length, 1, '1 gate_ended before any property over them');
  assert.equal(ends[0].verdict, 'red', 'a failing gate is recorded red');

  const cost = lib.foldLandGateCost(events);
  assert.equal(cost.state, lib.METRIC_STATES.KNOWN, `the curve is known, reason: ${cost.reason}`);
  assert.equal(cost.buckets.length, 1, '1 bucket');
  assert.ok(cost.buckets[0].max_ms > 0, `a red gate still carries a real duration, got ${cost.buckets[0].max_ms}`);
});

test('the printed bucket table is the imported fold of the written record', () => {
  const dir = scratch('table');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '2', '--load', '0', '--repeat', '2',
    '--gate-cmd', cmd([process.execPath, fx, '60', '0']),
    '--out', out,
  ]);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

  const cost = lib.foldLandGateCost(readRecord(out));
  assert.equal(cost.state, lib.METRIC_STATES.KNOWN, `the curve is known, reason: ${cost.reason}`);
  assert.ok(cost.buckets.length > 0, 'the fold produced at least 1 bucket');

  const rows = parseTable(r.stdout);
  assert.equal(rows.length, cost.buckets.length, 'the table has 1 row per folded bucket');
  assert.deepEqual(rows, cost.buckets.map((b) => ({
    concurrency: b.concurrency,
    n: b.n,
    median_ms: b.median_ms,
    max_ms: b.max_ms,
  })), 'the operator facing table and the machine readable metric agree');
  assert.equal(fieldOf(r.stdout, 'gate_cost_state'), lib.METRIC_STATES.KNOWN, 'the state is printed');
});

test('--repeat puts 1 observation per repetition into the bucket', () => {
  const dir = scratch('repeat');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '2', '--load', '0', '--repeat', '3',
    '--gate-cmd', cmd([process.execPath, fx, '250', '0']),
    '--out', out,
  ]);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

  const events = readRecord(out);
  assert.equal(ofKind(events, 'gate_started').length, 6, '3 repetitions of 2 gates');
  assert.equal(ofKind(events, 'run_started').length, 1, 'the repetitions share 1 run record');

  const cost = lib.foldLandGateCost(events);
  assert.equal(cost.state, lib.METRIC_STATES.KNOWN, `the curve is known, reason: ${cost.reason}`);
  const bucket = cost.buckets.find((b) => b.concurrency === 2);
  assert.ok(bucket !== undefined, `a concurrency 2 bucket exists, got ${JSON.stringify(cost.buckets)}`);
  assert.equal(bucket.n, 6, 'the median has 6 observations to be a median of');
});

test('every load process is reaped and carries a recorded abnormal exit', () => {
  const dir = scratch('reap');
  const gateFx = writeGateFixture(dir, SLEEP_GATE);
  const loadFile = writeFixture(dir, 'load-fixture', FOREVER_LOAD);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '1', '--load', '2',
    '--gate-cmd', cmd([process.execPath, gateFx, '120', '0']),
    '--load-cmd', cmd([process.execPath, loadFile]),
    '--out', out,
  ]);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

  const events = readRecord(out);
  const loadStarts = ofKind(events, 'worker_started').filter((e) => String(e.node_id).startsWith('load-'));
  assert.equal(loadStarts.length, 2, '2 load workers before any property over them');

  const loadEnds = ofKind(events, 'worker_ended').filter((e) => String(e.node_id).startsWith('load-'));
  assert.equal(loadEnds.length, 2, 'every load worker closed its interval');
  assert.deepEqual(loadEnds.map((e) => e.outcome), ['abnormal', 'abnormal'], 'a killed load process is a recorded abnormal exit');

  // The guard proves no damage AND that work happened: 2 pids were real, and both are gone.
  const pids = loadStarts.map((e) => e.pid);
  assert.equal(pids.filter((p) => Number.isInteger(p) && p > 0).length, 2, `2 real pids were recorded, got ${JSON.stringify(pids)}`);
  assert.deepEqual(pids.map(isAlive), [false, false], 'no load child outlived the driver');
});

test('an unknown flag is rejected by name', () => {
  const dir = scratch('flag');
  const r = runDriver(['--gates', '1', '--load', '0', '--turbo', '--out', path.join(dir, 'r.jsonl')]);
  assert.notEqual(r.status, 0, 'an unknown flag is a non zero exit');
  assert.match(r.stderr, /--turbo/, 'the rejection names the flag rather than ignoring it');
});

test('the driver sets neither clock pin variable in the child environment', () => {
  const dir = scratch('pin');
  const probe = path.join(dir, 'env-probe.json');
  const fx = writeGateFixture(dir, envProbeGate(probe));
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '1', '--load', '0',
    '--gate-cmd', cmd([process.execPath, fx]),
    '--out', out,
  ]);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

  const seen = JSON.parse(fs.readFileSync(probe, 'utf8'));
  assert.equal(seen.mode, null, 'FERROX_TEST_MODE is absent in the child');
  assert.equal(seen.now, null, 'FERROX_NOW_MS is absent in the child');
});

test('the injected clock is the only source of time in the record', () => {
  const dir = scratch('clock');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '2', '--load', '0',
    '--gate-cmd', cmd([process.execPath, fx, '40', '0']),
    '--clock-step', '1000',
    '--out', out,
  ]);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

  const events = readRecord(out);
  assert.ok(events.length > 0, 'the record is not empty');
  const offGrid = events.filter((e) => e.ts % 1000 !== 0);
  assert.deepEqual(offGrid, [], 'every ts came from the injected step clock, so no platform clock leaked in');
  assert.equal(events[0].ts, 0, 'the injected clock started the record at its own origin');
});

// ─── task 2: the false green seeder and the measured rate ───────────────────
//
// THE SEEDED COUNT IS CHOSEN HERE AND THE FOLD IS CHECKED AGAINST IT. A rate
// computed from a run whose true rate is unknown cannot be validated by
// anything, so every arm below names `--broken` and then asserts the imported
// fold reproduces exactly that number over the count that landed.

function runSeeder(args, scratchRoot, out) {
  return runDriver(['--false-green', ...args, '--scratch-root', scratchRoot, '--out', out]);
}

test('a corpus of 10 with 3 broken folds to 0.3 while every gate was green', () => {
  const dir = scratch('fg-positive');
  const out = path.join(dir, 'record.jsonl');
  const r = runSeeder(['--increments', '10', '--broken', '3'], dir, out);
  assert.equal(r.status, 0, `seeder failed: ${r.stderr}`);

  const events = readRecord(out);

  // The first half is what makes this D13 item 3's POSITIVE case: a rate
  // computed from gate outcomes alone reads 0 on this record.
  const gateEnds = ofKind(events, 'gate_ended');
  assert.equal(gateEnds.length, 10, '10 gate_ended before any property over them');
  assert.deepEqual([...new Set(gateEnds.map((e) => e.verdict))], ['green'], 'every narrow gate was green');

  assert.equal(ofKind(events, 'land_completed').length, 10, '10 increments landed');

  const rate = lib.foldFalseGreenRate(events);
  assert.equal(rate.state, lib.METRIC_STATES.KNOWN, `the rate is known, reason: ${rate.reason}`);
  assert.equal(rate.value, 0.3, 'the fold reproduces the 3 the test seeded over the 10 that landed');
});

test('a corpus with 0 broken folds to a MEASURED 0, which is not an unmeasured one', () => {
  const dir = scratch('fg-zero');
  const out = path.join(dir, 'record.jsonl');
  const r = runSeeder(['--increments', '10', '--broken', '0'], dir, out);
  assert.equal(r.status, 0, `seeder failed: ${r.stderr}`);

  const events = readRecord(out);
  assert.equal(ofKind(events, 'post_land_truth').length, 10, 'every landed increment was classified');

  const rate = lib.foldFalseGreenRate(events);
  assert.equal(rate.value, 0, 'the measured rate is 0');
  assert.equal(rate.state, lib.METRIC_STATES.KNOWN, 'a measured 0 is KNOWN');
  assert.notEqual(rate.state, lib.METRIC_STATES.UNDEFINED, 'a measured 0 is not an absent measurement');
});

test('skipping the wide check folds to UNDEFINED with no value at all', () => {
  const dir = scratch('fg-skip');
  const out = path.join(dir, 'record.jsonl');
  const r = runSeeder(['--increments', '10', '--broken', '3', '--skip-wide'], dir, out);
  assert.equal(r.status, 0, `seeder failed: ${r.stderr}`);

  const events = readRecord(out);
  assert.equal(ofKind(events, 'land_completed').length, 10, '10 increments still landed');
  assert.equal(ofKind(events, 'post_land_truth').length, 0, 'nothing was classified');

  const rate = lib.foldFalseGreenRate(events);
  assert.equal(rate.state, lib.METRIC_STATES.UNDEFINED, 'an unmeasured rate is UNDEFINED');
  assert.equal(rate.value, null, 'and it carries no number, so it cannot be read as 0');
});

test('a partial classification folds to UNKNOWN and names the shortfall', () => {
  const dir = scratch('fg-partial');
  const out = path.join(dir, 'record.jsonl');
  const r = runSeeder(['--increments', '10', '--broken', '3', '--classify', '6'], dir, out);
  assert.equal(r.status, 0, `seeder failed: ${r.stderr}`);

  const events = readRecord(out);
  assert.equal(ofKind(events, 'post_land_truth').length, 6, '6 of the 10 were classified');

  const rate = lib.foldFalseGreenRate(events);
  assert.equal(rate.state, lib.METRIC_STATES.UNKNOWN, 'a partial classification is UNKNOWN');
  assert.equal(rate.value, null, 'and produces no number');
  assert.match(rate.reason, /shortfall of 4/, 'the reason names the 4 that were never classified');
});

test('the seeder removes its scratch repository and writes nowhere else', () => {
  const dir = scratch('fg-clean');
  const out = path.join(dir, 'record.jsonl');
  const scratchRoot = path.join(dir, 'seed-root');
  fs.mkdirSync(scratchRoot);

  const r = runDriver(['--false-green', '--increments', '6', '--broken', '2', '--scratch-root', scratchRoot, '--out', out]);
  assert.equal(r.status, 0, `seeder failed: ${r.stderr}`);

  const repoPath = fieldOf(r.stdout, 'scratch_repo');
  assert.ok(typeof repoPath === 'string' && repoPath.length > 0, 'the seeder names the repository it built');
  // The guard proves no damage AND that work happened: a real repository was
  // built at a named path, and afterwards nothing is left behind.
  assert.equal(fs.existsSync(repoPath), false, 'the scratch repository was removed');
  assert.deepEqual(fs.readdirSync(scratchRoot), [], 'nothing outside the scratch repository was left in the root');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['record.jsonl', 'seed-root'], 'only the named record was written');
});

test('the rate the seeder prints is the rate the imported fold computes', () => {
  const dir = scratch('fg-agree');
  const out = path.join(dir, 'record.jsonl');
  const r = runSeeder(['--increments', '8', '--broken', '2'], dir, out);
  assert.equal(r.status, 0, `seeder failed: ${r.stderr}`);

  const rate = lib.foldFalseGreenRate(readRecord(out));
  assert.equal(rate.state, lib.METRIC_STATES.KNOWN, `the rate is known, reason: ${rate.reason}`);
  assert.equal(fieldOf(r.stdout, 'false_green_rate'), String(rate.value), 'the printed rate is the folded rate');
  assert.equal(fieldOf(r.stdout, 'false_green_state'), rate.state, 'the printed state is the folded state');
  assert.equal(fieldOf(r.stdout, 'seeded_broken'), '2', 'the seeded count is published beside the folded one');
});

test('every seeded result and classification is a value the shipped fold recognises', () => {
  const dir = scratch('fg-vocab');
  const out = path.join(dir, 'record.jsonl');
  const r = runSeeder(['--increments', '6', '--broken', '2'], dir, out);
  assert.equal(r.status, 0, `seeder failed: ${r.stderr}`);

  const events = readRecord(out);

  // THE PRODUCER IS THE AUTHORITY. Both vocabularies are read from the shipped
  // library rather than written here, so a family added or renamed by a later
  // phase does not turn this file red for the wrong reason.
  const lands = ofKind(events, 'land_completed');
  assert.equal(lands.length, 6, '6 land_completed before any property over them');
  const badLands = lands.filter((e) => !lib.LAND_RESULTS_LANDED.includes(String(e.result).split(':')[0]));
  assert.deepEqual(badLands.map((e) => e.result), [], 'every seeded land carries a LANDED family');

  const truths = ofKind(events, 'post_land_truth');
  assert.equal(truths.length, 6, '6 post_land_truth before any property over them');
  const undecided = truths.filter((e) => !lib.DECIDED_CLASSIFICATIONS.includes(String(e.classification)));
  assert.deepEqual(undecided.map((e) => e.classification), [], 'every seeded classification is a DECIDED one');

  // The consequence, asserted rather than assumed: an unrecognised family or an
  // undecided classification would make this fold report no number at all.
  const rate = lib.foldFalseGreenRate(events);
  assert.equal(rate.state, lib.METRIC_STATES.KNOWN, `the denominator survived, reason: ${rate.reason}`);
  assert.equal(rate.value, 2 / 6, 'and reproduces the 2 the test seeded over the 6 that landed');
});

test('the seeder refuses when more increments are broken than exist', () => {
  const dir = scratch('fg-contra');
  const out = path.join(dir, 'record.jsonl');
  const scratchRoot = path.join(dir, 'seed-root');
  fs.mkdirSync(scratchRoot);

  const r = runDriver(['--false-green', '--increments', '4', '--broken', '9', '--scratch-root', scratchRoot, '--out', out]);
  assert.notEqual(r.status, 0, 'the contradiction is a non zero exit');
  assert.match(r.stderr, /9/, 'the refusal names the broken count');
  assert.match(r.stderr, /4/, 'and the increment count it exceeds');
  // Validation precedes the side effect: no repository was built and no record written.
  assert.equal(fs.existsSync(out), false, 'nothing was written');
  assert.deepEqual(fs.readdirSync(scratchRoot), [], 'no scratch repository was built before the contradiction was caught');
});

// ─── task 3: --real and --history, driven without invoking the real gate ────

const GIT = '/usr/bin/git';

/** A scratch git repository with the subjects the caller names, in the order given. */
function seedHistory(dir, subjects) {
  const run = (args) => spawnSync(GIT, args, { cwd: dir, encoding: 'utf8' });
  run(['init', '--quiet']);
  run(['config', 'user.email', 'bench@example.invalid']);
  run(['config', 'user.name', 'bench-land-gate']);
  run(['config', 'commit.gpgsign', 'false']);
  for (let i = 0; i < subjects.length; i++) {
    fs.writeFileSync(path.join(dir, `f-${i}.txt`), `${i}\n`, 'utf8');
    run(['add', '.']);
    run(['commit', '--quiet', '-m', subjects[i]]);
  }
  return dir;
}

test('--real resolves the repository own land gate without invoking it', () => {
  const dir = scratch('real-dry');
  seedHistory(dir, ['chore: base']);
  const r = runDriver(['--real', '--dry-run', '--gates', '2', '--load', '1', '--root', dir], { cwd: dir });
  assert.equal(r.status, 0, `dry run failed: ${r.stderr}`);
  assert.equal(fieldOf(r.stdout, 'gate_cmd'), 'npm run lint:ci && npm test', 'the real gate is this repository own');
  assert.equal(fieldOf(r.stdout, 'real'), 'true', 'the run is marked real');
  assert.equal(fieldOf(r.stdout, 'gates'), '2', 'the requested cohort survived argv');
});

test('--real refuses on a dirty working tree and names the reason', () => {
  const dir = scratch('real-dirty');
  seedHistory(dir, ['chore: base']);
  fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'work in progress\n', 'utf8');

  const r = runDriver(['--real', '--dry-run', '--gates', '1', '--load', '0', '--root', dir], { cwd: dir });
  assert.notEqual(r.status, 0, 'a dirty tree is a non zero exit');
  assert.match(r.stderr, /DIRTY/, 'the refusal names the condition');
  assert.match(r.stderr, /uncommitted\.txt/, 'and names the path that caused it');
});

test('--history reports unavailable, never 0, when no commit matches', () => {
  const dir = scratch('hist-empty');
  seedHistory(dir, ['chore: nothing plan shaped here', 'docs: also nothing']);

  const r = runDriver(['--history', '--root', dir], { cwd: dir });
  assert.equal(r.status, 0, 'an unavailable number is a legitimate outcome and exits 0');
  assert.equal(fieldOf(r.stdout, 'provenance'), 'unavailable', 'the provenance says so');
  assert.equal(fieldOf(r.stdout, 'rate'), 'unavailable', 'an unmeasured rate is not a rate of 0');
  assert.notEqual(fieldOf(r.stdout, 'rate'), '0', 'and is never printed as 0');
});

test('--history derives a labelled rate from a history where repairs are present', () => {
  const dir = scratch('hist-full');
  // 30-02 is repaired AFTER it first appears, so it failed later.
  // 30-04 opens WITH a fix, so it has no repair later than its own first commit
  // and must not be counted. Without that clause the rate would read 0.5.
  seedHistory(dir, [
    'feat(30-01): the first plan',
    'docs(30-01): summary',
    'feat(30-02): the second plan',
    'fix(30-02): repair after landing',
    'feat(30-03): the third plan',
    'fix(30-04): the fourth plan opens with a repair',
  ]);

  const r = runDriver(['--history', '--root', dir], { cwd: dir });
  assert.equal(r.status, 0, `history failed: ${r.stderr}`);
  assert.equal(fieldOf(r.stdout, 'provenance'), 'replayed', 'a derived historical number is labelled replayed');
  assert.equal(fieldOf(r.stdout, 'landed_pairs'), '4', '4 distinct phase and plan pairs landed');
  assert.equal(fieldOf(r.stdout, 'failed_later_pairs'), '1', 'only 30-02 was repaired later than its first commit');
  assert.equal(fieldOf(r.stdout, 'rate'), '0.25', 'the rate is the second over the first');
  assert.equal(fieldOf(r.stdout, 'bound'), 'lower', 'and is published as a bound, never as the true rate');
  assert.match(r.stdout, /caveat/i, 'the caveats travel with the number rather than being buried');
});

test('the record names the command it timed, so a curve cannot be misattributed', () => {
  const dir = scratch('attrib');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');
  const gateCmd = cmd([process.execPath, fx, '40', '0']);

  const r = runDriver(['--gates', '1', '--load', '0', '--gate-cmd', gateCmd, '--out', out]);
  assert.equal(r.status, 0, `driver failed: ${r.stderr}`);

  const started = ofKind(readRecord(out), 'run_started');
  assert.equal(started.length, 1, '1 run_started before any property over it');
  assert.equal(started[0].gate_cmd, gateCmd, 'the record carries the exact command that was timed');
  assert.equal(started[0].real, false, 'and says plainly that this was not the repository own gate');
  assert.equal(started[0].requested_gates, 1, 'and the cohort that was requested');
});

test('a red gate is counted and warned about beside the curve', () => {
  const dir = scratch('redcount');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '2', '--load', '0',
    '--gate-cmd', cmd([process.execPath, fx, '40', '1']),
    '--out', out,
  ]);
  assert.equal(r.status, 0, 'the measurement completed');
  // A COUNTER, never a flag: an implementation that printed a warning and
  // counted 0 would pass a flag assertion and fail this one.
  assert.equal(fieldOf(r.stdout, 'gates_measured'), '2', '2 gates were measured');
  assert.equal(fieldOf(r.stdout, 'gates_red'), '2', 'both were red');
  assert.equal(fieldOf(r.stdout, 'gates_green'), '0', 'and none was green');
  assert.match(r.stdout, /WARNING/, 'a curve built from failing gates is flagged as such');
});

test('an all green run reports 0 red and raises no warning', () => {
  const dir = scratch('greencount');
  const fx = writeGateFixture(dir, SLEEP_GATE);
  const out = path.join(dir, 'record.jsonl');

  const r = runDriver([
    '--gates', '2', '--load', '0',
    '--gate-cmd', cmd([process.execPath, fx, '40', '0']),
    '--out', out,
  ]);
  assert.equal(r.status, 0, 'the measurement completed');
  assert.equal(fieldOf(r.stdout, 'gates_green'), '2', 'both gates were green');
  assert.equal(fieldOf(r.stdout, 'gates_red'), '0', 'none was red');
  assert.doesNotMatch(r.stdout, /WARNING/, 'a clean run raises no warning, so the warning is not constant');
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
