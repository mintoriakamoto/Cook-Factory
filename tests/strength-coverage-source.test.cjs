'use strict';

/**
 * FF-B11 red-green tests for the strength.coverage-source core.
 *
 * The previously-decorative coverage.delta was fed caller-supplied arithmetic;
 * this source derives covered/total from a REAL REQUIREMENTS.md so a "landed"
 * signal reflects an actual requirement-coverage advance, not a fabricated number.
 * Invariants:
 *   - countCoverage counts requirement checkbox lines (`- [ ]`/`- [x]` + **ID**):
 *     total = all such lines, covered = those marked `- [x]`.
 *   - flipping one requirement to complete raises covered by exactly 1, so
 *     coverage.delta(before, after) → 'landed'.
 *   - an unchanged fixture → equal covered → coverage.delta 'not-landed'.
 *   - a missing/empty file → { covered: 0, total: 0 } (fail closed).
 *
 * PURE reader: no clock, no config.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { countCoverage } = require('../ferrox-core/bin/lib/strength-coverage-source.cjs');
const { evaluateCoverageDelta } = require('../ferrox-core/bin/lib/coverage-delta.cjs');

function tmpReq(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-cov-src-'));
  const p = path.join(dir, 'REQUIREMENTS.md');
  fs.writeFileSync(p, body);
  return p;
}

const THREE_REQS_ONE_DONE = [
  '# Requirements',
  '',
  '## Strength',
  '- [x] **STRONG-01**: independent judge.',
  '- [ ] **STRONG-02**: red-green receipt.',
  '- [ ] **STRONG-03**: mutation kill.',
  '',
  'Some prose that is not a requirement line.',
  '- [ ] a plain checkbox with no bold ID (must NOT count)',
  '',
].join('\n');

const THREE_REQS_TWO_DONE = THREE_REQS_ONE_DONE.replace(
  '- [ ] **STRONG-02**: red-green receipt.',
  '- [x] **STRONG-02**: red-green receipt.',
);

test('countCoverage counts total requirement IDs and covered (marked complete)', () => {
  const p = tmpReq(THREE_REQS_ONE_DONE);
  assert.deepEqual(countCoverage({ requirementsPath: p }), { covered: 1, total: 3 });
});

test('a plain checkbox without a bold requirement ID does not count', () => {
  const p = tmpReq('- [x] not a requirement\n- [x] **REAL-01**: a real one.\n');
  assert.deepEqual(countCoverage({ requirementsPath: p }), { covered: 1, total: 1 });
});

test('flipping one requirement to complete drives coverage.delta to landed (FF-B11 real advance)', () => {
  const before = countCoverage({ requirementsPath: tmpReq(THREE_REQS_ONE_DONE) });
  const after = countCoverage({ requirementsPath: tmpReq(THREE_REQS_TWO_DONE) });

  assert.equal(after.covered, before.covered + 1, 'exactly one more covered');
  assert.equal(evaluateCoverageDelta(before.covered, after.covered).decision, 'landed');
});

test('an unchanged fixture drives coverage.delta to not-landed (no-op merge rejected)', () => {
  const before = countCoverage({ requirementsPath: tmpReq(THREE_REQS_ONE_DONE) });
  const after = countCoverage({ requirementsPath: tmpReq(THREE_REQS_ONE_DONE) });

  assert.equal(after.covered, before.covered);
  assert.equal(evaluateCoverageDelta(before.covered, after.covered).decision, 'not-landed');
});

test('a missing file fails closed → { covered: 0, total: 0 }', () => {
  assert.deepEqual(countCoverage({ requirementsPath: '/no/such/REQUIREMENTS.md' }), { covered: 0, total: 0 });
});

test('an empty file fails closed → { covered: 0, total: 0 }', () => {
  assert.deepEqual(countCoverage({ requirementsPath: tmpReq('') }), { covered: 0, total: 0 });
});

test('case-insensitive checkbox mark ([X] counts as covered)', () => {
  const p = tmpReq('- [X] **CAP-01**: upper X.\n- [ ] **CAP-02**: open.\n');
  assert.deepEqual(countCoverage({ requirementsPath: p }), { covered: 1, total: 2 });
});
