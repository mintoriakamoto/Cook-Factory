# Gates Taxonomy

Canonical gate types used across Ferrox workflows. Every validation checkpoint maps to one of these four types.

---

## Gate Types

### Pre-flight Gate
**Purpose:** Validates preconditions before starting an operation.
**Behavior:** Blocks entry if conditions unmet. No partial work created.
**Recovery:** Fix the missing precondition, then retry.
**Examples:**
- Plan-phase checks for REQUIREMENTS.md before planning
- Execute-phase validates PLAN.md exists before execution
- Discuss-phase confirms phase exists in ROADMAP.md

### Revision Gate
**Purpose:** Evaluates output quality and routes to revision if insufficient.
**Behavior:** Loops back to producer with specific feedback. Bounded by iteration cap.
**Recovery:** Producer addresses feedback; checker re-evaluates. The loop also escalates early if issue count does not decrease between consecutive iterations (stall detection). After max iterations, escalates unconditionally.
**Cap resolution:** The iteration cap is **not** a hard-coded number here — it is resolved by
`gate.cap-check` against `halting.gates.<gate>.max_passes` and `halting.gates.<gate>.wall_clock_seconds`
(whichever fires first yields the gate's `cap_outcome`). The verb is the single source of truth for the
cap; see [halting.md](halting.md) for the config block, the verb signatures, and the run-log.
**Examples:**
- Plan-checker reviewing PLAN.md (cap via `gate.cap-check` → `halting.gates.plan-check.max_passes`, default 3)
- Verifier checking phase deliverables against success criteria

### Escalation Gate
**Purpose:** Surfaces unresolvable issues to the developer for a decision.
**Behavior:** Pauses workflow, presents options, waits for human input.
**Recovery:** Developer chooses action; workflow resumes on selected path.
**Cap resolution:** Two halting verbs bound this gate — consult them, never hard-code:
- When a revision cap resolves to `stop-and-rescope`, the rescope routine it routes into is
  bounded by `rescope.check` against `halting.rescope.max_attempts` (a 3rd attempt returns
  `hard-descope-or-kill`). See [halting.md](halting.md).
- An *open* human checkpoint is not open forever: `human-sla.check` times it against
  `halting.human_sla_seconds` and, on breach, parks the increment (`breached` + park record).
  See [halting.md](halting.md).
**Examples:**
- Revision loop exhausted after its `gate.cap-check` cap → `stop-and-rescope` → `rescope.check`
- Merge conflict during worktree cleanup
- Ambiguous requirement needing clarification
- A human checkpoint left open past `halting.human_sla_seconds` (`human-sla.check` breach → park)

### Abort Gate
**Purpose:** Terminates the operation to prevent damage or waste.
**Behavior:** Stops immediately, preserves state, reports reason.
**Recovery:** Developer investigates root cause, fixes, restarts from checkpoint.
**Examples:**
- Context window critically low during execution
- STATE.md in error state blocking /ferrox:next
- Verification finds critical missing deliverables

---

## Gate Matrix

| Workflow | Phase | Gate Type | Artifacts Checked | Failure Behavior |
|----------|-------|-----------|-------------------|------------------|
| plan-phase | Entry | Pre-flight | REQUIREMENTS.md, ROADMAP.md | Block with missing-file message |
| plan-phase | Step 12 | Revision | PLAN.md quality | Loop to planner; cap via `gate.cap-check` (`halting.gates.plan-check`) |
| plan-phase | Post-revision | Escalation | Unresolved issues | Surface to developer |
| execute-phase | Entry | Pre-flight | PLAN.md | Block with missing-plan message |
| execute-phase | Completion | Revision | SUMMARY.md completeness | Re-run incomplete tasks |
| verify-work | Entry | Pre-flight | SUMMARY.md | Block with missing-summary |
| verify-work | Evaluation | Escalation | Failed criteria | Surface gaps to developer |
| next | Entry | Abort | Error state, checkpoints | Stop with diagnostic |

---

## Implementing Gates

Use this taxonomy when designing or auditing workflow validation points:

- **Pre-flight** gates belong at workflow entry points. They are cheap, deterministic checks that prevent wasted work. If you can verify a precondition with a file-existence check or a config read, use a pre-flight gate.
- **Revision** gates belong after a producer step where quality varies. Always pair them with an iteration cap to prevent infinite loops. Do **not** hard-code the cap in the workflow — resolve it with `gate.cap-check` reading `halting.gates.<gate>.max_passes` / `wall_clock_seconds`, whichever fires first (see [halting.md](halting.md)). The config value should reflect the cost of each iteration -- expensive operations get fewer retries.
- **Escalation** gates belong wherever automated resolution is impossible or ambiguous. They are the safety valve between revision loops and abort. Present the developer with clear options and enough context to decide.
- **Abort** gates belong at points where continuing would cause damage, waste significant resources, or produce meaningless output. They should preserve state so work can resume after the root cause is fixed.

**Selection heuristic:** Start with pre-flight. If the check happens after work is produced, it is a revision gate. If the revision loop cannot resolve the issue, escalate. If continuing is dangerous, abort.

---

## Halting cap verbs by gate loop

Every bounded loop in the Build Line resolves its cap from a halting verb — the single source of
truth (D-05). Consult the verb; never restate a hard-coded number. These are enforceable, tested
cores, but the *routing* that calls them is documented protocol, **not** runtime-un-bypassable
enforcement (that is Phase-5 strength-gate territory — backlog FF-B10). See [halting.md](halting.md).

| Gate loop | Verb to consult | Config key | Fires |
|-----------|-----------------|------------|-------|
| Revision / iteration cap (plan-check, verify, wave-audit) | `gate.cap-check` | `halting.gates.<gate>.{max_passes,wall_clock_seconds,cap_outcome}` | the gate's `cap_outcome` |
| Plan-lock / rescope routine | `rescope.check` | `halting.rescope.max_attempts` | `hard-descope-or-kill` past the cap |
| Open human checkpoint SLA | `human-sla.check` | `halting.human_sla_seconds` | `breached` + park record |
| Ship / merge — time since last landed merge | `ship-clock.check` | `halting.ship_clock_seconds` | `RED` (descope-and-merge the passing subset) |
| Ship / merge — no-op merge guard | `coverage.delta` | (arithmetic; no config) | `not-landed` on a zero/negative coverage delta |

At a **ship/merge** point the two Ship-Clock teeth pair up: `ship-clock.check` fires `RED` when the
wall-clock since the last coverage-advancing merge exceeds `halting.ship_clock_seconds`, and
`coverage.delta` rejects a candidate merge that does not strictly advance coverage as `not-landed`.
Both are consulted by the ship/merge protocol.

### Strength merge gate at the ship/merge point (FF-B10 — now closed)

Beyond the two Ship-Clock teeth, the ship/merge protocol **CONSULTS `strength.merge-gate`** for
the aggregate landed verdict — receipts all `valid` + coverage `landed` + ownership `ok` + hot
seam `serialized` + burndown `ok` + no open security + no open CRITICAL/HIGH, returning `pass`
or `block(reasons[])` (fail-closed). See [strength.md](strength.md) for the eight strength verbs
and the config block.

Unlike the halting Ship-Clock verbs above — which are consulted as documented protocol —
`strength.merge-gate` is **ENFORCED at the tool layer** by the `ferrox-merge-gate-guard.js`
PreToolUse hook: a `git merge` / `gh pr merge` / `git pull` / `git rebase` / protected-branch or
release-tag push, and the GitHub MCP `merge_pull_request` / `push_files` /
`create_or_update_file` (protected-branch) tools, are blocked (`exit 2`) unless the gate returns
`pass`. **FF-B10 is CLOSED by that hook** for the KNOWN merge vectors — a caller can no longer
skip the gate by simply not invoking the verb.

**Honest scope (not overclaimed):** the hook covers all KNOWN merge vectors and fails closed, but
a client-side command/tool matcher is **not cryptographically un-bypassable** — an arbitrary
script or a novel tool can evade a matcher. The cryptographically-un-bypassable layer is
**server-side branch protection / a pre-receive hook**, tracked as publish-time item **FF-B17**.

| Gate loop | Verb to consult | Enforcement |
|-----------|-----------------|-------------|
| Ship / merge — aggregate landed verdict | `strength.merge-gate` | Enforced at the tool layer (covers known merge vectors, fails closed) via the `ferrox-merge-gate-guard.js` PreToolUse hook; server-side un-bypassable layer is FF-B17 |

### Trident cross-lineage discovery at the two bounded checkpoints (MODEL-04)

Two Build-Line checkpoints **CONSULT `ferrox-tools query trident.audit`** for a bounded,
cross-lineage discovery pass — the plan-lock gap-audit (`plan-lock-gap-audit`, which may
reshape the plan ONCE) and the high-risk wave-audit (`high-risk-wave-audit`, which
surfaces criticals on a risk-boundary wave). The panel draws from a cross-lineage set
that EXCLUDES the caller's own lineage (a Claude-run audit is answered by codex + gemini)
— the exclusion is by canonicalized lineage, so an alias (`anthropic` / `claude-opus`)
cannot slip a same-lineage reviewer back in (`caller-family-in-panel`, MEDIUM-1) — and the
panel must carry at least two distinct non-caller lineages, else `panel-not-cross-lineage`
(a "complete" verdict must prove ≥2 lineages reviewed, MEDIUM-2). Findings raised by ≥2
distinct families are tagged consensus vs contested. See [model-tiering.md](model-tiering.md)
for the verb, the config block, and the emitted tokens.

**Trident is BOUNDED — a single pass at exactly these two checkpoints, NOT a merge gate.**
It is explicitly **NOT** an open-ended / loop-until-clean merge condition: the
`trident.audit` core refuses any `--open-ended` / `--loop-until-clean` / `--max-rounds > 1`
shape (`unbounded-invocation`) and refuses a checkpoint set that is not exactly two
distinct entries (`checkpoint-set-not-bounded`). This is the anti-loop thesis (T-06-06):
Trident discovers, it never loops until an auditor finds nothing.

| Gate loop | Verb to consult | Enforcement |
|-----------|-----------------|-------------|
| Plan-lock gap-audit (`plan-lock-gap-audit`) | `trident.audit` | Bounded single cross-lineage pass — documented protocol; the verb enforces the two-checkpoint bound + caller-family exclusion (refuses `unbounded-invocation`) |
| High-risk wave-audit (`high-risk-wave-audit`) | `trident.audit` | Bounded single cross-lineage pass — documented protocol; the verb enforces the same bound, never a loop-until-clean merge condition |

## Per-Task Disciplines and Build Line Stages

Beyond these gate types, the vendored per-task disciplines are bound to the Build
Line stage where each applies. That binding is inspectable in
[discipline-stages.md](discipline-stages.md) — grep a `ferrox-{discipline}` skill
name there to resolve its named stage (`execute`, `verify`, `wave-audit`, or the
lifecycle-owned `discuss`).
