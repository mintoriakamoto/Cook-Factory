---
name: ferrox:fast
description: "A trivial change you could describe in one line. Runs inline, no subagents, no planning"
argument-hint: "[task description]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
requires: [config, quick]
---

<objective>
Execute a trivial task directly in the current context without spawning subagents
or generating PLAN.md files. For tasks too small to justify planning overhead:
typo fixes, config changes, small refactors, forgotten commits, simple additions.

This is NOT a replacement for /ferrox:quick — use /ferrox:quick for anything that
needs research, multi-step planning, or verification. /ferrox:fast is for tasks
you could describe in one sentence and execute in under 2 minutes.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/fast.md
</execution_context>

<process>
Execute end-to-end.
</process>
