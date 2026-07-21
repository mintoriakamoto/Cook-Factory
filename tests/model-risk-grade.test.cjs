'use strict';

/**
 * MODEL-03 red-green tests for the model.risk-grade core.
 *
 * A risk-boundary path/category forces high-risk (frontier + Trident) REGARDLESS
 * of a self-declared grade — a caller cannot self-downgrade past a boundary:
 *   - any path OR category touching a boundary -> high-risk + forcesFrontier +
 *     forcesTrident, overriding a benign selfGrade;
 *   - a benign path with no boundary hit -> the selfGrade, no forcing;
 *   - matching is case-insensitive across both paths and categories (Phase-4 trap);
 *   - multiple hits collect the distinct matched boundary tokens.
 *
 * PURE core: no fs, no clock, no config reads. riskBoundaries/selfGrade are EXPLICIT
 * inputs (the Plan 05 router forwards model.risk_boundaries).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateRiskGrade } = require('../ferrox-core/bin/lib/model-risk-grade.cjs');

const BOUNDARIES = ['auth', 'crypto', 'payments', 'pii', 'deserialization', 'network-file'];

test('an auth path forces high-risk over a low self-grade (MODEL-03)', () => {
  const r = evaluateRiskGrade({
    paths: ['src/AUTH/login.ts'],
    categories: [],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'low',
  });
  assert.equal(r.grade, 'high-risk');
  assert.equal(r.forcesFrontier, true);
  assert.equal(r.forcesTrident, true);
  assert.deepEqual(r.matched, ['auth']);
});

test('a benign path keeps the self-grade and forces nothing', () => {
  const r = evaluateRiskGrade({
    paths: ['src/ui/button.ts'],
    categories: ['frontend'],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'low',
  });
  assert.deepEqual(r, { grade: 'low', forcesFrontier: false, forcesTrident: false, matched: [] });
});

test('matching is case-insensitive on paths ("src/Crypto/Keys.ts" -> high-risk)', () => {
  const r = evaluateRiskGrade({
    paths: ['src/Crypto/Keys.ts'],
    categories: [],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'medium',
  });
  assert.equal(r.grade, 'high-risk');
  assert.deepEqual(r.matched, ['crypto']);
});

test('a category-list hit (not a path hit) also forces high-risk, case-insensitively', () => {
  const r = evaluateRiskGrade({
    paths: ['src/ui/panel.ts'],
    categories: ['PII'],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'low',
  });
  assert.equal(r.grade, 'high-risk');
  assert.deepEqual(r.matched, ['pii']);
});

test('multiple boundary hits collect distinct matched tokens', () => {
  const r = evaluateRiskGrade({
    paths: ['src/auth/payments-handler.ts'],
    categories: ['crypto'],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'low',
  });
  assert.equal(r.grade, 'high-risk');
  // auth + payments from the path, crypto from the category — distinct, no dupes.
  assert.deepEqual([...r.matched].sort(), ['auth', 'crypto', 'payments']);
});

test('a blank boundary entry never matches a blank candidate', () => {
  const r = evaluateRiskGrade({
    paths: [''],
    categories: [''],
    riskBoundaries: ['', '  '],
    selfGrade: 'low',
  });
  assert.deepEqual(r, { grade: 'low', forcesFrontier: false, forcesTrident: false, matched: [] });
});

test('a network-file boundary matches a hyphenated token', () => {
  const r = evaluateRiskGrade({
    paths: ['src/net/network-file-loader.ts'],
    categories: [],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'low',
  });
  assert.equal(r.grade, 'high-risk');
  assert.deepEqual(r.matched, ['network-file']);
});
