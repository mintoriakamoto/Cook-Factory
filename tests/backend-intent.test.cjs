'use strict';

/**
 * Phase 21 : reading a BACKEND out of a sentence.
 *
 * The flag `--fleet` is the machine surface. The surface a person uses is a
 * sentence typed into Claude Code, so this file proves the matcher that reads
 * that sentence.
 *
 * THE ARM THAT MATTERS MOST IS THE NARROW ONE. A false positive here dispatches
 * a backend nobody asked for, so the corpus of sentences that MENTION a fleet
 * without asking for one is asserted before anything else, and the mutation
 * battery at the bottom is built almost entirely out of mutants that WIDEN the
 * matcher. Every one of them must die against that corpus.
 *
 * COUNTERS, NEVER FLAGS. A matcher that never ran reports no match, and so does a
 * matcher that ran and correctly found nothing. The 2 are told apart by the
 * integer counters, which are asserted NON ZERO first: `texts` says the sentence
 * was genuinely read, `candidates` says the object list was genuinely walked.
 *
 * CONSTANTS ARE READ FROM THE SHIPPED ARTIFACT, never transcribed. Two copies of
 * a word list is how a matcher and its proof drift apart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const INTENT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'backend-intent.cjs');

const {
  detectBackendIntent,
  tokenize,
  INTENT_CODES,
  LEADS,
  CONNECTORS,
  NEGATORS,
  FLEET_LED_OBJECTS,
  FLEET_STANDALONE_OBJECTS,
  INLINE_LED_OBJECTS,
  INLINE_STANDALONE_OBJECTS,
  BACKEND_FLEET,
  BACKEND_INLINE,
} = require(INTENT_LIB);

/**
 * Sentences that genuinely ASK for a fleet. Sean's own phrasings are the first
 * entries, because the phrasing a product is demonstrated with is the phrasing
 * that has to work.
 */
const ASKS_FLEET = Object.freeze([
  'build it with the ferrox fleet',
  'use the fleet',
  'I want to use the fleet to build this',
  'build phase 21 with the ferrox fleet',
  'run it with the fleet',
  'run it wide',
  'go wide',
  'fleet mode',
  'ferrox fleet mode',
  'execute it as a fleet',
  'ship it with the fleet',
  'use the ferrox fleet',
]);

/** Sentences that genuinely ask for inline. */
const ASKS_INLINE = Object.freeze([
  'just run it inline',
  'run inline',
  'inline mode',
  'no fleet',
  'no ferrox fleet',
  'without the fleet',
  'single agent',
  'one agent',
  'one at a time',
  'run it solo',
  'dont use the fleet',
  'not the fleet',
]);

/**
 * Sentences that MENTION a fleet and ask for nothing. THIS IS THE CORPUS THE
 * WHOLE DESIGN IS SHAPED AROUND.
 */
const MENTIONS_ONLY = Object.freeze([
  'the fleet benchmark returned NEGATIVE',
  'compare it with the fleet numbers before deciding',
  'the fleet is slower than inline on this phase',
  'read the fleet documentation and report back',
  'phase 21 shipped the fleet glass and the fleet foreman',
  'why did the fleet cost more than the inline arm',
  'the fleet dispatch consumer is not built yet',
  'summarise what the fleet did last week',
  'a fleet of worker processes is what FF-B379 is about',
  'inline and fleet both appear in that table',
  'build a summary of the fleet costs',
]);

/** Assert the shape every arm reads, before any arm reads it. */
function assertScanned(res, label) {
  assert.ok(res.counters.texts > 0, `${label}: the sentence was genuinely read`);
  assert.ok(res.counters.candidates > 0, `${label}: the object list was genuinely walked`);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE NARROW ARM. It goes first because it is the one that matters.
// ─────────────────────────────────────────────────────────────────────────────

test('NARROW: a sentence that merely MENTIONS the fleet asks for nothing', () => {
  let scanned = 0;
  for (const sentence of MENTIONS_ONLY) {
    const res = detectBackendIntent(sentence);
    assertScanned(res, `narrow/${sentence}`);
    assert.equal(res.ok, true, `narrow/${sentence}: a mention is not a contradiction either`);
    assert.equal(res.counters.fleet_matches, 0, `narrow/${sentence}: no fleet request found`);
    assert.equal(res.backend, null, `narrow/${sentence}: no backend resolved`);
    assert.equal(res.phrase, null, `narrow/${sentence}: nothing to echo`);
    assert.equal(res.code, INTENT_CODES.NONE);
    scanned += 1;
  }
  assert.equal(scanned, MENTIONS_ONLY.length, 'every mention sentence was scanned');
  assert.ok(scanned >= 10, 'the narrowness corpus is large enough to be a corpus');

  // FALSIFIABILITY. The same matcher, 1 word different, DOES resolve. Without
  // this the arm above would also pass against a matcher that never matches.
  const asked = detectBackendIntent('use the fleet');
  assert.equal(asked.backend, BACKEND_FLEET,
    'the matcher genuinely resolves a real request, so the zeroes above are about the sentences');
});

// ─────────────────────────────────────────────────────────────────────────────
// The 2 directions.
// ─────────────────────────────────────────────────────────────────────────────

test('a sentence that ASKS for a fleet resolves fleet and reports the phrase to echo', () => {
  let matched = 0;
  for (const sentence of ASKS_FLEET) {
    const res = detectBackendIntent(sentence);
    assertScanned(res, `fleet/${sentence}`);
    assert.ok(res.counters.fleet_matches > 0, `fleet/${sentence}: at least 1 fleet match`);
    assert.equal(res.counters.inline_matches, 0, `fleet/${sentence}: and no inline match`);
    assert.equal(res.ok, true);
    assert.equal(res.backend, BACKEND_FLEET, `fleet/${sentence}: resolved fleet`);
    assert.equal(res.code, INTENT_CODES.FLEET);
    assert.equal(typeof res.phrase, 'string', `fleet/${sentence}: there is a phrase to echo`);
    assert.ok(res.phrase.length > 0, `fleet/${sentence}: the phrase is non empty`);
    assert.ok(tokenize(sentence).join(' ').includes(res.phrase),
      `fleet/${sentence}: the echoed phrase is genuinely a span of what was typed, got "${res.phrase}"`);
    matched += 1;
  }
  assert.equal(matched, ASKS_FLEET.length, 'every fleet request resolved');
});

test('a sentence that ASKS for inline resolves inline', () => {
  let matched = 0;
  for (const sentence of ASKS_INLINE) {
    const res = detectBackendIntent(sentence);
    assertScanned(res, `inline/${sentence}`);
    assert.ok(res.counters.inline_matches > 0, `inline/${sentence}: at least 1 inline match`);
    assert.equal(res.counters.fleet_matches, 0, `inline/${sentence}: and no fleet match`);
    assert.equal(res.ok, true);
    assert.equal(res.backend, BACKEND_INLINE, `inline/${sentence}: resolved inline`);
    assert.equal(res.code, INTENT_CODES.INLINE);
    matched += 1;
  }
  assert.equal(matched, ASKS_INLINE.length, 'every inline request resolved');
});

// ─────────────────────────────────────────────────────────────────────────────
// Contradiction, negation, and the ordinary case.
// ─────────────────────────────────────────────────────────────────────────────

test('a sentence asking for BOTH refuses rather than picking a side', () => {
  const both = [
    'use the fleet but run it inline',
    'run it inline, actually use the fleet',
    'fleet mode, single agent',
  ];
  let refused = 0;
  for (const sentence of both) {
    const res = detectBackendIntent(sentence);
    assertScanned(res, `conflict/${sentence}`);
    assert.ok(res.counters.fleet_matches > 0, `conflict/${sentence}: a fleet request was found`);
    assert.ok(res.counters.inline_matches > 0, `conflict/${sentence}: an inline request was found`);
    assert.equal(res.ok, false, `conflict/${sentence}: this refuses`);
    assert.equal(res.backend, null, `conflict/${sentence}: no side was picked`);
    assert.equal(res.code, INTENT_CODES.CONFLICT);
    assert.ok(res.reason.includes('contradictory'), `conflict/${sentence}: the reason names why`);
    refused += 1;
  }
  assert.equal(refused, both.length, 'every contradictory sentence refused');
});

test('a NEGATED fleet request is an inline decision, and the echo starts at the negator', () => {
  const res = detectBackendIntent('dont use the fleet on this one');
  assertScanned(res, 'negation');
  assert.ok(res.counters.negations > 0, 'the negation was genuinely seen');
  assert.equal(res.backend, BACKEND_INLINE, 'a refused fleet is a decision for inline');
  assert.equal(res.phrase, 'dont use the fleet',
    'the echo reads as the sentence typed rather than its opposite');

  // The reverse is deliberately NOT done: guessing the opposite of a refused
  // inline is a wrong dispatch waiting to happen.
  const reverse = detectBackendIntent('dont run it inline');
  assert.notEqual(reverse.backend, BACKEND_FLEET,
    'a negated inline is NOT read as a fleet request');
});

test('a sentence with nothing to say about backends resolves nothing, and that is not an error', () => {
  for (const sentence of ['21', '21 --wave 2', 'execute phase 21', 'fix the failing test']) {
    const res = detectBackendIntent(sentence);
    assert.equal(res.ok, true, `${sentence}: silence is not an error`);
    assert.equal(res.backend, null, `${sentence}: nothing was resolved`);
    assert.equal(res.code, INTENT_CODES.NONE);
  }
});

test('unreadable input is reported as unreadable rather than thrown', () => {
  for (const bad of [null, undefined, 42, {}, [], '', '   ', '!!!']) {
    const res = detectBackendIntent(bad);
    assert.equal(res.ok, true, 'unreadable input is not a refusal');
    assert.equal(res.backend, null);
    assert.equal(res.code, INTENT_CODES.UNREADABLE);
    assert.equal(res.counters.texts, 0, 'nothing readable was read');
  }
});

test('the flag tokens themselves carry no intent, so a flag cannot self trigger the matcher', () => {
  for (const argv of ['--fleet', '21 --fleet', '--inline', '21 --inline --wave 2']) {
    const res = detectBackendIntent(argv);
    assert.equal(res.backend, null,
      `${argv}: a bare flag token is not a sentence, and the flag layer already owns it`);
  }
});

test('the word lists are non empty and disjoint where they must be', () => {
  assert.ok(LEADS.length > 0, 'there are directive verbs');
  assert.ok(CONNECTORS.length > 0, 'there are connectors');
  assert.ok(NEGATORS.length > 0, 'there are negators');
  assert.ok(FLEET_LED_OBJECTS.length > 0, 'there are fleet objects');
  assert.ok(FLEET_STANDALONE_OBJECTS.length > 0, 'there are self directive fleet objects');
  assert.ok(INLINE_LED_OBJECTS.length > 0, 'there are inline objects');
  assert.ok(INLINE_STANDALONE_OBJECTS.length > 0, 'there are self directive inline objects');

  // A word that is BOTH a lead and a connector would let a lead chain through
  // itself, which is a quiet widening of the match.
  const overlap = LEADS.filter((w) => CONNECTORS.indexOf(w) !== -1);
  assert.deepEqual(overlap, [], `no word is both a lead and a connector, got ${overlap.join(', ')}`);

  // The bare word for a fleet is deliberately NOT an object. With one, "run fleet
  // benchmarks" would resolve a backend.
  const bare = FLEET_LED_OBJECTS.filter((o) => o.length === 1 && o[0] === 'fleet');
  assert.deepEqual(bare, [], 'the bare fleet noun is not an object on its own');
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION BATTERY : every mutant WIDENS or BREAKS the matcher, is applied on
// disk, is killed, and the artifact is restored byte identical.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the matcher in a CHILD PROCESS so the mutated file on disk is genuinely
 * loaded. An in process require would serve the module cached before the
 * mutation and score a battery it did not earn.
 */
function detectInChild(sentence) {
  const out = execFileSync(process.execPath, ['-e',
    'const m=require(' + JSON.stringify(INTENT_LIB) + ');'
    + 'process.stdout.write(JSON.stringify(m.detectBackendIntent(process.argv[1])));',
    sentence,
  ], { encoding: 'utf8' });
  return JSON.parse(out);
}

const MUTANTS = [
  {
    id: 'I01',
    from: '                if (group.led) {', to: '                if (false) {',
    why: 'an object with no directive verb in front of it is a mention, not a request',
    check: () => detectInChild('the fleet benchmark returned NEGATIVE').backend === null,
  },
  {
    id: 'I02',
    from: '        if (!numeric && CONNECTORS.indexOf(word) === -1)',
    to: '        if (!numeric && false)',
    why: 'a lead may only reach its object across CONNECTORS, never across any word',
    // "build a SUMMARY of the fleet costs" carries a real lead 4 words in front of
    // a real object, with a noun between them. The connector wall is the only
    // thing standing between that sentence and a dispatch.
    check: () => detectInChild('build a summary of the fleet costs').backend === null,
  },
  {
    id: 'I03',
    from: 'const MAX_CONNECTORS = 4;', to: 'const MAX_CONNECTORS = 0;',
    why: 'a lead must still reach an object a few connectors away',
    check: () => detectInChild('build it with the ferrox fleet').backend === 'fleet',
  },
  {
    id: 'I04',
    from: '    if (counters.fleet_matches > 0 && counters.inline_matches > 0) {',
    to: '    if (false) {',
    why: 'a sentence asking for both backends refuses rather than picking one',
    check: () => detectInChild('use the fleet but run it inline').ok === false,
  },
  {
    id: 'I05',
    from: '                if (negated) {', to: '                if (false) {',
    why: 'a refused fleet is a decision for inline, not a request for a fleet',
    check: () => detectInChild('dont use the fleet on this one').backend === 'inline',
  },
  {
    id: 'I06',
    from: '                    counters.fleet_matches += 1;', to: '                    counters.fleet_matches += 0;',
    why: 'a match must be COUNTED, so an arm can tell a scan that found nothing from a scan that never ran',
    check: () => detectInChild('use the fleet').counters.fleet_matches === 1,
  },
  {
    id: 'I07',
    from: '            counters.candidates += 1;', to: '            counters.candidates += 0;',
    why: 'the candidate counter is the receipt that the object list was genuinely walked',
    check: () => detectInChild('use the fleet').counters.candidates > 0,
  },
  {
    id: 'I08',
    from: '    result.phrase = first.phrase;', to: '    result.phrase = null;',
    why: 'an inference with no phrase cannot be echoed, and a silent inference is the defect',
    check: () => typeof detectInChild('use the fleet').phrase === 'string',
  },
  {
    id: 'I09',
    from: '                if (overlaps)', to: '                if (false)',
    why: '1 request counted twice is a counter that lies, and every arm here reads counters',
    // "use the fleet mode" carries "fleet mode" and "the fleet" on the same words.
    // Without the overlap guard it is 1 request counted as 2, and `inferences`
    // downstream stops meaning what it says.
    check: () => detectInChild('use the fleet mode').counters.fleet_matches === 1,
  },
  {
    id: 'I10',
    from: 'function findLead(tokens, objectStart) {',
    to: 'function findLead(tokens, objectStart) { return 0;',
    why: 'a lead that is always found is no lead requirement at all',
    check: () => detectInChild('the fleet benchmark returned NEGATIVE').backend === null,
  },
];

/** What git says about the mutated artifact right now. */
function numstat() {
  return execFileSync('git', ['diff', '--numstat', '--', INTENT_LIB],
    { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

test('MUTATION BATTERY: every mutant is applied on disk, killed, and restored', () => {
  // Git's view BEFORE the battery, compared against its view AFTER rather than
  // against the empty string. The guarded property is that the battery left the
  // artifact byte identical, not that the working tree was clean when it ran.
  const gitBefore = numstat();
  const original = fs.readFileSync(INTENT_LIB, 'utf8');

  assert.ok(MUTANTS.length > 0, 'the battery is non empty');

  const survivors = [];
  let applied = 0;
  let killed = 0;

  try {
    for (const m of MUTANTS) {
      // The replacement must EXIST. A mutant that cannot be applied is a battery
      // reporting a score it did not earn, so this is a hard failure.
      const occurrences = original.split(m.from).length - 1;
      assert.ok(occurrences > 0,
        `${m.id}: the target substring is absent from ${path.basename(INTENT_LIB)}: ${m.from}`);

      const mutated = original.split(m.from).join(m.to);
      assert.notEqual(mutated, original, `${m.id}: the mutation changed the text`);
      fs.writeFileSync(INTENT_LIB, mutated, 'utf8');

      // ASSERT APPLIED ON DISK, by reading it back rather than trusting the write.
      const onDisk = fs.readFileSync(INTENT_LIB, 'utf8');
      assert.equal(onDisk, mutated, `${m.id}: the mutant is genuinely on disk`);
      assert.equal(onDisk.includes(m.to), true, `${m.id}: the replacement text is present on disk`);
      applied += 1;

      // The check returns TRUE when the guarded property still holds, which for a
      // mutant means the battery FAILED to kill it.
      let held;
      try {
        held = m.check() === true;
      } catch {
        held = false;
      }
      if (held) survivors.push(`${m.id} (${m.why})`);
      else killed += 1;

      fs.writeFileSync(INTENT_LIB, original, 'utf8');
      assert.equal(fs.readFileSync(INTENT_LIB, 'utf8'), original, `${m.id}: the artifact was restored`);
    }
  } finally {
    fs.writeFileSync(INTENT_LIB, original, 'utf8');
  }

  assert.equal(applied, MUTANTS.length, 'every mutant was genuinely applied on disk');
  assert.deepEqual(survivors, [], `mutants SURVIVED: ${survivors.join(', ')}`);
  assert.equal(killed, MUTANTS.length, `every mutant was killed (${killed}/${MUTANTS.length})`);

  assert.equal(fs.readFileSync(INTENT_LIB, 'utf8'), original,
    `${path.basename(INTENT_LIB)} is byte identical`);
  const gitAfter = numstat();
  assert.equal(gitAfter, gitBefore,
    `git reports 0 changed lines ADDED by the battery. before=${JSON.stringify(gitBefore)} after=${JSON.stringify(gitAfter)}`);
});
