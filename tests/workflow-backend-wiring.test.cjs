'use strict';

/**
 * Phase 21 : the wiring, proved THROUGH THE WORKFLOW SURFACE.
 *
 * Nobody runs these scripts from a command line. People type a slash command in
 * Claude Code, so a proof that spawns the script directly proves the script and
 * says nothing about whether `/ferrox-execute-phase` reaches it. Every arm below
 * EXTRACTS THE SHELL BLOCK OUT OF THE SHIPPED WORKFLOW MARKDOWN and executes
 * exactly that text. If the workflow stops passing the flag, stops passing the
 * sentence, or stops running the switch at all, these arms go red.
 *
 * The workflow file is 132 kilobytes of prose, and a proof that reads it with a
 * substring match cannot tell a documented behavior from a performed one. So the
 * block is RUN, and what it captured into `BACKEND_JSON` and `BACKEND_EXIT` is
 * what is asserted.
 *
 * THE REQUIRED ARMS:
 *
 *   W1  `--fleet`, fleet unavailable, driven through the workflow: REFUSES and
 *       executes nothing. Exit 2 out of the workflow's own captured variable.
 *   W2  a CONFIG default, same tree, same reason: falls back and says so loudly.
 *   W3  the FF-B379 line appears WHENEVER fleet resolves, verbatim, out of the
 *       workflow's own captured output. A run that reported a fleet it did not
 *       perform is the exact defect this project exists to prevent.
 *   W4  a SENTENCE carrying fleet intent resolves through the workflow, and the
 *       echo is present.
 *   W5  a sentence that merely MENTIONS the fleet resolves nothing through the
 *       workflow. The narrow arm, at the surface people use.
 *
 * COUNTERS, NEVER FLAGS, and NON ZERO before any property over them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const EXECUTE_WORKFLOW = path.join(REPO_ROOT, 'ferrox-core', 'workflows', 'execute-phase.md');
const PLAN_WORKFLOW = path.join(REPO_ROOT, 'ferrox-core', 'workflows', 'plan-phase.md');

// Constants READ from the shipped artifacts, never transcribed.
const { FLEET_RUNTIME_ARTIFACTS, FLEET_INTERPRETER, FLEET_MANIFEST_KIND } =
  require('../ferrox-core/bin/lib/claude-orchestration.cjs');
const { CONSUMER_DECLARATION_KEY } = require('../scripts/execution-backend-switch.cjs');
const { CONSUMER_ENTRYPOINT, REFUSAL_EXIT_CODE, PRECEDENCE, SWITCH_CODES } =
  require('../ferrox-core/bin/lib/execution-backend-switch.cjs');

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-workflow-wiring-${label}-`));
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

/** A project tree. `plant` decides whether the fleet runtime is genuinely there. */
function project(label, opts) {
  const o = opts || {};
  const root = scratch(label);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.planning', 'config.json'),
    JSON.stringify({
      claude_orchestration: { enabled: true, execution_backend: o.backend },
      fleet: { enabled: true },
    }, null, 2),
    'utf8',
  );

  assert.ok(FLEET_RUNTIME_ARTIFACTS.length > 0,
    'the exported artifact list is non empty before anything is planted from it');

  let observed = 0;
  for (const rel of FLEET_RUNTIME_ARTIFACTS) {
    const target = path.join(root, rel);
    if (o.plant) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '// planted by the phase 21 workflow wiring proof\n', 'utf8');
    }
    // OBSERVE the condition rather than assume the loop ran.
    assert.equal(fs.existsSync(target), o.plant === true,
      `${rel}: the availability condition is genuine`);
    observed += 1;
  }
  assert.equal(observed, FLEET_RUNTIME_ARTIFACTS.length,
    'every declared runtime artifact was observed');

  if (o.consumer) {
    // The DECLARED consumer entry point, exporting the manifest kind it reads.
    // The switch loads it and compares that declaration against the producer's
    // own export, so a plant carrying the kind only as text would not count.
    const file = path.join(root, CONSUMER_ENTRYPOINT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file,
      "'use strict';\nmodule.exports = { " + CONSUMER_DECLARATION_KEY
        + ": '" + FLEET_MANIFEST_KIND + "' };\n", 'utf8');
    assert.equal(require(file)[CONSUMER_DECLARATION_KEY], FLEET_MANIFEST_KIND,
      'the planted consumer genuinely declares the manifest kind');
  }
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE EXTRACTOR : the workflow's own shell block, taken off disk and run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull the first fenced shell block out of a named `<step>` in a workflow file.
 *
 * Returns `{ ok, code, reason }` rather than throwing, so a workflow that lost
 * the step produces a NAMED failure in the arm that needed it instead of a stack
 * trace nobody can read.
 */
function extractStepShell(workflowPath, stepName) {
  const body = fs.readFileSync(workflowPath, 'utf8');
  const open = body.indexOf('<step name="' + stepName + '"');
  if (open === -1) return { ok: false, code: '', reason: 'step_absent:' + stepName };
  const close = body.indexOf('</step>', open);
  if (close === -1) return { ok: false, code: '', reason: 'step_unterminated:' + stepName };
  const step = body.slice(open, close);
  const fenceOpen = step.indexOf('```bash');
  if (fenceOpen === -1) return { ok: false, code: '', reason: 'no_shell_block:' + stepName };
  const bodyStart = step.indexOf('\n', fenceOpen) + 1;
  const fenceClose = step.indexOf('```', bodyStart);
  if (fenceClose === -1) return { ok: false, code: '', reason: 'shell_block_unterminated:' + stepName };
  return { ok: true, code: step.slice(bodyStart, fenceClose), reason: 'extracted' };
}

/**
 * Put a shell block on disk and return its path.
 *
 * The block is executed as `bash <path>` rather than `bash -c <text>`. Windows
 * Git Bash ignores the exec bit for extension free scripts found on PATH, and an
 * explicit interpreter with an explicit path sidesteps that entirely
 * (DEFECT.WINDOWS-TEST-PORTABILITY).
 */
function writeScript(label, code) {
  const file = path.join(scratch('script-' + label), 'block.sh');
  fs.writeFileSync(file, code, 'utf8');
  return file;
}

/** The same, for a workflow section introduced by a markdown heading. */
function extractHeadingShell(workflowPath, heading) {
  const body = fs.readFileSync(workflowPath, 'utf8');
  const open = body.indexOf(heading);
  if (open === -1) return { ok: false, code: '', reason: 'heading_absent:' + heading };
  const fenceOpen = body.indexOf('```bash', open);
  if (fenceOpen === -1) return { ok: false, code: '', reason: 'no_shell_block:' + heading };
  const bodyStart = body.indexOf('\n', fenceOpen) + 1;
  const fenceClose = body.indexOf('```', bodyStart);
  if (fenceClose === -1) return { ok: false, code: '', reason: 'shell_block_unterminated:' + heading };
  return { ok: true, code: body.slice(bodyStart, fenceClose), reason: 'extracted' };
}

/**
 * Run the planning workflow's own recommendation block against THIS repository,
 * which is a real project with a real phase graph, and report what it printed.
 */
function runPlanRecommendation(phase) {
  const extracted = extractHeadingShell(PLAN_WORKFLOW, '## 13f.');
  if (!extracted.ok) return { ok: false, stdout: '', reason: extracted.reason };
  const env = Object.assign({}, process.env, { RUNTIME_DIR: REPO_ROOT, PHASE_NUMBER: String(phase) });
  const r = spawnSync('bash', [writeScript('plan', extracted.code)],
    { cwd: REPO_ROOT, encoding: 'utf8', env });
  return { ok: true, stdout: r.stdout, stderr: r.stderr, status: r.status, reason: 'ran' };
}

/**
 * Run the workflow's own block, in a project tree, and report what IT captured.
 *
 * `RUNTIME_DIR` is how the block itself resolves the repository, so pointing it
 * at this checkout makes the block find the real shipped switch. The project
 * tree is the working directory, which is where the switch reads its config from.
 * The epilogue only OBSERVES the 2 variables the workflow told the orchestrator
 * to read; it adds no behavior of its own.
 */
function runWorkflowBackendStep(root, env) {
  const extracted = extractStepShell(EXECUTE_WORKFLOW, 'resolve_execution_backend');
  assert.equal(extracted.ok, true,
    `the workflow still carries a runnable backend step: ${extracted.reason}`);

  const out = scratch('capture');
  const jsonPath = path.join(out, 'backend.json');
  const exitPath = path.join(out, 'backend.exit');
  const script = extracted.code
    + '\nprintf "%s" "${BACKEND_EXIT}" > "' + exitPath + '"\n'
    + 'printf "%s" "${BACKEND_JSON}" > "' + jsonPath + '"\n';

  const childEnv = Object.assign({}, process.env, env || {});
  childEnv.RUNTIME_DIR = REPO_ROOT;
  childEnv.PATH = INTERPRETER_BIN + path.delimiter + (process.env.PATH || '');
  childEnv.Path = childEnv.PATH;

  const r = spawnSync('bash', [writeScript('backend', script)],
    { cwd: root, encoding: 'utf8', env: childEnv });

  let json = null;
  try {
    json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    json = null;
  }
  let captured = null;
  try {
    captured = Number(fs.readFileSync(exitPath, 'utf8').trim());
  } catch {
    captured = null;
  }
  return { shell: r.status, exit: captured, json, stderr: r.stderr, stdout: r.stdout, script };
}

/** Assert the shape every arm reads, before any arm reads it. */
function assertRan(res, label) {
  assert.notEqual(res.json, null,
    `${label}: the workflow block genuinely produced JSON. stderr=${res.stderr}`);
  assert.notEqual(res.exit, null, `${label}: the workflow captured an exit code`);
  assert.equal(res.json.counters.decisions, 1, `${label}: exactly 1 decision was made`);
  assert.ok(res.json.counters.notices > 0, `${label}: the run was not silent`);
}

// ─────────────────────────────────────────────────────────────────────────────
// W0 : the block is genuinely extractable and genuinely runs the switch.
// ─────────────────────────────────────────────────────────────────────────────

test('W0: the shipped workflow carries a RUNNABLE backend step, not only prose about one', () => {
  const extracted = extractStepShell(EXECUTE_WORKFLOW, 'resolve_execution_backend');
  assert.equal(extracted.ok, true, `extraction: ${extracted.reason}`);
  assert.ok(extracted.code.length > 0, 'the block is non empty');
  assert.ok(extracted.code.includes('execution-backend-switch.cjs'),
    'the block invokes the switch by path');
  assert.ok(extracted.code.includes('BACKEND_EXIT=$?'),
    'the block captures the exit code the workflow then tells the orchestrator to obey');

  // And it RUNS, in a tree where nothing is planted, reaching the default.
  const res = runWorkflowBackendStep(project('w0', { backend: 'auto', plant: false }), {});
  assertRan(res, 'W0');
  assert.equal(res.exit, 0, `W0: the ordinary path exits 0. stderr=${res.stderr}`);
  assert.equal(res.json.executed_backend, 'inline');
});

// ─────────────────────────────────────────────────────────────────────────────
// W1 : REQUIRED. --fleet, unavailable, THROUGH THE WORKFLOW: refuses.
// ─────────────────────────────────────────────────────────────────────────────

test('W1: --fleet with the fleet unavailable, driven through the workflow, REFUSES and executes nothing', () => {
  const res = runWorkflowBackendStep(
    project('w1', { backend: 'auto', plant: false }),
    { BACKEND_FLAG: '--fleet', PHASE_ARG: '21' },
  );
  assertRan(res, 'W1');

  // COUNTER FIRST, NON ZERO, before any property over it.
  assert.ok(res.json.counters.refusals > 0, 'W1: the run recorded at least 1 refusal');
  assert.equal(res.json.counters.refusals, 1, 'W1: exactly 1 refusal');
  assert.equal(res.json.counters.fallbacks, 0, 'W1: a refusal is NOT a fallback');
  assert.ok(res.json.counters.probes > 0, 'W1: the availability detector was genuinely consulted');

  // THE EXIT CODE THE WORKFLOW ITSELF CAPTURED.
  assert.notEqual(res.exit, 0, 'W1: the workflow captured a non zero exit');
  assert.equal(res.exit, REFUSAL_EXIT_CODE, 'W1: it is the refusal code');
  assert.equal(res.json.precedence, PRECEDENCE.FLAG, 'W1: the FLAG level decided');
  assert.equal(res.json.code, SWITCH_CODES.FLEET_UNAVAILABLE_REFUSED);

  // NOTHING WAS EXECUTED.
  assert.equal(res.json.executed_backend, null, 'W1: nothing was executed');
  assert.equal(res.json.resolved_backend, null, 'W1: no backend was resolved');
  assert.match(res.stderr, /REFUSING/, 'W1: the refusal reached the operator loudly');
  assert.match(res.stderr, /Nothing was executed/, 'W1: it states that nothing ran');

  // The workflow TELLS the orchestrator to obey that code and stop.
  const step = fs.readFileSync(EXECUTE_WORKFLOW, 'utf8');
  assert.ok(step.includes('Exit `2` is a REFUSAL'),
    'the workflow names exit 2 as a refusal');
  assert.ok(step.includes('Execute nothing'),
    'the workflow tells the orchestrator to execute nothing on a refusal');
});

// ─────────────────────────────────────────────────────────────────────────────
// W2 : REQUIRED. A CONFIG default in the SAME tree falls back and says so.
// ─────────────────────────────────────────────────────────────────────────────

test('W2: a CONFIG default fleet, same unavailable tree, falls back through the workflow and says so loudly', () => {
  const res = runWorkflowBackendStep(
    project('w2', { backend: 'fleet', plant: false }),
    { PHASE_ARG: '21' },
  );
  assertRan(res, 'W2');

  assert.ok(res.json.counters.fallbacks > 0, 'W2: the run recorded at least 1 fallback');
  assert.equal(res.json.counters.fallbacks, 1, 'W2: exactly 1 fallback');
  assert.equal(res.json.counters.refusals, 0, 'W2: a config default NEVER refuses');
  assert.ok(res.json.counters.probes > 0, 'W2: the detector was genuinely consulted');

  assert.equal(res.exit, 0, `W2: an unattended build is not broken. stderr=${res.stderr}`);
  assert.equal(res.json.precedence, PRECEDENCE.CONFIG, 'W2: the CONFIG level decided');
  assert.equal(res.json.requested_backend, 'fleet', 'W2: fleet is what was asked for');
  assert.equal(res.json.executed_backend, 'inline', 'W2: inline is what actually ran');
  assert.equal(res.json.code, SWITCH_CODES.FLEET_UNAVAILABLE_FALLBACK);

  // LOUD, and at warn rather than info.
  assert.match(res.stderr, /FALLING BACK/, 'W2: the fallback is loud');
  assert.ok(res.json.notices.some((n) => n.level === 'warn'), 'W2: at warn level');

  // THE ASYMMETRY, at the workflow surface: same availability, same reason,
  // opposite outcome, and the only difference is which level asked.
  const refused = runWorkflowBackendStep(
    project('w2-flag', { backend: 'auto', plant: false }),
    { BACKEND_FLAG: '--fleet', PHASE_ARG: '21' },
  );
  assert.equal(refused.json.detail, res.json.detail,
    'both runs faced the same unavailability for the same named reason');
  assert.notEqual(refused.exit, res.exit, 'the exit codes differ, which is the whole switch');
  assert.equal(refused.json.counters.refusals + res.json.counters.refusals, 1,
    'exactly 1 of the 2 runs refused');
  assert.equal(refused.json.counters.fallbacks + res.json.counters.fallbacks, 1,
    'exactly 1 of the 2 runs fell back');
});

// ─────────────────────────────────────────────────────────────────────────────
// W3 : REQUIRED. The FF-B379 honesty line, whenever fleet resolves.
// ─────────────────────────────────────────────────────────────────────────────

const CONSUMER_MISSING_LINE = 'fleet backend resolved, no dispatch manifest consumer is '
  + 'installed in this tree (' + CONSUMER_ENTRYPOINT + ' is absent or declares a different '
  + 'manifest kind), executing inline';

test('W3: whenever fleet RESOLVES with no consumer installed, the named line appears verbatim', () => {
  // 3 different precedence levels reach a resolved fleet in the same tree. The
  // honesty line has to be present on every one of them, not only the flag.
  const arms = [
    ['flag', { BACKEND_FLAG: '--fleet', PHASE_ARG: '21' }, PRECEDENCE.FLAG, { backend: 'auto' }],
    ['language', { BACKEND_INTENT: 'build it with the ferrox fleet', PHASE_ARG: '21' }, PRECEDENCE.LANGUAGE, { backend: 'auto' }],
    ['config', { PHASE_ARG: '21' }, PRECEDENCE.CONFIG, { backend: 'fleet' }],
  ];

  let seen = 0;
  for (const [label, env, precedence, cfg] of arms) {
    const res = runWorkflowBackendStep(
      project('w3-' + label, { backend: cfg.backend, plant: true, consumer: false }), env);
    assertRan(res, `W3/${label}`);

    assert.ok(res.json.counters.consumer_gaps > 0, `W3/${label}: at least 1 consumer gap recorded`);
    assert.equal(res.json.counters.consumer_gaps, 1, `W3/${label}: exactly 1 consumer gap`);
    assert.equal(res.json.precedence, precedence, `W3/${label}: the expected level decided`);

    // The distinction the arm exists for: what RESOLVED and what RAN differ.
    assert.equal(res.json.resolved_backend, 'fleet', `W3/${label}: fleet genuinely resolved`);
    assert.equal(res.json.executed_backend, 'inline', `W3/${label}: inline is what actually ran`);
    assert.notEqual(res.json.resolved_backend, res.json.executed_backend,
      `W3/${label}: the gap is exactly the difference between these 2 fields`);
    assert.equal(res.json.code, SWITCH_CODES.FLEET_CONSUMER_MISSING);

    // VERBATIM, out of the workflow's own captured output.
    assert.equal(res.json.reason, CONSUMER_MISSING_LINE,
      `W3/${label}: the reason is the line, verbatim`);
    assert.ok(res.stderr.includes(CONSUMER_MISSING_LINE),
      `W3/${label}: the line genuinely reached the operator. stderr=${res.stderr}`);
    seen += 1;
  }
  assert.equal(seen, arms.length, 'every level that resolves a fleet carried the line');

  // The workflow TELLS the orchestrator to repeat it, and names the entry point
  // a tree is missing rather than a backlog id for work that is done.
  const body = fs.readFileSync(EXECUTE_WORKFLOW, 'utf8');
  assert.ok(body.includes(CONSUMER_ENTRYPOINT), 'the workflow names the consumer entry point');
  assert.ok(body.includes('Never report a fleet run that did not happen'),
    'the workflow states the prohibition the line exists to enforce');
  assert.ok(body.includes('Resolution is not execution'),
    'the workflow states that a resolved fleet has spawned nothing yet');
});

// ─────────────────────────────────────────────────────────────────────────────
// W4 and W5 : the surface people actually use, driven through the workflow.
// ─────────────────────────────────────────────────────────────────────────────

test('W4: a SENTENCE asking for the fleet resolves through the workflow, and the echo is present', () => {
  const res = runWorkflowBackendStep(
    project('w4', { backend: 'auto', plant: true, consumer: true }),
    { BACKEND_INTENT: 'build phase 21 with the ferrox fleet', PHASE_ARG: '21' },
  );
  assertRan(res, 'W4');

  assert.ok(res.json.counters.inferences > 0, 'W4: the run recorded at least 1 inference');
  assert.equal(res.json.counters.inferences, 1, 'W4: exactly 1 backend was read out of words');
  assert.ok(res.json.intent.counters.candidates > 0, 'W4: the matcher genuinely scanned');

  assert.equal(res.exit, 0, `W4: it resolved. stderr=${res.stderr}`);
  assert.equal(res.json.precedence, PRECEDENCE.LANGUAGE, 'W4: the LANGUAGE level decided');
  assert.equal(res.json.executed_backend, 'fleet', 'W4: it genuinely reached the fleet');

  const echo = res.json.notices.filter((n) => n.code === SWITCH_CODES.LANGUAGE_INTENT);
  assert.equal(echo.length, 1, 'W4: exactly 1 echo notice');
  assert.ok(echo[0].text.includes('build phase 21 with the ferrox fleet'),
    `W4: the echo names the phrase that triggered it, got ${echo[0].text}`);
  assert.ok(res.stderr.includes(echo[0].text), 'W4: the echo genuinely reached the operator');

  // The workflow tells the orchestrator to repeat it BEFORE the first wave.
  const body = fs.readFileSync(EXECUTE_WORKFLOW, 'utf8');
  assert.ok(body.includes('Echo every inference before acting'),
    'the workflow names the echo obligation');
  assert.ok(body.includes('BACKEND_INTENT'),
    'the workflow carries the variable the sentence travels in');
});

test('W5: a sentence that merely MENTIONS the fleet dispatches nothing through the workflow', () => {
  const mentions = [
    'the fleet benchmark returned NEGATIVE',
    'build a summary of the fleet costs',
    'the fleet dispatch consumer is not built yet',
  ];
  // PHASE 999 does not exist, so the verdict supplies no recommendation and this
  // arm reads the LANGUAGE level in isolation. Sharing the run with a live
  // recommendation would let another precedence level answer for it.
  let scanned = 0;
  for (const sentence of mentions) {
    const res = runWorkflowBackendStep(
      project('w5', { backend: 'auto', plant: true, consumer: true }),
      { BACKEND_INTENT: sentence, PHASE_ARG: '999' },
    );
    assertRan(res, `W5/${sentence}`);

    // NON ZERO FIRST: the matcher genuinely ran over this sentence.
    assert.ok(res.json.intent.counters.texts > 0, `W5/${sentence}: the sentence was genuinely read`);
    assert.ok(res.json.intent.counters.candidates > 0, `W5/${sentence}: the object list was walked`);

    assert.equal(res.json.counters.inferences, 0, `W5/${sentence}: nothing was inferred`);
    assert.notEqual(res.json.precedence, PRECEDENCE.LANGUAGE,
      `W5/${sentence}: the LANGUAGE level did not decide`);
    assert.equal(res.json.executed_backend, 'inline',
      `W5/${sentence}: a mention does not dispatch a fleet`);
    scanned += 1;
  }
  assert.equal(scanned, mentions.length, 'every mention was driven through the workflow');

  // FALSIFIABILITY through the SAME surface: 1 sentence that does ask.
  const asked = runWorkflowBackendStep(
    project('w5-falsify', { backend: 'auto', plant: true, consumer: true }),
    { BACKEND_INTENT: 'use the fleet', PHASE_ARG: '999' },
  );
  assert.equal(asked.json.executed_backend, 'fleet',
    'the workflow genuinely reaches a fleet, so the zeroes above are about the sentences');
});

test('a sentence asking for BOTH backends refuses through the workflow, having probed nothing', () => {
  const res = runWorkflowBackendStep(
    project('w-conflict', { backend: 'auto', plant: true, consumer: true }),
    { BACKEND_INTENT: 'use the fleet but run it inline', PHASE_ARG: '21' },
  );
  assertRan(res, 'conflict');
  assert.ok(res.json.counters.refusals > 0, 'at least 1 refusal');
  assert.equal(res.json.counters.refusals, 1, 'exactly 1 refusal');
  assert.equal(res.exit, REFUSAL_EXIT_CODE, 'the workflow captured the refusal code');
  assert.equal(res.json.code, SWITCH_CODES.CONFLICTING_LANGUAGE);
  assert.equal(res.json.executed_backend, null, 'nothing was executed');
  assert.equal(res.json.counters.probes, 0,
    'a contradictory sentence refuses having probed nothing');
});

// ─────────────────────────────────────────────────────────────────────────────
// FF-B410 : precedence level 4 is LIVE rather than inert.
// ─────────────────────────────────────────────────────────────────────────────

test('FF-B410: the workflow FEEDS the parallelism verdict into the switch instead of leaving level 4 inert', () => {
  const extracted = extractStepShell(EXECUTE_WORKFLOW, 'resolve_execution_backend');
  assert.equal(extracted.ok, true, extracted.reason);
  assert.ok(extracted.code.includes('parallelism-verdict.cjs'),
    'the block genuinely runs the verdict');
  assert.ok(extracted.code.includes('--recommendation'),
    'and genuinely hands the pick to the switch');

  // The verdict's machine readable pick is what makes that a 1 line step, and it
  // is READ from the shipped script rather than assumed.
  const pick = spawnSync(process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'parallelism-verdict.cjs'), '21', '--pick'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(pick.status, 0, `the verdict answers --pick. stderr=${pick.stderr}`);
  const word = pick.stdout.trim();
  const { MODES } = require('../scripts/parallelism-verdict.cjs');
  assert.ok(word === MODES.FLEET || word === MODES.SOLO,
    `--pick emits exactly 1 mode word from the verdict's own vocabulary, got ${JSON.stringify(word)}`);
  assert.equal(pick.stdout.trim().split('\n').length, 1, '--pick emits 1 line and nothing else');

  // LEVEL 4 IS LIVE. A real phase, no flag, no sentence, no config default: the
  // verdict's own pick is what decides, and the switch names where it came from.
  const live = runWorkflowBackendStep(
    project('b410-live', { backend: 'auto', plant: false }), { PHASE_ARG: '21' });
  assertRan(live, 'FF-B410 live');
  assert.equal(live.json.precedence, PRECEDENCE.RECOMMENDATION,
    `the verdict decided this run. detail=${live.json.detail}`);
  // The SAME word `--pick` emitted is what the run went on to ask for. `solo` is
  // the verdict's word for this session and `inline` is the switch's word for the
  // same thing, which is why the mapping is stated rather than assumed equal.
  const expected = word === MODES.FLEET ? 'fleet' : 'inline';
  assert.equal(live.json.requested_backend, expected,
    `level 4 asked for what --pick said, got ${live.json.requested_backend} for pick ${word}`);

  // And an unreadable phase degrades with a NAMED reason rather than a shrug.
  const degraded = runWorkflowBackendStep(
    project('b410-degrade', { backend: 'auto', plant: false }), { PHASE_ARG: '999' });
  assertRan(degraded, 'FF-B410 degrade');
  assert.equal(degraded.json.precedence, PRECEDENCE.DEFAULT);
  assert.match(degraded.json.detail, /^recommendation_unavailable:/,
    `the degrade names why level 4 was unusable, got ${degraded.json.detail}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE GLASS : the wave structure is SHOWN, at the start and at wave boundaries.
// ─────────────────────────────────────────────────────────────────────────────

test('the execute workflow renders the read only glass at the start AND at wave boundaries', () => {
  const body = fs.readFileSync(EXECUTE_WORKFLOW, 'utf8');
  const renders = body.split('node "$GLASS" graph').length - 1;
  assert.ok(renders > 0, 'the workflow renders the glass at all');
  assert.equal(renders, 2,
    `the glass is rendered exactly twice, at the start and at the wave boundary, got ${renders}`);
  assert.ok(body.includes('Wave boundary glass'), 'the wave boundary render is labelled');
  assert.ok(body.includes('It is READ ONLY'), 'the workflow states that the view changes nothing');
  assert.ok(body.includes('instrument reporting its own reach'),
    'the workflow tells the reader that an unproven edge is reach, never a defect count');

  // It genuinely runs, read only, against this repository.
  const before = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const glass = spawnSync(process.execPath,
    [path.join(REPO_ROOT, 'scripts', 'fleet-glass.cjs'), 'graph', '21'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(glass.status, 0, `the glass renders. stderr=${glass.stderr}`);
  assert.match(glass.stdout, /GRAPH {2}phase 21/, 'it names the phase it drew');
  assert.match(glass.stdout, /Wave 1/, 'it names the waves');
  const after = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(after, before, 'rendering the glass changed nothing on disk');
});

// ─────────────────────────────────────────────────────────────────────────────
// PLANNING : the phase ends by naming the mode that fits, recommendation first.
// ─────────────────────────────────────────────────────────────────────────────

test('the plan workflow ENDS by running the parallelism verdict, recommendation first', () => {
  const body = fs.readFileSync(PLAN_WORKFLOW, 'utf8');
  assert.ok(body.includes('parallelism-verdict.cjs'), 'the plan workflow runs the verdict');

  // ORDER MATTERS: the recommendation is reported after the plans exist and
  // before the final status, which is what makes it the closing word.
  const verdictAt = body.indexOf('parallelism-verdict.cjs');
  const commitAt = body.indexOf('## 13d. Commit Plans');
  const statusAt = body.indexOf('## 14. Present Final Status');
  assert.ok(commitAt > 0 && statusAt > 0, 'both anchors are present');
  assert.ok(verdictAt > commitAt,
    'the recommendation is made AFTER the plans exist, because the shape is only knowable then');
  assert.ok(verdictAt < statusAt,
    'and BEFORE the final status, so it is the closing word rather than a footnote');

  assert.ok(body.includes('recommendation first'), 'the workflow states the ordering rule');
  assert.ok(body.includes('Report the verdict, never act on it here'),
    'planning reports the mode and never chooses the backend');

  // RUN the workflow's own block, so this proves a performed behavior rather than
  // a documented one, and it genuinely leads with the pick on line 1.
  const run = runPlanRecommendation(21);
  assert.equal(run.ok, true, `the planning block is extractable: ${run.reason}`);
  const lines = run.stdout.split('\n');
  assert.match(lines[0], /^Recommendation: /, `line 1 is the pick, got ${JSON.stringify(lines[0])}`);
  assert.match(lines[0], /\(Recommended\)/, 'and it is marked as the recommendation');
  assert.match(lines[1], /^Why: /, 'line 2 is the reason');
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SURFACES : the 2 files a person reads before typing anything.
// ─────────────────────────────────────────────────────────────────────────────

test('the execute surfaces teach the SENTENCE first and the flag as the machine surface', () => {
  let checked = 0;
  for (const rel of [
    path.join('skills', 'ferrox-execute-phase', 'SKILL.md'),
    path.join('commands', 'ferrox', 'execute-phase.md'),
  ]) {
    const body = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.ok(body.includes('You do not need the flags. Just say it.'),
      `${rel}: the sentence surface is taught first`);
    assert.ok(body.includes('with the ferrox fleet'),
      `${rel}: it shows a sentence a person would actually type`);
    assert.ok(body.includes('the fleet benchmark returned negative'),
      `${rel}: it shows what does NOT count, which is the narrowness promise`);
    assert.ok(body.includes('echoed back before anything runs'),
      `${rel}: it promises the echo`);
    assert.ok(body.includes('REFUSES'),
      `${rel}: it states that an unhonorable fleet refuses`);
    assert.ok(body.includes('`--fleet`') && body.includes('`--inline`'),
      `${rel}: both flags are still documented as the machine surface`);
    checked += 1;
  }
  assert.equal(checked, 2, 'both execute surfaces were checked');
});

test('the plan surfaces say that planning ends with a parallelism recommendation', () => {
  let checked = 0;
  for (const rel of [
    path.join('skills', 'ferrox-plan-phase', 'SKILL.md'),
    path.join('commands', 'ferrox', 'plan-phase.md'),
  ]) {
    const body = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    assert.ok(body.includes('Planning ends with a parallelism recommendation'),
      `${rel}: the closing recommendation is documented`);
    assert.ok(body.includes('parallelism-verdict.cjs'),
      `${rel}: it names the script that produces it`);
    assert.ok(body.includes('It reports and never acts'),
      `${rel}: it states that planning does not choose the backend`);
    checked += 1;
  }
  assert.equal(checked, 2, 'both plan surfaces were checked');
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION BATTERY : mutate THE WORKFLOW ITSELF. Every replacement asserted
// applied on disk, every artifact restored, and the tree proved byte identical.
// ─────────────────────────────────────────────────────────────────────────────

const MUTANTS = [
  {
    id: 'X01', file: EXECUTE_WORKFLOW,
    from: '  ${BACKEND_INTENT:+--intent "$BACKEND_INTENT"} \\\n',
    to: '',
    why: 'a workflow that never hands the sentence over has not wired natural language at all',
    check: () => {
      const r = runWorkflowBackendStep(
        project('x01', { backend: 'auto', plant: true, consumer: true }),
        { BACKEND_INTENT: 'use the fleet', PHASE_ARG: '21' });
      return r.json !== null && r.json.precedence === PRECEDENCE.LANGUAGE;
    },
  },
  {
    id: 'X02', file: EXECUTE_WORKFLOW,
    from: 'BACKEND_JSON=$(node "$SWITCH" ${BACKEND_FLAG:-} \\',
    to: 'BACKEND_JSON=$(node "$SWITCH" \\',
    why: 'a workflow that drops the flag cannot honor an explicit --fleet',
    check: () => {
      const r = runWorkflowBackendStep(
        project('x02', { backend: 'auto', plant: false }),
        { BACKEND_FLAG: '--fleet', PHASE_ARG: '21' });
      return r.exit === REFUSAL_EXIT_CODE;
    },
  },
  {
    id: 'X03', file: EXECUTE_WORKFLOW,
    from: 'RECOMMENDATION=$(node "$VERDICT" "${PHASE_ARG}" --pick 2>/dev/null || true)',
    to: 'RECOMMENDATION=""',
    why: 'FF-B410: precedence level 4 must be fed by the verdict rather than left inert',
    check: () => {
      const r = runWorkflowBackendStep(
        project('x03', { backend: 'auto', plant: false }), { PHASE_ARG: '21' });
      return r.json !== null && r.json.precedence === PRECEDENCE.RECOMMENDATION;
    },
  },
  {
    id: 'X04', file: EXECUTE_WORKFLOW,
    from: 'BACKEND_EXIT=$?',
    to: 'BACKEND_EXIT=0',
    why: 'a workflow that hard codes success cannot refuse anything',
    check: () => {
      const r = runWorkflowBackendStep(
        project('x04', { backend: 'auto', plant: false }),
        { BACKEND_FLAG: '--fleet', PHASE_ARG: '21' });
      return r.exit === REFUSAL_EXIT_CODE;
    },
  },
  {
    id: 'X05', file: EXECUTE_WORKFLOW,
    from: 'node "$GLASS" graph "${PHASE_NUMBER}" 2>/dev/null || true',
    to: 'true',
    why: 'the wave structure has to be SHOWN, at the start and at every wave boundary',
    check: () => {
      const body = fs.readFileSync(EXECUTE_WORKFLOW, 'utf8');
      return (body.split('node "$GLASS" graph').length - 1) === 2;
    },
  },
  {
    id: 'X06', file: EXECUTE_WORKFLOW,
    from: '**Never report a fleet run that did not happen.**',
    to: 'Report whatever seems right.',
    why: 'the workflow must carry the prohibition, or an orchestrator reading it is free to '
      + 'call an inline run a fleet run',
    check: () => fs.readFileSync(EXECUTE_WORKFLOW, 'utf8')
      .includes('Never report a fleet run that'),
  },
  {
    id: 'X07', file: EXECUTE_WORKFLOW,
    from: 'node "$CONSUMER" --manifest "$MANIFEST_JSON" --json',
    to: 'echo "dispatched as a fleet"',
    why: 'the workflow must INVOKE the dispatch consumer rather than announce a fleet itself. '
      + 'A workflow that prints the claim is the exact defect the consumer exists to prevent',
    check: () => fs.readFileSync(EXECUTE_WORKFLOW, 'utf8')
      .includes('node "$CONSUMER" --manifest "$MANIFEST_JSON" --json'),
  },
  {
    id: 'X08', file: EXECUTE_WORKFLOW,
    from: '**Never describe a run as a fleet run when `verdict.fleet` is `false`**',
    to: 'Describe the run however you like',
    why: 'the fleet claim belongs to the verdict, computed from observed worker counts, and '
      + 'the workflow has to say so or the orchestrator will decide for itself',
    check: () => fs.readFileSync(EXECUTE_WORKFLOW, 'utf8')
      .includes('Never describe a run as a fleet run when'),
  },
  {
    id: 'X07', file: EXECUTE_WORKFLOW,
    from: '- Exit `2` is a REFUSAL. **STOP.** Execute nothing.',
    to: '- Exit `2` is a warning. Carry on.',
    why: 'the refusal is only a refusal if the orchestrator is told to stop',
    check: () => {
      const body = fs.readFileSync(EXECUTE_WORKFLOW, 'utf8');
      return body.includes('Exit `2` is a REFUSAL') && body.includes('Execute nothing');
    },
  },
  {
    id: 'X08', file: PLAN_WORKFLOW,
    from: 'node "$VERDICT" "${PHASE_NUMBER}" 2>/dev/null || true',
    to: 'true',
    why: 'planning must END by naming the mode that fits',
    check: () => /^Recommendation: /.test(runPlanRecommendation(21).stdout),
  },
];

/** What git says about the mutated artifacts right now. */
function numstat() {
  return execFileSync('git', ['diff', '--numstat', '--', EXECUTE_WORKFLOW, PLAN_WORKFLOW],
    { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

test('MUTATION BATTERY: every workflow mutant is applied on disk, killed, and restored', () => {
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
      assert.equal(onDisk.includes(m.from), false, `${m.id}: the original text is genuinely gone`);
      applied += 1;

      let held;
      try {
        held = m.check() === true;
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
