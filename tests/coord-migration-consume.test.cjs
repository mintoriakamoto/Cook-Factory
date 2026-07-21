'use strict';

/**
 * FF-B15 red-green tests for consume-once migration (coord-migration extension).
 *
 * A centrally-allocated migration number must validate only ONCE — a replay of a
 * previously-consumed number is rejected (replay defense across the gate).
 * Invariants:
 *   - consumeMigration on an allocated, not-yet-consumed number → 'consumed' and
 *     records it in a persisted `consumed` set.
 *   - a second consume of the same number → 'rejected-replay'.
 *   - consume of a never-allocated number → 'rejected-uncentral'.
 *   - allocMigration/checkMigration (COORD-04) semantics are unchanged; alloc
 *     preserves the consumed set.
 *
 * Hermetic temp store under <tmp>/.planning/coord/migration-seq.json.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  allocMigration,
  checkMigration,
  consumeMigration,
} = require('../ferrox-core/bin/lib/coord-migration.cjs');

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-coord-consume-'));
  return path.join(dir, '.planning', 'coord', 'migration-seq.json');
}

function readStore(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('consumeMigration accepts an allocated, not-yet-consumed number → consumed', () => {
  const statePath = tmpStatePath();
  const n = allocMigration({ statePath }); // 1

  assert.deepEqual(consumeMigration({ statePath, number: n }), { decision: 'consumed' });
  assert.deepEqual(readStore(statePath).consumed, [1], 'number recorded in the consumed set');
});

test('a second consume of the same number → rejected-replay (consume-once)', () => {
  const statePath = tmpStatePath();
  const n = allocMigration({ statePath }); // 1
  consumeMigration({ statePath, number: n });

  assert.deepEqual(consumeMigration({ statePath, number: n }), { decision: 'rejected-replay' });
  assert.deepEqual(readStore(statePath).consumed, [1], 'consumed set unchanged on replay (no double-append)');
});

test('consume of a never-allocated number → rejected-uncentral', () => {
  const statePath = tmpStatePath();
  allocMigration({ statePath }); // 1

  assert.deepEqual(consumeMigration({ statePath, number: 999 }), { decision: 'rejected-uncentral' });
  const store = readStore(statePath);
  assert.deepEqual(store.consumed ?? [], [], 'an uncentral number is never recorded');
});

test('consume against an absent store → rejected-uncentral (nothing allocated)', () => {
  const statePath = tmpStatePath();
  assert.equal(fs.existsSync(statePath), false, 'precondition: store absent');
  assert.deepEqual(consumeMigration({ statePath, number: 1 }), { decision: 'rejected-uncentral' });
});

test('alloc preserves an existing consumed set (COORD-04 semantics intact)', () => {
  const statePath = tmpStatePath();
  const a = allocMigration({ statePath }); // 1
  consumeMigration({ statePath, number: a }); // consumed: [1]
  const b = allocMigration({ statePath }); // 2 — must not wipe consumed

  const store = readStore(statePath);
  assert.deepEqual(store.allocated, [1, 2], 'allocated still accumulates');
  assert.deepEqual(store.consumed, [1], 'consumed preserved across an allocation');
  // checkMigration unchanged: allocated membership.
  assert.deepEqual(checkMigration({ statePath, number: b }), { decision: 'valid' });
  assert.deepEqual(checkMigration({ statePath, number: 42 }), { decision: 'rejected-uncentral' });
});
