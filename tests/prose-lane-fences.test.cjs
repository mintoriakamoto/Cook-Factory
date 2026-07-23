'use strict';

/**
 * MILESTONE v1.13 Wave 0: prose-lane fences (blockers B1-B5).
 *
 * Two halves, following tests/brainstorm-seam.test.cjs. (1) Behavioral proof
 * against the REAL merge-gate guard hook + real strength verb: a non-code
 * config domain (writing and its gate-select aliases) waives ONLY the 2 code
 * instruments (coverage delta, mutation kill) with a loud 1-line notice, and a
 * code/absent domain produces BYTE-IDENTICAL v1.12 output (exact stdout
 * equality on both the block and the allow paths). (2) Text-contract
 * assertions on the workflow surfaces (prompts, not executable code): the 5
 * sniff sites carry the non-code domain condition, verify-work and the
 * verifier carry the non-code branches, and the software-path text at every
 * site is still present verbatim. Plus the B4 no-change proof: crucible
 * routing in anvil-eligibility is untouched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'ferrox-merge-gate-guard.js');
const FERROX_TOOLS = path.join(ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const read = (f) => fs.readFileSync(f, 'utf8');

const { selectGate } = require('../ferrox-core/bin/lib/gate-select.cjs');
const { evaluateGateFirstEligibility } = require('../ferrox-core/bin/lib/anvil-eligibility.cjs');

// The Wave 0 non-code set: canonical keys per the milestone (A8) plus every
// gate-select alias that resolves to one of them.
const NON_CODE_CANONICAL = ['writing', 'long-form', 'research'];

/** Extract the ALIASES table entries from src/gate-select.cts (the authority). */
function gateSelectAliases() {
  const src = read(path.join(ROOT, 'src', 'gate-select.cts'));
  const block = /const ALIASES[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'ALIASES table must be extractable from src/gate-select.cts');
  const out = {};
  const re = /^\s*'?([a-z0-9-]+)'?:\s*'([a-z0-9-]+)',\s*$/gm;
  let m;
  while ((m = re.exec(block[1])) !== null) out[m[1]] = m[2];
  assert.ok(Object.keys(out).length >= 20, 'alias extraction must find the table');
  return out;
}

/** The alias keys that resolve to a non-code canonical, per gate-select. */
function nonCodeAliasKeys() {
  const aliases = gateSelectAliases();
  return Object.keys(aliases).filter((k) => NON_CODE_CANONICAL.includes(aliases[k]));
}

// ─── merge-gate guard fixtures (idiom from strength-merge-gate-hook.test.cjs) ─

function makeProject(domain) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-plf-'));
  fs.mkdirSync(path.join(dir, '.planning', 'strength'), { recursive: true });
  const cfg = {
    strength: {
      receipt_store: '.planning/strength/receipts.json',
      coverage_store: '.planning/strength/coverage-baseline.json',
      requirements_path: '.planning/REQUIREMENTS.md',
      security_categories: ['security', 'auth', 'crypto', 'injection', 'secrets', 'deserialization'],
      medium_cluster_threshold: 3,
      security_age_limit_days: 7,
    },
    coordination: { hot_seams: ['**/*.lock', '**/migrations/**'], migration_store: '.planning/coord/migration-seq.json' },
  };
  if (domain !== undefined) cfg.domain = domain;
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  return dir;
}

function seedManifest(dir, overrides) {
  const base = {
    increment: 'INC-1',
    requirements: ['STRONG-01'],
    declared: 'a.ts',
    actual: 'a.ts',
    files: 'src/foo.ts',
    opened: 0,
    resolved: 0,
    mutation_test: 'strong.test.cjs',
    mutation_flipped: true,
  };
  fs.writeFileSync(
    path.join(dir, '.planning', 'strength', 'merge-gate-request.json'),
    JSON.stringify(Object.assign(base, overrides || {}), null, 2) + '\n',
  );
}

function seedRequirements(dir, covered, total) {
  const lines = ['# Requirements', ''];
  for (let i = 1; i <= total; i++) lines.push(`- [${i <= covered ? 'x' : ' '}] **STRONG-0${i}** requirement ${i}`);
  fs.writeFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), lines.join('\n') + '\n');
}

function seedCoverageBaseline(dir, covered) {
  fs.writeFileSync(path.join(dir, '.planning', 'strength', 'coverage-baseline.json'), JSON.stringify({ covered }, null, 2) + '\n');
}

function seedReceipt(dir, requirement) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', dir, 'query', 'strength.receipt', '--requirement', requirement,
      '--test', 'strong-01.test.cjs', '--exit-code', '1', '--log-digest', 'abc123', '--commit', 'deadbeef', '--raw'],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, `seedReceipt failed: ${res.stderr}`);
}

function runHook(cwd) {
  const event = { tool_name: 'Bash', tool_input: { command: 'git merge --no-ff feature/x' }, cwd };
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: 'utf8' });
}

/** A fixture where EVERYTHING passes except the named code instruments. */
function seedCodeInstrumentFailure(domain, { coverageFails = true, mutationFails = false } = {}) {
  const dir = makeProject(domain);
  seedManifest(dir, mutationFails ? { mutation_flipped: false } : {});
  seedReceipt(dir, 'STRONG-01');
  seedRequirements(dir, 1, 2);
  seedCoverageBaseline(dir, coverageFails ? 1 : 0); // covered 1 vs baseline 1 → no advance
  return dir;
}

/** A fully green fixture (the v1.12 pass fixture, verbatim seeds). */
function seedPassFixture(domain) {
  const dir = makeProject(domain);
  seedManifest(dir);
  seedReceipt(dir, 'STRONG-01');
  seedRequirements(dir, 1, 2);
  seedCoverageBaseline(dir, 0);
  return dir;
}

// The exact v1.12 block output for a coverage-only failure. The byte-identical
// contract: a code (or absent) domain project must emit precisely this.
const LEGACY_COVERAGE_BLOCK = JSON.stringify({
  decision: 'block',
  reason: 'Merge-gate guard: the strength merge-gate did not pass (coverage-not-landed). This merge/ship/release is blocked until the gate returns pass.',
});

// ─── B1: guard hook waiver behavior ──────────────────────────────────────────

test('B1 byte-identical: code domain, coverage failure → the exact v1.12 block bytes (exit 2)', () => {
  const r = runHook(seedCodeInstrumentFailure('code'));
  assert.equal(r.status, 2, `code domain must still block: ${r.stdout} ${r.stderr}`);
  assert.equal(r.stdout, LEGACY_COVERAGE_BLOCK, 'block output must be byte-identical to v1.12');
});

test('B1 byte-identical: ABSENT domain behaves exactly like code (same bytes, exit 2)', () => {
  const rCode = runHook(seedCodeInstrumentFailure('code'));
  const rNone = runHook(seedCodeInstrumentFailure(undefined));
  assert.equal(rNone.status, 2);
  assert.equal(rNone.stdout, rCode.stdout, 'absent domain and code domain must emit identical bytes');
  assert.equal(rNone.stdout, LEGACY_COVERAGE_BLOCK);
});

test('B1 byte-identical: fully green code fixture still allows with EMPTY stdout (exit 0)', () => {
  const r = runHook(seedPassFixture('code'));
  assert.equal(r.status, 0, `green code fixture must pass: ${r.stdout} ${r.stderr}`);
  assert.equal(r.stdout, '', 'an allowed software merge emits nothing, exactly as in v1.12');
});

test('B1 waiver: writing domain, coverage-only failure → ALLOWED with a loud 1-line waiver', () => {
  const r = runHook(seedCodeInstrumentFailure('writing'));
  assert.equal(r.status, 0, `writing domain must waive coverage: ${r.stdout} ${r.stderr}`);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'the waiver is exactly 1 line');
  assert.match(lines[0], /NON-CODE DOMAIN WAIVER/);
  assert.match(lines[0], /'writing' -> 'writing'/);
  assert.match(lines[0], /coverage-not-landed/);
  assert.match(lines[0], /code-suite instruments/);
});

test('B1 waiver: coverage AND mutation both waived together, both named in the line', () => {
  const r = runHook(seedCodeInstrumentFailure('writing', { coverageFails: true, mutationFails: true }));
  assert.equal(r.status, 0, `both instruments must be waivable: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /coverage-not-landed \+ mutation-survived/);
});

test('B1 waiver: alias + normalization forms resolve through gate-select rules', () => {
  for (const domain of ['reports', 'Long Form', 'factual_synthesis', 'content']) {
    const r = runHook(seedCodeInstrumentFailure(domain));
    assert.equal(r.status, 0, `domain '${domain}' must waive: ${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /NON-CODE DOMAIN WAIVER/);
  }
});

test('B1 strictness: writing domain does NOT waive a non-instrument failure (missing receipts)', () => {
  const dir = makeProject('writing');
  seedManifest(dir); // no receipt, no REQUIREMENTS.md → receipts/coverage both fail
  const r = runHook(dir);
  assert.equal(r.status, 2, 'a receipts failure must still block a writing project');
  assert.match(r.stdout, /"decision":"block"/);
});

test('B1 strictness: fully green writing fixture allows with EMPTY stdout (nothing to waive)', () => {
  const r = runHook(seedPassFixture('writing'));
  assert.equal(r.status, 0, `green writing fixture must pass: ${r.stdout} ${r.stderr}`);
  assert.equal(r.stdout, '', 'no waiver line when nothing was waived');
});

test('B1 impossibility: code-family domains can never enter the waiver branch', () => {
  for (const domain of ['code', 'web-ui', 'data-sql', 'infra', 'agentic', '']) {
    const r = runHook(seedCodeInstrumentFailure(domain));
    assert.equal(r.status, 2, `domain '${domain}' must never be waived`);
    assert.doesNotMatch(r.stdout, /WAIVER/);
  }
});

// ─── drift guard: the hook alias table mirrors gate-select ──────────────────

test('the hook non-code alias table agrees with src/gate-select.cts exactly', () => {
  const hookSrc = read(HOOK);
  const block = /const NON_CODE_ALIASES = \{([\s\S]*?)\n\};/.exec(hookSrc);
  assert.ok(block, 'NON_CODE_ALIASES must exist in the hook');
  const hookAliases = {};
  const re = /^\s*'?([a-z0-9-]+)'?:\s*'([a-z0-9-]+)',\s*$/gm;
  let m;
  while ((m = re.exec(block[1])) !== null) hookAliases[m[1]] = m[2];
  const authority = gateSelectAliases();
  const expected = {};
  for (const k of Object.keys(authority)) {
    if (NON_CODE_CANONICAL.includes(authority[k])) expected[k] = authority[k];
  }
  assert.deepEqual(hookAliases, expected, 'hook alias table drifted from gate-select');
  // Belt and braces: the compiled selectGate agrees with every mapping.
  for (const k of Object.keys(expected)) {
    const sel = selectGate(k);
    assert.equal(sel.known, true, `alias '${k}' must be known to selectGate`);
  }
});

// ─── B5: the 5 sniff sites carry the domain condition ────────────────────────

const CASE_LINE = 'writing|long-form|research|reports|content|design|conversation|support|rag|factual-synthesis';

test('the sniff case list covers every non-code canonical + alias from gate-select', () => {
  const names = CASE_LINE.split('|');
  const expected = NON_CODE_CANONICAL.concat(nonCodeAliasKeys());
  assert.deepEqual(names.slice().sort(), expected.slice().sort(), 'case list drifted from gate-select');
});

test('B5a+B5b: post-merge-gate carries the domain condition on BOTH sniffs, software text intact', () => {
  const doc = read(path.join(ROOT, 'ferrox-core', 'workflows', 'execute-phase', 'steps', 'post-merge-gate.md'));
  assert.equal(doc.split(CASE_LINE).length - 1, 2, 'both Step A and Step B carry the case list');
  assert.match(doc, /build sniff skipped, no build step applies to prose deliverables/);
  assert.match(doc, /test sniff skipped, no code test runner applies to prose deliverables/);
  assert.match(doc, /TEST_CMD="true"\n/, 'non-code test sniff resolves to a no-op');
  // Software path unchanged:
  assert.match(doc, /TEST_CMD="npm test"/);
  assert.match(doc, /BUILD_CMD="npm run build"/);
  assert.match(doc, /BUILD_CMD="cargo build"/);
  assert.match(doc, /elif \[ -z "\$BUILD_CMD" \]; then/);
  assert.match(doc, /elif \[ -z "\$TEST_CMD" \]; then/);
});

test('B5c: regression-gate carries the domain condition, software sniff intact', () => {
  const doc = read(path.join(ROOT, 'ferrox-core', 'workflows', 'execute-phase', 'steps', 'regression-gate.md'));
  assert.ok(doc.includes(CASE_LINE), 'regression-gate carries the case list');
  assert.match(doc, /REG_TEST_CMD="true"\n\s*echo "Non-code domain/);
  assert.match(doc, /regression test sniff skipped, no code test runner applies to prose deliverables/);
  assert.match(doc, /REG_TEST_CMD="npm test"/);
  assert.match(doc, /elif \[ -z "\$REG_TEST_CMD" \]; then/);
});

test('B5d: audit-fix carries the domain condition, software sniff intact', () => {
  const doc = read(path.join(ROOT, 'ferrox-core', 'workflows', 'audit-fix.md'));
  assert.ok(doc.includes(CASE_LINE), 'audit-fix carries the case list');
  assert.match(doc, /AUDIT_TEST_CMD="true"\n\s*echo "Non-code domain/);
  assert.match(doc, /audit test sniff skipped, no code test runner applies to prose deliverables/);
  assert.match(doc, /AUDIT_TEST_CMD="npm test"/);
  assert.match(doc, /elif \[ -z "\$AUDIT_TEST_CMD" \]; then/);
});

test('B5e: tdd.md is injected ONLY for code domains (single, conditioned reference)', () => {
  const doc = read(path.join(ROOT, 'ferrox-core', 'workflows', 'execute-phase.md'));
  const refs = doc.split('references/tdd.md').length - 1;
  assert.equal(refs, 1, 'exactly 1 tdd.md reference, and it must be the conditioned one');
  assert.match(doc, /\$\{NONCODE_DOMAIN \? '' : '@~\/.claude\/ferrox-core\/references\/tdd\.md'\}/);
  assert.match(doc, /NONCODE_DOMAIN is an ORCHESTRATOR build-time fact/);
  assert.match(doc, /`writing`, `long-form`,\s*\n?\s*or `research`/);
});

// ─── B2: verify-work non-code UAT branch + taxonomy ─────────────────────────

test('B2: verify-work gains the non-code UAT branch, software smoke test untouched', () => {
  const doc = read(path.join(ROOT, 'ferrox-core', 'workflows', 'verify-work.md'));
  assert.match(doc, /Non-code domain branch \(v1\.13 Wave 0, B2\)/);
  assert.match(doc, /Deliverable Shape Test/);
  assert.match(doc, /exists, is non-empty, its frontmatter \(when declared\) parses as valid YAML/);
  assert.match(doc, /Do NOT inject the Cold Start Smoke Test/);
  assert.match(doc, /plan frontmatter|PLAN\.md files, falling back to `\.planning\/config\.json` `domain`/);
  // Software path unchanged:
  assert.match(doc, /Cold Start Smoke Test/);
  assert.match(doc, /Kill any running server\/service\./);
  // Blocker taxonomy gains non-code entries (both tables):
  assert.match(doc, /deliverable missing, file empty, frontmatter does not parse → blocker/);
  assert.match(doc, /\| Non-code \(writing\/long-form\/research\): "deliverable missing", "file empty", "frontmatter does not parse" \| blocker \|/);
  assert.match(doc, /"contradicts the canon", "wrong facts", "missing section", "broken citation" \| major \|/);
  // Software taxonomy rows still verbatim:
  assert.match(doc, /\| "crashes", "error", "exception", "fails completely" \| blocker \|/);
});

// ─── B3: verifier artifact-type guard ────────────────────────────────────────

test('B3: verifier gains the artifact-type guard on wiring AND the hollow check, greps untouched', () => {
  const doc = read(path.join(ROOT, 'agents', 'ferrox-verifier.md'));
  assert.equal(doc.split('Artifact-type guard (v1.13 Wave 0, B3)').length - 1, 2, 'guard appears at Level 3 and Level 4b');
  assert.match(doc, /Level 3 wiring is NOT an import grep/);
  assert.match(doc, /false ORPHANED/);
  assert.match(doc, /SKIP the React-hook and data-source greps/);
  assert.match(doc, /falling back to `\.planning\/config\.json` `domain`/);
  // Software path unchanged:
  assert.match(doc, /grep -r "import\.\*\$artifact_name"/);
  assert.match(doc, /useState\|useQuery\|useSWR\|useStore/);
});

// ─── B4: no router change — crucible routing conditions are untouched ───────

test('B4: anvil-eligibility crucible routing is byte-for-byte unchanged in behavior', () => {
  // writing + no gate → 2 blockers → normal (the v1.12 behavior the milestone locks).
  assert.deepEqual(
    evaluateGateFirstEligibility({ domain: 'writing', gatePresent: false, executorAvailable: true, enabled: true }).route,
    'normal',
  );
  // writing + gate present → domain-not-gateable is the SOLE reason → crucible.
  const r = evaluateGateFirstEligibility({ domain: 'writing', gatePresent: true, executorAvailable: true, enabled: true });
  assert.deepEqual(r.route, 'crucible');
  assert.deepEqual(r.reasons, ['domain-not-gateable']);
  // code + gate present → gate-first, eligible.
  const c = evaluateGateFirstEligibility({ domain: 'code', gatePresent: true, executorAvailable: true, enabled: true });
  assert.equal(c.eligible, true);
  assert.equal(c.route, 'gate-first');
  // research/long-form remain gate-first ROUTABLE domains (tier 4): the fences
  // in this wave must not have made them look un-gateable anywhere.
  for (const d of ['research', 'long-form']) {
    assert.equal(selectGate(d).route, 'gate-first', `${d} stays a tier-4 gate-first domain`);
  }
});
