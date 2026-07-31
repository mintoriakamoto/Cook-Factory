'use strict';

/**
 * FF-B29 loop-generator config guard: the properties under lock, not the functions.
 *
 *   - THE MUST-FIRE CASE IS THE LOAD-BEARING ONE. A guard that CANNOT fire passes every
 *     test that only exercises the safe cases. So the first group drives all 5 values into
 *     the loop-generating combination and asserts the guard DOES fire, and the integration
 *     group does the same thing end to end from a real config file on disk.
 *   - IT MUST FIRE FOR BOTH UNATTENDED MODE VALUES. FF-B29's own text says `autonomous`.
 *     This repository's `.planning/config.json` carries `yolo`. A bare equality against 1
 *     literal would make the guard unfireable on the very system that ships it (CONTEXT
 *     D10), so both values are driven.
 *   - IT MUST DISCRIMINATE. 5 single-member controls, 1 per member, each asserted quiet.
 *     A guard that always warns is as useless as a guard that never warns, in the opposite
 *     direction.
 *   - THE 2 FALSY TRAPS ARE PINNED. A threshold of 0 is not an absent threshold, and an
 *     auto advance of false is not an absent auto advance. A truthiness test conflates
 *     both and the guard then warns on every project that never set the keys.
 *   - EVERY RESOLUTION PATH IS PINNED INDIVIDUALLY. The 5 values do NOT come from 1 path.
 *     3 cases assert the 3 non-obvious reads individually, so a future refactor that
 *     unifies them fails a named test rather than silently disabling the guard.
 *   - REAL EXIT CODES FOR THE SURFACES. The doctor and init groups drive
 *     `ferrox-core/bin/ferrox-tools.cjs` as a CHILD PROCESS against scratch projects, so
 *     the exit code and the printed text are the ones an operator sees.
 *   - NOTHING TOUCHES THE LIVE REPOSITORY CONFIG. Every scratch project lives under a
 *     temporary root, and a committed case asserts this repository's own config stays
 *     quiet, so shipping the guard does not turn this project's own doctor noisy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TOOLS = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const GUARD_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'antiloop-config-guard.cjs');

const guard = require(GUARD_LIB);

const SCRATCH_ROOTS = [];

/** The 5 values in the loop-generating combination, as the pure core receives them. */
const LOOP_COMBINATION = Object.freeze({
  mode: 'autonomous',
  granularity: 'fine',
  securityBlockOn: 'low',
  inlinePlanThreshold: 0,
  autoAdvance: false,
});

test.after(() => {
  for (const root of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* a scratch tree that will not delete is not a test failure */
    }
  }
});

/**
 * Build a scratch project with a real planning directory and a real config file.
 * `config` is written verbatim, so a test can OMIT a key to drive the unresolved path.
 */
function scratchProject(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-config-guard-'));
  SCRATCH_ROOTS.push(root);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return root;
}

/** A project config carrying the full loop-generating combination. */
function loopConfig(overrides) {
  const base = {
    mode: 'autonomous',
    granularity: 'fine',
    workflow: {
      security_block_on: 'low',
      inline_plan_threshold: 0,
      auto_advance: false,
    },
  };
  const merged = { ...base, ...(overrides || {}) };
  if (overrides && overrides.workflow) merged.workflow = { ...base.workflow, ...overrides.workflow };
  return merged;
}

/** Combined stdout and stderr, because doctor prints to stdout and a failure to stderr. */
function out(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

/** Drive the real CLI as a child process with the scratch project as the working directory. */
function runTools(root, args) {
  return spawnSync(process.execPath, [TOOLS, ...args], { encoding: 'utf8', cwd: root });
}

// ---------------------------------------------------------------------------
// Group 1: the must-fire case at the pure-core level.
// ---------------------------------------------------------------------------

test('the guard FIRES on the full loop-generating combination, naming all 5 members', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION });
  assert.equal(
    r.decision,
    'warn-loop-combination',
    'the 5-key loop-generating combination did NOT fire. This is the only assertion that '
      + 'distinguishes a working guard from a guard that can never fire, because every safe '
      + 'case passes either way.',
  );
  assert.equal(r.matched.length, 5, `expected all 5 members matched, got ${JSON.stringify(r.matched)}`);
  assert.deepEqual(r.unresolved, [], 'no input should be unresolved when all 5 arrive explicitly');
});

test('the guard fires for the yolo mode value, the one this repository actually runs', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, mode: 'yolo' });
  assert.equal(
    r.decision,
    'warn-loop-combination',
    'a bare equality against the single literal autonomous would make this guard unfireable '
      + 'on the very system that ships it, because .planning/config.json here carries yolo.',
  );
});

test('UNATTENDED_MODES is an exported frozen list carrying at least 2 values', () => {
  assert.equal(Object.isFrozen(guard.UNATTENDED_MODES), true, 'the mode vocabulary must be frozen');
  assert.ok(guard.UNATTENDED_MODES.length >= 2, 'the mode vocabulary must carry at least 2 values');
  assert.ok(guard.UNATTENDED_MODES.includes('autonomous'), 'FF-B29 names autonomous');
  assert.ok(guard.UNATTENDED_MODES.includes('yolo'), 'this repository .planning/config.json carries yolo');
});

test('every value in UNATTENDED_MODES fires when the other 4 members match', () => {
  for (const mode of guard.UNATTENDED_MODES) {
    const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, mode });
    assert.equal(r.decision, 'warn-loop-combination', `mode ${mode} is in the frozen list but did not fire`);
  }
});

test('values are compared after trimming and lower-casing, so padding and case are not silent misses', () => {
  const r = guard.evaluateLoopConfigCombination({
    mode: ' Autonomous ',
    granularity: 'FINE',
    securityBlockOn: ' Low',
    inlinePlanThreshold: 0,
    autoAdvance: false,
  });
  assert.equal(r.decision, 'warn-loop-combination', 'a capitalised or padded config value must not be a silent miss');
});

// ---------------------------------------------------------------------------
// Group 2: the 5 single-member controls. The guard must DISCRIMINATE.
// ---------------------------------------------------------------------------

const SINGLE_MEMBER_MISSES = [
  ['mode is attended', { mode: 'interactive' }],
  ['granularity is standard', { granularity: 'standard' }],
  ['security block threshold is high', { securityBlockOn: 'high' }],
  ['inline plan threshold is non-zero', { inlinePlanThreshold: 5 }],
  ['auto advance is true', { autoAdvance: true }],
];

for (const [label, miss] of SINGLE_MEMBER_MISSES) {
  test(`the guard stays QUIET when ${label} and the other 4 members match`, () => {
    const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, ...miss });
    assert.equal(r.decision, 'ok', `the guard fired on a safe config differing in exactly 1 member: ${JSON.stringify(miss)}`);
    assert.equal(r.matched.length, 4, 'exactly 4 of the 5 members should have matched');
    assert.deepEqual(r.unresolved, [], 'a resolved but non-matching value is NOT unresolved');
  });
}

// ---------------------------------------------------------------------------
// Group 3: the 2 falsy traps. Each is the difference between a guard that works
// and a guard that fires on every project in the world.
// ---------------------------------------------------------------------------

test('an inline plan threshold of the NUMBER 0 matches', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, inlinePlanThreshold: 0 });
  assert.equal(r.decision, 'warn-loop-combination', 'the number 0 is the loop-generating value and must match');
});

test('an inline plan threshold supplied as the STRING form of 0 matches', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, inlinePlanThreshold: ' 0 ' });
  assert.equal(r.decision, 'warn-loop-combination', 'a project config is JSON authored by hand and a quoted number is a realistic input');
});

test('an ABSENT inline plan threshold does NOT match and is reported unresolved', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, inlinePlanThreshold: undefined });
  assert.equal(
    r.decision,
    'ok',
    'a truthiness test over the threshold would have returned warn-loop-combination here, '
      + 'because undefined is falsy, and the guard would then warn on every project that '
      + 'never set the key, which is most of them.',
  );
  assert.ok(r.unresolved.some((x) => /inline/i.test(x)), `the absent threshold must be named in unresolved, got ${JSON.stringify(r.unresolved)}`);
});

test('an inline plan threshold of a non-zero number does NOT match and is NOT unresolved', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, inlinePlanThreshold: 5 });
  assert.equal(r.decision, 'ok');
  assert.deepEqual(r.unresolved, [], 'a value that resolves and does not match is resolved, not unresolved');
});

test('an auto advance of the BOOLEAN false matches', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, autoAdvance: false });
  assert.equal(r.decision, 'warn-loop-combination', 'the boolean false is the loop-generating value and must match');
});

test('an ABSENT auto advance does NOT match and is reported unresolved', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, autoAdvance: undefined });
  assert.equal(
    r.decision,
    'ok',
    'a truthiness test over auto advance would have returned warn-loop-combination here, '
      + 'because undefined is falsy in exactly the same way the boolean false is, and the '
      + 'guard would then warn on every project that never set the key.',
  );
  assert.ok(r.unresolved.some((x) => /auto/i.test(x)), `the absent auto advance must be named in unresolved, got ${JSON.stringify(r.unresolved)}`);
});

test('an auto advance of the boolean true does NOT match and is NOT unresolved', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, autoAdvance: true });
  assert.equal(r.decision, 'ok');
  assert.deepEqual(r.unresolved, [], 'true resolves and does not match');
});

test('a null inline plan threshold and a null auto advance are both unresolved, never matches', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, inlinePlanThreshold: null, autoAdvance: null });
  assert.equal(r.decision, 'ok');
  assert.ok(r.unresolved.some((x) => /inline/i.test(x)));
  assert.ok(r.unresolved.some((x) => /auto/i.test(x)));
});

// ---------------------------------------------------------------------------
// Group 4: the unresolved surface. This is what makes a DEAD guard visible.
// ---------------------------------------------------------------------------

test('a quiet decision with unresolved inputs is distinguishable from a quiet decision with none', () => {
  const safe = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, granularity: 'standard' });
  const dead = guard.evaluateLoopConfigCombination({
    mode: undefined,
    granularity: undefined,
    securityBlockOn: undefined,
    inlinePlanThreshold: undefined,
    autoAdvance: undefined,
  });
  assert.equal(safe.decision, 'ok');
  assert.equal(dead.decision, 'ok');
  assert.deepEqual(safe.unresolved, [], 'a safely configured project resolves everything');
  assert.equal(dead.unresolved.length, 5, 'a guard that can never fire names all 5 broken reads');
  assert.notDeepEqual(safe.unresolved, dead.unresolved, 'the dead guard and the safe project must NOT print identically');
});

test('every unresolved name is a config key name an operator can go and look at', () => {
  const dead = guard.evaluateLoopConfigCombination({});
  assert.deepEqual(dead.unresolved, [
    'mode',
    'granularity',
    'workflow.security_block_on',
    'workflow.inline_plan_threshold',
    'workflow.auto_advance',
  ]);
});

test('an empty string mode is unresolved rather than silently non-matching', () => {
  const r = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION, mode: '   ' });
  assert.equal(r.decision, 'ok');
  assert.ok(r.unresolved.includes('mode'));
});

// ---------------------------------------------------------------------------
// Group 5: the hermetic contract. The core reads no config, no filesystem, no clock.
// ---------------------------------------------------------------------------

test('the built guard lib contains no require call, so the core cannot reach for config', () => {
  const src = fs.readFileSync(GUARD_LIB, 'utf8');
  const hits = src.split(/\r?\n/).filter((line) => /require\(/.test(line));
  assert.deepEqual(hits, [], 'the pure core must import nothing; the router resolves the values and passes them in');
});

test('the guard is deterministic: the same input returns the same decision every time', () => {
  const a = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION });
  const b = guard.evaluateLoopConfigCombination({ ...LOOP_COMBINATION });
  assert.deepEqual(a, b);
});

test('the guard does not mutate its input object', () => {
  const input = { ...LOOP_COMBINATION };
  const snapshot = JSON.stringify(input);
  guard.evaluateLoopConfigCombination(input);
  assert.equal(JSON.stringify(input), snapshot);
});

// ---------------------------------------------------------------------------
// Group 6: this repository's own values stay quiet.
// ---------------------------------------------------------------------------

test('this repository own config values return the quiet decision', () => {
  // Read from the live file rather than restating them, so a future config change
  // that DOES create the combination turns this test red instead of lying.
  const live = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.planning', 'config.json'), 'utf8'));
  const r = guard.evaluateLoopConfigCombination({
    mode: live.mode,
    granularity: live.granularity,
    securityBlockOn: live.workflow && live.workflow.security_block_on,
    inlinePlanThreshold: live.workflow && live.workflow.inline_plan_threshold,
    autoAdvance: live.workflow && live.workflow.auto_advance,
  });
  assert.equal(r.decision, 'ok', 'shipping the guard must not turn this project own doctor noisy');
});

// ---------------------------------------------------------------------------
// Group 7: the 3-path resolver. The 5 values do NOT come from 1 path, and each
// non-obvious read is pinned individually so a unifying refactor fails a NAMED
// test rather than silently disabling the guard.
// ---------------------------------------------------------------------------

const RESOLVE_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'antiloop-config-resolve.cjs');
const resolver = require(RESOLVE_LIB);

test('the resolver returns all 5 values for a project carrying the loop-generating combination, none undefined', () => {
  const root = scratchProject(loopConfig());
  const r = resolver.resolveLoopConfigInputs(root);
  assert.equal(r.mode, 'autonomous');
  assert.equal(r.granularity, 'fine');
  assert.equal(r.securityBlockOn, 'low', 'the security threshold read must not be undefined');
  assert.equal(r.inlinePlanThreshold, 0, 'the inline threshold read must not be undefined');
  assert.equal(r.autoAdvance, false, 'the auto advance read must not be undefined');
});

test('PATH PIN: the security block threshold resolves from the NESTED workflow object, not the flat projection', () => {
  const root = scratchProject(loopConfig());
  const observed = resolver.observeResolutionPaths(root);
  assert.equal(observed.securityBlockOn.nested, 'low', 'the nested workflow object is the only path that returns it');
  assert.equal(observed.securityBlockOn.flat, undefined, 'the flat projection drops it, because the key is capability-federated rather than central');
  assert.equal(resolver.resolveLoopConfigInputs(root).securityBlockOn, 'low');
});

test('PATH PIN: the inline plan threshold resolves from the RAW config file, from NEITHER loader path', () => {
  const root = scratchProject(loopConfig());
  const observed = resolver.observeResolutionPaths(root);
  assert.equal(observed.inlinePlanThreshold.flat, undefined, 'the flat projection drops it');
  assert.equal(observed.inlinePlanThreshold.nested, undefined, 'the nested workflow object drops it too');
  assert.equal(observed.inlinePlanThreshold.raw, 0, 'only the raw project config file returns it');
  assert.equal(resolver.resolveLoopConfigInputs(root).inlinePlanThreshold, 0);
});

test('PATH PIN: the auto advance value resolves from the FLAT projection, not the nested workflow object', () => {
  const root = scratchProject(loopConfig());
  const observed = resolver.observeResolutionPaths(root);
  assert.equal(observed.autoAdvance.flat, false, 'the flat projection is the path that returns it');
  assert.equal(observed.autoAdvance.nested, undefined, 'the nested read returns undefined even when the project sets it');
  assert.equal(resolver.resolveLoopConfigInputs(root).autoAdvance, false);
});

test('a broken read yields the unresolved marker rather than an exception', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-config-guard-broken-'));
  SCRATCH_ROOTS.push(root);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{ this is not json');
  const r = resolver.resolveLoopConfigInputs(root);
  assert.equal(r.inlinePlanThreshold, undefined, 'an unparseable config file must yield the unresolved marker, never throw');
  const decided = guard.evaluateLoopConfigCombination(r);
  assert.ok(decided.unresolved.includes('workflow.inline_plan_threshold'), 'the broken read must be VISIBLE, never silently collapsed into a non-matching value');
});

test('a project omitting the inline threshold key reports it unresolved, not as a non-match', () => {
  const cfg = loopConfig();
  delete cfg.workflow.inline_plan_threshold;
  const root = scratchProject(cfg);
  const decided = guard.evaluateLoopConfigCombination(resolver.resolveLoopConfigInputs(root));
  assert.equal(decided.decision, 'ok');
  assert.deepEqual(decided.unresolved, ['workflow.inline_plan_threshold']);
});

// ---------------------------------------------------------------------------
// Group 8: the doctor surface, driven as a CHILD PROCESS against real projects.
// ---------------------------------------------------------------------------

/** The exact phrase that appears ONLY when the combination fires. */
const FIRING_MARKER = 'the loop combination is present';

test('THE MUST-FIRE INTEGRATION CASE: a real config file carrying all 5 values makes doctor print the warning', () => {
  const root = scratchProject(loopConfig());
  const res = runTools(root, ['doctor']);
  const text = out(res);
  assert.equal(res.status, 0, 'the guard warns and never fails; doctor must exit 0 even in the firing case');
  assert.ok(
    text.includes(FIRING_MARKER),
    'doctor did NOT name the loop combination for a project whose config file carries all 5 values. '
      + 'A resolver reading all 5 through 1 path returns undefined for at least 2 of them, the '
      + 'conjunction then never holds, and this test is the only thing standing between that and a '
      + `guard that ships dead. Observed output:\n${text}`,
  );
  for (const member of ['mode', 'granularity', 'workflow.security_block_on', 'workflow.inline_plan_threshold', 'workflow.auto_advance']) {
    assert.ok(text.includes(member), `the firing line must name the matched member ${member}`);
  }
});

test('THE INTEGRATION CONTROL: the same project with a standard granularity does NOT name the combination', () => {
  const root = scratchProject(loopConfig({ granularity: 'standard' }));
  const res = runTools(root, ['doctor']);
  const text = out(res);
  assert.equal(res.status, 0);
  assert.equal(text.includes(FIRING_MARKER), false, `a safe project must not name the combination. Observed output:\n${text}`);
  assert.ok(/config guard: ok/.test(text), 'the quiet decision must still be reported, so silence is never ambiguous');
});

test('THE UNRESOLVED SURFACE IS VISIBLE at doctor: a dead guard does not print like a safe project', () => {
  const cfg = loopConfig();
  delete cfg.workflow.inline_plan_threshold;
  const root = scratchProject(cfg);
  const res = runTools(root, ['doctor']);
  const text = out(res);
  assert.equal(res.status, 0);
  assert.equal(text.includes(FIRING_MARKER), false);
  assert.ok(/1 of 5 inputs unresolved/.test(text), `the unresolved COUNT must be printed. Observed output:\n${text}`);
  assert.ok(text.includes('workflow.inline_plan_threshold'), 'the unresolved input must be named');
});

test('doctor exits 0 and stays quiet in THIS repository', () => {
  const res = runTools(REPO_ROOT, ['doctor']);
  const text = out(res);
  assert.equal(res.status, 0);
  assert.equal(text.includes(FIRING_MARKER), false, 'shipping the guard must not turn this project own doctor noisy');
  assert.ok(/config guard: ok/.test(text), `this repository must still get a reported quiet decision. Observed output:\n${text}`);
});

test('DOCTOR SURVIVES A MISSING GUARD LIB: it degrades to an unavailable marker and still exits 0', () => {
  const stash = `${GUARD_LIB}.stashed-for-test`;
  fs.renameSync(GUARD_LIB, stash);
  let res;
  try {
    res = runTools(REPO_ROOT, ['doctor']);
  } finally {
    fs.renameSync(stash, GUARD_LIB);
  }
  const text = out(res);
  assert.equal(res.status, 0, 'a missing built lib can never take doctor down');
  assert.ok(/config guard: unavailable/.test(text), `expected the unavailable marker. Observed output:\n${text}`);
  assert.equal(fs.existsSync(GUARD_LIB), true, 'the lib must be restored');
});

// ---------------------------------------------------------------------------
// Group 9: the plan-phase init surface, driven as a CHILD PROCESS. The moment a
// human is about to plan a phase is the moment a runaway plan generator is
// actionable, which is why this is the second surface FF-B29 names.
// ---------------------------------------------------------------------------

/** The 38 keys the plan-phase payload carried before this plan touched it. */
const PAYLOAD_KEYS_BEFORE = Object.freeze([
  'researcher_model', 'planner_model', 'checker_model', 'tdd_mode', 'granularity',
  'research_enabled', 'plan_checker_enabled', 'nyquist_validation_enabled', 'commit_docs',
  'text_mode', 'auto_advance', 'auto_chain_active', 'mode', 'phase_found', 'phase_dir',
  'expected_phase_dir', 'phase_number', 'phase_name', 'phase_slug', 'padded_phase',
  'phase_req_ids', 'phase_status', 'has_research', 'has_context', 'has_reviews', 'has_plans',
  'plan_count', 'planning_exists', 'roadmap_exists', 'state_path', 'roadmap_path',
  'requirements_path', 'patterns_path', 'project_root', 'agents_installed', 'missing_agents',
  'agents_dir', 'agent_runtime',
]);

/** Run the plan-phase init command against a project and parse its JSON payload. */
function initPlanPhase(root) {
  const res = runTools(root, ['init', 'plan-phase', '1']);
  let payload = null;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    payload = null;
  }
  return { res, payload };
}

test('THE MUST-FIRE INIT CASE: the plan-phase payload names the combination for a project holding it', () => {
  const root = scratchProject(loopConfig());
  const { res, payload } = initPlanPhase(root);
  assert.equal(res.status, 0, 'the warning never blocks planning; the command must exit 0');
  assert.ok(payload, `the payload must still parse as JSON. Observed:\n${out(res)}`);
  assert.ok(payload.config_warnings, 'the config warnings entry must be present');
  assert.equal(payload.config_warnings.decision, 'warn-loop-combination');
  assert.deepEqual(payload.config_warnings.matched, [
    'mode', 'granularity', 'workflow.security_block_on', 'workflow.inline_plan_threshold', 'workflow.auto_advance',
  ], 'the entry must list every matched member');
  assert.ok(
    typeof payload.config_warnings.message === 'string'
      && payload.config_warnings.message.includes(FIRING_MARKER),
    'the entry must carry the human-readable warning naming the loop combination',
  );
});

test('THE INIT CONTROL: a safe project carries no combination warning and still exits 0', () => {
  const root = scratchProject(loopConfig({ granularity: 'standard' }));
  const { res, payload } = initPlanPhase(root);
  assert.equal(res.status, 0);
  assert.ok(payload);
  assert.equal(payload.config_warnings.decision, 'ok');
  assert.deepEqual(payload.config_warnings.matched, [
    'mode', 'workflow.security_block_on', 'workflow.inline_plan_threshold', 'workflow.auto_advance',
  ]);
  assert.equal(payload.config_warnings.message.includes(FIRING_MARKER), false, 'a safe project must not be told the combination is present');
});

test('the init payload names the unresolved inputs for a project with an unresolvable read', () => {
  const cfg = loopConfig();
  delete cfg.workflow.inline_plan_threshold;
  const root = scratchProject(cfg);
  const { res, payload } = initPlanPhase(root);
  assert.equal(res.status, 0);
  assert.deepEqual(payload.config_warnings.unresolved, ['workflow.inline_plan_threshold']);
});

test('THE PAYLOAD SHAPE IS STABLE: every key present before this plan is still present, in both cases', () => {
  for (const [label, cfg] of [['firing', loopConfig()], ['safe', loopConfig({ granularity: 'standard' })]]) {
    const { payload } = initPlanPhase(scratchProject(cfg));
    const keys = new Set(Object.keys(payload));
    const missing = PAYLOAD_KEYS_BEFORE.filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `the ${label} payload dropped keys it carried before this plan`);
    assert.ok(keys.has('config_warnings'), `the ${label} payload must carry the new key`);
    assert.equal(keys.size, PAYLOAD_KEYS_BEFORE.length + 1, `the ${label} payload must add exactly 1 key`);
  }
});

test('the init warning path can never fail the command: a broken config still yields a full payload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-config-guard-init-broken-'));
  SCRATCH_ROOTS.push(root);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{ not json at all');
  const { res, payload } = initPlanPhase(root);
  assert.equal(res.status, 0, 'an exception anywhere in the guard path must leave the command intact');
  assert.ok(payload, 'the rest of the payload must survive');
  const missing = PAYLOAD_KEYS_BEFORE.filter((k) => !(k in payload));
  assert.deepEqual(missing, [], 'the rest of the payload must be intact');
});

test('INIT SURVIVES A MISSING GUARD LIB: the payload keeps every other key and the command exits 0', () => {
  // Regression guard. A STATIC import of the resolver in init.cts put the whole CLI
  // on the critical path of a warning surface: with the guard lib moved aside, every
  // init command died with Cannot find module. The require is lazy and inside the try
  // for exactly this reason, and this case is what holds it there.
  const root = scratchProject(loopConfig());
  const stash = `${GUARD_LIB}.stashed-for-init-test`;
  fs.renameSync(GUARD_LIB, stash);
  let probe;
  try {
    probe = initPlanPhase(root);
  } finally {
    fs.renameSync(stash, GUARD_LIB);
  }
  assert.equal(probe.res.status, 0, `a missing built lib must never take an init command down. Observed:\n${out(probe.res)}`);
  assert.ok(probe.payload, 'the payload must still parse');
  const missing = PAYLOAD_KEYS_BEFORE.filter((k) => !(k in probe.payload));
  assert.deepEqual(missing, [], 'every key the payload carried before this plan must survive');
  assert.equal(fs.existsSync(GUARD_LIB), true, 'the lib must be restored');
});

test('ONE RESOLVER, NOT TWO: the init surface and the doctor line reach the same module', () => {
  const initSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'init.cts'), 'utf8');
  const toolsSrc = fs.readFileSync(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs'), 'utf8');
  assert.ok(/antiloop-config-resolve\.cjs/.test(initSrc), 'the init surface must call the shared resolver');
  assert.ok(/antiloop-config-resolve\.cjs/.test(toolsSrc), 'the doctor line must call the shared resolver');
  // A second resolver would have to read the raw config file itself. Nothing outside
  // the shared module may do that for this key.
  assert.equal(/inline_plan_threshold/.test(initSrc), false, 'init must not re-derive the raw read; that is how 2 resolvers drift');
  assert.equal(/inline_plan_threshold/.test(toolsSrc), false, 'ferrox-tools must not re-derive the raw read');
});

test('the init and the doctor surfaces agree on the decision for the same project', () => {
  const root = scratchProject(loopConfig());
  const { payload } = initPlanPhase(root);
  const doctorText = out(runTools(root, ['doctor']));
  assert.equal(payload.config_warnings.decision, 'warn-loop-combination');
  assert.ok(doctorText.includes(FIRING_MARKER), 'the 2 surfaces must never disagree, because they share 1 resolver');
});

module.exports = { scratchProject, loopConfig, runTools, out, LOOP_COMBINATION, FIRING_MARKER };
