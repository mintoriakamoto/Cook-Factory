'use strict';

/**
 * TRIAGE-01 (v1.1 Phase C) — inbox.to-backlog: approved issue -> backlog row,
 * ungated issue -> refused. The issue-first gate is enforced in the core, not prose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateToBacklog } = require('../ferrox-core/bin/lib/inbox-to-backlog.cjs');

test('TRIAGE-01: an approved feature issue becomes a backlog row with gh source + acceptance', () => {
  const r = evaluateToBacklog({
    number: 42,
    title: 'Add capped benchmark goal-loop',
    type: 'feature',
    labels: ['feature-request', 'needs-review', 'approved-feature'],
    acceptanceCriteria: 'loop terminates at cap; cap-outcome logged',
  });
  assert.equal(r.decision, 'append');
  assert.equal(r.id, 'gh-42');
  assert.equal(r.source, 'gh#42');
  assert.match(r.row, /gh#42/);
  assert.match(r.row, /Acceptance: loop terminates at cap/);
  assert.match(r.row, /^\| gh-42 \| FEAT \| inbox \(gh#42\) \|/);
});

test('TRIAGE-01: an UNGATED feature issue is refused (issue-first gate)', () => {
  const r = evaluateToBacklog({
    number: 7,
    title: 'Sneak in without approval',
    type: 'feature',
    labels: ['feature-request', 'needs-review'], // no approved-feature
  });
  assert.equal(r.decision, 'refused-not-gated');
  assert.equal(r.requiredLabel, 'approved-feature');
});

test('TRIAGE-01: enhancement and bug require their own approval labels', () => {
  assert.equal(
    evaluateToBacklog({ number: 1, title: 'e', type: 'enhancement', labels: ['approved-enhancement'] }).decision,
    'append',
  );
  assert.equal(
    evaluateToBacklog({ number: 2, title: 'e', type: 'enhancement', labels: ['approved-feature'] }).decision,
    'refused-not-gated', // wrong approval label doesn't count
  );
  assert.equal(
    evaluateToBacklog({ number: 3, title: 'b', type: 'bug', labels: ['confirmed-bug'] }).decision,
    'append',
  );
});

test('TRIAGE-01: approval label match is case-insensitive', () => {
  const r = evaluateToBacklog({
    number: 9, title: 'x', type: 'feature', labels: ['Approved-Feature'],
  });
  assert.equal(r.decision, 'append');
});

// Count STRUCTURAL column delimiters robustly: strip every backslash-escape pair
// (\\ and \|) first, then count remaining pipes. A 5-column row has exactly 6.
function structuralPipes(row) {
  return (row.replace(/\\./g, '').match(/\|/g) || []).length;
}

test('TRIAGE-01: a pipe in the title cannot break the backlog table', () => {
  const r = evaluateToBacklog({
    number: 5, title: 'add A | B routing', type: 'feature', labels: ['approved-feature'],
  });
  assert.equal(r.decision, 'append');
  assert.equal(structuralPipes(r.row), 6);
});

test('TRIAGE-01: a BACKSLASH-then-pipe title stays escaped (Phase-C audit MEDIUM)', () => {
  // 'back\|slash' must not leak a live delimiter: backslash escaped first, then pipe.
  const r = evaluateToBacklog({
    number: 6, title: 'back\\|slash routing', type: 'feature', labels: ['approved-feature'],
  });
  assert.equal(r.decision, 'append');
  assert.equal(structuralPipes(r.row), 6);
  // the raw backslash is doubled and the pipe is escaped
  assert.match(r.row, /back\\\\\\|slash/);
});
