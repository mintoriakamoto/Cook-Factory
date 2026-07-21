"use strict";
/**
 * ANV-03 Anvil candidate decision (v1.4 Anvil Executor).
 *
 * THE SAFETY INVARIANT of the whole milestone: an Anvil result is only ever a
 * *candidate*. Anvil-green means "worth handing to Factory's verify + merge-gate" — it
 * NEVER waives receipts, mutation, coverage, or any merge-gate criterion. The candidate
 * is exactly as untrusted as any other diff. This core deliberately emits NO waiver
 * flags — it only routes.
 *
 * decideAnvilCandidate({ parsed, candidatePresent }) -> { action, reason }
 *   candidatePresent && parsed.green === true  -> 'accept-candidate' (-> unchanged merge-gate)
 *   candidatePresent && !green                 -> 'reject'           (partial; normal executor)
 *   !candidatePresent                          -> 'fallback-normal'  (empty/silent burn; normal)
 *
 * PURE. Never throws. Fail-toward-normal on any garbage input.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/anvil-candidate-gate.cjs. `export =` CJS shape; no stdout.
 */
/**
 * PURE. Route an Anvil run's outcome. `green` must be EXACTLY true to accept — a
 * truthy non-true does not (safety: an unparsed/degenerate result must never land free).
 */
function decideAnvilCandidate(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (o.candidatePresent !== true) {
        return { action: 'fallback-normal', reason: 'no-candidate-written' };
    }
    const parsed = o.parsed && typeof o.parsed === 'object' ? o.parsed : null;
    const green = parsed !== null && parsed.green === true;
    return green
        ? { action: 'accept-candidate', reason: 'anvil-green-faces-merge-gate' }
        : { action: 'reject', reason: 'anvil-not-green' };
}
module.exports = { decideAnvilCandidate };
