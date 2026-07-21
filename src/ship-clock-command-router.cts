/**
 * HALT-04 ship-clock.check CLI router (Plan 06, D-01/D-02).
 *
 * Exposes the tested ship-clock-check core (Plan 05) as
 * `ferrox_run query ship-clock.check`. Resolves halting.ship_clock_seconds
 * (default 86400), forwards EXPLICIT --last-merge-ts/--now-ts ms + increment id
 * to the core, and writes the decision JSON to stdout. The run-log `ts` is
 * derived from --now-ts (new Date(nowMs).toISOString()) — never a clock read
 * (plan-check W1).
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/ship-clock-command-router.cjs.
 */

import { SHIP_CLOCK_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import shipClockCheck = require('./ship-clock-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import haltingLog = require('./halting-log.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;

interface RouteShipClockCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function resolveHalting(cwd: string): Record<string, unknown> {
  try {
    const cfg = loadConfig(cwd);
    const halting = cfg && typeof cfg.halting === 'object' && cfg.halting !== null ? cfg.halting : {};
    return halting as Record<string, unknown>;
  } catch {
    return {};
  }
}

function handleCheck(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const increment = parseFlag(args, '--increment');
  const lastMergeRaw = parseFlag(args, '--last-merge-ts');
  const nowRaw = parseFlag(args, '--now-ts');

  const lastMergeMs = Number(lastMergeRaw);
  const nowMs = Number(nowRaw);

  if (
    !increment ||
    lastMergeRaw === undefined || nowRaw === undefined ||
    !Number.isFinite(lastMergeMs) || !Number.isFinite(nowMs)
  ) {
    error('Usage: ferrox-tools query ship-clock.check --increment <id> --last-merge-ts <ms> --now-ts <ms>');
    return;
  }

  const halting = resolveHalting(cwd);
  const budgetSeconds = Number.isFinite(Number(halting.ship_clock_seconds)) ? Number(halting.ship_clock_seconds) : 86400;

  const nowIso = new Date(nowMs).toISOString();

  const result = shipClockCheck.runShipClockCheck(
    { increment, lastMergeMs, nowMs, budgetSeconds, nowIso },
    { logPath: haltingLog.haltingLogPath(cwd) },
  );

  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

function routeShipClockCommand({ args, cwd, raw, error }: RouteShipClockCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: SHIP_CLOCK_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown ship-clock subcommand. Available: ${available.join(', ')}`,
    handlers: {
      check: () => handleCheck(args, cwd, raw, error),
    },
  });
}

export = { routeShipClockCommand };
