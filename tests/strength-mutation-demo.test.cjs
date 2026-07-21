'use strict';

/**
 * STRONG-03 REAL bounded mutation demo (per CONTEXT: one real, scoped harness — an
 * ACTUAL code mutation + ACTUAL assertion execution, not a hard-coded verdict).
 *
 * The harness:
 *   1. Reads the real target source (tests/fixtures/mutation-demo/target.cjs).
 *   2. Applies ONE textual mutation to the boundary operator (`>=` → `>`).
 *   3. Writes the mutated source to a hermetic temp file and require()s it FRESH
 *      (unique path → no require-cache collision).
 *   4. Runs each assertion (strong / weak) against the MUTATED function in a
 *      try/catch, recording whether it threw (flipped to RED = mutant killed) or
 *      passed (stayed GREEN = mutant survived).
 *   5. Feeds each observed `mapped_test_flipped_to_red` into evaluateMutationCheck
 *      and asserts the STRONG path → killed and the WEAK path → survived.
 *
 * This proves a survived mutant is caught by a real mutation + real execution, not
 * by decision logic alone. Bounded: one target, one mutation, two assertions,
 * in-process (no recursive `node --test` spawn).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateMutationCheck } = require('../ferrox-core/bin/lib/strength-mutation-check.cjs');

const FIXTURES = path.join(__dirname, 'fixtures', 'mutation-demo');
const TARGET_SRC_PATH = path.join(FIXTURES, 'target.cjs');
const strongAssert = require(path.join(FIXTURES, 'strong-assert.cjs'));
const weakAssert = require(path.join(FIXTURES, 'weak-assert.cjs'));

/** Apply ONE real textual mutation to the boundary operator: `>=` → `>`. */
function mutateSource(src) {
  // Mutate the actual boundary comparison in the RETURN statement (not any prose
  // in the JSDoc). The `return ` prefix pins it to executable code.
  const mutated = src.replace('return age >= 18;', 'return age > 18;');
  assert.notEqual(mutated, src, 'the mutation must actually change the source');
  return mutated;
}

/** Write mutated source to a unique temp file and require it FRESH. Returns isAdult. */
function loadMutatedTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-mut-demo-'));
  const p = path.join(dir, 'target.mut.cjs');
  fs.writeFileSync(p, mutateSource(fs.readFileSync(TARGET_SRC_PATH, 'utf8')));
  delete require.cache[require.resolve(p)]; // bust any cache for this unique path
  return require(p).isAdult;
}

/** Run an assertion fn against a target; true = flipped to red (threw / killed). */
function observeFlip(assertFn, isAdult) {
  try {
    assertFn(isAdult);
    return false; // passed → mutant survived (stayed green)
  } catch {
    return true; // threw → mutant killed (flipped to red)
  }
}

// --- Sanity: both assertions PASS against the ORIGINAL (un-mutated) target ----

test('sanity: strong and weak assertions both pass against the original target', () => {
  const { isAdult } = require(TARGET_SRC_PATH);
  assert.doesNotThrow(() => strongAssert(isAdult), 'strong passes on correct code');
  assert.doesNotThrow(() => weakAssert(isAdult), 'weak passes on correct code');
});

// --- The real killed vs survived demonstration (STRONG-03) -------------------

test('the STRONG assertion KILLS the boundary mutant → mutation-check killed', () => {
  const mutatedIsAdult = loadMutatedTarget();

  // Ground the mutation: the mutant differs from the original AT the boundary.
  assert.equal(mutatedIsAdult(18), false, 'mutated (>) target is wrong at the boundary');

  const flipped = observeFlip(strongAssert, mutatedIsAdult);
  assert.equal(flipped, true, 'strong assertion flipped to red against the mutant (real execution)');

  const r = evaluateMutationCheck({
    requirement: 'DEMO-STRONG-03',
    test: 'tests/fixtures/mutation-demo/strong-assert.cjs',
    mapped_test_flipped_to_red: flipped,
  });
  assert.equal(r.decision, 'killed');
});

test('the WEAK assertion SURVIVES the boundary mutant → mutation-check survived', () => {
  const mutatedIsAdult = loadMutatedTarget();

  const flipped = observeFlip(weakAssert, mutatedIsAdult);
  assert.equal(flipped, false, 'weak assertion stayed green against the mutant (real execution)');

  const r = evaluateMutationCheck({
    requirement: 'DEMO-WEAK',
    test: 'tests/fixtures/mutation-demo/weak-assert.cjs',
    mapped_test_flipped_to_red: flipped,
  });
  assert.equal(r.decision, 'survived', 'fake coverage caught by a REAL mutation + REAL execution');
});
