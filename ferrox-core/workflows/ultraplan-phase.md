# Ultraplan Phase Workflow [BETA]

Offload Ferrox's plan phase to Claude Code's ultraplan cloud infrastructure.

⚠ **BETA feature.** Ultraplan is in research preview and may change. This workflow is
intentionally isolated from /ferrox:plan-phase so upstream changes to ultraplan cannot
affect the core planning pipeline.

---

<step name="banner">

Display the stage banner:

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Ferrox ► ULTRAPLAN PHASE  ⚠ BETA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ultraplan is in research preview (Claude Code v2.1.91+).
Use /ferrox:plan-phase for stable local planning.
```

</step>

---

<step name="runtime_gate">

Check that the session is running inside Claude Code:

```bash
if [ "$CLAUDECODE" = "1" ] || [ -n "$CLAUDE_CODE_ENTRYPOINT" ]; then
  CC_VERSION="$(claude --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
  if [ -n "$CC_VERSION" ] && [ "$(printf '%s\n' "2.1.91" "$CC_VERSION" | sort -V | head -n1)" = "2.1.91" ]; then
    echo "claude-code:${CC_VERSION}"
  else
    echo ""
  fi
else
  echo ""
fi
```

If the output is empty or unset, display the following error and exit:

```text
╔══════════════════════════════════════════════════════════════╗
║  RUNTIME ERROR                                               ║
╚══════════════════════════════════════════════════════════════╝

/ferrox:ultraplan-phase requires Claude Code.
ultraplan is not available in this runtime.

Use /ferrox:plan-phase for local planning instead.
```

</step>

---

<step name="initialize">

Parse phase number from `$ARGUMENTS`. If no phase number is provided, detect the next
unplanned phase from the roadmap (same logic as /ferrox:plan-phase).

Load Ferrox phase context:

```bash
_FERROX_SHIM_NAME="ferrox-tools.cjs"; _FERROX_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; if [ -f "$FERROX_TOOLS" ]; then ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif command -v ferrox-tools >/dev/null 2>&1; then FERROX_TOOLS="$(command -v ferrox-tools)"; ferrox_run() { "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; else echo "ERROR: ferrox-tools.cjs not found at $FERROX_TOOLS and ferrox-tools is not on PATH. Run: npx -y ferrox-factory@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${FERROX_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${FERROX_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(ferrox_run query init.plan-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `phase_found`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`,
`phase_dir`, `roadmap_path`, `requirements_path`, `research_path`, `planning_exists`.

**If `planning_exists` is false:** Error and exit:

```text
No .planning directory found. Initialize the project first:

/ferrox:new-project
```

**If `phase_found` is false:** Error with the phase number provided and exit.

Display detected phase:

```text
Phase {N}: {phase name}
```

</step>

---

<step name="build_prompt">

Build the ultraplan prompt from Ferrox context.

1. Read the phase scope from ROADMAP.md — extract the goal, deliverables, and scope for
   the target phase.

2. Read REQUIREMENTS.md if it exists (`requirements_path` is not null) — extract a
   concise summary (key requirements relevant to this phase, not the full document).

3. Read RESEARCH.md if it exists (`research_path` is not null) — extract a concise
   summary of technical findings. Including this reduces redundant cloud research.

Construct the prompt:

```text
Plan phase {phase_number}: {phase_name}

## Phase Scope (from ROADMAP.md)

{phase scope block extracted from ROADMAP.md}

## Requirements Context

{requirements summary, or "No REQUIREMENTS.md found — infer from phase scope."}

## Existing Research

{research summary, or "No RESEARCH.md found — research from scratch."}

## Output Format

Produce a Ferrox PLAN.md with the following YAML frontmatter:

---
phase: "{padded_phase}-{phase_slug}"
plan: "{padded_phase}-01"
type: "feature"
wave: 1
depends_on: []
files_modified: []
autonomous: true
must_haves:
  truths: []
  artifacts: []
---

Then a ## Plan section with numbered tasks. Each task should have:
- A clear imperative title
- Files to create or modify
- Specific implementation steps

Keep the plan focused and executable.
```

</step>

---

<step name="return_path_card">

Display the return-path instructions **before** triggering ultraplan so they are visible
in the terminal scroll-back after ultraplan launches:

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 WHEN THE PLAN IS READY — WHAT TO DO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When ◆ ultraplan ready appears in your terminal:

  1. Open the session link in your browser
  2. Review the plan — use inline comments and emoji reactions to give feedback
  3. Ask Claude to revise until you're satisfied
  4. Click "Approve plan and teleport back to terminal"
  5. At the terminal dialog, choose Cancel  ← saves the plan to a file
  6. Note the file path Claude prints
  7. Run: /ferrox:import --from <the file path>

/ferrox:import will run conflict detection, convert to Ferrox format,
validate via plan-checker, update ROADMAP.md, and commit.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Launching ultraplan for Phase {N}: {phase_name}...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

</step>

---

<step name="trigger">

Trigger ultraplan with the constructed prompt:

```text
/ultraplan {constructed prompt from build_prompt step}
```

Your terminal will show a `◇ ultraplan` status indicator while the remote session works.
Use `/tasks` to open the detail view with the session link, agent activity, and a stop action.

</step>
