'use strict';

/**
 * STRONG-04 red-green tests for the strength.severity-route core.
 *
 * Two guarantees a security finding can never rely on hope for:
 *   1. A finding whose category is in the security set routes to `block` at ANY
 *      severity (low/medium/high/critical) and is NEVER auto-backlogged.
 *   2. A cluster of >= threshold related MEDIUMs on ONE surface re-scores to a
 *      synthesized HIGH — many mediums on one seam are a high, not noise.
 * Category, surface, and severity matching is CASE-INSENSITIVE (Phase-4 trap:
 * inputs are never assumed pre-normalized). securityCategories + clusterThreshold
 * are EXPLICIT inputs (the Plan 07 router forwards the resolved strength.* config).
 *
 * PURE core: no fs, no clock, no config reads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateSeverityRoute } = require('../ferrox-core/bin/lib/strength-severity-route.cjs');

const SECURITY = ['security', 'auth', 'crypto', 'injection', 'secrets', 'deserialization'];

// --- security never auto-backlogs, at any severity (STRONG-04) ---------------

for (const severity of ['low', 'medium', 'high', 'critical']) {
  test(`a security-category finding blocks at severity=${severity}`, () => {
    const r = evaluateSeverityRoute({
      findings: [{ category: 'security', surface: 'src/api.ts', severity }],
      securityCategories: SECURITY,
      clusterThreshold: 3,
    });
    assert.equal(r.decision, 'block');
    assert.equal(r.reason, 'security-never-backlog');
  });
}

test('security category match is case-insensitive ("Security" vs "security")', () => {
  const r = evaluateSeverityRoute({
    findings: [{ category: 'Security', surface: 'src/api.ts', severity: 'LOW' }],
    securityCategories: SECURITY,
    clusterThreshold: 3,
  });
  assert.equal(r.decision, 'block');
  assert.equal(r.reason, 'security-never-backlog');
});

test('security precedence: a security finding blocks even amid a MEDIUM cluster', () => {
  const r = evaluateSeverityRoute({
    findings: [
      { category: 'style', surface: 'src/auth.ts', severity: 'medium' },
      { category: 'style', surface: 'src/auth.ts', severity: 'medium' },
      { category: 'style', surface: 'src/auth.ts', severity: 'medium' },
      { category: 'injection', surface: 'src/db.ts', severity: 'low' },
    ],
    securityCategories: SECURITY,
    clusterThreshold: 3,
  });
  assert.equal(r.decision, 'block', 'security wins over cluster synthesis');
  assert.equal(r.reason, 'security-never-backlog');
});

// --- MEDIUM cluster on one surface synthesizes a HIGH (STRONG-04) -------------

test('>= threshold MEDIUMs on one surface synthesizes a HIGH', () => {
  const r = evaluateSeverityRoute({
    findings: [
      { category: 'style', surface: 'src/checkout.ts', severity: 'medium' },
      { category: 'perf', surface: 'src/checkout.ts', severity: 'medium' },
      { category: 'logic', surface: 'src/checkout.ts', severity: 'medium' },
    ],
    securityCategories: SECURITY,
    clusterThreshold: 3,
  });
  assert.equal(r.decision, 'synthesize-high');
  assert.equal(r.synthesized, 'HIGH');
  assert.equal(r.surface, 'src/checkout.ts');
  assert.equal(r.medium_count, 3);
});

test('surface grouping is case-insensitive ("src/Auth.ts" vs "src/auth.ts")', () => {
  const r = evaluateSeverityRoute({
    findings: [
      { category: 'style', surface: 'src/Auth.ts', severity: 'Medium' },
      { category: 'perf', surface: 'src/auth.ts', severity: 'MEDIUM' },
      { category: 'logic', surface: 'SRC/AUTH.TS', severity: 'medium' },
    ],
    securityCategories: SECURITY,
    clusterThreshold: 3,
  });
  assert.equal(r.decision, 'synthesize-high');
  assert.equal(r.synthesized, 'HIGH');
  assert.equal(r.medium_count, 3, 'case-variant surfaces group as one');
});

test('MEDIUMs split across different surfaces do NOT synthesize (each below threshold)', () => {
  const r = evaluateSeverityRoute({
    findings: [
      { category: 'style', surface: 'src/a.ts', severity: 'medium' },
      { category: 'style', surface: 'src/b.ts', severity: 'medium' },
      { category: 'style', surface: 'src/c.ts', severity: 'medium' },
    ],
    securityCategories: SECURITY,
    clusterThreshold: 3,
  });
  assert.equal(r.decision, 'route-backlog');
});

test('a below-threshold cluster routes to backlog (normal routing)', () => {
  const r = evaluateSeverityRoute({
    findings: [
      { category: 'style', surface: 'src/x.ts', severity: 'medium' },
      { category: 'style', surface: 'src/x.ts', severity: 'medium' },
    ],
    securityCategories: SECURITY,
    clusterThreshold: 3,
  });
  assert.equal(r.decision, 'route-backlog');
});

test('an empty securityCategories input blocks nothing spuriously', () => {
  const r = evaluateSeverityRoute({
    findings: [{ category: 'security', surface: 'src/api.ts', severity: 'high' }],
    securityCategories: [],
    clusterThreshold: 3,
  });
  assert.notEqual(r.decision, 'block', 'no security set → no security block');
});

test('non-medium findings do not count toward a cluster', () => {
  const r = evaluateSeverityRoute({
    findings: [
      { category: 'style', surface: 'src/x.ts', severity: 'medium' },
      { category: 'style', surface: 'src/x.ts', severity: 'low' },
      { category: 'style', surface: 'src/x.ts', severity: 'high' },
    ],
    securityCategories: SECURITY,
    clusterThreshold: 3,
  });
  // Only 1 medium on the surface — below threshold; a lone high is not a security
  // category, so it routes to backlog (severity-route does not block on plain high).
  assert.equal(r.decision, 'route-backlog');
});

test('empty findings → route-backlog (nothing to escalate)', () => {
  const r = evaluateSeverityRoute({
    findings: [],
    securityCategories: SECURITY,
    clusterThreshold: 3,
  });
  assert.equal(r.decision, 'route-backlog');
});
