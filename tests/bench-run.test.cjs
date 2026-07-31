'use strict';

/**
 * bench-run: the properties under lock, not the functions.
 *
 * EVERY case here drives `scripts/bench-run.cjs` AS A REAL CHILD PROCESS against
 * a scratch corpus this file builds. That is not a style preference. A test that
 * imports a module cannot see what `main` does, and this script's whole subject
 * is what `main` does: which builder it selects, whether it writes a file, what
 * it prints, and what exit code it leaves behind. An in process test of the node
 * model would have passed against a script whose live builder called a network
 * on the default path.
 *
 *   - A BASELINE THAT ATTEMPTED 0 NODES IS NOT A BASELINE. "every task passed"
 *     is vacuously true of 0 tasks, so the attempted count is asserted as a
 *     non zero equality BEFORE any property over the attempted set is asserted.
 *     The runner refuses such a run by its own guard and the refusal names the
 *     number 0.
 *   - COORDINATION WIDTH, NOT LIST WIDTH: a multi file task expands to 1 node
 *     per module carrying its declared edges. `permitted_width` for a within
 *     task run is asserted to be the maximum declared width and asserted NOT to
 *     be the task count and NOT to be the node count, which are the 2 numbers a
 *     runner that counted or summed would produce and both of which flatter a
 *     fleet by construction.
 *   - A SERIAL ARM FOLDS TO A DEMONSTRATED WIDTH OF EXACTLY 1. Anything else is
 *     not a baseline, and the assertion catches an emitter whose intervals
 *     overlap when they must not.
 *   - SKIPPED IS NEITHER A PASS NOR A FAILURE. The live builder is driven on 3
 *     arms: opt in absent, opt in set to `0`, and opt in set to the literal `1`.
 *     The third arm is what proves the skip path is a real branch rather than
 *     the only branch.
 *   - NOT ATTEMPTED IS A THIRD OUTCOME. A task the builder could not attempt is
 *     named, emits no worker event, and is excluded from every denominator. It
 *     is asserted to be neither a pass nor a failure.
 *   - A GATE THAT PRINTED NOTHING IS A REFUSAL, NEVER A SCORE OF 0.
 *   - GUARDS FIRE: every refusal below is driven against a case where the thing
 *     it detects IS present, and observed reporting it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bench-run.cjs');

/** The opt in that is the whole boundary between an offline default and a model call. */
const LIVE_OPT_IN = 'FERROX_BENCH_LIVE';

/**
 * The live adapter surface. `FERROX_BENCH_LIVE_BIN` is a TEST SEAM: it replaces
 * the shipped profile's HEAD and nothing else, which is how every arm in this
 * file reaches the whole dispatch path at ZERO AGENT SPEND.
 */
const LIVE_ADAPTER = 'FERROX_BENCH_LIVE_ADAPTER';
const LIVE_BIN = 'FERROX_BENCH_LIVE_BIN';
const LIVE_TIMEOUT = 'FERROX_BENCH_LIVE_TIMEOUT_MS';

/**
 * FF-B301. The salvage seams: the bounded retry, its pause, and the TEST ONLY
 * lever that puts a salvage policy on a builder that must not carry one.
 *
 * `DEFAULT_LIVE_ATTEMPTS` is the shipped TOTAL, 2 retries plus the first
 * attempt. It is stated here once and asserted as a COUNTER everywhere below: a
 * flag saying a retry happened passes for an implementation that REPORTS a retry
 * and does not retry, and only the dispatch count can tell those apart.
 */
const LIVE_RETRIES = 'FERROX_BENCH_LIVE_RETRIES';
const LIVE_RETRY_DELAY = 'FERROX_BENCH_LIVE_RETRY_DELAY_MS';
const FORCE_SALVAGE = 'FERROX_BENCH_FORCE_SALVAGE_ON';
const DEFAULT_LIVE_ATTEMPTS = 3;

/** The shipped libraries, read at RUNTIME so no vocabulary here is a transcription. */
const PROBE = require(path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib', 'fleet-probe.cjs'));
const FOLD = require(path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs'));

// ─── scratch trees ───────────────────────────────────────────────────────────

const SCRATCH_ROOTS = [];

function scratchRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-bench-run-${tag}-`));
  SCRATCH_ROOTS.push(root);
  return root;
}

/**
 * A gate that scores a candidate by which tokens it carries.
 *
 * It takes a FILE for a single file task and a DIRECTORY for a multi file one,
 * which is the 1 invocation contract CONTEXT.md locks so the score parser is 1
 * implementation. `modules` names the files a multi file candidate must carry:
 * a build missing any of them scores 0 through the missing module refusal
 * rather than the fraction of checks that happen not to touch it.
 */
function gateSource(axis, tokens, modules) {
  const label = axis === 'hidden' ? 'hidden' : 'gate';
  const failWord = axis === 'hidden' ? 'HFAIL' : 'FAIL';
  return [
    'import sys, os',
    'p = sys.argv[1]',
    `TOKENS = ${JSON.stringify(tokens)}`,
    `MODULES = ${JSON.stringify(modules || [])}`,
    'if os.path.isdir(p):',
    '    have = sorted(os.listdir(p))',
    '    missing = [m for m in MODULES if m not in have]',
    '    if missing:',
    `        print("${failWord} missing modules: " + ", ".join(missing))`,
    `        print("${label}: 0/%d" % len(TOKENS))`,
    '        sys.exit(0)',
    '    text = "".join(open(os.path.join(p, n), encoding="utf-8").read() for n in have)',
    'else:',
    '    text = open(p, encoding="utf-8").read()',
    'passed = 0',
    'for t in TOKENS:',
    '    if t in text:',
    '        passed += 1',
    '    else:',
    `        print("${failWord} " + t)`,
    `print("${label}: %d/%d" % (passed, len(TOKENS)))`,
    '',
  ].join('\n');
}

/** A gate that runs and prints no summary line at all. A crash, never a score of 0. */
const SILENT_GATE = ['import sys', 'sys.stderr.write("this gate printed no summary line\\n")', ''].join('\n');

const VISIBLE_TOKENS = ['ALPHA', 'BETA', 'GAMMA'];
const HIDDEN_TOKENS = ['DELTA', 'EPSILON'];

/** Fixture bodies. `shallow` is FULL on visible and strictly below full on hidden. */
const BODY = {
  reference: '# ALPHA BETA GAMMA DELTA EPSILON\nVALUE = 1\n',
  mutant: '# ALPHA BETA\nVALUE = 1\n',
  shallow: '# ALPHA BETA GAMMA DELTA\nVALUE = 1\n',
};

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * Write 1 single file task into a scratch corpus.
 *
 * `parts` names which artifacts to write, so a case can withhold exactly 1 and
 * assert the outcome that appears.
 */
function writeSingleTask(root, id, parts) {
  const p = parts || {};
  // `extraTokens` names checks no fixture satisfies, so the task scores strictly
  // below full on the visible axis. That is what turns a saturated score set
  // into a discriminating one, and it is the control for the saturation arm.
  const visible = VISIBLE_TOKENS.concat(p.extraTokens || []);
  writeFile(path.join(root, 'specs', `${id}.md`), `# ${id}\n\nCarry ALPHA, BETA and GAMMA.\n`);
  writeFile(path.join(root, 'gates', `${id}.py`), p.silentGate === true ? SILENT_GATE : gateSource('gate', visible, null));
  if (p.hidden !== false) writeFile(path.join(root, 'hidden', `${id}.py`), gateSource('hidden', HIDDEN_TOKENS, null));
  for (const kind of ['reference', 'mutant', 'shallow']) {
    if (p[kind] === false) continue;
    writeFile(path.join(root, kind, `${id}.py`), BODY[kind]);
  }
}

/**
 * Write 1 multi file task with the plan 03 shape: 4 modules, 5 edges, 1 seam,
 * depth 3 and a declared permitted width of 2.
 */
function writeMultiTask(root, id, parts) {
  const p = parts || {};
  const base = path.join(root, 'multi', id);
  const files = ['a.py', 'b.py', 'c.py', 'd.py'];
  const structure = {
    task: id,
    files,
    // dependent to prerequisite, matching the workgraph direction
    edges: [['b.py', 'a.py'], ['c.py', 'a.py'], ['d.py', 'a.py'], ['d.py', 'b.py'], ['d.py', 'c.py']],
    seam: ['a.py'],
    depth: 3,
    permitted_width: typeof p.permitted_width === 'number' ? p.permitted_width : 2,
  };
  // `extraEdges` declares an edge onto a module the task does NOT carry, which
  // is how a WITHHELD dependency is driven: the graph drops the dangling edge
  // because the node does not exist, while `structure.json` still declares it,
  // so a prompt builder that reads the declaration meets a dependency that was
  // never built.
  if (Array.isArray(p.extraEdges)) structure.edges = structure.edges.concat(p.extraEdges);
  writeFile(path.join(base, 'SPEC.md'), `# ${id}\n\n4 modules. The seam is a.py.\n`);
  writeFile(path.join(base, 'structure.json'), `${JSON.stringify(structure, null, 2)}\n`);
  writeFile(path.join(base, 'gate.py'), p.silentGate === true ? SILENT_GATE : gateSource('gate', VISIBLE_TOKENS, files));
  if (p.hidden !== false) writeFile(path.join(base, 'hidden.py'), gateSource('hidden', HIDDEN_TOKENS, files));
  for (const kind of ['reference', 'mutant', 'shallow']) {
    if (p[kind] === false) continue;
    for (let i = 0; i < files.length; i++) {
      // The tokens are spread across the modules, so a partial build cannot
      // score full by carrying every token in 1 file.
      const body = i === 0 ? BODY[kind] : `# module ${files[i]}\nVALUE = ${i}\n`;
      writeFile(path.join(base, kind, files[i]), body);
    }
  }
  return structure;
}

/** A results tree carrying recorded candidates for the named tasks. */
function writeResults(root, rows) {
  writeFile(path.join(root, 'results-scratch.json'), `${JSON.stringify(rows, null, 2)}\n`);
  return root;
}

function replayRow(task, lane, code) {
  return {
    lane,
    task,
    ok: true,
    visible_pct: 100,
    hidden_pct: 100,
    cost: 0.25,
    profile: { runtime_ms: 210.5 },
    code,
  };
}

// ─── the child process seam ──────────────────────────────────────────────────

/**
 * Run the script as a real child process.
 *
 * `PYTHONDONTWRITEBYTECODE` is set on every invocation. The gates are real
 * `python3` children and a bare interpreter writes `__pycache__` into whatever
 * tree it imports from, which in this repository is a byte pinned tree.
 */
function runScript(args, options) {
  const o = options || {};
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  if (o.corpus !== undefined) env.FERROX_BENCH_CORPUS_ROOT = o.corpus;
  if (o.results !== undefined) env.FERROX_BENCH_RESULTS_ROOT = o.results;
  // Delete rather than assign: an inherited opt in would make the absent arm
  // untestable, and assigning the empty string is a different case from absent.
  delete env[LIVE_OPT_IN];
  delete env[LIVE_ADAPTER];
  delete env[LIVE_BIN];
  delete env[LIVE_TIMEOUT];
  delete env[LIVE_RETRIES];
  delete env[LIVE_RETRY_DELAY];
  delete env[FORCE_SALVAGE];
  delete env.FERROX_BENCH_SUPPRESS_WORKER_END;
  // A pinned clock is refused by the runner, and the suite may pin globally.
  delete env.FERROX_TEST_MODE;
  delete env.FERROX_NOW_MS;
  for (const [k, v] of Object.entries(o.env || {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  // `outerBoundMs` is the case's OWN bound on the whole child, and it exists so
  // a mutation battery that REMOVES the runner's per dispatch timeout cannot
  // hang the suite. Without it that mutant would be untestable, and an untestable
  // mutant is indistinguishable from a guard that cannot fire.
  const bound = typeof o.outerBoundMs === 'number'
    ? { timeout: o.outerBoundMs, killSignal: 'SIGKILL' }
    : {};
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env,
    cwd: REPO_ROOT,
    ...bound,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

/** Parse the report the script prints on stdout. */
function reportOf(run) {
  assert.notEqual(run.stdout.trim(), '', `the run printed nothing on stdout. stderr: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** Read a written run record back off disk as parsed events. */
function readRecord(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

function kindsOf(events, kind) {
  return events.filter((e) => e.kind === kind);
}

// ─── task 1: the node model ──────────────────────────────────────────────────

test('a single file task expands to exactly 1 node with 0 edges', () => {
  const corpus = scratchRoot('expand-single');
  writeSingleTask(corpus, 'solo');

  const run = runScript(['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--plan-only'], { corpus });
  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);

  assert.equal(report.nodes.length, 1, 'exactly 1 node');
  assert.equal(report.nodes[0].id, 'solo', 'the node id is the task id');
  assert.equal(report.edges.length, 0, 'exactly 0 edges');
});

test('a multi file task expands to exactly 4 nodes and 5 edges keyed task slash module', () => {
  const corpus = scratchRoot('expand-multi');
  writeMultiTask(corpus, 'widget');

  const run = runScript(['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--plan-only'], { corpus });
  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);

  assert.equal(report.nodes.length, 4, 'exactly 4 nodes, 1 per module');
  assert.deepEqual(
    report.nodes.map((n) => n.id),
    ['widget/a.py', 'widget/b.py', 'widget/c.py', 'widget/d.py'],
    'the ids are task slash module',
  );
  assert.equal(report.edges.length, 5, 'exactly 5 edges, the ones structure.json declares');
  assert.deepEqual(
    report.edges,
    [
      ['widget/b.py', 'widget/a.py'],
      ['widget/c.py', 'widget/a.py'],
      ['widget/d.py', 'widget/a.py'],
      ['widget/d.py', 'widget/b.py'],
      ['widget/d.py', 'widget/c.py'],
    ],
    'every edge is namespaced to its task and runs dependent to prerequisite',
  );
});

test('the topological order does not inherit the order the corpus enumerated its tasks', () => {
  // 2 corpora holding the SAME tasks whose directory entries were created in
  // opposite orders. Scanning the same tree twice proves nothing: an
  // enumeration change is the real threat, and a runner that trusted input
  // order would produce 2 different build orders for 1 corpus.
  const forward = scratchRoot('order-forward');
  writeMultiTask(forward, 'aaa');
  writeSingleTask(forward, 'mmm');
  writeMultiTask(forward, 'zzz');

  const reversed = scratchRoot('order-reversed');
  writeMultiTask(reversed, 'zzz');
  writeSingleTask(reversed, 'mmm');
  writeMultiTask(reversed, 'aaa');

  const args = ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--plan-only'];
  const a = reportOf(runScript(args, { corpus: forward }));
  const b = reportOf(runScript(args, { corpus: reversed }));

  assert.ok(a.order.length > 0, 'the order is not empty');
  assert.deepEqual(a.order, b.order, 'the build order is identical whichever order the tasks were enumerated in');
  assert.deepEqual(a.nodes.map((n) => n.id), b.nodes.map((n) => n.id), 'and so is the node set');
});

test('a prerequisite is always built before its dependent, and the seam is first', () => {
  const corpus = scratchRoot('order-topo');
  writeMultiTask(corpus, 'widget');

  const report = reportOf(runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--plan-only'],
    { corpus },
  ));

  const at = (id) => report.order.indexOf(id);
  assert.equal(at('widget/a.py'), 0, 'the seam, which every sibling depends on, is built first');
  assert.ok(at('widget/b.py') > at('widget/a.py'), 'b follows its prerequisite a');
  assert.ok(at('widget/c.py') > at('widget/a.py'), 'c follows its prerequisite a');
  assert.ok(at('widget/d.py') > at('widget/b.py'), 'd follows its prerequisite b');
  assert.ok(at('widget/d.py') > at('widget/c.py'), 'd follows its prerequisite c');
});

test('permitted width for a within task run over 3 multi tasks is 2, and is neither 3 nor 12', () => {
  const corpus = scratchRoot('permitted');
  writeMultiTask(corpus, 'one');
  writeMultiTask(corpus, 'two');
  writeMultiTask(corpus, 'six');

  const report = reportOf(runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--plan-only'],
    { corpus },
  ));

  assert.equal(report.nodes.length, 12, '3 tasks of 4 modules is 12 nodes');
  assert.equal(report.permitted_width, 2, 'the maximum declared permitted_width, taken from structure.json');
  assert.notEqual(report.permitted_width, 3, 'NOT the task count: a runner that counted tasks would report 3');
  assert.notEqual(report.permitted_width, 12, 'NOT the node count: a runner that summed modules would report 12');
});

test('permitted width for an across task run is the task count, and it is labeled the ceiling', () => {
  const corpus = scratchRoot('permitted-across');
  writeMultiTask(corpus, 'one');
  writeMultiTask(corpus, 'two');
  writeMultiTask(corpus, 'six');

  const report = reportOf(runScript(
    ['--arm', 'serial', '--shape', 'across-task', '--builder', 'reference', '--plan-only'],
    { corpus },
  ));

  assert.equal(report.permitted_width, 3, 'the task count');
  assert.equal(report.shape, 'across-task');
  assert.equal(
    report.shape_label,
    'the embarrassing parallel upper bound',
    'the flattering shape says so about itself, so a reader can see which number a claim rests on',
  );
});

test('the within task shape is labeled coordination width rather than a ceiling', () => {
  const corpus = scratchRoot('label-within');
  writeMultiTask(corpus, 'one');

  const report = reportOf(runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--plan-only'],
    { corpus },
  ));
  assert.equal(report.shape_label, 'coordination width');
});

// ─── task 1: the live builder, D9's positive case on 3 arms ──────────────────

test('the live builder SKIPS when the opt in is absent, names the variable, writes nothing, exits 0', () => {
  const corpus = scratchRoot('live-absent');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-absent-out');

  const run = runScript(['--arm', 'serial', '--shape', 'both', '--builder', 'live', '--repeat', '2', '--out', out], { corpus });

  assert.equal(run.status, 0, 'a skip is never a failure');
  const combined = `${run.stdout}${run.stderr}`;
  assert.match(combined, /SKIPPED/, 'the word SKIPPED appears');
  assert.match(combined, new RegExp(LIVE_OPT_IN), 'the reason names the opt in variable');
  assert.deepEqual(fs.readdirSync(out), [], 'no record was written');
});

test('the live builder SKIPS when the opt in is set to 0, which is a distinct absent case', () => {
  const corpus = scratchRoot('live-zero');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-zero-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'both', '--builder', 'live', '--out', out],
    { corpus, env: { [LIVE_OPT_IN]: '0' } },
  );

  assert.equal(run.status, 0, 'a skip is never a failure');
  const combined = `${run.stdout}${run.stderr}`;
  assert.match(combined, /SKIPPED/);
  assert.match(combined, new RegExp(LIVE_OPT_IN), 'the reason names the opt in variable');
  assert.deepEqual(fs.readdirSync(out), [], 'no record was written');
});

test('the live builder with the opt in at the literal 1 reaches the ADAPTER path, never the skip path', () => {
  // The arm that proves the skip path is a real branch rather than the only
  // branch. A runner whose live builder was a permanent skip would pass both
  // arms above and would still be a runner with no live builder at all.
  //
  // UPDATED because the behaviour intentionally changed. Plan 22-06 refused here
  // with `E_BR_LIVE_ENDPOINT`, which named an HTTP endpoint this dispatch path
  // does not use: the engine dispatches to locally installed adapter BINARIES
  // through the argv profiles. That 1 refusal is REPLACED by 2 narrower ones and
  // this case keeps every structural assertion it made.
  const corpus = scratchRoot('live-one');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-one-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: { [LIVE_OPT_IN]: '1' } },
  );

  assert.notEqual(run.status, 0, 'the non skip branch reports a failure rather than a silent pass');
  const combined = `${run.stdout}${run.stderr}`;
  assert.doesNotMatch(combined, /SKIPPED/, 'this arm did NOT take the skip path');
  assert.match(combined, /FERROX_BENCH_LIVE_ADAPTER/, 'the error names the variable that selects an adapter');
  assert.match(combined, /E_BR_LIVE_ADAPTER_UNSET/, 'it carries a builder error code');
  assert.doesNotMatch(combined, /corpus/i, 'it is a BUILDER error, never reported as a corpus failure');
  assert.deepEqual(fs.readdirSync(out), [], 'and it wrote no record');
});

test('the live builder reaches no adapter on the skip path, so the skip needs no key', () => {
  // Driven by removing every dispatch affordance the runner could use: the skip
  // must be reachable with no adapter identity configured at all.
  const corpus = scratchRoot('live-nokey');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-nokey-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: { FERROX_BENCH_LIVE_ADAPTER: null, FERROX_BENCH_LIVE_BIN: null } },
  );
  assert.equal(run.status, 0);
  assert.match(`${run.stdout}${run.stderr}`, /SKIPPED/);
});

// ─── task 1: the replay builder ──────────────────────────────────────────────

test('the replay builder returns the same recorded candidate across 2 runs of the same task', () => {
  const corpus = scratchRoot('replay-stable');
  writeSingleTask(corpus, 'solo');
  const results = writeResults(scratchRoot('replay-stable-res'), [
    replayRow('solo', 'lane-b', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 2\n'),
    replayRow('solo', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);

  const args = ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--plan-only'];
  const a = reportOf(runScript(args, { corpus, results }));
  const b = reportOf(runScript(args, { corpus, results }));

  assert.equal(a.selection.length, 1, 'exactly 1 node had a recorded candidate');
  assert.deepEqual(a.selection, b.selection, 'the same record is selected on both runs');
  assert.equal(a.selection[0].lane, 'lane-a', 'selection is by a declared preference order, never by file order');
});

test('the replay builder reports NOT ATTEMPTED BY NAME, and it is neither a pass nor a failure', () => {
  // The uncovered tasks carry NO reference fixture either, so the reference
  // fallback cannot reach them. That is what makes them genuinely unattemptable
  // rather than merely lacking an archived record.
  const corpus = scratchRoot('replay-gap');
  writeSingleTask(corpus, 'covered');
  writeSingleTask(corpus, 'uncovered', { reference: false });
  writeMultiTask(corpus, 'structured', { reference: false });
  const results = writeResults(scratchRoot('replay-gap-res'), [
    replayRow('covered', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);
  const out = scratchRoot('replay-gap-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);
  const record = report.records[0];

  assert.equal(record.attempted, 1, 'exactly 1 node was attempted');
  assert.deepEqual(
    record.not_attempted_tasks,
    ['structured', 'uncovered'],
    'every task the builder could not attempt is named',
  );
  assert.equal(record.not_attempted_nodes.length, 5, '1 uncovered single task node plus 4 structured modules');

  // Neither a pass nor a failure: the 3 outcome sets are disjoint and the
  // unattempted tasks appear in none of the 2 that carry a verdict.
  for (const id of ['uncovered', 'structured']) {
    assert.ok(!record.landed_tasks.includes(id), `${id} is not counted as a pass`);
    assert.ok(!record.failed_tasks.includes(id), `${id} is not counted as a failure`);
  }
  assert.equal(record.scored_tasks, 1, 'only the attempted task reached a gate, so only it is in a denominator');
});

test('an unattempted node emits no worker event at all, so it cannot enter a width fold', () => {
  const corpus = scratchRoot('replay-noevents');
  writeSingleTask(corpus, 'covered');
  writeSingleTask(corpus, 'uncovered', { reference: false });
  const results = writeResults(scratchRoot('replay-noevents-res'), [
    replayRow('covered', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);
  const out = scratchRoot('replay-noevents-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const events = readRecord(reportOf(run).records[0].path);

  const started = kindsOf(events, 'worker_started');
  assert.equal(started.length, 1, 'exactly 1 worker_started, for the 1 attempted node');
  assert.deepEqual(started.map((e) => e.node_id), ['covered']);
  assert.ok(
    !events.some((e) => String(e.node_id || '').startsWith('uncovered')),
    'the unattempted task appears in no event of any kind',
  );
});

test('the replay arm carries provenance replayed, so it can never reach a POSITIVE verdict', () => {
  const corpus = scratchRoot('replay-provenance');
  writeSingleTask(corpus, 'covered');
  const results = writeResults(scratchRoot('replay-provenance-res'), [
    replayRow('covered', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);
  const out = scratchRoot('replay-provenance-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const events = readRecord(reportOf(run).records[0].path);
  const started = kindsOf(events, 'run_started')[0];
  assert.equal(started.provenance, 'replayed');
  assert.notEqual(started.provenance, 'measured', 'a replayed arm must never claim to be measured');
});

// ─── task 1: the reference builder refuses where a verdict would read ────────

test('the reference builder refuses with a non zero exit when --out is absent', () => {
  const corpus = scratchRoot('ref-noout');
  writeSingleTask(corpus, 'solo');

  const run = runScript(['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference'], { corpus });

  assert.notEqual(run.status, 0, 'the refusal is a non zero exit');
  assert.match(run.stderr, /E_BR_REFERENCE_NEEDS_OUT/);
  assert.match(run.stderr, /--out/, 'the refusal names the flag it needs');
});

test('the reference builder refuses to write under the published proof directory', () => {
  const corpus = scratchRoot('ref-proof');
  writeSingleTask(corpus, 'solo');
  const inside = path.join(REPO_ROOT, '.planning', 'proof', 'scratch-should-never-exist');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', inside],
    { corpus },
  );

  assert.notEqual(run.status, 0, 'the refusal is a non zero exit');
  assert.match(run.stderr, /E_BR_REFERENCE_IN_PROOF/);
  assert.equal(fs.existsSync(inside), false, 'and it created nothing, because it validated before acting');
});

test('the reference arm carries provenance unavailable, the second guard on the same property', () => {
  const corpus = scratchRoot('ref-provenance');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('ref-provenance-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const events = readRecord(reportOf(run).records[0].path);
  assert.equal(kindsOf(events, 'run_started')[0].provenance, 'unavailable');
});

// UPDATED BY PLAN 22-07, and the guard is not weakened. Plan 22-06 drove this
// against `fleet`, which that plan did not build. This plan builds it, so the
// same guard is driven against an arm NOTHING builds. An unknown arm is still
// refused by name and the arm list is still exactly 2 values.
test('an arm outside the shipped vocabulary is refused by name', () => {
  const corpus = scratchRoot('arm-unknown');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('arm-unknown-out');

  const run = runScript(
    ['--arm', 'parallel', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /E_BR_ARM_UNSUPPORTED/);
  assert.match(run.stderr, /serial, fleet/, 'the refusal names the 2 arms that exist');
});

test('a serial run that is handed a width is refused, so a fleet run cannot wear a baseline label', () => {
  const corpus = scratchRoot('arm-width-serial');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('arm-width-serial-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--width', '3', '--out', out],
    { corpus },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /E_BR_WIDTH_ON_SERIAL/);
  assert.deepEqual(fs.readdirSync(out), [], 'nothing was written');
});

// ─── task 2: the serial arm, the scorer and the self validating record ───────

test('a serial run folds to a DEMONSTRATED WIDTH of exactly 1 with state known', () => {
  // A serial arm that folds to anything else is not a baseline. This is the
  // assertion that catches an emitter overlapping intervals it must not.
  const corpus = scratchRoot('width-one');
  writeSingleTask(corpus, 'alpha');
  writeSingleTask(corpus, 'beta');
  writeMultiTask(corpus, 'widget');
  const out = scratchRoot('width-one-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  assert.equal(record.attempted, 6, '2 single file nodes plus 4 modules were attempted');
  assert.equal(record.metrics.demonstrated_width.state, 'known', 'the width is known, never guessed');
  assert.equal(record.metrics.demonstrated_width.value, 1, 'a serial arm demonstrates a width of exactly 1');
  assert.equal(record.permitted_width, 2, 'while the corpus permitted 2, and the 2 numbers are never merged');
});

test('the written record validates with 0 errors, read back off disk rather than trusted', () => {
  const fold = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs'));
  const corpus = scratchRoot('validates');
  writeSingleTask(corpus, 'alpha');
  writeMultiTask(corpus, 'widget');
  const out = scratchRoot('validates-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);

  const events = readRecord(reportOf(run).records[0].path);
  assert.ok(events.length > 0, 'the file carries events, so the validation below is not vacuous');
  const validation = fold.validateRunRecord(events);
  assert.deepEqual(validation.errors, [], 'the shipped validator reports no error');
  assert.equal(validation.ok, true);
});

test('a suppressed worker_ended is REFUSED BEFORE WRITING, naming E_PR_WORKER_UNTERMINATED', () => {
  // The guard driven against a positive case. An unterminated interval makes
  // demonstrated width UNKNOWABLE, and closing it at run end is the single
  // easiest way to manufacture a positive result.
  const corpus = scratchRoot('suppressed');
  writeSingleTask(corpus, 'alpha');
  writeSingleTask(corpus, 'beta');
  const out = scratchRoot('suppressed-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus, env: { FERROX_BENCH_SUPPRESS_WORKER_END: 'beta' } },
  );

  assert.notEqual(run.status, 0, 'the run is refused');
  assert.match(run.stderr, /E_BR_RECORD_INVALID/);
  assert.match(run.stderr, /E_PR_WORKER_UNTERMINATED/, 'the shipped validator code is named');
  assert.deepEqual(fs.readdirSync(out), [], 'and NOTHING was written: the record was validated before the write');
});

test('the test only suppression flag is named as test only in the help text', () => {
  const run = runScript(['--help']);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /FERROX_BENCH_SUPPRESS_WORKER_END/);
  assert.match(run.stdout, /TEST ONLY/, 'the flag says of itself that it is test only');
});

test('the corpus_hash on run_started equals the hash the shipped index computes', () => {
  const corpusLib = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'bench-corpus.cjs'));
  const corpus = scratchRoot('hash');
  writeSingleTask(corpus, 'alpha');
  writeMultiTask(corpus, 'widget');
  const out = scratchRoot('hash-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);

  const expected = corpusLib.indexCorpus({ root: corpus, repoRoot: corpus, addedTasks: [] });
  assert.equal(expected.ok, true);
  const events = readRecord(reportOf(run).records[0].path);
  const started = kindsOf(events, 'run_started')[0];
  assert.equal(
    started.corpus_hash,
    expected.index.corpus_hash,
    'the verdict refuses to compare 2 arms whose corpus hashes differ, so this field is not decoration',
  );
});

test('a shallow candidate LANDS and is then classified false_green by the later gate', () => {
  // The corpus level analog of the false green case: a candidate that satisfies
  // the contract it was shown and fails the adversarial checks it was not.
  const corpus = scratchRoot('false-green');
  writeSingleTask(corpus, 'alpha');
  const out = scratchRoot('false-green-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--fixture', 'shallow', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);
  const record = report.records[0];
  const events = readRecord(record.path);

  assert.equal(record.scores[0].visible_pct, 100, 'the shallow candidate scores FULL on the visible gate');
  assert.ok(record.scores[0].hidden_pct < 100, 'and strictly below full on the hidden gate');

  const landed = kindsOf(events, 'land_completed');
  assert.equal(landed.length, 1, 'it landed');
  assert.equal(landed[0].node_id, 'alpha');

  const truths = kindsOf(events, 'post_land_truth');
  assert.equal(truths.length, 1);
  assert.equal(
    truths[0].classification,
    'false_green',
    'the shipped vocabulary spells the superseded failed-later classification false_green',
  );
  assert.equal(record.metrics.false_green_rate.state, 'known');
  assert.equal(record.metrics.false_green_rate.value, 1, 'the rate is non zero, computed from post land truth');
});

test('the CONTROL: the same corpus with the reference fixture is classified held', () => {
  const corpus = scratchRoot('held');
  writeSingleTask(corpus, 'alpha');
  const out = scratchRoot('held-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--fixture', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  const events = readRecord(record.path);

  assert.equal(kindsOf(events, 'post_land_truth')[0].classification, 'held');
  assert.equal(record.metrics.false_green_rate.value, 0, 'a measured rate of 0, which is not the same claim as unmeasured');
  assert.equal(record.metrics.false_green_rate.state, 'known');
});

test('a candidate that failed its visible gate produces NO land_completed and NO post_land_truth', () => {
  // An increment that never landed cannot appear in a land failure rate.
  const corpus = scratchRoot('never-landed');
  writeSingleTask(corpus, 'alpha');
  const out = scratchRoot('never-landed-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--fixture', 'mutant', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  const events = readRecord(record.path);

  assert.equal(record.attempted, 1, 'the node WAS attempted, so this is not the empty case');
  assert.ok(record.scores[0].visible_pct < 100, 'and its visible gate did not score full');
  assert.deepEqual(record.landed_tasks, []);
  assert.deepEqual(record.failed_tasks, ['alpha']);
  assert.equal(kindsOf(events, 'land_completed').length, 0);
  assert.equal(kindsOf(events, 'post_land_truth').length, 0);
});

test('a gate that printed no summary line is a REFUSAL naming the task and the gate, never a score of 0', () => {
  const corpus = scratchRoot('silent-gate');
  writeSingleTask(corpus, 'alpha', { silentGate: true });
  const out = scratchRoot('silent-gate-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );

  assert.notEqual(run.status, 0, 'a refusal exits non zero');
  assert.match(run.stderr, /E_BR_GATE_REFUSED/);
  assert.match(run.stderr, /alpha/, 'the refusal names the task');
  assert.match(run.stderr, /visible/, 'and names the gate');
  assert.doesNotMatch(run.stderr, /scored 0 of/, 'a gate that crashed is NOT reported as a score of 0');
  assert.deepEqual(fs.readdirSync(out), [], 'and no record was written');
});

test('the 6 metrics the runner prints equal the 6 the shipped assembler computes from the file', () => {
  const fold = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs'));
  const corpus = scratchRoot('metrics-agree');
  writeSingleTask(corpus, 'alpha');
  writeMultiTask(corpus, 'widget');
  const out = scratchRoot('metrics-agree-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);
  const record = report.records[0];

  const events = readRecord(record.path);
  const doc = fold.assembleFoldDocument({
    events,
    antiloopLogPath: report.antiloop_log_path === null ? undefined : report.antiloop_log_path,
  });

  const keys = Object.keys(doc.metrics).sort();
  assert.equal(keys.length, 6, 'all 6 metric keys are present in every case');
  assert.deepEqual(Object.keys(record.metrics).sort(), keys, 'the runner printed the same 6 keys');
  for (const key of keys) {
    assert.equal(record.metrics[key].state, doc.metrics[key].state, `${key} state agrees`);
    const printed = record.metrics[key].value;
    const computed = doc.metrics[key].value === undefined ? null : doc.metrics[key].value;
    assert.equal(printed, computed, `${key} value agrees, so the operator facing and machine readable numbers cannot disagree`);
  }
});

test('within-task and across-task build the same node set and land the same count', () => {
  const corpus = scratchRoot('two-shapes');
  writeSingleTask(corpus, 'alpha');
  writeMultiTask(corpus, 'widget');
  writeMultiTask(corpus, 'gadget');
  const out = scratchRoot('two-shapes-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'both', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);
  assert.equal(report.records.length, 2, '1 record per shape');

  const within = report.records.find((r) => r.shape === 'within-task');
  const across = report.records.find((r) => r.shape === 'across-task');

  const nodesOf = (rec) => kindsOf(readRecord(rec.path), 'worker_started').map((e) => e.node_id).sort();
  assert.equal(within.attempted, 9, '1 single file node plus 2 tasks of 4 modules');
  assert.deepEqual(nodesOf(within), nodesOf(across), 'the SAME node set: the baseline is the same work in the same amount');
  assert.deepEqual(within.landed_tasks, across.landed_tasks, 'and the same landed count');

  // What they differ in, and it is only these 2 things.
  assert.equal(within.permitted_width, 2, 'coordination width, from structure.json');
  assert.equal(across.permitted_width, 3, 'the task count, which is why it is the ceiling');
  assert.notDeepEqual(
    kindsOf(readRecord(within.path), 'worker_started').map((e) => e.node_id),
    kindsOf(readRecord(across.path), 'worker_started').map((e) => e.node_id),
    'the ORDER differs: one serializes tasks, the other interleaves them',
  );
  assert.equal(across.shape_label, 'the embarrassing parallel upper bound');
});

test('both shapes still demonstrate a width of exactly 1, because both are the serial arm', () => {
  const corpus = scratchRoot('two-shapes-width');
  writeMultiTask(corpus, 'widget');
  writeMultiTask(corpus, 'gadget');
  const out = scratchRoot('two-shapes-width-out');

  const report = reportOf(runScript(
    ['--arm', 'serial', '--shape', 'both', '--builder', 'reference', '--out', out],
    { corpus },
  ));
  for (const record of report.records) {
    assert.equal(record.metrics.demonstrated_width.state, 'known', record.shape);
    assert.equal(record.metrics.demonstrated_width.value, 1, `${record.shape} demonstrates 1`);
  }
});

test('gate_started carries the OBSERVED concurrency, so land gate cost is not UNKNOWN', () => {
  // Plan 22-04 recorded FF-B252: no shipped emitter writes a concurrency, so
  // land gate cost folds to UNKNOWN on every record the loop emits today. This
  // runner writes the observed value, which is 1 on a serial arm.
  const corpus = scratchRoot('concurrency');
  writeSingleTask(corpus, 'alpha');
  const out = scratchRoot('concurrency-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  const events = readRecord(record.path);

  const starts = kindsOf(events, 'gate_started');
  assert.equal(starts.length, 2, 'a visible gate and a hidden gate');
  for (const e of starts) assert.equal(e.concurrency, 1, 'observed, and it is 1 on a serial arm');
  assert.equal(record.metrics.land_gate_cost.state, 'known', 'so the curve is computable rather than UNKNOWN');
  assert.equal(record.metrics.land_gate_cost.buckets[0].concurrency, 1);
});

test('worker_ended carries usd, so cost per landed increment is not UNDEFINED', () => {
  // Plan 22-04 recorded FF-B253: no shipped source writes a usd field, so cost
  // per landed increment folds to UNDEFINED on every record today.
  const corpus = scratchRoot('cost');
  writeSingleTask(corpus, 'covered');
  const results = writeResults(scratchRoot('cost-res'), [
    replayRow('covered', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);
  const out = scratchRoot('cost-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  const events = readRecord(record.path);

  assert.equal(kindsOf(events, 'worker_ended')[0].usd, 0.25, 'the recorded spend rides on the worker end event');
  assert.equal(record.metrics.cost_per_landed_increment.state, 'known');
  assert.equal(record.metrics.cost_per_landed_increment.value, 0.25);
});

// ─── the trap: an empty measurement wearing the clothes of a real one ────────

test('a run that attempted 0 nodes is REFUSED, and the refusal names the number 0', () => {
  // "every task passed" is VACUOUSLY TRUE of 0 tasks. A serial baseline that
  // attempted nothing is an empty measurement, and it must fail loudly rather
  // than report a clean sheet.
  // Neither task carries a reference fixture, so neither the archived source nor
  // the reference fallback can build anything.
  const corpus = scratchRoot('zero-attempted');
  writeSingleTask(corpus, 'alpha', { reference: false });
  writeSingleTask(corpus, 'beta', { reference: false });
  const results = writeResults(scratchRoot('zero-attempted-res'), []);
  const out = scratchRoot('zero-attempted-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );

  assert.notEqual(run.status, 0, 'a run that built nothing is not a baseline');
  assert.match(run.stderr, /E_BR_ZERO_ATTEMPTED/);
  assert.match(run.stderr, /attempted 0 of 2 nodes/, 'the refusal names the number 0');
  assert.match(run.stderr, /alpha, beta/, 'and names every task it could not attempt');
  assert.deepEqual(fs.readdirSync(out), [], 'and it wrote no record');
});

test('the CONTROL: 1 recorded candidate is enough to make the same corpus a real run', () => {
  // The same corpus, 1 field changed, so the assertion above is about the
  // attempted count and not about some unrelated blocker.
  const corpus = scratchRoot('zero-control');
  writeSingleTask(corpus, 'alpha', { reference: false });
  writeSingleTask(corpus, 'beta', { reference: false });
  const results = writeResults(scratchRoot('zero-control-res'), [
    replayRow('alpha', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);
  const out = scratchRoot('zero-control-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(reportOf(run).records[0].attempted, 1);
});

test('a measurement harness refuses to run under a pinned clock', () => {
  // CONTEXT D12. A pinned clock emits every event at 1 instant, so the wall
  // clock reads 0 and the width fold reads a number belonging to no run. A
  // timing test that silently reads no time passes for the wrong reason.
  const corpus = scratchRoot('pinned');
  writeSingleTask(corpus, 'alpha');
  const out = scratchRoot('pinned-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus, env: { FERROX_TEST_MODE: '1', FERROX_NOW_MS: '1700000000000' } },
  );

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /E_BR_CLOCK_PINNED/);
  assert.deepEqual(fs.readdirSync(out), []);
});

// ─── task 3: the guard battery ───────────────────────────────────────────────

test('--repeat 1 warns that SIGMA is undefined, and --repeat 2 does not', () => {
  // A single serial run leaves sigma undefined, and every verdict computed from
  // it returns INSUFFICIENT. Both directions are driven in 1 case, so a runner
  // that always warns and a runner that never warns both fail.
  const corpus = scratchRoot('sigma');
  writeSingleTask(corpus, 'alpha');
  const outOne = scratchRoot('sigma-one-out');
  const outTwo = scratchRoot('sigma-two-out');

  const one = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--repeat', '1', '--out', outOne],
    { corpus },
  );
  assert.equal(one.status, 0, one.stderr);
  const oneReport = reportOf(one);
  assert.equal(oneReport.advisories.length, 1, 'a non zero advisory count');
  assert.match(oneReport.advisories[0], /SIGMA/, 'the advisory names sigma');
  assert.match(one.stderr, /SIGMA UNDEFINED/, 'and it reaches stderr');

  const two = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--repeat', '2', '--out', outTwo],
    { corpus },
  );
  assert.equal(two.status, 0, two.stderr);
  assert.deepEqual(reportOf(two).advisories, [], 'a baseline with a spread carries no advisory');
  assert.doesNotMatch(two.stderr, /SIGMA UNDEFINED/);
});

test('2 records produced in 1 invocation carry distinct run ids and the identical corpus hash', () => {
  const corpus = scratchRoot('distinct-ids');
  writeSingleTask(corpus, 'alpha');
  const out = scratchRoot('distinct-ids-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'both', '--builder', 'reference', '--repeat', '2', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);

  assert.equal(report.records.length, 4, '2 shapes at a repeat of 2');
  const ids = report.records.map((r) => r.run_id);
  assert.equal(new Set(ids).size, 4, 'every run id is distinct');
  assert.equal(fs.readdirSync(out).length, 4, 'and 4 files were written, 1 per record');

  const hashes = new Set(report.records.map((r) => r.corpus_hash));
  assert.equal(hashes.size, 1, 'the verdict refuses to compare 2 arms whose corpus hashes differ');
});

test('the saturation verdict is SATURATED when every candidate scored full', () => {
  // The recorded v1.6 outcome, reproduced by this apparatus at the moment a run
  // completes rather than in a report 2 plans later.
  const corpus = scratchRoot('saturated');
  writeSingleTask(corpus, 'alpha');
  writeSingleTask(corpus, 'beta');
  const out = scratchRoot('saturated-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  assert.deepEqual(record.visible_pcts, [100, 100], 'both scored full');
  assert.equal(record.saturation.verdict, 'saturated');
  assert.equal(record.saturation.n, 2);
  assert.equal(record.saturation.full, 2);
  assert.match(run.stderr, /saturation saturated/, 'and it is printed rather than only recorded');
});

test('the OTHER DIRECTION: 1 non full score makes the same axis discriminating', () => {
  const corpus = scratchRoot('discriminating');
  writeSingleTask(corpus, 'alpha');
  writeSingleTask(corpus, 'beta', { extraTokens: ['OMEGA'] });
  const out = scratchRoot('discriminating-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  assert.equal(record.visible_pcts.length, 2);
  assert.equal(record.saturation.full, 1, 'exactly 1 of the 2 scored full');
  assert.equal(record.saturation.verdict, 'discriminating');
});

test('a task the builder attempted but could not build fully is still refused, never silently dropped', () => {
  // A task with no reference fixture is NOT ATTEMPTED, and a corpus of only such
  // tasks attempts 0 nodes. The guard fires on the reference builder too, so it
  // is not a property of the replay builder alone.
  const corpus = scratchRoot('ref-zero');
  writeSingleTask(corpus, 'alpha', { reference: false });
  const out = scratchRoot('ref-zero-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /E_BR_ZERO_ATTEMPTED/);
  assert.match(run.stderr, /attempted 0 of 1 nodes/);
});

// ─── the reference fallback, which is what gives the corpus any width ────────

test('a multi module task with no archived record is built from its reference implementation', () => {
  // FF-B261. The 18 archived candidate records predate the corpus extension, so
  // the 3 tasks that carry parallel structure had no replay source and were the
  // only tasks reported not attempted that mattered. The fallback decomposes
  // them into 1 node per module with the edges structure.json declares.
  const corpus = scratchRoot('fallback');
  writeMultiTask(corpus, 'widget');
  const results = writeResults(scratchRoot('fallback-res'), []);
  const out = scratchRoot('fallback-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  assert.equal(record.attempted, 4, 'all 4 modules were attempted, where before there were 0');
  assert.deepEqual(record.not_attempted_tasks, [], 'and nothing was left unattempted');
  assert.deepEqual(record.candidate_sources, { reference: 4 }, 'all 4 came from the reference implementation');

  const events = readRecord(record.path);
  assert.deepEqual(
    kindsOf(events, 'worker_started').map((e) => e.node_id).sort(),
    ['widget/a.py', 'widget/b.py', 'widget/c.py', 'widget/d.py'],
    '1 node per module, not 1 node per task',
  );
});

test('the fallback does NOT widen the provenance vocabulary', () => {
  // A reference built candidate is `replayed`, which is what keeps it unable to
  // produce a POSITIVE verdict. A 4th provenance value would be the precise
  // anti pattern this phase refuses.
  const fold = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs'));
  const corpus = scratchRoot('fallback-prov');
  writeMultiTask(corpus, 'widget');
  const results = writeResults(scratchRoot('fallback-prov-res'), []);
  const out = scratchRoot('fallback-prov-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const events = readRecord(reportOf(run).records[0].path);
  const started = kindsOf(events, 'run_started')[0];

  assert.equal(started.provenance, 'replayed');
  assert.ok(fold.PROVENANCES.includes(started.provenance), 'and it is inside the shipped closed vocabulary');
  assert.equal(fold.PROVENANCES.length, 3, 'which still holds exactly 3 values');
  assert.deepEqual(fold.validateRunRecord(events).errors, [], 'so the record still validates');
});

test('an archived candidate is preferred over the reference, and the 2 stay distinguishable', () => {
  // They are both `replayed` and they are NOT the same evidence. A report that
  // could not tell an agent candidate from a reference implementation would be
  // hiding which of the 2 claims it was making.
  const corpus = scratchRoot('sources');
  writeSingleTask(corpus, 'covered');
  writeMultiTask(corpus, 'widget');
  const results = writeResults(scratchRoot('sources-res'), [
    replayRow('covered', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);
  const out = scratchRoot('sources-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  assert.equal(record.attempted, 5, '1 archived single file node plus 4 reference modules');
  assert.deepEqual(record.candidate_sources, { archived: 1, reference: 4 });

  const events = readRecord(record.path);
  const byNode = new Map(kindsOf(events, 'worker_started').map((e) => [e.node_id, e.candidate_source]));
  assert.equal(byNode.get('covered'), 'archived', 'the task WITH a record uses it rather than its fixture');
  assert.equal(byNode.get('widget/a.py'), 'reference');
  assert.equal(new Set([...byNode.values()]).size, 2, 'both sources appear, distinguishable in the record');
});

test('a mixed source arm ADVISES that its cost metric is diluted', () => {
  // The numerator is archived spend alone; the denominator is every landed
  // increment. So the figure falls as the fallback covers more nodes and stops
  // meaning what its name says. Both directions are driven: a pure archived arm
  // carries no such advisory.
  const corpus = scratchRoot('mixed-cost');
  writeSingleTask(corpus, 'covered');
  writeMultiTask(corpus, 'widget');
  const results = writeResults(scratchRoot('mixed-cost-res'), [
    replayRow('covered', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);
  const out = scratchRoot('mixed-cost-out');

  const mixedRun = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--repeat', '2', '--out', out],
    { corpus, results },
  );
  assert.equal(mixedRun.status, 0, mixedRun.stderr);
  const mixed = reportOf(mixedRun);
  assert.equal(mixed.advisories.length, 1, 'exactly the dilution advisory, since --repeat is 2');
  assert.match(mixed.advisories[0], /DILUTED/);
  assert.match(mixed.advisories[0], /1 archived candidates with 4 reference/, 'and it names both counts');

  // The control: a corpus where every attempted node came from an archive.
  const pure = scratchRoot('pure-cost');
  writeSingleTask(pure, 'covered');
  const pureResults = writeResults(scratchRoot('pure-cost-res'), [
    replayRow('covered', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);
  const pureOut = scratchRoot('pure-cost-out');
  const pureRun = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--repeat', '2', '--out', pureOut],
    { corpus: pure, results: pureResults },
  );
  assert.equal(pureRun.status, 0, pureRun.stderr);
  assert.deepEqual(reportOf(pureRun).advisories, [], 'a single source arm carries no dilution advisory');
});

test('a task with neither an archived record nor a reference is STILL not attempted, by name', () => {
  // The fallback must not silently manufacture a candidate. The third outcome
  // survives, and a corpus of only such tasks still trips the 0 attempted guard.
  const corpus = scratchRoot('no-fallback');
  writeSingleTask(corpus, 'bare', { reference: false });
  const results = writeResults(scratchRoot('no-fallback-res'), []);
  const out = scratchRoot('no-fallback-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.notEqual(run.status, 0, 'nothing could be built, so the run is refused');
  assert.match(run.stderr, /E_BR_ZERO_ATTEMPTED/);
  assert.match(run.stderr, /attempted 0 of 1 nodes/);
  assert.match(run.stderr, /bare/, 'the task is named');
  assert.deepEqual(fs.readdirSync(out), []);
});

// ─── the 3 widths, and what separates them ───────────────────────────────────

test('permitted width counts only the nodes ATTEMPTED, never structure the run skipped', () => {
  // The defect this closure fixes. The first baseline declared a permitted width
  // of 2 while every node it attempted was a single file task whose permitted
  // width is 1: the 2 came from a multi file task the builder had skipped. A
  // permitted width drawn from work nobody attempted overstates what any arm
  // could demonstrate, in the direction that flatters a fleet.
  const corpus = scratchRoot('attempted-width');
  writeSingleTask(corpus, 'alpha');
  writeMultiTask(corpus, 'widget', { reference: false });
  const results = writeResults(scratchRoot('attempted-width-res'), [
    replayRow('alpha', 'lane-a', '# ALPHA BETA GAMMA DELTA EPSILON\nX = 1\n'),
  ]);
  const out = scratchRoot('attempted-width-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  assert.deepEqual(record.not_attempted_tasks, ['widget'], 'the structured task could not be built');
  assert.equal(record.permitted_width, 1, 'so the permitted width is 1, the width the attempted set offers');
  assert.notEqual(record.permitted_width, 2, 'NOT the 2 declared by a task nobody attempted');
  assert.equal(
    record.permitted_width_declared_over_corpus,
    2,
    'the corpus figure is still reported beside it, so the gap is visible rather than silent',
  );
});

test('a fully built multi module task offers the width its structure.json declares', () => {
  // The measurement that separates a sound decomposition from a broken one. It
  // is computed from the nodes BUILT and the edges DECLARED, so it is 2 only if
  // the task really was split into modules the fleet arm could run at once.
  const corpus = scratchRoot('available');
  writeMultiTask(corpus, 'widget');
  const results = writeResults(scratchRoot('available-res'), []);
  const out = scratchRoot('available-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const row = reportOf(run).records[0].per_task_width.find((w) => w.task === 'widget');

  assert.equal(row.modules_built, 4);
  assert.equal(row.declared_permitted_width, 2, 'structure.json declares 2');
  assert.equal(row.available_width, 2, 'and the built nodes really offer 2, so the decomposition is SOUND');
  assert.equal(
    row.demonstrated_width,
    1,
    'while the SERIAL arm demonstrates 1, which is correct: a serial arm that demonstrated 2 '
      + 'would not be serial, and would not be a baseline',
  );
});

test('the CONTROL: a task built as an indivisible lump offers a width of 1, not its declared 2', () => {
  // The positive case for the same measurement. Restricted to a single module,
  // the declared width still reads 2 and the AVAILABLE width correctly collapses
  // to 1. Without this arm the previous test is consistent with a number that is
  // simply copied from structure.json.
  const corpus = scratchRoot('lump');
  writeMultiTask(corpus, 'widget');
  const results = writeResults(scratchRoot('lump-res'), []);
  const out = scratchRoot('lump-out');

  // Only the seam carries a reference body; the other 3 modules are removed, so
  // the task is partially built.
  for (const mod of ['b.py', 'c.py', 'd.py']) {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
    fs.rmSync(path.join(corpus, 'multi', 'widget', 'reference', mod), { force: true, maxRetries: 5, retryDelay: 50 });
  }

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  const row = record.per_task_width.find((w) => w.task === 'widget');

  assert.equal(row.modules_built, 1, 'only the seam was built');
  assert.equal(row.declared_permitted_width, 2, 'structure.json still declares 2');
  assert.equal(row.available_width, 1, 'but the built nodes offer only 1, so the number is measured not copied');
  assert.equal(record.permitted_width, 1, 'and a partially built task is credited 1, never its declared width');
});

test('the serial arm still demonstrates exactly 1 with multi module tasks attempted', () => {
  // The baseline contract survives the fallback. Every per task row reads 1 and
  // so does the whole record: the serial arm builds 1 node at a time whatever
  // width the graph offers.
  const corpus = scratchRoot('serial-holds');
  writeMultiTask(corpus, 'widget');
  writeMultiTask(corpus, 'gadget');
  writeSingleTask(corpus, 'alpha');
  const results = writeResults(scratchRoot('serial-holds-res'), []);
  const out = scratchRoot('serial-holds-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  assert.equal(record.attempted, 9, '2 tasks of 4 modules plus 1 single file task');
  assert.equal(record.metrics.demonstrated_width.state, 'known');
  assert.equal(record.metrics.demonstrated_width.value, 1);
  for (const row of record.per_task_width) {
    assert.equal(row.demonstrated_width, 1, `${row.task} demonstrates 1 on a serial arm`);
  }
  assert.equal(record.permitted_width, 2, 'while the attempted set now really permits 2');
});

// ─── the record filename must be committable ─────────────────────────────────

test('no run id matches the secret shapes the pre commit scanner hard blocks', () => {
  // A record nobody can stage is a record that never reaches the verdict. Both
  // shape names end in the word for a unit of work, and followed by a hyphen and
  // a long identifier run its last 2 letters plus that hyphen reproduce the
  // prefix of a well known model provider key, which the repository pre commit
  // scanner hard blocks. Every record named the long way was unstageable. This
  // is the regression guard, and it fires on the id rather than after 4 files
  // have been produced and found uncommittable.
  const corpus = scratchRoot('committable');
  writeSingleTask(corpus, 'alpha');
  const out = scratchRoot('committable-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'both', '--builder', 'reference', '--repeat', '2', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);
  assert.equal(report.records.length, 4, 'both shapes at a repeat of 2, so both id spellings are covered');

  // The subset of the scanner's patterns that a generated identifier can
  // plausibly collide with. A key shape is 1 unlucky word away from any id
  // scheme that joins words with hyphens.
  const SECRET_SHAPES = [
    /sk-[A-Za-z0-9_-]{16,}/,
    /gh[ousr]_[A-Za-z0-9]{20,}/,
    /glpat-[A-Za-z0-9_-]{16,}/,
    /npm_[A-Za-z0-9]{30,}/,
    /AKIA[0-9A-Z]{16}/,
  ];
  for (const record of report.records) {
    for (const shape of SECRET_SHAPES) {
      assert.doesNotMatch(record.run_id, shape, `the run id ${record.run_id} collides with a blocked secret shape`);
      assert.doesNotMatch(path.basename(record.path), shape, 'and neither does the filename it produced');
    }
  }
});

// ─── the emitted vocabulary is the shipped one, not an invented one ──────────

test('the land result this runner emits is a member of the shipped LANDED family', () => {
  // The producer side of the gap closure in `proof-fold`. `_partitionLands`
  // counts an increment as landed ONLY when its result family is in
  // LAND_RESULTS_LANDED, and an unrecognised family folds to UNKNOWN naming the
  // value. A runner emitting an invented string such as `ok` or `done` would
  // therefore produce a baseline that reads EMPTY while looking complete, which
  // is the exact shape of the trap this plan exists to avoid.
  const fold = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs'));
  const corpus = scratchRoot('land-family');
  writeSingleTask(corpus, 'alpha');
  writeSingleTask(corpus, 'beta');
  const out = scratchRoot('land-family-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', out],
    { corpus },
  );
  assert.equal(run.status, 0, run.stderr);
  const events = readRecord(reportOf(run).records[0].path);

  const lands = kindsOf(events, 'land_completed');
  assert.equal(lands.length, 2, 'the run landed 2 increments, so the check below is not vacuous');
  for (const e of lands) {
    const family = String(e.result).split(':')[0];
    assert.ok(
      fold.LAND_RESULTS_LANDED.includes(family),
      `the emitted result family ${JSON.stringify(family)} must be 1 of `
        + `${fold.LAND_RESULTS_LANDED.join(', ')}, or the fold cannot count it as landed`,
    );
    assert.ok(
      !fold.LAND_RESULTS_NOT_LANDED.includes(family),
      'and it must not be a family that means the increment did NOT land',
    );
  }

  // The property that matters, asserted through the fold rather than by
  // inspecting the string: the denominator is non zero.
  const doc = fold.assembleFoldDocument({ events });
  assert.equal(doc.landed, 2, 'the shipped fold counts both increments as landed');
  assert.equal(doc.metrics.cost_per_landed_increment.state, 'known', 'so the rates that divide by it resolve');
  assert.equal(doc.metrics.wall_clock_to_land.state, 'known');
});

test('every post land classification this runner emits is DECIDED, never the undecided unknown', () => {
  // The reader side of the same gap closure. The false green fold partitions
  // truths into decided (held, false_green) and undecided, and a record whose
  // classifications are all `unknown` reports UNDEFINED rather than a fabricated
  // rate of 0. A runner emitting `unknown` would publish an unmeasurable arm.
  const fold = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs'));
  const corpus = scratchRoot('decided');
  writeSingleTask(corpus, 'alpha');
  const outHeld = scratchRoot('decided-held-out');
  const outFalse = scratchRoot('decided-false-out');

  for (const [fixture, expected, dir] of [['reference', 'held', outHeld], ['shallow', 'false_green', outFalse]]) {
    const run = runScript(
      ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--fixture', fixture, '--out', dir],
      { corpus },
    );
    assert.equal(run.status, 0, run.stderr);
    const events = readRecord(reportOf(run).records[0].path);
    const truths = kindsOf(events, 'post_land_truth');
    assert.equal(truths.length, 1, `${fixture} produced 1 classification`);
    assert.equal(truths[0].classification, expected);
    assert.notEqual(truths[0].classification, 'unknown', 'an undecided classification is never emitted');
    assert.equal(
      fold.assembleFoldDocument({ events }).metrics.false_green_rate.state,
      'known',
      `${fixture}: a decided classification yields a KNOWN rate rather than UNDEFINED`,
    );
  }
});

// ─── the committed serial baseline ───────────────────────────────────────────

/**
 * The corpus every PUBLISHED record was measured against, from plan 23-04.
 *
 * It is a literal on purpose. The point of pinning it here is that a record set
 * measured against some OTHER corpus cannot be dropped into `.planning/proof/`
 * and quietly inherit the published baseline's standing: `corpus_hash` is what
 * makes 2 arms comparable, and a test that read the expected hash back out of
 * the same records it is checking would agree with whatever it was given.
 */
const PUBLISHED_CORPUS_HASH = '82f894848aa9a1eadcd081c09b84320b577796111a6cd0cc02612540f79bf3a7';

test('the committed serial baseline is at least 2 measured records that can be compared', () => {
  // SC2. The verdict in plan 22-07 refuses to return anything without a paired
  // serial arm, and refuses to compare 2 arms whose corpus hashes differ, so
  // both properties are guarded here rather than assumed.
  //
  // ─── WHY THIS ARM MOVED OFF THE REPLAY RECORDS, PLAN 23-05 ────────────────
  //
  // It used to read the 4 phase 22 `-replay-` records and require their
  // provenance to be `replayed`. Plan 23-04 changed the corpus, so those records
  // carry a DIFFERENT `corpus_hash` from everything published above them and are
  // non comparable by the shipped guard's own rule. They were moved to
  // `.planning/proof/superseded-phase-22/` rather than deleted, and comparing
  // across that hash boundary is exactly what `corpus_hash` exists to refuse.
  //
  // So the subject is now the committed LIVE baseline, and the provenance
  // assertion INVERTS rather than relaxes. `replayed` was asserted because a
  // replayed arm can never produce a POSITIVE verdict; `measured` is asserted
  // here because a measured arm is the only thing that can, and a replay
  // substituted back under these filenames would be a published proof resting on
  // a rerun. Both directions are pinned exactly, neither accepts both.
  const fold = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs'));
  const proofDir = path.join(REPO_ROOT, '.planning', 'proof');
  assert.equal(fs.existsSync(proofDir), true, 'the published baseline directory exists');

  const files = fs.readdirSync(proofDir)
    .filter((f) => f.startsWith('serial-within-') && f.endsWith('.jsonl'));

  // THE NON ZERO COUNT, ASSERTED FIRST. Every property below is quantified over
  // this list, so all of them are vacuously true of an empty one. A rename of the
  // published records would empty the filter and turn this whole arm green
  // without a single record being read, which is the defect class this milestone
  // exists to eliminate, so the count answers before anything else does.
  assert.ok(
    files.length > 0,
    'the baseline filter matched 0 records, so every assertion below it is vacuous. '
      + `${proofDir} holds: ${fs.readdirSync(proofDir).join(', ')}`,
  );
  assert.ok(
    files.length >= fold.MIN_SERIAL_RUNS,
    `the baseline holds ${files.length} serial records. Sigma is the spread over at least `
      + `${fold.MIN_SERIAL_RUNS} serial runs, so a baseline of fewer than that leaves every `
      + 'verdict INSUFFICIENT.',
  );

  const runIds = new Set();
  const corpusHashes = new Set();
  let totalAttempted = 0;
  let totalLanded = 0;
  for (const file of files) {
    const events = readRecord(path.join(proofDir, file));
    const validation = fold.validateRunRecord(events);
    assert.deepEqual(validation.errors, [], `${file} validates through the shipped validator`);

    const started = kindsOf(events, 'run_started')[0];
    assert.equal(started.arm, 'serial');
    assert.equal(
      started.provenance, fold.MEASURED_PROVENANCE,
      `${file} carries provenance ${String(started.provenance)}. The published baseline is a REAL `
        + 'measurement, and only a measured arm can support a POSITIVE verdict.',
    );
    runIds.add(started.run_id);
    corpusHashes.add(started.corpus_hash);

    const width = fold.foldDemonstratedWidth(events);
    assert.equal(width.state, 'known', `${file} width is known`);
    assert.equal(width.value, 1, `${file} demonstrates a width of exactly 1, which is what makes it a baseline`);

    totalAttempted += kindsOf(events, 'worker_started').length;

    // The DENOMINATOR, not merely the attempt. An emitted result outside the
    // shipped landed family folds to an empty landed set, so a record can carry
    // worker events and still leave every rate that divides by landed
    // increments with nothing to divide by.
    const doc = fold.assembleFoldDocument({ events });
    assert.ok(doc.landed > 0, `${file} folds to ${doc.landed} landed increments, so its rates have a denominator`);
    totalLanded += doc.landed;
  }

  assert.equal(runIds.size, files.length, 'every run id is distinct');
  assert.equal(corpusHashes.size, 1, 'every record carries the identical corpus hash');
  // And it is the hash plan 04 PUBLISHED, not merely a hash they agree on. 2
  // records rebuilt together against a different corpus would also agree with
  // each other, and would silently replace the baseline the report was rendered
  // from.
  assert.equal(
    [...corpusHashes][0], PUBLISHED_CORPUS_HASH,
    'the committed baseline was measured against a corpus other than the published one, so it is '
      + 'not comparable with the fleet arm it is published beside',
  );

  // THE NON VACUOUS ASSERTIONS. Every property above is trivially true of a
  // record that attempted nothing, so both counts are asserted non zero by name.
  // A baseline of 0 attempted nodes is an empty measurement wearing the clothes
  // of a real one.
  assert.ok(
    totalAttempted > 0,
    `the committed baseline attempted ${totalAttempted} nodes in total. A serial baseline that `
      + 'attempted 0 nodes is not a baseline, and every claim above it is vacuous.',
  );
  assert.ok(
    totalLanded > 0,
    `the committed baseline folds to ${totalLanded} landed increments in total. "every task passed" `
      + 'is vacuously true of 0 tasks.',
  );
});

// ─── plan 07 task 1: the fleet arm, its loop probe and its skip path ─────────
//
// EVERY case below drives a STUB loop, never phase 19. A stub that answers the
// probe and reports a preflight verdict is enough to prove the arm's record
// shape, its width fold, its abnormal exit handling, its reader adaptation and
// its skip path, and it keeps this file running in seconds. The real loop is
// exercised by hand in task 3, and what it does there is REFUSE.

/**
 * A stub dispatch entry point standing in for `scripts/fleet-loop.cjs`.
 *
 * It answers the 2 invocations the probe and the arm make of the real one:
 * `<phase> --preflight --raw` prints a preflight document, and `<phase> --run
 * --log=<path>` appends the 2 event refused record the real loop writes when its
 * own preflight refuses. Nothing else about phase 19 is simulated, because
 * nothing else is observed.
 */
function writeStubLoop(root, opts) {
  const o = opts || {};
  const file = path.join(root, 'stub-loop.cjs');
  const body = [
    "'use strict';",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const ALLOWED = ${o.dispatchAllowed === true ? 'true' : 'false'};`,
    `const REFUSED_BECAUSE = ${JSON.stringify(o.refusedBecause || 'empty-roster: 0 adapters are configured')};`,
    'const argv = process.argv.slice(2);',
    'const preflight = {',
    '  checks: [{ name: "adapters", ok: ALLOWED, refused_because: ALLOWED ? "" : REFUSED_BECAUSE, observed: { roster: [] } }],',
    '  check_names: ["adapters"],',
    '  dispatch_allowed: ALLOWED,',
    '};',
    'if (!argv.includes("--run")) {',
    '  process.stdout.write(JSON.stringify(preflight) + "\\n");',
    '  process.exit(ALLOWED ? 0 : 1);',
    '}',
    'const logFlag = argv.find((a) => a.startsWith("--log="));',
    'const logPath = logFlag === undefined ? null : logFlag.slice("--log=".length);',
    'if (logPath !== null) {',
    '  fs.mkdirSync(path.dirname(logPath), { recursive: true });',
    '  const now = Date.now();',
    '  const rows = [',
    '    { ts: now, kind: "run_started", run_id: "stub-run", graph_generation: null, phase: "22" },',
    '    { ts: now + 1, kind: "run_closed", run_id: "stub-run", stopped_by: "preflight_refused" },',
    '  ];',
    '  fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join("\\n") + "\\n", "utf8");',
    '}',
    'process.stdout.write(JSON.stringify({ run_id: "stub-run", dispatch_allowed: ALLOWED }) + "\\n");',
    'process.exit(ALLOWED ? 0 : 1);',
    '',
  ].join('\n');
  writeFile(file, body);
  return file;
}

/**
 * A stub graph reporter standing in for `scripts/gen-workgraph.cjs`.
 *
 * `nodeCount` of 0 is the arm that proves the second probed fact is a real
 * observation: a document describing 0 nodes describes no graph for the corpus
 * run, and the probe must refuse it however callable the entry point was.
 */
function writeStubGraph(root, nodeCount) {
  const file = path.join(root, 'stub-graph.cjs');
  const ids = [];
  for (let i = 1; i <= nodeCount; i++) ids.push(`22-0${i}`);
  const body = [
    "'use strict';",
    `const IDS = ${JSON.stringify(ids)};`,
    'const doc = {',
    '  schema: "workgraph/v1",',
    '  phase: "22",',
    '  schedule: IDS,',
    '  nodes: IDS.map((id, i) => ({ id, schedule_order: i, wave: 1 })),',
    '  edges: [],',
    '};',
    'process.stdout.write(JSON.stringify(doc) + "\\n");',
    '',
  ].join('\n');
  writeFile(file, body);
  return file;
}

/** The 4 seams the fleet arm reads, set together so no case half configures one. */
function fleetEnv(root, opts) {
  const o = opts || {};
  return {
    FERROX_BENCH_FLEET_ENTRY: o.entry === null ? path.join(root, 'no-such-loop.cjs') : o.entry,
    FERROX_BENCH_FLEET_GRAPH: o.graph,
    FERROX_BENCH_FLEET_PHASE: '22',
  };
}

test('the fleet arm against a stub loop with 3 ready nodes at width 2 folds to a demonstrated width of exactly 2', () => {
  const corpus = scratchRoot('fleet-w2');
  const stubs = scratchRoot('fleet-w2-stub');
  const out = scratchRoot('fleet-w2-out');
  for (const id of ['s1', 's2', 's3']) writeSingleTask(corpus, id);

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: true }),
        graph: writeStubGraph(stubs, 3),
      }),
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);
  assert.equal(report.status, 'ok', 'the arm ran rather than skipping or refusing');
  const record = report.records[0];

  // NON VACUOUS FIRST. Every width claim is trivially true of a run that
  // dispatched nothing, so the attempted count is asserted before the width.
  assert.equal(record.attempted, 3, 'all 3 nodes were attempted');
  assert.equal(record.metrics.demonstrated_width.state, 'known');
  assert.equal(
    record.metrics.demonstrated_width.value, 2,
    'the fleet arm demonstrates exactly the width it was allowed, and is neither 3 (uncapped) nor 1 (serial)',
  );
});

// ─── FF-B345: the dispatch CEILING, and the silent clamp it replaced ─────────
//
// THE DEFECT. The ceiling was `permittedWidth`, which for a within task run is
// the maximum DECLARED `permitted_width` over the tasks. That is a PER TASK
// number, it says how many modules of ONE task may be built at once, and it was
// governing a run holding 5 tasks. `--width 8` was silently lowered to 3 and the
// paid 23-05 run measured a scheduler nobody had asked for.
//
// The ceiling is now `availableWidth` over the run's own node ids and declared
// edges: the largest number of them simultaneously ready in a valid build order.
// The declared number is still reported and is asserted below to be DIFFERENT
// from the ceiling, because a corpus where the 2 coincide could not tell which
// one the runner used.

test('FF-B345: the ceiling is the graph AVAILABLE width, not the per task declared one', () => {
  const corpus = scratchRoot('fleet-cap');
  const stubs = scratchRoot('fleet-cap-stub');
  const out = scratchRoot('fleet-cap-out');
  // 2 single file tasks plus 1 multi file task whose declared permitted width is
  // 2. The declared within task width is therefore 2, while the head of the
  // order carries exactly 3 simultaneously ready nodes: s1, s2 and the multi
  // task seam. The 2 numbers DIFFER, which is what makes the case discriminating.
  for (const id of ['s1', 's2']) writeSingleTask(corpus, id);
  writeMultiTask(corpus, 'widget');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference', '--width', '5', '--out', out],
    {
      corpus,
      outerBoundMs: 60_000,
      env: {
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 3),
        }),
        // PINNED, for the reason `pinnedProfile` states below: an unpinned
        // corpus refills a lane inside the millisecond it freed it, and the
        // folded width then stops being a property of the schedule.
        FERROX_BENCH_NODE_MS: JSON.stringify({
          s1: 400, s2: 400, 'widget/a.py': 400, 'widget/b.py': 100, 'widget/c.py': 100, 'widget/d.py': 100,
        }),
      },
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.attempted, 6, 'NON ZERO FIRST: 2 single nodes plus 4 modules');

  assert.equal(record.width_requested, 5, 'the record says what was ASKED for');
  assert.equal(record.width_available, 3, 'and what the GRAPH offers, which is 3 ready nodes at its widest');
  assert.equal(record.dispatch_cap, 3, 'the cap is the lesser of the 2, never the 5 that was asked for');
  assert.equal(
    record.permitted_width_declared_over_corpus, 2,
    'the DECLARED per task number is still reported, and it is 2. A cap of 2 here would mean the '
      + 'runner was still using the declared number as its ceiling',
  );
  assert.notEqual(
    record.dispatch_cap, record.permitted_width_declared_over_corpus,
    'the ceiling and the declaration are DIFFERENT numbers on this corpus, which is what makes this '
      + 'case able to tell them apart',
  );

  assert.equal(record.metrics.demonstrated_width.state, 'known');
  assert.equal(
    record.metrics.demonstrated_width.value, 3,
    'the arm demonstrates 3: what the graph had, not the 5 asked for and not the 2 declared',
  );

  // THE CLAMP IS LOUD. A cap lowered in silence is how a scheduler defect gets
  // published as a measurement, so the lowering is stated on stderr and in the
  // record, and both numbers are named.
  assert.equal(record.width_lowered, true, 'the record says the request was lowered');
  assert.match(run.stderr, /W_BR_WIDTH_LOWERED/, 'and stderr names the notice');
  assert.match(run.stderr, /--width 5 was asked for/, 'naming what was asked for');
  assert.match(run.stderr, /the dispatch cap is 3/, 'and what was given');
});

test('FF-B345: the CONTROL, a request AT OR UNDER the available width is silent and binds', () => {
  // D8a both directions, and it is 2 claims in 1 arm. The notice is ABSENT over a
  // world where nothing was lowered, and the cap still BINDS below the ceiling:
  // if the fix had simply removed the clamp this arm would read 3.
  const corpus = scratchRoot('fleet-cap-ctl');
  const stubs = scratchRoot('fleet-cap-ctl-stub');
  const out = scratchRoot('fleet-cap-ctl-out');
  for (const id of ['s1', 's2']) writeSingleTask(corpus, id);
  writeMultiTask(corpus, 'widget');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      outerBoundMs: 60_000,
      env: {
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 3),
        }),
        FERROX_BENCH_NODE_MS: JSON.stringify({
          s1: 400, s2: 400, 'widget/a.py': 400, 'widget/b.py': 100, 'widget/c.py': 100, 'widget/d.py': 100,
        }),
      },
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.attempted, 6, 'NON ZERO FIRST: every node was still built');
  assert.equal(record.width_requested, 2);
  assert.equal(record.width_available, 3, 'the graph still offers 3');
  assert.equal(record.dispatch_cap, 2, 'and the arm still takes the 2 it asked for');
  assert.equal(record.width_lowered, false);
  assert.equal(
    run.stderr.includes('W_BR_WIDTH_LOWERED'), false,
    'the lowering notice is ABSENT over a run that was not lowered',
  );
  assert.equal(
    record.metrics.demonstrated_width.value, 2,
    'exactly 2, never the 3 an unbounded arm would reach',
  );
});

test('FF-B345: --plan-only reports the available width, so the ceiling is readable at zero spend', () => {
  // An operator choosing `--width` can see what the graph actually offers BEFORE
  // paying for a run, rather than discovering afterwards that it was lowered.
  const corpus = scratchRoot('fleet-cap-plan');
  for (const id of ['s1', 's2']) writeSingleTask(corpus, id);
  writeMultiTask(corpus, 'widget');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference', '--plan-only'],
    { corpus },
  );

  assert.equal(run.status, 0, run.stderr);
  const plan = reportOf(run);
  assert.equal(plan.nodes.length, 6, 'NON ZERO FIRST: the plan describes 6 nodes');
  assert.equal(plan.available_width, 3, 'and states the ceiling the cap will be taken against');
  assert.equal(plan.permitted_width, 2, 'beside the declared number, which is NOT the ceiling');
});

// ─── FF-B343: the READY SET, and the head of line block it replaced ──────────
//
// THE DEFECT. The batch scan stopped at the first node whose prerequisites were
// unmet instead of skipping it. The within task order groups a task's nodes
// together, so the instant the head of the queue was a module waiting on its
// seam the WHOLE fleet stopped, including every other task whose seam was ready
// and idle. The paid 23-05 fleet record spent 218.3 of its 486.0 build seconds
// at a demonstrated width of exactly 1 for that reason and published 1.33x.
//
// The comment defending the `break` claimed skipping would build the graph in an
// order the shape did not declare. That is false: the shape declares EDGES, the
// order is one valid linearization of them, and a node whose every declared
// prerequisite is done is a valid topological step wherever it sits in that
// linearization.
//
// EVERY CASE BELOW ASSERTS A COUNTER. The demonstrated width is folded through
// the shipped fold from the record's own intervals, and the attempted count is
// asserted as a non zero equality first, because every width claim is vacuously
// true of a run that dispatched nothing.

/**
 * A PINNED duration profile: every seam slow, every leaf quick.
 *
 * THE DURATIONS ARE THE EXPERIMENT, not decoration. With every child equally
 * fast the runner refills a lane inside the same millisecond it freed it, every
 * interval in the record shares a timestamp with several others, and the folded
 * width stops being a property of the SCHEDULE. A head of line scan then folds
 * to the same number a ready set scan does, and the case cannot tell them apart.
 * This was found by mutation: the head of line `break` SURVIVED against an
 * unpinned corpus and is killed against this one.
 */
function pinnedProfile(tasks) {
  const profile = {};
  for (const task of tasks) {
    profile[`${task}/a.py`] = 400;
    profile[`${task}/b.py`] = 100;
    profile[`${task}/c.py`] = 100;
    profile[`${task}/d.py`] = 100;
  }
  return JSON.stringify(profile);
}

test('FF-B343: a BLOCKED head no longer stops the fleet, and the width folds to 3 rather than 2', () => {
  const corpus = scratchRoot('fleet-readyset');
  const stubs = scratchRoot('fleet-readyset-stub');
  const out = scratchRoot('fleet-readyset-out');
  // 3 multi file tasks, each 4 modules behind 1 seam, each declaring a permitted
  // width of 3 so the cap is not the thing under test. The within task order is
  // m1's 4 modules, then m2's, then m3's, so the head of the queue is BLOCKED
  // from the second fill onward while 2 other seams sit ready.
  for (const id of ['m1', 'm2', 'm3']) writeMultiTask(corpus, id, { permitted_width: 3 });

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference', '--width', '3', '--out', out],
    {
      corpus,
      outerBoundMs: 60_000,
      env: {
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 3),
        }),
        FERROX_BENCH_NODE_MS: pinnedProfile(['m1', 'm2', 'm3']),
      },
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  // NON ZERO FIRST.
  assert.equal(record.attempted, 12, 'all 12 modules were attempted');
  assert.equal(record.dispatch_cap, 3, 'and the arm was allowed 3 lanes');

  assert.equal(record.metrics.demonstrated_width.state, 'known');
  assert.equal(
    record.metrics.demonstrated_width.value, 3,
    'the 3 seams are dispatched together. A head of line scan would reach only 2, because it would '
      + 'stop at m1 module b and never see the m2 and m3 seams behind it',
  );

  // THE SAME CLAIM AS AN INSTANT, read off the record rather than off the fold.
  // The 3 seams open their intervals with nothing having closed in between,
  // which is what "dispatched together" means and is not something a fold that
  // counted wrongly could manufacture.
  const worker = readRecord(record.path)
    .filter((e) => e.kind === 'worker_started' || e.kind === 'worker_ended');
  const opening = [];
  for (const event of worker) {
    if (event.kind === 'worker_ended') break;
    opening.push(String(event.node_id));
  }
  assert.deepEqual(
    opening.sort(), ['m1/a.py', 'm2/a.py', 'm3/a.py'],
    'the first 3 events are the 3 seams starting, with no end between them',
  );
});

test('FF-B343: the CONTROL, the same 3 tasks at width 2 still demonstrate exactly 2', () => {
  // The other direction. If the ready set had simply removed the cap, this arm
  // would read 3 as well. It reads the number it was allowed, so the case above
  // measured the scan and not a missing bound.
  const corpus = scratchRoot('fleet-readyset-ctl');
  const stubs = scratchRoot('fleet-readyset-ctl-stub');
  const out = scratchRoot('fleet-readyset-ctl-out');
  for (const id of ['m1', 'm2', 'm3']) writeMultiTask(corpus, id, { permitted_width: 3 });

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      outerBoundMs: 60_000,
      env: {
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 3),
        }),
        FERROX_BENCH_NODE_MS: pinnedProfile(['m1', 'm2', 'm3']),
      },
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.attempted, 12, 'NON ZERO FIRST: all 12 modules were attempted');
  assert.equal(record.dispatch_cap, 2);
  assert.equal(record.metrics.demonstrated_width.value, 2, 'exactly the 2 lanes it was allowed, never 3');
});

test('FF-B343: REQUIRED FAILING ARM, an unsatisfiable prerequisite still REFUSES as E_BR_FLEET_STUCK', () => {
  // The guard has to keep firing, and under ready set semantics an empty batch
  // is no longer the routine "the head is not ready". It can now only mean NO
  // remaining node has a valid topological step, so the case is manufactured:
  // the seam's build child reports `not-attempted`, which is a real branch the
  // parent already handles, and the 3 modules behind it can never become ready.
  const corpus = scratchRoot('fleet-stuck');
  const stubs = scratchRoot('fleet-stuck-stub');
  const out = scratchRoot('fleet-stuck-out');
  writeMultiTask(corpus, 'widget');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: {
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 1),
        }),
        FERROX_BENCH_NOT_ATTEMPTED_NODE: 'widget/a.py',
      },
    },
  );

  assert.notEqual(run.status, 0, 'a stuck graph is a refusal, never a run that quietly built 3 of 4');
  assert.match(run.stderr, /E_BR_FLEET_STUCK/, 'and it refuses by the shipped code');
  assert.match(
    run.stderr, /No remaining node has all of its declared prerequisites done/,
    'the refusal states the ready set condition, not the head of line one it replaced',
  );
  // The refusal NAMES what is blocked and what it waits on, so a reader can tell
  // an unsatisfiable prerequisite from a cycle without re running anything.
  for (const module of ['widget/b.py', 'widget/c.py', 'widget/d.py']) {
    assert.match(
      run.stderr, new RegExp(`${module.replace('/', '\\/')} waiting on widget\\/a\\.py`),
      `${module} is named as blocked on the seam`,
    );
  }
  assert.deepEqual(recordsIn(out), [], 'and no run record is written for a graph that never completed');
});

test('FF-B343: the CONTROL, the same corpus with no unsatisfiable prerequisite completes', () => {
  // D8a both directions. Without the seam refusing, the identical invocation
  // runs to a record, so the refusal above is a property of the world and not of
  // the corpus or the arm.
  const corpus = scratchRoot('fleet-stuck-ctl');
  const stubs = scratchRoot('fleet-stuck-ctl-stub');
  const out = scratchRoot('fleet-stuck-ctl-out');
  writeMultiTask(corpus, 'widget');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: true }),
        graph: writeStubGraph(stubs, 1),
      }),
    },
  );

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr.includes('E_BR_FLEET_STUCK'), false, 'the stuck sentence is ABSENT here');
  assert.equal(reportOf(run).records[0].attempted, 4, 'NON ZERO FIRST: all 4 modules built');
});

test('FF-B343: 2 runs over the same corpus name the SAME scoring node, so the report is reproducible', () => {
  // The bookkeeping now applies out of the shape's order, so the order is
  // RESTORED before it is read. `executeRun` picks a task's scoring node as the
  // LAST member of `built` for that task and emits that id on every gate, land
  // and post land event, so a `built` left in completion order would make 2 runs
  // over 1 corpus disagree about which node was scored.
  const corpus = scratchRoot('fleet-determinism');
  const stubs = scratchRoot('fleet-determinism-stub');
  const out = scratchRoot('fleet-determinism-out');
  for (const id of ['m1', 'm2']) writeMultiTask(corpus, id, { permitted_width: 3 });

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference', '--width', '3',
      '--repeat', '2', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: true }),
        graph: writeStubGraph(stubs, 2),
      }),
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);
  assert.equal(report.records.length, 2, 'NON ZERO FIRST: 2 records were produced in 1 invocation');

  const shapeOf = (rec) => readRecord(rec.path)
    .filter((e) => ['gate_started', 'gate_ended', 'land_completed', 'post_land_truth'].includes(e.kind))
    .map((e) => `${e.kind}:${e.node_id}`);

  const first = shapeOf(report.records[0]);
  const second = shapeOf(report.records[1]);
  assert.ok(first.length > 0, 'NON ZERO FIRST: the runs emitted scoring events at all');
  assert.deepEqual(second, first, 'the 2 runs name the identical nodes on every scoring event');
  // And the scoring node is the LAST module of each task in the DECLARED order,
  // never whichever child happened to exit last.
  assert.ok(first.includes('gate_started:m1/d.py'), 'm1 is scored on its last module in build order');
  assert.ok(first.includes('gate_started:m2/d.py'), 'and so is m2');
});

test('a killed fleet worker still closes its interval as abnormal and the width stays known', () => {
  const corpus = scratchRoot('fleet-kill');
  const stubs = scratchRoot('fleet-kill-stub');
  const out = scratchRoot('fleet-kill-out');
  for (const id of ['s1', 's2', 's3']) writeSingleTask(corpus, id);

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: {
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 3),
        }),
        FERROX_BENCH_KILL_NODE: 's1',
      },
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  const events = readRecord(record.path);

  const ended = kindsOf(events, 'worker_ended').filter((e) => e.node_id === 's1');
  assert.equal(ended.length, 1, 'the killed worker still emitted exactly 1 end event');
  assert.equal(
    ended[0].outcome, 'abnormal',
    'the shipped vocabulary spells an abnormal exit `abnormal`; a worker that ends with no event makes width unknowable',
  );
  assert.equal(record.metrics.demonstrated_width.state, 'known', 'the interval closed, so the width is a number');
  assert.equal(record.metrics.demonstrated_width.value, 2);
});

test('with the abnormal end handler suppressed the same killed worker makes the width unknown', () => {
  const corpus = scratchRoot('fleet-kill-sup');
  const stubs = scratchRoot('fleet-kill-sup-stub');
  const out = scratchRoot('fleet-kill-sup-out');
  for (const id of ['s1', 's2', 's3']) writeSingleTask(corpus, id);

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: {
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 3),
        }),
        FERROX_BENCH_KILL_NODE: 's1',
        FERROX_BENCH_SUPPRESS_ABNORMAL_END: '1',
      },
    },
  );

  // THE SECOND ARM. The first proves the handler works; this one proves the fold
  // would have caught it if it had not. Without both, a handler that silently
  // stopped running would be indistinguishable from a guard that cannot fire.
  assert.notEqual(run.status, 0, 'the record is refused rather than written');
  assert.match(run.stderr, /E_PR_WORKER_UNTERMINATED/, 'the shipped validator names the unterminated interval');
  assert.match(run.stderr, /demonstrated width folded to unknown/, 'the fold state is reported beside the validator code');
  assert.match(run.stderr, /1 unterminated worker interval/, 'and the fold names exactly 1 unterminated interval');
  assert.deepEqual(fs.readdirSync(out), [], 'nothing was written: validation runs before the write');
});

test('the fleet arm skips when no loop is present, naming both probed facts', () => {
  const corpus = scratchRoot('fleet-skip');
  const stubs = scratchRoot('fleet-skip-stub');
  const out = scratchRoot('fleet-skip-out');
  writeSingleTask(corpus, 's1');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, { entry: null, graph: writeStubGraph(stubs, 3) }),
    },
  );

  assert.equal(run.status, 0, 'a measurement that was not taken is neither a pass nor a failure');
  const report = reportOf(run);
  assert.equal(report.status, 'SKIPPED');
  assert.equal(report.records.length, 0, 'no record was written');
  assert.deepEqual(fs.readdirSync(out), [], 'and no file was created');
  assert.equal(report.probe.callable, false, 'the first probed fact is reported');
  assert.equal(typeof report.probe.graph_generation, 'string', 'the second probed fact is reported too');
  assert.match(report.reason, /dispatch entry point/, 'the reason names what was probed');
  assert.match(report.reason, /graph generation/, 'and names the second fact, so a reader sees both');
});

test('the fleet arm skips when the graph reports 0 nodes, however callable the entry point is', () => {
  const corpus = scratchRoot('fleet-skip-graph');
  const stubs = scratchRoot('fleet-skip-graph-stub');
  const out = scratchRoot('fleet-skip-graph-out');
  writeSingleTask(corpus, 's1');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: true }),
        graph: writeStubGraph(stubs, 0),
      }),
    },
  );

  assert.equal(run.status, 0);
  const report = reportOf(run);
  assert.equal(report.status, 'SKIPPED');
  assert.equal(report.probe.callable, true, 'the entry point WAS callable');
  assert.equal(report.probe.graph_generation, null, 'and the graph still reported no generation for the corpus run');
});

test('a configuration value claiming a fleet does not make the loop probe pass', () => {
  const corpus = scratchRoot('fleet-config-lie');
  const stubs = scratchRoot('fleet-config-lie-stub');
  const out = scratchRoot('fleet-config-lie-out');
  writeSingleTask(corpus, 's1');

  // THE RECORDED DEFECT, driven directly. MEASUREMENT-v1.14-PARALLELISM.md
  // finding 1 records a width limiter that was planner conservatism read from
  // configuration rather than anything true about the code, and phase 19 GATE 1
  // says the same of a base check that trusted a setting. A configuration key
  // asserting a fleet is enabled is not evidence that one exists.
  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--out', out],
    {
      corpus,
      env: {
        ...fleetEnv(stubs, { entry: null, graph: writeStubGraph(stubs, 3) }),
        FERROX_BENCH_FLEET_ENABLED: '1',
        FERROX_BENCH_FLEET_ADAPTERS: 'claude,codex',
      },
    },
  );

  assert.equal(run.status, 0);
  const report = reportOf(run);
  assert.equal(report.status, 'SKIPPED', 'the probe observes rather than reads configuration');
  assert.equal(report.records.length, 0);
});

test('the fleet arm record validates with 0 errors through the shipped validator', () => {
  const corpus = scratchRoot('fleet-valid');
  const stubs = scratchRoot('fleet-valid-stub');
  const out = scratchRoot('fleet-valid-out');
  for (const id of ['s1', 's2', 's3']) writeSingleTask(corpus, id);

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: true }),
        graph: writeStubGraph(stubs, 3),
      }),
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  const events = readRecord(record.path);
  const fold = require(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs'));
  const validation = fold.validateRunRecord(events);

  assert.ok(kindsOf(events, 'worker_started').length > 0, 'the record carries worker events at all');
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(validation.errors.length, 0);

  const started = events.find((e) => e.kind === 'run_started');
  assert.equal(started.arm, 'fleet', 'the arm names itself fleet');
  assert.equal(started.provenance, 'unavailable', 'the reference builder is not a measurement of an agent');
  assert.ok(String(started.corpus_hash).length > 0);
});

test('the fleet arm and the serial arm build the same node set and land the same count', () => {
  const corpus = scratchRoot('fleet-parity');
  const stubs = scratchRoot('fleet-parity-stub');
  const fleetOut = scratchRoot('fleet-parity-fleet');
  const serialOut = scratchRoot('fleet-parity-serial');
  for (const id of ['s1', 's2']) writeSingleTask(corpus, id);
  writeMultiTask(corpus, 'widget');

  const env = fleetEnv(stubs, {
    entry: writeStubLoop(stubs, { dispatchAllowed: true }),
    graph: writeStubGraph(stubs, 3),
  });

  const fleet = runScript(
    ['--arm', 'fleet', '--shape', 'within-task', '--builder', 'reference', '--width', '2', '--out', fleetOut],
    { corpus, env },
  );
  const serial = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'reference', '--out', serialOut],
    { corpus, env },
  );

  assert.equal(fleet.status, 0, fleet.stderr);
  assert.equal(serial.status, 0, serial.stderr);
  const f = reportOf(fleet).records[0];
  const s = reportOf(serial).records[0];

  // Comparable BY CONSTRUCTION rather than by coincidence: the same node model,
  // the same builder and the same scorer, differing only in how many build
  // children are in flight at once.
  assert.ok(f.attempted > 0, 'the fleet arm attempted a non zero number of nodes');
  assert.equal(f.attempted, s.attempted, 'the same node count was attempted');
  assert.deepEqual(f.landed_tasks, s.landed_tasks, 'the same tasks landed');
  assert.deepEqual(f.failed_tasks, s.failed_tasks, 'the same tasks failed');
  assert.equal(f.corpus_hash, s.corpus_hash, 'over the identical corpus');
  assert.notEqual(f.metrics.demonstrated_width.value, s.metrics.demonstrated_width.value,
    'and they differ in exactly the thing being measured');
});

test('a loop that refuses dispatch makes the fleet arm REFUSED with the named reason, never a pass and never a failure', () => {
  const corpus = scratchRoot('fleet-refused');
  const stubs = scratchRoot('fleet-refused-stub');
  const out = scratchRoot('fleet-refused-out');
  writeSingleTask(corpus, 's1');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: false, refusedBecause: 'empty-roster: 0 adapters are configured' }),
        graph: writeStubGraph(stubs, 3),
      }),
    },
  );

  assert.equal(run.status, 0, 'a refusal is neither a pass nor a failure');
  const report = reportOf(run);
  assert.equal(report.status, 'REFUSED');
  assert.match(report.reason, /empty-roster/, 'the loop own reason travels through verbatim');
  assert.equal(report.records.length, 0, 'a run that dispatched nothing measured nothing');

  // UPDATED IN THE GAP CLOSURE, and the guard is strengthened. It previously
  // asserted the directory stayed EMPTY. Writing nothing was the defect: it left
  // the report with no evidence of WHY the fleet arm was absent, so the renderer
  // asserted a cause on the bare condition that no fleet arm was present, and
  // that sentence would have been emitted word for word over an arm that
  // dispatched and merely landed nothing.
  const written = fs.readdirSync(out);
  assert.deepEqual(written.filter((f) => f.endsWith('.jsonl')), [],
    'NO run record reached the directory a verdict reads, which is the original guard');
  assert.equal(written.length, 1, 'and exactly 1 refusal artifact was published as evidence');
  assert.match(written[0], /^fleet-refusal-\d+\.json$/);

  const artifact = JSON.parse(fs.readFileSync(path.join(out, written[0]), 'utf8'));
  assert.equal(artifact.schema, 'bench-run-refusal/v1');
  assert.equal(artifact.status, 'REFUSED');
  assert.match(artifact.reason, /empty-roster/, 'the artifact carries the VERBATIM reason');
  assert.equal(artifact.reason, report.reason, 'and it is the same string, not a retyped one');
  assert.ok(Array.isArray(artifact.refused_checks) && artifact.refused_checks.length > 0,
    'naming which precondition refused');
});

test('the refused record is adapted at the reader with exactly 3 named fields and never as measured', () => {
  const corpus = scratchRoot('fleet-adapt');
  const stubs = scratchRoot('fleet-adapt-stub');
  const out = scratchRoot('fleet-adapt-out');
  writeSingleTask(corpus, 's1');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: false }),
        graph: writeStubGraph(stubs, 3),
      }),
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const adaptation = reportOf(run).adaptation;

  // FF-B280. The producer emits `{ ts, kind, run_id, graph_generation, phase }`
  // and the phase 22 validator requires 3 further fields, so an unadapted record
  // from a fully live successful run is refused with 3 codes at event 0. The
  // repair is at the READER and the validator is never widened: a validator that
  // accepts 2 shapes cannot tell a malformed record from a new one.
  assert.deepEqual(
    adaptation.fields_supplied.slice().sort(), ['arm', 'corpus_hash', 'provenance'],
    'exactly the 3 fields the validator requires and the producer does not write',
  );
  assert.deepEqual(
    adaptation.codes_before.slice().sort(),
    ['E_PR_ARM_UNKNOWN', 'E_PR_CORPUS_HASH_MISSING', 'E_PR_PROVENANCE_UNKNOWN'],
    'the unadapted record is refused with exactly those 3 codes',
  );
  assert.deepEqual(adaptation.codes_after, [], 'and the completed record validates clean');
  assert.equal(
    adaptation.provenance, 'unavailable',
    'a refused run is never labelled measured: measured is for a real dispatch alone',
  );
  assert.equal(adaptation.corpus_hash_source, 'run context', 'the hash comes from the context the arm already holds');
});

// ADDED AFTER THE MUTATION BATTERY. 2 mutants SURVIVED the first run and both
// survived for the same reason: no case drove the property. An unkilled mutant
// is indistinguishable from a guard that cannot fire, so the cases were written
// rather than the score accepted.

test('the recorded fleet intervals genuinely OVERLAP, so the width is measured and not constructed', () => {
  const corpus = scratchRoot('fleet-overlap');
  const stubs = scratchRoot('fleet-overlap-stub');
  const out = scratchRoot('fleet-overlap-out');
  for (const id of ['s1', 's2', 's3']) writeSingleTask(corpus, id);

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: true }),
        graph: writeStubGraph(stubs, 3),
      }),
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const events = readRecord(reportOf(run).records[0].path);

  const starts = kindsOf(events, 'worker_started');
  const ends = kindsOf(events, 'worker_ended');
  assert.ok(starts.length >= 2, 'the run opened at least 2 intervals at all');

  // THE PROPERTY, asserted directly on the instants rather than through the
  // folded number. Some interval must still be OPEN when another opens. A runner
  // that emitted every end after the whole batch was awaited would satisfy the
  // folded width of 2 while having run its children strictly one after another,
  // which is a recorded overlap that did not happen.
  const endBy = new Map(ends.map((e) => [String(e.node_id), e.ts]));
  const overlapping = starts.some((a) => starts.some((b) => {
    if (a.node_id === b.node_id) return false;
    const aEnd = endBy.get(String(a.node_id));
    return aEnd !== undefined && a.ts < b.ts && b.ts < aEnd;
  }));
  assert.equal(overlapping, true, 'at least 1 interval was still open when another opened');
});

test('a SLOW child closes its interval last, so the end order proves ends fire at child exit', () => {
  const corpus = scratchRoot('fleet-endorder');
  const stubs = scratchRoot('fleet-endorder-stub');
  const out = scratchRoot('fleet-endorder-out');
  for (const id of ['s1', 's2']) writeSingleTask(corpus, id);

  // `s1` is dispatched FIRST and finishes LAST. The 2 candidate implementations
  // are only distinguishable here: a runner closing intervals at child exit
  // reports s2 ending first, and a runner closing them all in batch order after
  // the await reports s1 ending first. With every child equally fast the 2
  // produce identical records and the claim would be unfalsifiable.
  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: {
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 2),
        }),
        FERROX_BENCH_SLOW_NODE: 's1',
      },
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const events = readRecord(reportOf(run).records[0].path);
  const starts = kindsOf(events, 'worker_started').map((e) => String(e.node_id));
  const ends = kindsOf(events, 'worker_ended').map((e) => String(e.node_id));

  assert.deepEqual(starts, ['s1', 's2'], 's1 was dispatched first');
  assert.deepEqual(
    ends, ['s2', 's1'],
    'and finished LAST. An end order equal to the start order would mean the ends were emitted in '
      + 'batch order after the await, which records the same overlap whether the children ran '
      + 'together or one after another',
  );
});

// ─── FF-B344: the ROLLING POOL, and the batch barrier it replaced ────────────
//
// THE DEFECT. `await Promise.all(batch)` started no node until EVERY node in the
// batch had finished, so a lane freed by a fast child sat empty until the
// slowest sibling exited. In the paid 23-05 fleet record 100.9 of the 218.3
// seconds spent at a demonstrated width of 1 were seconds in which at least 1
// node was ready to dispatch and no lane would take it.
//
// The 2 implementations are only distinguishable against UNEQUAL child
// durations, which is what FERROX_BENCH_SLOW_NODE supplies. With every child
// equally fast a barrier and a pool produce identical records and the claim
// would be unfalsifiable.

test('FF-B344: a freed lane REFILLS before the slow sibling exits, so the barrier is gone', () => {
  const corpus = scratchRoot('fleet-pool');
  const stubs = scratchRoot('fleet-pool-stub');
  const out = scratchRoot('fleet-pool-out');
  for (const id of ['s1', 's2', 's3']) writeSingleTask(corpus, id);

  // 3 nodes, 2 lanes. s1 dawdles, s2 is fast. A POOL refills s2's lane with s3
  // the instant s2 exits, so s3 opens its interval while s1 is still running. A
  // BARRIER cannot: s3 belongs to the next batch and the next batch cannot begin
  // until s1, the slowest member of the first, has finished.
  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: {
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 3),
        }),
        FERROX_BENCH_SLOW_NODE: 's1',
      },
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.attempted, 3, 'NON ZERO FIRST: all 3 nodes were built');

  const events = readRecord(record.path);
  const worker = events.filter((e) => e.kind === 'worker_started' || e.kind === 'worker_ended');
  const indexOf = (kind, node) => worker.findIndex((e) => e.kind === kind && e.node_id === node);

  const s3Start = indexOf('worker_started', 's3');
  const s1End = indexOf('worker_ended', 's1');
  const s2End = indexOf('worker_ended', 's2');
  assert.notEqual(s3Start, -1, 'NON ZERO FIRST: s3 opened an interval at all');
  assert.notEqual(s1End, -1);
  assert.notEqual(s2End, -1);

  assert.ok(
    s2End < s3Start,
    's3 is dispatched AFTER s2 frees its lane, which is what makes this a refill rather than a '
      + 'third lane opened beyond the cap',
  );
  assert.ok(
    s3Start < s1End,
    'and BEFORE the slow sibling exits. Under the batch barrier s3 could not start until s1 had '
      + 'finished, so this ordering is impossible for it to produce',
  );

  // THE SAME FACT AS A CLOCK COMPARISON, read off the record's own timestamps
  // rather than off its event order, because the 2 could disagree.
  const ts = (kind, node) => worker.find((e) => e.kind === kind && e.node_id === node).ts;
  assert.ok(
    ts('worker_started', 's3') < ts('worker_ended', 's1'),
    's3 genuinely overlaps s1 in wall clock',
  );

  // AND THE CAP STILL HOLDS. A pool that refilled without counting would open 3
  // intervals at once against 2 permitted lanes.
  assert.equal(record.dispatch_cap, 2);
  assert.equal(record.metrics.demonstrated_width.state, 'known');
  assert.equal(
    record.metrics.demonstrated_width.value, 2,
    'never 3: the pool refills a lane, it does not add one',
  );
});

test('FF-B344: the CONTROL, with no slow child the pool still opens exactly 2 lanes', () => {
  // The other direction. The case above turns on 1 unequal duration, so the same
  // corpus with equal durations is driven too: the cap is still 2 and every node
  // still builds, which shows the refill is not smuggling in extra concurrency.
  const corpus = scratchRoot('fleet-pool-ctl');
  const stubs = scratchRoot('fleet-pool-ctl-stub');
  const out = scratchRoot('fleet-pool-ctl-out');
  for (const id of ['s1', 's2', 's3']) writeSingleTask(corpus, id);

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: true }),
        graph: writeStubGraph(stubs, 3),
      }),
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.attempted, 3, 'NON ZERO FIRST: all 3 nodes were built');
  assert.equal(record.metrics.demonstrated_width.value, 2, 'exactly the 2 lanes it was allowed');
});

test('FF-B344: a REFUSAL stops the fill and DRAINS, so no interval is left open', () => {
  // The failure path is the one a pool can get wrong. Returning at the first
  // refusal would abandon the children still in flight: their `worker_started`
  // is already in the record and their exit handler would never run, so the
  // salvaged events would carry a start with no end. The loop stops opening
  // lanes and keeps racing until every open one has closed.
  const corpus = scratchRoot('b344-drain');
  const stubs = scratchRoot('b344-drain-loop');
  const out = scratchRoot('b344-drain-out');
  for (const id of ['t1', 't2', 't3', 't4']) writeSingleTask(corpus, id);
  const stub = writeStubAdapter('b344-drain');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'live', '--width', '2', '--out', out],
    {
      corpus,
      outerBoundMs: 90_000,
      env: {
        ...liveEnv(stub, {
          FERROX_STUB_MODE: 'late',
          FERROX_STUB_OK_TIMES: '2',
          FERROX_STUB_USD: '0.25',
          [LIVE_RETRY_DELAY]: '0',
        }),
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 4),
        }),
      },
    },
  );

  assert.notEqual(run.status, 0, 'a partial run reports a failure');
  const report = reportOf(run);
  assert.equal(report.status, 'PARTIAL');

  const partials = partialsIn(out);
  assert.equal(partials.length, 1, 'NON ZERO FIRST: exactly 1 partial artifact was salvaged');
  const artifact = partials[0].artifact;
  assert.equal(artifact.attempted, 2, 'the 2 candidates already paid for are IN the artifact');

  // EVERY INTERVAL THE RECORD OPENED IS CLOSED. Asserted as 2 counters and an
  // equality, never as a flag: a drain that skipped a lane would leave a start
  // with no end and the count would not match.
  const starts = artifact.events.filter((e) => e.kind === 'worker_started');
  const ends = artifact.events.filter((e) => e.kind === 'worker_ended');
  assert.ok(starts.length > 0, 'NON ZERO FIRST: intervals were opened');
  assert.equal(
    ends.length, starts.length,
    `every one of the ${starts.length} intervals the salvaged record opened was closed`,
  );
  const openedIds = starts.map((e) => e.attempt_id).sort();
  const closedIds = ends.map((e) => e.attempt_id).sort();
  assert.deepEqual(closedIds, openedIds, 'and they are closed under their OWN attempt ids');
});

test('a node the fleet builder cannot attempt emits NO worker event, exactly as on the serial arm', () => {
  const corpus = scratchRoot('fleet-unattempted');
  const stubs = scratchRoot('fleet-unattempted-stub');
  const out = scratchRoot('fleet-unattempted-out');
  writeSingleTask(corpus, 'built');
  // `absent` carries a spec and a gate but NO reference fixture, so the builder
  // has no input for it. NOT ATTEMPTED is a third outcome: never a pass, never a
  // failure, and excluded from every denominator.
  writeSingleTask(corpus, 'absent', { reference: false, mutant: false, shallow: false });

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'reference', '--width', '2', '--out', out],
    {
      corpus,
      env: fleetEnv(stubs, {
        entry: writeStubLoop(stubs, { dispatchAllowed: true }),
        graph: writeStubGraph(stubs, 3),
      }),
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.attempted, 1, 'exactly the 1 node the builder had an input for');
  assert.deepEqual(record.not_attempted_tasks, ['absent'], 'and the other is named');
  assert.equal(record.landed_tasks.includes('absent'), false, 'never counted as a task that passed');
  assert.equal(record.failed_tasks.includes('absent'), false, 'and never as one that failed');

  const events = readRecord(record.path);
  const touching = events.filter((e) => String(e.node_id) === 'absent');
  assert.deepEqual(touching, [], 'the unattempted node appears in NO event of any kind');
});

test('the fleet arm contains no harness isolation flag and names its worktree convention', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  // Phase 19 D8: bypassing Ferrox loses files_modified ownership, the merge gate
  // and the base guard, and going wide through a harness flag is how FF-B101 was
  // found at a cost of a worker branched 693 commits stale.
  for (const flag of ['--isolate', 'isolatedWorktree', 'CLAUDE_WORKTREE', 'harness-isolation']) {
    assert.equal(source.includes(flag), false, `the runner carries no ${flag}`);
  }
  assert.ok(source.includes('FERROX_BENCH_FLEET_ENTRY'), 'the dispatch entry point is a named seam');
});

// ─── the live adapter, every arm at ZERO AGENT SPEND ─────────────────────────
//
// NOTHING BELOW INVOKES A MODEL, and that is a property of the seams rather than
// of a promise. Every arm reaches the dispatch path through 1 of 3 doors:
//
//   1. `FERROX_BENCH_LIVE_BIN` replaces the shipped profile's HEAD with a stub
//      binary this file writes onto a scratch PATH. The argv TAIL stays the
//      engine's, so the whole path from identity resolution through argv
//      construction through spawn through candidate capture is exercised.
//   2. An identity outside the shipped dispatchable set is refused BEFORE
//      anything is spawned.
//   3. The provenance SELECTION seam is read through `--plan-only`, which
//      constructs the builder and dispatches nothing at all.
//
// No key is read, no network is reached, and the substituted head forces
// provenance `unavailable` so no arm here could be published as a real run.

/** The bare binary name the stub is installed under. `opts.bin` takes a NAME, never a path. */
const STUB_BIN_NAME = 'ferrox-bench-stub-adapter';

/**
 * The stub adapter body.
 *
 * It is the ONLY thing any arm in this file spawns in place of a model. It
 * records every invocation before it does anything else, because SIDE EFFECT
 * BEFORE VALIDATION is what lets the dispatch COUNTER be asserted as a number.
 */
const STUB_ADAPTER_SOURCE = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const argv = process.argv.slice(2);',
  'const w = process.env.FERROX_STUB_WITNESS;',
  "const mode = process.env.FERROX_STUB_MODE || 'ok';",
  '// The witness is written FIRST, so an invocation that then hangs or exits',
  '// non zero is still counted. A counter that only counts successes cannot see',
  '// a doubled dispatch whose second call failed.',
  "fs.appendFileSync(path.join(w, 'dispatch.log'), 'dispatch\\n');",
  "fs.appendFileSync(path.join(w, 'invocations.jsonl'), JSON.stringify({ pid: process.pid, argv }) + '\\n');",
  "if (mode === 'hang') {",
  "  fs.writeFileSync(path.join(w, 'hang.pid'), String(process.pid));",
  '  // A BACKSTOP, never the mechanism under test. The runner bound kills this',
  '  // long before 2 minutes; the backstop only stops a battery that removed the',
  '  // bound from leaking a process that outlives the suite.',
  '  setTimeout(() => process.exit(0), 120000);',
  '} else {',
  '  // FF-B301. `late` answers the first FERROX_STUB_OK_TIMES dispatches of the',
  '  // whole invocation and refuses every one after that. It is how the exact',
  '  // 23-05 shape is driven: a run that has ALREADY BOUGHT candidates and then',
  '  // meets a limit. The counter is the shared dispatch witness, so the cutover',
  '  // point is a number the case can compute rather than one the stub asserts.',
  "  if (mode === 'late') {",
  "    const all = fs.readFileSync(path.join(w, 'dispatch.log'), 'utf8')",
  "      .split(/\\r?\\n/).filter((l) => l !== '').length;",
  "    if (all > Number(process.env.FERROX_STUB_OK_TIMES || '1')) {",
  "      process.stderr.write('the stub adapter refused dispatch ' + all + '\\n');",
  '      process.exit(3);',
  '    }',
  '  }',
  '  // FF-B301. `flaky` refuses the first FERROX_STUB_FAIL_TIMES dispatches FOR',
  '  // THIS NODE and answers after that. It keys off the module named in the',
  '  // prompt, so a multi node corpus can make exactly 1 node flaky while every',
  '  // other node succeeds on its first attempt. The counter is the witness log',
  '  // already written above, which is why the count is a number rather than a',
  '  // flag the stub sets about itself.',
  "  if (mode === 'flaky') {",
  '    const pm = /MODULE TO WRITE: (.+)/.exec(argv[argv.length - 1]);',
  '    const tm = /TASK: (.+)/.exec(argv[argv.length - 1]);',
  "    const key = (tm === null ? 'none' : tm[1].trim()) + '/' + (pm === null ? 'single' : pm[1].trim());",
  "    const target = process.env.FERROX_STUB_FAIL_NODE || '';",
  "    if (target === '' || key === target) {",
  "      const counter = path.join(w, 'flaky-' + key.replace(/[^A-Za-z0-9]/g, '_') + '.log');",
  "      fs.appendFileSync(counter, 'x\\n');",
  "      const seen = fs.readFileSync(counter, 'utf8').split(/\\r?\\n/).filter((l) => l !== '').length;",
  "      if (seen <= Number(process.env.FERROX_STUB_FAIL_TIMES || '1')) {",
  "        process.stderr.write('the stub adapter refused attempt ' + seen + '\\n');",
  '        process.exit(3);',
  '      }',
  '    }',
  '  }',
  "  if (mode === 'nonzero') { process.stderr.write('the stub adapter refused\\n'); process.exit(3); }",
  "  if (mode === 'empty') { process.exit(0); }",
  "  if (mode === 'slow') {",
  '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,',
  "      Number(process.env.FERROX_STUB_SLEEP_MS || '150'));",
  '  }',
  '  const prompt = argv[argv.length - 1];',
  '  const m = /MODULE TO WRITE: (.+)/.exec(prompt);',
  "  const mod = m === null ? 'single' : m[1].trim();",
  "  let out = '# ALPHA BETA GAMMA DELTA EPSILON\\n# BUILT ' + mod + '\\nVALUE = 1\\n';",
  "  if (process.env.FERROX_STUB_USD) {",
  "    out += JSON.stringify({ total_cost_usd: Number(process.env.FERROX_STUB_USD) }) + '\\n';",
  '  }',
  '  process.stdout.write(out);',
  '}',
  '',
].join('\n');

/**
 * Install the stub adapter on a scratch PATH and return its seams.
 *
 * The wrapper is a `#!/bin/sh` script that `exec`s node, which is the pattern
 * `tests/fleet-land-proof.test.cjs` already uses for a substituted adapter
 * binary. `$0` is recorded so a case can prove the SUBSTITUTED head is what ran
 * rather than a real adapter that happened to be installed.
 */
function writeStubAdapter(tag) {
  const root = scratchRoot(`stub-${tag}`);
  const bin = path.join(root, 'bin');
  const witness = path.join(root, 'witness');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(witness, { recursive: true });
  const helper = path.join(root, 'stub-adapter.cjs');
  writeFile(helper, STUB_ADAPTER_SOURCE);
  const wrapper = path.join(bin, STUB_BIN_NAME);
  fs.writeFileSync(wrapper, [
    '#!/bin/sh',
    'printf "%s\\n" "$0" >> "$FERROX_STUB_WITNESS/argv0.log"',
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(helper)} "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(wrapper, 0o755);
  return { bin, witness, root };
}

/** The env that reaches the adapter path through the substituted head. */
function liveEnv(stub, extra) {
  return {
    [LIVE_OPT_IN]: '1',
    [LIVE_ADAPTER]: 'claude',
    [LIVE_BIN]: STUB_BIN_NAME,
    PATH: `${stub.bin}${path.delimiter}${process.env.PATH}`,
    FERROX_STUB_WITNESS: stub.witness,
    ...(extra || {}),
  };
}

function witnessLines(stub, name) {
  const file = path.join(stub.witness, name);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
}

/** The dispatch COUNTER. A number, never a flag. */
function dispatchCount(stub) {
  return witnessLines(stub, 'dispatch.log').length;
}

function invocations(stub) {
  return witnessLines(stub, 'invocations.jsonl').map((l) => JSON.parse(l));
}

/** Every prompt the adapter was handed, which is always the FINAL argv element. */
function promptsOf(stub) {
  return invocations(stub).map((i) => i.argv[i.argv.length - 1]);
}

// ─── task 1: the opt in is STILL an opt in ───────────────────────────────────

test('a TRUTHY but non literal opt in still SKIPS, so building the adapter did not make live the default', () => {
  // Plan 22-06 mutant 10, kept alive rather than weakened. `true` is truthy in
  // every language this repository speaks, and a builder that accepted it would
  // make a real model call reachable by an accident of spelling.
  const corpus = scratchRoot('live-truthy');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-truthy-out');
  const stub = writeStubAdapter('truthy');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: { ...liveEnv(stub), [LIVE_OPT_IN]: 'true' } },
  );

  assert.equal(run.status, 0, 'a skip is never a failure');
  assert.match(`${run.stdout}${run.stderr}`, /SKIPPED/, 'the truthy value took the SKIP path');
  assert.deepEqual(fs.readdirSync(out), [], 'no record was written');
  assert.equal(dispatchCount(stub), 0, 'and the adapter was dispatched EXACTLY 0 times');
});

test('the SKIP sentence is ABSENT over a world where a dispatch DID happen, D8a both directions', () => {
  // A mutation battery cannot detect a false SENTENCE. The skip sentence states
  // that no model endpoint was contacted and no key was read, and it would be
  // emitted word for word over a run that dispatched. So it is rendered over the
  // world where it is FALSE and asserted ABSENT.
  const corpus = scratchRoot('d8a-skip');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('d8a-skip-out');
  const stub = writeStubAdapter('d8a-skip');

  const dispatched = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(dispatched.status, 0, dispatched.stderr);
  assert.ok(dispatchCount(stub) > 0, 'NON ZERO FIRST: a dispatch genuinely happened in this world');
  const dispatchedText = `${dispatched.stdout}${dispatched.stderr}`;
  assert.doesNotMatch(dispatchedText, /SKIPPED/, 'the skip status is absent over a run that dispatched');
  assert.doesNotMatch(
    dispatchedText, /No model endpoint was contacted/,
    'and so is the sentence claiming no endpoint was contacted',
  );

  // The TRUE direction, because a sentence that never appears is not a guard.
  const skipped = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', scratchRoot('d8a-skip-out2')],
    { corpus },
  );
  assert.equal(skipped.status, 0);
  assert.match(
    `${skipped.stdout}${skipped.stderr}`, /No model endpoint was contacted/,
    'over the world where it IS true the sentence is present',
  );
});

// ─── task 1: the 2 narrower refusals that replaced the endpoint one ───────────

test('the opt in at the literal 1 with NO adapter identity refuses by code and writes nothing', () => {
  const corpus = scratchRoot('live-unset');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-unset-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: { [LIVE_OPT_IN]: '1' } },
  );

  assert.notEqual(run.status, 0, 'the non skip branch reports a failure rather than a silent pass');
  const combined = `${run.stdout}${run.stderr}`;
  assert.doesNotMatch(combined, /SKIPPED/, 'this arm did NOT take the skip path');
  assert.match(combined, /E_BR_LIVE_ADAPTER_UNSET/, 'it carries the narrower builder error code');
  assert.match(combined, new RegExp(LIVE_ADAPTER), 'and it names the variable that would fix it');
  assert.deepEqual(fs.readdirSync(out), [], 'and it wrote no record');
});

test('kimi is refused BY NAME as not dispatchable, with the set read from the shipped library', () => {
  // FF-B225 holding STRUCTURALLY rather than by comment: `kimi` appears in
  // neither the engine's PROFILES nor the shipped ADAPTER_PROFILES, so
  // `isDispatchable` is already false for it. This case asserts that rather than
  // trusting it, and reads the dispatchable set out of the library at RUNTIME so
  // a transcription here could not drift from the engine.
  assert.equal(PROBE.isDispatchable('kimi'), false, 'the shipped library already refuses kimi');
  const dispatchable = Object.keys(PROBE.ADAPTER_PROFILES);
  assert.ok(dispatchable.length > 0, 'NON ZERO FIRST: the dispatchable set is not empty');

  const corpus = scratchRoot('live-kimi');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-kimi-out');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: { [LIVE_OPT_IN]: '1', [LIVE_ADAPTER]: 'kimi' } },
  );

  assert.notEqual(run.status, 0);
  const combined = `${run.stdout}${run.stderr}`;
  assert.match(combined, /E_BR_LIVE_ADAPTER_UNKNOWN/, 'the unknown identity refusal fired');
  assert.match(combined, /kimi/, 'the message NAMES the identity that was refused');
  for (const id of dispatchable) {
    assert.ok(
      combined.includes(id),
      `the message names ${id}, so an operator sees the dispatchable set rather than guessing it`,
    );
  }
  assert.deepEqual(fs.readdirSync(out), [], 'and it wrote no record');
});

test('the unknown adapter message is ABSENT over an identity that IS dispatchable, D8a both directions', () => {
  const corpus = scratchRoot('d8a-unknown');
  writeSingleTask(corpus, 'solo');
  const stub = writeStubAdapter('d8a-unknown');

  const ok = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', scratchRoot('d8a-unknown-out')],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(dispatchCount(stub) > 0, 'NON ZERO FIRST: this world really did dispatch');
  const text = `${ok.stdout}${ok.stderr}`;
  assert.doesNotMatch(text, /E_BR_LIVE_ADAPTER_UNKNOWN/, 'the refusal code does not appear');
  assert.doesNotMatch(
    text, /The dispatchable set is/,
    'and neither does the sentence that names the dispatchable set',
  );
});

// ─── task 1: the argv is the SHIPPED profile's, not a transcription ───────────

test('the spawned argv equals buildProbeInvocation called directly, with the prompt LAST', () => {
  const corpus = scratchRoot('live-argv');
  writeSingleTask(corpus, 'solo');
  const stub = writeStubAdapter('argv');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', scratchRoot('live-argv-out')],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(run.status, 0, run.stderr);

  const seen = invocations(stub);
  assert.equal(seen.length, 1, 'NON ZERO FIRST: exactly 1 invocation to compare');
  const prompt = seen[0].argv[seen[0].argv.length - 1];

  const direct = PROBE.buildProbeInvocation('claude', prompt, { bin: STUB_BIN_NAME });
  assert.deepEqual(
    seen[0].argv, direct.args,
    'the argv the runner spawned is the shipped profile tail, compared against the library called directly',
  );
  assert.equal(direct.bin, STUB_BIN_NAME, 'and opts.bin replaced the profile HEAD only');
  assert.equal(
    seen[0].argv[seen[0].argv.length - 1], prompt,
    'the prompt is the FINAL element, which is the shape the vendored engine uses',
  );
  assert.ok(seen[0].argv.length > 1, 'the tail is not empty, so this is a real comparison');

  const argv0 = witnessLines(stub, 'argv0.log');
  assert.equal(argv0.length, 1, 'the substituted head ran exactly once');
  assert.equal(
    path.basename(argv0[0]), STUB_BIN_NAME,
    'and what ran was the SUBSTITUTED binary, never a real adapter that happened to be installed',
  );
});

test('the adapter is spawned with an argv ARRAY and no shell appears on the path', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /shell:\s*true/, 'no spawn in this runner enables a shell');
  assert.equal(source.includes('execSync('), false, 'and no shell executing helper is used');
  assert.ok(
    source.includes('shell: false'),
    'the live dispatch states shell false explicitly, so an operator supplied identity cannot reach a shell',
  );
  assert.ok(
    source.includes('buildProbeInvocation'),
    'the invocation comes from the shipped library rather than a string this file composed',
  );
});

// ─── task 1: the 2 dispatch refusals, each driven where the condition IS present

test('a hung adapter hits the bounded timeout, the refusal names the bound, and the stub is DEAD', () => {
  const corpus = scratchRoot('live-hang');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-hang-out');
  const stub = writeStubAdapter('hang');

  // The case carries its OWN outer bound on the whole child, so a battery that
  // removes the runner's bound cannot hang the suite: the child is killed and
  // this case fails on the absent refusal instead.
  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    {
      corpus,
      outerBoundMs: 20_000,
      // FF-B301. The retry policy is PINNED TO 0 here so this case keeps its own
      // subject, which is the BOUND and the dead process, and does not become a
      // second reading of the retry default. Under the default this adapter is
      // dispatched 3 times, and that IS asserted, with its own counter, by
      // `a RETRYABLE timeout is retried to the bound` below.
      env: liveEnv(stub, { FERROX_STUB_MODE: 'hang', [LIVE_TIMEOUT]: '1500', [LIVE_RETRIES]: '0' }),
    },
  );

  assert.notEqual(run.status, 0, 'a hung adapter is a builder failure');
  const combined = `${run.stdout}${run.stderr}`;
  assert.match(combined, /E_BR_LIVE_TIMEOUT/, 'the timeout refusal fired');
  assert.match(combined, /1500/, 'and it NAMES the bound, so an operator sees the number');
  assert.deepEqual(fs.readdirSync(out), [], 'no record was written');
  assert.equal(dispatchCount(stub), 1, 'the adapter was reached exactly once, so this measures a real hang');

  const pid = Number(witnessLines(stub, 'hang.pid')[0]);
  assert.ok(Number.isFinite(pid) && pid > 0, 'the stub recorded its own pid');
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, 'the hung process is DEAD: a bound that does not kill is not a bound');
});

test('an adapter that exits non zero is a BUILDER failure and is never recorded as a score of 0', () => {
  const corpus = scratchRoot('live-nonzero');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-nonzero-out');
  const stub = writeStubAdapter('nonzero');

  // FF-B301. The DELAY is pinned to 0 so this case stays fast. The RETRY COUNT
  // is left at the shipped default deliberately, so the number asserted below is
  // the number a real run produces rather than one this case arranged.
  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub, { FERROX_STUB_MODE: 'nonzero', [LIVE_RETRY_DELAY]: '0' }) },
  );

  assert.equal(
    dispatchCount(stub), DEFAULT_LIVE_ATTEMPTS,
    `NON ZERO FIRST: the adapter really was reached, ${DEFAULT_LIVE_ATTEMPTS} times, which is the `
      + 'shipped default of 2 retries plus the first attempt',
  );
  assert.notEqual(run.status, 0);
  const combined = `${run.stdout}${run.stderr}`;
  assert.match(combined, /E_BR_LIVE_DISPATCH_FAILED/, 'the dispatch failure refusal fired');
  assert.doesNotMatch(combined, /gate: 0\//, 'an adapter that refused is not a score of 0');
  assert.deepEqual(
    fs.readdirSync(out), [],
    'and nothing was recorded at all: 0 nodes were built, so 0 candidates were lost and there is '
      + 'nothing for a partial artifact to salvage',
  );
});

test('an adapter that answers NOTHING is the same refusal, because it built nothing', () => {
  const corpus = scratchRoot('live-empty');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-empty-out');
  const stub = writeStubAdapter('empty');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub, { FERROX_STUB_MODE: 'empty', [LIVE_RETRY_DELAY]: '0' }) },
  );

  assert.equal(
    dispatchCount(stub), DEFAULT_LIVE_ATTEMPTS,
    'NON ZERO FIRST: the adapter really was reached and exited 0, once per permitted attempt',
  );
  assert.notEqual(run.status, 0);
  assert.match(`${run.stdout}${run.stderr}`, /E_BR_LIVE_DISPATCH_FAILED/);
  assert.deepEqual(fs.readdirSync(out), [], 'no record, and no score of 0');
});

// ─── task 1: the dispatch COUNTER, FF-B268 closed for the live lane ───────────

test('the FLEET arm dispatches EXACTLY once per node, so a preview pass cannot double the spend', () => {
  // FF-B268: the fleet arm asks the builder twice per node, once as `preview` in
  // the parent and once in the build child. For a replay builder that is 2 file
  // reads. For a LIVE builder it is 2 model calls and a real doubling of the
  // budget plan 04 pays, so the live `preview` must dispatch nothing and it is
  // asserted with a NUMBER rather than by reading the code.
  const corpus = scratchRoot('live-count');
  const stubs = scratchRoot('live-count-loop');
  const out = scratchRoot('live-count-out');
  for (const id of ['s1', 's2', 's3']) writeSingleTask(corpus, id);
  const stub = writeStubAdapter('count');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'live', '--width', '2', '--out', out],
    {
      corpus,
      env: {
        ...liveEnv(stub),
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 3),
        }),
      },
    },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.attempted, 3, 'NON ZERO FIRST: the node count is 3, asserted before any ratio');
  assert.equal(
    dispatchCount(stub), 3,
    'EXACTLY 1 dispatch per node. Not at most, not truthy: a preview that dispatched would report 6',
  );
});

test('the SERIAL arm dispatches exactly once per node too, so the 2 arms buy the same work', () => {
  const corpus = scratchRoot('live-count-serial');
  const out = scratchRoot('live-count-serial-out');
  for (const id of ['s1', 's2', 's3']) writeSingleTask(corpus, id);
  const stub = writeStubAdapter('count-serial');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'across-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub) },
  );

  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.attempted, 3, 'NON ZERO FIRST');
  assert.equal(dispatchCount(stub), 3, 'exactly 1 dispatch per node');
});

// ─── task 2: provenance, and the guard that stops a rehearsal being published ──

test('THE REQUIRED FAILING ARM: a run through a SUBSTITUTED head is unavailable and NEVER measured', () => {
  // This is the most load bearing case in the file. A zero spend rehearsal that
  // could report `measured` would let the entire published A/B be a rehearsal
  // wearing a real label, which is this phase's own defect class.
  const corpus = scratchRoot('live-prov-sub');
  writeSingleTask(corpus, 'solo');
  writeMultiTask(corpus, 'widget');
  const out = scratchRoot('live-prov-sub-out');
  const stub = writeStubAdapter('prov-sub');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  assert.equal(record.attempted, 5, 'NON ZERO FIRST: 1 single node plus 4 modules were genuinely built');

  const events = readRecord(record.path);
  const started = kindsOf(events, 'worker_started');
  assert.equal(started.length, 5, 'and every one of them opened a worker interval');
  for (const e of started) {
    assert.equal(e.provenance, 'unavailable', `${e.node_id} is unavailable, because the head was substituted`);
    assert.notEqual(e.provenance, 'measured', `${e.node_id} is NOT measured: nothing measured an agent here`);
  }
  const runStarted = kindsOf(events, 'run_started')[0];
  assert.equal(runStarted.provenance, 'unavailable', 'and the run declares itself unavailable too');
});

test('THE POSITIVE CONTROL: no substitution and a dispatchable identity chooses measured', () => {
  // Driven at the provenance SELECTION seam through `--plan-only`, which
  // constructs the builder and dispatches NOTHING, so the guard is proven not to
  // be the degenerate one that makes everything `unavailable` without spending a
  // single token to prove it.
  const corpus = scratchRoot('live-prov-pos');
  writeSingleTask(corpus, 'solo');

  const report = reportOf(runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--plan-only'],
    { corpus, env: { [LIVE_OPT_IN]: '1', [LIVE_ADAPTER]: 'claude' } },
  ));

  assert.equal(report.provenance, 'measured', 'a real head plus a dispatchable identity IS measured');
  assert.equal(report.live.adapter, 'claude');
  assert.equal(report.live.substituted, false, 'and nothing was substituted');
});

test('the identity mock yields unavailable even with NO substitution, because echo is not an implementation', () => {
  const corpus = scratchRoot('live-prov-mock');
  writeSingleTask(corpus, 'solo');

  const report = reportOf(runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--plan-only'],
    { corpus, env: { [LIVE_OPT_IN]: '1', [LIVE_ADAPTER]: 'mock' } },
  ));

  assert.equal(report.live.substituted, false, 'the head was NOT substituted, so this is the identity alone');
  assert.equal(
    report.provenance, 'unavailable',
    'the engine maps mock to echo, and a candidate that echoes the prompt IS the prompt',
  );
  assert.notEqual(report.provenance, 'measured');
});

test('PROVENANCES holds exactly 3 values read from the library, and this runner introduces no fourth', () => {
  assert.deepEqual(
    FOLD.PROVENANCES.slice().sort(), ['measured', 'replayed', 'unavailable'],
    'the shipped set, read at runtime rather than transcribed',
  );
  assert.equal(FOLD.PROVENANCES.length, 3, 'exactly 3 before and after this plan');

  const source = fs.readFileSync(SCRIPT, 'utf8');
  const declared = [...source.matchAll(/^const PROVENANCE_[A-Z]+ = '([a-z]+)';$/gm)].map((m) => m[1]);
  assert.ok(declared.length > 0, 'NON ZERO FIRST: the runner declares its provenance vocabulary in one place');
  assert.equal(declared.length, 3, 'and it declares exactly 3, so a fourth would be visible here');
  for (const value of declared) {
    assert.ok(FOLD.PROVENANCES.includes(value), `${value} is a MEMBER of the shipped set, never an addition`);
  }
});

// ─── task 2: the identity is readable OUT OF THE RECORD ──────────────────────

test('every worker_started carries the adapter IDENTITY, and the run used EXACTLY 1 of them', () => {
  // Plan 05 must assert that its 2 arms dispatched to the SAME adapter, because
  // a serial arm on 1 model against a fleet arm on another confounds model speed
  // with concurrency. It can only assert that if this field exists.
  const corpus = scratchRoot('live-identity');
  writeSingleTask(corpus, 'solo');
  writeMultiTask(corpus, 'widget');
  const out = scratchRoot('live-identity-out');
  const stub = writeStubAdapter('identity');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub, { [LIVE_ADAPTER]: 'codex' }) },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.attempted, 5, 'NON ZERO FIRST');

  const started = kindsOf(readRecord(record.path), 'worker_started');
  assert.equal(started.length, 5, 'and 5 intervals were opened');
  const identities = new Set(started.map((e) => String(e.lane).split(':')[0]));
  assert.deepEqual([...identities], ['codex'], 'every record names the identity that produced it');
  assert.equal(identities.size, 1, 'the distinct identity set over the run has size EXACTLY 1');
});

test('a record produced through a SUBSTITUTED head states BOTH the identity and the substitution', () => {
  const corpus = scratchRoot('live-sub-lane');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-sub-lane-out');
  const stub = writeStubAdapter('sub-lane');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub, { [LIVE_ADAPTER]: 'gemini' }) },
  );
  assert.equal(run.status, 0, run.stderr);
  const started = kindsOf(readRecord(reportOf(run).records[0].path), 'worker_started');
  assert.ok(started.length > 0, 'NON ZERO FIRST');
  for (const e of started) {
    assert.equal(
      e.lane, 'gemini:substituted',
      'a reader can tell a rehearsal from a real dispatch WITHOUT consulting anything outside the record',
    );
  }
});

test('any sentence calling the run a live agent measurement is ABSENT over a rehearsal, D8a both directions', () => {
  const corpus = scratchRoot('d8a-measured');
  writeSingleTask(corpus, 'solo');
  const stub = writeStubAdapter('d8a-measured');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', scratchRoot('d8a-measured-out')],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(run.status, 0, run.stderr);
  const report = reportOf(run);
  const record = report.records[0];
  assert.ok(record.attempted > 0, 'NON ZERO FIRST: this world really did build something');

  const rendered = JSON.stringify(report);
  assert.equal(
    rendered.includes('"provenance":"measured"'), false,
    'nothing in the rendered report calls this rehearsal a measured agent run',
  );
  assert.equal(record.provenance, 'unavailable', 'the report row says so in the field a reader reads');

  // The TRUE direction, at the selection seam and still at zero spend.
  const real = reportOf(runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--plan-only'],
    { corpus, env: { [LIVE_OPT_IN]: '1', [LIVE_ADAPTER]: 'claude' } },
  ));
  assert.equal(
    JSON.stringify(real).includes('"provenance":"measured"'), true,
    'over a world where a real head WOULD be dispatched, the measured claim IS rendered',
  );
});

// ─── task 2: duration is MEASURED, spend is carried or UNKNOWN ───────────────

test('durationMs is a measured positive number on every build and is at least the interval the stub slept', () => {
  const corpus = scratchRoot('live-duration');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-duration-out');
  const stub = writeStubAdapter('duration');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub, { FERROX_STUB_MODE: 'slow', FERROX_STUB_SLEEP_MS: '150' }) },
  );
  assert.equal(run.status, 0, run.stderr);

  const ended = kindsOf(readRecord(reportOf(run).records[0].path), 'worker_ended');
  assert.ok(ended.length > 0, 'NON ZERO FIRST');
  for (const e of ended) {
    assert.equal(typeof e.recorded_runtime_ms, 'number', 'the duration is a number, never null, on a successful build');
    assert.ok(e.recorded_runtime_ms > 0, 'and it is positive');
    assert.ok(
      e.recorded_runtime_ms >= 150,
      `the recorded ${e.recorded_runtime_ms} ms is at least the 150 ms the stub slept, so it is MEASURED`,
    );
  }
});

test('an adapter reporting NO spend yields UNKNOWN, and the recorded value is NOT 0', () => {
  // A rate of 0 and a rate nobody measured are different claims, and this
  // apparatus exists to keep them apart. No per call cost is machine reported on
  // the pinned argv, so this is the case that holds in practice.
  const corpus = scratchRoot('live-usd-none');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-usd-none-out');
  const stub = writeStubAdapter('usd-none');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  const ended = kindsOf(readRecord(record.path), 'worker_ended');
  assert.ok(ended.length > 0, 'NON ZERO FIRST');
  for (const e of ended) {
    assert.equal(e.usd, null, 'the adapter reported no spend, so the record carries null');
    assert.notEqual(e.usd, 0, 'and it is NOT a fabricated measured 0');
  }
  assert.notEqual(
    record.metrics.cost_per_landed_increment.state, 'known',
    'so the metric stays undefined rather than publishing a rate nobody measured',
  );
});

test('an adapter that DOES report a spend carries it through unchanged', () => {
  const corpus = scratchRoot('live-usd-some');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-usd-some-out');
  const stub = writeStubAdapter('usd-some');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub, { FERROX_STUB_USD: '0.0125' }) },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];

  const ended = kindsOf(readRecord(record.path), 'worker_ended');
  assert.equal(ended.length, 1, 'NON ZERO FIRST');
  assert.equal(ended[0].usd, 0.0125, 'the reported figure rides out unchanged');
  assert.equal(record.metrics.cost_per_landed_increment.state, 'known', 'and the metric is a real number');
});

test('the cost report line is stripped from the candidate, so a spend marker never becomes source', () => {
  const corpus = scratchRoot('live-usd-strip');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('live-usd-strip-out');
  const stub = writeStubAdapter('usd-strip');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub, { FERROX_STUB_USD: '0.0125' }) },
  );
  assert.equal(run.status, 0, run.stderr);
  const record = reportOf(run).records[0];
  assert.equal(record.landed_tasks.includes('solo'), true, 'the candidate still scores and lands');
});

// ─── task 2: the dependency context a downstream module receives ─────────────

test('a downstream module is shown its declared dependencies BUILT SOURCE, with the seam as the control', () => {
  // Without this a multi module task is 4 independent single file tasks wearing
  // 1 task name, the seam is decorative, and the corpus flatters a fleet by
  // construction. CONTEXT D6 names that failure mode and rules it out.
  const corpus = scratchRoot('live-deps');
  writeMultiTask(corpus, 'widget');
  const out = scratchRoot('live-deps-out');
  const stub = writeStubAdapter('deps');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(reportOf(run).records[0].attempted, 4, 'NON ZERO FIRST: all 4 modules were built');

  const prompts = promptsOf(stub);
  assert.equal(prompts.length, 4, 'and 4 prompts were handed to the adapter');
  const forModule = (mod) => {
    const hit = prompts.filter((p) => p.includes(`MODULE TO WRITE: ${mod}`));
    assert.equal(hit.length, 1, `exactly 1 prompt named ${mod}`);
    return hit[0];
  };

  // The stub writes a per module marker into every candidate it produces, so the
  // seam's BUILT SOURCE is identifiable inside a later prompt by containment.
  assert.ok(
    forModule('d.py').includes('# BUILT a.py'),
    'the integrator is shown the SEAM MODULE IT WAS BUILT, not merely told the edge exists',
  );
  assert.ok(forModule('d.py').includes('# BUILT b.py'), 'and every other declared dependency too');
  assert.ok(forModule('d.py').includes('# BUILT c.py'));
  assert.equal(
    forModule('a.py').includes('# BUILT a.py'), false,
    'THE CONTROL: the seam has no dependency, so its own prompt carries no built source at all',
  );
});

test('a dependency that was NOT built is NAMED as not built rather than silently omitted', () => {
  // A prompt that quietly drops a missing dependency asks the agent to INVENT
  // the seam, and 2 agents inventing 2 different seams is not a coordination
  // measurement.
  const corpus = scratchRoot('live-deps-missing');
  writeMultiTask(corpus, 'widget', { extraEdges: [['d.py', 'absent.py']] });
  const out = scratchRoot('live-deps-missing-out');
  const stub = writeStubAdapter('deps-missing');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(reportOf(run).records[0].attempted, 4, 'NON ZERO FIRST');

  const prompts = promptsOf(stub);
  const integrator = prompts.filter((p) => p.includes('MODULE TO WRITE: d.py'));
  assert.equal(integrator.length, 1);
  assert.ok(
    integrator[0].includes('absent.py'),
    'the withheld dependency is NAMED, so the omission is detectable by a reader',
  );
  assert.ok(
    integrator[0].includes('WAS NOT BUILT'),
    'and it is stated as not built rather than left to be inferred from an absence',
  );
});

// ─── FF-B301: the bounded retry and the partial record ───────────────────────
//
// THE DEFECT. A single failed dispatch aborted the entire live run. 1 transient
// adapter refusal, rate limit or timeout on the last node of a 20 node run
// discarded every candidate already paid for and wrote no record at all. That is
// correct for a REPLAY builder, where a failure is deterministic and free to
// retry, and it is expensive for a LIVE one.
//
// WHAT IS UNDER LOCK BELOW, and why each one is a counter rather than a flag:
//
//   - THE RETRY GENUINELY RE DISPATCHES. A flag saying a retry happened passes
//     for an implementation that REPORTS a retry and does not retry, so every
//     case here asserts the DISPATCH COUNT the stub adapter recorded for itself.
//   - THE ATTEMPT COUNT TRAVELS WITH THE RECORD. A node that succeeded on
//     attempt 2 is not the same datum as one that succeeded on attempt 1, and
//     the record says which through `attempt_id`.
//   - THE WALL CLOCK IS NOT SUMMED. A failed attempt records an UNKNOWN spend
//     and an UNKNOWN runtime, never a 0 and never a total.
//   - THE REPLAY BUILDER IS UNCHANGED, and that is enforced by a REFUSAL driven
//     through the real CLI against a world where the policy IS present.
//   - A PARTIAL CANNOT READ AS COMPLETE. 3 structural guards, and the one that
//     matters most is COMPUTED by the shipped validator rather than asserted.
//
// ZERO AGENT SPEND. Every arm reaches the dispatch path through the substituted
// head on a scratch PATH, which forces provenance `unavailable`. No key is read,
// no network is reached and no model is invoked.

/** The partial artifacts a run left behind, parsed. A `.json`, never a `.jsonl`. */
function partialsIn(dir) {
  return fs.readdirSync(dir)
    .filter((n) => n.startsWith('bench-partial-') && n.endsWith('.json'))
    .sort()
    .map((n) => ({ name: n, artifact: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }));
}

function recordsIn(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort();
}

/** Every worker event for 1 node, in record order. */
function workerEventsFor(events, nodeId) {
  return events.filter(
    (e) => (e.kind === 'worker_started' || e.kind === 'worker_ended') && e.node_id === nodeId,
  );
}

test('a RETRYABLE refusal is RE DISPATCHED and the run then succeeds, asserted by the dispatch COUNT', () => {
  // The whole defect in 1 case. The adapter refuses the first dispatch and
  // answers the second. Before FF-B301 this run aborted with no record at all.
  const corpus = scratchRoot('b301-retry');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('b301-retry-out');
  const stub = writeStubAdapter('b301-retry');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    {
      corpus,
      env: liveEnv(stub, {
        FERROX_STUB_MODE: 'flaky',
        FERROX_STUB_FAIL_TIMES: '1',
        [LIVE_RETRY_DELAY]: '0',
      }),
    },
  );

  assert.equal(run.status, 0, `the retried run completed. stderr: ${run.stderr}`);
  // A COUNTER, NEVER A FLAG. 2 is the number that separates a real re dispatch
  // from a report of one: an implementation that logged a retry without making
  // it would leave this at 1 and would still print everything else below.
  assert.equal(dispatchCount(stub), 2, 'the adapter was reached EXACTLY twice: 1 refusal, 1 answer');

  const report = reportOf(run);
  assert.equal(report.status, 'ok', 'a run that recovered inside its bound is a COMPLETE run');
  assert.equal(report.records.length, 1, 'NON ZERO FIRST: there is a record to assert over');
  assert.equal(report.records[0].attempted, 1, 'and it built the node');

  const events = readRecord(report.records[0].path);
  const worker = workerEventsFor(events, 'solo');
  assert.equal(worker.length, 4, 'exactly 2 intervals: the refused attempt and the answered one');

  const failed = worker.filter((e) => e.kind === 'worker_ended' && e.outcome === 'failed');
  const completed = worker.filter((e) => e.kind === 'worker_ended' && e.outcome === 'completed');
  assert.equal(failed.length, 1, 'the refused attempt CLOSED its interval rather than dangling');
  assert.equal(completed.length, 1, 'and exactly 1 attempt produced a candidate');

  // THE ATTEMPT COUNT TRAVELS WITH THE RECORD. A node that succeeded on attempt
  // 2 is not the datum a node that succeeded on attempt 1 is.
  assert.equal(failed[0].attempt_id, 'solo#1', 'the refusal is labelled attempt 1');
  assert.equal(completed[0].attempt_id, 'solo#2', 'and the candidate is labelled attempt 2, NOT 1');

  // THE WALL CLOCK IS NOT SUMMED, and the spend is not fabricated.
  assert.equal(failed[0].usd, null, 'a dispatch that did not answer bought nothing. UNKNOWN, never 0');
  assert.equal(failed[0].recorded_runtime_ms, null, 'and it measured no build time. UNKNOWN, never 0');
  assert.ok(
    completed[0].recorded_runtime_ms > 0,
    'the answered attempt carries its OWN measured duration',
  );

  // Every later event for this node keys to the attempt that actually built it,
  // so a gate result is never filed against an attempt that produced nothing.
  const land = events.filter((e) => e.kind === 'land_completed' && e.node_id === 'solo');
  assert.equal(land.length, 1, 'NON ZERO FIRST: the node landed');
  assert.equal(land[0].attempt_id, 'solo#2', 'and its land result keys to attempt 2');
});

test('the retry is BOUNDED and the bound TRACKS the configured policy rather than a constant', () => {
  // A retry with no bound is an unbounded loop wearing a recovery costume, and
  // it would spend an authorized budget 1 refused dispatch at a time. The bound
  // is driven at 2 DIFFERENT values, because a single value is satisfied by a
  // hard coded constant that happens to match.
  const corpus = scratchRoot('b301-bound');
  writeSingleTask(corpus, 'solo');
  const stubs = [];

  for (const [retries, expected] of [['0', 1], ['4', 5]]) {
    const stub = writeStubAdapter(`b301-bound-${retries}`);
    stubs.push(stub);
    const run = runScript(
      ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', scratchRoot(`b301-bound-out-${retries}`)],
      {
        corpus,
        outerBoundMs: 60_000,
        env: liveEnv(stub, {
          FERROX_STUB_MODE: 'nonzero',
          [LIVE_RETRIES]: retries,
          [LIVE_RETRY_DELAY]: '0',
        }),
      },
    );
    assert.notEqual(run.status, 0, 'an adapter that never answers is still a failure');
    assert.equal(
      dispatchCount(stub), expected,
      `${retries} retries is EXACTLY ${expected} attempt${expected === 1 ? '' : 's'} and never more`,
    );
    assert.match(`${run.stdout}${run.stderr}`, /E_BR_LIVE_DISPATCH_FAILED/, 'and the refusal still fires');
  }

  // The 2 counts DIFFER, so neither is a constant that happened to match.
  assert.notEqual(dispatchCount(stubs[0]), dispatchCount(stubs[1]));
});

test('a RETRYABLE timeout is retried to the bound, so the bound and the retry are separate facts', () => {
  // The timeout refusal is 1 of exactly 2 codes a retry is permitted against.
  // The bound case above pins the DEAD process and the named bound at 0 retries;
  // this one pins the retry at the shipped default over the same condition.
  const corpus = scratchRoot('b301-timeout-retry');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('b301-timeout-retry-out');
  const stub = writeStubAdapter('b301-timeout-retry');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    {
      corpus,
      outerBoundMs: 60_000,
      env: liveEnv(stub, {
        FERROX_STUB_MODE: 'hang',
        [LIVE_TIMEOUT]: '1200',
        [LIVE_RETRY_DELAY]: '0',
      }),
    },
  );

  assert.notEqual(run.status, 0, 'a hung adapter is still a builder failure at the end of the bound');
  assert.equal(
    dispatchCount(stub), DEFAULT_LIVE_ATTEMPTS,
    'the timeout is retryable, so it was dispatched once per permitted attempt',
  );
  assert.match(`${run.stdout}${run.stderr}`, /E_BR_LIVE_TIMEOUT/, 'and the bound is what refused it');
});

test('the retryable set is EXACTLY the 2 dispatch codes and holds NEITHER identity refusal', () => {
  // The 2 identity refusals are configuration facts about the invocation this
  // process built. They are IDENTICAL on attempt 3, so retrying them turns 1
  // immediate and correct refusal into the same refusal 2 pauses later. The set
  // is read out of the running CLI rather than transcribed here.
  const corpus = scratchRoot('b301-codes');
  writeSingleTask(corpus, 'solo');
  const stub = writeStubAdapter('b301-codes');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--plan-only'],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(run.status, 0, run.stderr);
  const plan = reportOf(run);

  assert.notEqual(plan.salvage, null, 'NON ZERO FIRST: the live builder carries a policy to read');
  assert.deepEqual(
    plan.salvage.retryable_codes.slice().sort(),
    ['E_BR_LIVE_DISPATCH_FAILED', 'E_BR_LIVE_TIMEOUT'],
    'exactly the 2 codes that name a dispatch which did not answer',
  );
  for (const identity of ['E_BR_LIVE_ADAPTER_UNSET', 'E_BR_LIVE_ADAPTER_UNKNOWN']) {
    assert.equal(
      plan.salvage.retryable_codes.includes(identity), false,
      `${identity} is a configuration fact, not a transient one, so it is never retried`,
    );
  }
  assert.equal(plan.salvage.max_attempts, DEFAULT_LIVE_ATTEMPTS, 'the shipped bound is a total');

  // THE DECISION, not the list. A predicate that ignored the list entirely would
  // leave every assertion above intact while retrying everything, so the runner
  // publishes what it will ACTUALLY do per code and that is what is asserted.
  assert.equal(plan.retry_decision.length, 4, 'NON ZERO FIRST: all 4 live codes are decided');
  const decision = new Map(plan.retry_decision.map((r) => [r.code, r.retried]));
  assert.equal(decision.get('E_BR_LIVE_DISPATCH_FAILED'), true);
  assert.equal(decision.get('E_BR_LIVE_TIMEOUT'), true);
  assert.equal(
    decision.get('E_BR_LIVE_ADAPTER_UNSET'), false,
    'an unset identity is a configuration fact and the runner will NOT retry it',
  );
  assert.equal(
    decision.get('E_BR_LIVE_ADAPTER_UNKNOWN'), false,
    'and neither will it retry an identity that carries no argv profile',
  );
  assert.equal(
    plan.retry_decision.filter((r) => r.retried).length, 2,
    'EXACTLY 2 of the 4 are retried, so the decision discriminates rather than agreeing with itself',
  );
});

test('an identity refusal is NOT retried and reaches the adapter EXACTLY 0 times', () => {
  // The negative direction of the set above, driven rather than read. A run
  // whose identity is not dispatchable must refuse at once, spawn nothing, and
  // never pause for a retry that cannot change the answer.
  const corpus = scratchRoot('b301-no-retry');
  writeSingleTask(corpus, 'solo');
  const out = scratchRoot('b301-no-retry-out');
  const stub = writeStubAdapter('b301-no-retry');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--out', out],
    { corpus, env: liveEnv(stub, { [LIVE_ADAPTER]: 'kimi' }) },
  );

  assert.notEqual(run.status, 0);
  assert.match(`${run.stdout}${run.stderr}`, /E_BR_LIVE_ADAPTER_UNKNOWN/, 'the identity refusal fired');
  assert.equal(dispatchCount(stub), 0, 'and NOTHING was spawned, once or 3 times');
  assert.deepEqual(fs.readdirSync(out), [], 'and no artifact of any kind was written');
});

// ─── the LIVE ONLY fence, with its REQUIRED FAILING ARM ──────────────────────

test('the salvage policy is ABSENT from the replay and the reference builder, read from the CLI', () => {
  const corpus = scratchRoot('b301-fence-read');
  writeSingleTask(corpus, 'solo');
  const results = writeResults(scratchRoot('b301-fence-results'), [replayRow('solo', 'opus-4-8', BODY.reference)]);
  const stub = writeStubAdapter('b301-fence-read');

  for (const builder of ['replay', 'reference']) {
    const run = runScript(
      ['--arm', 'serial', '--shape', 'within-task', '--builder', builder, '--plan-only'],
      { corpus, results },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      reportOf(run).salvage, null,
      `the ${builder} builder carries NO salvage policy, so it gets 1 attempt and today's abort`,
    );
  }

  // THE CONTROL. A seam that reads null for every builder is not a fence, it is
  // a field nobody set, so the live builder is read through the SAME seam.
  const live = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'live', '--plan-only'],
    { corpus, env: liveEnv(stub) },
  );
  assert.equal(live.status, 0, live.stderr);
  assert.notEqual(reportOf(live).salvage, null, 'and the live builder DOES carry one');
});

test('REQUIRED FAILING ARM: a salvage policy on the REPLAY builder is REFUSED by the fence', () => {
  // A guard nobody has watched fire is indistinguishable from a guard that
  // cannot fire. The policy is put where it must not be, through a TEST ONLY
  // seam, and the refusal is OBSERVED through the real CLI.
  const corpus = scratchRoot('b301-fence-fire');
  writeSingleTask(corpus, 'solo');
  const results = writeResults(scratchRoot('b301-fence-fire-results'), [replayRow('solo', 'opus-4-8', BODY.reference)]);
  const out = scratchRoot('b301-fence-fire-out');

  const refused = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', out],
    { corpus, results, env: { [FORCE_SALVAGE]: 'replay' } },
  );

  assert.notEqual(refused.status, 0, 'the widened policy is a failure, never a silent acceptance');
  const combined = `${refused.stdout}${refused.stderr}`;
  assert.match(combined, /E_BR_SALVAGE_WIDENED/, 'the fence fired BY CODE');
  assert.match(combined, /replay/, 'and it NAMES the builder that carried the policy it must not');
  assert.deepEqual(
    fs.readdirSync(out), [],
    'and it refused BEFORE anything was written, so there is nothing to undo',
  );

  // THE TRUE DIRECTION, because a refusal that fires on every run is not a
  // fence either. The SAME corpus and the SAME builder without the seam runs.
  const clean = runScript(
    ['--arm', 'serial', '--shape', 'within-task', '--builder', 'replay', '--out', scratchRoot('b301-fence-clean-out')],
    { corpus, results },
  );
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(reportOf(clean).records[0].attempted, 1, 'NON ZERO FIRST: the unfenced run really built');
  assert.doesNotMatch(`${clean.stdout}${clean.stderr}`, /E_BR_SALVAGE_WIDENED/, 'and nothing was refused');
});

// ─── the PARTIAL record ──────────────────────────────────────────────────────

test('a run that fails AFTER buying candidates writes a PARTIAL artifact and never a run record', () => {
  // The 23-05 shape exactly. 3 tasks, the adapter answers the first 2 dispatches
  // and refuses every one after that, which is what a rate limit at dispatch 100
  // of 104 looks like from inside the runner.
  const corpus = scratchRoot('b301-partial');
  for (const id of ['t1', 't2', 't3']) writeSingleTask(corpus, id);
  const out = scratchRoot('b301-partial-out');
  const stub = writeStubAdapter('b301-partial');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'across-task', '--builder', 'live', '--out', out],
    {
      corpus,
      outerBoundMs: 60_000,
      env: liveEnv(stub, {
        FERROX_STUB_MODE: 'late',
        FERROX_STUB_OK_TIMES: '2',
        FERROX_STUB_USD: '0.25',
        [LIVE_RETRY_DELAY]: '0',
      }),
    },
  );

  // GUARD 3 OF 3: the exit code. A partial never borrows a zero exit.
  assert.notEqual(run.status, 0, 'a partial run reports a failure');

  const report = reportOf(run);
  assert.equal(report.status, 'PARTIAL', 'and it is named PARTIAL rather than ok');
  assert.notEqual(report.status, 'ok', 'a partial is NEVER reported as a completed run');

  // GUARD 2 OF 3: it is a `.json`, so the arm loader cannot read it as an arm.
  const partials = partialsIn(out);
  assert.equal(partials.length, 1, 'NON ZERO FIRST: exactly 1 partial artifact was salvaged');
  assert.deepEqual(recordsIn(out), [], 'and NO .jsonl run record exists, so it cannot become an arm');

  const a = partials[0].artifact;
  assert.equal(a.schema, 'bench-run-partial/v1');
  assert.equal(a.status, 'PARTIAL');

  // THE SALVAGE ITSELF: the candidates already paid for survived.
  assert.equal(a.attempted, 2, 'the 2 nodes already bought are IN the artifact');
  assert.equal(a.total_nodes, 3, 'against the 3 the run set out to build');
  assert.deepEqual(a.built_nodes, ['t1', 't2'], 'and they are named');

  // The ATTEMPT COUNT rides with the failure, so a reader knows the run did not
  // give up on the first refusal.
  assert.equal(a.failure.node, 't3', 'the node that stopped the run is named');
  assert.equal(
    a.failure.attempts, DEFAULT_LIVE_ATTEMPTS,
    'and it was attempted once per permitted attempt before the run stopped',
  );
  assert.equal(a.failure.code, 'E_BR_LIVE_DISPATCH_FAILED');
  assert.equal(a.failure.retryable, true);

  // The DISPATCH COUNT confirms it: 2 answers plus 3 refused attempts on t3.
  assert.equal(
    dispatchCount(stub), 2 + DEFAULT_LIVE_ATTEMPTS,
    'the adapter was reached exactly twice for the built nodes and once per attempt for the third',
  );

  // The SPEND already paid for is preserved, which is the point of salvaging.
  const paid = a.events.filter((e) => e.kind === 'worker_ended' && e.outcome === 'completed');
  assert.equal(paid.length, 2, 'NON ZERO FIRST: 2 completed intervals survived');
  for (const e of paid) assert.equal(e.usd, 0.25, 'carrying the spend the adapter reported');

  // The corpus hash requirement is NOT relaxed and the provenance is NOT widened.
  assert.equal(typeof a.corpus_hash, 'string');
  assert.notEqual(a.corpus_hash, '', 'a partial record still carries the corpus hash');
  assert.ok(
    ['measured', 'replayed', 'unavailable'].includes(a.provenance),
    'and a real provenance from the shipped 3, never a new one for being partial',
  );
  assert.equal(a.provenance, 'unavailable', 'a substituted head is a rehearsal and is never measured');

  // NOTHING WAS SCORED, and there is no score shaped field for a renderer to
  // average. An absent key cannot be read as a 0.
  assert.equal(a.scored, false);
  for (const key of ['scores', 'landed_tasks', 'failed_tasks', 'metrics', 'saturation']) {
    assert.equal(key in a, false, `the artifact carries no ${key} at all`);
  }
});

test('GUARD 1 OF 3, COMPUTED: the shipped validator REFUSES the salvaged events as a run record', () => {
  // The strongest of the 3 guards and the only one a reader can check without
  // trusting this file. The partial carries NO run_closed, so the SAME validator
  // every complete record has to satisfy refuses it as a truncated log. The
  // artifact reports that verdict, and this case recomputes it independently
  // rather than reading the artifact's own claim about itself.
  const corpus = scratchRoot('b301-validator');
  for (const id of ['t1', 't2']) writeSingleTask(corpus, id);
  const out = scratchRoot('b301-validator-out');
  const stub = writeStubAdapter('b301-validator');

  const run = runScript(
    ['--arm', 'serial', '--shape', 'across-task', '--builder', 'live', '--out', out],
    {
      corpus,
      outerBoundMs: 60_000,
      env: liveEnv(stub, {
        FERROX_STUB_MODE: 'late',
        FERROX_STUB_OK_TIMES: '1',
        [LIVE_RETRY_DELAY]: '0',
      }),
    },
  );
  assert.notEqual(run.status, 0);

  const partials = partialsIn(out);
  assert.equal(partials.length, 1, 'NON ZERO FIRST');
  const a = partials[0].artifact;

  assert.ok(a.events.length > 0, 'NON ZERO FIRST: there are events to validate');
  assert.equal(
    a.events.some((e) => e.kind === 'run_closed'), false,
    'NO run_closed is emitted on the partial path',
  );
  assert.equal(a.run_closed, false, 'and the artifact says so');

  // RECOMPUTED HERE, through the shipped library, over the artifact's own events.
  const verdict = FOLD.validateRunRecord(a.events);
  assert.equal(verdict.ok, false, 'the shipped validator REFUSES this event set as a run record');
  const codes = [...new Set(verdict.errors.map((e) => e.code))];
  assert.ok(
    codes.includes(FOLD.PROOF_CODES.E_PR_RUN_NOT_CLOSED),
    'by the truncated log code, so a partial copied into a .jsonl is still refused',
  );
  assert.equal(
    a.record_validation.refused_as_run_record, true,
    'and the artifact reports the same verdict it was computed from',
  );

  // THE CONTROL. A validator that refused everything would prove nothing, so a
  // COMPLETE run over the same corpus is validated through the same call.
  const okStub = writeStubAdapter('b301-validator-ok');
  const okOut = scratchRoot('b301-validator-ok-out');
  const ok = runScript(
    ['--arm', 'serial', '--shape', 'across-task', '--builder', 'live', '--out', okOut],
    { corpus, env: liveEnv(okStub) },
  );
  assert.equal(ok.status, 0, ok.stderr);
  const okEvents = readRecord(reportOf(ok).records[0].path);
  assert.ok(okEvents.some((e) => e.kind === 'run_closed'), 'the complete run DOES close');
  assert.equal(
    FOLD.validateRunRecord(okEvents).ok, true,
    'and the same validator ACCEPTS it, so the refusal above discriminates',
  );
});

test('FF-B284: the PARTIAL prose is ABSENT over a run that COMPLETED, and vice versa', () => {
  // A mutation battery cannot detect a FALSE SENTENCE. The partial report states
  // that nothing was scored and that candidates were salvaged, and both would be
  // emitted word for word over a run that scored everything. So each is rendered
  // over the world where it is FALSE and asserted ABSENT.
  const corpus = scratchRoot('b301-sentence');
  for (const id of ['t1', 't2'] ) writeSingleTask(corpus, id);

  const okStub = writeStubAdapter('b301-sentence-ok');
  const okOut = scratchRoot('b301-sentence-ok-out');
  const ok = runScript(
    ['--arm', 'serial', '--shape', 'across-task', '--builder', 'live', '--out', okOut],
    { corpus, env: liveEnv(okStub) },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(reportOf(ok).records[0].attempted, 2, 'NON ZERO FIRST: this world really did build');
  const okText = `${ok.stdout}${ok.stderr}`;
  assert.doesNotMatch(okText, /PARTIAL/, 'the word PARTIAL is absent over a completed run');
  assert.doesNotMatch(okText, /NOTHING WAS SCORED/, 'and so is the claim that nothing was scored');
  assert.deepEqual(partialsIn(okOut), [], 'and no partial artifact was written');

  const badStub = writeStubAdapter('b301-sentence-bad');
  const badOut = scratchRoot('b301-sentence-bad-out');
  const bad = runScript(
    ['--arm', 'serial', '--shape', 'across-task', '--builder', 'live', '--out', badOut],
    {
      corpus,
      outerBoundMs: 60_000,
      env: liveEnv(badStub, {
        FERROX_STUB_MODE: 'late', FERROX_STUB_OK_TIMES: '1', [LIVE_RETRY_DELAY]: '0',
      }),
    },
  );
  assert.notEqual(bad.status, 0);
  const badText = `${bad.stdout}${bad.stderr}`;
  assert.match(badText, /PARTIAL/, 'over the world where it IS true the word is present');
  assert.match(badText, /NOTHING WAS SCORED/, 'and so is the claim');
  assert.doesNotMatch(badText, /"status": "ok"/, 'and the completed status is NOT also emitted');
});

test('a LATER run failing does not discard the runs that ALREADY completed', () => {
  // The other half of "not a total loss". 2 shapes in 1 invocation: the first
  // completes and its record must survive on disk and in the report, and the
  // second is salvaged as a partial beside it.
  const corpus = scratchRoot('b301-earlier');
  for (const id of ['t1', 't2']) writeSingleTask(corpus, id);
  const out = scratchRoot('b301-earlier-out');
  const stub = writeStubAdapter('b301-earlier');

  // 3 answers, then refusals. Shape 1 spends 2 of them and COMPLETES; shape 2
  // spends the third on its first node and is then refused on its second, so it
  // has genuinely bought a candidate before it dies.
  const run = runScript(
    ['--arm', 'serial', '--shape', 'both', '--builder', 'live', '--out', out],
    {
      corpus,
      outerBoundMs: 60_000,
      env: liveEnv(stub, {
        FERROX_STUB_MODE: 'late', FERROX_STUB_OK_TIMES: '3', [LIVE_RETRY_DELAY]: '0',
      }),
    },
  );

  assert.notEqual(run.status, 0, 'the invocation as a whole did not complete');
  const report = reportOf(run);
  assert.equal(report.status, 'PARTIAL');
  assert.equal(
    report.records.length, 1,
    'NON ZERO FIRST: the run that COMPLETED before the failure is still reported',
  );
  assert.equal(report.records[0].attempted, 2, 'and it really built its nodes');

  assert.equal(recordsIn(out).length, 1, 'its .jsonl record survived on disk');
  assert.equal(partialsIn(out).length, 1, 'and the failed run is salvaged beside it as a partial');
  assert.ok(
    fs.existsSync(report.records[0].path),
    'the completed record is at the path the report names, so a reader can find it',
  );
});

test('the FLEET arm retries too, and its record carries the attempt that built the candidate', () => {
  // The fleet arm dispatches through a build CHILD and closes its intervals from
  // inside the batch, so it is a separate implementation of the same property
  // and it is driven separately rather than assumed to follow.
  const corpus = scratchRoot('b301-fleet');
  const stubs = scratchRoot('b301-fleet-loop');
  const out = scratchRoot('b301-fleet-out');
  for (const id of ['s1', 's2']) writeSingleTask(corpus, id);
  const stub = writeStubAdapter('b301-fleet');

  const run = runScript(
    ['--arm', 'fleet', '--shape', 'across-task', '--builder', 'live', '--width', '2', '--out', out],
    {
      corpus,
      outerBoundMs: 60_000,
      env: {
        ...liveEnv(stub, {
          FERROX_STUB_MODE: 'flaky',
          FERROX_STUB_FAIL_NODE: 's2/single',
          FERROX_STUB_FAIL_TIMES: '1',
          [LIVE_RETRY_DELAY]: '0',
        }),
        ...fleetEnv(stubs, {
          entry: writeStubLoop(stubs, { dispatchAllowed: true }),
          graph: writeStubGraph(stubs, 2),
        }),
      },
    },
  );

  assert.equal(run.status, 0, `the fleet run recovered inside its bound. stderr: ${run.stderr}`);
  assert.equal(dispatchCount(stub), 3, 'EXACTLY 3 dispatches: 1 for s1, and 2 for the flaky s2');

  const report = reportOf(run);
  assert.equal(report.records[0].attempted, 2, 'NON ZERO FIRST: both nodes were built');

  const events = readRecord(report.records[0].path);
  const s2 = workerEventsFor(events, 's2');
  assert.equal(s2.length, 4, 'the flaky node opened 2 intervals, 1 per attempt');
  const s2failed = s2.filter((e) => e.kind === 'worker_ended' && e.outcome === 'failed');
  const s2done = s2.filter((e) => e.kind === 'worker_ended' && e.outcome === 'completed');
  assert.equal(s2failed.length, 1, 'the refused dispatch CLOSED its interval');
  assert.equal(s2failed[0].attempt_id, 's2#1');
  assert.equal(s2done.length, 1);
  assert.equal(s2done[0].attempt_id, 's2#2', 'and the candidate is labelled attempt 2, NOT 1');

  // THE WALL CLOCK IS NOT SUMMED AND THE SPEND IS NOT FABRICATED, on this arm
  // too. The fleet arm closes its intervals from inside the batch, so it is a
  // separate emitter and it is asserted separately.
  assert.equal(s2failed[0].usd, null, 'the refused dispatch bought nothing. UNKNOWN, never 0');
  assert.equal(s2failed[0].recorded_runtime_ms, null, 'and measured no build. UNKNOWN, never 0');
  assert.ok(s2done[0].recorded_runtime_ms > 0, 'the answered attempt carries its OWN duration');

  // EVERY LATER EVENT KEYS TO THE ATTEMPT THAT BUILT THE CANDIDATE. The worker
  // pair above is emitted with an explicit label; the gate and the land result
  // are emitted through the run's shared attempt lookup, which is a SECOND place
  // the count has to reach and is not covered by the pair.
  const s2land = events.filter((e) => e.kind === 'land_completed' && e.node_id === 's2');
  assert.equal(s2land.length, 1, 'NON ZERO FIRST: the flaky node landed');
  assert.equal(s2land[0].attempt_id, 's2#2', 'and its land result keys to attempt 2, NOT 1');
  const s2gate = events.filter((e) => e.kind === 'gate_ended' && e.node_id === 's2');
  assert.ok(s2gate.length > 0, 'NON ZERO FIRST: it was scored');
  for (const g of s2gate) assert.equal(g.attempt_id, 's2#2', 'and every gate result too');

  // THE CONTROL. The node that never failed is still attempt 1, so the label is
  // not simply incrementing for everything.
  const s1done = workerEventsFor(events, 's1').filter((e) => e.kind === 'worker_ended');
  assert.equal(s1done.length, 1, 'the healthy node opened exactly 1 interval');
  assert.equal(s1done[0].attempt_id, 's1#1', 'and it is still attempt 1');
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
