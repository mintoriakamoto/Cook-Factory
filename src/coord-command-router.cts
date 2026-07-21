/**
 * COORD-02..05 coord.* CLI router (Plan 05).
 *
 * Exposes the four tested Phase-4 coordination cores (Plans 02-04) as the five
 * locked-name verbs `ferrox_run query coord.<verb>`:
 *   - coord.ownership-check   (COORD-02, coord-ownership-check core)
 *   - coord.hot-seam-check    (COORD-03, coord-hot-seam-check core)
 *   - coord.alloc-migration   (COORD-04, coord-migration.allocMigration — MUTATION)
 *   - coord.check-migration   (COORD-04, coord-migration.checkMigration)
 *   - coord.shared-write-check(COORD-05, coord-shared-write-check core)
 *
 * The router is the SOLE place operator-supplied CLI flags enter the pure cores.
 * It resolves the operator's registry from `coordination.*` (Plan 01 config
 * propagation) — hot_seams / shared_state_paths / migration_store — and forwards
 * EXPLICIT inputs to the cores, which reach for no config, git, or clock. A
 * missing required flag fails closed on the error() InvalidArgs path (non-zero,
 * no crash — threat T-04-12); alias drift is guarded by the check-alias-drift
 * COORD family entry (threat T-04-13).
 *
 * Determinism: no Date.now here. The ownership-check log `ts` is derived from an
 * optional explicit --now-ts (new Date(ms).toISOString()), never a clock read.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/coord-command-router.cjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { COORD_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coordOwnership = require('./coord-ownership-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coordHotSeam = require('./coord-hot-seam-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coordMigration = require('./coord-migration.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import coordSharedWrite = require('./coord-shared-write-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import haltingLog = require('./halting-log.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;

interface RouteCoordCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
}

/** The default migration-sequence store path (relative to cwd). */
const DEFAULT_MIGRATION_STORE = '.planning/coord/migration-seq.json';

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

/**
 * Resolve the operator's coordination block from config (Plan 01 propagation).
 * A load failure collapses to an empty block; the per-list fallbacks below then
 * supply the manifest defaults.
 */
function resolveCoordination(cwd: string): Record<string, unknown> {
  try {
    const cfg = loadConfig(cwd);
    const coord = cfg && typeof cfg.coordination === 'object' && cfg.coordination !== null ? cfg.coordination : {};
    return coord as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The manifest coordination default — the authoritative fallback when a config
 * drops the coordination block entirely. Read once from the sibling
 * ferrox-core/bin/shared/config-defaults.manifest.json (../shared relative to the
 * compiled router in bin/lib) and cached.
 */
let manifestCoordCache: Record<string, unknown> | null | undefined;
function manifestCoord(): Record<string, unknown> {
  if (manifestCoordCache !== undefined) return manifestCoordCache ?? {};
  try {
    const manifestPath = path.join(__dirname, '..', 'shared', 'config-defaults.manifest.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const coord =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).coordination : undefined;
    manifestCoordCache =
      coord && typeof coord === 'object' && coord !== null ? (coord as Record<string, unknown>) : null;
  } catch {
    manifestCoordCache = null;
  }
  return manifestCoordCache ?? {};
}

/** Resolve a coordination string-list key with a manifest-default fallback. */
function resolveList(coord: Record<string, unknown>, key: string): string[] {
  const fromCfg = coord[key];
  if (Array.isArray(fromCfg) && fromCfg.length > 0) return fromCfg as string[];
  const fromManifest = manifestCoord()[key];
  return Array.isArray(fromManifest) ? (fromManifest as string[]) : [];
}

/** Resolve the migration store path (coordination.migration_store) joined under cwd. */
function resolveMigrationStore(coord: Record<string, unknown>, cwd: string): string {
  const configured = typeof coord.migration_store === 'string' && coord.migration_store !== ''
    ? coord.migration_store
    : (typeof manifestCoord().migration_store === 'string' && manifestCoord().migration_store !== ''
      ? (manifestCoord().migration_store as string)
      : DEFAULT_MIGRATION_STORE);
  return path.join(cwd, configured);
}

function writeJson(result: unknown, raw: boolean): void {
  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

function handleOwnershipCheck(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const declaredRaw = parseFlag(args, '--declared');
  const actualRaw = parseFlag(args, '--actual');
  const increment = parseFlag(args, '--increment');
  const nowRaw = parseFlag(args, '--now-ts');

  if (declaredRaw === undefined || actualRaw === undefined || !increment) {
    error('Usage: ferrox-tools query coord.ownership-check --declared <a,b,c> --actual <a,b> --increment <id>');
    return;
  }

  const nowMs = Number(nowRaw);
  const nowIso = nowRaw !== undefined && Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : '';

  const result = coordOwnership.runOwnershipCheck(
    { declared: parseList(declaredRaw), actual: parseList(actualRaw), nowIso },
    { logPath: haltingLog.haltingLogPath(cwd), increment },
  );

  writeJson(result, raw);
}

function handleHotSeamCheck(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const filesRaw = parseFlag(args, '--files');
  if (filesRaw === undefined) {
    error('Usage: ferrox-tools query coord.hot-seam-check --files <a,b>');
    return;
  }

  const coord = resolveCoordination(cwd);
  const seams = resolveList(coord, 'hot_seams');

  const result = coordHotSeam.evaluateHotSeam({ filesModified: parseList(filesRaw), seams });
  writeJson(result, raw);
}

function handleAllocMigration(args: string[], cwd: string, raw: boolean): void {
  const coord = resolveCoordination(cwd);
  const statePath = resolveMigrationStore(coord, cwd);
  const number = coordMigration.allocMigration({ statePath });
  writeJson({ number }, raw);
}

function handleCheckMigration(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const numberRaw = parseFlag(args, '--number');
  const number = Number(numberRaw);
  if (numberRaw === undefined || !Number.isFinite(number)) {
    error('Usage: ferrox-tools query coord.check-migration --number <n>');
    return;
  }

  const coord = resolveCoordination(cwd);
  const statePath = resolveMigrationStore(coord, cwd);
  const result = coordMigration.checkMigration({ statePath, number });
  writeJson(result, raw);
}

function handleConsumeMigration(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const numberRaw = parseFlag(args, '--number');
  const number = Number(numberRaw);
  if (numberRaw === undefined || !Number.isFinite(number)) {
    error('Usage: ferrox-tools query coord.consume-migration --number <n>');
    return;
  }

  const coord = resolveCoordination(cwd);
  const statePath = resolveMigrationStore(coord, cwd);
  const result = coordMigration.consumeMigration({ statePath, number });
  writeJson(result, raw);
}

function handleSharedWriteCheck(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const actor = parseFlag(args, '--actor');
  const target = parseFlag(args, '--target');
  if (!actor || !target) {
    error('Usage: ferrox-tools query coord.shared-write-check --actor <role> --target <path>');
    return;
  }

  const coord = resolveCoordination(cwd);
  const sharedPaths = resolveList(coord, 'shared_state_paths');

  const result = coordSharedWrite.evaluateSharedWrite({ actor, targetPath: target, sharedPaths });
  writeJson(result, raw);
}

function routeCoordCommand({ args, cwd, raw, error }: RouteCoordCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: COORD_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown coord subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'ownership-check': () => handleOwnershipCheck(args, cwd, raw, error),
      'hot-seam-check': () => handleHotSeamCheck(args, cwd, raw, error),
      'alloc-migration': () => handleAllocMigration(args, cwd, raw),
      'check-migration': () => handleCheckMigration(args, cwd, raw, error),
      'consume-migration': () => handleConsumeMigration(args, cwd, raw, error),
      'shared-write-check': () => handleSharedWriteCheck(args, cwd, raw, error),
    },
  });
}

export = { routeCoordCommand };
