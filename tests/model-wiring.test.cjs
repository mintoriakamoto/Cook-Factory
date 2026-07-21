'use strict';

/**
 * Acceptance tests for the model-tiering wiring (06-07).
 *
 * This is a file-reading test — it asserts the DOCUMENTED model is actually
 * present and greppable, so the model-tiering model cannot silently rot or
 * over-claim. It proves five things:
 *   1. model-tiering.md exists, is non-empty, documents all six model/trident/rtk
 *      verbs, and contains a `ferrox-tools query model.` usage token.
 *   2. model-tiering.md documents the decision tokens the cores emit (route:
 *      tier/map; escalate: escalate/refused; risk-grade: high-risk; trident:
 *      complete/refused + the four refusal reasons; rtk: wrap/passthrough) — a
 *      doc/code consistency guard (the Phase-4 token lesson).
 *   3. gates.md cites trident.audit at BOTH plan-lock-gap-audit and
 *      high-risk-wave-audit and states the bounded / not-a-merge-gate property.
 *   4. model-profile-resolution.md cites model.route/escalate/risk-grade.
 *   5. execute-phase-wave-guard.md cites model.risk-grade forcing frontier+Trident
 *      and rtk.wrap wrapping the Bash/dev op layer.
 *
 * Every assertion is a hard, POSITIVE includes-assert. node --test exits non-zero
 * on any failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const MODEL_TIERING_MD = 'ferrox-core/references/model-tiering.md';
const GATES_MD = 'ferrox-core/references/gates.md';
const MODEL_PROFILE_MD = 'ferrox-core/references/model-profile-resolution.md';
const WAVE_GUARD_MD = 'ferrox-core/references/execute-phase-wave-guard.md';

// The six locked-name Phase-6 verbs (must match command-aliases.cts /
// {model,trident,rtk}-command-router.cts exactly — the Phase-4 doc/code token lesson).
const SIX_VERBS = [
  'model.route',
  'model.escalate',
  'model.risk-grade',
  'trident.audit',
  'rtk.wrap',
  'rtk.report',
];

test('model-tiering.md exists, documents all six verbs + a ferrox-tools usage token', () => {
  assert.ok(exists(MODEL_TIERING_MD), `${MODEL_TIERING_MD} must exist`);
  const s = read(MODEL_TIERING_MD);
  assert.ok(s.trim().length > 0, 'model-tiering.md must be non-empty');
  for (const verb of SIX_VERBS) {
    assert.ok(s.includes(verb), `model-tiering.md must document ${verb}`);
  }
  // A real usage token, not just a bare mention of the verbs.
  assert.match(
    s,
    /ferrox-tools query model\./,
    'model-tiering.md must contain a "ferrox-tools query model." usage token',
  );
});

test('model-tiering.md documents the decision tokens the cores emit (doc/code consistency)', () => {
  const s = read(MODEL_TIERING_MD);
  // The REAL terminal tokens each core emits:
  //   model.route      -> tier / map
  //   model.escalate   -> escalate / refused
  //   model.risk-grade -> high-risk (+ forcesFrontier / forcesTrident / matched)
  //   trident.audit    -> complete (pass:single, bounded) / refused + four reasons
  //   rtk.wrap         -> wrap / passthrough
  //   rtk.report       -> saved / source:rtk (+ error empty/unparseable)
  const REQUIRED_TOKENS = [
    // route
    '"tier"',
    '"map"',
    // escalate
    '"escalate"',
    '"refused"',
    // risk-grade
    'high-risk',
    'forcesFrontier',
    'forcesTrident',
    // trident: valid + the four refusal reasons
    '"complete"',
    '"single"',
    'checkpoint-set-not-bounded',
    'unbounded-invocation',
    'invalid-checkpoint',
    'caller-family-in-panel',
    'panel_families',
    'consensus',
    'contested',
    // rtk
    '"wrap"',
    '"passthrough"',
    '"source": "rtk"',
  ];
  for (const tok of REQUIRED_TOKENS) {
    assert.ok(
      s.includes(tok),
      `model-tiering.md must document the "${tok}" decision token the core emits`,
    );
  }
});

test('model-tiering.md states the bounded-Trident / anti-loop framing', () => {
  const s = read(MODEL_TIERING_MD);
  assert.match(
    s,
    /bounded/i,
    'model-tiering.md must state Trident is bounded',
  );
  assert.match(
    s,
    /NOT (an open-ended|a merge)/,
    'model-tiering.md must state Trident is NOT an open-ended / merge condition',
  );
  assert.match(
    s,
    /single pass|one pass/i,
    'model-tiering.md must state Trident is a single pass',
  );
});

test('model-tiering.md is honest: tested logic injected, live demo bounded + graceful, verb enforces / orchestrator spawns', () => {
  const s = read(MODEL_TIERING_MD);
  assert.match(
    s,
    /inject/i,
    'model-tiering.md must state the enforceable logic is tested with injected inputs',
  );
  assert.match(
    s,
    /graceful/i,
    'model-tiering.md must state the live codex/gemini/rtk demo degrades gracefully',
  );
  assert.match(
    s,
    /orchestrator/i,
    'model-tiering.md must state the orchestrator spawns the agent at the resolved tier',
  );
  assert.match(
    s,
    /does\s*\**\s*NOT\s*\**\s*spawn|not\s+spawn/i,
    'model-tiering.md must state the verb does NOT spawn agents (it enforces the tier/cap/lineage)',
  );
});

test('gates.md cites trident.audit at BOTH checkpoints and states the bounded / not-a-merge-gate property', () => {
  const g = read(GATES_MD);
  assert.ok(g.includes('trident.audit'), 'gates.md must cite trident.audit');
  assert.ok(
    g.includes('plan-lock-gap-audit'),
    'gates.md must cite the plan-lock-gap-audit checkpoint',
  );
  assert.ok(
    g.includes('high-risk-wave-audit'),
    'gates.md must cite the high-risk-wave-audit checkpoint',
  );
  assert.match(
    g,
    /bounded/i,
    'gates.md must state Trident is bounded at the two checkpoints',
  );
  assert.match(
    g,
    /NOT (an open-ended|a merge)|not a merge gate|never loops/i,
    'gates.md must state Trident is NOT a loop-until-clean merge condition',
  );
});

test('model-profile-resolution.md cites the three model tiering verbs', () => {
  const m = read(MODEL_PROFILE_MD);
  for (const verb of ['model.route', 'model.escalate', 'model.risk-grade']) {
    assert.ok(m.includes(verb), `model-profile-resolution.md must cite ${verb}`);
  }
});

test('execute-phase-wave-guard.md cites model.risk-grade forcing frontier+Trident and rtk.wrap wrapping the Bash/dev op layer', () => {
  const w = read(WAVE_GUARD_MD);
  assert.ok(
    w.includes('model.risk-grade'),
    'wave-guard ref must cite model.risk-grade',
  );
  assert.match(
    w,
    /frontier/i,
    'wave-guard ref must state model.risk-grade forces the frontier tier',
  );
  assert.ok(
    w.includes('trident.audit') || /Trident/.test(w),
    'wave-guard ref must state a high-risk wave runs Trident',
  );
  assert.ok(w.includes('rtk.wrap'), 'wave-guard ref must cite rtk.wrap');
  assert.match(
    w,
    /Bash\/dev op layer|shell\/dev op/i,
    'wave-guard ref must state rtk.wrap wraps the Bash/dev op layer',
  );
});
