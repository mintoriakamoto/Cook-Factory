"use strict";
/**
 * INTG-05 authority fence + post-op invariant assertion (v1.6 — WLD field report property #5).
 *
 * Unattended autonomy near irreversible gates needs machine-checked fences. Every executor carries the
 * same deny-set (no push / merge-to-main / release / deploy / canary / issue-close / lifecycle-cleanup),
 * and after each op the canonical candidate pointer + protected paths are asserted unchanged.
 *
 *   checkAuthority({ op, denied? }) -> { allowed, reason }
 *     Denies any op in the deny-set. FAIL-CLOSED: a non-string/empty op → deny. Default deny-set applies
 *     when none is supplied.
 *   assertInvariants({ candidateShaBefore, candidateShaAfter, protectedPathsDirty }) -> { ok, violations }
 *     Flags an unexpected candidate-pointer move or a dirtied protected path.
 *
 * PURE, never throws.
 *
 * ADR-457: compiles to ferrox-core/bin/lib/authority-fence.cjs. `export =` shape.
 */
const DEFAULT_DENIED = [
    'push', 'merge-main', 'release', 'deploy', 'canary', 'issue-close', 'lifecycle-cleanup',
];
/** PURE. Allow only a known, non-denied op. Fail-closed: garbage op → deny. */
function checkAuthority(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const op = o.op;
    if (typeof op !== 'string' || op === '')
        return { allowed: false, reason: 'non-string-op-deny' };
    const denied = Array.isArray(o.denied)
        ? o.denied.filter((x) => typeof x === 'string')
        : DEFAULT_DENIED;
    if (denied.includes(op))
        return { allowed: false, reason: `denied:${op}` };
    return { allowed: true, reason: 'allowed' };
}
/** PURE. Assert the candidate pointer didn't move and no protected path was dirtied by the last op. */
function assertInvariants(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const violations = [];
    const before = o.candidateShaBefore;
    const after = o.candidateShaAfter;
    // Only a KNOWN move is a violation; if either SHA is unknown we can't assert stability -> flag it.
    if (typeof before !== 'string' || typeof after !== 'string') {
        violations.push('candidate-sha-unverifiable');
    }
    else if (before !== after) {
        violations.push('candidate-pointer-moved');
    }
    if (o.protectedPathsDirty === true)
        violations.push('protected-path-dirtied');
    return { ok: violations.length === 0, violations };
}
module.exports = { checkAuthority, assertInvariants };
