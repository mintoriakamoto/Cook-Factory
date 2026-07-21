/**
 * MODEL-04 trident.* CLI router (Plan 06).
 *
 * Exposes the tested Plan 03 trident-audit core as the locked-name verb
 * `ferrox_run query trident.audit` — the bounded, cross-lineage, anti-loop
 * discovery gate at exactly two checkpoints.
 *
 * The router is the SOLE place operator flags enter the pure core. It parses
 * --caller-family, --checkpoint, and an INJECTED --panel (JSON array), resolves
 * allowedCheckpoints from config.model.trident_checkpoints (Plan 01, with a
 * config-defaults.manifest.json fallback), and forwards EXPLICIT inputs to
 * evaluateTrident. Anti-loop flags (--open-ended / --loop-until-clean /
 * --max-rounds) are forwarded so the core refuses 'unbounded-invocation' — the
 * router itself contains NO loop.
 *
 * The optional --live path gathers a real codex+gemini panel through the single
 * external-cli seam (one call per family, no retry) and feeds the SAME core;
 * when any panel CLI is absent it degrades to { decision:'degraded' } rather than
 * looping or throwing. A missing required flag fails closed on error()
 * (non-zero, no crash — T-06-12). Alias drift is guarded by the check-alias-drift
 * TRIDENT family entry (T-06-13).
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/trident-command-router.cjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { TRIDENT_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import tridentAudit = require('./trident-audit.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import externalCli = require('./external-cli.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;
const { runExternalCli } = externalCli;

interface RouteTridentCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
}

/** The two external families a Claude-run Trident audit draws from (never Claude). */
const LIVE_PANEL_BINS = ['codex', 'gemini'];

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
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

/** Resolve model.trident_checkpoints with a manifest-default fallback. */
function resolveCheckpoints(model: Record<string, unknown>): string[] {
  const fromCfg = model.trident_checkpoints;
  if (Array.isArray(fromCfg) && fromCfg.length > 0) return fromCfg as string[];
  const fromManifest = manifestModel().trident_checkpoints;
  return Array.isArray(fromManifest) ? (fromManifest as string[]) : [];
}

function writeJson(result: unknown, raw: boolean): void {
  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

/**
 * Gather a live codex+gemini panel through the external-cli seam. One call per
 * family (no retry). When any CLI is absent, returns null so the caller degrades
 * to { decision:'degraded' } — the router never loops to "fill" a missing family.
 */
function gatherLivePanel(cwd: string): { panel: { family: string; findings: string[] }[] } | { absent: string } {
  const panel: { family: string; findings: string[] }[] = [];
  for (const bin of LIVE_PANEL_BINS) {
    const res = runExternalCli({ bin, args: ['--version'], cwd });
    if (!res.present) return { absent: bin };
    const findings = res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    panel.push({ family: bin, findings });
  }
  return { panel };
}

function handleAudit(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const callerFamily = parseFlag(args, '--caller-family');
  const checkpoint = parseFlag(args, '--checkpoint');
  const live = args.includes('--live');
  const panelRaw = parseFlag(args, '--panel');

  if (callerFamily === undefined || checkpoint === undefined || (!live && panelRaw === undefined)) {
    error('Usage: ferrox-tools query trident.audit --caller-family <fam> --checkpoint <name> --panel <json-array> [--live]', 'InvalidArgs');
    return;
  }

  const model = resolveModel(cwd);
  const allowedCheckpoints = resolveCheckpoints(model);

  // Anti-loop shape flags forwarded to the core (which refuses them). The router
  // has no loop of its own.
  const openEnded = args.includes('--open-ended');
  const loopUntilClean = args.includes('--loop-until-clean');
  const maxRoundsRaw = parseFlag(args, '--max-rounds');
  const maxRounds = maxRoundsRaw !== undefined && Number.isFinite(Number(maxRoundsRaw)) ? Number(maxRoundsRaw) : undefined;

  let panel: unknown;
  if (live) {
    const gathered = gatherLivePanel(cwd);
    if ('absent' in gathered) {
      writeJson({ decision: 'degraded', reason: 'cli-absent', cli: gathered.absent }, raw);
      return;
    }
    panel = gathered.panel;
  } else {
    try {
      panel = JSON.parse(panelRaw as string);
    } catch {
      error('trident.audit: --panel must be a JSON array', 'InvalidArgs');
      return;
    }
  }

  const result = tridentAudit.evaluateTrident({
    callerFamily,
    panel: Array.isArray(panel) ? panel : [],
    checkpoint,
    allowedCheckpoints,
    mode: openEnded ? 'open-ended' : undefined,
    loopUntilClean: loopUntilClean ? true : undefined,
    maxRounds,
  });
  writeJson(result, raw);
}

function routeTridentCommand({ args, cwd, raw, error }: RouteTridentCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: TRIDENT_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown trident subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'audit': () => handleAudit(args, cwd, raw, error),
    },
  });
}

export = { routeTridentCommand };
