'use strict';

/**
 * MODEL-04 red-green tests for the trident.audit enforcement core — the anti-loop
 * thesis made code. Four bounded invariants over an INJECTED panel of findings,
 * evaluated in order, returning on the FIRST failing invariant:
 *   (1) allowedCheckpoints MUST be exactly two distinct entries (bounded set);
 *   (2) NO open-ended / loopUntilClean / maxRounds>1 invocation (single pass only);
 *   (3) the checkpoint MUST be one of the two allowed;
 *   (4) cross-lineage: the caller's own family may NOT be in the panel.
 * Only if all four pass: one pass tags findings CONSENSUS (>= 2 distinct families)
 * vs CONTESTED (exactly one family).
 *
 * PURE core: no fs, no clock, no config, no child_process. Panel + allowedCheckpoints
 * are INJECTED (the Plan 06 seam supplies the real codex/gemini panel; the Plan 08
 * demo runs it live). There is NO real CLI call here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateTrident } = require('../ferrox-core/bin/lib/trident-audit.cjs');

const CHECKPOINTS = ['plan-lock-gap-audit', 'high-risk-wave-audit'];

// A valid cross-lineage panel (Claude caller draws from codex + gemini).
function crossLineagePanel() {
  return [
    { family: 'codex', findings: ['missing-authz', 'weak-hash'] },
    { family: 'gemini', findings: ['missing-authz'] },
  ];
}

// --- (4) cross-lineage caller-family exclusion --------------------------------

test('REFUSE a panel that includes the caller family (cross-lineage exclusion)', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: [{ family: 'claude', findings: ['x'] }, { family: 'codex', findings: ['x'] }],
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'caller-family-in-panel');
});

test('caller-family exclusion is case-insensitive ("Claude" still excluded)', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: [{ family: 'Claude', findings: ['x'] }, { family: 'gemini', findings: ['x'] }],
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'caller-family-in-panel');
});

// --- (4) cross-lineage exclusion defeats ALIASING (MEDIUM-1) ------------------
// The caller lineage must be canonicalized BEFORE the exclusion equality check, so
// a panel member that is a lineage-alias of the caller (not a byte-equal string) is
// still recognized as the caller's own family and refused. Casing was already caught;
// aliasing (anthropic / claude-opus for a `claude` caller) was previously defeatable.

test('caller-family exclusion catches an ALIAS of the caller lineage ("anthropic" ~ claude)', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: [{ family: 'anthropic', findings: ['x'] }],
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'caller-family-in-panel', 'anthropic is the claude lineage — an aliased self-audit');
});

test('caller-family exclusion catches a claude-* alias of the caller lineage ("claude-opus")', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: [{ family: 'claude-opus', findings: ['x'] }],
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'caller-family-in-panel', 'claude-opus is the claude lineage — an aliased self-audit');
});

// --- (3) invalid checkpoint ---------------------------------------------------

test('REFUSE an invalid checkpoint not in the allowed set', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: crossLineagePanel(),
    checkpoint: 'some-other-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'invalid-checkpoint');
});

// --- (2) unbounded invocation (the anti-loop thesis) --------------------------

test('REFUSE an open-ended mode invocation', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: crossLineagePanel(),
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
    mode: 'open-ended',
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'unbounded-invocation');
});

test('REFUSE a loopUntilClean invocation', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: crossLineagePanel(),
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
    loopUntilClean: true,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'unbounded-invocation');
});

test('REFUSE a maxRounds > 1 invocation', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: crossLineagePanel(),
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
    maxRounds: 2,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'unbounded-invocation');
});

// --- (1) bounded set (checked FIRST) ------------------------------------------

test('REFUSE a checkpoint set that is not exactly two entries', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: crossLineagePanel(),
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: ['plan-lock-gap-audit', 'high-risk-wave-audit', 'extra-audit'],
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'checkpoint-set-not-bounded');
});

test('the bounded-set check precedes the unbounded check (order)', () => {
  // A 1-entry set AND an open-ended mode -> the FIRST failing invariant wins.
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: crossLineagePanel(),
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: ['only-one'],
    mode: 'open-ended',
  });
  assert.equal(r.reason, 'checkpoint-set-not-bounded');
});

// --- (5) minimum cross-lineage INCLUSION (MEDIUM-2) ---------------------------
// Enforcing caller EXCLUSION alone let a panel vacuously complete with <2 real
// lineages — an empty / single-family / same-lineage panel returned `complete`, so
// "trident complete" did not prove ≥2 lineages reviewed. After caller-exclusion the
// panel MUST contain at least two DISTINCT non-caller lineages (canonicalized).

test('REFUSE an empty panel as not cross-lineage (needs >= 2 distinct lineages)', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: [],
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'panel-not-cross-lineage');
});

test('REFUSE a single-family panel as not cross-lineage', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: [{ family: 'codex', findings: ['x'] }],
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'panel-not-cross-lineage');
});

test('REFUSE two panel members of the SAME lineage (gpt-4 + openai are both openai)', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: [{ family: 'gpt-4', findings: ['x'] }, { family: 'openai', findings: ['y'] }],
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'panel-not-cross-lineage', 'two aliases of one lineage is NOT cross-lineage');
});

test('a genuine 2-lineage panel (codex + gemini) completes', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: [{ family: 'codex', findings: ['x'] }, { family: 'gemini', findings: ['y'] }],
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'complete', 'openai + google are two distinct non-caller lineages');
});

// --- valid bounded call + consensus/contested tagging -------------------------

test('a VALID bounded cross-lineage call completes single-pass with consensus tagging', () => {
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: crossLineagePanel(),
    checkpoint: 'high-risk-wave-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'complete');
  assert.equal(r.pass, 'single');
  assert.equal(r.bounded, true);
  assert.equal(r.checkpoint, 'high-risk-wave-audit');
  assert.deepEqual([...r.panel_families].sort(), ['codex', 'gemini']);
  // 'missing-authz' raised by codex + gemini (2 distinct) -> consensus.
  assert.deepEqual(r.consensus, ['missing-authz']);
  // 'weak-hash' raised by codex only -> contested.
  assert.deepEqual(r.contested, ['weak-hash']);
});

test('a finding raised by two panel entries of the SAME family is still contested', () => {
  // Panel is cross-lineage (codex=openai + gemini=google satisfy MEDIUM-2), but the
  // 'dup' finding is raised only by the codex lineage twice — one distinct lens.
  const r = evaluateTrident({
    callerFamily: 'claude',
    panel: [
      { family: 'codex', findings: ['dup'] },
      { family: 'codex', findings: ['dup'] },
      { family: 'gemini', findings: ['other'] },
    ],
    checkpoint: 'plan-lock-gap-audit',
    allowedCheckpoints: CHECKPOINTS,
  });
  assert.equal(r.decision, 'complete');
  assert.ok(r.contested.includes('dup'), 'same family twice is one distinct lens, not consensus');
  assert.deepEqual(r.consensus, [], 'no finding was raised by two distinct families');
});
