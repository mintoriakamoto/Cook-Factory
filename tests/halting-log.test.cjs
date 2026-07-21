'use strict';

/**
 * Red-green tests for the append-only halting run-log module (D-03).
 *
 * The run-log is the evidence surface every Phase-3 cap verb writes to and that
 * Phase 5 receipts + Phase 8 DOG-02 read as truth. The two invariants under test:
 *   1. Append-only — a second append never truncates or drops the first line.
 *   2. Caller-supplied `ts` — the module never reads the wall clock, so cap-verb
 *      tests stay deterministic (they pass their explicit --now-ts through).
 *
 * Every write targets a hermetic temp file created via fs.mkdtempSync so the
 * tests never touch a real .planning/halting-log.jsonl.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendHaltingLog,
  readHaltingLog,
  haltingLogPath,
} = require('../ferrox-core/bin/lib/halting-log.cjs');

function tmpLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-halting-log-'));
  return path.join(dir, 'halting-log.jsonl');
}

const entryA = {
  ts: '2026-07-18T00:00:00.000Z',
  gate: 'plan-check',
  trigger: 'pass-cap',
  cap_outcome: 'stop-and-rescope',
  increment: 'INC-001',
};
const entryB = {
  ts: '2026-07-18T01:00:00.000Z',
  gate: 'wave-audit',
  trigger: 'wall-clock',
  cap_outcome: 'ship-with-backlog',
  increment: 'INC-002',
};

test('appendHaltingLog creates the file and writes exactly one JSONL line', () => {
  const p = tmpLogPath();
  assert.equal(fs.existsSync(p), false, 'precondition: file absent');

  appendHaltingLog(entryA, { path: p });

  assert.equal(fs.existsSync(p), true, 'file created on first append');
  const raw = fs.readFileSync(p, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l !== '');
  assert.equal(lines.length, 1, 'exactly one JSONL line written');
  assert.deepEqual(JSON.parse(lines[0]), entryA);
  assert.ok(raw.endsWith('\n'), 'line is newline-terminated');
});

test('second append preserves the first line (append-only, never truncates)', () => {
  const p = tmpLogPath();
  appendHaltingLog(entryA, { path: p });
  appendHaltingLog(entryB, { path: p });

  const entries = readHaltingLog({ path: p });
  assert.equal(entries.length, 2, 'both entries present after two appends');
  assert.deepEqual(entries[0], entryA, 'first line preserved in order');
  assert.deepEqual(entries[1], entryB, 'second line appended after first');
});

test('readHaltingLog returns [] for a missing file (no throw)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-halting-log-'));
  const p = path.join(dir, 'does-not-exist.jsonl');
  assert.deepEqual(readHaltingLog({ path: p }), []);
});

test('readHaltingLog ignores blank trailing lines', () => {
  const p = tmpLogPath();
  appendHaltingLog(entryA, { path: p });
  // Simulate an operator/editor adding trailing blank lines.
  fs.appendFileSync(p, '\n\n   \n');

  const entries = readHaltingLog({ path: p });
  assert.equal(entries.length, 1, 'blank/whitespace-only trailing lines skipped');
  assert.deepEqual(entries[0], entryA);
});

test('the recorded ts is the caller-provided value, not a wall-clock read', () => {
  const p = tmpLogPath();
  const pinned = '1999-12-31T23:59:59.000Z';
  appendHaltingLog({ ...entryA, ts: pinned }, { path: p });

  const [entry] = readHaltingLog({ path: p });
  assert.equal(entry.ts, pinned, 'ts round-trips the caller value exactly');
});

test('haltingLogPath resolves to <cwd>/.planning/halting-log.jsonl', () => {
  const cwd = path.join(os.tmpdir(), 'some-project');
  assert.equal(
    haltingLogPath(cwd),
    path.join(cwd, '.planning', 'halting-log.jsonl'),
  );
});
