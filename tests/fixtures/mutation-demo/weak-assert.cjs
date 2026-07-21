'use strict';

const assert = require('node:assert/strict');

/**
 * WEAK assertion: only checks a value FAR from the boundary. isAdult(40) is true
 * under both the original (`>=`) and the mutated (`>`) target — 40 > 18 either way
 * — so this assertion CANNOT detect a boundary mutation. It SURVIVES the mutant
 * (stays green), which is exactly the fake coverage STRONG-03 must reject.
 *
 * Throws on failure; returns normally on pass (it passes against the mutant).
 */
module.exports = function weakAssert(isAdult) {
  assert.strictEqual(isAdult(40), true, 'far above boundary is adult (mutation-blind)');
};
