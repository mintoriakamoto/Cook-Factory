/**
 * MEM-01/02 memory.* CLI router (Plan 04).
 *
 * Exposes the tested Phase-7 memory cores (Plans 02-03) as the three locked-name
 * verbs `ferrox-tools query memory.<verb>`:
 *   - memory.fact    (MEM-01, memory-fact — --op add|get-valid-at|history|invalidate)
 *   - memory.recall  (MEM-02, memory-recall-capture.recall — read-only, valid-now)
 *   - memory.capture (MEM-02, memory-recall-capture.capture — MUTATION)
 *
 * The router is the SOLE place operator-supplied CLI flags + the config-resolved
 * `memory.fact_store` / `memory.recall_limit` (Plan 01 propagation) enter the pure
 * cores, which reach for no config, git, or clock. It resolves the fact store to
 * `path.join(cwd, memory.fact_store)` with a manifest fallback of
 * ".planning/graphs/memory-facts.json", and recall_limit (fallback 50). Every
 * timestamp is an EXPLICIT flag parsed with Number; a non-finite/missing required
 * flag fails closed on the error() InvalidArgs path (non-zero, no crash —
 * T-07-13). Alias drift is guarded by the check-alias-drift MEMORY family entry
 * (T-07-12).
 *
 * Determinism: no Date.now here — every decision timestamp is an explicit input.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/memory-command-router.cjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import memoryFact = require('./memory-fact.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import memoryRecallCapture = require('./memory-recall-capture.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;

interface RouteMemoryCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
}

/** The default fact-store path (relative to cwd). */
const DEFAULT_FACT_STORE = '.planning/graphs/memory-facts.json';
/** The default recall bound. */
const DEFAULT_RECALL_LIMIT = 50;

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Presence flag → boolean (e.g. --contradicts). */
function hasFlag(args: string[], flag: string): boolean {
  return args.indexOf(flag) >= 0;
}

/**
 * Resolve the operator's memory block from config (Plan 01 propagation). A load
 * failure collapses to an empty block; the fallbacks below supply the manifest
 * defaults.
 */
function resolveMemory(cwd: string): Record<string, unknown> {
  try {
    const cfg = loadConfig(cwd);
    const mem = cfg && typeof cfg.memory === 'object' && cfg.memory !== null ? cfg.memory : {};
    return mem as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The manifest memory default — the authoritative fallback when a config drops
 * the memory block entirely. Read once from the sibling
 * ferrox-core/bin/shared/config-defaults.manifest.json and cached.
 */
let manifestMemoryCache: Record<string, unknown> | null | undefined;
function manifestMemory(): Record<string, unknown> {
  if (manifestMemoryCache !== undefined) return manifestMemoryCache ?? {};
  try {
    const manifestPath = path.join(__dirname, '..', 'shared', 'config-defaults.manifest.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const mem = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).memory : undefined;
    manifestMemoryCache = mem && typeof mem === 'object' && mem !== null ? (mem as Record<string, unknown>) : null;
  } catch {
    manifestMemoryCache = null;
  }
  return manifestMemoryCache ?? {};
}

/** Resolve the fact store path (memory.fact_store) joined under cwd. */
function resolveFactStore(mem: Record<string, unknown>, cwd: string): string {
  const configured = typeof mem.fact_store === 'string' && mem.fact_store !== ''
    ? mem.fact_store
    : (typeof manifestMemory().fact_store === 'string' && manifestMemory().fact_store !== ''
      ? (manifestMemory().fact_store as string)
      : DEFAULT_FACT_STORE);
  return path.join(cwd, configured);
}

/**
 * Resolve the recall limit (memory.recall_limit) with a manifest fallback, CLAMPED
 * to a floor of 1 (L-1). recall truncates via `slice(0, limit)`: an operator value
 * of 0 would silently zero out every recall, and a negative value would drop the
 * NEWEST decisions (slice(0, -n)) — both are footguns, so any finite value below 1
 * (and any non-integer) is clamped up to the sane floor of one decision.
 */
const MIN_RECALL_LIMIT = 1;
function resolveRecallLimit(mem: Record<string, unknown>): number {
  const configured = mem.recall_limit;
  let resolved: number;
  if (typeof configured === 'number' && Number.isFinite(configured)) {
    resolved = configured;
  } else {
    const fromManifest = manifestMemory().recall_limit;
    resolved = typeof fromManifest === 'number' && Number.isFinite(fromManifest) ? fromManifest : DEFAULT_RECALL_LIMIT;
  }
  return Math.max(MIN_RECALL_LIMIT, Math.floor(resolved));
}

function writeJson(result: unknown, raw: boolean): void {
  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

/**
 * Parse an explicit timestamp flag with Number; on missing/non-finite call
 * error() (InvalidArgs) and return undefined so the handler bails.
 */
function parseTs(
  args: string[],
  flag: string,
  usage: string,
  error: (m: string, r?: string) => void,
): number | undefined {
  const raw = parseFlag(args, flag);
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n)) {
    error(usage, 'InvalidArgs');
    return undefined;
  }
  return n;
}

function handleFact(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const op = parseFlag(args, '--op');
  const mem = resolveMemory(cwd);
  const statePath = resolveFactStore(mem, cwd);

  switch (op) {
    case 'add': {
      const subject = parseFlag(args, '--subject');
      const predicate = parseFlag(args, '--predicate');
      const object = parseFlag(args, '--object');
      if (!subject || !predicate || object === undefined) {
        error('Usage: ferrox-tools query memory.fact --op add --subject <s> --predicate <p> --object <o> --valid-from <ts> --recorded-at <ts>', 'InvalidArgs');
        return;
      }
      const validFrom = parseTs(args, '--valid-from', 'memory.fact --op add requires a finite --valid-from', error);
      if (validFrom === undefined) return;
      const recordedAt = parseTs(args, '--recorded-at', 'memory.fact --op add requires a finite --recorded-at', error);
      if (recordedAt === undefined) return;
      const confidenceRaw = parseFlag(args, '--confidence');
      const confidence = confidenceRaw !== undefined ? Number(confidenceRaw) : undefined;
      if (confidence !== undefined && !Number.isFinite(confidence)) {
        error('memory.fact --op add: --confidence must be finite', 'InvalidArgs');
        return;
      }
      const result = memoryFact.addFact({ statePath, subject, predicate, object, validFrom, recordedAt, confidence });
      writeJson(result, raw);
      return;
    }
    case 'get-valid-at': {
      const ts = parseTs(args, '--ts', 'memory.fact --op get-valid-at requires a finite --ts', error);
      if (ts === undefined) return;
      const subject = parseFlag(args, '--subject');
      const result = memoryFact.getValidAt({ statePath, ts, subject });
      writeJson(result, raw);
      return;
    }
    case 'history': {
      const subject = parseFlag(args, '--subject');
      if (!subject) {
        error('Usage: ferrox-tools query memory.fact --op history --subject <s>', 'InvalidArgs');
        return;
      }
      const result = memoryFact.history({ statePath, subject });
      writeJson(result, raw);
      return;
    }
    case 'invalidate': {
      const subject = parseFlag(args, '--subject');
      const predicate = parseFlag(args, '--predicate');
      if (!subject || !predicate) {
        error('Usage: ferrox-tools query memory.fact --op invalidate --subject <s> --predicate <p> --valid-to <ts>', 'InvalidArgs');
        return;
      }
      const validTo = parseTs(args, '--valid-to', 'memory.fact --op invalidate requires a finite --valid-to', error);
      if (validTo === undefined) return;
      const matchObject = parseFlag(args, '--object');
      const result = memoryFact.invalidateFact({ statePath, subject, predicate, validTo, matchObject });
      writeJson(result, raw);
      return;
    }
    default:
      error(`Unknown or missing --op for memory.fact. Expected one of: add, get-valid-at, history, invalidate`, 'InvalidArgs');
      return;
  }
}

function handleRecall(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const subject = parseFlag(args, '--subject');
  if (!subject) {
    error('Usage: ferrox-tools query memory.recall --subject <s> --now-ts <ts>', 'InvalidArgs');
    return;
  }
  const nowTs = parseTs(args, '--now-ts', 'memory.recall requires a finite --now-ts', error);
  if (nowTs === undefined) return;
  const mem = resolveMemory(cwd);
  const statePath = resolveFactStore(mem, cwd);
  const limit = resolveRecallLimit(mem);
  const result = memoryRecallCapture.recall({ statePath, subject, nowTs, limit });
  writeJson(result, raw);
}

function handleCapture(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const subject = parseFlag(args, '--subject');
  const predicate = parseFlag(args, '--predicate');
  const object = parseFlag(args, '--object');
  if (!subject || !predicate || object === undefined) {
    error('Usage: ferrox-tools query memory.capture --subject <s> --predicate <p> --object <o> --valid-from <ts> --recorded-at <ts> [--contradicts]', 'InvalidArgs');
    return;
  }
  const validFrom = parseTs(args, '--valid-from', 'memory.capture requires a finite --valid-from', error);
  if (validFrom === undefined) return;
  const recordedAt = parseTs(args, '--recorded-at', 'memory.capture requires a finite --recorded-at', error);
  if (recordedAt === undefined) return;
  const confidenceRaw = parseFlag(args, '--confidence');
  const confidence = confidenceRaw !== undefined ? Number(confidenceRaw) : undefined;
  if (confidence !== undefined && !Number.isFinite(confidence)) {
    error('memory.capture: --confidence must be finite', 'InvalidArgs');
    return;
  }
  const contradicts = hasFlag(args, '--contradicts');
  const mem = resolveMemory(cwd);
  const statePath = resolveFactStore(mem, cwd);
  const result = memoryRecallCapture.capture({ statePath, subject, predicate, object, validFrom, recordedAt, confidence, contradicts });
  writeJson(result, raw);
}

function routeMemoryCommand({ args, cwd, raw, error }: RouteMemoryCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: MEMORY_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown memory subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'fact': () => handleFact(args, cwd, raw, error),
      'recall': () => handleRecall(args, cwd, raw, error),
      'capture': () => handleCapture(args, cwd, raw, error),
    },
  });
}

export = { routeMemoryCommand };
