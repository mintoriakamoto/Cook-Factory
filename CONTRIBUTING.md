# Contributing to Ferrox Factory

Ferrox Factory is a bounded, gate-driven build system. Contributions flow through
the same discipline the system enforces on itself: **issue-first, gated, and
evidence-backed.** No unbounded loops, no un-reviewed merges.

## The issue-first rule

**Every change starts as an issue, and every issue is triaged before code.**

1. **Open a typed issue** using one of the templates
   (`.github/ISSUE_TEMPLATE/`): Feature, Enhancement, Bug, or Chore. Fill every
   required field — `ferrox-inbox` grades submissions against these templates and
   an incomplete one is flagged or closed.
2. **Triage.** `ferrox-inbox` classifies the issue, scores completeness, and
   applies review labels. A maintainer reviews.
3. **Approval gate.** A feature needs `approved-feature`; an enhancement needs
   `approved-enhancement`; a bug needs `confirmed-bug`. **No PR merges without its
   issue carrying the approval label.**
4. **Into the Build Line.** An approved issue is pulled into the backlog
   (`ferrox-inbox --to-backlog`), planned, and executed through the gates.

## Approval gates & labels

| Type | Entry label | Approval label required to merge |
|------|-------------|----------------------------------|
| Feature | `feature-request` + `needs-review` | `approved-feature` |
| Enhancement | `enhancement` + `needs-review` | `approved-enhancement` |
| Bug | `bug` + `needs-triage` | `confirmed-bug` |
| Chore | `type: chore` + `needs-triage` | (maintainer discretion) |

## Pull requests

Use the **typed PR template** matching your change
(`.github/PULL_REQUEST_TEMPLATE/feature.md` / `enhancement.md` / `fix.md`) — not
the default. Each PR must link its approved issue (`Closes #NN`) and carry the
Build Line evidence checklist:

- **Red→green receipt** (STRONG-02): a test observed failing, then passing.
- **Mutation/assertion-strength** (STRONG-03): the test flips when its target is mutated.
- **Independent cross-audit**: CRITICAL/HIGH fixed, MEDIUM/LOW routed to backlog.
- **`strength.merge-gate` = pass**: receipts + coverage verified, fail-closed.
- **Backlog burn-down** (STRONG-05): net backlog must not grow.

A PR whose linked issue lacks its approval label, or whose merge-gate does not
pass, is **blocked at the tool layer** — this is enforced, not advisory.

## What "done" means

A shippable, coverage-advancing increment lands on `main` — the build always
terminates and always moves forward. If everything else fails, this must hold:
**the build never enters an unbounded loop.**

## License

By contributing you agree your contributions are licensed under the MIT License.
Ferrox Factory is a fork of [open-gsd/gsd-core](https://github.com/open-gsd/gsd-core)
(MIT) and vendors Superpowers disciplines (MIT); preserve attribution.
