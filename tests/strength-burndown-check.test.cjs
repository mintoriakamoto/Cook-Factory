'use strict';

/**
 * STRONG-05 red-green tests for the strength.burndown-check core.
 *
 * "Landed" must be UNREACHABLE while the backlog grows or a security/correctness
 * item rots. Invariants:
 *   - net = opened - resolved > 0 → blocked/net-backlog-grew.
 *   - any security/correctness item aged past age_limit_days → blocked/aged-item,
 *     even when net shrank.
 *   - net flat/shrank AND no aged security/correctness item → ok.
 *   - non-finite counts or a missing age_limit_days → blocked (fail closed:
 *     cannot prove the floor holds). Category matching is case-insensitive.
 *
 * PURE core: no fs, no clock, no config.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateBurndown } = require('../ferrox-core/bin/lib/strength-burndown-check.cjs');

// --- net backlog growth blocks (STRONG-05) -----------------------------------

test('net backlog growth (opened > resolved) → blocked/net-backlog-grew', () => {
  const r = evaluateBurndown({ opened: 5, resolved: 2, items: [], age_limit_days: 7 });
  assert.equal(r.decision, 'blocked');
  assert.equal(r.reason, 'net-backlog-grew');
});

// --- aged security/correctness item blocks even when net shrank --------------

test('an aged security item blocks even when net backlog shrank → blocked/aged-item', () => {
  const r = evaluateBurndown({
    opened: 2,
    resolved: 5,
    items: [{ id: 'S-1', category: 'Security', age_days: 10 }],
    age_limit_days: 7,
  });
  assert.equal(r.decision, 'blocked');
  assert.equal(r.reason, 'aged-item');
});

test('an aged correctness item blocks (category case-insensitive)', () => {
  const r = evaluateBurndown({
    opened: 0,
    resolved: 0,
    items: [{ id: 'C-1', category: 'CORRECTNESS', age_days: 8 }],
    age_limit_days: 7,
  });
  assert.equal(r.decision, 'blocked');
  assert.equal(r.reason, 'aged-item');
});

// --- ok path -----------------------------------------------------------------

test('net shrank and no aged security/correctness item → ok', () => {
  const r = evaluateBurndown({
    opened: 2,
    resolved: 5,
    items: [{ id: 'S-1', category: 'security', age_days: 3 }],
    age_limit_days: 7,
  });
  assert.equal(r.decision, 'ok');
});

test('net flat with no items → ok', () => {
  const r = evaluateBurndown({ opened: 4, resolved: 4, items: [], age_limit_days: 7 });
  assert.equal(r.decision, 'ok');
});

test('an aged NON-security/correctness item does not block (only security/correctness age matters)', () => {
  const r = evaluateBurndown({
    opened: 1,
    resolved: 3,
    items: [{ id: 'X-1', category: 'style', age_days: 100 }],
    age_limit_days: 7,
  });
  assert.equal(r.decision, 'ok');
});

test('age exactly at the limit does not block (strictly greater than)', () => {
  const r = evaluateBurndown({
    opened: 0,
    resolved: 0,
    items: [{ id: 'S-1', category: 'security', age_days: 7 }],
    age_limit_days: 7,
  });
  assert.equal(r.decision, 'ok', 'age_days must be strictly > age_limit_days to block');
});

// --- fail closed -------------------------------------------------------------

test('a non-finite opened count fails closed → blocked', () => {
  assert.equal(evaluateBurndown({ resolved: 2, items: [], age_limit_days: 7 }).decision, 'blocked');
  assert.equal(evaluateBurndown({ opened: NaN, resolved: 2, items: [], age_limit_days: 7 }).decision, 'blocked');
});

test('a missing age_limit_days fails closed → blocked (cannot prove the floor)', () => {
  const r = evaluateBurndown({ opened: 1, resolved: 3, items: [{ id: 'S-1', category: 'security', age_days: 3 }] });
  assert.equal(r.decision, 'blocked');
});
