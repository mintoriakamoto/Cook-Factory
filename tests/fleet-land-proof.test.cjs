'use strict';

/**
 * Phase 20 plan 07: ONE NODE LANDS, END TO END, WITH NO NETWORK AND NO SPEND.
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * SC5's control plane was proven step by step in
 * `.planning/phases/20-autonomy-guards/CONTROL-PLANE-PROOF.md`, and step 6, the
 * land, was declared finished by READING THE CALL SITE. It was not finished. The
 * engine requires exactly 1 of its 2 review flags and aborts with exit 2 when
 * neither is present, one step PAST the suite step where FF-B217 stopped every
 * earlier run, and the seam passed neither. The land path had therefore never
 * completed anywhere: it had only ever aborted, and each abort was blamed on the
 * obstacle it happened to reach first.
 *
 * So this file does the only thing that settles it. It drives the chain to a
 * card whose status is `landed`, and it reads that status FROM THE CARD STORE,
 * which is the value the engine itself reads, never from the land's printed
 * prose. A parser over a human sentence drifts the first time upstream rewords
 * it, and it drifts silently.
 *
 * ─── THE FIXTURE BORROWS NOTHING ─────────────────────────────────────────────
 *
 * Every fixture below builds its own bare remote, its own clone, its own engine
 * home and its own phase directory. An empty untracked directory does not exist
 * in any git checkout, so a test that borrowed a fixture directory passed on 1
 * machine and nowhere else. That is CONTEXT D9 fact 4 and it is not relitigated.
 *
 * That includes the ENGINE. Each fixture gets its own copy of the vendored
 * tree, about 1 megabyte, and every arm runs that copy rather than the
 * repository's. A symlink was tried first and is wrong for a measured reason: a
 * real dispatch writes bytecode beside the entrypoints, through a symlink that
 * IS the repository's tree, and a concurrent guard file asserting that tree is
 * clean went red. See the bytecode note below.
 *
 * ─── THE 2 STUBS, AND WHY INTERPOSING IS THE RIGHT ANSWER ────────────────────
 *
 * The engine's land verb pushes the branch and then runs a pull request creation
 * command, aborting if that fails, and it closes the card as landed only after
 * that succeeds. Against a fixture remote that is a local path there is no
 * GitHub, so the real command cannot succeed and the chain would stop 1 step
 * short of the state the criterion names.
 *
 * The engine resolves that command through PATH: it invokes it by bare name with
 * an argument list, no shell, inheriting the environment (`ratchet:53-62`). So a
 * stub placed first on PATH answers it. That is exactly the discipline the
 * engine uses for its own agent adapter, whose selftest dispatches to a mock
 * rather than to a model. Interposing at the network boundary is the same move
 * at the same kind of boundary, and it lets the whole chain run with no account,
 * no network and no pull request against any real remote.
 *
 * The second stub is the agent, and it is needed for 1 arm only. The worker seam
 * passes NO adapter flag, so the engine picks a lane by probing PATH for an
 * installed agent. Under `runLoop` there is no way to ask for the mock, and a
 * suite that dispatched whatever agent happens to be installed on the machine
 * would cost real money. So that arm puts a stub first on PATH and asserts the
 * stub is what answered. The gap it works around is filed as a backlog row
 * rather than papered over.
 *
 * Nothing under the vendored directory is modified, and no flag is added to the
 * engine. Both stubs live in the fixture's own scratch tree.
 *
 * ─── EVERY GATE IS WATCHED REFUSING ──────────────────────────────────────────
 *
 * A clean run proves the chain can be walked. It does not prove the gate in the
 * middle of it does anything. So the same chain is driven with a fixture suite
 * that exits non zero, and the land is observed aborting AT THE SUITE STATION
 * with the card not landed and no pull request attempted. The slug arm and the
 * empty card mapping arm are the same shape: each is a refusal somebody watched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const P = 'phase 20 plan 07';
const REPO_ROOT = path.join(__dirname, '..');

/**
 * The REPOSITORY's vendored engine, named here for exactly 1 purpose: to assert
 * at the end that nothing in this file touched it. Every arm runs the fixture's
 * own copy instead. See the copy in `buildFixture` for why.
 */
const VENDOR_ROOT = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet');
const VENDOR_BIN = path.join(VENDOR_ROOT, 'bin');
/** Built rather than written, so this file's own text cannot trip the guards that scan for it. */
const BYTECODE_DIR = '__py' + 'cache__';

const controlplane = require('../scripts/fleet-controlplane.cjs');
const loop = require('../scripts/fleet-loop.cjs');
const workgraphScan = require('../ferrox-core/bin/lib/workgraph-scan.cjs');
const runfold = require('../ferrox-core/bin/lib/fleet-runfold.cjs');
const landqueue = require('../ferrox-core/bin/lib/fleet-landqueue.cjs');

/**
 * The phase the fixtures declare. Far from any real phase number so it cannot
 * collide with planned work, and it exists only inside a scratch tree.
 */
const PHASE = '58';
const PHASE_DIR = `${PHASE}-land-proof`;
const NODE_ID = `${PHASE}-01`;

/**
 * The ceiling on 1 case, ms.
 *
 * A bound is a MECHANISM and not a comment: this file spawns git, the engine and
 * a land gate several times, and a wedge with no bound has no verdict. Measured
 * on this machine the whole file runs in well under a quarter of this.
 */
const CASE_TIMEOUT_MS = 300000;

/**
 * The interpreter the engine needs.
 *
 * Probed once. When it is absent every case skips NAMING it, following the shape
 * `tests/fleet-probe.test.cjs:499` already uses for an unavailable dependency,
 * rather than inventing a pattern or failing for a reason that is not this
 * file's subject. A silent skip would be the defect this phase exists to stop,
 * so the reason carries the interpreter's name.
 */
const PYTHON_PROBE = spawnSync('python3', ['-c', 'pass'], { encoding: 'utf8' });
const SKIP_NO_PYTHON = (PYTHON_PROBE.error || PYTHON_PROBE.status !== 0)
  ? 'python3 is not runnable on this machine, and the vendored engine entrypoints are python3'
  : false;

/**
 * ─── THE BYTECODE THE ENGINE WRITES, AND WHY THE FIXTURE OWNS A COPY ─────────
 *
 * A REAL worker dispatch writes `ratchetcpython-<v>.pyc` beside the engine's
 * entrypoints, and no seam in this repository can stop it. REPRODUCED in
 * isolation while writing this file, and the cause is exact:
 * `ratchet-exec:715-722` spawns the auto-grant helper `ratchet-index` with a
 * SCRUBBED environment built from an allowlist of 6 names, and
 * `PYTHONDONTWRITEBYTECODE` is not 1 of them. `ratchet-index:24-29` imports the
 * kernel AS A LIBRARY, so the interpreter writes bytecode for it.
 *
 * It fires only on a REAL card, because that branch is gated on the work id
 * matching `[A-Za-z0-9]+`, which a hex work id does and a hyphenated slug does
 * not. That is why the slug arm below leaves its engine copy clean and the
 * landing arm does not, and it is the same predicate that already explains the
 * auto-grant line in `CONTROL-PLANE-PROOF.md` step 5.
 *
 * The vendored tree may not be modified, so the fix is upstream's or a recorded
 * divergence, and it is FILED rather than reached for. What this file owes the
 * suite is that the artifact never lands in the REPOSITORY's copy: 5 guards
 * assert that tree carries no bytecode, and 1 of them runs CONCURRENTLY with
 * this file. So each fixture runs its own copy of the engine and the last case
 * asserts both halves: the repository's tree is untouched, and the fixture's
 * copy carries the artifact, which is what shows the isolation is doing the work
 * rather than the defect having quietly gone away.
 */
const BYTECODE_PRESENT_AT_START = fs.existsSync(path.join(VENDOR_BIN, BYTECODE_DIR));
/**
 * The artifact's name, OBSERVED rather than derived.
 *
 * The kernel's source file carries no extension, so the interpreter's cache name
 * comes out as `ratchetcpython-<v>.pyc` here rather than the dotted form the
 * usual rule would predict. The separator is optional in the pattern because the
 * name is an implementation detail of the interpreter.
 */
const KERNEL_BYTECODE = /^ratchet\.?cpython-\d+\.pyc$/;

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-land-proof-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
  // NOTHING is cleaned up under the repository's vendored tree, deliberately.
  // Nothing in this file writes there, and a cleanup here would let a future
  // regression that DID write there pass unnoticed.
});

function git(cwd, ...args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/**
 * Run `fn` with the fixture's environment in force, then restore it.
 *
 * Both default seams read `process.env`, so a value that lives only in a child's
 * explicit environment never reaches them.
 *
 * ─── WHY THIS IS NOT A PLAIN try/finally, WHICH IS WHAT IT WAS ───────────────
 *
 * `try { return fn(); } finally { restore(); }` restores the moment `fn` RETURNS
 * ITS PROMISE, not when the promise settles. Wrapping an async driver in that
 * shape therefore rewinds the environment while the run is still going, and the
 * rest of the run reads whatever the machine happens to carry.
 *
 * That is not a hypothetical. Written that way, this file's own wiring arm put
 * the fixture PATH back after the FIRST worker and the engine then probed the
 * real machine for an agent on every later attempt, which is precisely the real
 * spend this file exists to avoid, produced by the harness rather than by the
 * subject. So a thenable is awaited before the restore, and the restore still
 * runs on the throwing path.
 */
function withEnv(overrides, fn) {
  const before = {};
  for (const key of Object.keys(overrides)) before[key] = process.env[key];
  const restore = () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  let result;
  try {
    for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    return result.then(
      (value) => { restore(); return value; },
      (err) => { restore(); throw err; },
    );
  }
  restore();
  return result;
}

/**
 * EVERY AGENT THE ENGINE KNOWS HOW TO DISPATCH TO.
 *
 * The worker seam passes no adapter flag, so the engine picks a lane by probing
 * PATH for an installed agent. Prefixing 1 stub makes the right answer likely
 * rather than certain, and "likely" is not a property to hold real money
 * against.
 *
 * Restricting the PATH to the directories holding the tools the chain needs was
 * tried first and REJECTED by measurement: on this machine a real agent lives in
 * the same directory as an interpreter the engine cannot run without, so the
 * restriction removed nothing. The answer that works is to SHADOW every name.
 * The fixture's directory is first on PATH and holds an entry for each of these,
 * so no ordering mistake and no restore bug can reach a real one, and the
 * shadowing is asserted by RUNNING each name rather than by reading a string.
 */
const AGENT_NAMES = ['claude', 'codex', 'gemini', 'wayland-core'];
/** Printed by a shadow so an absent binary can never be mistaken for a shadowed one. */
const SHADOW_MARKER = 'land proof shadow';
/** Printed by the 1 agent that answers, so a real binary cannot be mistaken for it. */
const STUB_MARKER = 'land proof stub';

const SKIP_REASON = SKIP_NO_PYTHON;

const PLAN_TEXT = [
  '---',
  `phase: ${PHASE_DIR}`,
  'plan: 01',
  'type: execute',
  'wave: 1',
  'depends_on: []',
  'files_modified:',
  '  - src/land-proof-fixture.cts',
  'autonomous: true',
  '---',
  '',
  '<objective>A fixture plan. It exists so the scan emits exactly 1 node.</objective>',
  '',
].join('\n');

/**
 * A whole world: a bare remote, a clone pointed at it, a phase directory holding
 * exactly 1 plan, an engine home scoped inside the scratch tree, and the 2 stubs.
 *
 * The clone's `origin` really is the bare repository, because the manifest's
 * declared remote is checked against the repository's ACTUAL configured remote
 * and a mismatch refuses the whole verb with `REMOTES RED` and rolls back.
 */
function buildFixture({ label, suiteCmd }) {
  const sp = scratch(label);
  const bare = path.join(sp, 'remote.git');
  const seed = path.join(sp, 'seed');
  const repo = path.join(sp, 'repo');
  const home = path.join(sp, 'engine-home');
  const bin = path.join(sp, 'bin');
  const ghLog = path.join(sp, 'gh-calls.log');
  const agentLog = path.join(sp, 'agent-calls.log');

  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);

  fs.mkdirSync(seed, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'land-proof@example.invalid');
  git(seed, 'config', 'user.name', 'land proof fixture');
  fs.mkdirSync(path.join(seed, '.planning', 'phases', PHASE_DIR), { recursive: true });
  fs.writeFileSync(path.join(seed, '.planning', 'phases', PHASE_DIR, `${NODE_ID}-PLAN.md`), PLAN_TEXT);
  fs.writeFileSync(path.join(seed, 'README.md'), 'A land proof fixture. Built by the test, borrowed from nothing.\n');
  git(seed, 'add', '-A');
  const seeded = git(seed, 'commit', '-qm', 'chore: seed the land proof fixture');
  assert.equal(seeded.status, 0, `${P}: the fixture seed commit failed: ${seeded.stderr}`);
  git(seed, 'remote', 'add', 'origin', bare);
  assert.equal(git(seed, 'push', '-q', 'origin', 'main').status, 0, `${P}: the fixture seed push failed`);

  const cloned = spawnSync('git', ['clone', '-q', bare, repo], { encoding: 'utf8' });
  assert.equal(cloned.status, 0, `${P}: the fixture clone failed: ${cloned.stderr}`);
  git(repo, 'config', 'user.email', 'land-proof@example.invalid');
  git(repo, 'config', 'user.name', 'land proof fixture');
  // THE ENGINE THE FIXTURE RUNS IS A COPY, AND THE COPY IS THE WHOLE POINT.
  //
  // This was a symlink first, and a symlink is WRONG for a measured reason. A
  // real worker dispatch writes bytecode beside the entrypoints, see the
  // BYTECODE note above, and through a symlink "beside the entrypoints" IS the
  // real vendored tree. Observed: a full suite run turned
  // `tests/fleet-divergence.test.cjs` red, because the runner runs files
  // concurrently and that file asserts the real tree carries no bytecode while
  // this one was busy creating some in it. Cleaning up afterwards does not fix
  // that; it only makes the collision a race.
  //
  // A copy resolves it at the root: `HERE` inside the engine points into the
  // scratch tree, every artifact the engine writes lands in the scratch tree,
  // and the real vendored tree is never written to at all. It costs about 1
  // megabyte per fixture and it is what makes the last case in this file an
  // assertion rather than a hope.
  const engineDir = path.join(repo, 'ferrox-core', 'bin', 'vendor');
  fs.mkdirSync(engineDir, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet'), path.join(engineDir, 'ratchet'), { recursive: true });

  // The stubs. Both record what they were asked to do, so an arm can assert the
  // stub is what answered rather than assuming it.
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'gh'),
    ['#!/bin/sh', `echo "$@" >> ${ghLog}`, 'exit 0', ''].join('\n'),
  );
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  fs.writeFileSync(
    path.join(bin, 'claude'),
    [
      '#!/bin/sh',
      '# The engine probes an adapter with --version before it dispatches to it.',
      `if [ "$1" = "--version" ]; then echo "${STUB_MARKER}"; exit 0; fi`,
      `pwd >> ${agentLog}`,
      'echo "delivered by the land proof stub" > land-proof.txt',
      'git add -A >/dev/null 2>&1',
      'git commit -qm "feat: the land proof node delivers" >/dev/null 2>&1',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(path.join(bin, 'claude'), 0o755);
  // The shadows. Every other agent name the engine knows resolves HERE and
  // refuses, so `detect_tools` reports it absent and the dispatcher cannot pick
  // it. Refusing loudly rather than silently, so an assertion can tell a shadow
  // apart from a binary that simply is not installed on this machine.
  for (const shadowed of AGENT_NAMES.filter((n) => n !== 'claude')) {
    fs.writeFileSync(
      path.join(bin, shadowed),
      ['#!/bin/sh', `echo "${SHADOW_MARKER}" >&2`, 'exit 127', ''].join('\n'),
    );
    fs.chmodSync(path.join(bin, shadowed), 0o755);
  }

  const built = workgraphScan.buildWorkgraph({ cwd: repo, phase: PHASE });
  assert.ok(built.ok, `${P}: the fixture graph did not build: ${built.message}`);
  const nodes = (built.document.nodes ?? []).map((n) => String(n.id));
  assert.deepEqual(
    nodes, [NODE_ID],
    `${P}: the fixture must emit exactly 1 node, or every count below means something else`,
  );

  const stubPath = `${bin}${path.delimiter}${process.env.PATH}`;

  // THE PRECONDITION, RUN RATHER THAN ASSUMED. Every dispatch below reaches a
  // real agent and spends real money if this is wrong, so it is settled here,
  // before anything is minted, by INVOKING each name the engine can dispatch to.
  for (const agent of AGENT_NAMES) {
    const probe = spawnSync(agent, ['--version'], {
      encoding: 'utf8', env: { ...process.env, PATH: stubPath },
    });
    const seen = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
    assert.match(
      seen, agent === 'claude' ? new RegExp(STUB_MARKER) : new RegExp(SHADOW_MARKER),
      `${P}: ${agent} on this fixture's PATH is not this fixture's own file. Refusing to `
        + 'continue: a dispatch from here could reach a real agent.',
    );
  }

  const plane = withEnv({ PATH: stubPath, PYTHONDONTWRITEBYTECODE: '1' }, () => controlplane.ensureControlPlane({
    repoRoot: repo,
    home,
    phase: PHASE,
    nodes,
    suiteCmd,
    // The hook fence's warning is a real and wanted line in an operator's
    // terminal and pure noise in a suite. Swallowed here, and asserted where it
    // belongs, in `tests/fleet-controlplane.test.cjs`.
    warn: () => {},
    // FF-B493. Minting installs a git hook pack into the git COMMON directory,
    // so the plane now refuses to reach the engine until the caller NAMES the
    // repository it is about to change. `repo` here is a throwaway fixture this
    // file built under the OS temp directory a few lines above, which is the
    // only kind of repository anything in this suite is allowed to mint into.
    acknowledgeHooks: repo,
  }));

  const engineEnv = {
    ...process.env,
    PATH: stubPath,
    RATCHET_HOME: home,
    PYTHONDONTWRITEBYTECODE: '1',
  };

  return {
    sp,
    bare,
    repo,
    home,
    bin,
    ghLog,
    agentLog,
    plane,
    stubPath,
    engineEnv,
    suiteCmd,
    // The fixture's OWN copies. Every direct spawn below names these, so no arm
    // in this file executes the repository's vendored entrypoints.
    ratchet: path.join(engineDir, 'ratchet', 'bin', 'ratchet'),
    ratchetExec: path.join(engineDir, 'ratchet', 'bin', 'ratchet-exec'),
    engineBin: path.join(engineDir, 'ratchet', 'bin'),
  };
}

/** The card store, which is the value the engine itself reads. */
function cardFor(fixture, slug = NODE_ID) {
  const target = path.join(fixture.home, 'state', 'workcards.json');
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  return parsed.cards.find((c) => String(c.slug) === slug) ?? null;
}

/** The engine's own land journal, which names the station an abort died at. */
function landRuns(fixture) {
  const target = path.join(fixture.home, 'state', 'journals.json');
  if (!fs.existsSync(target)) return [];
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  return (parsed.runs ?? []).filter((r) => r.verb === 'land');
}

function ghCalls(fixture) {
  if (!fs.existsSync(fixture.ghLog)) return [];
  return fs.readFileSync(fixture.ghLog, 'utf8').split(/\r?\n/).filter((l) => l !== '');
}

/** Drive the worker through the engine's mock adapter, which reaches no model. */
function runWorker(fixture, cardArgument, mockCmd) {
  return spawnSync(
    fixture.ratchetExec,
    ['run', String(cardArgument), '--cli', 'mock', '--timeout', '120'],
    { encoding: 'utf8', cwd: fixture.sp, env: { ...fixture.engineEnv, RATCHET_MOCK_CMD: mockCmd } },
  );
}

/** The mock's stimulus: deliver a real change into the lane's OWN worktree. */
const MOCK_DELIVERS = [
  'cd "$RATCHET_WORKTREE"',
  'echo "delivered by the mock adapter" > land-proof.txt',
  'git add -A',
  'git commit -qm "feat: the land proof node delivers"',
].join(' && ');

/**
 * Run the land verb, WITH THE ARGV THE FLEET WOULD USE.
 *
 * ─── WHY THE FLAGS ARE NOT WRITTEN OUT HERE, WHICH IS WHAT THEY WERE ─────────
 *
 * This function hardcoded `['land', worktree, '--no-fuse']`. That made every
 * direct arm below a proof that the ENGINE journals a skip when handed the skip
 * flag, and no proof at all that the FLEET hands it. Measured: swapping the seam
 * at `src/fleet-landqueue.cts:800` from the skip flag to the CLAIMING flag left
 * this whole file at 7/7 green, because the argv it ran never came from the seam.
 *
 * So the argv comes from `landCommandSpec`, the same function
 * `defaultLandCommand` builds its child from, and the 2 flags are asserted here
 * by CONSTANT rather than by literal: present for the skip, absent for the claim.
 * A regression has to use those same constants to regress, so it cannot pass.
 */
function runLandVerb(fixture) {
  const card = cardFor(fixture);
  const spec = landqueue.landCommandSpec({
    worktree: String(card.worktree),
    repoRoot: fixture.repo,
  });

  assert.equal(
    spec.command, fixture.ratchet,
    `${P}: the seam's entrypoint is not this fixture's own engine copy, so this arm would run `
      + 'the repository\'s vendored tree',
  );
  assert.ok(
    spec.args.includes(landqueue.RATCHET_REVIEW_SKIP_FLAG),
    `${P}: the land argv carries no review SKIP flag. The engine requires exactly 1 of its 2 `
      + 'review flags and aborts without one, so this land would never have completed.',
  );
  assert.equal(
    spec.args.includes(landqueue.RATCHET_REVIEW_CLAIM_FLAG), false,
    `${P}: the land argv carries the review CLAIM flag. The fleet has no reviewer in its loop, `
      + 'so claiming one is a review nobody performed, recorded as though somebody had.',
  );

  return spawnSync(
    spec.command, spec.args,
    { encoding: 'utf8', cwd: fixture.sp, env: fixture.engineEnv },
  );
}

// ── the memoised fixtures. Each is built at most once. ──────────────────────

let CLEAN = null;
let FAILING = null;
let LOOP = null;

/**
 * What the wiring arm's run did with its PER RUN ENGINE COPY, observed at the
 * moment the run released it.
 *
 * The copy is deleted when the run ends, so the artifact CPython wrote into it
 * cannot be read afterwards. Recording it at the release seam is the only place
 * the evidence still exists, and the recorder DELEGATES to the real
 * `prepareRunEngine`: it observes the production path rather than replacing it.
 */
const LOOP_ENGINE_RELEASES = [];

/** The wiring arm's own summary, so section 6 can read what that run reported. */
let LOOP_SUMMARY = null;

function cleanFixture() {
  if (CLEAN === null) CLEAN = buildFixture({ label: 'clean', suiteCmd: 'echo fixture-suite-green' });
  return CLEAN;
}

function failingFixture() {
  if (FAILING === null) {
    FAILING = buildFixture({ label: 'failing', suiteCmd: 'echo fixture-suite-marker-xyz; exit 3' });
  }
  return FAILING;
}

function loopFixture() {
  if (LOOP === null) LOOP = buildFixture({ label: 'loop', suiteCmd: 'echo fixture-suite-green' });
  return LOOP;
}

// ── 1. the control plane ────────────────────────────────────────────────────

test(`${P}: the control plane mints exactly 1 OPEN card carrying a work id and a worktree`, {
  skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS,
}, () => {
  const f = cleanFixture();

  assert.deepEqual(Object.keys(f.plane.cards), [NODE_ID]);
  assert.deepEqual(f.plane.created, [NODE_ID], 'the card must be freshly minted, not found');
  assert.equal(f.plane.base.checked, true);
  assert.equal(f.plane.base.commits_ahead, 0, 'the fixture clone is level with its own remote');

  const mapped = f.plane.cards[NODE_ID];
  assert.match(mapped.work_id, /^[0-9a-f]{6,}$/, 'the work id is a content hash, not a slug');
  assert.notEqual(mapped.work_id, NODE_ID, 'and it is a DIFFERENT value from the node id');
  assert.ok(fs.existsSync(mapped.worktree), 'the minted worktree has to be on disk');
  assert.equal(
    git(mapped.worktree, 'branch', '--show-current').stdout.trim(), `feat/${NODE_ID}`,
    'the worktree is on its own branch, which is what makes it isolated',
  );

  const card = cardFor(f);
  assert.equal(card.status, 'open', 'a worker can only claim an OPEN card');

  const manifest = JSON.parse(fs.readFileSync(f.plane.manifest_path, 'utf8'));
  assert.equal(
    manifest.repos[controlplane.REPO_KEY].suite_cmd, f.suiteCmd,
    'the declared fixture suite has to reach the manifest, or the land would install a whole '
      + 'dependency tree inside a scratch worktree',
  );
  assert.notEqual(
    manifest.repos[controlplane.REPO_KEY].suite_cmd, controlplane.SUITE_CMD,
    'and it has to be the fixture one, or this file would be running the real gate by accident',
  );
});

// ── 2. THE NAMESPACE TRAP, watched refusing ─────────────────────────────────

test(`${P}: the node id is the card SLUG and dispatching it REFUSES, with the card still open`, {
  skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS,
}, () => {
  const f = cleanFixture();

  // The refusal must not be explicable by a closed card, or the arm would prove
  // nothing about namespaces. Read the state first.
  assert.equal(cardFor(f).status, 'open');

  const refused = runWorker(f, NODE_ID, 'true');
  assert.equal(
    refused.status, 2,
    `${P}: the slug must refuse. stdout: ${refused.stdout}\nstderr: ${refused.stderr}`,
  );
  assert.match(
    refused.stdout, /no OPEN card/,
    'and it refuses because the id it was given matches no card, which is the whole of the '
      + '32 failed workers of the first real dispatch in 1 assertion',
  );
});

// ── 3. THE CRITERION. One node reaches a closed landed card. ────────────────

test(`${P}: 1 node goes from no card to a card whose status is LANDED, end to end`, {
  skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS,
}, () => {
  const f = cleanFixture();
  const mapped = f.plane.cards[NODE_ID];

  const worker = runWorker(f, mapped.work_id, MOCK_DELIVERS);
  assert.equal(
    worker.status, 0,
    `${P}: the worker did not reach a clean delivery. stdout: ${worker.stdout}\nstderr: ${worker.stderr}`,
  );
  assert.match(worker.stdout, /verdict clean/, 'the same work id the slug arm was refused for');

  const landed = runLandVerb(f);
  assert.equal(
    landed.status, 0,
    `${P}: the land did not complete. stdout: ${landed.stdout}\nstderr: ${landed.stderr}`,
  );

  // THE PRODUCER IS THE AUTHORITY. This is read from the card store, which is
  // the value the engine itself reads, and never from the land's printed prose.
  const card = cardFor(f);
  assert.equal(
    card.status, 'landed',
    `${P}: the card is ${card.status}. The land path has still never completed.`,
  );
  assert.equal(typeof card.closed, 'string', 'a landed card carries the instant it closed');

  // The gate really ran its 4 stations, read from the engine's journal rather
  // than from a sentence: a land that skipped straight to a close would satisfy
  // the status assertion alone.
  const runs = landRuns(f);
  const steps = new Set(runs[runs.length - 1].steps.map((s) => s.label));
  assert.ok(steps.has('rebase'), 'station 1');
  assert.ok(steps.has('suite'), 'station 2, the gate that lets this run through');
  assert.ok(
    steps.has('review:skipped'),
    'station 3, recorded as a SKIP. The fleet has no reviewer, so a station recorded as '
      + '"review" would be a review nobody performed',
  );
  assert.equal(
    steps.has('review'), false,
    'and the claiming station must be absent, or the record carries a false green',
  );
  assert.ok(steps.has('pushed'), 'station 4');

  // No real pull request. The stub answered, and it answered locally.
  const calls = ghCalls(f);
  const created = calls.filter((c) => c.startsWith('pr create'));
  assert.equal(created.length, 1, `${P}: expected exactly 1 stubbed pull request creation`);
  assert.match(
    created[0], new RegExp(`-R ${f.sp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    'and it names a path inside this test\'s own scratch tree, never a remote anybody can see',
  );

  // The branch really reached the fixture remote, which is what a land is for.
  assert.equal(
    git(f.bare, 'rev-parse', '--verify', `feat/${NODE_ID}`).status, 0,
    'the branch has to exist on the fixture remote, or the push step did nothing',
  );
});

// ── 4. THE REQUIRED FAILING ARM. The gate is watched refusing. ──────────────

test(`${P}: a failing suite ABORTS the land at the suite station, and the card is NOT landed`, {
  skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS,
}, () => {
  const f = failingFixture();
  const mapped = f.plane.cards[NODE_ID];

  const worker = runWorker(f, mapped.work_id, MOCK_DELIVERS);
  assert.equal(
    worker.status, 0,
    `${P}: this arm needs a CLEAN delivery, so that the only thing that differs from the `
      + `landing arm is the suite. stdout: ${worker.stdout}`,
  );

  const landed = runLandVerb(f);
  assert.notEqual(landed.status, 0, `${P}: a failing suite must not produce a green land`);
  assert.match(landed.stdout, /suite FAILED/);
  assert.match(
    landed.stdout, /fixture-suite-marker-xyz/,
    'the fixture suite really ran, so the abort is the suite failing rather than the command '
      + 'never being found',
  );

  // WHERE it died, read from the engine's journal rather than inferred from an
  // exit code that every later station also produces.
  const runs = landRuns(f);
  const last = runs[runs.length - 1];
  assert.equal(
    last.outcome, 'aborted:suite',
    `${P}: the abort must be AT the suite station. It was ${last.outcome}.`,
  );
  const steps = new Set(last.steps.map((s) => s.label));
  assert.ok(steps.has('rebase'), 'it got past station 1');
  assert.equal(steps.has('suite'), false, 'and never completed station 2');
  assert.equal(steps.has('pushed'), false, 'so nothing was pushed');

  const card = cardFor(f);
  assert.notEqual(
    card.status, 'landed',
    `${P}: a land that aborted must NOT leave a landed card. This is the assertion that makes `
      + 'the green arm mean something.',
  );

  assert.deepEqual(
    ghCalls(f).filter((c) => c.startsWith('pr create')), [],
    'and no pull request is attempted, because the gate stopped before the push window',
  );
  assert.equal(
    git(f.bare, 'rev-parse', '--verify', `feat/${NODE_ID}`).status !== 0, true,
    'the branch never reaches the remote when the suite refuses',
  );
});

// ── 5. THE WIRING. The same chain through runLoop. ──────────────────────────

/**
 * WHAT THIS ARM COVERS AND WHAT IT DOES NOT, STATED RATHER THAN IMPLIED.
 *
 * Everything downstream of the preflight is REAL here: the graph, the control
 * plane's cards, the manager pass, the worker spawn through the default seam,
 * the land queue, the land verb and the fold. Only 2 things are supplied.
 *
 *   the preflight   injected as allowed. Its 3 checks create real worktrees,
 *                   race 2 concurrent stub lands and kill a child with an
 *                   uncatchable signal. Phase 19 built them and proves them in
 *                   its own batteries, and paying that cost again here would add
 *                   minutes to the suite to prove something already proven.
 *
 *   RATCHET_HOME    set on this process, because `runLoop` passes the scoped
 *                   home to the WORKER seam and not to the LAND seam. Observed
 *                   while writing this file: without it the land exits 1 with
 *                   `no manifest at <home>/state/workspace.json`, because the
 *                   engine falls back to the operator's personal control plane.
 *                   `defaultLandCommand` now honours a home it is GIVEN; the
 *                   remaining gap is that the driver does not give it one, which
 *                   is 1 line in a file this plan does not own. Filed, not
 *                   papered over.
 */
test(`${P}: runLoop with the REAL worker and land seams lands the node and drains`, {
  skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS,
}, async () => {
  const f = loopFixture();
  const mapped = f.plane.cards[NODE_ID];
  const logPath = path.join(f.sp, 'runlog', 'fleet-runlog.jsonl');
  const runId = 'land-proof-wiring';

  const summary = await withEnv(
    { PATH: f.stubPath, RATCHET_HOME: f.home, PYTHONDONTWRITEBYTECODE: '1' },
    () => loop.runLoop({
      cwd: f.repo,
      phase: PHASE,
      runId,
      logPath,
      capacity: 1,
      cards: f.plane.cards,
      ratchetHome: f.home,
      preflight: { dispatch_allowed: true, checks: [] },
      // The REAL copy, wrapped only so its state survives its own deletion. See
      // LOOP_ENGINE_RELEASES and the arm in section 6 that reads it.
      prepareEngine: (sourceRoot) => {
        const handle = loop.prepareRunEngine(sourceRoot);
        return {
          root: handle.root,
          release: () => {
            LOOP_ENGINE_RELEASES.push({
              source_root: sourceRoot,
              root: handle.root,
              bytecode: fs.existsSync(
                path.join(handle.root, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', BYTECODE_DIR),
              ),
            });
            handle.release();
          },
        };
      },
      write: () => {},
      writeErr: () => {},
    }),
  );

  LOOP_SUMMARY = summary;

  assert.equal(summary.stopped_by, 'drained', `${P}: the run must drain, not hit a bound`);
  assert.deepEqual(summary.parked, [], 'and nothing parks on a node that lands first time');
  assert.deepEqual(summary.blocked_on_human, []);
  assert.equal(summary.dispatched.length, 1, 'exactly 1 dispatch for exactly 1 node');

  // The card store again, because the driver's own return value is not the
  // authority on whether the engine closed anything.
  const card = cardFor(f);
  assert.equal(card.status, 'landed', `${P}: the wired run left the card ${card.status}`);

  // ─── THE REVIEW STATION, READ FROM THE JOURNAL OF A FLEET DRIVEN LAND ──────
  //
  // `landed` alone does not carry it. A land handed the CLAIMING flag reaches
  // `landed` too, and this arm is the only one in the file whose argv came from
  // the FLEET rather than from the file, so this is where the fleet's own choice
  // of flag becomes observable. Without it, swapping the seam's flag left the
  // whole file green and only `tests/fleet-landqueue.test.cjs` refused.
  const wiredSteps = new Set(landRuns(f).at(-1).steps.map((s) => s.label));
  assert.ok(
    wiredSteps.has('review:skipped'),
    `${P}: the FLEET driven land did not record a skipped review. The fleet has no reviewer in `
      + 'its loop, so this station is the honest record of what happened.',
  );
  assert.equal(
    wiredSteps.has('review'), false,
    `${P}: the FLEET driven land journalled a performed review. Nobody reviewed anything: this `
      + 'is the false green the phase exists to make impossible.',
  );

  // The folded record, which is the artifact phase 22 reads.
  const events = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l !== '').map((l) => JSON.parse(l));
  const record = runfold.foldRunRecord(events, { runId });
  assert.equal(record.false_green.landed, 1, 'the fold counts exactly 1 landed attempt');
  const node = record.nodes.find((n) => n.node_id === NODE_ID);
  assert.equal(node.attempts.length, 1);
  assert.equal(
    typeof node.attempts[0].land_completed_at, 'number',
    'and the attempt carries a completed land rather than a gate that ended in the air',
  );
  assert.deepEqual(record.rounds_per_artifact, { [NODE_ID]: 1 });

  // THE PLACEHOLDER MUST NOT HAVE BEEN USED. `worktreeOf` still falls back to
  // `path.join(cwd, nodeId)` for the injected stub cases, and a wiring
  // regression that quietly fell back to it would produce a run that looks fine
  // and lands nothing.
  assert.equal(
    fs.existsSync(path.join(f.repo, NODE_ID)), false,
    'the placeholder path does not even exist, so a run that used it could not have landed',
  );
  assert.equal(
    card.worktree, mapped.worktree,
    'the card that closed is the one the control plane minted',
  );

  // The stub is what answered, so no agent was paid. The engine runs an agent
  // inside a throwaway clone built BESIDE the lane's worktree, and DROPS the
  // clone afterwards, so the recorded directory is compared as a STRING against
  // the resolved worktree root rather than resolved itself: it no longer exists
  // by the time this reads it.
  const agentCwds = fs.readFileSync(f.agentLog, 'utf8').split(/\r?\n/).filter((l) => l !== '');
  assert.equal(agentCwds.length, 1, `${P}: expected exactly 1 stubbed agent invocation`);
  assert.equal(
    path.dirname(agentCwds[0]),
    fs.realpathSync(path.dirname(mapped.worktree)),
    'the agent ran beside the minted worktree, never beside the placeholder',
  );
});

test(`${P}: runLoop with an EMPTY card mapping refuses at the worker seam`, {
  skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS,
}, async () => {
  const f = loopFixture();

  // The seam refuses BY DESIGN rather than defaulting to the node id, and this
  // arm is what keeps that refusal from being softened later into a fallback.
  // A fallback would dispatch the slug, which is the exact shape that refused on
  // all 32 workers of the first real dispatch.
  await assert.rejects(
    () => withEnv(
      { PATH: f.stubPath, RATCHET_HOME: f.home, PYTHONDONTWRITEBYTECODE: '1' },
      () => loop.runLoop({
        cwd: f.repo,
        phase: PHASE,
        runId: 'land-proof-no-cards',
        logPath: path.join(f.sp, 'runlog', 'no-cards.jsonl'),
        capacity: 1,
        cards: {},
        ratchetHome: f.home,
        preflight: { dispatch_allowed: true, checks: [] },
        write: () => {},
        writeErr: () => {},
      }),
    ),
    (err) => {
      assert.match(String(err.message), /no work id for node/);
      assert.match(
        String(err.message), /work_id/,
        'the refusal names the value the engine actually matches on, so a reader is not left '
          + 'thinking the node id was wrong in some other way',
      );
      assert.match(String(err.message), new RegExp(NODE_ID));
      return true;
    },
  );
});

// ── 6. the engine this file ran is the engine that shipped ─────────────────

test(`${P}: a REAL dispatch leaves the tree it was pointed at carrying NO bytecode`, {
  skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS,
}, () => {
  // FF-B234. The wiring arm above drove a REAL worker through the default seam,
  // against `f.repo`. A driver that ran that tree's engine IN PLACE writes
  // bytecode beside its entrypoints, because `ratchet-exec` re-spawns its
  // auto-grant helper with a scrubbed 6 name environment that drops
  // PYTHONDONTWRITEBYTECODE. `f.repo` stands in for the repository a real fleet
  // is pointed at, and this is the assertion that says running the fleet must
  // not mutate the engine it runs.
  const f = loopFixture();
  const inPlace = path.join(f.engineBin, BYTECODE_DIR);
  assert.equal(
    fs.existsSync(inPlace), false,
    `${P}: the run's OWN engine tree carries bytecode at ${inPlace}, so the dispatch ran that `
      + 'tree in place rather than a per run copy.',
  );

  // HALF 2, AND WITHOUT IT HALF 1 IS VACUOUS. A driver that dispatched nothing
  // at all would leave the tree just as clean, so the COPY has to be shown as
  // the thing the interpreter actually loaded. Its bytecode is that evidence:
  // the auto-grant helper writes it beside the source it imported, and here that
  // source is the copy.
  assert.equal(
    LOOP_ENGINE_RELEASES.length, 1,
    `${P}: the wired run made ${LOOP_ENGINE_RELEASES.length} per run engine copies. Exactly 1 `
      + 'is the claim: 1 copy for the whole run, released when the run ends.',
  );
  const observed = LOOP_ENGINE_RELEASES[0];
  assert.equal(observed.source_root, f.repo, 'the copy is taken FROM the tree the run was pointed at');
  assert.equal(
    observed.bytecode, true,
    `${P}: the per run copy at ${observed.root} carries NO bytecode, so either no real dispatch `
      + 'happened or the interpreter loaded some other tree. Either makes half 1 prove nothing.',
  );

  // And the copy is somewhere neither the run's tree nor this repository can be
  // written through, which is the property the seam refuses without.
  for (const enclosing of [f.repo, REPO_ROOT]) {
    assert.equal(
      observed.root === enclosing || observed.root.startsWith(enclosing + path.sep), false,
      `${P}: the per run copy at ${observed.root} sits inside ${enclosing}, so writing to it `
        + 'writes to a tree a guard asserts is clean.',
    );
  }

  // The run REPORTS what it ran, so a caller reading only the summary can tell a
  // copy from the tree in place without reading this file's fixtures.
  assert.equal(
    LOOP_SUMMARY.engine_root, observed.root,
    'the summary names the engine the run executed, and it is the copy',
  );
});

test(`${P}: the repository's engine is untouched, and the fixture's copy carries the artifact`, {
  skip: SKIP_REASON, timeout: CASE_TIMEOUT_MS,
}, () => {
  // HALF 1. The repository's tree is exactly as this file found it.
  assert.equal(
    fs.existsSync(path.join(VENDOR_BIN, BYTECODE_DIR)), BYTECODE_PRESENT_AT_START,
    `${P}: a bytecode directory appeared beside the REPOSITORY's vendored entrypoints. Nothing `
      + 'in this file executes them: each fixture runs its own copy precisely so that a '
      + 'concurrent guard asserting this tree is clean cannot be turned red by this one.',
  );

  // HALF 2. THE ISOLATION IS DOING THE WORK, rather than the defect having gone
  // away. Without this the case above would pass just as well against a file
  // that never ran the engine at all.
  const f = cleanFixture();
  const fixtureBytecode = path.join(f.engineBin, BYTECODE_DIR);
  assert.equal(
    fs.existsSync(fixtureBytecode), true,
    `${P}: the fixture's own engine copy carries NO bytecode, so either the auto-grant helper `
      + 'stopped writing it or no real dispatch happened. Both make half 1 vacuous.',
  );
  const stray = fs.readdirSync(fixtureBytecode).filter((n) => !KERNEL_BYTECODE.test(n));
  assert.deepEqual(
    stray, [],
    `${P}: the fixture's engine copy carries bytecode this file cannot account for: `
      + `${stray.join(', ')}. The only artifact a fleet run explains is the kernel, imported as `
      + 'a library by the auto-grant helper spawned without the bytecode flag.',
  );

  const dirty = spawnSync(
    'git',
    // Tracked changes only. The untracked question is answered above, against
    // this file's own starting state; this is the stronger and simpler claim
    // that no vendored FILE was edited.
    ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=no', '--', 'ferrox-core/bin/vendor'],
    { encoding: 'utf8' },
  );
  assert.equal(dirty.status, 0, `${P}: could not read the vendored tree's status`);
  assert.equal(
    dirty.stdout.trim(), '',
    `${P}: a vendored file was MODIFIED while this file ran:\n${dirty.stdout}`,
  );
});
