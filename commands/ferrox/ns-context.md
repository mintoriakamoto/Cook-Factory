---
name: ferrox-context
description: "codebase intel | map graphify docs learnings mempalace"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [map-codebase, graphify, docs-update, extract-learnings, mempalace-recall, mempalace-capture]
---

Route to the appropriate codebase-intelligence skill based on the user's intent.
`ferrox-scan` and `ferrox-intel` were folded into `ferrox-map-codebase` flags by #2790.

| User wants | Invoke |
|---|---|
| Map the full codebase structure | ferrox-map-codebase |
| Quick lightweight codebase scan | ferrox-map-codebase --fast |
| Query mapped intelligence files | ferrox-map-codebase --query |
| Generate a knowledge graph | ferrox-graphify |
| Update project documentation | ferrox-docs-update |
| Extract learnings from a completed phase | ferrox-extract-learnings |
| Recall prior decisions and patterns before planning | ferrox-mempalace-recall |
| File a phase artifact into MemPalace | ferrox-mempalace-capture |

Invoke the matched skill directly using the Skill tool.
