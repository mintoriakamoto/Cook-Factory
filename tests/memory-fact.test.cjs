'use strict';

/**
 * MEM-01 bi-temporal fact store — supersede-don't-delete + half-open validity.
 *
 * Modeled on tests/coord-migration.test.cjs: a hermetic tmpStatePath targeting
 * `<tmp>/.planning/graphs/memory-facts.json` (no real project state touched),
 * node:test / node:assert/strict, and EXPLICIT integer timestamps everywhere
 * (100/150/199/200/250) — never Date.now. The store is deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memoryFact = require('../ferrox-core/bin/lib/memory-fact.cjs');
const { addFact, getValidAt, history, invalidateFact, normalizeStore } = memoryFact;

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-memory-fact-'));
  return path.join(dir, '.planning', 'graphs', 'memory-facts.json');
}

function readStore(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('addFact on an absent store creates it and appends a fact with valid_to=null', () => {
  const statePath = tmpStatePath();
  const fact = addFact({ statePath, subject: 'S', predicate: 'P', object: 'OLD', validFrom: 100, recordedAt: 100 });
  assert.equal(fact.subject, 'S');
  assert.equal(fact.predicate, 'P');
  assert.equal(fact.object, 'OLD');
  assert.equal(fact.valid_from, 100);
  assert.equal(fact.valid_to, null);
  assert.equal(fact.confidence, 1);
  assert.equal(fact.recorded_at, 100);
  const store = readStore(statePath);
  assert.equal(store.facts.length, 1);
});

test('invalidateFact sets valid_to on the currently-valid fact and NEVER deletes it', () => {
  const statePath = tmpStatePath();
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'OLD', validFrom: 100, recordedAt: 100 });
  const mutated = invalidateFact({ statePath, subject: 'S', predicate: 'P', validTo: 200 });
  assert.ok(mutated, 'returns the mutated fact');
  assert.equal(mutated.valid_to, 200);
  const store = readStore(statePath);
  assert.equal(store.facts.length, 1, 'old fact retained, not deleted');
  assert.equal(store.facts[0].valid_to, 200);
  assert.equal(store.facts[0].object, 'OLD');
});

test('invalidateFact on an already-superseded fact does not touch it (no double-close)', () => {
  const statePath = tmpStatePath();
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'OLD', validFrom: 100, recordedAt: 100 });
  invalidateFact({ statePath, subject: 'S', predicate: 'P', validTo: 200 });
  const second = invalidateFact({ statePath, subject: 'S', predicate: 'P', validTo: 999 });
  assert.equal(second, null, 'no currently-valid fact to close → null');
  const store = readStore(statePath);
  assert.equal(store.facts[0].valid_to, 200, 'valid_to unchanged (idempotent)');
});

test('getValidAt before the first fact returns none', () => {
  const statePath = tmpStatePath();
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'OLD', validFrom: 100, recordedAt: 100 });
  assert.equal(getValidAt({ statePath, ts: 50 }).length, 0);
});

test('MEM-01 supersede-don\'t-delete: history shows both, get-valid-at returns the version valid at each instant, old fact retained', () => {
  const statePath = tmpStatePath();
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'OLD', validFrom: 100, recordedAt: 100 });
  invalidateFact({ statePath, subject: 'S', predicate: 'P', validTo: 200 });
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'NEW', validFrom: 200, recordedAt: 200 });

  const hist = history({ statePath, subject: 'S' });
  assert.equal(hist.length, 2, 'history shows BOTH versions');
  const objs = hist.map(f => f.object).sort();
  assert.deepEqual(objs, ['NEW', 'OLD'], 'both OLD and NEW present');
  const oldFact = hist.find(f => f.object === 'OLD');
  assert.equal(oldFact.valid_to, 200, 'old fact retained with valid_to set (not deleted)');

  // Half-open [valid_from, valid_to): the valid_to instant belongs to the successor.
  assert.equal(getValidAt({ statePath, ts: 150 })[0].object, 'OLD', 'ts 150 → OLD');
  assert.equal(getValidAt({ statePath, ts: 199 })[0].object, 'OLD', 'ts 199 → OLD');
  assert.equal(getValidAt({ statePath, ts: 200 })[0].object, 'NEW', 'ts 200 (valid_to instant) → NEW');
  assert.equal(getValidAt({ statePath, ts: 250 })[0].object, 'NEW', 'ts 250 → NEW');
});

test('history returns facts in recorded_at ascending order', () => {
  const statePath = tmpStatePath();
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'A', validFrom: 300, recordedAt: 300 });
  addFact({ statePath, subject: 'S', predicate: 'Q', object: 'B', validFrom: 100, recordedAt: 100 });
  const hist = history({ statePath, subject: 'S' });
  assert.deepEqual(hist.map(f => f.recorded_at), [100, 300]);
});

test('getValidAt filters by subject when provided', () => {
  const statePath = tmpStatePath();
  addFact({ statePath, subject: 'S1', predicate: 'P', object: 'x', validFrom: 100, recordedAt: 100 });
  addFact({ statePath, subject: 'S2', predicate: 'P', object: 'y', validFrom: 100, recordedAt: 100 });
  const only = getValidAt({ statePath, ts: 150, subject: 'S1' });
  assert.equal(only.length, 1);
  assert.equal(only[0].subject, 'S1');
});

// ---------------------------------------------------------------------------
// H-1 (Fix 1a): invalidateFact must close ALL open matches, not just the first.
// ---------------------------------------------------------------------------

/** Count facts with valid_to === null for a given subject+predicate. */
function countOpen(statePath, subject, predicate) {
  const store = readStore(statePath);
  return store.facts.filter(
    (f) => f.valid_to === null && f.subject === subject && f.predicate === predicate,
  ).length;
}

test('H-1a: invalidateFact closes ALL open facts for subject+predicate (not just the first)', () => {
  const statePath = tmpStatePath();
  // Seed TWO currently-open facts for the same subject+predicate (pure appends).
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'v1', validFrom: 100, recordedAt: 100 });
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'v2', validFrom: 100, recordedAt: 110 });
  assert.equal(countOpen(statePath, 'S', 'P'), 2, 'precondition: two open facts');

  invalidateFact({ statePath, subject: 'S', predicate: 'P', validTo: 200 });

  assert.equal(countOpen(statePath, 'S', 'P'), 0, 'ALL open facts closed, none left valid-now');
  const store = readStore(statePath);
  assert.equal(store.facts.length, 2, 'both retained (supersede, never delete)');
  store.facts.forEach((f) => assert.equal(f.valid_to, 200, 'each closed at validTo'));
});

test('H-1b: supersedeAndAddFact closes all priors and appends the new fact in one write', () => {
  const statePath = tmpStatePath();
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'v1', validFrom: 100, recordedAt: 100 });
  addFact({ statePath, subject: 'S', predicate: 'P', object: 'v2', validFrom: 100, recordedAt: 110 });
  const added = memoryFact.supersedeAndAddFact({ statePath, subject: 'S', predicate: 'P', object: 'v3', validFrom: 150, recordedAt: 150 });
  assert.equal(added.object, 'v3');
  assert.equal(added.valid_to, null);
  assert.equal(countOpen(statePath, 'S', 'P'), 1, 'exactly one valid-now after supersede-and-add');
  const store = readStore(statePath);
  assert.equal(store.facts.length, 3, 'all retained in history');
  const open = store.facts.filter((f) => f.valid_to === null);
  assert.equal(open[0].object, 'v3', 'the sole open fact is the newest');
});

// ---------------------------------------------------------------------------
// M-1 (Fix 2): a syntactically corrupt store degrades to empty on READ and fails
// closed (no data loss) on WRITE — it must never crash a read.
// ---------------------------------------------------------------------------

/** Write raw (possibly corrupt) bytes to a fact-store path, creating dirs. */
function writeRawStore(statePath, raw) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, raw);
}

const MERGE_CONFLICT = '<<<<<<< HEAD\n{"facts":[]}\n=======\n{bad}\n>>>>>>> other\n';
const NOT_JSON = 'not json {{{';

test('M-1: getValidAt degrades a merge-conflict-corrupted store to empty (no crash)', () => {
  const statePath = tmpStatePath();
  writeRawStore(statePath, MERGE_CONFLICT);
  assert.deepEqual(getValidAt({ statePath, ts: 150 }), [], 'corrupt store → empty, not a throw');
});

test('M-1: history/getValidAt degrade a garbage-JSON store to empty (no crash)', () => {
  const statePath = tmpStatePath();
  writeRawStore(statePath, NOT_JSON);
  assert.deepEqual(history({ statePath, subject: 'S' }), []);
  assert.deepEqual(getValidAt({ statePath, ts: 999, subject: 'S' }), []);
});

test('M-1: WRITE over a corrupt store fails closed WITHOUT clobbering (no data loss)', () => {
  const statePath = tmpStatePath();
  writeRawStore(statePath, NOT_JSON);
  assert.throws(
    () => addFact({ statePath, subject: 'S', predicate: 'P', object: 'x', validFrom: 100, recordedAt: 100 }),
    'write must fail closed on a corrupt store',
  );
  assert.equal(fs.readFileSync(statePath, 'utf8'), NOT_JSON, 'corrupt file preserved, not overwritten');
});

test('normalizeStore collapses a malformed store to { facts: [] }', () => {
  assert.deepEqual(normalizeStore(null), { facts: [] });
  assert.deepEqual(normalizeStore('garbage'), { facts: [] });
  assert.deepEqual(normalizeStore({ facts: 'nope' }), { facts: [] });
  // Filters malformed entries.
  const mixed = normalizeStore({ facts: [{ subject: 'S', predicate: 'P', object: 'o', valid_from: 1, valid_to: null, confidence: 1, recorded_at: 1 }, 42, null] });
  assert.equal(mixed.facts.length, 1);
});
