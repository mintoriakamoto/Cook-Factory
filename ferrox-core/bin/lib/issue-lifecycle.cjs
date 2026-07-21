"use strict";
/**
 * issue-lifecycle core (TRIAGE-01, v1.1 Phase C — C2 link/label + C3 close-on-pass).
 *
 * Ties a GitHub issue to a Ferrox increment across the Build Line:
 *   - C2 onIncrementStart: an increment linked to gh#NN labels the issue
 *     `in-progress` (and drops any triage/review label). The link is the
 *     increment's `github_issue` field.
 *   - C3 onMergeGate: the issue closes ONLY as a consequence of the strength
 *     merge-gate returning `pass`. A non-pass gate (block) holds the issue open —
 *     the close is a downstream effect of the gate, never a manual step, and never
 *     fires on a failed merge.
 *
 * PURE: returns the gh action(s) the caller (ship / merge-gate workflow) should
 * run; performs no I/O itself. `export =` CJS shape.
 */
function normIssue(n) {
    if (typeof n === 'number' && Number.isInteger(n) && n > 0)
        return n;
    return null;
}
/**
 * PURE (C2). When an increment linked to an issue starts, mark the issue
 * in-progress and clear its "waiting" labels.
 */
function onIncrementStart(input) {
    const issue = normIssue(input.githubIssue);
    if (issue === null) {
        return { decision: 'noop', reason: 'no linked github_issue', actions: [] };
    }
    return {
        decision: 'applied',
        actions: [
            { action: 'label', issue, value: 'in-progress' },
            { action: 'unlabel', issue, value: 'needs-review' },
            { action: 'unlabel', issue, value: 'needs-triage' },
        ],
    };
}
/**
 * PURE (C3). Close the linked issue IFF the merge gate passed. Any non-pass
 * decision holds the issue open — a blocked merge must never close its issue.
 */
function onMergeGate(input) {
    const issue = normIssue(input.githubIssue);
    if (issue === null) {
        return { decision: 'noop', reason: 'no linked github_issue', actions: [] };
    }
    if (input.gateDecision !== 'pass') {
        return {
            decision: 'noop',
            reason: `merge-gate did not pass (${input.gateDecision}) — issue held open`,
            actions: [],
        };
    }
    return {
        decision: 'applied',
        actions: [
            {
                action: 'comment',
                issue,
                value: `Resolved by Ferrox increment ${input.increment} — strength merge-gate passed and the increment landed on main.`,
            },
            { action: 'unlabel', issue, value: 'in-progress' },
            { action: 'close', issue },
        ],
    };
}
module.exports = { onIncrementStart, onMergeGate };
