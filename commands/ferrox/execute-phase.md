---
name: ferrox:execute-phase
description: "Time to actually build the current step. Runs its plans, in parallel where they allow it"
argument-hint: "<phase-number> [--fleet|--inline] [--wave N] [--gaps-only] [--interactive] [--tdd]"
effort: max
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - TodoWrite
  - AskUserQuestion
requires: [phase, verify-work]
---
<objective>
Execute all plans in a phase using wave-based parallel execution.

Orchestrator stays lean: discover plans, analyze dependencies, group into waves, spawn subagents, collect results. Each subagent loads the full execute-plan context and handles its own plan.

Optional wave filter:
- `--wave N` executes only Wave `N` for pacing, quota management, or staged rollout
- phase verification/completion still only happens when no incomplete plans remain after the selected wave finishes

Flag handling rule:
- The optional flags documented below are available behaviors, not implied active behaviors
- A flag is active only when its literal token appears in `$ARGUMENTS`
- If a documented flag is absent from `$ARGUMENTS`, treat it as inactive

Context budget: ~15% orchestrator, 100% fresh per subagent.
</objective>

<execution_context>
@~/.claude/ferrox-core/workflows/execute-phase.md
@~/.claude/ferrox-core/references/ui-brand.md
</execution_context>

<runtime_note>
**Copilot (VS Code):** Use `vscode_askquestions` wherever this workflow calls `AskUserQuestion`. They are equivalent — `vscode_askquestions` is the VS Code Copilot implementation of the same interactive question API.
</runtime_note>

<context>
Phase: $ARGUMENTS

**Available optional flags (documentation only — not automatically active):**
- `--wave N` — Execute only Wave `N` in the phase. Use when you want to pace execution or stay inside usage limits.
- `--gaps-only` — Execute only gap closure plans (plans with `gap_closure: true` in frontmatter). Use after verify-work creates fix plans.
- `--interactive` — Execute plans sequentially inline (no subagents) with user checkpoints between tasks. Lower token usage, pair-programming style. Best for small phases, bug fixes, and verification gaps.
- `--fleet` — Execute this phase as a fleet of worker processes. **An explicit `--fleet` that cannot be honored REFUSES the run** with a non zero exit and names why. It never silently runs inline behind your back.
- `--inline` — Execute this phase inline in this session. Always available, always succeeds.

**You do not need the flags. Just say it.** "build phase 21 with the ferrox fleet", "use the fleet", "run it wide" and "fleet mode" all resolve the fleet backend. "run it inline", "no fleet", "single agent" and "one at a time" all resolve inline. **Every inferred backend is echoed back before anything runs**, naming the phrase that triggered it and how to override it, because a silent inference is worse than a flag. The matcher is deliberately narrow: a sentence that merely MENTIONS the fleet, like "the fleet benchmark returned negative", asks for nothing. A sentence asking for both refuses rather than picking one.

**A backend asked for in words behaves like a flag, not like a default.** If the fleet cannot run, the run REFUSES and executes nothing, because you decided.

**Backend selection is per run.** Precedence, highest first: the flag on this invocation, then the backend you asked for in words, then `claude_orchestration.execution_backend` in `.planning/config.json`, then the parallelism verdict's recommendation, then inline. A CONFIG default that cannot be honored falls back to inline and says so loudly, because a configuration value must never break an unattended build, and config is the only level that falls back. `--fleet` and `--inline` together is a REFUSAL, not last token wins. A flag beats a sentence when they disagree, and the run says which one it obeyed. The `resolve_execution_backend` step in the workflow runs `scripts/execution-backend-switch.cjs` and every outcome names the resolved backend, the reason, and which precedence level decided it.

**Active flags must be derived from `$ARGUMENTS`:**
- `--wave N` is active only if the literal `--wave` token is present in `$ARGUMENTS`
- `--gaps-only` is active only if the literal `--gaps-only` token is present in `$ARGUMENTS`
- `--interactive` is active only if the literal `--interactive` token is present in `$ARGUMENTS`
- `--fleet` is active only if the literal `--fleet` token is present in `$ARGUMENTS`
- `--inline` is active only if the literal `--inline` token is present in `$ARGUMENTS`
- If none of these tokens appear, run the standard full-phase execution flow with no flag-specific filtering
- Do not infer that a flag is active just because it is documented in this prompt

Context files are resolved inside the workflow via `ferrox-tools query init.execute-phase` and per-subagent `<files_to_read>` blocks.
</context>

<process>
Execute end-to-end.
Preserve all workflow gates (wave execution, checkpoint handling, verification, state updates, routing).
</process>
