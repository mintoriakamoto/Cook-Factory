# Coordination Layer

The Coordination Layer is the parallel-safety core of Ferrox Factory. Its single promise:
**when many agents build in parallel, each writer stays in its lane, shared state has one
writer, and migration/sequence numbers never collide.** Ownership is checked against a
declared file set; hot seams serialize regardless of wave; migrations are centrally
allocated; shared-state writes are restricted to the orchestrator; and the shared halting
state is hot-seam-serialized and atomically written.

This reference is the **one place** the coordination model is described (mirroring
[halting.md](halting.md) for the anti-loop layer). The five verbs below are the enforceable
cores; the hot-seam registry is the shared-write surface; atomic-state is the durability
core. Every other reference and workflow that needs a coordination decision must **consult
the verbs named here** — it must never restate the ownership, seam, or shared-write logic in
prose. The verb is the single source of truth.

---

## The five verbs

Each verb is a real, tested CLI core, dispatchable via `ferrox_run query coord.<verb>`. They
are pure decision functions: they take explicit inputs (a declared/actual file set, a target
path, a sequence number) and return a terminal `decision`, with no hidden clock or global
mutation inside the check.

### `coord.ownership-check` — declared vs actual file set (COORD-01 backing)

```bash
ferrox_run query coord.ownership-check \
  --declared <a,b,c> --actual <a,b> --increment <id>
```

Compares the files a plan *declared* (its `files_modified` set) against the files it
*actually* wrote. Returns `ok` when `actual ⊆ declared`; any undeclared write is a
**wave-invalidating** signal — the plan escaped its lane, so the wave's parallelism
assumption is void. This is the runtime backing for the one-writer-per-worktree guarantee
(COORD-01, below).

```jsonc
{ "decision": "ok" }                 // actual ⊆ declared — plan stayed in its lane
{ "decision": "wave-invalidating", "undeclared": ["src/x.ts"] }  // undeclared write — wave invalidated
```

### `coord.hot-seam-check` — serialize-global for shared-write surfaces

```bash
ferrox_run query coord.hot-seam-check --files <a,b>
```

Consulted **before a wave parallelizes**. If any file in the set touches a registered hot
seam — a shared-write surface (`STATE.md`, `ROADMAP.md`, `BACKLOG.md`, migration sequences,
the shared halting state) — the plan must run **serial regardless of its wave assignment**.
A hot-seam plan runs serial even when the pairwise files-overlap heuristic found no conflict.

```jsonc
{ "decision": "parallel-ok" }        // no hot seam touched — wave may parallelize
{ "decision": "serialize-global" }   // hot seam touched — force PARALLELIZATION=false
```

### `coord.alloc-migration` — central migration/sequence allocation

```bash
ferrox_run query coord.alloc-migration
```

Allocates the next migration / monotonic sequence number centrally, so a parallel worktree
**never self-assigns** (which would collide with a sibling worktree picking the same number).

```jsonc
{ "number": 1 }
```

### `coord.check-migration` — validate an allocated number is the expected next

```bash
ferrox_run query coord.check-migration --number <n>
```

Validates that a proposed migration/sequence number was centrally allocated — the guard
against a self-assigned or out-of-order number sneaking in.

```jsonc
{ "decision": "valid" }              // n is a centrally-allocated number
{ "decision": "rejected-uncentral" } // never centrally allocated (self-assigned) — reject
```

### `coord.shared-write-check` — sole-writer rule for shared state

```bash
ferrox_run query coord.shared-write-check --actor <role> --target <path>
```

Enforces the **sole-writer rule**: the shared planning-state files (`STATE.md`, `ROADMAP.md`,
`BACKLOG.md`) have a single writer — the orchestrator. A non-orchestrator actor (an
executor / sub-agent) targeting one of these hot-seam paths is `forbidden`.

```jsonc
{ "decision": "forbidden", "matched": "**/STATE.md" }  // executor writing shared state — refused
{ "decision": "allowed" }                              // orchestrator, or a non-hot-seam path
```

---

## The hot-seam registry

The hot-seam registry is the shared list of write surfaces that must be serialized: the
shared planning-state files (`STATE.md`, `ROADMAP.md`, `BACKLOG.md`), migration/sequence
numbers, and the shared halting state. `coord.hot-seam-check` reads this registry to decide
`serialize-global`; `coord.shared-write-check` reads it to decide `forbidden` for a
non-orchestrator actor. The registry is the single place a "shared write surface" is defined —
adding a seam there makes both the pre-wave serialization consult and the sole-writer rule
cover it without restating paths in prose.

### FF-B12 — halting state is hot-seam-serialized + atomically written

The shared halting-state files (the `.planning/` halting run-log and the rescope / SLA /
ship-clock state that [halting.md](halting.md)'s verbs persist) are hot seams too. Under
FF-B12 they are now **hot-seam-serialized** (parallel writers do not race them) and
**atomically written** via the atomic-state core (write-temp-then-rename, so a crash mid-write
never leaves a torn file). This closes the last shared-write race between the anti-loop layer
and parallel waves.

---

## Mechanism vs Protocol (honest)

Be honest about what is enforced code and what is documented orchestration. This split is
deliberate: do not over-promise an autonomous, un-bypassable coordinator.

### Mechanism — enforced code, backed by red-green tests

These are the enforceable cores. They are real CLI verbs with tests; they take explicit
inputs and return a terminal decision:

- **Ownership** — `coord.ownership-check`: the declared-vs-actual set check that flags an
  undeclared write as wave-invalidating.
- **Hot-seam serialization** — `coord.hot-seam-check`: the registry lookup that returns
  `serialize-global` for a shared-write surface.
- **Migration allocation + validation** — `coord.alloc-migration` / `coord.check-migration`:
  central sequence allocation and the expected-next validation.
- **Sole-writer rule** — `coord.shared-write-check`: the actor+target check that forbids a
  non-orchestrator write to shared state.
- **The hot-seam registry + atomic-state** — the shared registry the seam/shared-write verbs
  read, and the atomic (temp-then-rename) writer that makes the shared halting state
  crash-safe (FF-B12).

**Honest scope of "enforced".** These cores are enforceable in the sense that they are real,
tested code: they take explicit inputs, return a terminal decision, and (for state) write
atomically. They are **not yet un-bypassable at runtime** — nothing stops a caller from
simply not invoking a verb. A coordination check the caller *cannot* skip (a fail-closed
PreToolUse / merge-gate hook) is **Phase-5 strength-gate territory** (backlog **FF-B10**).
Until that lands, the wave and commit references and the orchestrator **MUST consult these
verbs** as documented protocol; do not claim the routing itself is auto-enforced. The
greppable `ferrox_run query coord.*` citations in execute-phase.md, git-planning-commit.md,
and worktree-path-safety.md are what make the required consult inspectable.

### Protocol — documented orchestration the workflows follow

These are documented routines the workflows perform **on top of** the enforced cores. Their
enforceable cores are the tested verbs above; the routing itself is workflow protocol, not an
executable scheduler:

- **Pre-wave serialization.** Before a wave parallelizes, the workflow consults
  `coord.hot-seam-check`; on `serialize-global` it forces `PARALLELIZATION=false` for that
  wave. The enforced core is the seam decision; the "force this wave serial" reaction is the
  workflow-level routine.
- **Post-plan ownership consult.** After each plan completes, the workflow consults
  `coord.ownership-check`; on a non-`valid` decision it treats the wave as invalidated rather
  than merging silently. The enforced core is the ownership decision; the "invalidate the
  wave" reaction is the workflow-level routine.
- **Migration allocation on the shared seam.** A plan needing a sequence number allocates via
  `coord.alloc-migration` (never self-assigns in a worktree) and validates with
  `coord.check-migration`. The enforced cores are the allocation + validation verbs; "route
  every migration through the allocator" is the protocol.

**The verb is the single source of truth for every coordination decision.** Workflows and
references must consult the verb; they must never restate the ownership, seam, or
shared-write logic as a hard-coded rule in prose.

---

## COORD-01 — one-writer-per-worktree (honest scope)

COORD-01 is the fork's shipped GSD primitive for **one writer per worktree**: parallel
executors run in isolated git worktrees (`isolation="worktree"`), and the shipped guards make
each executor stay in its own tree and its own branch:

- **`worktree-path-safety.md`** — the cwd-drift sentinel (#3097) and absolute-path guard
  (#3099) that stop an executor from writing into the main repo instead of its worktree.
- **`worktree-branch-check.md`** — the fail-closed, verify-only spawn-time HEAD/base guard
  that halts (`exit 42`) if a worktree HEAD is on a protected branch or the wrong base, and
  refuses self-recovery (#2924, #48).

`coord.ownership-check` **backs** this guarantee at runtime: it turns any write outside a
plan's declared `files_modified` set into a wave-invalidating signal, so a writer that escapes
its declared lane is caught even if the filesystem guards passed.

**Explicit honest caveat — worktrees are DISABLED on this build.** COORD-01 is verified this
phase by **inspecting the shipped guards** (they exist and are non-empty) and **testing the
ownership check** — NOT by a live parallel worktree run. Worktrees are off this build, so no
live parallel execution is claimed or exercised. The guards + `coord.ownership-check` are
present and consulted as protocol; the un-bypassable, live-exercised enforcement is the
Phase-5 strength-gate story (FF-B10). This doc must not — and does not — over-claim a live
parallel run.
