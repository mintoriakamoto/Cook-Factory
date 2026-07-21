'use strict';

/**
 * Red-green tests for the HALT-02 rescope.check core (D-02, D-04).
 *
 * This is the global per-increment rescope counter that kills the unbounded
 * Stage-4 -> Stage-1 cycle. Three invariants under test:
 *   1. The counter is GLOBAL and PERSISTED: three sequential calls across the
 *      SAME state file (10->8 allow, 8->5 allow, 5->3 refuse) cap at 2 — the
 *      third is refused because the count persisted, not because the call knew
 *      its own index.
 *   2. Each accepted rescope must be STRICTLY SMALLER than the prior (both the
 *      passed prevSize and any stored lastSize); a non-smaller scope is rejected
 *      without touching the counter and without logging.
 *   3. On the capped (third) attempt the decision is hard-descope-or-kill and
 *      exactly one rescope-cap run-log entry is written.
 *
 * State and log both target hermetic temp files via fs.mkdtempSync; nowIso is an
 * explicit input so the recorded ts is deterministic (no Date.now).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runRescopeCheck } = require('../ferrox-core/bin/lib/rescope-check.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-rescope-'));
}

function readLog(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

test('global persisted counter caps at 2: allow, allow, then refuse the 3rd', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'rescope-state.json');
  const logPath = path.join(dir, 'halting-log.jsonl');
  const base = { increment: 'INC-001', maxAttempts: 2, nowIso: '2026-07-19T00:00:00.000Z' };

  const first = runRescopeCheck({ ...base, prevSize: 10, newSize: 8 }, { statePath, logPath });
  assert.equal(first.decision, 'rescope-allowed');
  assert.equal(first.attempt, 1);

  const second = runRescopeCheck({ ...base, prevSize: 8, newSize: 5 }, { statePath, logPath });
  assert.equal(second.decision, 'rescope-allowed');
  assert.equal(second.attempt, 2);

  // Third attempt is strictly smaller (5->3) yet REFUSED — the persisted counter
  // hit the cap. Proves the cap is global state, not per-call knowledge.
  const third = runRescopeCheck({ ...base, prevSize: 5, newSize: 3 }, { statePath, logPath });
  assert.equal(third.decision, 'hard-descope-or-kill');
  assert.equal(third.attempt, 2);

  const entries = readLog(logPath);
  assert.equal(entries.length, 1, 'exactly one cap event logged (only the refused 3rd)');
  assert.deepEqual(entries[0], {
    ts: '2026-07-19T00:00:00.000Z',
    gate: 'rescope',
    trigger: 'rescope-cap',
    cap_outcome: 'hard-descope-or-kill',
    increment: 'INC-001',
  });
});

test('a non-smaller scope is rejected without incrementing the counter or logging', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'rescope-state.json');
  const logPath = path.join(dir, 'halting-log.jsonl');
  const base = { increment: 'INC-002', maxAttempts: 2, nowIso: '2026-07-19T01:00:00.000Z' };

  // Equal size is not strictly smaller -> rejected, counter untouched (attempt 0).
  const equal = runRescopeCheck({ ...base, prevSize: 5, newSize: 5 }, { statePath, logPath });
  assert.equal(equal.decision, 'rejected-not-smaller');
  assert.equal(equal.attempt, 0);
  assert.equal(readLog(logPath).length, 0, 'a rejection logs nothing');

  // The counter was NOT consumed: a genuinely smaller rescope now succeeds as attempt 1.
  const smaller = runRescopeCheck({ ...base, prevSize: 5, newSize: 4 }, { statePath, logPath });
  assert.equal(smaller.decision, 'rescope-allowed');
  assert.equal(smaller.attempt, 1);
});

test('a larger scope is rejected as not-smaller', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'rescope-state.json');
  const logPath = path.join(dir, 'halting-log.jsonl');

  const grown = runRescopeCheck(
    { increment: 'INC-003', maxAttempts: 2, nowIso: '2026-07-19T02:00:00.000Z', prevSize: 5, newSize: 7 },
    { statePath, logPath },
  );
  assert.equal(grown.decision, 'rejected-not-smaller');
  assert.equal(grown.attempt, 0);
});

test('strictly-smaller is enforced against the stored lastSize, not just prevSize', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'rescope-state.json');
  const logPath = path.join(dir, 'halting-log.jsonl');
  const base = { increment: 'INC-004', maxAttempts: 2, nowIso: '2026-07-19T03:00:00.000Z' };

  const first = runRescopeCheck({ ...base, prevSize: 10, newSize: 8 }, { statePath, logPath });
  assert.equal(first.decision, 'rescope-allowed');
  assert.equal(first.attempt, 1);

  // newSize 9 < prevSize 20 but NOT < stored lastSize 8 -> rejected. Blocks a
  // re-grown scope even when the caller passes a large prevSize (T-03-06).
  const regrow = runRescopeCheck({ ...base, prevSize: 20, newSize: 9 }, { statePath, logPath });
  assert.equal(regrow.decision, 'rejected-not-smaller');
  assert.equal(regrow.attempt, 1, 'counter unchanged by the rejected re-grow');
});

test('a missing state file is treated as zero attempts', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'does-not-exist.json');
  const logPath = path.join(dir, 'halting-log.jsonl');

  assert.equal(fs.existsSync(statePath), false, 'precondition: state absent');
  const result = runRescopeCheck(
    { increment: 'INC-005', maxAttempts: 2, nowIso: '2026-07-19T04:00:00.000Z', prevSize: 10, newSize: 6 },
    { statePath, logPath },
  );
  assert.equal(result.decision, 'rescope-allowed');
  assert.equal(result.attempt, 1, 'missing file = 0 prior attempts, so this is attempt 1');
});
