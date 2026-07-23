'use strict';

/**
 * v1.13 Wave 3: the citation-sources gate (research pack, tier 4, grounding floor).
 *
 * Per-check unit coverage (CS-01..CS-06 provoked and cleared, including the CS-03
 * INDET abstain path and the CS-06 WARN advisory path), both invocation modes
 * (packet and --ledger 2-part), fluent-pool assurance for all 5 A7-seed mutants,
 * and the sealed end-to-end path: generate -> seal into a temp FERROX_SEALED_STORE
 * -> validateGateCard green with the reference M/M and every mutant caught, plus
 * replay determinism, the repo-visibility rejection, and gate-runner byte-compat
 * (INDET and WARN lines provably invisible to the parser).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const gateRunner = require('../ferrox-core/bin/lib/gate-runner.cjs');
const gen = require('../gates/citation-sources/fixtures/generators/generators.cjs');

const GATE = path.join(__dirname, '..', 'gates', 'citation-sources', 'gate.cjs');
const CARD_FILE = path.join(__dirname, '..', 'gates', 'citation-sources', 'card.md');
const NONCE = 'w3cs';

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const FIX = mkTemp('citation-gate-fix-');
const LEDGER = gen.buildLedger(path.join(FIX, 'ws'), { nonce: NONCE });
const PACKET_CMD = [process.execPath, GATE];
const TWO_PART_CMD = [process.execPath, GATE, '--ledger', LEDGER];

let artifactCounter = 0;
function writeArtifact(content) {
  const artifactPath = path.join(FIX, `artifact-${artifactCounter++}.md`);
  fs.writeFileSync(artifactPath, content);
  return artifactPath;
}

function runOn(content, gateCmd = PACKET_CMD) {
  return gateRunner.runGate({ gateCmd, artifactPath: writeArtifact(content) });
}

/** Raw invocation for the INDET/WARN surface asserts (runGate hides non-FAIL lines). */
function runRaw(content, gateArgs = []) {
  const r = spawnSync(process.execPath, [GATE, ...gateArgs, writeArtifact(content)], { encoding: 'utf8' });
  return { stdout: r.stdout, status: r.status };
}

function mutant(id) {
  return gen.mutants({ nonce: NONCE }).find((m) => m.id === id);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(files) {
  const repo = mkTemp('citation-gate-repo-');
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

test('reference packet scores 6/6 with zero fails (packet mode)', () => {
  const r = runOn(gen.referenceContent({ nonce: NONCE }));
  assert.deepEqual(r, { score: [6, 6], fails: [] });
});

test('2-part mode: --ledger SOURCES.md plus the bare report scores 6/6', () => {
  const r = runOn(gen.reportContent({ nonce: NONCE }), TWO_PART_CMD);
  assert.deepEqual(r, { score: [6, 6], fails: [] });
});

test('the reference exercises the legal alteration grammar live', () => {
  const content = gen.referenceContent({ nonce: NONCE });
  assert.equal(content.includes('\u201C'), true, 'curly quotes present (normalization live)');
  assert.equal(content.includes('was signed ...'), true, 'internal ellipsis present');
  assert.equal(content.includes('"[Runners] reported'), true, 'bracketed substitution present');
  assert.equal(content.includes(' retracted]'), true, 'acknowledged retracted citation present');
});

// ---------- per-check units ----------

test('CS-01: a content-drifted excerpt with a stale hash fails exactly the integrity check', () => {
  const r = runOn(mutant('cs-m4').content);
  assert.deepEqual(r.fails, ['CS-01 structure']);
});

test('CS-01: an archived entry missing content_hash fails', () => {
  const flareHash = gen.ledgerEntries()[1].content_hash;
  const content = gen.referenceContent({ nonce: NONCE }).replace(`    content_hash: ${flareHash}\n`, '');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['CS-01 structure']);
});

test('CS-01: a schema violation (bad access enum) fails', () => {
  const content = gen.referenceContent({ nonce: NONCE }).replace('    access: archived', '    access: mirrored');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['CS-01 structure']);
});

test('CS-02: a marker citing a nonexistent ledger id fails referential integrity', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace('[S:courier-interview]. The interviews were collected off the mesh.', '[S:courier-archive]. The interviews were collected off the mesh.');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['CS-02 grounding']);
});

test('CS-02: an unflagged retraction fails (the retracted entry cited as live)', () => {
  const r = runOn(mutant('cs-m3').content);
  assert.deepEqual(r.fails, ['CS-02 grounding']);
});

test('CS-02: the retracted annotation on a non-retracted entry fails (escape-hatch ban)', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace('[S:mesh-survey-2025], and', '[S:mesh-survey-2025 retracted], and');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['CS-02 grounding']);
});

test('CS-03: a paraphrased quote fails the verbatim match', () => {
  const r = runOn(mutant('cs-m1').content);
  assert.deepEqual(r.fails, ['CS-03 grounding']);
});

test('CS-03: transposed source ids fail the quote match while every id resolves', () => {
  const r = runOn(mutant('cs-m2').content);
  assert.deepEqual(r.fails, ['CS-03 grounding']);
});

test('CS-03: a legally formatted ellipsis hiding a negation fails', () => {
  const r = runOn(mutant('cs-m5').content);
  assert.deepEqual(r.fails, ['CS-03 grounding']);
});

test('CS-03 INDET: a beyond-grammar alteration abstains, never fails (3-valued)', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace('arrived intact far more often', 'arrived intact [far] more often');
  const raw = runRaw(content);
  assert.equal(raw.stdout.includes('INDET CS-03 multi-substitution'), true, 'INDET line emitted');
  assert.equal(raw.stdout.includes('FAIL CS-03'), false, 'INDET never becomes a FAIL');
  assert.equal(raw.stdout.includes('gate: 6/6'), true, 'INDET never moves the score');
  assert.equal(raw.status, 0);
});

test('CS-04: an unparseable ledger url fails the syntax check and nothing else', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace('    url: https://example.org/tariff-ledger-study', '    url: "%% not a url %%"');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['CS-04 value']);
});

test('CS-05: a declared claim with no marker fails the unresolved-claim scan', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace('- Hand carriage traded speed for delivery reliability. [S:courier-interview]', '- Hand carriage traded speed for delivery reliability.');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['CS-05 grounding']);
});

test('CS-05: a marker hidden in an HTML comment does not count (escape-hatch ban)', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace(
      '- Hand carriage traded speed for delivery reliability. [S:courier-interview]',
      '- Hand carriage traded speed for delivery reliability. <!-- [S:courier-interview] -->'
    );
  const r = runOn(content);
  assert.deepEqual(r.fails, ['CS-05 grounding']);
});

test('CS-05: without the claims declared flag the scan passes vacuously (documented)', () => {
  const content = gen
    .referenceContent({ nonce: NONCE })
    .replace('claims: declared\n', '')
    .replace('- Hand carriage traded speed for delivery reliability. [S:courier-interview]', '- Hand carriage traded speed for delivery reliability.');
  const r = runOn(content);
  assert.deepEqual(r, { score: [6, 6], fails: [] });
});

test('CS-06 WARN: an uncited ledger entry emits an advisory and the gate still passes', () => {
  const orphan = [
    '  - id: orphan-memo',
    '    title: "Orphan memo"',
    '    access: live',
    '    access_date: 2026-07-21',
    '    excerpt: "An uncited note kept for later."',
    '  - id: tariff-ledger-study',
  ].join('\n');
  const content = gen.referenceContent({ nonce: NONCE }).replace('  - id: tariff-ledger-study', orphan);
  const raw = runRaw(content);
  assert.equal(raw.stdout.includes('WARN CS-06 unused-source orphan-memo'), true, 'advisory emitted');
  assert.equal(raw.stdout.includes('FAIL CS-06'), false, 'CS-06 never fails by contract');
  assert.equal(raw.stdout.includes('gate: 6/6'), true);
  assert.equal(raw.status, 0);
});

// ---------- surface + card contract ----------

test('every emitted FAIL token is v2 and inside the committed card inventory', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  const inventory = new Map(parsed.card.checks.map((c) => [c.id, c.category]));
  const rotten = [
    '---',
    'claims: declared',
    '---',
    '',
    '# Rotten report',
    '',
    '- A claim with no source behind it at all.',
    '',
    '"A quote with no ledger anywhere" [S:ghost-source]',
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

test('committed card declares the 6-check inventory and the 5-mutant fluent pool', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.card.gateId, 'citation-sources');
  assert.deepEqual(
    parsed.card.checks.map((c) => c.id),
    ['CS-01', 'CS-02', 'CS-03', 'CS-04', 'CS-05', 'CS-06']
  );
  assert.equal(parsed.card.hasTopLevelValidation, true, 'single-template card, no templates block');
  assert.equal(parsed.card.templates, null);
  assert.equal(parsed.card.poolMin, 5);
  assert.equal(parsed.card.poolStatus, 'full');
  assert.equal(parsed.card.mutants.length, 5);
  assert.equal(parsed.card.mutants.every((m) => m.mutantClass === 'fluent-but-wrong'), true);
  assert.equal(parsed.card.mutants.some((m) => m.mustFail.includes('CS-06')), false, 'no mutant may target the advisory check');
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

// ---------- sealed end-to-end ----------

/** Seal reference + pool into a fresh store and return cardMarkdown args. */
function sealPool(store, nonce) {
  const put = (content) => {
    const r = seal.sealPut({ content, storeRoot: store });
    assert.equal(r.ok, true);
    return r;
  };
  return {
    referenceUri: put(gen.referenceContent({ nonce })).uri,
    mutants: gen.mutants({ nonce }).map((m) => ({ ...m, fixtureUri: put(m.content).uri })),
  };
}

test('e2e: seal the pool, validateGateCard green, reference M/M, all 5 mutants caught', () => {
  const store = mkTemp('citation-gate-store-');
  const repo = initRepo({ 'README.md': 'clean hermetic repo\n' });
  const pool = sealPool(store, gen.mintNonce());

  const card = gen.cardMarkdown({ ...pool, rotationK: 5 });
  const r = seal.validateGateCard(card, {
    repoRoot: repo,
    storeRoot: store,
    runId: 'W3-CITATION-01',
    gateCmd: PACKET_CMD,
    gateScriptPath: GATE,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.runRecord.gateId, 'citation-sources');
  assert.deepEqual(r.runRecord.referenceScore, [6, 6], 'reference is M/M');
  assert.equal(r.runRecord.sampled.length, 5, 'rotation_k 5 samples the full pool');
  for (const s of r.runRecord.sampled) {
    assert.equal(s.fails.length >= 1, true, `${s.id} was caught`);
  }
});

test('e2e: replaying the same runId reproduces the mutant sample', () => {
  const store = mkTemp('citation-gate-store-');
  const pool = sealPool(store, gen.mintNonce());
  const card = gen.cardMarkdown({ ...pool, rotationK: 2 });
  const first = seal.validateGateCard(card, { storeRoot: store, runId: 'W3-CITATION-REPLAY' });
  const second = seal.validateGateCard(card, { storeRoot: store, runId: 'W3-CITATION-REPLAY' });
  assert.deepEqual(
    first.runRecord.sampled.map((s) => s.id),
    second.runRecord.sampled.map((s) => s.id)
  );
  assert.equal(first.runRecord.sampled.length, 2);
});

test('e2e: sealing fixture content that is committed in the repo is rejected, not laundered', () => {
  const store = mkTemp('citation-gate-store-');
  const nonce = gen.mintNonce();
  const refContent = gen.referenceContent({ nonce });
  const repo = initRepo({ 'reports/committed/REPORT.md': refContent });

  const pool = sealPool(store, nonce);
  const card = gen.cardMarkdown({ ...pool, rotationK: 5 });
  const r = seal.validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_FIXTURE_REPO_VISIBLE');
  assert.equal(
    r.errors.some((e) => e.code === 'E_FIXTURE_REPO_VISIBLE' && e.role === 'reference'),
    true
  );
});

// ---------- gate-runner byte-compat ----------

test('runGate parses the gate output exactly (score, normalized v2 fail line)', () => {
  const r = runOn(mutant('cs-m1').content);
  assert.deepEqual(r, { score: [5, 6], fails: ['CS-03 grounding'] });
});

test('parseGateOutput provably ignores INDET and WARN lines (extra-line tolerance)', () => {
  const stdout = [
    'INDET CS-03 multi-substitution',
    'WARN CS-06 unused-source orphan-memo',
    'gate: 6/6',
    '',
  ].join('\n');
  assert.deepEqual(gateRunner.parseGateOutput(stdout), { score: [6, 6], fails: [] });
});
