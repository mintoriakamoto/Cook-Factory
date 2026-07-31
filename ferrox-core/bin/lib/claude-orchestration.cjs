"use strict";
/**
 * Claude Orchestration Capability — Workflow-tool backend detection + emitter
 *
 * #1143 — adopts Claude Code's Workflow tool (the engine behind `/effort ultracode`)
 * as an optional, runtime-gated parallel-execution backend for the Ferrox loop.
 *
 * This module is the pure, testable core of the capability. It owns two seams:
 *
 *   detectWorkflowBackend({ runtimeId, hostIntegration, config, agentSdkVersion })
 *     → { available: boolean, backend: 'workflow'|'inline', reason: string }
 *     Fail-closed: every miss degrades to `inline` (today's behaviour), so the
 *     core loop is byte-identical unless every gate opens. This is criteria 3 + 6.
 *
 *   emitWorkflowScript({ phaseDir, waves, runId, budgetTokens? })
 *     → { ok:true, script, summary } | { ok:false, reason }
 *     Maps Ferrox's wave/plan model 1:1 onto Workflow primitives:
 *       wave  → sequential `parallel()` stage barriers,
 *       plan  → `agent(brief, { agentType:'ferrox-executor', isolation:'worktree' })`,
 *       files_modified overlap → forces plans into separate sequential stages
 *         (the same overlap rule execute-phase already applies inline),
 *       resumeFromRunId → wired to the phase run id,
 *       budgetTokens → a shared token pool.
 *     The emitted script composes the SAME ferrox-executor agent and worktree
 *     isolation the inline path uses, so it produces the same artifacts/commits
 *     (criterion 2). It is a generated string consumed by the orchestrator; this
 *     module never invokes the Workflow tool itself.
 *
 * Design laws:
 *   - Gall's Law: ship a small working slice that composes existing primitives
 *     (ferrox-executor + worktree isolation) rather than reinventing them.
 *   - Greenspun's Tenth Rule (cited in #1143): adopt the Workflow tool's
 *     barrier/pipeline/budget/resume semantics instead of hand-rolling them.
 *   - Postel's Law: liberal in input (missing fields → inline), conservative in
 *     output (workflow only when every gate opens).
 *   - Fail-closed: an unknown version, a missing descriptor, or a disabled
 *     toggle all resolve to `inline`, never to `workflow`.
 *
 * Zero third-party dependencies. Never throws on bad input.
 *
 * Phase 21 SC2 adds a FOURTH backend, `fleet`, and one seam that is not pure:
 * the fleet rung is an OBSERVATION of artifacts on disk and of an interpreter on
 * PATH, never a configuration value read back out of a configuration object. The
 * observation is injected as a `probe`, exactly as `clock.cjs` injects time and
 * `gate-cap.cjs` injects budgets, and the DEFAULT probe does the real filesystem
 * and PATH work rooted at an explicit project root. That is what lets both arms
 * of the fail-closed proof be real: a scratch tree with the artifacts genuinely
 * absent, and the same tree with every one of them genuinely planted.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// ─── Constants ────────────────────────────────────────────────────────────────
/**
 * The Agent SDK version that introduced the Workflow tool (#1143 prior art).
 * Used as the default floor when config does not override it. A runtime reporting
 * an agentSdkVersion below this cannot host the Workflow backend.
 */
const WORKFLOW_TOOL_FLOOR_VERSION = '0.3.149';
/** Closed enum for the `claude_orchestration.execution_backend` config key. */
const BACKEND_VALUES = new Set(['auto', 'workflow', 'inline', 'fleet']);
/** Only this runtime can host the Workflow tool (Claude Code / Agent SDK). */
const WORKFLOW_RUNTIME = 'claude';
/** The fourth backend value, named once so the router and the ladder agree. */
const FLEET_BACKEND = 'fleet';
/**
 * The interpreter the fleet engine declares as its own precondition.
 * READ from `capabilities/fleet/capability.json`, which states "Requires a Python 3
 * interpreter on PATH when enabled; the default inline execution path never needs
 * one." A committed test asserts that declaration is still there, so this constant
 * cannot silently outlive the requirement it tracks.
 */
const FLEET_INTERPRETER = 'python3';
/**
 * Every repository-relative artifact the fleet runtime needs before a fleet
 * dispatch can be anything other than a promise.
 *
 * ONE constant, exported, and iterated by the fail-closed battery rather than
 * transcribed into it. Two copies of a list is how a new artifact ships with no
 * coverage.
 *
 * `scripts/fleet-loop.cjs` is the driver produced by plan 19-05; if that plan's
 * driver is ever renamed or relocated, this is the single line to change and
 * `tests/claude-orchestration.test.cjs` names which. The 7 libs below are the
 * exact set the driver loads through its own `loadLib` at
 * `scripts/fleet-loop.cjs:194-206`; each is a hard require, so an absent one is a
 * fleet that cannot start.
 */
const FLEET_RUNTIME_ARTIFACTS = Object.freeze([
    'scripts/fleet-loop.cjs',
    'ferrox-core/bin/lib/fleet-runlog.cjs',
    'ferrox-core/bin/lib/fleet-runfold.cjs',
    'ferrox-core/bin/lib/fleet-board.cjs',
    'ferrox-core/bin/lib/fleet-landqueue.cjs',
    'ferrox-core/bin/lib/fleet-manager.cjs',
    'ferrox-core/bin/lib/fleet-park.cjs',
    'ferrox-core/bin/lib/fleet-probe.cjs',
]);
// ─── Semver helpers ───────────────────────────────────────────────────────────
/** Official-ish strict SemVer 2.0.0 numeric triple (+ optional pre/build). */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** True for a syntactically valid semver string. */
function isValidSemver(s) {
    return typeof s === 'string' && SEMVER_RE.test(s);
}
/**
 * Compare two semver strings.
 * Returns -1/0/1 in the usual sense. Garbage in either position → -1 (fail-closed:
 * an unparseable version is treated as "less than" any real floor, so detection
 * never accidentally enables the preview backend on an unknown SDK).
 *
 * Pre-release/build metadata are ignored for the comparison — only the numeric
 * major.minor.patch triple participates, matching how the Workflow-tool floor is
 * specified (a plain "0.3.149").
 */
function compareSemver(a, b) {
    if (!isValidSemver(a) || !isValidSemver(b))
        return -1;
    // Split numeric triple from pre-release/build metadata.
    const parseTriple = (s) => {
        const core = s.split('-')[0].split('+')[0].split('.');
        return [parseInt(core[0], 10), parseInt(core[1], 10), parseInt(core[2], 10)];
    };
    const hasPre = (s) => s.indexOf('-') !== -1;
    const preIdentifiers = (s) => (s.split('-')[1] || '').split('+')[0].split('.').filter((x) => x.length > 0);
    const am = parseTriple(a);
    const bm = parseTriple(b);
    for (let i = 0; i < 3; i++) {
        if (am[i] < bm[i])
            return -1;
        if (am[i] > bm[i])
            return 1;
    }
    // Numeric triple is equal. SemVer 2.0.0 §11 precedence:
    //   - a version WITH a pre-release tag is LOWER than the same triple WITHOUT one
    //     (keeps the floor fail-closed for pre-release builds of the GA floor);
    //   - two pre-releases of the same triple are ordered by their dot-separated
    //     identifiers (numeric < alphanumeric; numeric compared numerically,
    //     alphanumeric lexically; fewer identifiers < more).
    const aPre = hasPre(a);
    const bPre = hasPre(b);
    if (aPre && !bPre)
        return -1;
    if (!aPre && bPre)
        return 1;
    if (aPre && bPre) {
        const ai = preIdentifiers(a);
        const bi = preIdentifiers(b);
        const len = Math.min(ai.length, bi.length);
        for (let i = 0; i < len; i++) {
            const ax = ai[i];
            const bx = bi[i];
            const aNum = /^\d+$/.test(ax);
            const bNum = /^\d+$/.test(bx);
            if (aNum && bNum) {
                const an = parseInt(ax, 10);
                const bn = parseInt(bx, 10);
                if (an < bn)
                    return -1;
                if (an > bn)
                    return 1;
            }
            else if (aNum && !bNum) {
                return -1; // numeric identifiers always lower than alphanumeric
            }
            else if (!aNum && bNum) {
                return 1;
            }
            else {
                if (ax < bx)
                    return -1;
                if (ax > bx)
                    return 1;
            }
        }
        if (ai.length < bi.length)
            return -1;
        if (ai.length > bi.length)
            return 1;
    }
    return 0;
}
/** Inline result shorthand. */
function inline(reason, available = false) {
    return { available, backend: 'inline', reason };
}
// ─── the default probe: real observation, no subprocess, no network ───────────
/** True when `p` exists and is a regular file. Any error is "not observed". */
function isReadableFile(p) {
    try {
        return node_fs_1.default.statSync(p).isFile();
    }
    catch {
        return false;
    }
}
/**
 * Resolve `name` against the process PATH by scanning its entries directly.
 *
 * Deliberately NOT a subprocess: threat T-21-10 accepts the probe's cost only
 * because it is a bounded number of local existence checks with no `which`, no
 * shell and no network. A subprocess here would also inherit a shell builtin
 * lookup that reports success for a command the fleet cannot actually execute.
 */
function resolveOnPath(name, env) {
    const raw = env['PATH'] || env['Path'] || '';
    if (typeof raw !== 'string' || raw.length === 0)
        return false;
    const exts = process.platform === 'win32'
        ? (env['PATHEXT'] || '.EXE;.CMD;.BAT').split(';').filter((x) => x.length > 0)
        : [''];
    for (const dir of raw.split(node_path_1.default.delimiter)) {
        if (dir.length === 0)
            continue;
        for (const ext of exts) {
            if (isReadableFile(node_path_1.default.join(dir, name + ext)))
                return true;
        }
    }
    return false;
}
/** The default observation seam. */
const DEFAULT_FLEET_PROBE = Object.freeze({
    pathExists(root, relPath) {
        return isReadableFile(node_path_1.default.join(root, relPath));
    },
    interpreterOnPath(name) {
        return resolveOnPath(name, process.env);
    },
});
/**
 * Resolve whether the FLEET backend should activate.
 *
 * Gate ladder (first miss wins, every miss resolving to `inline`):
 *   1. capability enabled                      → capability_disabled
 *   2. execution_backend is exactly 'fleet'     → backend_not_fleet
 *   3. the fleet capability's activation key on  → fleet_capability_disabled
 *   4. the declared interpreter resolves on PATH → fleet_interpreter_unavailable:<name>
 *   5. every FLEET_RUNTIME_ARTIFACTS entry exists → fleet_artifact_missing:<relPath>
 *
 * Rungs 4 and 5 are OBSERVATIONS. That is the whole point of the rung: a
 * configuration value is not evidence that a fleet can run, and a backend
 * selected on a false premise is a fleet dispatched against a runtime that is
 * not there (T-21-06).
 *
 * Deliberately independent of the Claude runtime rungs: a fleet of worker command
 * line interfaces runs as separate operating system processes and needs no
 * Workflow tool, so gating it behind the Claude check would refuse fleet on every
 * other runtime for a reason that does not apply to it.
 *
 * Never throws. A probe that throws resolves to inline with `fleet_probe_failed`.
 */
function detectFleetBackend(input) {
    if (input === null || input === undefined || typeof input !== 'object') {
        return inline('capability_disabled');
    }
    const cfg = (input.config !== null && input.config !== undefined && typeof input.config === 'object')
        ? input.config
        : {};
    // 1. the capability must be opted in (default-off — ships disabled).
    if (!cfg['claude_orchestration.enabled']) {
        return inline('capability_disabled');
    }
    // 2. this ladder answers for the fleet backend and nothing else.
    if (cfg['claude_orchestration.execution_backend'] !== FLEET_BACKEND) {
        return inline('backend_not_fleet');
    }
    // 3. the fleet engine's own activation key. This is the last configuration rung;
    //    everything below observes.
    if (!cfg['fleet.enabled']) {
        return inline('fleet_capability_disabled');
    }
    const probe = (input.probe !== null && input.probe !== undefined && typeof input.probe === 'object')
        ? input.probe
        : DEFAULT_FLEET_PROBE;
    const root = typeof input.projectRoot === 'string' && input.projectRoot.length > 0
        ? input.projectRoot
        : process.cwd();
    try {
        // 4. the interpreter the fleet engine declares it requires.
        if (probe.interpreterOnPath(FLEET_INTERPRETER) !== true) {
            return inline('fleet_interpreter_unavailable:' + FLEET_INTERPRETER);
        }
        // 5. every runtime artifact, naming the first absent one so a reader of the
        //    result learns what to fix rather than only that something is wrong.
        for (const rel of FLEET_RUNTIME_ARTIFACTS) {
            if (probe.pathExists(root, rel) !== true) {
                return inline('fleet_artifact_missing:' + rel);
            }
        }
    }
    catch {
        // The module's header states it never throws on bad input; a hostile or broken
        // probe is bad input, and it degrades to today's behaviour like every other miss.
        return inline('fleet_probe_failed');
    }
    return { available: true, backend: 'fleet', reason: 'fleet_backend_active' };
}
/**
 * Resolve whether the Workflow-tool backend should activate.
 *
 * Gate ladder (all must pass for `workflow`; first miss wins, fail-closed):
 *   1. capability enabled (claude_orchestration.enabled truthy)
 *   2. runtime is Claude (the only runtime that exposes the Workflow tool)
 *   3. execution_backend !== 'inline'
 *   4. host descriptor signals nested+background dispatch (Workflow-tool capable)
 *   5. agentSdkVersion is a known, valid semver
 *   6. agentSdkVersion >= the configured floor (default WORKFLOW_TOOL_FLOOR_VERSION)
 *   7. execution_backend === 'workflow' OR 'auto' (both reach here; 'inline' exited at 3)
 *
 * Never throws. Destructures defensively.
 */
function detectWorkflowBackend(input) {
    if (input === null || input === undefined || typeof input !== 'object') {
        return inline('capability_disabled');
    }
    const cfg = (input.config !== null && input.config !== undefined && typeof input.config === 'object')
        ? input.config
        : {};
    // 1. capability must be opted in (default-off — ships disabled).
    if (!cfg['claude_orchestration.enabled']) {
        return inline('capability_disabled');
    }
    // 1b. FLEET ROUTE — deliberately BEFORE the Claude-specific rungs below. A fleet
    //     of worker command line interfaces runs as separate operating system
    //     processes and does not need the Workflow tool, so gating it behind the
    //     Claude runtime check would refuse fleet on every other runtime for a reason
    //     that does not apply to it. Only an EXACT 'fleet' request routes here, so the
    //     3 pre-existing backends keep their exact rung order and their exact reasons.
    if (cfg['claude_orchestration.execution_backend'] === FLEET_BACKEND) {
        return detectFleetBackend(input);
    }
    // 2. only Claude can host the Workflow tool.
    if (input.runtimeId !== WORKFLOW_RUNTIME) {
        return inline('runtime_not_claude');
    }
    // 3. explicit inline opt-out short-circuits.
    let backendRaw = cfg['claude_orchestration.execution_backend'];
    if (typeof backendRaw !== 'string' || !BACKEND_VALUES.has(backendRaw)) {
        backendRaw = 'auto';
    }
    if (backendRaw === 'inline') {
        return inline('backend_inline');
    }
    // 4. the host dispatch descriptor must be the nesting-capable Claude-Code shape
    //    (a proxy for Workflow-tool presence). This is Claude-specific and already
    //    gated at step 2; `background:true` alone is true on several non-Claude hosts,
    //    so the proxy is only meaningful after the runtime check above. Note: this is
    //    NOT the canonical `shouldFlattenDispatch` rule (which keys on
    //    `backgroundDispatch`); the Workflow backend works precisely because a single
    //    tool-call orchestrates internally, sidestepping the backgroundDispatch:false
    //    limitation. Missing/false/foreign descriptor → fail-closed.
    const hi = input.hostIntegration;
    if (hi === null || hi === undefined || typeof hi !== 'object' || Array.isArray(hi)) {
        return inline('workflow_tool_unavailable');
    }
    const dispatch = hi.dispatch;
    if (typeof dispatch !== 'object' || dispatch === null || Array.isArray(dispatch)) {
        return inline('workflow_tool_unavailable');
    }
    const nested = dispatch['nested'];
    const background = dispatch['background'];
    if (nested !== true || background !== true) {
        return inline('workflow_tool_unavailable');
    }
    // 5. an unknown agentSdkVersion cannot be trusted to meet the floor.
    if (!isValidSemver(input.agentSdkVersion)) {
        return inline('agent_sdk_version_unknown');
    }
    // 6. version floor (config override > default constant).
    const floorRaw = cfg['claude_orchestration.min_agent_sdk_version'];
    const floor = typeof floorRaw === 'string' && isValidSemver(floorRaw) ? floorRaw : WORKFLOW_TOOL_FLOOR_VERSION;
    if (compareSemver(input.agentSdkVersion, floor) < 0) {
        return inline('agent_sdk_version_below_floor');
    }
    // 7. auto/workflow both reach the workflow backend once every gate passes.
    return { available: true, backend: 'workflow', reason: 'workflow_backend_active' };
}
/**
 * Partition a wave's plans into a near-minimal number of sequential stages (via
 * greedy first-fit — not guaranteed optimal for arbitrary overlap graphs, but
 * correct: no two plans sharing a file ever cohabit a stage) such that no two
 * plans in the same stage share a modified file. Each plan goes into the earliest
 * stage where it does not overlap any plan already there.
 *
 * A plan with an EMPTY files_modified set declares no files; it overlaps nothing
 * and coalesces into stage 0 (same behavior as the inline path, which also cannot
 * guard against undeclared concurrent writes — declare filesModified accurately).
 *
 * This is the same overlap rule execute-phase applies inline — the only difference
 * is the execution vehicle (Workflow `parallel()` vs one-agent-per-message).
 */
function partitionStages(plans) {
    const stages = [];
    for (const plan of plans) {
        const fileSet = new Set(plan.files_modified);
        let placed = false;
        for (const stage of stages) {
            let overlap = false;
            for (const f of fileSet) {
                if (stage.files.has(f)) {
                    overlap = true;
                    break;
                }
            }
            if (!overlap) {
                stage.plans.push(plan);
                for (const f of fileSet)
                    stage.files.add(f);
                placed = true;
                break;
            }
        }
        if (!placed) {
            stages.push({ plans: [plan], files: new Set(fileSet) });
        }
    }
    return stages.map((s) => s.plans.map((p) => p.id));
}
/**
 * Quote a free-text value for safe embedding as a JavaScript/Workflow double-quoted
 * string literal. Uses JSON.stringify so every JS-relevant escape (backslash, quote,
 * newline, tab, NUL, U+2028/U+2029, all control chars) is handled by the language
 * itself — there is no hand-rolled escape table to drift. Returns the value already
 * wrapped in its surrounding quotes.
 */
function quoteString(s) {
    return JSON.stringify(s);
}
/**
 * True if `s` is a safe identifier/path token to interpolate into the generated
 * script WITHOUT requiring a string-literal context — i.e. it contains no
 * character that could terminate a comment line (`\n`/`\r`), break out of a
 * string literal (`"` / `\`), or smuggle a NUL/control sequence. Used for
 * `phaseDir`, `runId`, `wave.id`, and `plan.id`, which are identifiers/paths and
 * must never legitimately contain such characters. Rejecting them at validation
 * (rather than silently flattening) keeps the emitted script faithful to input.
 */
const UNSCRIPTABLE_CHAR_RE = /[\r\n"\\\x00-\x1f\x7f\u2028\u2029]/;
function isScriptableIdentifier(s) {
    if (typeof s !== 'string' || s.length === 0)
        return false;
    return !UNSCRIPTABLE_CHAR_RE.test(s);
}
/** Identifier of the emitted dispatch manifest shape. */
const FLEET_MANIFEST_KIND = 'ferrox.fleet.dispatch/v1';
/**
 * The ONE validation pass both emitters run, in ONE order, producing ONE reason
 * per defect.
 *
 * Factored rather than copied on purpose. Two emitters carrying two copies of a
 * refusal ladder is how an input that is unsafe under one backend becomes
 * acceptable under the other, which is T-21-08 and T-21-09 in the same defect.
 * Every reason string below is the literal the workflow emitter already shipped,
 * so this refactor changes no observable refusal.
 */
function validateEmitInput(input) {
    if (input === null || input === undefined || typeof input !== 'object') {
        return { ok: false, reason: 'invalid_input' };
    }
    const { phaseDir, waves, runId } = input;
    // Identifiers/paths interpolated into the generated script must be free of any
    // character that could terminate a comment, break out of a string literal, or
    // smuggle control bytes — reject up front (security: #1143 review Finding 1).
    if (!isScriptableIdentifier(phaseDir)) {
        return { ok: false, reason: 'phaseDir must be a non-empty string without newlines/quotes/backslash/control chars' };
    }
    if (!isScriptableIdentifier(runId)) {
        return { ok: false, reason: 'runId must be a non-empty string without newlines/quotes/backslash/control chars' };
    }
    if (!Array.isArray(waves) || waves.length === 0) {
        return { ok: false, reason: 'waves must be a non-empty array' };
    }
    for (let i = 0; i < waves.length; i++) {
        const w = waves[i];
        if (w === null || typeof w !== 'object' || typeof w.id !== 'string') {
            return { ok: false, reason: 'waves[' + i + '] must be { id, plans: non-empty[] }' };
        }
        if (!isScriptableIdentifier(w.id)) {
            return { ok: false, reason: 'waves[' + i + '].id must not contain newlines/quotes/backslash/control chars' };
        }
        if (!Array.isArray(w.plans) || w.plans.length === 0) {
            return { ok: false, reason: 'waves[' + i + '] must have a non-empty plans array' };
        }
        const seenIds = new Set();
        for (let j = 0; j < w.plans.length; j++) {
            const p = w.plans[j];
            if (p === null || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.brief !== 'string' || !Array.isArray(p.files_modified)) {
                return { ok: false, reason: 'waves[' + i + '].plans[' + j + '] must be { id, brief, files_modified[] }' };
            }
            if (!isScriptableIdentifier(p.id)) {
                return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].id must not contain newlines/quotes/backslash/control chars' };
            }
            if (seenIds.has(p.id)) {
                return { ok: false, reason: 'waves[' + i + '] has duplicate plan id "' + p.id + '"' };
            }
            seenIds.add(p.id);
            for (const f of p.files_modified) {
                if (typeof f !== 'string' || f.length === 0) {
                    return { ok: false, reason: 'waves[' + i + '].plans[' + j + '].files_modified entries must be non-empty strings' };
                }
            }
        }
    }
    const budgetTokens = (typeof input.budgetTokens === 'number' && Number.isFinite(input.budgetTokens) && input.budgetTokens > 0)
        ? Math.floor(input.budgetTokens)
        : null;
    return { ok: true, budgetTokens };
}
/**
 * Emit a Workflow script mapping the phase's wave/plan model onto Workflow
 * primitives. Pure and deterministic: identical input yields an identical string.
 *
 * Returns ok:false (never throws) on invalid input — empty waves, missing runId,
 * a wave with no plans, etc.
 */
function emitWorkflowScript(input) {
    const validated = validateEmitInput(input);
    if (!validated.ok)
        return validated;
    const { budgetTokens } = validated;
    const { phaseDir, waves, runId } = input;
    const lines = [];
    lines.push('// Ferrox Workflow script — generated by the claude-orchestration capability (#1143)');
    lines.push('// phase: ' + phaseDir);
    lines.push('// BETA: preview-grade; on any failure the orchestrator falls back to inline dispatch.');
    lines.push('// Composes the SAME ferrox-executor agent + worktree isolation as the inline path,');
    lines.push('// so artifacts (SUMMARY.md) and commits are produced identically.');
    lines.push('resumeFromRunId(' + quoteString(runId) + ')');
    if (budgetTokens !== null) {
        lines.push('budget(' + budgetTokens + ')');
    }
    lines.push('');
    const stagesByWave = [];
    let totalPlans = 0;
    for (let wi = 0; wi < waves.length; wi++) {
        const wave = waves[wi];
        const stages = partitionStages(wave.plans);
        stagesByWave.push(stages);
        totalPlans += wave.plans.length;
        lines.push('// Wave ' + wave.id);
        for (let si = 0; si < stages.length; si++) {
            const stagePlanIds = stages[si];
            // Resolve back to plan objects for briefs (ids are unique within a wave — validated above).
            const stagePlans = stagePlanIds.map((id) => wave.plans.find((p) => p.id === id));
            if (stages.length > 1) {
                lines.push('// Stage ' + si + (si > 0 ? ' (sequential — files_modified overlap)' : ''));
            }
            if (stagePlans.length === 1) {
                const p = stagePlans[0];
                lines.push('parallel(');
                lines.push('  agent(' + quoteString(p.brief) + ', { agentType: "ferrox-executor", isolation: "worktree" })');
                lines.push(')');
            }
            else {
                lines.push('parallel(');
                for (const p of stagePlans) {
                    lines.push('  agent(' + quoteString(p.brief) + ', { agentType: "ferrox-executor", isolation: "worktree" }),');
                }
                // Replace trailing comma on the last agent line with nothing.
                const lastIdx = lines.length - 1;
                lines[lastIdx] = lines[lastIdx].replace(/,$/, '');
                lines.push(')');
            }
        }
        if (wi < waves.length - 1)
            lines.push('');
    }
    lines.push('// Each agent writes SUMMARY.md on its worktree branch; commits land there');
    lines.push('// and are merged by the orchestrator exactly as in inline wave dispatch.');
    const script = lines.join('\n');
    return {
        ok: true,
        script,
        summary: {
            waves: waves.length,
            plans: totalPlans,
            stagesByWave,
            resumeRunId: runId,
            budgetTokens,
        },
    };
}
/**
 * Emit a FLEET dispatch manifest from the same wave/plan model.
 *
 * The manifest is DATA, not a script string: a fleet dispatches operating system
 * processes, and a generated script would be a second execution vehicle to keep
 * faithful to the first.
 *
 * It partitions each wave through `partitionStages`, the EXISTING function, and it
 * validates through `validateEmitInput`, the EXISTING ladder. Neither is copied.
 * That is the reason a plan pair that is unsafe under one backend cannot be safe
 * under the other, and it is asserted directly by a committed case comparing the
 * 2 summaries on identical input.
 *
 * Pure and deterministic. Never throws.
 */
function emitFleetManifest(input) {
    const validated = validateEmitInput(input);
    if (!validated.ok)
        return validated;
    const { budgetTokens } = validated;
    const { phaseDir, waves, runId } = input;
    const stagesByWave = [];
    let totalPlans = 0;
    const manifestWaves = [];
    for (const wave of waves) {
        const stages = partitionStages(wave.plans);
        stagesByWave.push(stages);
        totalPlans += wave.plans.length;
        manifestWaves.push({
            id: wave.id,
            stages: stages.map((stagePlanIds, index) => ({
                index,
                // Plan ids are unique within a wave (validated above), so this resolve is total.
                plans: stagePlanIds.map((id) => {
                    const p = wave.plans.find((c) => c.id === id);
                    return { id: p.id, brief: p.brief, files_modified: p.files_modified.slice() };
                }),
            })),
        });
    }
    return {
        ok: true,
        manifest: {
            kind: FLEET_MANIFEST_KIND,
            phaseDir,
            runId,
            budgetTokens,
            waves: manifestWaves,
        },
        summary: {
            waves: waves.length,
            plans: totalPlans,
            stagesByWave,
            resumeRunId: runId,
            budgetTokens,
        },
    };
}
module.exports = {
    detectWorkflowBackend,
    detectFleetBackend,
    emitWorkflowScript,
    emitFleetManifest,
    compareSemver,
    isValidSemver,
    WORKFLOW_TOOL_FLOOR_VERSION,
    BACKEND_VALUES,
    WORKFLOW_RUNTIME,
    FLEET_BACKEND,
    FLEET_INTERPRETER,
    FLEET_RUNTIME_ARTIFACTS,
    DEFAULT_FLEET_PROBE,
    // Exported for the SAME reason FLEET_RUNTIME_ARTIFACTS is: the backend switch
    // observes whether anything READS this kind (FF-B379), and an observer that
    // transcribed the string would keep answering after the kind changed. Two
    // copies of an identifier is how a gap gets reported closed while it is open.
    FLEET_MANIFEST_KIND,
};
