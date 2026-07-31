---
name: ferrox-next
description: "Say what you want in plain words, or run it bare to see where you are and what to do next"
argument-hint: "[what you want, in plain words]"
effort: low
allowed-tools:
  - Read
  - Bash
  - Glob
  - SlashCommand
  - AskUserQuestion
---

<objective>
The front door. Two ways in, and the command decides which one you meant.

**With words:** say what you want and it routes you. It understands sequences, so "brainstorm a game and then build it autonomously" becomes a chain (brainstorm, then set the project up, then build every step) rather than only the first thing you said.

**With nothing:** it reads the project's state and shows a short menu of the right next actions, including how to pick up work you left part way.

This is a launcher/router only. It never does the work itself. It reads project + workflow state via `ferrox-tools smart-entry --json`.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/smart-entry.md
@~/.claude/ferrox-core/workflows/do.md
@~/.claude/ferrox-core/references/ui-brand.md
</execution_context>

<context>
Arguments: $ARGUMENTS

`$ARGUMENTS` empty, or only flags (`--text`, `--json`), means "show me the menu".
`$ARGUMENTS` carrying anything else is a request to be routed via `do.md`, including its compound step.
</context>

<process>
Follow ~/.claude/ferrox-core/workflows/smart-entry.md, beginning with its `freeform` step. Dispatch exactly one command (the head of the chain, when the request was compound). Then stop.
</process>
