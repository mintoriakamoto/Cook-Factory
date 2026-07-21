'use strict';

/**
 * Wave 4 pack B: the spreadsheets gate (.xlsx deliverables).
 *
 * Runtime discovery: FERROX_GATES_PYTHON, then python3, probed for openpyxl. When no
 * runtime with openpyxl exists, the fixture-dependent tests SKIP with a clear message
 * (documented degradation) while the AST/contract-level checks still run: card parse,
 * inventory sync between gate source and card, py_compile of gate + generators, and
 * requirements pinning. When the `formulas` recalc engine is additionally present, the
 * dynamic-recalc tests run too; otherwise they skip and the degraded static mode is
 * what the pool-assurance tests exercise (mutants are caught in BOTH modes by design).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const gateRunner = require('../ferrox-core/bin/lib/gate-runner.cjs');

const PACK = path.join(__dirname, '..', 'gates', 'spreadsheets');
const GATE = path.join(PACK, 'gate.py');
const GENERATORS = path.join(PACK, 'generators.py');
const CARD_FILE = path.join(PACK, 'card.md');
const REQUIREMENTS = path.join(__dirname, '..', 'requirements-gates.txt');

function probe(bin, args) {
  try {
    execFileSync(bin, args, { stdio: 'ignore', timeout: 60000 });
    return true;
  } catch {
    return false;
  }
}

function findPython() {
  const candidates = [];
  if (process.env.FERROX_GATES_PYTHON) candidates.push(process.env.FERROX_GATES_PYTHON);
  candidates.push('python3');
  for (const bin of candidates) {
    if (probe(bin, ['-c', 'import openpyxl'])) return bin;
  }
  return null;
}

const BARE_PY = probe('python3', ['--version']) ? 'python3' : null;
const PY = findPython();
const HAS_FORMULAS = PY !== null && probe(PY, ['-c', 'import formulas']);

const SKIP_NO_OPENPYXL =
  PY === null
    ? 'no python3 with openpyxl found (set FERROX_GATES_PYTHON or pip install -r requirements-gates.txt); spreadsheet fixture tests skipped'
    : false;
const SKIP_NO_FORMULAS = HAS_FORMULAS
  ? false
  : 'formulas recalc engine not importable; dynamic-recalc test skipped (degraded static mode covered above)';

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let fixtures = null;
function generated() {
  if (fixtures === null) {
    const dir = mkTemp('ss-gate-fix-');
    execFileSync(PY, [GENERATORS, '--out', dir, '--nonce', 'w4packb'], { stdio: 'ignore', timeout: 120000 });
    fixtures = {
      dir,
      config: path.join(dir, 'config.json'),
      reference: path.join(dir, 'reference.xlsx'),
      pool: JSON.parse(fs.readFileSync(path.join(dir, 'pool.json'), 'utf8')),
    };
  }
  return fixtures;
}

function runOn(artifactPath, env = { FERROX_SS_NO_RECALC: '1' }) {
  const fix = generated();
  let stdout = '';
  try {
    stdout = execFileSync(PY, [GATE, '--config', fix.config, artifactPath], {
      encoding: 'utf8',
      timeout: 300000,
      env: { ...process.env, ...env },
    });
  } catch (e) {
    stdout = typeof e.stdout === 'string' ? e.stdout : '';
  }
  return gateRunner.parseGateOutput(stdout);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(files) {
  const repo = mkTemp('ss-gate-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'wave4@ferrox.local']);
  git(repo, ['config', 'user.name', 'Ferrox Wave4']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'hermetic wave4 repo']);
  return repo;
}

function buildCard(referenceUri, pool, rotationK) {
  const mutantYaml = pool
    .map(
      (m) =>
        `    - { id: ${m.id}, class: fluent-but-wrong, why_fluent: catches the ${m.id} class, ` +
        `expected_drop: ${m.expected_drop}, must_fail: [${m.must_fail.join(', ')}], fixture: ${m.fixtureUri} }`
    )
    .join('\n');
  return [
    '---',
    'card: 1',
    'gate_id: spreadsheets',
    'domain: business-docs',
    'tier: 1',
    'disclosure_default: opaque',
    'checks:',
    '  - { id: SS-01, category: execution, desc: recalculates with zero error cells, measures: recalc plus error-token scan }',
    '  - { id: SS-02, category: value, desc: formulas not literals, measures: data_type over declared ranges }',
    '  - { id: SS-03, category: relation, desc: perturbation probe, measures: input mutation moves the observed total }',
    '  - { id: SS-04, category: relation, desc: cross-sheet refs resolve, measures: sheet tokens vs sheetnames }',
    '  - { id: SS-05, category: relation, desc: totals recompute, measures: range sum vs total within tolerance }',
    'validation:',
    `  reference: ${referenceUri}`,
    '  pool_min: 5',
    '  pool_status: full',
    '  mutants:',
    mutantYaml,
    `  rotation_k: ${rotationK}`,
    '---',
    '',
    '## Intent',
    'Wave 4 pack B end-to-end validation card.',
    '',
  ].join('\n');
}

// ---------- contract-level checks (always run) ----------

test('committed card declares the full 5-check inventory and a 5-mutant fluent pool', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.card.gateId, 'spreadsheets');
  assert.deepEqual(
    parsed.card.checks.map((c) => `${c.id}:${c.category}`),
    ['SS-01:execution', 'SS-02:value', 'SS-03:relation', 'SS-04:relation', 'SS-05:relation']
  );
  assert.equal(parsed.card.mutants.length, 5);
  assert.equal(parsed.card.mutants.every((m) => m.mutantClass === 'fluent-but-wrong'), true);
  assert.equal(parsed.card.poolMin, 5);
});

test('gate source inventory matches the card byte for byte', () => {
  const source = fs.readFileSync(GATE, 'utf8');
  const block = /CHECKS = \[([\s\S]*?)\]/.exec(source);
  assert.notEqual(block, null);
  const declared = [...block[1].matchAll(/\("(SS-\d{2})", "(\w+)"\)/g)].map((m) => `${m[1]}:${m[2]}`);
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.deepEqual(declared, parsed.card.checks.map((c) => `${c.id}:${c.category}`));
});

test('generator pool manifest ids and must_fail sets match the committed card', () => {
  const source = fs.readFileSync(GENERATORS, 'utf8');
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  for (const mutant of parsed.card.mutants) {
    assert.equal(source.includes(`"id": "${mutant.id}"`), true, `${mutant.id} generated`);
    for (const id of mutant.mustFail) {
      assert.equal(new RegExp(`"${mutant.id}"[\\s\\S]{0,600}"${id}"`).test(source), true, `${mutant.id} targets ${id}`);
    }
  }
});

test('requirements-gates.txt pins the python runtime exactly', () => {
  const text = fs.readFileSync(REQUIREMENTS, 'utf8');
  assert.match(text, /^openpyxl==3\.1\.5$/m);
  assert.match(text, /^formulas==1\.3\.4$/m);
});

test('gate.py and generators.py compile', { skip: BARE_PY === null ? 'no python3 on PATH' : false }, () => {
  execFileSync(BARE_PY, ['-m', 'py_compile', GATE, GENERATORS], { stdio: 'ignore', timeout: 60000 });
});

// ---------- fixture-dependent checks ----------

test('reference workbook scores 5/5 with zero fails (degraded static mode)', { skip: SKIP_NO_OPENPYXL }, () => {
  const r = runOn(generated().reference);
  assert.deepEqual(r, { score: [5, 5], fails: [] });
});

test('every pool mutant is caught in degraded static mode (drop + must_fail)', { skip: SKIP_NO_OPENPYXL }, () => {
  const fix = generated();
  for (const mutant of fix.pool) {
    const r = runOn(path.join(fix.dir, mutant.file));
    assert.equal(r.fails.length >= mutant.expected_drop, true, `${mutant.id} dropped ${r.fails.length}`);
    const ids = new Set(r.fails.map((f) => f.split(' ')[0]));
    for (const id of mutant.must_fail) {
      assert.equal(ids.has(id), true, `${mutant.id} must fail ${id}, got [${r.fails.join(', ')}]`);
    }
  }
});

test('every emitted FAIL token is v2 and inside the card inventory', { skip: SKIP_NO_OPENPYXL }, () => {
  const fix = generated();
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  const inventory = new Map(parsed.card.checks.map((c) => [c.id, c.category]));
  for (const mutant of fix.pool) {
    const r = runOn(path.join(fix.dir, mutant.file));
    for (const fail of r.fails) {
      const cls = gateRunner.classifyFail(fail);
      assert.equal(cls.v2, true, `${fail} is v2`);
      assert.equal(inventory.get(cls.id), cls.category, `${fail} in inventory`);
    }
  }
});

test('an unreadable artifact fails closed at 0/5', { skip: SKIP_NO_OPENPYXL }, () => {
  const r = runOn(path.join(generated().dir, 'no-such-workbook.xlsx'));
  assert.deepEqual(r.score, [0, 5]);
  assert.equal(r.fails.length, 5);
});

test('e2e: seal reference + pool into a temp store, validateGateCard green, all 5 mutants caught', { skip: SKIP_NO_OPENPYXL }, () => {
  const fix = generated();
  const store = mkTemp('ss-gate-store-');
  const repo = initRepo({ 'README.md': 'clean hermetic repo\n' });

  const ref = seal.sealPut({ content: fs.readFileSync(fix.reference), storeRoot: store });
  assert.equal(ref.ok, true);
  const pool = fix.pool.map((m) => {
    const put = seal.sealPut({ content: fs.readFileSync(path.join(fix.dir, m.file)), storeRoot: store });
    assert.equal(put.ok, true);
    return { ...m, fixtureUri: put.uri };
  });

  const card = buildCard(ref.uri, pool, 5);
  const previous = process.env.FERROX_SS_NO_RECALC;
  process.env.FERROX_SS_NO_RECALC = '1'; // deterministic static mode for the sealed run
  let r;
  try {
    r = seal.validateGateCard(card, {
      repoRoot: repo,
      storeRoot: store,
      runId: 'W4-SS-01',
      gateCmd: [PY, GATE, '--config', fix.config],
      gateScriptPath: GATE,
    });
  } finally {
    if (previous === undefined) delete process.env.FERROX_SS_NO_RECALC;
    else process.env.FERROX_SS_NO_RECALC = previous;
  }
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.runRecord.sampled.length, 5, 'rotation_k 5 samples the full pool');
  assert.deepEqual(r.runRecord.referenceScore, [5, 5]);
  for (const s of r.runRecord.sampled) {
    assert.equal(s.fails.length >= 1, true, `${s.id} was caught`);
  }
});

test('e2e: sealing a workbook that is committed in the repo is rejected, not laundered', { skip: SKIP_NO_OPENPYXL }, () => {
  const fix = generated();
  const store = mkTemp('ss-gate-store-');
  const bytes = fs.readFileSync(fix.reference);
  const repo = initRepo({ 'models/committed-model.xlsx': bytes });

  const ref = seal.sealPut({ content: bytes, storeRoot: store });
  const pool = fix.pool.map((m) => ({
    ...m,
    fixtureUri: seal.sealPut({ content: fs.readFileSync(path.join(fix.dir, m.file)), storeRoot: store }).uri,
  }));
  const r = seal.validateGateCard(buildCard(ref.uri, pool, 5), { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_FIXTURE_REPO_VISIBLE');
});

test('dynamic recalc mode: reference green, hardcoded-total mutant caught by the perturbation probe', { skip: SKIP_NO_OPENPYXL || SKIP_NO_FORMULAS }, () => {
  const fix = generated();
  const live = { FERROX_SS_NO_RECALC: '' };
  const ref = runOn(fix.reference, live);
  assert.deepEqual(ref, { score: [5, 5], fails: [] });
  const m1 = fix.pool.find((m) => m.id === 'ss-m1');
  const r = runOn(path.join(fix.dir, m1.file), live);
  const ids = new Set(r.fails.map((f) => f.split(' ')[0]));
  assert.equal(ids.has('SS-02') && ids.has('SS-03'), true, `got [${r.fails.join(', ')}]`);
});
