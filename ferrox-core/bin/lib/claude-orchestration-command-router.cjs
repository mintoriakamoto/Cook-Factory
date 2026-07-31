"use strict";
/**
 * Claude orchestration command router — CLI dispatcher for
 * `ferrox-tools claude-orchestration <subcommand>`.
 *
 * #1143 — thin CLI adapter over the pure `claude-orchestration.cjs` module.
 * Lets execute-phase (or any orchestrator) invoke the Workflow-backend
 * detection and the Workflow-script emitter through the standard capability
 * command surface (ADR-959) instead of a bare `require()`.
 *
 * Router signature: { args, cwd, raw, error } — identical to the other host
 * routers; discovered by dispatchCapabilityCommand via the registry's
 * commandFamilies index.
 *
 * Subcommands (phase 21 SC2 adds 2 FLAGS and 0 subcommands — a third subcommand
 * would change the capability's declared subcommand list and drag a registry
 * surface behind it for no gain):
 *   detect-backend [--runtime <id>] [--agent-sdk-version <ver>] [--no-nested-dispatch]
 *                  [--backend <auto|workflow|inline|fleet>]
 *       Resolves which execution backend should activate. `--runtime`
 *       defaults to the FERROX_RUNTIME env var (or 'unknown'). Reads the
 *       `claude_orchestration.*` AND `fleet.*` keys from .planning/config.json;
 *       `--backend` overrides the configured execution_backend for this call.
 *       Emits { available, backend, reason }. The fleet rung OBSERVES the project
 *       tree at `cwd`, so this is the seam a fail-closed proof drives.
 *
 *   emit-workflow --waves <path> --run-id <id> [--phase-dir <dir>] [--budget <n>]
 *                 [--backend <workflow|fleet>]
 *       Reads a wave/plan manifest JSON file and emits either the generated
 *       Workflow script + summary (default) or, with `--backend fleet`, the fleet
 *       dispatch manifest + the SAME summary. The input shape is unchanged:
 *       { waves: [{ id, plans: [{ id, brief, files_modified: string[] }] }] }.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const io = require("./io.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require("./claude-orchestration.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configLoader = require("./config-loader.cjs");
const { output } = io;
const { detectWorkflowBackend, emitWorkflowScript, emitFleetManifest, FLEET_BACKEND, BACKEND_VALUES } = core;
const CAPABLE_HOST = { dispatch: { nested: true, background: true } };
function usage(error) {
    error('Usage: ferrox-tools claude-orchestration <detect-backend|emit-workflow> [...]\n' +
        '  detect-backend [--runtime <id>] [--agent-sdk-version <ver>] [--no-nested-dispatch]\n' +
        '                 [--backend <auto|workflow|inline|fleet>]\n' +
        '  emit-workflow --waves <path> --run-id <id> [--phase-dir <dir>] [--budget <n>]\n' +
        '                [--backend <workflow|fleet>]');
}
function argValue(args, flag) {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}
/**
 * Detect whether the Workflow backend should activate for the current/given
 * runtime. Reads `claude_orchestration.*` from the project config; runtime and
 * SDK version come from flags (the orchestrator already knows these) or env.
 */
function cmdDetectBackend(args, cwd, raw) {
    const runtimeId = argValue(args, '--runtime') || process.env['FERROX_RUNTIME'] || 'unknown';
    const agentSdkVersion = argValue(args, '--agent-sdk-version');
    const noNested = args.includes('--no-nested-dispatch');
    const hostIntegration = noNested ? { dispatch: { nested: false, background: true } } : CAPABLE_HOST;
    // Resolve the claude_orchestration.* and fleet.* slices from the project config
    // (federated keys are merged by loadConfig as nested objects). A config read
    // failure degrades to inline — it must not break the core loop. The fleet slice
    // is read because the fleet rung consults the fleet engine's OWN activation key;
    // reading it out of the fleet capability rather than mirroring it into a second
    // claude_orchestration key keeps 1 switch for 1 engine.
    const slices = {};
    try {
        const loaded = configLoader.loadConfig(cwd);
        for (const family of ['claude_orchestration', 'fleet']) {
            const slice = loaded[family];
            if (slice && typeof slice === 'object' && !Array.isArray(slice)) {
                slices[family] = slice;
            }
        }
    }
    catch {
        // leave slices empty — every downstream rung then fails closed to inline.
    }
    // Flatten the nested slices into the dotted-key shape detectWorkflowBackend expects.
    const flatConfig = {};
    for (const family of Object.keys(slices)) {
        const slice = slices[family];
        for (const k of Object.keys(slice)) {
            flatConfig[family + '.' + k] = slice[k];
        }
    }
    // --backend overrides the configured execution_backend for this call only. An
    // unrecognised value is IGNORED rather than accepted: the enum is closed, and a
    // typo silently selecting a backend is the class of defect the enum exists for.
    const backendOverride = argValue(args, '--backend');
    if (backendOverride !== undefined && BACKEND_VALUES.has(backendOverride)) {
        flatConfig['claude_orchestration.execution_backend'] = backendOverride;
    }
    const result = detectWorkflowBackend({
        runtimeId,
        hostIntegration,
        config: flatConfig,
        agentSdkVersion,
        // The fleet rung observes THIS tree. Passing cwd rather than process.cwd() is
        // what lets a scratch project be probed as itself.
        projectRoot: cwd,
    });
    output(result, raw);
}
/**
 * Emit a Workflow script from a wave/plan manifest file.
 */
function cmdEmitWorkflow(args, _cwd, raw, error) {
    const wavesPath = argValue(args, '--waves');
    const runId = argValue(args, '--run-id');
    const phaseDir = argValue(args, '--phase-dir') || '.planning/phases/current';
    const budgetRaw = argValue(args, '--budget');
    if (!wavesPath) {
        error('emit-workflow requires --waves <path>');
        return;
    }
    if (!runId) {
        error('emit-workflow requires --run-id <id>');
        return;
    }
    let waves;
    try {
        const content = node_fs_1.default.readFileSync(node_path_1.default.resolve(wavesPath), 'utf8');
        const parsed = JSON.parse(content);
        waves = parsed['waves'];
    }
    catch (e) {
        error('emit-workflow: could not read/parse --waves file "' + wavesPath + '": ' + (e instanceof Error ? e.message : String(e)));
        return;
    }
    const budgetTokens = budgetRaw !== undefined ? parseInt(budgetRaw, 10) : undefined;
    const budget = (typeof budgetTokens === 'number' && !Number.isNaN(budgetTokens)) ? budgetTokens : undefined;
    const emitInput = {
        phaseDir,
        runId,
        waves: waves,
        budgetTokens: budget,
    };
    // --backend fleet selects the manifest emitter. Both emitters share ONE
    // validation ladder and ONE overlap rule, so this flag changes the dispatch
    // vehicle and nothing about which plans may run together.
    if (argValue(args, '--backend') === FLEET_BACKEND) {
        const fleetResult = emitFleetManifest(emitInput);
        if (!fleetResult.ok) {
            error('emit-workflow: ' + fleetResult.reason);
            return;
        }
        output({ manifest: fleetResult.manifest, summary: fleetResult.summary }, raw);
        return;
    }
    const result = emitWorkflowScript(emitInput);
    if (!result.ok) {
        error('emit-workflow: ' + result.reason);
        return;
    }
    output({ script: result.script, summary: result.summary }, raw);
}
function routeClaudeOrchestrationCommand(opts) {
    const { args, cwd, raw, error } = opts;
    // args[0] is the family ('claude-orchestration'); the subcommand is args[1].
    const subcommand = args[1];
    if (subcommand === 'detect-backend') {
        cmdDetectBackend(args, cwd, raw);
    }
    else if (subcommand === 'emit-workflow') {
        cmdEmitWorkflow(args, cwd, raw, error);
    }
    else {
        usage(error);
    }
}
module.exports = { routeClaudeOrchestrationCommand };
