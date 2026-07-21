'use strict';

/**
 * MODEL-05 red-green tests for the rtk.wrap decision core.
 *
 * Route a shell/dev op through rtk ONLY when the flag is enabled AND rtk is
 * present; otherwise pass the original command through unchanged so the fork keeps
 * working on a machine without rtk (graceful pass-through):
 *   - enabled AND present AND a non-empty command -> wrap (rtk prepended);
 *   - flag off OR rtk absent -> passthrough (command unchanged);
 *   - an empty/invalid command fails closed to passthrough (never a bare 'rtk').
 *
 * PURE core: no fs, no clock, no config, no spawn. enabled/rtkPresent are EXPLICIT
 * inputs (the Plan 06 router forwards config.model.rtk.enabled; the seam probes rtk).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateRtkWrap } = require('../ferrox-core/bin/lib/rtk-wrap.cjs');

test('wrap when enabled AND rtk present (MODEL-05)', () => {
  const r = evaluateRtkWrap({ enabled: true, rtkPresent: true, command: ['git', 'status'] });
  assert.deepEqual(r, { decision: 'wrap', wrapped: ['rtk', 'git', 'status'] });
});

test('passthrough when the flag is off', () => {
  const r = evaluateRtkWrap({ enabled: false, rtkPresent: true, command: ['git', 'status'] });
  assert.deepEqual(r, { decision: 'passthrough', wrapped: ['git', 'status'] });
});

test('passthrough when rtk is absent (graceful degradation)', () => {
  const r = evaluateRtkWrap({ enabled: true, rtkPresent: false, command: ['git', 'status'] });
  assert.deepEqual(r, { decision: 'passthrough', wrapped: ['git', 'status'] });
});

test('an empty command fails closed to passthrough (never a bare rtk)', () => {
  const r = evaluateRtkWrap({ enabled: true, rtkPresent: true, command: [] });
  assert.equal(r.decision, 'passthrough');
  assert.deepEqual(r.wrapped, []);
});

test('a non-array command fails closed to passthrough', () => {
  const r = evaluateRtkWrap({ enabled: true, rtkPresent: true, command: 'git status' });
  assert.equal(r.decision, 'passthrough');
});

test('a command with a non-string element fails closed to passthrough', () => {
  const r = evaluateRtkWrap({ enabled: true, rtkPresent: true, command: ['git', 42] });
  assert.equal(r.decision, 'passthrough');
});

test('truthy-but-not-true enabled does NOT wrap (strict boolean)', () => {
  const r = evaluateRtkWrap({ enabled: 1, rtkPresent: true, command: ['git', 'status'] });
  assert.equal(r.decision, 'passthrough');
});
