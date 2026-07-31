/**
 * Phase Lifecycle Pure Helpers — pure-computation functions extracted from
 * the phase-lifecycle SDK handler (ADR-457 build-at-publish: the hand-written
 * bin/lib/phase-lifecycle.cjs collapsed to a TypeScript source of truth).
 * Behaviour is preserved byte-for-behaviour from the prior hand-written .cjs;
 * only types are added.
 *
 * I/O adapter pattern (ADR-3524 Section 4): each side supplies its own I/O
 * (sync readFileSync for CJS, async readFile for SDK); the pure computation
 * logic is shared via this generated artifact.
 *
 * Scope:
 *   - clampPercent(completed, total): percent with 100 ceiling
 *
 * RETIRED by phase 14.1 D3c: `deriveProgressFromRoadmap` read the GENERATED
 * ROADMAP progress table to produce state counters, which is the edge that
 * would close the cycle the moment that table became generated. Its last
 * consumer went with the completePhase progress block in plan 02, and an
 * exported function that reads a generated region to produce state counters is
 * a cycle waiting to be rewired, so it is deleted rather than left dangling.
 * The aggregate counters now come from the phase directories, through
 * `deriveProgressFromPhaseDirs` in state.cts.
 *
 * `clampPercent` is the surviving half of the issue #4 root-cause fix and keeps
 * its live consumer inside state-transition.cjs.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md)
 *   - Issue #4 (ferroxfactory/ferrox-core)
 */

/**
 * Compute progress percent clamped to 100.
 * Root cause fix for issue #4 — see gen-phase-lifecycle.mjs for full documentation.
 */
export function clampPercent(completed: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((completed / total) * 100));
}
