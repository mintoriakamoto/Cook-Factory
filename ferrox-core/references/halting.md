# Halting Layer

The Halting Layer is the anti-loop core of Ferrox Factory. Its single promise: **every
loop in the Build Line is bounded and every termination is logged.** Caps and wall-clock
budgets force each gate to resolve to exactly one of three cap-outcomes; rescope is globally
counted and capped; human touchpoints have an SLA; the Ship Clock has autonomous teeth.

This reference is the **one place** the halting mechanism is described. The config block below
is the schema; the five verbs below are the enforceable cores; the run-log below is the
evidence surface. Every other reference and workflow that needs a cap must **consult the
verbs named here** — it must never restate a hard-coded number. The verb is the single source
of truth (D-05).

---

## Config block

The halting knobs live under a single `halting.*` block in `.planning/config.json`. All keys
have built-in fallbacks, so an absent or partial block degrades to sane defaults rather than
crashing.

```jsonc
{
  "halting": {
    "gates": {
      // Per-gate overrides, keyed by gate id (e.g. "revision", "verify", "wave-audit").
      // Any gate not listed here uses the built-in fallbacks shown below.
      "<gate>": {
        "max_passes": 3,              // pass-cap: max revision passes before the cap fires
        "wall_clock_seconds": 1800,   // wall-clock budget for the gate's loop
        "cap_outcome": "stop-and-rescope"  // what the gate resolves to when a cap fires
      }
    },
    "rescope": {
      "max_attempts": 2              // global per-increment rescope attempts before hard-descope-or-kill
    },
    "human_sla_seconds": 86400,      // SLA window for an open human checkpoint before it is parked
    "ship_clock_seconds": 86400      // wall-clock since the last coverage-advancing merge before RED
  }
}
```

### Built-in fallbacks (used when a key is absent)

| Key | Default | Meaning |
|-----|---------|---------|
| `halting.gates.<gate>.max_passes` | `3` | Max passes before the pass-cap trigger fires. |
| `halting.gates.<gate>.wall_clock_seconds` | `1800` | Wall-clock budget; whichever of pass-cap / wall-clock fires **first** yields the cap_outcome. |
| `halting.gates.<gate>.cap_outcome` | `stop-and-rescope` | The cap-outcome this gate resolves to. One of the enum below. |
| `halting.rescope.max_attempts` | `2` | Global rescope attempts per increment before `hard-descope-or-kill`. |
| `halting.human_sla_seconds` | `86400` | SLA window (seconds) for an open human checkpoint. |
| `halting.ship_clock_seconds` | `86400` | Seconds since the last coverage-advancing merge before the Ship Clock goes RED. |

### `cap_outcome` enum

Every gate cap resolves to exactly one of these three outcomes:

| `cap_outcome` | Meaning |
|---------------|---------|
| `ship-with-backlog` | Land the passing subset now; file the remainder to the backlog. |
| `stop-and-rescope` | Halt the loop and route into the rescope routine (bounded by `halting.rescope.max_attempts`). |
| `escalate-to-human` | Surface to the developer for a decision (an Escalation Gate — see [gates.md](gates.md)). |

---

## The five verbs

Each verb is a real, tested CLI core, dispatchable via `ferrox_run query <verb>`. All timestamps
are **epoch milliseconds** passed as explicit flags (never a clock read inside the verb) — this
keeps the caps deterministic and testable. The run-log's ISO `ts` is derived from `--now-ts`.

### `gate.cap-check` — resolve a gate's iteration/wall-clock cap

```bash
ferrox_run query gate.cap-check \
  --gate <id> --increment <id> --passes <n> --start-ts <ms> --now-ts <ms>
```

Resolves `halting.gates.<gate>.{max_passes,wall_clock_seconds,cap_outcome}`. Returns `continue`
while under both caps, or the gate's `cap_outcome` when a cap fires — and **logs which trigger
fired** (`pass-cap` vs `wall-clock`) to the run-log. Whichever cap trips first wins.

```jsonc
{ "decision": "stop-and-rescope", "trigger": "pass-cap", "gate": "revision", "cap_outcome": "stop-and-rescope" }
// decision is "continue" while under cap; otherwise the gate's cap_outcome. trigger ∈ pass-cap | wall-clock.
```

### `rescope.check` — enforce the global rescope attempt counter

```bash
ferrox_run query rescope.check \
  --increment <id> --prev-size <n> --new-size <n> --now-ts <ms>
```

Enforces the global per-increment attempt counter capped at `halting.rescope.max_attempts` (2).
Each recorded rescope must be **strictly smaller** (`new-size < prev-size`); state persists at
`.planning/rescope-state.json`. A 3rd attempt is refused with `hard-descope-or-kill`.

```jsonc
{ "decision": "continue", "attempts": 1 }        // under cap, scope strictly shrank
{ "decision": "hard-descope-or-kill", "attempts": 2 }  // cap reached; refuse a 3rd rescope
```

### `human-sla.check` — SLA on an open human checkpoint

```bash
ferrox_run query human-sla.check \
  --increment <id> --opened-ts <ms> --now-ts <ms>
```

Given a checkpoint's open timestamp, returns `within` or `breached` against `halting.human_sla_seconds`.
On breach the increment is auto-parked (park record at `.planning/human-sla-park.json`).

```jsonc
{ "decision": "within" }
{ "decision": "breached" }   // + park record written
```

### `ship-clock.check` — autonomous teeth on the Ship Clock

```bash
ferrox_run query ship-clock.check \
  --increment <id> --last-merge-ts <ms> --now-ts <ms>
```

Wall-clock since the last coverage-advancing merge, against `halting.ship_clock_seconds`. Returns
`green` or `RED`; RED signals the descope-and-merge-the-passing-subset routine (HALT-04, below).

```jsonc
{ "decision": "green" }
{ "decision": "RED" }
```

### `coverage.delta` — reject a no-op ("not-landed") merge

```bash
ferrox_run query coverage.delta --before <n> --after <n>
```

Pure arithmetic: does a candidate merge advance requirement/VALIDATION coverage (delta > 0)? The
"landed" signal is gated on this — a no-op merge (zero coverage advance) is **rejected as not-landed**.

```jsonc
{ "decision": "landed", "delta": 2 }
{ "decision": "not-landed", "delta": 0 }
```

---

## Run-log: `.planning/halting-log.jsonl`

Every cap that fires appends one line to the append-only run-log at `.planning/halting-log.jsonl`.
This is the **evidence surface** that gates actually fired — it feeds Phase 5 receipts and Phase 8
DOG-02.

Each entry:

```jsonc
{ "ts": "2026-07-19T00:10:00.000Z", "gate": "revision", "trigger": "pass-cap", "cap_outcome": "stop-and-rescope", "increment": "demo" }
```

| Field | Description |
|-------|-------------|
| `ts` | ISO-8601 timestamp, derived from the verb's `--now-ts` ms (never a live clock read). |
| `gate` | The gate id whose cap fired. |
| `trigger` | Which cap tripped: `pass-cap` or `wall-clock`. |
| `cap_outcome` | The resolved outcome (the `cap_outcome` enum). |
| `increment` | The increment the cap fired against. |

---

## Mechanism vs Protocol

Be honest about what is enforced code and what is documented orchestration. This split is
deliberate (D-04): do not over-promise an autonomous scheduler.

### Mechanism — enforced code, backed by red-green tests

These are the enforceable cores. They are real CLI verbs with tests; they resolve config, take
explicit timestamps, return a decision, and write the run-log:

- **The gate caps** — `gate.cap-check`: pass-cap and wall-clock timers resolving a gate's `cap_outcome`.
- **The rescope counter** — `rescope.check`: the global per-increment attempt cap and the strictly-smaller-scope check, refusing a 3rd attempt with `hard-descope-or-kill`.
- **The SLA park transition** — `human-sla.check`: the SLA timer that fires `breached` and parks the increment (observable state transition).
- **The Ship Clock** — `ship-clock.check`: the wall-clock-since-last-landed-merge timer that fires `RED`.
- **The coverage-delta gate** — `coverage.delta`: the arithmetic that rejects a zero-delta merge as `not-landed`.

If you need a cap anywhere, call the verb. The number lives in `halting.*` config, resolved from
`.planning/config.json` by the verb's router (`loadConfig(cwd).halting`) — never restated in prose.

**Honest scope of "enforced".** These cores are enforceable in the sense that they are real,
tested code: they resolve config, take explicit time, return a terminal decision, and write the
run-log. They are **not yet un-bypassable at runtime** — nothing stops a caller from simply not
invoking the verb. A cap-check the caller *cannot* skip (a fail-closed PreToolUse / merge-gate
hook) is **Phase-5 strength-gate territory** (backlog **FF-B10**). Until that lands, the gate
references and the orchestrator **MUST consult these verbs** as documented protocol; do not claim
the routing itself is auto-enforced.

### Protocol — documented orchestration the workflows follow

These are documented routines the workflows perform **on top of** the enforced cores. Their
enforceable cores are the tested verbs above; the routing itself is workflow protocol, not an
executable scheduler. They are described here (and cited by the gate references) so the behavior
is inspectable, but they are **not** claimed as autonomous code:

- **HALT-03 — pull-next-queued-increment on an SLA park.** When `human-sla.check` returns `breached`
  and parks the current increment, the documented protocol is: the Build Line **pulls the next
  queued increment forward** rather than blocking on the parked one. The enforced core is the SLA
  timer + park transition (`human-sla.check`); the "pull next" scheduling is the workflow-level
  routine that reacts to the park. It is protocol, not a running scheduler.
- **HALT-04 — descope-to-the-already-passing-subset on a RED ship clock.** When `ship-clock.check`
  returns `RED`, the documented protocol is: **descope to the already-passing subset and merge that**,
  filing the remainder to the backlog — with `coverage.delta` guarding that the merge actually
  advances coverage (a no-op is rejected as `not-landed`). The enforced cores are the ship-clock
  RED signal and the coverage-delta gate; the "select the passing subset and merge it" routine is
  the workflow-level protocol that reacts to RED. It is protocol, not a running scheduler.

**The verb is the single source of truth for every cap.** Workflows and references must consult
the verb; they must never restate a hard-coded cap number.
