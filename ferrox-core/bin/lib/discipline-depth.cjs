"use strict";
/**
 * FAST-01/FAST-02 discipline.depth core (v1.2 Fast Path).
 *
 * Decides the PROCESS depth for one increment — 'fast' (verify + cheap gates
 * only) or 'full' (RED-first TDD, mutation receipt, adversarial audit). This is
 * the seam that closes BENCHMARK-v1.1 §3: the expensive rituals only fire when
 * the increment's risk earns them; the never-off invariants (halting caps,
 * fail-closed merge-gate, generated-sync + burn-down floors) are NOT decided
 * here — the workflow runs them on BOTH paths unconditionally.
 *
 * FAIL-TOWARD-FULL, in evaluation order (reasons collect distinct, this order):
 *   1. 'risk-boundary'          — a boundary path/category hit, composed via
 *      evaluateRiskGrade (MODEL-03). declaredDepth:'fast' CANNOT override a
 *      boundary (anti-spoofing, mirrors T-06-03): a caller may opt UP to full,
 *      never DOWN past a boundary.
 *   2. 'high-risk-self-grade'   — normalized selfGrade is 'high-risk'/'high'.
 *   3. 'declared-full'          — plan frontmatter opted up. Any OTHER
 *      declaredDepth value (incl. 'fast') is advisory-at-most and an unknown
 *      enum is IGNORED, never honored (the Phase-3 cap_outcome fail-closed
 *      lesson).
 *   4. 'gate-failure-ratchet'   — a gate already failed on this increment's
 *      fast path; the workflow persists that marker and the decider ratchets
 *      one-way to full (FAST-02).
 *   5. 'ungradeable'            — NO gradeable candidates at all (no paths, no
 *      categories after normalization): you cannot fast-path what you cannot
 *      see.
 * Otherwise -> 'fast' with empty reasons.
 *
 * The composed riskGrade is exposed so the workflow writes it into the
 * merge-gate evidence manifest — the grade itself is auditable (FAST-02).
 *
 * PURE: no fs, no clock, no config reads. All inputs explicit.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/discipline-depth.cjs. `export =` CJS shape; no stdout.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const riskGrade = require("./model-risk-grade.cjs");
const { evaluateRiskGrade, norm } = riskGrade;
/**
 * PURE. Decide the process depth for one increment. Fail-toward-full.
 */
function evaluateDisciplineDepth(opts) {
    const paths = Array.isArray(opts ? opts.paths : undefined) ? opts.paths : [];
    const categories = Array.isArray(opts ? opts.categories : undefined)
        ? opts.categories
        : [];
    const graded = evaluateRiskGrade({
        paths,
        categories,
        riskBoundaries: opts ? opts.riskBoundaries : undefined,
        selfGrade: typeof (opts ? opts.selfGrade : undefined) === 'string'
            ? opts.selfGrade
            : '',
    });
    const reasons = [];
    // 1. Boundary hit — un-overridable (anti-spoofing).
    if (graded.matched.length > 0)
        reasons.push('risk-boundary');
    // 2. High-risk self-grade (normalized; 'high' accepted as a synonym).
    const self = norm(opts ? opts.selfGrade : undefined);
    if (self === 'high-risk' || self === 'high')
        reasons.push('high-risk-self-grade');
    // 3. Opt UP is always honored; every other declaredDepth value is ignored.
    if (norm(opts ? opts.declaredDepth : undefined) === 'full')
        reasons.push('declared-full');
    // 4. One-way escalation ratchet (FAST-02).
    if (opts && opts.priorGateFailure === true)
        reasons.push('gate-failure-ratchet');
    // 5. Nothing gradeable at all — fail toward full.
    const candidates = [...paths, ...categories].map(norm).filter((c) => c !== '');
    if (reasons.length === 0 && candidates.length === 0)
        reasons.push('ungradeable');
    // FAST-03: only GENUINE high-risk earns the external cross-audit. A boundary
    // hit (graded.matched) or a high-risk self-grade is high-risk; being full for
    // any OTHER reason (declared/ratchet/ungradeable) is "verify hard", which the
    // internal adversarial audit does without the external round-trip.
    const highRisk = graded.matched.length > 0 || self === 'high-risk' || self === 'high';
    return {
        depth: reasons.length > 0 ? 'full' : 'fast',
        reasons,
        matched: graded.matched,
        riskGrade: graded.grade,
        auditTier: highRisk ? 'cross' : 'internal',
    };
}
module.exports = { evaluateDisciplineDepth };
