---
name: ferrox-undo
description: "You want the last step put back the way it was. Reverses its commits safely, in order"
argument-hint: "--last N | --phase NN | --plan NN-MM"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---


<objective>
Safe git revert — roll back Ferrox phase or plan commits using the phase manifest, with dependency checks and a confirmation gate before execution.

Three modes:
- **--last N**: Show recent Ferrox commits for interactive selection
- **--phase NN**: Revert all commits for a phase (manifest + git log fallback)
- **--plan NN-MM**: Revert all commits for a specific plan
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/undo.md
@~/.claude/ferrox-core/references/ui-brand.md
@~/.claude/ferrox-core/references/gate-prompts.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute end-to-end.
</process>
