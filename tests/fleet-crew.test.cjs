'use strict';

/**
 * Phase 21 (v1.14 Fleet Mode): the battery over the CREW view.
 *
 * WHAT THE HARD ARMS IN HERE ARE FOR, in the order they matter.
 *
 * 1. `roster` reports NOT ON PATH when the binary is genuinely absent, and it is
 *    driven with PATH scrubbed to an EMPTY DIRECTORY. The scrub is confirmed 2
 *    independent ways before the report is believed: the directory is read and
 *    asserted to hold 0 entries, and a spawn of a bare adapter name under that
 *    exact environment is asserted to fail to start. Without both confirmations
 *    a passing arm could be measuring a typo in the environment plumbing rather
 *    than the resolver. It is PAIRED against an arm where the same 3 names ARE
 *    present as real executable files and are reported ON PATH, so the column is
 *    a measurement rather than a constant. A resolver that returned null for
 *    everything would pass the scrubbed arm alone.
 *
 * 2. `roster` SPAWNS NOTHING, asserted as an exact counter of 0 rather than as a
 *    flag. Counting shims are installed on PATH under all 3 adapter names, each
 *    of which appends a line to a counter file when it is run. The rendered
 *    output is asserted NON EMPTY first, because "it spawned nothing" is
 *    vacuously true of a command that printed nothing, and only then is the
 *    counter asserted to be exactly 0. The counter is proven able to COUNT by an
 *    arm that runs 1 shim on purpose and observes it reach 1.
 *
 * 3. `assign` over an EMPTY roster REFUSES BY NAME. It must not render an empty
 *    plan, because an empty assignment table reads as "there is no work" and the
 *    truth is the opposite: there is work and nobody declared to do it. The arm
 *    asserts the named rule, a non zero exit and that the node count is stated.
 *
 * EVERY CLI ARM SPAWNS THE COMMAND AS A REAL CHILD PROCESS against a scratch
 * root, so the environment seam, the argument parse and the exit code are all
 * inside the measurement rather than beside it.
 *
 * ZERO AGENT SPEND. No arm in this file invokes claude, codex or gemini. The
 * probe arms run the probe module's own zero spend lane, and the PATH arms
 * install inert shims that echo. The suite may be run on any machine without
 * spending a call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const crew = require('../scripts/fleet-crew.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const CREW_CLI = path.join(REPO_ROOT, 'scripts', 'fleet-crew.cjs');
const NODE_BIN = process.execPath;

/** The 3 adapter names this project can dispatch to. Read, never retyped. */
const ADAPTER_NAMES = ['claude', 'codex', 'gemini'];

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-crew-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* a scratch tree that will not delete is not a test failure */ }
  }
});

/** A project root carrying exactly the config given. */
function projectRoot(label, config) {
  const root = scratch(label);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config, null, 2));
  }
  return root;
}

/**
 * The 4 node, 2 wave scratch phase every `assign` arm is measured against.
 *
 * WHY A REAL GRAPH AND NOT AN EMPTY SCRATCH ROOT. An `assign` arm run against a
 * root with no phase directory does not measure the assignment rule at all: the
 * shipped `phase-plan-index` verb answers "Phase not found", the graph build
 * REFUSES, and the projection then sees 0 nodes. A refusal that fires over 0
 * nodes cannot distinguish "there is work and nobody to do it" from "there is no
 * work", which is exactly the ambiguity the empty crew refusal exists to remove,
 * so an arm driven that way passes while proving nothing. Writing real plan files
 * makes the node count NON ZERO and STATED, so the refusal is a measurement.
 *
 * The waves are derived by the shipped verb from `depends_on` rather than taken
 * from the frontmatter `wave` key, so the dependencies below are what actually
 * produce 2 waves. That was confirmed by running the verb against this fixture
 * rather than assumed from the frontmatter.
 */
const SCRATCH_PLANS = [
  { plan: '01', wave: 1, depends_on: '[]' },
  { plan: '02', wave: 1, depends_on: '[]' },
  { plan: '03', wave: 2, depends_on: '[21-01]' },
  { plan: '04', wave: 2, depends_on: '[21-02]' },
];
const SCRATCH_NODE_COUNT = SCRATCH_PLANS.length;

/** Give a root a real, indexable phase 21. Returns the root. */
function withPhase(root) {
  const dir = path.join(root, '.planning', 'phases', '21-scratch');
  fs.mkdirSync(dir, { recursive: true });
  for (const p of SCRATCH_PLANS) {
    fs.writeFileSync(path.join(dir, `21-${p.plan}-PLAN.md`), [
      '---',
      'phase: 21-scratch',
      `plan: ${p.plan}`,
      'type: execute',
      `wave: ${p.wave}`,
      `depends_on: ${p.depends_on}`,
      'node_kind: plan',
      'files_modified:',
      `  - src/scratch-${p.plan}.ts`,
      'autonomous: true',
      '---',
      '',
      `# Scratch plan ${p.plan}`,
      '',
    ].join('\n'));
  }
  return root;
}

/**
 * A bin directory holding 1 counting shim per name. Every shim APPENDS to the
 * counter file and then echoes, so a spawn is recorded whatever the caller does
 * with the output.
 */
function countingBin(label, names) {
  const dir = scratch(label);
  const counter = path.join(dir, 'spawns.log');
  fs.writeFileSync(counter, '');
  for (const name of names) {
    const shim = path.join(dir, name);
    fs.writeFileSync(shim, `#!/bin/sh\necho "${name} $*" >> "${counter}"\necho shim-${name}\n`);
    fs.chmodSync(shim, 0o755);
  }
  return { dir, counter };
}

/** How many spawns the counter recorded. An absent file is 0 recorded spawns. */
function spawnCount(counter) {
  let text;
  try { text = fs.readFileSync(counter, 'utf8'); } catch { return 0; }
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

/** Run the CLI as a real child process with a fully controlled environment. */
function runCli(args, opts) {
  const options = opts === undefined ? {} : opts;
  const env = {
    HOME: process.env.HOME,
    NODE_OPTIONS: '',
    PATH: options.pathValue === undefined ? process.env.PATH : options.pathValue,
  };
  if (options.root !== undefined) env.FERROX_CREW_ROOT = options.root;
  const result = spawnSync(NODE_BIN, [CREW_CLI, ...args], {
    encoding: 'utf8',
    env,
    cwd: options.cwd === undefined ? REPO_ROOT : options.cwd,
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout === null ? '' : result.stdout,
    stderr: result.stderr === null ? '' : result.stderr,
  };
}

/* ------------------------------------------------------------------------ *
 * HARD ARM 1: ON PATH is a measurement, driven both ways.
 * ------------------------------------------------------------------------ */

test('roster reports NOT ON PATH with PATH scrubbed to an empty directory, and the scrub is confirmed 2 ways', (t) => {
  const emptyDir = scratch('empty-path');
  const root = projectRoot('scrubbed-root', { fleet: { adapters: ADAPTER_NAMES } });

  // Scrub confirmation 1: the directory that IS the whole PATH holds 0 entries.
  const entries = fs.readdirSync(emptyDir);
  assert.equal(entries.length, 0,
    `the scrub directory must be empty for this arm to measure anything, it held ${entries.length} entries`);

  // Scrub confirmation 2: a spawn of a bare adapter name under this exact
  // environment cannot start. This is independent of the resolver under test.
  const probeSpawn = spawnSync('claude', ['--version'], {
    env: { PATH: emptyDir, HOME: process.env.HOME },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.ok(probeSpawn.error !== undefined && probeSpawn.error !== null,
    'a bare adapter name must fail to start under the scrubbed PATH, otherwise the scrub did not take');
  t.diagnostic(`scrub confirmation 2: spawn error ${String(probeSpawn.error && probeSpawn.error.code)}`);

  const out = runCli(['roster'], { root, pathValue: emptyDir });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.length > 400, 'the roster must render a real panel before its columns are believed');

  for (const name of ADAPTER_NAMES) {
    assert.match(out.stdout, new RegExp(`NOT ON PATH: no executable file named '${name}'`),
      `${name} must be reported NOT ON PATH under a scrubbed PATH`);
  }
  assert.match(out.stdout, /on path {7}0 identities/,
    'the crew size counter must read 0 on path under a scrubbed PATH');
});

test('roster reports ON PATH when the same 3 names ARE present, so the column is not a constant', () => {
  const bin = countingBin('present-bin', ADAPTER_NAMES);
  const root = projectRoot('present-root', { fleet: { adapters: ADAPTER_NAMES } });

  const out = runCli(['roster'], { root, pathValue: bin.dir });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.length > 400, 'the roster must render a real panel');

  for (const name of ADAPTER_NAMES) {
    assert.match(out.stdout, new RegExp(`resolved at ${path.join(bin.dir, name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `${name} must be reported ON PATH with its resolved location`);
  }
  assert.doesNotMatch(out.stdout, /NOT ON PATH/,
    'no member may read NOT ON PATH when all 3 are present');
  assert.match(out.stdout, /on path {7}3 identities/,
    'the crew size counter must read 3 on path when 3 are present');
});

test('a NON EXECUTABLE file with an adapter name is NOT on path, so presence is not just a filename', () => {
  // A mutation battery proved the executable bit check was unwatched: making the
  // resolver accept any regular file killed no arm, because every arm either had
  // no file at all or a properly executable one. A stray non executable file
  // named `claude` on PATH is a real shape (a note, a config, a partial download)
  // and calling it an adapter is a presence claim the machine cannot honour.
  const dir = scratch('nonexec-bin');
  const stray = path.join(dir, 'claude');
  fs.writeFileSync(stray, 'this is a text file, not a program\n');
  fs.chmodSync(stray, 0o644);
  assert.equal(fs.statSync(stray).isFile(), true, 'the file must exist for this arm to measure the bit');

  // The MODE precondition is POSIX only: Windows reports 0o666 or 0o444 rather
  // than the requested octal, so asserting the requested bits there would measure
  // the platform instead of the resolver. The BEHAVIOUR assertions below run on
  // every OS, which is what this arm is actually for.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(stray).mode & 0o111, 0, 'the file must carry NO executable bit');
  }

  assert.equal(crew.resolveOnPath('claude', dir), null,
    'a regular file without the executable bit is not a binary this machine can run');

  const out = runCli(['roster'], { root: projectRoot('nonexec-root', { fleet: { adapters: ADAPTER_NAMES } }), pathValue: dir });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /NOT ON PATH: no executable file named 'claude'/,
    'the report must say NOT ON PATH for a file it cannot execute');

  // PAIRED: the SAME file, with only the bit changed, flips the answer. Without
  // this the arm above would also pass against a resolver that never resolves.
  // Also POSIX only, because Windows cannot grant the bit this pairing turns on.
  if (process.platform !== 'win32') {
    fs.chmodSync(stray, 0o755);
    assert.equal(crew.resolveOnPath('claude', dir), stray,
      'the same file with the executable bit set must resolve, so the bit is what was measured');
  }
});

test('markOf keeps no and UNKNOWN as 2 different words, driven directly', () => {
  // Defence in depth that nothing watched fail is defence a mutation removes for
  // free. Every caller passes a boolean today, so this contract is driven here.
  assert.equal(crew.markOf(true), 'yes');
  assert.equal(crew.markOf(false), 'no', 'a measured negative says no');
  assert.equal(crew.markOf(null), 'UNKNOWN', 'an unmeasured fact must never render as a measured negative');
  assert.equal(crew.markOf(undefined), 'UNKNOWN', 'an absent fact is unmeasured, not negative');
  assert.notEqual(crew.markOf(null), crew.markOf(false),
    'collapsing UNKNOWN into no is how a report claims a measurement it never made');
});

/* ------------------------------------------------------------------------ *
 * HARD ARM 2: roster spawns nothing, counted exactly.
 * ------------------------------------------------------------------------ */

test('the spawn counter can COUNT, proven before it is trusted to read 0', () => {
  const bin = countingBin('counter-selftest', ADAPTER_NAMES);
  assert.equal(spawnCount(bin.counter), 0, 'the counter starts at 0');

  const ran = spawnSync(path.join(bin.dir, 'claude'), ['--version'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(ran.status, 0, 'the shim must run');
  assert.equal(spawnCount(bin.counter), 1,
    'the counter must reach 1 after 1 deliberate spawn, otherwise a 0 reading measures nothing');
});

test('roster spawns EXACTLY 0 adapters, asserted after the output is proven non empty', (t) => {
  const bin = countingBin('roster-nospawn', ADAPTER_NAMES);
  const root = projectRoot('nospawn-root', { fleet: { adapters: ADAPTER_NAMES } });
  assert.equal(spawnCount(bin.counter), 0, 'the counter must start at 0');

  const out = runCli(['roster'], { root, pathValue: bin.dir });

  // NON ZERO FIRST. "It spawned nothing" is vacuously true of a command that
  // printed nothing, so the real output is established before the counter is read.
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.length > 400,
    `the roster must render a real panel first, it rendered ${out.stdout.length} characters`);
  assert.match(out.stdout, /TEAM {2}the roles this project declared/);
  assert.match(out.stdout, /BACKENDS {2}the vendor CLI identities/);
  assert.match(out.stdout, /CREW SIZE/);
  for (const name of ADAPTER_NAMES) assert.ok(out.stdout.includes(name), `${name} must appear in the roster`);

  const spawns = spawnCount(bin.counter);
  t.diagnostic(`adapter spawns recorded during roster: ${spawns}`);
  assert.equal(spawns, 0,
    `roster must spawn EXACTLY 0 adapters, the counter recorded ${spawns}. A status listing that runs `
    + 'the vendors is how a suite starts making paid calls per run.');
});

/* ------------------------------------------------------------------------ *
 * HARD ARM 3: assign over an empty roster refuses by name.
 * ------------------------------------------------------------------------ */

test('assign over an EMPTY roster refuses by name rather than rendering an empty plan', () => {
  const refusal = crew.projectAssignments({
    nodes: [{ id: '21-01', wave: 1, schedule_order: 0 }, { id: '21-02', wave: 1, schedule_order: 1 }],
    crew: [],
  });
  assert.equal(refusal.ok, false, 'an empty crew must refuse');
  assert.equal(refusal.rule, crew.EMPTY_CREW_RULE, 'the refusal must name WHICH rule answered');
  assert.equal(refusal.code, crew.CREW_ERROR_CODES.EMPTY_CREW);
  assert.match(refusal.message, /2 nodes/, 'the refusal must state how much work went unassigned');
  assert.match(refusal.message, /fleet\.adapters/, 'the refusal must name the fix');
  assert.ok(!Object.prototype.hasOwnProperty.call(refusal, 'assignments'),
    'a refusal must carry no assignment table at all');
});

test('assign over an EMPTY roster refuses by name over a graph that HAS work, with a non zero exit', (t) => {
  // The graph is real and its node count is NON ZERO, established before the
  // refusal is believed. Over an unreadable or empty graph this arm would pass
  // without distinguishing "nobody to do the work" from "no work", which is the
  // exact ambiguity the rule exists to remove.
  const root = withPhase(projectRoot('assign-empty', { model_profile: 'adaptive' }));
  const staffed = runCli(['assign', '21'], { root: withPhase(staffedRoot('assign-empty-control')) });
  assert.equal(staffed.status, 0, staffed.stderr);
  assert.match(staffed.stdout, new RegExp(`${SCRATCH_NODE_COUNT} nodes across 2 waves`),
    `the control arm must prove this fixture graph carries ${SCRATCH_NODE_COUNT} real nodes, `
    + 'otherwise the refusal below is measured over an empty graph and means nothing');

  const out = runCli(['assign', '21'], { root });
  t.diagnostic(`refusal exit status: ${out.status}`);

  assert.notEqual(out.status, 0, 'a refusal must not exit 0');
  assert.ok(out.stdout.length > 200, 'the refusal must be rendered, not silent');
  assert.match(out.stdout, new RegExp(`REFUSED by rule ${crew.EMPTY_CREW_RULE}`));
  assert.match(out.stdout, new RegExp(`${SCRATCH_NODE_COUNT} nodes`),
    'the refusal must state how much REAL work went unassigned, which is what makes it a refusal '
    + 'rather than a report of an empty phase');
  assert.doesNotMatch(out.stdout, /CREW MEMBER/,
    'a refusal must render NO assignment table, because an empty table reads as no work');
  assert.doesNotMatch(out.stdout, /declares 0 nodes/,
    'a populated graph must never be described as declaring 0 nodes');
});

test('an UNREADABLE graph is a named unavailable and is NEVER rendered as an empty graph', () => {
  // No phase directory at all: the shipped index verb answers "Phase not found".
  const root = projectRoot('assign-unreadable', { fleet: { adapters: ADAPTER_NAMES } });
  const out = runCli(['assign', '21'], { root });

  assert.notEqual(out.status, 0, 'an unreadable graph must not exit 0');
  assert.match(out.stdout, /UNAVAILABLE: nothing was read/,
    'the reader must say it could not reach the graph');
  assert.match(out.stdout, /no phase directory/,
    "the graph's OWN refusal message must be carried through rather than paraphrased");
  assert.doesNotMatch(out.stdout, /this graph was read/,
    'a graph that was never read must never be described as having been read');
  assert.doesNotMatch(out.stdout, /declares 0 nodes/,
    'an unreadable graph rendered as a graph declaring 0 nodes is the same lie as a green report '
    + 'over a dead vendor: unavailable and empty are 2 different facts');
});

test('assign renders a real projection when a crew IS configured, so the refusal is not a constant', () => {
  const out = runCli(['assign', '21'], {});
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /CREW MEMBER/, 'a configured crew must render the table');
  assert.doesNotMatch(out.stdout, /REFUSED by rule/);
  for (const name of ADAPTER_NAMES) {
    assert.ok(out.stdout.includes(name), `${name} must take at least 1 node of phase 21`);
  }
});

/* ------------------------------------------------------------------------ *
 * The 3 facts are never collapsed.
 * ------------------------------------------------------------------------ */

test('ON PATH, CONFIGURED and READY are 3 independent columns', () => {
  const built = crew.buildCrew({
    dispatchable: ADAPTER_NAMES,
    configured: ['claude'],
    pathValue: '',
    resolve: (bin) => (bin === 'codex' ? '/fake/codex' : null),
  });
  const byName = new Map(built.members.map((m) => [m.identity, m]));

  assert.equal(byName.get('claude').configured, true);
  assert.equal(byName.get('claude').on_path, false, 'configured must not imply on path');
  assert.equal(byName.get('codex').on_path, true);
  assert.equal(byName.get('codex').configured, false, 'on path must not imply configured');
  for (const name of ADAPTER_NAMES) {
    assert.equal(byName.get(name).ready, null, 'readiness is UNKNOWN until a probe runs');
  }
  assert.equal(built.counts.on_path, 1);
  assert.equal(built.counts.configured, 1);
  assert.equal(built.counts.dispatchable, 3);
});

test('UNKNOWN readiness renders as UNKNOWN and never as 0 and never as blank', () => {
  const built = crew.buildCrew({ dispatchable: ADAPTER_NAMES, configured: ADAPTER_NAMES, pathValue: '', resolve: () => null });
  const text = crew.renderRoster(built, { config_detail: 'test' }).join('\n');
  assert.match(text, /UNKNOWN/, 'an unmeasured lane must say UNKNOWN');
  assert.doesNotMatch(text, /READY {7}0/, 'an unmeasured lane must never be reported as 0 ready');
  const rows = text.split('\n').filter((line) => /^ {2}(claude|codex|gemini) /.test(line));
  assert.equal(rows.length, 3, 'every member gets exactly 1 aligned row');
  for (const row of rows) assert.match(row, /UNKNOWN/, `the READY column must be filled: ${row}`);
});

/* ------------------------------------------------------------------------ *
 * The exclusions are visible policy.
 * ------------------------------------------------------------------------ */

test('kimi and wayland-core are excluded WITH their reasons rendered', () => {
  const out = runCli(['roster'], {});
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /EXCLUDED BY POLICY/);
  for (const name of ['kimi', 'wayland-core']) {
    assert.ok(out.stdout.includes(name), `${name} must be rendered rather than silently absent`);
  }
  assert.match(out.stdout, /FF-B225/, 'each exclusion must carry the backlog row that owns it');
  assert.match(out.stdout, /NOT dispatchable by the vendored\s+engine/,
    'the kimi reason must be rendered, not merely its name');
  assert.match(out.stdout, /metered service/, 'the wayland-core reason must be rendered');
  assert.match(out.stdout, /excluded {6}2 identities/, 'the crew size counter must count the exclusions');
});

test('the dispatchable crew is DERIVED from the shipped profile table, never retyped', () => {
  const probe = require('../ferrox-core/bin/lib/fleet-probe.cjs');
  const derived = crew.dispatchableIdentities(probe);
  assert.deepEqual(derived, ADAPTER_NAMES,
    'the crew must be the shipped profile identities minus the mock lane and minus the stated exclusions');
  assert.ok(!derived.includes(crew.MOCK_IDENTITY), 'the zero spend lane is not a crew member');
  for (const excluded of Object.keys(crew.CREW_EXCLUSIONS)) {
    assert.ok(!derived.includes(excluded), `${excluded} must not appear in the crew`);
  }

  // THE SHIPPED TABLE CANNOT EXERCISE THE EXCLUSION FILTER, and that must be
  // stated rather than left to look like coverage. `fleet-probe` carries no argv
  // profile for kimi or wayland-core, so filtering them out of the shipped table
  // removes nothing and a mutation deleting the filter kills no arm against it.
  for (const excluded of Object.keys(crew.CREW_EXCLUSIONS)) {
    assert.ok(!Object.prototype.hasOwnProperty.call(probe.ADAPTER_PROFILES, excluded),
      `${excluded} is absent from the shipped profile table, which is WHY the arm below drives a `
      + 'synthetic table instead of this one');
  }
});

test('the exclusion filter is watched failing, driven against a table that DOES carry the exclusions', () => {
  // A guard nobody has watched fail is a guard a mutation removes for free. The
  // shipped table cannot put kimi or wayland-core in front of the filter, so the
  // filter is driven against a handcrafted table where the condition IS present.
  // This is the same split the fleet preflight uses: judge a handcrafted
  // observation rather than only observations where the rule never has to fire.
  const excludedNames = Object.keys(crew.CREW_EXCLUSIONS);
  assert.ok(excludedNames.length > 0, 'there must be exclusions for this arm to mean anything');

  const synthetic = { ADAPTER_PROFILES: { claude: [], codex: [], gemini: [], mock: [] } };
  for (const name of excludedNames) synthetic.ADAPTER_PROFILES[name] = [];

  // NON EMPTY FIRST: the synthetic table really does offer the excluded names.
  for (const name of excludedNames) {
    assert.ok(Object.prototype.hasOwnProperty.call(synthetic.ADAPTER_PROFILES, name),
      `${name} must be present in the synthetic table, otherwise the filter has nothing to remove`);
  }

  const derived = crew.dispatchableIdentities(synthetic);
  assert.deepEqual(derived, ADAPTER_NAMES,
    'every stated exclusion and the zero spend lane must be removed even when the profile table '
    + 'offers them, which is the day this filter starts doing work');
  for (const name of excludedNames) {
    assert.ok(!derived.includes(name),
      `${name} is dispatchable in this table and must STILL be held out of the crew by policy`);
  }
});

test('a configured identity the engine cannot dispatch gets a row that SAYS SO', () => {
  const built = crew.buildCrew({
    dispatchable: ADAPTER_NAMES,
    configured: [...ADAPTER_NAMES, 'nonesuch'],
    pathValue: '',
    resolve: () => null,
  });
  const odd = built.members.find((m) => m.identity === 'nonesuch');
  assert.ok(odd, 'a declared identity must never be silently dropped');
  assert.equal(odd.dispatchable, false);
  assert.match(odd.note, /DECLARED and NOT dispatchable/);
});

/* ------------------------------------------------------------------------ *
 * The empty configured roster renders as a stated state, never as a blank.
 * ------------------------------------------------------------------------ */

test('a config with no fleet key renders the empty crew explicitly and names the preflight refusal', () => {
  const root = projectRoot('no-fleet-key', { model_profile: 'adaptive' });
  const loaded = crew.loadConfiguredRoster({ root });
  assert.equal(loaded.state, 'no-fleet-key', 'an absent key is a different state from an empty array');
  assert.deepEqual(loaded.adapters, []);

  const out = runCli(['roster'], { root });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /THE CONFIGURED CREW IS EMPTY/);
  assert.match(out.stdout, /vacuously\s+true of 0 adapters/,
    'the empty state must state WHY the preflight refuses rather than leaving a blank');
  assert.match(out.stdout, /configured {4}0 identities/);
});

test('the 4 empty config situations carry 4 different states', () => {
  assert.equal(crew.loadConfiguredRoster({ root: scratch('no-file') }).state, 'no-config-file');
  assert.equal(crew.loadConfiguredRoster({ root: projectRoot('no-key', { a: 1 }) }).state, 'no-fleet-key');
  assert.equal(crew.loadConfiguredRoster({ root: projectRoot('no-arr', { fleet: {} }) }).state, 'no-adapters-key');
  assert.equal(crew.loadConfiguredRoster({ root: projectRoot('empty-arr', { fleet: { adapters: [] } }) }).state, 'empty-adapters');
});

/* ------------------------------------------------------------------------ *
 * The assignment rule is deterministic and explains itself.
 * ------------------------------------------------------------------------ */

test('the projection is deterministic and every assignment carries its reason', () => {
  const nodes = [
    { id: '21-03', wave: 2, schedule_order: 2 },
    { id: '21-01', wave: 1, schedule_order: 0 },
    { id: '21-02', wave: 1, schedule_order: 1 },
  ];
  const first = crew.projectAssignments({ nodes, crew: ADAPTER_NAMES });
  const second = crew.projectAssignments({ nodes: [...nodes].reverse(), crew: [...ADAPTER_NAMES].reverse() });
  assert.deepEqual(first.assignments, second.assignments,
    'the same graph and crew must project identically regardless of input order');
  for (const a of first.assignments) {
    assert.ok(a.reason.length > 40, `every assignment must explain itself: ${a.node}`);
  }
  assert.equal(first.assignments[0].member, 'claude');
  assert.equal(first.assignments[1].member, 'codex');
  assert.equal(first.assignments[2].member, 'claude', 'the rotation must RESET at a wave boundary');
});

test('a wave wider than the crew SAYS the nodes serialize rather than hiding it', () => {
  const nodes = [0, 1, 2, 3].map((i) => ({ id: `w-0${i}`, wave: 1, schedule_order: i }));
  const projected = crew.projectAssignments({ nodes, crew: ['claude', 'codex'] });
  assert.equal(projected.ok, true);
  assert.match(projected.assignments[2].reason, /SERIALIZE/,
    'a second lap must name the serialization it causes');
  assert.match(projected.assignments[2].reason, /A crew of 2 is the limit here, not the graph/);
  assert.doesNotMatch(projected.assignments[0].reason, /SERIALIZE/,
    'a first lap must not claim serialization');
});

/* ------------------------------------------------------------------------ *
 * assign is a projection and never claims otherwise.
 * ------------------------------------------------------------------------ */

test('assign labels itself a projection and names the open dispatch consumer', () => {
  const out = runCli(['assign', '21'], {});
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /PROJECTION, not a dispatch/);
  assert.match(out.stdout, /SPAWNED NOTHING AND STARTED NOTHING/);
  assert.match(out.stdout, /FF-B379/, 'the dispatch consumer must be named');
  assert.doesNotMatch(out.stdout, /now running|started worker/i,
    'a projection must never read as a dispatch that happened');

  // FF-B379 CLOSED WHILE THIS VIEW WAS BEING BUILT, so the view must not still
  // claim it is open. The claim it makes instead is checkable, and is checked
  // against the consumer's own source below rather than asserted from prose.
  assert.doesNotMatch(out.stdout, /FF-B379 and it is OPEN/,
    'the consumer has landed, and a view that still calls it open is stating a stale fact');
  assert.match(out.stdout, /THE DISPATCH CONSUMER HAS LANDED AND IT STILL DOES NOT CONSUME THIS/);
});

test('the claim that the landed consumer carries no crew choice is checked against ITS source', () => {
  // A view that says "the consumer does not consume this" is making a claim about
  // another file. Claims about other files rot silently, so this reads that file.
  const consumer = path.join(REPO_ROOT, 'scripts', 'fleet-dispatch.cjs');
  if (!fs.existsSync(consumer)) {
    assert.fail('scripts/fleet-dispatch.cjs is named by the assign output and must exist, '
      + 'otherwise the view names a consumer that is not there');
  }
  const source = fs.readFileSync(consumer, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // NON EMPTY FIRST: the file really was read and really has code in it.
  assert.ok(source.length > 2000,
    `the consumer source must be read before it is characterised, read ${source.length} characters`);

  for (const needle of ['crew', 'roleBinding', 'team-manifest']) {
    assert.ok(!source.includes(needle),
      `the assign output claims the landed consumer carries no crew choice, and the consumer names `
      + `${needle}. Either that claim is now stale or the consumer grew a second roster beside the `
      + 'team, and both of those are things a reader must be told rather than left to discover.');
  }
});

test('assign spawns EXACTLY 0 adapters, asserted after its output is proven non empty', (t) => {
  const bin = countingBin('assign-nospawn', ADAPTER_NAMES);
  const out = runCli(['assign', '21'], { pathValue: bin.dir });

  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.length > 400, 'the projection must render before the counter is believed');
  assert.match(out.stdout, /CREW MEMBER/);

  const spawns = spawnCount(bin.counter);
  t.diagnostic(`adapter spawns recorded during assign: ${spawns}`);
  assert.equal(spawns, 0, `a projection must spawn EXACTLY 0 adapters, the counter recorded ${spawns}`);
});

/* ------------------------------------------------------------------------ *
 * Probing is spend gated. The mock lane is the default and says what it is.
 * ------------------------------------------------------------------------ */

test('probe defaults to the ZERO SPEND lane and spends 0 vendor calls, counted', (t) => {
  const bin = countingBin('probe-default', ADAPTER_NAMES);
  const root = projectRoot('probe-root', { fleet: { adapters: ADAPTER_NAMES } });
  const out = runCli(['probe'], { root, pathValue: `${bin.dir}${path.delimiter}${process.env.PATH}` });

  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.length > 300, 'the probe report must render before its spend claim is believed');
  assert.match(out.stdout, /MOCK LANE, 0 spend/);
  assert.match(out.stdout, /IT\s+PROVES\s+NOTHING\s+ABOUT\s+ANY\s+VENDOR/,
    'a mock answer must never be presentable as a vendor answer');
  assert.match(out.stdout, /spend: 0/);

  // The TABLE itself must survive being lifted away from its banner.
  assert.doesNotMatch(out.stdout, /\bREADY\b/,
    'the mock lane must not print the word READY anywhere: a table of 3 members reading READY is '
    + 'indistinguishable from 3 healthy vendors once it leaves the banner that qualified it');
  assert.match(out.stdout, /PLUMBING/, 'the mock lane must head its column with what it measured');
  assert.match(out.stdout, /WIRED/, 'the mock lane must use its own vocabulary');
  assert.match(out.stdout, /VENDOR READINESS MEASURED FOR 0 of 3/,
    'after a mock probe the vendors are still unmeasured, and that must be stated');
  assert.match(out.stdout, /still\s+UNKNOWN/,
    'an unmeasured vendor stays UNKNOWN, which is not 0 ready and is not a blank');

  const spawns = spawnCount(bin.counter);
  t.diagnostic(`vendor spawns recorded during the default probe: ${spawns}`);
  assert.equal(spawns, 0,
    `the default probe lane must spend EXACTLY 0 vendor calls, the counter recorded ${spawns}`);
});

test('the default probe lane really is the mock identity, per member', () => {
  const calls = [];
  const probe = require('../ferrox-core/bin/lib/fleet-probe.cjs');
  const folded = crew.probeCrew({
    members: ADAPTER_NAMES.map((identity) => ({ identity })),
    real: false,
    probe,
    nonce: 'nonce-abc',
    run: (bin) => { calls.push(bin); return { status: 0, stdout: 'nonce-abc', stderr: '' }; },
  });
  assert.equal(folded.lane, 'mock');
  assert.equal(calls.length, 3, '1 call per member');
  for (const bin of calls) {
    assert.ok(!ADAPTER_NAMES.includes(bin), `the default lane must not reach a vendor binary, it reached ${bin}`);
  }
  for (const r of folded.results) {
    assert.equal(r.lane_identity, crew.MOCK_IDENTITY, 'the report must say which lane produced the verdict');
    assert.ok(ADAPTER_NAMES.includes(r.identity), 'the member name must still travel with its answer');
  }
});

test('the real lane is opt in and states its expected spend before it makes a call', () => {
  const calls = [];
  const probe = require('../ferrox-core/bin/lib/fleet-probe.cjs');
  const folded = crew.probeCrew({
    members: ADAPTER_NAMES.map((identity) => ({ identity })),
    real: true,
    probe,
    nonce: 'nonce-xyz',
    run: (bin) => { calls.push(bin); return { status: 0, stdout: 'nonce-xyz', stderr: '' }; },
  });
  assert.deepEqual(calls, ADAPTER_NAMES, 'the real lane must reach the vendor binaries by name');
  assert.equal(folded.lane, 'real');

  const text = crew.renderProbe(folded, {}).join('\n');
  assert.match(text, /REAL LANE, THIS SPENT/);
  assert.match(text, /3 real vendor calls/);
  assert.match(crew.USAGE, /--real SPENDS MONEY/, 'the usage text must warn before the flag is typed');

  // PAIRED against the mock arm: the real lane DOES print READY, so the mock
  // lane's silence is a deliberate distinction rather than a word this file
  // never emits at all.
  assert.match(text, /VENDOR READY/, 'the real lane heads its column with vendor readiness');
  assert.match(text, /3 members READY of 3 probed/,
    'the real lane must report readiness in the readiness vocabulary');
  assert.doesNotMatch(text, /WIRED/, 'the plumbing vocabulary belongs to the mock lane alone');
});

test('the 2 lanes use 2 vocabularies, so a mock answer can never be reported as a vendor answer', () => {
  const probe = require('../ferrox-core/bin/lib/fleet-probe.cjs');
  const members = ADAPTER_NAMES.map((identity) => ({ identity }));
  const stub = () => ({ status: 0, stdout: 'n-1', stderr: '' });

  const mock = crew.renderProbe(
    crew.probeCrew({ members, real: false, probe, nonce: 'n-1', run: stub }), {},
  ).join('\n');
  const real = crew.renderProbe(
    crew.probeCrew({ members, real: true, probe, nonce: 'n-1', run: stub }), {},
  ).join('\n');

  // The SAME underlying verdict renders 2 different ways, which is the point.
  assert.equal(crew.PLUMBING_WORDING.READY, 'WIRED');
  assert.ok(mock.includes('WIRED') && !mock.includes('READY'),
    'a zero spend answer must never carry the vendor readiness word');
  assert.ok(real.includes('READY') && !real.includes('WIRED'),
    'a paid answer must carry the vendor readiness word');
  assert.notEqual(mock, real,
    'if the 2 lanes rendered identically, the lane distinction would be decoration');
});

test('probe over an empty configured crew says 0 probed is not 0 failed', () => {
  const root = projectRoot('probe-empty', { model_profile: 'adaptive' });
  const out = runCli(['probe'], { root });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /NO MEMBER WAS PROBED/);
  assert.match(out.stdout, /0 probed is not 0 failed/);
});

/* ------------------------------------------------------------------------ *
 * THE TEAM IS THE ROSTER. It is read from the shipped manifest, not forked.
 * ------------------------------------------------------------------------ */

/**
 * A TEAM.md built through the SHIPPED serializer and hasher, never hand rolled.
 *
 * The manifest hash is a staleness guard and the parser refuses a stale one, so a
 * hand typed fixture would be testing my arithmetic rather than the view. The
 * hash is therefore COMPUTED by the same function the producer uses, and the
 * document is emitted by the same serializer, which is the whole point of
 * consuming the manifest rather than forking it.
 */
function teamDoc(roles) {
  const team = require('../ferrox-core/bin/lib/team-manifest.cjs');
  const manifest = {
    schema: 'team-manifest/v1',
    derived_from: { brainstorm: 'crew-view-fixture', milestone: 'v1.14' },
    manifest_hash: 'pending',
    roles,
  };
  manifest.manifest_hash = team.computeTeamManifestHash(manifest);
  return team.serializeTeamManifest(manifest);
}

const FIXTURE_ROLES = [
  {
    id: 'inline-seat',
    charter: 'Do the work that needs no separate process, inside the host runtime that is already running.',
    rationale: 'Because the smallest duty in this fixture must not pay for a process it does not need.',
    non_redundancy: 'Sole owner of the inline write surface in this fixture.',
    provenance: '(stance: sounding-board, confirmed at exit)',
    binding: { inline: true },
    effective_binding: 'inline',
    tier: 'mid',
    owns: ['docs/inline.md'],
    reviews: [],
    phase_scope: null,
  },
  {
    id: 'agent-seat',
    charter: 'Do the work that a named Claude Code subagent owns, so the duty travels with its own charter.',
    rationale: 'Because a bound seat is the rung the manifest already ships and the fixture must exercise it.',
    non_redundancy: 'Sole owner of the agent write surface in this fixture.',
    provenance: '(stance: sounding-board, confirmed at exit)',
    binding: { agent: 'ferrox-fixture-seat' },
    effective_binding: 'agent',
    tier: null,
    owns: ['docs/agent.md'],
    reviews: [],
    phase_scope: null,
  },
];

/** A project root carrying a real, parseable TEAM.md. */
function staffedRoot(label) {
  const root = projectRoot(label, { fleet: { adapters: ADAPTER_NAMES } });
  fs.writeFileSync(path.join(root, '.planning', 'TEAM.md'), teamDoc(FIXTURE_ROLES));
  return root;
}

test('the fixture team really parses through the SHIPPED parser, proven before it is relied on', () => {
  const root = staffedRoot('team-parse-selftest');
  const loaded = crew.loadTeam({ root });
  assert.equal(loaded.state, 'staffed',
    `the fixture must parse, otherwise every team arm below measures a parse failure: ${loaded.detail}`);
  assert.equal(loaded.roles.length, 2);
});

test('roster renders 1 row per TEAM ROLE, and inline versus agent are visually distinct', () => {
  const root = staffedRoot('team-rows');
  const out = runCli(['roster'], { root });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.length > 600, 'the roster must render a real panel');

  assert.match(out.stdout, /ROLE {10}BINDING/, 'the team panel must be an aligned roster');
  assert.match(out.stdout, /inline-seat\s+inline\s/, 'an inline role must render its rung');
  assert.match(out.stdout, /agent-seat\s+agent:ferrox-fixture-seat\s/, 'an agent role must render its named agent');
  assert.match(out.stdout, /backed by the host runtime, no separate process/);
  assert.match(out.stdout, /backed by the Claude Code subagent 'ferrox-fixture-seat'/);
  assert.match(out.stdout, /2 roles: 1 inline, 1 agent/);
  assert.doesNotMatch(out.stdout, /ABSENT: no role by role view/,
    'a staffed team must not render the absent panel');
});

test('a role that is NOT CLI backed reads n/a in the vendor columns, never no and never UNKNOWN', () => {
  const rows = crew.buildTeamRows({
    roles: [{ id: 'inline-seat', binding: { inline: true }, effective_binding: 'inline' }],
    members: [{ identity: 'claude', on_path: true, configured: true, ready: null }],
  });
  assert.equal(rows[0].on_path, null, 'a non CLI rung has no PATH fact at all');
  assert.equal(rows[0].configured, null);
  const text = crew.renderTeamPanel(rows, { state: 'staffed' }).join('\n');
  const row = text.split('\n').find((line) => line.includes('inline-seat'));
  assert.match(row, /n\/a/, 'the vendor columns must read n/a on a non CLI rung');
  assert.doesNotMatch(row, /UNKNOWN/,
    'n/a and UNKNOWN are different claims: not applicable is not the same as never measured');
});

test('an ABSENT team is rendered as a named absence and never as an empty team', () => {
  const root = projectRoot('team-absent', { fleet: { adapters: ADAPTER_NAMES } });
  const loaded = crew.loadTeam({ root });
  assert.equal(loaded.state, 'absent');
  assert.match(loaded.detail, /An absent team is not an empty team/);

  const out = runCli(['roster'], { root });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ABSENT: no role by role view could be rendered/);
  assert.match(out.stdout, /3 different\s+problems with 3 different fixes/);
  assert.match(out.stdout, /BACKENDS/,
    'the backend facts must still render, because they hold whether or not a team was declared');
});

test('an INVALID team is a different state from an absent one and carries the parser refusal', () => {
  const root = projectRoot('team-invalid', { fleet: { adapters: ADAPTER_NAMES } });
  fs.writeFileSync(path.join(root, '.planning', 'TEAM.md'), '# TEAM\n\nno fenced block at all here.\n');
  const loaded = crew.loadTeam({ root });
  assert.equal(loaded.state, 'invalid', 'a file that exists and does not parse is not an absent file');
  assert.match(loaded.detail, /REFUSED it/, 'the parser refusal must be carried through, not paraphrased away');
});

test('this view adds NOTHING to the binding union, and it says exactly what the third rung would cost', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'team-manifest.cts'), 'utf8');
  assert.ok(source.includes('binding: { agent: string } | { inline: true };'),
    'the union must still be the 2 members this view reports, otherwise the gap wording has rotted');
  assert.ok(!source.includes('cli:'),
    'this plan must not have widened the binding union');

  // THE CITED LINE NUMBERS ARE PINNED. A gap statement exists so a reader can go
  // straight to the change without hunting, and a citation that drifts by even 1
  // line sends them to the wrong declaration. This shipped statement WAS off by
  // one when written, which is exactly why it is asserted rather than trusted.
  const lines = source.split(/\r?\n/);
  const cited = [
    { n: 128, needle: 'binding: { agent: string } | { inline: true };', what: 'the binding union' },
    { n: 130, needle: "effective_binding: 'agent' | 'inline';", what: 'the effective binding rung' },
  ];
  for (const { n, needle, what } of cited) {
    assert.ok(lines[n - 1] !== undefined && lines[n - 1].includes(needle),
      `${what} must be at src/team-manifest.cts:${n} as this view's gap statement claims, `
      + `line ${n} actually reads: ${JSON.stringify(lines[n - 1])}`);
    assert.ok(crew.CLI_BINDING_GAP.cost.includes(`:${n}`),
      `the gap cost table must cite line ${n}`);
  }
  // The RANGE the view prints must contain both cited lines.
  const [from, to] = crew.CLI_BINDING_GAP.line.split('-').map(Number);
  for (const { n } of cited) {
    assert.ok(n >= from && n <= to,
      `the printed range ${crew.CLI_BINDING_GAP.line} must contain the cited line ${n}`);
  }

  const out = runCli(['roster'], {});
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /THE THIRD RUNG DOES NOT EXIST YET, AND THIS VIEW DID NOT ADD IT/);
  assert.match(out.stdout, /src\/team-manifest\.cts:122-131/, 'the gap must name its file and its line');
  assert.match(out.stdout, /REFUSES unknown bindings on\s+purpose/,
    'the reason the validator must not be widened has to travel with the gap');
});

test('assign over a STAFFED team projects TEAM MEMBERS and names its source as the team', () => {
  const root = withPhase(staffedRoot('assign-team'));
  const out = runCli(['assign', '21'], { root });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /2 team roles read from/, 'the team must be named as the source');
  assert.match(out.stdout, /inline-seat/, 'a team role must take a node');
  assert.match(out.stdout, /agent-seat/);
  assert.doesNotMatch(out.stdout, /FALLBACK/, 'a staffed team is not a fallback');

  // The TEAM is the authority: the vendor identities are configured in this root
  // and they must NOT appear as executors, because a team projection that quietly
  // assigned vendors beside the roles would be the second concept this whole view
  // exists not to be.
  const table = out.stdout.slice(out.stdout.indexOf('CREW MEMBER'));
  for (const name of ADAPTER_NAMES) {
    assert.ok(!table.includes(name),
      `${name} is a configured vendor and must not take a node when a TEAM declares the executors`);
  }
  assert.match(out.stdout, new RegExp(`${SCRATCH_NODE_COUNT} nodes across 2 waves`),
    'every node of the real fixture graph must be projected onto a team member');
  assert.match(out.stdout, /backed by the host runtime, no separate process|the Claude Code subagent/,
    'each projected role must carry what actually backs it');
});

test('assign with NO team manifest falls back and SAYS it fell back', () => {
  const out = runCli(['assign', '21'], {});
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /NO TEAM MANIFEST \(absent\)/);
  assert.match(out.stdout, /That is a FALLBACK and\s+not a team projection/,
    'a fallback presented as a team projection would be the second concept this view exists not to be');
});

test('the executor resolver prefers the team and falls back only when there is no team', () => {
  const fromTeam = crew.resolveExecutors({
    team: { state: 'staffed', roles: [{ id: 'a', binding: { inline: true } }, { id: 'b', binding: { agent: 'x' } }] },
    configured: ADAPTER_NAMES,
    dispatchable: ADAPTER_NAMES,
  });
  assert.equal(fromTeam.source, 'team');
  assert.deepEqual(fromTeam.executors.map((e) => e.name), ['a', 'b'],
    'the team is the authority when it exists, and the vendor roster does not override it');

  const fallback = crew.resolveExecutors({
    team: { state: 'absent', roles: [] },
    configured: ADAPTER_NAMES,
    dispatchable: ADAPTER_NAMES,
  });
  assert.equal(fallback.source, 'fallback-adapters');
  assert.deepEqual(fallback.executors.map((e) => e.name), ADAPTER_NAMES);
});

test('roster over a staffed team still spawns EXACTLY 0 adapters', (t) => {
  const bin = countingBin('team-nospawn', ADAPTER_NAMES);
  const root = staffedRoot('team-nospawn-root');
  const out = runCli(['roster'], { root, pathValue: bin.dir });

  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.length > 600, 'the roster must render before the counter is believed');
  assert.match(out.stdout, /inline-seat/);

  const spawns = spawnCount(bin.counter);
  t.diagnostic(`adapter spawns recorded during a staffed roster: ${spawns}`);
  assert.equal(spawns, 0, `reading a team must spawn EXACTLY 0 adapters, the counter recorded ${spawns}`);
});

/* ------------------------------------------------------------------------ *
 * Usage and unknown verbs.
 * ------------------------------------------------------------------------ */

test('an unknown verb refuses with a non zero exit and prints the usage', () => {
  const out = runCli(['nonesuch'], {});
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /unknown verb 'nonesuch'/);
  assert.match(out.stdout, /roster/);
});

test('assign without a phase refuses rather than guessing one', () => {
  const out = runCli(['assign'], {});
  assert.notEqual(out.status, 0);
  assert.match(out.stdout, /assign needs a phase/);
});

/* ------------------------------------------------------------------------ *
 * The module writes nothing.
 * ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ *
 * ZERO AGENT SPEND, guarded at the source rather than promised in a comment.
 * ------------------------------------------------------------------------ */

test('no arm in this file can reach a paid lane, asserted over this file OWN source', () => {
  // FF-B338 is OPEN and this repository's live `.planning/config.json` declares a
  // NON EMPTY fleet.adapters roster, left configured by the phase 23 run. Under a
  // non empty roster the fleet preflight makes REAL PAID CALLS, 1 per configured
  // adapter, and that has already happened here: a suite once made 12 real calls
  // per run because a probe fired unasked. `checkAdapters` still carries no env
  // kill switch, so the only durable protection is that no arm reaches it.
  //
  // A comment saying so cannot fail. This arm can. The needles are assembled from
  // fragments so that the assertion text below is not itself a match, which would
  // make the check report a violation it created.
  const source = fs.readFileSync(__filename, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const forbidden = [
    { needle: 'fleet-' + 'loop', why: 'the preflight module spends 1 real call per configured adapter' },
    { needle: 'check' + 'Adapters', why: 'the preflight check has no env kill switch (FF-B338)' },
    // The QUOTED argument form only. Reading the flag out of the usage string as
    // a regex literal is how this file proves the warning exists and spends
    // nothing; PASSING it as an argv element is what spends. Those are different
    // shapes and the needle distinguishes them rather than banning the topic.
    { needle: "'--" + "real'", why: 'passing the real lane flag spends 1 real vendor call per member' },
    { needle: 'fleet-' + 'doctor', why: 'the doctor verb drives the same paid preflight' },
  ];
  for (const { needle, why } of forbidden) {
    assert.ok(!source.includes(needle),
      `this file must never name ${needle}: ${why}. Every probe arm here runs the zero spend lane `
      + 'or an injected run stub, and the suite must stay runnable on any machine without spending.');
  }

  // The paired positive: the file DOES drive the probe, so the absence above is a
  // deliberate lane choice and not a file that simply never probes anything.
  assert.ok(source.includes('probeCrew'), 'this file must actually exercise the probe seam');
  assert.ok(source.includes(crew.MOCK_IDENTITY), 'the zero spend lane must be named as the lane used');
});

test('the crew module names no filesystem write operation', () => {
  const source = fs.readFileSync(CREW_CLI, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'renameSync', 'createWriteStream']) {
    assert.ok(!source.includes(forbidden),
      `the crew view must never write: it names ${forbidden}`);
  }
  assert.ok(!source.includes('ferrox-core/bin/vendor'),
    'the crew view must never reach into the byte pinned vendored tree');
});
