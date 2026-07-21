'use strict';

/**
 * Red-green tests for the COORD-04 coord-migration core (allocMigration +
 * checkMigration).
 *
 * Migration/sequence numbers must be handed out by ONE central authority, never
 * chosen inside a worktree. Invariants under test:
 *   1. allocMigration is strictly monotonic from a CENTRAL, PERSISTED store:
 *      three sequential calls across the same statePath return 1, 2, 3 — proven
 *      by the store's growing `allocated` list, not per-call knowledge.
 *   2. The whole read-modify-write runs under the atomic-state file lock
 *      (updateJsonFileAtomic), so two interleaved allocations cannot both read
 *      the same `next` and collide (lost-update, FF-B12 primitive).
 *   3. checkMigration accepts a centrally-allocated number (valid) and rejects a
 *      self-assigned / uncentral number (rejected-uncentral); an absent store
 *      rejects everything (nothing has been centrally allocated).
 *
 * The store targets a hermetic temp file under <tmp>/.planning/coord/
 * migration-seq.json via fs.mkdtempSync — no real project state is touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  allocMigration,
  checkMigration,
} = require('../ferrox-core/bin/lib/coord-migration.cjs');

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-coord-migration-'));
  return path.join(dir, '.planning', 'coord', 'migration-seq.json');
}

function readStore(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- allocMigration: monotonic central allocation (COORD-04) -----------------

test('allocMigration returns 1 on an absent store and persists { next: 2, allocated: [1] }', () => {
  const statePath = tmpStatePath();
  assert.equal(fs.existsSync(statePath), false, 'precondition: store absent');

  const first = allocMigration({ statePath });
  assert.equal(first, 1, 'first allocation from an absent store is 1');

  const store = readStore(statePath);
  assert.equal(store.next, 2, 'next advanced to 2');
  assert.deepEqual(store.allocated, [1], 'allocated records the handed-out number');
});

test('allocMigration is strictly monotonic and persisted across separate calls (1, 2, 3)', () => {
  const statePath = tmpStatePath();

  assert.equal(allocMigration({ statePath }), 1);
  assert.equal(allocMigration({ statePath }), 2);
  assert.equal(allocMigration({ statePath }), 3);

  const store = readStore(statePath);
  assert.equal(store.next, 4, 'next persisted at 4 after three allocations');
  assert.deepEqual(store.allocated, [1, 2, 3], 'allocated accumulates every number in order');
});

// --- checkMigration: reject a self-assigned / uncentral number (COORD-04) ----

test('checkMigration returns valid for a centrally-allocated number', () => {
  const statePath = tmpStatePath();
  allocMigration({ statePath }); // 1
  allocMigration({ statePath }); // 2

  assert.deepEqual(checkMigration({ statePath, number: 2 }), { decision: 'valid' });
  assert.deepEqual(checkMigration({ statePath, number: 1 }), { decision: 'valid' });
});

test('checkMigration rejects a self-assigned number never centrally allocated', () => {
  const statePath = tmpStatePath();
  allocMigration({ statePath }); // 1
  allocMigration({ statePath }); // 2

  // 999 was chosen inside a worktree — it is not in the central allocated set.
  assert.deepEqual(checkMigration({ statePath, number: 999 }), { decision: 'rejected-uncentral' });
});

test('checkMigration against an absent store rejects any number (nothing allocated)', () => {
  const statePath = tmpStatePath();
  assert.equal(fs.existsSync(statePath), false, 'precondition: store absent');

  assert.deepEqual(checkMigration({ statePath, number: 1 }), { decision: 'rejected-uncentral' });
  assert.deepEqual(checkMigration({ statePath, number: 42 }), { decision: 'rejected-uncentral' });
});
