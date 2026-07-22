'use strict';

/**
 * v1.10 Wave 3: the brainstorm-artifact gate (agent-ops pack, tier 2, hygiene floor).
 *
 * Per-check unit coverage (BA-01..BA-06 each provoked and cleared), fluent-mutant pool
 * assurance (every generator mutant drops >= expected_drop and emits every must_fail id),
 * and the sealed end-to-end path through the Wave 1 v1.9 framework: generate -> seal into
 * a temp FERROX_SEALED_STORE -> validateGateCard green on the reference with all 5 mutants
 * caught, plus replay determinism and the repo-visibility rejection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const gateRunner = require('../ferrox-core/bin/lib/gate-runner.cjs');
const gen = require('../gates/brainstorm-artifact/fixtures/generators/generators.cjs');

const GATE = path.join(__dirname, '..', 'gates', 'brainstorm-artifact', 'gate.cjs');
const CARD_FILE = path.join(__dirname, '..', 'gates', 'brainstorm-artifact', 'card.md');
const NONCE = 'w3ba';

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const FIX = mkTemp('brainstorm-gate-fix-');
const WS = gen.buildWorkspace(path.join(FIX, 'ws'));
const GATE_CMD = [process.execPath, GATE, '--workspace', WS];

let artifactCounter = 0;
function runOn(content, gateCmd = GATE_CMD) {
  const artifactPath = path.join(FIX, `artifact-${artifactCounter++}.md`);
  fs.writeFileSync(artifactPath, content);
  return gateRunner.runGate({ gateCmd, artifactPath });
}

function mutant(id) {
  return gen.mutants({ nonce: NONCE }).find((m) => m.id === id);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(files) {
  const repo = mkTemp('brainstorm-gate-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'wave3@ferrox.local']);
  git(repo, ['config', 'user.name', 'Ferrox Wave3']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'hermetic wave3 repo']);
  return repo;
}

// ---------- reference ----------

test('reference brainstorm scores 6/6 with zero fails', () => {
  const r = runOn(gen.referenceContent({ nonce: NONCE }));
  assert.deepEqual(r, { score: [6, 6], fails: [] });
});

test('without --workspace the dead-ref scan degrades open (documented)', () => {
  const r = runOn(mutant('ba-m3').content, [process.execPath, GATE]);
  assert.deepEqual(r.score, [6, 6]);
});

// ---------- per-check units ----------

test('BA-01: a missing Recommendation section fails structure (and the pick check)', () => {
  const r = runOn(mutant('ba-m1').content);
  assert.deepEqual(r.fails, ['BA-01 structure', 'BA-02 structure']);
});

test('BA-01: required sections out of template order fail', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace('## Open Questions', '## SWAPMARKER')
    .replace('## Next Step', '## Open Questions')
    .replace('## SWAPMARKER', '## Next Step');
  const r = runOn(content);
  assert.equal(r.fails.includes('BA-01 structure'), true);
});

test('BA-02: a polished hedge with no pick fails exactly the pick check', () => {
  const r = runOn(mutant('ba-m2').content);
  assert.deepEqual(r.fails, ['BA-02 structure']);
});

test('BA-02: a Recommendation under the length floor fails', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace(/## Recommendation\n\n[\s\S]*?\n\n## Decisions/, '## Recommendation\n\nOption B.\n\n## Decisions');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-02 structure']);
});

test('BA-03: em dashes in otherwise perfect prose fail the editorial floor', () => {
  const r = runOn(mutant('ba-m4').content);
  assert.deepEqual(r.fails, ['BA-03 value']);
});

test('BA-03: an en dash fails the editorial floor', () => {
  const content = gen.referenceContent({ nonce: NONCE }).replace('local file only.', 'local file only – always.');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-03 value']);
});

test('BA-03: spelled-out numbers before countable nouns fail', () => {
  const content = gen.referenceContent({ nonce: NONCE }) + '\nWe tried this two times before settling.\n';
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-03 value']);
});

test('BA-04: a plausible-but-renamed file path fails the dead-ref scan', () => {
  const r = runOn(mutant('ba-m3').content);
  assert.deepEqual(r.fails, ['BA-04 grounding']);
});

test('BA-05: an empty Open Questions section fails', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace(/## Open Questions\n\n[\s\S]*?\n\n## Next Step/, '## Open Questions\n\n## Next Step');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-05 structure']);
});

test('BA-05: an empty Next Step section fails', () => {
  const content = gen.referenceContent({ nonce: NONCE }).replace(/## Next Step\n\n[\s\S]*$/, '## Next Step\n');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-05 structure']);
});

test('BA-06: a fluently buried TBD fails the placeholder scan', () => {
  const r = runOn(mutant('ba-m5').content);
  assert.deepEqual(r.fails, ['BA-06 value']);
});

test('BA-06: lorem ipsum filler fails the placeholder scan', () => {
  const content = gen.referenceContent({ nonce: NONCE }) + '\nLorem ipsum dolor sit amet.\n';
  const r = runOn(content);
  assert.deepEqual(r.fails, ['BA-06 value']);
});

// ---------- surface + card contract ----------

test('every emitted FAIL token is v2 and inside the committed card inventory', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  const inventory = new Map(parsed.card.checks.map((c) => [c.id, c.category]));
  const rotten = [
    '# Brainstorm: rotten',
    '',
    '## Context',
    '',
    'Sketchy notes — with a dash, a TODO, and a dead `src/never-existed.cjs` path.',
    '',
    '## Decisions',
    '',
    'None yet.',
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
  assert.equal(parsed.card.gateId, 'brainstorm-artifact');
  assert.deepEqual(
    parsed.card.checks.map((c) => c.id),
    ['BA-01', 'BA-02', 'BA-03', 'BA-04', 'BA-05', 'BA-06']
  );
  assert.equal(parsed.card.mutants.length, 5);
  assert.equal(parsed.card.mutants.every((m) => m.mutantClass === 'fluent-but-wrong'), true);
  assert.equal(parsed.card.poolMin, 5);
});

// ---------- fluent pool assurance ----------

test('every pool mutant drops >= expected_drop and emits every must_fail id', () => {
  for (const m of gen.mutants({ nonce: NONCE })) {
    const r = runOn(m.content);
    assert.equal(r.fails.length >= m.expectedDrop, true, `${m.id} dropped ${r.fails.length}`);
    const ids = new Set(r.fails.map((f) => f.split(' ')[0]));
    for (const id of m.mustFail) {
      assert.equal(ids.has(id), true, `${m.id} must fail ${id}`);
    }
  }
});

// ---------- sealed end-to-end through the Wave 1 v1.9 framework ----------

test('e2e: generate, seal into a temp store, validateGateCard green with all 5 mutants caught', () => {
  const store = mkTemp('brainstorm-gate-store-');
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
    runId: 'W3-BRAINSTORM-01',
    gateCmd: GATE_CMD,
    gateScriptPath: GATE,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.runRecord.gateId, 'brainstorm-artifact');
  assert.equal(r.runRecord.sampled.length, 5, 'rotation_k 5 samples the full pool');
  assert.deepEqual(r.runRecord.referenceScore, [6, 6]);
  for (const s of r.runRecord.sampled) {
    assert.equal(s.fails.length >= 1, true, `${s.id} was caught`);
  }
});

test('e2e: replaying the same runId reproduces the identical mutant sample', () => {
  const store = mkTemp('brainstorm-gate-store-');
  const nonce = gen.mintNonce();
  const ref = seal.sealPut({ content: gen.referenceContent({ nonce }), storeRoot: store });
  const pool = gen.mutants({ nonce }).map((m) => ({
    ...m,
    fixtureUri: seal.sealPut({ content: m.content, storeRoot: store }).uri,
  }));
  const card = gen.cardMarkdown({ referenceUri: ref.uri, mutants: pool, rotationK: 2 });
  const first = seal.validateGateCard(card, { storeRoot: store, runId: 'W3-BRAINSTORM-REPLAY' });
  const second = seal.validateGateCard(card, { storeRoot: store, runId: 'W3-BRAINSTORM-REPLAY' });
  assert.deepEqual(
    first.runRecord.sampled.map((s) => s.id),
    second.runRecord.sampled.map((s) => s.id)
  );
  assert.equal(first.runRecord.sampled.length, 2);
});

test('e2e: sealing fixture content that is committed in the repo is rejected, not laundered', () => {
  const store = mkTemp('brainstorm-gate-store-');
  const nonce = gen.mintNonce();
  const refContent = gen.referenceContent({ nonce });
  const repo = initRepo({ '.planning/brainstorms/committed/BRAINSTORM.md': refContent });

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
