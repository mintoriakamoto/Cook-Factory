---
name: ferrox-project
description: "project lifecycle | milestones audits summary"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [new-project, onboard, new-milestone, complete-milestone, audit-milestone, milestone-summary, import, ingest-docs, profile-user, review-backlog]
---

Route to the appropriate project / milestone skill based on the user's intent.
`ferrox-plan-milestone-gaps` was deleted by #2790 — gap planning now happens
inline as part of `ferrox-audit-milestone`'s output.

| User wants | Invoke |
|---|---|
| Start a new project | ferrox-new-project |
| Onboard an existing codebase | ferrox-onboard |
| Create a new milestone | ferrox-new-milestone |
| Complete the current milestone | ferrox-complete-milestone |
| Audit a milestone for issues | ferrox-audit-milestone |
| Summarize milestone status | ferrox-milestone-summary |
| Import an external plan | ferrox-import |
| Bootstrap planning from existing docs | ferrox-ingest-docs |
| Generate a developer profile | ferrox-profile-user |
| Review and promote backlog items | ferrox-review-backlog |

Invoke the matched skill directly using the Skill tool.
