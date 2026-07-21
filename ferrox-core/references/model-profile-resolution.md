# Model Profile Resolution

Resolve model profile once at the start of orchestration, then use it for all Task spawns.

## Resolution Pattern

```bash
MODEL_PROFILE=$(cat .planning/config.json 2>/dev/null | grep -o '"model_profile"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -o '"[^"]*"$' | tr -d '"' || echo "balanced")
```

Default: `balanced` if not set or config missing.

## Lookup Table

@~/.claude/ferrox-core/references/model-profiles.md

Look up the agent in the table for the resolved profile. Pass the model parameter to Task calls:

```
Task(
  prompt="...",
  subagent_type="ferrox-planner",
  model="{resolved_model}"  # "inherit", "sonnet", or "haiku"
)
```

**Note:** Opus-tier agents resolve to `"inherit"` (not `"opus"`). This causes the agent to use the parent session's model, avoiding conflicts with organization policies that may block specific opus versions.

If `model_profile` is `"adaptive"`, agents resolve to role-based assignments (opus/sonnet/haiku based on agent type).

If `model_profile` is `"inherit"`, all agents resolve to `"inherit"` (useful for OpenCode `/model`).

## Usage

1. Resolve once at orchestration start
2. Store the profile value
3. Look up each agent's model from the table when spawning
4. Pass model parameter to each Task call (values: `"inherit"`, `"sonnet"`, `"haiku"`)

## Build-Line tiering consults (MODEL-01/02/03)

The inherited profile resolution above is **hardened** by three tested tiering verbs —
consult them, never restate their logic in prose. See
[model-tiering.md](model-tiering.md) for the `model.*` config block and the emitted
tokens.

- **`ferrox-tools query model.route --stage <stage>`** (MODEL-01) — resolves the cost
  tier for a Build-Line stage from the inspectable `model.stage_tiers` map
  (frontier = judgment/verify/audit; mid = build/execute; small = grunt);
  `--dump` returns the whole map. An unmapped stage falls to the mid workhorse, never
  `undefined`.
- **`ferrox-tools query model.escalate --from <tier> --attempt <n>`** (MODEL-02) — the
  one-hop failure-escalation cap: a failed task escalates EXACTLY one tier up
  `model.tier_order`, and a second attempt is `refused` (anti-runaway-cost).
- **`ferrox-tools query model.risk-grade --paths <a,b> --self-grade <g>`** (MODEL-03) —
  a path/category touching a `model.risk_boundaries` entry forces `high-risk`
  (`forcesFrontier`/`forcesTrident`) REGARDLESS of a low self-grade.

These verbs ENFORCE the tier assignment and the escalation cap; the orchestrator is what
spawns each agent at the resolved tier.
