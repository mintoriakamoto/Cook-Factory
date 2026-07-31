"use strict";
/**
 * The anti-loop gate core (phase 15, D4 / D5 / D6 / D8).
 *
 * A PURE, hermetic fold over the append-only event log written by
 * `src/antiloop-log.cts`. It derives the review budget and the round count for a
 * reviewed pair, refuses to open an unbudgeted gate, and refuses to let an
 * unreproducible finding be marked blocking. Callers pass the already-read event
 * array in; this module reads no file, no clock, no process and no network, and
 * imports no other module at all. That contract is what makes the phase 15
 * mutation battery fast and deterministic, and it is the same contract
 * `src/governance-manifest.cts:30-33` states.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * On 2026-07-25 all 4 anti-loop mechanisms in this repo were prose, and they
 * failed to stop a live loop in this very tree. The plans converged 4 blockers
 * to 1 to 0, 3 more reviewer lineages were then added, the count went back above
 * 20, and a re-plan was proposed. Three specific defeats, and each has a function
 * below that closes it:
 *
 *   1. There was always room for 1 more auditor, because no review budget was
 *      ever declared. Nothing could be spent because nothing was allocated.
 *   2. The round counter was scoped to the GATE INSTANCE, so internal rounds 1 to
 *      3 followed by a freshly named cross-audit read as round 1 again. Renaming
 *      the gate reset the count.
 *   3. The severity floor did not help, because the findings were genuinely HIGH.
 *      Severity is the wrong question. Whether the finding carries a command that
 *      fails right now is the right one.
 *
 * D4 states the consequence: a rule an agent can read and then not follow is not
 * a mechanism. If it is not enforced by an artifact that fails closed, it does
 * not count as delivered.
 *
 * ---------------------------------------------------------------------------
 * THE 3 RULES, AS THE FUNCTIONS THAT ENFORCE THEM
 * ---------------------------------------------------------------------------
 *   RULE 1, a gate with no declared budget cannot open.
 *     `normalizeBudget` plus `evaluateGateOpen`. An absent, non-numeric,
 *     negative, fractional or infinite allowance collapses to an allowance of 0
 *     and reports E_LOOP_BUDGET_UNDECLARED. It never collapses to a fallback.
 *   RULE 2, counters bind to the pair (artifact, question), never to the gate.
 *     `counterKey` plus `foldAntiloopEvents`. The count is DERIVED by folding and
 *     is never a parameter.
 *   RULE 3, a finding with an empty reproducible field cannot be blocking.
 *     `evaluateFindingBlocking`, which takes no severity parameter at all.
 *
 * ---------------------------------------------------------------------------
 * THE COMPOSITION WITH THE STRENGTH GATE (D8, stated so nobody has to infer it)
 * ---------------------------------------------------------------------------
 * The 2 gates answer 2 different questions and neither supersedes the other.
 *
 * The strength gate at `src/strength-severity-route.cts` asks whether a finding
 * may be DEFERRED to the backlog. For a security-category finding the answer is
 * no, at any severity. That is requirement STRONG-04, it returns a block decision
 * with the reason security-never-backlog at `src/strength-severity-route.cts:77-81`,
 * and this phase does not touch it.
 *
 * This module asks whether a review round may BLOCK further progress. The answer
 * is only when the finding carries a command that failed at the moment it was
 * filed. Severity buys nothing here, in either direction.
 *
 * The concrete consequence, implemented by `evaluateBudgetSpentDisposition`: when
 * a budget is spent the disposition sweeps the remaining findings into backlog
 * rows regardless of severity, and that sweep MUST NOT swallow a
 * security-category finding. A remaining security finding resolves the pair to
 * escalate-to-human instead, so the review still closes and no further round is
 * granted, while the security finding reaches a human rather than a backlog row.
 * Rule 3 is unweakened by this: that same finding is still not blocking. Closing
 * the review and escalating 1 finding are different acts.
 *
 * The security category set is an EXPLICIT input, taken the way
 * `src/strength-severity-route.cts:17-18` takes it. It is never re-derived here.
 *
 * ADR-457 build-at-publish: this TS source compiles to the artifact
 * ferrox-core/bin/lib/antiloop-gate.cjs, which is TRACKED and committed. CJS
 * module shape (`export =`). The module owns NO stdout; plan 04's checker script
 * owns CLI output and turns these decisions into a non-zero exit.
 */
/**
 * The terminal outcome vocabulary, mirroring the shipped set at
 * `src/gate-cap.cts:24-32` (VALID_CAP_OUTCOMES). Do not invent a fourth member.
 *
 * These are MIRRORED rather than imported on purpose. Importing the gate-cap lib
 * would drag the halting log and its filesystem module into this module's import
 * graph and destroy the hermetic contract stated in the header. A comment
 * claiming agreement rots, so the agreement is pinned by a committed test that
 * loads BOTH built libs and asserts set equality. Divergence is a test failure,
 * not a stale comment.
 */
const ANTILOOP_TERMINAL_OUTCOMES = Object.freeze([
    'ship-with-backlog',
    'stop-and-rescope',
    'escalate-to-human',
]);
/**
 * The error codes this module emits, frozen so plan 04's gate formats them
 * without re-declaring the strings. Vocabulary shape copied from
 * `src/governance-manifest.cts` (E_<AREA>_<REASON>).
 */
const ANTILOOP_ERROR_CODES = Object.freeze({
    BUDGET_UNDECLARED: 'E_LOOP_BUDGET_UNDECLARED',
    BUDGET_SPENT: 'E_LOOP_BUDGET_SPENT',
    UNREPRODUCIBLE_BLOCKING: 'E_LOOP_UNREPRODUCIBLE_BLOCKING',
});
/** The 4 event kinds the fold understands. Anything else is counted, not thrown. */
const KNOWN_EVENT_KINDS = new Set([
    'budget-declared',
    'round-opened',
    'round-closed',
    'finding-filed',
]);
// ----------------------------------------------------------------------------
// Normalization and the counter key (RULE 2)
// ----------------------------------------------------------------------------
/**
 * Trim, collapse inner whitespace, drop control characters, lower-case. A
 * non-string collapses to the empty string. Same fail-soft shape as
 * `src/strength-severity-route.cts:46-48`, extended to strip control characters
 * so the key separator below cannot be smuggled into a key half.
 */
function norm(v) {
    if (typeof v !== 'string')
        return '';
    return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
/**
 * The key separator. It cannot occur in either half after `norm`, which strips
 * every control character, so 2 different pairs can never collide.
 */
const KEY_SEPARATOR = '\u0000';
/**
 * RULE 2, and it is the whole mechanism. The key reads `artifact` and `question`
 * and nothing else.
 *
 * `gate` and `lineage` live on the events as PROVENANCE, so a human can see
 * which gate and which reviewer produced a round. They are structurally unable to
 * reach this key: there is no parameter for them and no branch that reads them.
 * That is what makes internal rounds 1 to 3 followed by a cross-audit round 1
 * read as round 4. A gate rename and a lineage swap are no-ops here BY
 * CONSTRUCTION rather than by discipline, which is the difference between this
 * and the prose mechanism that failed on 2026-07-25.
 *
 * Contrast `src/gate-cap.cts:53`, where the budget is keyed on the gate id. That
 * is precisely the gate-instance binding D5 rule 2 forbids.
 */
function counterKey(input) {
    const artifact = norm(input ? input.artifact : undefined);
    const question = norm(input ? input.question : undefined);
    return artifact + KEY_SEPARATOR + question;
}
/** A usable allowance is a finite non-negative integer. Everything else is null. */
function allowanceOrNull(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}
/**
 * RULE 1, fail-CLOSED. This is the shape of `normalizeCapOutcome` at
 * `src/gate-cap.cts:34-45` applied one level up: there, any value outside the
 * enum collapses to the safe terminal default; here, any allowance that is
 * missing, non-numeric, negative, fractional, infinite or not a number collapses
 * to 0 and the budget is reported UNDECLARED.
 *
 * It must NOT collapse to a fallback allowance. `src/gate-command-router.cts:6-8`
 * supplies a fallback of 3 passes when the gate config is absent, and the phase
 * 15 pattern map names that as 1 of the 3 fatal gaps against D5: a silent
 * fallback is an undeclared budget wearing a number. Here an undeclared budget
 * refuses the gate instead.
 *
 * Both allowances are required. A budget that states rounds but not lineages has
 * not bounded the loop, because adding a reviewer would then be unbounded.
 */
function normalizeBudget(raw) {
    const src = raw !== null && typeof raw === 'object' ? raw : null;
    const rounds = allowanceOrNull(src === null ? undefined : src.max_rounds);
    const lineages = allowanceOrNull(src === null ? undefined : src.max_lineages);
    if (rounds === null || lineages === null) {
        return { declared: false, max_rounds: 0, max_lineages: 0 };
    }
    return { declared: true, max_rounds: rounds, max_lineages: lineages };
}
// ----------------------------------------------------------------------------
// The fold
// ----------------------------------------------------------------------------
function emptyPairState(key, artifact, question) {
    return {
        key,
        artifact,
        question,
        budget: { declared: false, max_rounds: 0, max_lineages: 0 },
        budget_event_index: -1,
        first_round_index: -1,
        rounds: 0,
        rounds_closed: 0,
        lineages: new Set(),
        findings: [],
        ignored_kinds: [],
    };
}
/**
 * PURE. Fold an event array into a map from counter key to the derived state of
 * that pair. An empty array yields an empty map.
 *
 * An unknown event kind is IGNORED rather than thrown, so a future event kind
 * does not break an old fold, but it is recorded on the pair's `ignored_kinds`
 * so an unknown kind is visible rather than silent.
 *
 * The FIRST budget declaration for a pair wins. A later one cannot raise the
 * allowance, because a re-declaration mid-review is the same loop-extending move
 * as a rename and rule 1 would be worth nothing if it were permitted.
 */
function foldAntiloopEvents(events) {
    const list = Array.isArray(events) ? events : [];
    const pairs = new Map();
    for (let i = 0; i < list.length; i++) {
        const ev = list[i] !== null && typeof list[i] === 'object' ? list[i] : {};
        const key = counterKey(ev);
        let state = pairs.get(key);
        if (state === undefined) {
            state = emptyPairState(key, norm(ev.artifact), norm(ev.question));
            pairs.set(key, state);
        }
        const kind = norm(ev.kind);
        if (!KNOWN_EVENT_KINDS.has(kind)) {
            state.ignored_kinds.push(typeof ev.kind === 'string' ? ev.kind : String(ev.kind));
            continue;
        }
        if (kind === 'budget-declared') {
            if (state.budget_event_index === -1) {
                state.budget_event_index = i;
                state.budget = normalizeBudget(ev);
            }
            continue;
        }
        if (kind === 'round-opened') {
            if (state.first_round_index === -1)
                state.first_round_index = i;
            state.rounds += 1;
            const lineage = norm(ev.lineage);
            if (lineage !== '')
                state.lineages.add(lineage);
            continue;
        }
        if (kind === 'round-closed') {
            state.rounds_closed += 1;
            continue;
        }
        state.findings.push(ev);
    }
    return pairs;
}
// ----------------------------------------------------------------------------
// RULE 1 and RULE 2 together: may this gate open?
// ----------------------------------------------------------------------------
/**
 * PURE. Decide whether a review round may open for a pair.
 *
 * The round count and the distinct lineage count are DERIVED here by folding the
 * events. Neither is a parameter, which is the single most important difference
 * from `src/gate-cap.cts:55`, where the pass count arrives as a caller-supplied
 * scalar and whoever calls can pass 0.
 *
 *   - No budget event for the pair, a malformed budget, or a budget declared
 *     AFTER the first round already ran: refuse, E_LOOP_BUDGET_UNDECLARED. The
 *     late case matters because a budget written once rounds are underway is a
 *     number chosen to fit the rounds already spent.
 *   - The derived round count has reached the declared round allowance, or the
 *     derived distinct lineage count has reached the declared lineage allowance:
 *     the review closes, E_LOOP_BUDGET_SPENT, outcome ship-with-backlog. Adding a
 *     reviewer lineage therefore cannot buy a round.
 *   - Otherwise the open is permitted.
 */
function evaluateGateOpen(input) {
    const events = input ? input.events : undefined;
    const artifact = input ? input.artifact : undefined;
    const question = input ? input.question : undefined;
    const pairs = foldAntiloopEvents(events);
    const key = counterKey({ artifact, question });
    const state = pairs.get(key);
    const rounds = state === undefined ? 0 : state.rounds;
    const lineages = state === undefined ? 0 : state.lineages.size;
    const budget = state === undefined ? { declared: false, max_rounds: 0, max_lineages: 0 } : state.budget;
    const budgetIsLate = state !== undefined
        && state.budget_event_index !== -1
        && state.first_round_index !== -1
        && state.first_round_index < state.budget_event_index;
    if (!budget.declared || budgetIsLate) {
        return {
            // Fail closed, mirroring the safe default of `src/gate-cap.cts:34-45`.
            decision: 'refuse-open',
            code: ANTILOOP_ERROR_CODES.BUDGET_UNDECLARED,
            outcome: 'stop-and-rescope',
            key,
            rounds,
            lineages,
            max_rounds: budget.max_rounds,
            max_lineages: budget.max_lineages,
            message: budgetIsLate
                ? 'the review budget for this pair was declared after the first round already ran, '
                    + 'so it is a number fitted to the rounds already spent. Declare the budget before '
                    + 'the first round opens.'
                : 'no usable review budget is declared for this pair. Write a budget-declared event '
                    + 'carrying a non-negative integer max_rounds AND max_lineages before the first '
                    + 'round opens. An unbudgeted gate cannot open.',
        };
    }
    if (rounds >= budget.max_rounds || lineages >= budget.max_lineages) {
        return {
            decision: 'close-review',
            code: ANTILOOP_ERROR_CODES.BUDGET_SPENT,
            outcome: 'ship-with-backlog',
            key,
            rounds,
            lineages,
            max_rounds: budget.max_rounds,
            max_lineages: budget.max_lineages,
            message: `the review budget for this pair is spent at ${rounds} of ${budget.max_rounds} rounds `
                + `and ${lineages} of ${budget.max_lineages} lineages. The review closes and every `
                + 'remaining finding becomes a backlog row. Adding a lineage does not buy a round, and '
                + '"try again" is not one of the legal moves.',
        };
    }
    return {
        decision: 'open-ok',
        code: null,
        outcome: null,
        key,
        rounds,
        lineages,
        max_rounds: budget.max_rounds,
        max_lineages: budget.max_lineages,
        message: `round ${rounds + 1} of ${budget.max_rounds} may open for this pair `
            + `(${lineages} of ${budget.max_lineages} lineages used).`,
    };
}
// ----------------------------------------------------------------------------
// RULE 3: may this finding block?
// ----------------------------------------------------------------------------
/**
 * PURE. A finding is eligible to block ONLY when its reproducible field is a
 * non-empty string after trimming AND its observed exit is a non-zero finite
 * number. Anything else is non-blocking, coded E_LOOP_UNREPRODUCIBLE_BLOCKING.
 *
 * THIS FUNCTION TAKES NO SEVERITY PARAMETER, AND THAT ABSENCE IS THE ENFORCEMENT.
 * Rule 3 grants blocking with no severity argument available. A future caller
 * cannot argue its way to blocking on severity because there is nowhere to put
 * one. On 2026-07-25 the severity floor did not stop the loop, because the
 * findings really were HIGH. Severity was never the question.
 *
 * A command that exits 0 does not block either. It did not fail at the moment it
 * was filed, so it is a prediction, and a prediction gets an id and ships past.
 *
 * This does NOT weaken the security gate. See the composition paragraph in the
 * header: `src/strength-severity-route.cts` decides whether a finding may be
 * deferred to the backlog, which is a different question and is unchanged.
 */
function evaluateFindingBlocking(input) {
    const finding = input ? input.finding : undefined;
    const src = finding !== null && typeof finding === 'object' ? finding : {};
    const id = typeof src.finding_id === 'string' && src.finding_id !== '' ? src.finding_id : '<unnamed>';
    const command = typeof src.reproducible === 'string' ? src.reproducible.trim() : '';
    const exit = src.reproducible_exit;
    const observedFailure = typeof exit === 'number' && Number.isFinite(exit) && exit !== 0;
    if (command === '') {
        return {
            blocking: false,
            code: ANTILOOP_ERROR_CODES.UNREPRODUCIBLE_BLOCKING,
            finding_id: id,
            reason: 'no-reproducible-command',
            message: `finding ${id} carries no reproducible command, so it cannot block at any severity. `
                + 'Give it an id, record it as a backlog row, and ship past it.',
        };
    }
    if (!observedFailure) {
        return {
            blocking: false,
            code: ANTILOOP_ERROR_CODES.UNREPRODUCIBLE_BLOCKING,
            finding_id: id,
            reason: 'command-did-not-fail',
            message: `finding ${id} carries a command that did not fail when it was filed, so it is a `
                + 'prediction rather than a reproducible failure. Only a reproducible failure blocks.',
        };
    }
    return {
        blocking: true,
        code: null,
        finding_id: id,
        reason: 'reproducible-failure',
        message: `finding ${id} carries a command that fails now, so it blocks.`,
    };
}
// ----------------------------------------------------------------------------
// D8: what happens to the findings that remain when the budget is spent
// ----------------------------------------------------------------------------
/**
 * PURE. Resolve the terminal outcome for the findings that remain when a review
 * budget is spent.
 *
 * Default: ship-with-backlog. The review closes and every remaining finding
 * becomes a backlog row regardless of severity, which is the D5 rule 1
 * disposition.
 *
 * EXCEPTION, and it is the D8 composition: if any remaining finding's category is
 * in the supplied security set, the outcome is escalate-to-human instead. The
 * review still closes and no further round is granted, but a security finding
 * reaches a human rather than a backlog row. Sweeping it into the backlog would
 * silently invert requirement STRONG-04, which
 * `src/strength-severity-route.cts:77-81` enforces at any severity.
 *
 * Rule 3 is unaffected either way: that same finding is still not blocking unless
 * it carries a command that fails. Relaxing either half is forbidden by D8.
 *
 * `securityCategories` is an EXPLICIT input, matched at lower case, exactly as
 * `src/strength-severity-route.cts:67-69` takes it. Never re-derived here.
 */
function evaluateBudgetSpentDisposition(input) {
    const rawFindings = input ? input.findings : undefined;
    const findings = Array.isArray(rawFindings)
        ? rawFindings
        : [];
    const rawSecurity = input ? input.securityCategories : undefined;
    const securitySet = new Set((Array.isArray(rawSecurity) ? rawSecurity : []).map(norm));
    securitySet.delete(''); // a blank entry must never match a blank category
    const security = [];
    for (const f of findings) {
        const src = f !== null && typeof f === 'object' ? f : {};
        if (securitySet.has(norm(src.category))) {
            security.push(typeof src.finding_id === 'string' ? src.finding_id : '<unnamed>');
        }
    }
    if (security.length > 0) {
        return {
            outcome: 'escalate-to-human',
            reason: 'security-never-backlog',
            remaining: findings.length,
            security_findings: security,
            message: `the review budget is spent and ${security.length} remaining finding(s) carry a security `
                + 'category, so the batch escalates to a human instead of becoming backlog rows. The '
                + 'review still closes and no further round is granted.',
        };
    }
    return {
        outcome: 'ship-with-backlog',
        reason: 'budget-spent',
        remaining: findings.length,
        security_findings: [],
        message: `the review budget is spent; ${findings.length} remaining finding(s) become backlog rows `
            + 'regardless of severity.',
    };
}
// ----------------------------------------------------------------------------
// Reading a budget out of visible human prose
// ----------------------------------------------------------------------------
/**
 * The canonical declaration: 1 bolded sentence naming the words "review budget",
 * then a digit count of rounds with the question those rounds review, followed by
 * a statement about cross-audit lineage.
 *
 * This form was chosen by reading what a human already wrote at
 * `.planning/phases/15-prove-the-premise/CONTEXT.md`, not by inventing a shape,
 * which is the same method `parseScopeDeclaration` used when it was matched to
 * the sentence already present at `.planning/ROADMAP.md` line 3. The bolded body
 * excludes the asterisk character so the match cannot run across an adjacent
 * bolded sentence and pick up a digit that belongs to a different claim.
 */
const BUDGET_SENTENCE = /\*\*([^*]{0,600}?review budget[^*]{0,600}?)\*\*/i;
/** A digit count of rounds, with the question those rounds review when stated. */
const ROUND_ALLOWANCE = /(\d+)\s+(?:[a-z][a-z-]*\s+){0,3}rounds?\b(?:\s+(?:for|per|at|of)\s+([a-z][a-z0-9 -]{0,40}?))?(?=\s*(?:\band\b|[,;.]|$))/gi;
/** "No cross-audit lineage is budgeted." */
const NO_LINEAGE_BUDGETED = /\bno\s+(?:[a-z-]+\s+){0,2}lineages?\s+(?:is|are)\s+budgeted\b/i;
/** "2 cross-audit lineages are budgeted." */
const LINEAGE_ALLOWANCE = /(\d+)\s+(?:[a-z-]+\s+){0,2}lineages?\s+(?:is|are)\s+budgeted\b/i;
/** How far past the bolded sentence the lineage statement may live. */
const LINEAGE_SCAN_CHARS = 400;
/** The result-union error builder, verbatim in shape from `src/governance-manifest.cts:76-89`. */
function err(file, code, message, extra) {
    const e = { ok: false, code, message, file };
    if (extra !== undefined) {
        if (extra.line !== undefined)
            e.line = extra.line;
        if (extra.text !== undefined)
            e.text = extra.text;
    }
    return e;
}
/**
 * PURE. Parse a review budget out of a governance file's prose. Never throws;
 * every failure returns the result-union error shape coded
 * E_LOOP_BUDGET_UNDECLARED, because a budget that cannot be read is a budget that
 * was not declared.
 *
 * `max_rounds` mirrors the FIRST round allowance in the sentence, which is the
 * allowance for the artifact the declaration leads with. Every allowance found is
 * also returned in `allowances` with the question it names, so a caller reviewing
 * a specific question selects its own rather than inferring one.
 *
 * `max_lineages` is derived, and the derivation is stated rather than assumed.
 * Per the BudgetAllowance note, an allowance is the count AT WHICH the review
 * closes, so it is 1 higher than the number of lineages permitted. When the prose
 * says no cross-audit lineage is budgeted, the only permitted lineage is the one
 * running the declared rounds, so the review closes when a 2nd distinct lineage
 * appears and the allowance is 2. When the prose budgets N cross-audit lineages,
 * 1 plus N are permitted and the allowance is 2 plus N.
 */
function parseBudgetDeclaration(text, filename) {
    const file = typeof filename === 'string' && filename !== '' ? filename : '<unknown>';
    if (typeof text !== 'string' || text.trim() === '') {
        return err(file, ANTILOOP_ERROR_CODES.BUDGET_UNDECLARED, 'no review budget: the file is empty');
    }
    const sentence = BUDGET_SENTENCE.exec(text);
    if (sentence === null) {
        return err(file, ANTILOOP_ERROR_CODES.BUDGET_UNDECLARED, 'no review budget is declared. Add 1 bolded sentence naming the review budget, the digit '
            + 'count of rounds and the question they review, followed by a statement of how many '
            + 'cross-audit lineages are budgeted. An unbudgeted gate cannot open.');
    }
    const body = sentence[1];
    const line = text.slice(0, sentence.index).split(/\r?\n/).length;
    const quoted = body.replace(/\s+/g, ' ').trim();
    const allowances = [];
    for (const m of body.matchAll(ROUND_ALLOWANCE)) {
        allowances.push({
            rounds: Number(m[1]),
            question: typeof m[2] === 'string' ? m[2].replace(/\s+/g, ' ').trim().toLowerCase() : '',
        });
    }
    if (allowances.length === 0) {
        return err(file, ANTILOOP_ERROR_CODES.BUDGET_UNDECLARED, 'the review budget sentence states no digit count of rounds, so no allowance exists to '
            + 'spend. State it as a digit.', { line, text: quoted });
    }
    const tail = text.slice(sentence.index, sentence.index + sentence[0].length + LINEAGE_SCAN_CHARS);
    const lineageCount = LINEAGE_ALLOWANCE.exec(tail);
    let crossAuditBudgeted;
    let maxLineages;
    if (lineageCount !== null) {
        crossAuditBudgeted = true;
        maxLineages = 2 + Number(lineageCount[1]);
    }
    else if (NO_LINEAGE_BUDGETED.test(tail)) {
        crossAuditBudgeted = false;
        maxLineages = 2;
    }
    else {
        return err(file, ANTILOOP_ERROR_CODES.BUDGET_UNDECLARED, 'the review budget states rounds but says nothing about reviewing lineages, so adding a '
            + 'reviewer would be unbounded. State either that no cross-audit lineage is budgeted or '
            + 'how many are.', { line, text: quoted });
    }
    return {
        ok: true,
        file,
        line,
        text: quoted,
        max_rounds: allowances[0].rounds,
        max_lineages: maxLineages,
        allowances,
        cross_audit_budgeted: crossAuditBudgeted,
    };
}
module.exports = {
    counterKey,
    foldAntiloopEvents,
    normalizeBudget,
    evaluateGateOpen,
    evaluateFindingBlocking,
    evaluateBudgetSpentDisposition,
    parseBudgetDeclaration,
    ANTILOOP_TERMINAL_OUTCOMES,
    ANTILOOP_ERROR_CODES,
};
