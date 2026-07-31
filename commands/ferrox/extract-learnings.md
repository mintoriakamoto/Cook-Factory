---
name: ferrox:extract-learnings
description: "A step is finished and you want the decisions, lessons and surprises kept before moving on"
argument-hint: <phase-number>
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
  - Agent
type: prompt
requires: [phase]
---
<objective>
Extract structured learnings from completed phase artifacts (PLAN.md, SUMMARY.md, VERIFICATION.md, UAT.md, STATE.md) into a LEARNINGS.md file that captures decisions, lessons learned, patterns discovered, and surprises encountered.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/extract-learnings.md
</execution_context>

Execute the extract-learnings workflow from @~/.claude/ferrox-core/workflows/extract-learnings.md end-to-end.
