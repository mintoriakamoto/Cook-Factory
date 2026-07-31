---
ferrox_state_version: '1.0'
milestone: v1.14
milestone_name: Fleet Mode
current_phase: 14.1
current_phase_name: governance-truth
status: executing
last_updated: "2026-07-25T13:40:29.724Z"
last_activity: 2026-07-25
progress:
  total_phases: 2
  completed_phases: 1
  total_plans: 5
  completed_plans: 1
---

<!--
INTENTIONALLY INVALID FIXTURE. DO NOT REPAIR THIS FILE.

Reproduces the governance defect that was live in `.planning/STATE.md` on 2026-07-25.
The frontmatter declares milestone v1.14 while the body points an agent at the v1.1
milestone. A declaration-equality check passes this file green, and that is the whole
reason Phase 14.1 exists.

3 specimens live here, and each one is load bearing.

1. The 2 VERSIONED false claims: the bolded current-focus line under Project Reference,
   and the resume pointer under Session Continuity. `detectStaleClaims` catches both.
2. One VERSIONLESS false claim: the position line reading
   "14-01 planned, awaiting execution". It names no version, so the version check
   returns zero on it and only `checkStateStructure` can see it. 3 of the 4 drifts
   observed in the real file that day had exactly this shape.
3. One retained-for-history subheading naming the old milestone in a parenthetical.
   It must NOT be flagged, so the version check cannot reach its result by flagging
   every mention of an old milestone.

A contributor who tidies this file silently deletes the regression. Leave it alone.
-->

# Project State

## Project Reference

See: .planning/PROJECT.md

**Core value:** A shippable, coverage-advancing increment lands on main every session.
**Current focus:** v1.1 "Reach & Triage"

## Current Position

Phase: 14.1 (governance-truth) — EXECUTING
Plan: 14-01 planned, awaiting execution
Status: Executing Phase 14.1
Last activity: 2026-07-25 — Phase 14.1 execution started

## Accumulated Context

### Decisions (v1.14)

- The scheduler is deterministic code; the LLM is never in a scheduling decision.

### Decisions (v1.1, retained for history)

- Parity reframe: the fork inherits 19 runtime adapters.

## Session Continuity

Last session: 2026-07-25 (v1.14 planning and cross-audit).
Stopped at: Phase 14 re-scoped to the generator only.
Resume file: .planning/MILESTONE-v1.1-REACH.md
