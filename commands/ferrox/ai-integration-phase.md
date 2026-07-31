---
name: ferrox:ai-integration-phase
description: "A step involves building an AI system and you want its design and evals pinned down first"
argument-hint: "[phase number]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - WebFetch
  - WebSearch
  - AskUserQuestion
  - mcp__context7__*
requires: [phase]
---
<objective>
Create an AI design contract (AI-SPEC.md) for a phase involving AI system development.
Orchestrates ferrox-framework-selector → ferrox-ai-researcher → ferrox-domain-researcher → ferrox-eval-planner.
Flow: Select Framework → Research Docs → Research Domain → Design Eval Strategy → Done
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/ai-integration-phase.md
@~/.claude/ferrox-core/references/ai-frameworks.md
@~/.claude/ferrox-core/references/ai-evals.md
</execution_context>

<context>
Phase number: $ARGUMENTS — optional, auto-detects next unplanned phase if omitted.
</context>

<process>
Execute end-to-end.
Preserve all workflow gates.
</process>
