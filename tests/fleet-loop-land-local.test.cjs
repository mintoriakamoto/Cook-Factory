'use strict';

/**
 * THE LOCAL LANDER, REACHED FROM THE COMMAND LINE.
 *
 * ─── WHY THIS FILE EXISTS: FF-B501 ───────────────────────────────────────────
 *
 * `src/fleet-landqueue.cts` grew a second lander that merges the worker branch
 * into the trunk with git alone, no `gh` and no network, and it was UNREACHABLE.
 * `runLand` forwarded `landStrategy`, `branch`, `mainline` and `engineRoot`, and
 * no file outside the queue named any of them. So every fleet land still took the
 * GitHub shaped engine path that FF-B216 records as unable to merge at all: it
 * force pushes, opens a pull request, and stops there waiting for a human. A
 * lander nobody can select is a lander that does not exist, and a queue that
 * serializes perfectly and then cannot merge is a queue rather than a lander.
 *
 * ─── THE ACCEPTANCE IS A COUNTER, NEVER A FLAG ───────────────────────────────
 *
 * `summary.landed` being true passes for an implementation that reports landing
 * and merges nothing, which is precisely the false green the whole seam exists to
 * prevent. So the subject of the arm below is the FIXTURE TRUNK'S COMMIT COUNT,
 * read out of git before and after, plus the bytes of the file the branch carried
 * read back out of the trunk. Both are facts about the repository rather than
 * claims made by the driver.
 *
 * ─── AND THE FIXTURE IS A SCRATCH REPOSITORY, ALWAYS ─────────────────────────
 *
 * A land MOVES A TRUNK. Every repository below is built by this file inside the
 * platform temp directory, seconds before it is used, and removed afterwards. No
 * arm here names a repository it did not create.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const loop = require('../scripts/fleet-loop.cjs');
const landqueue = require('../ferrox-core/bin/lib/fleet-landqueue.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const LOOP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fleet-loop.cjs');

/** The ceiling on 1 driven run, ms. A hang has no verdict. */
const RUN_TIMEOUT_MS = 180000;

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-land-local-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here, following tests/fleet-loop-postland.test.cjs:68
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

/** 1 git command against a fixture, refusing loudly rather than returning junk. */
function git(cwd, ...args) {
  const proc = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return {
    status: proc.status,
    stdout: typeof proc.stdout === 'string' ? proc.stdout : '',
    stderr: typeof proc.stderr === 'string' ? proc.stderr : '',
  };
}

function gitOk(cwd, ...args) {
  const out = git(cwd, ...args);
  assert.equal(out.status, 0, `git ${args.join(' ')} failed in the fixture: ${out.stderr}`);
  return out.stdout.trim();
}

/** THE COUNTER. How many commits the trunk carries, read out of git. */
function trunkCommits(repo, mainline) {
  return Number(gitOk(repo, 'rev-list', '--count', mainline));
}

/** The bytes of 1 path AS THE TRUNK CARRIES THEM, never as the worktree left them. */
function fileOnTrunk(repo, mainline, relPath) {
  const out = git(repo, 'show', `${mainline}:${relPath}`);
  return out.status === 0 ? out.stdout : null;
}

/**
 * A scratch project: a git repository with a trunk, a scannable phase, and 1
 * worker branch carrying a real change in its own worktree.
 *
 * The worktree is created with plain `git worktree add`, not with the control
 * plane, because what the lander needs is a branch that exists and a worktree
 * that reports it. Minting a real card would drag in the engine, a hook pack and
 * a manifest, none of which is the question this file asks.
 */
function makeProject(label, { phase = '94', node = null, delivered = 'landed by the local lander\n' } = {}) {
  const root = scratch(label);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  gitOk(repo, 'init', '-q', '-b', 'main');
  gitOk(repo, 'config', 'user.email', 'fixture@ferrox.invalid');
  gitOk(repo, 'config', 'user.name', 'ferrox fixture');
  gitOk(repo, 'config', 'commit.gpgsign', 'false');

  // The roster this project declares. EMPTY and explicitly so: the adapters
  // precondition probes a non empty roster by spawning every identity in it with
  // a real prompt, and a suite must not buy its answers.
  fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.planning', 'config.json'),
    `${JSON.stringify({ fleet: { adapters: [] } }, null, 2)}\n`,
  );

  const nodeId = node ?? `${phase}-01`;
  const phaseDir = path.join(repo, '.planning', 'phases', `${phase}-land-local`);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, `${nodeId}-PLAN.md`), [
    '---',
    `phase: ${phase}-land-local`,
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified:',
    '  - delivered.txt',
    'autonomous: true',
    '---',
    '',
    '<tasks>',
    '<task type="auto">',
    '  <name>deliver</name>',
    '</task>',
    '</tasks>',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture trunk\n');
  gitOk(repo, 'add', '-A');
  gitOk(repo, 'commit', '-q', '-m', 'fixture: the trunk');

  // The worker branch, with a real change on it, in its own worktree. This is
  // what a minted card gives a node, built here with plain git.
  const branch = `feat/${nodeId}`;
  const worktree = path.join(root, 'wt');
  gitOk(repo, 'worktree', 'add', '-q', '-b', branch, worktree);
  fs.writeFileSync(path.join(worktree, 'delivered.txt'), delivered);
  gitOk(worktree, 'add', '-A');
  gitOk(worktree, 'commit', '-q', '-m', 'deliver: the increment');

  return { root, repo, worktree, branch, nodeId, phase, delivered };
}

/**
 * The harness: `main` with a real argv, in a child, with ONLY the seams that
 * would spend or mint injected.
 *
 * The LAND SEAM IS NOT INJECTED, which is the whole point. `landCommand` is left
 * absent so `defaultLandCommand` runs, reads the strategy this run threaded, and
 * either merges the trunk or does not. An injected land would prove that the
 * driver calls something, which is not the question.
 */
const HARNESS = `'use strict';
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const loop = require(cfg.loopScript);
const allowed = () => ({
  checks: loop.CHECK_NAMES.map((name) => ({ name, ok: true, observed: {}, refused_because: null })),
  check_names: [...loop.CHECK_NAMES],
  dispatch_allowed: true,
});

loop.main({
  argv: cfg.argv,
  repoRoot: cfg.installRoot,
  runPreflight: async () => allowed(),
  ensureControlPlane: () => ({
    home: cfg.ratchetHome,
    cards: { [cfg.nodeId]: { work_id: 'fixture-work-id', worktree: cfg.worktree } },
  }),
  runLoop: (opts) => loop.runLoop({
    ...opts,
    preflight: allowed(),
    runId: cfg.runId,
    repoKey: cfg.repoKey,
    tokenDir: cfg.tokenDir,
    projectionPath: cfg.projectionPath,
    clock: () => Date.now(),
    ttlMs: 3600000,
    heartbeatMs: 60,
    waitTickMs: 20,
    maxPasses: 30,
    landWaitTimeoutMs: 60000,
    // A worker that delivers cleanly. The change it "made" is already on the
    // branch, which is what a real worker would have committed in its worktree.
    spawnWorker: () => require('node:child_process').spawn(
      process.execPath, ['-e', 'process.exitCode = 0;'], { stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  }),
}).then(
  (code) => { process.stdout.write('HARNESS_EXIT:' + code + '\\n'); },
  (e) => { process.stderr.write('HARNESS_THREW: ' + (e && e.message) + '\\n'); process.exitCode = 70; },
);
`;

/**
 * Drive 1 whole run and hand back what the TRUNK did.
 *
 * `loopScript` is a parameter so the same arm can be pointed at the driver as it
 * was before the strategy was threaded, which is how the red half of this
 * measurement was taken. An acceptance arm that was never seen to fail proves
 * nothing about the change that made it pass.
 */
function driveLand(project, { loopScript = LOOP_SCRIPT, extraArgs = [], mainline = 'main' } = {}) {
  const logPath = path.join(project.root, 'fleet-runlog.jsonl');
  const cfgPath = path.join(project.root, 'harness.json');
  const harnessPath = path.join(project.root, 'harness.cjs');
  fs.writeFileSync(harnessPath, HARNESS);
  fs.writeFileSync(cfgPath, JSON.stringify({
    loopScript,
    installRoot: REPO_ROOT,
    nodeId: project.nodeId,
    worktree: project.worktree,
    ratchetHome: path.join(project.root, 'ratchet-home'),
    repoKey: `land-local/${project.nodeId}`,
    runId: `run-${project.nodeId}`,
    tokenDir: path.join(project.root, 'tokens'),
    projectionPath: path.join(project.root, 'board.json'),
    argv: [
      project.phase, '--run', '--raw',
      `--repo=${project.repo}`,
      `--log=${logPath}`,
      ...extraArgs,
    ],
  }));

  const before = trunkCommits(project.repo, mainline);
  const proc = spawnSync(process.execPath, [harnessPath, cfgPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(proc.signal, null, `the harness was killed by ${proc.signal}. stderr:\n${proc.stderr}`);
  assert.notEqual(proc.status, 70, `the harness threw:\n${proc.stderr}`);

  const events = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
    : [];

  return {
    proc,
    before,
    after: trunkCommits(project.repo, mainline),
    trunkFile: fileOnTrunk(project.repo, mainline, 'delivered.txt'),
    events,
    logPath,
  };
}

// ── the acceptance: a counter, not a flag ───────────────────────────────────

test('THE COUNTER: --land=local moves the fixture trunk and the content matches', { timeout: RUN_TIMEOUT_MS }, (t) => {
  const project = makeProject('counter');

  // The trunk starts with 1 commit and does NOT carry the delivered file.
  assert.equal(trunkCommits(project.repo, 'main'), 1);
  assert.equal(fileOnTrunk(project.repo, 'main', 'delivered.txt'), null);

  const run = driveLand(project, { extraArgs: ['--land=local'] });
  t.diagnostic(`trunk commits ${run.before} -> ${run.after}`);

  // ─── THE ACCEPTANCE ────────────────────────────────────────────────────────
  //
  // The branch commit and the merge commit both become reachable, so 1 becomes 3.
  // A driver that reported a land and merged nothing leaves this at 1, which is
  // exactly what the unwired driver did when this arm was first run.
  assert.ok(
    run.after > run.before,
    'the trunk did not move, so nothing was merged. A land that reports success and leaves the '
      + `trunk where it was is the false green this seam exists to remove. stderr:\n${run.proc.stderr}`,
  );
  assert.equal(run.after, 3, 'the branch commit and the merge commit are both reachable from the trunk');

  // AND THE CONTENT. A trunk that moved for some other reason is not a land.
  assert.equal(run.trunkFile, project.delivered, 'the trunk does not carry the bytes the branch delivered');

  // The merge really is a merge: 2 parents, the old trunk and the branch tip.
  const parents = gitOk(project.repo, 'rev-list', '--parents', '-n', '1', 'main').split(/\s+/);
  assert.equal(parents.length, 3, 'the trunk tip is not a 2 parent merge commit');
});

test('the land was recorded as landed in the run log, and the record agrees with git', { timeout: RUN_TIMEOUT_MS }, () => {
  const project = makeProject('recorded');
  const run = driveLand(project, { extraArgs: ['--land=local'] });

  const completed = run.events.filter((e) => e.kind === 'land_completed');
  assert.equal(completed.length, 1, `expected exactly 1 land_completed, got ${completed.length}`);
  assert.equal(completed[0].result, 'landed');

  // BOTH HALVES. The record alone is a claim; the trunk alone does not say the
  // run knew about it. A record that said landed while the trunk stood still is
  // the defect, and so is a moved trunk nobody wrote down.
  assert.equal(run.after, 3);
});

// ── the default is untouched ────────────────────────────────────────────────

test('WITHOUT --land the trunk does NOT move, because the default lander is unchanged', { timeout: RUN_TIMEOUT_MS }, () => {
  const project = makeProject('default-arm');
  const run = driveLand(project);

  // THE DISCRIMINATING ARM. Without it, the arm above passes for an
  // implementation that quietly made every land local, which would change the
  // behaviour of every existing caller.
  assert.equal(run.after, run.before, 'a run that named no lander merged anyway');
  assert.equal(fileOnTrunk(project.repo, 'main', 'delivered.txt'), null);
});

// ── the refusals ────────────────────────────────────────────────────────────

test('an unknown --land REFUSES and never falls back to the engine', () => {
  assert.throws(
    () => loop.parseLandStrategy('locl'),
    (e) => {
      assert.match(e.message, /is not a land strategy/);
      assert.match(e.message, /REFUSES rather than falling back/);
      return true;
    },
  );
});

test('the legal set is READ off the shipped table, so it cannot drift', () => {
  for (const strategy of Object.values(landqueue.LAND_STRATEGY)) {
    assert.equal(loop.parseLandStrategy(strategy), strategy);
  }
  // Absent is `undefined`, and the queue reads an absent strategy as the engine.
  assert.equal(loop.parseLandStrategy(null), undefined);
});

test('a --land=local that CANNOT merge refuses by name and leaves the trunk byte identical', { timeout: RUN_TIMEOUT_MS }, () => {
  const project = makeProject('conflict');

  // A conflicting change on the trunk itself, so the merge cannot be made.
  fs.writeFileSync(path.join(project.repo, 'delivered.txt'), 'the trunk wrote this instead\n');
  gitOk(project.repo, 'add', '-A');
  gitOk(project.repo, 'commit', '-q', '-m', 'trunk: a conflicting change');

  const tipBefore = gitOk(project.repo, 'rev-parse', 'main');
  const run = driveLand(project, { extraArgs: ['--land=local'] });

  // REFUSED, and the trunk is exactly where it was. Not merged with a marker in
  // it, not moved and then rolled back: untouched.
  assert.equal(gitOk(project.repo, 'rev-parse', 'main'), tipBefore, 'the trunk moved on a refused land');
  assert.equal(
    fileOnTrunk(project.repo, 'main', 'delivered.txt'), 'the trunk wrote this instead\n',
    'the trunk content changed on a refused land',
  );

  // A node whose land refuses is never landed, so it stays ready and is retried
  // until the park ceiling removes it. That is the existing park discipline and
  // not a defect, so the assertion is over EVERY attempt rather than over a count
  // this arm has no business pinning: not one of them may say `landed`.
  const completed = run.events.filter((e) => e.kind === 'land_completed');
  assert.ok(completed.length >= 1, 'the land seam was never reached, so nothing was refused');
  assert.deepEqual(
    completed.filter((e) => e.result === 'landed'), [],
    'a conflicting merge was reported as landed',
  );
});

test('--mainline names the trunk, and a run that names one lands into THAT branch', { timeout: RUN_TIMEOUT_MS }, () => {
  const project = makeProject('mainline');

  // A second trunk, forked from the first, so landing into it is observable
  // separately from landing into `main`.
  gitOk(project.repo, 'branch', 'release/next', 'main');
  const mainBefore = trunkCommits(project.repo, 'main');

  const run = driveLand(project, {
    extraArgs: ['--land=local', '--mainline=release/next'],
    mainline: 'release/next',
  });

  assert.equal(run.after, 3, 'the named trunk did not take the merge');
  assert.equal(run.trunkFile, project.delivered);
  // AND THE OTHER TRUNK IS UNTOUCHED, which is what makes the flag mean anything.
  assert.equal(trunkCommits(project.repo, 'main'), mainBefore, 'landing moved a trunk nobody named');
});

// ── the engine root split ───────────────────────────────────────────────────

test('the engine is copied from THIS installation, never from the repository being landed into', async () => {
  const project = makeProject('engine-split');
  const seen = { source: null, drive: null };

  await loop.main({
    argv: [project.phase, '--run', '--raw', `--repo=${project.repo}`, '--land=engine'],
    repoRoot: REPO_ROOT,
    runPreflight: async () => ({
      checks: loop.CHECK_NAMES.map((n) => ({ name: n, ok: true, observed: {}, refused_because: null })),
      check_names: [...loop.CHECK_NAMES],
      dispatch_allowed: true,
    }),
    ensureControlPlane: () => ({ cards: {}, home: '' }),
    runLoop: async (opts) => {
      seen.drive = opts;
      return {
        run_id: 'run-engine-split', dispatch_allowed: true, preflight: opts.preflight,
        stopped_by: 'drained', passes: [], dispatched: [], parked: [], blocked_on_human: [],
      };
    },
    write: () => {},
    writeErr: () => {},
  });

  // The 2 roots are DIFFERENT inputs and the run names both: the increment lands
  // in the target, the engine is read from the installation. A target project is
  // not required to vendor an engine at all.
  assert.equal(seen.drive.cwd, project.repo);
  assert.equal(seen.drive.engineSourceRoot, REPO_ROOT);
  assert.notEqual(seen.drive.engineSourceRoot, seen.drive.cwd);
  assert.equal(seen.source, null);
});

test('WITH NO --repo the engine source and the repository are the SAME value, exactly as today', async () => {
  const project = makeProject('engine-same');
  let drive = null;

  await loop.main({
    argv: [project.phase, '--run', '--raw'],
    repoRoot: project.repo,
    runPreflight: async () => ({
      checks: loop.CHECK_NAMES.map((n) => ({ name: n, ok: true, observed: {}, refused_because: null })),
      check_names: [...loop.CHECK_NAMES],
      dispatch_allowed: true,
    }),
    ensureControlPlane: () => ({ cards: {}, home: '' }),
    runLoop: async (opts) => {
      drive = opts;
      return {
        run_id: 'run-engine-same', dispatch_allowed: true, preflight: opts.preflight,
        stopped_by: 'drained', passes: [], dispatched: [], parked: [], blocked_on_human: [],
      };
    },
    write: () => {},
    writeErr: () => {},
  });

  assert.equal(drive.engineSourceRoot, project.repo);
  assert.equal(drive.engineSourceRoot, drive.cwd);
  // And no lander was named, so the queue keeps the engine default it has today.
  assert.equal(drive.landStrategy, undefined);
  assert.equal(drive.mainline, undefined);
});

test('the usage text names --land and --mainline', () => {
  for (const flag of ['--land=', '--mainline=']) {
    assert.ok(loop.USAGE.includes(flag), `the usage text never mentions ${flag}`);
  }
});
