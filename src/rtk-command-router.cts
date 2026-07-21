/**
 * MODEL-05 rtk.* CLI router (Plan 06).
 *
 * Exposes the two tested Plan 04 rtk cores as the locked-name verbs
 * `ferrox_run query rtk.wrap` and `ferrox_run query rtk.report`:
 *   - rtk.wrap    (MODEL-05, rtk-wrap core) — route a dev op through rtk only
 *                 when config.model.rtk.enabled AND rtk is present, else graceful
 *                 passthrough;
 *   - rtk.report  (MODEL-05, rtk-report core) — parse token savings from rtk's
 *                 OWN output, never fabricating a figure.
 *
 * The router is the SOLE place operator flags enter the pure cores. It resolves
 * config.model.rtk.enabled (Plan 01, manifest fallback) and probes rtk presence
 * through the single external-cli seam — or accepts an INJECTED presence
 * (--rtk-present) / injected output (--rtk-output) so the required suite never
 * spawns a real rtk. The optional --live path captures real rtk output through the
 * SAME seam, degrading gracefully when rtk is absent. A missing required flag
 * fails closed on error() (non-zero, no crash — T-06-12). Alias drift is guarded
 * by the check-alias-drift RTK family entry (T-06-13).
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/rtk-command-router.cjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { RTK_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import rtkWrap = require('./rtk-wrap.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import rtkReport = require('./rtk-report.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import externalCli = require('./external-cli.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;
const { runExternalCli } = externalCli;

interface RouteRtkCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Split a comma-separated list flag into trimmed, non-empty parts. */
function parseList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function resolveModel(cwd: string): Record<string, unknown> {
  try {
    const cfg = loadConfig(cwd);
    const m = cfg && typeof cfg.model === 'object' && cfg.model !== null ? cfg.model : {};
    return m as Record<string, unknown>;
  } catch {
    return {};
  }
}

let manifestModelCache: Record<string, unknown> | null | undefined;
function manifestModel(): Record<string, unknown> {
  if (manifestModelCache !== undefined) return manifestModelCache ?? {};
  try {
    const manifestPath = path.join(__dirname, '..', 'shared', 'config-defaults.manifest.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const model = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).model : undefined;
    manifestModelCache = model && typeof model === 'object' && model !== null ? (model as Record<string, unknown>) : null;
  } catch {
    manifestModelCache = null;
  }
  return manifestModelCache ?? {};
}

/**
 * Resolve config.model.rtk.enabled as a STRICT boolean (the core also gates on
 * ===true, so a non-boolean config value fails closed to passthrough). Falls back
 * to the manifest default.
 */
function resolveRtkEnabled(model: Record<string, unknown>): boolean {
  const rtk = model.rtk;
  if (rtk && typeof rtk === 'object' && 'enabled' in (rtk as Record<string, unknown>)) {
    return (rtk as Record<string, unknown>).enabled === true;
  }
  const mRtk = manifestModel().rtk;
  return mRtk && typeof mRtk === 'object' ? (mRtk as Record<string, unknown>).enabled === true : false;
}

function writeJson(result: unknown, raw: boolean): void {
  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

function handleWrap(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const command = parseList(parseFlag(args, '--command'));
  if (command.length === 0) {
    error('Usage: ferrox-tools query rtk.wrap --command <a,b,c> [--rtk-present <true|false>] [--live]', 'InvalidArgs');
    return;
  }
  const model = resolveModel(cwd);
  const enabled = resolveRtkEnabled(model);

  // Presence: an INJECTED --rtk-present wins (tests / deterministic); otherwise a
  // --live probe through the seam; otherwise fail closed to absent (passthrough).
  const presentFlag = parseFlag(args, '--rtk-present');
  let rtkPresent: boolean;
  if (presentFlag !== undefined) {
    rtkPresent = presentFlag === 'true';
  } else if (args.includes('--live')) {
    rtkPresent = runExternalCli({ bin: 'rtk', args: ['--version'], cwd }).present === true;
  } else {
    rtkPresent = false;
  }

  const result = rtkWrap.evaluateRtkWrap({ enabled, rtkPresent, command });
  writeJson(result, raw);
}

function handleReport(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const live = args.includes('--live');
  let rtkOutput: string;
  if (live) {
    // Capture real rtk output through the SAME seam; absent rtk degrades to an
    // empty string, which parseRtkSavings maps to { error:'empty' } (never fabricates).
    const res = runExternalCli({ bin: 'rtk', args: ['gain'], cwd });
    rtkOutput = res.present ? res.stdout : '';
  } else {
    const injected = parseFlag(args, '--rtk-output');
    if (injected === undefined) {
      error('Usage: ferrox-tools query rtk.report --rtk-output <text> | --live', 'InvalidArgs');
      return;
    }
    rtkOutput = injected;
  }
  const result = rtkReport.parseRtkSavings({ rtkOutput });
  writeJson(result, raw);
}

function routeRtkCommand({ args, cwd, raw, error }: RouteRtkCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: RTK_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown rtk subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'wrap': () => handleWrap(args, cwd, raw, error),
      'report': () => handleReport(args, cwd, raw, error),
    },
  });
}

export = { routeRtkCommand };
