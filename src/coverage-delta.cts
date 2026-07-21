/**
 * HALT-04 coverage.delta core (D-02) — the second tooth of the Ship Clock.
 *
 * Decides whether a candidate merge advances requirement/VALIDATION coverage.
 * Only a STRICTLY POSITIVE delta (after - before > 0) counts as `landed`; a
 * no-op merge (delta 0) or a regression (delta < 0) is rejected as `not-landed`.
 * This is the arithmetic gate HALT-04's descope-and-merge is checked against, so
 * an inflated 'after' can never fake a land (T-03-11) — the coverage source is
 * Phase 5's territory; Phase 3 owns only the strictness of the comparison.
 *
 * PURE: no fs, no clock, no log — the "landed" signal is a decision the caller
 * acts on.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/coverage-delta.cjs. `export =` CJS shape; no stdout.
 */

/** The coverage-delta decision plus the computed delta. */
interface CoverageDeltaResult {
  decision: 'landed' | 'not-landed';
  delta: number;
}

/**
 * PURE. delta = after - before. A strictly positive delta is `landed`; a zero
 * or negative delta is `not-landed` (the no-op / regression is rejected).
 */
function evaluateCoverageDelta(before: number, after: number): CoverageDeltaResult {
  const delta = after - before;
  return { decision: delta > 0 ? 'landed' : 'not-landed', delta };
}

export = { evaluateCoverageDelta };
