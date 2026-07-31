"use strict";
/**
 * Backend intent : reading "build it with the ferrox fleet" as a backend request.
 *
 * Phase 21. The flag `--fleet` is the machine surface. The surface a person
 * actually uses is a sentence typed into Claude Code, so this module reads that
 * sentence and reports which backend, if any, it asked for.
 *
 * THE MATCH IS NARROW ON PURPOSE. A false positive here dispatches the wrong
 * backend, so this module prefers missing an unusual phrasing over catching a
 * sentence that merely MENTIONS the fleet. "the fleet benchmark returned
 * negative" is a report about a fleet, not a request for one, and it must not
 * resolve a backend. That single property is what the grammar below is shaped
 * around: an object phrase on its own is never enough. A DIRECTIVE LEAD has to
 * sit in front of it, separated by nothing but a closed list of connector words.
 *
 * The grammar, in full:
 *
 *   LEAD          a verb of instruction: use, run, build, execute, dispatch, ...
 *   CONNECTORS    up to 4 words from a closed list: it, this, with, as, the, ...
 *   OBJECT        the thing being asked for: "the fleet", "the ferrox fleet",
 *                 "a fleet", "wide", "inline", "solo"
 *
 * A few objects are SELF DIRECTIVE and need no lead, because they name a mode
 * rather than a noun: "fleet mode", "inline mode", "no fleet", "one at a time".
 *
 * NEGATION FLIPS RATHER THAN CANCELS. "dont use the fleet" is a real decision
 * about a backend, and the decision is inline. A negator inside a 2 word window
 * in front of the lead turns a fleet request into an inline request. The reverse
 * is deliberately NOT done: "not inline" is not read as a fleet request, because
 * guessing the opposite of a refusal is exactly the kind of cleverness that
 * produces a wrong dispatch.
 *
 * CONTRADICTION REFUSES. A sentence carrying both directions is 2 contradictory
 * decisions rather than 1, and this module reports that as a refusal for the
 * caller to route through its own single refusal rung. It never picks a side.
 *
 * COUNTERS, NEVER FLAGS. The result carries integer counters, so a caller can
 * assert that the matcher genuinely scanned and genuinely matched rather than
 * assert a boolean an empty implementation would also satisfy.
 *
 * Pure. Zero third party dependencies. Never throws on bad input.
 */
// ─── Constants ────────────────────────────────────────────────────────────────
const BACKEND_FLEET = 'fleet';
const BACKEND_INLINE = 'inline';
/** Closed set of outcome codes. */
const INTENT_CODES = Object.freeze({
    UNREADABLE: 'intent_text_unreadable',
    NONE: 'no_backend_intent',
    FLEET: 'fleet_intent',
    INLINE: 'inline_intent',
    CONFLICT: 'conflicting_backend_intent',
});
/**
 * Verbs of instruction. A sentence has to contain one of these in front of an
 * object before this module reads it as a request rather than a mention.
 */
const LEADS = Object.freeze([
    'use', 'used', 'using',
    'run', 'runs', 'running',
    'build', 'builds', 'building',
    'execute', 'executes', 'executing',
    'dispatch', 'dispatches', 'dispatching',
    'do', 'go', 'spin', 'ship', 'launch', 'start',
]);
/**
 * The only words allowed to sit between a lead and its object. Anything outside
 * this list breaks the phrase, which is what keeps "compare it with the fleet
 * numbers" from reading as a request: `compare` is not a lead, and no lead
 * reaches the object through it.
 */
const CONNECTORS = Object.freeze([
    'it', 'this', 'that', 'them', 'all', 'everything',
    'with', 'as', 'on', 'in', 'up', 'out', 'via', 'across',
    'the', 'a', 'of', 'rest', 'whole', 'entire', 'thing', 'job', 'work', 'phase',
]);
/** How many connector words a lead may reach across to find its object. */
const MAX_CONNECTORS = 4;
/** Words that turn a fleet request into an inline one. */
const NEGATORS = Object.freeze([
    'no', 'not', 'dont', 'doesnt', 'never', 'without', 'avoid', 'skip', 'stop', 'cant', 'cannot',
]);
/** How far in front of a lead a negator is still read as negating it. */
const NEGATION_WINDOW = 2;
/**
 * Objects that need a lead in front of them. Deliberately absent: the bare word
 * `fleet`. With a lead in front, "run fleet benchmarks" would match it, and that
 * sentence is about benchmarks.
 */
const FLEET_LED_OBJECTS = Object.freeze([
    Object.freeze(['the', 'ferrox', 'fleet']),
    Object.freeze(['the', 'fleet']),
    Object.freeze(['ferrox', 'fleet']),
    Object.freeze(['a', 'fleet']),
    Object.freeze(['wide']),
]);
/** Objects that name a mode, and so carry their own direction. */
const FLEET_STANDALONE_OBJECTS = Object.freeze([
    Object.freeze(['ferrox', 'fleet', 'mode']),
    Object.freeze(['fleet', 'mode']),
]);
const INLINE_LED_OBJECTS = Object.freeze([
    Object.freeze(['inline']),
    Object.freeze(['solo']),
]);
const INLINE_STANDALONE_OBJECTS = Object.freeze([
    Object.freeze(['inline', 'mode']),
    Object.freeze(['solo', 'mode']),
    Object.freeze(['without', 'the', 'ferrox', 'fleet']),
    Object.freeze(['without', 'the', 'fleet']),
    Object.freeze(['without', 'a', 'fleet']),
    Object.freeze(['no', 'ferrox', 'fleet']),
    Object.freeze(['no', 'fleet']),
    Object.freeze(['not', 'the', 'fleet']),
    Object.freeze(['single', 'agent']),
    Object.freeze(['one', 'agent']),
    Object.freeze(['one', 'at', 'a', 'time']),
]);
// ─── Normalisation ────────────────────────────────────────────────────────────
/**
 * Reduce a sentence to lowercase words. Apostrophes are DELETED rather than
 * turned into a boundary, so "dont" and "don't" are 1 token and the negator list
 * holds 1 spelling instead of 2 that can drift apart.
 */
function tokenize(text) {
    if (typeof text !== 'string' || text.length === 0)
        return [];
    const flat = text
        .toLowerCase()
        .replace(/[‘’ʼ]/g, "'")
        .replace(/'/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    if (flat.length === 0)
        return [];
    return flat.split(' ');
}
function zeroCounters() {
    return { texts: 0, candidates: 0, fleet_matches: 0, inline_matches: 0, negations: 0 };
}
/** Does `pattern` sit at `tokens[at]`. */
function patternAt(tokens, at, pattern) {
    if (at + pattern.length > tokens.length)
        return false;
    for (let k = 0; k < pattern.length; k += 1) {
        if (tokens[at + k] !== pattern[k])
            return false;
    }
    return true;
}
/**
 * Walk backward from an object looking for the lead that governs it, crossing
 * connector words only. Returns the lead's index, or -1 when no lead reaches it.
 */
function findLead(tokens, objectStart) {
    let crossed = 0;
    let i = objectStart - 1;
    while (i >= 0 && crossed <= MAX_CONNECTORS) {
        const word = tokens[i];
        if (LEADS.indexOf(word) !== -1)
            return i;
        // A bare number is a phase id, never a verb, so "build phase 21 with the
        // fleet" is not broken by the 21 sitting in the middle of it.
        const numeric = /^[0-9]+$/.test(word);
        if (!numeric && CONNECTORS.indexOf(word) === -1)
            return -1;
        crossed += 1;
        i -= 1;
    }
    return -1;
}
/**
 * The index of a negator sitting inside the window in front of `at`, or -1.
 *
 * The INDEX is returned rather than a boolean so the echoed phrase can start at
 * the negator. An echo reading `understood "use the fleet" as backend inline`
 * would be unreadable; `understood "dont use the fleet" as backend inline` is
 * the sentence the person actually typed.
 */
function negatorIndex(tokens, at) {
    const from = at - NEGATION_WINDOW < 0 ? 0 : at - NEGATION_WINDOW;
    for (let i = from; i < at; i += 1) {
        if (NEGATORS.indexOf(tokens[i]) !== -1)
            return i;
    }
    return -1;
}
// ─── The matcher ──────────────────────────────────────────────────────────────
/**
 * Read a sentence as a backend request.
 *
 * Returns `ok: false` only for a CONTRADICTION, which is a decision the caller
 * must refuse. Unreadable text and text with no request both return `ok: true`
 * with a null backend: a sentence that says nothing about backends is not an
 * error, it is the ordinary case.
 */
function detectBackendIntent(text) {
    const counters = zeroCounters();
    const result = {
        ok: true,
        backend: null,
        phrase: null,
        code: INTENT_CODES.NONE,
        reason: 'the invocation text asked for no particular backend',
        matches: [],
        counters,
    };
    const tokens = tokenize(text);
    if (tokens.length === 0) {
        result.code = INTENT_CODES.UNREADABLE;
        result.reason = 'the invocation text carried no readable words';
        return result;
    }
    counters.texts = 1;
    const groups = [
        { objects: FLEET_STANDALONE_OBJECTS, backend: BACKEND_FLEET, led: false },
        { objects: INLINE_STANDALONE_OBJECTS, backend: BACKEND_INLINE, led: false },
        { objects: FLEET_LED_OBJECTS, backend: BACKEND_FLEET, led: true },
        { objects: INLINE_LED_OBJECTS, backend: BACKEND_INLINE, led: true },
    ];
    // Positions already spoken for, so "without the fleet" is not also read as a
    // bare "the fleet" sitting somewhere with no lead.
    const claimed = new Array(tokens.length).fill(false);
    for (const group of groups) {
        for (const pattern of group.objects) {
            counters.candidates += 1;
            for (let i = 0; i < tokens.length; i += 1) {
                if (!patternAt(tokens, i, pattern))
                    continue;
                let overlaps = false;
                for (let k = 0; k < pattern.length; k += 1) {
                    if (claimed[i + k] === true)
                        overlaps = true;
                }
                if (overlaps)
                    continue;
                let start = i;
                if (group.led) {
                    const lead = findLead(tokens, i);
                    if (lead === -1)
                        continue;
                    start = lead;
                }
                const negator = negatorIndex(tokens, start);
                const negated = negator !== -1;
                let backend = group.backend;
                if (negated) {
                    counters.negations += 1;
                    // Only a fleet request flips. See the module note: guessing the
                    // opposite of a refused inline is a wrong dispatch waiting to happen.
                    if (backend === BACKEND_FLEET) {
                        backend = BACKEND_INLINE;
                        start = negator;
                    }
                    else {
                        continue;
                    }
                }
                for (let k = start; k < i + pattern.length; k += 1)
                    claimed[k] = true;
                const phrase = tokens.slice(start, i + pattern.length).join(' ');
                result.matches.push({ backend, phrase, negated });
                if (backend === BACKEND_FLEET)
                    counters.fleet_matches += 1;
                else
                    counters.inline_matches += 1;
            }
        }
    }
    if (counters.fleet_matches > 0 && counters.inline_matches > 0) {
        result.ok = false;
        result.backend = null;
        result.phrase = null;
        result.code = INTENT_CODES.CONFLICT;
        result.reason =
            'the invocation text asked for both backends ('
                + result.matches.map((m) => '"' + m.phrase + '" as ' + m.backend).join(' and ')
                + '), which is 2 contradictory decisions rather than 1';
        return result;
    }
    if (counters.fleet_matches === 0 && counters.inline_matches === 0) {
        return result;
    }
    const first = result.matches[0];
    result.backend = first.backend;
    result.phrase = first.phrase;
    result.code = first.backend === BACKEND_FLEET ? INTENT_CODES.FLEET : INTENT_CODES.INLINE;
    result.reason = 'the invocation text asked for the ' + first.backend
        + ' backend with the phrase "' + first.phrase + '"';
    return result;
}
module.exports = {
    detectBackendIntent,
    tokenize,
    INTENT_CODES,
    LEADS,
    CONNECTORS,
    NEGATORS,
    MAX_CONNECTORS,
    NEGATION_WINDOW,
    FLEET_LED_OBJECTS,
    FLEET_STANDALONE_OBJECTS,
    INLINE_LED_OBJECTS,
    INLINE_STANDALONE_OBJECTS,
    BACKEND_FLEET,
    BACKEND_INLINE,
};
