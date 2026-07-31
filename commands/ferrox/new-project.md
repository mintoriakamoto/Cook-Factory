---
name: ferrox:new-project
description: "Building something new from scratch. Asks what you want, plans it, then offers to build it"
argument-hint: "[--auto]"
allowed-tools:
  - Read
  - Bash
  - Write
  - Agent
  - AskUserQuestion
requires: [config, phase, plan-phase, progress, discuss-phase]
---
<runtime_note>
**Copilot (VS Code):** Use `vscode_askquestions` wherever this workflow calls `AskUserQuestion`. They are equivalent — `vscode_askquestions` is the VS Code Copilot implementation of the same interactive question API.
</runtime_note>

<context>
**Flags:**
- `--auto` — Automatic mode. After config questions, runs research → requirements → roadmap without further interaction. Expects idea document via @ reference.
</context>

<objective>
Initialize a new project through unified flow: questioning → research (optional) → requirements → roadmap.

**Creates:**
- `.planning/PROJECT.md` — project context
- `.planning/config.json` — workflow preferences
- `.planning/research/` — domain research (optional)
- `.planning/REQUIREMENTS.md` — scoped requirements
- `.planning/ROADMAP.md` — phase structure
- `.planning/STATE.md` — project memory

**After this command:** it asks whether to build it now or one step at a time. "Build it now" hands
off to `/ferrox:progress --next --auto` and needs nothing further from you. "One step at a time"
ends on `/ferrox:discuss-phase 1`.

Do not print a different next step here. This line and `workflows/new-project.md` previously
disagreed, which is 2 contradictory next steps inside 1 command.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/new-project.md
@~/.claude/ferrox-core/references/questioning.md
@~/.claude/ferrox-core/references/ui-brand.md
@~/.claude/ferrox-core/templates/project.md
@~/.claude/ferrox-core/templates/requirements.md
</execution_context>

<process>
Execute end-to-end.
Preserve all workflow gates (validation, approvals, commits, routing).
</process>
