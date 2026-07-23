#!/usr/bin/env node
'use strict';

/**
 * Build step for the citation-sources pack: generate the reference packet and the
 * 5 mutant packets with a fresh per-seal nonce, seal them into the sealed store
 * (FERROX_SEALED_STORE or the default ~/.cache/ferrox/gates/sealed), and print the
 * sealed URIs that belong in card.md, plus the current gate script hash for the
 * card's `gate_script_hash:` field. Idempotent per nonce: content addressing makes
 * re-runs of the same bytes no-ops.
 *
 * Usage:
 *   node gates/citation-sources/fixtures/generators/seal-fixtures.cjs
 *   FERROX_SEALED_STORE=/some/store node .../seal-fixtures.cjs
 *
 * Nothing this script emits may be committed; the generated content exists only
 * inside the store (ADR-SEALED-GATES decision 1).
 */

const fs = require('node:fs');
const path = require('node:path');

const seal = require(path.join(__dirname, '..', '..', '..', '..', 'ferrox-core', 'bin', 'lib', 'gate-seal.cjs'));
const gen = require('./generators.cjs');

function main() {
  const nonce = gen.mintNonce();
  const entries = [
    { label: 'reference', content: gen.referenceContent({ nonce }) },
    ...gen.mutants({ nonce }).map((m) => ({ label: m.id, content: m.content })),
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
  const gateScript = path.join(__dirname, '..', '..', 'gate.cjs');
  process.stdout.write(`gate_script_hash: ${seal.sha256HexOf(fs.readFileSync(gateScript))}\n`);
  return failed ? 1 : 0;
}

process.exitCode = main();
