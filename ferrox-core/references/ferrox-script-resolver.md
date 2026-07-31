# Standard `ferrox_script` Resolver

Use this bootstrap block when a workflow must run a shipped `scripts/*.cjs` entry point.
Keep this resolver centralized; workflows paste this exact line and nothing else.
`tests/global-install-script-resolution.install.test.cjs` asserts every pasted copy is
byte identical to the block below, so a drifted copy fails the suite rather than failing
silently on a customer machine.

## Why this exists (FF-B477)

The prior form was 2 lines per call site:

```bash
FERROX_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
SWITCH="${FERROX_ROOT}/scripts/execution-backend-switch.cjs"
[ -f "$SWITCH" ] || SWITCH="${FERROX_ROOT}/.claude/scripts/execution-backend-switch.cjs"
```

`FERROX_ROOT` defaults to the git toplevel of the USER'S PROJECT, so neither candidate
could ever point at a GLOBAL install. `npx ferrox-factory --claude --global` is the first
option in the README and it installs to `~/.claude/scripts/`, which nothing looked at.
Fleet mode therefore refused on every machine that installed the documented default way,
while a local install worked because its second candidate happened to land on
`<project>/.claude/scripts/`.

## Resolution order, and why it is that order

1. `$RUNTIME_DIR` when the caller set it. An explicit root always wins.
2. The project tree. A repo that SELF HOSTS Ferrox keeps running its own copy of the
   scripts rather than a stale global install, which is what makes dogfooding honest.
   Probes `scripts/`, then the local install dirs `.claude/scripts/` and `.codex/scripts/`.
3. The install root, per runtime, honouring each runtime's config dir env var.

Step 3 mirrors `ferrox-core/references/ferrox-run-resolver.md` entry for entry and in the
same order. Both tables are checked against each other by the same test, so a runtime
added to one and not the other is a red suite, never a silent hole.

There is no `command -v` arm. `ferrox-tools` is on `PATH` because `package.json` declares
it as a `bin`; these `scripts/*.cjs` entry points are not `bin` entries and never appear
on `PATH`, so an arm probing for them there would always miss.

## Contract

`ferrox_script <basename.cjs>` prints an absolute path on stdout.

- Exit 0: the printed path EXISTS.
- Exit 1: nothing resolved. The printed path is the canonical project relative location,
  so the caller's error message names a real place rather than an empty string.

```bash
ferrox_script() { _n="$1"; _p="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; for _c in "${_p}/scripts/${_n}" "${_p}/.claude/scripts/${_n}" "${_p}/.codex/scripts/${_n}" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/${_n}" "${HERMES_HOME:-$HOME/.hermes}/scripts/${_n}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/scripts/${_n}" "${CODEX_HOME:-$HOME/.codex}/scripts/${_n}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/scripts/${_n}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/scripts/${_n}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/scripts/${_n}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/scripts/${_n}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/scripts/${_n}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/scripts/${_n}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/scripts/${_n}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/scripts/${_n}" "${GROK_AGENTS_HOME:-$HOME/.agents}/scripts/${_n}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/scripts/${_n}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/scripts/${_n}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/scripts/${_n}"; do [ -f "$_c" ] && { printf '%s\n' "$_c"; return 0; }; done; printf '%s\n' "${_p}/scripts/${_n}"; return 1; }
```

## Use

```bash
ferrox_script() { ... }   # the line above, pasted verbatim
SWITCH=$(ferrox_script execution-backend-switch.cjs)
```
