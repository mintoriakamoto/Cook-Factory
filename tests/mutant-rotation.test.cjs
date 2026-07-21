'use strict';

/**
 * SEAL-02 red-green tests: per-run mutant rotation (ADR-SEALED-GATES decision 2).
 *
 * The pinned deterministic sampling algorithm:
 *   1. seed0 = sha256(utf8(runId + ":" + gateId))
 *   2. candidates = pool sorted lexicographically by fixture hash
 *   3. draw i (0-based): u = first 8 bytes of sha256(seed0 || uint32BE(i)) as big-endian
 *      uint64; pick index u % remaining, remove, repeat until K drawn (default K = 2).
 *
 * Run-record shape: { runId, gateId, sampled: [{ id, hash }] }. Pure, never throws.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { sampleMutants, mintRunId } = require('../ferrox-core/bin/lib/mutant-rotation.cjs');

function hashOf(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** A fixed 5-member pool. Hashes are real sha256 values so lexicographic order is stable. */
function fixedPool() {
  return ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({
    id,
    fixture: `sealed:sha256:${hashOf(`fixture-content-${id}`)}`,
  }));
}

test('sampleMutants: same (runId, gateId) yields the identical sample across calls', () => {
  const pool = fixedPool();
  const a = sampleMutants({ runId: 'run-001', gateId: 'release-manifest', pool, k: 2 });
  const b = sampleMutants({ runId: 'run-001', gateId: 'release-manifest', pool, k: 2 });
  const c = sampleMutants({ runId: 'run-001', gateId: 'release-manifest', pool, k: 2 });
  assert.deepEqual(a.sampled, b.sampled);
  assert.deepEqual(b.sampled, c.sampled);
  assert.equal(a.sampled.length, 2);
});

test('sampleMutants: run record carries runId, gateId, and sampled id + hash pairs', () => {
  const pool = fixedPool();
  const r = sampleMutants({ runId: 'run-002', gateId: 'g1', pool, k: 2 });
  assert.equal(r.runId, 'run-002');
  assert.equal(r.gateId, 'g1');
  for (const s of r.sampled) {
    assert.match(s.id, /^m[1-5]$/);
    assert.match(s.hash, /^[0-9a-f]{64}$/);
  }
});

test('sampleMutants: sampling is without replacement (distinct picks)', () => {
  const pool = fixedPool();
  const r = sampleMutants({ runId: 'run-003', gateId: 'g1', pool, k: 5 });
  const ids = r.sampled.map((s) => s.id);
  assert.equal(new Set(ids).size, 5);
});

test('sampleMutants: different runId changes the sample for at least 1 of many runs', () => {
  const pool = fixedPool();
  const base = JSON.stringify(sampleMutants({ runId: 'r-0', gateId: 'g1', pool, k: 2 }).sampled);
  let differs = false;
  for (let i = 1; i <= 16; i++) {
    const s = JSON.stringify(sampleMutants({ runId: `r-${i}`, gateId: 'g1', pool, k: 2 }).sampled);
    if (s !== base) differs = true;
  }
  assert.equal(differs, true);
});

test('sampleMutants: candidate order is hash-sorted, so pool input order is irrelevant', () => {
  const pool = fixedPool();
  const shuffled = [pool[3], pool[0], pool[4], pool[2], pool[1]];
  const a = sampleMutants({ runId: 'run-004', gateId: 'g1', pool, k: 2 });
  const b = sampleMutants({ runId: 'run-004', gateId: 'g1', pool: shuffled, k: 2 });
  assert.deepEqual(a.sampled, b.sampled);
});

test('sampleMutants: k defaults to 2 and clamps to the pool size', () => {
  const pool = fixedPool();
  assert.equal(sampleMutants({ runId: 'r', gateId: 'g', pool }).sampled.length, 2);
  assert.equal(sampleMutants({ runId: 'r', gateId: 'g', pool: pool.slice(0, 1), k: 2 }).sampled.length, 1);
  assert.equal(sampleMutants({ runId: 'r', gateId: 'g', pool, k: 99 }).sampled.length, 5);
});

test('sampleMutants: accepts bare 64-hex fixture hashes as well as sealed URIs', () => {
  const pool = fixedPool().map((m) => ({ id: m.id, fixture: m.fixture.slice('sealed:sha256:'.length) }));
  const r = sampleMutants({ runId: 'run-005', gateId: 'g1', pool, k: 2 });
  assert.equal(r.sampled.length, 2);
});

test('sampleMutants: garbage input never throws and fails toward an empty sample', () => {
  for (const garbage of [undefined, null, {}, { pool: 'nope' }, { runId: 7, gateId: {}, pool: [{}] }]) {
    const r = sampleMutants(garbage);
    assert.deepEqual(r.sampled, []);
  }
});

test('mintRunId: iso timestamp plus 4 hex chars; injectable for determinism', () => {
  const id = mintRunId({ now: () => new Date('2026-07-21T00:00:00.000Z'), randomHex: () => 'abcd' });
  assert.equal(id, '2026-07-21T00:00:00.000Z-abcd');
  assert.match(mintRunId(), /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z-[0-9a-f]{4}$/);
});
