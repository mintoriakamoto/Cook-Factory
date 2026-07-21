# Model Tiering + Trident

Model Tiering is what makes **"power when needed, cheap when not"** a rule in Ferrox
Factory rather than a hope. Its single promise: **work routes to the right-cost model
for its Build-Line stage, a failing task escalates at most one tier, a risk-boundary
path forces frontier + a cross-lineage Trident audit, that Trident runs at exactly two
bounded checkpoints (never an open-ended merge condition), and shell/dev ops route
through RTK when it is present — degrading gracefully everywhere the environment is
thinner.**

This reference is the **one place** the model-tiering model is described (mirroring
[strength.md](strength.md) for the strength layer, [coordination.md](coordination.md)
for the parallel-safety layer, and [halting.md](halting.md) for the anti-loop layer).
It **formalizes and hardens** the inherited model resolution
([model-profile-resolution.md](model-profile-resolution.md) →
[model-profiles.md](model-profiles.md)); it does **not** reinvent it. The six verbs
below are the enforceable cores; the `model.*` config block is their schema. Every
other reference and workflow that needs a tiering decision must **consult the verbs
named here** — it must never restate the route, escalate, risk-grade, Trident, or RTK
logic in prose. The verb is the single source of truth.

---

## Config block

The tiering knobs live under a single `model.*` block in `.planning/config.json`. All
keys have built-in fallbacks (sourced from the config-defaults manifest and propagated
through all three `config-loader` branches — the Phase-3 config-propagation trap), so an
absent or partial block degrades to the Build-Line defaults rather than crashing. Config
is resolved once at each router boundary (`loadConfig(cwd).model`) and the EXPLICIT
values are forwarded to the pure cores.

```jsonc
{
  "model": {
    "stage_tiers": {                 // Build-Line stage -> cost tier (MODEL-01)
      "discuss": "frontier",
      "plan": "frontier",
      "verify": "frontier",
      "wave-audit": "frontier",
      "audit": "frontier",
      "judgment": "frontier",
      "execute": "mid",
      "build": "mid",
      "grunt": "small"
    },
    "default_tier": "mid",           // unmapped stage falls to the mid workhorse, never undefined
    "tier_order": ["small", "mid", "frontier"],  // the escalation ladder low->high (MODEL-02)
    "max_escalations": 1,            // the one-hop cap: a second attempt is refused
    "risk_boundaries": [             // any path/category touching one forces high-risk (MODEL-03)
      "auth", "crypto", "payments", "pii", "deserialization", "network-file"
    ],
    "trident_checkpoints": [         // the EXACTLY TWO bounded audit checkpoints (MODEL-04)
      "plan-lock-gap-audit",
      "high-risk-wave-audit"
    ],
    "rtk": { "enabled": true }       // route shell/dev ops through rtk when present (MODEL-05)
  }
}
```

### Built-in fallbacks (used when a key is absent)

| Key | Default | Meaning |
|-----|---------|---------|
| `model.stage_tiers` | see block above | The inspectable stage→tier map `model.route` resolves. frontier = judgment/verify/audit/plan/discuss/wave-audit; mid = build/execute; small = grunt. |
| `model.default_tier` | `mid` | An unmapped stage routes here — fail to the mid workhorse, never to `undefined`. |
| `model.tier_order` | `small, mid, frontier` | The escalation ladder `model.escalate` walks one hop at a time. |
| `model.max_escalations` | `1` | The one-hop cap. A second escalation attempt is `refused` (anti-runaway-cost). |
| `model.risk_boundaries` | `auth, crypto, payments, pii, deserialization, network-file` | Case-insensitive boundary tokens; a matching path/category forces `high-risk`. |
| `model.trident_checkpoints` | `plan-lock-gap-audit, high-risk-wave-audit` | The EXACTLY TWO allowed Trident checkpoints. A set that is not two distinct entries refuses `checkpoint-set-not-bounded`. |
| `model.rtk.enabled` | `true` | Route dev ops through rtk when it is ALSO present; else graceful passthrough. |

---

## The six verbs

Each verb is a tested, pure-by-injection core reached through
`ferrox-tools query <verb>`. The **emitted decision tokens below are byte-identical to
what the cores emit** (the Phase-4 doc/code token lesson) — the wiring test
(`tests/model-wiring.test.cjs`) asserts this doc documents ONLY those tokens.

### `model.route` — stage → tier (MODEL-01)

```bash
ferrox-tools query model.route --stage verify      # -> { "tier": "frontier" }
ferrox-tools query model.route --stage build       # -> { "tier": "mid" }
ferrox-tools query model.route --stage grunt        # -> { "tier": "small" }
ferrox-tools query model.route --dump               # -> { "map": { <stage>: <tier>, ... } }
```

Emits `tier` on a stage lookup and `map` on a `--dump` (the inspectable stage→tier map).
An unmapped stage falls to `default_tier`, then to `mid` — never `undefined`. Stage and
map keys are trim+lower-cased at match time. A bare `model.route` with neither `--stage`
nor `--dump` is an `InvalidArgs` error (non-zero, no crash) — a caller mistake fails
loudly rather than silently dumping the whole map.

### `model.escalate` — the one-hop cap (MODEL-02)

```bash
ferrox-tools query model.escalate --from small --attempt 1   # -> { "decision": "escalate", "tier": "mid" }
ferrox-tools query model.escalate --from small --attempt 2   # -> { "decision": "refused",  "tier": "small" }
```

Emits `escalate` (with the resolved next tier) or `refused` (capped — the current/top
tier). A failed task escalates EXACTLY ONE tier up `tier_order` and only while
`attempt <= max_escalations`; a second attempt, a task already at the top tier, or an
unknown `from` tier all fail closed to `refused`. There is NO loop and NO retry in the
core — the cap is the anti-runaway-cost rule.

### `model.risk-grade` — risk forces frontier + Trident (MODEL-03)

```bash
ferrox-tools query model.risk-grade --paths src/auth/login.ts --self-grade low
# -> { "grade": "high-risk", "forcesFrontier": true, "forcesTrident": true, "matched": ["auth"] }
ferrox-tools query model.risk-grade --paths src/util/format.ts --self-grade low
# -> { "grade": "low", "forcesFrontier": false, "forcesTrident": false, "matched": [] }
```

Emits `high-risk` (with `forcesFrontier`/`forcesTrident` true and the `matched` boundary
tokens) when ANY path or category touches ANY boundary — REGARDLESS of a low
`--self-grade` (the anti-self-downgrade rule). A benign wave returns the caller's
`--self-grade` with `forcesFrontier`/`forcesTrident` false. Boundary and candidate
tokens are trim+lower-cased at match time (case-insensitive); a candidate matches when it
CONTAINS a boundary token (so `src/auth/login.ts` matches `auth`).

### `trident.audit` — bounded cross-lineage discovery (MODEL-04)

```bash
ferrox-tools query trident.audit --caller-family claude --checkpoint high-risk-wave-audit \
  --panel '[{"family":"codex","findings":["missing-authz"]},{"family":"gemini","findings":["missing-authz","weak-hash"]}]'
# -> { "decision": "complete", "pass": "single", "bounded": true,
#      "checkpoint": "high-risk-wave-audit", "panel_families": ["codex","gemini"],
#      "consensus": ["missing-authz"], "contested": ["weak-hash"] }
```

On a valid bounded call, emits `complete` with `pass: "single"`, `bounded: true`, the
resolved `checkpoint`, the `panel_families` (the caller's family is never present),
and the findings split into `consensus` (raised by ≥2 distinct families) vs `contested`
(exactly one). Otherwise it emits `refused` with EXACTLY ONE of five reasons, evaluated
in order:

| `reason` | Fires when |
|----------|-----------|
| `checkpoint-set-not-bounded` | `trident_checkpoints` is not exactly two distinct entries (an extra checkpoint smuggles a third audit loop — T-06-08). |
| `unbounded-invocation` | any `--open-ended` / `--loop-until-clean` / `--max-rounds > 1` shape — a single pass is the only legal shape (T-06-06, the anti-loop thesis). |
| `invalid-checkpoint` | the `--checkpoint` is not one of the two allowed. |
| `caller-family-in-panel` | any panel member's canonical LINEAGE equals the caller's lineage (a Claude-run audit draws from codex+gemini, never Claude — T-06-07). Lineage is canonicalized, so an alias (`anthropic` / `claude-opus` for a `claude` caller) cannot defeat the exclusion — MEDIUM-1. |
| `panel-not-cross-lineage` | after exclusion, the panel carries fewer than two DISTINCT non-caller lineages (an empty / single-family / same-lineage panel is a hollow receipt that does not prove ≥2 lineages reviewed — MEDIUM-2). |

Family and checkpoint comparisons are trim+lower-cased at match time; families are
further canonicalized to a lineage id (`anthropic`/`claude-*`/`opus`/`sonnet`/`haiku`→
`claude`, `openai`/`gpt-*`/`codex`/`o1`/`o3`→`openai`, `google`/`gemini*`→`google`;
unknown families are their own lineage) for BOTH the exclusion and the ≥2-lineage
inclusion checks. The core is PURE
(no fs, clock, config, or child_process) — the injected panel comes from the router seam;
the core itself NEVER spawns a CLI and contains NO loop.

### `rtk.wrap` — wrap the shell/dev op layer, or pass through (MODEL-05)

```bash
ferrox-tools query rtk.wrap --command git,status --rtk-present true   # (rtk.enabled) -> { "decision": "wrap", "wrapped": ["rtk","git","status"] }
ferrox-tools query rtk.wrap --command git,status --rtk-present false  # -> { "decision": "passthrough", "wrapped": ["git","status"] }
```

Emits `wrap` (the command prefixed with `rtk`) ONLY when `model.rtk.enabled` is strictly
true AND rtk is present AND the command is a non-empty string array; every other case —
disabled, rtk absent, empty command — fails closed to `passthrough` with the original
command unchanged. This is the graceful-degradation seam: the fork keeps working on a
machine without rtk.

### `rtk.report` — parse rtk's OWN savings figure, never fabricate (MODEL-05)

```bash
ferrox-tools query rtk.report --rtk-output 'Tokens saved: 45,231 (73% reduction)'
# -> { "saved": 45231, "source": "rtk", "pct": 73 }
ferrox-tools query rtk.report --rtk-output ''          # -> { "saved": 0, "source": "rtk", "error": "empty" }
```

Emits a `saved` count with `source: "rtk"` (and `pct` when present) parsed from rtk's OWN
output — a savings number is ONLY ever echoed from rtk, never fabricated (the honesty
rule). The parse is TOTAL (never throws): empty/whitespace input → `error: "empty"`; a
non-empty output with no savings figure → `error: "unparseable"`. The `--live` path feeds
real `rtk gain` output through the same core.

---

## The Trident bound (the anti-loop thesis)

Trident is a **DISCOVERY tool at exactly two bounded checkpoints, NOT a merge gate.**
This is the whole anti-loop thesis of the design, and it is enforced in the
`trident.audit` core — not merely asked for in prose:

- **Exactly two checkpoints.** `trident_checkpoints` must be exactly two distinct
  entries — `plan-lock-gap-audit` (the plan-lock gap-audit may reshape the plan ONCE)
  and `high-risk-wave-audit` (a high-risk wave surfaces criticals). A third checkpoint
  refuses `checkpoint-set-not-bounded`; an unknown checkpoint refuses
  `invalid-checkpoint`.
- **One pass, never a loop.** A single pass over a fixed panel is the ONLY legal shape.
  Any `--open-ended` / `--loop-until-clean` / `--max-rounds > 1` invocation refuses
  `unbounded-invocation`. Trident is **explicitly NOT** an open-ended / loop-until-clean
  merge condition — it never "loops until the auditor finds nothing."
- **Cross-lineage panel.** The panel draws from a cross-lineage set that EXCLUDES the
  caller's own lineage: a Claude-run audit is answered by codex + gemini, never Claude
  (`caller-family-in-panel`) — and the exclusion is by canonicalized LINEAGE, so an
  alias (`anthropic` / `claude-opus`) cannot slip a Claude reviewer back in (MEDIUM-1).
  The panel must ALSO carry at least two distinct non-caller lineages, else
  `panel-not-cross-lineage` — a "complete" verdict must prove ≥2 lineages actually
  reviewed, never a hollow one-lens or empty panel (MEDIUM-2). Findings raised by ≥2
  distinct families are `consensus`; a lone finding is `contested`.

---

## Mechanism vs Protocol (honest)

This layer is deliberately split so it can be trusted for exactly what it is:

- **Tested enforceable logic (mechanism).** Routing, the one-hop escalation cap,
  risk-grade boundary forcing, Trident's lineage-exclusion + checkpoint-bound +
  consensus tagging, and the rtk enable/passthrough decision are all DETERMINISTIC
  cores tested with INJECTED inputs. The verb ENFORCES the tier assignment, the
  escalation cap, and the panel lineage/bound.
- **Real-but-environment-dependent (bounded live demo).** The ACTUAL codex/gemini
  Trident panel and the ACTUAL rtk token measurement are real on a machine where those
  CLIs are on PATH — invoked through the single external-cli seam as a BOUNDED live demo
  (`tests/trident-rtk-live-demo.slow.test.cjs`, one pass each). That demo **degrades
  gracefully** and NEVER fails when a CLI is absent — it is not a CI hard-dependency. The
  seam is `shell:false`, single-shot (no retry), timeout-bounded, and returns
  `{ present:false }` on ENOENT/timeout without throwing.
- **Orchestration protocol.** WHICH agent actually runs at a resolved tier is the
  ORCHESTRATOR spawning it at that model. The verb does **NOT** spawn agents — it
  enforces the tier/cap/lineage/bound that the orchestrator then honors. The verbs are
  enforceable cores; the *routing* that consults them at the plan-lock / wave-audit /
  execute points is documented protocol.
