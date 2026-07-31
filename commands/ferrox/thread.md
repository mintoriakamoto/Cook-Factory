---
name: ferrox:thread
description: "You want a named context thread that survives across sessions for one line of work"
argument-hint: "[list [--open | --resolved] | close <slug> | status <slug> | name | description]"
allowed-tools:
  - Read
  - Write
  - Bash
requires: [phase]
---

<objective>
Create, list, close, or resume persistent context threads. Threads are lightweight
cross-session knowledge stores for work that spans multiple sessions but
doesn't belong to any specific phase.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/thread.md
</execution_context>

<process>
Execute end-to-end.
</process>
