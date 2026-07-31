#!/usr/bin/env node
'use strict';

/**
 * bench-land-gate.cjs: Phase 22 of milestone v1.14 (Fleet Mode), plan 05.
 *
 * Measures the land gate. Three modes, 1 script:
 *
 *   1. THE LOAD DRIVER. Runs K gate commands concurrently while M background
 *      load commands run alongside, times every gate against a real wall clock,
 *      and reports the cost as a CURVE over concurrency.
 *   2. THE FALSE GREEN SEEDER. Builds a scratch git repository holding N
 *      increments of which exactly J pass a NARROW check and fail a WIDE one,
 *      then folds the resulting record and checks the rate against the number
 *      the caller chose.
 *   3. THE HISTORICAL QUERY. Derives this repository's own land failure rate
 *      from commit subjects, labels it `replayed`, publishes its caveats, and
 *      reports `unavailable` rather than 0 when the query finds nothing.
 *
 * WHY A CURVE AND NEVER AN AVERAGE. `.planning/TEST-AND-BENCHMARK-DESIGN.md:123`
 * asks whether the gate degrades under contention and names that as unknown. An
 * average over concurrency buckets is precisely the statistic that hides the
 * degradation this script exists to find. A gate costing 40 s alone and 6 min at
 * width 5 is a different system from one costing 40 s at both, and only a curve
 * can tell them apart.
 *
 * WHY `concurrency` IS THE OBSERVED PEAK IN FLIGHT COUNT, NOT THE REQUESTED `K`.
 * This is the T-22-05-01 guard and it is the single most consequential decision
 * in the file. A cohort of 3 gates spawns over a few milliseconds, so counting
 * only at the instant of each spawn would record 1, 2 and 3, and the gate that
 * actually spent its whole life under 3 way contention would land in the
 * BASELINE bucket. That silently flattens the curve. So each gate carries the
 * maximum number of gate processes observed in flight at any instant during its
 * own interval. A staggered cohort that never overlaps therefore records values
 * BELOW the requested count, which is the observation, and the test asserts
 * exactly that.
 *
 * WHY THE RECORD IS VALIDATED BEFORE IT IS WRITTEN. An emitter whose output its
 * own reader rejects is a defect that must surface at the emitter rather than
 * silently in the report. Nothing is written until `validateRunRecord` returns
 * clean, and a refusal names its codes and writes no file at all.
 *
 * THE WIRE SHAPE IS THE SHIPPED ONE. `.planning/phases/22-proof/CONTEXT.md` D10
 * declared hyphenated kinds and outcomes that no library ships. Plan 22-04
 * measured 9 divergences and adopted the shipped `fleet-runlog` vocabulary. This
 * emitter writes that vocabulary: underscored kinds, `verdict` on `gate_ended`,
 * `abnormal` for a recorded abnormal worker exit, and `false_green` for the post
 * land classification. The producer is the authority.
 *
 * FF-B252 IS CLOSED FOR THIS ARM. `src/fleet-landqueue.cts` writes no
 * `concurrency` onto `gate_started`, so `foldLandGateCost` correctly returns
 * UNKNOWN for every record the loop emits today. That fold behaviour is right and
 * is not widened here. This harness is its own emitter and it writes the field,
 * which is why it gets a curve where the loop gets an honest refusal.
 *
 * THIS SCRIPT OWNS NO GOVERNED FILE, adds no npm script alias and appears in no
 * lint chain, for the reason `scripts/gen-workgraph.cjs:12-21` gives about
 * derived answers. It also must not: a benchmark that ran inside the land gate
 * would be a land gate measuring itself.
 *
 * Usage:
 *   node scripts/bench-land-gate.cjs --gates <K> --load <M> [--repeat <R>]
 *        [--gate-cmd <cmd>] [--load-cmd <cmd>] [--stagger <ms>] [--out <path>]
 *        [--corpus-hash <h>] [--run-id <id>] [--real] [--dry-run]
 *   node scripts/bench-land-gate.cjs --false-green --increments <N> --broken <J>
 *        [--classify <C>] [--skip-wide] [--scratch-root <dir>] [--out <path>]
 *   node scripts/bench-land-gate.cjs --history [--root <dir>]
 *
 * Test only flags, named as such because they exist to drive a guard:
 *   --suppress-run-closed   omit `run_closed` so the self validation refusal fires
 *   --clock-step <ms>       inject a fake clock advancing by a fixed step per call
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');
const FOLD_PATH = path.join(LIB_DIR, 'proof-fold.cjs');
const CLOCK_PATH = path.join(LIB_DIR, 'clock.cjs');

/**
 * `/usr/bin/git` and nothing else, anywhere in this file. The RTK proxy silently
 * truncates `git log` at 50 lines with no marker and it corrupted a measurement
 * before it was caught (FF-B60). A truncated history query publishes a wrong
 * denominator and nobody can see that it happened.
 */
const GIT = '/usr/bin/git';

/** The real land gate: this repository's own, verbatim. */
const REAL_GATE_CMD = 'npm run lint:ci && npm test';

const USAGE = [
  '  node scripts/bench-land-gate.cjs --gates <K> --load <M> [--repeat <R>] [--gate-cmd <cmd>]',
  '                                   [--load-cmd <cmd>] [--stagger <ms>] [--out <path>] [--real]',
  '  node scripts/bench-land-gate.cjs --false-green --increments <N> --broken <J> [--classify <C>]',
  '                                   [--skip-wide] [--scratch-root <dir>] [--out <path>]',
  '  node scripts/bench-land-gate.cjs --history [--root <dir>]',
].join('\n');

function loadLibs() {
  try {
    return { fold: require(FOLD_PATH), clock: require(CLOCK_PATH) };
  } catch {
    throw new ExitError(
      1,
      'ferrox-core/bin/lib/proof-fold.cjs or clock.cjs is missing. Run:\n'
        + '  npm run build:lib',
    );
  }
}

// ─── argv ────────────────────────────────────────────────────────────────────

/** Flags taking a value. Every other `--flag` is a boolean, and anything else is rejected by name. */
const VALUE_FLAGS = new Set([
  '--gates', '--load', '--repeat', '--gate-cmd', '--load-cmd', '--stagger', '--out',
  '--corpus-hash', '--run-id', '--clock-step', '--root',
  '--increments', '--broken', '--classify', '--scratch-root',
]);

const BOOL_FLAGS = new Set([
  '--real', '--dry-run', '--suppress-run-closed', '--help',
  '--false-green', '--skip-wide', '--history',
]);

/**
 * `runMain` passes NO arguments to main, so every flag is read from
 * `process.argv.slice(2)` here. An unknown flag is REJECTED BY NAME rather than
 * ignored: a benchmark that silently dropped `--gates 5` would report a width 1
 * measurement labelled as a width 5 one.
 */
function readArgv(argv) {
  const out = { flags: {}, bools: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new ExitError(1, `bench-land-gate.cjs takes no positional argument, and got ${JSON.stringify(a)}. Run:\n${USAGE}`);
    }
    if (BOOL_FLAGS.has(a)) {
      out.bools[a] = true;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) throw new ExitError(1, `${a} needs a value, and none was given. Run:\n${USAGE}`);
      out.flags[a] = v;
      i += 1;
      continue;
    }
    throw new ExitError(1, `unknown flag ${a}. bench-land-gate.cjs rejects a flag it does not know rather than ignoring it, because an ignored flag produces a measurement labelled as something it is not. Run:\n${USAGE}`);
  }
  return out;
}

function intFlag(parsed, name, fallback, min) {
  const raw = parsed.flags[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ExitError(1, `${name} takes a non negative whole number, and got ${JSON.stringify(raw)}`);
  const n = Number(raw);
  if (n < min) throw new ExitError(1, `${name} must be at least ${min}, and got ${n}`);
  return n;
}

// ─── the clock seam ──────────────────────────────────────────────────────────

/**
 * A clock advancing by a fixed step per call, for the tests.
 *
 * The harness NEVER sets `FERROX_TEST_MODE` or `FERROX_NOW_MS` on its own
 * process or on any child's. Both must be set for `clock.cjs` to pin, setting 1
 * of the 2 leaves the code reading real time while appearing pinned, and a
 * measurement harness that pinned its own clock would report 0 for every
 * duration. Determinism arrives as an INJECTED ARGUMENT instead.
 */
function stepClock(stepMs) {
  let calls = 0;
  return {
    now() {
      const t = calls * stepMs;
      calls += 1;
      return t;
    },
  };
}

// ─── the emitter ─────────────────────────────────────────────────────────────

function makeEmitter(clock, runId) {
  const events = [];
  return {
    events,
    emit(kind, fields) {
      const event = { kind, run_id: runId, ts: clock.now() };
      for (const [k, v] of Object.entries(fields || {})) event[k] = v;
      events.push(event);
      return event;
    },
  };
}

// ─── child processes ─────────────────────────────────────────────────────────

/**
 * Every child gets an explicit `cwd` and an environment DERIVED from the
 * parent's, never the parent's own object mutated. A harness that mutated
 * `process.env` to configure 1 child would configure every later one too.
 */
function childEnv() {
  return { ...process.env };
}

function substitute(command, index, total) {
  return command.split('{i}').join(String(index)).split('{n}').join(String(total));
}

/** Spawn and resolve once the operating system confirms the process exists. */
function spawnChild(command, cwd, detached) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: childEnv(),
      detached: Boolean(detached),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

function onExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Kill a detached child's whole process group, then escalate.
 *
 * The group, not the process: every command runs under a shell, so killing the
 * shell alone can orphan whatever it launched. A load process that outlived the
 * run would skew every later measurement taken on the machine, which is the
 * T-22-05-05 threat.
 */
async function reap(child) {
  const exited = onExit(child);
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  const escalate = delay(2000).then(() => 'timeout');
  if (await Promise.race([exited.then(() => 'exited'), escalate]) === 'timeout') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await exited;
}

// ─── the load driver ─────────────────────────────────────────────────────────

/**
 * Run `repeat` cohorts of `gates` concurrent gate commands, each cohort under
 * `load` background processes, and return the event array. The clock is an
 * ARGUMENT and is never defaulted in here: only the top level call site knows
 * whether this is a measurement or a test.
 */
async function runDriver(options) {
  const {
    clock, gates, load, repeat, gateCmd, loadCmd, stagger, cwd, runId, corpusHash, suppressClose, real,
  } = options;
  const em = makeEmitter(clock, runId);

  // The record NAMES THE COMMAND IT TIMED. Without this a curve can be quoted as
  // the repository's own land gate when it in fact timed a stand in, or timed a
  // gate that short circuited on an unrelated check. That is not hypothetical:
  // the first real run of this harness produced a plausible looking 2 second
  // bucket that was a failing drift check, not the gate.
  em.emit('run_started', {
    graph_generation: 'bench-land-gate/v1',
    corpus_hash: corpusHash,
    arm: 'serial',
    provenance: 'measured',
    gate_cmd: gateCmd,
    load_cmd: loadCmd,
    requested_gates: gates,
    requested_load: load,
    real: Boolean(real),
  });

  for (let rep = 0; rep < repeat; rep++) {
    // ── the background load, started FIRST and running throughout ──────────
    const loadChildren = [];
    for (let j = 0; j < load; j++) {
      const id = `load-${rep}-${j}`;
      const child = await spawnChild(substitute(loadCmd, j, load), cwd, true);
      loadChildren.push({ id, child });
      em.emit('worker_started', {
        worker_id: id, node_id: id, attempt_id: id, lease_epoch: 0, pid: child.pid,
      });
    }

    // ── the gate cohort ───────────────────────────────────────────────────
    const open = new Set();
    const waits = [];
    let inFlight = 0;

    for (let i = 0; i < gates; i++) {
      if (stagger > 0 && i > 0) await delay(stagger);

      const id = `gate-${rep}-${i}`;
      const child = await spawnChild(substitute(gateCmd, i, gates), cwd, false);
      inFlight += 1;

      em.emit('worker_started', {
        worker_id: id, node_id: id, attempt_id: id, lease_epoch: 0, pid: child.pid,
      });
      const startEvent = em.emit('gate_started', {
        node_id: id, attempt_id: id, gate: 'land', concurrency: inFlight,
      });

      // The peak is raised for every gate whose interval is open right now,
      // including this one. This is what makes the recorded number an
      // observation of contention rather than a restatement of the request.
      const record = { startEvent, peak: inFlight };
      open.add(record);
      for (const other of open) other.peak = Math.max(other.peak, inFlight);

      waits.push(onExit(child).then(({ code, signal }) => {
        inFlight -= 1;
        open.delete(record);
        const green = code === 0 && signal === null;
        em.emit('gate_ended', {
          node_id: id, attempt_id: id, gate: 'land', verdict: green ? 'green' : 'red',
        });
        em.emit('worker_ended', {
          worker_id: id, node_id: id, attempt_id: id, outcome: green ? 'completed' : 'failed',
        });
        // Recorded on the START event, which is where the fold reads it, and
        // fixed only once the interval it describes has actually closed.
        record.startEvent.concurrency = record.peak;
      }));
    }

    await Promise.all(waits);

    // ── every child is reaped, and the kill is a RECORDED abnormal exit ────
    for (const { id, child } of loadChildren) {
      await reap(child);
      em.emit('worker_ended', {
        worker_id: id, node_id: id, attempt_id: id, outcome: 'abnormal',
      });
    }
  }

  if (!suppressClose) em.emit('run_closed', {});
  return em.events;
}

// ─── writing, which happens only after the reader accepts ────────────────────

/**
 * Validate, THEN write. Never the other way round.
 *
 * A record that fails its own reader is refused with every code named and
 * nothing is written at all, so a caller cannot find a half trusted artifact on
 * disk and fold it later.
 */
function validateThenWrite(fold, events, outPath) {
  const result = fold.validateRunRecord(events);
  if (!result.ok) {
    const codes = [...new Set(result.errors.map((e) => e.code))].sort();
    const detail = result.errors.map((e) => `  [${e.code}] ${e.message}`).join('\n');
    throw new ExitError(
      1,
      `refusing to write ${outPath}: the emitted record does not validate through its own reader.\n`
        + `codes: ${codes.join(', ')}\n${detail}\n`
        + 'Nothing was written. An emitter whose output its own reader rejects is a defect that '
        + 'belongs at the emitter, not in the report.',
    );
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
}

/** The operator facing curve, printed from the SAME fold the machine readable metric uses. */
function printCurve(fold, events, outPath) {
  const cost = fold.foldLandGateCost(events);
  const lines = [
    '',
    'land gate cost curve',
    '',
    '| concurrency | n | median ms | max ms |',
    '| --- | --- | --- | --- |',
  ];
  for (const b of cost.buckets) {
    lines.push(`| ${b.concurrency} | ${b.n} | ${b.median_ms} | ${b.max_ms} |`);
  }
  // A RED COUNT, printed beside the curve and never inferred from it.
  // A bucket built from failing gates is a bucket that timed a short circuit,
  // and it is indistinguishable from a fast gate unless the verdicts are shown.
  const ends = events.filter((e) => e.kind === 'gate_ended');
  const red = ends.filter((e) => e.verdict !== 'green').length;
  lines.push('');
  lines.push(`gates_measured: ${ends.length}`);
  lines.push(`gates_green: ${ends.length - red}`);
  lines.push(`gates_red: ${red}`);
  if (red > 0) {
    lines.push(
      `WARNING: ${red} of ${ends.length} gate${ends.length === 1 ? '' : 's'} exited non zero. A red `
        + 'gate is a real measurement, but a gate that fails EARLY times its failure rather than the '
        + 'gate, so this curve must not be read as the cost of a passing gate.',
    );
  }
  lines.push(`gate_cost_state: ${cost.state}`);
  lines.push(`baseline_ms: ${cost.baseline_ms === null ? 'null' : cost.baseline_ms}`);
  lines.push(`degradation: ${cost.degradation === null ? 'null' : cost.degradation.toFixed(4)}`);
  if (cost.reason !== '') lines.push(`reason: ${cost.reason}`);
  lines.push(`record: ${outPath}`);
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
}

// ─── the dirty tree refusal ──────────────────────────────────────────────────

/**
 * `--real` refuses on a dirty tree, because a gate measured against uncommitted
 * work is not measuring the gate. The check runs BEFORE anything is spawned.
 */
function refuseIfDirty(root) {
  let status;
  try {
    status = execFileSync(GIT, ['status', '--porcelain'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    throw new ExitError(1, `--real could not read the working tree state at ${root}: ${err.message}`);
  }
  const dirty = status.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (dirty.length === 0) return;
  throw new ExitError(
    1,
    `--real refuses to run: the working tree at ${root} is DIRTY, with ${dirty.length} changed `
      + `path${dirty.length === 1 ? '' : 's'}:\n${dirty.slice(0, 10).map((l) => `  ${l}`).join('\n')}\n`
      + 'A gate measured against uncommitted work is not measuring the gate. Commit or stash first.',
  );
}

// ─── mode 1: the driver ──────────────────────────────────────────────────────

const DEFAULT_GATE_CMD = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},40)"`;
const DEFAULT_LOAD_CMD = `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"`;

async function driverMode(parsed, libs) {
  const gates = intFlag(parsed, '--gates', 1, 1);
  const load = intFlag(parsed, '--load', 0, 0);
  const repeat = intFlag(parsed, '--repeat', 1, 1);
  const stagger = intFlag(parsed, '--stagger', 0, 0);
  const real = Boolean(parsed.bools['--real']);
  const root = parsed.flags['--root'] === undefined ? REPO_ROOT : path.resolve(parsed.flags['--root']);

  // The refusal precedes every side effect, including the dry run resolution.
  if (real) refuseIfDirty(root);

  // `--real` supplies the repository's own land gate as the DEFAULT, and an
  // explicit `--gate-cmd` still wins. The operator sometimes has to fence off a
  // component that is red for a reason outside the measurement, and the honest
  // answer to that is a named command recorded in the record, never a hidden
  // substitution. The dirty tree refusal applies either way.
  const gateCmd = parsed.flags['--gate-cmd'] !== undefined
    ? parsed.flags['--gate-cmd']
    : (real ? REAL_GATE_CMD : DEFAULT_GATE_CMD);
  const loadCmd = parsed.flags['--load-cmd'] === undefined ? DEFAULT_LOAD_CMD : parsed.flags['--load-cmd'];

  const runId = parsed.flags['--run-id'] === undefined
    ? `blg-${Date.now()}-${process.pid}`
    : parsed.flags['--run-id'];
  const corpusHash = parsed.flags['--corpus-hash'] === undefined
    ? (real ? 'REPO-LAND-GATE' : 'STANDIN-LAND-GATE')
    : parsed.flags['--corpus-hash'];
  const outPath = parsed.flags['--out'] === undefined
    ? path.join(REPO_ROOT, '.planning', 'proof', `${runId}.jsonl`)
    : path.resolve(parsed.flags['--out']);

  if (parsed.bools['--dry-run']) {
    process.stdout.write([
      'mode: driver',
      `gate_cmd: ${gateCmd}`,
      `load_cmd: ${loadCmd}`,
      `gates: ${gates}`,
      `load: ${load}`,
      `repeat: ${repeat}`,
      `stagger: ${stagger}`,
      `real: ${real}`,
      `record: ${outPath}`,
      '',
    ].join('\n'));
    return 0;
  }

  const stepRaw = parsed.flags['--clock-step'];
  const clock = stepRaw === undefined ? libs.clock.realClock : stepClock(intFlag(parsed, '--clock-step', 1, 1));

  const events = await runDriver({
    clock,
    gates,
    load,
    repeat,
    gateCmd,
    loadCmd,
    stagger,
    cwd: root,
    runId,
    corpusHash,
    real,
    suppressClose: Boolean(parsed.bools['--suppress-run-closed']),
  });

  validateThenWrite(libs.fold, events, outPath);
  printCurve(libs.fold, events, outPath);
  // A red gate is a MEASUREMENT. The driver reports that the measurement
  // completed, never that the gate failed.
  return 0;
}

// ─── mode 2: the false green seeder ──────────────────────────────────────────

/**
 * A false green is an increment that passed the gate it was checked BY and
 * failed a LATER gate. `.planning/TEST-AND-BENCHMARK-DESIGN.md:124` gives that
 * definition and names the reason it is the honest number: speed bought by
 * landing broken work is not speed.
 *
 * The narrow check is what an increment is checked by before it lands. The wide
 * check is what runs afterward. Both are stand ins and NOT this repository's own
 * gates: the subject of this mode is the RATE APPARATUS, and driving the real
 * gates here would make every test take minutes and would prove nothing extra.
 *
 * Both checks run as REAL CHILD PROCESSES against a REAL git repository, because
 * an apparatus tested only against a hand built event array is an apparatus that
 * has never seen its own inputs.
 */
function runCheck(script, target, cwd) {
  const r = spawnSync(process.execPath, [script, target], {
    cwd, env: childEnv(), encoding: 'utf8', timeout: 30000,
  });
  return r.status === 0;
}

const NARROW_CHECK = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const body = fs.readFileSync(process.argv[2], 'utf8');",
  "process.exitCode = body.includes('NARROW-FAIL') ? 1 : 0;",
  '',
].join('\n');

const WIDE_CHECK = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const body = fs.readFileSync(process.argv[2], 'utf8');",
  "process.exitCode = body.includes('WIDE-FAIL') ? 1 : 0;",
  '',
].join('\n');

function git(args, cwd) {
  execFileSync(GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Build the scratch repository. Every path is joined from the scratch root, never assembled by hand. */
function seedRepository(repoRoot, increments, broken) {
  fs.mkdirSync(repoRoot, { recursive: true });
  git(['init', '--quiet'], repoRoot);
  git(['config', 'user.email', 'bench@example.invalid'], repoRoot);
  git(['config', 'user.name', 'bench-land-gate'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);

  fs.writeFileSync(path.join(repoRoot, 'narrow-check.cjs'), NARROW_CHECK, 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'wide-check.cjs'), WIDE_CHECK, 'utf8');
  git(['add', '.'], repoRoot);
  git(['commit', '--quiet', '-m', 'chore: the 2 checks'], repoRoot);

  const files = [];
  for (let i = 0; i < increments; i++) {
    // The FIRST `broken` increments are the seeded ones. They pass the narrow
    // check and fail the wide one, which is the definition made concrete.
    const isBroken = i < broken;
    const name = `inc-${i}.txt`;
    const body = isBroken ? `increment ${i}\nWIDE-FAIL\n` : `increment ${i}\n`;
    fs.writeFileSync(path.join(repoRoot, name), body, 'utf8');
    git(['add', name], repoRoot);
    git(['commit', '--quiet', '-m', `feat(seed-${i}): increment ${i}`], repoRoot);
    files.push({ index: i, name, isBroken });
  }
  return files;
}

/**
 * The result string a successful land carries, READ FROM THE SHIPPED LIBRARY.
 *
 * `foldFalseGreenRate` classifies `land_completed.result` by FAMILY and reports
 * UNKNOWN for a family it does not recognise, so an invented value such as `ok`
 * would make the denominator vanish and the seeded rate with it. Preferring
 * `landed`, which is what `defaultLandCommand` returns on exit 0, and refusing
 * outright rather than shipping a string the reader cannot classify.
 */
function landedResult(libs) {
  const families = libs.fold.LAND_RESULTS_LANDED;
  if (Array.isArray(families) && families.includes('landed')) return 'landed';
  if (Array.isArray(families) && families.length > 0) return families[0];
  throw new ExitError(
    1,
    'the shipped proof-fold library exposes no landed result family, so this seeder cannot write a '
      + 'land_completed the fold would count. Run:\n  npm run build:lib',
  );
}

function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* best effort: the scratch root is the caller's to inspect */ }
}

function falseGreenMode(parsed, libs) {
  const increments = intFlag(parsed, '--increments', 10, 1);
  const broken = intFlag(parsed, '--broken', 0, 0);
  const classify = intFlag(parsed, '--classify', increments, 0);
  const skipWide = Boolean(parsed.bools['--skip-wide']);

  // VALIDATE FIRST. The contradiction is caught before a single directory is
  // created, so a refused run leaves nothing behind to be found and folded.
  if (broken > increments) {
    throw new ExitError(
      1,
      `--broken ${broken} exceeds --increments ${increments}. A corpus cannot contain more broken `
        + `increments than increments. Nothing was built and nothing was written. Choose a --broken `
        + `value at or below ${increments}.`,
    );
  }

  const runId = parsed.flags['--run-id'] === undefined
    ? `blg-fg-${Date.now()}-${process.pid}`
    : parsed.flags['--run-id'];
  const outPath = parsed.flags['--out'] === undefined
    ? path.join(REPO_ROOT, '.planning', 'proof', `${runId}.jsonl`)
    : path.resolve(parsed.flags['--out']);
  const scratchRoot = parsed.flags['--scratch-root'] === undefined
    ? os.tmpdir()
    : path.resolve(parsed.flags['--scratch-root']);

  const repoRoot = fs.mkdtempSync(path.join(scratchRoot, 'blg-seed-'));
  const clock = parsed.flags['--clock-step'] === undefined
    ? libs.clock.realClock
    : stepClock(intFlag(parsed, '--clock-step', 1, 1));
  const em = makeEmitter(clock, runId);

  try {
    const files = seedRepository(repoRoot, increments, broken);
    const narrow = path.join(repoRoot, 'narrow-check.cjs');
    const wide = path.join(repoRoot, 'wide-check.cjs');

    em.emit('run_started', {
      graph_generation: 'bench-land-gate/v1',
      corpus_hash: `SEEDED-${increments}-${broken}`,
      arm: 'serial',
      provenance: 'measured',
    });

    const landed = [];
    for (const f of files) {
      const id = `inc-${f.index}`;
      const target = path.join(repoRoot, f.name);
      em.emit('worker_started', { worker_id: id, node_id: id, attempt_id: id, lease_epoch: 0 });
      em.emit('gate_started', { node_id: id, attempt_id: id, gate: 'narrow', concurrency: 1 });
      const green = runCheck(narrow, target, repoRoot);
      em.emit('gate_ended', { node_id: id, attempt_id: id, gate: 'narrow', verdict: green ? 'green' : 'red' });
      em.emit('worker_ended', { worker_id: id, node_id: id, attempt_id: id, outcome: 'completed' });
      if (!green) continue;
      em.emit('land_completed', { node_id: id, attempt_id: id, result: landedResult(libs) });
      landed.push({ id, target });
    }

    // The wide check runs AFTER landing, which is what makes its failures LATER
    // failures rather than gate failures. A rate derived from the narrow gate's
    // own verdicts would read 0 on this record by construction.
    if (!skipWide) {
      for (const l of landed.slice(0, classify)) {
        const held = runCheck(wide, l.target, repoRoot);
        // Both values are read from the shipped library, never transcribed. The
        // fold partitions truths into DECIDED and undecided, and a record whose
        // classifications are all `unknown` reports UNDEFINED rather than a rate
        // of 0, so a seeder writing an undecided value would seed nothing.
        em.emit('post_land_truth', {
          node_id: l.id,
          attempt_id: l.id,
          classification: held ? libs.fold.HELD_CLASSIFICATION : libs.fold.FALSE_GREEN_CLASSIFICATION,
          failing_gate: held ? '' : 'wide',
        });
      }
    }

    em.emit('run_closed', {});
    validateThenWrite(libs.fold, em.events, outPath);
  } finally {
    removeTree(repoRoot);
  }

  const rate = libs.fold.foldFalseGreenRate(em.events);
  process.stdout.write([
    '',
    'false green rate',
    '',
    `seeded_increments: ${increments}`,
    `seeded_broken: ${broken}`,
    `landed: ${em.events.filter((e) => e.kind === 'land_completed').length}`,
    `classified: ${em.events.filter((e) => e.kind === 'post_land_truth').length}`,
    `false_green_rate: ${rate.value === null ? 'null' : rate.value}`,
    `false_green_state: ${rate.state}`,
    rate.reason === '' ? 'reason: none' : `reason: ${rate.reason}`,
    `scratch_repo: ${repoRoot}`,
    `record: ${outPath}`,
    '',
  ].join('\n'));
  return 0;
}

// ─── mode 3: the historical land failure rate ────────────────────────────────

/** The conventional commit shape this repository uses, carrying a phase and plan pair in its scope. */
const PLAN_SUBJECT = /^([a-z]+)\((\d+(?:\.\d+)?)-(\d+)\):/;

/** The 3 subject prefixes that name a repair. */
const REPAIR_TYPES = new Set(['fix', 'revert', 'repair']);

/** The query, in 1 line, so anyone can rerun it by hand and get the same input. */
const HISTORY_QUERY = `${GIT} log --reverse --format=%s`;

/**
 * The caveats, published WITH the number rather than buried under it.
 *
 * A number nobody can reproduce is worse than an absent one, and a number whose
 * blind spots are unstated invites being quoted as the true rate. This query has
 * pressure in BOTH directions and both are named, because naming only the
 * undercount would make the result look conservative when it is not purely so.
 */
const HISTORY_CAVEATS = [
  'caveat 1: the query reads commit SUBJECTS only, so it counts only failures that were repaired '
    + 'in a separately labelled commit.',
  'caveat 2: a failure repaired silently inside a later plan is INVISIBLE to it, which pushes the '
    + 'number DOWN.',
  'caveat 3: a repair committed during a plan own execution, after its first commit but before it '
    + 'closed, is counted here, which pushes the number UP.',
  'caveat 4: it is therefore a BOUND rather than the true rate, and it must never be quoted as the '
    + 'measured land failure rate.',
];

/**
 * LANDED and FAILED LATER are both counted over distinct phase and plan PAIRS.
 *
 * The plan text says "count as LANDED every COMMIT whose subject matches" and
 * then "every landed PAIR" for the numerator. Those 2 are different
 * denominators and the rate is only coherent over 1 of them, so pairs are used
 * for both and the choice is stated here rather than left to a reader to infer.
 */
function foldHistory(subjects) {
  const first = new Map();
  const repairs = new Map();

  for (let i = 0; i < subjects.length; i++) {
    const m = PLAN_SUBJECT.exec(subjects[i]);
    if (m === null) continue;
    const pair = `${m[2]}-${m[3]}`;
    if (!first.has(pair)) first.set(pair, i);
    if (!REPAIR_TYPES.has(m[1])) continue;
    const list = repairs.get(pair);
    if (list === undefined) repairs.set(pair, [i]); else list.push(i);
  }

  const failedLater = [];
  for (const [pair, firstIndex] of first) {
    const list = repairs.get(pair);
    if (list === undefined) continue;
    // Strictly LATER than the pair's first commit. A pair that opens with a fix
    // was never repaired after landing and must not be counted, and without this
    // clause the rate inflates on exactly the commits that prove nothing.
    if (list.some((i) => i > firstIndex)) failedLater.push(pair);
  }

  return { landed: [...first.keys()], failedLater: failedLater.sort() };
}

function historyMode(parsed) {
  const root = parsed.flags['--root'] === undefined ? REPO_ROOT : path.resolve(parsed.flags['--root']);

  let raw;
  try {
    raw = execFileSync(GIT, ['log', '--reverse', '--format=%s'], {
      cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
  } catch (err) {
    process.stdout.write(unavailable(root, `the history query could not run: ${err.message}`));
    return 0;
  }

  const subjects = raw.split(/\r?\n/).filter((l) => l !== '');
  const { landed, failedLater } = foldHistory(subjects);

  if (landed.length === 0) {
    process.stdout.write(unavailable(
      root,
      `0 of ${subjects.length} commit subjects match the phase and plan shape, so the denominator `
        + 'does not exist. An unmeasured rate is NOT a rate of 0.',
    ));
    return 0;
  }

  const rate = failedLater.length / landed.length;
  process.stdout.write([
    '',
    'historical land failure rate',
    '',
    'provenance: replayed',
    'bound: lower',
    `root: ${root}`,
    `subjects_read: ${subjects.length}`,
    `landed_pairs: ${landed.length}`,
    `failed_later_pairs: ${failedLater.length}`,
    `rate: ${rate}`,
    `failed_later: ${failedLater.join(', ')}`,
    `query: ${HISTORY_QUERY}`,
    ...HISTORY_CAVEATS,
    '',
  ].join('\n'));
  return 0;
}

function unavailable(root, reason) {
  return [
    '',
    'historical land failure rate',
    '',
    'provenance: unavailable',
    'rate: unavailable',
    `root: ${root}`,
    `reason: ${reason}`,
    `query: ${HISTORY_QUERY}`,
    '',
  ].join('\n');
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const parsed = readArgv(process.argv.slice(2));
  if (parsed.bools['--help']) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.bools['--history']) return historyMode(parsed);
  const libs = loadLibs();
  if (parsed.bools['--false-green']) return falseGreenMode(parsed, libs);
  return driverMode(parsed, libs);
}

if (require.main === module) runMain(main);

module.exports = {
  readArgv, runDriver, stepClock, substitute, validateThenWrite, refuseIfDirty, GIT, REAL_GATE_CMD,
};
