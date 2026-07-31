'use strict';

/**
 * SC1: the post land classification, its DERIVED counter, and its loud absence.
 *
 * ─── WHAT WAS BROKEN, MEASURED RATHER THAN PREDICTED (FF-B272) ───────────────
 *
 * `scripts/fleet-loop.cjs` has carried an `opts.verifyPostLand` seam since phase
 * 19, and NO command line path ever set it. Only the suite injected one. So on
 * every real run `classification` stayed the literal `unknown` for every landed
 * increment, and `unknown` is a legal MEMBER of the vocabulary rather than an
 * absence, so the record looked complete while nothing had been measured. The
 * false green rate over any real run was UNDEFINED BY CONSTRUCTION.
 *
 * ─── WHY EVERY ARM SPAWNS A CHILD PROCESS ────────────────────────────────────
 *
 * A GAP BETWEEN A LIBRARY AND ITS ENTRYPOINT IS INVISIBLE TO EVERY TEST THAT
 * IMPORTS THE LIBRARY. That is precisely the gap this plan closes, so a test that
 * called `runLoop` with a verifier of its own would prove nothing about it: the
 * suite has been able to do that since phase 19 and the defect shipped anyway.
 * These arms run a harness as a REAL CHILD PROCESS, and the harness reaches
 * `main` with a real argv.
 *
 * ─── WHY THE LAND SEAM IS A STUB AND THE CLASSIFICATION IS NOT ───────────────
 *
 * The land gate in this repository was MEASURED by plan 22-05 at 109 seconds warm
 * and 130 seconds cold. A suite that pays that is a suite nobody runs. So the
 * WORKER and the LAND are stubs, and everything under test is real: the flag
 * parse, the verifier construction, the spawn, the exit code classification, the
 * landed family test, the fold and the warning. The stub is what makes the exit
 * code drivable in milliseconds; it is not what is being measured.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const LOOP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fleet-loop.cjs');
const loop = require('../scripts/fleet-loop.cjs');
const proofFold = require('../ferrox-core/bin/lib/proof-fold.cjs');

/** How many plan nodes every fixture carries. Above 1 so counts discriminate. */
const NODE_COUNT = 3;

/**
 * The ceiling on 1 harness invocation, ms.
 *
 * A bound and not a comment: an arm whose failure mode is a hang has no verdict,
 * which is the same defect class this phase exists to find.
 */
const HARNESS_TIMEOUT_MS = 180000;

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-postland-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here, following tests/fleet-loop-park.test.cjs:75
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

/**
 * The harness: it reaches `main` with a real argv, in a real child process.
 *
 * It injects the WORKER and the LAND seams and nothing else. The preflight is
 * injected too, because this repository declares no `fleet.adapters` roster and
 * the real preflight therefore refuses by design, which is a different question
 * from the one every arm here asks.
 */
const HARNESS_SOURCE = `'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const loop = require(cfg.loopScript);

const allowed = () => ({
  checks: loop.CHECK_NAMES.map((name) => ({ name, ok: true, observed: {}, refused_because: null })),
  check_names: [...loop.CHECK_NAMES],
  dispatch_allowed: true,
});

loop.main({
  argv: cfg.argv,
  repoRoot: cfg.root,
  runPreflight: async () => allowed(),
  ensureControlPlane: () => ({ cards: {}, home: '' }),
  runLoop: (opts) => loop.runLoop({
    ...opts,
    projectionPath: cfg.projectionPath,
    tokenDir: cfg.tokenDir,
    repoKey: cfg.repoKey,
    runId: cfg.runId,
    clock: () => Date.now(),
    ttlMs: 3600000,
    heartbeatMs: 60,
    waitTickMs: 2000,
    maxPasses: 30,
    preflight: allowed(),
    landCommand: () => cfg.land,
    spawnWorker: () => spawn(process.execPath, [cfg.workerScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  }),
}).then(
  (code) => { process.exitCode = code; },
  (e) => { process.stderr.write('HARNESS_THREW: ' + (e && e.message) + '\\n'); process.exitCode = 70; },
);
`;

/** A worker that always succeeds, so a clean delivery reaches the land. */
const WORKER_SOURCE = "'use strict';\nprocess.exitCode = 0;\n";

/** A gate that exits with the code its fixture chose. */
const GATE_SOURCE = "'use strict';\nprocess.exitCode = Number(process.argv[2]);\n";

/**
 * Build a project, run 1 whole fleet through `main` in a child, and hand back
 * everything observed: the exit code, both channels, the printed summary and the
 * events on disk.
 *
 * BUILT AND NEVER BORROWED (FF-B217). An empty untracked directory does not exist
 * in any git checkout, so a borrowed fixture passes on 1 machine and nowhere else.
 */
function runFleet(label, { land, verifyArgs = null, extraArgs = [] }) {
  const root = scratch(label);
  const phase = '95';
  const phaseDir = path.join(root, '.planning', 'phases', `${phase}-postland`);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (let n = 1; n <= NODE_COUNT; n++) {
    const plan = String(n).padStart(2, '0');
    fs.writeFileSync(path.join(phaseDir, `${phase}-${plan}-PLAN.md`), [
      '---',
      `phase: ${phase}-postland`,
      `plan: ${plan}`,
      'type: execute',
      'wave: 1',
      'depends_on: []',
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

  const workerScript = path.join(root, 'stub-worker.cjs');
  fs.writeFileSync(workerScript, WORKER_SOURCE);
  const harnessScript = path.join(root, 'harness.cjs');
  fs.writeFileSync(harnessScript, HARNESS_SOURCE);

  const logPath = path.join(root, `${label}.jsonl`);
  const argv = [phase, '--run', '--raw', `--log=${logPath}`, ...extraArgs];
  if (verifyArgs !== null) {
    argv.push(`--verify-post-land=${verifyArgs.join(loop.VERIFY_POST_LAND_SEPARATOR)}`);
  }

  const cfgPath = path.join(root, 'harness.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    loopScript: LOOP_SCRIPT,
    root,
    argv,
    land,
    workerScript,
    logPath,
    projectionPath: path.join(root, 'board.json'),
    tokenDir: path.join(root, '.planning'),
    repoKey: `loop-postland/${label}`,
    runId: `run-${label}`,
  }));

  const proc = spawnSync(process.execPath, [harnessScript, cfgPath], {
    cwd: root,
    encoding: 'utf8',
    timeout: HARNESS_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    proc.signal, null,
    `the harness was killed by ${proc.signal} rather than exiting. stderr:\n${proc.stderr}`,
  );
  assert.notEqual(proc.status, 70, `the harness threw:\n${proc.stderr}`);

  const printedLine = proc.stdout.split(/\r?\n/).filter((l) => l.startsWith('{')).pop();
  assert.ok(printedLine !== undefined, `the harness printed no object. stderr:\n${proc.stderr}`);
  const printed = JSON.parse(printedLine);

  const events = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

  return {
    status: proc.status,
    stdout: proc.stdout,
    stderr: proc.stderr,
    summary: printed.summary,
    counts: printed.summary.post_land_counts,
    events,
    root,
  };
}

/** A land seam that reports a real successful land, exactly as exit 0 does. */
const GREEN_LAND = { code: 0, verdict: 'green', result: 'landed' };

/** The `post_land_truth` classifications on disk, counted independently. */
function truthsOf(events, runId) {
  return events
    .filter((e) => e.kind === 'post_land_truth' && e.run_id === runId)
    .map((e) => e.classification);
}

// The 5 runs every arm below reads. They are computed once because each one is a
// whole fleet, and re running them per assertion would buy nothing.
const RUNS = {};

test.before(() => {
  const gate = path.join(scratch('gate'), 'gate.cjs');
  fs.writeFileSync(gate, GATE_SOURCE);

  RUNS.bare = runFleet('bare', { land: GREEN_LAND });
  RUNS.held = runFleet('held', {
    land: GREEN_LAND, verifyArgs: [process.execPath, gate, '0'],
  });
  RUNS.falseGreen = runFleet('falsegreen', {
    land: GREEN_LAND, verifyArgs: [process.execPath, gate, '3'],
  });
  RUNS.unspawnable = runFleet('unspawnable', {
    land: GREEN_LAND,
    verifyArgs: [path.join(RUNS.bare.root, 'no-such-gate-anywhere'), '0'],
  });
  // A land that ABORTED. `defaultLandCommand` at src/fleet-landqueue.cts:862
  // writes exactly this shape on a non zero exit, so the family carries a suffix
  // and an equality test against a literal would miss it entirely. The park
  // ceiling bounds the arm: a node whose land never succeeds is otherwise ready
  // on every pass forever.
  RUNS.aborted = runFleet('aborted', {
    land: { code: 3, verdict: 'red', result: 'aborted:exit-3' },
    verifyArgs: [process.execPath, gate, '0'],
    extraArgs: ['--park-after-attempts=1'],
  });
});

// ══ the required failing arm: the run that wires NOTHING ═════════════════════

test('WITHOUT a verifier the decided count is 0 against a NON ZERO landed count', () => {
  const r = RUNS.bare;

  // NON ZERO FIRST, AND THE ORDER IS THE POINT. Every property below is
  // VACUOUSLY TRUE over an empty set, so a run that landed nothing would satisfy
  // all of them while proving nothing at all.
  assert.ok(r.counts.landed > 0, 'the run landed nothing, so every count below is vacuous');
  assert.equal(r.counts.landed, NODE_COUNT);

  // This is FF-B272 exactly: a complete set of truths, every one of them the
  // literal `unknown`, and therefore 0 DECIDED classifications.
  assert.equal(r.counts.decided, 0);
  assert.equal(r.counts.undecided, r.counts.landed);
  const truths = truthsOf(r.events, 'run-bare');
  assert.equal(truths.length, NODE_COUNT, 'the run emitted no post_land_truth at all');
  assert.deepEqual([...new Set(truths)], ['unknown']);
});

// ══ the positive arm: a gate that still passes after the land ════════════════

test('WITH a verifier whose gate exits 0 every landed increment is HELD', () => {
  const r = RUNS.held;

  assert.ok(r.counts.landed > 0, 'the run landed nothing, so every count below is vacuous');
  assert.equal(r.counts.decided, r.counts.landed);
  assert.equal(r.counts.undecided, 0);

  const truths = truthsOf(r.events, 'run-held');
  assert.equal(truths.length, NODE_COUNT);
  assert.deepEqual([...new Set(truths)], ['held']);

  // AND IT IS A COUNTER RATHER THAN A FLAG. A boolean is satisfied by a verifier
  // that was wired and never called.
  assert.equal(r.counts.decided, NODE_COUNT);
});

// ══ the false green arm: the point of the whole criterion ════════════════════

test('a gate that FAILS after the land is false_green, and the shipped fold reports a RATE', () => {
  const r = RUNS.falseGreen;

  assert.ok(r.counts.landed > 0, 'the run landed nothing, so every count below is vacuous');
  assert.equal(r.counts.decided, r.counts.landed);
  const truths = truthsOf(r.events, 'run-falsegreen');
  assert.equal(truths.length, NODE_COUNT);
  assert.deepEqual([...new Set(truths)], ['false_green']);

  // THE SHIPPED FOLD, NOT A LOCAL REIMPLEMENTATION. Phase 22 built it and 2
  // rounds of review converged on it; a second opinion here would be the one that
  // disagrees.
  const rate = proofFold.foldFalseGreenRate(r.events);
  assert.equal(rate.state, proofFold.METRIC_STATES.KNOWN);
  assert.equal(rate.value, 1);

  // AND THE DISCRIMINATOR. The identical run reports UNDEFINED today, because
  // nothing wired the verifier. This assertion is what separates a measured rate
  // from the absence of one, and the state names are READ from the shipped
  // vocabulary rather than transcribed: there are 3 of them and `undefined` is
  // not `unknown`.
  assert.notEqual(rate.state, proofFold.METRIC_STATES.UNDEFINED);
});

test('the no verifier record and the all held record fold to DIFFERENT results', () => {
  // Plan 22-04 made these 2 distinguishable AT THE READER. This arm proves the
  // PRODUCER can now reach the second of them, which is the half that was
  // missing: before this plan every real run produced only the first.
  const bare = proofFold.foldFalseGreenRate(RUNS.bare.events);
  const held = proofFold.foldFalseGreenRate(RUNS.held.events);

  assert.notDeepEqual(bare, held);
  // UNDEFINED with a null value against KNOWN with a value of 0. Those 2 are the
  // whole point: a fabricated 0 clearing the POSITIVE threshold is what phase 22
  // repaired at the reader, and this arm shows the producer reaching the other
  // side of that repair for the first time.
  assert.equal(bare.state, proofFold.METRIC_STATES.UNDEFINED);
  assert.equal(bare.value, null);
  assert.equal(held.state, proofFold.METRIC_STATES.KNOWN);
  assert.equal(held.value, 0);
  assert.notEqual(bare.state, held.state);
});

// ══ a verifier that could not run has verified NOTHING ═══════════════════════

test('a gate that cannot be SPAWNED is unknown and undecided, and is NOT held', () => {
  const r = RUNS.unspawnable;

  assert.ok(r.counts.landed > 0, 'the run landed nothing, so every count below is vacuous');
  assert.equal(r.counts.decided, 0);
  assert.equal(r.counts.undecided, r.counts.landed);

  const truths = truthsOf(r.events, 'run-unspawnable');
  assert.equal(truths.length, NODE_COUNT);
  assert.deepEqual([...new Set(truths)], ['unknown']);
  // THE FABRICATED PASS, NAMED. Reporting `held` for a gate that never ran is the
  // exact shape of defect this phase exists to stop.
  assert.ok(!truths.includes('held'), 'a gate that never ran was reported held');
});

// ══ a land that did not land is not an increment to classify ═════════════════

test('a land in an ABORTED family raises no decided count', () => {
  const r = RUNS.aborted;

  // WORK HAPPENED. A guard proving "no damage" that cannot also prove the run
  // ran is satisfied by a run that did nothing.
  const truths = truthsOf(r.events, 'run-aborted');
  assert.ok(truths.length > 0, 'the run reached no land at all, so the arm is vacuous');

  const results = r.events
    .filter((e) => e.kind === 'land_completed' && e.run_id === 'run-aborted')
    .map((e) => e.result);
  assert.ok(results.length > 0);
  assert.ok(results.every((v) => v.startsWith('aborted')), `results were ${JSON.stringify(results)}`);

  // The verifier was WIRED on this run, so a decided count of 0 here is the
  // family test refusing rather than an absent verifier.
  assert.equal(r.counts.landed, 0);
  assert.equal(r.counts.decided, 0);
  assert.equal(r.counts.undecided, truths.length);
  assert.deepEqual([...new Set(truths)], ['unknown']);
});

// ══ D8a: the warning is driven over a world where it is FALSE ════════════════

test('the absence warning fires on a run that wired NOTHING', () => {
  assert.match(RUNS.bare.stderr, /wired NO post land verifier/);
  assert.match(RUNS.bare.stderr, /--verify-post-land/);
});

test('D8a: the absence warning is ABSENT on a run that DID wire a verifier', () => {
  // A MUTATION BATTERY CANNOT DETECT A FALSE SENTENCE (D8a, FF-B284). Phase 22's
  // fourth defect survived 25 mutants because it was PROSE: true on the day it
  // was written and emitted word for word when false. Reading the sentence is
  // not enough, so it is rendered over an input CONTRADICTING it.
  assert.doesNotMatch(RUNS.held.stderr, /wired NO post land verifier/);
  assert.doesNotMatch(RUNS.held.stdout, /wired NO post land verifier/);
  // And the arm above is not vacuous: the same text IS produced somewhere.
  assert.match(RUNS.bare.stderr, /wired NO post land verifier/);
});

// ══ the counter is DERIVED, and it is checked against the log it claims ══════

test('the printed counter agrees with an INDEPENDENT count read from the log', (t) => {
  for (const [label, runId] of [
    ['bare', 'run-bare'], ['held', 'run-held'], ['falseGreen', 'run-falsegreen'],
    ['unspawnable', 'run-unspawnable'], ['aborted', 'run-aborted'],
  ]) {
    const r = RUNS[label];
    const truths = truthsOf(r.events, runId);
    const decided = truths.filter((c) => proofFold.DECIDED_CLASSIFICATIONS.includes(c)).length;
    const undecided = truths.length - decided;
    const landed = new Set(
      r.events
        .filter((e) => e.kind === 'land_completed' && e.run_id === runId
          && proofFold.LAND_RESULTS_LANDED.includes(String(e.result).split(':')[0]))
        .map((e) => JSON.stringify([e.node_id, e.attempt_id])),
    ).size;

    assert.equal(r.counts.decided, decided, `${label}: decided drifted from the log`);
    assert.equal(r.counts.undecided, undecided, `${label}: undecided drifted from the log`);
    assert.equal(r.counts.landed, landed, `${label}: landed drifted from the log`);

    // The observed numbers, on the record, so the counter is legible in the TAP
    // output rather than only inside an assertion that passed silently.
    const rate = proofFold.foldFalseGreenRate(r.events);
    t.diagnostic(
      `${label}: decided=${r.counts.decided} undecided=${r.counts.undecided} `
        + `landed=${r.counts.landed} false_green_rate=${rate.state}:${rate.value}`,
    );
  }
});

test('the counts are NUMBERS and the decided total is non zero somewhere', () => {
  // A flag would satisfy every equality above on the arms where the expected
  // value happens to be truthy. These 2 assertions are what a boolean cannot pass.
  assert.equal(typeof RUNS.held.counts.decided, 'number');
  assert.equal(RUNS.held.counts.decided + RUNS.falseGreen.counts.decided, NODE_COUNT * 2);
});
