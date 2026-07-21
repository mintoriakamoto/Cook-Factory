'use strict';

/**
 * ROUTE-FLUX-01 (v1.1 Phase B) — FluxRouter tier routing through the
 * provider-agnostic resolver.
 *
 * The `dynamic_routing.tier_models.{light,standard,heavy}` seam
 * (config-schema.manifest.json:171-173) binds abstract agent tiers to
 * spawnable model-ids. FluxRouter's lanes are opaque alias strings the HOST
 * runtime maps to its OpenAI-compatible endpoint — so the core resolver stays
 * provider-agnostic: it returns whatever alias the operator mapped, and never
 * needs to know "flux" exists.
 *
 * This locks the v1.1 contract:
 *   heavy   agents -> flux-reasoning   (ferrox-planner)
 *   standard agents -> flux-standard   (ferrox-executor)
 *   light   agents -> flux-fast        (ferrox-codebase-mapper)
 * plus the MODEL-02 one-hop escalation climbing exactly one tier
 * (light attempt-1 -> flux-standard, not straight to flux-reasoning).
 *
 * Non-flux sentinel aliases are used in the escalation case so a hard-coded
 * "flux" special-case could never masquerade as real tier resolution.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const resolver = require('../ferrox-core/bin/lib/model-resolver.cjs');

function makeProject(dynamicRouting) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-flux-route-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const cfg = dynamicRouting === undefined ? {} : { dynamic_routing: dynamicRouting };
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(cfg));
  return dir;
}

const FLUX_TIER_MODELS = {
  heavy: 'flux-reasoning',
  standard: 'flux-standard',
  light: 'flux-fast',
};

test('ROUTE-FLUX-01: heavy/standard/light agents resolve to their flux lanes', () => {
  const dir = makeProject({ enabled: true, tier_models: FLUX_TIER_MODELS });
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-planner', 0), 'flux-reasoning');
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-executor', 0), 'flux-standard');
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-codebase-mapper', 0), 'flux-fast');
});

test('ROUTE-FLUX-01: one-hop escalation climbs exactly one tier (light -> standard)', () => {
  // Sentinel aliases (NOT flux-*) prove tier arithmetic, not a flux special-case.
  const dir = makeProject({
    enabled: true,
    tier_models: { heavy: 'lane-H', standard: 'lane-S', light: 'lane-L' },
  });
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-codebase-mapper', 0), 'lane-L');
  // one hop up from light is standard — not heavy
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-codebase-mapper', 1), 'lane-S');
});

test('ROUTE-FLUX-01: flux-auto adaptive default routes every tier to the auto lane', () => {
  const dir = makeProject({
    enabled: true,
    tier_models: { heavy: 'flux-auto', standard: 'flux-auto', light: 'flux-auto' },
  });
  // exercise a heavy, a standard, AND a light agent so this can detect misrouting
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-planner', 0), 'flux-auto');
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-executor', 0), 'flux-auto');
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-codebase-mapper', 0), 'flux-auto');
});

test('ROUTE-FLUX-01: disabled dynamic_routing falls back to the EXACT Claude tier default', () => {
  const dir = makeProject({ enabled: false, tier_models: FLUX_TIER_MODELS });
  // Assert the exact fallback (not merely "not flux") so a leak of any other
  // flux lane is caught, per Phase-B cross-audit MEDIUM.
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-planner', 0), 'opus');
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-executor', 0), 'sonnet');
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-codebase-mapper', 0), 'haiku');
});

test('ROUTE-FLUX-01: a mistyped tier key silently falls back (documented footgun, FF-B21)', () => {
  // "havy" is unvalidated -> heavy agent misroutes to its Claude default, no throw.
  // This LOCKS the current (documented) behavior so a future guard is a deliberate change.
  const dir = makeProject({
    enabled: true,
    tier_models: { havy: 'flux-reasoning', standard: 'flux-standard', light: 'flux-fast' },
  });
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-planner', 0), 'opus');
  // the correctly-spelled tiers still route to flux
  assert.equal(resolver.resolveModelForTier(dir, 'ferrox-executor', 0), 'flux-standard');
});
