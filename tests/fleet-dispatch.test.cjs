'use strict';

/**
 * THE DISPATCH MANIFEST CONSUMER, PROVED BY SPAWNING PROCESSES. Phase 21, FF-B379.
 *
 * `scripts/fleet-dispatch.cjs` reads the dispatch manifest that
 * `src/claude-orchestration.cts` emits and dispatches the wave through the shipped
 * fleet driver. Every arm below runs that script AS A CHILD PROCESS, the way a
 * person runs it, because the claim being made is about operating system processes
 * and an in-process arm cannot witness one.
 *
 * ─── THE ONE ARM THAT ACTUALLY CLOSES FF-B379 ────────────────────────────────
 *
 * `a wave of 3 dispatches 3 REAL worker processes` asserts an INTEGER COUNT of
 * observed worker spawns, greater than 1, and it asserts the count is non zero
 * before asserting any property over it. A flag saying "dispatched" is satisfied
 * by an implementation that reports a dispatch and spawns nothing, so no arm here
 * accepts one. The count is read off the run log the driver wrote, and it is
 * corroborated by marker files the worker processes themselves wrote, so an
 * implementation that logged 3 spawns without starting 3 processes fails too.
 *
 * ─── AND THE ONE THAT STOPS IT BEING A LIE ───────────────────────────────────
 *
 * `3 workers at capacity 1 is NOT a fleet run` drives the SAME fixture with the
 * same 3 nodes and a capacity of 1. It observes the same 3 spawns and refuses the
 * fleet claim, because the 3 workers never ran at the same time. That is the arm
 * that makes the word fleet mean something: a spawn total cannot tell a fan out
 * from a queue, and the first cut of this consumer classified on the total alone.
 *
 * ─── ZERO AGENT SPEND, AS A MECHANISM ────────────────────────────────────────
 *
 * FF-B338. The fourth precondition probes `fleet.adapters` BY SPAWNING EVERY
 * ADAPTER IN IT with a real prompt, and this repository declares a live roster of
 * 3 paid vendors (`claude`, `codex`, `gemini`). A dispatch arm that reached the
 * real preflight would therefore buy its answer on 3 accounts, per invocation.
 *
 * Two mechanisms, because either alone is a comment:
 *
 *   1. Every arm runs under an EXPLICITLY EMPTY roster supplied by this file
 *      through `FERROX_PROJECT`, the same fixture mechanism
 *      `tests/fleet-loop-cli.test.cjs` established for the same reason.
 *   2. `runCli` REFUSES TO SPAWN if the roster either the repository root or the
 *      arm's own project root would resolve is not empty. So an ordering
 *      regression, a rename, or a change to the config precedence walk stops the
 *      suite rather than being paid for.
 *
 * The dispatching arms additionally replace the preflight outright with a proof
 * harness, so no adapter binary is reachable even in principle. `no arm can reach
 * a paid adapter` asserts that property over this file's own source.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DISPATCH_CLI = path.join(REPO_ROOT, 'scripts', 'fleet-dispatch.cjs');
const DISPATCH_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-dispatch-plan.cjs');

const orchestration = require('../ferrox-core/bin/lib/claude-orchestration.cjs');
const workgraphScan = require('../ferrox-core/bin/lib/workgraph-scan.cjs');
const dispatchLib = require('../ferrox-core/bin/lib/fleet-dispatch-plan.cjs');
const loop = require('../scripts/fleet-loop.cjs');

const { DISPATCH_OUTCOMES, FLEET_DISPATCH_ERROR_CODES, FLEET_MINIMUM_WORKERS } = dispatchLib;
const { DISPATCH_CLI_CODES } = require('../scripts/fleet-dispatch.cjs');

/** The exit code a refusal carries. Distinct from 1, which is any other unhappy end. */
const REFUSAL_EXIT = 2;

/**
 * The ceiling on 1 CLI invocation, ms. A MECHANISM and not a comment: an arm whose
 * failure mode is a hang has no verdict.
 */
const CLI_TIMEOUT_MS = 120000;

/** How long a stub worker stays alive, ms. Long enough that 3 of them overlap. */
const WORKER_ALIVE_MS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// THE ZERO SPEND FIXTURE. Copied from tests/fleet-loop-cli.test.cjs, deliberately.
// ─────────────────────────────────────────────────────────────────────────────

const ADAPTER_FIXTURE_PROJECT = 'fleet-dispatch-adapter-fixture';
const ADAPTER_FIXTURE_DIR = path.join(REPO_ROOT, '.planning', ADAPTER_FIXTURE_PROJECT);

/** The roster the fixture declares. Empty, and explicitly so. */
const FIXTURE_ROSTER = [];

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-dispatch-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.before(() => {
  fs.mkdirSync(ADAPTER_FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ADAPTER_FIXTURE_DIR, 'config.json'),
    `${JSON.stringify({ fleet: { adapters: FIXTURE_ROSTER } }, null, 2)}\n`,
  );
});

test.after(() => {
  try {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
    fs.rmSync(ADAPTER_FIXTURE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* best effort */ }
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

/**
 * The roster the CHILD would resolve at a given root, read through the SAME
 * precedence walk the child reads it through, without spawning anything.
 *
 * The shipped resolver rather than a re-read of the fixture file, because what
 * matters is not what this file wrote, it is what `readAdapterRoster` will find.
 */
function rosterTheChildWouldSee(cwd) {
  const ca = require('../ferrox-core/bin/lib/capability-activation.cjs');
  let registry = {};
  try { registry = require('../ferrox-core/bin/lib/capability-registry.cjs'); } catch { /* absent */ }
  return asTheChildSees(() => {
    const resolved = ca.resolveConfigKey('fleet.adapters', { config: {}, cwd, registry });
    return Array.isArray(resolved.value) ? resolved.value : null;
  });
}

/**
 * Run a function under the SAME `FERROX_PROJECT` the child runs under.
 *
 * That variable does 2 things, and this file needs both to agree. It redirects the
 * config precedence walk, which is what supplies the empty roster, AND it
 * redirects the planning root to `.planning/<project>/`, which is where the child
 * will look for a phase directory. An in-process assertion made without it would
 * be describing a different tree than the one the arm dispatches against.
 */
function asTheChildSees(fn) {
  const saved = process.env.FERROX_PROJECT;
  process.env.FERROX_PROJECT = ADAPTER_FIXTURE_PROJECT;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.FERROX_PROJECT;
    else process.env.FERROX_PROJECT = saved;
  }
}

/**
 * Run the consumer as a person would, and return what the process actually did.
 *
 * ─── THE ZERO SPEND GUARD, AND WHY IT IS A MECHANISM ─────────────────────────
 *
 * A non empty roster makes the fourth precondition SPAWN EVERY ADAPTER IN IT with
 * a real prompt, which is real money on 3 vendors. This repository DOES declare
 * such a roster. So the roster is checked BEFORE THE SPAWN, at both roots the
 * child could resolve it from, and a surprise refuses to run rather than being
 * paid for. A comment cannot hold this property; this can.
 */
function runCli(args, opts = {}) {
  const projectRoot = typeof opts.projectRoot === 'string' ? opts.projectRoot : REPO_ROOT;
  for (const [label, cwd] of [['the repository root', REPO_ROOT], ["the arm's project root", projectRoot]]) {
    const roster = rosterTheChildWouldSee(cwd);
    assert.deepEqual(
      roster, FIXTURE_ROSTER,
      `REFUSING TO SPAWN. The adapter fixture no longer resolves to an empty roster at ${label}, `
        + `so this spawn could probe ${JSON.stringify(roster)} by invoking each one as a real, `
        + `paid model call. Repair ${ADAPTER_FIXTURE_DIR}/config.json rather than letting the `
        + 'suite dispatch.',
    );
  }

  const result = spawnSync(process.execPath, [DISPATCH_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: { ...process.env, FERROX_PROJECT: ADAPTER_FIXTURE_PROJECT },
    // An inherited stdin would let a regression block on a prompt instead of failing.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    result.signal, null,
    `the CLI was killed by ${result.signal} rather than exiting. stderr was:\n${result.stderr}`,
  );
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { json = null; }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FIXTURE : a project, a manifest, and a harness whose workers are real.
// ─────────────────────────────────────────────────────────────────────────────

const PHASE = '90';

/**
 * A project whose work graph carries `plans.length` INDEPENDENT nodes, and a
 * manifest emitted from the SAME model by the SHIPPED emitter.
 *
 * The manifest is never hand written. `emitFleetManifest` partitions through
 * `partitionStages`, and a hand written manifest would let this file assert a
 * partition the producer does not actually make, which is a test proving its own
 * fixture.
 */
function project(label, opts = {}) {
  const plans = opts.plans ?? ['01', '02', '03'];
  const failing = new Set(opts.failing ?? []);
  const root = scratch(label);
  // The planning base the CHILD resolves, which `FERROX_PROJECT` moves under
  // `.planning/<project>/`. Writing the phase anywhere else would build a fixture
  // the arm cannot reach.
  const planningBase = path.join(root, '.planning', ADAPTER_FIXTURE_PROJECT);
  const phaseDir = path.join(planningBase, 'phases', `${PHASE}-proof`);
  fs.mkdirSync(phaseDir, { recursive: true });
  // The arm's OWN empty roster, declared rather than merely absent. The guard in
  // `runCli` reads this root too, and a roster that is empty because no file
  // exists proves nothing about a root that later grows one.
  fs.writeFileSync(
    path.join(planningBase, 'config.json'),
    `${JSON.stringify({ fleet: { adapters: FIXTURE_ROSTER } }, null, 2)}\n`,
  );

  for (const p of plans) {
    fs.writeFileSync(path.join(phaseDir, `${PHASE}-${p}-PLAN.md`), [
      '---',
      `phase: ${PHASE}-proof`,
      `plan: ${p}`,
      'type: execute',
      'wave: 1',
      'depends_on: []',
      'files_modified:',
      `  - src/lane-${p}.cts`,
      'autonomous: true',
      '---',
      '',
      '<tasks>',
      '<task type="auto">',
      `  <name>lane ${p}</name>`,
      '</task>',
      '</tasks>',
      '',
    ].join('\n'));
  }

  const emitted = orchestration.emitFleetManifest({
    phaseDir,
    runId: `${label}-run`,
    waves: [{
      id: 'w1',
      plans: plans.map((p) => ({
        id: `${PHASE}-${p}`,
        brief: `lane ${p}`,
        files_modified: [`src/lane-${p}.cts`],
      })),
    }],
  });
  assert.equal(emitted.ok, true, `the shipped emitter produced a manifest: ${emitted.reason ?? ''}`);

  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(emitted, null, 2)}\n`);

  // ── the worker: a REAL script run as a REAL child process ──
  //
  // It writes a marker on start and another on exit, so the spawn count the
  // consumer folds out of the log can be corroborated against processes that
  // demonstrably ran. It names no agent CLI and reaches no network.
  const markerDir = path.join(root, 'markers');
  const workerScript = path.join(root, 'stub-worker.cjs');
  fs.writeFileSync(workerScript, `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [dir, nodeId, shouldFail] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const safe = nodeId.replace(/[^A-Za-z0-9_.-]/g, '_');
let round = 0;
try { round = Number(fs.readFileSync(path.join(dir, 'rounds-' + safe), 'utf8')) || 0; } catch { round = 0; }
round += 1;
fs.writeFileSync(path.join(dir, 'rounds-' + safe), String(round));
fs.writeFileSync(path.join(dir, 'start-' + safe + '-' + round), String(Date.now()));
setTimeout(() => {
  fs.writeFileSync(path.join(dir, 'end-' + safe + '-' + round), String(Date.now()));
  if (shouldFail === 'fail') process.exit(1);
}, ${WORKER_ALIVE_MS});
`);

  const harnessPath = path.join(root, 'harness.cjs');
  fs.writeFileSync(harnessPath, `'use strict';
const { spawn } = require('node:child_process');
const CHECK_NAMES = ${JSON.stringify([...loop.CHECK_NAMES])};
const FAILING = ${JSON.stringify([...failing])};
module.exports = {
  runPreflight: async () => ({
    checks: CHECK_NAMES.map((name) => ({ name, ok: true, observed: {}, refused_because: null })),
    check_names: CHECK_NAMES,
    dispatch_allowed: ${opts.refusePreflight === true ? 'false' : 'true'},
  }),
  ensureControlPlane: ({ nodes }) => {
    const cards = {};
    for (const n of nodes) cards[n] = { work_id: 'work-' + n, worktree: ${JSON.stringify(root)} };
    return { cards, home: ${JSON.stringify(path.join(root, 'ratchet-home'))}, created: [...nodes] };
  },
  spawnWorker: (ctx) => {
    ${opts.throwOnSpawn === true ? "throw new Error('the harness worker seam refused to spawn');" : ''}
    return spawn(process.execPath, [
      ${JSON.stringify(workerScript)},
      ${JSON.stringify(markerDir)},
      String(ctx.nodeId),
      FAILING.indexOf(String(ctx.nodeId)) === -1 ? 'pass' : 'fail',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  },
  landCommand: () => ({ code: 0, verdict: 'green', result: 'landed' }),
};
`);

  return {
    label,
    root,
    phaseDir,
    manifestPath,
    harnessPath,
    markerDir,
    nodeIds: plans.map((p) => `${PHASE}-${p}`),
    emitted,
    /** Every marker the worker processes wrote, sorted. */
    markers() {
      try { return fs.readdirSync(markerDir).sort(); } catch { return []; }
    },
    /** How many worker processes genuinely STARTED, counted on the filesystem. */
    startsOnDisk() {
      return this.markers().filter((m) => m.startsWith('start-')).length;
    },
    /** Every event in a run log this project wrote. */
    events(logName = 'run.jsonl') {
      const p = path.join(root, logName);
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, 'utf8').split(/\r?\n/)
        .filter((l) => l.trim() !== '')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((e) => e !== null);
    },
    log(logName = 'run.jsonl') {
      return path.join(root, logName);
    },
  };
}

/** Rewrite a project's manifest through a mutator, for the malformed arms. */
function rewriteManifest(proj, mutate, name = 'manifest.json') {
  const doc = JSON.parse(fs.readFileSync(proj.manifestPath, 'utf8'));
  mutate(doc);
  const p = path.join(proj.root, name);
  fs.writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);
  return p;
}

/** Dispatch a project through the harness and hand back everything observed. */
function dispatch(proj, extra = [], logName = 'run.jsonl') {
  return runCli([
    '--manifest', proj.manifestPath,
    '--project-root', proj.root,
    '--proof-harness', proj.harnessPath,
    '--log', proj.log(logName),
    '--json',
    ...extra,
  ], { projectRoot: proj.root });
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FIXTURE ITSELF, asserted before anything is asserted THROUGH it.
// ─────────────────────────────────────────────────────────────────────────────

test('the fixture builds a real 3 node graph and the shipped emitter puts all 3 in 1 stage', () => {
  const proj = project('fixture');
  const built = asTheChildSees(() => workgraphScan.buildWorkgraph({ cwd: proj.root, phase: PHASE }));
  assert.equal(built.ok, true, `the work graph was genuinely built: ${built.message ?? ''}`);
  const ids = built.document.nodes.map((n) => String(n.id)).sort();
  assert.deepEqual(ids, ['90-01', '90-02', '90-03'], 'the graph carries the 3 declared nodes');

  // 1 stage of 3 is what makes a width of 3 POSSIBLE. If the shipped partitioner
  // ever split these, the headline arm would be asserting a fleet the manifest
  // never described, so this is checked rather than assumed.
  assert.deepEqual(proj.emitted.summary.stagesByWave, [[['90-01', '90-02', '90-03']]],
    'the shipped partitioner puts 3 disjoint lanes in 1 stage');
  assert.equal(proj.emitted.manifest.kind, orchestration.FLEET_MANIFEST_KIND);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ARM THAT CLOSES FF-B379.
// ─────────────────────────────────────────────────────────────────────────────

test('a wave of 3 dispatches 3 REAL worker processes, counted, and MORE THAN 1', () => {
  const proj = project('fleet');
  const r = dispatch(proj);

  assert.equal(r.status, 0, `the dispatch succeeded. stderr:\n${r.stderr}`);
  assert.notEqual(r.json, null, 'the consumer emitted a JSON payload');

  // ── THE COUNT. Non zero FIRST, then integer, then greater than 1. ──
  //
  // The order is the whole discipline. `> 1` over an undefined is false in a way
  // that reads like a passing assertion in reverse, and a count that arrived as a
  // string would satisfy a loose comparison. So the value is proved to exist and
  // to be a whole number before any property over it is asserted.
  const spawns = r.json.observed.observed_spawns;
  assert.notEqual(spawns, undefined, 'the payload carries an observed spawn count');
  assert.equal(typeof spawns, 'number', 'the spawn count is a number, not a flag or a string');
  assert.ok(Number.isInteger(spawns), 'the spawn count is a whole number');
  assert.ok(spawns > 0, `the spawn count is NON ZERO before anything is claimed over it, got ${spawns}`);
  assert.ok(spawns > 1, `MORE THAN 1 worker process was observed starting, got ${spawns}`);
  assert.equal(spawns, 3, `all 3 nodes were dispatched, got ${spawns}`);

  const nodes = r.json.observed.distinct_nodes;
  assert.equal(typeof nodes, 'number');
  assert.ok(nodes > 0, `the distinct node count is non zero, got ${nodes}`);
  assert.equal(nodes, 3, 'the 3 spawns covered 3 distinct nodes, so this is a fan out and not a retry');
  assert.deepEqual(r.json.observed.node_ids, ['90-01', '90-02', '90-03']);

  // ── THE WIDTH. What makes it a fleet rather than a queue. ──
  const width = r.json.observed.demonstrated_width;
  assert.equal(typeof width.value, 'number');
  assert.ok(width.value > 0, `the demonstrated width is non zero, got ${width.value}`);
  assert.ok(width.value > 1,
    `MORE THAN 1 worker was alive AT THE SAME TIME, got ${width.value}`);
  assert.equal(width.exact, true, 'the width was folded from closed intervals only');

  assert.equal(r.json.verdict.outcome, DISPATCH_OUTCOMES.DISPATCHED_FLEET);
  assert.equal(r.json.verdict.fleet, true);
  assert.match(r.stderr, /fleet dispatch: dispatched_fleet \| fleet run: yes \| workers observed: 3/);

  // ── CORROBORATION. The log is not the only witness. ──
  //
  // An implementation that appended 3 `worker_started` events and spawned nothing
  // satisfies every assertion above. These do not: the markers were written by the
  // worker processes themselves, from inside their own address space.
  assert.equal(proj.startsOnDisk(), 3,
    `3 worker processes wrote their own start marker, saw ${JSON.stringify(proj.markers())}`);
  for (const id of proj.nodeIds) {
    assert.ok(proj.markers().includes(`end-${id}-1`), `${id} ran to completion in its own process`);
  }

  // And the log itself, read off disk rather than out of the payload.
  const started = proj.events().filter((e) => e.kind === 'worker_started');
  assert.equal(started.length, 3, 'the run log on disk carries 3 worker_started events');
  assert.equal(new Set(started.map((e) => e.node_id)).size, 3);

  // The run finished the graph rather than stopping on a bound.
  assert.equal(r.json.stopped_by, 'drained');
  assert.deepEqual(r.json.parked, []);
});

test('the FF-B379 sentence is gone from the consumer path, and no path claims a fleet it did not run', () => {
  const proj = project('nosentence');
  const r = dispatch(proj);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /dispatch consumer not built/,
    'the retired sentence is gone, because a consumer now exists and dispatched');
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /FF-B379/,
    'the closed backlog id is not printed by a path that genuinely dispatched');
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ARMS THAT STOP THE COUNT BEING A LIE.
// ─────────────────────────────────────────────────────────────────────────────

test('3 workers at capacity 1 is NOT a fleet run, and says exactly that', () => {
  const proj = project('sequential');
  const r = dispatch(proj, ['--capacity', '1']);

  // The SAME 3 spawns on the SAME 3 nodes. Nothing about the total changed.
  assert.equal(r.json.observed.observed_spawns, 3);
  assert.equal(r.json.observed.distinct_nodes, 3);
  assert.equal(proj.startsOnDisk(), 3, '3 real processes still ran');

  // What changed is the only thing that decides the claim.
  assert.equal(r.json.observed.demonstrated_width.value, 1,
    'never more than 1 worker was alive at a time');
  assert.equal(r.json.verdict.outcome, DISPATCH_OUTCOMES.DISPATCHED_SEQUENTIALLY);
  assert.equal(r.json.verdict.fleet, false,
    'a run that started 3 workers one after another is a queue, not a fleet');
  assert.notEqual(r.status, 0, 'a run that is not a fleet run does not exit 0');
  assert.match(r.stderr, /this run is NOT reported as a fleet run/);
  assert.match(r.stderr, /a spawn total is not a width/);
});

test('a capacity of 1 is announced BEFORE the run rather than explained after it', () => {
  const proj = project('narrow', { plans: ['01'] });
  const r = dispatch(proj);
  assert.match(r.stderr, /the resolved capacity is 1/);
  assert.match(r.stderr, /This will NOT be a fleet run/);
  assert.equal(r.json.verdict.outcome, DISPATCH_OUTCOMES.DISPATCHED_SINGLE_WORKER);
  assert.equal(r.json.verdict.fleet, false);
  assert.equal(r.json.observed.observed_spawns, 1,
    'exactly 1 worker was observed, which is the count the refusal is derived from');
  assert.notEqual(r.status, 0);
});

test('a refused preflight spawns nothing and is never described as a fleet', () => {
  const proj = project('refused', { refusePreflight: true });
  const r = dispatch(proj);

  assert.equal(r.json.verdict.outcome, DISPATCH_OUTCOMES.PREFLIGHT_REFUSED);
  assert.equal(r.json.verdict.fleet, false);
  assert.equal(r.json.verdict.counters.observed_spawns, 0,
    'a refused preflight observed 0 spawns, asserted rather than assumed');
  assert.equal(proj.startsOnDisk(), 0, 'no worker process was started');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dispatch REFUSED/);
});

test('a worker seam that cannot spawn is a NAMED driver failure, never a quiet 0', () => {
  const proj = project('spawnthrow', { throwOnSpawn: true });
  const r = dispatch(proj);
  assert.equal(r.json.verdict.outcome, DISPATCH_OUTCOMES.DRIVER_FAILED);
  assert.equal(r.json.verdict.fleet, false);
  assert.match(r.json.verdict.reason, /the harness worker seam refused to spawn/,
    'the driver failure carries the reason the seam gave, not a shrug');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the driver failed/);
});

test('a driver that fails before naming its run counts 0, never the PREVIOUS run', () => {
  // A clean 3 worker run first, into a log this arm then reuses.
  const clean = project('priorrun');
  const first = dispatch(clean, [], 'shared.jsonl');
  assert.equal(first.json.observed.observed_spawns, 3, 'the log now holds a 3 worker run');

  // Now a run whose worker seam throws. The driver never returns a summary, so
  // there is no run id to scope the fold to. A fold that treated the absent id as
  // "no filter" would hand back the PREVIOUS run's 3 workers and report them as
  // this run's, which is a fabricated fan out on the one path where nothing ran.
  const broken = project('afterprior', { throwOnSpawn: true });
  fs.copyFileSync(clean.log('shared.jsonl'), broken.log('shared.jsonl'));
  const second = dispatch(broken, [], 'shared.jsonl');

  assert.equal(second.json.verdict.outcome, DISPATCH_OUTCOMES.DRIVER_FAILED);
  assert.equal(second.json.observed.scoped, false,
    'the consumer says it could not attribute the log to this run');
  assert.equal(second.json.observed.observed_spawns, 0,
    'a count nobody can attribute is 0, not the prior run total');
  assert.equal(second.json.observed.distinct_nodes, 0);
  assert.equal(second.json.observed.demonstrated_width.value, 0);
  assert.equal(second.json.verdict.counters.observed_spawns, 0);
  assert.equal(broken.startsOnDisk(), 0, 'and no worker process was in fact started');
});

// ─────────────────────────────────────────────────────────────────────────────
// A FAILED WORKER DOES NOT SILENTLY VANISH.
// ─────────────────────────────────────────────────────────────────────────────

test('a worker that FAILS is recorded, retried, parked, and reported. It never vanishes', () => {
  const proj = project('failing', { failing: ['90-03'] });
  const r = dispatch(proj, ['--park-after-attempts', '2']);

  const events = proj.events();
  const ended = events.filter((e) => e.kind === 'worker_ended');
  const failed = ended.filter((e) => e.outcome === 'failed');

  assert.ok(failed.length > 0,
    `the failing worker's end event is in the log, saw outcomes ${JSON.stringify(ended.map((e) => e.outcome))}`);
  assert.deepEqual([...new Set(failed.map((e) => e.node_id))], ['90-03'],
    'the failure is attributed to the node that failed and to no other');
  for (const e of failed) {
    assert.equal(e.exit_code, 1, 'the failing exit code is recorded rather than flattened');
    assert.equal(typeof e.attempt_id, 'string');
  }

  // The 2 clean nodes still finished. A failing node must not take the wave with it.
  const completed = ended.filter((e) => e.outcome === 'completed').map((e) => e.node_id);
  assert.ok(completed.includes('90-01') && completed.includes('90-02'),
    `the clean nodes completed, saw ${JSON.stringify(completed)}`);

  // The abandoned node is NAMED, in the payload and to the reader.
  assert.deepEqual(r.json.parked, ['90-03'], 'the abandoned node is named in the payload');
  assert.notEqual(r.status, 0, 'a run that abandoned work does not exit 0');
  assert.match(r.stderr, /parked node\(s\)/);
  assert.match(r.stderr, /90-03/);

  // And the spawn count includes the retries, so the record describes the work
  // that was actually attempted rather than the work that was planned.
  assert.ok(r.json.observed.observed_spawns > proj.nodeIds.length,
    `the retries are counted, got ${r.json.observed.observed_spawns} spawns over ${proj.nodeIds.length} nodes`);
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATE BEFORE SIDE EFFECTS : refusals by name, and nothing dispatched.
// ─────────────────────────────────────────────────────────────────────────────

test('OVERLAPPING WRITE LANES NEVER DISPATCH, and the refusal names both plans and the file', () => {
  const proj = project('overlap');
  // 2 plans in 1 STAGE both declaring 1 file. The shipped partitioner never emits
  // this, which is exactly why the consumer must re-verify: a manifest is a file,
  // and a file can be edited, hand assembled, or written by an older emitter.
  const bad = rewriteManifest(proj, (doc) => {
    doc.manifest.waves[0].stages[0].plans[1].files_modified = ['src/lane-01.cts'];
  }, 'overlapping.json');

  const r = runCli([
    '--manifest', bad, '--project-root', proj.root, '--proof-harness', proj.harnessPath,
    '--log', proj.log('overlap.jsonl'), '--json',
  ], { projectRoot: proj.root });

  assert.equal(r.status, REFUSAL_EXIT, `an overlapping manifest refuses. stderr:\n${r.stderr}`);
  assert.match(r.stderr, new RegExp(FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_OVERLAPPING_LANES));
  assert.match(r.stderr, /"90-01" and "90-02"/, 'both colliding plans are named');
  assert.match(r.stderr, /"src\/lane-01\.cts"/, 'the contested file is named');
  assert.match(r.stderr, /2 worker processes on 1 file/);

  // THE PROPERTY THAT MATTERS. 2 workers editing 1 file is the damage, so the
  // refusal must happen before ANY worker exists, not after.
  assert.equal(proj.startsOnDisk(), 0, 'NOT ONE worker process was started');
  assert.equal(fs.existsSync(proj.log('overlap.jsonl')), false,
    'no run log was written, so the driver was never reached');
  assert.equal(r.stdout.trim(), '', 'nothing was reported, because nothing happened');
});

test('an ABSENT manifest refuses by name and dispatches nothing', () => {
  const proj = project('absent');
  const r = runCli([
    '--manifest', path.join(proj.root, 'no-such-file.json'),
    '--project-root', proj.root, '--proof-harness', proj.harnessPath,
  ], { projectRoot: proj.root });
  assert.equal(r.status, REFUSAL_EXIT);
  assert.match(r.stderr, /could not be read/);
  assert.equal(proj.startsOnDisk(), 0);
});

test('a manifest flag with no manifest refuses and names how to make one', () => {
  const r = runCli([]);
  assert.equal(r.status, REFUSAL_EXIT);
  assert.match(r.stderr, /needs a dispatch manifest and none was given/);
  assert.match(r.stderr, /emit-workflow/, 'the refusal names the command that produces one');
});

test('a MALFORMED manifest refuses by name for each way it can be malformed', () => {
  const proj = project('malformed');
  const cases = [
    {
      name: 'not JSON at all',
      write: () => {
        const p = path.join(proj.root, 'not-json.json');
        fs.writeFileSync(p, 'this is not a manifest\n');
        return p;
      },
      expect: /is not JSON/,
    },
    {
      name: 'an array rather than an object',
      write: () => {
        const p = path.join(proj.root, 'array.json');
        fs.writeFileSync(p, '[]\n');
        return p;
      },
      expect: new RegExp(FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_MANIFEST_MALFORMED),
    },
    {
      name: 'some other kind',
      write: () => rewriteManifest(proj, (d) => { d.manifest.kind = 'something.else/v9'; }, 'wrongkind.json'),
      expect: new RegExp(FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_KIND_MISMATCH),
    },
    {
      name: 'no kind at all, which must never read as a wildcard',
      write: () => rewriteManifest(proj, (d) => { delete d.manifest.kind; }, 'nokind.json'),
      expect: new RegExp(FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_KIND_MISMATCH),
    },
    {
      name: 'no waves',
      write: () => rewriteManifest(proj, (d) => { d.manifest.waves = []; }, 'nowaves.json'),
      expect: new RegExp(FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_NO_WAVES),
    },
    {
      name: 'an UNDECLARED write lane, which cannot be checked for overlap',
      write: () => rewriteManifest(proj, (d) => {
        delete d.manifest.waves[0].stages[0].plans[0].files_modified;
      }, 'nofiles.json'),
      expect: new RegExp(FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_BAD_PLAN),
    },
    {
      name: '1 node id in 2 places',
      write: () => rewriteManifest(proj, (d) => {
        const stage = d.manifest.waves[0].stages[0];
        stage.plans[1].id = stage.plans[0].id;
        stage.plans[1].files_modified = ['src/lane-99.cts'];
      }, 'dupe.json'),
      expect: new RegExp(FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_DUPLICATE_NODE),
    },
  ];

  for (const c of cases) {
    const p = c.write();
    const r = runCli([
      '--manifest', p, '--project-root', proj.root, '--proof-harness', proj.harnessPath,
    ], { projectRoot: proj.root });
    assert.equal(r.status, REFUSAL_EXIT, `${c.name}: refuses with the refusal code`);
    assert.match(r.stderr, c.expect, `${c.name}: refuses BY NAME`);
    assert.match(r.stderr, /Nothing was dispatched and nothing was minted/, `${c.name}: says so`);
    assert.equal(proj.startsOnDisk(), 0, `${c.name}: no worker process was started`);
  }
});

test('a manifest naming nodes the work graph does not carry refuses rather than dispatching the graph', () => {
  const proj = project('mismatch');
  const bad = rewriteManifest(proj, (d) => {
    d.manifest.waves[0].stages[0].plans[0].id = '90-77';
  }, 'mismatch.json');
  const r = runCli([
    '--manifest', bad, '--project-root', proj.root, '--proof-harness', proj.harnessPath,
  ], { projectRoot: proj.root });
  assert.equal(r.status, REFUSAL_EXIT);
  assert.match(r.stderr, new RegExp('graph_mismatch'));
  assert.match(r.stderr, /90-77/, 'the node the manifest invented is named');
  assert.match(r.stderr, /90-01/, 'the node the graph carries and the manifest forgot is named');
  assert.equal(proj.startsOnDisk(), 0);
});

test('a bound that is not a positive whole number refuses BEFORE anything is read', () => {
  const proj = project('bounds');
  for (const [flag, value] of [
    ['--capacity', 'three'], ['--capacity', '0'], ['--capacity', '-1'], ['--capacity', '2.5'],
    ['--max-passes', 'none'], ['--deadline-ms', '0'], ['--park-budget', 'x'],
  ]) {
    const r = runCli([
      '--manifest', proj.manifestPath, '--project-root', proj.root,
      '--proof-harness', proj.harnessPath, flag, value,
    ], { projectRoot: proj.root });
    assert.equal(r.status, REFUSAL_EXIT, `${flag}=${value} refuses`);
    assert.match(r.stderr, new RegExp(`\\${flag} must be a positive whole number`));
    assert.equal(proj.startsOnDisk(), 0, `${flag}=${value} started no worker`);
  }
});

test('--plan-only reconciles the manifest and dispatches NOTHING', () => {
  const proj = project('planonly');
  const r = dispatch(proj, ['--plan-only'], 'planonly.jsonl');
  assert.equal(r.status, 0);
  assert.equal(r.json.plan_only, true);
  assert.deepEqual(r.json.node_ids, ['90-01', '90-02', '90-03']);
  assert.equal(r.json.capacity, 3, 'the widest stage decided the capacity');
  assert.equal(r.json.counters.lane_conflicts, 0, 'the overlap check RAN and found nothing');
  assert.equal(r.json.reconciliation.missing_from_graph, 0);
  assert.equal(r.json.reconciliation.missing_from_manifest, 0);
  assert.match(r.stderr, /NOTHING was dispatched/);
  assert.equal(proj.startsOnDisk(), 0, 'no worker process was started');
  assert.equal(fs.existsSync(proj.log('planonly.jsonl')), false, 'no run log was written');
});

// ─────────────────────────────────────────────────────────────────────────────
// THE PROOF HARNESS IS IMPOSSIBLE TO MISTAKE FOR A PRODUCTION RUN.
// ─────────────────────────────────────────────────────────────────────────────

test('a harness run is stamped in the payload and announced twice on stderr', () => {
  const proj = project('stamped');
  const r = dispatch(proj);
  assert.notEqual(r.json.proof_harness, null, 'the payload carries the harness stamp');
  assert.equal(r.json.proof_harness.module, proj.harnessPath);
  assert.deepEqual(r.json.proof_harness.seams,
    ['runPreflight', 'ensureControlPlane', 'spawnWorker', 'landCommand']);

  const banners = r.stderr.split('PROOF HARNESS ACTIVE').length - 1;
  assert.equal(banners, 2,
    'the banner is printed before the run AND beside the verdict, so a reader who '
    + 'scrolled past the first cannot quote the number without the second');
  assert.match(r.stderr, /is not a production fleet run/);
});

test('a run with NO harness carries an explicit null stamp rather than an absent field', () => {
  const proj = project('nostamp');
  const r = runCli([
    '--manifest', proj.manifestPath, '--project-root', proj.root, '--plan-only', '--json',
  ], { projectRoot: proj.root });
  assert.equal(r.status, 0);
  assert.equal('proof_harness' in r.json, true, 'the field is present on every payload');
  assert.equal(r.json.proof_harness, null);
  assert.doesNotMatch(r.stderr, /PROOF HARNESS ACTIVE/);
});

test('a harness that replaces NOTHING refuses rather than silently running the real preflight', () => {
  const proj = project('emptyharness');
  const empty = path.join(proj.root, 'empty-harness.cjs');
  fs.writeFileSync(empty, "'use strict';\nmodule.exports = { notASeam: 1 };\n");
  const r = runCli([
    '--manifest', proj.manifestPath, '--project-root', proj.root, '--proof-harness', empty,
  ], { projectRoot: proj.root });
  assert.equal(r.status, REFUSAL_EXIT);
  assert.match(r.stderr, new RegExp('harness_empty'));
  assert.match(r.stderr, /replaces nothing/);
  assert.match(r.stderr, /live paid adapter roster/,
    'the refusal names the consequence, because that is the reason it refuses');
  assert.equal(proj.startsOnDisk(), 0);
});

test('a harness that cannot be loaded refuses by name', () => {
  const proj = project('badharness');
  const r = runCli([
    '--manifest', proj.manifestPath, '--project-root', proj.root,
    '--proof-harness', path.join(proj.root, 'no-such-harness.cjs'),
  ], { projectRoot: proj.root });
  assert.equal(r.status, REFUSAL_EXIT);
  assert.match(r.stderr, new RegExp('harness_unloadable'));
});

// ─────────────────────────────────────────────────────────────────────────────
// THE WIRE : the consumer is DECLARED, and the switch finds it by declaration.
// ─────────────────────────────────────────────────────────────────────────────

test('the consumer declares the kind the PRODUCER exports, and never a transcription', () => {
  const consumer = require('../scripts/fleet-dispatch.cjs');
  assert.equal(typeof orchestration.FLEET_MANIFEST_KIND, 'string');
  assert.notEqual(orchestration.FLEET_MANIFEST_KIND, '');
  assert.equal(consumer.CONSUMES_MANIFEST_KIND, orchestration.FLEET_MANIFEST_KIND,
    'the consumer reads the kind off the producer own export');

  const cli = require('../scripts/execution-backend-switch.cjs');
  assert.deepEqual(cli.CONSUMER_REGISTRY, ['scripts/fleet-dispatch.cjs'],
    'the switch looks for the consumer at the path the consumer lives at');
  assert.equal(cli.CONSUMER_DECLARATION_KEY, 'CONSUMES_MANIFEST_KIND',
    'the switch reads the declaration this file just asserted');
});

test('the fleet claim is derived from counters, and the vocabulary is one frozen set', () => {
  assert.equal(Object.isFrozen(DISPATCH_OUTCOMES), true);
  assert.equal(FLEET_MINIMUM_WORKERS, 2);
  assert.equal(dispatchLib.FLEET_MINIMUM_WIDTH, 2);
  // A width below the floor can never be a fleet, at any spawn total.
  for (const spawns of [2, 3, 8, 32]) {
    const v = dispatchLib.classifyDispatch({
      dispatch_allowed: true, observed_spawns: spawns, distinct_nodes: spawns,
      demonstrated_width: 1, width_exact: true,
    });
    assert.equal(v.fleet, false, `${spawns} spawns at width 1 is not a fleet`);
    assert.equal(v.outcome, DISPATCH_OUTCOMES.DISPATCHED_SEQUENTIALLY);
  }
  // And a flag cannot buy the claim, because there is no flag to set.
  const bluff = dispatchLib.classifyDispatch({ dispatch_allowed: true, fleet: true, dispatched: true });
  assert.equal(bluff.fleet, false);
  assert.equal(bluff.outcome, DISPATCH_OUTCOMES.DISPATCHED_NOTHING);
});

// ─────────────────────────────────────────────────────────────────────────────
// ZERO AGENT SPEND, asserted over this file's own source.
// ─────────────────────────────────────────────────────────────────────────────

test('no arm in this file can reach a paid adapter', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  // The worker every dispatching arm spawns is `process.execPath` running a script
  // this file wrote. Nothing here names an agent CLI as a command.
  for (const agent of ['claude', 'codex', 'gemini']) {
    const spawnShaped = new RegExp(`spawn(Sync)?\\(\\s*['"\`]${agent}`, 'i');
    assert.doesNotMatch(source, spawnShaped, `no arm spawns ${agent}`);
  }
  assert.match(source, /rosterTheChildWouldSee/, 'the roster guard exists');
  assert.match(source, /REFUSING TO SPAWN/, 'the roster guard refuses rather than warning');

  // The guard is not decorative: the repository really does declare a paid roster,
  // and the fixture really does override it. Both halves, or the guard proves
  // nothing about the thing it guards.
  const live = require('../ferrox-core/bin/lib/capability-activation.cjs')
    .resolveConfigKey('fleet.adapters', { config: {}, cwd: REPO_ROOT, registry: {} });
  assert.ok(Array.isArray(live.value) && live.value.length > 0,
    'the repository declares a NON EMPTY roster, which is what makes the guard necessary');
  assert.deepEqual(rosterTheChildWouldSee(REPO_ROOT), [],
    'and the fixture overrides it to empty, which is what makes the guard sufficient');
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION BATTERY : every replacement asserted APPLIED on disk, every artifact
// restored, and the tree proved byte identical afterwards with `git diff`.
// ─────────────────────────────────────────────────────────────────────────────

/** Projects reused across the battery, built once because each costs a dispatch. */
const battery = {};
function fleetProject() {
  if (battery.fleet === undefined) battery.fleet = project('m-fleet');
  return battery.fleet;
}
function seqProject() {
  if (battery.seq === undefined) battery.seq = project('m-seq');
  return battery.seq;
}
function planProject() {
  if (battery.plan === undefined) battery.plan = project('m-plan');
  return battery.plan;
}

/** A fresh log per invocation, so a mutant never reads a prior mutant's run. */
let logSeq = 0;
function freshLog() {
  logSeq += 1;
  return `battery-${logSeq}.jsonl`;
}

/** The dispatch a mutant is checked against, at full width. */
function fleetRun(extra = []) {
  return dispatch(fleetProject(), extra, freshLog());
}

/** The same fixture at capacity 1: 3 spawns, width 1. */
function sequentialRun() {
  return dispatch(seqProject(), ['--capacity', '1'], freshLog());
}

/** A read-only run, used by every mutant whose property needs no processes. */
function planRun(args) {
  const proj = planProject();
  return runCli([
    '--manifest', args.manifest ?? proj.manifestPath,
    '--project-root', proj.root, '--plan-only', '--json',
  ], { projectRoot: proj.root });
}

/**
 * Did this run refuse FOR THE STATED REASON.
 *
 * The exit code alone is not enough and 2 mutants proved it. A manifest with 1
 * node id in 2 places ALSO fails reconciliation against the work graph, so a check
 * reading only the exit code watched the duplicate rung get deleted and reported a
 * kill it had not earned. A mutant killed by the wrong refusal is a test that has
 * stopped guarding the property it names.
 */
function refusedWith(r, code) {
  return r.status === REFUSAL_EXIT && typeof r.stderr === 'string' && r.stderr.includes(code);
}

const MUTANTS = [
  // ── the library: the fleet claim ──
  {
    id: 'M01', file: DISPATCH_LIB,
    from: 'const FLEET_MINIMUM_WIDTH = 2;', to: 'const FLEET_MINIMUM_WIDTH = 1;',
    why: 'a run that never overlapped 2 workers must not be called a fleet',
    check: () => sequentialRun().json.verdict.fleet === false,
  },
  {
    id: 'M02', file: DISPATCH_LIB,
    from: 'if (width < FLEET_MINIMUM_WIDTH) {', to: 'if (false) {',
    why: 'the width rung must actually run',
    check: () => sequentialRun().json.verdict.outcome === DISPATCH_OUTCOMES.DISPATCHED_SEQUENTIALLY,
  },
  {
    id: 'M03', file: DISPATCH_LIB,
    from: 'const FLEET_MINIMUM_WORKERS = 2;', to: 'const FLEET_MINIMUM_WORKERS = 1;',
    why: '1 worker on 1 node is a SINGLE WORKER run, named as such',
    check: () => {
      // The constant is what decides which of 2 refusals a 1 worker run gets. At
      // 1 it stops naming the count and falls through to the width rung, which is
      // still not a fleet but no longer tells the reader that 1 worker started.
      const proj = project('m03', { plans: ['01'] });
      const r = dispatch(proj, [], freshLog());
      return r.json.verdict.outcome === DISPATCH_OUTCOMES.DISPATCHED_SINGLE_WORKER;
    },
  },
  {
    id: 'M04', file: DISPATCH_LIB,
    from: 'if (spawns < FLEET_MINIMUM_WORKERS || nodes < FLEET_MINIMUM_WORKERS) {',
    to: 'if (false) {',
    why: '1 observed worker must be reported as 1 worker, not as a fleet',
    check: () => {
      const proj = project('m04', { plans: ['01'] });
      const r = dispatch(proj, [], freshLog());
      return r.json.verdict.outcome === DISPATCH_OUTCOMES.DISPATCHED_SINGLE_WORKER;
    },
  },
  {
    id: 'M05', file: DISPATCH_LIB,
    from: 'if (source.dispatch_allowed !== true) {', to: 'if (false) {',
    why: 'a refused preflight is a refusal and can never be anything else',
    check: () => {
      const proj = project('m05', { refusePreflight: true });
      return dispatch(proj, [], freshLog()).json.verdict.outcome === DISPATCH_OUTCOMES.PREFLIGHT_REFUSED;
    },
  },
  {
    id: 'M06', file: DISPATCH_LIB,
    from: 'if (isNonEmptyString(source.error)) {', to: 'if (false) {',
    why: 'a driver failure outranks every count observed beside it',
    check: () => {
      const proj = project('m06', { throwOnSpawn: true });
      return dispatch(proj, [], freshLog()).json.verdict.outcome === DISPATCH_OUTCOMES.DRIVER_FAILED;
    },
  },
  // ── the library: validate before side effects ──
  {
    id: 'M07', file: DISPATCH_LIB,
    from: 'if (owner !== undefined) {', to: 'if (false) {',
    why: '2 plans in 1 stage declaring 1 file must NEVER dispatch',
    check: () => {
      const proj = planProject();
      const bad = rewriteManifest(proj, (d) => {
        d.manifest.waves[0].stages[0].plans[1].files_modified = ['src/lane-01.cts'];
      }, 'm07.json');
      return refusedWith(planRun({ manifest: bad }),
        FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_OVERLAPPING_LANES);
    },
  },
  {
    id: 'M08', file: DISPATCH_LIB,
    from: 'if (seenNodes.has(id)) {', to: 'if (false) {',
    why: '1 node dispatched twice in 1 run is 2 workers on 1 card',
    check: () => {
      const proj = planProject();
      const bad = rewriteManifest(proj, (d) => {
        const s = d.manifest.waves[0].stages[0];
        s.plans[1].id = s.plans[0].id;
        s.plans[1].files_modified = ['src/lane-98.cts'];
      }, 'm08.json');
      // The CODE, not the exit. This manifest also fails reconciliation, so an
      // exit-only check watches the duplicate rung vanish and calls it a kill.
      return refusedWith(planRun({ manifest: bad }),
        FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_DUPLICATE_NODE);
    },
  },
  {
    id: 'M09', file: DISPATCH_LIB,
    from: "if (record['kind'] !== expectedKind) {", to: 'if (false) {',
    why: 'a manifest of another kind is a document nobody has understood',
    check: () => {
      const proj = planProject();
      const bad = rewriteManifest(proj, (d) => { d.manifest.kind = 'other/v9'; }, 'm09.json');
      return refusedWith(planRun({ manifest: bad }),
        FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_KIND_MISMATCH);
    },
  },
  {
    id: 'M10', file: DISPATCH_LIB,
    from: 'if (!isNonEmptyString(expectedKind)) {', to: 'if (false) {',
    why: 'a comparison against nothing accepts everything',
    check: () => {
      // Driven through the library, because the CLI always supplies a kind. The
      // module is re-read from the MUTATED file rather than the require cache.
      delete require.cache[require.resolve('../ferrox-core/bin/lib/fleet-dispatch-plan.cjs')];
      const mutated = require('../ferrox-core/bin/lib/fleet-dispatch-plan.cjs');
      const r = mutated.readDispatchPlan({ manifest: { kind: 'anything' }, expectedKind: '' });
      delete require.cache[require.resolve('../ferrox-core/bin/lib/fleet-dispatch-plan.cjs')];
      return r.ok === false && r.code === FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_NO_EXPECTED_KIND;
    },
  },
  {
    id: 'M11', file: DISPATCH_LIB,
    from: 'if (!Array.isArray(filesRaw)) {', to: 'if (false) {',
    why: 'an UNDECLARED write lane cannot be checked for overlap and is not assumed empty',
    check: () => {
      const proj = planProject();
      const bad = rewriteManifest(proj, (d) => {
        delete d.manifest.waves[0].stages[0].plans[0].files_modified;
      }, 'm11.json');
      return refusedWith(planRun({ manifest: bad }), FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_BAD_PLAN);
    },
  },
  {
    id: 'M12', file: DISPATCH_LIB,
    from: 'if (cap < capacity)', to: 'if (cap > 1e9)',
    why: 'a capacity ceiling must actually lower the capacity',
    check: () => sequentialRun().json.observed.demonstrated_width.value === 1,
  },
  // ── the command line interface ──
  {
    id: 'M13', file: DISPATCH_CLI,
    from: 'const REFUSAL_EXIT_CODE = 2;', to: 'const REFUSAL_EXIT_CODE = 0;',
    why: 'a refusal that exits 0 is not a refusal',
    check: () => {
      const proj = planProject();
      const bad = rewriteManifest(proj, (d) => { d.manifest.kind = 'other/v9'; }, 'm13.json');
      return planRun({ manifest: bad }).status !== 0;
    },
  },
  {
    id: 'M14', file: DISPATCH_CLI,
    from: '  if (!read.ok) {', to: '  if (false) {',
    why: 'a refused manifest must stop the run BEFORE a worker exists',
    check: () => {
      const proj = project('m14');
      const bad = rewriteManifest(proj, (d) => {
        d.manifest.waves[0].stages[0].plans[1].files_modified = ['src/lane-01.cts'];
      }, 'm14.json');
      const r = runCli([
        '--manifest', bad, '--project-root', proj.root, '--proof-harness', proj.harnessPath,
        '--log', proj.log(freshLog()),
      ], { projectRoot: proj.root });
      return refusedWith(r, FLEET_DISPATCH_ERROR_CODES.E_DISPATCH_OVERLAPPING_LANES)
        && proj.startsOnDisk() === 0;
    },
  },
  {
    id: 'M15', file: DISPATCH_CLI,
    from: '  if (!reconciled.ok) {', to: '  if (false) {',
    why: 'the driver dispatches the GRAPH, so a manifest that does not match it governs nothing',
    check: () => {
      const proj = planProject();
      const bad = rewriteManifest(proj, (d) => {
        d.manifest.waves[0].stages[0].plans[0].id = '90-77';
      }, 'm15.json');
      return refusedWith(planRun({ manifest: bad }), DISPATCH_CLI_CODES.GRAPH_MISMATCH);
    },
  },
  {
    id: 'M16', file: DISPATCH_CLI,
    from: 'const CONSUMES_MANIFEST_KIND = orchestration.FLEET_MANIFEST_KIND;',
    to: "const CONSUMES_MANIFEST_KIND = 'ferrox.fleet.dispatch/transcribed';",
    why: 'the kind is read off the producer own export, never transcribed here',
    check: () => planRun({}).status === 0,
  },
  {
    id: 'M17', file: DISPATCH_CLI,
    from: "    if (event.kind !== 'worker_started') continue;",
    to: "    if (event.kind !== 'run_started') continue;",
    why: 'the spawn count comes from the event the driver writes AT THE SPAWN',
    check: () => {
      const r = fleetRun();
      return r.json.observed.observed_spawns === 3 && r.json.verdict.fleet === true;
    },
  },
  {
    id: 'M18', file: DISPATCH_CLI,
    from: '    demonstrated_width: width.value,', to: '    demonstrated_width: spawns.observed_spawns,',
    why: 'a spawn total handed to the width argument is the exact defect this component names',
    check: () => sequentialRun().json.verdict.fleet === false,
  },
  {
    id: 'M19', file: DISPATCH_CLI,
    from: '  if (verdict.outcome !== DISPATCH_OUTCOMES.DISPATCHED_FLEET) {', to: '  if (false) {',
    why: 'a run that is not a fleet run must not exit as though it were',
    check: () => sequentialRun().status !== 0,
  },
  {
    id: 'M20', file: DISPATCH_CLI,
    from: '  if (parked.length > 0) {', to: '  if (false) {',
    why: 'a run that abandoned work did not finish the graph',
    check: () => {
      const proj = project('m20', { failing: ['90-03'] });
      return dispatch(proj, ['--park-after-attempts', '2'], freshLog()).status !== 0;
    },
  },
  {
    id: 'M21', file: DISPATCH_CLI,
    from: '  if (seams.length === 0) {', to: '  if (false) {',
    why: 'a harness that replaces nothing would run the REAL preflight against a paid roster',
    check: () => {
      const proj = planProject();
      const empty = path.join(proj.root, 'm21-harness.cjs');
      fs.writeFileSync(empty, "'use strict';\nmodule.exports = {};\n");
      const r = runCli([
        '--manifest', proj.manifestPath, '--project-root', proj.root, '--proof-harness', empty,
        '--plan-only',
      ], { projectRoot: proj.root });
      return refusedWith(r, DISPATCH_CLI_CODES.HARNESS_EMPTY);
    },
  },
  {
    id: 'M22', file: DISPATCH_CLI,
    from: '    proof_harness: harness === null ? null : { module: harness.module, seams: harness.seams },',
    to: '    proof_harness: null,',
    why: 'a harness run that is not stamped can be quoted as a production number',
    check: () => fleetRun().json.proof_harness !== null,
  },
  {
    id: 'M23', file: DISPATCH_CLI,
    from: "if (harness !== null) err(harnessBanner(harness) + '\\n');", to: 'if (false) { /* silenced */ }',
    why: 'the harness banner is how a reader knows the seams were not the shipped fleet',
    check: () => fleetRun().stderr.includes('PROOF HARNESS ACTIVE'),
  },
  {
    id: 'M24', file: DISPATCH_CLI,
    from: '  if (plan.capacity < FLEET_MINIMUM_WORKERS) {', to: '  if (false) {',
    why: 'a capacity of 1 is announced before the run, not explained after it',
    check: () => {
      const proj = project('m24', { plans: ['01'] });
      return dispatch(proj, [], freshLog()).stderr.includes('This will NOT be a fleet run');
    },
  },
  // NO MUTANT FOR THE RUN ID SCOPING, AND THE REASON IS RECORDED RATHER THAN
  // LEFT AS AN ABSENCE. The count is protected twice over: the early return in
  // `observeSpawns` zeroes it, and the strict `event.run_id !== runId` filter
  // excludes every event when the id is empty. Neither guard alone can be mutated
  // into an overcount, because the other one still holds, so a single substring
  // mutant SURVIVES while the property is genuinely safe. The behaviour is covered
  // by the arm `a driver that fails before naming its run counts 0`, which drives
  // a real prior run into a shared log. Staged as FF-B452: a battery that can only
  // replace 1 substring cannot express a mutant over 2 redundant guards.
  {
    id: 'M25', file: DISPATCH_CLI,
    from: '  if (planOnly) {', to: '  if (false) {',
    why: '--plan-only must dispatch nothing',
    check: () => {
      const proj = project('m25');
      const r = runCli([
        '--manifest', proj.manifestPath, '--project-root', proj.root,
        '--proof-harness', proj.harnessPath, '--plan-only', '--json',
        '--log', proj.log(freshLog()),
      ], { projectRoot: proj.root });
      return r.status === 0 && proj.startsOnDisk() === 0;
    },
  },
];

/** What git says about the mutated artifacts right now. */
function numstat() {
  return execFileSync('git', ['diff', '--numstat', '--', DISPATCH_LIB, DISPATCH_CLI],
    { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

test('MUTATION BATTERY: every mutant is applied on disk, killed, and restored', () => {
  // Git's view BEFORE the battery, compared against its view AFTER rather than
  // against the empty string: the guarded property is that the battery left the
  // artifacts byte identical, and asserting emptiness would instead assert the
  // working tree was clean when the suite ran, which is a different claim and one
  // this repository cannot make while other agents are committing.
  const gitBefore = numstat();
  const originals = new Map();
  for (const m of MUTANTS) {
    if (!originals.has(m.file)) originals.set(m.file, fs.readFileSync(m.file, 'utf8'));
  }

  assert.ok(MUTANTS.length > 0, 'the battery is non empty');

  // ── THE ARTIFACTS ARE CLEAN BEFORE THE FIRST MUTANT ─────────────────────────
  //
  // A battery run that is killed between applying a mutant and restoring it
  // leaves that mutant on disk. The NEXT run then reads the mutated file as its
  // "original", restores to it, and reports a full score for a tree that is
  // permanently broken in exactly the way the battery is supposed to detect. That
  // happened once while this file was being written, and the surviving symptom was
  // a payload field that had been `null` for 3 runs.
  //
  // So every replacement text is looked for BEFORE anything is applied. A hit is a
  // hard failure naming the residue, not a repair: repairing it silently would
  // restore the same blind spot.
  for (const m of MUTANTS) {
    const body = originals.get(m.file);
    assert.equal(body.includes(m.to), false,
      `${m.id}: ${path.basename(m.file)} already carries this mutant's replacement text, so a `
      + `previous battery run was interrupted before restoring it. Repair the file before `
      + `re-running: ${JSON.stringify(m.to)}`);
    assert.equal(body.includes(m.from), true,
      `${m.id}: ${path.basename(m.file)} carries the unmutated text this mutant replaces`);
  }

  const survivors = [];
  let applied = 0;
  let killed = 0;

  try {
    for (const m of MUTANTS) {
      const original = originals.get(m.file);

      // The replacement must EXIST. A mutant that cannot be applied is a battery
      // reporting a score it did not earn, so this is a hard failure.
      const occurrences = original.split(m.from).length - 1;
      assert.ok(occurrences > 0,
        `${m.id}: the target substring is absent from ${path.basename(m.file)}: ${m.from}`);

      const mutated = original.split(m.from).join(m.to);
      assert.notEqual(mutated, original, `${m.id}: the mutation changed the text`);
      fs.writeFileSync(m.file, mutated, 'utf8');

      // ASSERT APPLIED ON DISK, by reading it back rather than trusting the write.
      const onDisk = fs.readFileSync(m.file, 'utf8');
      assert.equal(onDisk, mutated, `${m.id}: the mutant is genuinely on disk`);
      assert.equal(onDisk.includes(m.to), true, `${m.id}: the replacement text is present on disk`);
      applied += 1;

      // The check returns TRUE when the guarded property still holds, which for a
      // mutant means the battery FAILED to kill it.
      let held;
      try {
        held = m.check() === true;
      } catch {
        held = false;
      }
      if (held) survivors.push(`${m.id} (${m.why})`);
      else killed += 1;

      fs.writeFileSync(m.file, original, 'utf8');
      assert.equal(fs.readFileSync(m.file, 'utf8'), original, `${m.id}: the artifact was restored`);
    }
  } finally {
    for (const [file, body] of originals) fs.writeFileSync(file, body, 'utf8');
    delete require.cache[require.resolve('../ferrox-core/bin/lib/fleet-dispatch-plan.cjs')];
  }

  assert.equal(applied, MUTANTS.length, 'every mutant was genuinely applied on disk');
  assert.deepEqual(survivors, [], `mutants SURVIVED: ${survivors.join(', ')}`);
  assert.equal(killed, MUTANTS.length, `every mutant was killed (${killed}/${MUTANTS.length})`);

  // The tree is byte identical to where it started.
  for (const [file, body] of originals) {
    assert.equal(fs.readFileSync(file, 'utf8'), body, `${path.basename(file)} is byte identical`);
  }
  const gitAfter = numstat();
  assert.equal(gitAfter, gitBefore,
    `git reports 0 lines changed BY the battery. before=${JSON.stringify(gitBefore)} after=${JSON.stringify(gitAfter)}`);
});
