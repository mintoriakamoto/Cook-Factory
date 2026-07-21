'use strict';

/**
 * Wave 3 pack test: gates/test-generation, the flagship RELATIONAL gate.
 *
 * End-to-end through the Wave 1 sealed-gate framework: the committed generator
 * produces the reference bundle and the 5 fluent-but-wrong mutant bundles at
 * test time, they are sealed into a temp FERROX_SEALED_STORE (never a repo),
 * and validateGateCard runs the real gate.py against them. Direct gate runs
 * then prove every pool member is caught for ANY rotation sample (the fixture
 * design guarantees reference kills 10/10 pool mutants and every mutant suite
 * kills 3 or fewer, so verdicts are runId-independent). Per-check unit tests
 * drive the AST scanners (TG-03/TG-04/TG-06) through a python shim.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const gateRunner = require('../ferrox-core/bin/lib/gate-runner.cjs');

const PACK_DIR = path.join(__dirname, '..', 'gates', 'test-generation');
const GATE_PY = path.join(PACK_DIR, 'gate.py');
const GENERATOR = path.join(PACK_DIR, 'fixtures', 'generators', 'generate_fixtures.py');
const CARD_PATH = path.join(PACK_DIR, 'card.md');
const PYTHON = 'python3';
const RUN_ID = 'TG-RUN-01';
const CHECK_TOTAL = 6;

// ---------- helpers ----------

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

/** Hermetic stand-in for the pack repo: the card is committed, fixtures are not. */
function initRepo() {
  const repo = mkTemp('tg-pack-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'tg-pack@ferrox.local']);
  git(repo, ['config', 'user.name', 'Ferrox TG Pack Test']);
  fs.writeFileSync(path.join(repo, 'card.md'), fs.readFileSync(CARD_PATH));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'commit the card, never the fixtures']);
  return repo;
}

/** Run gate.py directly on a bundle file and parse the v2 output contract. */
function runGateDirect(bundlePath, runId) {
  const proc = spawnSync(PYTHON, [GATE_PY, bundlePath], {
    encoding: 'utf8',
    env: { ...process.env, FERROX_RUN_ID: runId || RUN_ID },
    timeout: 300000,
  });
  assert.equal(proc.error, undefined, `gate.py spawn failed: ${proc.error}`);
  return { stdout: proc.stdout, status: proc.status, parsed: gateRunner.parseGateOutput(proc.stdout) };
}

/** Drive the gate module's pure AST scanners through a python shim. */
function runScanners(suiteSource, targetModule) {
  const shim = [
    'import ast, importlib.util, json, sys',
    "spec = importlib.util.spec_from_file_location('tg_gate', sys.argv[1])",
    'gate = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(gate)',
    'tree = ast.parse(sys.stdin.read())',
    'print(json.dumps({',
    "    'assert_free': gate.assert_free_test_functions(tree),",
    "    'self_comparing': gate.self_comparing_asserts(tree),",
    "    'tamper': gate.tamper_findings(tree, sys.argv[2]),",
    '}))',
  ].join('\n');
  const proc = spawnSync(PYTHON, ['-c', shim, GATE_PY, targetModule || 'intervals'], {
    encoding: 'utf8',
    input: suiteSource,
    timeout: 60000,
  });
  assert.equal(proc.status, 0, `scanner shim failed: ${proc.stderr}`);
  return JSON.parse(proc.stdout);
}

// ---------- shared setup: generate + seal once ----------

const FIXTURE_DIR = mkTemp('tg-fixtures-');
const STORE_ROOT = mkTemp('tg-sealed-store-');
const MANIFEST = JSON.parse(
  execFileSync(PYTHON, [GENERATOR, '--out', FIXTURE_DIR], { encoding: 'utf8' })
);
const CARD_MARKDOWN = fs.readFileSync(CARD_PATH, 'utf8');
// js-yaml v4 load() is safe by default (DEFAULT_SCHEMA has no code-executing
// tags; the unsafe v3 loader was removed upstream) - same usage as gate-seal.cts.
const CARD_FRONTMATTER = yaml.load(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(CARD_MARKDOWN)[1]);

function bundlePathFor(name) {
  return path.join(FIXTURE_DIR, `${name}.json`);
}

function readBundle(name) {
  return JSON.parse(fs.readFileSync(bundlePathFor(name), 'utf8'));
}

/** Write a variant bundle (reference bundle with a swapped suite) to a temp file. */
function writeVariantBundle(suiteSource) {
  const bundle = readBundle('reference');
  bundle.suite.source = suiteSource;
  const file = path.join(mkTemp('tg-variant-'), 'bundle.json');
  fs.writeFileSync(file, JSON.stringify(bundle));
  return file;
}

for (const name of ['reference', 'tg-m1', 'tg-m2', 'tg-m3', 'tg-m4', 'tg-m5']) {
  const put = seal.sealPut({ filePath: bundlePathFor(name), storeRoot: STORE_ROOT });
  assert.equal(put.ok, true, `sealing ${name} failed`);
}

// ---------- generator + card coherence ----------

test('generator is byte-deterministic across runs', () => {
  const first = execFileSync(PYTHON, [GENERATOR, '--manifest'], { encoding: 'utf8' });
  const second = execFileSync(PYTHON, [GENERATOR, '--manifest'], { encoding: 'utf8' });
  assert.equal(first, second);
  const manifest = JSON.parse(first);
  for (const [name, entry] of Object.entries(MANIFEST)) {
    assert.equal(manifest[name].sha256, entry.sha256, `${name} hash drifted between runs`);
    assert.equal(sha256(fs.readFileSync(bundlePathFor(name))), entry.sha256);
  }
});

test('card declares the relational contract: 6 checks, full fluent pool of 5', () => {
  const parsed = seal.parseGateCard(CARD_MARKDOWN);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.card.gateId, 'test-generation');
  assert.deepEqual(
    parsed.card.checks.map((c) => c.id),
    ['TG-01', 'TG-02', 'TG-03', 'TG-04', 'TG-05', 'TG-06']
  );
  assert.deepEqual(
    parsed.card.checks.map((c) => c.category),
    ['relation', 'relation', 'structure', 'value', 'execution', 'security']
  );
  assert.equal(parsed.card.poolMin, 5);
  assert.equal(parsed.card.poolStatus, 'full');
  assert.equal(parsed.card.rotationK, 2);
  assert.equal(parsed.card.mutants.length, 5);
  assert.equal(parsed.card.mutants.every((m) => m.mustFail.includes('TG-01')), true,
    'every pool member must be exposed by the kill relation');
  // The relational target is the point of the pack: tests scored vs the source.
  assert.notEqual(CARD_FRONTMATTER.relational_target, null);
  assert.match(CARD_FRONTMATTER.relational_target.relation, /mutation-kill/);
  for (const mutant of CARD_FRONTMATTER.validation.mutants) {
    assert.equal(mutant.class, 'fluent-but-wrong');
    assert.equal(typeof mutant.why_fluent, 'string');
  }
});

test('card fixture URIs match the generated bundle hashes exactly', () => {
  const parsed = seal.parseGateCard(CARD_MARKDOWN);
  assert.equal(parsed.card.reference, `sealed:sha256:${MANIFEST.reference.sha256}`);
  for (const mutant of parsed.card.mutants) {
    assert.equal(mutant.fixture, `sealed:sha256:${MANIFEST[mutant.id].sha256}`,
      `card fixture for ${mutant.id} out of sync with the generator - regenerate hashes`);
  }
});

// ---------- end-to-end through the Wave 1 sealed-gate framework ----------

test('e2e: generated fixtures seal + validate green through validateGateCard', () => {
  const repo = initRepo();
  const previousRunId = process.env.FERROX_RUN_ID;
  process.env.FERROX_RUN_ID = RUN_ID;
  let result;
  try {
    result = seal.validateGateCard(CARD_MARKDOWN, {
      repoRoot: repo,
      storeRoot: STORE_ROOT,
      runId: RUN_ID,
      gateCmd: [PYTHON, GATE_PY],
      gateScriptPath: GATE_PY,
    });
  } finally {
    if (previousRunId === undefined) delete process.env.FERROX_RUN_ID;
    else process.env.FERROX_RUN_ID = previousRunId;
  }
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, [], 'pool of 5 meets pool_min, no seeded-grace warning');
  assert.equal(result.runRecord.runId, RUN_ID);
  assert.equal(result.runRecord.gateId, 'test-generation');
  assert.equal(result.runRecord.referenceHash, MANIFEST.reference.sha256);
  assert.deepEqual(result.runRecord.referenceScore, [CHECK_TOTAL, CHECK_TOTAL]);
  assert.equal(result.runRecord.gateScriptHash, sha256(fs.readFileSync(GATE_PY)));
  assert.equal(result.runRecord.sampled.length, 2);
  for (const sampled of result.runRecord.sampled) {
    assert.equal(sampled.hash, MANIFEST[sampled.id].sha256);
    assert.equal(sampled.score[0] < CHECK_TOTAL, true, `${sampled.id} must drop checks`);
  }
});

test('reference suite scores 6/6 with zero FAIL lines', () => {
  const run = runGateDirect(bundlePathFor('reference'));
  assert.deepEqual(run.parsed.score, [CHECK_TOTAL, CHECK_TOTAL]);
  assert.deepEqual(run.parsed.fails, []);
  assert.equal(run.status, 0);
});

// Every pool member is caught, per the card's own declaration (drop + must_fail),
// and every emitted FAIL token conforms to the v2 opaque surface.
for (const mutant of seal.parseGateCard(fs.readFileSync(CARD_PATH, 'utf8')).card.mutants) {
  test(`mutant ${mutant.id} drops >= ${mutant.expectedDrop} and emits ${mutant.mustFail.join('+')}`, () => {
    const run = runGateDirect(bundlePathFor(mutant.id));
    assert.equal(run.parsed.fails.length >= mutant.expectedDrop, true,
      `dropped ${run.parsed.fails.length} < expected_drop ${mutant.expectedDrop}`);
    assert.equal(run.parsed.score[1], CHECK_TOTAL);
    const emitted = new Set();
    for (const fail of run.parsed.fails) {
      const cls = gateRunner.classifyFail(fail);
      assert.equal(cls.v2, true, `non-v2 FAIL token: ${fail}`);
      assert.match(cls.id, /^TG-0[1-6]$/);
      emitted.add(cls.id);
    }
    for (const required of mutant.mustFail) {
      assert.equal(emitted.has(required), true, `${mutant.id} must emit ${required}`);
    }
    assert.notEqual(run.status, 0);
  });
}

// ---------- rotation behavior ----------

test('same FERROX_RUN_ID reproduces byte-identical gate output', () => {
  const first = runGateDirect(bundlePathFor('tg-m4'), 'TG-ROTATE-77');
  const second = runGateDirect(bundlePathFor('tg-m4'), 'TG-ROTATE-77');
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(first.parsed, second.parsed);
});

test('verdicts hold under a different rotation seed', () => {
  // Fixture design guarantee: reference kills the FULL pool and tg-m1 kills
  // none of it, so any sampled subset yields the same verdict.
  const reference = runGateDirect(bundlePathFor('reference'), 'TG-OTHER-SEED-42');
  assert.deepEqual(reference.parsed.score, [CHECK_TOTAL, CHECK_TOTAL]);
  const mutant = runGateDirect(bundlePathFor('tg-m1'), 'TG-OTHER-SEED-42');
  assert.equal(mutant.parsed.fails.includes('TG-01 relation'), true);
});

// ---------- per-check unit tests of the AST scanners ----------

test('TG-03 scanner: assert-free and constant-assert test functions are flagged', () => {
  const scanned = runScanners([
    'import unittest',
    'from intervals import merge_intervals',
    'class TestThings(unittest.TestCase):',
    '    def test_no_assert_at_all(self):',
    '        merge_intervals([[1, 2]])',
    '    def test_only_a_literal_assert(self):',
    '        merge_intervals([[1, 2]])',
    '        assert True',
    '    def test_real_assert(self):',
    '        self.assertEqual(merge_intervals([]), [])',
    '    def test_raises_counts_as_an_assertion(self):',
    '        with self.assertRaises(TypeError):',
    '            merge_intervals(None)',
    'def helper_without_assert():',
    '    return 1',
  ].join('\n'));
  assert.deepEqual(scanned.assert_free, ['test_no_assert_at_all', 'test_only_a_literal_assert']);
});

test('TG-04 scanner: self-comparing shapes are counted, honest asserts are not', () => {
  const flagged = runScanners([
    'import unittest',
    'from intervals import merge_intervals, overlaps',
    'class TestSelfCompare(unittest.TestCase):',
    '    def test_bare_self_compare(self):',
    '        assert merge_intervals([[1, 2]]) == merge_intervals([[1, 2]])',
    '    def test_assert_equal_self_compare(self):',
    '        self.assertEqual(overlaps([1, 5], [4, 9]), overlaps([1, 5], [4, 9]))',
    '    def test_assert_true_wrapping_self_compare(self):',
    '        self.assertTrue(merge_intervals([]) == merge_intervals([]))',
  ].join('\n'));
  assert.equal(flagged.self_comparing, 3);

  const clean = runScanners([
    'import unittest',
    'from intervals import merge_intervals',
    'class TestHonest(unittest.TestCase):',
    '    def test_against_a_literal(self):',
    '        self.assertEqual(merge_intervals([[1, 3], [2, 6]]), [[1, 6]])',
    '    def test_against_a_variable(self):',
    '        expected = [[1, 6]]',
    '        self.assertEqual(merge_intervals([[1, 3], [2, 6]]), expected)',
  ].join('\n'));
  assert.equal(clean.self_comparing, 0);
});

test('TG-06 scanner: tampering channels are flagged, clean suites are not', () => {
  const tampering = runScanners([
    'import unittest',
    'import intervals',
    'from unittest import mock',
    'class TestTamper(unittest.TestCase):',
    '    def test_direct_attribute_assignment(self):',
    '        intervals.merge_intervals = lambda data: data',
    '        assert intervals.merge_intervals([[1, 2]]) == [[1, 2]]',
    '    def test_setattr_on_the_target(self):',
    '        setattr(intervals, "overlaps", lambda a, b: True)',
    '        assert intervals.overlaps([1, 2], [9, 9])',
    '    def test_mock_patch_by_string(self):',
    '        with mock.patch("intervals.total_covered", return_value=7):',
    '            assert intervals.total_covered([]) == 7',
    '    def test_patch_object_on_the_module(self):',
    '        with mock.patch.object(intervals, "merge_intervals", return_value=[]):',
    '            assert intervals.merge_intervals([[1, 2]]) == []',
    '    def test_file_write_channel(self):',
    '        with open("intervals.py", "w") as handle:',
    '            handle.write("")',
    '        assert True is not None',
  ].join('\n'));
  assert.equal(tampering.tamper.length >= 5, true, `expected 5+ findings, got ${JSON.stringify(tampering.tamper)}`);

  const clean = runScanners([
    'import unittest',
    'import intervals',
    'class TestClean(unittest.TestCase):',
    '    def test_reads_are_fine(self):',
    '        with open("notes.txt", "r") as handle:',
    '            pass',
    '        self.assertEqual(intervals.merge_intervals([]), [])',
    '    def test_patching_other_modules_is_out_of_scope(self):',
    '        from unittest import mock',
    '        with mock.patch("os.getcwd", return_value="/tmp"):',
    '            self.assertEqual(intervals.merge_intervals([]), [])',
  ].join('\n'));
  assert.deepEqual(clean.tamper, []);
});

// ---------- execution + integrity paths through the full gate ----------

test('TG-05: a suite failing on the pristine target fails execution and voids the kill score', () => {
  const bundle = writeVariantBundle([
    'import unittest',
    'from intervals import merge_intervals',
    'class TestWrongExpectation(unittest.TestCase):',
    '    def test_wrong_value(self):',
    '        self.assertEqual(merge_intervals([]), [[1]])',
    '',
  ].join('\n'));
  const run = runGateDirect(bundle);
  assert.equal(run.parsed.fails.includes('TG-05 execution'), true);
  assert.equal(run.parsed.fails.includes('TG-01 relation'), true,
    'a red suite must not be credited with kills');
});

test('TG-06 runtime hash catches a target rewrite the static scan cannot see', () => {
  const bundle = writeVariantBundle([
    'import unittest',
    'class TestSneakyRewrite(unittest.TestCase):',
    '    def test_rewrites_the_target_source(self):',
    '        handle = open("intervals.py", chr(119))',
    '        handle.write("def merge_intervals(data):\\n    return data\\n")',
    '        handle.close()',
    '        assert callable(open)',
    '',
  ].join('\n'));
  const run = runGateDirect(bundle);
  assert.equal(run.parsed.fails.includes('TG-06 security'), true,
    'runtime before/after hash must catch a dynamic-mode file write');
});

test('malformed bundle fails closed at 0/6 with the full FAIL surface', () => {
  const file = path.join(mkTemp('tg-malformed-'), 'bundle.json');
  fs.writeFileSync(file, 'not json at all');
  const run = runGateDirect(file);
  assert.deepEqual(run.parsed.score, [0, CHECK_TOTAL]);
  assert.equal(run.parsed.fails.length, CHECK_TOTAL);
  for (const fail of run.parsed.fails) {
    assert.equal(gateRunner.classifyFail(fail).v2, true);
  }
});

test('TG-02 degradation: stdlib trace fallback measures the same executed lines as coverage.py', () => {
  const shim = [
    'import importlib.util, sys',
    "spec = importlib.util.spec_from_file_location('tg_gate', sys.argv[1])",
    'gate = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(gate)',
    'sys.stdout.write(gate.COVERAGE_RUNNER_SOURCE)',
  ].join('\n');
  const runnerSource = execFileSync(PYTHON, ['-c', shim, GATE_PY], { encoding: 'utf8' });
  const bundle = readBundle('reference');
  const runDir = mkTemp('tg-cov-parity-');
  fs.writeFileSync(path.join(runDir, bundle.target.filename), bundle.target.source);
  fs.writeFileSync(path.join(runDir, bundle.suite.filename), bundle.suite.source);
  fs.writeFileSync(path.join(runDir, 'runner.py'), runnerSource);
  const lines = (mode) => {
    const proc = spawnSync(
      PYTHON,
      ['-B', 'runner.py', bundle.target.filename, bundle.suite.filename.slice(0, -3), mode],
      { cwd: runDir, encoding: 'utf8', timeout: 120000 }
    );
    assert.equal(proc.status, 0, `coverage runner (${mode}) failed: ${proc.stderr}`);
    return JSON.parse(proc.stdout.trim().split('\n').pop());
  };
  const viaCoverage = lines('auto');
  const viaTrace = lines('trace');
  assert.equal(viaCoverage.length > 0, true);
  assert.deepEqual(viaTrace, viaCoverage);
});
