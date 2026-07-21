'use strict';

/**
 * XAUD-01 red-green tests — the cross-audit CADENCE decider (v1.6, Sean's policy).
 *
 * Policy: "never trust one AI" -> a cross-audit is NON-NEGOTIABLE, but the EXPENSIVE 3-eye
 * cross-audit is paid at MILESTONE cadence, not per-phase. The cheap machine gate still runs
 * every phase; only this decides when the expensive multi-model audit fires.
 *
 *   evaluateCrossAuditCadence({ event, crossesRiskBoundary, atIntegrationBoundary,
 *                              phasesSinceLastAudit, maxPhasesWithoutAudit }) -> { crossAudit, reason }
 *
 * Rules:
 *  - milestone-complete            -> ALWAYS audit (batched over the milestone's phases)
 *  - standalone-complete (1-2 ph)  -> ALWAYS audit (small work still gets ONE; "too small" doesn't exist)
 *  - phase-complete (mid-milestone):
 *      * crossesRiskBoundary       -> audit (security/risk trigger — don't let it ride)
 *      * atIntegrationBoundary     -> audit (natural wave/integration point)
 *      * phasesSinceLastAudit >= max -> audit (bound how far a bad phase propagates; default 5)
 *      * else                      -> DEFER to milestone (the batching win)
 *  - unknown/garbage event         -> fail-toward-audit (never trust one AI)
 *
 * PURE: no fs/env/clock. Never throws.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCrossAuditCadence } = require('../ferrox-core/bin/lib/cross-audit-cadence.cjs');

test('milestone-complete always cross-audits (XAUD-01)', () => {
  const r = evaluateCrossAuditCadence({ event: 'milestone-complete' });
  assert.equal(r.crossAudit, true);
  assert.match(r.reason, /milestone/);
});

test('standalone-complete always cross-audits (small work still gets one)', () => {
  const r = evaluateCrossAuditCadence({ event: 'standalone-complete' });
  assert.equal(r.crossAudit, true);
  assert.match(r.reason, /standalone/);
});

test('plain mid-milestone phase-complete DEFERS (the batching win)', () => {
  const r = evaluateCrossAuditCadence({
    event: 'phase-complete', crossesRiskBoundary: false, atIntegrationBoundary: false,
    phasesSinceLastAudit: 2, maxPhasesWithoutAudit: 5,
  });
  assert.equal(r.crossAudit, false);
  assert.match(r.reason, /defer/);
});

test('a mid-milestone phase that crosses a risk boundary audits immediately (security trigger)', () => {
  const r = evaluateCrossAuditCadence({
    event: 'phase-complete', crossesRiskBoundary: true, phasesSinceLastAudit: 1, maxPhasesWithoutAudit: 5,
  });
  assert.equal(r.crossAudit, true);
  assert.match(r.reason, /risk-boundary/);
});

test('a mid-milestone integration boundary audits', () => {
  const r = evaluateCrossAuditCadence({
    event: 'phase-complete', atIntegrationBoundary: true, phasesSinceLastAudit: 1, maxPhasesWithoutAudit: 5,
  });
  assert.equal(r.crossAudit, true);
  assert.match(r.reason, /integration/);
});

test('hitting maxPhasesWithoutAudit forces an audit (bound propagation)', () => {
  const r = evaluateCrossAuditCadence({
    event: 'phase-complete', phasesSinceLastAudit: 5, maxPhasesWithoutAudit: 5,
  });
  assert.equal(r.crossAudit, true);
  assert.match(r.reason, /max-phases/);
});

test('one below the max still defers', () => {
  const r = evaluateCrossAuditCadence({
    event: 'phase-complete', phasesSinceLastAudit: 4, maxPhasesWithoutAudit: 5,
  });
  assert.equal(r.crossAudit, false);
});

test('maxPhasesWithoutAudit defaults to 5 when unset', () => {
  assert.equal(evaluateCrossAuditCadence({ event: 'phase-complete', phasesSinceLastAudit: 4 }).crossAudit, false);
  assert.equal(evaluateCrossAuditCadence({ event: 'phase-complete', phasesSinceLastAudit: 5 }).crossAudit, true);
});

test('risk boundary must be EXACTLY true (fail-toward-defer only on recognized no-trigger)', () => {
  const r = evaluateCrossAuditCadence({ event: 'phase-complete', crossesRiskBoundary: 1, phasesSinceLastAudit: 1 });
  assert.equal(r.crossAudit, false); // truthy-not-true does not trip the trigger
});

test('unknown/garbage event fails toward audit (never trust one AI), never throws', () => {
  assert.doesNotThrow(() => evaluateCrossAuditCadence(undefined));
  assert.equal(evaluateCrossAuditCadence(undefined).crossAudit, true);
  assert.equal(evaluateCrossAuditCadence({}).crossAudit, true);
  assert.equal(evaluateCrossAuditCadence({ event: 'nonsense' }).crossAudit, true);
});
