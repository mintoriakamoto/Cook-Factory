'use strict';

/**
 * Fixture subject for the mutation gate's observed-refusal arms.
 *
 * NOT production code and NOT loaded by anything but tests/gate-mutation.test.cjs.
 * It is deliberately small and deliberately mutable: 1 boundary comparison and
 * 1 arithmetic expression, so Stryker creates real mutants that a weak test set
 * lets live and a strong test set kills.
 *
 * Shaped after ferrox-core/bin/lib/gate-cap.cjs, whose surviving mutants are
 * exactly a `>=` boundary and a `-` arithmetic operator (phase 20 CONTEXT.md D4).
 */

/** @returns {boolean} true once elapsed has reached the budget. */
function overBudget(elapsedMs, budgetMs) {
  return elapsedMs >= budgetMs;
}

/** @returns {number} budget left after the span from startMs to nowMs. */
function remaining(startMs, nowMs, budgetMs) {
  return budgetMs - (nowMs - startMs);
}

module.exports = { overBudget, remaining };
