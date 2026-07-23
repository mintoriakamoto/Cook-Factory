'use strict';

/**
 * v1.13 Wave 3: the lore-consistency gate (writing pack, tier 2, relational).
 *
 * Per-check unit coverage (LC-01..LC-09 provoked and cleared), the A4 verdict
 * surface asserted verbatim (CONTRACT HONORED / CONTRACT BREACHED, the scope
 * disclaimer, the advisory count, canon_facts_hash presence and stability),
 * advisory WARN paths that never move the score, fluent-pool assurance for all
 * 6 mutants, the sealed end-to-end path (generate -> seal into a temp
 * FERROX_SEALED_STORE -> validateGateCard green with the reference 9/9 and all
 * sampled mutants caught), replay determinism, the repo-visibility rejection,
 * and gate-runner byte-compat despite the extra verdict / INDET / WARN / hash
 * lines.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const seal = require('../ferrox-core/bin/lib/gate-seal.cjs');
const gateRunner = require('../ferrox-core/bin/lib/gate-runner.cjs');
const gen = require('../gates/lore-consistency/fixtures/generators/generators.cjs');

const GATE = path.join(__dirname, '..', 'gates', 'lore-consistency', 'gate.cjs');
const CARD_FILE = path.join(__dirname, '..', 'gates', 'lore-consistency', 'card.md');
const NONCE = 'w3lc';
const GATE_CMD = [process.execPath, GATE];

const HONORED_LINE = 'LORE GATE: CONTRACT HONORED (9/9 declared-fact checks)';
const BREACHED_8_LINE = 'LORE GATE: CONTRACT BREACHED (8/9 declared-fact checks)';
const DISCLAIMER_LINE =
  'Scope: only declared facts were checked; prose canon fidelity outside the declared contract stays with the judgment eyes.';

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const FIX = mkTemp('lore-gate-fix-');

let artifactCounter = 0;
function writeBundle(bundleOrContent) {
  const content = typeof bundleOrContent === 'string' ? bundleOrContent : gen.serializeBundle(bundleOrContent);
  const artifactPath = path.join(FIX, `bundle-${artifactCounter++}.json`);
  fs.writeFileSync(artifactPath, content);
  return artifactPath;
}

function runOn(bundleOrContent) {
  return gateRunner.runGate({ gateCmd: GATE_CMD, artifactPath: writeBundle(bundleOrContent) });
}

/** Raw stdout of a gate run (nonzero exit still carries the verdict surface). */
function rawRun(bundleOrContent) {
  const artifactPath = writeBundle(bundleOrContent);
  try {
    return execFileSync(process.execPath, [GATE, artifactPath], { encoding: 'utf8' });
  } catch (e) {
    return typeof e.stdout === 'string' ? e.stdout : '';
  }
}

function lines(raw) {
  return raw.split(/\r?\n/).filter((l) => l !== '');
}

function bundle() {
  return gen.referenceBundle({ nonce: NONCE });
}

/** Edit the chapter markdown in place with a mandatory-hit string replace. */
function editChapter(b, from, to) {
  assert.equal(b.chapter.markdown.includes(from), true, `chapter edit target present: ${from}`);
  b.chapter.markdown = b.chapter.markdown.split(from).join(to);
  return b;
}

/** Edit the lore markdown in place with a mandatory-hit string replace. */
function editLore(b, from, to) {
  assert.equal(b.lore.includes(from), true, `lore edit target present: ${from}`);
  b.lore = b.lore.split(from).join(to);
  return b;
}

function mutant(id) {
  return gen.mutants({ nonce: NONCE }).find((m) => m.id === id);
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(files) {
  const repo = mkTemp('lore-gate-repo-');
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

test('reference bundle scores 9/9 with zero fails', () => {
  const r = runOn(bundle());
  assert.deepEqual(r, { score: [9, 9], fails: [] });
});

test('a missing artifact fails closed on every check', () => {
  const r = gateRunner.runGate({ gateCmd: GATE_CMD, artifactPath: path.join(FIX, 'missing.json') });
  assert.deepEqual(r.score, [0, 9]);
  assert.equal(r.fails.length, 9);
});

test('a wrong bundle schema tag fails closed on every check', () => {
  const b = bundle();
  b.schema = 'ferrox.some-other.bundle/1';
  const r = runOn(b);
  assert.deepEqual(r.score, [0, 9]);
});

// ---------- per-check units: provoke + clear ----------

test('LC-01: a duplicated entity id breaks bible integrity', () => {
  const b = editLore(bundle(), 'id: dorian-ash', 'id: mara-vale');
  const r = runOn(b);
  assert.equal(r.fails.includes('LC-01 structure'), true);
});

test('LC-01: a lore doc with no canon-facts fence fails and hashes empty', () => {
  const b = bundle();
  b.lore = '# LORE\n\nAll prose, no machine slice.\n';
  const raw = rawRun(b);
  const parsed = gateRunner.parseGateOutput(raw);
  assert.equal(parsed.fails.includes('LC-01 structure'), true);
  const hashLine = lines(raw).find((l) => l.startsWith('canon_facts_hash: '));
  assert.equal(hashLine, `canon_facts_hash: ${seal.sha256HexOf('')}`);
});

test('LC-01: a sources store in the lore slot fails bible integrity', () => {
  const b = bundle();
  b.lore = [
    '# SOURCES',
    '',
    '```yaml canon-facts',
    'schema: canon-facts/v1',
    'store: sources',
    'sources:',
    '  - { id: field-notes, access: offline, access_date: 2026-07-20, excerpt: noted }',
    '```',
    '',
  ].join('\n');
  const r = runOn(b);
  assert.equal(r.fails.includes('LC-01 structure'), true);
});

test('LC-02: a contract thread id missing from the bible fails grounding alone', () => {
  const b = bundle();
  b.trusted_contract.threads.open = ['vault-echo', 'ghost-thread'];
  editChapter(b, 'open: [vault-echo]', 'open: [vault-echo, ghost-thread]');
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-02 grounding']);
});

test('LC-02: a transposed required-cast id fails grounding', () => {
  const b = bundle();
  b.trusted_contract.required_on_stage = ['mara-vale', 'dorian-asch'];
  editChapter(b, 'required_on_stage: [mara-vale, dorian-ash]', 'required_on_stage: [mara-vale, dorian-asch]');
  const r = runOn(b);
  assert.equal(r.fails.includes('LC-02 grounding'), true);
});

test('LC-03: the homoglyph mutant fails exactly the cast-presence check', () => {
  const r = runOn(mutant('lc-m3').content);
  assert.deepEqual(r.fails, ['LC-03 relation']);
});

test('LC-03: an alias match satisfies cast presence (the alias path, live)', () => {
  // Replace the canonical Mara Vale mention with her declared alias.
  const b = editChapter(bundle(), 'time Mara Vale reached', 'time the Locksmith reached');
  assert.equal(b.chapter.markdown.includes('Mara Vale'), false, 'the canonical name is gone from the draft');
  const r = runOn(b);
  assert.deepEqual(r.fails, []);
});

test('LC-04: the dead-character mutant fails exactly the lifecycle check', () => {
  const r = runOn(mutant('lc-m2').content);
  assert.deepEqual(r.fails, ['LC-04 relation']);
});

test('LC-04: a departed entity on stage fails lifecycle', () => {
  const b = bundle();
  editChapter(b, 'additional_on_stage: [night-ledger]', 'additional_on_stage: [night-ledger, wren-tam]');
  b.chapter.markdown += 'Wren Tam kept the count from the doorway, the way she always had.\n';
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-04 relation']);
});

test('LC-04: a dead entity with no declared death date fails as unverifiable', () => {
  const b = editLore(bundle(), '\n    death_date: 2131-02-09', '');
  editChapter(b, 'additional_on_stage: [night-ledger]', 'additional_on_stage: [night-ledger, silas-crane]');
  b.chapter.markdown += 'Silas Crane waited at the counting table as if the years owed him rent.\n';
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-04 relation']);
});

test('LC-04: an on-stage entity introduced after the scene date fails', () => {
  const b = editLore(bundle(), 'introduced: ch-cold-open:70', 'introduced: ch-late-echo:9');
  b.prior_state.chapters.push({ chapter_id: 'ch-late-echo', scene_date: '2131-06-01' });
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-04 relation']);
});

test('LC-04: an unledgered introducing chapter abstains INDET, never guesses', () => {
  const b = editLore(bundle(), 'introduced: ch-cold-open:70', 'introduced: ch-side-story:9');
  const raw = rawRun(b);
  assert.equal(lines(raw).includes('INDET LC-04 intro-chapter-unledgered'), true);
  const parsed = gateRunner.parseGateOutput(raw);
  assert.deepEqual(parsed, { score: [9, 9], fails: [] });
});

test('LC-05: the nudged ghost-scene date fails exactly the timeline check', () => {
  const r = runOn(mutant('lc-m1').content);
  assert.deepEqual(r.fails, ['LC-05 value']);
});

test('LC-05: the lying flashback flag fails exactly the timeline check', () => {
  const r = runOn(mutant('lc-m4').content);
  assert.deepEqual(r.fails, ['LC-05 value']);
});

test('LC-05: a scene date outside the declared era bounds fails', () => {
  const b = bundle();
  b.thresholds.era_end = '2131-04-10';
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-05 value']);
});

test('LC-05: a contract window admits an in-window draft concretization', () => {
  const b = bundle();
  delete b.trusted_contract.scene_date;
  b.trusted_contract.scene_date_window = ['2131-04-10', '2131-04-25'];
  editChapter(b, 'scene_date: 2131-04-19', 'scene_date: 2131-04-19\nscene_date_window: [2131-04-10, 2131-04-25]');
  const r = runOn(b);
  assert.deepEqual(r, { score: [9, 9], fails: [] });
});

test('LC-05: a draft concretization outside the contract window fails', () => {
  const b = bundle();
  delete b.trusted_contract.scene_date;
  b.trusted_contract.scene_date_window = ['2131-04-21', '2131-04-25'];
  editChapter(b, 'scene_date: 2131-04-19', 'scene_date: 2131-04-19\nscene_date_window: [2131-04-21, 2131-04-25]');
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-05 value']);
});

test('LC-06: the birthday-boundary age mutant fails exactly the age check', () => {
  const r = runOn(mutant('lc-m5').content);
  assert.deepEqual(r.fails, ['LC-06 value']);
});

test('LC-06: an age declared for an entity with no birthdate fails, never silently passes', () => {
  const b = editChapter(bundle(), '  mara-vale: 29', '  mara-vale: 29\n  night-ledger: 3');
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-06 value']);
});

test('LC-07: a draft that omits the beats field to dodge the floor still fails the echo', () => {
  const b = editChapter(bundle(), '\nbeats: [beat-vault-approach, beat-ledger-glimpse]', '');
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-07 structure']);
});

test('LC-07: a pov echo mismatch fails the contract echo', () => {
  const b = editChapter(bundle(), 'pov: mara-vale', 'pov: dorian-ash');
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-07 structure']);
});

test('LC-07: an unknown frontmatter key fails the contract echo', () => {
  const b = editChapter(bundle(), 'chapter_id: ch-vault-heist', 'chapter_id: ch-vault-heist\nstatus: drafted');
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-07 structure']);
});

test('LC-07: a chapter_id that disagrees with the filename slug fails', () => {
  const b = editChapter(bundle(), 'chapter_id: ch-vault-heist', 'chapter_id: ch-vault-job');
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-07 structure']);
});

test('LC-08: the closed-thread touch mutant fails exactly the ledger check', () => {
  const r = runOn(mutant('lc-m6').content);
  assert.deepEqual(r.fails, ['LC-08 relation']);
});

test('LC-08: closing a never-opened thread fails', () => {
  const b = bundle();
  b.trusted_contract.threads.open = [];
  b.trusted_contract.threads.close = ['vault-echo'];
  editChapter(b, 'open: [vault-echo]', 'open: []');
  editChapter(b, 'close: []', 'close: [vault-echo]');
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-08 relation']);
});

test('LC-08: a double open fails', () => {
  const b = bundle();
  b.trusted_contract.threads.open = ['heist-plan'];
  editChapter(b, 'open: [vault-echo]', 'open: [heist-plan]');
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-08 relation']);
});

test('LC-09: a word count outside the tolerance band fails the machine floor', () => {
  const b = bundle();
  const doubled = b.trusted_contract.word_count_target * 2;
  editChapter(b, `word_count_target: ${b.trusted_contract.word_count_target}`, `word_count_target: ${doubled}`);
  b.trusted_contract.word_count_target = doubled;
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-09 value']);
});

test('LC-09: a contract beat missing from the beats_covered manifest fails', () => {
  const b = editChapter(
    bundle(),
    'beats_covered: [beat-vault-approach, beat-ledger-glimpse]',
    'beats_covered: [beat-vault-approach]'
  );
  const r = runOn(b);
  assert.deepEqual(r.fails, ['LC-09 value']);
});

// ---------- the A4 verdict surface, verbatim ----------

test('A4: a passing run ends with the CONTRACT HONORED summary, the disclaimer, and the advisory count', () => {
  const raw = rawRun(bundle());
  const out = lines(raw);
  assert.equal(out.includes(HONORED_LINE), true, 'verbatim summary line');
  assert.equal(out[out.length - 1], 'gate: 9/9', 'the machine summary is the LAST line');
  assert.equal(out[out.indexOf(HONORED_LINE) + 1], DISCLAIMER_LINE, 'exactly 1 disclaimer line follows the summary');
  assert.equal(out[out.indexOf(HONORED_LINE) + 2], 'advisories: 0');
  assert.equal(out.includes('PASS'), false, 'the gate never prints a bare PASS');
});

test('A4: a failing run ends with the honest CONTRACT BREACHED variant', () => {
  const raw = rawRun(mutant('lc-m2').content);
  const out = lines(raw);
  assert.equal(out.includes(BREACHED_8_LINE), true, 'verbatim breach line');
  assert.equal(out[out.length - 1], 'gate: 8/9');
  assert.equal(out[out.indexOf(BREACHED_8_LINE) + 1], DISCLAIMER_LINE);
});

test('A3: canon_facts_hash is present, well formed, and stable across runs', () => {
  const first = lines(rawRun(bundle())).find((l) => l.startsWith('canon_facts_hash: '));
  const second = lines(rawRun(bundle())).find((l) => l.startsWith('canon_facts_hash: '));
  assert.match(first, /^canon_facts_hash: [0-9a-f]{64}$/);
  assert.equal(first, second);
});

test('A3: a keeper edit inside the canon block changes the hash (retcon invalidation key)', () => {
  const before = lines(rawRun(bundle())).find((l) => l.startsWith('canon_facts_hash: '));
  const b = editLore(bundle(), 'value: green', 'value: grey');
  const raw = rawRun(b);
  const after = lines(raw).find((l) => l.startsWith('canon_facts_hash: '));
  assert.notEqual(after, before);
  assert.deepEqual(gateRunner.parseGateOutput(raw).score, [9, 9], 'the edited bible still validates');
});

// ---------- the advisory tier: warns, never fails ----------

test('advisory: a near-miss spelling warns and never moves the score', () => {
  const b = bundle();
  b.chapter.markdown += 'She signed the manifest as Marra Vale, the way the old forger taught her.\n';
  const raw = rawRun(b);
  const out = lines(raw);
  assert.equal(out.includes('WARN near-miss Marra ~ mara'), true);
  assert.equal(out.includes('advisories: 1'), true);
  assert.deepEqual(gateRunner.parseGateOutput(raw), { score: [9, 9], fails: [] });
});

test('advisory: an unlisted recurring entity warns and never moves the score', () => {
  const b = bundle();
  b.chapter.markdown += 'The fence they called Kessler waited by the tram, and Kessler never waited well.\n';
  const raw = rawRun(b);
  const out = lines(raw);
  assert.equal(out.includes('WARN unlisted-entity Kessler x2'), true);
  assert.equal(out.includes('advisories: 1'), true);
  assert.deepEqual(gateRunner.parseGateOutput(raw), { score: [9, 9], fails: [] });
});

// ---------- surface + card contract ----------

test('every emitted FAIL token is v2 and inside the committed card inventory', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  const inventory = new Map(parsed.card.checks.map((c) => [c.id, c.category]));
  const b = bundle();
  b.lore = '# LORE\n\nno machine slice at all\n';
  b.chapter.markdown = '# ch-vault-heist\n\nA chapter with no frontmatter and none of the cast named.\n';
  const worst = runOn(b);
  assert.equal(worst.fails.length >= 6, true, `broad-failure bundle dropped ${worst.fails.length}`);
  for (const fail of worst.fails) {
    const cls = gateRunner.classifyFail(fail);
    assert.equal(cls.v2, true, `${fail} is v2`);
    assert.equal(inventory.get(cls.id), cls.category, `${fail} in inventory`);
  }
});

test('committed card declares the 9-check inventory and the 6-mutant fluent pool', () => {
  const parsed = seal.parseGateCard(fs.readFileSync(CARD_FILE, 'utf8'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.card.gateId, 'lore-consistency');
  assert.deepEqual(
    parsed.card.checks.map((c) => c.id),
    ['LC-01', 'LC-02', 'LC-03', 'LC-04', 'LC-05', 'LC-06', 'LC-07', 'LC-08', 'LC-09']
  );
  assert.equal(parsed.card.templates, null, 'single-template card');
  assert.equal(parsed.card.hasTopLevelValidation, true);
  assert.equal(parsed.card.poolMin, 6);
  assert.equal(parsed.card.poolStatus, 'full');
  assert.equal(parsed.card.mutants.length, 6);
  assert.equal(parsed.card.mutants.every((m) => m.mutantClass === 'fluent-but-wrong'), true);
  assert.deepEqual(
    parsed.card.mutants.map((m) => m.mustFail.join(',')),
    ['LC-05', 'LC-04', 'LC-03', 'LC-05', 'LC-06', 'LC-08']
  );
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

// ---------- sealed end-to-end through the framework ----------

/** Seal the reference + pool into a fresh store and return cardMarkdown args. */
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

test('e2e: seal the pool, validateGateCard green, reference 9/9, all 6 mutants caught', () => {
  const store = mkTemp('lore-gate-store-');
  const repo = initRepo({ 'README.md': 'clean hermetic repo\n' });
  const pool = sealPool(store, gen.mintNonce());
  const card = gen.cardMarkdown({ ...pool, rotationK: 6 });
  const r = seal.validateGateCard(card, {
    repoRoot: repo,
    storeRoot: store,
    runId: 'W3-LORE-01',
    gateCmd: GATE_CMD,
    gateScriptPath: GATE,
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.runRecord.gateId, 'lore-consistency');
  assert.deepEqual(r.runRecord.referenceScore, [9, 9], 'reference is M/M');
  assert.equal(r.runRecord.sampled.length, 6, 'rotation_k 6 samples the full pool');
  for (const s of r.runRecord.sampled) {
    assert.equal(s.fails.length >= 1, true, `${s.id} was caught`);
  }
});

test('e2e: replaying the same runId reproduces the sample', () => {
  const store = mkTemp('lore-gate-store-');
  const pool = sealPool(store, gen.mintNonce());
  const card = gen.cardMarkdown({ ...pool, rotationK: 2 });
  const first = seal.validateGateCard(card, { storeRoot: store, runId: 'W3-LORE-REPLAY' });
  const second = seal.validateGateCard(card, { storeRoot: store, runId: 'W3-LORE-REPLAY' });
  assert.deepEqual(
    first.runRecord.sampled.map((s) => s.id),
    second.runRecord.sampled.map((s) => s.id)
  );
  assert.equal(first.runRecord.sampled.length, 2);
});

test('e2e: sealing fixture content that is committed in the repo is rejected, not laundered', () => {
  const store = mkTemp('lore-gate-store-');
  const nonce = gen.mintNonce();
  const refContent = gen.referenceContent({ nonce });
  const repo = initRepo({ 'book/bundles/committed-bundle.json': refContent });
  const pool = sealPool(store, nonce);
  const card = gen.cardMarkdown({ ...pool, rotationK: 6 });
  const r = seal.validateGateCard(card, { repoRoot: repo, storeRoot: store });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_FIXTURE_REPO_VISIBLE');
  assert.equal(
    r.errors.some((e) => e.code === 'E_FIXTURE_REPO_VISIBLE' && e.role === 'reference'),
    true
  );
});

// ---------- gate-runner byte-compat despite the extra receipt lines ----------

test('byte-compat: FAIL + INDET + WARN + hash + verdict lines parse to the exact score and fails', () => {
  // 1 bundle that produces every extra surface at once: a lifecycle FAIL, an
  // INDET abstention, and an advisory WARN, all around the A4 receipt lines.
  const b = editLore(bundle(), 'introduced: ch-cold-open:70', 'introduced: ch-side-story:9');
  editChapter(b, 'additional_on_stage: [night-ledger]', 'additional_on_stage: [night-ledger, wren-tam]');
  b.chapter.markdown += 'Wren Tam kept the count, and the fence they called Kessler watched, and Kessler smiled.\n';
  const raw = rawRun(b);
  const out = lines(raw);
  assert.equal(out.includes('FAIL LC-04 relation'), true);
  assert.equal(out.includes('INDET LC-04 intro-chapter-unledgered'), true);
  assert.equal(out.includes('WARN unlisted-entity Kessler x2'), true);
  assert.equal(out.includes(BREACHED_8_LINE), true);
  assert.equal(out[out.length - 1], 'gate: 8/9');
  // The parser sees exactly the machine surface: last summary wins, FAIL lines
  // only, and the verdict line's own (8/9 ...) text never confuses it.
  const parsed = gateRunner.parseGateOutput(raw);
  assert.deepEqual(parsed, { score: [8, 9], fails: ['LC-04 relation'] });
  const viaRunner = gateRunner.runGate({ gateCmd: GATE_CMD, artifactPath: writeBundle(b) });
  assert.deepEqual(viaRunner, parsed);
});

test('byte-compat: runGate on a clean run ignores the verdict and hash lines entirely', () => {
  const raw = rawRun(bundle());
  assert.equal(raw.includes('LORE GATE: CONTRACT HONORED'), true);
  assert.equal(raw.includes('canon_facts_hash: '), true);
  assert.deepEqual(gateRunner.parseGateOutput(raw), { score: [9, 9], fails: [] });
});
