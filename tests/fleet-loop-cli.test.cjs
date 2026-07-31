'use strict';

/**
 * The CLI wire: `main` actually reaches `runLoop`.
 *
 * ─── WHY THIS FILE SPAWNS THE SCRIPT INSTEAD OF IMPORTING IT ─────────────────
 *
 * Phase 19 built `runLoop`, tested it hard, and shipped a driver whose `main`
 * never called it. The suite was green the whole time and could not have been
 * otherwise: every test imported `scripts/fleet-loop.cjs` and invoked `runLoop`
 * directly, so no test ever executed the argv path that was supposed to reach
 * it. A GAP BETWEEN A LIBRARY AND ITS ENTRYPOINT IS INVISIBLE TO EVERY TEST
 * THAT IMPORTS THE LIBRARY.
 *
 * So this file imports nothing from the module under test. It runs the script
 * the way a person runs it, as a child process with an argv, and asserts on the
 * exit code and the bytes on stdout. That is the only shape of test that can
 * observe whether the wire exists.
 *
 * ─── THE DISCRIMINATOR ───────────────────────────────────────────────────────
 *
 * The preflight path prints a preflight object. The dispatch path prints
 * `{summary, run_record}`. `run_record` is folded out of the log the driver
 * wrote, so its presence cannot be faked by a `main` that only preflights: the
 * old `main` had no run id to fold on and no log to fold from. Asserting that
 * key is therefore an assertion that `runLoop` ran, not a shape check.
 *
 * ─── WHY PHASE 08 ────────────────────────────────────────────────────────────
 *
 * `08-dogfood/` is a real phase directory that scans to a graph with 0 nodes.
 * The driver therefore dispatches nothing, drains on the first pass and exits,
 * which gives the positive wire case a real run with a real log and NO spawned
 * workers. A test that proves the wire must not also spawn an agent fleet: a
 * suite that dispatches real workers is a suite nobody runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const LOOP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fleet-loop.cjs');

/**
 * The phase this file CREATES to get an empty graph, and removes afterwards.
 *
 * ─── WHY IT IS BUILT RATHER THAN BORROWED (FF-B217) ──────────────────────────
 *
 * This was `08`, whose directory is empty and yields 0 nodes. That worked in the
 * primary tree and NOWHERE else: `.planning/phases/08-dogfood/` holds 0 tracked
 * files, and GIT CANNOT REPRESENT AN EMPTY DIRECTORY, so it does not exist in
 * any checkout. The test therefore depended on a local artifact of 1 machine,
 * and it failed the moment the land gate ran the suite in a fresh worktree with
 * `phase 08 has no phase directory`.
 *
 * A fixture the test creates is true everywhere. The number is deliberately far
 * from any real phase so it cannot collide with planned work.
 */
const EMPTY_PHASE = '97';
const EMPTY_PHASE_DIR = path.join(
  REPO_ROOT, '.planning', 'phases', `${EMPTY_PHASE}-cli-wire-fixture`,
);

/** A phase with no directory at all. Only `runLoop` can produce its message. */
const ABSENT_PHASE = '99';

/**
 * The fixture that owns the ADAPTER ROSTER every spawn in this file runs under.
 *
 * ─── WHY THIS EXISTS, PLAN 23-05 ─────────────────────────────────────────────
 *
 * Every arm below used to get its refusal FOR FREE, because this repository
 * declared no `fleet.adapters` roster at all and the fourth precondition refuses
 * an empty one. Plan 23-05 configured that roster for the live A/B, and the
 * consequence was not a stale assertion. It was this:
 *
 *   `checkAdapters` probes a NON EMPTY roster by SPAWNING EVERY ADAPTER IN IT
 *   with a real prompt. The profiles are `claude -p`, `codex exec` and
 *   `gemini -p` (ferrox-core/bin/lib/fleet-probe.cjs:99). So with the roster
 *   configured, `npm test` made 3 REAL, PAID model calls per arm in this file,
 *   on 3 vendors, from a unit suite, and its verdict became a function of 3
 *   external accounts' balances, auth state and rate limits.
 *
 * A test suite must not buy its answers and must not depend on which adapters
 * happen to be installed on the machine running it. So the roster these arms run
 * under is now SUPPLIED BY THIS FILE rather than read from the repository's live
 * config: `FERROX_PROJECT` redirects the config precedence walk's workstream
 * level to `.planning/<project>/config.json`, and this fixture declares an
 * EXPLICITLY EMPTY roster there.
 *
 * The empty roster refusal itself is untouched and is the thing being exercised.
 * `checkAdapters` returns on `roster.length === 0` BEFORE the probe loop, so no
 * adapter binary is reached and nothing is spent. That ordering is asserted by
 * the arms below rather than trusted, and `runCli` refuses to spawn at all if
 * the fixture ever stops resolving.
 */
const ADAPTER_FIXTURE_PROJECT = 'fleet-cli-adapter-fixture';
const ADAPTER_FIXTURE_DIR = path.join(
  REPO_ROOT, '.planning', ADAPTER_FIXTURE_PROJECT,
);

/** The roster the fixture declares. Empty, and explicitly so. */
const FIXTURE_ROSTER = [];

/**
 * The ceiling on a single CLI invocation, ms.
 *
 * The preflight creates a real worktree, so these are not instant. The bound is
 * a MECHANISM and not a comment: a wire test whose failure mode is a hang has no
 * verdict, which is the same defect this milestone keeps finding in its own
 * guards.
 */
const CLI_TIMEOUT_MS = 180000;

const SCRATCH_ROOTS = [];

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-fleet-cli-'));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.before(() => {
  // A directory carrying 1 non-plan file: it exists, so the scan finds a phase,
  // and it holds no plans, so the graph is empty. Both halves are asserted
  // below rather than assumed.
  fs.mkdirSync(EMPTY_PHASE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EMPTY_PHASE_DIR, 'NOTES.md'),
    '# fixture\n\nCreated and removed by tests/fleet-loop-cli.test.cjs. Not a real phase.\n',
  );

  fs.mkdirSync(ADAPTER_FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ADAPTER_FIXTURE_DIR, 'config.json'),
    `${JSON.stringify({ fleet: { adapters: FIXTURE_ROSTER } }, null, 2)}\n`,
  );
});

test.after(() => {
  try {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
    fs.rmSync(EMPTY_PHASE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* best effort */ }
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
 * The roster the CHILD would resolve, read through the same precedence walk the
 * child reads it through, without spawning anything.
 *
 * This is the zero spend guard's instrument. It is deliberately the shipped
 * resolver rather than a re-read of the fixture file, because what matters is
 * not what this file wrote, it is what `readAdapterRoster` will find.
 */
function rosterTheChildWouldSee() {
  const ca = require('../ferrox-core/bin/lib/capability-activation.cjs');
  let registry = {};
  try { registry = require('../ferrox-core/bin/lib/capability-registry.cjs'); } catch { /* absent */ }
  const saved = process.env.FERROX_PROJECT;
  process.env.FERROX_PROJECT = ADAPTER_FIXTURE_PROJECT;
  try {
    const resolved = ca.resolveConfigKey('fleet.adapters', { config: {}, cwd: REPO_ROOT, registry });
    return Array.isArray(resolved.value) ? resolved.value : null;
  } finally {
    if (saved === undefined) delete process.env.FERROX_PROJECT;
    else process.env.FERROX_PROJECT = saved;
  }
}

/** Run the script as a person would, and return what the process actually did. */
function runCli(args) {
  // ─── THE ZERO SPEND GUARD, AND WHY IT IS A MECHANISM ──────────────────────
  //
  // A non empty roster makes the fourth precondition SPAWN EVERY ADAPTER IN IT
  // with a real prompt, which is real money on 3 vendors. If the fixture ever
  // stops resolving, for a typo, a rename, or a change to the config precedence
  // walk, the child would silently fall through to the repository's own
  // 3 identity roster and this file would start buying its answers again. So the
  // roster is CHECKED BEFORE THE SPAWN and a surprise refuses to run rather than
  // being paid for. A comment cannot hold this property; this can.
  const roster = rosterTheChildWouldSee();
  assert.deepEqual(
    roster, FIXTURE_ROSTER,
    'REFUSING TO SPAWN. The adapter fixture no longer resolves to an empty roster, so this spawn '
      + `would probe ${JSON.stringify(roster)} by invoking each one as a real, paid model call. `
      + `Repair ${ADAPTER_FIXTURE_DIR}/config.json rather than letting the suite dispatch.`,
  );

  const result = spawnSync(process.execPath, [LOOP_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    // The fixture roster, supplied to the child. See ADAPTER_FIXTURE_PROJECT.
    env: { ...process.env, FERROX_PROJECT: ADAPTER_FIXTURE_PROJECT },
    // The driver spawns nothing on these paths, but an inherited stdin would let
    // a future regression block on a prompt instead of failing.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    result.signal,
    null,
    `the CLI was killed by ${result.signal} rather than exiting. `
      + `stderr was:\n${result.stderr}`,
  );
  return result;
}

// ── the argv guards ─────────────────────────────────────────────────────────

test('a missing phase refuses and names the usage', () => {
  const r = runCli(['--run']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs a phase as its first argument/);
  assert.match(r.stderr, /--run/);
});

test('--preflight and --run together refuse rather than picking a winner', () => {
  const r = runCli([EMPTY_PHASE, '--run', '--preflight']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /contradict each other/);
  // The refusal has to happen BEFORE any dispatch, so nothing was folded.
  assert.equal(r.stdout.trim(), '');
});

test('a capacity that is not a positive whole number refuses', () => {
  for (const bad of ['four', '0', '-1', '2.5', '']) {
    const r = runCli([EMPTY_PHASE, '--run', `--capacity=${bad}`]);
    assert.equal(r.status, 1, `--capacity=${bad} should refuse`);
    assert.match(r.stderr, /--capacity must be a positive whole number/);
  }
});

test('a max-passes that is not a positive whole number refuses', () => {
  const r = runCli([EMPTY_PHASE, '--run', '--max-passes=none']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--max-passes must be a positive whole number/);
});

// ── the wire ────────────────────────────────────────────────────────────────

test('the fixture phase exists and its graph is empty', () => {
  const scan = require('../ferrox-core/bin/lib/workgraph-scan.cjs');
  const built = scan.buildWorkgraph({ cwd: REPO_ROOT, phase: EMPTY_PHASE });
  // BOTH halves matter. `ok` false would mean the directory did not survive,
  // which is the exact defect this fixture replaced. 0 nodes is what lets the
  // wire test below dispatch nothing.
  assert.equal(built.ok, true, `the fixture phase directory is missing: ${built.message}`);
  assert.equal((built.document.nodes || []).length, 0);
});

test('--run reaches runLoop, proven by the run log only the driver writes', () => {
  // ─── WHY THE DISCRIMINATOR MOVED, PHASE 20 SC2 ────────────────────────────
  //
  // This arm used to assert a folded `run_record` on stdout, which required the
  // preflight to PASS in this repository. Phase 20 made the adapter probe the
  // fourth dispatch precondition, and an empty `fleet.adapters` roster refuses by
  // design: a fleet run against a roster nobody declared has no adapter to probe.
  //
  // The wire is still observable, and by an artifact rather than by a shape: a
  // refused run is STILL a run, `runLoop` brackets it in the log, and NOTHING
  // ELSE IN THIS PROCESS WRITES THAT FILE. A `main` that stopped at the
  // preflight would leave no log at all, which is exactly what the arm below
  // asserts is not the case. The dispatching half of the wire is driven against
  // a fixture in tests/fleet-loop-adapters.test.cjs, where `main` takes its repo
  // root and its control plane as injected dependencies.
  //
  // ─── WHERE THE EMPTY ROSTER COMES FROM NOW, PLAN 23-05 ────────────────────
  //
  // It used to be this repository's own config, which declared no roster. That
  // is no longer true and the arm no longer depends on it. See
  // ADAPTER_FIXTURE_PROJECT: the roster is supplied by this file, so the refusal
  // is a property of a stated fixture rather than an accident of the tree the
  // suite happens to be running in.
  const logPath = path.join(scratch(), 'fleet-runlog.jsonl');
  const r = runCli([EMPTY_PHASE, '--run', '--raw', `--log=${logPath}`]);

  assert.equal(r.status, 1, `the empty roster should refuse. stdout:\n${r.stdout}`);
  assert.match(r.stderr, /REFUSED adapters/);

  // `runLoop` writes the human refusal to stdout ahead of the rendered object,
  // so the object is the last `--raw` line rather than the whole stream.
  const printed = JSON.parse(
    r.stdout.split(/\r?\n/).filter((l) => l.startsWith('{')).pop(),
  );
  assert.equal(printed.dispatch_allowed, false);

  // WHICH RULE REFUSED, and that NO ADAPTER WAS REACHED. Without these the arm
  // is satisfied by any adapters refusal at all, including the one produced by
  // 3 real paid probes coming back not ready, so it could go on passing while
  // the suite quietly dispatched. `verdicts` empty and `chain.ran` false are the
  // observable form of "the empty roster branch returned before the probe loop".
  const adapters = printed.checks.find((c) => c.name === 'adapters');
  assert.equal(adapters.ok, false);
  assert.equal(adapters.observed.rule, 'empty-roster');
  assert.deepEqual(adapters.observed.roster, FIXTURE_ROSTER, 'the fixture roster is what was read');
  assert.deepEqual(adapters.observed.verdicts, [], 'no adapter was probed, so nothing was spent');
  assert.equal(adapters.observed.chain.ran, false);

  // THE DISCRIMINATOR. Only `runLoop` writes this file.
  assert.ok(fs.existsSync(logPath), 'the driver was never reached: no run log was written');
  const written = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const events = written.map((l) => JSON.parse(l));
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('run_started'));
  assert.ok(kinds.includes('run_closed'));
  assert.equal(new Set(events.map((e) => e.run_id)).size, 1);
  assert.equal(events.find((e) => e.kind === 'run_closed').stopped_by, 'preflight_refused');
});

test('without --run the CLI still stops at the preflight', () => {
  const logPath = path.join(scratch(), 'unused.jsonl');
  const r = runCli([EMPTY_PHASE, '--raw', `--log=${logPath}`]);

  // The preflight refuses here for the reason above, and the exit code carries
  // it. What this arm exists to prove is unchanged: WITHOUT `--run` nothing is
  // dispatched and nothing is written, whichever way the preflight went.
  assert.equal(r.status, 1, `stderr:\n${r.stderr}`);
  const printed = JSON.parse(r.stdout);
  assert.ok(!Object.prototype.hasOwnProperty.call(printed, 'run_record'));
  assert.equal(printed.dispatch_allowed, false);
  const adapters = printed.checks.find((c) => c.name === 'adapters');
  assert.equal(adapters.ok, false);
  // The fixture's roster is what refused, and it refused before probing. Same
  // reason as the arm above: an unqualified `ok === false` is also what 3 real
  // paid probes returning not ready would produce.
  assert.equal(adapters.observed.rule, 'empty-roster');
  assert.deepEqual(adapters.observed.verdicts, [], 'no adapter was probed, so nothing was spent');
  // Dispatch is opt in, so nothing was written and nothing was spawned.
  assert.equal(fs.existsSync(logPath), false);
});

test('the worker seam dispatches the WORK ID and refuses without one', () => {
  const loop = require('../scripts/fleet-loop.cjs');

  // `ratchet-exec:701` matches an open card on its work_id, a content hash. The
  // workgraph node id is the card's SLUG. Passing the slug refuses with exit 2,
  // which is what all 32 workers of the first real dispatch did, so the seam
  // must carry the work id and must not quietly fall back to the node id.
  const engineRoot = path.join(scratch(), 'engine');
  const spec = loop.workerCommandSpec({ nodeId: '20-01', workId: '8f5e7a9df1', engineRoot });
  assert.ok(spec.args.includes('8f5e7a9df1'));
  assert.ok(!spec.args.includes('20-01'), 'the slug must not reach the engine');

  assert.throws(
    () => loop.workerCommandSpec({ nodeId: '20-01', engineRoot }),
    /no work id for node "20-01"/,
  );
});

test('the worker seam runs a PER RUN COPY and refuses the tree it is pointed at', () => {
  // FF-B234. `ratchet-exec` re-spawns its auto-grant helper with a scrubbed 6
  // name environment that DROPS PYTHONDONTWRITEBYTECODE, so the helper imports
  // the kernel with bytecode writing enabled whatever the caller set and CPython
  // writes a cache directory beside the source it loaded. Setting the variable on
  // our own child is necessary and not sufficient; the copy is what closes it.
  //
  // Both refusals are here because the property has 2 ways to regress: dropping
  // the copy entirely, and passing the tree under the fleet as the copy. A seam
  // that DEFAULTED to the repository root would make the first regression silent.
  const loop = require('../scripts/fleet-loop.cjs');
  const engineRoot = path.join(scratch(), 'engine');

  assert.equal(
    loop.workerCommandSpec({ nodeId: '20-01', workId: 'abc123', engineRoot }).command,
    path.join(engineRoot, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', 'ratchet-exec'),
    'the entrypoint comes from the engine root, not from the repository',
  );

  assert.throws(
    () => loop.workerCommandSpec({ nodeId: '20-01', workId: 'abc123' }),
    /no engine root for node "20-01"/,
    'an absent engine root REFUSES rather than falling back to the tracked tree',
  );

  assert.throws(
    () => loop.workerCommandSpec({
      nodeId: '20-01', workId: 'abc123', repoRoot: REPO_ROOT, engineRoot: REPO_ROOT,
    }),
    /is inside the repository the fleet is operating on/,
    'and the tree under the fleet is refused AS an engine root, which is the defect by name',
  );
});

test('the per run engine copy is a real copy, outside the tree it was taken from', () => {
  // The copy has to be somewhere writing to it cannot reach the source, or it is
  // the same defect with an extra directory in the path.
  const loop = require('../scripts/fleet-loop.cjs');
  const engine = loop.prepareRunEngine(REPO_ROOT);
  try {
    const entrypoint = path.join(engine.root, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', 'ratchet-exec');
    assert.equal(fs.existsSync(entrypoint), true, 'the copy carries the entrypoint the seam names');
    assert.equal(
      engine.root.startsWith(REPO_ROOT + path.sep), false,
      'and it lives outside the repository, so bytecode written into it lands nowhere tracked',
    );
  } finally {
    engine.release();
  }
  assert.equal(fs.existsSync(engine.root), false, 'the release removes it, so a run leaks nothing');
});

test('the worker seam carries the repo scoped ratchet home when it has one', () => {
  const loop = require('../scripts/fleet-loop.cjs');
  // Without it the engine falls back to ~/.ratchet, so a run silently borrows
  // the operator's personal state and fails on a machine that has none.
  const withHome = loop.workerSpawnOptions({ cwd: REPO_ROOT, ratchetHome: '/x/.ferrox/rh' });
  assert.equal(withHome.env.RATCHET_HOME, '/x/.ferrox/rh');
});

test('the worker seam refuses to let CPython write bytecode into the vendored tree', () => {
  // Not a style preference. The vendored engine is byte pinned and 5 separate
  // guards assert it carries no bytecode, so the first real dispatch of this
  // driver wrote `__pycache__` under it and turned 8 tests red. Running the
  // fleet must not mutate the engine it runs, and the seam has to carry that
  // itself: an operator whose shell happens to export the variable is not a
  // guard. Asserted on the options the seam actually passes to `spawn`, so it
  // costs no subprocess.
  const loop = require('../scripts/fleet-loop.cjs');
  const opts = loop.workerSpawnOptions({ cwd: REPO_ROOT });
  assert.equal(opts.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(opts.cwd, REPO_ROOT);
});

test('--run answers the PRECONDITIONS before it ever looks at the graph', () => {
  // This arm used to assert that an absent phase produced `has no phase
  // directory`, which is emitted by `buildWorkgraph`. Phase 20 SC2 moved the
  // preflight ahead of the control plane and therefore ahead of the graph, and
  // the reason is a correctness fix rather than a preference: the control plane
  // mints a card and a REAL git worktree per node, so a run that is going to be
  // refused must be refused BEFORE anything is created.
  //
  // So the guard becomes the ordering itself. An absent phase and a declared
  // roster of 0 adapters are both refusals, and the one that answers is the one
  // that comes first. The roster of 0 comes from this file's own fixture as of
  // plan 23-05, not from the repository's config. See ADAPTER_FIXTURE_PROJECT.
  const logPath = path.join(scratch(), 'absent.jsonl');
  const r = runCli([ABSENT_PHASE, '--run', `--log=${logPath}`]);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED adapters/);
  // Named, so the ordering is proven against THE PRECONDITION THIS ARM MEANS
  // rather than against whichever one happened to answer.
  assert.match(r.stderr, /empty-roster: 0 adapters are configured/);
  assert.doesNotMatch(r.stderr, /has no phase directory/);
});

// ══ SC1: --verify-post-land, its validation, and its ORDERING (FF-B272) ══════
//
// The seam `opts.verifyPostLand` has existed since phase 19 and no command line
// path ever set it, so every real run classified every landed increment
// `unknown`. These cases drive the missing producer. The refusal arms run the
// script as a CHILD PROCESS, because the subject is what `main` does with an
// argv and a test that imports the library cannot see that. The arms that need
// to observe what reached the DRIVER call the exported `main` against a fixture
// supplying its own root and its own control plane, for the reason the `main`
// docstring gives: a check must not be able to cause the damage it tests for.

const loop = require('../scripts/fleet-loop.cjs');

/** A repository shaped fixture with a scannable phase directory and 0 nodes. */
function mainFixture(tag) {
  const root = path.join(scratch(), tag);
  fs.mkdirSync(path.join(root, '.planning', 'phases', '96-verify-post-land'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.planning', 'phases', '96-verify-post-land', 'NOTES.md'),
    '# fixture\n\nA phase directory with no plans, so the graph is empty.\n',
  );
  return root;
}

/** The preflight shape `main` needs to reach its dispatch branch. */
function allowedPreflight() {
  return {
    checks: loop.CHECK_NAMES.map((name) => ({ name, ok: true, observed: {}, refused_because: null })),
    check_names: [...loop.CHECK_NAMES],
    dispatch_allowed: true,
  };
}

/**
 * Drive `main` on the dispatch branch and hand back what reached the driver.
 *
 * The driver itself is stubbed, because these arms are about the COMMAND LINE
 * seam. What the driver then does with the verifier is driven for real, against
 * real lands, in tests/fleet-loop-postland.test.cjs.
 */
async function driveMainFor(root, extraArgs) {
  const logPath = path.join(root, 'fleet-runlog.jsonl');
  fs.writeFileSync(logPath, [
    JSON.stringify({ ts: 1, kind: 'run_started', run_id: 'run-vpl', graph_generation: null, phase: '96' }),
    JSON.stringify({ ts: 2, kind: 'run_closed', run_id: 'run-vpl', stopped_by: 'drained' }),
    '',
  ].join('\n'));

  const ensureCalls = [];
  const driveCalls = [];
  let out = '';
  let errText = '';
  const code = await loop.main({
    argv: ['96', '--run', '--raw', `--log=${logPath}`, ...extraArgs],
    repoRoot: root,
    runPreflight: async () => allowedPreflight(),
    // The stand in DOES what the real one does: it creates the engine home. So an
    // assertion below observes an ABSENT SIDE EFFECT rather than the absence of a
    // call to something that might have failed anyway.
    ensureControlPlane: (input) => {
      ensureCalls.push(input);
      fs.mkdirSync(path.join(root, '.ferrox', 'ratchet-home', 'state'), { recursive: true });
      return { home: path.join(root, '.ferrox', 'ratchet-home'), cards: {} };
    },
    runLoop: async (opts) => {
      driveCalls.push(opts);
      return {
        run_id: 'run-vpl', dispatch_allowed: true, preflight: opts.preflight,
        stopped_by: 'drained', passes: [], dispatched: [], parked: [], blocked_on_human: [],
        post_land_counts: { decided: 0, undecided: 0, landed: 0 },
      };
    },
    write: (s) => { out += s; },
    writeErr: (s) => { errText += s; },
  });
  return { code, ensureCalls, driveCalls, out, err: errText, root };
}

test('an EMPTY --verify-post-land refuses and names the flag', () => {
  const r = runCli([EMPTY_PHASE, '--run', '--verify-post-land=']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--verify-post-land needs a command/);
  assert.match(r.stderr, /yields 0 tokens/);
  // The refusal happened BEFORE dispatch, so nothing was folded and printed.
  assert.equal(r.stdout.trim(), '');
});

test('a --verify-post-land that splits to 0 tokens refuses the same way', () => {
  // Every one of these is a value a person could plausibly type. None of them
  // yields a command, and a tolerant parse would leave the run believing it
  // wired a verifier while it wired nothing.
  // `:::::` is deliberately NOT here: it splits to the single token `:`, which is
  // 1 token and is therefore accepted by the parse and refused later by the spawn
  // as a gate that could not run. A value list that included it would be asserting
  // the parse is stricter than it is.
  for (const bad of ['::', '::::', '   ', '::   ::']) {
    const r = runCli([EMPTY_PHASE, '--run', `--verify-post-land=${bad}`]);
    assert.equal(r.status, 1, `--verify-post-land=${bad} should refuse`);
    assert.match(r.stderr, /--verify-post-land needs a command/);
  }
});

test('THE ORDERING CASE: a malformed --verify-post-land mints NO card and NO worktree', async () => {
  // The comment above the bounds block records what this is guarding: numeric
  // flags used to be parsed at the point of use, which put them AFTER
  // `ensureControlPlane`, so `--capacity=four` created a ratchet home and minted
  // work cards complete with real git worktrees and only then refused the
  // argument it could have rejected first. This flag sits in the same block for
  // the same reason, and this arm is what proves it rather than asserting it.
  const root = mainFixture('ordering');
  const planeDir = path.join(root, '.ferrox');
  assert.equal(fs.existsSync(planeDir), false, 'the fixture started dirty');

  await assert.rejects(
    () => driveMainFor(root, ['--verify-post-land=::']),
    (e) => {
      assert.match(e.message, /--verify-post-land needs a command/);
      return true;
    },
  );

  // THE DISCRIMINATOR, and it is an absent SIDE EFFECT rather than an uncalled
  // stub: the stand in above creates the home when it runs, so this directory
  // existing would mean validation ran too late.
  assert.equal(fs.existsSync(planeDir), false, 'a refused flag still minted a control plane');
});

test('a well formed --verify-post-land reaches the driver as a command and an argv ARRAY', async () => {
  const root = mainFixture('reaches');
  const marker = path.join(root, 'argv.json');
  // The child writes back the argv IT actually received. A spaced token is in
  // there on purpose: the separator is multi character precisely so a value
  // holding a space stays 1 token rather than being torn into 2.
  const code = 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(1)))';
  const spaced = 'a b c';
  const sep = loop.VERIFY_POST_LAND_SEPARATOR;
  const value = ['node', '-e', code, marker, spaced].join(sep);

  const r = await driveMainFor(root, [`--verify-post-land=${value}`]);
  assert.equal(r.code, 0, `main refused: ${r.err}`);
  assert.equal(r.driveCalls.length, 1);

  // 1. It reached the driver at all, which is the whole of FF-B272.
  const verifier = r.driveCalls[0].verifyPostLand;
  assert.equal(typeof verifier, 'function', 'the driver was handed no post land verifier');

  // 2. It is SYNCHRONOUS. `landAttempt` calls it synchronously and membership
  //    tests the result, so a promise would fail that test, the classification
  //    would stay `unknown`, and the run would be byte identical to a run that
  //    wired nothing at all.
  const reported = verifier({ nodeId: 'n1', attemptId: 'a1', outcome: { result: 'landed' } });
  assert.equal(typeof reported, 'string', 'the verifier returned a promise rather than a value');
  assert.ok(loop.POST_LAND_CLASSIFICATIONS.includes(reported), `reported ${reported}`);

  // 3. It is a command and an argv ARRAY, observed from the child that received
  //    it rather than from the object that was handed over. The length is a
  //    SPECIFIC number rather than merely truthy.
  assert.ok(fs.existsSync(marker), 'the verifier command was never spawned');
  const received = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(received.length, 2);
  assert.equal(received[0], marker);
  assert.equal(received[1], spaced, 'the separator tore a spaced argument into 2 tokens');
});

test('NO SHELL: a value only a shell could run is not run', async () => {
  // `exit 7` is not a program. Under `shell: true` it is a shell BUILTIN and the
  // child would exit 7, which the classifier reads as a gate that ran and failed
  // and reports `false_green`. Under `shell: false` there is no such file, the
  // spawn errors, and a verifier that could not run reports `unknown`. So the 2
  // are distinguishable by their classification alone and no source grep is
  // needed to tell them apart.
  const root = mainFixture('noshell');
  const r = await driveMainFor(root, ['--verify-post-land=exit 7']);
  assert.equal(r.code, 0, `main refused: ${r.err}`);

  const verifier = r.driveCalls[0].verifyPostLand;
  const reported = verifier({ nodeId: 'n1', attemptId: 'a1', outcome: { result: 'landed' } });
  assert.equal(reported, 'unknown', 'the verifier value reached a shell');
  assert.notEqual(reported, 'false_green');
});

test('the verifier is an OPT IN: without the flag the driver still gets null', async () => {
  // The gate this re runs was measured at 109 seconds warm, so a default would
  // add that per landed increment to every run in this project. The criterion is
  // that a real run CAN classify, and this arm is what keeps it from becoming a
  // tax on every run that did not ask for it.
  const root = mainFixture('optin');
  const r = await driveMainFor(root, []);
  assert.equal(r.code, 0, `main refused: ${r.err}`);
  assert.equal(r.driveCalls[0].verifyPostLand, null);
  // And the absence is LOUD rather than silent, so a reader can tell a verifier
  // that was never wired from one that ran and abstained.
  assert.match(r.err, /--verify-post-land/);
});
