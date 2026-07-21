'use strict';

/**
 * MODEL-01 red-green tests for the model.route core.
 *
 * route maps a Build-Line stage to a cost tier from an EXPLICIT stage->tier map:
 *   - a mapped stage returns its tier (frontier/mid/small);
 *   - an unmapped stage returns the default tier (and 'mid' when even that is absent);
 *   - lookup is case-insensitive/trimmed (Phase-4 trap: never assume normalized);
 *   - a dump request returns the whole normalized map so the assignment is inspectable.
 *
 * PURE core: no fs, no clock, no config reads. stageTiers/defaultTier are EXPLICIT
 * inputs (the Plan 05 router forwards the resolved model.* config).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateRoute } = require('../ferrox-core/bin/lib/model-route.cjs');

const STAGE_TIERS = { verify: 'frontier', build: 'mid', grunt: 'small' };

test('a verify stage routes to frontier (MODEL-01)', () => {
  const r = evaluateRoute({ stage: 'verify', stageTiers: STAGE_TIERS, defaultTier: 'mid' });
  assert.deepEqual(r, { tier: 'frontier' });
});

test('a build stage routes to mid, a grunt stage to small', () => {
  assert.equal(evaluateRoute({ stage: 'build', stageTiers: STAGE_TIERS, defaultTier: 'mid' }).tier, 'mid');
  assert.equal(evaluateRoute({ stage: 'grunt', stageTiers: STAGE_TIERS, defaultTier: 'mid' }).tier, 'small');
});

test('an unmapped stage falls back to the default tier', () => {
  const r = evaluateRoute({ stage: 'nonesuch', stageTiers: STAGE_TIERS, defaultTier: 'mid' });
  assert.equal(r.tier, 'mid');
});

test('an unmapped stage with no defaultTier fails to the mid workhorse (never undefined)', () => {
  const r = evaluateRoute({ stage: 'nonesuch', stageTiers: STAGE_TIERS });
  assert.equal(r.tier, 'mid');
});

test('stage lookup is case-insensitive and trimmed ("  Verify " === "verify")', () => {
  const r = evaluateRoute({ stage: '  Verify ', stageTiers: STAGE_TIERS, defaultTier: 'mid' });
  assert.equal(r.tier, 'frontier');
});

test('mixed-case map keys still resolve (normalized at match time)', () => {
  const r = evaluateRoute({ stage: 'grunt', stageTiers: { GRUNT: 'small' }, defaultTier: 'mid' });
  assert.equal(r.tier, 'small');
});

test('a dump request (dump:true) returns the whole normalized stage->tier map', () => {
  const r = evaluateRoute({ dump: true, stageTiers: { Verify: 'frontier', BUILD: 'mid' }, defaultTier: 'mid' });
  assert.ok(r.map && typeof r.map === 'object');
  assert.equal(r.map.verify, 'frontier');
  assert.equal(r.map.build, 'mid');
  assert.equal(r.tier, undefined, 'a dump returns a map, not a tier');
});

test('no stage (and no dump flag) also returns the inspectable map', () => {
  const r = evaluateRoute({ stageTiers: STAGE_TIERS, defaultTier: 'mid' });
  assert.ok(r.map && typeof r.map === 'object');
  assert.equal(r.map.verify, 'frontier');
});
