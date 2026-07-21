"use strict";
/**
 * HALT-03 human-sla.check CLI router (Plan 06, D-01/D-02).
 *
 * Exposes the tested human-sla-check core (Plan 04) as
 * `ferrox_run query human-sla.check`. Resolves halting.human_sla_seconds
 * (default 86400), forwards EXPLICIT --opened-ts/--now-ts ms + increment id to
 * the core (which parks on breach), and writes the decision JSON to stdout. The
 * park/run-log `ts` is derived from --now-ts (new Date(nowMs).toISOString()) —
 * never a clock read (plan-check W1).
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/human-sla-command-router.cjs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_path_1 = __importDefault(require("node:path"));
const command_aliases_cjs_1 = require("./command-aliases.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjsCommandRouterAdapter = require("./cjs-command-router-adapter.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const humanSlaCheck = require("./human-sla-check.cjs");
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
    const openedRaw = parseFlag(args, '--opened-ts');
    const nowRaw = parseFlag(args, '--now-ts');
    const openedMs = Number(openedRaw);
    const nowMs = Number(nowRaw);
    if (!increment ||
        openedRaw === undefined || nowRaw === undefined ||
        !Number.isFinite(openedMs) || !Number.isFinite(nowMs)) {
        error('Usage: ferrox-tools query human-sla.check --increment <id> --opened-ts <ms> --now-ts <ms>');
        return;
    }
    const halting = resolveHalting(cwd);
    const slaSeconds = Number.isFinite(Number(halting.human_sla_seconds)) ? Number(halting.human_sla_seconds) : 86400;
    const nowIso = new Date(nowMs).toISOString();
    const result = humanSlaCheck.runHumanSlaCheck({ increment, openedMs, nowMs, slaSeconds, nowIso }, {
        parkPath: node_path_1.default.join(cwd, '.planning', 'human-sla-park.json'),
        logPath: haltingLog.haltingLogPath(cwd),
    });
    process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}
function routeHumanSlaCommand({ args, cwd, raw, error }) {
    routeCjsCommandFamily({
        args,
        subcommands: command_aliases_cjs_1.HUMAN_SLA_SUBCOMMANDS,
        unsupported: {},
        error,
        unknownMessage: (_s, available) => `Unknown human-sla subcommand. Available: ${available.join(', ')}`,
        handlers: {
            check: () => handleCheck(args, cwd, raw, error),
        },
    });
}
module.exports = { routeHumanSlaCommand };
