<purpose>
Retroactive 7-pillar visual audit of implemented frontend code. Standalone command that works on any project — Ferrox-managed or not. Produces scored UI-REVIEW.md with actionable findings, then runs the design eyes (design critique + post-change a11y audit) as parallel independent reviewers.
</purpose>

<required_reading>
@~/.claude/ferrox-core/references/ui-brand.md

If DESIGN.md exists at project root, it is binding context; read it before any UI/visual work.
</required_reading>

<available_agent_types>
Valid Ferrox subagent types (use exact names — do not fall back to 'general-purpose'):
- ferrox-ui-auditor — Audits UI against design requirements (7 pillars)
- ferrox-design-critic — Design eye: hierarchy, contrast, alignment, consistency, intent
- ferrox-a11y-auditor — Design eye: post-change WCAG 2.1 AA audit of implemented surfaces
</available_agent_types>

<process>

## 0. Initialize

```bash
_FERROX_SHIM_NAME="ferrox-tools.cjs"; _FERROX_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; if [ -f "$FERROX_TOOLS" ]; then ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif command -v ferrox-tools >/dev/null 2>&1; then FERROX_TOOLS="$(command -v ferrox-tools)"; ferrox_run() { "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; else echo "ERROR: ferrox-tools.cjs not found at $FERROX_TOOLS and ferrox-tools is not on PATH. Run: npx -y ferrox-factory@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${FERROX_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${FERROX_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(ferrox_run query init.phase-op "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_UI_REVIEWER=$(ferrox_run query agent-skills ferrox-ui-auditor)
```

Parse: `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `commit_docs`.

```bash
UI_AUDITOR_MODEL=$(ferrox_run query resolve-model ferrox-ui-auditor --raw)
DESIGN_CRITIC_MODEL=$(ferrox_run query resolve-model ferrox-design-critic --raw)
A11Y_AUDITOR_MODEL=$(ferrox_run query resolve-model ferrox-a11y-auditor --raw)
```

Display banner:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Ferrox ► UI AUDIT — PHASE {N}: {name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 1. Detect Input State

```bash
SUMMARY_FILES=$(ls "${PHASE_DIR}"/*-SUMMARY.md 2>/dev/null)
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
UI_REVIEW_FILE=$(ls "${PHASE_DIR}"/*-UI-REVIEW.md 2>/dev/null | head -1)
```

**If `SUMMARY_FILES` empty:** Exit — "Phase {N} not executed. Run /ferrox:execute-phase {N} first."


**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
**If `UI_REVIEW_FILE` non-empty:** Use AskUserQuestion:
- header: "Existing UI Review"
- question: "UI-REVIEW.md already exists for Phase {N}."
- options:
  - "Re-audit — run fresh audit"
  - "View — display current review and exit"

If "View": display file, exit.
If "Re-audit": continue.

## 2. Gather Context Paths

Build file list for auditor:
- All SUMMARY.md files in phase dir
- All PLAN.md files in phase dir
- UI-SPEC.md (if exists — audit baseline)
- CONTEXT.md (if exists — locked decisions)

## 3. Spawn ferrox-ui-auditor

```
◆ Spawning UI auditor... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Build prompt:

```markdown
Read ~/.claude/agents/ferrox-ui-auditor.md for instructions.

<objective>
Conduct 7-pillar visual audit of Phase {phase_number}: {phase_name}
{If UI-SPEC exists: "Audit against UI-SPEC.md design contract."}
{If no UI-SPEC: "Audit against abstract 7-pillar standards."}
</objective>

<files_to_read>
- {summary_paths} (Execution summaries)
- {plan_paths} (Execution plans — what was intended)
- {ui_spec_path} (UI Design Contract — audit baseline, if exists)
- {context_path} (User decisions, if exists)
</files_to_read>

${AGENT_SKILLS_UI_REVIEWER}

<config>
phase_dir: {phase_dir}
padded_phase: {padded_phase}
</config>
```

Omit null file paths.

```
Agent(
  prompt=ui_audit_prompt,
  subagent_type="ferrox-ui-auditor",
  model="{UI_AUDITOR_MODEL}",
  description="UI Audit Phase {N}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

## 4. Handle Return

**If `## UI REVIEW COMPLETE`:**

Display score summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Ferrox ► UI AUDIT COMPLETE ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Phase {N}: {Name}** — Overall: {score}/28

| Pillar | Score |
|--------|-------|
| Copywriting | {N}/4 |
| Visuals | {N}/4 |
| Color | {N}/4 |
| Typography | {N}/4 |
| Spacing | {N}/4 |
| Experience Design | {N}/4 |
| Security and Headers | {N}/4 |

Top fixes:
1. {fix}
2. {fix}
3. {fix}

Full review: {path to UI-REVIEW.md}

───────────────────────────────────────────────────────────────

## ▶ Next

`/clear` then:

- `/ferrox:verify-work {N}` — UAT testing before phase completion

───────────────────────────────────────────────────────────────
```

## 4.5. Design Eyes Cross-Audit (2 parallel independent eyes)

Runs after the ui-auditor returns, on the same implemented surfaces. Mirrors the
execute-phase 3-eye cross-audit dispatch idiom: the eyes are independent, so fire BOTH
`Agent()` calls in a single message and wait; wall clock is the slower eye, not the sum. Do no
other work while they run. The critic grades design intent (against DESIGN.md when present
plus the anti-template list); the a11y auditor runs the post-change WCAG 2.1 AA pass on the
shipped code (its design-phase sister, ferrox-a11y-design-reviewer, fires earlier in
/ferrox:ui-phase).

**Web-ui gate first (mechanical floor + INDET handoff).** Before dispatching the eyes, run
the web-ui gate pack on every self-contained HTML surface in the audit scope (served
snapshots and standalone pages qualify; component sources and stylesheets do not):

```bash
WEBUI_GATE_OUT=$(node gates/web-ui/gate.cjs "${surface}" 2>&1)
```

Capture RAW STDOUT per surface. Do NOT route the handoff through gateRunner.runGate:
parseGateOutput consumes only the FAIL lines plus the summary and drops INDET lines by
design; the raw stdout is the only surface that carries them. Then split the output 3 ways:

- `FAIL` lines: mechanical floor violations at the executable tier; carry them into the
  findings merge with the WU id as the kind.
- `INDET <ID> <reason-code>` lines: extract them verbatim and pass them to BOTH eyes as
  named judgment items in a `<gate_indet_items>` block; the pack refused to guess and these
  lines are exactly the judgment slice the eyes own.
- `UNSUPPORTED-INPUT`: the surface does not satisfy the card's input contract
  (`gates/web-ui/card.md`); list it in a `<gate_unsupported>` block so the eyes cover the
  mechanical floor themselves on that surface (graceful degradation, documented in each
  a11y eye), and note it in the findings summary: "web-ui gate skipped {surface}:
  UNSUPPORTED-INPUT". Most implemented tsx/jsx scopes land here; that is expected, not an
  error.

**Screenshot verify (graceful, no hard dependency).** If chrome-devtools MCP tools
(`mcp__chrome-devtools__*` or a plugin-prefixed variant) or playwright MCP tools
(`mcp__playwright__*` or a plugin-prefixed variant) are available AND a dev server or visual
companion screen is being served (check with `ferrox-tools visual.status --project-dir .`;
start one when useful with `ferrox-tools visual.start --project-dir .`, stop it after with
`ferrox-tools visual.stop --project-dir .`), capture the surface at 1200px and 375px widths, save under
`.planning/ui-reviews/` (gitignore gate applies), and list the screenshot paths in both
prompts. Otherwise skip with a 1-line note: "screenshot verify skipped: no browser MCP
available". Never install anything to make this pass.

```
Agent(
  prompt="Read ~/.claude/agents/ferrox-design-critic.md for instructions.

  <objective>Critique the implemented Phase {N} surfaces against the design contract and the anti-template list.</objective>
  <required_reading>
  - DESIGN.md (project root, if present — binding contract)
  - {ui_spec_path} (token plan, if exists)
  - {context_path} (intent, if exists)
  </required_reading>
  <surfaces>{source scope from SUMMARY.md key-files}{screenshot paths, if captured}</surfaces>
  <gate_indet_items>{raw INDET lines from the web-ui gate, if any; omit the block when none}</gate_indet_items>
  <gate_unsupported>{surfaces the gate refused as UNSUPPORTED-INPUT, if any; omit when none}</gate_unsupported>",
  subagent_type="ferrox-design-critic",
  model="{DESIGN_CRITIC_MODEL}",
  description="Design critique Phase {N}"
)
Agent(
  prompt="Read ~/.claude/agents/ferrox-a11y-auditor.md for instructions.

  <objective>Post-change WCAG 2.1 AA audit of the implemented Phase {N} surfaces.</objective>
  <required_reading>
  - {summary_paths} (key-files = audit scope)
  </required_reading>
  <config>
  phase_dir: {phase_dir}
  padded_phase: {padded_phase}
  dev_server_url: {url if a dev server was detected, else omit}
  </config>
  <gate_indet_items>{raw INDET lines from the web-ui gate, if any; omit the block when none}</gate_indet_items>
  <gate_unsupported>{surfaces the gate refused as UNSUPPORTED-INPUT, if any; omit when none}</gate_unsupported>",
  subagent_type="ferrox-a11y-auditor",
  model="{A11Y_AUDITOR_MODEL}",
  description="A11y audit Phase {N}"
)
```

**Merge the returns** into 1 structured findings list (severity, pillar, kind, surface,
evidence, fix) and display it under the pillar score table. Route by max severity:

- **PASS / NOTE only:** proceed to commit.
- **WARN:** display as non-blocking recommendations; record as follow-ups in UI-REVIEW.md.
- **BLOCK:** the review does NOT close green until every BLOCK finding is resolved or
  explicitly waived. Use AskUserQuestion per BLOCK finding (recommendation first: state the
  fix and why):
  - "Fix now (Recommended)" — apply the fix (or route to /ferrox:audit-fix), then re-run the
    affected eye on the touched surfaces.
  - "Waive" — record the waiver verbatim in a `## Design Eyes Waivers` section of
    UI-REVIEW.md (finding, reason, who waived, date).

  Unresolved, unwaived BLOCKs are surfaced in the final status as ship blockers ahead of
  `/ferrox:verify-work`.

## Automated UI Verification (when Playwright-MCP is available)

If `mcp__playwright__*` tools are accessible in this session:

1. Navigate to each UI component described in the phase's UI-SPEC.md using
   `mcp__playwright__navigate` (or equivalent Playwright-MCP tool).
2. Take a screenshot of each component using `mcp__playwright__screenshot`.
3. Compare against the spec's visual requirements — dimensions, color palette,
   layout, spacing scale, and typography.
4. Report any dimension, color, or layout discrepancies automatically as
   additional findings within the relevant pillar section of UI-REVIEW.md.
5. Flag items that require human judgment (brand feel, content tone) as
   `needs_human_review: true` in the findings — these are surfaced to the user
   separately after the automated pass completes.

If Playwright-MCP is not available in this session, this section is skipped
entirely. The audit falls back to the standard code-only review described above.
No configuration change is required — the availability of `mcp__playwright__*`
tools is detected at runtime.

## 5. Commit (if configured)

```bash
ferrox_run query commit "docs(${padded_phase}): UI audit review" --files "${PHASE_DIR}/${PADDED_PHASE}-UI-REVIEW.md"
# Include the a11y report when the design eyes ran:
A11Y_FILE="${PHASE_DIR}/${PADDED_PHASE}-A11Y.md"
[ -f "$A11Y_FILE" ] && ferrox_run query commit "docs(${padded_phase}): a11y audit" --files "$A11Y_FILE"
```

</process>

<success_criteria>
- [ ] Phase validated
- [ ] SUMMARY.md files found (execution completed)
- [ ] Existing review handled (re-audit/view)
- [ ] ferrox-ui-auditor spawned with correct context
- [ ] UI-REVIEW.md created in phase directory
- [ ] Web-ui gate run on the self-contained HTML surfaces in scope; raw stdout captured; INDET lines handed to both eyes; UNSUPPORTED-INPUT surfaces noted for the eyes' fallback floor pass
- [ ] Design eyes cross-audit run: ferrox-design-critic + ferrox-a11y-auditor dispatched in parallel on the implemented surfaces
- [ ] Screenshot verify attempted when a browser MCP is available (1200px + 375px), skipped with a note otherwise
- [ ] Every BLOCK finding from the eyes resolved or explicitly waived (waivers recorded in UI-REVIEW.md)
- [ ] Score summary displayed to user
- [ ] Next steps presented
</success_criteria>
