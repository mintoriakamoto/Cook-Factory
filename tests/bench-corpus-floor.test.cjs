'use strict';

/**
 * bench-corpus-floor: the discrimination floor instrument under lock, driven as a
 * REAL CHILD PROCESS.
 *
 *   - NEVER IMPORTED. Every arm below runs `node scripts/bench-corpus-floor.cjs`
 *     through `spawnSync`. A test that imported the module could not see the argv
 *     wiring, the exit codes, the child spawning of the runner, or the python
 *     gate spawning, and those 4 are most of what this script is (D8b).
 *   - 3 CANDIDATE ANSWERS, 1 ASSERTED AND 2 EXCLUDED. The model arms name the
 *     replayed round count, the closed form answer and the per task summation
 *     answer, assert the first and exclude the other 2 BY VALUE. A model that is
 *     right on a corpus where all 3 agree proves nothing, so every model fixture
 *     is chosen so they DISAGREE.
 *   - THE STRADDLE IS THE PROPERTY NEITHER WRONG MODEL CAN PRODUCE. A closed form
 *     publishes no batch membership at all and a per task summation cannot put 2
 *     tasks in 1 batch by construction, so the straddle arms separate the
 *     faithful replay from both of them at once.
 *   - THE REAL CORPUS SCOPE ARM. 2 refusals are observed firing on the ACTUAL
 *     corpus at the ACTUAL scope, not only against a scratch fixture. A guard that
 *     fires in the fixture and cannot fire on the input it exists for is this
 *     phase's defect class.
 *   - NON ZERO BEFORE EVERY PROPERTY. Every property this instrument asserts over
 *     its task set is vacuously true of an empty one, so each arm asserts a count
 *     first and the property second.
 *   - FIXTURES ARE BUILT, NEVER BORROWED. An empty untracked directory exists in
 *     no checkout, so every corpus below is written from scratch under the OS
 *     temporary directory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'bench-corpus-floor.cjs');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'bench-run.cjs');

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-cf-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

// ─── the fixture corpus builder ──────────────────────────────────────────────

/**
 * A gate that scores 3 out of 3 when its marker is present in the candidate and 1
 * out of 3 when it is not.
 *
 * The candidate is a FILE for a single task and a DIRECTORY for a multi task,
 * which is `scripts/bench-run.cjs` `candidateOf`, so the gate handles both.
 */
function gateSource(axis, marker) {
  return [
    'import os',
    'import sys',
    '',
    'target = sys.argv[1]',
    'text = ""',
    'if os.path.isdir(target):',
    '    for name in sorted(os.listdir(target)):',
    '        full = os.path.join(target, name)',
    '        if os.path.isfile(full):',
    '            with open(full) as fh:',
    '                text += fh.read()',
    'else:',
    '    with open(target) as fh:',
    '        text = fh.read()',
    `score = 3 if ${JSON.stringify(marker)} in text else 1`,
    `print("${axis}: %d/3" % score)`,
    '',
  ].join('\n');
}

const VISIBLE_MARKER = 'VISIBLE_OK';
const HIDDEN_MARKER = 'HIDDEN_OK';

function write(root, rel, text) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function body(markers) {
  return `# ${markers.join(' ')}\nvalue = 1\n`;
}

/**
 * Build a corpus from a declarative spec.
 *
 * A single task spec: { id, hidden, mutant, shallow, mutantFull, shallowFull }.
 * `hidden` defaults to true; `mutant` and `shallow` default to absent, because
 * FF-B323 makes ABSENCE trip nothing and a lean fixture spawns fewer gates.
 *
 * A multi task spec: { id, files, edges, permitted_width, hidden }.
 */
function buildCorpus(label, spec) {
  const root = scratch(label);
  write(root, path.join('gates', '.keep'), '');

  for (const t of spec.singles || []) {
    write(root, path.join('specs', `${t.id}.md`), `spec for ${t.id}\n`);
    write(root, path.join('gates', `${t.id}.py`), gateSource('gate', VISIBLE_MARKER));
    if (t.hidden !== false) {
      write(root, path.join('hidden', `${t.id}.py`), gateSource('hidden', HIDDEN_MARKER));
    }
    write(root, path.join('reference', `${t.id}.py`), body([VISIBLE_MARKER, HIDDEN_MARKER]));
    if (t.mutant === true) {
      write(root, path.join('mutant', `${t.id}.py`), body(t.mutantFull === true ? [VISIBLE_MARKER] : []));
    }
    if (t.shallow === true) {
      write(root, path.join('shallow', `${t.id}.py`), body(t.shallowFull === true ? [HIDDEN_MARKER] : []));
    }
  }

  for (const m of spec.multis || []) {
    const base = path.join('multi', m.id);
    write(root, path.join(base, 'SPEC.md'), `spec for ${m.id}\n`);
    write(root, path.join(base, 'gate.py'), gateSource('gate', VISIBLE_MARKER));
    if (m.hidden !== false) {
      write(root, path.join(base, 'hidden.py'), gateSource('hidden', HIDDEN_MARKER));
    }
    write(root, path.join(base, 'structure.json'), `${JSON.stringify({
      task: m.id,
      files: m.files,
      edges: m.edges,
      seam: m.seam || [],
      depth: m.depth || 1,
      permitted_width: m.permitted_width,
    }, null, 2)}\n`);
    for (const f of m.files) {
      write(root, path.join(base, 'reference', f), body([VISIBLE_MARKER, HIDDEN_MARKER]));
    }
  }

  return root;
}

// ─── driving the instrument ──────────────────────────────────────────────────

function run(args, corpusRoot) {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  if (corpusRoot !== undefined && corpusRoot !== null) env.FERROX_BENCH_CORPUS_ROOT = corpusRoot;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env,
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function runRaw(args, corpusRoot) {
  const r = run([...args, '--raw'], corpusRoot);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = null;
  }
  assert.notEqual(parsed, null, `the instrument emitted parseable JSON. stdout was:\n${r.stdout}\nstderr was:\n${r.stderr}`);
  return { r, out: parsed };
}

function runPlanOnly(args, corpusRoot) {
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  if (corpusRoot !== undefined && corpusRoot !== null) env.FERROX_BENCH_CORPUS_ROOT = corpusRoot;
  const r = spawnSync(process.execPath, [
    RUNNER, '--builder', 'replay', '--plan-only', '--arm', 'fleet', ...args,
  ], { encoding: 'utf8', cwd: REPO_ROOT, env, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, `bench-run.cjs --plan-only succeeded. stderr:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

function codesOf(out) {
  return out.refusals.map((x) => x.code);
}

// ─── the shared fixtures ─────────────────────────────────────────────────────

const CACHE = new Map();
function fixture(name, make) {
  if (!CACHE.has(name)) CACHE.set(name, make());
  return CACHE.get(name);
}

/** A wide multi task: 3 independent modules feeding 1 seam. Computed width 3, depth 2. */
function wideMulti(id) {
  return {
    id,
    files: ['a.py', 'b.py', 'c.py', 'z.py'],
    edges: [['z.py', 'a.py'], ['z.py', 'b.py'], ['z.py', 'c.py']],
    seam: ['z.py'],
    depth: 2,
    permitted_width: 3,
  };
}

/**
 * THE MODEL FIXTURE. 2 wide multi tasks and 3 single tasks at a cap of 3.
 *
 * The 3 candidate answers DISAGREE here by construction:
 *   the shipped loop, replayed        5
 *   the closed form, max(ceil(11/3), 2)  4
 *   the per task summation, 2 + 2 + 1 + 1 + 1  7
 *
 * Every task is sound, so the arm also proves a clean corpus raises 0 refusals.
 */
function modelCorpus() {
  return buildCorpus('model', {
    multis: [wideMulti('alpha'), wideMulti('beta')],
    singles: [
      { id: 's1', mutant: true, shallow: true },
      { id: 's2' },
      { id: 's3' },
    ],
  });
}

/** 1 wide multi and 1 single. The batch at the task boundary STRADDLES them. */
function straddleCorpus() {
  return buildCorpus('straddle', {
    multis: [wideMulti('alpha')],
    singles: [{ id: 'zsolo' }],
  });
}

/** A pure chain. N equals M, so no latency makes a fleet faster. */
function chainCorpus() {
  return buildCorpus('chain', {
    multis: [{
      id: 'chain',
      files: ['a.py', 'b.py', 'c.py', 'd.py'],
      edges: [['b.py', 'a.py'], ['c.py', 'b.py'], ['d.py', 'c.py']],
      seam: ['d.py'],
      depth: 4,
      permitted_width: 1,
    }],
  });
}

/** A task that DECLARES a width of 3 and whose edges COMPUTE 1. */
function declaresThreeCorpus() {
  return buildCorpus('declares3', {
    multis: [{
      id: 'lump',
      files: ['a.py', 'b.py', 'c.py'],
      edges: [['b.py', 'a.py'], ['c.py', 'b.py']],
      seam: ['c.py'],
      depth: 3,
      permitted_width: 3,
    }],
    singles: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
  });
}

// ─── the model, and BOTH wrong answers excluded by value ─────────────────────

test('the round count REPLAYS the shipped loop and is NEITHER wrong model, on a corpus where all 3 disagree', () => {
  const root = fixture('model', modelCorpus);
  const { r, out } = runRaw(['--structure'], root);

  assert.equal(out.task_count, 5, 'the fixture holds 5 tasks, asserted BEFORE any property over the set');
  assert.ok(out.task_count > 0, 'the task count is non zero, so no property below is vacuous');
  assert.equal(out.nodes, 11, 'the runner planned 11 nodes');
  assert.equal(out.schedule_cap, 3, 'the cap is the maximum DECLARED permitted_width');

  // The 3 candidates, computed by hand from the order the runner emits:
  //   R1 alpha/a alpha/b alpha/c      R2 alpha/z beta/a beta/b
  //   R3 beta/c                       R4 beta/z s1 s2
  //   R5 s3
  assert.equal(out.rounds, 5, 'the REPLAYED round count is 5');
  assert.equal(out.model_closed_form_would_be, 4, 'the closed form answer on this corpus is 4');
  assert.equal(out.model_per_task_sum_would_be, 7, 'the per task summation answer on this corpus is 7');
  assert.notEqual(out.rounds, out.model_closed_form_would_be, 'the replay is NOT the closed form answer');
  assert.notEqual(out.rounds, out.model_per_task_sum_would_be, 'the replay is NOT the per task summation answer');

  assert.deepEqual(out.batch_sizes, [3, 3, 1, 3, 1], 'the per round batch sizes are published');
  assert.equal(out.denominator, 6, 'the denominator N minus M is 6');
  assert.equal(r.status, 0, `a sound corpus raises no refusal. stderr:\n${r.stderr}`);
  assert.equal(out.refusals.length, 0, 'a sound corpus raises no refusal');
});

test('the published batch sizes sum to N, so the round count is auditable rather than opaque', () => {
  const root = fixture('model', modelCorpus);
  const { out } = runRaw(['--structure'], root);
  assert.ok(out.batch_sizes.length > 0, 'at least 1 batch was published');
  assert.equal(out.batch_sizes.length, out.rounds, '1 published size per round');
  const sum = out.batch_sizes.reduce((s, n) => s + n, 0);
  assert.equal(sum, out.nodes, 'the batch sizes sum to N, so no node was dropped or double counted');
});

// ─── the straddle, which neither wrong model can produce ─────────────────────

test('at least 1 published batch STRADDLES 2 tasks, asserted by name', () => {
  const root = fixture('straddle', straddleCorpus);
  const { out } = runRaw(['--structure'], root);

  assert.equal(out.task_count, 2, 'the fixture holds 2 tasks');
  assert.equal(out.nodes, 5, 'the runner planned 5 nodes');
  assert.ok(out.straddling_batches.length > 0, 'at least 1 batch straddles a task boundary');

  const spanning = out.straddling_batches.find((b) => b.tasks.includes('alpha') && b.tasks.includes('zsolo'));
  assert.notEqual(spanning, undefined, 'a batch spans alpha and zsolo');
  assert.equal(spanning.round, 2, 'the straddling batch is round 2');
  assert.deepEqual(spanning.nodes, ['alpha/z.py', 'zsolo'], 'the straddling batch is alpha/z.py with zsolo, named');
  assert.deepEqual(out.batch_sizes, [3, 2], 'round 1 fills the cap inside alpha and round 2 carries its tail plus zsolo');
});

test('the model fixture also straddles, and the straddling batches are named', () => {
  const root = fixture('model', modelCorpus);
  const { out } = runRaw(['--structure'], root);
  assert.ok(out.straddling_batches.length >= 2, 'more than 1 batch straddles');
  const r2 = out.straddling_batches.find((b) => b.round === 2);
  assert.notEqual(r2, undefined, 'round 2 straddles');
  assert.deepEqual(r2.nodes, ['alpha/z.py', 'beta/a.py', 'beta/b.py'], 'round 2 carries alpha\'s tail with beta\'s head');
  assert.deepEqual(r2.tasks, ['alpha', 'beta'], 'round 2 spans alpha and beta');
});

// ─── the 3 inputs come from the runner ───────────────────────────────────────

test('the order, the edges and the cap come from bench-run.cjs --plan-only, compared against it directly', () => {
  const root = fixture('model', modelCorpus);
  const { out } = runRaw(['--structure'], root);
  const plan = runPlanOnly(['--shape', 'within-task'], root);

  assert.ok(plan.order.length > 0, 'the producer emitted a non empty order');
  assert.deepEqual(out.order, plan.order, 'the instrument reports the producer\'s TOTAL ORDER verbatim');
  assert.deepEqual(out.edges, plan.edges, 'the instrument reports the producer\'s EDGES verbatim');
  assert.equal(out.schedule_cap, plan.permitted_width, 'the schedule cap is the producer\'s permitted_width');
  assert.deepEqual(out.tasks.slice().sort(), plan.tasks.slice().sort(), 'the scope matches the producer\'s');
});

test('the order the instrument replays is the producer\'s and not a locally sorted one', () => {
  const root = fixture('declares3', declaresThreeCorpus);
  const { out } = runRaw(['--structure'], root);
  const plan = runPlanOnly(['--shape', 'within-task'], root);
  assert.deepEqual(out.order, plan.order, 'the order is the producer\'s');
  const flattened = out.batches.reduce((acc, b) => acc.concat(b), []);
  assert.deepEqual(flattened, plan.order, 'the batches concatenate back into the producer\'s order exactly');
});

// ─── the 2 widths are DIFFERENT NUMBERS, both halves in 1 case ───────────────

test('the schedule cap is the maximum DECLARED width while the width floor uses the COMPUTED width', () => {
  const root = fixture('declares3', declaresThreeCorpus);
  const { r, out } = runRaw(['--structure'], root);

  assert.equal(out.task_count, 4, 'the fixture holds 4 tasks');

  // Half 1: the SCHEDULE takes the DECLARED number, so the runner is modelled faithfully.
  assert.equal(out.schedule_cap, 3, 'the schedule cap is 3, the DECLARED width');
  assert.equal(out.declared_width_max, 3, 'the declared maximum is 3');

  // Half 2: the WIDTH FLOOR takes the COMPUTED number, so the declaration is testable.
  const lump = out.per_task.find((t) => t.task === 'lump');
  assert.notEqual(lump, undefined, 'the lump task is reported');
  assert.equal(lump.computed_width, 1, 'the COMPUTED available width of a chain is 1');
  assert.notEqual(lump.computed_width, 3, 'the computed width is NOT the declared 3');
  assert.equal(lump.declared_width, 3, 'the declared width is reported beside it, so the gap is visible');
  assert.equal(out.computed_width_max, 1, 'the maximum computed width over the scope is 1');
  assert.ok(codesOf(out).includes('E_CF_WIDTH_FLOOR'), 'E_CF_WIDTH_FLOOR fires on the computed number');
  assert.equal(r.status, 1, 'a refusal exits non zero');
});

test('the width floor names the computed number and the declared one beside it', () => {
  const root = fixture('declares3', declaresThreeCorpus);
  const { out } = runRaw(['--structure'], root);
  const refusal = out.refusals.find((x) => x.code === 'E_CF_WIDTH_FLOOR');
  assert.notEqual(refusal, undefined, 'the refusal is present');
  assert.match(refusal.detail, /COMPUTED available width over the tasks in scope is 1/, 'the computed number is named');
  assert.match(refusal.detail, /maximum DECLARED width is 3/, 'the declared number is named beside it');
});

test('the computed depth is the longest chain and not the layer count', () => {
  const root = fixture('declares3', declaresThreeCorpus);
  const { out } = runRaw(['--structure'], root);
  const lump = out.per_task.find((t) => t.task === 'lump');
  assert.equal(lump.computed_depth, 3, 'a chain of 3 has a depth of 3');
  assert.equal(out.computed_depth_max, 3, 'the maximum computed depth is 3');
});

// ─── --structure needs NO overhead artifact ─────────────────────────────────

test('--structure with NO overhead artifact anywhere exits 0 and publishes its numbers', () => {
  const root = fixture('model', modelCorpus);
  const r = run(['--structure'], root);

  assert.equal(r.status, 0, `a structure run needs no overhead artifact. stderr:\n${r.stderr}`);
  assert.match(r.stdout, /^nodes: 11$/m, 'N is published');
  assert.match(r.stdout, /^rounds: 5$/m, 'M is published');
  assert.match(r.stdout, /^batch_sizes: 3,3,1,3,1$/m, 'the batch sizes are published');
  assert.match(r.stdout, /^task: alpha .* computed_width: 3 declared_width: 3$/m, 'the per task widths are published');
  assert.doesNotMatch(r.stdout, /E_CF_OVERHEAD_UNMEASURED/, 'the unmeasured refusal cannot fire in structure mode');
  assert.doesNotMatch(r.stdout, /E_CF_OVERHEAD_UNSOUND/, 'the unsound refusal cannot fire in structure mode');
  assert.doesNotMatch(r.stdout, /l_min_ms/, 'structure mode publishes no floor number at all');
});

test('--structure raises neither overhead refusal even when an unsound artifact sits beside it', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('structure-noise');
  fs.writeFileSync(path.join(dir, 'overhead.json'), '{"garbage": true}\n');
  const { r, out } = runRaw(['--structure'], root);
  assert.equal(r.status, 0, 'the structure mode ignores an artifact it was never given');
  assert.equal(out.floor, null, 'the raw structure payload carries no floor block');
  assert.equal(codesOf(out).filter((c) => c.startsWith('E_CF_OVERHEAD')).length, 0, 'no overhead refusal fired');
});

// ─── the overhead refusals, each driven by a case where the condition IS present

function overheadArtifact(dir, name, patch) {
  const witness = { load1_start: 0.2, load1_end: 0.2, interpreters_start: 2, interpreters_end: 2 };
  const base = {
    schema: 'bench-corpus-floor-overhead/v1',
    f_run_ms: 60000,
    f_node_ms: 30000,
    sigma_ms: 500,
    nodes_divided_by: 11,
    corpus_hash: 'REPLACE_ME',
    witness_cpu_count: 8,
    regions: [
      { name: 'f_run', command: 'FIXTURE f_run', repeat: 2, ms: 60000, witness },
      { name: 'f_node', command: 'FIXTURE f_node', repeat: 2, ms: 330000, witness },
      { name: 'sigma', command: 'FIXTURE sigma', repeat: 2, ms: 500, witness },
    ],
  };
  const artifact = { ...base, ...(patch || {}) };
  const full = path.join(dir, name);
  fs.writeFileSync(full, `${JSON.stringify(artifact, null, 2)}\n`);
  return full;
}

function corpusHashOf(root) {
  const { out } = runRaw(['--structure'], root);
  assert.equal(typeof out.corpus_hash, 'string', 'the corpus hash is published');
  assert.ok(out.corpus_hash.length > 0, 'the corpus hash is not empty');
  return out.corpus_hash;
}

test('--floor with NO overhead artifact refuses E_CF_OVERHEAD_UNMEASURED and prints no floor number', () => {
  const root = fixture('model', modelCorpus);
  const { r, out } = runRaw(['--floor'], root);

  assert.equal(r.status, 1, 'the refusal exits non zero');
  assert.ok(codesOf(out).includes('E_CF_OVERHEAD_UNMEASURED'), 'the unmeasured code fired');
  assert.equal(out.floor, null, 'NO floor number was published');
  const text = run(['--floor'], root).stdout;
  assert.doesNotMatch(text, /l_min_ms/, 'no L_min line appears in the human output either');
});

test('--floor with an artifact naming no command it timed refuses E_CF_OVERHEAD_UNMEASURED', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('nocmd');
  const artifact = overheadArtifact(dir, 'overhead.json', {
    corpus_hash: corpusHashOf(root),
    regions: [
      { name: 'f_run', command: '', repeat: 2, ms: 60000 },
      { name: 'f_node', command: '   ', repeat: 2, ms: 330000 },
    ],
  });

  const { r, out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 1, 'the refusal exits non zero');
  const refusal = out.refusals.find((x) => x.code === 'E_CF_OVERHEAD_UNMEASURED');
  assert.notEqual(refusal, undefined, 'the unmeasured code fired');
  assert.equal(refusal.leg, 'artifact-names-no-command', 'the leg names what was missing');
  assert.equal(out.floor, null, 'NO floor number was published');
});

test('--floor refuses E_CF_OVERHEAD_UNSOUND when the artifact carries no contention witness', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('nowitness');
  const artifact = overheadArtifact(dir, 'overhead.json', {
    corpus_hash: corpusHashOf(root),
    witness_cpu_count: 8,
    regions: [
      { name: 'f_run', command: 'FIXTURE f_run', repeat: 2, ms: 60000 },
      { name: 'f_node', command: 'FIXTURE f_node', repeat: 2, ms: 330000 },
      { name: 'sigma', command: 'FIXTURE sigma', repeat: 2, ms: 500 },
    ],
  });

  const { r, out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 1, 'the refusal exits non zero');
  const refusal = out.refusals.find((x) => x.code === 'E_CF_OVERHEAD_UNSOUND');
  assert.notEqual(refusal, undefined, 'the unsound code fired');
  assert.equal(refusal.leg, 'no-contention-witness', 'the leg names which of the 3 fired');
  assert.equal(out.floor, null, 'NO floor number was published');
});

test('an artifact whose witness is missing ANY 1 field is REFUSED rather than accepted with a default', () => {
  const root = fixture('model', modelCorpus);
  const hash = corpusHashOf(root);
  const complete = { load1_start: 0.2, load1_end: 0.2, interpreters_start: 2, interpreters_end: 2 };

  // 1 arm per field, and each arm removes exactly 1. A reader that filled a
  // missing reading with 0 would accept every one of these, and a 0 load is the
  // most flattering default available.
  for (const missing of ['load1_start', 'load1_end', 'interpreters_start', 'interpreters_end']) {
    const partial = { ...complete };
    delete partial[missing];
    const dir = scratch(`partial-${missing}`);
    const artifact = overheadArtifact(dir, 'overhead.json', {
      corpus_hash: hash,
      witness_cpu_count: 8,
      regions: [
        { name: 'f_run', command: 'FIXTURE f_run', repeat: 2, ms: 60000, witness: partial },
        { name: 'f_node', command: 'FIXTURE f_node', repeat: 2, ms: 330000, witness: complete },
        { name: 'sigma', command: 'FIXTURE sigma', repeat: 2, ms: 500, witness: complete },
      ],
    });
    const { r, out } = runRaw(['--floor', '--overhead', artifact], root);
    assert.equal(r.status, 1, `a witness missing ${missing} exits non zero`);
    const refusal = out.refusals.find((x) => x.code === 'E_CF_OVERHEAD_UNSOUND');
    assert.notEqual(refusal, undefined, `a witness missing ${missing} raises the unsound code`);
    assert.equal(refusal.leg, 'no-contention-witness', `a witness missing ${missing} raises the witness leg`);
    assert.equal(out.floor, null, `a witness missing ${missing} publishes NO floor`);
  }

  // The CPU count is part of the witness too: a ratio needs a denominator.
  const dir = scratch('partial-cpus');
  const artifact = overheadArtifact(dir, 'overhead.json', { corpus_hash: hash, witness_cpu_count: null });
  const { r, out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 1, 'a witness with no CPU count exits non zero');
  assert.equal(out.refusals.find((x) => x.code === 'E_CF_OVERHEAD_UNSOUND').leg, 'no-contention-witness', 'a ratio with no denominator is no witness');
});

test('--floor refuses E_CF_OVERHEAD_UNSOUND when the witness records load above the declared ratio', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('contended');
  const hot = { load1_start: 0.4, load1_end: 22.5, interpreters_start: 2, interpreters_end: 3 };
  const artifact = overheadArtifact(dir, 'overhead.json', {
    corpus_hash: corpusHashOf(root),
    witness_cpu_count: 8,
    regions: [
      { name: 'f_run', command: 'FIXTURE f_run', repeat: 2, ms: 60000, witness: hot },
      { name: 'f_node', command: 'FIXTURE f_node', repeat: 2, ms: 330000, witness: hot },
      { name: 'sigma', command: 'FIXTURE sigma', repeat: 2, ms: 500, witness: hot },
    ],
  });

  const { r, out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 1, 'the refusal exits non zero');
  const refusal = out.refusals.find((x) => x.code === 'E_CF_OVERHEAD_UNSOUND');
  assert.notEqual(refusal, undefined, 'the unsound code fired');
  assert.equal(refusal.leg, 'witness-records-contention', 'the leg names which of the 3 fired');
  assert.match(refusal.detail, /ratio of 2\.81 above the declared 0\.7/, 'the observed ratio and the constant are both named');
  assert.equal(out.floor, null, 'NO floor number was published');
});

test('the contention leg also catches a freshly started sibling suite through the interpreter count alone', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('interpreters');
  // A quiet 1 minute load average with a burst of interpreters: exactly the
  // sibling suite that started seconds ago and cannot appear in a lagging average.
  const burst = { load1_start: 0.1, load1_end: 0.1, interpreters_start: 2, interpreters_end: 41 };
  const artifact = overheadArtifact(dir, 'overhead.json', {
    corpus_hash: corpusHashOf(root),
    witness_cpu_count: 8,
    regions: [
      { name: 'f_run', command: 'FIXTURE f_run', repeat: 2, ms: 60000, witness: burst },
      { name: 'f_node', command: 'FIXTURE f_node', repeat: 2, ms: 330000, witness: burst },
      { name: 'sigma', command: 'FIXTURE sigma', repeat: 2, ms: 500, witness: burst },
    ],
  });

  const { r, out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 1, 'the refusal exits non zero');
  const refusal = out.refusals.find((x) => x.code === 'E_CF_OVERHEAD_UNSOUND');
  assert.notEqual(refusal, undefined, 'the unsound code fired on the interpreter count alone');
  assert.equal(refusal.leg, 'witness-records-contention', 'the same leg carries the instantaneous reading');
  assert.match(refusal.detail, /observed 41 concurrent node and python3 processes/, 'the observed count is named');
});

test('--floor refuses E_CF_OVERHEAD_UNSOUND when the artifact records a different corpus hash', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('hashdrift');
  const artifact = overheadArtifact(dir, 'overhead.json', { corpus_hash: 'a'.repeat(64) });

  const { r, out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 1, 'the refusal exits non zero');
  const refusal = out.refusals.find((x) => x.code === 'E_CF_OVERHEAD_UNSOUND');
  assert.notEqual(refusal, undefined, 'the unsound code fired');
  assert.equal(refusal.leg, 'corpus-hash-mismatch', 'the leg names which of the 3 fired');
  assert.equal(out.floor, null, 'NO floor number was published');
});

test('the contention constants are declared in the source and are NOT read from the environment', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('envhostile');
  const hot = { load1_start: 0.4, load1_end: 22.5, interpreters_start: 2, interpreters_end: 3 };
  const artifact = overheadArtifact(dir, 'overhead.json', {
    corpus_hash: corpusHashOf(root),
    witness_cpu_count: 8,
    regions: [
      { name: 'f_run', command: 'FIXTURE f_run', repeat: 2, ms: 60000, witness: hot },
      { name: 'f_node', command: 'FIXTURE f_node', repeat: 2, ms: 330000, witness: hot },
      { name: 'sigma', command: 'FIXTURE sigma', repeat: 2, ms: 500, witness: hot },
    ],
  });

  // Every plausible spelling of an override. The refusal must still fire: a
  // constant tuned from outside is a constant that can be tuned until a number
  // passes, which is exactly what this plan refuses.
  const env = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    FERROX_BENCH_CORPUS_ROOT: root,
    MAX_LOAD_PER_CPU: '99',
    FERROX_CF_MAX_LOAD_PER_CPU: '99',
    FERROX_MAX_LOAD_PER_CPU: '99',
    MAX_CONCURRENT_INTERPRETERS: '9999',
    FERROX_CF_MAX_CONCURRENT_INTERPRETERS: '9999',
    FERROX_CF_WIDTH_FLOOR: '1',
    WIDTH_FLOOR: '1',
  };
  const r = spawnSync(process.execPath, [SCRIPT, '--floor', '--overhead', artifact, '--raw'], {
    encoding: 'utf8', cwd: REPO_ROOT, env, timeout: 180000, maxBuffer: 32 * 1024 * 1024,
  });
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 1, 'the refusal still exits non zero under a hostile environment');
  assert.ok(codesOf(out).includes('E_CF_OVERHEAD_UNSOUND'), 'the contention refusal is not overridable from the environment');
});

// ─── the positive arm, with the arithmetic recomputed by hand ────────────────

test('the positive arm prints a numeric L_min with its 5 inputs, and a hand recomputation agrees', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('sound');
  const artifact = overheadArtifact(dir, 'overhead.json', { corpus_hash: corpusHashOf(root) });

  const { r, out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 0, `a sound artifact over a sound corpus exits 0. stderr:\n${r.stderr}`);
  assert.equal(out.refusals.length, 0, 'no refusal fired');
  assert.notEqual(out.floor, null, 'a floor block was published');

  const n = out.nodes;
  const m = out.rounds;
  const f = out.floor;
  assert.equal(f.f_run_ms, 60000, 'F_run is published');
  assert.equal(f.f_node_ms, 30000, 'F_node is published');
  assert.equal(f.sigma_ms, 500, 'sigma is published');
  assert.equal(n, 11, 'N is published beside them');
  assert.equal(m, 5, 'M is published beside them');

  const byHand = Math.round((f.f_run_ms + m * f.f_node_ms + f.sigma_ms) / (n - m));
  assert.equal(byHand, 35083, 'the hand computation of (60000 + 5 * 30000 + 500) / 6 is 35083');
  assert.equal(f.l_min_ms, byHand, 'the published L_min equals its own arithmetic');

  const text = run(['--floor', '--overhead', artifact], root).stdout;
  assert.match(text, /^l_min_arithmetic: \(60000 \+ 5 \* 30000 \+ 500\) \/ \(11 - 5\) = 35083$/m, 'the arithmetic that produced it is published, so a reader can recompute it by hand');
});

test('a sound artifact does NOT trip the unsound refusal, so the refusal is a discriminator', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('sound-control');
  const artifact = overheadArtifact(dir, 'overhead.json', { corpus_hash: corpusHashOf(root) });
  const { out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(codesOf(out).filter((c) => c === 'E_CF_OVERHEAD_UNSOUND').length, 0, 'a sound artifact passes');
  assert.equal(codesOf(out).filter((c) => c === 'E_CF_OVERHEAD_UNMEASURED').length, 0, 'a named artifact passes');
  assert.ok(out.floor.commands.length >= 3, 'the commands it timed are republished beside the figures');
  assert.equal(out.floor.commands[0].name, 'f_run', 'each figure names the command it was timed from');
});

// ─── the headroom refusal ────────────────────────────────────────────────────

test('a corpus where N equals M refuses E_CF_NO_HEADROOM and prints NO latency number at all', () => {
  const root = fixture('chain', chainCorpus);
  const { r, out } = runRaw(['--structure'], root);

  assert.equal(out.task_count, 1, 'the fixture holds 1 task');
  assert.equal(out.nodes, 4, 'a chain of 4 plans 4 nodes');
  assert.equal(out.rounds, 4, 'a chain replays into 4 rounds of 1');
  assert.equal(out.nodes, out.rounds, 'N equals M');
  assert.equal(out.denominator, 0, 'the denominator is 0');
  assert.ok(codesOf(out).includes('E_CF_NO_HEADROOM'), 'the headroom code fired');
  assert.equal(r.status, 1, 'the refusal exits non zero');

  const text = run(['--structure'], root).stdout;
  assert.doesNotMatch(text, /l_min_ms/, 'no L_min number is printed');
  assert.doesNotMatch(text, /l_min_s/, 'no L_min in seconds either');
  assert.match(text, /stated rather than reported as a very large number/, 'the refusal states the structural fact instead');
});

test('--floor over a corpus with no headroom publishes no floor even with a sound artifact', () => {
  const root = fixture('chain', chainCorpus);
  const dir = scratch('chainfloor');
  const artifact = overheadArtifact(dir, 'overhead.json', { corpus_hash: corpusHashOf(root) });

  const { r, out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 1, 'the refusal exits non zero');
  assert.ok(codesOf(out).includes('E_CF_NO_HEADROOM'), 'the headroom code fired');
  assert.equal(out.floor, null, 'no floor was published, because the arithmetic has no positive denominator');
});

// ─── the gate refusal, 3 legs and a control ──────────────────────────────────

function gateBase(extraSingles) {
  return {
    multis: [wideMulti('alpha')],
    singles: extraSingles,
  };
}

test('E_CF_GATE_CANNOT_FAIL leg 1: a task carrying no hidden gate', () => {
  const root = fixture('gate-nohidden', () => buildCorpus('gate-nohidden', gateBase([
    { id: 'bare', hidden: false },
    { id: 'sound', mutant: true, shallow: true },
  ])));
  const { r, out } = runRaw(['--structure'], root);

  assert.equal(out.task_count, 3, 'the fixture holds 3 tasks');
  assert.ok(out.gate_legs.length > 0, 'at least 1 leg fired, asserted before the property below');
  const leg = out.gate_legs.find((l) => l.task === 'bare');
  assert.notEqual(leg, undefined, 'the bare task tripped a leg');
  assert.equal(leg.leg, 'no-hidden-gate', 'the leg is the missing hidden gate');
  assert.equal(out.gate_legs.filter((l) => l.task === 'sound').length, 0, 'the sound task tripped nothing');
  assert.ok(codesOf(out).includes('E_CF_GATE_CANNOT_FAIL'), 'the gate code fired');
  assert.equal(r.status, 1, 'the refusal exits non zero');
});

test('E_CF_GATE_CANNOT_FAIL leg 2: a mutant fixture that is PRESENT and scores FULL on the visible gate', () => {
  const root = fixture('gate-mutantfull', () => buildCorpus('gate-mutantfull', gateBase([
    { id: 'weak', mutant: true, mutantFull: true, shallow: true },
    { id: 'sound', mutant: true, shallow: true },
  ])));
  const { r, out } = runRaw(['--structure'], root);

  assert.ok(out.gate_legs.length > 0, 'at least 1 leg fired');
  const leg = out.gate_legs.find((l) => l.task === 'weak');
  assert.notEqual(leg, undefined, 'the weak task tripped a leg');
  assert.equal(leg.leg, 'mutant-scores-full-on-visible', 'the leg is the mutant scoring full');
  assert.match(leg.detail, /scores 3\/3 on the visible gate/, 'the observed score is named');
  assert.equal(out.gate_legs.filter((l) => l.task === 'sound').length, 0, 'the sound task tripped nothing');
  assert.equal(r.status, 1, 'the refusal exits non zero');
});

test('E_CF_GATE_CANNOT_FAIL leg 3: a shallow fixture that is PRESENT and scores FULL on the hidden gate', () => {
  const root = fixture('gate-shallowfull', () => buildCorpus('gate-shallowfull', gateBase([
    { id: 'thin', mutant: true, shallow: true, shallowFull: true },
    { id: 'sound', mutant: true, shallow: true },
  ])));
  const { r, out } = runRaw(['--structure'], root);

  assert.ok(out.gate_legs.length > 0, 'at least 1 leg fired');
  const leg = out.gate_legs.find((l) => l.task === 'thin');
  assert.notEqual(leg, undefined, 'the thin task tripped a leg');
  assert.equal(leg.leg, 'shallow-scores-full-on-hidden', 'the leg is the shallow fixture scoring full');
  assert.match(leg.detail, /scores 3\/3 on the hidden gate/, 'the observed score is named');
  assert.equal(out.gate_legs.filter((l) => l.task === 'sound').length, 0, 'the sound task tripped nothing');
  assert.equal(r.status, 1, 'the refusal exits non zero');
});

test('the gate control: a task satisfying all 3 conditions trips NOTHING, so the refusal is not a blanket', () => {
  const root = fixture('model', modelCorpus);
  const { r, out } = runRaw(['--structure'], root);
  assert.ok(out.task_count > 0, 'the scope is non empty');
  assert.equal(out.gate_legs.length, 0, 'no leg fired over a sound corpus');
  assert.equal(codesOf(out).filter((c) => c === 'E_CF_GATE_CANNOT_FAIL').length, 0, 'the gate code did not fire');
  assert.equal(r.status, 0, 'the sound corpus exits 0');
});

test('FF-B323: the ABSENCE of a mutant or shallow fixture is NOT the refusal condition', () => {
  // s2 and s3 in the model corpus own neither a mutant nor a shallow fixture, and
  // plan 04 runs --structure before its own fixtures exist. A check that refused
  // on absence would make that plan unable to pass its own verification.
  const root = fixture('model', modelCorpus);
  const { out } = runRaw(['--structure'], root);
  assert.ok(out.tasks.includes('s2'), 's2 is in scope');
  assert.ok(out.tasks.includes('s3'), 's3 is in scope');
  assert.equal(out.gate_legs.filter((l) => l.task === 's2').length, 0, 'a task with no mutant fixture trips nothing');
  assert.equal(out.gate_legs.filter((l) => l.task === 's3').length, 0, 'a task with no shallow fixture trips nothing');
});

// ─── the non zero task count, asserted before any property ───────────────────

test('a corpus holding 0 tasks in scope is REFUSED rather than reported', () => {
  const root = scratch('empty');
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'multi'), { recursive: true });

  const r = run(['--structure'], root);
  assert.equal(r.status, 1, 'an empty scope exits non zero');
  assert.match(r.stderr, /E_CF_NO_TASKS/, 'the no tasks code fired');
  assert.match(r.stderr, /vacuously true of an empty one/, 'the refusal states why 0 tasks is not a floor');
  assert.doesNotMatch(r.stdout, /rounds:/, 'no property over the task set was published');
});

test('--tasks naming a task the corpus does not hold is REFUSED by name', () => {
  const root = fixture('model', modelCorpus);
  const r = run(['--structure', '--tasks', 'nosuchtask'], root);
  assert.equal(r.status, 1, 'the refusal exits non zero');
  assert.match(r.stderr, /E_CF_TASK_UNKNOWN/, 'the unknown task code fired');
  assert.match(r.stderr, /nosuchtask/, 'the refusal names the task it could not find');
});

// ─── the output NAMES its shape and its subset ───────────────────────────────

test('the output names the shape and the task subset, and both change with the subset', () => {
  const root = fixture('model', modelCorpus);

  const full = runRaw(['--structure'], root).out;
  const subset = runRaw(['--structure', '--tasks', 'alpha,s1'], root).out;

  assert.equal(full.shape, 'within-task', 'the full run names its shape');
  assert.equal(subset.shape, 'within-task', 'the subset run names its shape');
  assert.equal(full.task_count, 5, 'the full scope carries 5 tasks');
  assert.equal(subset.task_count, 2, 'the subset carries 2 tasks');
  assert.notDeepEqual(full.tasks, subset.tasks, 'the NAMED subset changed');
  assert.notEqual(full.nodes, subset.nodes, 'the numbers changed with it');
  assert.notEqual(full.rounds, subset.rounds, 'the round count changed with it');

  const text = run(['--structure', '--tasks', 'alpha,s1'], root).stdout;
  assert.match(text, /^shape: within-task$/m, 'the human output names the shape');
  assert.match(text, /^tasks: alpha,s1$/m, 'the human output names the subset');
  assert.match(text, /^task_count: 2$/m, 'the human output names the subset size');
});

test('a floor computed for 1 subset cannot silently describe another', () => {
  const root = fixture('model', modelCorpus);
  const a = runRaw(['--structure', '--tasks', 'alpha,beta'], root).out;
  const b = runRaw(['--structure', '--tasks', 's1,s2,s3'], root).out;
  assert.deepEqual(a.tasks, ['alpha', 'beta'], 'the first run names its own subset');
  assert.deepEqual(b.tasks, ['s1', 's2', 's3'], 'the second run names its own subset');
  assert.notEqual(a.nodes, b.nodes, '2 different subsets produce 2 different node counts');
});

// ─── D8a: the claim rendered over an input that CONTRADICTS it ───────────────

test('D8a: the discrimination claim is ABSENT over a corpus that cannot discriminate', () => {
  const root = fixture('chain', chainCorpus);
  const dir = scratch('claim-absent');
  const artifact = overheadArtifact(dir, 'overhead.json', { corpus_hash: corpusHashOf(root) });

  const r = run(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 1, 'the run refused');
  assert.match(r.stdout, /nodes: 4/, 'the run did produce output, so the absence below is not the absence of a run');
  assert.doesNotMatch(r.stdout, /^claim:/m, 'the discrimination sentence does NOT appear over a corpus where it is false');
  assert.doesNotMatch(r.stdout, /can separate a fleet from a serial arm/, 'no wording of the claim appears anywhere');

  const { out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.equal(out.floor, null, 'the raw payload carries no claim either');
});

test('D8a: the discrimination claim is PRESENT over a corpus that can discriminate', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('claim-present');
  const artifact = overheadArtifact(dir, 'overhead.json', { corpus_hash: corpusHashOf(root) });

  const r = run(['--floor', '--overhead', artifact], root);
  assert.equal(r.status, 0, 'the run did not refuse');
  assert.match(r.stdout, /^claim: this corpus can separate a fleet from a serial arm at a computed width of 3/m, 'the sentence appears');
  assert.match(r.stdout, /provided each node costs a real agent more than 35083 ms/, 'the sentence carries the floor it depends on');

  const { out } = runRaw(['--floor', '--overhead', artifact], root);
  assert.notEqual(out.floor.claim, null, 'the raw payload carries the claim');
  assert.match(out.floor.claim, /within-task over 5 tasks/, 'the claim names the shape and the subset it describes');
});

test('D8a: the claim names its own shape and subset, and both change with the subset', () => {
  const root = fixture('model', modelCorpus);
  const dir = scratch('claim-attrib');
  const artifact = overheadArtifact(dir, 'overhead.json', { corpus_hash: corpusHashOf(root) });

  const full = runRaw(['--floor', '--overhead', artifact], root).out;
  const subset = runRaw(['--floor', '--overhead', artifact, '--tasks', 'alpha,s1,s2,s3'], root).out;

  assert.notEqual(full.floor, null, 'the full run published a claim');
  assert.notEqual(subset.floor, null, 'the subset run published a claim');
  assert.notEqual(full.floor.claim, subset.floor.claim, 'the 2 claims are not the same sentence');
  assert.match(full.floor.claim, /over 5 tasks/, 'the full claim names 5 tasks');
  assert.match(subset.floor.claim, /over 4 tasks/, 'the subset claim names 4 tasks');
  assert.notEqual(full.floor.l_min_ms, subset.floor.l_min_ms, 'the floor changed with the subset');
});

// ─── the mode guard ──────────────────────────────────────────────────────────

test('the instrument rejects an unknown flag by name rather than ignoring it', () => {
  const root = fixture('model', modelCorpus);
  const r = run(['--structure', '--widht', '3'], root);
  assert.equal(r.status, 1, 'the unknown flag exits non zero');
  assert.match(r.stderr, /unknown flag --widht/, 'the flag is named');
});

test('the instrument refuses 2 modes at once and refuses none at all', () => {
  const root = fixture('model', modelCorpus);
  const both = run(['--structure', '--floor'], root);
  assert.equal(both.status, 1, '2 modes at once is refused');
  assert.match(both.stderr, /contradict each other/, 'the refusal says why');

  const neither = run([], root);
  assert.equal(neither.status, 1, 'no mode at all is refused');
  assert.match(neither.stderr, /needs 1 of --structure, --floor or --measure-overhead/, 'the refusal names the modes');
});

test('FF-B322: --width applies the SAME min the runner applies and can never exceed the permitted width', () => {
  const root = fixture('model', modelCorpus);
  const narrow = runRaw(['--structure', '--width', '2'], root).out;
  const wide = runRaw(['--structure', '--width', '99'], root).out;
  const plan = runPlanOnly(['--shape', 'within-task'], root);

  assert.equal(narrow.schedule_cap, 2, 'a narrower width is honoured');
  assert.equal(wide.schedule_cap, plan.permitted_width, 'a wider width is clamped to the permitted width');
  assert.equal(wide.schedule_cap, 3, 'the clamp lands on the producer\'s number');
  assert.notEqual(narrow.rounds, wide.rounds, 'the cap changes the schedule, so it is load bearing');
});

// ─── --measure-overhead, driven against stubs sleeping a known interval ──────

/** A stub that sleeps a known interval and exits. It is a real child process. */
function sleepStub(dir, name, ms) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, [
    "'use strict';",
    `const until = Date.now() + ${ms};`,
    'const wait = () => { if (Date.now() < until) setTimeout(wait, 5); };',
    'wait();',
    '',
  ].join('\n'));
  return full;
}

test('--measure-overhead records the figures its stubs produced, names every command, and populates the witness', () => {
  const root = fixture('straddle', straddleCorpus);
  const dir = scratch('measure');
  const slow = sleepStub(dir, 'slow.cjs', 300);
  const fast = sleepStub(dir, 'fast.cjs', 60);
  const out = path.join(dir, 'overhead.json');

  const r = run([
    '--measure-overhead',
    '--f-run-cmd', `node ${JSON.stringify(slow)}`,
    '--f-node-cmd', `node ${JSON.stringify(fast)}`,
    '--sigma-cmd', `node ${JSON.stringify(fast)}`,
    '--repeat', '2',
    '--out', out,
    '--raw',
  ], root);
  assert.equal(r.status, 0, `the measurement completed. stderr:\n${r.stderr}`);

  const payload = JSON.parse(r.stdout);
  const a = payload.artifact;
  assert.equal(a.regions.length, 3, '3 regions were timed');

  // THE RECORDED FIGURES REFLECT THE STUBS. The slow stub sleeps 5 times the fast
  // one, so f_run must land well above the raw f_node region and both must clear
  // their own sleep.
  const fRun = a.regions.find((x) => x.name === 'f_run');
  const fNode = a.regions.find((x) => x.name === 'f_node');
  assert.ok(fRun.ms >= 300, `f_run recorded ${fRun.ms} ms, at or above the 300 ms its stub slept`);
  assert.ok(fNode.ms >= 60, `f_node recorded ${fNode.ms} ms, at or above the 60 ms its stub slept`);
  assert.ok(fRun.ms > fNode.ms, 'the slower stub recorded the larger figure, so the figures are not constant');

  // EVERY FIGURE NAMES THE COMMAND IT TIMED.
  for (const region of a.regions) {
    assert.ok(region.command.length > 0, `${region.name} names the command it timed`);
    assert.equal(region.repeat, 2, `${region.name} states its repeat count`);
    assert.equal(region.samples_ms.length, 2, `${region.name} kept 1 sample per repeat`);
  }

  // THE WITNESS IS POPULATED AND NUMERIC.
  assert.equal(typeof a.witness_cpu_count, 'number', 'the CPU count is numeric');
  assert.ok(a.witness_cpu_count > 0, 'the CPU count is positive');
  for (const region of a.regions) {
    for (const key of ['load1_start', 'load1_end', 'interpreters_start', 'interpreters_end']) {
      assert.equal(typeof region.witness[key], 'number', `${region.name} witness ${key} is numeric`);
      assert.ok(region.witness[key] >= 0, `${region.name} witness ${key} is not negative`);
    }
  }

  // THE ARTIFACT NAMES WHAT IT DIVIDED BY AND WHICH CORPUS SIGMA DESCRIBES.
  assert.equal(a.nodes_divided_by, 5, 'the node count divided by is recorded');
  assert.equal(a.f_node_ms, Math.round(fNode.ms / 5), 'f_node_ms is the region divided by the node count');
  assert.equal(a.corpus_hash, corpusHashOf(root), 'the corpus hash sigma was measured against is recorded');

  // IT IS A .json ARTIFACT AND NOT A .jsonl RUN RECORD.
  assert.ok(fs.existsSync(out), 'the artifact was written');
  assert.equal(path.extname(out), '.json', 'the artifact is .json so the report arm loader cannot read it as an arm');
  const onDisk = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(onDisk.schema, 'bench-corpus-floor-overhead/v1', 'the artifact carries its schema');
});

test('--measure-overhead REFUSES to guess what to time when a command is not named', () => {
  const root = fixture('straddle', straddleCorpus);
  const dir = scratch('measure-unnamed');
  const stub = sleepStub(dir, 'fast.cjs', 30);

  const missingNode = run(['--measure-overhead', '--f-run-cmd', `node ${JSON.stringify(stub)}`], root);
  assert.equal(missingNode.status, 1, 'a missing per node command is refused');
  assert.match(missingNode.stderr, /E_CF_OVERHEAD_UNMEASURED/, 'the unmeasured code fired');
  assert.match(missingNode.stderr, /does not guess/, 'the refusal says why it will not default');

  const missingRun = run(['--measure-overhead', '--f-node-cmd', `node ${JSON.stringify(stub)}`], root);
  assert.equal(missingRun.status, 1, 'a missing per run command is refused');
  assert.match(missingRun.stderr, /E_CF_OVERHEAD_UNMEASURED/, 'the unmeasured code fired');
});

test('an artifact written by --measure-overhead is accepted by --floor, so the 2 halves agree on 1 shape', () => {
  const root = fixture('straddle', straddleCorpus);
  const dir = scratch('roundtrip');
  const stub = sleepStub(dir, 'fast.cjs', 40);
  const out = path.join(dir, 'overhead.json');

  const measured = run([
    '--measure-overhead',
    '--f-run-cmd', `node ${JSON.stringify(stub)}`,
    '--f-node-cmd', `node ${JSON.stringify(stub)}`,
    '--sigma-cmd', `node ${JSON.stringify(stub)}`,
    '--repeat', '1',
    '--out', out,
  ], root);
  assert.equal(measured.status, 0, 'the measurement completed');

  const { out: floored } = runRaw(['--floor', '--overhead', out], root);
  // AN ARTIFACT 1 PLAN PROMISES AND ANOTHER CONSUMES IN A DIFFERENT SHAPE is the
  // failure mode a split introduces, and this arm is where it is closed. It
  // asserts the SHAPE agreement and NOT the quiet of the machine: this suite runs
  // beside 2 sibling suites in parallel worktrees, and FF-B257 records what that
  // does. A contended witness is the guard WORKING, so the contention leg is the
  // 1 leg this arm tolerates, and it is named rather than silently allowed.
  const legs = floored.refusals.map((x) => x.leg);
  assert.equal(codesOf(floored).filter((c) => c === 'E_CF_OVERHEAD_UNMEASURED').length, 0, 'the written artifact names its commands and carries its figures');
  assert.equal(legs.filter((l) => l === 'no-contention-witness').length, 0, 'the written artifact carries a COMPLETE witness, so the shapes agree');
  assert.equal(legs.filter((l) => l === 'corpus-hash-mismatch').length, 0, 'the written artifact records the corpus it measured, so the hashes agree');

  const tolerated = new Set(['witness-records-contention']);
  const untolerated = floored.refusals.filter((x) => !tolerated.has(x.leg));
  assert.equal(untolerated.length, 0, `the only refusal a sound round trip may raise is the contention one. Got: ${JSON.stringify(untolerated)}`);

  if (legs.includes('witness-records-contention')) {
    // The machine was busy while this suite ran, which is the FF-B257 case, and
    // the instrument refused rather than publishing a contended figure.
    assert.equal(floored.floor, null, 'a contended measurement publishes NO floor, which is the refusal doing its work');
  } else {
    assert.notEqual(floored.floor, null, 'a quiet measurement publishes a floor from a real round trip');
    assert.equal(typeof floored.floor.l_min_ms, 'number', 'L_min is numeric');
  }
});

// ─── THE REAL CORPUS SCOPE ARM ───────────────────────────────────────────────

/**
 * The bar this phase set: at least 1 refusal observed firing on the REAL corpus
 * at the REAL scope, not only against a scratch fixture. This corpus produces 2.
 *
 * It also excludes both wrong models BY VALUE on the real input, which is the
 * check the 2 rejected drafts of this plan could not have passed.
 */
test('the REAL corpus at the REAL scope replays to 18 rounds, which is NEITHER 14 nor 32', () => {
  const { r, out } = runRaw(['--structure']);

  assert.equal(out.task_count, 20, 'the corpus holds 20 tasks, asserted before every property below');
  assert.ok(out.task_count > 0, 'the scope is non empty');
  assert.equal(out.shape, 'within-task', 'the run names its shape');
  assert.equal(out.nodes, 41, 'N is 41');
  assert.equal(out.schedule_cap, 3, 'the cap is 3');

  assert.equal(out.rounds, 18, 'M is 18, the shipped loop replayed');
  assert.equal(out.denominator, 23, 'the denominator N minus M is 23');

  assert.equal(out.model_closed_form_would_be, 14, 'the closed form would have said 14');
  assert.equal(out.model_per_task_sum_would_be, 32, 'the per task summation would have said 32');
  assert.notEqual(out.rounds, 14, 'M is NOT the closed form answer');
  assert.notEqual(out.rounds, 32, 'M is NOT the per task summation answer');

  assert.deepEqual(
    out.batch_sizes,
    [3, 3, 1, 2, 3, 1, 3, 2, 3, 2, 3, 2, 2, 3, 1, 3, 2, 2],
    'the published batch sizes are the ones the shipped loop produces',
  );
  assert.equal(out.batch_sizes.reduce((s, n) => s + n, 0), 41, 'the batch sizes sum to 41');
  assert.equal(r.status, 1, 'the real corpus still refuses, which is the finding');
});

test('the REAL corpus straddles tasks, so the replay is provably not a per task summation', () => {
  const { out } = runRaw(['--structure']);
  assert.ok(out.straddling_batches.length > 0, 'at least 1 batch straddles on the real input');
  const seam = out.straddling_batches.find((b) => b.nodes.includes('ledger/cli.py'));
  assert.notEqual(seam, undefined, 'the ledger seam node shares a batch with the next task');
  assert.equal(seam.round, 5, 'it is round 5');
  assert.deepEqual(
    seam.nodes,
    ['ledger/cli.py', 'merge_patch', 'parse_duration'],
    'round 5 carries ledger/cli.py with merge_patch and parse_duration',
  );
  assert.deepEqual(
    seam.tasks,
    ['ledger', 'merge_patch', 'parse_duration'],
    'round 5 spans the ledger task and 2 single file tasks',
  );
});

/**
 * THE BEFORE AND THE AFTER OF E_CF_WIDTH_FLOOR, HELD IN 1 CASE.
 *
 * Plan 23-03 observed this refusal FIRING on the phase 22 corpus at a computed
 * width of 2. Plan 23-04 added 2 tasks that COMPUTE a width of 3, which is the
 * condition that clears it. Both halves are asserted here, because an arm that
 * only recorded the AFTER would be indistinguishable from a guard that stopped
 * being able to fire at all.
 *
 * The BEFORE half runs over the 3 INHERITED multi tasks, which this phase does
 * not modify, so it is a REQUIRED FAILING ARM against real corpus content rather
 * than against a scratch fixture, and it stays reachable for every later phase.
 */
test('E_CF_WIDTH_FLOOR fires on the INHERITED subset at width 2 and NOT on the grown corpus at width 3', () => {
  // BEFORE: the 3 inherited multi tasks, untouched by this phase.
  const before = runRaw(['--structure', '--tasks', 'ledger,router,schedule']);
  assert.equal(before.out.task_count, 3, 'the inherited subset holds 3 tasks, asserted before every property');
  assert.equal(before.out.computed_width_max, 2, 'the inherited subset computes a maximum available width of 2');
  assert.notEqual(before.out.computed_width_max, 3, 'it is NOT the floor of 3');
  assert.ok(codesOf(before.out).includes('E_CF_WIDTH_FLOOR'), 'E_CF_WIDTH_FLOOR FIRES on the inherited subset');
  assert.equal(before.r.status, 1, 'the inherited subset exits non zero');

  // AFTER: the grown corpus.
  const { r, out } = runRaw(['--structure']);
  assert.equal(out.computed_width_max, 3, 'the grown corpus computes a maximum available width of 3');
  assert.equal(out.declared_width_max, 3, 'the maximum DECLARED width is 3');
  assert.equal(
    codesOf(out).includes('E_CF_WIDTH_FLOOR'),
    false,
    'E_CF_WIDTH_FLOOR no longer fires, because the edges now support the floor',
  );

  // The 2 widths are still 2 different numbers, and the corpus now shows both.
  const multis = out.per_task.filter((t) => t.kind === 'multi');
  assert.equal(multis.length, 5, 'the corpus holds 5 multi tasks');
  const wide = multis.filter((m) => m.computed_width === 3).map((m) => m.task).sort();
  const narrow = multis.filter((m) => m.computed_width === 2).map((m) => m.task).sort();
  assert.deepEqual(wide, ['retention', 'txn'], 'the 2 tasks this phase added compute a width of 3');
  assert.deepEqual(narrow, ['ledger', 'router', 'schedule'], 'the 3 inherited tasks still compute a width of 2');
  for (const m of multis) {
    assert.equal(
      m.computed_width,
      m.declared_width,
      `${m.task} computes the width it declares, which is what a sound decomposition looks like`,
    );
    assert.equal(m.computed_depth, m.nodes === 7 ? 4 : 3, `${m.task} computes its depth`);
  }

  assert.equal(r.status, 1, 'the grown corpus still exits non zero, on its remaining gate refusal');
});

test('the REAL corpus fires E_CF_GATE_CANNOT_FAIL naming the inherited tasks that carry no hidden gate', () => {
  const { out } = runRaw(['--structure']);

  assert.ok(out.gate_legs.length > 0, 'at least 1 gate leg fired on the real input');
  const bare = out.gate_legs.filter((l) => l.leg === 'no-hidden-gate').map((l) => l.task).sort();
  assert.deepEqual(
    bare,
    ['b64_strict', 'jwt_alg', 'parse_duration', 'roman_parse', 'safe_eval', 'safe_redirect', 'sanitize_path'],
    'the 7 inherited tasks carrying no hidden gate are named',
  );
  assert.ok(codesOf(out).includes('E_CF_GATE_CANNOT_FAIL'), 'E_CF_GATE_CANNOT_FAIL fires on the REAL input');
  assert.deepEqual(
    codesOf(out).sort(),
    ['E_CF_GATE_CANNOT_FAIL'],
    'exactly 1 refusal fires on the grown corpus, and it is the inherited no-hidden-gate one',
  );
});

test('the REAL corpus order, edges and cap match bench-run.cjs --plan-only invoked directly', () => {
  const { out } = runRaw(['--structure']);
  const plan = runPlanOnly(['--shape', 'within-task']);
  assert.equal(plan.order.length, 41, 'the producer planned 41 nodes');
  assert.deepEqual(out.order, plan.order, 'the total order is the producer\'s');
  assert.deepEqual(out.edges, plan.edges, 'the edges are the producer\'s');
  assert.equal(out.schedule_cap, plan.permitted_width, 'the cap is the producer\'s permitted width');
});

/**
 * The `L_min` step driven ONCE against the REAL corpus at the REAL scope, with a
 * HAND BUILT FIXTURE overhead artifact.
 *
 * THE FIGURES BELOW ARE A FIXTURE AND ARE LABELLED AS ONE EVERYWHERE THEY APPEAR.
 * This plan takes NO real timing: it runs in a wave alongside 2 plans running full
 * node suites in sibling worktrees, and FF-B257 records that CPU contention on
 * this machine converts a `spawnSync` suite into a false red. A fixed overhead
 * timed under that load is not the fleet's fixed overhead, and it propagates
 * straight into `L_min`, which the plan that spends money compares its measured
 * latency against. An inflated floor produces a WRONG verdict, not a conservative
 * one. The real measurement belongs to plan 04, which is alone in its wave.
 */
test('the L_min step runs end to end over the REAL corpus with a FIXTURE overhead of 60 s and 30 s', () => {
  const dir = scratch('realfloor');
  const artifact = overheadArtifact(dir, 'overhead.json', {
    corpus_hash: corpusHashOf(undefined),
    f_run_ms: 60000,
    f_node_ms: 30000,
    sigma_ms: 0,
    nodes_divided_by: 41,
  });

  const { r, out } = runRaw(['--floor', '--overhead', artifact]);
  assert.equal(out.nodes, 41, 'the real N');
  assert.equal(out.rounds, 18, 'the real replayed M');
  assert.equal(out.denominator, 23, 'the real denominator');
  assert.notEqual(out.floor, null, 'a corpus QUALITY refusal leaves the arithmetic defined, so the floor is published beside it');
  assert.equal(out.floor.l_min_ms, 26087, '(60000 + 18 * 30000 + 0) / 23 is 26087 ms');
  assert.equal(out.floor.l_min_ms, Math.round((60000 + 18 * 30000 + 0) / 23), 'the published floor equals its own arithmetic recomputed by hand');

  // The 2 wrong models would have published a different floor from the SAME inputs.
  assert.equal(Math.round((60000 + 14 * 30000 + 0) / 27), 17778, 'the closed form would have published 17778 ms');
  assert.equal(Math.round((60000 + 32 * 30000 + 0) / 9), 113333, 'the per task summation would have published 113333 ms');
  assert.notEqual(out.floor.l_min_ms, 17778, 'the published floor is NOT the closed form floor');
  assert.notEqual(out.floor.l_min_ms, 113333, 'the published floor is NOT the per task summation floor');

  assert.equal(r.status, 1, 'the real corpus still refuses on its remaining quality condition');
  assert.deepEqual(codesOf(out).sort(), ['E_CF_GATE_CANNOT_FAIL'], 'the 1 refusal that fires on the REAL input');
  assert.match(out.floor.claim, /at a computed width of 3/, 'the claim on the real input names the computed width the edges support');
});

/**
 * `--measure-overhead` WITH NO `--out` WRITES NOWHERE AT ALL.
 *
 * The mode writes only where `--out` points, and every arm in this suite points
 * it at a scratch directory. A mode that wrote a default path would drop a
 * contended figure into the tree the next plan reads from.
 *
 * Plan 23-04 committed a REAL artifact at `.planning/proof/fleet-overhead.json`
 * by naming `--out` explicitly, which is the supported path. So the property this
 * arm holds is that the directory listing is UNCHANGED BY THE RUN, and NOT that
 * the directory holds no overhead artifact: the second is a statement about which
 * plans have run, and it went stale the moment the plan that owns the measurement
 * landed. The count is compared before against after, so a mode that started
 * writing a default path still turns this red.
 */
test('--measure-overhead with no --out writes NO file into .planning/proof', () => {
  const root = fixture('straddle', straddleCorpus);
  const dir = scratch('nooutput');
  const stub = sleepStub(dir, 'fast.cjs', 30);
  const proofDir = path.join(REPO_ROOT, '.planning', 'proof');

  const before = fs.existsSync(proofDir) ? fs.readdirSync(proofDir).sort() : [];
  assert.ok(before.length > 0, 'the proof directory holds files already, so the comparison below is not vacuous');
  const overheadBefore = before.filter((n) => n.includes('overhead')).length;

  const r = run([
    '--measure-overhead',
    '--f-run-cmd', `node ${JSON.stringify(stub)}`,
    '--f-node-cmd', `node ${JSON.stringify(stub)}`,
    '--sigma-cmd', `node ${JSON.stringify(stub)}`,
    '--repeat', '1',
  ], root);
  assert.equal(r.status, 0, 'the measurement completed');
  assert.match(r.stdout, /^out: \(not written\)$/m, 'the mode says plainly that it wrote nothing');

  const after = fs.existsSync(proofDir) ? fs.readdirSync(proofDir).sort() : [];
  assert.deepEqual(after, before, '.planning/proof gained no file');
  assert.equal(
    after.filter((n) => n.includes('overhead')).length,
    overheadBefore,
    'the run added no overhead artifact of its own',
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
