'use strict';

/**
 * FLUX-02 / FF-B26 red-green tests — the model-backend resolver (v1.3 Flux Backbone).
 *
 * Pure decider: given the provider config, a tier, the tier_models ladder, and what's
 * AVAILABLE (flux key present? which host CLIs?), return { transport, tier, modelId, reason }.
 *
 * The degradation ladder (never breaks — always resolves SOMETHING):
 *   1. provider 'flux' AND fluxKeyPresent  -> transport 'flux', modelId = ladder[tier]
 *   2. else host CLIs present               -> transport 'cli',  modelId = ladder[tier] (or null)
 *   3. else                                 -> transport 'host', modelId = null (host-native)
 *
 * FF-B26: tier -> modelId is a plain lookup in the tier_models ladder (arbitrary rung names,
 * so a 5-rung ladder works). An unknown tier degrades modelId to null, never throws.
 *
 * PURE: no fs, no env reads, no clock, no network. Availability is passed in EXPLICITLY
 * (the router probes env/PATH and forwards booleans) so the decision is deterministic + testable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveModelBackend } = require('../ferrox-core/bin/lib/model-backend.cjs');

const LADDER = {
  frontier: 'flux-reasoning',
  'near-frontier': 'flux-pinned-glm-5-2',
  mid: 'flux-standard',
  small: 'flux-fast',
  grunt: 'flux-pinned-cheapest',
};

test('flux configured + key present -> transport flux, tier model from the ladder (FLUX-02)', () => {
  const r = resolveModelBackend({
    provider: 'flux', tierModels: LADDER, tier: 'near-frontier',
    fluxKeyPresent: true, cliAvailable: true,
  });
  assert.equal(r.transport, 'flux');
  assert.equal(r.modelId, 'flux-pinned-glm-5-2');
  assert.equal(r.tier, 'near-frontier');
});

test('flux configured but NO key -> degrades to CLI (not flux)', () => {
  const r = resolveModelBackend({
    provider: 'flux', tierModels: LADDER, tier: 'mid',
    fluxKeyPresent: false, cliAvailable: true,
  });
  assert.equal(r.transport, 'cli');
  assert.equal(r.modelId, 'flux-standard');
  assert.ok(r.reason.includes('no-flux-key'));
});

test('no flux, CLIs present -> transport cli', () => {
  const r = resolveModelBackend({
    provider: 'generic', tierModels: LADDER, tier: 'frontier',
    fluxKeyPresent: false, cliAvailable: true,
  });
  assert.equal(r.transport, 'cli');
  assert.equal(r.modelId, 'flux-reasoning');
});

test('neither flux nor CLIs -> transport host, modelId null (degraded, never broken)', () => {
  const r = resolveModelBackend({
    provider: 'flux', tierModels: LADDER, tier: 'mid',
    fluxKeyPresent: false, cliAvailable: false,
  });
  assert.equal(r.transport, 'host');
  assert.equal(r.modelId, null);
  assert.ok(r.reason.includes('host-native'));
});

test('FF-B26: an unknown tier degrades modelId to null, never throws', () => {
  const r = resolveModelBackend({
    provider: 'flux', tierModels: LADDER, tier: 'turbo',
    fluxKeyPresent: true, cliAvailable: true,
  });
  assert.equal(r.transport, 'flux');
  assert.equal(r.modelId, null);
  assert.ok(r.reason.includes('unknown-tier'));
});

test('a 5-rung ladder resolves every rung (FLUX-03 shape)', () => {
  for (const [tier, expected] of Object.entries(LADDER)) {
    const r = resolveModelBackend({
      provider: 'flux', tierModels: LADDER, tier,
      fluxKeyPresent: true, cliAvailable: true,
    });
    assert.equal(r.modelId, expected, `rung ${tier}`);
  }
});

test('missing/garbage tierModels degrades to null model, still resolves transport', () => {
  const r = resolveModelBackend({
    provider: 'flux', tierModels: null, tier: 'mid',
    fluxKeyPresent: true, cliAvailable: true,
  });
  assert.equal(r.transport, 'flux');
  assert.equal(r.modelId, null);
});

test('non-string tier is handled (no throw) -> host-native fallback path still safe', () => {
  const r = resolveModelBackend({
    provider: 'flux', tierModels: LADDER, tier: 42,
    fluxKeyPresent: true, cliAvailable: true,
  });
  assert.equal(r.modelId, null);
  assert.equal(r.transport, 'flux');
});

test('the resolver NEVER throws on a fully-empty/garbage input (fail-safe)', () => {
  assert.doesNotThrow(() => resolveModelBackend({}));
  const r = resolveModelBackend({});
  // no provider, no key, no cli -> host-native
  assert.equal(r.transport, 'host');
  assert.equal(r.modelId, null);
});

test('flux transport requires the EXACT provider "flux" — a typo degrades to cli/host', () => {
  const r = resolveModelBackend({
    provider: 'fluxx', tierModels: LADDER, tier: 'mid',
    fluxKeyPresent: true, cliAvailable: true,
  });
  assert.notEqual(r.transport, 'flux');
});
