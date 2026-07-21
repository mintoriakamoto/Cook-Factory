# FluxRouter integration (v1.1, ROUTE-FLUX-01)

How Ferrox routes agent tiers through **FluxRouter** — an OpenAI-compatible model
gateway — without any core knowing FluxRouter exists.

> **FluxRouter is a private, secret service.** This doc covers only the Ferrox
> *integration surface* (config + host env). It documents nothing about
> FluxRouter's routing, pricing, or provider internals.

## The seam

Ferrox agents carry an abstract **tier** — `heavy` / `standard` / `light`
(`AGENT_DEFAULT_TIERS`, e.g. `ferrox-planner` = heavy, `ferrox-executor` =
standard, `ferrox-codebase-mapper` = light). The resolver
(`resolveModelForTier`) maps tier → a spawnable model-id via
`dynamic_routing.tier_models`. The mapped value is an **opaque alias string**:
the resolver returns it verbatim and never interprets it, so the cores stay
provider-agnostic. FluxRouter's lanes are just such aliases.

## Config (`.planning/config.json`)

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": {
      "heavy": "flux-reasoning",
      "standard": "flux-standard",
      "light": "flux-fast"
    }
  }
}
```

The top-level `dynamic_routing` block is schema-recognized
(`config-schema.manifest.json` →
`dynamic_routing.(enabled|escalate_on_failure|max_escalations|tier_models.(light|standard|heavy))`)
and propagates through the loader.

> ⚠ **The nested `tier_models.*` sub-keys are NOT validated.** A typo —
> `"havy"` instead of `"heavy"` — is passed through verbatim with **no warning**;
> the affected tier silently falls back to its Claude default (heavy→`opus`,
> standard→`sonnet`, light→`haiku`), so on a FluxRouter deployment those agents
> quietly run the wrong model. Only `light`/`standard`/`heavy` are honored.
> Always verify a new mapping with a resolve probe before trusting it:
> `node ferrox-core/bin/lib/model-resolver.cjs` → `resolveModelForTier(cwd, 'ferrox-planner', 0)`
> should return your heavy lane, not `opus`. (Hardening tracked: FF-B21.)

Resolution (locked by `tests/model-resolver-flux.test.cjs`):

| Agent tier | Example agent | Resolves to |
|---|---|---|
| heavy | ferrox-planner | `flux-reasoning` |
| standard | ferrox-executor | `flux-standard` |
| light | ferrox-codebase-mapper | `flux-fast` |

**One-hop escalation (MODEL-02):** at the default `max_escalations: 1`, a failed
light task climbs exactly one tier (`light` → `standard` → its alias), never
straight to the top. Raising `max_escalations` lets a task climb that many tiers
(e.g. `max_escalations: 2`, light attempt-2 → `heavy` lane), so keep it at 1 to
preserve the strict one-hop cap. Governed by `dynamic_routing.max_escalations`
and `escalate_on_failure`.

### `flux-auto` — the adaptive default lane

To hand tier selection to FluxRouter's own autopilot, map every tier to
`flux-auto`:

```json
"tier_models": { "heavy": "flux-auto", "standard": "flux-auto", "light": "flux-auto" }
```

Ferrox still emits its tier decision; `flux-auto` tells the gateway to route
adaptively. This is the zero-config day-one lane.

### Pinning a specific lane per agent

`model_overrides[<agent>]` (top resolution precedence) pins an exact lane for one
agent, e.g. force the verifier onto `flux-reasoning` while everything else runs
`flux-standard`. Composes with `tier_models`.

## Host-env wiring

Ferrox never dials the API — the **host runtime** does. Point it at FluxRouter's
OpenAI-compatible endpoint (base URL + `sk-flux` key) via the runtime's normal
model env. `model_profile: "inherit"` gives a zero-config smoke test: agents run
whatever the host session's model is, through the gateway.

The alias strings above must match the lane names your FluxRouter deployment
exposes. Ferrox validates none of them — an unknown alias fails at the host, not
in a Ferrox core.

## What did NOT change

`model-route`, `model-escalate`, `model-risk-grade`, and the resolver remain
provider-agnostic. No FluxRouter-specific branch exists in any core — the entire
integration is config + host env. That is the design: Ferrox routes *tiers*;
the host maps *tiers→endpoints*.
