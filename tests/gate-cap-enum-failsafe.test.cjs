'use strict';

/**
 * RED→GREEN regression for HIGH-3: cap_outcome fail-open.
 *
 * Pre-fix, evaluateGateCap echoed whatever `capOutcome` it was handed. A garbage
 * or out-of-enum value (e.g. "continue", "", "disabled") therefore became the
 * gate's DECISION when a trigger fired — a silent cap-disable: the pass-cap /
 * wall-clock fired, yet the gate "resolved" to a non-terminal (or nonsense)
 * outcome and the loop kept going.
 *
 * The fix validates cap_outcome against the enum
 * {ship-with-backlog, stop-and-rescope, escalate-to-human} and, when it is
 * missing/invalid, falls back to the SAFE default stop-and-rescope. A fired
 * trigger must NEVER resolve to "continue". These tests fail before that fix
 * (garbage passes through) and pass after it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateGateCap, runGateCapCheck } = require('../ferrox-core/bin/lib/gate-cap.cjs');

const TERMINAL = new Set(['ship-with-backlog', 'stop-and-rescope', 'escalate-to-human']);

function tmpLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-gate-enum-'));
  return path.join(dir, 'halting-log.jsonl');
}
function readLog(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

test('a fired pass-cap with a garbage cap_outcome never resolves to continue', () => {
  const result = evaluateGateCap({
    gate: 'plan-check',
    passes: 3,
    maxPasses: 3, // pass-cap fires
    startMs: 0,
    nowMs: 1000,
    wallClockSeconds: 3600,
    capOutcome: 'continue', // the dangerous fail-open value
  });
  assert.equal(result.trigger, 'pass-cap');
  assert.notEqual(result.decision, 'continue', 'a fired trigger must not silently continue');
  assert.ok(TERMINAL.has(result.decision), `decision must be a terminal outcome, got ${result.decision}`);
  assert.equal(result.decision, 'stop-and-rescope', 'invalid cap_outcome falls back to the safe default');
  assert.equal(result.cap_outcome, 'stop-and-rescope');
});

test('a fired wall-clock with an out-of-enum cap_outcome falls back to stop-and-rescope', () => {
  const result = evaluateGateCap({
    gate: 'wave-audit',
    passes: 0, // under pass-cap so only wall-clock can fire
    maxPasses: 3,
    startMs: 0,
    nowMs: 7_200_000, // elapsed 7200s >= 3600s budget
    wallClockSeconds: 3600,
    capOutcome: 'disabled', // garbage
  });
  assert.equal(result.trigger, 'wall-clock');
  assert.ok(TERMINAL.has(result.decision));
  assert.equal(result.decision, 'stop-and-rescope');
  assert.equal(result.cap_outcome, 'stop-and-rescope');
});

test('an empty / undefined cap_outcome on a breach falls back to the safe default', () => {
  for (const bad of ['', undefined, null, 42, {}]) {
    const result = evaluateGateCap({
      gate: 'verify',
      passes: 5,
      maxPasses: 3,
      startMs: 0,
      nowMs: 1000,
      wallClockSeconds: 3600,
      capOutcome: bad,
    });
    assert.equal(result.trigger, 'pass-cap');
    assert.equal(result.decision, 'stop-and-rescope', `bad cap_outcome ${JSON.stringify(bad)} must fall back`);
  }
});

test('a VALID cap_outcome is preserved verbatim (no over-correction)', () => {
  for (const good of ['ship-with-backlog', 'stop-and-rescope', 'escalate-to-human']) {
    const result = evaluateGateCap({
      gate: 'plan-check',
      passes: 3,
      maxPasses: 3,
      startMs: 0,
      nowMs: 1000,
      wallClockSeconds: 3600,
      capOutcome: good,
    });
    assert.equal(result.decision, good, `valid ${good} must pass through unchanged`);
    assert.equal(result.cap_outcome, good);
  }
});

test('the under-cap continue path is unaffected by an invalid cap_outcome', () => {
  const result = evaluateGateCap({
    gate: 'plan-check',
    passes: 1,
    maxPasses: 3,
    startMs: 0,
    nowMs: 1000,
    wallClockSeconds: 3600,
    capOutcome: 'garbage', // irrelevant while under both caps
  });
  assert.equal(result.trigger, 'none');
  assert.equal(result.decision, 'continue');
});

test('runGateCapCheck logs the NORMALIZED cap_outcome, never the garbage value', () => {
  const logPath = tmpLogPath();
  const result = runGateCapCheck(
    {
      gate: 'plan-check',
      passes: 3,
      maxPasses: 3,
      startMs: 0,
      nowMs: 1000,
      wallClockSeconds: 3600,
      capOutcome: 'continue', // fail-open attempt
      nowIso: '2026-07-19T00:00:00.000Z',
    },
    { logPath, increment: 'INC-ENUM' },
  );
  assert.equal(result.decision, 'stop-and-rescope');
  const entries = readLog(logPath);
  assert.equal(entries.length, 1, 'a fired trigger still logs exactly one entry');
  assert.equal(entries[0].trigger, 'pass-cap');
  assert.equal(entries[0].cap_outcome, 'stop-and-rescope', 'the run-log records the safe normalized outcome');
});
