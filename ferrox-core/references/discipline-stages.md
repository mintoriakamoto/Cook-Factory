# Discipline → Build Line Stage Mapping

This document maps each vendored Superpowers discipline (staged under
`skills-vendored/ferrox-*` and shipped as `skills/ferrox-*`) to the Ferrox **Build
Line stage** where it applies. The Build Line stages are the ones defined in
`FERROX-FACTORY-BRIEF.md` ("The Build Line" pipeline). The mapping is intentionally
machine-greppable: each row keeps the exact `ferrox-{discipline}` skill name and its
single named-stage token on the same line, so a single `grep` resolves name → stage.

Stage tokens are drawn from a closed set: `execute`, `verify`, `wave-audit`,
`discuss`.

## Mapping

| Discipline skill | Stage token | Why this stage |
|------------------|-------------|----------------|
| `ferrox-test-driven-development` | `execute` | Red-green TDD receipt is produced while building the increment — the Execute stage. |
| `ferrox-systematic-debugging` | `execute` | Bug isolation happens inline during Execute, before drift is handed off to a backlog packet. |
| `ferrox-verification-before-completion` | `verify` | Evidence-before-claims runs in the goal-backward Verify stage, not while authoring code. |
| `ferrox-requesting-code-review` | `wave-audit` | An author requests review at the independent WAVE-AUDIT judge stage. |
| `ferrox-receiving-code-review` | `wave-audit` | Acting on severity-graded findings is part of the WAVE-AUDIT loop (fix-now vs backlog). |

## Brainstorm stays GSD-owned

There is **no vendored brainstorm skill**. The brainstorm stage maps to the
`discuss` stage token and is owned by GSD's `discuss-phase` (upstream), not a
Superpowers discipline. This row exists so a reader who greps for the `discuss`
stage sees it is intentionally GSD-owned, not a missing/forgotten discipline.

| Stage owner | Stage token | Note |
|-------------|-------------|------|
| GSD `discuss-phase` (no vendored skill) | `discuss` | Brainstorm/convergence is GSD-owned; no `ferrox-brainstorm` discipline is vendored. |
