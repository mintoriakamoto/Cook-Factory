<purpose>
Ferrox smart entry — the state-aware front door. Detect the current project situation via `ferrox-tools smart-entry --json`, present a short menu of the right next actions, and dispatch to exactly one existing Ferrox command. This is a launcher/router only; it never does the work itself.

This is a *menu* front door, not a second router. For in-project forward motion (planning → executing → verify-pending) the recommended action is `/ferrox:progress --next`, which delegates to the single gated advancement engine (`workflows/next.md`: Route 0 resume-incomplete-phase + Gates 1-3). smart-entry adds value only where `--next` cannot reach: pre-project, remediation (paused/blocked/verify-failed), and lifecycle exits (idle-stranded/complete). See `docs/adr/1787-ferrox-next-smart-entry.md`.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's `execution_context` before starting.
</required_reading>

<process>

<step name="text_mode">
**TEXT_MODE handling (non-Claude runtimes).**

Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
</step>

<step name="resolve">
**Resolve the ferrox_run shim.**

Run this resolver block exactly. It locates `ferrox-tools.cjs` across every supported runtime home and defines a `ferrox_run` function. If it cannot find the tool, it prints the standard install hint and exits non-zero.

```bash
```
</step>

<step name="detect">
**Detect the situation.**

```bash
_FERROX_SHIM_NAME="ferrox-tools.cjs"; _FERROX_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; if [ -f "$FERROX_TOOLS" ]; then ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif command -v ferrox-tools >/dev/null 2>&1; then FERROX_TOOLS="$(command -v ferrox-tools)"; ferrox_run() { "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; else echo "ERROR: ferrox-tools.cjs not found at $FERROX_TOOLS and ferrox-tools is not on PATH. Run: npx -y ferrox-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${FERROX_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${FERROX_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
SNAPSHOT=$(ferrox_run smart-entry --json 2>/dev/null)
```

Parse `SNAPSHOT` as JSON. It has the shape:

```json
{
  "situation": "executing",
  "recommended": "progress-next",
  "summary": "Phase 2 of 5 · 60% · executing",
  "signals": { "...": "..." },
  "actions": [
    { "id": "progress-next", "label": "Advance to the next step", "command": "/ferrox:progress --next", "recommended": true },
    { "id": "execute-phase", "label": "Continue executing phase 2", "command": "/ferrox:execute-phase", "recommended": false }
  ]
}
```

`situation` is one of: `no-project`, `paused`, `blocked`, `verify-failed`, `needs-first-phase`, `planning`, `executing`, `verify-pending`, `idle-stranded`, `complete`, `unknown`.

**Fallback (never strand the user):** `smart-entry --json` can fail for two reasons, and each has a different recovery. Parse `SNAPSHOT`; if it is empty, not valid JSON, or missing `actions`, apply the first matching recovery below — do NOT error.

1. **`ferrox-tools` itself is broken** (the failure is a `Cannot find module ...` / Node crash, not just an empty result). Probe by running `ferrox_run state-snapshot` — if THAT also errors, the whole tool layer is down and routing to `/ferrox:progress` would dead-end too (it also needs ferrox-tools). **Recover by reading state directly:**
   - Read `.planning/STATE.md` (frontmatter + body) with the Read tool. Extract: `status` (frontmatter `status:` or body `**Status:**`), `Phase:` from the body, `total_phases`/`percent` from a nested `progress:` frontmatter object if present, and any `## Blockers` items.
   - Synthesize a minimal result: `situation` = your best guess from the status text (`executing`/`verifying`/`planning`/`complete`/`paused`), `summary` = a one-line read ("Phase N of M · status"), and an `actions` list built from status (e.g. verifying → `/ferrox:verify-work`, executing → `/ferrox:execute-phase`, else `/ferrox:progress`), always including `/ferrox:quick` and `/ferrox:help`.
   - Print one line first: `smart-entry unavailable (ferrox-tools error) — reading state directly. The ferrox-tools layer may need a rebuild (rm tsconfig.build.tsbuildinfo && npm run build).`
   - Proceed to the `present` step with this synthesized result.

2. **Only `smart-entry` is unavailable** (e.g. older ferrox-core without the subcommand; `state-snapshot` still works). Run `/ferrox:progress` and stop. Print one line first: `smart-entry unavailable — showing progress.`
</step>

<step name="present">
**Present the menu.**

Show the `summary` line to orient the user, then offer the actions.

**If TEXT_MODE is false:** call `AskUserQuestion` with:
- `header`: a short label derived from `situation` (e.g. `executing` → "Continue work", `blocked` → "Unblock", `no-project` → "Get started", `complete` → "What next?").
- `question`: the `summary` line, then "What would you like to do?"
- `options`: the first 4 entries of `actions[]` in order. For each, `label` = the action's `label`, `description` = the action's `command`. The recommended action is already first; surface it as the first option. The user may also type a custom command (handled automatically).

**If TEXT_MODE is true:** print the `summary`, then a numbered list of ALL `actions[]` (not capped to 4 — text has no limit), then ask the user to type the number of their choice:

```
{summary}

  1. {actions[0].label}  ({actions[0].command})
  2. {actions[1].label}  ({actions[1].command})
  ...

Type a number, or describe what you want to do.
```

Wait for the user's response before continuing. Map the chosen number to the corresponding action.
</step>

<step name="display">
**Show the routing decision.**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Ferrox ► SMART ENTRY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Situation:** {situation}
**Routing to:** {chosen command}
```
</step>

<step name="dispatch">
**Dispatch and stop.**

Invoke the chosen action's `command`. If the user typed a free-form response instead of picking an action, treat it as freeform intent and route via `/ferrox:progress --do "<their text>"`.

After invoking the command, **stop**. The dispatched command owns everything from here. Do not continue, do not chain, do not re-enter this workflow.
</step>

</process>

<success_criteria>
- [ ] Situation detected via `ferrox_run smart-entry --json`
- [ ] Summary shown to orient the user
- [ ] Menu offered (AskUserQuestion, or numbered list under TEXT_MODE)
- [ ] Routing decision displayed before dispatch
- [ ] Exactly one command dispatched
- [ ] Any detection failure falls back to /ferrox:progress (never strands the user)
- [ ] No work done directly — launcher only
</success_criteria>
