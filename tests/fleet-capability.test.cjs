'use strict';

/**
 * Phase 18 plan 02: the fleet capability, its interpreter probe, and the claim
 * that the default execution path survives an absent interpreter.
 *
 * D5 is the whole design of this file. 2 of the arms below pass trivially on the
 * machine that wrote them unless they are driven deliberately:
 *
 * 1. An interpreter absent test run on a machine that HAS an interpreter proves
 *    nothing. So the probe is driven with an injected PATH pointing at an empty
 *    directory, AND the real command line interface is spawned as a child
 *    process with PATH scrubbed down to that same empty directory. Only the
 *    second arm can prove the default path does not depend on the interpreter,
 *    because only the second arm runs the real code with no interpreter reachable.
 *
 * 2. An inactive formatter test that asserts falsy passes on an empty string.
 *    Every inactive assertion below is `=== null`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const fleet = require('../ferrox-core/bin/lib/fleet-capability.cjs');
const registry = require('../ferrox-core/bin/lib/capability-registry.cjs');

const P = 'phase 18 plan 02';
const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-fleet-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/** A project directory carrying a .planning/config.json with the given body. */
function scratchProject(label, config) {
  const root = scratch(label);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  }
  return root;
}

// ─── the capability declaration ──────────────────────────────────────────────

test(`${P}: the fleet capability is registered, is a feature, and contributes nothing installable`, () => {
  const c = registry.capabilities.fleet;
  assert.ok(c, `${P}: the fleet capability is not in the generated registry`);
  assert.equal(c.role, 'feature', `${P}: fleet must carry the feature role`);
  assert.equal(c.activationKey, 'fleet.enabled', `${P}: the activation key drifted`);
  for (const key of ['skills', 'agents', 'commands', 'hooks', 'steps', 'contributions', 'gates']) {
    const value = c[key] || [];
    assert.equal(
      value.length,
      0,
      `${P}: fleet contributes ${value.length} ${key}, and the base install guarantee depends on that being 0. ` +
        'Phase 18 registers the engine and nothing else, per D4. The surfaces are phases 19 through 21.',
    );
  }
});

test(`${P}: the activation key defaults to false in the generated config schema`, () => {
  const entry = registry.configSchema['fleet.enabled'];
  assert.ok(entry, `${P}: fleet.enabled is absent from the generated config schema`);
  assert.equal(entry.type, 'boolean');
  assert.equal(entry.default, false, `${P}: fleet must be off by default`);
});

// ─── activation, through the 1 shared precedence chain ───────────────────────

test(`${P}: activation is inactive when no configuration mentions the key`, () => {
  const root = scratchProject('cfg-absent', {});
  assert.equal(
    fleet.isFleetActive({ config: {}, cwd: root, registry: {} }),
    false,
    `${P}: an unmentioned key must resolve inactive`,
  );
});

test(`${P}: activation is active when the project configuration sets the key true`, () => {
  const root = scratchProject('cfg-true', { fleet: { enabled: true } });
  assert.equal(
    fleet.isFleetActive({ config: {}, cwd: root, registry: {} }),
    true,
    `${P}: a project configuration setting the key true must resolve active`,
  );
});

test(`${P}: activation is inactive when the project configuration sets the key false`, () => {
  const root = scratchProject('cfg-false', { fleet: { enabled: false } });
  assert.equal(
    fleet.isFleetActive({ config: {}, cwd: root, registry: {} }),
    false,
    `${P}: an explicit false is a different input from absent, and both must resolve inactive`,
  );
});

test(`${P}: activation reads the registry schema default when nothing else names the key`, () => {
  const root = scratchProject('cfg-schema', {});
  assert.equal(
    fleet.isFleetActive({ config: {}, cwd: root, registry }),
    false,
    `${P}: the real registry default is false, so the schema level must also resolve inactive`,
  );
});

// ─── the interpreter probe, both directions ──────────────────────────────────

test(`${P}: the interpreter probe reports not found on a PATH that contains none`, () => {
  const empty = scratch('nopath');
  const r = fleet.probeInterpreter({ pathEnv: empty });
  assert.equal(r.found, false, `${P}: the probe reported found on an empty PATH, so it cannot fire`);
  assert.equal(r.path, null);
  assert.equal(r.name, 'python3');
});

test(`${P}: the interpreter probe reports found on the real PATH and names the resolved path`, () => {
  const r = fleet.probeInterpreter({ pathEnv: process.env.PATH });
  assert.equal(
    r.found,
    true,
    `${P}: the probe reported not found on the real PATH. If this machine genuinely has no ` +
      'interpreter, the absent arm above is the only one that can be observed here and this ' +
      'failure is the honest report of that, not a defect in the probe.',
  );
  assert.equal(typeof r.path, 'string');
  assert.equal(fs.existsSync(r.path), true, `${P}: the probe returned a path that does not exist`);
});

test(`${P}: the interpreter probe executes nothing, it only looks up`, () => {
  // A directory entry that is not executable at all still resolves, because the
  // probe is a lookup. If the probe ever starts executing, this arm goes red
  // with a spawn error rather than passing quietly.
  const dir = scratch('lookuponly');
  const fake = path.join(dir, 'fleet-probe-marker');
  fs.writeFileSync(fake, 'not executable\n', { mode: 0o600 });
  const r = fleet.probeInterpreter({ pathEnv: dir, interpreter: 'fleet-probe-marker' });
  assert.equal(r.found, true, `${P}: a lookup only probe must resolve a non executable entry`);
  assert.equal(r.path, fake);
});

// ─── readiness ───────────────────────────────────────────────────────────────

test(`${P}: readiness with the capability inactive carries no verdict at all`, () => {
  const root = scratchProject('ready-inactive', {});
  const r = fleet.assessFleetReadiness({ config: {}, cwd: root, registry: {} });
  assert.equal(r.active, false);
  assert.equal(r.ready, null, `${P}: an inactive capability must carry no readiness verdict`);
  assert.equal(r.interpreter, null, `${P}: an inactive capability must not have run the probe`);
  assert.equal(r.engine, null);
});

test(`${P}: readiness with the capability active and the interpreter present reports ready`, () => {
  const root = scratchProject('ready-yes', { fleet: { enabled: true } });
  const r = fleet.assessFleetReadiness({ config: {}, cwd: root, registry: {}, pathEnv: process.env.PATH });
  assert.equal(r.active, true);
  assert.equal(r.ready, true, `${P}: the real tree plus a real interpreter must report ready`);
  assert.equal(r.engine.entrypoints, 15, `${P}: the vendored engine must carry 15 entrypoints`);
  assert.equal(typeof r.interpreter.path, 'string');
});

test(`${P}: readiness with the capability active and the interpreter absent reports NOT ready and names it`, () => {
  const root = scratchProject('ready-nointerp', { fleet: { enabled: true } });
  const empty = scratch('ready-nointerp-path');
  const r = fleet.assessFleetReadiness({ config: {}, cwd: root, registry: {}, pathEnv: empty });
  assert.equal(r.active, true);
  assert.equal(r.ready, false, `${P}: an absent interpreter must report NOT ready rather than throwing or reporting ready`);
  assert.match(r.reason, /python3/, `${P}: the reason must name the interpreter`);
});

test(`${P}: readiness with the capability active and the vendored tree absent reports NOT ready and names the engine`, () => {
  const root = scratchProject('ready-noengine', { fleet: { enabled: true } });
  const emptyEngine = scratch('ready-noengine-dir');
  const r = fleet.assessFleetReadiness({
    config: {}, cwd: root, registry: {}, pathEnv: process.env.PATH, engineDir: emptyEngine,
  });
  assert.equal(r.active, true);
  assert.equal(r.ready, false);
  assert.match(r.reason, /vendored engine/, `${P}: the reason must name the engine`);
  assert.match(r.reason, /0 of 15/, `${P}: an empty directory must be counted, not merely reported absent`);
});

// ─── the doctor line formatter ───────────────────────────────────────────────

test(`${P}: the doctor line formatter returns exactly null for every inactive case`, () => {
  const inactive = { active: false, ready: null, reason: null, interpreter: null, engine: null };
  assert.equal(
    fleet.formatFleetDoctorLine(inactive),
    null,
    `${P}: an inactive capability must contribute NO line. Asserted against null rather than falsy, ` +
      'so an empty string cannot pass for a suppressed line.',
  );
  assert.equal(fleet.formatFleetDoctorLine(null), null);
  assert.equal(fleet.formatFleetDoctorLine(undefined), null);
});

test(`${P}: the doctor line formatter returns 1 line for every active case`, () => {
  const root = scratchProject('fmt-active', { fleet: { enabled: true } });
  const ready = fleet.assessFleetReadiness({ config: {}, cwd: root, registry: {}, pathEnv: process.env.PATH });
  const readyLine = fleet.formatFleetDoctorLine(ready);
  assert.equal(typeof readyLine, 'string');
  assert.equal(readyLine.split(/\r?\n/).length, 1, `${P}: the formatter must return 1 line, never 2`);
  assert.match(readyLine, /^fleet: READY \(/);

  const empty = scratch('fmt-active-path');
  const notReady = fleet.assessFleetReadiness({ config: {}, cwd: root, registry: {}, pathEnv: empty });
  const notReadyLine = fleet.formatFleetDoctorLine(notReady);
  assert.equal(notReadyLine.split(/\r?\n/).length, 1);
  assert.match(notReadyLine, /^fleet: NOT READY \(/);
  assert.match(notReadyLine, /python3/);
});

// ─── the arm that actually proves the default path survives ──────────────────

test(`${P}: the real command line interface runs an ordinary command with no interpreter on PATH`, () => {
  const empty = scratch('cli-scrubbed-path');
  // The absolute node executable is used deliberately: the child needs a node to
  // start, and PATH is being scrubbed to a directory that contains nothing, so a
  // bare `node` would fail to spawn for a reason that has nothing to do with the
  // property under test.
  const out = spawnSync(process.execPath, [CLI, 'current-timestamp'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: empty },
  });
  assert.equal(
    out.status,
    0,
    `${P}: the real command line interface failed with PATH scrubbed of every interpreter. ` +
      `stderr: ${(out.stderr || '').trim()}`,
  );
  assert.equal(
    (out.stdout || '').trim().length > 0,
    true,
    `${P}: the ordinary command produced no output under a scrubbed PATH`,
  );
  // Prove the scrub was real. If an interpreter were still reachable, this arm
  // would be asserting nothing at all.
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require("node:child_process").spawnSync("python3",["--version"]).error !== undefined))'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: empty },
  });
  assert.equal(
    probe.stdout.trim(),
    'true',
    `${P}: the scrubbed PATH still reached an interpreter, so the arm above proved nothing`,
  );
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
