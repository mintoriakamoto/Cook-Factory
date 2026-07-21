'use strict';

const assert = require('node:assert/strict');

/**
 * STRONG assertion: pins BOTH sides of the boundary. It asserts the value just
 * below the boundary is false AND the value AT the boundary is true. The AT-boundary
 * check (isAdult(18) === true) is exactly what the `>=` → `>` mutant breaks, so this
 * assertion flips to red (throws) against the mutated target — it KILLS the mutant.
 *
 * Throws on failure (so the harness observes a red flip); returns normally on pass.
 */
module.exports = function strongAssert(isAdult) {
  assert.strictEqual(isAdult(17), false, 'below boundary is not adult');
  assert.strictEqual(isAdult(18), true, 'AT boundary IS adult (the mutation-sensitive check)');
};
