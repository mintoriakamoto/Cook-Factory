# Claude orchestration — Workflow execution backend (BETA)

> Injected at `execute:wave:post` `into: executor` only when
> `claude_orchestration.enabled` is true. Default-off; `onError: skip`.

## When this contribution is active

The Claude orchestration capability is **default-off and BETA**. It activates only
when ALL of the following hold:

1. `claude_orchestration.enabled` is `true` in `.planning/config.json`, AND
2. the active runtime is **Claude Code** (the Workflow tool is Claude / Agent
   SDK-specific), AND
3. `claude_orchestration.execution_backend` resolves to `workflow` — either
   explicitly, or via `auto` — **and** the Agent SDK version is
   `>= claude_orchestration.min_agent_sdk_version` (default `0.3.149`). The SDK
   floor applies in both `auto` and `workflow` modes (fail-closed: a pre-release
   or older SDK never activates the preview backend).

Detection is fail-closed: any miss degrades to **inline, manual, one-agent-per-
message dispatch** — exactly today's behaviour. On a non-Claude runtime this
contribution is a no-op.

## What the executor does when the Workflow backend is active

Instead of the orchestrator fanning out one `Agent(subagent_type=ferrox-executor,
isolation=worktree, run_in_background=true)` per message (which on Claude Code
cannot nest further subagents — #853 — and so degrades to sequential inline
execution), execute-phase **emits a generated Workflow script** and lets the main
loop orchestrate it:

- **waves → one or more sequential `parallel()` barriers** — each wave is a
  barrier group; when plans within a wave share `files_modified`, they are split
  into separate sequential stages within that wave's barrier (the next wave
  still waits for the previous wave to complete).
- **plans → `agent(brief, { agentType: 'ferrox-executor', isolation: 'worktree' })`**
  — the SAME executor agent and worktree isolation the inline path uses, so the
  produced `SUMMARY.md` and commits are identical.
- **`files_modified` overlap → separate sequential stages** — two plans that
  touch the same file are placed in different stages within the wave (the same
  overlap rule execute-phase already applies inline).
- **`resumeFromRunId`** — wired to the phase run id, so an interrupted phase
  resumes without re-running completed plans.
- **`budget(tokens)`** — a shared token pool across the whole phase when the
  orchestrator passes a `budgetTokens` value to `emitWorkflowScript` (it is a
  function parameter, not a config key; the orchestrator decides the budget).

The emitter is a pure function exposed through the capability command surface:
`ferrox-tools claude-orchestration emit-workflow --waves <manifest.json> --run-id <id>
[--phase-dir <dir>] [--budget <n>]` (or `require('ferrox-core/bin/lib/claude-orchestration.cjs').emitWorkflowScript`
directly). It maps the phase's wave/plan manifest to the Workflow script string
and never invokes the Workflow tool itself; the orchestrator runs the emitted
script. Detection is resolved by the orchestrator calling the pure
`detectWorkflowBackend` with the LIVE host descriptor (the CLI
`ferrox-tools claude-orchestration detect-backend` is a simulation harness that
assumes a capable host unless `--no-nested-dispatch` is passed — it does not probe
the real runtime; the orchestrator supplies the real descriptor).

## The fleet execution backend (phase 21 SC2)

`claude_orchestration.execution_backend` accepts a fourth value, `fleet`. It
dispatches the wave to a fleet of worker command line interface PROCESSES rather
than to in process subagents. The same team roster binds to inline, workflow or
fleet; the mode decides only whether that team is 5 subagents or 5 operating
system processes, and nothing about planning changes between them.

**The fleet rung is runtime independent.** It is evaluated BEFORE the Claude
specific rungs, because a fleet of worker command line interfaces runs as separate
processes and needs no Workflow tool. Gating it behind the Claude runtime check
would refuse it on every other runtime for a reason that does not apply to it.

**The fleet rung OBSERVES rather than trusts.** A configuration value is not
evidence that a fleet can run, and a backend selected on a false premise is a
fleet dispatched against a runtime that is not there. The ladder is, first miss
wins, every miss resolving to inline with its own named reason:

1. `capability_disabled` when `claude_orchestration.enabled` is not true.
2. `backend_not_fleet` when `execution_backend` is not exactly `fleet`.
3. `fleet_capability_disabled` when the fleet engine's own `fleet.enabled` key is
   not true.
4. `fleet_interpreter_unavailable:<name>` when the interpreter the fleet engine
   declares does not resolve on PATH. OBSERVED by scanning PATH directly, with no
   shell, no `which` and no subprocess.
5. `fleet_artifact_missing:<path>` when a required fleet runtime artifact is
   absent, NAMING the specific artifact so a reader of the result learns what to
   fix. OBSERVED on the filesystem, rooted at the resolved project root.

Only with every rung observed open does it return
`{ available: true, backend: 'fleet', reason: 'fleet_backend_active' }`.

When the fleet backend is active, the executor emits a fleet DISPATCH MANIFEST
rather than a script:

`ferrox-tools claude-orchestration emit-workflow --waves <manifest.json>
--run-id <id> --backend fleet`

The manifest partitions each wave through the SAME `partitionStages` function the
Workflow emitter uses and validates through the SAME refusal ladder, so 2 plans
sharing a `files_modified` entry can never be placed in the same stage under one
backend and different stages under the other. A second overlap rule is how a plan
pair that is unsafe under one backend becomes safe under the other.

## Fallback contract

If detection resolves to `inline` (tool absent, SDK too old, runtime not Claude,
the fleet runtime absent, or the capability disabled), execute-phase MUST proceed
with the standard inline wave dispatch. The executor MUST NOT assume parallelism,
a shared budget, or resume-from-run-id semantics in that mode.

**This is unconditional and it applies to the fleet backend exactly as it applies
to the workflow backend.** A backend switch that can break an existing build is
worse than no switch. Every fleet miss above is a refusal that leaves today's
inline path intact, and the proof of it is a real child process run against a
scratch tree with the fleet artifacts genuinely absent and the interpreter
genuinely scrubbed from PATH, in which `emit-workflow` still emits a working
script. See `tests/claude-orchestration-failclosed.test.cjs`.
