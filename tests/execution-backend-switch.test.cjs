'use strict';

/**
 * Phase 21 : the PER RUN backend switch for `/ferrox-execute-phase`.
 *
 * Every arm below spawns `scripts/execution-backend-switch.cjs` as a REAL CHILD
 * PROCESS. A test that imports a library cannot see what `main` does: it cannot
 * see the exit code, it cannot see what reached stderr, and it cannot see
 * whether the wiring that reads the config and probes the tree is connected at
 * all. The 4 required arms are exit code arms, so importing would prove nothing.
 *
 * The 4 REQUIRED FAILING ARMS, and why each exists:
 *
 *   1  `--fleet` with the fleet GENUINELY unavailable REFUSES. Non zero exit,
 *      reason named. A person made a decision; running inline behind their back
 *      would be lying to them.
 *   2  The CONFIG default `fleet`, in the SAME genuinely unavailable tree, exits
 *      0, executes inline, and says so loudly on stderr. A configuration value
 *      must never break an unattended build.
 *   3  `--fleet` and `--inline` together REFUSES. Two contradictory explicit
 *      decisions are not a decision, and last token wins would invent an intent.
 *   4  The backend resolving to `fleet` with NO dispatch manifest consumer says
 *      so explicitly (FF-B379) and executes inline.
 *
 * Arms 1 and 2 run against THE SAME TREE. That is the asymmetry proof: identical
 * availability, identical reason, opposite outcome, and the only difference is
 * which precedence level asked.
 *
 * FALSIFIABILITY. Each refusal arm is paired with an arm that reaches the other
 * answer in a tree that differs in exactly 1 way, so no arm can be passing
 * because its condition is permanent:
 *   - arm 1 and 2's tree is planted into an AVAILABLE tree, which reaches fleet.
 *   - arm 4's consumer gap is closed by writing ONE file that carries the
 *     manifest kind, which reaches `fleet_active` with `executed_backend: fleet`.
 *
 * COUNTERS, NEVER FLAGS. A boolean saying "fell back" is satisfied by an
 * implementation that reports a fallback and does nothing. Every arm asserts the
 * INTEGER counters, and asserts they are NON ZERO before reading any property
 * over them.
 *
 * VALIDATE BEFORE SIDE EFFECTS. `counters.probes` is the receipt: a refusal on
 * contradictory flags must have probed NOTHING, which is asserted as an exact 0
 * alongside a non zero probe count from an arm that did reach the detector.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SWITCH_CLI = path.join(REPO_ROOT, 'scripts', 'execution-backend-switch.cjs');
const SWITCH_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'execution-backend-switch.cjs');

// Constants are READ from the shipped artifacts, never transcribed. Two copies of
// a list is how a new artifact ships with no coverage.
const { FLEET_RUNTIME_ARTIFACTS, FLEET_INTERPRETER, FLEET_MANIFEST_KIND } =
  require('../ferrox-core/bin/lib/claude-orchestration.cjs');
const { CONSUMER_ENTRYPOINT, REFUSAL_EXIT_CODE, PRECEDENCE, SWITCH_CODES } =
  require('../ferrox-core/bin/lib/execution-backend-switch.cjs');
const { CONSUMER_DECLARATION_KEY } = require('../scripts/execution-backend-switch.cjs');

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-backend-switch-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/** A directory holding a real executable named exactly like the interpreter. */
function interpreterBin() {
  const dir = scratch('bin');
  const exe = path.join(dir, FLEET_INTERPRETER + (process.platform === 'win32' ? '.EXE' : ''));
  fs.writeFileSync(exe, '#!/bin/sh\necho 3\n', 'utf8');
  fs.chmodSync(exe, 0o755);
  return dir;
}

const INTERPRETER_BIN = interpreterBin();

function envWithInterpreter() {
  const env = Object.assign({}, process.env);
  env.PATH = INTERPRETER_BIN + path.delimiter + (process.env.PATH || '');
  env.Path = env.PATH;
  return env;
}

/**
 * A project tree. `plant` decides whether the fleet runtime is genuinely there.
 * `backend` is written into `.planning/config.json` as the CONFIG precedence
 * level, so arms 1 and 2 can share one availability condition.
 */
function project(label, opts) {
  const o = opts || {};
  const root = scratch(label);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.planning', 'config.json'),
    JSON.stringify({
      claude_orchestration: { enabled: o.enabled !== false, execution_backend: o.backend },
      fleet: { enabled: o.fleetEnabled !== false },
    }, null, 2),
    'utf8',
  );

  assert.ok(FLEET_RUNTIME_ARTIFACTS.length > 0,
    'the exported artifact list is non empty before anything is planted from it');

  if (o.plant) {
    for (const rel of FLEET_RUNTIME_ARTIFACTS) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '// planted by the phase 21 backend switch proof\n', 'utf8');
    }
    // OBSERVE the plant landed rather than assume the loop ran.
    let planted = 0;
    for (const rel of FLEET_RUNTIME_ARTIFACTS) {
      assert.equal(fs.existsSync(path.join(root, rel)), true, `${rel} was genuinely planted`);
      planted += 1;
    }
    assert.equal(planted, FLEET_RUNTIME_ARTIFACTS.length,
      'every declared runtime artifact was planted');
  } else {
    let absent = 0;
    for (const rel of FLEET_RUNTIME_ARTIFACTS) {
      assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} is genuinely absent`);
      absent += 1;
    }
    assert.equal(absent, FLEET_RUNTIME_ARTIFACTS.length,
      'the unavailability is genuine across every declared artifact');
  }

  if (o.consumer) {
    // A consumer is the DECLARED entry point, exporting the manifest kind it
    // reads. The kind comes from the emitter's own export, so a correct plant
    // cannot drift from what is actually emitted, and `consumer: 'other-kind'`
    // plants an entry point that is present and reads something else. That
    // second shape is the property the old text scan could never have had.
    const consumerFile = path.join(root, CONSUMER_ENTRYPOINT);
    fs.mkdirSync(path.dirname(consumerFile), { recursive: true });
    const declaredKind = o.consumer === 'other-kind'
      ? 'ferrox.some.other.manifest/v9'
      : (o.consumer === 'silent' ? null : FLEET_MANIFEST_KIND);
    fs.writeFileSync(
      consumerFile,
      declaredKind === null
        ? "'use strict';\nmodule.exports = {};\n"
        : "'use strict';\nmodule.exports = { " + CONSUMER_DECLARATION_KEY
          + ": '" + declaredKind + "' };\n",
      'utf8',
    );
    // OBSERVE the plant is loadable and declares what this fixture intended,
    // rather than assuming the write landed as text. The observation loads it
    // exactly as the switch will.
    const planted = require(consumerFile);
    assert.equal(planted[CONSUMER_DECLARATION_KEY] ?? null, declaredKind,
      'the planted consumer genuinely declares the kind this fixture intended');
    assert.equal(declaredKind === FLEET_MANIFEST_KIND, o.consumer === true,
      'only a correct plant declares the emitter own kind');
  }

  return root;
}

/** Spawn the switch as a real child process and parse its JSON. */
function runSwitch(root, args) {
  const argv = [SWITCH_CLI, '--project-root', root, '--json'].concat(args || []);
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', env: envWithInterpreter() });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: parsed };
}

/** Assert the shape every arm reads, before any arm reads it. */
function assertDecided(res, label) {
  assert.notEqual(res.json, null, `${label}: the child emitted parseable JSON. stdout=${res.stdout} stderr=${res.stderr}`);
  assert.equal(res.json.counters.decisions, 1, `${label}: exactly 1 decision was made`);
  assert.ok(res.json.counters.notices > 0, `${label}: the run was not silent`);
  assert.equal(res.json.notices.length, res.json.counters.notices,
    `${label}: the notice counter counts the notices actually emitted`);
}

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED ARM 1 : an explicit --fleet that cannot be honored REFUSES.
// ─────────────────────────────────────────────────────────────────────────────

test('ARM 1: --fleet with the fleet genuinely unavailable REFUSES with a non zero exit and names why', () => {
  const root = project('arm1', { backend: 'auto', plant: false });
  const res = runSwitch(root, ['--fleet']);

  assertDecided(res, 'arm 1');

  // COUNTER FIRST, and NON ZERO, before any property over it.
  assert.ok(res.json.counters.refusals > 0, 'arm 1: the run recorded at least 1 refusal');
  assert.equal(res.json.counters.refusals, 1, 'arm 1: exactly 1 refusal');
  assert.equal(res.json.counters.fallbacks, 0, 'arm 1: a refusal is NOT a fallback');
  assert.ok(res.json.counters.probes > 0,
    'arm 1: the availability detector was genuinely consulted, so the refusal is evidence based');

  assert.notEqual(res.status, 0, 'arm 1: the exit code is non zero');
  assert.equal(res.status, REFUSAL_EXIT_CODE, 'arm 1: the exit code is the refusal code');
  assert.equal(res.json.refused, true);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.precedence, PRECEDENCE.FLAG, 'arm 1: the FLAG level decided');
  assert.equal(res.json.code, SWITCH_CODES.FLEET_UNAVAILABLE_REFUSED);

  // NOTHING was executed. A refusal that still ran inline is the defect.
  assert.equal(res.json.executed_backend, null, 'arm 1: nothing was executed');
  assert.equal(res.json.resolved_backend, null, 'arm 1: no backend was resolved');

  // The reason is NAMED, and it is the detector's own reason rather than a shrug.
  assert.match(res.json.detail, /^fleet_artifact_missing:/,
    `arm 1: the refusal names the specific missing artifact, got ${res.json.detail}`);
  assert.match(res.stderr, /REFUSING/, 'arm 1: the refusal is loud on stderr');
  assert.match(res.stderr, /--fleet/, 'arm 1: stderr names the flag that was refused');
  assert.match(res.stderr, /fleet_artifact_missing:/, 'arm 1: stderr names the reason');
  assert.match(res.stderr, /Nothing was executed/, 'arm 1: stderr states nothing ran');
});

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED ARM 2 : the SAME unavailable tree, decided by CONFIG, falls back.
// ─────────────────────────────────────────────────────────────────────────────

test('ARM 2: the CONFIG default fleet, in the SAME unavailable tree, exits 0, runs inline, and is loud on stderr', () => {
  const root = project('arm2', { backend: 'fleet', plant: false });
  const res = runSwitch(root, []);

  assertDecided(res, 'arm 2');

  assert.ok(res.json.counters.fallbacks > 0, 'arm 2: the run recorded at least 1 fallback');
  assert.equal(res.json.counters.fallbacks, 1, 'arm 2: exactly 1 fallback');
  assert.equal(res.json.counters.refusals, 0, 'arm 2: a config default NEVER refuses');
  assert.ok(res.json.counters.probes > 0, 'arm 2: the detector was genuinely consulted');

  assert.equal(res.status, 0, `arm 2: an unattended build is not broken. stderr=${res.stderr}`);
  assert.equal(res.json.refused, false);
  assert.equal(res.json.precedence, PRECEDENCE.CONFIG, 'arm 2: the CONFIG level decided');
  assert.equal(res.json.requested_backend, 'fleet', 'arm 2: fleet was what was asked for');
  assert.equal(res.json.executed_backend, 'inline', 'arm 2: inline is what actually ran');
  assert.equal(res.json.code, SWITCH_CODES.FLEET_UNAVAILABLE_FALLBACK);

  // LOUD. Not a debug line, not a silent degrade.
  assert.match(res.stderr, /FALLING BACK/, 'arm 2: the fallback is loud on stderr');
  assert.match(res.stderr, /fleet_artifact_missing:/, 'arm 2: stderr names the reason');
  assert.match(res.stderr, /executes inline/, 'arm 2: stderr names what actually happens');
  const warn = res.json.notices.filter((n) => n.level === 'warn');
  assert.ok(warn.length > 0, 'arm 2: the fallback notice is at warn level, not info');
});

test('THE ASYMMETRY: arms 1 and 2 differ ONLY in which precedence level asked', () => {
  const refused = runSwitch(project('asym-flag', { backend: 'auto', plant: false }), ['--fleet']);
  const fellBack = runSwitch(project('asym-config', { backend: 'fleet', plant: false }), []);

  assertDecided(refused, 'asymmetry/flag');
  assertDecided(fellBack, 'asymmetry/config');

  // IDENTICAL availability, IDENTICAL reason.
  assert.equal(refused.json.detail, fellBack.json.detail,
    'both runs faced the same unavailability for the same named reason');
  assert.equal(refused.json.requested_backend, fellBack.json.requested_backend,
    'both runs asked for the same backend');

  // OPPOSITE outcome.
  assert.notEqual(refused.status, fellBack.status,
    'the exit codes differ, which is the whole switch');
  assert.equal(refused.json.counters.refusals + fellBack.json.counters.refusals, 1,
    'exactly 1 of the 2 runs refused');
  assert.equal(refused.json.counters.fallbacks + fellBack.json.counters.fallbacks, 1,
    'exactly 1 of the 2 runs fell back');
});

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED ARM 3 : contradictory flags REFUSE, having probed nothing.
// ─────────────────────────────────────────────────────────────────────────────

test('ARM 3: --fleet and --inline together REFUSES, and is NOT resolved by last token wins', () => {
  const root = project('arm3', { backend: 'auto', plant: false });
  const both = runSwitch(root, ['--fleet', '--inline']);
  const reversed = runSwitch(root, ['--inline', '--fleet']);

  for (const [label, res] of [['fleet then inline', both], ['inline then fleet', reversed]]) {
    assertDecided(res, `arm 3/${label}`);
    assert.ok(res.json.counters.refusals > 0, `arm 3/${label}: at least 1 refusal`);
    assert.equal(res.json.counters.refusals, 1, `arm 3/${label}: exactly 1 refusal`);
    assert.notEqual(res.status, 0, `arm 3/${label}: non zero exit`);
    assert.equal(res.status, REFUSAL_EXIT_CODE, `arm 3/${label}: the refusal code`);
    assert.equal(res.json.code, SWITCH_CODES.CONFLICTING_FLAGS);
    assert.equal(res.json.executed_backend, null, `arm 3/${label}: nothing was executed`);
    assert.match(res.stderr, /REFUSING/, `arm 3/${label}: loud on stderr`);

    // VALIDATE BEFORE SIDE EFFECTS. The receipt is an EXACT zero probe count: no
    // config was read, no tree was walked, no verdict was loaded.
    assert.equal(res.json.counters.probes, 0,
      `arm 3/${label}: a contradictory invocation refuses having probed nothing`);
  }

  // Order does not change the answer, which is what "not last token wins" means.
  assert.equal(both.status, reversed.status);
  assert.equal(both.json.code, reversed.json.code);

  // FALSIFIABILITY of the probe assertion: an arm that DID reach the detector in
  // the same tree records a non zero probe count, so the exact 0 above is a
  // property of the refusal rather than of the counter never moving.
  const reached = runSwitch(root, ['--fleet']);
  assert.ok(reached.json.counters.probes > 0,
    'the probe counter genuinely moves when a run reaches the detector');
});

test('a repeated single flag is 1 decision stated twice, not a contradiction', () => {
  const res = runSwitch(project('repeat', { backend: 'auto', plant: false }), ['--inline', '--inline']);
  assertDecided(res, 'repeat');
  assert.equal(res.json.counters.refusals, 0, 'a repeated flag is not a refusal');
  assert.equal(res.status, 0);
  assert.equal(res.json.executed_backend, 'inline');
});

test('--inline ALWAYS succeeds, even in a tree where the fleet is unavailable', () => {
  const res = runSwitch(project('inline-always', { backend: 'fleet', plant: false }), ['--inline']);
  assertDecided(res, 'inline-always');
  assert.equal(res.status, 0, `inline is always available. stderr=${res.stderr}`);
  assert.equal(res.json.counters.refusals, 0);
  assert.equal(res.json.counters.fallbacks, 0);
  assert.equal(res.json.precedence, PRECEDENCE.FLAG, 'the flag outranks the config default fleet');
  assert.equal(res.json.executed_backend, 'inline');
  // The flag outranking config is asserted by a probe count of 0 as well: inline
  // needs no detector, so nothing was consulted to reach it.
  assert.equal(res.json.counters.probes, 0, 'an explicit inline consults nothing');
});

// ─────────────────────────────────────────────────────────────────────────────
// REQUIRED ARM 4 : fleet resolves, no dispatch consumer, says so and runs inline.
// ─────────────────────────────────────────────────────────────────────────────

test('ARM 4: the backend resolving to fleet with NO consumer installed says so by name and executes inline', () => {
  const root = project('arm4', { backend: 'fleet', plant: true, consumer: false });
  const res = runSwitch(root, ['--fleet']);

  assertDecided(res, 'arm 4');

  assert.ok(res.json.counters.consumer_gaps > 0, 'arm 4: at least 1 consumer gap recorded');
  assert.equal(res.json.counters.consumer_gaps, 1, 'arm 4: exactly 1 consumer gap');
  assert.equal(res.json.counters.refusals, 0, 'arm 4: the consumer gap is not a refusal');
  assert.equal(res.status, 0, `arm 4: the run proceeds. stderr=${res.stderr}`);

  // The distinction the whole arm exists for: what RESOLVED and what RAN differ.
  assert.equal(res.json.resolved_backend, 'fleet', 'arm 4: fleet genuinely resolved');
  assert.equal(res.json.executed_backend, 'inline', 'arm 4: inline is what actually ran');
  assert.notEqual(res.json.resolved_backend, res.json.executed_backend,
    'arm 4: the gap is exactly the difference between these 2 fields');
  assert.equal(res.json.code, SWITCH_CODES.FLEET_CONSUMER_MISSING);
  assert.equal(res.json.consumer_matches.length, 0, 'arm 4: no consumer was observed');
  assert.equal(res.json.consumer_declared.length, 0,
    'arm 4: the registered entry point is genuinely absent from this tree, not merely unmatched');

  // ─── THE LINE HAS A NEW NAME, AND THAT IS THE POINT ───────────────────────
  //
  // This used to read `dispatch consumer not built (FF-B379)`, because no
  // consumer existed anywhere. One ships now, so a tree WITHOUT it is a tree
  // missing an install rather than a repository missing a component, and the
  // line says exactly that and names the entry point to install. The old
  // sentence is asserted ABSENT so a revert cannot quietly restore a claim about
  // work that is done.
  const EXPECTED = 'fleet backend resolved, no dispatch manifest consumer is installed in this '
    + 'tree (' + CONSUMER_ENTRYPOINT + ' is absent or declares a different manifest kind), '
    + 'executing inline';
  assert.equal(res.json.reason, EXPECTED, 'arm 4: the reason is the readable line, verbatim');
  assert.ok(res.stderr.includes(EXPECTED), `arm 4: the line reached stderr. stderr=${res.stderr}`);
  assert.ok(res.stderr.includes(CONSUMER_ENTRYPOINT), 'arm 4: the missing entry point is named');
  assert.equal(res.stderr.includes('dispatch consumer not built'), false,
    'arm 4: the retired FF-B379 sentence is gone, because the consumer is built');
});

test('ARM 4 is FALSIFIABLE: installing the declared consumer reaches a real fleet resolution', () => {
  const withConsumer = project('arm4-closed', { backend: 'fleet', plant: true, consumer: true });
  const res = runSwitch(withConsumer, ['--fleet']);

  assertDecided(res, 'arm 4 falsifiability');
  assert.equal(res.status, 0, `stderr=${res.stderr}`);
  assert.equal(res.json.counters.consumer_gaps, 0, 'the gap is CLOSED, so no gap is recorded');
  assert.equal(res.json.resolved_backend, 'fleet');
  assert.equal(res.json.executed_backend, 'fleet',
    'with the declared consumer installed the run genuinely resolves to the fleet');
  assert.equal(res.json.code, SWITCH_CODES.FLEET_ACTIVE);
  assert.ok(res.json.consumer_matches.length > 0, 'the observed consumer is NAMED');
  assert.equal(res.json.consumer_matches[0], CONSUMER_ENTRYPOINT);

  // RESOLUTION IS NOT EXECUTION. The switch must not claim a fleet RAN: it
  // spawned nothing and counted nothing. It names the entry point that will.
  assert.ok(res.stderr.includes('dispatching through ' + CONSUMER_ENTRYPOINT),
    `the switch names the consumer it hands off to. stderr=${res.stderr}`);
  assert.equal(res.stderr.includes('executing as a fleet'), false,
    'the switch never claims a fleet executed, because it did not run one');
});

test('an entry point that declares a DIFFERENT manifest kind is NOT a consumer', () => {
  // The property a text scan could never have had. A module sitting at the
  // registered path, loading cleanly, reading some other document, is not a
  // consumer of THIS manifest, and counting it would report the gap closed by a
  // file that cannot dispatch anything.
  const root = project('arm4-wrongkind', { backend: 'fleet', plant: true, consumer: 'other-kind' });
  const res = runSwitch(root, ['--fleet']);

  assertDecided(res, 'wrong kind');
  assert.equal(res.status, 0, `stderr=${res.stderr}`);

  // NON ZERO FIRST: the entry point was genuinely FOUND and LOADED, so the
  // absence below is a mismatch and not a missing file.
  assert.ok(res.json.consumer_declared.length > 0, 'the registered entry point was found');
  assert.equal(res.json.consumer_declared[0].loaded, true, 'and it loaded');
  assert.equal(res.json.consumer_declared[0].kind, 'ferrox.some.other.manifest/v9',
    'and it declared a kind, just not this one');
  assert.notEqual(res.json.consumer_declared[0].kind, FLEET_MANIFEST_KIND);

  assert.equal(res.json.counters.consumer_gaps, 1, 'so the gap is still counted');
  assert.equal(res.json.consumer_matches.length, 0, 'and nothing matched');
  assert.equal(res.json.executed_backend, 'inline', 'and the run executes inline');
  assert.equal(res.json.code, SWITCH_CODES.FLEET_CONSUMER_MISSING);
});

test('an entry point that declares NOTHING is not a consumer either', () => {
  // Presence on disk is not evidence. A file at the registered path that exports
  // no declaration has told the observer nothing about what it reads, and
  // counting it would close the gap on the strength of a filename.
  const root = project('arm4-silent', { backend: 'fleet', plant: true, consumer: 'silent' });
  const res = runSwitch(root, ['--fleet']);

  assertDecided(res, 'silent consumer');
  assert.ok(res.json.consumer_declared.length > 0, 'the file was genuinely found');
  assert.equal(res.json.consumer_declared[0].loaded, true, 'and it loaded cleanly');
  assert.equal(res.json.consumer_declared[0].kind, null, 'and it declared nothing');
  assert.equal(res.json.counters.consumer_gaps, 1, 'so the gap stands');
  assert.equal(res.json.executed_backend, 'inline');
});

test('this repository ships the declared consumer, and it reads the emitter own kind', () => {
  // FF-B379 CLOSED, asserted against the live tree rather than a fixture. The
  // arm above proves an empty tree still reports the gap; this one proves the
  // gap is genuinely shut here, which is the claim the phase makes.
  const observed = require('../scripts/execution-backend-switch.cjs').observeDispatchConsumer(REPO_ROOT);

  // THE KIND IS READABLE FIRST. An observer that could not read the manifest kind
  // would report "no consumer" for a reason that has nothing to do with consumers,
  // and the claim below would be true or false by accident. This exact defect was
  // found by the mutation battery: the constant was not exported at all.
  assert.equal(typeof observed.kind, 'string', 'the manifest kind is genuinely readable');
  assert.ok(observed.kind.length > 0, 'the manifest kind is non empty');
  assert.equal(observed.kind, FLEET_MANIFEST_KIND, 'the observer reads the emitter own kind');

  assert.ok(observed.matches.length > 0,
    `the dispatch consumer is installed here, declared=${JSON.stringify(observed.declared)}`);
  assert.equal(observed.present, true);
  assert.equal(observed.matches[0], CONSUMER_ENTRYPOINT);

  // AND IT IS THE SAME CONSTANT, not a copy that happens to agree today. The
  // consumer imports the kind off the producer's export, so a producer that
  // changed its kind would take the consumer with it.
  const consumer = require('../scripts/fleet-dispatch.cjs');
  assert.equal(consumer[CONSUMER_DECLARATION_KEY], FLEET_MANIFEST_KIND,
    'the consumer declares the kind the emitter exports');
  assert.equal(
    fs.readFileSync(path.join(REPO_ROOT, CONSUMER_ENTRYPOINT), 'utf8').includes(
      "'" + FLEET_MANIFEST_KIND + "'"),
    false,
    'and it does so by IMPORTING the constant rather than transcribing the literal',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// LANGUAGE : the surface people actually use. 5 required arms.
//
// The flag is the machine surface. A person types a sentence, so the sentence is
// precedence level 2, above the config default, and an inferred fleet REFUSES on
// unavailability exactly as `--fleet` does, because the person decided.
// ─────────────────────────────────────────────────────────────────────────────

/** Sentences that genuinely ask for a fleet. */
const FLEET_SENTENCES = Object.freeze([
  'build it with the ferrox fleet',
  'use the fleet',
  'build phase 21 with the fleet',
  'run it wide',
  'fleet mode',
]);

/**
 * Sentences that MENTION a fleet without asking for one. This corpus is the
 * narrowness proof, and it is the most important thing in this file: a matcher
 * that fires on any of these dispatches a backend nobody asked for.
 */
const MENTION_SENTENCES = Object.freeze([
  'the fleet benchmark returned NEGATIVE',
  'compare it with the fleet numbers before deciding',
  'the fleet is slower than inline on this phase',
  'read the fleet documentation',
  'phase 21 shipped the fleet glass and the fleet foreman',
]);

test('LANGUAGE ARM 1: a sentence carrying fleet intent resolves fleet AND echoes what it understood', () => {
  let echoed = 0;
  for (const sentence of FLEET_SENTENCES) {
    // A tree where the fleet CAN run, so this arm reads the resolution rather
    // than the refusal that arm 3 owns.
    const res = runSwitch(project('lang1', { backend: 'auto', plant: true, consumer: true }),
      ['--intent', sentence]);
    assertDecided(res, `language 1/${sentence}`);

    // COUNTER FIRST, NON ZERO, before any property over it.
    assert.ok(res.json.counters.inferences > 0,
      `language 1/${sentence}: the run recorded at least 1 inference`);
    assert.equal(res.json.counters.inferences, 1,
      `language 1/${sentence}: exactly 1 backend was read out of words`);
    assert.ok(res.json.intent.counters.candidates > 0,
      `language 1/${sentence}: the matcher genuinely scanned its object list`);
    assert.ok(res.json.intent.counters.fleet_matches > 0,
      `language 1/${sentence}: the matcher genuinely matched`);

    assert.equal(res.json.precedence, PRECEDENCE.LANGUAGE,
      `language 1/${sentence}: the LANGUAGE level decided`);
    assert.equal(res.json.requested_backend, 'fleet');
    assert.equal(res.json.executed_backend, 'fleet',
      `language 1/${sentence}: it genuinely reached the fleet. stderr=${res.stderr}`);

    // THE ECHO. An inference the reader cannot see is worse than a flag.
    const echo = res.json.notices.filter((n) => n.code === SWITCH_CODES.LANGUAGE_INTENT);
    assert.equal(echo.length, 1, `language 1/${sentence}: exactly 1 echo notice`);
    assert.ok(echo[0].text.includes(res.json.intent.phrase),
      `language 1/${sentence}: the echo names the phrase that triggered it, got ${echo[0].text}`);
    assert.match(echo[0].text, /^understood "/,
      `language 1/${sentence}: the echo states what was understood`);
    assert.match(echo[0].text, /to override\.$/,
      `language 1/${sentence}: the echo names how to override it`);
    assert.ok(res.stderr.includes(echo[0].text),
      `language 1/${sentence}: the echo genuinely reached stderr`);
    echoed += 1;
  }
  assert.equal(echoed, FLEET_SENTENCES.length, 'every fleet sentence was echoed');
});

test('LANGUAGE ARM 2: a sentence that merely MENTIONS the fleet resolves NO backend', () => {
  let scanned = 0;
  for (const sentence of MENTION_SENTENCES) {
    const res = runSwitch(project('lang2', { backend: 'auto', plant: true, consumer: true }),
      ['--intent', sentence]);
    assertDecided(res, `language 2/${sentence}`);

    // NON ZERO FIRST: the matcher genuinely ran over this sentence. Without this,
    // a matcher that never executed would pass the whole arm.
    assert.ok(res.json.intent.counters.texts > 0,
      `language 2/${sentence}: the sentence was genuinely read`);
    assert.ok(res.json.intent.counters.candidates > 0,
      `language 2/${sentence}: the matcher genuinely scanned its object list`);

    assert.equal(res.json.intent.counters.fleet_matches, 0,
      `language 2/${sentence}: no fleet request was found`);
    assert.equal(res.json.counters.inferences, 0,
      `language 2/${sentence}: nothing was inferred`);
    assert.equal(res.json.intent.backend, null,
      `language 2/${sentence}: the matcher reports no backend`);
    assert.notEqual(res.json.precedence, PRECEDENCE.LANGUAGE,
      `language 2/${sentence}: the LANGUAGE level did not decide`);
    assert.equal(res.json.executed_backend, 'inline',
      `language 2/${sentence}: a mention does not dispatch a fleet`);
    scanned += 1;
  }
  assert.equal(scanned, MENTION_SENTENCES.length, 'every mention sentence was scanned');

  // FALSIFIABILITY: the same tree, the same matcher, 1 sentence that DOES ask.
  const asked = runSwitch(project('lang2-falsify', { backend: 'auto', plant: true, consumer: true }),
    ['--intent', 'use the fleet']);
  assert.equal(asked.json.executed_backend, 'fleet',
    'the matcher genuinely reaches fleet in this tree, so the 0 counts above are a property of the sentences');
});

test('LANGUAGE ARM 3: an INFERRED fleet that cannot be honored REFUSES and executes nothing', () => {
  const res = runSwitch(project('lang3', { backend: 'auto', plant: false }),
    ['--intent', 'build it with the ferrox fleet']);
  assertDecided(res, 'language 3');

  assert.ok(res.json.counters.refusals > 0, 'language 3: at least 1 refusal');
  assert.equal(res.json.counters.refusals, 1, 'language 3: exactly 1 refusal');
  assert.equal(res.json.counters.fallbacks, 0,
    'language 3: an inferred decision NEVER falls back. That is the whole property');
  assert.ok(res.json.counters.probes > 0, 'language 3: the detector was genuinely consulted');
  assert.equal(res.json.counters.inferences, 1, 'language 3: the inference was still echoed');

  assert.notEqual(res.status, 0, 'language 3: non zero exit');
  assert.equal(res.status, REFUSAL_EXIT_CODE);
  assert.equal(res.json.precedence, PRECEDENCE.LANGUAGE);
  assert.equal(res.json.code, SWITCH_CODES.FLEET_UNAVAILABLE_REFUSED);
  assert.equal(res.json.executed_backend, null, 'language 3: nothing was executed');
  assert.equal(res.json.resolved_backend, null, 'language 3: no backend was resolved');
  assert.match(res.stderr, /REFUSING/, 'language 3: loud on stderr');
  assert.ok(res.stderr.includes('build it with the ferrox fleet'),
    `language 3: the refusal names the words that asked. stderr=${res.stderr}`);

  // THE ASYMMETRY, restated at this level: the SAME unavailable tree, asked by
  // CONFIG instead of by words, falls back rather than refusing.
  const byConfig = runSwitch(project('lang3-config', { backend: 'fleet', plant: false }), []);
  assert.equal(byConfig.status, 0, 'a config default never breaks an unattended build');
  assert.equal(byConfig.json.counters.fallbacks, 1);
  assert.equal(res.json.detail, byConfig.json.detail,
    'both runs faced the same unavailability for the same named reason');
});

test('LANGUAGE ARM 4: a flag DISAGREEING with the words follows the flag and says that it did', () => {
  const res = runSwitch(project('lang4', { backend: 'auto', plant: true, consumer: true }),
    ['--inline', '--intent', 'build it with the ferrox fleet']);
  assertDecided(res, 'language 4');

  assert.ok(res.json.counters.overrides > 0, 'language 4: at least 1 override recorded');
  assert.equal(res.json.counters.overrides, 1, 'language 4: exactly 1 override');
  assert.equal(res.json.counters.inferences, 0,
    'language 4: the flag decided, so no backend was read out of words');

  assert.equal(res.json.precedence, PRECEDENCE.FLAG, 'language 4: the FLAG level decided');
  assert.equal(res.json.executed_backend, 'inline', 'language 4: the flag is what ran');

  const said = res.json.notices.filter((n) => n.code === SWITCH_CODES.LANGUAGE_OVERRIDDEN);
  assert.equal(said.length, 1, 'language 4: exactly 1 override notice');
  assert.ok(said[0].text.includes('build it with the ferrox fleet'),
    `language 4: the notice names the words that lost, got ${said[0].text}`);
  assert.match(said[0].text, /Following the flag/, 'language 4: the notice names which one won');
  assert.ok(res.stderr.includes(said[0].text), 'language 4: it genuinely reached stderr');

  // AGREEMENT is not an override: the counter moves for disagreement only.
  const agrees = runSwitch(project('lang4-agree', { backend: 'auto', plant: true, consumer: true }),
    ['--fleet', '--intent', 'build it with the ferrox fleet']);
  assert.equal(agrees.json.counters.overrides, 0,
    'a flag agreeing with the words is not an override');
  assert.equal(agrees.json.executed_backend, 'fleet');
});

test('LANGUAGE ARM 5: one sentence asking for BOTH backends REFUSES, having probed nothing', () => {
  const root = project('lang5', { backend: 'auto', plant: true, consumer: true });
  const res = runSwitch(root, ['--intent', 'use the fleet but run it inline']);
  assertDecided(res, 'language 5');

  assert.ok(res.json.counters.refusals > 0, 'language 5: at least 1 refusal');
  assert.equal(res.json.counters.refusals, 1, 'language 5: exactly 1 refusal');
  assert.ok(res.json.intent.counters.fleet_matches > 0, 'language 5: a fleet request was found');
  assert.ok(res.json.intent.counters.inline_matches > 0, 'language 5: an inline request was found');

  assert.notEqual(res.status, 0, 'language 5: non zero exit');
  assert.equal(res.status, REFUSAL_EXIT_CODE);
  assert.equal(res.json.code, SWITCH_CODES.CONFLICTING_LANGUAGE);
  assert.equal(res.json.executed_backend, null, 'language 5: nothing was executed');

  // The SAME rung as contradictory flags: validated before any side effect, so the
  // receipt is an exact 0 probe count.
  assert.equal(res.json.counters.probes, 0,
    'language 5: a contradictory sentence refuses having probed nothing');
  assert.match(res.stderr, /REFUSING/, 'language 5: loud on stderr');

  // FALSIFIABILITY: the same tree reaches a decision when the sentence is coherent.
  const coherent = runSwitch(root, ['--intent', 'use the fleet']);
  assert.equal(coherent.json.counters.refusals, 0);
  assert.equal(coherent.json.executed_backend, 'fleet');
});

test('a negated fleet request is an INLINE decision, not a fleet one', () => {
  const res = runSwitch(project('negated', { backend: 'auto', plant: true, consumer: true }),
    ['--intent', 'dont use the fleet for this one']);
  assertDecided(res, 'negated');
  assert.ok(res.json.intent.counters.negations > 0, 'the negation was genuinely seen');
  assert.equal(res.json.precedence, PRECEDENCE.LANGUAGE);
  assert.equal(res.json.executed_backend, 'inline');
  assert.equal(res.json.intent.phrase, 'dont use the fleet',
    'the echoed phrase starts at the negator, so the echo reads as the sentence typed');
});

test('the flag TOKENS themselves are not read as language, so a flag cannot self trigger', () => {
  // `--intent "21 --fleet"` is a person quoting their own arguments. The words
  // carry no request, and the flag parser must not read the QUOTED value as a flag.
  const res = runSwitch(project('selftrigger', { backend: 'auto', plant: false }),
    ['--intent', '21 --fleet']);
  assertDecided(res, 'self trigger');
  assert.equal(res.json.counters.refusals, 0,
    `a quoted flag inside intent text is not a decision. stderr=${res.stderr}`);
  assert.equal(res.json.counters.inferences, 0, 'and it is not an inference either');
  assert.equal(res.json.executed_backend, 'inline');

  // The stripper is what makes that true, and it is asserted directly.
  const { stripValueFlags } = require('../scripts/execution-backend-switch.cjs');
  assert.deepEqual(stripValueFlags(['--intent', '--fleet', '--json']), ['--json'],
    'a value flag consumes its value, so the value is never an invocation token');
});

// ─────────────────────────────────────────────────────────────────────────────
// PRECEDENCE : the config, the recommendation and the default.
// ─────────────────────────────────────────────────────────────────────────────

test('precedence level 3: a supplied recommendation decides when no flag and no config default exist', () => {
  const root = project('rec', { backend: 'auto', plant: false });
  const res = runSwitch(root, ['--recommendation', 'solo']);
  assertDecided(res, 'recommendation');
  assert.equal(res.status, 0);
  assert.equal(res.json.precedence, PRECEDENCE.RECOMMENDATION);
  assert.equal(res.json.executed_backend, 'inline', 'the verdict word solo maps onto inline');
  assert.match(res.json.detail, /parallelism_verdict:/, 'the provenance of the pick is named');
});

test('precedence level 3 loses to level 2, and level 2 loses to level 1', () => {
  // config fleet + recommendation solo: CONFIG wins, so the run tries fleet.
  const configWins = runSwitch(project('prec-config', { backend: 'fleet', plant: false }),
    ['--recommendation', 'solo']);
  assert.equal(configWins.json.precedence, PRECEDENCE.CONFIG);
  assert.equal(configWins.json.requested_backend, 'fleet');

  // flag inline + config fleet + recommendation fleet: the FLAG wins.
  const flagWins = runSwitch(project('prec-flag', { backend: 'fleet', plant: false }),
    ['--inline', '--recommendation', 'fleet']);
  assert.equal(flagWins.json.precedence, PRECEDENCE.FLAG);
  assert.equal(flagWins.json.executed_backend, 'inline');
});

test('precedence level 4 degrades to inline with a NAMED reason, never a shrug', () => {
  const res = runSwitch(project('default', { backend: 'auto', plant: false }), []);
  assertDecided(res, 'default');
  assert.equal(res.status, 0);
  assert.equal(res.json.precedence, PRECEDENCE.DEFAULT);
  assert.equal(res.json.executed_backend, 'inline');
  assert.match(res.json.detail, /^recommendation_unavailable:/,
    `the degrade names why level 3 was unusable, got ${res.json.detail}`);
});

test('the recommendation VOCABULARY is read from the parallelism verdict module, not transcribed', () => {
  const { readVerdictModes } = require('../scripts/execution-backend-switch.cjs');
  const modes = readVerdictModes();
  assert.equal(modes.present, true,
    `the verdict module is loadable and exposes MODES, source=${modes.source}`);
  assert.equal(modes.source, 'parallelism-verdict');
  const verdict = require('../scripts/parallelism-verdict.cjs');
  assert.equal(modes.fleet, verdict.MODES.FLEET, 'the fleet word comes from the verdict module');
  assert.equal(modes.solo, verdict.MODES.SOLO, 'the solo word comes from the verdict module');

  // An invented third word is refused rather than guessed at.
  const res = runSwitch(project('badmode', { backend: 'auto', plant: false }),
    ['--recommendation', 'sideways']);
  assert.equal(res.json.precedence, PRECEDENCE.DEFAULT);
  assert.match(res.json.detail, /unrecognised_mode:sideways/);
});

// ─────────────────────────────────────────────────────────────────────────────
// WIRING : the switch is reachable from `/ferrox-execute-phase`.
// ─────────────────────────────────────────────────────────────────────────────

test('the execute-phase surfaces document both flags and run the switch', () => {
  const workflow = fs.readFileSync(
    path.join(REPO_ROOT, 'ferrox-core', 'workflows', 'execute-phase.md'), 'utf8');
  // FF-B477: the switch is resolved through the canonical ferrox_script resolver
  // rather than a literal ${FERROX_ROOT}/scripts/... path, because that path could
  // only ever name the user's project and never a global install root.
  assert.ok(workflow.includes('ferrox_script execution-backend-switch.cjs'),
    'the workflow invokes the switch through the canonical resolver');
  assert.ok(workflow.includes('ferrox_script() {'),
    'the workflow carries the canonical resolver definition it calls');
  assert.ok(workflow.includes('resolve_execution_backend'),
    'the workflow carries the backend resolution step');
  assert.ok(workflow.includes(CONSUMER_ENTRYPOINT),
    'the workflow invokes the dispatch manifest consumer by path');
  assert.ok(workflow.includes('dispatched_fleet'),
    'the workflow reads the consumer own outcome rather than announcing a fleet itself');

  for (const rel of [
    path.join('skills', 'ferrox-execute-phase', 'SKILL.md'),
    path.join('commands', 'ferrox', 'execute-phase.md'),
  ]) {
    const body = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.ok(body.includes('`--fleet`'), `${rel} documents the fleet flag`);
    assert.ok(body.includes('`--inline`'), `${rel} documents the inline flag`);
    assert.ok(body.includes('REFUSES'), `${rel} states that an unhonorable --fleet refuses`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION BATTERY : every replacement asserted APPLIED on disk, every artifact
// restored, and the tree proved byte identical afterwards with `git diff`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each mutant names a file, an exact substring to replace, its replacement, and
 * the arm that must go RED. A mutant whose replacement is not found on disk is a
 * FAILURE of the battery rather than a skip: a battery that silently skips is a
 * battery reporting a score it did not earn.
 */
const MUTANTS = [
  // ── the lib: the refusal asymmetry ──
  {
    id: 'M01', file: SWITCH_LIB,
    from: 'const REFUSAL_EXIT_CODE = 2;', to: 'const REFUSAL_EXIT_CODE = 0;',
    why: 'a refusal that exits 0 is not a refusal',
    check: (run) => run(project('m01', { backend: 'auto', plant: false }), ['--fleet']).status !== 0,
  },
  {
    id: 'M02', file: SWITCH_LIB,
    from: 'if (wantsFleet && wantsInline) {', to: 'if (false) {',
    why: 'contradictory flags must not resolve to a pick',
    // The exit code ALONE cannot kill this mutant: without the conflict rung the
    // run picks fleet, finds it unavailable, and refuses anyway with a non zero
    // exit for an entirely different reason. The guarded property is the REASON,
    // so that is what this asserts.
    check: (run) => {
      const r = run(project('m02', { backend: 'auto', plant: false }), ['--fleet', '--inline']);
      return r.status !== 0 && r.json !== null && r.json.code === SWITCH_CODES.CONFLICTING_FLAGS;
    },
  },
  {
    id: 'M03', file: SWITCH_LIB,
    from: 'if (isExplicitDecision(result.precedence)) {', to: 'if (false) {',
    why: 'an explicit --fleet must refuse rather than fall back',
    check: (run) => run(project('m03', { backend: 'auto', plant: false }), ['--fleet']).status !== 0,
  },
  {
    id: 'M04', file: SWITCH_LIB,
    from: 'if (isExplicitDecision(result.precedence)) {', to: 'if (true) {',
    why: 'a config default must fall back rather than refuse',
    check: (run) => run(project('m04', { backend: 'fleet', plant: false }), []).status === 0,
  },
  // ── the lib: the missing consumer report ──
  {
    id: 'M05', file: SWITCH_LIB,
    from: 'if (!consumerPresent) {', to: 'if (false) {',
    why: 'a fleet with no consumer must not report itself as running',
    check: (run) => {
      const r = run(project('m05', { backend: 'fleet', plant: true }), ['--fleet']);
      return r.json !== null && r.json.executed_backend === 'inline';
    },
  },
  {
    id: 'M06', file: SWITCH_LIB,
    from: "result.reason = 'fleet backend resolved, no dispatch manifest consumer is installed in this '",
    to: "result.reason = 'all good ('",
    why: 'the missing consumer line is the line a demo audience reads',
    check: (run) => {
      const r = run(project('m06', { backend: 'fleet', plant: true }), ['--fleet']);
      return r.stderr.includes('no dispatch manifest consumer is installed');
    },
  },
  // ── the script: the declared registry, which replaced the text scan ──
  {
    id: 'M06b', file: SWITCH_CLI,
    from: '    if (consumed === kind) matches.push(rel);',
    to: '    matches.push(rel);',
    why: 'an entry point declaring a DIFFERENT manifest kind must not close the gap',
    check: (run) => {
      const r = run(project('m06b', { backend: 'fleet', plant: true, consumer: 'other-kind' }), ['--fleet']);
      return r.json !== null && r.json.counters.consumer_gaps === 1
        && r.json.executed_backend === 'inline';
    },
  },
  // ── the lib: counters, never flags ──
  {
    id: 'M07', file: SWITCH_LIB,
    from: '      result.counters.refusals = 1;', to: '      result.counters.refusals = 0;',
    why: 'a refusal must be COUNTED, not merely announced',
    check: (run) => {
      const r = run(project('m07', { backend: 'auto', plant: false }), ['--fleet']);
      return r.json !== null && r.json.counters.refusals === 1;
    },
  },
  {
    id: 'M08', file: SWITCH_LIB,
    from: '    result.counters.fallbacks = 1;', to: '    result.counters.fallbacks = 0;',
    why: 'a fallback must be COUNTED, not merely announced',
    check: (run) => {
      const r = run(project('m08', { backend: 'fleet', plant: false }), []);
      return r.json !== null && r.json.counters.fallbacks === 1;
    },
  },
  {
    id: 'M09', file: SWITCH_LIB,
    from: '    result.counters.consumer_gaps = 1;', to: '    result.counters.consumer_gaps = 0;',
    why: 'the consumer gap must be COUNTED',
    check: (run) => {
      const r = run(project('m09', { backend: 'fleet', plant: true }), ['--fleet']);
      return r.json !== null && r.json.counters.consumer_gaps === 1;
    },
  },
  {
    id: 'M10', file: SWITCH_LIB,
    from: '    counters.probes += 1;', to: '    counters.probes += 0;',
    why: 'the probe receipt is what proves validation preceded side effects',
    check: (run) => {
      const r = run(project('m10', { backend: 'auto', plant: false }), ['--fleet']);
      return r.json !== null && r.json.counters.probes > 0;
    },
  },
  // ── the lib: precedence ──
  {
    id: 'M11', file: SWITCH_LIB,
    from: '        result.precedence = decision.precedence;', to: '        result.precedence = PRECEDENCE.CONFIG;',
    why: 'every outcome must name WHICH precedence level decided',
    check: (run) => {
      const r = run(project('m11', { backend: 'auto', plant: false }), ['--inline']);
      return r.json !== null && r.json.precedence === PRECEDENCE.FLAG;
    },
  },
  {
    id: 'M12', file: SWITCH_LIB,
    from: 'if (cfgRaw === BACKEND_FLEET || cfgRaw === BACKEND_INLINE) {', to: 'if (false) {',
    why: 'the config default is precedence level 2 and must be consulted',
    check: (run) => {
      const r = run(project('m12', { backend: 'fleet', plant: false }), []);
      return r.json !== null && r.json.precedence === PRECEDENCE.CONFIG;
    },
  },
  {
    id: 'M13', file: SWITCH_LIB,
    from: '  const flags = parseBackendFlags(argv);', to: '  const flags = { ok: true, flag: null };',
    why: 'flag validation is the first thing that happens',
    check: (run) => run(project('m13', { backend: 'auto', plant: false }), ['--fleet', '--inline']).status !== 0,
  },
  // ── the command line interface: loudness and the availability question ──
  {
    id: 'M14', file: SWITCH_CLI,
    from: '  for (const notice of result.notices) {', to: '  for (const notice of []) {',
    why: 'no path is ever silent',
    check: (run) => run(project('m14', { backend: 'fleet', plant: false }), []).stderr.includes('FALLING BACK'),
  },
  {
    id: 'M15', file: SWITCH_CLI,
    from: "  flatConfig['claude_orchestration.execution_backend'] = BACKEND_FLEET;",
    to: "  flatConfig['claude_orchestration.execution_backend'] = BACKEND_INLINE;",
    why: 'the availability question must be asked ABOUT the fleet',
    check: (run) => {
      const r = run(project('m15', { backend: 'fleet', plant: true, consumer: true }), ['--fleet']);
      return r.json !== null && r.json.executed_backend === 'fleet';
    },
  },
  {
    id: 'M16', file: SWITCH_CLI,
    from: "    const consumed = (mod !== null && typeof mod === 'object') ? mod[CONSUMER_DECLARATION_KEY] : undefined;",
    to: '    const consumed = kind;',
    why: 'a module at the registered path that DECLARES NOTHING is not a consumer, and '
      + 'presence on disk is not evidence that anything reads the manifest',
    check: (run) => {
      const r = run(project('m16', { backend: 'fleet', plant: true, consumer: 'silent' }), ['--fleet']);
      return r.json !== null && r.json.counters.consumer_gaps === 1
        && r.json.executed_backend === 'inline';
    },
  },
  // ── the lib: language is a DECISION, not a default ──
  {
    id: 'M18', file: SWITCH_LIB,
    from: '    return precedence === PRECEDENCE.FLAG || precedence === PRECEDENCE.LANGUAGE;',
    to: '    return precedence === PRECEDENCE.FLAG;',
    why: 'a fleet asked for in words must refuse rather than fall back',
    check: (run) => run(project('m18', { backend: 'auto', plant: false }),
      ['--intent', 'use the fleet']).status !== 0,
  },
  {
    id: 'M19', file: SWITCH_LIB,
    from: '            result.counters.inferences = 1;', to: '            result.counters.inferences = 0;',
    why: 'an inference must be COUNTED, not merely announced',
    check: (run) => {
      const r = run(project('m19', { backend: 'auto', plant: true, consumer: true }),
        ['--intent', 'use the fleet']);
      return r.json !== null && r.json.counters.inferences === 1;
    },
  },
  {
    id: 'M20', file: SWITCH_LIB,
    from: '        if (result.precedence === PRECEDENCE.LANGUAGE) {', to: '        if (false) {',
    why: 'a silent inference is strictly worse than a flag',
    check: (run) => {
      const r = run(project('m20', { backend: 'auto', plant: true, consumer: true }),
        ['--intent', 'use the fleet']);
      return r.stderr.includes('understood "use the fleet"');
    },
  },
  {
    id: 'M21', file: SWITCH_LIB,
    from: '        if (decision.overriddenBackend !== null) {', to: '        if (false) {',
    why: 'a flag that beat a sentence must SAY that it did',
    check: (run) => {
      const r = run(project('m21', { backend: 'auto', plant: true, consumer: true }),
        ['--inline', '--intent', 'use the fleet']);
      return r.stderr.includes('Following the flag');
    },
  },
  {
    id: 'M22', file: SWITCH_LIB,
    from: '    if (flags.flag !== null) {', to: '    if (false) {',
    why: 'a flag outranks a sentence when the 2 disagree',
    check: (run) => {
      const r = run(project('m22', { backend: 'auto', plant: true, consumer: true }),
        ['--inline', '--intent', 'use the fleet']);
      return r.json !== null && r.json.executed_backend === 'inline';
    },
  },
  {
    id: 'M23', file: SWITCH_LIB,
    from: '            ...none, ok: false, code: SWITCH_CODES.CONFLICTING_LANGUAGE,',
    to: '            ...none, ok: true, code: SWITCH_CODES.CONFLICTING_LANGUAGE,',
    why: 'a contradictory sentence leaves through the SAME refusal rung as contradictory flags',
    check: (run) => run(project('m23', { backend: 'auto', plant: true, consumer: true }),
      ['--intent', 'use the fleet but run it inline']).status !== 0,
  },
  // ── the command line interface: the sentence is genuinely read and genuinely fenced ──
  {
    id: 'M24', file: SWITCH_CLI,
    from: '  const intent = intentRaw === undefined ? null : intentLib.detectBackendIntent(intentRaw);',
    to: '  const intent = null;',
    why: 'the sentence must actually reach the matcher',
    check: (run) => {
      const r = run(project('m24', { backend: 'auto', plant: true, consumer: true }),
        ['--intent', 'use the fleet']);
      return r.json !== null && r.json.executed_backend === 'fleet';
    },
  },
  {
    id: 'M25', file: SWITCH_CLI,
    from: '  const flagArgv = stripValueFlags(argv);', to: '  const flagArgv = argv;',
    why: 'a quoted value must never be read as an invocation token',
    check: (run) => {
      const r = run(project('m25', { backend: 'auto', plant: false }), ['--intent', '--fleet']);
      return r.json !== null && r.json.counters.refusals === 0;
    },
  },
  {
    id: 'M17', file: SWITCH_CLI,
    from: '  const kind = orchestration.FLEET_MANIFEST_KIND;',
    to: '  const kind = orchestration.NOT_THE_MANIFEST_KIND;',
    why: 'an unreadable kind must not read as "no consumer"',
    check: (run) => {
      const r = run(project('m17', { backend: 'fleet', plant: true, consumer: true }), ['--fleet']);
      return r.json !== null && r.json.executed_backend === 'fleet';
    },
  },
];

/** What git says about the mutated artifacts right now. */
function numstat() {
  return execFileSync('git', ['diff', '--numstat', '--', SWITCH_LIB, SWITCH_CLI],
    { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

test('MUTATION BATTERY: every mutant is applied on disk, killed, and restored', () => {
  // Git's view BEFORE the battery. Compared against its view AFTER, rather than
  // against the empty string: the guarded property is that the battery left the
  // artifacts byte identical, and asserting emptiness would instead assert that
  // the working tree was clean when the suite ran, which is a different claim and
  // one this repository cannot make while other agents are committing.
  const gitBefore = numstat();
  const originals = new Map();
  for (const m of MUTANTS) {
    if (!originals.has(m.file)) originals.set(m.file, fs.readFileSync(m.file, 'utf8'));
  }

  assert.ok(MUTANTS.length > 0, 'the battery is non empty');

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
        held = m.check(runSwitch) === true;
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
    `git reports 0 changed lines ADDED by the battery. before=${JSON.stringify(gitBefore)} after=${JSON.stringify(gitAfter)}`);
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // a scratch directory that outlives the run is not a failure of the proof.
    }
  }
});
