<purpose>
Interactive configuration of third-party integrations for Ferrox — search API keys
(Brave / Firecrawl / Exa), code-review CLI routing (`review.models.<cli>`), and
agent-skill injection (`agent_skills.<agent-type>`). Writes to
`.planning/config.json` via `ferrox-tools` so unrelated keys are
preserved, never clobbered.

This command is deliberately separate from `/ferrox:settings` (workflow toggles)
and any `/ferrox-settings-advanced` tuning surface. It exists because API keys and
cross-tool routing are *connectivity* concerns, not workflow or tuning knobs.
</purpose>

<security>
**API keys are secrets.** They are written as plaintext to
`.planning/config.json` — that is where secrets live on disk, and file
permissions are the security boundary. The UI must never display, echo, or
log the plaintext value. The workflow follows these rules:

- **Masking convention: `****<last-4>`** (e.g. `sk-abc123def456` → `****f456`).
  Strings shorter than 8 characters render as `****` with no tail so a short
  secret does not leak a meaningful fraction of its bytes. Unset values render
  as `(unset)`.
- **Plaintext is never echoed by AskUserQuestion descriptions, confirmation
  tables, or any log line.** It is not written to any file under `.planning/`
  other than `config.json` itself.
- **`config-set` output is masked** for keys in the secret set
  (`brave_search`, `firecrawl`, `exa_search`) — see
  `ferrox-core/bin/lib/secrets.cjs`.
- **Agent-type and CLI slug validation.** `agent_skills.<agent-type>` and
  `review.models.<cli>` keys are matched against `^[a-zA-Z0-9_-]+$`. Inputs
  containing path separators (`/`, `\`, `..`), whitespace, or shell
  metacharacters are rejected. This closes off skill-injection attacks.
</security>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<process>

<step name="ensure_and_load_config">
Ensure config exists and resolve the active config path (flat vs workstream, #2282):

```bash
_FERROX_SHIM_NAME="ferrox-tools.cjs"; _FERROX_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; if [ -f "$FERROX_TOOLS" ]; then ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif command -v ferrox-tools >/dev/null 2>&1; then FERROX_TOOLS="$(command -v ferrox-tools)"; ferrox_run() { "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; else echo "ERROR: ferrox-tools.cjs not found at $FERROX_TOOLS and ferrox-tools is not on PATH. Run: npx -y ferrox-factory@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${FERROX_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${FERROX_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
ferrox_run query config-ensure-section
if [[ -z "${FERROX_CONFIG_PATH:-}" ]]; then
  if [[ -f .planning/active-workstream ]]; then
    WS=$(tr -d '\n\r' < .planning/active-workstream)
    FERROX_CONFIG_PATH=".planning/workstreams/${WS}/config.json"
  else
    FERROX_CONFIG_PATH=".planning/config.json"
  fi
fi
```

Store `$FERROX_CONFIG_PATH`. Every subsequent read/write uses it.
</step>

<step name="read_current">
Read the current config and compute a masked view for display. For each
integration field, compute one of:

- `(unset)` — field is null / missing
- `****<last-4>` — secret field that is populated (plaintext never shown)
- `<value>` — non-secret routing/skill string, shown as-is

```bash
BRAVE=$(ferrox_run query config-get brave_search --default null)
FIRECRAWL=$(ferrox_run query config-get firecrawl --default null)
EXA=$(ferrox_run query config-get exa_search --default null)
SEARCH_GITIGNORED=$(ferrox_run query config-get search_gitignored --default false)
```

For each secret key (`brave_search`, `firecrawl`, `exa_search`) the displayed
value is `****<last-4>` when set, never the raw string. Never echo the
plaintext to stdout, stderr, or any log.
</step>

<step name="section_1_search_integrations">

**Text mode (`workflow.text_mode: true` or `--text` flag):** Set
`TEXT_MODE=true` and replace every `AskUserQuestion` call with a plain-text
numbered list. Required for non-Claude runtimes.

Ask the user what they want to do for each search API key. For keys that are
already set, show `**** already set` and offer Leave / Replace / Clear. For
unset keys, offer Skip / Set.

```text
AskUserQuestion([
  {
    question: "Brave Search API key — used for web research during plan/discuss phases",
    header: "Brave",
    multiSelect: false,
    options: [
      // When already set:
      { label: "Leave (**** already set)", description: "Keep current value" },
      { label: "Replace", description: "Enter a new API key" },
      { label: "Clear", description: "Remove the stored key" }
      // When unset, use the two-option shape: Skip / Set.
    ]
  },
  {
    question: "Firecrawl API key — used for deep-crawl scraping",
    header: "Firecrawl",
    multiSelect: false,
    options: [ /* same Leave/Replace/Clear or Skip/Set */ ]
  },
  {
    question: "Exa Search API key — used for semantic search",
    header: "Exa",
    multiSelect: false,
    options: [ /* same Leave/Replace/Clear or Skip/Set */ ]
  },
  {
    question: "Include gitignored files in local code searches?",
    header: "Gitignored",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Respect .gitignore. Safer — excludes secrets, node_modules, build artifacts." },
      { label: "Yes", description: "Include gitignored files. Useful when secrets/artifacts genuinely contain searchable intent." }
    ]
  }
])
```

For each "Set" or "Replace", follow with a text-input prompt that asks for the
key value. **The answer must not be echoed back** in subsequent question
descriptions or confirmation text. Write the value via:

```bash
ferrox_run query config-set brave_search "<value>"     # masked in output
ferrox_run query config-set firecrawl "<value>"        # masked in output
ferrox_run query config-set exa_search "<value>"       # masked in output
ferrox_run query config-set search_gitignored true|false
```

For "Clear", write `null`:

```bash
ferrox_run query config-set brave_search null
```
</step>

<step name="section_2_review_models">

`review.models.<cli>` is a map that tells the code-review workflow which
shell command to invoke for a given reviewer flavor. Supported flavors:
`claude`, `codex`, `gemini`, `opencode`.

```text
AskUserQuestion([
  {
    question: "Review model CLI mapping — what next?",
    header: "Review",
    multiSelect: false,
    options: [
      { label: "Configure CLI", description: "Pick a reviewer flavor and set/clear its command" },
      { label: "Done", description: "Finish this section" }
    ]
  }
])
```

If "Configure CLI" is selected, ask:

```text
AskUserQuestion([
  {
    question: "Which reviewer CLI do you want to configure?",
    header: "CLI",
    multiSelect: false,
    options: [
      { label: "Claude", description: "review.models.claude — defaults to session model when unset" },
      { label: "Codex", description: "review.models.codex — bare model id injected into --model, e.g. 'gpt-5'" },
      { label: "Gemini", description: "review.models.gemini — bare model id injected into -m, e.g. 'gemini-2.5-pro'" },
      { label: "OpenCode", description: "review.models.opencode — bare model id injected into --model, e.g. 'claude-sonnet-4'" }
    ]
  }
])
```

For the selected CLI, show the current value (or `(unset)`) and offer
Leave / Replace / Clear, followed by a text-input prompt for the model id
string. Write via:

```bash
ferrox_run query config-set review.models.<cli> "<model id>"
```

After each update, return to the "Review model CLI mapping — what next?" question.
Loop until the user selects "Done".

The `review.models.<cli>` key is validated by the dynamic pattern
`^review\.models\.[a-zA-Z0-9_-]+$`. Empty CLI slugs and path-containing slugs
are rejected by `config-set` before any write.
</step>

<step name="section_3_agent_skills">

`agent_skills.<agent-type>` injects extra skill names into an agent's spawn
frontmatter. The slug is user-extensible, so input is free-text validated
against `^[a-zA-Z0-9_-]+$`. Inputs with path separators, spaces, or shell
metacharacters are rejected.

```text
AskUserQuestion([
  {
    question: "Agent skills mapping — what next?",
    header: "Agent Skills",
    multiSelect: false,
    options: [
      { label: "Configure agent", description: "Pick an agent type and set/clear skills" },
      { label: "Done", description: "Finish this section" }
    ]
  }
])
```

If "Configure agent" is selected, ask:

```text
AskUserQuestion([
  {
    question: "Configure agent_skills for which agent type?",
    header: "Agent Type",
    multiSelect: false,
    options: [
      { label: "ferrox-executor", description: "Skills injected when spawning executor agents" },
      { label: "ferrox-planner", description: "Skills injected when spawning planner agents" },
      { label: "ferrox-verifier", description: "Skills injected when spawning verifier agents" },
      { label: "Custom…", description: "Enter a custom agent-type slug" }
    ]
  }
])
```

For "Custom…", prompt for a slug and validate it matches
`^[a-zA-Z0-9_-]+$`. If it fails validation, print:

```text
Rejected: agent-type '<slug>' must match [a-zA-Z0-9_-]+ (no path separators,
spaces, or shell metacharacters).
```

and re-prompt.

For a selected slug, prompt for the comma-separated skill list (text input).
Show the current value if any, offer Leave / Replace / Clear. Write via:

```bash
ferrox_run query config-set agent_skills.<slug> "<skill-a,skill-b,skill-c>"
```

After each update, return to the "Agent skills mapping — what next?" question.
Loop until "Done".
</step>

<step name="confirm">
Display the masked confirmation table. **No plaintext API keys appear in this
output under any circumstance.**

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Ferrox ► INTEGRATIONS UPDATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Search Integrations
| Field              | Value             |
|--------------------|-------------------|
| brave_search       | ****<last-4>      |  (or "(unset)")
| firecrawl          | ****<last-4>      |
| exa_search         | ****<last-4>      |
| search_gitignored  | true | false      |

Code Review CLI Routing
| CLI         | Command                              |
|-------------|--------------------------------------|
| claude      | <value or (session model default)>   |
| codex       | <value or (unset)>                   |
| gemini      | <value or (unset)>                   |
| opencode    | <value or (unset)>                   |

Agent Skills Injection
| Agent Type       | Skills                    |
|------------------|---------------------------|
| <slug>           | <skill-a, skill-b>        |
| ...              | ...                       |

Notes:
- API keys are stored plaintext in .planning/config.json. The confirmation
  table above never displays plaintext — keys appear as ****<last-4>.
- Plaintext is not echoed back by this workflow, not written to any log,
  and not displayed in error messages.

Quick commands:
- /ferrox:settings — workflow toggles and model profile
- /ferrox-set-profile <profile> — switch model profile
```
</step>

</process>

<success_criteria>
- [ ] Current config read from `$FERROX_CONFIG_PATH`
- [ ] User presented with three sections: Search Integrations, Review CLI Routing, Agent Skills Injection
- [ ] API keys written plaintext only to `config.json`; never echoed, never logged, never displayed
- [ ] Masked confirmation table uses `****<last-4>` for set keys and `(unset)` for null
- [ ] `review.models.<cli>` and `agent_skills.<agent-type>` keys validated against `[a-zA-Z0-9_-]+` before write
- [ ] Config merge preserves all keys outside the three sections this workflow owns
</success_criteria>
