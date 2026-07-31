"use strict";
/**
 * Execution backend switch : the PRECEDENCE layer for `/ferrox-execute-phase`.
 *
 * Phase 21. `detectWorkflowBackend` / `detectFleetBackend` in
 * `claude-orchestration.cjs` already answer 1 question: CAN the fleet backend
 * run here. That resolver is the authority on availability and this module never
 * reimplements it. This module answers a different question: WHO decided, and
 * what happens when the decision cannot be honored.
 *
 * Precedence, highest first:
 *
 *   1. flag            an explicit `--fleet` or `--inline` on the invocation.
 *   2. language        the backend a person asked for IN WORDS, read out of the
 *                      invocation text by `backend-intent.cjs`. "build it with
 *                      the ferrox fleet" is the primary interface; the flag is
 *                      the machine surface underneath it.
 *   3. config          `claude_orchestration.execution_backend` in
 *                      `.planning/config.json`, when it names a backend this
 *                      switch understands.
 *   4. recommendation  the parallelism verdict's pick, supplied by the caller.
 *   5. default         inline, with the reason the recommendation was not usable.
 *
 * THE ASYMMETRY IS THE POINT:
 *
 *   - An explicit `--fleet` that cannot be honored REFUSES with a non zero exit
 *     and names why. A person made a decision; running inline behind their back
 *     would be lying to them.
 *   - AN INFERRED FLEET REFUSES THE SAME WAY. A person who typed "use the
 *     ferrox fleet" decided just as much as a person who typed `--fleet`, and
 *     falling back after that sentence would be lying to them in plainer
 *     English. `isExplicitDecision` is the 1 predicate that says which levels
 *     count as a person deciding.
 *   - A CONFIG default that cannot be honored FALLS BACK to inline and says so
 *     loudly on stderr. A configuration value must never break an unattended
 *     build. Config is the ONLY level that falls back.
 *   - `--inline` always succeeds. Inline is always available.
 *   - No path is ever silent. Every outcome names the resolved backend, the
 *     reason, and which precedence level decided it.
 *
 * AN INFERENCE IS ALWAYS ECHOED. A backend resolved from words emits a notice
 * naming the phrase that triggered it and how to override it, BEFORE anything
 * runs. A silent inference is strictly worse than a flag, because the reader
 * cannot see that it was made.
 *
 * `--fleet` and `--inline` together is a REFUSAL, not last flag wins. Two
 * contradictory explicit decisions are not a decision. A sentence carrying both
 * directions refuses through THE SAME RUNG rather than a second one built beside
 * it, which is why both arrive at `readExplicitDecision` and leave through 1
 * refusal block.
 *
 * THE CONSUMER GAP, CLOSED AND STILL REPORTED. FF-B379 recorded that the fleet
 * dispatch manifest emitted by `emit-workflow --backend fleet` had NO CONSUMER:
 * nothing read it and spawned worker processes, so a resolution of `fleet` did
 * not fan out. `scripts/fleet-dispatch.cjs` is that consumer and it now ships,
 * which is why this module no longer names a backlog id on the happy path.
 *
 * The REPORT survives, because a tree can still be missing it. An install carrying
 * no `CONSUMER_ENTRYPOINT`, or carrying a module that declares some other manifest
 * kind, has no way to fan out, and this module then names THAT, by entry point,
 * and executes inline. A run that silently executed inline while reporting fleet
 * is the exact defect this project exists to prevent, and so is a run that reports
 * a fleet because a resolver said the word.
 *
 * THIS MODULE NEVER CLAIMS A FLEET RAN. It resolves a backend. Whether workers
 * were actually spawned is decided by the consumer, from observed worker counts,
 * and is reported there. Resolution is not execution.
 *
 * PROVIDERS, not values. Availability detection, config reads, the verdict and
 * the consumer observation are all side effecting. They are injected as
 * functions and are invoked ONLY after the flags validate, so a contradictory
 * invocation refuses having probed nothing. `counters.probes` reports how many
 * provider calls a resolution actually made, so that ordering is asserted rather
 * than asserted about.
 *
 * Counters, never flags. Every result carries integer counters. A boolean saying
 * "fell back" is satisfied by an implementation that reports a fallback and does
 * nothing; a count of 1 fallback alongside an executed backend of inline is not.
 *
 * Zero third party dependencies. Never throws on bad input.
 */
// ─── Constants ────────────────────────────────────────────────────────────────
/** The 2 backends this switch resolves between. */
const BACKEND_FLEET = 'fleet';
const BACKEND_INLINE = 'inline';
/** The literal tokens accepted on an invocation. */
const FLAG_FLEET = '--fleet';
const FLAG_INLINE = '--inline';
/** The precedence levels, named once so callers and tests agree. */
const PRECEDENCE = Object.freeze({
    FLAG: 'flag',
    LANGUAGE: 'language',
    CONFIG: 'config',
    RECOMMENDATION: 'recommendation',
    DEFAULT: 'default',
    NONE: 'none',
});
/**
 * The precedence levels at which A PERSON DECIDED. These are the levels that
 * refuse rather than fall back when the fleet cannot run. Named once, as 1
 * predicate, so the refusal branch and every caller reading this file agree on
 * which levels are a decision and which are a default.
 */
function isExplicitDecision(precedence) {
    return precedence === PRECEDENCE.FLAG || precedence === PRECEDENCE.LANGUAGE;
}
/**
 * WHERE THE DISPATCH MANIFEST CONSUMER LIVES, declared once.
 *
 * The caller observes the consumer at this path and this module names it in the
 * line a person reads when the observation comes back empty. One declaration, so
 * the place the observer looks and the place the message tells you to look cannot
 * drift apart. A message naming a path nobody checks is worse than no message.
 */
const CONSUMER_ENTRYPOINT = 'scripts/fleet-dispatch.cjs';
/** Exit code for a refusal. Distinct from 1, which is any other failure. */
const REFUSAL_EXIT_CODE = 2;
/** Closed set of outcome codes. */
const SWITCH_CODES = Object.freeze({
    INVALID_ARGV: 'invalid_argv',
    CONFLICTING_FLAGS: 'conflicting_backend_flags',
    CONFLICTING_LANGUAGE: 'conflicting_backend_language',
    LANGUAGE_INTENT: 'backend_read_from_language',
    LANGUAGE_OVERRIDDEN: 'language_overridden_by_flag',
    INLINE_REQUESTED: 'inline_requested',
    FLEET_ACTIVE: 'fleet_active',
    FLEET_CONSUMER_MISSING: 'fleet_consumer_missing',
    FLEET_UNAVAILABLE_REFUSED: 'fleet_unavailable_refused',
    FLEET_UNAVAILABLE_FALLBACK: 'fleet_unavailable_fallback',
});
/** Notice levels. */
const LEVEL_ERROR = 'error';
const LEVEL_WARN = 'warn';
const LEVEL_INFO = 'info';
// ─── Flag parsing ─────────────────────────────────────────────────────────────
/**
 * Parse the 2 backend tokens out of an invocation.
 *
 * An unrecognised token is IGNORED: this parser owns 2 tokens and nothing else,
 * and `/ferrox-execute-phase` carries several other flags that are none of its
 * business. Both tokens present is a refusal. A repeated token is not, because
 * `--fleet --fleet` is 1 unambiguous decision stated twice.
 */
function parseBackendFlags(argv) {
    if (!Array.isArray(argv)) {
        return {
            ok: false,
            flag: null,
            code: SWITCH_CODES.INVALID_ARGV,
            reason: 'the invocation could not be read as a list of arguments',
            seen: [],
        };
    }
    const seen = [];
    let wantsFleet = false;
    let wantsInline = false;
    for (const raw of argv) {
        if (typeof raw !== 'string')
            continue;
        const token = raw.trim();
        if (token === FLAG_FLEET) {
            wantsFleet = true;
            seen.push(FLAG_FLEET);
        }
        else if (token === FLAG_INLINE) {
            wantsInline = true;
            seen.push(FLAG_INLINE);
        }
    }
    if (wantsFleet && wantsInline) {
        return {
            ok: false,
            flag: null,
            code: SWITCH_CODES.CONFLICTING_FLAGS,
            reason: FLAG_FLEET + ' and ' + FLAG_INLINE + ' were both given. That is 2 '
                + 'contradictory explicit decisions rather than 1, so this run refuses '
                + 'instead of picking the later token and calling it your intent',
            seen,
        };
    }
    return {
        ok: true,
        flag: wantsFleet ? BACKEND_FLEET : (wantsInline ? BACKEND_INLINE : null),
        code: 'flags_ok',
        reason: 'flags parsed',
        seen,
    };
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function zeroCounters() {
    return {
        decisions: 0, refusals: 0, fallbacks: 0, consumer_gaps: 0, notices: 0, probes: 0,
        inferences: 0, overrides: 0,
    };
}
function pushNotice(result, level, code, text) {
    result.notices.push({ level, code, text });
    result.counters.notices += 1;
}
/** A provider that is absent or not a function contributes nothing and costs no probe. */
function callProvider(providers, name, counters, fallback) {
    const fn = providers[name];
    if (typeof fn !== 'function')
        return fallback;
    counters.probes += 1;
    try {
        return fn();
    }
    catch {
        return fallback;
    }
}
/** Normalise a detect result into { fleetAvailable, reason }. */
function readDetect(value) {
    if (value === null || value === undefined || typeof value !== 'object') {
        return { fleetAvailable: false, reason: 'detector_unavailable' };
    }
    const d = value;
    const reason = typeof d.reason === 'string' && d.reason.length > 0 ? d.reason : 'unknown';
    const fleetAvailable = d.available === true && d.backend === BACKEND_FLEET;
    return { fleetAvailable, reason };
}
/** Normalise a recommendation into { backend, reason } or a named unavailability. */
function readRecommendation(value) {
    if (value === null || value === undefined || typeof value !== 'object') {
        return { backend: null, reason: 'recommendation_unavailable:absent' };
    }
    const r = value;
    const reason = typeof r.reason === 'string' && r.reason.length > 0 ? r.reason : 'unknown';
    if (r.available !== true) {
        return { backend: null, reason: 'recommendation_unavailable:' + reason };
    }
    if (r.backend !== BACKEND_FLEET && r.backend !== BACKEND_INLINE) {
        return { backend: null, reason: 'recommendation_unavailable:unrecognised_backend' };
    }
    return { backend: r.backend, reason };
}
/** Normalise whatever the caller passed as an intent into a usable shape. */
function readIntent(value) {
    if (value === null || value === undefined || typeof value !== 'object') {
        return { ok: true, backend: null, phrase: null, reason: 'no_intent_supplied' };
    }
    const v = value;
    const reason = typeof v.reason === 'string' && v.reason.length > 0 ? v.reason : 'unknown';
    if (v.ok === false) {
        return { ok: false, backend: null, phrase: null, reason };
    }
    if (v.backend !== BACKEND_FLEET && v.backend !== BACKEND_INLINE) {
        return { ok: true, backend: null, phrase: null, reason };
    }
    const phrase = typeof v.phrase === 'string' && v.phrase.length > 0 ? v.phrase : null;
    return { ok: true, backend: v.backend, phrase, reason };
}
/**
 * Fold the flag and the sentence into 1 decision, so both leave through ONE
 * refusal rung rather than 2 that can drift apart.
 *
 * A flag beats a sentence. When they disagree the flag is followed and the
 * sentence is reported as overridden rather than dropped, because a person who
 * typed both should be told which one this run obeyed.
 */
function readExplicitDecision(flags, intent) {
    const none = {
        ok: true, backend: null, precedence: null, phrase: null,
        code: 'decision_ok', reason: 'no explicit decision was made', overriddenBackend: null,
    };
    if (!flags.ok) {
        return {
            ...none, ok: false, code: flags.code, reason: flags.reason,
        };
    }
    const lang = readIntent(intent);
    if (!lang.ok) {
        return {
            ...none, ok: false, code: SWITCH_CODES.CONFLICTING_LANGUAGE, reason: lang.reason,
        };
    }
    if (flags.flag !== null) {
        return {
            ...none,
            backend: flags.flag,
            precedence: PRECEDENCE.FLAG,
            overriddenBackend: (lang.backend !== null && lang.backend !== flags.flag) ? lang.backend : null,
            phrase: lang.phrase,
        };
    }
    if (lang.backend !== null) {
        return {
            ...none,
            backend: lang.backend,
            precedence: PRECEDENCE.LANGUAGE,
            phrase: lang.phrase,
        };
    }
    return none;
}
// ─── The resolver ─────────────────────────────────────────────────────────────
/**
 * Resolve which execution backend a `/ferrox-execute-phase` run uses.
 *
 * Providers are invoked lazily and only after the flags validate, so a
 * contradictory invocation refuses having observed nothing. `counters.probes` is
 * the receipt for that ordering.
 */
function resolveExecutionBackend(argv, providers, intent) {
    const p = (providers !== null && providers !== undefined && typeof providers === 'object')
        ? providers
        : {};
    const result = {
        ok: true,
        refused: false,
        exit_code: 0,
        requested_backend: null,
        precedence: PRECEDENCE.NONE,
        resolved_backend: null,
        executed_backend: null,
        code: '',
        reason: '',
        detail: null,
        notices: [],
        counters: zeroCounters(),
    };
    // VALIDATE BEFORE SIDE EFFECTS. Nothing below this block is probed until the
    // invocation itself is coherent.
    const flags = parseBackendFlags(argv);
    const decision = readExplicitDecision(flags, intent);
    result.counters.decisions = 1;
    if (!decision.ok) {
        result.ok = false;
        result.refused = true;
        result.exit_code = REFUSAL_EXIT_CODE;
        result.code = decision.code;
        result.reason = decision.reason;
        result.counters.refusals = 1;
        pushNotice(result, LEVEL_ERROR, decision.code, 'REFUSING: ' + decision.reason + '. Nothing was executed.');
        return result;
    }
    // The phrase a sentence was read from, kept for the refusal line and the echo.
    const phrase = decision.phrase;
    // ── Precedence levels 1 and 2: the flag, then the sentence. ──
    let requested = decision.backend;
    if (requested !== null) {
        result.precedence = decision.precedence;
        if (result.precedence === PRECEDENCE.LANGUAGE) {
            // ECHO BEFORE ACTING. A silent inference is worse than a flag.
            result.counters.inferences = 1;
            pushNotice(result, LEVEL_INFO, SWITCH_CODES.LANGUAGE_INTENT, 'understood "' + String(phrase) + '" as backend ' + requested + '. Say '
                + (requested === BACKEND_FLEET ? FLAG_INLINE + ' or "run it inline"' : FLAG_FLEET + ' or "use the fleet"')
                + ' to override.');
        }
        if (decision.overriddenBackend !== null) {
            result.counters.overrides = 1;
            pushNotice(result, LEVEL_WARN, SWITCH_CODES.LANGUAGE_OVERRIDDEN, 'the words "' + String(phrase) + '" asked for backend ' + decision.overriddenBackend
                + ' and the flag asked for backend ' + requested
                + '. Following the flag, because a flag is unambiguous and a sentence is read.');
        }
    }
    else {
        // ── Precedence level 3: the config default. ──
        const cfgRaw = callProvider(p, 'configBackend', result.counters, undefined);
        if (cfgRaw === BACKEND_FLEET || cfgRaw === BACKEND_INLINE) {
            requested = cfgRaw;
            result.precedence = PRECEDENCE.CONFIG;
        }
        else {
            // ── Precedence level 4: the recommendation. ──
            const rec = readRecommendation(callProvider(p, 'recommend', result.counters, null));
            if (rec.backend !== null) {
                requested = rec.backend;
                result.precedence = PRECEDENCE.RECOMMENDATION;
                result.detail = rec.reason;
            }
            else {
                // ── Precedence level 5: the default, naming why level 4 was unusable. ──
                requested = BACKEND_INLINE;
                result.precedence = PRECEDENCE.DEFAULT;
                result.detail = rec.reason;
                pushNotice(result, LEVEL_INFO, 'recommendation_unavailable', 'no backend flag and no usable config default or recommendation ('
                    + rec.reason + '), so this run defaults to inline.');
            }
        }
    }
    result.requested_backend = requested;
    // ── Inline always succeeds. ──
    if (requested === BACKEND_INLINE) {
        result.resolved_backend = BACKEND_INLINE;
        result.executed_backend = BACKEND_INLINE;
        result.code = SWITCH_CODES.INLINE_REQUESTED;
        result.reason = 'inline backend selected by the ' + result.precedence + ' precedence level';
        pushNotice(result, LEVEL_INFO, SWITCH_CODES.INLINE_REQUESTED, 'executing inline (' + result.precedence + ').');
        return result;
    }
    // ── Fleet was requested. Ask the authority whether it can run. ──
    const detect = readDetect(callProvider(p, 'detect', result.counters, null));
    result.detail = detect.reason;
    if (!detect.fleetAvailable) {
        if (isExplicitDecision(result.precedence)) {
            // An explicit decision that cannot be honored REFUSES. A sentence counts as
            // an explicit decision: a person who typed "use the ferrox fleet" decided.
            const asked = result.precedence === PRECEDENCE.FLAG
                ? FLAG_FLEET
                : 'the fleet in words ("' + String(phrase) + '")';
            result.ok = false;
            result.refused = true;
            result.exit_code = REFUSAL_EXIT_CODE;
            result.resolved_backend = null;
            result.executed_backend = null;
            result.code = SWITCH_CODES.FLEET_UNAVAILABLE_REFUSED;
            result.reason =
                asked + ' was requested explicitly and the fleet backend is not available ('
                    + detect.reason + ')';
            result.counters.refusals = 1;
            const escape = result.precedence === PRECEDENCE.FLAG
                ? 'Run without ' + FLAG_FLEET + ', or with ' + FLAG_INLINE + ', to execute inline.'
                : 'Say ' + FLAG_INLINE + ', or "run it inline", to execute inline.';
            pushNotice(result, LEVEL_ERROR, SWITCH_CODES.FLEET_UNAVAILABLE_REFUSED, 'REFUSING: ' + result.reason + '. Nothing was executed. ' + escape);
            return result;
        }
        // A configured or recommended default that cannot be honored FALLS BACK, loudly.
        result.resolved_backend = BACKEND_INLINE;
        result.executed_backend = BACKEND_INLINE;
        result.code = SWITCH_CODES.FLEET_UNAVAILABLE_FALLBACK;
        result.reason =
            'the ' + result.precedence + ' precedence level asked for the fleet backend, it is not '
                + 'available (' + detect.reason + '), so this run executes inline';
        result.counters.fallbacks = 1;
        pushNotice(result, LEVEL_WARN, SWITCH_CODES.FLEET_UNAVAILABLE_FALLBACK, 'FALLING BACK: ' + result.reason + '. Pass ' + FLAG_FLEET + ' to make this a refusal instead.');
        return result;
    }
    // ── Fleet is genuinely available. Is there a consumer to dispatch through. ──
    result.resolved_backend = BACKEND_FLEET;
    const consumerPresent = callProvider(p, 'consumerPresent', result.counters, false) === true;
    if (!consumerPresent) {
        result.executed_backend = BACKEND_INLINE;
        result.code = SWITCH_CODES.FLEET_CONSUMER_MISSING;
        result.reason = 'fleet backend resolved, no dispatch manifest consumer is installed in this '
            + 'tree (' + CONSUMER_ENTRYPOINT + ' is absent or declares a different manifest kind), '
            + 'executing inline';
        result.counters.consumer_gaps = 1;
        pushNotice(result, LEVEL_WARN, SWITCH_CODES.FLEET_CONSUMER_MISSING, result.reason);
        return result;
    }
    result.executed_backend = BACKEND_FLEET;
    result.code = SWITCH_CODES.FLEET_ACTIVE;
    result.reason = 'fleet backend selected by the ' + result.precedence + ' precedence level and active ('
        + detect.reason + ')';
    // NOT "executing as a fleet". This module resolved a backend; it spawned
    // nothing and counted nothing. The consumer named here is what dispatches, and
    // the fleet claim belongs to it, decided from observed worker counts.
    pushNotice(result, LEVEL_INFO, SWITCH_CODES.FLEET_ACTIVE, 'dispatching through ' + CONSUMER_ENTRYPOINT + ' (' + result.precedence + '). Whether this '
        + 'run is a fleet run is reported by the consumer from observed worker counts, never here.');
    return result;
}
/**
 * Render the 1 line a person reads. Every outcome names the executed backend,
 * the precedence level that decided it, and the reason.
 */
function formatDecisionLine(result) {
    if (result === null || result === undefined || typeof result !== 'object') {
        return 'execution backend: unknown (no result)';
    }
    const executed = result.executed_backend === null ? 'nothing' : result.executed_backend;
    return 'execution backend: ' + executed
        + ' | decided by: ' + result.precedence
        + ' | requested: ' + (result.requested_backend === null ? 'none' : result.requested_backend)
        + ' | reason: ' + result.code
        + (result.detail === null ? '' : ' (' + result.detail + ')');
}
module.exports = {
    parseBackendFlags,
    readExplicitDecision,
    isExplicitDecision,
    resolveExecutionBackend,
    formatDecisionLine,
    BACKEND_FLEET,
    BACKEND_INLINE,
    FLAG_FLEET,
    FLAG_INLINE,
    PRECEDENCE,
    SWITCH_CODES,
    CONSUMER_ENTRYPOINT,
    REFUSAL_EXIT_CODE,
};
