"use strict";
/**
 * INTG-01 integration-landing decider (v1.6 — WLD field report property #1).
 *
 * An accepted packet lands on the canonical integration candidate ONLY as a reversible ff-only pointer
 * advance, and ONLY after the EXACT merged head was proven in a disposable prep worktree. The baseline
 * stays pristine until proof. This pure decider gates that landing.
 *
 *   decideIntegrationLanding({ mergedHeadProven, ffOnlyPossible, protectedPathsClean }) -> { action, reason }
 *     land    — all three true: advance the canonical pointer with `git merge --ff-only`
 *     reprove — merged head not yet proven → prove the exact merged SHA first
 *     block   — ff-only impossible (candidate diverged) or protected paths dirtied → re-prep / stop
 *
 * FAIL-CLOSED: any missing/garbage input → block. Landing requires all three EXPLICIT trues. Never throws.
 *
 * ADR-457: compiles to ferrox-core/bin/lib/integration-landing.cjs. `export =` shape.
 */
/**
 * PURE. Decide whether an accepted packet may ff-only land on the candidate. Every guard requires an
 * EXACT boolean true; anything else is treated as not-satisfied (fail-closed).
 */
function decideIntegrationLanding(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    // Protected-path safety comes first — a dirtied protected path blocks regardless of proof state.
    if (o.protectedPathsClean !== true)
        return { action: 'block', reason: 'protected-paths-dirty' };
    if (o.mergedHeadProven !== true)
        return { action: 'reprove', reason: 'merged-head-not-proven' };
    if (o.ffOnlyPossible !== true)
        return { action: 'block', reason: 'not-fast-forward-candidate-diverged' };
    return { action: 'land', reason: 'ff-only-advance-of-proven-head' };
}
module.exports = { decideIntegrationLanding };
