'use strict';

/**
 * TRIAGE-01 C2/C3 — issue lifecycle: label in-progress on start; close ONLY on
 * merge-gate pass. The fail-closed property (block => issue stays open) is the
 * load-bearing one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { onIncrementStart, onMergeGate } = require('../ferrox-core/bin/lib/issue-lifecycle.cjs');

test('C2: a linked increment labels its issue in-progress and clears waiting labels', () => {
  const r = onIncrementStart({ githubIssue: 42, increment: 'gh-42' });
  assert.equal(r.decision, 'applied');
  assert.deepEqual(r.actions[0], { action: 'label', issue: 42, value: 'in-progress' });
  assert.ok(r.actions.some((a) => a.action === 'unlabel' && a.value === 'needs-review'));
});

test('C2: an increment with no linked issue is a noop (no stray gh calls)', () => {
  const r = onIncrementStart({ githubIssue: null, increment: 'FF-B21' });
  assert.equal(r.decision, 'noop');
  assert.equal(r.actions.length, 0);
});

test('C3: merge-gate PASS closes the linked issue (comment + close)', () => {
  const r = onMergeGate({ githubIssue: 42, increment: 'gh-42', gateDecision: 'pass' });
  assert.equal(r.decision, 'applied');
  assert.ok(r.actions.some((a) => a.action === 'close' && a.issue === 42));
});

test('C3 (fail-closed): a BLOCKED merge-gate does NOT close the issue', () => {
  const r = onMergeGate({ githubIssue: 42, increment: 'gh-42', gateDecision: 'block' });
  assert.equal(r.decision, 'noop');
  assert.equal(r.actions.filter((a) => a.action === 'close').length, 0);
});

test('C3 (fail-closed): an unknown/garbage gate decision does NOT close the issue', () => {
  for (const d of ['', 'PASS', 'passed', 'ok', 'unknown']) {
    const r = onMergeGate({ githubIssue: 42, increment: 'gh-42', gateDecision: d });
    assert.equal(r.actions.filter((a) => a.action === 'close').length, 0, `must not close on '${d}'`);
  }
});

test('C3: no linked issue => noop even on pass', () => {
  const r = onMergeGate({ githubIssue: null, increment: 'FF-B21', gateDecision: 'pass' });
  assert.equal(r.decision, 'noop');
});
