'use strict';

/**
 * RED→GREEN regression for MODEL-01..05: the `model.*` config block must be
 * PROPAGATED through config-loader — not schema-registered-but-dropped.
 *
 * This mirrors tests/strength-config-resolution.test.cjs and guards against the
 * exact Phase-3 trap: a new top-level block accepted by the schema yet never
 * copied into the resolved `_baseConfig`, so every operator override is silently
 * inert and the Phase-6 verbs (model.route MODEL-01, model.escalate MODEL-02,
 * model.risk-grade MODEL-03, trident.audit MODEL-04, rtk.* MODEL-05) run on
 * hard-coded fallbacks.
 *
 * Every assertion in case (a) uses NON-DEFAULT values so a manifest fallback can
 * never masquerade as a resolved value. These FAIL before the loader edits
 * (cfg.model === undefined) and pass after them. Case (c) additionally pins the
 * MODEL-04 exactly-two-checkpoint bound and the MODEL-02 one-hop cap defaults.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../ferrox-core/bin/lib/config-loader.cjs');

// Deliberately NON-DEFAULT everywhere so a fallback can never masquerade as a
// resolved value. Scalars are sentinels the manifest never ships; every array is
// a single-element sentinel token the defaults never contain; the stage_tiers map
// carries a sentinel stage the manifest never maps.
const NON_DEFAULT_MODEL = {
  stage_tiers: { 'only-sentinel-stage': 'only-sentinel-tier' },
  default_tier: 'only-sentinel-tier',
  tier_order: ['only-sentinel-tier'],
  max_escalations: 99,
  risk_boundaries: ['only-sentinel-boundary'],
  trident_checkpoints: ['only-sentinel-checkpoint'],
  rtk: { enabled: false },
};

function makeProject(model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-model-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const cfg = model === undefined ? {} : { model };
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(cfg, null, 2) + '\n',
  );
  return dir;
}

test('loadConfig propagates the whole model block (MODEL-01..05)', () => {
  const cwd = makeProject(NON_DEFAULT_MODEL);
  const cfg = loadConfig(cwd);
  assert.ok(
    cfg.model && typeof cfg.model === 'object',
    'model block must be resolved, not dropped',
  );
  // Scalars are kept verbatim — the operator's exact override survives.
  assert.equal(cfg.model.default_tier, 'only-sentinel-tier');
  assert.equal(cfg.model.max_escalations, 99);
  // Nested object (stage_tiers) survives with the sentinel stage.
  assert.equal(cfg.model.stage_tiers['only-sentinel-stage'], 'only-sentinel-tier');
  // rtk nested flag survives.
  assert.equal(cfg.model.rtk.enabled, false);
  // Arrays are replaced (not merged) — the operator's exact list survives.
  assert.deepEqual(cfg.model.tier_order, ['only-sentinel-tier']);
  assert.deepEqual(cfg.model.risk_boundaries, ['only-sentinel-boundary']);
  assert.deepEqual(cfg.model.trident_checkpoints, ['only-sentinel-checkpoint']);
});

test('a partial model block keeps manifest defaults for untouched keys', () => {
  // Operator only overrides rtk.enabled; max_escalations and trident_checkpoints
  // must fall back to the manifest defaults, not vanish.
  const cwd = makeProject({ rtk: { enabled: false } });
  const cfg = loadConfig(cwd);
  assert.ok(cfg.model && typeof cfg.model === 'object');
  assert.equal(cfg.model.rtk.enabled, false, 'configured value wins');
  assert.equal(
    cfg.model.max_escalations,
    1,
    'untouched max_escalations keeps its manifest one-hop-cap default',
  );
  assert.ok(
    Array.isArray(cfg.model.trident_checkpoints) &&
      cfg.model.trident_checkpoints.length === 2,
    'untouched trident_checkpoints keeps its exactly-two manifest default',
  );
  assert.deepEqual(
    cfg.model.tier_order,
    ['small', 'mid', 'frontier'],
    'untouched tier_order keeps its manifest escalation ladder',
  );
});

test('no model block resolves the manifest default model (MODEL-02/04 bounds)', () => {
  const cwd = makeProject(undefined);
  const cfg = loadConfig(cwd);
  assert.ok(cfg.model && typeof cfg.model === 'object');
  assert.equal(
    cfg.model.max_escalations,
    1,
    'default max_escalations is the MODEL-02 one-hop cap',
  );
  assert.equal(
    cfg.model.trident_checkpoints.length,
    2,
    'default trident_checkpoints has EXACTLY two entries (MODEL-04 bound)',
  );
  assert.equal(cfg.model.default_tier, 'mid', 'default_tier is the mid workhorse');
  assert.ok(
    Array.isArray(cfg.model.risk_boundaries) &&
      cfg.model.risk_boundaries.includes('auth') &&
      cfg.model.risk_boundaries.includes('payments'),
    'default risk_boundaries carries the manifest boundary list',
  );
});
