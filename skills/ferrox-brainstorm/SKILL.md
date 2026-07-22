---
name: ferrox-brainstorm
description: "Freeform ideation session. Explore a topic, persist it to .planning/brainstorms/, then route it into the lifecycle"
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
  - AskUserQuestion
---

<objective>
Freeform brainstorm session. Explores a topic conversationally (divergent options,
tradeoffs, recommendation-first), persists the output to `.planning/brainstorms/`,
then offers 3 routes: promote to `/ferrox-discuss-phase`, seed a new milestone, or
park it in the backlog via `/ferrox-capture --backlog`.

Accepts an optional topic argument: `/ferrox-brainstorm pricing model for the API tier`
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/brainstorm.md
</execution_context>

<context>
Arguments: $ARGUMENTS

If $ARGUMENTS is non-empty, treat it as the brainstorm topic. Otherwise ask for one.
</context>

<process>
Execute end-to-end.
</process>
