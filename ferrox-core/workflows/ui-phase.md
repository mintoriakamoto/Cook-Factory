<purpose>
Generate a UI design contract (UI-SPEC.md) for frontend phases. Orchestrates ferrox-ui-researcher and ferrox-ui-checker with a revision loop. Inserts between discuss-phase and plan-phase in the lifecycle.

UI-SPEC.md locks spacing, typography, color, copywriting, and design system decisions before the planner creates tasks. This prevents design debt caused by ad-hoc styling decisions during execution.
</purpose>

<required_reading>
@~/.claude/ferrox-core/references/ui-brand.md

If DESIGN.md exists at project root, it is binding context; read it before any UI/visual work.
</required_reading>

<available_agent_types>
Valid Ferrox subagent types (use exact names — do not fall back to 'general-purpose'):
- ferrox-ui-researcher — Researches UI/UX approaches
- ferrox-ui-checker — Reviews UI implementation quality
- ferrox-design-critic — Design eye: hierarchy, contrast, alignment, consistency, intent
- ferrox-a11y-design-reviewer — Design eye: design-phase WCAG 2.1 AA review
</available_agent_types>

<process>

## 1. Initialize

```bash
_FERROX_SHIM_NAME="ferrox-tools.cjs"; _FERROX_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; if [ -f "$FERROX_TOOLS" ]; then ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.claude/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${_FERROX_RUNTIME_ROOT}/.codex/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif command -v ferrox-tools >/dev/null 2>&1; then FERROX_TOOLS="$(command -v ferrox-tools)"; ferrox_run() { "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${HERMES_HOME:-$HOME/.hermes}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEX_HOME:-$HOME/.codex}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}" ]; then FERROX_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/ferrox-core/bin/${_FERROX_SHIM_NAME}"; ferrox_run() { node "$FERROX_TOOLS" "$@"; }; else echo "ERROR: ferrox-tools.cjs not found at $FERROX_TOOLS and ferrox-tools is not on PATH. Run: npx -y ferrox-factory@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${FERROX_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${FERROX_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(ferrox_run query init.plan-phase "$PHASE")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_UI=$(ferrox_run query agent-skills ferrox-ui-researcher)
AGENT_SKILLS_UI_CHECKER=$(ferrox_run query agent-skills ferrox-ui-checker)
```

Parse JSON for: `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `has_context`, `has_research`, `commit_docs`.

**File paths:** `state_path`, `roadmap_path`, `requirements_path`, `context_path`, `research_path`.

Detect sketch findings:
```bash
SKETCH_FINDINGS_PATH=$(ls ./.claude/skills/sketch-findings-*/SKILL.md 2>/dev/null | head -1 || true)
```

Resolve UI agent models:

```bash
UI_RESEARCHER_MODEL=$(ferrox_run query resolve-model ferrox-ui-researcher --raw)
UI_CHECKER_MODEL=$(ferrox_run query resolve-model ferrox-ui-checker --raw)
DESIGN_CRITIC_MODEL=$(ferrox_run query resolve-model ferrox-design-critic --raw)
A11Y_REVIEWER_MODEL=$(ferrox_run query resolve-model ferrox-a11y-design-reviewer --raw)
```

Check config:

```bash
UI_ENABLED=$(ferrox_run query config-get workflow.ui_phase 2>/dev/null || echo "true")
```

**If `UI_ENABLED` is `false`:**
```
UI phase is disabled in config. Enable via /ferrox:settings.
```
Exit workflow.

**If `planning_exists` is false:** Error — run `/ferrox:new-project` first.

## 2. Parse and Validate Phase

Extract phase number from $ARGUMENTS. If not provided, detect next unplanned phase.

```bash
PHASE_INFO=$(ferrox_run query roadmap.get-phase "${PHASE}")
```

**If `found` is false:** Error with available phases.

## 3. Check Prerequisites

**If `has_context` is false:**
```
No CONTEXT.md found for Phase {N}.
Recommended: run /ferrox:discuss-phase {N} first to capture design preferences.
Continuing without user decisions — UI researcher will ask all questions.
```
Continue (non-blocking).

**If `has_research` is false:**
```
No RESEARCH.md found for Phase {N}.
Note: stack decisions (component library, styling approach) will be asked during UI research.
```
Continue (non-blocking).

**If `SKETCH_FINDINGS_PATH` is not empty:**
```
⚡ Sketch findings detected: {SKETCH_FINDINGS_PATH}
   Validated design decisions from /ferrox:sketch will be loaded into the UI researcher.
   Pre-validated decisions (layout, palette, typography, spacing) should be treated as locked — not re-asked.
```

**DESIGN.md contract check:**
```bash
test -f DESIGN.md && echo "design_contract=present" || echo "design_contract=absent"
```
- **Present:** DESIGN.md is the binding design contract. Pass it verbatim to the UI
  researcher; UI-SPEC tokens (palette, type scale, spacing, components, voice) MUST derive
  from it, and its locked values are never re-asked. Precedence: DESIGN.md tokens first,
  then sketch findings, then researcher questions.
- **Absent:** recommend running `/ferrox:design-init` first so the UI-SPEC has durable
  tokens to enforce, then continue (non-blocking): a UI-SPEC written without a contract
  should offer to crystallize its final tokens into DESIGN.md at the end.

## 4. Check Existing UI-SPEC

```bash
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
```


**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
**If exists:** Use AskUserQuestion:
- header: "Existing UI-SPEC"
- question: "UI-SPEC.md already exists for Phase {N}. What would you like to do?"
- options:
  - "Update — re-run researcher with existing as baseline"
  - "View — display current UI-SPEC and exit"
  - "Skip — keep current UI-SPEC, proceed to verification"

If "View": display file contents, exit.
If "Skip": proceed to step 7 (checker).
If "Update": continue to step 5.

## 5. Spawn ferrox-ui-researcher

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Ferrox ► UI DESIGN CONTRACT — PHASE {N}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning UI researcher... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Build prompt:

```markdown
Read ~/.claude/agents/ferrox-ui-researcher.md for instructions.

<objective>
Create UI design contract for Phase {phase_number}: {phase_name}
Answer: "What visual and interaction contracts does this phase need?"
</objective>

<files_to_read>
- {state_path} (Project State)
- {roadmap_path} (Roadmap)
- {requirements_path} (Requirements)
- {context_path} (USER DECISIONS from /ferrox:discuss-phase)
- {research_path} (Technical Research — stack decisions)
- {SKETCH_FINDINGS_PATH} (Sketch Findings — validated design decisions, CSS patterns, visual direction from /ferrox:sketch, if exists)
</files_to_read>

${AGENT_SKILLS_UI}

<output>
Write to: {phase_dir}/{padded_phase}-UI-SPEC.md
Template: ~/.claude/ferrox-core/templates/UI-SPEC.md
</output>

<config>
commit_docs: {commit_docs}
phase_dir: {phase_dir}
padded_phase: {padded_phase}
</config>
```

Omit null file paths from `<files_to_read>`.

```
Agent(
  prompt=ui_research_prompt,
  subagent_type="ferrox-ui-researcher",
  model="{UI_RESEARCHER_MODEL}",
  description="UI Design Contract Phase {N}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

## 6. Handle Researcher Return

**If `## UI-SPEC COMPLETE`:**
Display confirmation. Continue to step 7.

**If `## UI-SPEC BLOCKED`:**
Display blocker details and options. Exit workflow.

## 7. Spawn ferrox-ui-checker

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Ferrox ► VERIFYING UI-SPEC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Spawning UI checker... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Build prompt:

```markdown
Read ~/.claude/agents/ferrox-ui-checker.md for instructions.

<objective>
Validate UI design contract for Phase {phase_number}: {phase_name}
Check all 6 dimensions. Return APPROVED or BLOCKED.
</objective>

<files_to_read>
- {phase_dir}/{padded_phase}-UI-SPEC.md (UI Design Contract — PRIMARY INPUT)
- {context_path} (USER DECISIONS — check compliance)
- {research_path} (Technical Research — check stack alignment)
</files_to_read>

${AGENT_SKILLS_UI_CHECKER}

<config>
ui_safety_gate: {ui_safety_gate config value}
</config>
```

```
Agent(
  prompt=ui_checker_prompt,
  subagent_type="ferrox-ui-checker",
  model="{UI_CHECKER_MODEL}",
  description="Verify UI-SPEC Phase {N}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

## 8. Handle Checker Return

**If `## UI-SPEC VERIFIED`:**
Display dimension results. Proceed to step 9.5.

**If `## ISSUES FOUND`:**
Display blocking issues. Proceed to step 9.

## 9. Revision Loop (Max 2 Iterations)

Track `revision_count` (starts at 0).

**If `revision_count` < 2:**
- Increment `revision_count`
- Re-spawn ferrox-ui-researcher with revision context:

```markdown
<revision>
The UI checker found issues with the current UI-SPEC.md.

### Issues to Fix
{paste blocking issues from checker return}

Read the existing UI-SPEC.md, fix ONLY the listed issues, re-write the file.
Do NOT re-ask the user questions that are already answered.
</revision>
```

- After researcher returns → re-spawn checker (step 7)

**If `revision_count` >= 2:**
```
Max revision iterations reached. Remaining issues:

{list remaining issues}

Options:
1. Force approve — proceed with current UI-SPEC (FLAGs become accepted)
2. Edit manually — open UI-SPEC.md in editor, re-run /ferrox:ui-phase
3. Abandon — exit without approving
```

Use AskUserQuestion for the choice.

**On "Force approve":** proceed to step 9.5 (the UI-consideration probe still runs on the accepted UI-SPEC, so state coverage is recorded even when quality FLAGs were accepted), then step 10. **On "Edit manually" / "Abandon":** exit without running the probe.

## 9.5. UI-Consideration Probe (post-verification)

Run AFTER the checker approves the UI-SPEC (VERIFIED, or force-approved at step 9) — never inline
during authoring, so a revision-loop researcher rewrite (step 9) cannot clobber the section and the
`## UI Considerations` block is committed with the FINAL UI-SPEC. This is the visual analog of
spec-phase Step 5.5's edge probe, retargeted to the UI element/state axis. Reference:
@~/.claude/ferrox-core/references/ui-consideration-probe.md.

**Skip conditions:** if `--auto` and the UI-SPEC already carries a resolved `## UI Considerations`
section (re-run), the write-back is idempotent (it REPLACES that section, never appends). If the
runtime is non-Claude and the probe engine cannot be resolved, the shim FAILS LOUD (below) — it
never silently no-ops (a silent skip would drop the whole state-coverage axis).

**Runtime coverage compute — resolve and invoke ui-consideration-probe.cjs:**

```bash
# Resolve the compiled ui-consideration-probe.cjs against the Ferrox install dir via RUNTIME_DIR
# (#448) — NOT the consuming project's git root — falling back to git toplevel / $HOME/.claude.
# Mirrors spec-phase.md Step 5.5's edge-probe resolution idiom verbatim (same candidate paths).
_FERROX_RT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
UI_PROBE_JS=$(for _c in \
  "$_FERROX_RT/ferrox-core/bin/lib/ui-consideration-probe.cjs" \
  "$_FERROX_RT/bin/lib/ui-consideration-probe.cjs" \
  "$_FERROX_RT/.claude/bin/lib/ui-consideration-probe.cjs" \
  "$HOME/.claude/ferrox-core/bin/lib/ui-consideration-probe.cjs" \
  "$HOME/.claude/bin/lib/ui-consideration-probe.cjs"; do
  [ -f "$_c" ] && { echo "$_c"; break; }
done)

# Graceful degradation — never a silent skip. Build ONLY when $_FERROX_RT is a verified Ferrox source
# checkout (has tsconfig.build.json + src/ui-consideration-probe.cts), pinned with --prefix so we
# never trigger the CONSUMING project's own build during a ui-phase. Real installs ship the
# compiled .cjs via prepublishOnly, so this path only matters in a Ferrox dev checkout.
if [ -z "$UI_PROBE_JS" ]; then
  if [ -f "$_FERROX_RT/tsconfig.build.json" ] && [ -f "$_FERROX_RT/src/ui-consideration-probe.cts" ]; then
    npm --prefix "$_FERROX_RT" run build:lib 2>/dev/null || true
    UI_PROBE_JS=$(for _c in \
      "$_FERROX_RT/ferrox-core/bin/lib/ui-consideration-probe.cjs" \
      "$_FERROX_RT/bin/lib/ui-consideration-probe.cjs" \
      "$_FERROX_RT/.claude/bin/lib/ui-consideration-probe.cjs" \
      "$HOME/.claude/ferrox-core/bin/lib/ui-consideration-probe.cjs" \
      "$HOME/.claude/bin/lib/ui-consideration-probe.cjs"; do
      [ -f "$_c" ] && { echo "$_c"; break; }
    done)
  fi
  if [ -z "$UI_PROBE_JS" ]; then
    echo "ERROR: ui-consideration-probe.cjs not found — reinstall Ferrox or run \`npm run build:lib\` in your Ferrox checkout." >&2
    exit 1
  fi
fi

# Element extraction (MANUAL BY DESIGN — not an oversight): the agent reads the researcher-authored
# UI-SPEC prose (the described surfaces — the Design System / Copywriting rows and any element the
# researcher named) and writes ONE object per UI element/surface: {"id","text"} where text is the
# prose describing it. This mirrors spec-phase Step 5.5's edge-probe REQS_JSON step VERBATIM — a
# hand-populated heredoc guarded by the fail-loud <replace:> check below — the established, shipped
# pattern for feeding a probe from a prose spec. It is NOT mechanized on purpose: a UI-SPEC has no
# single machine-parseable "elements" column — surfaces are distributed across design-token tables
# (Design System / Typography / Color), the Copywriting section, and prose the researcher names, so a
# regex/table parse would fail-OPEN (miss a prose-named surface, or feed a design-token row as a bogus
# element). The agent-authored heredoc + fail-loud guard is the conservative choice, identical to the
# requirement-side edge-probe path (RR-04). If a future UI-SPEC gains a canonical element table,
# revisit to parse it. Populate the heredoc from the UI-SPEC; the guard below fails loud on a
# forgotten substitution (never a no-op).
ELEMENTS_JSON=$(mktemp "${TMPDIR:-/tmp}/ui-probe-elements-XXXXXX") && mv "$ELEMENTS_JSON" "${ELEMENTS_JSON}.json" && ELEMENTS_JSON="${ELEMENTS_JSON}.json" || exit 1
cat > "$ELEMENTS_JSON" <<'JSON'
[
  { "id": "E1", "text": "<replace: element/surface description from the UI-SPEC prose>" }
]
JSON
if ! node -e 'const a=require(process.argv[1]);if(!Array.isArray(a)||a.length===0)process.exit(1);if(a.some(e=>typeof e.text!=="string"||!e.text.trim()||e.text.includes("<replace:")))process.exit(1)' "$ELEMENTS_JSON" 2>/dev/null; then
  rm -f "$ELEMENTS_JSON"
  echo "ERROR: ui-probe elements JSON is empty/invalid or still holds the <replace: …> placeholder — populate \$ELEMENTS_JSON from the UI-SPEC's described surfaces before this step runs." >&2
  exit 1
fi
# Invoke the compiled engine and CAPTURE its report. FATAL-INVOKE GUARD: use `if ! COVERAGE=$(…)`,
# NEVER a bare `COVERAGE=$(node …)` — a bare capture swallows the engine's exit 2 (invalid shape /
# bad input) and falls through to prose re-derivation: fail-OPEN at the exact boundary the engine
# validation protects.
if ! COVERAGE=$(node "$UI_PROBE_JS" "$ELEMENTS_JSON"); then
  rm -f "$ELEMENTS_JSON"
  echo "ERROR: ui-consideration-probe engine failed (invalid shapes or bad input) — fix the element(s) and re-run; never proceed with empty coverage." >&2
  exit 1
fi
rm -f "$ELEMENTS_JSON"
# Malformed-report guard: exit 0 but garbage. The report must parse as { items[], coverage{} }.
if ! printf '%s' "$COVERAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{process.exit(1)}if(!r||!Array.isArray(r.items)||typeof r.coverage!=="object"||r.coverage===null)process.exit(1)})'; then
  echo "ERROR: ui-consideration-probe produced an unparseable or malformed coverage report — refusing to proceed with the resolution loop." >&2
  exit 1
fi
# Zero-applicable guard: a report where NO category applied across ANY element is far more likely a
# classification miss (or malformed elements) than a genuinely state-free UI. Surface it loudly.
APPLICABLE=$(printf '%s' "$COVERAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let n=0;try{n=JSON.parse(s).coverage.applicable}catch{n=0}process.stdout.write(String(n))})')
if [ "$APPLICABLE" = "0" ]; then
  echo "WARNING: ui-consideration-probe proposed ZERO applicable categories across all elements — likely a classification miss or malformed elements, not a genuinely state-free UI. Do NOT silently write an empty UI Considerations section." >&2
fi
```

If `$APPLICABLE` is `0`, do NOT proceed silently: ask via AskUserQuestion ("The UI probe found no
applicable state considerations — is this genuinely a state-free surface, or should we revisit the
element descriptions?"). Only write an empty section after explicit confirmation.

**Propose-then-confirm (the partial-cue mitigation — load-bearing).** For each element, the engine
reports the DETECTED element kinds (`classifyElement` over the built `.cjs`). The prose classifier
is heuristic and LOSSY: a surface that is genuinely both a form and a list, but whose prose trips
only the form cue, under-covers — and because SOMETHING classified, no `unclassified` signal fires.
So SURFACE the detected kinds to the user (AskUserQuestion) and ask whether any real element kind
was missed. If the user ADDs a kind, re-run that element with an authored `elements` override
(the union of detected + added) so the missed categories are raised. A single tripped cue is a
SIGNAL, not proof the element is only that kind — the confirm step, not the heuristic, is what makes
coverage sound.

**Resolution loop** (mirror spec-phase 5.5): resolve each applicable consideration via
AskUserQuestion — **Specify** (→ `covered`, write a concrete truth) / **Dismiss (reason required)** /
**Backstop** (a held-out/visual UI-state test) / **Defer** (→ `unresolved`). An `unclassified` row is
a manual-review nudge, not a hard block. Text mode (`workflow.text_mode` / `--text`) → numbered lists.

**Kind-confirmation under `--auto`.** The propose-then-confirm step above is an AskUserQuestion, so
under `--auto` it follows the spec-phase 5.5 convention (replace AskUserQuestion with Claude's
recommended choice): Claude re-reads each element's prose and authors the `elements` override (the
union of the detected kinds + any kind it identifies as missed) instead of prompting — so `--auto`
recall rests on Claude's kind-identification, not the heuristic cue-match alone. This matters because
`autoResolve` (below) is a RESOLUTION floor only: it resolves the *detected* categories and cannot
recover a kind that was never surfaced, so recall is fixed HERE, at kind-confirmation, before
resolution runs.

**`--auto` mode (two layers).** The adapter's `autoResolve` is the CODE floor: every applicable
consideration auto-`backstop`s (carrying the taxonomy question as its resolution) and an
`unclassified` candidate stays `unresolved` — it NEVER auto-`dismiss`es and never auto-backstops an
unclassified item (#1110). On top of that floor the workflow MAY upgrade an item to `covered` when a
defensible acceptance criterion can be written (the same judgment spec-phase 5.5 applies in prose).
An auto `--auto` run therefore leaves un-upgraded backstops as `backstop`: at verify time each one
with no wired evidence routes to `insufficient_spec → human_needed` — never a silent pass (#1154).
That surfacing is the intended honest-verifier behavior, not over-flagging.

**Write-back.** Populate a `## UI Considerations` section in the UI-SPEC from the resolved
considerations, in the format the shipped plan-phase `## UI Considerations` lift rule reads:
`covered` → a truth string; `backstop` → a flat scalar `{ statement, verification: backstop }`;
`unresolved` → an explicit `⚠ unresolved — planner must treat as assumption` row. Empty-state and
error-state COPY stays in `## Copywriting Contract` — the considerations section covers shape-rooted
STATE coverage and REFERENCES those rows rather than restating the copy (de-dup). IDEMPOTENT: if a
`## UI Considerations` section already exists, REPLACE it — never append a duplicate.

## 9.7. Design Eyes Cross-Audit (2 parallel independent eyes)

Runs after the UI-consideration probe, on the FINAL UI-SPEC plus every UI artifact this phase
produced (mockups, sketches, and visual companion screens under
`.planning/brainstorms/*/screens/` or the phase dir). Mirrors the execute-phase 3-eye
cross-audit dispatch idiom: the eyes are independent, so fire BOTH `Agent()` calls in a single
message and wait; wall clock is the slower eye, not the sum. Do no other work while they run.

Collect the artifact list first:

```bash
UI_ARTIFACTS=$(ls "${PHASE_DIR}"/*-UI-SPEC.md .planning/brainstorms/*/screens/*.html "${PHASE_DIR}"/mockups/**/*.html 2>/dev/null | tr '\n' ',')
```

**Web-ui gate first (mechanical floor + INDET handoff).** Before dispatching the eyes, run
the web-ui gate pack on every self-contained HTML artifact in the list (companion screens
and generated mockups satisfy the card's input contract by construction):

```bash
WEBUI_GATE_OUT=$(node gates/web-ui/gate.cjs "${artifact}" 2>&1)
```

Capture RAW STDOUT per artifact. Do NOT route the handoff through gateRunner.runGate:
parseGateOutput consumes only the FAIL lines plus the summary and drops INDET lines by
design; the raw stdout is the only surface that carries them. Then split the output 3 ways:

- `FAIL` lines: mechanical floor violations at the executable tier; carry them into the
  findings merge with the WU id as the kind.
- `INDET <ID> <reason-code>` lines: extract them verbatim and pass them to BOTH eyes as
  named judgment items in a `<gate_indet_items>` block; the pack refused to guess and these
  lines are exactly the judgment slice the eyes own.
- `UNSUPPORTED-INPUT`: the artifact does not satisfy the card's input contract
  (`gates/web-ui/card.md`); list it in a `<gate_unsupported>` block so the eyes cover the
  mechanical floor themselves on that surface (graceful degradation, documented in each
  a11y eye), and note it in the findings summary: "web-ui gate skipped {artifact}:
  UNSUPPORTED-INPUT".

**Screenshot verify (graceful, no hard dependency).** If chrome-devtools MCP tools
(`mcp__chrome-devtools__*` or a plugin-prefixed variant) or playwright MCP tools
(`mcp__playwright__*` or a plugin-prefixed variant) are available in this session AND a screen
is being served (visual companion running, or a dev server; check with
`ferrox-tools visual.status --project-dir .`, start one when useful with
`ferrox-tools visual.start --project-dir .`), capture the served screen at
1200px and 375px widths before dispatching the eyes, save under
`.planning/ui-reviews/` (the gitignore gate from ferrox-ui-auditor applies), and list the
screenshot paths in both prompts so render-level findings (overflow, clipped focus rings,
rendered contrast) ride with the critique. If neither tool family is available or nothing is
being served, skip with a 1-line note in the findings summary: "screenshot verify skipped: no
browser MCP available". Never install anything to make this pass.

Dispatch both eyes in parallel (single message, 2 calls):

```
Agent(
  prompt="Read ~/.claude/agents/ferrox-design-critic.md for instructions.

  <objective>Critique the Phase {N} UI artifacts against the design contract and the anti-template list.</objective>
  <required_reading>
  - DESIGN.md (project root, if present — binding contract)
  - {phase_dir}/{padded_phase}-UI-SPEC.md (token plan)
  - {context_path} (intent, if present)
  </required_reading>
  <surfaces>{UI_ARTIFACTS}{screenshot paths, if captured}</surfaces>
  <gate_indet_items>{raw INDET lines from the web-ui gate, if any; omit the block when none}</gate_indet_items>
  <gate_unsupported>{artifacts the gate refused as UNSUPPORTED-INPUT, if any; omit when none}</gate_unsupported>",
  subagent_type="ferrox-design-critic",
  model="{DESIGN_CRITIC_MODEL}",
  description="Design critique Phase {N}"
)
Agent(
  prompt="Read ~/.claude/agents/ferrox-a11y-design-reviewer.md for instructions.

  <objective>Design-phase WCAG 2.1 AA review of the Phase {N} UI artifacts.</objective>
  <required_reading>
  - DESIGN.md (project root, if present — accessibility floor may be declared here)
  - {phase_dir}/{padded_phase}-UI-SPEC.md
  </required_reading>
  <surfaces>{UI_ARTIFACTS}{screenshot paths, if captured}</surfaces>
  <gate_indet_items>{raw INDET lines from the web-ui gate, if any; omit the block when none}</gate_indet_items>
  <gate_unsupported>{artifacts the gate refused as UNSUPPORTED-INPUT, if any; omit when none}</gate_unsupported>",
  subagent_type="ferrox-a11y-design-reviewer",
  model="{A11Y_REVIEWER_MODEL}",
  description="A11y design review Phase {N}"
)
```

**Merge the returns** into 1 structured findings list (severity, pillar, kind, surface,
evidence, fix) and display it. Then route by max severity:

- **PASS / NOTE only:** record NOTEs as follow-ups in the UI-SPEC, proceed to step 10.
- **WARN:** display as non-blocking recommendations, record in the UI-SPEC, proceed.
- **BLOCK:** the phase does NOT proceed until every BLOCK finding is resolved or explicitly
  waived. Use AskUserQuestion per BLOCK finding (recommendation first: state the fix you would
  apply and why):
  - "Fix now (Recommended)" — re-spawn ferrox-ui-researcher with the finding as revision
    context (reuse the step 9 revision mechanism, same max-2-iteration cap), then re-run BOTH
    eyes on the revised artifacts.
  - "Waive" — record the waiver verbatim in a `## Design Eyes Waivers` section of the UI-SPEC
    (finding, reason, who waived, date). A waiver is loud, never silent.

  If BLOCK findings remain after the revision cap and the user declines to waive, exit the
  workflow with the findings list; do not present the UI-SPEC as ready.

## 10. Present Final Status

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Ferrox ► UI-SPEC READY ✓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**Phase {N}: {Name}** — UI design contract approved

Dimensions: 6/6 passed
{If any FLAGs: "Recommendations: {N} (non-blocking)"}

───────────────────────────────────────────────────────────────

## ▶ Next Up — [${PROJECT_CODE}] ${PROJECT_TITLE}

{If CONTEXT.md exists for this phase:}
**Plan Phase {N}** — planner will use UI-SPEC.md as design context

`/clear` then: `/ferrox:plan-phase {N}`

{If CONTEXT.md does NOT exist:}
**Discuss Phase {N}** — gather implementation context before planning

`/clear` then: `/ferrox:discuss-phase {N}`

(or `/ferrox:plan-phase {N}` to skip discussion)

───────────────────────────────────────────────────────────────
```

## 11. Commit (if configured)

```bash
ferrox_run query commit "docs(${padded_phase}): UI design contract" --files "${PHASE_DIR}/${PADDED_PHASE}-UI-SPEC.md"
```

## 12. Update State

```bash
ferrox_run query state.record-session \
  --stopped-at "Phase ${PHASE} UI-SPEC approved" \
  --resume-file "${PHASE_DIR}/${PADDED_PHASE}-UI-SPEC.md"
```

</process>

<success_criteria>
- [ ] Config checked (exit if ui_phase disabled)
- [ ] Phase validated against roadmap
- [ ] Prerequisites checked (CONTEXT.md, RESEARCH.md — non-blocking warnings)
- [ ] Existing UI-SPEC handled (update/view/skip)
- [ ] ferrox-ui-researcher spawned with correct context and file paths
- [ ] UI-SPEC.md created in correct location
- [ ] ferrox-ui-checker spawned with UI-SPEC.md
- [ ] All 6 dimensions evaluated
- [ ] Revision loop if BLOCKED (max 2 iterations)
- [ ] Web-ui gate run on the self-contained HTML artifacts; raw stdout captured; INDET lines handed to both eyes; UNSUPPORTED-INPUT artifacts noted for the eyes' fallback floor pass
- [ ] Design eyes cross-audit run: ferrox-design-critic + ferrox-a11y-design-reviewer dispatched in parallel on the final artifacts
- [ ] Screenshot verify attempted when a browser MCP is available (1200px + 375px), skipped with a note otherwise
- [ ] Every BLOCK finding from the eyes resolved or explicitly waived (waivers recorded in UI-SPEC) before final status
- [ ] Final status displayed with next steps
- [ ] UI-SPEC.md committed (if commit_docs enabled)
- [ ] State updated
</success_criteria>
