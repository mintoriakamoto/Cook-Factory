'use strict';

/**
 * MILESTONE v1.9 Wave 2: the eval-harness-integrity gate pack.
 *
 * Layout under test (gates/eval-harness-integrity/):
 *   gate.py                      the machine gate (python3 stdlib, v2 FAIL surface, 8 checks)
 *   card.md                      the Gate Card with sealed:sha256: fixture references
 *   fixtures/generators/*.cjs    deterministic generators; CONTENT is sealed, never committed
 *
 * 2 layers of coverage:
 *   1. Direct unit tests of every check (EHI-01 .. EHI-08) against minimal perturbations
 *      of the generated reference harness.
 *   2. End-to-end through the Wave 1 sealed framework: generate, seal into a temp
 *      FERROX_SEALED_STORE, validateGateCard() with the real card: reference green, all
 *      5 fluent mutants caught, rotation sampling recorded and replayable, repo-visible
 *      fixture content rejected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const gateRunner = require('../ferrox-core/bin/lib/gate-runner.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PACK_ROOT = path.join(REPO_ROOT, 'gates', 'eval-harness-integrity');
const GATE_PY = path.join(PACK_ROOT, 'gate.py');
const CARD_PATH = path.join(PACK_ROOT, 'card.md');
const SEAL_SCRIPT = path.join(PACK_ROOT, 'fixtures', 'generators', 'seal-fixtures.cjs');
const PYTHON = 'python3';

const lib = require('../gates/eval-harness-integrity/fixtures/generators/harness-lib.cjs');
const { generateReference } = require('../gates/eval-harness-integrity/fixtures/generators/reference.cjs');
const { generateMutants } = require('../gates/eval-harness-integrity/fixtures/generators/mutants.cjs');

const CHECK_CATEGORIES = {
  'EHI-01': 'execution',
  'EHI-02': 'relation',
  'EHI-03': 'relation',
  'EHI-04': 'relation',
  'EHI-05': 'grounding',
  'EHI-06': 'structure',
  'EHI-07': 'security',
  'EHI-08': 'relation',
};

// ---------- helpers ----------

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Run gate.py on a harness (object or raw string) and return { score, fails }. */
function runGateOn(harness) {
  const dir = mkTemp('ehi-gate-');
  const artifactPath = path.join(dir, 'harness.json');
  fs.writeFileSync(artifactPath, typeof harness === 'string' ? harness : JSON.stringify(harness));
  const result = gateRunner.runGate({ gateCmd: [PYTHON, GATE_PY], artifactPath });
  return result; // mkdtemp dirs are left to the OS tmpdir, matching the sibling pack tests
}

function referenceHarness() {
  return JSON.parse(generateReference());
}

function failIds(result) {
  return result.fails.map((f) => f.split(/\s+/, 1)[0]);
}

/** A hermetic git repo, selftest idiom: stands in for a repo that committed fixtures. */
function initRepo(files) {
  const repo = mkTemp('ehi-repo-');
  const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'wave2@ferrox.local']);
  git(['config', 'user.name', 'Ferrox Wave2 Test']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'commit fixtures the burned way']);
  return repo;
}

/** Seal all pack fixtures into a fresh temp store via the build-step script + env var. */
function sealPackFixtures() {
  const store = mkTemp('ehi-store-');
  const out = execFileSync(process.execPath, [SEAL_SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, FERROX_SEALED_STORE: store },
  });
  return { store, out };
}

const CARD_MARKDOWN = fs.readFileSync(CARD_PATH, 'utf8');

// ---------- layer 1: direct unit tests of every check ----------

test('reference harness scores 8/8 with zero fails', () => {
  const result = runGateOn(generateReference());
  assert.deepEqual(result.fails, []);
  assert.deepEqual(result.score, [8, 8]);
});

test('unparseable artifact fails every check and every token is v2 card-conformant', () => {
  const result = runGateOn('this is not json {');
  assert.deepEqual(result.score, [0, 8]);
  assert.equal(result.fails.length, 8);
  for (const fail of result.fails) {
    const cls = gateRunner.classifyFail(fail);
    assert.equal(cls.v2, true, `not a v2 token: ${fail}`);
    assert.equal(cls.category, CHECK_CATEGORIES[cls.id], `category drift: ${fail}`);
  }
});

test('EHI-01: an unknown scorer type is a non-executable harness, all checks fail', () => {
  const harness = referenceHarness();
  harness.scorer = { type: 'llm-vibes' };
  const result = runGateOn(harness);
  assert.deepEqual(result.score, [0, 8]);
  assert.equal(failIds(result).includes('EHI-01'), true);
});

test('EHI-02: a scorer that cannot reach ceiling on its own answer key fails', () => {
  const harness = referenceHarness();
  harness.scorer = { type: 'schema' };
  for (const task of harness.tasks.slice(0, 3)) {
    task.schema = { type: 'string', enum: task.options.filter((o) => o !== task.answer) };
  }
  const result = runGateOn(harness);
  assert.equal(failIds(result).includes('EHI-02'), true, 'gold 0.925 is below the 0.98 ceiling');
});

test('EHI-03: a chance declaration the random stub does not land in fails exactly once', () => {
  const harness = referenceHarness();
  harness.chance_level = 0.5; // actual deterministic random score is 0.25
  const result = runGateOn(harness);
  assert.deepEqual(result.fails, ['EHI-03 relation']);
});

test('EHI-04: the 0.15 delta floor beats a trivially small declared delta', () => {
  const harness = referenceHarness();
  harness.declared_mutant_delta = 0.02;
  harness.mutant_answers = lib.buildMutantAnswers(harness.tasks, 2); // drop 0.05
  const ids = failIds(runGateOn(harness));
  assert.equal(ids.includes('EHI-04'), true);
  assert.equal(ids.includes('EHI-08'), true, 'a 0.95 mutant also overlaps the gold interval');
});

test('EHI-05: an exemplar embedding a test prompt verbatim fails exactly once', () => {
  const harness = referenceHarness();
  harness.exemplars = [
    ...harness.exemplars,
    `Worked example: ${harness.tasks[7].prompt} The reviewer records the accepted label.`,
  ];
  const result = runGateOn(harness);
  assert.deepEqual(result.fails, ['EHI-05 grounding']);
});

test('EHI-06: a task without a compiling schema fails exactly once', () => {
  const harness = referenceHarness();
  delete harness.tasks[4].schema;
  const result = runGateOn(harness);
  assert.deepEqual(result.fails, ['EHI-06 structure']);
});

test('EHI-06: vacuous schemas over the 20 percent ban threshold fail, at it they pass', () => {
  const over = referenceHarness();
  for (const task of over.tasks.slice(0, 9)) task.schema = { type: 'string' }; // 22.5 percent
  assert.deepEqual(runGateOn(over).fails, ['EHI-06 structure']);

  const at = referenceHarness();
  for (const task of at.tasks.slice(0, 8)) task.schema = { type: 'string' }; // 20 percent exactly
  assert.deepEqual(runGateOn(at).fails, []);
});

test('EHI-07: every bypass channel in the scorer config is flagged', () => {
  for (const scorer of [
    { type: 'exact', always_pass: true },
    { type: 'exact', skip_items: ['t01', 't02'] },
    { type: 'exact', known_flaky: ['t03'] },
    { type: 'exact', score_floor: 0.9 },
  ]) {
    const harness = referenceHarness();
    harness.scorer = scorer;
    const ids = failIds(runGateOn(harness));
    assert.equal(ids.includes('EHI-07'), true, `bypass not flagged: ${JSON.stringify(scorer)}`);
  }
});

test('EHI-07: bypass channels are simulated, always_pass collapses calibration too', () => {
  const harness = referenceHarness();
  harness.scorer = { type: 'exact', always_pass: true };
  const ids = failIds(runGateOn(harness));
  for (const id of ['EHI-03', 'EHI-04', 'EHI-07', 'EHI-08']) {
    assert.equal(ids.includes(id), true, `expected ${id} under always_pass`);
  }
});

test('EHI-08: an over-corrupted planted mutant breaks ordering while EHI-04 stays green', () => {
  const harness = referenceHarness();
  harness.mutant_answers = lib.buildMutantAnswers(harness.tasks, 40); // mutant 0.0 < random 0.25
  const ids = failIds(runGateOn(harness));
  assert.equal(ids.includes('EHI-08'), true);
  assert.equal(ids.includes('EHI-04'), false, 'a 1.0 drop satisfies the delta check');
});

test('random-stub derivation is byte-identical across the JS generator and the python gate', () => {
  const ids = ['t01', 't07', 't19', 't28', 't40'];
  const py = execFileSync(
    PYTHON,
    [
      '-c',
      'import hashlib,sys\n' +
        'for t in sys.argv[1:]:\n' +
        '    print(int(hashlib.sha256(t.encode("utf-8")).hexdigest()[:8], 16) % 4)',
      ...ids,
    ],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .map(Number);
  assert.deepEqual(py, ids.map((id) => lib.pickIndex(id, 4)));
});

// ---------- layer 2: generator + card + sealed framework, end to end ----------

test('generators are byte-deterministic and mirror the card fixture hashes exactly', () => {
  assert.equal(sha256(generateReference()), sha256(generateReference()));
  const parsed = seal.parseGateCard(CARD_MARKDOWN);
  assert.equal(parsed.ok, true);
  const card = parsed.card;
  assert.equal(card.gateId, 'eval-harness-integrity');
  assert.equal(card.reference, `sealed:sha256:${sha256(generateReference())}`);

  const pool = generateMutants();
  assert.equal(card.mutants.length, 5);
  assert.equal(pool.length, 5);
  for (let i = 0; i < pool.length; i++) {
    assert.equal(card.mutants[i].id, pool[i].id);
    assert.equal(card.mutants[i].mutantClass, 'fluent-but-wrong');
    assert.equal(card.mutants[i].fixture, `sealed:sha256:${sha256(pool[i].content)}`);
    assert.equal(card.mutants[i].expectedDrop, pool[i].expectedDrop);
    assert.deepEqual(card.mutants[i].mustFail, pool[i].mustFail);
  }
});

test('every pool mutant is caught by a direct gate run at its declared drop and must_fail ids', () => {
  for (const mutant of generateMutants()) {
    const result = runGateOn(mutant.content);
    const ids = failIds(result);
    assert.equal(
      result.fails.length >= mutant.expectedDrop,
      true,
      `${mutant.id} dropped ${result.fails.length} < expected ${mutant.expectedDrop}`
    );
    for (const id of mutant.mustFail) {
      assert.equal(ids.includes(id), true, `${mutant.id} did not emit ${id}`);
    }
  }
});

test('the pack validates end to end through the sealed framework: reference green, rotation recorded', () => {
  const { store, out } = sealPackFixtures();
  assert.match(out, /reference: sealed:sha256:[0-9a-f]{64}/);

  const result = seal.validateGateCard(CARD_MARKDOWN, {
    repoRoot: REPO_ROOT,
    storeRoot: store,
    runId: 'WAVE2-EHI-RUN-01',
    gateCmd: [PYTHON, GATE_PY],
    gateScriptPath: GATE_PY,
    scanDirs: ['gates'],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  // Pool is at pool_min 5: full status, no W_POOL_BELOW_MIN grace warning.
  assert.deepEqual(result.warnings, []);
  // Rotation sampling recorded for replay (ADR decision 2 run-record contract).
  assert.equal(result.runRecord.runId, 'WAVE2-EHI-RUN-01');
  assert.equal(result.runRecord.gateId, 'eval-harness-integrity');
  assert.deepEqual(result.runRecord.referenceScore, [8, 8]);
  assert.equal(result.runRecord.gateScriptHash, sha256(fs.readFileSync(GATE_PY, 'utf8')));
  assert.equal(result.runRecord.sampled.length, 2);
  const poolIds = new Set(generateMutants().map((m) => m.id));
  for (const sampled of result.runRecord.sampled) {
    assert.equal(poolIds.has(sampled.id), true);
    assert.match(sampled.hash, /^[0-9a-f]{64}$/);
    assert.equal(Array.isArray(sampled.fails) && sampled.fails.length >= 1, true);
    assert.equal(sampled.score[1], 8);
  }
});

test('rotation replay: the same runId reproduces the identical mutant sample', () => {
  const { store } = sealPackFixtures();
  const opts = {
    repoRoot: REPO_ROOT,
    storeRoot: store,
    runId: 'WAVE2-EHI-REPLAY',
    gateCmd: [PYTHON, GATE_PY],
    scanDirs: ['gates'],
  };
  const first = seal.validateGateCard(CARD_MARKDOWN, opts);
  const second = seal.validateGateCard(CARD_MARKDOWN, opts);
  assert.equal(first.ok, true);
  assert.deepEqual(
    first.runRecord.sampled.map((s) => s.id),
    second.runRecord.sampled.map((s) => s.id)
  );
});

test('all 5 fluent mutants are caught through the framework when the whole pool is sampled', () => {
  const { store } = sealPackFixtures();
  const wholePoolCard = CARD_MARKDOWN.replace('rotation_k: 2', 'rotation_k: 5');
  assert.notEqual(wholePoolCard, CARD_MARKDOWN);
  const result = seal.validateGateCard(wholePoolCard, {
    repoRoot: REPO_ROOT,
    storeRoot: store,
    runId: 'WAVE2-EHI-FULL-POOL',
    gateCmd: [PYTHON, GATE_PY],
    scanDirs: ['gates'],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.runRecord.sampled.length, 5);
  assert.deepEqual(
    result.runRecord.sampled.map((s) => s.id).sort(),
    ['ehi-m1', 'ehi-m2', 'ehi-m3', 'ehi-m4', 'ehi-m5']
  );
});

test('a burned mutant (one the gate passes) fails the whole validation, not just itself', () => {
  const { store } = sealPackFixtures();
  // Reference content posing as the ehi-m2 mutant: scores 8/8, drops nothing.
  const posed = seal.sealPut({ content: generateReference(), storeRoot: store });
  assert.equal(posed.ok, true);
  const m2Hash = sha256(generateMutants()[1].content);
  const burnedCard = CARD_MARKDOWN.replace('rotation_k: 2', 'rotation_k: 5').replace(m2Hash, posed.hash);
  const result = seal.validateGateCard(burnedCard, {
    storeRoot: store,
    runId: 'WAVE2-EHI-BURNED',
    gateCmd: [PYTHON, GATE_PY],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.some((e) => e.code === 'E_MUTANT_NOT_CAUGHT' && e.mutantId === 'ehi-m2'), true);
});

test('fixture content that is repo-visible is rejected, generators do not launder it', () => {
  const { store } = sealPackFixtures();
  // A repo that committed the generated reference: the exact burned layout Wave 1 rejects.
  const repo = initRepo({ 'fixtures/eval-harness-reference.json': generateReference() });
  const result = seal.validateGateCard(CARD_MARKDOWN, { repoRoot: repo, storeRoot: store });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_FIXTURE_REPO_VISIBLE');
  assert.equal(
    result.errors.some((e) => e.code === 'E_FIXTURE_REPO_VISIBLE' && e.role === 'reference'),
    true
  );
});

test('the generated fixture content is not committed to THIS repo (sealed, not shipped)', () => {
  const repoHashes = seal.collectRepoBlobHashes(REPO_ROOT, { scanDirs: ['gates'] });
  assert.equal(seal.isRepoVisible(sha256(generateReference()), repoHashes), false);
  for (const mutant of generateMutants()) {
    assert.equal(seal.isRepoVisible(sha256(mutant.content), repoHashes), false, `${mutant.id} is repo-visible`);
  }
});
