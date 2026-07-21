'use strict';

/**
 * RED→GREEN regression for MEDIUM-4: rescope-state TOCTOU lost-update.
 *
 * runRescopeCheck (and the human-SLA park writer) did an unguarded
 * read→check→write: two concurrent invocations both read the same attempt
 * count and one write clobbered the other, so an increment was lost and the
 * rescope cap could be silently bypassed.
 *
 * The fix introduces an atomic-state primitive (src/atomic-state.cts): a
 * cross-process O_EXCL lockfile with bounded retry wrapping the whole
 * read-modify-write, plus temp-file + rename atomic writes. This whole suite
 * imports that module — before the fix it does not exist, so the file fails to
 * load (RED); after the fix the concurrency proof below shows NO lost updates.
 *
 * The concurrency proof runs N worker threads that each perform K locked
 * increments of a shared counter and asserts the final value is exactly N*K.
 * Under the old unguarded RMW this race loses updates (final < N*K); under the
 * atomic primitive every increment survives.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const atomic = require('../ferrox-core/bin/lib/atomic-state.cjs');
const { runRescopeCheck } = require('../ferrox-core/bin/lib/rescope-check.cjs');
const { runHumanSlaCheck } = require('../ferrox-core/bin/lib/human-sla-check.cjs');

const ATOMIC_MODULE = path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib', 'atomic-state.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-toctou-'));
}
function residue(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
}

// --- atomicWriteFileSync: temp + rename, no residue --------------------------

test('atomicWriteFileSync writes the content and leaves no .tmp residue', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'state.json');
  atomic.atomicWriteFileSync(target, '{"n":1}\n');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"n":1}\n');
  assert.deepEqual(residue(dir), [], 'no temp files left behind');
});

// --- withFileLock: mutual exclusion + cleanup --------------------------------

test('withFileLock throws when the lock is already held (bounded retry), then cleans up', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'state.json');
  const lockPath = target + '.lock';

  // Simulate another holder: pre-create the lockfile.
  fs.writeFileSync(lockPath, 'held-by-other');
  assert.throws(
    () => atomic.withFileLock(target, () => 'never', { retries: 2, retryDelayMs: 1, staleMs: 60_000 }),
    /lock/i,
    'a held lock must not be silently ignored',
  );
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing a single simulated lockfile, not a temp-dir cleanup
  fs.rmSync(lockPath, { force: true });

  // With no contender the critical section runs and the lock is released.
  const out = atomic.withFileLock(target, () => 'ran', { retries: 2, retryDelayMs: 1 });
  assert.equal(out, 'ran');
  assert.equal(fs.existsSync(lockPath), false, 'lock released after the section');
});

// --- the no-lost-update concurrency proof ------------------------------------

function runWorkers(counterPath, workers, iterations, lockOpts) {
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    const atomic = require(workerData.modulePath);
    for (let i = 0; i < workerData.iterations; i++) {
      atomic.updateJsonFileAtomic(workerData.counterPath, (cur) => {
        const n = (cur && typeof cur === 'object' && typeof cur.n === 'number') ? cur.n : 0;
        return { next: { n: n + 1 }, result: null, changed: true };
      }, workerData.lockOpts);
    }
    parentPort.postMessage('done');
  `;
  const tasks = [];
  for (let w = 0; w < workers; w++) {
    tasks.push(new Promise((resolve, reject) => {
      const worker = new Worker(code, {
        eval: true,
        workerData: { modulePath: ATOMIC_MODULE, counterPath, iterations, lockOpts },
      });
      worker.once('message', () => resolve());
      worker.once('error', reject);
      worker.once('exit', (c) => { if (c !== 0) reject(new Error('worker exit ' + c)); });
    }));
  }
  return Promise.all(tasks);
}

test('concurrent locked increments never lose an update (no TOCTOU lost-update)', async () => {
  const dir = tmpDir();
  const counterPath = path.join(dir, 'counter.json');
  const WORKERS = 4;
  const ITER = 120;
  await runWorkers(counterPath, WORKERS, ITER, { retries: 500_000, retryDelayMs: 1, staleMs: 60_000 });
  const final = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
  assert.equal(final.n, WORKERS * ITER, `every increment must survive: expected ${WORKERS * ITER}, got ${final.n}`);
  assert.deepEqual(residue(dir), [], 'no lock/temp residue after all workers finish');
});

// --- runRescopeCheck is wired through the atomic primitive -------------------

test('runRescopeCheck goes through the atomic writer: caps sequentially, no residue', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'rescope-state.json');
  const logPath = path.join(dir, 'halting-log.jsonl');
  const base = { increment: 'INC-1', maxAttempts: 2, nowIso: '2026-07-19T00:00:00.000Z' };

  const a = runRescopeCheck({ ...base, prevSize: 10, newSize: 8 }, { statePath, logPath });
  const b = runRescopeCheck({ ...base, prevSize: 8, newSize: 5 }, { statePath, logPath });
  const c = runRescopeCheck({ ...base, prevSize: 5, newSize: 3 }, { statePath, logPath });
  assert.equal(a.decision, 'rescope-allowed');
  assert.equal(a.attempt, 1);
  assert.equal(b.decision, 'rescope-allowed');
  assert.equal(b.attempt, 2);
  assert.equal(c.decision, 'hard-descope-or-kill', 'cap still holds past the atomic rewrite');
  assert.deepEqual(residue(dir), [], 'rescope leaves no lock/temp residue');

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state['INC-1'].attempts, 2);
  assert.equal(state['INC-1'].lastSize, 5);
});

// --- the park writer gets the same atomic treatment -------------------------

test('human-sla park write is atomic (no residue) and records the park', () => {
  const dir = tmpDir();
  const parkPath = path.join(dir, 'human-sla-park.json');
  const logPath = path.join(dir, 'halting-log.jsonl');

  const r = runHumanSlaCheck(
    { increment: 'INC-9', openedMs: 0, nowMs: 2 * 86400 * 1000, slaSeconds: 86400, nowIso: '2026-07-19T02:00:00.000Z' },
    { parkPath, logPath },
  );
  assert.equal(r.decision, 'breached');
  const park = JSON.parse(fs.readFileSync(parkPath, 'utf8'));
  assert.equal(park['INC-9'].status, 'parked');
  assert.equal(park['INC-9'].reason, 'human-sla-breach');
  assert.deepEqual(residue(dir), [], 'park write leaves no lock/temp residue');
});
