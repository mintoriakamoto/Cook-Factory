"use strict";
/**
 * INTG-03 aggregate-head failure classifier (v1.6 — from the WLD Desktop field report, property #3).
 *
 * Cross-cutting regressions appear ONLY when the full suite runs at the exact merged head — a
 * per-packet verify can't see them. But a raw red suite at the head is also full of env/flake noise
 * (a symlinked node_modules producing 347 "duplicate React" failures; parallel-load timeouts). This
 * pure core classifies every failure so the REAL regressions block and the noise is quarantined — and,
 * critically, never the reverse.
 *
 * Verdict per failure (first match wins, in this order):
 *   1. pre-existing  — already failing at the baseline SHA (not a NEW regression; doesn't block)
 *   2. env-artifact  — matches a DECLARED env signature (quarantine, doesn't block)
 *   3. known-flake   — matches a DECLARED flake signature (quarantine, doesn't block)
 *   4. regression    — a new failure matching nothing above → REAL, blocks the wave
 *
 * FAIL-TOWARD-REGRESSION: only an EXPLICIT declared pattern quarantines a new failure. Env-looking text
 * with no declared pattern is a regression. Noise never silently passes as env. PURE, never throws.
 *
 * ADR-457: compiles to ferrox-core/bin/lib/integration-failure-classify.cjs. `export =` shape.
 */
/** Coerce to a string[] of non-empty strings; anything else → []. */
function strList(v) {
    if (!Array.isArray(v))
        return [];
    return v.filter((x) => typeof x === 'string' && x !== '');
}
/** Does `s` contain any of the declared patterns (plain substring, case-sensitive)? */
function matchesAny(s, patterns) {
    for (const p of patterns) {
        if (p !== '' && s.includes(p))
            return p;
    }
    return null;
}
/**
 * PURE. Classify failures observed at the exact merged head. Order of precedence is deliberate:
 * pre-existing (baseline) first, then declared env, then declared flake, else regression.
 */
function classifyFailures(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const failures = strList(o.failures);
    const baseline = new Set(strList(o.baseline));
    const envPatterns = strList(o.envPatterns);
    const flakePatterns = strList(o.flakePatterns);
    const classified = [];
    const summary = { regression: 0, env: 0, flake: 0, preExisting: 0 };
    for (const name of failures) {
        if (baseline.has(name)) {
            classified.push({ name, verdict: 'pre-existing', reason: 'red-at-baseline' });
            summary.preExisting++;
            continue;
        }
        const env = matchesAny(name, envPatterns);
        if (env !== null) {
            classified.push({ name, verdict: 'env-artifact', reason: `env:${env}` });
            summary.env++;
            continue;
        }
        const flake = matchesAny(name, flakePatterns);
        if (flake !== null) {
            classified.push({ name, verdict: 'known-flake', reason: `flake:${flake}` });
            summary.flake++;
            continue;
        }
        classified.push({ name, verdict: 'regression', reason: 'new-unclassified' });
        summary.regression++;
    }
    return { classified, summary, blocks: summary.regression > 0 };
}
module.exports = { classifyFailures };
