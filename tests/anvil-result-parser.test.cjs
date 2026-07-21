'use strict';

/**
 * ANV-02 red-green tests — the Anvil result parser (v1.4 Anvil Executor).
 *
 * Anvil exits 0 EVEN WHEN NEVER GREEN — so the exit code is meaningless. The truth
 * lives in the last ledger line it prints:
 *   FINAL best=N/M  calls=K  out_tok=T  flat_cost=$X  TRUE_cost=$Y
 *
 * parseAnvilResult(stdout) -> { best, total, calls, outTok, flatCostUsd, trueCostUsd, green }
 *   green = total > 0 && best >= total
 *
 * FAIL-CLOSED: a missing/garbage FINAL line yields green:false with null fields — a
 * result we cannot score is treated as NOT green, so the candidate faces the full
 * normal gate and never gets a free pass. PURE: string in, object out. Never throws.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseAnvilResult } = require('../ferrox-core/bin/lib/anvil-result-parser.cjs');

const GREEN_OUT = [
  '# AB-MCTS demo pool=[minimax,glm,deepseek,kimi] budget=12 calls',
  'init [seed]: 3/5  (calls=0 $0.0000)',
  '  deeper[glm] on \'accepts empty\': 5/5 ACCEPT  best=5/5 (calls=2 $0.0002)',
  'GREEN at calls=2 $0.0002',
  'FINAL best=5/5  calls=2  out_tok=1840  flat_cost=$0.0002  TRUE_cost=$0.0011',
].join('\n');

const PARTIAL_OUT = [
  'init [seed]: 3/5  (calls=0 $0.0000)',
  'FINAL best=4/5  calls=12  out_tok=9200  flat_cost=$0.0009  TRUE_cost=$0.0051',
].join('\n');

test('parses a GREEN FINAL line — score, cost, tokens, green=true (ANV-02)', () => {
  const r = parseAnvilResult(GREEN_OUT);
  assert.equal(r.best, 5);
  assert.equal(r.total, 5);
  assert.equal(r.calls, 2);
  assert.equal(r.outTok, 1840);
  assert.equal(r.flatCostUsd, 0.0002);
  assert.equal(r.trueCostUsd, 0.0011);
  assert.equal(r.green, true);
});

test('a partial climb (best < total) is NOT green', () => {
  const r = parseAnvilResult(PARTIAL_OUT);
  assert.equal(r.best, 4);
  assert.equal(r.total, 5);
  assert.equal(r.green, false);
});

test('best == total but total 0 is NOT green (degenerate gate)', () => {
  const r = parseAnvilResult('FINAL best=0/0  calls=1  out_tok=10  flat_cost=$0.0000  TRUE_cost=$0.0000');
  assert.equal(r.green, false);
});

test('FAIL-CLOSED: no FINAL line -> green false, null fields (never a free pass)', () => {
  const r = parseAnvilResult('init [seed]: 3/5\nsome noise\nno final here');
  assert.equal(r.green, false);
  assert.equal(r.best, null);
  assert.equal(r.total, null);
});

test('FAIL-CLOSED: empty / non-string input -> green false, never throws', () => {
  assert.doesNotThrow(() => parseAnvilResult(''));
  assert.equal(parseAnvilResult('').green, false);
  assert.doesNotThrow(() => parseAnvilResult(undefined));
  assert.equal(parseAnvilResult(undefined).green, false);
  assert.doesNotThrow(() => parseAnvilResult(42));
  assert.equal(parseAnvilResult(42).green, false);
});

test('takes the LAST FINAL line if somehow more than one is present', () => {
  const out = [
    'FINAL best=2/5  calls=4  out_tok=100  flat_cost=$0.0001  TRUE_cost=$0.0005',
    'FINAL best=5/5  calls=8  out_tok=300  flat_cost=$0.0003  TRUE_cost=$0.0015',
  ].join('\n');
  const r = parseAnvilResult(out);
  assert.equal(r.best, 5);
  assert.equal(r.green, true);
  assert.equal(r.calls, 8);
});

test('tolerates missing cost fields on the FINAL line -> nulls, score still parsed', () => {
  const r = parseAnvilResult('FINAL best=5/5  calls=3');
  assert.equal(r.best, 5);
  assert.equal(r.total, 5);
  assert.equal(r.green, true);
  assert.equal(r.flatCostUsd, null);
});
