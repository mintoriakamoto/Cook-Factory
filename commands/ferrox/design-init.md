---
name: ferrox:design-init
description: "You want a durable design contract before any UI is built. Creates DESIGN.md by interview"
argument-hint: "[--from-existing]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - AskUserQuestion
---
<objective>
Create `DESIGN.md` at the project root: a 9-section design contract (visual theme, colors,
typography, spacing and layout, components, motion, voice and copy, accessibility floor,
never-do list) with concrete values, never adjectives. Once it exists, every UI and visual
workflow treats it as binding context.

Two modes:
- **Interview** (default): short recommendation-first interview grounded in the repo's README
  and package metadata, then write the contract.
- **`--from-existing`**: scan the codebase's existing UI (tokens, styles, components) and
  draft the contract from observed values, confirming only the gaps.

Works in any repo. Does not require prior Ferrox project setup.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/design-init.md
@~/.claude/ferrox-core/references/design-contract-example.md
</execution_context>

<runtime_note>
**Copilot (VS Code):** Use `vscode_askquestions` wherever this workflow calls `AskUserQuestion`.
</runtime_note>

<context>
Arguments: $ARGUMENTS

**Available flags:**
- `--from-existing` - Skip the interview; scan the existing codebase UI and draft DESIGN.md
  from what is already true, resolving only ambiguities with the developer.
</context>

<process>
Execute the design-init workflow end-to-end. Preserve all workflow gates (existing-file
check, mode recommendation, recommendation-first interview, review gate before writing).
</process>
