#!/usr/bin/env node
'use strict';

/**
 * Build step for the eval-harness-integrity pack: generate the reference and mutant
 * fixtures deterministically, seal them into the sealed store (FERROX_SEALED_STORE or
 * the default ~/.cache/ferrox/gates/sealed), and print the sealed URIs that belong in
 * card.md. Idempotent: content addressing makes re-runs no-ops.
 *
 * Usage:
 *   node gates/eval-harness-integrity/fixtures/generators/seal-fixtures.cjs
 *   FERROX_SEALED_STORE=/some/store node .../seal-fixtures.cjs
 *
 * Nothing this script emits may be committed; the generated content exists only inside
 * the store (ADR-SEALED-GATES decision 1).
 */

const path = require('node:path');

const seal = require(path.join(__dirname, '..', '..', '..', '..', 'ferrox-core', 'bin', 'lib', 'gate-seal.cjs'));
const { generateReference } = require('./reference.cjs');
const { generateMutants } = require('./mutants.cjs');

function main() {
  const entries = [
    { label: 'reference', content: generateReference() },
    ...generateMutants().map((m) => ({ label: m.id, content: m.content })),
  ];
  let failed = false;
  for (const entry of entries) {
    const result = seal.sealPut({ content: entry.content });
    if (result.ok === true) {
      process.stdout.write(`${entry.label}: ${result.uri}\n`);
    } else {
      failed = true;
      process.stdout.write(`${entry.label}: SEAL FAILED ${result.code}\n`);
    }
  }
  return failed ? 1 : 0;
}

process.exitCode = main();
