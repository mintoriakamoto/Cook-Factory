---
name: ferrox-canon-init
description: "Writing a book or research and you need one source of truth. Creates LORE.md or SOURCES.md"
argument-hint: "[--from-existing | --from-brainstorm]"
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
Create the project's declared canon store(s) at the project root: `LORE.md` (book and
writing projects) and/or `SOURCES.md` (research and nonfiction), each carrying the fenced
`yaml canon-facts` machine slice. Once a store exists, every creative gate and agent treats
it as binding context.

3 modes:
- **Interview** (default): short recommendation-first interview grounded in the repo's
  README and premise notes, then write the store(s).
- **`--from-existing`**: scan an existing manuscript, notes, chapters, or bibliography for
  entities, sources, and facts; draft the store from what is already true, confirming only
  the gaps.
- **`--from-brainstorm`**: read the book or software BRAINSTORM.md (the v1.12 brainstorm
  artifact) as the seed for entities, threads, world rules, and sources.

Works in any repo. Does not require prior Ferrox project setup.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/canon-init.md
</execution_context>

<runtime_note>
**Copilot (VS Code):** Use `vscode_askquestions` wherever this workflow calls `AskUserQuestion`.
</runtime_note>

<context>
Arguments: $ARGUMENTS

**Available flags:**
- `--from-existing` - Skip the interview; scan the existing manuscript, notes, chapters, or
  bibliography and draft the store from what is already true, resolving only gaps.
- `--from-brainstorm` - Skip the interview; seed the store from the project's BRAINSTORM.md.
</context>

<process>
Execute the canon-init workflow end-to-end. Preserve all workflow gates (existing-store
check, domain and template mapping, mode recommendation, recommendation-first interview,
review gate before writing, binding closing message).
</process>
