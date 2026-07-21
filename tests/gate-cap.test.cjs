'use strict';

/**
 * Red-green tests for the HALT-01 gate.cap-check core (D-02, D-03).
 *
 * The cap-check is the single source of truth for "max N passes" across the
 * line: given a gate id, its current pass count, and a start/now timestamp pair
 * (both explicit — never a clock read), it decides `continue` vs the gate's
 * resolved cap_outcome AND records WHICH trigger fired (pass-cap vs wall-clock).
 *
 * Two firing paths and one clean path are proven here:
 *   1. pass-cap  — passes >= maxPasses while still under the wall-clock budget.
 *   2. wall-clock — elapsed >= wallClockSeconds while still under the pass cap.
 *   3. continue  — under both caps: no cap fires and NOTHING is logged.
 * Plus the documented tie-break (both caps crossed at once -> pass-cap).
 *
 * Every write targets a hermetic temp log via fs.mkdtempSync so the tests never
 * touch a real .planning/halting-log.jsonl. All time arrives as explicit integer
 * ms, keeping the assertions deterministic (no Date.now anywhere in the path).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  evaluateGateCap,
  runGateCapCheck,
} = require('../ferrox-core/bin/lib/gate-cap.cjs');

function tmpLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-gate-cap-'));
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

// --- evaluateGateCap: pure decision, no fs, no clock ------------------------

test('evaluateGateCap fires pass-cap when passes >= maxPasses (under the wall-clock budget)', () => {
  const result = evaluateGateCap({
    gate: 'plan-check',
    passes: 3,
    maxPasses: 3,
    startMs: 0,
    nowMs: 1000, // elapsed 1s, budget 3600s -> wall-clock NOT crossed
    wallClockSeconds: 3600,
    capOutcome: 'stop-and-rescope',
  });
  assert.equal(result.trigger, 'pass-cap');
  assert.equal(result.decision, 'stop-and-rescope');
  assert.equal(result.gate, 'plan-check');
  assert.equal(result.cap_outcome, 'stop-and-rescope');
});

test('evaluateGateCap fires wall-clock when elapsed >= wallClockSeconds (under the pass cap)', () => {
  const result = evaluateGateCap({
    gate: 'wave-audit',
    passes: 0, // under the pass cap
    maxPasses: 3,
    startMs: 0,
    nowMs: 7_200_000, // elapsed 7200s >= budget 3600s
    wallClockSeconds: 3600,
    capOutcome: 'ship-with-backlog',
  });
  assert.equal(result.trigger, 'wall-clock');
  assert.equal(result.decision, 'ship-with-backlog');
  assert.equal(result.gate, 'wave-audit');
  assert.equal(result.cap_outcome, 'ship-with-backlog');
});

test('evaluateGateCap returns continue with trigger none when under BOTH caps', () => {
  const result = evaluateGateCap({
    gate: 'plan-check',
    passes: 1,
    maxPasses: 3,
    startMs: 0,
    nowMs: 1000,
    wallClockSeconds: 3600,
    capOutcome: 'stop-and-rescope',
  });
  assert.equal(result.trigger, 'none');
  assert.equal(result.decision, 'continue');
});

test('evaluateGateCap tie-break: both caps crossed simultaneously -> pass-cap', () => {
  const result = evaluateGateCap({
    gate: 'plan-check',
    passes: 5,
    maxPasses: 3, // pass cap crossed
    startMs: 0,
    nowMs: 7_200_000,
    wallClockSeconds: 3600, // wall-clock ALSO crossed
    capOutcome: 'escalate-to-human',
  });
  assert.equal(result.trigger, 'pass-cap', 'documented tie-break prefers pass-cap');
  assert.equal(result.decision, 'escalate-to-human');
});

// --- runGateCapCheck: thin logging wrapper ----------------------------------

test('runGateCapCheck logs exactly one pass-cap entry with the caller ts on a pass-cap breach', () => {
  const logPath = tmpLogPath();
  const result = runGateCapCheck(
    {
      gate: 'plan-check',
      passes: 3,
      maxPasses: 3,
      startMs: 0,
      nowMs: 1000,
      wallClockSeconds: 3600,
      capOutcome: 'stop-and-rescope',
      nowIso: '2026-07-19T00:00:00.000Z',
    },
    { logPath, increment: 'INC-001' },
  );

  assert.equal(result.trigger, 'pass-cap');
  assert.equal(result.decision, 'stop-and-rescope');

  const entries = readLog(logPath);
  assert.equal(entries.length, 1, 'exactly one run-log entry on a fired cap');
  assert.deepEqual(entries[0], {
    ts: '2026-07-19T00:00:00.000Z',
    gate: 'plan-check',
    trigger: 'pass-cap',
    cap_outcome: 'stop-and-rescope',
    increment: 'INC-001',
  });
});

test('runGateCapCheck logs exactly one wall-clock entry on a wall-clock breach', () => {
  const logPath = tmpLogPath();
  const result = runGateCapCheck(
    {
      gate: 'wave-audit',
      passes: 0,
      maxPasses: 3,
      startMs: 0,
      nowMs: 7_200_000,
      wallClockSeconds: 3600,
      capOutcome: 'ship-with-backlog',
      nowIso: '2026-07-19T01:00:00.000Z',
    },
    { logPath, increment: 'INC-002' },
  );

  assert.equal(result.trigger, 'wall-clock');

  const entries = readLog(logPath);
  assert.equal(entries.length, 1, 'exactly one run-log entry on a fired cap');
  assert.equal(entries[0].trigger, 'wall-clock');
  assert.equal(entries[0].ts, '2026-07-19T01:00:00.000Z');
  assert.equal(entries[0].cap_outcome, 'ship-with-backlog');
  assert.equal(entries[0].increment, 'INC-002');
});

test('runGateCapCheck writes NO log entry on the continue path', () => {
  const logPath = tmpLogPath();
  const result = runGateCapCheck(
    {
      gate: 'plan-check',
      passes: 1,
      maxPasses: 3,
      startMs: 0,
      nowMs: 1000,
      wallClockSeconds: 3600,
      capOutcome: 'stop-and-rescope',
      nowIso: '2026-07-19T02:00:00.000Z',
    },
    { logPath, increment: 'INC-003' },
  );

  assert.equal(result.decision, 'continue');
  assert.equal(result.trigger, 'none');
  assert.equal(readLog(logPath).length, 0, 'continue path logs nothing');
});
