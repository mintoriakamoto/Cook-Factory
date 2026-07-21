'use strict';

/**
 * MODEL-02 red-green tests for the model.escalate core (the one-hop cap).
 *
 * A failed task escalates exactly ONE tier up the ladder and no further:
 *   - attempt <= maxEscalations AND a higher tier exists -> escalate one hop;
 *   - a second escalation (attempt > maxEscalations) -> refused (capped);
 *   - already at the top tier -> refused (can't go higher);
 *   - an unknown 'from' tier fails closed to refused (never silently promote).
 *
 * PURE core: no fs, no clock, no config reads. tierOrder/maxEscalations are
 * EXPLICIT inputs (the Plan 05 router forwards model.tier_order + model.max_escalations).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateEscalate } = require('../ferrox-core/bin/lib/model-escalate.cjs');

const LADDER = ['small', 'mid', 'frontier'];

test('small escalates one hop to mid on attempt 1 (MODEL-02)', () => {
  const r = evaluateEscalate({ from: 'small', attempt: 1, tierOrder: LADDER, maxEscalations: 1 });
  assert.deepEqual(r, { decision: 'escalate', tier: 'mid' });
});

test('mid escalates one hop to frontier on attempt 1', () => {
  const r = evaluateEscalate({ from: 'mid', attempt: 1, tierOrder: LADDER, maxEscalations: 1 });
  assert.deepEqual(r, { decision: 'escalate', tier: 'frontier' });
});

test('a SECOND escalation (attempt > maxEscalations) is refused, capped at the current tier', () => {
  const r = evaluateEscalate({ from: 'mid', attempt: 2, tierOrder: LADDER, maxEscalations: 1 });
  assert.equal(r.decision, 'refused');
  assert.equal(r.tier, 'mid', 'stays at the tier it escalated to; no further hop');
});

test('already at the top tier -> refused (can not go higher)', () => {
  const r = evaluateEscalate({ from: 'frontier', attempt: 1, tierOrder: LADDER, maxEscalations: 1 });
  assert.equal(r.decision, 'refused');
  assert.equal(r.tier, 'frontier');
});

test('an unknown from tier fails closed to refused (never silently promote)', () => {
  const r = evaluateEscalate({ from: 'nonesuch', attempt: 1, tierOrder: LADDER, maxEscalations: 1 });
  assert.equal(r.decision, 'refused');
});

test('escalation is case-insensitive on the from tier ("MID" -> frontier)', () => {
  const r = evaluateEscalate({ from: ' MID ', attempt: 1, tierOrder: LADDER, maxEscalations: 1 });
  assert.deepEqual(r, { decision: 'escalate', tier: 'frontier' });
});

test('a higher maxEscalations does not matter once at the top tier', () => {
  const r = evaluateEscalate({ from: 'frontier', attempt: 1, tierOrder: LADDER, maxEscalations: 5 });
  assert.equal(r.decision, 'refused');
  assert.equal(r.tier, 'frontier');
});
