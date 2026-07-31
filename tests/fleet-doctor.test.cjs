'use strict';

/**
 * Phase 18 plan 02, task 2: the doctor reports fleet readiness ONLY when the
 * capability is active, and the base install carries no fleet surface.
 *
 * D5 governs the whole file. 3 arms here would pass trivially if they were
 * written the obvious way, so each is driven against a case that carries the
 * thing it detects:
 *
 * 1. Asserting only that the ACTIVE arm prints a line never exercises the
 *    inactive arm at all. Both directions are asserted, and the active arm
 *    asserts the COUNT is 1 rather than that a match exists, so a duplicated
 *    doctor block is a failure rather than a pass.
 * 2. Absent and explicitly false are different inputs. Both are driven.
 * 3. An interpreter absent arm run on a machine that HAS an interpreter proves
 *    nothing, so the child process is spawned with PATH scrubbed to an empty
 *    directory and the scrub itself is proven real before the arm is believed.
 *
 * The unavailable library arm injects a real require failure through a preload
 * rather than renaming the shipped library out of the way. Renaming a tracked
 * file mid suite mutates the developer's working tree and races every other
 * test in the run; a preload proves the same property with no write at all, and
 * the injection is itself proven to have taken effect by driving the SAME
 * preload with the capability turned ON, where the line would otherwise appear.
 *
 * Doctor output is JSON encoded by the shared output helper, so every line
 * assertion below decodes first and then splits. A raw grep over the process
 * output sees 1 physical line and can never count doctor lines.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const INSTALL_JS = path.join(REPO_ROOT, 'bin', 'install.js');

const P = 'phase 18 plan 02';
/** Every doctor line for an active capability starts with this exact prefix. */
const FLEET_PREFIX = 'fleet: ';
const SCRATCH_ROOTS = [];

/**
 * The scratch prefix deliberately carries NO fleet token. The install arm below
 * runs the installed command line interface out of a scratch directory and the
 * doctor prints that absolute path in 2 of its own lines, so a prefix containing
 * the token makes the "no fleet token anywhere in the output" assertion match
 * the fixture's own directory name and report a leak that is not there. Observed
 * on the first run of this file. The fixture was corrected rather than the
 * assertion weakened, because the strict scan over every line is the assertion
 * worth keeping.
 */
const SCRATCH_PREFIX = 'ferrox-fdoctor-';

test(`${P}: the scratch prefix used by this file carries no fleet token`, () => {
  assert.equal(
    /fleet/i.test(SCRATCH_PREFIX),
    false,
    `${P}: the scratch prefix carries a fleet token, which makes the install arm match its own fixture path ` +
      'and report a leak that is not there',
  );
});

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${SCRATCH_PREFIX}${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/** A project root carrying a .planning/config.json with the given body. */
function scratchProject(label, config) {
  const root = scratch(label);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  return root;
}

/**
 * Drive the REAL command line interface as a child process against a scratch
 * project, so the 4 level activation precedence walk is exercised for real
 * rather than mocked. Returns the decoded doctor lines plus the exit status.
 */
function runDoctor(cwd, opts) {
  const o = opts || {};
  const nodeArgs = (o.nodeArgs || []).concat([o.cli || CLI, 'doctor', '--cwd', cwd]);
  const res = spawnSync(process.execPath, nodeArgs, {
    cwd: o.spawnCwd || REPO_ROOT,
    encoding: 'utf8',
    env: o.env || process.env,
    timeout: 60000,
  });
  let lines = [];
  let decoded = null;
  try {
    decoded = JSON.parse(res.stdout);
    if (typeof decoded === 'string') lines = decoded.split(/\r?\n/);
  } catch {
    // An undecodable payload is itself a finding: report the raw bytes rather
    // than an empty line list, which would let a broken arm pass as "no fleet
    // line present".
    lines = String(res.stdout || '').split(/\r?\n/);
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', lines, decoded };
}

function fleetLines(lines) {
  return lines.filter((l) => l.startsWith(FLEET_PREFIX));
}

function mentionsFleet(lines) {
  return lines.filter((l) => /fleet/i.test(l));
}

// ─── arm 1: no fleet key anywhere ────────────────────────────────────────────

test(`${P}: with no fleet key in the project configuration the doctor prints no fleet token`, () => {
  const root = scratchProject('absent', { domain: 'unset' });
  const r = runDoctor(root);
  assert.equal(r.status, 0, `${P} inactive arm: the doctor exited ${r.status}. stderr: ${r.stderr.trim()}`);
  assert.equal(
    mentionsFleet(r.lines).length,
    0,
    `${P} inactive arm: the doctor leaked a fleet token for a project that never enabled the capability. ` +
      `Offending lines: ${JSON.stringify(mentionsFleet(r.lines))}`,
  );
  assert.ok(
    r.lines.some((l) => l.startsWith('running cli: ')),
    `${P} inactive arm: the doctor produced no running cli line, so the arm above asserted nothing`,
  );
});

// ─── arm 2: the key set true ─────────────────────────────────────────────────

test(`${P}: with the key set true the doctor prints exactly 1 fleet line`, () => {
  const root = scratchProject('true', { domain: 'unset', fleet: { enabled: true } });
  const r = runDoctor(root);
  assert.equal(r.status, 0, `${P} active arm: the doctor exited ${r.status}. stderr: ${r.stderr.trim()}`);
  const hits = fleetLines(r.lines);
  assert.equal(
    hits.length,
    1,
    `${P} active arm: the doctor printed ${hits.length} fleet lines, expected exactly 1. ` +
      'A count of 1 rather than a presence check is what makes a duplicated doctor block a failure. ' +
      `Observed: ${JSON.stringify(hits)}`,
  );
});

test(`${P}: with the key set true and an interpreter present that line reports ready`, () => {
  const root = scratchProject('true-ready', { domain: 'unset', fleet: { enabled: true } });
  const r = runDoctor(root);
  const hits = fleetLines(r.lines);
  assert.equal(hits.length, 1);
  assert.match(
    hits[0],
    /^fleet: READY \(/,
    `${P} ready arm: expected a READY verdict on a machine carrying an interpreter and the vendored tree. ` +
      `Observed: ${hits[0]}. If this machine genuinely has no interpreter, this failure is the honest ` +
      'report of that rather than a defect in the doctor block.',
  );
  assert.match(hits[0], /15 vendored entrypoints/, `${P} ready arm: the line must name the entrypoint count`);
});

// ─── arm 3: the key set true with no interpreter reachable ───────────────────

test(`${P}: with the key set true and PATH scrubbed the line reports NOT ready and names the interpreter`, () => {
  const root = scratchProject('true-nointerp', { domain: 'unset', fleet: { enabled: true } });
  const empty = scratch('scrubbed-path');

  // Prove the scrub is real BEFORE believing the arm. Without this the arm
  // would be asserting nothing on a machine where PATH is not what the test
  // thinks it is.
  const scrubCheck = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(String(require("node:child_process").spawnSync("python3",["--version"]).error !== undefined))'],
    { encoding: 'utf8', env: { ...process.env, PATH: empty } },
  );
  assert.equal(
    scrubCheck.stdout.trim(),
    'true',
    `${P} scrubbed arm: the scrubbed PATH still reached an interpreter, so this arm proves nothing`,
  );

  // The absolute node executable is used deliberately: the child needs a node
  // to start and PATH now contains nothing, so a bare lookup would fail for a
  // reason unrelated to the property under test.
  const r = runDoctor(root, { env: { ...process.env, PATH: empty } });
  assert.equal(r.status, 0, `${P} scrubbed arm: the doctor exited ${r.status}, and a fleet line is information rather than a failure. stderr: ${r.stderr.trim()}`);
  const hits = fleetLines(r.lines);
  assert.equal(hits.length, 1, `${P} scrubbed arm: expected exactly 1 fleet line, observed ${JSON.stringify(hits)}`);
  assert.match(hits[0], /^fleet: NOT READY \(/, `${P} scrubbed arm: observed ${hits[0]}`);
  assert.match(hits[0], /python3/, `${P} scrubbed arm: the line must name the interpreter. Observed: ${hits[0]}`);
});

// ─── arm 4: the key set explicitly false ─────────────────────────────────────

test(`${P}: with the key set explicitly false the doctor prints no fleet line`, () => {
  // Absent and explicitly false are DIFFERENT inputs through the precedence
  // walk. Arm 1 exercised absent only, so this arm is not a duplicate of it.
  const root = scratchProject('false', { domain: 'unset', fleet: { enabled: false } });
  const r = runDoctor(root);
  assert.equal(r.status, 0, `${P} explicit false arm: the doctor exited ${r.status}. stderr: ${r.stderr.trim()}`);
  assert.equal(
    mentionsFleet(r.lines).length,
    0,
    `${P} explicit false arm: an explicit false must suppress the line exactly as an absent key does. ` +
      `Offending lines: ${JSON.stringify(mentionsFleet(r.lines))}`,
  );
});

// ─── arm 5: the fleet library unavailable ────────────────────────────────────

test(`${P}: the doctor exits 0 and prints its other lines when the fleet library is unavailable`, () => {
  const dir = scratch('nolib');
  const preload = path.join(dir, 'break-fleet-require.cjs');
  fs.writeFileSync(
    preload,
    [
      "'use strict';",
      "const Module = require('node:module');",
      'const orig = Module._load;',
      'Module._load = function (request) {',
      "  if (typeof request === 'string' && request.includes('fleet-capability')) {",
      "    const e = new Error('simulated: the fleet library is unavailable');",
      "    e.code = 'MODULE_NOT_FOUND';",
      '    throw e;',
      '  }',
      '  return orig.apply(this, arguments);',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  // Driven with the capability turned ON. That is the whole point: with the key
  // true a working library produces a line, so an arm that observes NO line here
  // has proven both that the require really failed and that the failure was
  // absorbed. Running this with the key off would prove neither.
  const root = scratchProject('nolib-proj', { domain: 'unset', fleet: { enabled: true } });

  const control = runDoctor(root);
  assert.equal(
    fleetLines(control.lines).length,
    1,
    `${P} unavailable library arm: the control run produced no fleet line, so the injection below proves nothing`,
  );

  const r = runDoctor(root, { nodeArgs: ['--require', preload] });
  assert.equal(
    r.status,
    0,
    `${P} unavailable library arm: the doctor exited ${r.status}. A missing built library can never take ` +
      `the doctor down. stderr: ${r.stderr.trim()}`,
  );
  assert.ok(
    r.lines.some((l) => l.startsWith('running cli: ')),
    `${P} unavailable library arm: the doctor stopped printing its other lines`,
  );
  assert.ok(
    r.lines.some((l) => l.startsWith('team manifest: ')),
    `${P} unavailable library arm: the doctor lost the line that sits immediately above the fleet block`,
  );
  assert.equal(
    mentionsFleet(r.lines).length,
    0,
    `${P} unavailable library arm: an unavailable library must contribute NO line rather than a fallback ` +
      'string, because a fallback string would leak a fleet token into a project that never enabled the ' +
      `capability. Offending lines: ${JSON.stringify(mentionsFleet(r.lines))}`,
  );
});

// ─── the installable surface detector ────────────────────────────────────────

/**
 * The 4 installable surfaces SC3 names. Held as data so the detector below can
 * be pointed at a fixture root as well as at a real installed tree. A detector
 * that has only ever been pointed at a tree where it reports 0 has never been
 * observed reporting at all, and D5 treats that as no evidence.
 */
const INSTALLABLE_SURFACES = ['commands', 'skills', 'agents', 'hooks'];

/**
 * Surfaces a Claude local install actually creates. Measured 2026-07-26 by
 * running the real installer into a scratch project: commands, agents and hooks
 * are populated, and no skills directory is created at all, because skills are
 * a plugin surface on this runtime. The skills arm below is therefore carried
 * for completeness and is VACUOUS on this runtime: it can never report. Saying
 * so here is the point. A blanket "0 fleet entries under every surface" reads
 * like 4 results when 1 of them is an empty directory that cannot hold a result.
 */
const POPULATED_SURFACES = ['commands', 'agents', 'hooks'];

function walkFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Every file under an installable surface whose basename carries a fleet token,
 * keyed by surface and relative to the install root. Each surface is enumerated
 * by WALKING its installed directory rather than by reading a manifest, so a
 * surface the manifest forgot is still counted.
 */
function fleetSurfaceHits(root) {
  const hits = {};
  for (const surface of INSTALLABLE_SURFACES) {
    hits[surface] = walkFiles(path.join(root, surface))
      .filter((f) => /fleet/i.test(path.basename(f)))
      .map((f) => path.relative(root, f));
  }
  return hits;
}

/** How many files each installable surface actually carries. */
function surfaceCoverage(root) {
  const counts = {};
  for (const surface of INSTALLABLE_SURFACES) counts[surface] = walkFiles(path.join(root, surface)).length;
  return counts;
}

// ─── arm 6: the detector is observed reporting against a planted install ─────

/**
 * The measured half of SC3 was 2 real installs, 1 from the pre plan tree and 1
 * from this tree, compared as sorted path lists. That comparison was driven
 * against a PLANTED difference before it was believed: a fleet named command, a
 * fleet named agent and a fleet named hook were added to a throwaway copy of
 * this tree, the installer was run again, and the comparison reported all 3.
 * The install pair is a 1 time cost and its numbers live in the SUMMARY. What
 * is committed here is the detector that pins the property, driven against the
 * same planted shape, so the guard below is never a guard nobody watched fire.
 */
test(`${P}: the installable surface detector reports a planted fleet command, agent and hook`, () => {
  const root = scratch('planted');
  const planted = [
    path.join('commands', 'ferrox-fleet-status.md'),
    path.join('agents', 'ferrox-fleet-runner.md'),
    path.join('hooks', 'ferrox-fleet-supervisor.js'),
  ];
  // A control file per surface, so a detector matching every basename rather
  // than the fleet token would fail this test instead of passing it.
  const controls = [
    path.join('commands', 'ferrox-quick.md'),
    path.join('agents', 'ferrox-executor.md'),
    path.join('hooks', 'ferrox-context-monitor.js'),
  ];
  for (const rel of planted.concat(controls)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'planted fixture, phase 18 plan 02\n', 'utf8');
  }

  const hits = fleetSurfaceHits(root);
  assert.deepEqual(
    hits.commands,
    [path.join('commands', 'ferrox-fleet-status.md')],
    `${P} planted arm: the detector missed a planted fleet command, so its 0 on the real tree proves nothing. ` +
      `Observed: ${JSON.stringify(hits.commands)}`,
  );
  assert.deepEqual(
    hits.agents,
    [path.join('agents', 'ferrox-fleet-runner.md')],
    `${P} planted arm: the detector missed a planted fleet agent. Observed: ${JSON.stringify(hits.agents)}`,
  );
  assert.deepEqual(
    hits.hooks,
    [path.join('hooks', 'ferrox-fleet-supervisor.js')],
    `${P} planted arm: the detector missed a planted fleet hook. Observed: ${JSON.stringify(hits.hooks)}`,
  );
  assert.equal(
    INSTALLABLE_SURFACES.reduce((n, s) => n + hits[s].length, 0),
    3,
    `${P} planted arm: the detector reported a count other than the 3 planted entries, which means it is ` +
      `matching something other than the fleet token. Observed: ${JSON.stringify(hits)}`,
  );
});

// ─── arm 7: the base install carries no fleet surface ────────────────────────

test(`${P}: a real install carries no fleet named command, skill, agent or hook`, { timeout: 300000 }, () => {
  const proj = path.join(scratch('install'), 'proj');
  fs.mkdirSync(proj, { recursive: true });

  const install = spawnSync(process.execPath, [INSTALL_JS, '--claude', '--local'], {
    cwd: proj,
    encoding: 'utf8',
    timeout: 240000,
  });
  assert.equal(install.status, 0, `${P} install arm: the installer failed:\n${install.stdout}\n${install.stderr}`);

  const claude = path.join(proj, '.claude');

  const hits = fleetSurfaceHits(claude);
  for (const surface of INSTALLABLE_SURFACES) {
    assert.equal(
      hits[surface].length,
      0,
      `${P} install arm: the installed tree carries ${hits[surface].length} fleet named ${surface} entries, and ` +
        'the base install guarantee depends on that being 0. Phase 18 registers the engine and contributes no ' +
        `installable surface, per D4. Observed: ${JSON.stringify(hits[surface])}`,
    );
  }

  // Every surface that is supposed to hold something must hold something,
  // otherwise the 0 above is the 0 of an empty directory rather than a result.
  // This is the assertion that fails if a future installer change stops copying
  // a surface, which would otherwise turn the whole arm green and meaningless.
  const coverage = surfaceCoverage(claude);
  for (const surface of POPULATED_SURFACES) {
    assert.ok(
      coverage[surface] > 0,
      `${P} install arm: the installed ${surface} surface is empty, so its 0 fleet entries proved nothing. ` +
        `Observed coverage: ${JSON.stringify(coverage)}`,
    );
  }

  const installedCli = path.join(claude, 'ferrox-core', 'bin', 'ferrox-tools.cjs');
  assert.ok(fs.existsSync(installedCli), `${P} install arm: the installed command line interface is missing`);

  // The installed capability declaration must be present and off by default, so
  // that "no fleet surface" is a property of the capability rather than of a
  // capability that failed to install.
  const installedRegistry = path.join(claude, 'ferrox-core', 'bin', 'lib', 'capability-registry.cjs');
  assert.ok(fs.existsSync(installedRegistry), `${P} install arm: the installed capability registry is missing`);
  const reg = require(installedRegistry);
  assert.ok(reg.capabilities.fleet, `${P} install arm: fleet is absent from the installed registry`);
  assert.equal(
    reg.configSchema['fleet.enabled'].default,
    false,
    `${P} install arm: the installed default is not off`,
  );

  // The emptiness is the mechanism, so it is asserted rather than described.
  // Measured against the pre plan tree, the installed configuration schema went
  // from 42 keys to 43: 1 key added, 0 removed, and 0 of the 42 pre existing
  // keys changed its default. The only way that stays true is if this
  // capability keeps contributing nothing, so every 1 of the 7 contribution
  // arrays is checked here rather than the 4 named surfaces alone.
  for (const key of ['skills', 'agents', 'commands', 'hooks', 'steps', 'contributions', 'gates']) {
    const declared = reg.capabilities.fleet[key] || [];
    assert.equal(
      declared.length,
      0,
      `${P} install arm: the installed fleet capability contributes ${declared.length} ${key}, and SC3 holds ` +
        'by that count being 0 rather than by argument. Adding a surface here changes the base install for ' +
        `every user who never enables fleet. Observed: ${JSON.stringify(declared)}`,
    );
  }

  // Finally the installed command line interface itself, for a project with no
  // fleet configuration.
  const r = runDoctor(proj, { cli: installedCli, spawnCwd: proj });
  assert.equal(r.status, 0, `${P} install arm: the installed doctor exited ${r.status}. stderr: ${r.stderr.trim()}`);
  assert.equal(
    mentionsFleet(r.lines).length,
    0,
    `${P} install arm: the installed doctor leaked a fleet token for a project with no fleet configuration. ` +
      `Offending lines: ${JSON.stringify(mentionsFleet(r.lines))}`,
  );
  assert.ok(
    r.lines.some((l) => l.startsWith('running cli: ')),
    `${P} install arm: the installed doctor produced no output, so the assertion above proved nothing`,
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
