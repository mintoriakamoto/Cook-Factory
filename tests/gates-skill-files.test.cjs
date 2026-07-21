'use strict';

/**
 * Wave 4 pack A: the skill-and-instruction-files gate.
 *
 * Per-check unit coverage (SK-01..SK-06 each provoked and cleared), fluent-mutant pool
 * assurance (every generator mutant drops >= expected_drop and emits every must_fail id),
 * and the sealed end-to-end path through the Wave 1 framework: generate -> seal into a
 * temp FERROX_SEALED_STORE -> validateGateCard green on the reference, plus the
 * repo-visibility rejection (sealing committed content must not launder it).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const gateRunner = require('../ferrox-core/bin/lib/gate-runner.cjs');
const gen = require('../gates/skill-instruction-files/generators.cjs');

const GATE = path.join(__dirname, '..', 'gates', 'skill-instruction-files', 'gate.cjs');
const CARD_FILE = path.join(__dirname, '..', 'gates', 'skill-instruction-files', 'card.md');
const NONCE = 'w4pack-a';

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const FIX = mkTemp('skill-gate-fix-');
const WS = gen.buildWorkspace(path.join(FIX, 'ws'));
const MANIFEST = gen.writeManifest(path.join(FIX, 'manifest.json'));
const GATE_CMD = [
  process.execPath,
  GATE,
  '--workspace',
  WS,
  '--manifest',
  MANIFEST,
  '--budget',
  String(gen.BUDGET_TOKENS),
];

let artifactCounter = 0;
function runOn(content, gateCmd = GATE_CMD) {
  const artifactPath = path.join(FIX, `artifact-${artifactCounter++}.md`);
  fs.writeFileSync(artifactPath, content);
  return gateRunner.runGate({ gateCmd, artifactPath });
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(files) {
  const repo = mkTemp('skill-gate-repo-');
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

// ---------- reference ----------

test('reference file scores 6/6 with zero fails', () => {
  const r = runOn(gen.referenceContent({ nonce: NONCE }));
  assert.deepEqual(r, { score: [6, 6], fails: [] });
});

test('without --workspace and --manifest the dead-ref sub-scans degrade open (documented)', () => {
  const r = runOn(gen.referenceContent({ nonce: NONCE }), [process.execPath, GATE, '--budget', String(gen.BUDGET_TOKENS)]);
  assert.deepEqual(r.score, [6, 6]);
});

// ---------- per-check units ----------

test('SK-01: a renamed path that reads plausibly fails the dead-ref scan', () => {
  const mutant = gen.mutants({ nonce: NONCE }).find((m) => m.id === 'sk-m1');
  const r = runOn(mutant.content);
  assert.deepEqual(r.fails, ['SK-01 grounding']);
});

test('SK-01: a frontmatter tool missing from the manifest fails', () => {
  const content = gen.referenceContent({ nonce: NONCE }).replace('allowed-tools: [Read, Bash]', 'allowed-tools: [Read, Photoshop]');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['SK-01 grounding']);
});

test('SK-01: a slash-command skill missing from the manifest fails', () => {
  const content = gen.referenceContent({ nonce: NONCE }).replace('`/ferrox-debug`', '`/ferrox-megathink`');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['SK-01 grounding']);
});

test('SK-02: polite padding 40 percent past the budget fails the token check', () => {
  const mutant = gen.mutants({ nonce: NONCE }).find((m) => m.id === 'sk-m2');
  const r = runOn(mutant.content);
  assert.deepEqual(r.fails, ['SK-02 value']);
});

test('SK-03: a runnable example calling a nonexistent flag fails on execution', () => {
  const mutant = gen.mutants({ nonce: NONCE }).find((m) => m.id === 'sk-m3');
  const r = runOn(mutant.content);
  assert.deepEqual(r.fails, ['SK-03 execution']);
});

test('SK-03: a bash block that does not parse fails even when not runnable', () => {
  const content = gen.referenceContent({ nonce: NONCE }) + '\n```bash\nif [ ; then echo broken\n```\n';
  const r = runOn(content);
  assert.deepEqual(r.fails, ['SK-03 execution']);
});

test('SK-04: an empty description fails the frontmatter schema', () => {
  const mutant = gen.mutants({ nonce: NONCE }).find((m) => m.id === 'sk-m5');
  const r = runOn(mutant.content);
  assert.deepEqual(r.fails, ['SK-04 structure']);
});

test('SK-04: a description under the 40-char floor fails', () => {
  const content = gen.referenceContent({ nonce: NONCE }).replace(/^description: .*$/m, 'description: Verify things.');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['SK-04 structure']);
});

test('SK-05: contradictory directives 200+ lines apart fail the pair scan', () => {
  const mutant = gen.mutants({ nonce: NONCE }).find((m) => m.id === 'sk-m4');
  const lines = mutant.content.split('\n');
  const a = lines.findIndex((l) => /never auto-commit/i.test(l));
  const b = lines.findIndex((l) => /always auto-commit/i.test(l));
  assert.equal(a >= 0 && b >= 0 && b - a >= 200, true, `directives ${b - a} lines apart`);
  const r = runOn(mutant.content);
  assert.deepEqual(r.fails, ['SK-05 relation']);
});

test('SK-06: an em dash trips the editorial floor', () => {
  const content = gen.referenceContent({ nonce: NONCE }) + '\nKeep it simple — always.\n';
  const r = runOn(content);
  assert.deepEqual(r.fails, ['SK-06 value']);
});

test('SK-06: spelled-out numbers before countable nouns trip the editorial floor', () => {
  const content = gen.referenceContent({ nonce: NONCE }) + '\nRepeat the probe three times before reporting.\n';
  const r = runOn(content);
  assert.deepEqual(r.fails, ['SK-06 value']);
});

// ---------- surface + card contract ----------

test('every emitted FAIL token is v2 and inside the committed card inventory', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  const inventory = new Map(parsed.card.checks.map((c) => [c.id, c.category]));
  const rotten = [
    'No frontmatter here — and an em dash too.',
    'Check `scripts/missing-forever.cjs` before shipping.',
    '',
    '```bash runnable',
    'exit 3',
    '```',
    '',
  ].join('\n');
  const worst = runOn(rotten);
  assert.equal(worst.fails.length >= 4, true, `broad-failure artifact dropped ${worst.fails.length}`);
  for (const fail of worst.fails) {
    const cls = gateRunner.classifyFail(fail);
    assert.equal(cls.v2, true, `${fail} is v2`);
    assert.equal(inventory.get(cls.id), cls.category, `${fail} in inventory`);
  }
});

test('committed card declares the full 6-check inventory and a 5-mutant fluent pool', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.card.gateId, 'skill-instruction-files');
  assert.deepEqual(
    parsed.card.checks.map((c) => c.id),
    ['SK-01', 'SK-02', 'SK-03', 'SK-04', 'SK-05', 'SK-06']
  );
  assert.equal(parsed.card.mutants.length, 5);
  assert.equal(parsed.card.mutants.every((m) => m.mutantClass === 'fluent-but-wrong'), true);
  assert.equal(parsed.card.poolMin, 5);
});

// ---------- fluent pool assurance ----------

test('every pool mutant drops >= expected_drop and emits every must_fail id', () => {
  for (const mutant of gen.mutants({ nonce: NONCE })) {
    const r = runOn(mutant.content);
    assert.equal(r.fails.length >= mutant.expectedDrop, true, `${mutant.id} dropped ${r.fails.length}`);
    const ids = new Set(r.fails.map((f) => f.split(' ')[0]));
    for (const id of mutant.mustFail) {
      assert.equal(ids.has(id), true, `${mutant.id} must fail ${id}`);
    }
  }
});

// ---------- sealed end-to-end through Wave 1 ----------

test('e2e: generate, seal into a temp store, validateGateCard green with all 5 mutants caught', () => {
  const store = mkTemp('skill-gate-store-');
  const repo = initRepo({ 'README.md': 'clean hermetic repo\n' });
  const nonce = gen.mintNonce();

  const ref = seal.sealPut({ content: gen.referenceContent({ nonce }), storeRoot: store });
  assert.equal(ref.ok, true);
  const pool = gen.mutants({ nonce }).map((m) => {
    const put = seal.sealPut({ content: m.content, storeRoot: store });
    assert.equal(put.ok, true);
    return { ...m, fixtureUri: put.uri };
  });

  const card = gen.cardMarkdown({ referenceUri: ref.uri, mutants: pool, rotationK: 5 });
  const r = seal.validateGateCard(card, {
    repoRoot: repo,
    storeRoot: store,
    runId: 'W4-SKILL-01',
    gateCmd: GATE_CMD,
    gateScriptPath: GATE,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.runRecord.gateId, 'skill-instruction-files');
  assert.equal(r.runRecord.sampled.length, 5, 'rotation_k 5 samples the full pool');
  assert.deepEqual(r.runRecord.referenceScore, [6, 6]);
  for (const s of r.runRecord.sampled) {
    assert.equal(s.fails.length >= 1, true, `${s.id} was caught`);
  }
});

test('e2e: replaying the same runId reproduces the identical mutant sample', () => {
  const store = mkTemp('skill-gate-store-');
  const nonce = gen.mintNonce();
  const ref = seal.sealPut({ content: gen.referenceContent({ nonce }), storeRoot: store });
  const pool = gen.mutants({ nonce }).map((m) => ({
    ...m,
    fixtureUri: seal.sealPut({ content: m.content, storeRoot: store }).uri,
  }));
  const card = gen.cardMarkdown({ referenceUri: ref.uri, mutants: pool, rotationK: 2 });
  const first = seal.validateGateCard(card, { storeRoot: store, runId: 'W4-SKILL-REPLAY' });
  const second = seal.validateGateCard(card, { storeRoot: store, runId: 'W4-SKILL-REPLAY' });
  assert.deepEqual(
    first.runRecord.sampled.map((s) => s.id),
    second.runRecord.sampled.map((s) => s.id)
  );
  assert.equal(first.runRecord.sampled.length, 2);
});

test('e2e: sealing fixture content that is committed in the repo is rejected, not laundered', () => {
  const store = mkTemp('skill-gate-store-');
  const nonce = gen.mintNonce();
  const refContent = gen.referenceContent({ nonce });
  const repo = initRepo({ 'skills/committed-skill.md': refContent });

  const ref = seal.sealPut({ content: refContent, storeRoot: store });
  const pool = gen.mutants({ nonce }).map((m) => ({
    ...m,
    fixtureUri: seal.sealPut({ content: m.content, storeRoot: store }).uri,
  }));
  const card = gen.cardMarkdown({ referenceUri: ref.uri, mutants: pool, rotationK: 5 });
  const r = seal.validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_FIXTURE_REPO_VISIBLE');
  assert.equal(r.errors.some((e) => e.code === 'E_FIXTURE_REPO_VISIBLE' && e.role === 'reference'), true);
});
