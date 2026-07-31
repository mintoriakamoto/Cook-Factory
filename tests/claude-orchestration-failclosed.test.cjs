'use strict';

/**
 * Phase 21 plan 02, SC2: the fail closed proof, with the fleet runtime GENUINELY
 * unavailable.
 *
 * D8 item 2 of the phase context is the whole reason this file is separate from
 * `tests/claude-orchestration.test.cjs`. That file drives the ladder ORDER with an
 * injected probe. This file proves the ladder is wired into the running system,
 * because a test that imports a library cannot see what `main` does. Every arm
 * below spawns `ferrox-core/bin/ferrox-tools.cjs` as a REAL CHILD PROCESS against a
 * REAL scratch tree, and asserts on the child's PARSED OUTPUT rather than on its
 * exit code: `doctor` at `ferrox-core/bin/ferrox-tools.cjs:1479` always exits 0,
 * which is this repository's own proof that an exit code from this command line
 * interface is not on its own evidence of anything.
 *
 * The 4 arms, and why each exists:
 *
 *   A  GENUINELY UNAVAILABLE. A scratch project asking for the fleet backend with
 *      NONE of the required artifacts on disk. Resolves to inline, names a specific
 *      missing artifact, and, the point of the whole plan, `emit-workflow` in the
 *      SAME tree still emits a working script. A backend switch that can break an
 *      existing build is worse than no switch.
 *   B  GENUINELY AVAILABLE. The same tree with every artifact planted as a real
 *      file and a real interpreter on a real PATH directory. Resolves to fleet.
 *      WITHOUT this arm, arm A is a permanent condition rather than a refusal, and
 *      the fail closed claim would be unfalsifiable.
 *   C  ONE AT A TIME. From arm B's tree, remove exactly 1 artifact, observe inline
 *      naming THAT artifact, restore. Driven by iterating the EXPORTED constant, so
 *      a future artifact is covered automatically and no single gate is silently
 *      carrying the whole ladder.
 *   D  THE INTERPRETER ALONE. Arm B's tree, every artifact present, interpreter
 *      scrubbed from PATH.
 *
 * The scrub is CONFIRMED before it is relied on, twice and in 2 different ways: a
 * direct scan of every directory on the scrubbed PATH finds no interpreter, and the
 * identical tree observed under the unscrubbed PATH reaches `fleet`. A scrub that
 * silently failed would make arm A pass for the wrong reason, which is this
 * project's recorded defect class.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');

// The constant is READ from the built lib, never transcribed here. Two copies of a
// list is how a new artifact ships with no coverage.
const { FLEET_RUNTIME_ARTIFACTS, FLEET_INTERPRETER } =
  require('../ferrox-core/bin/lib/claude-orchestration.cjs');

const P = 'phase 21 plan 02 fail closed';
const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-fc-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

// ─── the 2 PATH worlds, both synthetic so both are controlled ────────────────

/** A directory holding nothing. The interpreter cannot be resolved from it. */
function emptyBin() {
  return scratch('emptybin');
}

/** A directory holding a real, executable file named exactly like the interpreter. */
function interpreterBin() {
  const dir = scratch('bin');
  const exe = path.join(dir, FLEET_INTERPRETER + (process.platform === 'win32' ? '.EXE' : ''));
  fs.writeFileSync(exe, '#!/bin/sh\necho 3\n', 'utf8');
  fs.chmodSync(exe, 0o755);
  return dir;
}

function envWithPath(binDir) {
  const env = Object.assign({}, process.env);
  env.PATH = binDir;
  env.Path = binDir;
  return env;
}

/**
 * Confirm a PATH really holds no interpreter, by scanning it the way the probe
 * does rather than by trusting that assigning the variable was enough.
 */
function assertNoInterpreterOn(binDir, label) {
  const entries = fs.readdirSync(binDir);
  for (const name of entries) {
    assert.ok(
      name.toLowerCase() !== FLEET_INTERPRETER && !name.toLowerCase().startsWith(FLEET_INTERPRETER + '.'),
      `${label}: the scrubbed PATH directory must not hold ${FLEET_INTERPRETER}, found ${name}`,
    );
  }
}

// ─── the scratch project ─────────────────────────────────────────────────────

const FLEET_CONFIG = {
  claude_orchestration: { enabled: true, execution_backend: 'fleet' },
  fleet: { enabled: true },
};

/** A project tree asking for the fleet backend. `plant` decides arm A from arm B. */
function fleetProject(label, plant) {
  const root = scratch(label);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.planning', 'config.json'),
    JSON.stringify(FLEET_CONFIG, null, 2),
    'utf8',
  );
  if (plant) {
    assert.ok(FLEET_RUNTIME_ARTIFACTS.length > 0,
      'the exported artifact list is non empty before anything is planted from it');
    for (const rel of FLEET_RUNTIME_ARTIFACTS) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '// planted by ' + P + '\n', 'utf8');
    }
    // Observe the plant landed rather than assume the loop ran.
    let planted = 0;
    for (const rel of FLEET_RUNTIME_ARTIFACTS) {
      assert.equal(fs.existsSync(path.join(root, rel)), true, `${rel} was genuinely planted`);
      planted += 1;
    }
    assert.equal(planted, FLEET_RUNTIME_ARTIFACTS.length);
  } else {
    // Observe the absence rather than assume it.
    let absent = 0;
    for (const rel of FLEET_RUNTIME_ARTIFACTS) {
      assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} is genuinely absent`);
      absent += 1;
    }
    assert.equal(absent, FLEET_RUNTIME_ARTIFACTS.length,
      'every artifact was checked absent, not merely the first');
  }
  return root;
}

// ─── the child process seam ──────────────────────────────────────────────────

function runCli(root, args, binDir) {
  const run = spawnSync(process.execPath, [CLI].concat(args).concat(['--cwd', root]), {
    encoding: 'utf8',
    cwd: root,
    env: envWithPath(binDir),
  });
  return run;
}

function detect(root, binDir) {
  const run = runCli(root, ['claude-orchestration', 'detect-backend', '--runtime', 'claude'], binDir);
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch { parsed = null; }
  assert.notEqual(parsed, null,
    `the child must emit parseable output. stdout=${run.stdout} stderr=${run.stderr}`);
  return parsed;
}

const WAVES = {
  waves: [
    {
      id: 'wave-1',
      plans: [
        { id: '21-a', brief: 'plan A brief', files_modified: ['src/a.ts'] },
        { id: '21-b', brief: 'plan B brief', files_modified: ['src/b.ts'] },
        { id: '21-c', brief: 'plan C brief', files_modified: ['src/a.ts'] },
      ],
    },
  ],
};

function wavesFileIn(root) {
  const p = path.join(root, 'waves.json');
  fs.writeFileSync(p, JSON.stringify(WAVES), 'utf8');
  return p;
}

// ─── ARM A: genuinely unavailable, and inline still works ────────────────────

test(`${P}: ARM A, the fleet runtime genuinely absent resolves to inline and names the artifact`, () => {
  const root = fleetProject('armA', false);
  const bin = interpreterBin();

  // A2 first: with the interpreter present, the ARTIFACT rung is the one that
  // refuses, so the reason names a specific missing artifact.
  const artifactArm = detect(root, bin);
  assert.equal(artifactArm.backend, 'inline');
  assert.equal(artifactArm.available, false);
  assert.equal(
    artifactArm.reason,
    'fleet_artifact_missing:' + FLEET_RUNTIME_ARTIFACTS[0],
    'the reason names the specific artifact a reader must go and fix',
  );

  // A1: the same tree with the interpreter ALSO scrubbed. Everything the fleet
  // needs is genuinely gone and the result is still inline, never an error.
  const empty = emptyBin();
  assertNoInterpreterOn(empty, 'ARM A');
  const fullyAbsent = detect(root, empty);
  assert.equal(fullyAbsent.backend, 'inline');
  assert.equal(fullyAbsent.available, false);
  assert.equal(fullyAbsent.reason, 'fleet_interpreter_unavailable:' + FLEET_INTERPRETER,
    'first miss wins, so the interpreter rung answers before the artifact rung');

  // Record the observed reasons in the run output so the SUMMARY quotes an
  // observation rather than a green check.
  process.stdout.write(
    `# ARM A observed reasons: "${fullyAbsent.reason}" and "${artifactArm.reason}"\n`,
  );
});

test(`${P}: ARM A, inline emission in the SAME unavailable tree still produces a working script`, () => {
  const root = fleetProject('armA-inline', false);
  const empty = emptyBin();
  assertNoInterpreterOn(empty, 'ARM A inline');
  const wavesPath = wavesFileIn(root);

  const run = runCli(
    root,
    ['claude-orchestration', 'emit-workflow', '--waves', wavesPath, '--run-id', 'run-armA'],
    empty,
  );
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch { parsed = null; }
  assert.notEqual(parsed, null, `emit must parse. stdout=${run.stdout} stderr=${run.stderr}`);

  assert.equal(typeof parsed.script, 'string');
  assert.ok(parsed.script.length > 0, 'the emitted script is non empty');

  // Counters, never flags. A flag saying "fell back to inline" passes for an
  // implementation that reports a fallback and then does nothing.
  const agentCount = parsed.script.split('agent(').length - 1;
  assert.equal(agentCount, 3, 'one agent invocation per plan actually reached the script');
  const parallelCount = parsed.script.split('parallel(').length - 1;
  assert.equal(parallelCount, 2, 'the overlapping pair forced a second sequential stage');
  assert.ok(parsed.script.includes('ferrox-executor'), 'it composes the same executor as today');
  assert.ok(parsed.script.includes('isolation: "worktree"'), 'it composes the same isolation as today');
  assert.equal(parsed.summary.plans, 3);
  assert.deepEqual(parsed.summary.stagesByWave, [[['21-a', '21-b'], ['21-c']]]);
});

// ─── ARM B: genuinely available ──────────────────────────────────────────────

test(`${P}: ARM B, every artifact genuinely planted resolves to the fleet backend`, () => {
  const root = fleetProject('armB', true);
  const bin = interpreterBin();
  const result = detect(root, bin);
  assert.deepEqual(result, { available: true, backend: 'fleet', reason: 'fleet_backend_active' },
    'arm A is a refusal rather than a permanent condition');
  process.stdout.write(`# ARM B observed reason: "${result.reason}"\n`);
});

test(`${P}: ARM B, the fleet manifest emits in the same available tree`, () => {
  const root = fleetProject('armB-emit', true);
  const bin = interpreterBin();
  const wavesPath = wavesFileIn(root);
  const run = runCli(
    root,
    ['claude-orchestration', 'emit-workflow', '--waves', wavesPath, '--run-id', 'run-armB', '--backend', 'fleet'],
    bin,
  );
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch { parsed = null; }
  assert.notEqual(parsed, null, `emit must parse. stdout=${run.stdout} stderr=${run.stderr}`);
  assert.equal(typeof parsed.manifest, 'object');
  assert.equal(typeof parsed.script, 'undefined', 'the fleet backend emits data, not a script');
  // The SAME partition the inline/workflow emitter produced in arm A above.
  assert.deepEqual(parsed.summary.stagesByWave, [[['21-a', '21-b'], ['21-c']]],
    'one overlap rule across both backends, observed through the real command line interface');
  assert.equal(parsed.manifest.waves[0].stages.length, 2);
});

// ─── ARM C: one artifact removed at a time ───────────────────────────────────

test(`${P}: ARM C, removing exactly 1 artifact at a time resolves to inline and names it`, () => {
  const root = fleetProject('armC', true);
  const bin = interpreterBin();

  // The tree starts genuinely available, so every refusal below is caused by the
  // single removal and by nothing else.
  assert.equal(detect(root, bin).backend, 'fleet', 'arm C starts from an available tree');

  assert.ok(FLEET_RUNTIME_ARTIFACTS.length > 0, 'non zero artifacts before iterating them');
  let observed = 0;
  for (const rel of FLEET_RUNTIME_ARTIFACTS) {
    const target = path.join(root, rel);
    const saved = fs.readFileSync(target, 'utf8');
    fs.unlinkSync(target);
    assert.equal(fs.existsSync(target), false, `${rel} was genuinely removed before the run`);

    const result = detect(root, bin);
    assert.equal(result.backend, 'inline', `${rel} absent must resolve to inline`);
    assert.equal(result.available, false);
    assert.equal(result.reason, 'fleet_artifact_missing:' + rel,
      'the reason names the artifact that was actually removed');

    fs.writeFileSync(target, saved, 'utf8');
    assert.equal(detect(root, bin).backend, 'fleet',
      `${rel} restored must return the tree to available, so the next removal is isolated`);
    observed += 1;
  }
  assert.equal(observed, FLEET_RUNTIME_ARTIFACTS.length,
    'every entry in the exported constant carried its own refusal');
  assert.ok(observed >= 2, 'more than 1 gate exists, so no single gate carries the ladder');
});

// ─── ARM D: the interpreter alone ────────────────────────────────────────────

test(`${P}: ARM D, every artifact present but the interpreter scrubbed resolves to inline`, () => {
  const root = fleetProject('armD', true);
  const withInterpreter = interpreterBin();
  const without = emptyBin();
  assertNoInterpreterOn(without, 'ARM D');

  // The scrub is confirmed by OBSERVATION: the identical tree differs only by PATH.
  const available = detect(root, withInterpreter);
  assert.equal(available.backend, 'fleet', 'the tree is available when the interpreter is reachable');

  const scrubbed = detect(root, without);
  assert.equal(scrubbed.backend, 'inline');
  assert.equal(scrubbed.available, false);
  assert.equal(scrubbed.reason, 'fleet_interpreter_unavailable:' + FLEET_INTERPRETER);
  assert.notEqual(scrubbed.reason, available.reason,
    'the scrub genuinely changed the observation rather than passing for the wrong reason');
});

// ─── the fallback is unconditional, not fleet specific ───────────────────────

test(`${P}: a config asking for fleet never breaks the pre-existing backends`, () => {
  const root = fleetProject('armE', false);
  const empty = emptyBin();
  // An explicit override back to each pre-existing value must still answer, in the
  // same genuinely unavailable tree, with that backend's own ladder.
  const inlineRun = runCli(
    root,
    ['claude-orchestration', 'detect-backend', '--runtime', 'claude', '--backend', 'inline'],
    empty,
  );
  const inlineParsed = JSON.parse(inlineRun.stdout);
  assert.equal(inlineParsed.backend, 'inline');
  assert.equal(inlineParsed.reason, 'backend_inline');

  const workflowRun = runCli(
    root,
    ['claude-orchestration', 'detect-backend', '--runtime', 'claude', '--backend', 'workflow',
      '--agent-sdk-version', '0.3.200'],
    empty,
  );
  const workflowParsed = JSON.parse(workflowRun.stdout);
  assert.equal(workflowParsed.backend, 'workflow', 'the workflow ladder is untouched by the fleet rung');
  assert.equal(workflowParsed.available, true);
});

test(`${P}: the probe root is the PROJECT tree, not whatever directory the child happens to sit in`, () => {
  // Found by a surviving mutant: every arm above spawns with the child's working
  // directory EQUAL to --cwd, so a router probing process.cwd() instead of the
  // resolved project root passed all of them. This arm separates the 2 on purpose.
  //
  // THIS repository genuinely holds every fleet runtime artifact, so a router that
  // probed its own working directory would answer `fleet_backend_active` here. The
  // scratch project holds none, and it is the one --cwd names.
  const root = fleetProject('probe-root', false);
  const bin = interpreterBin();

  let presentInRepo = 0;
  for (const rel of FLEET_RUNTIME_ARTIFACTS) {
    if (fs.existsSync(path.join(REPO_ROOT, rel))) presentInRepo += 1;
  }
  assert.equal(presentInRepo, FLEET_RUNTIME_ARTIFACTS.length,
    'this arm only discriminates while the repository itself holds every artifact; '
    + `it holds ${presentInRepo} of ${FLEET_RUNTIME_ARTIFACTS.length}`);

  const run = spawnSync(
    process.execPath,
    [CLI, 'claude-orchestration', 'detect-backend', '--runtime', 'claude', '--cwd', root],
    { encoding: 'utf8', cwd: REPO_ROOT, env: envWithPath(bin) },
  );
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch { parsed = null; }
  assert.notEqual(parsed, null, `the child must emit parseable output. stdout=${run.stdout} stderr=${run.stderr}`);
  assert.equal(parsed.backend, 'inline');
  assert.equal(parsed.reason, 'fleet_artifact_missing:' + FLEET_RUNTIME_ARTIFACTS[0],
    'the ladder observed the tree --cwd named, not the directory the process was launched from');
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
