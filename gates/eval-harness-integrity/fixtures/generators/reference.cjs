'use strict';

/**
 * Generator for the eval-harness-integrity REFERENCE fixture: a known-good discriminative
 * mini harness. Calibration by construction (see harness-lib.cjs):
 *
 *   gold stub 1.0 | planted mutant 0.6 | random stub 0.25
 *
 * which satisfies every check in the card: gold at ceiling (EHI-02), random inside the
 * declared 0.25 +/- 0.05 band (EHI-03), mutant drop 0.4 >= max(declared 0.3, floor 0.15)
 * (EHI-04), disjoint exemplar vocabulary (EHI-05), enum-constrained schemas (EHI-06),
 * a bypass-free scorer (EHI-07), and non-overlapping stub intervals (EHI-08).
 *
 * Output is byte-deterministic. The CONTENT this emits is sealed, never committed.
 */

const lib = require('./harness-lib.cjs');

/** Returns the reference fixture as a deterministic JSON string. */
function generateReference() {
  return lib.serialize(lib.buildReferenceHarness());
}

module.exports = { generateReference };

if (require.main === module) {
  process.stdout.write(generateReference());
}
