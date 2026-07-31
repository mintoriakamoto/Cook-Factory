'use strict';

/**
 * THE REPOSITORY A FLEET RUN ACTUALLY DRIVES.
 *
 * ─── WHY THIS FILE EXISTS: FF-B470, AND IT COST REAL MONEY ───────────────────
 *
 * The fourth precondition reads `fleet.adapters` out of
 * `<repoRoot>/.planning/config.json` and PROBES EVERY IDENTITY IT FINDS BY
 * SPAWNING IT WITH A REAL PROMPT. `runPreflight` was handed an empty bag by every
 * caller, so the adapters check fell through to the module level `REPO_ROOT` and
 * read THIS repository's roster whatever project the run was driving. This
 * repository declares a live paid roster of 3 vendors, so a run against ANOTHER
 * repository bought 1 call per identity, on accounts nobody in that run named,
 * with `cwd` pointed here. Measured before the fix: 6 real paid calls out of 1
 * suite run, 2 nonces across 3 vendors.
 *
 * ─── THE INSTRUMENT, AND WHY IT IS A COUNTING SHIM ───────────────────────────
 *
 * A test that proves a paid call is not made must not be able to make one. So the
 * arms below put a directory of COUNTING SHIMS at the head of the child's PATH:
 * an executable named for each adapter that appends its own name, its working
 * directory and its whole argv to a log and exits 1. It cannot reach a network
 * and it cannot spend. The verdict is then read off the log rather than asserted
 * from the shape of the code.
 *
 * `--version` is a FREE call and a prompt bearing argv is a PAID one, so the
 * counter classifies rather than merely counting: an adapter asked for its
 * version proves nothing about spend and an adapter handed a prompt is the defect.
 *
 * ─── AND WHY THE INSTRUMENT IS ITSELF DRIVEN ─────────────────────────────────
 *
 * An arm that asserts 0 paid calls passes just as well when the shim was never
 * reachable, the child never ran, or the probe seam was never touched. That is a
 * guard that cannot fire, which is the exact defect this milestone keeps finding
 * in its own guards. So the first arm drives a probe THROUGH the shim and asserts
 * the log records it. The zero below is a zero that was seen to be capable of
 * being non zero.
 *
 * ─── FF-B471 AND FF-B472 ─────────────────────────────────────────────────────
 *
 * The same entrypoint could only ever drive THIS repository, because it read no
 * `--repo`, no key and no suite command while every library beneath it had taken
 * those since phase 19. And `--verify-post-land` was opt in, so the common run
 * left its own false green rate UNDEFINED rather than measured. Both are wired
 * here, and both are asserted at the seam a caller actually reaches.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const loop = require('../scripts/fleet-loop.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const LOOP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fleet-loop.cjs');

/** The identities this repository declares, and therefore the ones to shim. */
const SHIMMED_ADAPTERS = ['claude', 'codex', 'gemini'];

/**
 * The ceiling on 1 child, ms. A wire test whose failure mode is a hang has no
 * verdict, so the bound is a mechanism rather than a comment.
 */
const CHILD_TIMEOUT_MS = 120000;

/**
 * The shim depends on the exec bit and on PATH resolving an extension-less
 * script, and Windows Git Bash honours neither. The measurement is a POSIX
 * measurement and says so rather than failing in 1 CI lane for a reason that has
 * nothing to do with the defect.
 */
const POSIX_ONLY = process.platform === 'win32'
  ? 'the counting shim needs a POSIX exec bit and PATH resolution of an extension-less script'
  : false;

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-repo-scope-${label}-`));
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

// ── the instrument ──────────────────────────────────────────────────────────

/**
 * A directory of counting shims, and the log they write.
 *
 * Every shim records its own identity, its working directory and its whole argv,
 * because all 3 are part of the finding: the calls were made with `cwd` pointed
 * at THIS repository, which is what proved the roster had been read from here.
 */
function makeAdapterShims(label) {
  const dir = scratch(`shim-${label}`);
  const log = path.join(dir, 'calls.log');
  for (const bin of SHIMMED_ADAPTERS) {
    const file = path.join(dir, bin);
    fs.writeFileSync(
      file,
      '#!/bin/sh\n'
        + `printf '%s\\t%s\\t%s\\n' '${bin}' "$PWD" "$*" >> ${JSON.stringify(log)}\n`
        + 'exit 1\n',
    );
    fs.chmodSync(file, 0o755);
  }
  return { dir, log };
}

/** Every invocation the shims recorded, as `{bin, cwd, argv}`. */
function readCalls(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [bin, cwd, ...rest] = line.split('\t');
      return { bin, cwd, argv: rest.join('\t') };
    });
}

/**
 * The FREE argvs. An adapter asked for its version or its help has been asked
 * nothing and has answered nothing, so it costs nothing and proves nothing.
 * Everything else carries a prompt and is a PAID call.
 */
const FREE_ARGVS = new Set(['--version', '-v', '--help', '-h', '']);

function paidCalls(log) {
  return readCalls(log).filter((call) => !FREE_ARGVS.has(call.argv.trim()));
}

/** The whole log, verbatim, for a failure message that can be read. */
function transcript(log) {
  const calls = readCalls(log);
  if (calls.length === 0) return '(the shim log is empty)';
  return calls.map((c) => `${c.bin}\t${c.cwd}\t${c.argv}`).join('\n');
}

/** Run a child with the shims at the HEAD of its PATH. */
function runChild(scriptPath, args, shimDir) {
  const env = { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}` };
  // The workstream config redirect is the OTHER way a child's roster can be
  // changed, and an arm that quietly inherited one would be measuring a fixture
  // instead of the repository. It is removed rather than trusted to be absent.
  delete env.FERROX_PROJECT;
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    timeout: CHILD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(
    result.signal,
    null,
    `the child was killed by ${result.signal} rather than exiting. stderr was:\n${result.stderr}`,
  );
  return result;
}

// ── 0: the instrument is real ───────────────────────────────────────────────

test('THE CONTROL: a probe driven through the counting shim IS recorded as a paid call', { skip: POSIX_ONLY }, () => {
  const shims = makeAdapterShims('control');
  const dir = scratch('control-driver');
  const script = path.join(dir, 'drive-probe.cjs');
  fs.writeFileSync(
    script,
    `'use strict';\n`
      + `const probe = require(${JSON.stringify(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-probe.cjs'))});\n`
      + `probe.runProbe({ identity: 'claude', nonce: 'FXP-control-nonce', cwd: process.cwd() });\n`,
  );

  const result = runChild(script, [], shims.dir);
  assert.equal(result.status, 0, `the control driver failed:\n${result.stderr}`);

  // WITHOUT THIS ARM every zero below is worthless: a shim that is never reached
  // records nothing, and so does a shim that is reached and works.
  const paid = paidCalls(shims.log);
  assert.equal(paid.length, 1, `the shim recorded no paid call, so it is not an instrument:\n${transcript(shims.log)}`);
  assert.equal(paid[0].bin, 'claude');
  assert.match(paid[0].argv, /FXP-control-nonce/, 'the recorded call carried no prompt');
});

// ── 1: FF-B470, the money ───────────────────────────────────────────────────

/**
 * A repository shaped fixture that declares its OWN adapter roster.
 *
 * The roster is declared EMPTY and explicitly so. An empty roster is what the
 * adapters check refuses on before its probe loop, so a correctly scoped run
 * reaches no adapter at all. A run scoped to the wrong repository reads 3
 * identities instead and spawns every one of them.
 */
function foreignProject(label, { roster = [], phase = '96' } = {}) {
  const root = scratch(label);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.planning', 'config.json'),
    `${JSON.stringify({ fleet: { adapters: roster } }, null, 2)}\n`,
  );
  const phaseDir = path.join(root, '.planning', 'phases', `${phase}-foreign`);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(phaseDir, 'NOTES.md'),
    '# fixture\n\nA phase directory with no plans, so the graph is empty.\n',
  );
  return { root, phase };
}

/**
 * The harness: it reaches `main` with a real argv against a FOREIGN repoRoot,
 * and lets the adapters check run FOR REAL.
 *
 * It forwards whatever bag `main` hands its preflight runner rather than
 * replacing it, which is the whole point: the subject is what `main` threads.
 * The other 3 checks are stubbed because each cuts a worktree or races 2 child
 * processes and none of them is the question being asked.
 */
const ADAPTERS_HARNESS = `'use strict';
const fs = require('node:fs');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const loop = require(cfg.loopScript);
const green = (name) => ({ name, ok: true, observed: {}, refused_because: null });

loop.main({
  argv: cfg.argv,
  repoRoot: cfg.root,
  runPreflight: (deps) => loop.runPreflight({
    ...deps,
    checkBase: () => green('base'),
    checkSerializer: () => green('serializer'),
    checkReclaim: () => green('reclaim'),
  }),
  ensureControlPlane: () => ({ cards: {}, home: '' }),
  runLoop: async (opts) => ({
    run_id: 'run-scope',
    dispatch_allowed: opts.preflight.dispatch_allowed,
    preflight: opts.preflight,
    stopped_by: 'preflight_refused',
    passes: [], dispatched: [], parked: [], blocked_on_human: [],
  }),
  write: () => {},
  writeErr: () => {},
}).then(
  (code) => { process.stdout.write('HARNESS_EXIT:' + code + '\\n'); },
  (e) => { process.stderr.write('HARNESS_THREW: ' + (e && e.message) + '\\n'); process.exitCode = 70; },
);
`;

/**
 * Drive `main` against a foreign repository under the shims, and hand back both
 * what the child did and every adapter invocation it caused.
 *
 * `loopScript` is a parameter so the SAME arm can be pointed at a copy of the
 * unfixed driver, which is how the non zero half of this measurement was taken.
 */
function driveForeignPreflight(label, { loopScript = LOOP_SCRIPT, argv } = {}) {
  const shims = makeAdapterShims(label);
  const project = foreignProject(`${label}-project`);
  const dir = scratch(`${label}-harness`);
  const script = path.join(dir, 'harness.cjs');
  const cfgPath = path.join(dir, 'cfg.json');
  fs.writeFileSync(script, ADAPTERS_HARNESS);
  fs.writeFileSync(cfgPath, JSON.stringify({
    loopScript,
    root: project.root,
    argv: argv ?? [project.phase, '--run', '--raw'],
  }));

  const result = runChild(script, [cfgPath], shims.dir);
  return { result, shims, project };
}

test('a preflight scoped to ANOTHER repository makes ZERO paid adapter calls', { skip: POSIX_ONLY }, (t) => {
  const driven = driveForeignPreflight('foreign-run');

  // The child reached the end of `main` rather than dying somewhere before the
  // adapters check, which would make an empty log a lie.
  assert.match(
    driven.result.stdout,
    /HARNESS_EXIT:/,
    `the harness never returned from main:\n${driven.result.stderr}`,
  );

  const paid = paidCalls(driven.shims.log);
  t.diagnostic(`shim recorded ${readCalls(driven.shims.log).length} invocation(s)`);
  assert.deepEqual(
    paid, [],
    'a run driving ANOTHER repository spawned an adapter with a prompt. That is a real, paid call '
      + 'on an account nobody in this run named. The shim recorded:\n'
      + transcript(driven.shims.log),
  );
});

test('the foreign roster is what was read: the fixture declares 0 adapters and this repository declares 3', () => {
  const project = foreignProject('roster-read');

  // The DISCRIMINATOR for the arm above. Both halves are needed: if the fixture
  // resolved to the same roster as this repository, a zero would prove only that
  // the 2 rosters agreed rather than that the run was scoped correctly.
  assert.deepEqual(loop.readAdapterRoster(project.root), []);
  assert.ok(
    loop.readAdapterRoster(REPO_ROOT).length > 0,
    'this repository declares no roster, so the mis-scoped run had nothing to spend on and this '
      + 'whole file measures nothing. Re-point it at a repository that declares one.',
  );
});

test('runPreflight hands the run\'s repoRoot to BOTH repo scoped checks', async () => {
  const seen = { base: null, adapters: null };
  const green = (name) => ({ name, ok: true, observed: {}, refused_because: null });

  await loop.runPreflight({
    repoRoot: path.join(os.tmpdir(), 'ferrox-scope-subject'),
    checkBase: (deps) => { seen.base = deps.repoRoot; return green('base'); },
    checkSerializer: () => green('serializer'),
    checkReclaim: () => green('reclaim'),
    checkAdapters: (deps) => { seen.adapters = deps.repoRoot; return green('adapters'); },
  });

  assert.equal(seen.base, path.join(os.tmpdir(), 'ferrox-scope-subject'));
  assert.equal(seen.adapters, path.join(os.tmpdir(), 'ferrox-scope-subject'));
});

test('an explicit per check repoRoot still wins, so a fixture can drive 1 check alone', async () => {
  let observed = null;
  const green = (name) => ({ name, ok: true, observed: {}, refused_because: null });
  const own = path.join(os.tmpdir(), 'ferrox-scope-override');

  await loop.runPreflight({
    repoRoot: path.join(os.tmpdir(), 'ferrox-scope-run'),
    adapters: { repoRoot: own },
    checkBase: () => green('base'),
    checkSerializer: () => green('serializer'),
    checkReclaim: () => green('reclaim'),
    checkAdapters: (deps) => { observed = deps.repoRoot; return green('adapters'); },
  });

  assert.equal(observed, own);
});

test('the PREFLIGHT branch is scoped too, not only the dispatch branch', async () => {
  const project = foreignProject('preflight-branch');
  let bag = null;

  const code = await loop.main({
    argv: [project.phase],
    repoRoot: project.root,
    runPreflight: async (deps) => {
      bag = deps;
      return {
        checks: loop.CHECK_NAMES.map((n) => ({ name: n, ok: true, observed: {}, refused_because: null })),
        check_names: [...loop.CHECK_NAMES],
        dispatch_allowed: true,
      };
    },
    write: () => {},
    writeErr: () => {},
  });

  assert.equal(code, 0);
  assert.equal(bag.repoRoot, project.root);
});

// ── 2: FF-B471, the cross repo flags ────────────────────────────────────────

/** A real git repository, because `--repo` refuses anything that is not one. */
function gitProject(label, opts = {}) {
  const project = foreignProject(label, opts);
  const git = (args) => spawnSync('git', args, { cwd: project.root, encoding: 'utf8' });
  const init = git(['init', '-q', '-b', 'main']);
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  return project;
}

/**
 * Drive `main` and capture what it threaded, without minting anything.
 *
 * `ensureControlPlane` and `runLoop` are both injected, so the arms observe the
 * VALUES that reach the 2 seams that already accepted them rather than the
 * side effects of a real plane.
 */
async function captureThreading(argv, project, extra = {}) {
  const seen = { ensure: [], drive: [], err: '', out: '' };
  const code = await loop.main({
    argv,
    repoRoot: project.root,
    runPreflight: async () => ({
      checks: loop.CHECK_NAMES.map((n) => ({ name: n, ok: true, observed: {}, refused_because: null })),
      check_names: [...loop.CHECK_NAMES],
      dispatch_allowed: true,
    }),
    ensureControlPlane: (input) => { seen.ensure.push(input); return { cards: {}, home: '' }; },
    runLoop: async (opts) => {
      seen.drive.push(opts);
      return {
        run_id: 'run-threading',
        dispatch_allowed: true,
        preflight: opts.preflight,
        stopped_by: 'drained',
        passes: [], dispatched: [], parked: [], blocked_on_human: [],
      };
    },
    write: (s) => { seen.out += s; },
    writeErr: (s) => { seen.err += s; },
    ...extra,
  });
  return { code, ...seen };
}

test('--repo names the repository the whole run drives', async () => {
  const target = gitProject('repo-flag');
  const here = foreignProject('repo-flag-fallback');

  // `repoRoot` in the bag is the FALLBACK, and the flag must beat it. Otherwise
  // the flag would be honoured only where nothing else supplied a root.
  const seen = await captureThreading([target.phase, '--run', '--raw', `--repo=${target.root}`], here);

  assert.equal(seen.code, 0);
  assert.equal(seen.ensure.length, 1);
  assert.equal(seen.ensure[0].repoRoot, target.root);
  assert.equal(seen.drive[0].cwd, target.root);
});

test('a --repo that does not exist REFUSES and never falls back', async () => {
  const here = gitProject('repo-missing-fallback');
  const absent = path.join(scratch('repo-missing'), 'no-such-repository');

  await assert.rejects(
    () => captureThreading([here.phase, '--run', `--repo=${absent}`], here),
    (e) => {
      assert.match(e.message, /no such path exists/);
      assert.match(e.message, /REFUSES rather than falling back/);
      // The message names the path it refused, so the operator can see the typo.
      assert.ok(e.message.includes(absent), 'the refusal did not name the path it refused');
      return true;
    },
  );
});

test('a --repo that exists but is NOT a git repository REFUSES', async () => {
  const here = gitProject('repo-notgit-fallback');
  // Deliberately NOT `gitProject`: a directory that is real and is not a repo.
  const plain = foreignProject('repo-notgit');

  await assert.rejects(
    () => captureThreading([here.phase, '--run', `--repo=${plain.root}`], here),
    (e) => {
      assert.match(e.message, /is not a git repository/);
      assert.match(e.message, /REFUSES rather than falling back/);
      return true;
    },
  );
});

test('an EMPTY --repo refuses rather than being treated as absent', async () => {
  const here = gitProject('repo-empty');
  await assert.rejects(
    () => captureThreading([here.phase, '--run', '--repo='], here),
    /--repo needs a path and was given an empty one/,
  );
});

test('--repo without --repo-key derives a key, and it is NOT the shipped literal', async () => {
  const target = gitProject('repo-derived-key');
  const seen = await captureThreading(
    [target.phase, '--run', '--raw', `--repo=${target.root}`], target,
  );

  const key = seen.ensure[0].repoKey;
  assert.equal(typeof key, 'string');
  assert.notEqual(key, 'core', 'the derived key collided with this repository\'s own manifest key');
  assert.equal(seen.drive[0].repoKey, key, 'the plane and the driver disagreed about the repo key');

  // DETERMINISTIC: the same path yields the same key, so a re-run reads back the
  // topology it wrote rather than minting a second one beside it.
  assert.equal(loop.deriveRepoKey(target.root), key);
  assert.equal(loop.deriveRepoKey(target.root), loop.deriveRepoKey(target.root));
});

test('2 repositories with the SAME basename derive DIFFERENT keys', () => {
  const a = path.join(scratch('same-name-a'), 'core');
  const b = path.join(scratch('same-name-b'), 'core');
  assert.notEqual(loop.deriveRepoKey(a), loop.deriveRepoKey(b));
});

test('an explicit --repo-key wins over the derived one', async () => {
  const target = gitProject('repo-explicit-key');
  const seen = await captureThreading(
    [target.phase, '--run', '--raw', `--repo=${target.root}`, '--repo-key=chosen'], target,
  );
  assert.equal(seen.ensure[0].repoKey, 'chosen');
  assert.equal(seen.drive[0].repoKey, 'chosen');
});

test('an EMPTY --repo-key refuses rather than being treated as absent', async () => {
  const here = gitProject('repo-key-empty');
  await assert.rejects(
    () => captureThreading([here.phase, '--run', '--repo-key='], here),
    /--repo-key was given an empty value/,
  );
});

test('--suite declares the land gate command and reaches the control plane', async () => {
  const target = gitProject('suite-flag');
  const seen = await captureThreading(
    [target.phase, '--run', '--raw', `--repo=${target.root}`, '--suite=npm test'], target,
  );
  assert.equal(seen.ensure[0].suiteCmd, 'npm test');
});

test('WITH NONE OF THE 3 FLAGS nothing changes: no key, no suite, and today\'s root', async () => {
  const here = gitProject('flags-absent');
  const seen = await captureThreading([here.phase, '--run', '--raw'], here);

  // `undefined` rather than a value of our choosing, so both consumers keep the
  // destructuring defaults they ship with. A key invented here would rename the
  // manifest entry of every run that never asked for one.
  assert.equal(seen.ensure[0].repoKey, undefined);
  assert.equal(seen.ensure[0].suiteCmd, undefined);
  assert.equal(seen.ensure[0].repoRoot, here.root);
  assert.equal(seen.drive[0].repoKey, undefined);
  assert.equal(seen.drive[0].cwd, here.root);
});

// ── 3: FF-B472, the measurement is on by default ────────────────────────────

test('the post land verifier DEFAULTS to the declared suite command', async () => {
  const target = gitProject('verify-default');
  const seen = await captureThreading(
    [target.phase, '--run', '--raw', `--repo=${target.root}`, '--suite=npm test'], target,
  );

  assert.equal(typeof seen.drive[0].verifyPostLand, 'function', 'the run wired no verifier');
  assert.doesNotMatch(
    seen.err, /wired NO post land verifier/,
    'a run that adopted its declared suite still warned that it had wired nothing',
  );
});

test('--verify-post-land still beats the suite derived default', async () => {
  const target = gitProject('verify-explicit');
  const seen = await captureThreading([
    target.phase, '--run', '--raw', `--repo=${target.root}`,
    '--suite=npm test', '--verify-post-land=node::--version',
  ], target);

  assert.equal(typeof seen.drive[0].verifyPostLand, 'function');
  assert.deepEqual(
    loop.chooseVerifyPostLand({ flagValue: 'node::--version', disabled: false, suite: 'npm test' }),
    { spec: { command: 'node', args: ['--version'] }, source: loop.VERIFY_POST_LAND_SOURCES.FLAG },
  );
});

test('--no-verify-post-land declines the verifier even when a suite was declared', async () => {
  const target = gitProject('verify-declined');
  const seen = await captureThreading([
    target.phase, '--run', '--raw', `--repo=${target.root}`,
    '--suite=npm test', '--no-verify-post-land',
  ], target);

  assert.equal(seen.drive[0].verifyPostLand, null, 'the opt out did not turn the verifier off');
  // The consequence is still stated: `unknown` is a legal member of the
  // classification vocabulary, so a reader cannot otherwise tell a declined
  // verifier from one that ran and abstained.
  assert.match(seen.err, /wired NO post land verifier/);
});

test('--verify-post-land and --no-verify-post-land together REFUSE', async () => {
  const here = gitProject('verify-contradiction');
  await assert.rejects(
    () => captureThreading(
      [here.phase, '--run', '--verify-post-land=node::--version', '--no-verify-post-land'], here,
    ),
    /contradict each other/,
  );
});

test('a suite command that needs a SHELL is not adopted, and the run says why', async () => {
  const target = gitProject('verify-unusable');
  const seen = await captureThreading([
    target.phase, '--run', '--raw', `--repo=${target.root}`,
    '--suite=npm ci --no-audit --no-fund && npm test',
  ], target);

  // NOT ADOPTED. Splitting that on whitespace would spawn `npm` with `&&` as an
  // argument and call whatever came back a measurement.
  assert.equal(seen.drive[0].verifyPostLand, null);
  assert.match(seen.err, /not expressible as a command and an argv array/);
  assert.match(seen.err, /wired NO post land verifier/);
  assert.equal(loop.suiteAsArgv('npm ci --no-audit --no-fund && npm test'), null);
});

test('a run that declares NO suite is byte identical to today: 1 warning, and it is the shipped one', async () => {
  const here = gitProject('verify-absent');
  const seen = await captureThreading([here.phase, '--run', '--raw'], here);

  assert.equal(seen.drive[0].verifyPostLand, null);
  // EXACT rather than a match: the extra line the unusable case prints must not
  // leak into the case that declared nothing, and an alarm about anything else
  // would still turn this red.
  assert.equal(seen.err, `${loop.VERIFY_POST_LAND_ABSENT_WARNING}\n`);
});

test('the source of the decision travels with it, because 3 of them look the same in the record', () => {
  const S = loop.VERIFY_POST_LAND_SOURCES;
  assert.equal(loop.chooseVerifyPostLand({ flagValue: null, disabled: false, suite: null }).source, S.NO_SUITE);
  assert.equal(loop.chooseVerifyPostLand({ flagValue: null, disabled: true, suite: 'npm test' }).source, S.DISABLED);
  assert.equal(loop.chooseVerifyPostLand({ flagValue: null, disabled: false, suite: 'a && b' }).source, S.SUITE_UNUSABLE);
  assert.equal(loop.chooseVerifyPostLand({ flagValue: null, disabled: false, suite: 'npm test' }).source, S.SUITE);

  // All 3 of the first ones wire nothing, which is exactly why the reason is
  // carried separately from the spec.
  assert.equal(loop.chooseVerifyPostLand({ flagValue: null, disabled: false, suite: null }).spec, null);
  assert.equal(loop.chooseVerifyPostLand({ flagValue: null, disabled: true, suite: 'npm test' }).spec, null);
  assert.equal(loop.chooseVerifyPostLand({ flagValue: null, disabled: false, suite: 'a && b' }).spec, null);
});

test('the usage text names the 4 new flags', () => {
  for (const flag of ['--repo=', '--repo-key=', '--suite=', '--no-verify-post-land']) {
    assert.ok(loop.USAGE.includes(flag), `the usage text never mentions ${flag}`);
  }
});

// ── 4: FF-B497, the hook pack consent ───────────────────────────────────────
//
// Minting runs `ratchet take`, which installs commit-msg, pre-commit and
// pre-push into the TARGET repository's shared git hooks directory. That
// directory is shared by every worktree of that repository, including one a human
// may be typing in, so the control plane refuses to mint until somebody names the
// repository they accept it in. `main` passed NO acknowledgement, so every real
// fleet run refused on every repository including this one.
//
// ─── THE ACCEPTANCE IS A COUNTER OF ENGINE INVOCATIONS ───────────────────────
//
// A refusal that is merely reported is worthless: what matters is that the engine
// which installs the hooks is never reached. So the arms below run the REAL
// `ensureControlPlane`, with only its engine seam wrapped and counted. An
// injected plane would assert that this file can write a stub.
//
// BOTH ARMS ARE REQUIRED. Without the second one a guard that refuses
// unconditionally passes the first, and a permanent no is not a consent gate.

/**
 * A scratch project the REAL control plane will accept as a subject.
 *
 * It needs 3 things the lighter fixtures above do not: a git remote, because the
 * engine's manifest requires one and refuses before it ever reaches the hook
 * gate; a phase carrying at least 1 plan, because a graph with 0 nodes mints 0
 * cards and the gate is SKIPPED rather than passed; and its own empty adapter
 * roster.
 */
function plannedGitProject(label, { phase = '93' } = {}) {
  const root = scratch(label);
  const repo = path.join(root, 'repo');
  const bare = path.join(root, 'origin.git');
  fs.mkdirSync(repo, { recursive: true });

  const git = (cwd, ...args) => {
    const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(out.status, 0, `git ${args.join(' ')} failed: ${out.stderr}`);
    return out;
  };
  assert.equal(
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { encoding: 'utf8' }).status, 0,
  );
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@ferrox.invalid');
  git(repo, 'config', 'user.name', 'ferrox fixture');
  git(repo, 'config', 'commit.gpgsign', 'false');

  fs.mkdirSync(path.join(repo, '.planning', 'phases', `${phase}-ack`), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.planning', 'config.json'),
    `${JSON.stringify({ fleet: { adapters: [] } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(repo, '.planning', 'phases', `${phase}-ack`, `${phase}-01-PLAN.md`), [
    '---', `phase: ${phase}-ack`, 'plan: 01', 'type: execute', 'wave: 1', 'depends_on: []',
    'files_modified:', '  - a.txt', 'autonomous: true', '---', '',
    '<tasks>', '<task type="auto">', '  <name>n</name>', '</task>', '</tasks>', '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture trunk\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture: the trunk');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');

  return { root, repo, phase };
}

/**
 * Drive `main` at the REAL control plane, counting every engine invocation.
 *
 * Only 3 seams are supplied to the plane and none of them is the gate: a scratch
 * engine home, a silenced warning channel, and the counted engine. The gate under
 * test is the shipped one.
 */
async function driveRealPlane(project, argvExtra) {
  const controlplane = require('../scripts/fleet-controlplane.cjs');
  const counted = { engineCalls: 0 };
  const home = path.join(project.root, 'ratchet-home');

  const run = async () => loop.main({
    argv: [project.phase, '--run', '--raw', `--repo=${project.repo}`, ...argvExtra],
    repoRoot: REPO_ROOT,
    runPreflight: async () => ({
      checks: loop.CHECK_NAMES.map((n) => ({ name: n, ok: true, observed: {}, refused_because: null })),
      check_names: [...loop.CHECK_NAMES],
      dispatch_allowed: true,
    }),
    ensureControlPlane: (input) => controlplane.ensureControlPlane({
      ...input,
      home,
      warn: () => {},
      suiteCmd: 'true',
      spawnEngine: () => {
        counted.engineCalls += 1;
        return { status: 0, stdout: '{}', stderr: '' };
      },
    }),
    runLoop: async (opts) => ({
      run_id: 'run-ack', dispatch_allowed: true, preflight: opts.preflight,
      stopped_by: 'drained', passes: [], dispatched: [], parked: [], blocked_on_human: [],
    }),
    write: () => {},
    writeErr: () => {},
  });

  return { counted, run, home };
}

test('WITHOUT --ack-hooks the run REFUSES and the engine is invoked EXACTLY 0 times', async () => {
  const project = plannedGitProject('ack-absent');
  const driven = await driveRealPlane(project, []);

  // THE REFUSAL PATH IS PROVEN FIRST. A count of 0 taken from a run that failed
  // for some unrelated reason, or never reached the plane at all, is not evidence
  // about this gate.
  await assert.rejects(driven.run, (e) => {
    assert.match(e.message, /REFUSING to mint cards/);
    assert.match(e.message, /commit-msg, pre-commit, pre-push/, 'the refusal names what it would install');
    assert.ok(e.message.includes(project.repo), 'the refusal names the repository it would install into');
    return true;
  });

  assert.equal(
    driven.counted.engineCalls, 0,
    'the engine that installs the hook pack was reached on an unacknowledged run',
  );
  // NOTHING WAS WRITTEN EITHER. A gate that refuses after creating the home has
  // already made the change it declined to make.
  assert.equal(fs.existsSync(driven.home), false, 'a refused run left an engine home behind');
});

test('WITH --ack-hooks the mint PROCEEDS and the engine is invoked MORE than 0 times', async () => {
  const project = plannedGitProject('ack-present');
  const driven = await driveRealPlane(project, ['--ack-hooks']);

  // The stub engine mints no real card, so the plane still refuses AFTERWARDS,
  // for a completely different and later reason. That is the discriminator: the
  // run got PAST the consent gate and reached the engine, which is what the
  // acknowledgement is for.
  await assert.rejects(driven.run, (e) => {
    assert.doesNotMatch(
      e.message, /REFUSING to mint cards/,
      'the acknowledgement was not honoured, so this gate is a permanent no',
    );
    return true;
  });

  assert.ok(
    driven.counted.engineCalls > 0,
    'the acknowledged run never reached the engine, so the gate refuses whatever it is told',
  );
});

test('the acknowledgement NAMES the repository the run drives, never the installation', async () => {
  const target = gitProject('ack-named');
  let seen;

  await captureThreading(
    [target.phase, '--run', '--raw', `--repo=${target.root}`, '--ack-hooks'], target,
  ).then((r) => { seen = r; });

  // Acknowledging A must never authorise B. With `--repo` the acknowledgement
  // follows the TARGET, so a run cannot consent to hooks in the installation and
  // have that consent silently spent somewhere else.
  assert.equal(seen.ensure[0].acknowledgeHooks, target.root);
  assert.notEqual(seen.ensure[0].acknowledgeHooks, REPO_ROOT);
});

test('WITHOUT the flag the acknowledgement is undefined, never true and never defaulted', async () => {
  const here = gitProject('ack-default');
  const seen = await captureThreading([here.phase, '--run', '--raw'], here);

  // `undefined` rather than `false`, because the plane's own resolver treats a
  // bare truthy value as blanket consent and refuses it. Defaulting this to
  // acknowledged in any form would turn a consent gate into a formality.
  assert.equal(seen.ensure[0].acknowledgeHooks, undefined);
});

test('the usage text names --ack-hooks and the operator channel', () => {
  assert.ok(loop.USAGE.includes('--ack-hooks'));
  assert.ok(loop.USAGE.includes('FERROX_FLEET_HOOK_ACK'));
});
