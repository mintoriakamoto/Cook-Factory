'use strict';

/**
 * FAST-01/FAST-02 red-green tests for the discipline.depth core (v1.2 Fast Path).
 *
 * The depth decider picks the PROCESS depth per increment — 'fast' (verify +
 * cheap gates only) or 'full' (RED-first TDD, mutation receipt, adversarial
 * audit). It FAILS TOWARD FULL:
 *   - a risk-boundary hit (composed via evaluateRiskGrade) -> full, and a
 *     declaredDepth:'fast' CANNOT override it (anti-spoofing, mirrors T-06-03);
 *   - a high-risk self-grade -> full;
 *   - priorGateFailure -> full (the one-way escalation ratchet, FAST-02);
 *   - NO gradeable inputs at all (no paths, no categories) -> full,
 *     reason 'ungradeable' — you cannot fast-path what you cannot see;
 *   - declaredDepth:'full' is always honored (a plan may opt UP, never down);
 *   - otherwise -> fast.
 *
 * The never-off invariants (halting caps, fail-closed merge-gate, floors) are
 * NOT decided here — they run on BOTH paths unconditionally in the workflow.
 *
 * PURE core: no fs, no clock, no config reads. All inputs explicit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateDisciplineDepth } = require('../ferrox-core/bin/lib/discipline-depth.cjs');

const BOUNDARIES = ['auth', 'crypto', 'payments', 'pii', 'deserialization', 'network-file'];

const base = {
  paths: ['src/ui/button.ts'],
  categories: ['frontend'],
  riskBoundaries: BOUNDARIES,
  selfGrade: 'standard',
};

test('a clean non-boundary increment takes the fast path (FAST-01)', () => {
  const r = evaluateDisciplineDepth({ ...base });
  assert.equal(r.depth, 'fast');
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.matched, []);
});

test('a boundary path forces full — declaredDepth:"fast" cannot override (anti-spoofing)', () => {
  const r = evaluateDisciplineDepth({
    ...base,
    paths: ['src/AUTH/login.ts'],
    declaredDepth: 'fast',
  });
  assert.equal(r.depth, 'full');
  assert.ok(r.reasons.includes('risk-boundary'));
  assert.deepEqual(r.matched, ['auth']);
});

test('a boundary category (not path) forces full, case-insensitively', () => {
  const r = evaluateDisciplineDepth({ ...base, categories: ['PII'] });
  assert.equal(r.depth, 'full');
  assert.deepEqual(r.matched, ['pii']);
});

test('a high-risk self-grade forces full even with benign paths', () => {
  const r = evaluateDisciplineDepth({ ...base, selfGrade: ' High-Risk ' });
  assert.equal(r.depth, 'full');
  assert.ok(r.reasons.includes('high-risk-self-grade'));
});

test('priorGateFailure ratchets to full on otherwise-clean inputs (FAST-02)', () => {
  const r = evaluateDisciplineDepth({ ...base, priorGateFailure: true });
  assert.equal(r.depth, 'full');
  assert.deepEqual(r.reasons, ['gate-failure-ratchet']);
});

test('declaredDepth:"full" is honored on a clean increment (opt UP is always allowed)', () => {
  const r = evaluateDisciplineDepth({ ...base, declaredDepth: 'full' });
  assert.equal(r.depth, 'full');
  assert.deepEqual(r.reasons, ['declared-full']);
});

test('no paths AND no categories -> full, reason "ungradeable" (fail-toward-full)', () => {
  const r = evaluateDisciplineDepth({
    paths: [],
    categories: [],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'standard',
  });
  assert.equal(r.depth, 'full');
  assert.deepEqual(r.reasons, ['ungradeable']);
});

test('garbage inputs (non-arrays, blanks) collapse to ungradeable -> full', () => {
  const r = evaluateDisciplineDepth({
    paths: 42,
    categories: [null, '  '],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'standard',
  });
  assert.equal(r.depth, 'full');
  assert.deepEqual(r.reasons, ['ungradeable']);
});

test('docs-only increment takes the fast path', () => {
  const r = evaluateDisciplineDepth({
    paths: ['README.md', 'docs/guide.md'],
    categories: ['docs'],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'low',
  });
  assert.equal(r.depth, 'fast');
});

test('multiple forcing conditions collect distinct reasons in evaluation order', () => {
  const r = evaluateDisciplineDepth({
    paths: ['src/auth/pay.ts'],
    categories: ['payments'],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'high-risk',
    declaredDepth: 'full',
    priorGateFailure: true,
  });
  assert.equal(r.depth, 'full');
  assert.deepEqual(r.reasons, [
    'risk-boundary',
    'high-risk-self-grade',
    'declared-full',
    'gate-failure-ratchet',
  ]);
  assert.deepEqual([...r.matched].sort(), ['auth', 'payments']);
});

test('the composed riskGrade is exposed for the evidence manifest (FAST-02 audit)', () => {
  const clean = evaluateDisciplineDepth({ ...base });
  assert.equal(clean.riskGrade, 'standard');
  const risky = evaluateDisciplineDepth({ ...base, paths: ['src/crypto/keys.ts'] });
  assert.equal(risky.riskGrade, 'high-risk');
});

test('an unknown declaredDepth value is ignored, not honored (enum fail-closed)', () => {
  const r = evaluateDisciplineDepth({ ...base, declaredDepth: 'turbo' });
  assert.equal(r.depth, 'fast');
  assert.deepEqual(r.reasons, []);
});

// ── FAST-03 audit tier — Sean's cross-audit theory, encoded ──────────────────
// The EXPENSIVE external cross-audit (Trident → real codex+gemini, network wait)
// fires ONLY for genuinely high-risk work. Everything else — the fast path AND
// full increments that are full only because they're un-provable (declared,
// ratcheted, ungradeable) — gets the fast INTERNAL adversarial audit (a
// fresh-context subagent, zero external round-trip). This is where the speed is.

test('fast path -> internal audit (no external round-trip)', () => {
  const r = evaluateDisciplineDepth({ ...base });
  assert.equal(r.depth, 'fast');
  assert.equal(r.auditTier, 'internal');
});

test('full via risk-boundary -> CROSS audit (the external panel is earned)', () => {
  const r = evaluateDisciplineDepth({ ...base, paths: ['src/auth/login.ts'] });
  assert.equal(r.depth, 'full');
  assert.equal(r.auditTier, 'cross');
});

test('full via high-risk self-grade -> CROSS audit', () => {
  const r = evaluateDisciplineDepth({ ...base, selfGrade: 'high-risk' });
  assert.equal(r.depth, 'full');
  assert.equal(r.auditTier, 'cross');
});

test('full via declared-full (NOT high-risk) -> INTERNAL audit, not cross', () => {
  // opting up to full does not mean "spend on external models" — it means
  // "verify hard", which the internal adversarial audit does without the wait.
  const r = evaluateDisciplineDepth({ ...base, declaredDepth: 'full' });
  assert.equal(r.depth, 'full');
  assert.equal(r.auditTier, 'internal');
});

test('full via gate-failure-ratchet (NOT high-risk) -> INTERNAL audit', () => {
  const r = evaluateDisciplineDepth({ ...base, priorGateFailure: true });
  assert.equal(r.depth, 'full');
  assert.equal(r.auditTier, 'internal');
});

test('full via ungradeable (NOT high-risk) -> INTERNAL audit', () => {
  const r = evaluateDisciplineDepth({
    paths: [],
    categories: [],
    riskBoundaries: BOUNDARIES,
    selfGrade: 'standard',
  });
  assert.equal(r.depth, 'full');
  assert.equal(r.auditTier, 'internal');
});

test('high-risk boundary + declared-full still -> CROSS (any high-risk reason wins)', () => {
  const r = evaluateDisciplineDepth({
    ...base,
    paths: ['src/crypto/keys.ts'],
    declaredDepth: 'full',
  });
  assert.equal(r.auditTier, 'cross');
});
