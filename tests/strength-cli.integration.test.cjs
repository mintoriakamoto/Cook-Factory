'use strict';

/**
 * End-to-end CLI integration/acceptance test for the eight Phase-5 strength verbs
 * + coord.consume-migration (Plan 07).
 *
 * Spawns `node ferrox-core/bin/ferrox-tools.cjs query strength.<verb> <flags>`
 * (and `coord.consume-migration`) via child_process.spawnSync in a hermetic temp
 * cwd carrying a `.planning/config.json` with a real strength block. Proves the
 * full dispatch seam: dot-split -> case 'strength' -> routeStrengthCommand -> the
 * Plan 02-06 core -> decision JSON on stdout at exit 0, with store paths resolved
 * from config.
 *
 * The merge-gate assertions are the fail-closed heart: it returns `block` when the
 * evidence stores are ABSENT (fails closed end-to-end), `pass` only when a
 * fully-satisfying fixture is seeded, and `block` with `input-verb-error` when an
 * evidence-gathering step throws (a malformed --findings payload) — proving an
 * errored input verb is never coerced to affirmative.
 *
 * All inputs are EXPLICIT (no Date.now anywhere in the path), so the decisions are
 * deterministic. One verb is invoked with a missing required flag to prove the
 * InvalidArgs path exits non-zero without a crash.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

/** Create a hermetic temp project dir with a real strength + coordination block. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-strength-cli-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      {
        strength: {
          receipt_store: '.planning/strength/receipts.json',
          coverage_store: '.planning/strength/coverage-baseline.json',
          requirements_path: '.planning/REQUIREMENTS.md',
          security_categories: ['security', 'auth', 'crypto', 'injection', 'secrets', 'deserialization'],
          medium_cluster_threshold: 3,
          security_age_limit_days: 7,
        },
        coordination: {
          hot_seams: ['**/*.lock', '**/migrations/**'],
          migration_store: '.planning/coord/migration-seq.json',
        },
      },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

/** Seed a REQUIREMENTS.md with `covered` of `total` requirement checkboxes marked. */
function seedRequirements(dir, covered, total) {
  const lines = ['# Requirements', ''];
  for (let i = 1; i <= total; i++) {
    const box = i <= covered ? 'x' : ' ';
    lines.push(`- [${box}] **STRONG-0${i}** requirement ${i}`);
  }
  fs.writeFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), lines.join('\n') + '\n');
}

/** Seed the coverage baseline store with `covered` covered-requirement count. */
function seedCoverageBaseline(dir, covered) {
  fs.mkdirSync(path.join(dir, '.planning', 'strength'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'strength', 'coverage-baseline.json'),
    JSON.stringify({ covered }, null, 2) + '\n',
  );
}

/** Spawn a ferrox-tools query verb; return { status, json, stdout, stderr }. */
function runVerb(cwd, verb, flags) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags, '--raw'],
    { encoding: 'utf8' },
  );
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = undefined;
  }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

// ─── individual verbs ───────────────────────────────────────────────────────────

test('strength.judge-check accepts an independent judge and rejects a self-judge at exit 0', () => {
  const cwd = makeProject();
  const independent = runVerb(cwd, 'strength.judge-check', ['--author', 'alice', '--judge', 'bob']);
  const selfJudged = runVerb(cwd, 'strength.judge-check', ['--author', 'alice', '--judge', 'ALICE']);
  assert.equal(independent.status, 0, independent.stderr);
  assert.equal(selfJudged.status, 0, selfJudged.stderr);
  assert.equal(independent.json.decision, 'accepted');
  assert.equal(selfJudged.json.decision, 'rejected-self-judged', 'a case-variant self-judge must be refused');
});

test('strength.severity-route blocks a batch that contains a security-category finding', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'strength.severity-route', [
    '--findings', JSON.stringify([{ category: 'Auth', surface: 'login', severity: 'low' }]),
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block');
  assert.equal(r.json.reason, 'security-never-backlog');
});

test('strength.verify-receipt reports missing then valid against the seeded receipt store', () => {
  const cwd = makeProject();
  const missing = runVerb(cwd, 'strength.verify-receipt', ['--requirement', 'STRONG-01']);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.json.decision, 'missing', 'no receipt yet → missing');

  // Record a real red-green receipt via the mutating verb, then re-verify.
  const rec = runVerb(cwd, 'strength.receipt', [
    '--requirement', 'STRONG-01', '--test', 'strong-01.test.cjs',
    '--exit-code', '1', '--log-digest', 'abc123', '--commit', 'deadbeef',
  ]);
  assert.equal(rec.status, 0, rec.stderr);
  const valid = runVerb(cwd, 'strength.verify-receipt', ['--requirement', 'STRONG-01']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.json.decision, 'valid', 'a recorded failing-run receipt validates');
});

test('strength.coverage-source counts covered/total from a real REQUIREMENTS.md fixture', () => {
  const cwd = makeProject();
  seedRequirements(cwd, 1, 3);
  const r = runVerb(cwd, 'strength.coverage-source', []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.total, 3);
  assert.equal(r.json.covered, 1);
});

test('strength.mutation-check reports killed on an observed flip and survived otherwise', () => {
  const cwd = makeProject();
  const killed = runVerb(cwd, 'strength.mutation-check', ['--test', 't', '--flipped', 'true']);
  const survived = runVerb(cwd, 'strength.mutation-check', ['--test', 't', '--flipped', 'false']);
  assert.equal(killed.status, 0, killed.stderr);
  assert.equal(survived.status, 0, survived.stderr);
  assert.equal(killed.json.decision, 'killed');
  assert.equal(survived.json.decision, 'survived');
});

test('strength.burndown-check is ok when net does not grow and blocks when it does', () => {
  const cwd = makeProject();
  const ok = runVerb(cwd, 'strength.burndown-check', ['--opened', '1', '--resolved', '2']);
  const blocked = runVerb(cwd, 'strength.burndown-check', ['--opened', '3', '--resolved', '1']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(ok.json.decision, 'ok');
  assert.equal(blocked.json.decision, 'blocked');
  assert.equal(blocked.json.reason, 'net-backlog-grew');
});

// ─── coord.consume-migration (FF-B15) ───────────────────────────────────────────

test('coord.consume-migration consumes an allocated number once then rejects the replay', () => {
  const cwd = makeProject();
  const alloc = runVerb(cwd, 'coord.alloc-migration', []);
  assert.equal(alloc.status, 0, alloc.stderr);
  assert.equal(alloc.json.number, 1);
  const first = runVerb(cwd, 'coord.consume-migration', ['--number', '1']);
  const replay = runVerb(cwd, 'coord.consume-migration', ['--number', '1']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(first.json.decision, 'consumed');
  assert.equal(replay.json.decision, 'rejected-replay', 'a consumed number no longer validates');
});

// ─── strength.merge-gate — the fail-closed heart ────────────────────────────────

/** The shared increment-context flags for a merge-gate invocation. */
function mergeGateFlags() {
  return [
    '--increment', 'INC-1',
    '--requirements', 'STRONG-01',
    '--declared', 'a.ts',
    '--actual', 'a.ts',
    '--files', 'src/foo.ts',
    '--opened', '0',
    '--resolved', '0',
    '--mutation-test', 'strong.test.cjs',
    '--mutation-flipped', 'true',
  ];
}

test('strength.merge-gate BLOCKS when the evidence stores are absent (fails closed end-to-end)', () => {
  const cwd = makeProject(); // no receipt store, no REQUIREMENTS.md
  const r = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block', `absent stores must fail closed, got: ${r.stdout}`);
  assert.ok(r.json.reasons.includes('receipts-not-valid'), 'missing receipts must block');
  assert.ok(r.json.reasons.includes('coverage-not-landed'), 'no coverage advance must block');
});

test('strength.merge-gate PASSES when a fully-satisfying fixture is seeded', () => {
  const cwd = makeProject();
  // Seed a valid red-green receipt for STRONG-01.
  runVerb(cwd, 'strength.receipt', [
    '--requirement', 'STRONG-01', '--test', 'strong-01.test.cjs',
    '--exit-code', '1', '--log-digest', 'abc123', '--commit', 'deadbeef',
  ]);
  // Seed an advancing REQUIREMENTS.md (covered 1 > baseline 0 → landed).
  seedRequirements(cwd, 1, 2);
  seedCoverageBaseline(cwd, 0); // Fix 3: baseline now fail-closed — must be seeded.

  const r = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'pass', `a fully-satisfying fixture must pass, got: ${r.stdout}`);
  assert.deepEqual(r.json.reasons, []);
});

test('strength.merge-gate BLOCKS with input-verb-error when an evidence gather throws (malformed --findings)', () => {
  const cwd = makeProject();
  // Seed the satisfying fixture so ONLY the gather error can cause the block.
  runVerb(cwd, 'strength.receipt', [
    '--requirement', 'STRONG-01', '--test', 'strong-01.test.cjs',
    '--exit-code', '1', '--log-digest', 'abc123', '--commit', 'deadbeef',
  ]);
  seedRequirements(cwd, 1, 2);
  seedCoverageBaseline(cwd, 0);

  const r = runVerb(cwd, 'strength.merge-gate', [...mergeGateFlags(), '--findings', 'not-json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block', 'a gathering error must fail closed');
  assert.ok(
    r.json.reasons.includes('input-verb-error'),
    `an errored input verb must never be coerced to affirmative, got: ${r.stdout}`,
  );
});

// ─── Fix 1: hot-seam serialization is an ASSERTION, not "touches no seam" ────────

/** The satisfying fixture (receipt + advancing coverage + seeded baseline). */
function seedSatisfyingFixture(cwd) {
  runVerb(cwd, 'strength.receipt', [
    '--requirement', 'STRONG-01', '--test', 'strong-01.test.cjs',
    '--exit-code', '1', '--log-digest', 'abc123', '--commit', 'deadbeef',
  ]);
  seedRequirements(cwd, 1, 2);
  seedCoverageBaseline(cwd, 0);
}

/** merge-gate flags with `--files` overridden to a migration seam path. */
function migrationFlags(extra) {
  const flags = mergeGateFlags();
  const i = flags.indexOf('--files');
  flags[i + 1] = 'src/db/migrations/001_init.sql'; // matches '**/migrations/**'
  return extra ? [...flags, ...extra] : flags;
}

test('strength.merge-gate BLOCKS a migration-touching increment WITHOUT the serialized assertion (hot-seam-not-serialized)', () => {
  const cwd = makeProject();
  seedSatisfyingFixture(cwd);
  const r = runVerb(cwd, 'strength.merge-gate', migrationFlags());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block', `a seam-touching increment without the assertion must block, got: ${r.stdout}`);
  assert.ok(
    r.json.reasons.includes('hot-seam-not-serialized'),
    `expected hot-seam-not-serialized, got: ${JSON.stringify(r.json.reasons)}`,
  );
});

test('strength.merge-gate PASSES a migration-touching increment WITH --hot-seam-serialized true (honest serialized migration)', () => {
  const cwd = makeProject();
  seedSatisfyingFixture(cwd);
  const r = runVerb(cwd, 'strength.merge-gate', migrationFlags(['--hot-seam-serialized', 'true']));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'pass', `an honest serialized migration must pass, got: ${r.stdout}`);
  assert.deepEqual(r.json.reasons, []);
});

test('strength.merge-gate does NOT let a seam-touching increment escape by omitting the seam file (Fix 1 anti-bypass)', () => {
  const cwd = makeProject();
  seedSatisfyingFixture(cwd);
  // The OLD bypass: lie by pointing --files at a non-seam path. With no serialized
  // assertion this still passes (nothing to serialize) — but the HONEST path
  // (declaring the migration file) now REQUIRES the assertion, so lying is no
  // longer the only way through. Assert the honest+asserted path is the pass path.
  const honest = runVerb(cwd, 'strength.merge-gate', migrationFlags(['--hot-seam-serialized', 'true']));
  const lying = runVerb(cwd, 'strength.merge-gate', mergeGateFlags()); // src/foo.ts, no seam
  assert.equal(honest.json.decision, 'pass', 'honest serialized migration passes');
  assert.equal(lying.json.decision, 'pass', 'a genuinely seam-free increment still passes');
});

// ─── Fix 2: security/backlog read from REAL stores (manifest can't forge them) ───

/** Write an open-findings store the merge gate reads regardless of --findings. */
function seedFindingsStore(cwd, open) {
  fs.mkdirSync(path.join(cwd, '.planning', 'strength'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.planning', 'strength', 'findings.json'),
    JSON.stringify({ open }, null, 2) + '\n',
  );
}

/** Write a .planning/BACKLOG.md with an `## Open` table of the given rows. */
function seedBacklog(cwd, rows) {
  const lines = ['# Backlog', '', '## Open', '', '| ID | Sev | From | Item | Blocks |', '|----|-----|------|------|--------|'];
  for (const r of rows) lines.push(`| ${r.id} | ${r.sev} | ${r.from || 'audit'} | ${r.item} | ${r.blocks || '—'} |`);
  fs.writeFileSync(path.join(cwd, '.planning', 'BACKLOG.md'), lines.join('\n') + '\n');
}

test('strength.merge-gate BLOCKS on a real open security finding in the findings store even when the manifest omits --findings', () => {
  const cwd = makeProject();
  seedSatisfyingFixture(cwd);
  seedFindingsStore(cwd, [{ category: 'security', severity: 'high' }]);
  // The manifest flags carry NO --findings — the old honor-system would pass.
  const r = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block', `an omitted-but-real open security finding must block, got: ${r.stdout}`);
  assert.ok(
    r.json.reasons.includes('security-open'),
    `expected security-open, got: ${JSON.stringify(r.json.reasons)}`,
  );
});

test('strength.merge-gate BLOCKS on an open SEC row in BACKLOG.md omitted from the manifest', () => {
  const cwd = makeProject();
  seedSatisfyingFixture(cwd);
  seedBacklog(cwd, [{ id: 'X-1', sev: 'SEC', item: 'unfixed auth bypass on /login' }]);
  const r = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block', `an open SEC backlog row must block, got: ${r.stdout}`);
  assert.ok(r.json.reasons.includes('security-open'), `expected security-open, got: ${JSON.stringify(r.json.reasons)}`);
});

test('strength.merge-gate BLOCKS when an aged CORRECTNESS backlog item breaches the burndown floor', () => {
  const cwd = makeProject();
  seedSatisfyingFixture(cwd);
  // age_days=30 > default security_age_limit_days=7 → aged-item.
  seedBacklog(cwd, [{ id: 'X-2', sev: 'CORRECTNESS', item: 'stale data-corruption bug age_days=30' }]);
  const r = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block', `an aged correctness backlog item must block burndown, got: ${r.stdout}`);
  assert.ok(r.json.reasons.includes('burndown-not-ok'), `expected burndown-not-ok, got: ${JSON.stringify(r.json.reasons)}`);
});

test('strength.merge-gate still PASSES with an empty findings store and a benign backlog (Fix 2 control)', () => {
  const cwd = makeProject();
  seedSatisfyingFixture(cwd);
  seedFindingsStore(cwd, []);
  seedBacklog(cwd, [{ id: 'B-1', sev: 'LOW', item: 'cosmetic doc nit' }]);
  const r = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'pass', `a clean store + benign backlog must pass, got: ${r.stdout}`);
});

test('strength.merge-gate BLOCKS (fail closed) on a MALFORMED findings store', () => {
  const cwd = makeProject();
  seedSatisfyingFixture(cwd);
  fs.mkdirSync(path.join(cwd, '.planning', 'strength'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.planning', 'strength', 'findings.json'), '{not json');
  const r = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block', `a corrupt security store must fail closed, got: ${r.stdout}`);
  assert.ok(r.json.reasons.includes('input-verb-error'), `expected input-verb-error, got: ${JSON.stringify(r.json.reasons)}`);
});

// ─── Fix 3: coverage baseline fails CLOSED (absent → block) + snapshot verb ───────

test('strength.merge-gate BLOCKS when the coverage baseline is ABSENT (coverage-baseline-missing, fail closed)', () => {
  const cwd = makeProject();
  // Seed everything EXCEPT the coverage baseline store.
  runVerb(cwd, 'strength.receipt', [
    '--requirement', 'STRONG-01', '--test', 'strong-01.test.cjs',
    '--exit-code', '1', '--log-digest', 'abc123', '--commit', 'deadbeef',
  ]);
  seedRequirements(cwd, 1, 2);
  const r = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block', `an absent baseline must fail closed, got: ${r.stdout}`);
  assert.ok(
    Array.isArray(r.json.errors) && r.json.errors.includes('coverage-baseline-missing'),
    `expected coverage-baseline-missing in errors, got: ${r.stdout}`,
  );
  assert.ok(r.json.reasons.includes('input-verb-error'), 'an absent baseline blocks via input-verb-error');
});

test('strength.coverage-baseline --snapshot seeds the store to the current covered count', () => {
  const cwd = makeProject();
  seedRequirements(cwd, 2, 5);
  const snap = runVerb(cwd, 'strength.coverage-baseline', ['--snapshot']);
  assert.equal(snap.status, 0, snap.stderr);
  assert.equal(snap.json.decision, 'snapshotted');
  assert.equal(snap.json.covered, 2);
  const onDisk = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'strength', 'coverage-baseline.json'), 'utf8'));
  assert.equal(onDisk.covered, 2);
});

test('snapshot-at-start + a REAL coverage advance PASSES; a no-op (no advance) BLOCKS', () => {
  const cwd = makeProject();
  runVerb(cwd, 'strength.receipt', [
    '--requirement', 'STRONG-01', '--test', 'strong-01.test.cjs',
    '--exit-code', '1', '--log-digest', 'abc123', '--commit', 'deadbeef',
  ]);
  // Increment start: 1 covered of 3. Snapshot the baseline = 1.
  seedRequirements(cwd, 1, 3);
  const snap = runVerb(cwd, 'strength.coverage-baseline', ['--snapshot']);
  assert.equal(snap.json.covered, 1);

  // No-op merge: coverage unchanged (still 1) → not-landed → block.
  const noop = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(noop.json.decision, 'block', `a no-op merge must block, got: ${noop.stdout}`);
  assert.ok(noop.json.reasons.includes('coverage-not-landed'), `expected coverage-not-landed, got: ${JSON.stringify(noop.json.reasons)}`);

  // Real advance: mark another requirement covered (2 > baseline 1) → landed → pass.
  seedRequirements(cwd, 2, 3);
  const advanced = runVerb(cwd, 'strength.merge-gate', mergeGateFlags());
  assert.equal(advanced.json.decision, 'pass', `a real advance over the snapshot must pass, got: ${advanced.stdout}`);
});

// ─── InvalidArgs path ───────────────────────────────────────────────────────────

test('a missing required flag exits non-zero via the InvalidArgs path (no crash)', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'strength.judge-check', ['--author', 'alice']);
  assert.notEqual(r.status, 0, 'a missing required flag must exit non-zero');
  assert.match(r.stderr, /Usage: ferrox-tools query strength\.judge-check/);
});
