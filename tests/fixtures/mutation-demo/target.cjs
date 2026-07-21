'use strict';

/**
 * STRONG-03 mutation-demo TARGET (a real, tiny pure function).
 *
 * `isAdult(age)` returns whether age is at or above the adult boundary (18). The
 * boundary comparison `age >= 18` is the mutation site: the demo harness rewrites
 * `>=` to `>`, which changes the verdict at EXACTLY age 18 (18 >= 18 is true, but
 * 18 > 18 is false) — a strong boundary assertion kills that mutant, a weak
 * far-from-boundary assertion cannot see it.
 */
function isAdult(age) {
  return age >= 18;
}

module.exports = { isAdult };
