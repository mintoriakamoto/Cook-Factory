---
name: ferrox-ultraplan-phase
description: "[BETA] You want planning offloaded to the ultraplan cloud, reviewed in a browser, imported"
argument-hint: "[phase-number]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---


<objective>
Offload Ferrox's plan phase to Claude Code's ultraplan cloud infrastructure.

Ultraplan drafts the plan in a remote cloud session while your terminal stays free.
Review and comment on the plan in your browser, then import it back via /ferrox-import --from.

⚠ BETA: ultraplan is in research preview. Use /ferrox-plan-phase for stable local planning.
Requirements: Claude Code v2.1.91+, claude.ai account, GitHub repository.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/ultraplan-phase.md
@~/.claude/ferrox-core/references/ui-brand.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the ultraplan-phase workflow end-to-end.
</process>
