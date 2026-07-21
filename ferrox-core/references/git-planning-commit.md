# Git Planning Commit

Commit planning artifacts via `ferrox-tools query commit`, which checks `commit_docs` config and gitignore status (same behavior as legacy `ferrox-tools.cjs commit`).

## Commit via CLI

Pass the message first, then file paths via `--files`. Both `commit` and `commit-to-subrepo` use `--files` to declare the paths to commit.

Always use this for `.planning/` files — it handles `commit_docs` and gitignore checks automatically:

```bash
ferrox-tools query commit "docs({scope}): {description}" --files .planning/STATE.md .planning/ROADMAP.md
```

The CLI will return `skipped` (with reason) if `commit_docs` is `false` or `.planning/` is gitignored. No manual conditional checks needed.

## Amend previous commit

To fold `.planning/` file changes into the previous commit:

```bash
ferrox-tools query commit "" --files .planning/codebase/*.md --amend
```

## Commit Message Patterns

| Command | Scope | Example |
|---------|-------|---------|
| plan-phase | phase | `docs(phase-03): create authentication plans` |
| execute-phase | phase | `docs(phase-03): complete authentication phase` |
| new-milestone | milestone | `docs: start milestone v1.1` |
| remove-phase | chore | `chore: remove phase 17 (dashboard)` |
| insert-phase | phase | `docs: insert phase 16.1 (critical fix)` |
| add-phase | phase | `docs: add phase 07 (settings page)` |

## When to Skip

- `commit_docs: false` in config
- `.planning/` is gitignored
- No changes to commit (check with `git status --porcelain .planning/`)

## Sole-writer rule for shared planning state

The shared planning-state files — `STATE.md`, `ROADMAP.md`, and `BACKLOG.md` — have a
**single writer: the orchestrator**, after all worktree agents in a wave complete. A
sub-agent / parallel executor MUST NOT write them (see execute-phase.md: "Do NOT update
STATE.md or ROADMAP.md — the orchestrator owns those writes"). This is the sole-writer
rule that keeps parallel waves from racing on shared state.

A non-orchestrator write to any of these shared-state paths is detected by
`coord.shared-write-check`, which returns `forbidden` for a non-orchestrator actor
targeting a hot-seam file:

```bash
ferrox_run query coord.shared-write-check --actor executor --target .planning/STATE.md
# → { "decision": "forbidden", "matched": "**/STATE.md" }
```

`coord.shared-write-check` is the coordination verb that backs this rule; see
[coordination.md](coordination.md) for the full coordination model and the honest
mechanism-vs-protocol scope (consulted protocol this phase, not yet un-bypassable —
Phase-5 / FF-B10).
