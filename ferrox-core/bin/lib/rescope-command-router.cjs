"use strict";
/**
 * HALT-02 rescope.check CLI router (Plan 06, D-01/D-02).
 *
 * Exposes the tested rescope-check core (Plan 03) as `ferrox_run query rescope.check`.
 * Resolves halting.rescope.max_attempts (default 2), forwards prev/new scope
 * sizes + increment id to the persisted core, and writes the decision JSON to
 * stdout. The run-log `ts` is derived from --now-ts
 * (new Date(nowMs).toISOString()) — never a clock read (plan-check W1).
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/rescope-command-router.cjs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_path_1 = __importDefault(require("node:path"));
const command_aliases_cjs_1 = require("./command-aliases.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjsCommandRouterAdapter = require("./cjs-command-router-adapter.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rescopeCheck = require("./rescope-check.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const haltingLog = require("./halting-log.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const configLoader = require("./config-loader.cjs");
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;
function parseFlag(args, flag) {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
function resolveHalting(cwd) {
    try {
        const cfg = loadConfig(cwd);
        const halting = cfg && typeof cfg.halting === 'object' && cfg.halting !== null ? cfg.halting : {};
        return halting;
    }
    catch {
        return {};
    }
}
function handleCheck(args, cwd, raw, error) {
    const increment = parseFlag(args, '--increment');
    const prevRaw = parseFlag(args, '--prev-size');
    const newRaw = parseFlag(args, '--new-size');
    const nowRaw = parseFlag(args, '--now-ts');
    const prevSize = Number(prevRaw);
    const newSize = Number(newRaw);
    const nowMs = Number(nowRaw);
    if (!increment ||
        prevRaw === undefined || newRaw === undefined || nowRaw === undefined ||
        !Number.isFinite(prevSize) || !Number.isFinite(newSize) || !Number.isFinite(nowMs)) {
        error('Usage: ferrox-tools query rescope.check --increment <id> --prev-size <n> --new-size <n> --now-ts <ms>');
        return;
    }
    const halting = resolveHalting(cwd);
    const rescope = (halting.rescope && typeof halting.rescope === 'object' ? halting.rescope : {});
    const maxAttempts = Number.isFinite(Number(rescope.max_attempts)) ? Number(rescope.max_attempts) : 2;
    const nowIso = new Date(nowMs).toISOString();
    const result = rescopeCheck.runRescopeCheck({ increment, prevSize, newSize, maxAttempts, nowIso }, {
        statePath: node_path_1.default.join(cwd, '.planning', 'rescope-state.json'),
        logPath: haltingLog.haltingLogPath(cwd),
    });
    process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}
function routeRescopeCommand({ args, cwd, raw, error }) {
    routeCjsCommandFamily({
        args,
        subcommands: command_aliases_cjs_1.RESCOPE_SUBCOMMANDS,
        unsupported: {},
        error,
        unknownMessage: (_s, available) => `Unknown rescope subcommand. Available: ${available.join(', ')}`,
        handlers: {
            check: () => handleCheck(args, cwd, raw, error),
        },
    });
}
module.exports = { routeRescopeCommand };
