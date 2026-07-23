'use strict';

/**
 * SEAL-01 self-test (ADR-SEALED-GATES decision 4). Wave 1 is not done until all 3 parts pass:
 *
 *   A. REJECTION: sealing the repo-committed gatebench toposort pair must fail with
 *      E_FIXTURE_REPO_VISIBLE for each colliding fixture (sealing a repo-visible file must
 *      not launder it), plus the E_UNSEALED_FIXTURE and E_SEALED_OBJECT_MISSING cases.
 *   B. POSITIVE CONTROL: the same gate with a freshly authored, never-committed ref+mutant
 *      pair sealed into the store validates green: reference M/M, mutants drop >= expected_drop.
 *   C. ROTATION DETERMINISM: fixed pool of 5, rotation_k 2, pinned runId asserts the exact
 *      expected 2 mutant ids across 3 calls (locks the decision-2 algorithm byte-for-byte;
 *      the pinned vector was computed from an independent reimplementation of the ADR text).
 *
 * The "old standard" being rejected in part A is the gatebench layout: ref+mutant fixture
 * pairs committed next to the task in the repo the builder can read. The pair here is a
 * byte-copy of that layout inside a hermetic temp repo, so the suite passes on any machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const { sampleMutants } = require('../ferrox-core/bin/lib/mutant-rotation.cjs');

const { sealPut, validateGateCard } = seal;

// ---------- helpers ----------

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

/** A hermetic git repo standing in for gatebench: fixture pair committed next to the task. */
function initRepo(files) {
  const repo = mkTemp('gate-seal-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'selftest@ferrox.local']);
  git(repo, ['config', 'user.name', 'Ferrox Selftest']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'commit gate fixtures the old way']);
  return repo;
}

/** The toposort gate script (v2 FAIL surface): nodes a-d, edges a->b, a->c, b->d, c->d. */
const GATE_SCRIPT_SOURCE = [
  "const fs = require('node:fs');",
  'const fails = [];',
  'let order = null;',
  "try { order = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch { /* fall through */ }",
  "if (!Array.isArray(order)) { fails.push('TS-01 structure'); order = []; }",
  "const want = ['a', 'b', 'c', 'd'];",
  'const set = new Set(order);',
  'if (!(order.length === 4 && set.size === 4 && want.every((n) => set.has(n)))) fails.push(\'TS-02 value\');',
  'const pos = {};',
  'order.forEach((n, i) => { pos[n] = i; });',
  "const edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']];",
  "if (!edges.every(([u, v]) => pos[u] !== undefined && pos[v] !== undefined && pos[u] < pos[v])) fails.push('TS-03 relation');",
  "for (const f of fails) console.log('FAIL ' + f);",
  "console.log('gate: ' + (3 - fails.length) + '/3');",
].join('\n');

function writeGateScript() {
  const dir = mkTemp('gate-seal-gate-');
  const file = path.join(dir, 'toposort-gate.cjs');
  fs.writeFileSync(file, GATE_SCRIPT_SOURCE);
  return file;
}

/** Minimal card markdown: frontmatter machine block plus the required prose sections. */
function cardMarkdown({ reference, mutants }) {
  const mutantYaml = mutants
    .map(
      (m) =>
        `    - { id: ${m.id}, class: fluent-but-wrong, why_fluent: ${m.why}, expected_drop: ${m.drop}, must_fail: [${m.mustFail}], fixture: ${m.fixture} }`
    )
    .join('\n');
  return [
    '---',
    'card: 1',
    'gate_id: toposort',
    'domain: code',
    'tier: 1',
    'relational_target: null',
    'disclosure_default: opaque',
    'checks:',
    '  - { id: TS-01, category: structure, desc: artifact parses as a JSON array, measures: JSON.parse on the artifact }',
    '  - { id: TS-02, category: value, desc: node set complete and exact, measures: set equality vs the 4 nodes }',
    '  - { id: TS-03, category: relation, desc: order respects every edge, measures: position comparison per edge }',
    'wrapped_tools:',
    '  - { name: node, version: 22.0.0, license: MIT, role: gate runtime }',
    'validation:',
    `  reference: ${reference}`,
    '  pool_min: 5',
    '  pool_status: seeded',
    '  mutants:',
    mutantYaml,
    '  rotation_k: 2',
    '  last_validated: null',
    'gamed_modes:',
    '  - { mode: memorize the visible reference order, status: sealed, note: sealed fixtures rotate per run }',
    '---',
    '',
    '## Intent',
    'Self-test card for the sealed-gate framework.',
    '',
    '## Gamed-mode rationale',
    'Covered by the rotating sealed pool.',
    '',
    '## Change log',
    '- 2026-07-21 authored by the wave 1 self-test.',
    '',
  ].join('\n');
}

const REF_CONTENT = '["a","b","c","d"]\n';
const MUTANT1_CONTENT = '["a","b","d","c"]\n';
const MUTANT2_CONTENT = '["a","b","c","e"]\n';

// ---------- Test A: the milestone REJECTION criterion ----------

test('A: sealing the repo-committed toposort pair fails E_FIXTURE_REPO_VISIBLE per fixture', () => {
  const repo = initRepo({
    'tasks/specs/toposort.md': '# toposort task spec\n',
    'tasks/fixtures/toposort_ref.json': REF_CONTENT,
    'tasks/fixtures/toposort_mutant1.json': MUTANT1_CONTENT,
    'tasks/fixtures/toposort_mutant2.json': MUTANT2_CONTENT,
  });
  const store = mkTemp('gate-seal-store-');

  // Sealing repo-visible content must not launder it.
  const ref = sealPut({ content: REF_CONTENT, storeRoot: store });
  const m1 = sealPut({ content: MUTANT1_CONTENT, storeRoot: store });
  const m2 = sealPut({ content: MUTANT2_CONTENT, storeRoot: store });
  assert.equal(ref.ok && m1.ok && m2.ok, true);

  const card = cardMarkdown({
    reference: ref.uri,
    mutants: [
      { id: 'ts-m1', why: 'valid-looking permutation that swaps 1 constrained pair', drop: 1, mustFail: 'TS-03', fixture: m1.uri },
      { id: 'ts-m2', why: 'complete-looking order that swaps a node for a stranger', drop: 2, mustFail: 'TS-02', fixture: m2.uri },
    ],
  });
  const r = validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_FIXTURE_REPO_VISIBLE');
  const visible = r.errors.filter((e) => e.code === 'E_FIXTURE_REPO_VISIBLE');
  assert.equal(visible.length, 3, 'each colliding fixture reports its own error');
});

test('A: a fixture deleted from the working tree but present in HEAD still collides', () => {
  const repo = initRepo({
    'tasks/fixtures/toposort_ref.json': REF_CONTENT,
    'tasks/fixtures/toposort_mutant1.json': MUTANT1_CONTENT,
    'tasks/fixtures/toposort_mutant2.json': MUTANT2_CONTENT,
  });
  fs.unlinkSync(path.join(repo, 'tasks/fixtures/toposort_ref.json'));
  const store = mkTemp('gate-seal-store-');
  const ref = sealPut({ content: REF_CONTENT, storeRoot: store });
  const m1 = sealPut({ content: MUTANT1_CONTENT, storeRoot: store });
  const m2 = sealPut({ content: MUTANT2_CONTENT, storeRoot: store });
  const card = cardMarkdown({
    reference: ref.uri,
    mutants: [
      { id: 'ts-m1', why: 'permutation swap', drop: 1, mustFail: 'TS-03', fixture: m1.uri },
      { id: 'ts-m2', why: 'stranger node', drop: 2, mustFail: 'TS-02', fixture: m2.uri },
    ],
  });
  const r = validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_FIXTURE_REPO_VISIBLE');
});

test('A: a fixture reference that is not a sealed:sha256: URI fails E_UNSEALED_FIXTURE', () => {
  const repo = initRepo({ 'README.md': 'clean repo\n' });
  const store = mkTemp('gate-seal-store-');
  const m1 = sealPut({ content: MUTANT1_CONTENT, storeRoot: store });
  const m2 = sealPut({ content: MUTANT2_CONTENT, storeRoot: store });
  const card = cardMarkdown({
    reference: 'tasks/fixtures/toposort_ref.json',
    mutants: [
      { id: 'ts-m1', why: 'permutation swap', drop: 1, mustFail: 'TS-03', fixture: m1.uri },
      { id: 'ts-m2', why: 'stranger node', drop: 2, mustFail: 'TS-02', fixture: m2.uri },
    ],
  });
  const r = validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.errors.some((e) => e.code === 'E_UNSEALED_FIXTURE' && e.role === 'reference'), true);
});

test('A: a sealed URI whose object is absent from the store fails E_SEALED_OBJECT_MISSING', () => {
  const repo = initRepo({ 'README.md': 'clean repo\n' });
  const store = mkTemp('gate-seal-store-');
  const m1 = sealPut({ content: MUTANT1_CONTENT, storeRoot: store });
  const m2 = sealPut({ content: MUTANT2_CONTENT, storeRoot: store });
  const ghost = crypto.createHash('sha256').update('never sealed anywhere', 'utf8').digest('hex');
  const card = cardMarkdown({
    reference: `sealed:sha256:${ghost}`,
    mutants: [
      { id: 'ts-m1', why: 'permutation swap', drop: 1, mustFail: 'TS-03', fixture: m1.uri },
      { id: 'ts-m2', why: 'stranger node', drop: 2, mustFail: 'TS-02', fixture: m2.uri },
    ],
  });
  const r = validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.errors.some((e) => e.code === 'E_SEALED_OBJECT_MISSING'), true);
});

// ---------- Test B: positive control ----------

const FRESH_REF = '["a","c","b","d"]\n';
const FRESH_MUTANT1 = '["c","a","b","d"]\n';
const FRESH_MUTANT2 = '["a","c","b","x"]\n';

test('B: a genuinely non-repo ref+mutant pair seals and validates green', () => {
  const repo = initRepo({ 'tasks/specs/toposort.md': '# toposort task spec\n' });
  const store = mkTemp('gate-seal-store-');
  const gateScript = writeGateScript();

  const ref = sealPut({ content: FRESH_REF, storeRoot: store });
  const m1 = sealPut({ content: FRESH_MUTANT1, storeRoot: store });
  const m2 = sealPut({ content: FRESH_MUTANT2, storeRoot: store });

  const card = cardMarkdown({
    reference: ref.uri,
    mutants: [
      { id: 'ts-m1', why: 'valid-looking order with 1 inverted edge', drop: 1, mustFail: 'TS-03', fixture: m1.uri },
      { id: 'ts-m2', why: 'complete-looking order that swaps a node for a stranger', drop: 2, mustFail: 'TS-02', fixture: m2.uri },
    ],
  });
  const r = validateGateCard(card, {
    repoRoot: repo,
    storeRoot: store,
    runId: 'B-RUN-01',
    gateCmd: [process.execPath, gateScript],
    gateScriptPath: gateScript,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  // Migration grace: pool of 2 validates but warns under pool_min 5.
  assert.equal(r.warnings.some((w) => w.code === 'W_POOL_BELOW_MIN'), true);
  // Run record: runId + gate script hash + reference hash + sampled mutant ids and hashes.
  assert.equal(r.runRecord.runId, 'B-RUN-01');
  assert.equal(r.runRecord.gateId, 'toposort');
  assert.equal(r.runRecord.referenceHash, ref.hash);
  assert.match(r.runRecord.gateScriptHash, /^[0-9a-f]{64}$/);
  assert.equal(r.runRecord.sampled.length, 2);
  for (const s of r.runRecord.sampled) {
    assert.match(s.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(s.score, [expectedMutantScore(s.id), 3]);
  }
  // Reference scored M/M.
  assert.deepEqual(r.runRecord.referenceScore, [3, 3]);
});

function expectedMutantScore(id) {
  return id === 'ts-m1' ? 2 : 1;
}

test('B: a sampled mutant that fails to drop burns the pool and fails validation', () => {
  const repo = initRepo({ 'README.md': 'clean repo\n' });
  const store = mkTemp('gate-seal-store-');
  const gateScript = writeGateScript();

  const ref = sealPut({ content: FRESH_REF, storeRoot: store });
  const passing = sealPut({ content: '["a","b","c","d"]\n', storeRoot: store }); // scores 3/3, drops nothing
  const m2 = sealPut({ content: FRESH_MUTANT2, storeRoot: store });

  const card = cardMarkdown({
    reference: ref.uri,
    mutants: [
      { id: 'ts-m1', why: 'claims to be wrong but the gate passes it', drop: 1, mustFail: 'TS-03', fixture: passing.uri },
      { id: 'ts-m2', why: 'stranger node', drop: 2, mustFail: 'TS-02', fixture: m2.uri },
    ],
  });
  const r = validateGateCard(card, {
    repoRoot: repo,
    storeRoot: store,
    runId: 'B-RUN-02',
    gateCmd: [process.execPath, gateScript],
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors.some((e) => e.code === 'E_MUTANT_NOT_CAUGHT' && e.mutantId === 'ts-m1'), true);
});

test('B: fewer than 2 fluent mutants fails validation outright (migration floor)', () => {
  const repo = initRepo({ 'README.md': 'clean repo\n' });
  const store = mkTemp('gate-seal-store-');
  const ref = sealPut({ content: FRESH_REF, storeRoot: store });
  const m1 = sealPut({ content: FRESH_MUTANT1, storeRoot: store });
  const card = cardMarkdown({
    reference: ref.uri,
    mutants: [{ id: 'ts-m1', why: 'lone mutant', drop: 1, mustFail: 'TS-03', fixture: m1.uri }],
  });
  const r = validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.errors.some((e) => e.code === 'E_POOL_TOO_SMALL'), true);
});

// ---------- Test C: rotation determinism, locked byte-for-byte ----------

test('C: same (runId, gateId) yields the identical sample across 3 calls', () => {
  const pool = ['1', '2', '3', '4', '5'].map((c, i) => ({ id: `tm-m${i + 1}`, fixture: c.repeat(64) }));
  const runs = [1, 2, 3].map(() =>
    sampleMutants({ runId: 'RUN-PINNED-01', gateId: 'toposort', pool, k: 2 })
  );
  assert.deepEqual(runs[0].sampled, runs[1].sampled);
  assert.deepEqual(runs[1].sampled, runs[2].sampled);
});

test('C: pinned vector, runId RUN-PINNED-01 draws exactly tm-m4 then tm-m1', () => {
  // Computed from an independent reimplementation of ADR-SEALED-GATES decision 2:
  // seed0 = sha256("RUN-PINNED-01:toposort"), candidates hash-sorted, draw i =
  // uint64BE(sha256(seed0 || uint32BE(i))[0..8]) mod remaining.
  const pool = ['1', '2', '3', '4', '5'].map((c, i) => ({ id: `tm-m${i + 1}`, fixture: c.repeat(64) }));
  const r = sampleMutants({ runId: 'RUN-PINNED-01', gateId: 'toposort', pool, k: 2 });
  assert.deepEqual(
    r.sampled,
    [
      { id: 'tm-m4', hash: '4'.repeat(64) },
      { id: 'tm-m1', hash: '1'.repeat(64) },
    ]
  );
});

test('C: the sample is recorded in the run-record shape (runId + sampled hashes)', () => {
  const pool = ['1', '2', '3', '4', '5'].map((c, i) => ({ id: `tm-m${i + 1}`, fixture: c.repeat(64) }));
  const r = sampleMutants({ runId: 'RUN-PINNED-01', gateId: 'toposort', pool, k: 2 });
  assert.deepEqual(Object.keys(r).sort(), ['gateId', 'runId', 'sampled']);
  assert.equal(r.runId, 'RUN-PINNED-01');
  assert.equal(r.gateId, 'toposort');
});

// ---------- Section 9: per-template validation blocks (GATE-CARD-SPEC, v1.12 Wave 2) ----------

test('9: per-template sampling seed, pinned vectors from an independent reimplementation', () => {
  // seed0 = sha256(runId + ":" + gateId + ":" + templateSlug); everything else decision-2.
  const pool = ['1', '2', '3', '4', '5'].map((c, i) => ({ id: `tm-m${i + 1}`, fixture: c.repeat(64) }));
  const book = sampleMutants({ runId: 'RUN-PINNED-01', gateId: 'toposort', templateSlug: 'book', pool, k: 2 });
  assert.deepEqual(book.sampled.map((s) => s.id), ['tm-m2', 'tm-m1']);
  assert.equal(book.templateSlug, 'book');
  const software = sampleMutants({ runId: 'RUN-PINNED-01', gateId: 'toposort', templateSlug: 'software', pool, k: 2 });
  assert.deepEqual(software.sampled.map((s) => s.id), ['tm-m5', 'tm-m2']);
  // No slug = the Wave 1 algorithm byte-for-byte (tm-m4 then tm-m1, locked above).
  const bare = sampleMutants({ runId: 'RUN-PINNED-01', gateId: 'toposort', pool, k: 2 });
  assert.deepEqual(bare.sampled.map((s) => s.id), ['tm-m4', 'tm-m1']);
  assert.equal('templateSlug' in bare, false);
});

/**
 * Templated gate: sorts keyed per shape. asc effective set = TS-01/TS-02/TS-03 (3 checks),
 * desc declares applies_to routing + waives TS-03, effective set = TS-01/TS-04 (2 checks).
 */
const TEMPLATED_GATE_SOURCE = [
  "const fs = require('node:fs');",
  'const args = process.argv.slice(2);',
  "let template = 'asc';",
  'const rest = [];',
  "for (let i = 0; i < args.length; i++) { if (args[i] === '--template') template = args[++i]; else rest.push(args[i]); }",
  'let order = null;',
  "try { order = JSON.parse(fs.readFileSync(rest[rest.length - 1], 'utf8')); } catch { /* fall through */ }",
  'const isArr = Array.isArray(order);',
  'if (!isArr) order = [];',
  "const want = ['a', 'b', 'c', 'd'];",
  'const set = new Set(order);',
  'const results = {',
  "  'TS-01': isArr,",
  "  'TS-02': JSON.stringify(order) === JSON.stringify(want),",
  "  'TS-03': order.length === 4 && set.size === 4 && want.every((n) => set.has(n)),",
  "  'TS-04': JSON.stringify(order) === JSON.stringify([...want].reverse()),",
  '};',
  "const cats = { 'TS-01': 'structure', 'TS-02': 'value', 'TS-03': 'relation', 'TS-04': 'value' };",
  "const sets = { asc: ['TS-01', 'TS-02', 'TS-03'], desc: ['TS-01', 'TS-04'] };",
  'const ids = sets[template] || [];',
  'let passed = 0;',
  "for (const id of ids) { if (results[id]) passed++; else console.log('FAIL ' + id + ' ' + cats[id]); }",
  "console.log('gate: ' + passed + '/' + ids.length);",
].join('\n');

function writeTemplatedGateScript() {
  const dir = mkTemp('gate-seal-tgate-');
  const file = path.join(dir, 'shapesort-gate.cjs');
  fs.writeFileSync(file, TEMPLATED_GATE_SOURCE);
  return file;
}

/** Templated card markdown per GATE-CARD-SPEC 9.1. Overrides via per-test knobs. */
function templatedCardMarkdown({ asc, desc, topLevelValidation = false, extraCheckLines = [], descMustFail = 'TS-04', descOverrides = null, gateScriptHash = null, lastValidated = {} }) {
  const mutantLines = (mutants) =>
    mutants
      .map(
        (m) =>
          `      - { id: ${m.id}, class: fluent-but-wrong, why_fluent: ${m.why}, expected_drop: ${m.drop}, must_fail: [${m.mustFail}], fixture: ${m.fixture} }`
      )
      .join('\n');
  const lines = [
    '---',
    'card: 1',
    'gate_id: shapesort',
    'domain: code',
    'tier: 1',
    'relational_target: null',
    'disclosure_default: opaque',
  ];
  if (gateScriptHash !== null) lines.push(`gate_script_hash: ${gateScriptHash}`);
  lines.push(
    'checks:',
    '  - { id: TS-01, category: structure, desc: artifact parses as a JSON array, measures: JSON.parse on the artifact }',
    '  - { id: TS-02, category: value, desc: ascending order exact, measures: sequence equality, applies_to: [asc] }',
    '  - { id: TS-03, category: relation, desc: node set complete, measures: set equality vs the 4 nodes }',
    '  - { id: TS-04, category: value, desc: descending order exact, measures: sequence equality, applies_to: [desc] }',
    ...extraCheckLines,
    'wrapped_tools:',
    '  - { name: node, version: 22.0.0, license: MIT, role: gate runtime }'
  );
  if (topLevelValidation) {
    lines.push('validation:', `  reference: ${asc.reference}`, '  pool_min: 5', '  pool_status: seeded', '  mutants: []', '  rotation_k: 2', '  last_validated: null');
  }
  lines.push('templates:', '  asc:', `    reference: ${asc.reference}`, '    pool_min: 5', '    pool_status: seeded');
  lines.push('    mutants:', mutantLines(asc.mutants));
  lines.push('    rotation_k: 2', `    last_validated: ${lastValidated.asc ?? 'null'}`);
  lines.push('  desc:', `    reference: ${desc.reference}`, '    pool_min: 5', '    pool_status: seeded');
  lines.push('    mutants:', mutantLines(desc.mutants.map((m) => ({ ...m, mustFail: descMustFail }))));
  lines.push('    rotation_k: 2', `    last_validated: ${lastValidated.desc ?? 'null'}`);
  lines.push('    check_overrides:');
  if (descOverrides !== null) {
    lines.push(...descOverrides);
  } else {
    lines.push('      TS-03:', '        waived: true');
  }
  lines.push(
    'gamed_modes:',
    '  - { mode: memorize the visible reference order, status: sealed, note: sealed fixtures rotate per run }',
    '---',
    '',
    '## Intent',
    'Self-test card for the per-template extension.',
    '',
    '## Gamed-mode rationale',
    'Covered by the rotating sealed pools.',
    '',
    '## Change log',
    '- 2026-07-23 authored by the wave 2 self-test.',
    ''
  );
  return lines.join('\n');
}

/** Seal the standard asc/desc fixture set into a fresh store. */
function sealTemplatedFixtures(store) {
  const put = (content) => sealPut({ content, storeRoot: store });
  return {
    asc: {
      reference: put('["a","b","c","d"]\n').uri,
      mutants: [
        { id: 'as-m1', why: 'valid-looking order with 1 swapped pair', drop: 1, mustFail: 'TS-02', fixture: put('["a","b","d","c"]\n').uri },
        { id: 'as-m2', why: 'complete-looking order with a stranger node', drop: 2, mustFail: 'TS-03', fixture: put('["a","b","c","e"]\n').uri },
      ],
    },
    desc: {
      reference: put('["d","c","b","a"]\n').uri,
      mutants: [
        { id: 'de-m1', why: 'near-descending order with 1 swapped pair', drop: 1, fixture: put('["d","c","a","b"]\n').uri },
        { id: 'de-m2', why: 'near-descending order with a different swap', drop: 1, fixture: put('["d","b","c","a"]\n').uri },
      ],
    },
  };
}

test('9: templated positive control, per-template effective sets, denominators, and samples', () => {
  const repo = initRepo({ 'README.md': 'clean repo\n' });
  const store = mkTemp('gate-seal-store-');
  const gateScript = writeTemplatedGateScript();
  const fx = sealTemplatedFixtures(store);
  const card = templatedCardMarkdown({ asc: fx.asc, desc: fx.desc });
  const r = validateGateCard(card, {
    repoRoot: repo,
    storeRoot: store,
    runId: 'W2-TPL-01',
    gateCmd: [process.execPath, gateScript],
    gateScriptPath: gateScript,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  // asc reference scores 3/3 (TS-01, TS-02, TS-03), desc scores 2/2 (TS-01, TS-04 after the waiver).
  assert.deepEqual(r.runRecord.templates.asc.referenceScore, [3, 3]);
  assert.deepEqual(r.runRecord.templates.desc.referenceScore, [2, 2]);
  assert.equal(r.runRecord.templates.asc.sampled.length, 2);
  assert.equal(r.runRecord.templates.desc.sampled.length, 2);
  for (const slug of ['asc', 'desc']) {
    for (const s of r.runRecord.templates[slug].sampled) {
      assert.equal(s.fails.length >= 1, true, `${slug} ${s.id} was caught`);
    }
  }
  // Seeded pools of 2 warn under pool_min 5, per template.
  assert.equal(r.warnings.filter((w) => w.code === 'W_POOL_BELOW_MIN').length, 2);
});

test('9: replaying the same runId reproduces both per-template samples', () => {
  const store = mkTemp('gate-seal-store-');
  const fx = sealTemplatedFixtures(store);
  const card = templatedCardMarkdown({ asc: fx.asc, desc: fx.desc });
  const first = validateGateCard(card, { storeRoot: store, runId: 'W2-TPL-REPLAY' });
  const second = validateGateCard(card, { storeRoot: store, runId: 'W2-TPL-REPLAY' });
  for (const slug of ['asc', 'desc']) {
    assert.deepEqual(
      first.runRecord.templates[slug].sampled.map((s) => s.id),
      second.runRecord.templates[slug].sampled.map((s) => s.id)
    );
  }
});

test('9: templates: plus a top-level validation: block fails E_TEMPLATE_VALIDATION_CONFLICT', () => {
  const store = mkTemp('gate-seal-store-');
  const fx = sealTemplatedFixtures(store);
  const card = templatedCardMarkdown({ asc: fx.asc, desc: fx.desc, topLevelValidation: true });
  const r = validateGateCard(card, { storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_TEMPLATE_VALIDATION_CONFLICT');
});

test('9: applies_to naming an undeclared template fails E_UNKNOWN_TEMPLATE', () => {
  const store = mkTemp('gate-seal-store-');
  const fx = sealTemplatedFixtures(store);
  const card = templatedCardMarkdown({
    asc: fx.asc,
    desc: fx.desc,
    extraCheckLines: ['  - { id: TS-05, category: value, desc: campaign-only check, measures: never runs, applies_to: [campaign] }'],
  });
  const r = validateGateCard(card, { storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.errors.some((e) => e.code === 'E_UNKNOWN_TEMPLATE'), true);
});

test('9: applies_to on a card with no templates: block fails E_UNKNOWN_TEMPLATE', () => {
  const store = mkTemp('gate-seal-store-');
  const ref = sealPut({ content: '["a","c","b","d"] \n', storeRoot: store });
  const m1 = sealPut({ content: '["c","a","b","d"] \n', storeRoot: store });
  const m2 = sealPut({ content: '["a","c","b","x"] \n', storeRoot: store });
  const card = cardMarkdown({
    reference: ref.uri,
    mutants: [
      { id: 'ts-m1', why: 'permutation swap', drop: 1, mustFail: 'TS-03', fixture: m1.uri },
      { id: 'ts-m2', why: 'stranger node', drop: 2, mustFail: 'TS-02', fixture: m2.uri },
    ],
  }).replace(
    '  - { id: TS-02, category: value, desc: node set complete and exact, measures: set equality vs the 4 nodes }',
    '  - { id: TS-02, category: value, desc: node set complete and exact, measures: set equality vs the 4 nodes, applies_to: [software] }'
  );
  const r = validateGateCard(card, { storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.errors.some((e) => e.code === 'E_UNKNOWN_TEMPLATE'), true);
});

test('9: a template with a reference but no pool fails E_TEMPLATE_POOL_INCOMPLETE', () => {
  const store = mkTemp('gate-seal-store-');
  const fx = sealTemplatedFixtures(store);
  const card = templatedCardMarkdown({ asc: fx.asc, desc: { reference: fx.desc.reference, mutants: [] } });
  const r = validateGateCard(card, { storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(
    r.errors.some((e) => e.code === 'E_TEMPLATE_POOL_INCOMPLETE' && e.template === 'desc'),
    true
  );
});

test('9: pool_status full below pool_min fails E_TEMPLATE_POOL_INCOMPLETE (5 EACH, never shared)', () => {
  const store = mkTemp('gate-seal-store-');
  const fx = sealTemplatedFixtures(store);
  const card = templatedCardMarkdown({ asc: fx.asc, desc: fx.desc }).replace(
    '  desc:\n' + `    reference: ${fx.desc.reference}\n` + '    pool_min: 5\n' + '    pool_status: seeded',
    '  desc:\n' + `    reference: ${fx.desc.reference}\n` + '    pool_min: 5\n' + '    pool_status: full'
  );
  const r = validateGateCard(card, { storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(
    r.errors.some((e) => e.code === 'E_TEMPLATE_POOL_INCOMPLETE' && e.template === 'desc'),
    true
  );
});

test('9: a waived check in that template must_fail fails E_TEMPLATE_CHECK_CONFLICT', () => {
  const store = mkTemp('gate-seal-store-');
  const fx = sealTemplatedFixtures(store);
  const card = templatedCardMarkdown({ asc: fx.asc, desc: fx.desc, descMustFail: 'TS-03' });
  const r = validateGateCard(card, { storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(
    r.errors.some((e) => e.code === 'E_TEMPLATE_CHECK_CONFLICT' && e.template === 'desc'),
    true
  );
});

test('9: a check_overrides key outside the inventory fails E_TEMPLATE_CHECK_CONFLICT', () => {
  const store = mkTemp('gate-seal-store-');
  const fx = sealTemplatedFixtures(store);
  const card = templatedCardMarkdown({
    asc: fx.asc,
    desc: fx.desc,
    descOverrides: ['      TS-03:', '        waived: true', '      TS-99:', '        waived: true'],
  });
  const r = validateGateCard(card, { storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.errors.some((e) => e.code === 'E_TEMPLATE_CHECK_CONFLICT'), true);
});

test('9: repo-visible fixture under ANY template is rejected, not laundered', () => {
  const store = mkTemp('gate-seal-store-');
  const fx = sealTemplatedFixtures(store);
  const repo = initRepo({ 'tasks/fixtures/desc_ref.json': '["d","c","b","a"]\n' });
  const card = templatedCardMarkdown({ asc: fx.asc, desc: fx.desc });
  const r = validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_FIXTURE_REPO_VISIBLE');
  assert.equal(
    r.errors.some((e) => e.code === 'E_FIXTURE_REPO_VISIBLE' && e.template === 'desc' && e.role === 'reference'),
    true
  );
});

test('9.4: a gate script hash change nulls last_validated for ALL templates', () => {
  const store = mkTemp('gate-seal-store-');
  const gateScript = writeTemplatedGateScript();
  const currentHash = crypto.createHash('sha256').update(fs.readFileSync(gateScript)).digest('hex');
  const fx = sealTemplatedFixtures(store);
  const dates = { asc: '2026-07-23', desc: '2026-07-23' };

  // Recorded hash matches the current script: the per-template dates survive.
  const intact = validateGateCard(
    templatedCardMarkdown({ asc: fx.asc, desc: fx.desc, gateScriptHash: currentHash, lastValidated: dates }),
    { storeRoot: store, gateScriptPath: gateScript, runId: 'W2-TPL-LV' }
  );
  assert.deepEqual(intact.lastValidated, { asc: '2026-07-23', desc: '2026-07-23' });

  // Recorded hash differs (the gate script changed): null for ALL templates, by design.
  const stale = validateGateCard(
    templatedCardMarkdown({ asc: fx.asc, desc: fx.desc, gateScriptHash: 'f'.repeat(64), lastValidated: dates }),
    { storeRoot: store, gateScriptPath: gateScript, runId: 'W2-TPL-LV' }
  );
  assert.deepEqual(stale.lastValidated, { asc: null, desc: null });

  // No recorded hash at all: unverifiable, also null for all templates.
  const unrecorded = validateGateCard(
    templatedCardMarkdown({ asc: fx.asc, desc: fx.desc, lastValidated: dates }),
    { storeRoot: store, gateScriptPath: gateScript, runId: 'W2-TPL-LV' }
  );
  assert.deepEqual(unrecorded.lastValidated, { asc: null, desc: null });
});
