'use strict';

/**
 * Red-green tests for the HALT-03 human-sla.check core (D-02, D-03, D-04).
 *
 * The human-SLA timer keeps the line from idling indefinitely on one human.
 * Given a checkpoint's open timestamp and an explicit now, it returns `within`
 * or `breached` against halting.human_sla_seconds; on breach it parks the
 * increment as an OBSERVABLE state transition and logs the event.
 *
 * Two paths under test:
 *   1. breach — elapsed >= slaSeconds: returns breached, writes a park record
 *      (status 'parked', reason 'human-sla-breach') AND one run-log entry.
 *   2. within — elapsed < slaSeconds: returns within, writes NO park record and
 *      NO log entry (a clean no-op).
 *
 * Park and log both target hermetic temp files; time is injected as explicit ms
 * and nowIso, so the recorded ts is deterministic (no Date.now).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runHumanSlaCheck } = require('../ferrox-core/bin/lib/human-sla-check.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-human-sla-'));
}

function readLog(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

function readPark(p) {
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, 'utf8').trim();
  return raw === '' ? {} : JSON.parse(raw);
}

test('a checkpoint past its SLA returns breached and parks the increment with a logged event', () => {
  const dir = tmpDir();
  const parkPath = path.join(dir, 'park-state.json');
  const logPath = path.join(dir, 'halting-log.jsonl');

  const result = runHumanSlaCheck(
    {
      increment: 'INC-001',
      openedMs: 0,
      nowMs: 7_200_000, // elapsed 7200s
      slaSeconds: 3600, // budget 3600s -> breached
      nowIso: '2026-07-19T00:00:00.000Z',
    },
    { parkPath, logPath },
  );

  assert.equal(result.decision, 'breached');
  assert.equal(result.elapsed_seconds, 7200);
  assert.equal(result.sla_seconds, 3600);

  // Park transition is observable.
  const park = readPark(parkPath);
  assert.deepEqual(park['INC-001'], {
    increment: 'INC-001',
    status: 'parked',
    reason: 'human-sla-breach',
    ts: '2026-07-19T00:00:00.000Z',
  });

  // Exactly one run-log entry naming the human-sla trigger.
  const entries = readLog(logPath);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    ts: '2026-07-19T00:00:00.000Z',
    gate: 'human-sla',
    trigger: 'human-sla',
    cap_outcome: 'escalate-to-human',
    increment: 'INC-001',
  });
});

test('a checkpoint within its SLA returns within and writes no park record and no log entry', () => {
  const dir = tmpDir();
  const parkPath = path.join(dir, 'park-state.json');
  const logPath = path.join(dir, 'halting-log.jsonl');

  const result = runHumanSlaCheck(
    {
      increment: 'INC-002',
      openedMs: 0,
      nowMs: 1000, // elapsed 1s
      slaSeconds: 3600, // well within budget
      nowIso: '2026-07-19T01:00:00.000Z',
    },
    { parkPath, logPath },
  );

  assert.equal(result.decision, 'within');
  assert.equal(result.elapsed_seconds, 1);
  assert.equal(result.sla_seconds, 3600);

  assert.equal(fs.existsSync(parkPath), false, 'no park record on the within path');
  assert.equal(readLog(logPath).length, 0, 'no log entry on the within path');
});
