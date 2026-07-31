'use strict';

/**
 * Phase 21 plan 02: the fleet backend rung, and the first test battery this
 * module has ever had.
 *
 * A repository wide search for `detectWorkflowBackend` returned 0 test files
 * before this one. That is 485 lines of shipped capability code whose fail
 * closed behaviour could not fire a test, so the 3 EXISTING backends are
 * covered here alongside the fourth.
 *
 * D8 item 1 and item 2 of the phase context govern this file. Two traps are
 * named and avoided:
 *
 * 1. A fleet ladder case whose probe reports everything present proves the
 *    happy path only. Every negative rung below is paired with the all open
 *    case directly above it, so each negative is known to be a REFUSAL rather
 *    than a permanent condition.
 * 2. A probe that is a mock asserting itself proves nothing about the live
 *    tree. The injected probe here covers the ladder ORDER; the genuinely
 *    unavailable proof is a real child process against a real scratch tree and
 *    lives in tests/claude-orchestration-failclosed.test.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const core = require('../ferrox-core/bin/lib/claude-orchestration.cjs');
const {
  detectWorkflowBackend,
  detectFleetBackend,
  emitWorkflowScript,
  emitFleetManifest,
  BACKEND_VALUES,
  FLEET_RUNTIME_ARTIFACTS,
  FLEET_INTERPRETER,
} = core;

const P = 'phase 21 plan 02';
const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-co-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

// ─── the injected probe ──────────────────────────────────────────────────────
//
// `missing` is the set of repository relative paths the probe reports ABSENT;
// every other path is reported present. `interpreter` is what the PATH half
// answers. Both halves count their calls, because a rung that never ran is a
// rung this file cannot claim to have covered.

function probeWith(opts) {
  const o = opts || {};
  const missing = new Set(o.missing || []);
  const calls = { pathExists: 0, interpreterOnPath: 0 };
  return {
    calls,
    probe: {
      pathExists(root, relPath) {
        calls.pathExists += 1;
        if (o.throwOnPath) throw new Error('probe exploded on ' + relPath);
        return !missing.has(relPath);
      },
      interpreterOnPath(name) {
        calls.interpreterOnPath += 1;
        if (o.throwOnInterpreter) throw new Error('probe exploded on ' + name);
        return o.interpreter !== false;
      },
    },
  };
}

/** A config slice whose every fleet rung is open. */
function openConfig(overrides) {
  return Object.assign(
    {
      'claude_orchestration.enabled': true,
      'claude_orchestration.execution_backend': 'fleet',
      'fleet.enabled': true,
    },
    overrides || {},
  );
}

function detectFleet(configOverrides, probeOpts) {
  const p = probeWith(probeOpts);
  const result = detectWorkflowBackend({
    runtimeId: 'codex',
    config: openConfig(configOverrides),
    projectRoot: '/nonexistent-scratch-root',
    probe: p.probe,
  });
  return { result, calls: p.calls };
}

// ─── the exported surface ────────────────────────────────────────────────────

test(`${P}: the backend enum carries exactly 4 values including fleet`, () => {
  const values = Array.from(BACKEND_VALUES).sort();
  assert.deepEqual(values, ['auto', 'fleet', 'inline', 'workflow'],
    'BACKEND_VALUES must be the closed 4 value enum');
});

test(`${P}: the code enum and the capability config enum carry the same 4 values`, () => {
  const capPath = path.join(REPO_ROOT, 'capabilities', 'claude-orchestration', 'capability.json');
  const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
  const declared = cap.config['claude_orchestration.execution_backend'].values;
  assert.ok(Array.isArray(declared) && declared.length > 0, 'the capability declares a non empty enum');
  assert.deepEqual(
    declared.slice().sort(),
    Array.from(BACKEND_VALUES).sort(),
    'the schema enum and the code enum must not drift',
  );
});

test(`${P}: FLEET_RUNTIME_ARTIFACTS is a non empty frozen list of repository relative paths`, () => {
  assert.ok(Array.isArray(FLEET_RUNTIME_ARTIFACTS), 'it is an array');
  assert.ok(FLEET_RUNTIME_ARTIFACTS.length > 0,
    'assert the count is non zero BEFORE asserting any property over the entries');
  assert.equal(Object.isFrozen(FLEET_RUNTIME_ARTIFACTS), true, 'it is frozen');
  for (const rel of FLEET_RUNTIME_ARTIFACTS) {
    assert.equal(typeof rel, 'string');
    assert.ok(rel.length > 0, 'no empty entry');
    assert.ok(!path.isAbsolute(rel), `${rel} must be repository relative`);
    assert.ok(!rel.includes('\\'), `${rel} must use forward slashes`);
  }
  assert.equal(new Set(FLEET_RUNTIME_ARTIFACTS).size, FLEET_RUNTIME_ARTIFACTS.length,
    'no duplicate entry, or arm C of the fail closed battery would test one twice and another never');
});

test(`${P}: FLEET_INTERPRETER names the interpreter the fleet capability declares`, () => {
  const fleetCap = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'fleet', 'capability.json'), 'utf8'),
  );
  const declaredText = JSON.stringify(fleetCap);
  assert.equal(typeof FLEET_INTERPRETER, 'string');
  assert.ok(FLEET_INTERPRETER.length > 0);
  assert.ok(declaredText.includes('Python 3'),
    'the fleet capability still declares the Python 3 precondition this constant tracks');
  assert.equal(FLEET_INTERPRETER, 'python3');
});

// ─── the fleet ladder, one case per rung ─────────────────────────────────────

test(`${P}: all rungs open resolves to the fleet backend`, () => {
  const { result, calls } = detectFleet();
  assert.deepEqual(result, { available: true, backend: 'fleet', reason: 'fleet_backend_active' });
  assert.ok(calls.interpreterOnPath > 0, 'the interpreter rung actually ran');
  assert.equal(calls.pathExists, FLEET_RUNTIME_ARTIFACTS.length,
    'every artifact was observed, not just the first');
});

test(`${P}: rung 1, the capability disabled resolves to inline`, () => {
  const { result } = detectFleet({ 'claude_orchestration.enabled': false });
  assert.equal(result.backend, 'inline');
  assert.equal(result.available, false);
  assert.equal(result.reason, 'capability_disabled');
});

test(`${P}: rung 2, an execution backend that is not fleet never reaches the fleet ladder`, () => {
  const p = probeWith();
  const result = detectFleetBackend({
    config: openConfig({ 'claude_orchestration.execution_backend': 'auto' }),
    probe: p.probe,
  });
  assert.equal(result.backend, 'inline');
  assert.equal(result.reason, 'backend_not_fleet');
  assert.equal(p.calls.pathExists, 0, 'no artifact was probed after the rung refused');
  assert.equal(p.calls.interpreterOnPath, 0, 'no interpreter was probed after the rung refused');
});

test(`${P}: rung 3, the fleet activation key off resolves to inline`, () => {
  const { result, calls } = detectFleet({ 'fleet.enabled': false });
  assert.equal(result.backend, 'inline');
  assert.equal(result.reason, 'fleet_capability_disabled');
  assert.equal(calls.pathExists, 0, 'first miss wins: the artifact rung did not run');
});

test(`${P}: rung 4, the interpreter absent resolves to inline and names it`, () => {
  const { result, calls } = detectFleet(undefined, { interpreter: false });
  assert.equal(result.backend, 'inline');
  assert.equal(result.reason, `fleet_interpreter_unavailable:${FLEET_INTERPRETER}`);
  assert.equal(calls.pathExists, 0, 'first miss wins: the artifact rung did not run');
});

test(`${P}: rung 5, each artifact absent on its own resolves to inline and names THAT artifact`, () => {
  assert.ok(FLEET_RUNTIME_ARTIFACTS.length > 0, 'non zero artifacts before iterating them');
  let observed = 0;
  for (const rel of FLEET_RUNTIME_ARTIFACTS) {
    const { result } = detectFleet(undefined, { missing: [rel] });
    assert.equal(result.backend, 'inline', `${rel} absent must resolve to inline`);
    assert.equal(result.available, false);
    assert.equal(result.reason, `fleet_artifact_missing:${rel}`,
      'the reason names the specific artifact so a reader learns what to fix');
    observed += 1;
  }
  assert.equal(observed, FLEET_RUNTIME_ARTIFACTS.length,
    'every artifact carried its own refusal; no single gate carries the ladder');
});

test(`${P}: a probe that throws resolves to inline rather than propagating`, () => {
  const a = detectFleet(undefined, { throwOnInterpreter: true });
  assert.equal(a.result.backend, 'inline');
  assert.equal(a.result.reason, 'fleet_probe_failed');

  const b = detectFleet(undefined, { throwOnPath: true });
  assert.equal(b.result.backend, 'inline');
  assert.equal(b.result.reason, 'fleet_probe_failed');
});

test(`${P}: the fleet ladder is independent of the Claude runtime rungs`, () => {
  // A fleet of worker command line interfaces runs as separate operating system
  // processes, so gating it behind the Workflow tool's runtime check would refuse
  // it on every other runtime for a reason that does not apply to it.
  for (const runtimeId of ['codex', 'gemini', 'unknown', undefined]) {
    const p = probeWith();
    const result = detectWorkflowBackend({
      runtimeId,
      config: openConfig(),
      projectRoot: '/nonexistent-scratch-root',
      probe: p.probe,
    });
    assert.equal(result.backend, 'fleet', `runtime ${String(runtimeId)} must still reach fleet`);
  }
});

test(`${P}: the default probe observes the live tree rather than a configuration value`, () => {
  // No probe injected. The default must do real filesystem work: an empty scratch
  // root holds none of the artifacts, so it refuses and names one of them.
  const emptyRoot = scratch('empty');
  const result = detectWorkflowBackend({
    runtimeId: 'claude',
    config: openConfig(),
    projectRoot: emptyRoot,
  });
  assert.equal(result.backend, 'inline');
  assert.ok(
    result.reason.startsWith('fleet_artifact_missing:') ||
    result.reason === `fleet_interpreter_unavailable:${FLEET_INTERPRETER}`,
    `the default probe observed the tree, got ${result.reason}`,
  );

  // The same call against the real repository root observes the artifacts present,
  // which is the pair that makes the empty root a refusal rather than a constant.
  const live = detectWorkflowBackend({
    runtimeId: 'claude',
    config: openConfig(),
    projectRoot: REPO_ROOT,
  });
  assert.notEqual(live.reason, result.reason,
    'the default probe distinguishes an empty tree from the real one');
});

// ─── the 3 pre-existing backends, whose fail closed behaviour had no coverage ──

test(`${P}: the workflow ladder still fails closed on every pre-existing rung`, () => {
  const capable = { dispatch: { nested: true, background: true } };
  const base = {
    runtimeId: 'claude',
    hostIntegration: capable,
    agentSdkVersion: '0.3.200',
    config: { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'workflow' },
  };
  assert.equal(detectWorkflowBackend(base).backend, 'workflow');
  assert.equal(detectWorkflowBackend(null).reason, 'capability_disabled');
  assert.equal(
    detectWorkflowBackend(Object.assign({}, base, { config: { 'claude_orchestration.enabled': false } })).reason,
    'capability_disabled');
  assert.equal(
    detectWorkflowBackend(Object.assign({}, base, { runtimeId: 'codex' })).reason,
    'runtime_not_claude');
  assert.equal(
    detectWorkflowBackend(Object.assign({}, base, {
      config: { 'claude_orchestration.enabled': true, 'claude_orchestration.execution_backend': 'inline' },
    })).reason,
    'backend_inline');
  assert.equal(
    detectWorkflowBackend(Object.assign({}, base, { hostIntegration: { dispatch: { nested: false, background: true } } })).reason,
    'workflow_tool_unavailable');
  assert.equal(
    detectWorkflowBackend(Object.assign({}, base, { agentSdkVersion: 'not-a-version' })).reason,
    'agent_sdk_version_unknown');
  assert.equal(
    detectWorkflowBackend(Object.assign({}, base, { agentSdkVersion: '0.3.1' })).reason,
    'agent_sdk_version_below_floor');
});

// ─── the fleet dispatch manifest ─────────────────────────────────────────────

function wavesFixture() {
  return [
    {
      id: 'wave-1',
      plans: [
        { id: '21-01', brief: 'the ask library', files_modified: ['scripts/fleet-ask.cjs'] },
        { id: '21-02', brief: 'the fleet backend', files_modified: ['src/claude-orchestration.cts'] },
        { id: '21-06', brief: 'a plan that collides with 21-01', files_modified: ['scripts/fleet-ask.cjs'] },
      ],
    },
    {
      id: 'wave-2',
      plans: [
        { id: '21-03', brief: 'the verdict', files_modified: ['scripts/parallelism-verdict.cjs'] },
      ],
    },
  ];
}

function emitInput(overrides) {
  return Object.assign({
    phaseDir: '.planning/phases/21-the-interface',
    waves: wavesFixture(),
    runId: 'run-21',
  }, overrides || {});
}

test(`${P}: the 2 emitters partition the same waves into the same stages`, () => {
  const script = emitWorkflowScript(emitInput());
  const manifest = emitFleetManifest(emitInput());
  assert.equal(script.ok, true, JSON.stringify(script));
  assert.equal(manifest.ok, true, JSON.stringify(manifest));
  assert.deepEqual(manifest.summary.stagesByWave, script.summary.stagesByWave,
    'one overlap rule, so a plan pair unsafe under one backend cannot be safe under the other');
  assert.equal(manifest.summary.waves, script.summary.waves);
  assert.equal(manifest.summary.plans, script.summary.plans);
  // The fixture exists to make the shared rule observable: 21-01 and 21-06 share a
  // file, so they must not cohabit a stage under either backend.
  const wave1 = manifest.summary.stagesByWave[0];
  assert.ok(wave1.length >= 2, 'the colliding pair forced a second stage');
  for (const stage of wave1) {
    assert.ok(!(stage.includes('21-01') && stage.includes('21-06')),
      'the colliding pair never share a stage');
  }
});

test(`${P}: the manifest is data naming waves, stages, plans and the run id`, () => {
  const r = emitFleetManifest(emitInput());
  assert.equal(r.ok, true);
  assert.equal(typeof r.manifest, 'object');
  assert.equal(typeof r.manifest.kind, 'string');
  assert.equal(r.manifest.runId, 'run-21');
  assert.equal(r.manifest.phaseDir, '.planning/phases/21-the-interface');
  assert.equal(r.manifest.waves.length, 2);
  assert.equal(r.manifest.waves[0].id, 'wave-1');
  assert.ok(r.manifest.waves[0].stages.length >= 2);
  const firstPlan = r.manifest.waves[0].stages[0].plans[0];
  assert.equal(typeof firstPlan.id, 'string');
  assert.equal(typeof firstPlan.brief, 'string');
  assert.ok(Array.isArray(firstPlan.files_modified));
  assert.equal(typeof r.script, 'undefined', 'the manifest is data, not a script string');
});

test(`${P}: identical input yields an identical manifest`, () => {
  const a = emitFleetManifest(emitInput());
  const b = emitFleetManifest(emitInput());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(JSON.stringify(a.manifest), JSON.stringify(b.manifest));
});

test(`${P}: both emitters refuse the same malformed inputs with the same reasons`, () => {
  const cases = [
    null,
    undefined,
    emitInput({ phaseDir: 'bad\nphase' }),
    emitInput({ phaseDir: '' }),
    emitInput({ runId: 'bad"run' }),
    emitInput({ runId: 'back\\slash' }),
    emitInput({ waves: [] }),
    emitInput({ waves: 'not-an-array' }),
    emitInput({ waves: [{ id: 'w', plans: [] }] }),
    emitInput({ waves: [{ id: 'w\nx', plans: [{ id: 'p', brief: 'b', files_modified: [] }] }] }),
    emitInput({ waves: [{ id: 'w', plans: [{ id: 'p\n', brief: 'b', files_modified: [] }] }] }),
    emitInput({ waves: [{ id: 'w', plans: [{ id: 'p', brief: 'b', files_modified: [''] }] }] }),
    emitInput({ waves: [{ id: 'w', plans: [{ id: 'p', brief: 'b' }] }] }),
    emitInput({
      waves: [{
        id: 'w',
        plans: [
          { id: 'dup', brief: 'b', files_modified: [] },
          { id: 'dup', brief: 'c', files_modified: [] },
        ],
      }],
    }),
  ];
  assert.ok(cases.length > 0, 'non zero refusal cases before asserting over them');
  let refused = 0;
  for (const input of cases) {
    const s = emitWorkflowScript(input);
    const m = emitFleetManifest(input);
    assert.equal(s.ok, false, `the workflow emitter must refuse ${JSON.stringify(input)}`);
    assert.equal(m.ok, false, `the fleet emitter must refuse ${JSON.stringify(input)}`);
    assert.equal(m.reason, s.reason, 'the 2 emitters refuse identical defects with an identical reason');
    refused += 1;
  }
  assert.equal(refused, cases.length);
});

test(`${P}: the capability declares no new subcommand`, () => {
  const cap = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'claude-orchestration', 'capability.json'), 'utf8'),
  );
  assert.deepEqual(cap.commands[0].subcommands, ['detect-backend', 'emit-workflow'],
    'the fleet backend rides the 2 existing subcommands, adding no registry surface');
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
