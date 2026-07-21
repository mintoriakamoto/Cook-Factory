'use strict';

/**
 * Red-green tests for the HALT-04 ship-clock.check core (D-02, D-03).
 *
 * The ship clock measures wall-clock since the last coverage-advancing merge
 * against halting.ship_clock_seconds. RED signals autonomous descope-and-merge
 * of the already-passing subset so a shippable increment lands every session.
 *
 * Two paths under test:
 *   1. RED   — elapsed >= budgetSeconds: returns RED and appends one run-log
 *      entry naming the ship-clock trigger.
 *   2. green — elapsed < budgetSeconds: returns green and logs nothing.
 *
 * The log targets a hermetic temp file; time is injected as explicit ms and
 * nowIso, so the recorded ts is deterministic (no Date.now).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runShipClockCheck } = require('../ferrox-core/bin/lib/ship-clock-check.cjs');

function tmpLogPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-ship-clock-'));
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

test('past the ship-clock budget returns RED and logs one ship-clock event', () => {
  const logPath = tmpLogPath();

  const result = runShipClockCheck(
    {
      increment: 'INC-001',
      lastMergeMs: 0,
      nowMs: 86_400_000, // elapsed 86400s (24h)
      budgetSeconds: 28_800, // budget 8h -> RED
      nowIso: '2026-07-19T00:00:00.000Z',
    },
    { logPath },
  );

  assert.equal(result.decision, 'RED');
  assert.equal(result.elapsed_seconds, 86_400);
  assert.equal(result.budget_seconds, 28_800);

  const entries = readLog(logPath);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    ts: '2026-07-19T00:00:00.000Z',
    gate: 'ship-clock',
    trigger: 'ship-clock',
    cap_outcome: 'stop-and-rescope',
    increment: 'INC-001',
  });
});

test('under the ship-clock budget returns green and logs nothing', () => {
  const logPath = tmpLogPath();

  const result = runShipClockCheck(
    {
      increment: 'INC-002',
      lastMergeMs: 0,
      nowMs: 1000, // elapsed 1s
      budgetSeconds: 28_800,
      nowIso: '2026-07-19T01:00:00.000Z',
    },
    { logPath },
  );

  assert.equal(result.decision, 'green');
  assert.equal(result.elapsed_seconds, 1);
  assert.equal(result.budget_seconds, 28_800);
  assert.equal(readLog(logPath).length, 0, 'green path logs nothing');
});
