# State Template

Template for `.planning/STATE.md` — the project's living memory.

---

## File Template

```markdown
---
ferrox_state_version: '1.0'  # placeholder; syncStateFrontmatter overwrites on first state.* call
status: planning
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current Position

Phase: 1 (phase-name)
Plan: 1 of 1 in current phase
Status: Ready to plan
Last activity: 2026-01-01

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: [N]
- Average duration: [X] min
- Total execution time: [X.X] hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**
- Last 5 plans: [durations]
- Trend: [Improving / Stable / Degrading]

*Updated after each plan completion*

```

<purpose>

STATE.md is the project's short-term memory spanning all phases and sessions.

**Problem it solves:** information is captured in summaries, issues, and decisions but not systematically consumed. Sessions start without context.

**Solution:** a single, small file that is read first in every workflow, updated after every significant action, and carries machine-written fields only.

**Phase 14.1 D3d, the rule that governs this template.** Every free-prose section was DELETED. STATE.md now carries frontmatter plus machine-written field sections, and nothing else. A stale claim needs somewhere to live; this file gives it nowhere. The closed set is exactly 3 level 2 sections and no heading of level 3 anywhere:

- `## Current Position`
- `## Performance Metrics`
- `## Operator Next Steps`, created on demand by the milestone-close writer

Anything else fails `checkStateStructure` in `src/governance-manifest.cts`. Do not add a section here without adding it there first, and do not add one there without a `src/` writer to cite.

</purpose>

<lifecycle>

**Creation:** after ROADMAP.md is created (during init). Set position to phase 1, ready to plan.

**Reading:** first step of every workflow.
- progress: present status to the user
- plan: inform planning decisions
- execute: know current position
- transition: know what is complete

**Writing:** after every significant action.
- execute: after SUMMARY.md is created, update position (phase, plan, status)
- transition: after a phase is marked complete, update the progress bar

**Where the deleted content went.** Decisions, blockers and roadmap evolution entries now live in machine-owned sections of the single `lifecycle: active` milestone artifact under `.planning`, written by `state add-decision`, `state add-blocker`, `state resolve-blocker` and `state add-roadmap-evolution`. Deferred items live in `.planning/BACKLOG.md`. The resume pointer is derived from the active milestone artifact and is no longer stored: `state record-session` accepts `--resume-file` and ignores it with a deprecation notice. The rebuild audit trail is an append-only sidecar, `state-rebuild-log.jsonl`, deliberately outside the file it audits.

</lifecycle>

<sections>

### Current Position
Where the project is right now, as machine-written fields and no prose:
- Phase, the phase number with an optional parenthesised name
- Plan, which plan within the phase
- Status, the current state
- Last activity, an ISO date with an optional writer-supplied narrative literal
- Progress, a bar and a percentage

Every one of those values is checked against a closed set of shapes derived from the SDK writers, so a sentence cannot be typed into a field.

### Performance Metrics
Velocity, so execution patterns are legible:
- Total plans completed
- Average duration per plan
- Per-phase breakdown
- Recent trend

Updated after each plan completion. Kept rather than deleted because it is a numeric table that carries no version and no claim, and a table of durations cannot go stale the way a sentence can.

### Operator Next Steps
Written only by the milestone-close writer, and only ever the single line that names the command to start the next milestone.

</sections>

<size_constraint>

Keep STATE.md under 60 lines.

It is a DIGEST, not an archive. There is no accumulated-context section to grow, so the only surface that grows is the metrics table, and `state prune` archives its old rows to STATE-ARCHIVE.md.

The goal is "read once, know where we are". If it is too long, that fails.

</size_constraint>
