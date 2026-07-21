'use strict';

/**
 * Acceptance tests for the Phase-7 memory wiring (Plan 05).
 *
 * A file-reading test — it asserts the DOCUMENTED PROTOCOL is actually present
 * and greppable, so the memory model cannot silently rot or over-claim. It proves:
 *   1. memory.md documents the three memory verbs + a ferrox-tools query memory.*
 *      usage token.
 *   2. memory.md states the supersede-don't-delete invariant and the half-open
 *      validity window.
 *   3. The mechanism-vs-protocol honesty: the store/recall/capture is tested
 *      enforceable code while the Frame/Learn invocation is orchestration protocol
 *      (not tool-layer enforced).
 *   4. The recall seam (mempalace-recall.md) cites memory.recall and the capture
 *      seam (mempalace-capture.md) cites memory.capture.
 *   5. The Frame ref (plan-phase.md) cites memory.recall and the Learn ref
 *      (extract-learnings.md) cites memory.capture.
 *
 * Every assertion is a hard assert. node --test exits non-zero on any failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const MEMORY_MD = 'ferrox-core/references/memory.md';
const RECALL_SEAM = 'commands/ferrox/mempalace-recall.md';
const CAPTURE_SEAM = 'commands/ferrox/mempalace-capture.md';
const PLAN_PHASE = 'ferrox-core/workflows/plan-phase.md';
const EXTRACT_LEARNINGS = 'ferrox-core/workflows/extract-learnings.md';

const THREE_VERBS = ['memory.fact', 'memory.recall', 'memory.capture'];

test('memory.md exists and documents all three memory verbs + a usage token', () => {
  assert.ok(exists(MEMORY_MD), `${MEMORY_MD} must exist`);
  const m = read(MEMORY_MD);
  assert.ok(m.trim().length > 0, 'memory.md must be non-empty');
  for (const verb of THREE_VERBS) {
    assert.ok(m.includes(verb), `memory.md must document ${verb}`);
  }
  assert.match(
    m,
    /ferrox-tools query memory\./,
    'memory.md must contain a "ferrox-tools query memory." usage token',
  );
});

test('memory.md states the supersede-don\'t-delete invariant and the half-open window', () => {
  const m = read(MEMORY_MD);
  assert.match(m, /SUPERSEDE-DON'T-DELETE/i, 'must state the supersede-don\'t-delete invariant');
  assert.match(m, /retained/i, 'must say the old fact is retained');
  assert.match(m, /\[valid_from, valid_to\)/, 'must state the half-open validity window');
  // The --op contract for memory.fact.
  for (const op of ['add', 'get-valid-at', 'history', 'invalidate']) {
    assert.ok(m.includes(op), `memory.md must document the --op ${op} operation`);
  }
});

test('memory.md carries the honest mechanism-vs-protocol caveat', () => {
  const m = read(MEMORY_MD);
  assert.match(m, /Mechanism vs Protocol/i, 'must have the honesty section');
  assert.match(m, /tested enforceable code/i, 'store/recall/capture is tested enforceable code');
  assert.match(m, /orchestration protocol/i, 'the Frame/Learn invocation is orchestration protocol');
  // Must NOT over-claim a tool-layer gate for the invocation.
  assert.match(m, /not enforced at the tool layer|NOT.*un-bypassable|graceful no-op/i,
    'must state the invocation is not a tool-layer gate');
});

test('the recall seam cites memory.recall and the capture seam cites memory.capture', () => {
  assert.match(read(RECALL_SEAM), /memory\.recall/, 'mempalace-recall.md must cite memory.recall');
  assert.match(read(CAPTURE_SEAM), /memory\.capture/, 'mempalace-capture.md must cite memory.capture');
});

test('the Frame ref cites memory.recall and the Learn ref cites memory.capture', () => {
  assert.match(read(PLAN_PHASE), /memory\.recall/, 'plan-phase.md (Frame) must cite memory.recall');
  assert.match(read(EXTRACT_LEARNINGS), /memory\.capture/, 'extract-learnings.md (Learn) must cite memory.capture');
});
