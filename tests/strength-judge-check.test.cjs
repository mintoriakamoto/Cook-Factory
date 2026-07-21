'use strict';

/**
 * STRONG-01 red-green tests for the strength.judge-check core.
 *
 * The identity that authored a change must NOT be the identity that grades its
 * risk. This core enforces that a severity/risk record carries an INDEPENDENT
 * judge identity (judge_id) distinct from the author (author_id). Invariants:
 *   1. judge_id === author_id (after trim + lower-case) → rejected-self-judged.
 *   2. A distinct non-empty judge_id → accepted.
 *   3. A missing / blank / non-string judge_id fails CLOSED → rejected-self-judged
 *      (an author cannot leave the judge blank to sneak a self-grade through).
 *   4. Whitespace/case-only differences do NOT make a judge independent.
 *   5. Raw ids are echoed for the run-log.
 *
 * PURE core: no fs, no clock — every assertion is deterministic on explicit input.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateJudgeCheck } = require('../ferrox-core/bin/lib/strength-judge-check.cjs');

// --- self-judge rejection (STRONG-01) ----------------------------------------

test('judge_id equal to author_id is rejected-self-judged', () => {
  const r = evaluateJudgeCheck({ author_id: 'agent-alpha', judge_id: 'agent-alpha' });
  assert.equal(r.decision, 'rejected-self-judged');
  assert.equal(r.author_id, 'agent-alpha', 'echoes raw author_id');
  assert.equal(r.judge_id, 'agent-alpha', 'echoes raw judge_id');
});

test('case/whitespace-only difference is still the same identity → rejected-self-judged', () => {
  const r = evaluateJudgeCheck({ author_id: 'Agent-Alpha', judge_id: '  agent-alpha  ' });
  assert.equal(r.decision, 'rejected-self-judged');
  assert.equal(r.author_id, 'Agent-Alpha', 'echoes RAW author_id, un-normalized');
  assert.equal(r.judge_id, '  agent-alpha  ', 'echoes RAW judge_id, un-normalized');
});

// --- independent judge acceptance (STRONG-01) --------------------------------

test('a distinct non-empty judge_id is accepted', () => {
  const r = evaluateJudgeCheck({ author_id: 'agent-alpha', judge_id: 'agent-bravo' });
  assert.equal(r.decision, 'accepted');
  assert.equal(r.author_id, 'agent-alpha');
  assert.equal(r.judge_id, 'agent-bravo');
});

// --- fail CLOSED on a blank / missing judge (STRONG-01) ----------------------

test('a blank judge_id fails closed → rejected-self-judged', () => {
  const r = evaluateJudgeCheck({ author_id: 'agent-alpha', judge_id: '   ' });
  assert.equal(r.decision, 'rejected-self-judged');
});

test('a missing judge_id fails closed → rejected-self-judged', () => {
  const r = evaluateJudgeCheck({ author_id: 'agent-alpha' });
  assert.equal(r.decision, 'rejected-self-judged');
});

test('a non-string judge_id fails closed → rejected-self-judged', () => {
  const r = evaluateJudgeCheck({ author_id: 'agent-alpha', judge_id: 12345 });
  assert.equal(r.decision, 'rejected-self-judged');
});

test('a blank author with a real judge is still accepted (author identity is not the guard here)', () => {
  // The guard is judge !== author AND judge present; a present distinct judge over
  // a blank author is independent (nothing to self-judge against).
  const r = evaluateJudgeCheck({ author_id: '', judge_id: 'agent-bravo' });
  assert.equal(r.decision, 'accepted');
});
