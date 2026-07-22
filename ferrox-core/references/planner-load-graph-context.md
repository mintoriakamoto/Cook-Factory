# Planner — Load Graph Context

> Loaded by `ferrox-planner` at the `load_graph_context` step.

Check for knowledge graph:

```bash
ls .planning/graphs/graph.json 2>/dev/null
```

If graph.json exists, check freshness:

```bash
_FERROX_SHIM_NAME="ferrox-tools.cjs"; _FERROX_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; if [ -f "$FERROX_TOOLS" ]; then ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif command -v ferrox-tools >/dev/null 2>&1; then FERROX_TOOLS="$(command -v ferrox-tools)"; ferrox_run() { "$FERROX_TOOLS" "$@"; }; elif [ -f "$HOME/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="$HOME/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; else echo "ERROR: ferrox-tools.cjs not found at $FERROX_TOOLS and ferrox-tools is not on PATH. Run: npx -y ferrox-factory@latest --claude --local" >&2; exit 1; fi
ferrox_run graphify status
```

If the status response has `stale: true`, note for later: "Graph is {age_hours}h old -- treat semantic relationships as approximate." Include this annotation inline with any graph context injected below.

Query the graph for phase-relevant dependency context (single query per D-06):

```bash
ferrox_run graphify query "<phase-goal-keyword>" --budget 2000
```

Use the keyword that best captures the phase goal. Examples:
- Phase "User Authentication" -> query term "auth"
- Phase "Payment Integration" -> query term "payment"
- Phase "Database Migration" -> query term "migration"

If the query returns nodes and edges, incorporate as dependency context for planning:
- Which modules/files are semantically related to this phase's domain
- Which subsystems may be affected by changes in this phase
- Cross-document relationships that inform task ordering and wave structure

If no results or graph.json absent, continue without graph context.
