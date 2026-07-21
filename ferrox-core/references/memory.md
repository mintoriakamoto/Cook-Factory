# Memory Layer

The Memory Layer is the bi-temporal knowledge graph behind the mempalace seam.
Its single promise: **the factory remembers what it decided and why — and never
overwrites its own history.** Decisions and surprises are recorded as facts with
validity windows; superseding a fact retains the old one; the Frame stage recalls
prior decisions before planning and the Learn stage captures new ones after ship.

This reference is the **one place** the memory model is described (mirroring
[coordination.md](coordination.md) and [strength.md](strength.md)). The three
verbs below are the enforceable cores; the bi-temporal fact store is the
durability surface; `atomic-state` is the concurrency core. Every workflow that
needs a memory decision must **consult the verbs named here** — never restate the
fact-store or validity logic in prose. The verb is the single source of truth.

---

## The memory verbs

Each verb is a real, tested CLI core, dispatchable via `ferrox-tools query memory.<verb>`.
They are pure functions over an explicit `statePath` (the router resolves
`cwd + memory.fact_store`); every timestamp is an explicit input — no hidden clock.

### `memory.fact` — the four bi-temporal operations (MEM-01)

```bash
ferrox-tools query memory.fact --op add \
  --subject <s> --predicate <p> --object <o> --valid-from <ms> --recorded-at <ms>
ferrox-tools query memory.fact --op get-valid-at --ts <ms> [--subject <s>]
ferrox-tools query memory.fact --op history --subject <s>
ferrox-tools query memory.fact --op invalidate --subject <s> --predicate <p> --valid-to <ms>
```

- `add` — append a fact with `valid_to: null` (currently valid). MUTATION.
- `get-valid-at` — the facts valid at an instant (half-open window, below).
- `history` — every version for a subject (both superseded and current).
- `invalidate` — supersede the currently-valid match (set `valid_to`). MUTATION.

### `memory.recall` — valid-now prior decisions (MEM-02)

```bash
ferrox-tools query memory.recall --subject <s> --now-ts <ms>
```

Returns the prior decisions/patterns for `subject` valid at `now-ts`, filtered to
the decision/pattern predicate set (`decided`, `chose`, `pattern`, `prefers` —
matched case-insensitively), most-recent first, bounded by `memory.recall_limit`.
Read-only.

### `memory.capture` — write a decision, supersede a contradicted prior (MEM-02)

```bash
ferrox-tools query memory.capture --subject <s> --predicate decided \
  --object <decision> --valid-from <ms> --recorded-at <ms> [--contradicts]
```

Adds a decision/surprise fact. With `--contradicts` it first invalidates the
currently-valid prior (sets its `valid_to`), then adds the new — the contradicted
prior is retained, never deleted. MUTATION.

---

## The bi-temporal fact store (MEM-01)

A fact is:

```
{ subject, predicate, object,
  valid_from: number, valid_to: number | null,
  confidence: number, recorded_at: number }
```

stored as `{ facts: [...] }` under `memory.fact_store`, written atomically through
`atomic-state`.

**SUPERSEDE-DON'T-DELETE is the core invariant.** Updating a fact sets the old
one's `valid_to` and adds a new fact; the old fact is RETAINED, never overwritten
or removed. `history` shows both versions; `get-valid-at` an old timestamp returns
the old value; `get-valid-at` at or after `valid_to` returns the successor.

**Validity windows are half-open `[valid_from, valid_to)`.** A fact is valid at
`ts` iff `valid_from <= ts && (valid_to === null || ts < valid_to)`. The `valid_to`
instant belongs to the SUCCESSOR, not the predecessor.

---

## Behind the mempalace seam (MEM-02)

The memory verbs are the native `.planning/graphs/` KG backend of the mempalace
recall/capture commands:

- **Frame-and-Recall** — the plan-phase Frame stage consults `memory.recall`
  before planning (via `commands/ferrox/mempalace-recall.md`), so a settled
  decision is not re-litigated.
- **Learn** — the extract-learnings Learn stage consults `memory.capture` after
  ship (via `commands/ferrox/mempalace-capture.md`), persisting decisions and
  surprises; a contradicted prior is superseded via invalidate.

---

## The memory.* config block

Resolved by config-loader (Plan 01 propagation) and read only by the router:

| Key | Default | Meaning |
|-----|---------|---------|
| `memory.fact_store` | `.planning/graphs/memory-facts.json` | Bi-temporal fact store path |
| `memory.recall_limit` | `50` | Max valid-now facts `memory.recall` returns |

---

## Mechanism vs Protocol (honest)

- **Tested enforceable code:** the bi-temporal store + recall/capture logic
  (`add` / `get-valid-at` / `history` / `invalidate`, and recall/capture over
  them) is deterministic with injected timestamps and covered by
  supersede-don't-delete, boundary, and CLI integration tests. The store cannot
  silently delete a superseded fact.
- **Orchestration protocol:** the orchestrator calling `memory.recall` at Frame
  and `memory.capture` at Learn is a workflow convention — the verb stores and
  returns, the workflow invokes it at the stage. This is NOT enforced at the tool
  layer (unlike the Phase-5 PreToolUse merge-gate): an unreachable or empty store
  is a graceful no-op, never a block. Do not read the Frame/Learn consult as an
  un-bypassable gate.
