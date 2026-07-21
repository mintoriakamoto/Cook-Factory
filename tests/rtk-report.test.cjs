'use strict';

/**
 * MODEL-05 red-green tests for the rtk.report savings-parse core.
 *
 * Parse the token-savings figure out of rtk's OWN output — never fabricate a
 * number (the honesty rule), never throw (total parse):
 *   - a realistic rtk gain string -> { saved, pct, source:'rtk' } from that output;
 *   - empty input -> { saved:0, source:'rtk', error:'empty' };
 *   - non-empty but number-free input -> { saved:0, source:'rtk', error:'unparseable' }.
 *
 * PURE core: no fs, no clock, no config, no spawn. rtkOutput is an EXPLICIT input
 * (the Plan 08 live demo feeds real rtk output; these tests feed canned strings).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRtkSavings } = require('../ferrox-core/bin/lib/rtk-report.cjs');

const REAL_RTK_OUTPUT = [
  'rtk gain',
  'Commands proxied: 142',
  'Tokens saved: 45,231 (73% reduction)',
  'Baseline: 61,960 tokens',
].join('\n');

test('parses a realistic rtk gain output into a saved figure (MODEL-05)', () => {
  const r = parseRtkSavings({ rtkOutput: REAL_RTK_OUTPUT });
  assert.equal(r.saved, 45231, 'commas stripped from the saved figure');
  assert.equal(r.pct, 73);
  assert.equal(r.source, 'rtk');
  assert.equal(r.error, undefined, 'a successful parse carries no error token');
});

test('empty output degrades to saved:0 with an empty error token (no throw)', () => {
  const r = parseRtkSavings({ rtkOutput: '' });
  assert.deepEqual(r, { saved: 0, source: 'rtk', error: 'empty' });
});

test('whitespace-only output is treated as empty', () => {
  const r = parseRtkSavings({ rtkOutput: '   \n  ' });
  assert.equal(r.saved, 0);
  assert.equal(r.error, 'empty');
});

test('number-free garbage degrades to saved:0 with an unparseable token (no throw)', () => {
  const r = parseRtkSavings({ rtkOutput: 'garbage no numbers here' });
  assert.deepEqual(r, { saved: 0, source: 'rtk', error: 'unparseable' });
});

test('a missing rtkOutput does not throw and degrades to empty', () => {
  const r = parseRtkSavings({});
  assert.equal(r.saved, 0);
  assert.equal(r.source, 'rtk');
  assert.ok(r.error === 'empty' || r.error === 'unparseable');
});

test('never fabricates a figure — a saved number only echoes rtk output', () => {
  // No "saved" figure present -> unparseable, saved stays 0 (never invented).
  const r = parseRtkSavings({ rtkOutput: 'Commands proxied: 142\nBaseline: 61,960 tokens' });
  assert.equal(r.saved, 0);
  assert.equal(r.error, 'unparseable');
});
