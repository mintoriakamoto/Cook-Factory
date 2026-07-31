---
name: ferrox:brainstorm
description: "You have an idea or a blank page and want to think it through. 3 silent stances, then routes"
argument-hint: "[topic] [--research] [--text]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - AskUserQuestion
requires: [capture, discuss-phase, explore, new-milestone]
---
<objective>
Brainstorm session that ends with an approved artifact, run in 1 of 3
stances chosen silently to fit the opening: guided (recommendation-first
questions and 2 to 3 approaches, for concrete decisions), generative (1
intake batch, then 4 to 6 pre-checked named options the user reacts to, for
blank pages), or sounding board (free-form creative collaboration with
content-triggered capture, for thinking out loud). Superpowers brainstorming
discipline stays the floor: hard gate (no implementation until the artifact
is approved), scope check before detail, self-review, and a user review gate
on the written doc. Parallel researcher subagents stay on tap and a local
browser companion shows mockups and diagrams for questions better seen than
read. Exits are stance-keyed (GO fork or recap-confirm); only exit-confirmed
items are promoted to Decisions, and park is a first-class exit with
resumable session notes.

Output: `.planning/brainstorms/{slug}-{date}/BRAINSTORM.md` (+ `research/` +
`screens/` + `SESSION-NOTES.md`), committed, then routed through exactly 3
exits: promote to `/ferrox:discuss-phase`, seed a milestone via
`/ferrox:new-milestone`, or park (optionally `/ferrox:capture --backlog`).

Boundary: `/ferrox:explore` is codebase-grounded Socratic ideation;
`/ferrox:brainstorm` is topic ideation with stances.

Flags:
- `--research`: fire 2 to 4 parallel researcher subagents up front, seeded by
  the topic (in the sounding-board stance this means a visible pre-read
  before the first reply, never an auto-fire mid-conversation). The same
  research fires mid-session whenever the discussion hits a genuine unknown.
- `--text`: plain-text prompts instead of AskUserQuestion, for non-Claude
  runtimes.

Accepts an optional topic argument: `/ferrox:brainstorm pricing model for the API tier`
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/brainstorm.md
</execution_context>

<context>
Arguments: $ARGUMENTS

Strip `--research` if present (enables research mode) and `--text` if
present (enables TEXT_MODE). The remainder is the brainstorm topic; if
empty, ask for one.
</context>

<process>
Execute end-to-end.
</process>
