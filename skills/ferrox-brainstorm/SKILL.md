---
name: ferrox-brainstorm
description: "Research brainstorm with a visual helper. Hard-gated design dialogue with recommendation-first questions, researcher subagents on tap, and a browser companion; artifact routed into the lifecycle"
argument-hint: "[topic] [--research]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
---

<objective>
Brainstorm session that ends with an approved design artifact. Superpowers
brainstorming discipline is the floor: hard gate (no implementation until the
design is approved), 1 question per message, scope check before detail, 2 to 3
approaches with tradeoffs, sectioned design presentation, self-review, and a
user review gate on the written doc. On top of that floor: every question is
recommendation-first (house law), parallel researcher subagents can be fired
at any point, and a local browser companion shows mockups and diagrams for
questions better seen than read.

Output: `.planning/brainstorms/{slug}-{date}/BRAINSTORM.md` (+ `research/` +
`screens/`), committed, then routed through exactly 3 exits: promote to
`/ferrox-discuss-phase`, seed a milestone via `/ferrox-new-milestone`, or park
via `/ferrox-capture --backlog`.

Flags:
- `--research`: fire 2 to 4 parallel researcher subagents up front, seeded by
  the topic. The same research fires mid-session whenever the discussion hits
  a genuine unknown.

Accepts an optional topic argument: `/ferrox-brainstorm pricing model for the API tier`
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/brainstorm.md
</execution_context>

<context>
Arguments: $ARGUMENTS

Strip `--research` if present (enables research mode). The remainder is the
brainstorm topic; if empty, ask for one.
</context>

<process>
Execute end-to-end.
</process>
