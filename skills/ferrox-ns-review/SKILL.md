---
name: ferrox-ns-review
description: "quality gates | code review debug audit security eval ui"
allowed-tools:
  - Read
  - Skill
---


Route to the appropriate quality / review skill based on the user's intent.
`ferrox-code-review-fix` was absorbed by `ferrox-code-review --fix` in #2790.

| User wants | Invoke |
|---|---|
| Review code for quality and correctness | ferrox-code-review |
| Auto-fix code review findings | ferrox-code-review --fix |
| Audit UAT / acceptance testing | ferrox-audit-uat |
| Security review of a phase | ferrox-secure-phase |
| Evaluate AI response quality | ferrox-eval-review |
| Review UI for design and accessibility | ferrox-ui-review |
| Validate phase outputs | ferrox-validate-phase |
| Debug a failing feature or error | ferrox-debug |
| Forensic investigation of a broken system | ferrox-forensics |
| Autonomous audit-to-fix pipeline | ferrox-audit-fix |
| Cross-AI peer review of plans | ferrox-review |
| Generate a UI design contract | ferrox-ui-phase |

Invoke the matched skill directly using the Skill tool.
