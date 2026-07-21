'use strict';

/**
 * Red-green tests for the COORD-02 coord.ownership-check core.
 *
 * The ownership check is consulted AFTER each plan in a wave: given the files a
 * plan DECLARED it would modify and the files it ACTUALLY touched, an actual set
 * that is not a subset of the declared set is a HARD wave-invalidating signal
 * (never a swallowed warning). Two invariants under test:
 *   1. actual ⊆ declared -> { decision:'ok', undeclared:[] } and NOTHING logged.
 *   2. actual ⊄ declared -> { decision:'wave-invalidating', undeclared:[...] }
 *      listing the undeclared writes, plus EXACTLY ONE run-log entry
 *      (gate:'coord-ownership', trigger:'undeclared-write', ts = caller nowIso).
 *
 * Paths are normalized (leading ./ stripped, separators normalized) before the
 * subset comparison, so 'a.ts' and './a.ts' and 'a\\a.ts'-style separators are
 * the same file — a plan cannot dodge the check by re-spelling a declared path.
 *
 * The run-log targets a hermetic temp file via fs.mkdtempSync; nowIso is an
 * explicit input so the recorded ts is deterministic (no Date.now).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  evaluateOwnership,
  runOwnershipCheck,
} = require('../ferrox-core/bin/lib/coord-ownership-check.cjs');

function tmpLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-coord-ownership-'));
  return path.join(dir, 'halting-log.jsonl');
}

function readLog(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

// --- evaluateOwnership: pure decision, no fs, no clock ----------------------

test('evaluateOwnership returns ok with empty undeclared when actual is a subset of declared', () => {
  const result = evaluateOwnership({ declared: ['a.ts', 'b.ts'], actual: ['a.ts'] });
  assert.equal(result.decision, 'ok');
  assert.deepEqual(result.undeclared, []);
});

test('evaluateOwnership returns wave-invalidating (a HARD signal) listing the undeclared write', () => {
  const result = evaluateOwnership({ declared: ['a.ts'], actual: ['a.ts', 'secret.ts'] });
  assert.equal(result.decision, 'wave-invalidating');
  assert.notEqual(result.decision, 'warning', 'undeclared write is a hard invalidation, never a warning');
  assert.deepEqual(result.undeclared, ['secret.ts']);
});

test('evaluateOwnership normalizes leading ./ so a.ts and ./a.ts are the same file', () => {
  const result = evaluateOwnership({ declared: ['a.ts'], actual: ['./a.ts'] });
  assert.equal(result.decision, 'ok');
  assert.deepEqual(result.undeclared, []);
});

test('evaluateOwnership normalizes separators so declared src/a.ts matches actual src\\a.ts', () => {
  const result = evaluateOwnership({ declared: ['src/a.ts'], actual: ['src\\a.ts'] });
  assert.equal(result.decision, 'ok');
  assert.deepEqual(result.undeclared, []);
});

test('evaluateOwnership collects every undeclared write, normalized', () => {
  const result = evaluateOwnership({
    declared: ['src/a.ts'],
    actual: ['./src/a.ts', 'src/b.ts', 'src\\c.ts'],
  });
  assert.equal(result.decision, 'wave-invalidating');
  assert.deepEqual(result.undeclared, ['src/b.ts', 'src/c.ts']);
});

// --- runOwnershipCheck: thin logging wrapper --------------------------------

test('runOwnershipCheck appends EXACTLY ONE run-log entry on wave-invalidating', () => {
  const logPath = tmpLogPath();
  const result = runOwnershipCheck(
    { declared: ['a.ts'], actual: ['a.ts', 'secret.ts'], nowIso: '2026-07-19T00:00:00.000Z' },
    { logPath, increment: 'INC-001' },
  );

  assert.equal(result.decision, 'wave-invalidating');
  assert.deepEqual(result.undeclared, ['secret.ts']);

  const entries = readLog(logPath);
  assert.equal(entries.length, 1, 'exactly one run-log entry on wave-invalidating');
  assert.equal(entries[0].ts, '2026-07-19T00:00:00.000Z', 'ts is the caller nowIso verbatim');
  assert.equal(entries[0].gate, 'coord-ownership');
  assert.equal(entries[0].trigger, 'undeclared-write');
  assert.equal(entries[0].increment, 'INC-001');
  assert.deepEqual(entries[0].undeclared, ['secret.ts']);
});

test('runOwnershipCheck appends NOTHING on the ok path', () => {
  const logPath = tmpLogPath();
  const result = runOwnershipCheck(
    { declared: ['a.ts', 'b.ts'], actual: ['a.ts'], nowIso: '2026-07-19T01:00:00.000Z' },
    { logPath, increment: 'INC-002' },
  );

  assert.equal(result.decision, 'ok');
  assert.equal(readLog(logPath).length, 0, 'the ok path logs nothing');
});
