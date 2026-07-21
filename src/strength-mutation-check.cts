/**
 * STRONG-03 strength.mutation-check decision core.
 *
 * A test that passes whether or not the code is correct is FAKE coverage. The
 * mutation gate mutates the code a test claims to cover and confirms the mapped
 * test flips to FAILING; a test that survives mutation of its own target is
 * rejected. Given a requirement→test mapping and the observed mutation result
 * (did the mapped test flip to red?), this decides:
 *   - killed:   the mapped test flipped to red → real coverage.
 *   - survived: the mapped test stayed green → fake coverage → rejected.
 *
 * Fail CLOSED: `killed` ONLY when `mapped_test_flipped_to_red === true` (the
 * boolean, not a truthy value) AND a non-empty `test` mapping is present. Every
 * other case — false, undefined, a non-boolean, or a missing/blank test — resolves
 * to `survived`, so unproven coverage is treated as fake and the merge-gate
 * (Plan 06) rejects it. Never silently killed.
 *
 * PURE core: no fs, no clock, no config. The REAL mutation observation is produced
 * by the bounded demo harness (tests/strength-mutation-demo.test.cjs); this core
 * only turns an observed flip into a verdict.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/strength-mutation-check.cjs. `export =` CJS shape; no stdout.
 */

/** A mutation-check verdict plus the echoed mapping for the run-log. */
interface MutationCheckResult {
  /** 'killed' iff the mapped test provably flipped to red, else 'survived'. */
  decision: 'killed' | 'survived';
  requirement: unknown;
  test: unknown;
}

/**
 * PURE. Decide killed vs survived from an observed mutation result. Fails closed
 * to `survived` unless a real test mapping is present AND the mapped test was
 * observed flipping to red (=== true).
 */
function evaluateMutationCheck(opts: {
  requirement?: unknown;
  test?: unknown;
  mapped_test_flipped_to_red?: unknown;
}): MutationCheckResult {
  const rawTest = opts ? opts.test : undefined;
  const flipped = opts ? opts.mapped_test_flipped_to_red : undefined;

  const testPresent = typeof rawTest === 'string' && rawTest.trim() !== '';
  const killed = flipped === true && testPresent;

  return {
    decision: killed ? 'killed' : 'survived',
    requirement: opts ? opts.requirement : undefined,
    test: rawTest,
  };
}

export = { evaluateMutationCheck };
