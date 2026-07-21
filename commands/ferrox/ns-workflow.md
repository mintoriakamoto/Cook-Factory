---
name: ferrox-workflow
description: "workflow | discuss plan execute verify phase progress"
argument-hint: ""
allowed-tools:
  - Read
  - Skill
requires: [discuss-phase, spec-phase, plan-phase, execute-phase, verify-work, phase, progress, next, ultraplan-phase, plan-review-convergence, add-tests, ai-integration-phase, autonomous, fast, mvp-phase, quick]
---

Route to the appropriate phase-pipeline skill based on the user's intent.
Sub-skill names below are post-#2790 consolidated targets — `ferrox-phase`
absorbs the former add/insert/remove/edit-phase commands and `ferrox-progress`
absorbs the former next/do workflow-advance commands. The reclaimed
`ferrox-next` target is the state-aware smart-entry launcher, not the retired
workflow-advance command.

| User wants | Invoke |
|---|---|
| Gather context before planning | ferrox-discuss-phase |
| Clarify what a phase delivers | ferrox-spec-phase |
| Create a PLAN.md | ferrox-plan-phase |
| Execute plans in a phase | ferrox-execute-phase |
| Verify built features through UAT | ferrox-verify-work |
| Add / insert / remove / edit a phase | ferrox-phase |
| Advance to the next logical step | ferrox-progress |
| Open the state-aware smart-entry launcher | ferrox-next |
| Offload planning to the ultraplan cloud | ferrox-ultraplan-phase |
| Cross-AI plan review convergence loop | ferrox-plan-review-convergence |
| Generate tests for a completed phase | ferrox-add-tests |
| Design an AI-integration phase | ferrox-ai-integration-phase |
| Run all remaining phases autonomously | ferrox-autonomous |
| Execute a trivial task inline | ferrox-fast |
| Plan a phase as a vertical MVP slice | ferrox-mvp-phase |
| Execute a quick task with Ferrox guarantees | ferrox-quick |

Invoke the matched skill directly using the Skill tool.
