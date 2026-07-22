'use strict';

/**
 * v1.11 Wave 1: the web-ui gate (6th pack, tier 1, mechanical floor for frontend surfaces).
 *
 * Per-check unit coverage (WU-01..WU-08 each provoked and cleared), the 3-valued verdict
 * surface (INDET lines emitted, never scored, provably ignored by gate-runner parsing),
 * the UNSUPPORTED-INPUT contract surface, fluent-mutant pool assurance (every generator
 * mutant drops >= expected_drop and emits every must_fail id), and the sealed end-to-end
 * path through the v1.9 framework: generate -> seal into a temp FERROX_SEALED_STORE ->
 * validateGateCard green on the reference with all 6 mutants caught, plus replay
 * determinism and the repo-visibility rejection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const gateRunner = require('../ferrox-core/bin/lib/gate-runner.cjs');
const gen = require('../gates/web-ui/fixtures/generators/generators.cjs');

const GATE = path.join(__dirname, '..', 'gates', 'web-ui', 'gate.cjs');
const CARD_FILE = path.join(__dirname, '..', 'gates', 'web-ui', 'card.md');
const NONCE = 'w1wu';

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const FIX = mkTemp('web-ui-gate-fix-');
const GATE_CMD = [process.execPath, GATE];

let artifactCounter = 0;
function writeArtifact(content) {
  const artifactPath = path.join(FIX, `artifact-${artifactCounter++}.html`);
  fs.writeFileSync(artifactPath, content);
  return artifactPath;
}

function runOn(content) {
  return gateRunner.runGate({ gateCmd: GATE_CMD, artifactPath: writeArtifact(content) });
}

/** Raw stdout, for asserting the INDET and UNSUPPORTED-INPUT line surfaces. */
function runRaw(content) {
  const artifactPath = writeArtifact(content);
  try {
    return execFileSync(process.execPath, [GATE, artifactPath], { encoding: 'utf8' });
  } catch (e) {
    return typeof e.stdout === 'string' ? e.stdout : '';
  }
}

function reference() {
  return gen.referenceContent({ nonce: NONCE });
}

function mutant(id) {
  return gen.mutants({ nonce: NONCE }).find((m) => m.id === id);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(files) {
  const repo = mkTemp('web-ui-gate-repo-');
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'wave1@ferrox.local']);
  git(repo, ['config', 'user.name', 'Ferrox Wave1']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'hermetic wave1 repo']);
  return repo;
}

// ---------- reference ----------

test('reference page scores 8/8 with zero fails and zero INDET on the scored checks', () => {
  const r = runOn(reference());
  assert.deepEqual(r, { score: [8, 8], fails: [] });
  const raw = runRaw(reference());
  assert.equal(raw.includes('INDET '), false, 'reference emits no INDET lines');
  assert.equal(raw.includes('UNSUPPORTED-INPUT'), false, 'reference is inside the contract');
});

test('an unreadable artifact fails closed with every check down', () => {
  const r = gateRunner.runGate({ gateCmd: GATE_CMD, artifactPath: path.join(FIX, 'missing.html') });
  assert.deepEqual(r.score, [0, 8]);
  assert.equal(r.fails.length, 8);
});

// ---------- WU-01: the UNSUPPORTED-INPUT contract surface ----------

test('WU-01: a page with link rel=stylesheet is rejected with the distinct verdict, as a failing gate', () => {
  const content = reference().replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<link rel="stylesheet" href="app.css">');
  const raw = runRaw(content);
  assert.equal(raw.includes('UNSUPPORTED-INPUT external-stylesheet'), true);
  const parsed = gateRunner.parseGateOutput(raw);
  assert.deepEqual(parsed, { score: [0, 8], fails: ['WU-01 structure'] });
});

test('WU-01: @import, a 2nd style block, and a non-:root custom property each carry their own reason code', () => {
  const cases = [
    [reference().replace('  * { box-sizing: border-box; }', '  @import url(other.css);\n  * { box-sizing: border-box; }'), 'css-import'],
    [reference().replace('</head>', '<style>.x { color: #000000; }</style>\n</head>'), 'multiple-style-blocks'],
    [reference().replace('  .muted { color: var(--muted); }', '  .muted { --local: #123456; color: var(--muted); }'), 'non-root-custom-property'],
    [reference().replace('  .muted { color: var(--muted); }', '  .card:has(img) { color: var(--muted); }'), 'unsupported-selector'],
    ['no markup at all, just prose', 'not-html'],
  ];
  for (const [content, reason] of cases) {
    const raw = runRaw(content);
    assert.equal(raw.includes(`UNSUPPORTED-INPUT ${reason}`), true, `reason ${reason}`);
    assert.deepEqual(gateRunner.parseGateOutput(raw).fails, ['WU-01 structure'], `reason ${reason} fails WU-01`);
  }
});

// ---------- WU-02: contrast ----------

test('WU-02: 4.4:1 body text on white fails exactly the contrast check', () => {
  const r = runOn(mutant('wu-m1').content);
  assert.deepEqual(r.fails, ['WU-02 value']);
});

test('WU-02: the same 4.4:1 gray passes as large text under the 3:1 floor', () => {
  const content = reference().replace('  .muted { color: var(--muted); }', '  .muted { color: #767676; font-size: 24px; }');
  const r = runOn(content);
  assert.deepEqual(r, { score: [8, 8], fails: [] });
});

test('WU-02 INDET: a gradient background abstains with a reason code and does not fail the gate', () => {
  const content = reference().replace(
    '  .page-main { padding: 24px 32px; }',
    '  .page-main { padding: 24px 32px; background-image: linear-gradient(#ffffff, #eef2f7); }'
  );
  const raw = runRaw(content);
  assert.equal(raw.includes('INDET WU-02 gradient-background'), true);
  assert.deepEqual(gateRunner.parseGateOutput(raw), { score: [8, 8], fails: [] });
});

test('WU-02 INDET: an unresolvable var() abstains instead of guessing a color', () => {
  const raw = runRaw(reference().replace('color: var(--accent);', 'color: var(--accent-missing);'));
  assert.equal(raw.includes('INDET WU-02 unresolvable-var'), true);
  assert.deepEqual(gateRunner.parseGateOutput(raw).fails, []);
});

// ---------- WU-03: tap targets ----------

test('WU-03: 22 px icon buttons fail the 24x24 floor deterministically', () => {
  const r = runOn(mutant('wu-m3').content);
  assert.deepEqual(r.fails, ['WU-03 value']);
});

test('WU-03 INDET: a content-sized button abstains and does not fail the gate', () => {
  const content = reference().replace(
    '    <button class="btn" type="submit">Create alert</button>',
    '    <button class="unsized" type="submit">Create alert</button>'
  );
  const raw = runRaw(content);
  assert.equal(raw.includes('INDET WU-03 content-sized-target'), true);
  assert.deepEqual(gateRunner.parseGateOutput(raw), { score: [8, 8], fails: [] });
});

test('WU-03: an inline text link is exempt per SC 2.5.8', () => {
  // The reference body-copy link declares no size at all and still passes.
  const r = runOn(reference());
  assert.deepEqual(r.fails, []);
});

// ---------- WU-04: focus ----------

test('WU-04: a pretty box-shadow with outline none in the focus rule fails the focus check', () => {
  const r = runOn(mutant('wu-m2').content);
  assert.deepEqual(r.fails, ['WU-04 value']);
});

test('WU-04: a role=button div without tabindex is keyboard-unreachable and fails', () => {
  const r = runOn(mutant('wu-m4').content);
  assert.deepEqual(r.fails, ['WU-04 value']);
});

test('WU-04: tabindex -1 on an interactive control fails (escape-hatch ban)', () => {
  const content = reference().replace('<button class="btn" type="submit">', '<button class="btn" type="submit" tabindex="-1">');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['WU-04 value']);
});

// ---------- WU-05: landmarks ----------

test('WU-05: landmark-free div soup fails structure', () => {
  const r = runOn(mutant('wu-m5').content);
  assert.deepEqual(r.fails, ['WU-05 structure']);
});

test('WU-05: a 2nd main landmark fails landmark-one-main', () => {
  const content = reference().replace('</body>', '<main aria-label="extra"><p>Stray copy.</p></main>\n</body>');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['WU-05 structure']);
});

// ---------- WU-06: heading order ----------

test('WU-06: a heading skip (h2 to h4) fails', () => {
  const content = reference().replace('<h2 id="usage">Usage</h2>', '<h4 id="usage">Usage</h4>');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['WU-06 structure']);
});

test('WU-06: a page whose first heading is not h1 fails', () => {
  const content = reference().replace('<h1>Ferrox Metrics</h1>', '<h2>Ferrox Metrics</h2>');
  const r = runOn(content);
  assert.deepEqual(r.fails, ['WU-06 structure']);
});

// ---------- WU-07: alt and labels ----------

test('WU-07: an img without an alt decision fails', () => {
  const r = runOn(reference().replace(' alt="Throughput trend for the last 30 days"', ''));
  assert.deepEqual(r.fails, ['WU-07 structure']);
});

test('WU-07: an input without any label fails', () => {
  const r = runOn(reference().replace('    <label class="field-label" for="alert-email">Notification email</label>', ''));
  assert.deepEqual(r.fails, ['WU-07 structure']);
});

// ---------- WU-08: reduced motion ----------

test('WU-08: dropping the prefers-reduced-motion fallback fails the motion check', () => {
  const r = runOn(mutant('wu-m6').content);
  assert.deepEqual(r.fails, ['WU-08 value']);
});

test('WU-08: a page with no motion at all passes vacuously', () => {
  const content = reference().replace('    transition: transform 160ms ease;', '');
  const r = runOn(content);
  assert.deepEqual(r.fails, []);
});

// ---------- gate-runner parsing of the extended surface ----------

test('gate-runner parses this gate byte-compatibly: INDET lines are ignored, FAILs and the summary survive', () => {
  const withIndetAndFail = reference()
    .replace('  .page-main { padding: 24px 32px; }', '  .page-main { padding: 24px 32px; background-image: linear-gradient(#ffffff, #eef2f7); }')
    .replace('<h2 id="usage">Usage</h2>', '<h4 id="usage">Usage</h4>');
  const raw = runRaw(withIndetAndFail);
  assert.equal(raw.includes('INDET WU-02 gradient-background'), true, 'the INDET line is on the surface');
  const parsed = gateRunner.parseGateOutput(raw);
  assert.deepEqual(parsed, { score: [7, 8], fails: ['WU-06 structure'] }, 'INDET never reaches score or fails');
});

// ---------- surface + card contract ----------

test('every emitted FAIL token is v2 and inside the committed card inventory', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  const inventory = new Map(parsed.card.checks.map((c) => [c.id, c.category]));
  const rotten = [
    '<!doctype html>',
    '<html lang="en">',
    '<head><title>Team overview</title>',
    '<style>',
    '  body { color: #9aa5b1; background-color: #ffffff; }',
    '  .pill { min-width: 20px; min-height: 20px; box-sizing: border-box; }',
    '  .spin { animation: spin 2s linear infinite; }',
    '  button:focus { outline: none; }',
    '</style>',
    '</head>',
    '<body>',
    '<h2>Overview</h2>',
    '<p>Quarterly numbers hold steady across the board.</p>',
    '<img src="chart.png">',
    '<input type="text" name="q">',
    '<button class="pill" aria-label="Refresh"></button>',
    '<div class="spin">Syncing</div>',
    '</body>',
    '</html>',
  ].join('\n');
  const worst = runOn(rotten);
  assert.equal(worst.fails.length >= 5, true, `broad-failure artifact dropped ${worst.fails.length}`);
  for (const fail of worst.fails) {
    const cls = gateRunner.classifyFail(fail);
    assert.equal(cls.v2, true, `${fail} is v2`);
    assert.equal(inventory.get(cls.id), cls.category, `${fail} in inventory`);
  }
});

test('committed card declares the full 8-check inventory and a 6-mutant fluent pool at rotation 2', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.card.gateId, 'web-ui');
  assert.deepEqual(
    parsed.card.checks.map((c) => c.id),
    ['WU-01', 'WU-02', 'WU-03', 'WU-04', 'WU-05', 'WU-06', 'WU-07', 'WU-08']
  );
  assert.equal(parsed.card.mutants.length, 6);
  assert.equal(parsed.card.mutants.every((m) => m.mutantClass === 'fluent-but-wrong'), true);
  assert.equal(parsed.card.poolMin, 5);
  assert.equal(parsed.card.rotationK, 2);
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

// ---------- sealed end-to-end through the v1.9 framework ----------

test('e2e: generate, seal into a temp store, validateGateCard green with all 6 mutants caught', () => {
  const store = mkTemp('web-ui-gate-store-');
  const repo = initRepo({ 'README.md': 'clean hermetic repo\n' });
  const nonce = gen.mintNonce();

  const ref = seal.sealPut({ content: gen.referenceContent({ nonce }), storeRoot: store });
  assert.equal(ref.ok, true);
  const pool = gen.mutants({ nonce }).map((m) => {
    const put = seal.sealPut({ content: m.content, storeRoot: store });
    assert.equal(put.ok, true);
    return { ...m, fixtureUri: put.uri };
  });

  const card = gen.cardMarkdown({ referenceUri: ref.uri, mutants: pool, rotationK: 6 });
  const r = seal.validateGateCard(card, {
    repoRoot: repo,
    storeRoot: store,
    runId: 'W1-WEBUI-01',
    gateCmd: GATE_CMD,
    gateScriptPath: GATE,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.runRecord.gateId, 'web-ui');
  assert.equal(r.runRecord.sampled.length, 6, 'rotation_k 6 samples the full pool');
  assert.deepEqual(r.runRecord.referenceScore, [8, 8]);
  for (const s of r.runRecord.sampled) {
    assert.equal(s.fails.length >= 1, true, `${s.id} was caught`);
  }
});

test('e2e: replaying the same runId reproduces the identical mutant sample', () => {
  const store = mkTemp('web-ui-gate-store-');
  const nonce = gen.mintNonce();
  const ref = seal.sealPut({ content: gen.referenceContent({ nonce }), storeRoot: store });
  const pool = gen.mutants({ nonce }).map((m) => ({
    ...m,
    fixtureUri: seal.sealPut({ content: m.content, storeRoot: store }).uri,
  }));
  const card = gen.cardMarkdown({ referenceUri: ref.uri, mutants: pool, rotationK: 2 });
  const first = seal.validateGateCard(card, { storeRoot: store, runId: 'W1-WEBUI-REPLAY' });
  const second = seal.validateGateCard(card, { storeRoot: store, runId: 'W1-WEBUI-REPLAY' });
  assert.deepEqual(
    first.runRecord.sampled.map((s) => s.id),
    second.runRecord.sampled.map((s) => s.id)
  );
  assert.equal(first.runRecord.sampled.length, 2);
});

test('e2e: sealing fixture content that is committed in the repo is rejected, not laundered', () => {
  const store = mkTemp('web-ui-gate-store-');
  const nonce = gen.mintNonce();
  const refContent = gen.referenceContent({ nonce });
  const repo = initRepo({ 'pages/committed/index.html': refContent });

  const ref = seal.sealPut({ content: refContent, storeRoot: store });
  const pool = gen.mutants({ nonce }).map((m) => ({
    ...m,
    fixtureUri: seal.sealPut({ content: m.content, storeRoot: store }).uri,
  }));
  const card = gen.cardMarkdown({ referenceUri: ref.uri, mutants: pool, rotationK: 6 });
  const r = seal.validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_FIXTURE_REPO_VISIBLE');
  assert.equal(r.errors.some((e) => e.code === 'E_FIXTURE_REPO_VISIBLE' && e.role === 'reference'), true);
});
