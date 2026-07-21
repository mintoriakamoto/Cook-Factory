'use strict';

/**
 * MEM-02 recall + capture — thin, deterministic layers over the Plan 02
 * bi-temporal fact store. recall returns prior decisions valid-now; capture
 * writes a decision fact and, when it contradicts a prior, supersedes it via
 * invalidate (add + invalidate — never delete).
 *
 * Modeled on tests/memory-fact.test.cjs: hermetic tmpStatePath targeting
 * `<tmp>/.planning/graphs/memory-facts.json`, node:test / node:assert/strict,
 * EXPLICIT integer timestamps — no Date.now.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rc = require('../ferrox-core/bin/lib/memory-recall-capture.cjs');
const { recall, capture, DECISION_PREDICATES } = rc;
const memoryFact = require('../ferrox-core/bin/lib/memory-fact.cjs');

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-recall-'));
  return path.join(dir, '.planning', 'graphs', 'memory-facts.json');
}

test('DECISION_PREDICATES default set', () => {
  assert.deepEqual(DECISION_PREDICATES, ['decided', 'chose', 'pattern', 'prefers']);
});

test('MEM-02: recall returns prior decisions valid-now; capture writes a recallable decision', () => {
  const statePath = tmpStatePath();
  capture({ statePath, subject: 'auth', predicate: 'decided', object: 'use-jwt', recordedAt: 100, validFrom: 100 });
  capture({ statePath, subject: 'auth', predicate: 'chose', object: 'jose-lib', recordedAt: 200, validFrom: 200 });
  const got = recall({ statePath, subject: 'auth', nowTs: 300, limit: 50 });
  assert.equal(got.length, 2, 'both decisions recalled');
  // Most-recent (recorded_at desc) first.
  assert.equal(got[0].object, 'jose-lib');
  assert.equal(got[1].object, 'use-jwt');
});

test('MEM-02: a contradicted prior is superseded not deleted', () => {
  const statePath = tmpStatePath();
  capture({ statePath, subject: 'auth', predicate: 'decided', object: 'DECISION_A', recordedAt: 100, validFrom: 100 });
  capture({ statePath, subject: 'auth', predicate: 'decided', object: 'DECISION_B', recordedAt: 200, validFrom: 200, contradicts: true });

  const hist = memoryFact.history({ statePath, subject: 'auth' });
  assert.equal(hist.length, 2, 'both retained in history');
  const a = hist.find(f => f.object === 'DECISION_A');
  assert.equal(a.valid_to, 200, 'contradicted prior retained with valid_to = validFrom of the new');

  const now = recall({ statePath, subject: 'auth', nowTs: 200, limit: 50 });
  assert.equal(now.length, 1, 'only the successor is valid-now');
  assert.equal(now[0].object, 'DECISION_B');
});

test('recall does not return a superseded prior (valid_to <= nowTs)', () => {
  const statePath = tmpStatePath();
  capture({ statePath, subject: 'x', predicate: 'decided', object: 'old', recordedAt: 100, validFrom: 100 });
  capture({ statePath, subject: 'x', predicate: 'decided', object: 'new', recordedAt: 200, validFrom: 200, contradicts: true });
  const got = recall({ statePath, subject: 'x', nowTs: 250, limit: 50 });
  assert.deepEqual(got.map(f => f.object), ['new']);
});

test('recall truncates to limit (most-recent first)', () => {
  const statePath = tmpStatePath();
  // Distinct decision predicates so all three stay valid-now (supersede-by-default
  // only closes a SAME subject+predicate prior — see H-1b). Truncation is still
  // exercised by limit=2 over three valid-now decisions.
  capture({ statePath, subject: 's', predicate: 'decided', object: 'a', recordedAt: 100, validFrom: 100 });
  capture({ statePath, subject: 's', predicate: 'chose', object: 'b', recordedAt: 200, validFrom: 200 });
  capture({ statePath, subject: 's', predicate: 'prefers', object: 'c', recordedAt: 300, validFrom: 300 });
  const got = recall({ statePath, subject: 's', nowTs: 400, limit: 2 });
  assert.equal(got.length, 2);
  assert.deepEqual(got.map(f => f.object), ['c', 'b']);
});

// ---------------------------------------------------------------------------
// H-1 (Fix 1b/1c): capture is supersede-by-default; --contradicts is atomic.
// "At most one valid-now fact per subject+predicate" is the enforced invariant.
// ---------------------------------------------------------------------------

/** Count valid_to===null facts for subject+predicate directly on disk. */
function countOpen(statePath, subject, predicate) {
  const store = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return store.facts.filter(
    (f) => f.valid_to === null && f.subject === subject && f.predicate === predicate,
  ).length;
}

test('H-1b: two plain captures of the same subject+predicate leave exactly ONE valid-now', () => {
  const statePath = tmpStatePath();
  capture({ statePath, subject: 'x', predicate: 'decided', object: 'v1', recordedAt: 100, validFrom: 100 });
  capture({ statePath, subject: 'x', predicate: 'decided', object: 'v2', recordedAt: 100, validFrom: 100 });

  const got = recall({ statePath, subject: 'x', nowTs: 150, limit: 50 });
  assert.equal(got.length, 1, 'recall never returns two valid-now for one subject+predicate');
  assert.equal(got[0].object, 'v2', 'the newer supersedes the older');
  assert.equal(countOpen(statePath, 'x', 'decided'), 1, 'exactly one valid_to:null on disk');

  const hist = memoryFact.history({ statePath, subject: 'x' });
  assert.equal(hist.length, 2, 'history retains BOTH (supersede, never delete)');
});

test('H-1c: capture --contradicts closes ALL open priors atomically → recall returns only the successor', () => {
  const statePath = tmpStatePath();
  // Seed two open priors directly (pure appends), simulating a pre-existing
  // double-open store the contradicting capture must fully close.
  memoryFact.addFact({ statePath, subject: 'x', predicate: 'decided', object: 'v1', validFrom: 100, recordedAt: 100 });
  memoryFact.addFact({ statePath, subject: 'x', predicate: 'decided', object: 'v2', validFrom: 100, recordedAt: 110 });
  assert.equal(countOpen(statePath, 'x', 'decided'), 2, 'precondition: two opens');

  capture({ statePath, subject: 'x', predicate: 'decided', object: 'v3', recordedAt: 200, validFrom: 200, contradicts: true });

  const got = recall({ statePath, subject: 'x', nowTs: 250, limit: 50 });
  assert.deepEqual(got.map(f => f.object), ['v3'], 'ALL priors closed; only v3 valid-now');
  assert.equal(countOpen(statePath, 'x', 'decided'), 1, 'exactly one valid_to:null (v3)');

  const hist = memoryFact.history({ statePath, subject: 'x' });
  assert.equal(hist.length, 3, 'all three retained (no delete)');
});

test('H-1: no two valid_to:null coexist for one subject+predicate across a capture sequence', () => {
  const statePath = tmpStatePath();
  for (let i = 1; i <= 5; i++) {
    capture({ statePath, subject: 'k', predicate: 'decided', object: 'o' + i, recordedAt: i * 100, validFrom: i * 100 });
    assert.equal(countOpen(statePath, 'k', 'decided'), 1, `after capture ${i}: exactly one valid-now`);
  }
  const hist = memoryFact.history({ statePath, subject: 'k' });
  assert.equal(hist.length, 5, 'every version retained');
});

test('recall predicate match is case-insensitive', () => {
  const statePath = tmpStatePath();
  // Capture with a mixed-case predicate; the lower-case filter must still recall it.
  capture({ statePath, subject: 's', predicate: 'Decided', object: 'v', recordedAt: 100, validFrom: 100 });
  const got = recall({ statePath, subject: 's', nowTs: 200, limit: 50 });
  assert.equal(got.length, 1);
  assert.equal(got[0].object, 'v');
});

test('recall filters out non-decision predicates', () => {
  const statePath = tmpStatePath();
  capture({ statePath, subject: 's', predicate: 'decided', object: 'keep', recordedAt: 100, validFrom: 100 });
  // A non-decision predicate written directly to the fact store must not be recalled.
  memoryFact.addFact({ statePath, subject: 's', predicate: 'noise', object: 'drop', validFrom: 100, recordedAt: 150 });
  const got = recall({ statePath, subject: 's', nowTs: 200, limit: 50 });
  assert.deepEqual(got.map(f => f.object), ['keep']);
});

test('capture round-trips against the shared statePath (later-session recall)', () => {
  const statePath = tmpStatePath();
  capture({ statePath, subject: 'sess', predicate: 'prefers', object: 'tabs', recordedAt: 500, validFrom: 500 });
  // A fresh recall call (as a later session would) sees it.
  const got = recall({ statePath, subject: 'sess', nowTs: 500, limit: 50 });
  assert.equal(got.length, 1);
  assert.equal(got[0].object, 'tabs');
});

test('M-1: recall over a corrupt store degrades to empty (no crash)', () => {
  const statePath = tmpStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, '<<<<<<< HEAD\nnot json {{{\n>>>>>>> other\n');
  assert.deepEqual(recall({ statePath, subject: 'anything', nowTs: 100, limit: 50 }), []);
});
