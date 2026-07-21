/**
 * HALT-01 gate.cap-check CLI router (Plan 06, D-01/D-02) plus the Wave 1 sealed-gate
 * verbs (MILESTONE v1.9, ADR-SEALED-GATES).
 *
 * gate.cap-check: exposes the tested gate-cap core (Plan 02) as
 * `ferrox_run query gate.cap-check`. Resolves the gate's caps from
 * halting.gates.<gate>.* (with built-in fallbacks max_passes=3,
 * wall_clock_seconds=1800, cap_outcome=stop-and-rescope), forwards EXPLICIT
 * --start-ts/--now-ts ms + pass count to the core, and writes the decision JSON to
 * stdout. The run-log `ts` is derived from --now-ts (new Date(nowMs).toISOString()),
 * never a clock read (plan-check W1).
 *
 * gate.seal / gate.verify-seal: seal a fixture or gate script into the
 * content-addressed store (default ~/.cache/ferrox/gates/sealed, --store or
 * FERROX_SEALED_STORE override) and verify a sealed object's presence + integrity.
 * gate.sample-mutants: replay the pinned per-run rotation sample for a
 * (runId, gateId, pool) triple. All 3 print core-result JSON at exit 0; a failed
 * verify is a decision, not a crash.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/gate-command-router.cjs.
 */

import { GATE_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gateCap = require('./gate-cap.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gateSeal = require('./gate-seal.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import haltingLog = require('./halting-log.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import mutantRotation = require('./mutant-rotation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;

type CapOutcome = 'ship-with-backlog' | 'stop-and-rescope' | 'escalate-to-human';

interface RouteGateCommandOptions {
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

function handleCapCheck(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const gate = parseFlag(args, '--gate');
  const increment = parseFlag(args, '--increment');
  const passesRaw = parseFlag(args, '--passes');
  const startRaw = parseFlag(args, '--start-ts');
  const nowRaw = parseFlag(args, '--now-ts');

  const passes = Number(passesRaw);
  const startMs = Number(startRaw);
  const nowMs = Number(nowRaw);

  if (
    !gate || !increment ||
    passesRaw === undefined || startRaw === undefined || nowRaw === undefined ||
    !Number.isFinite(passes) || !Number.isFinite(startMs) || !Number.isFinite(nowMs)
  ) {
    error('Usage: ferrox-tools query gate.cap-check --gate <id> --increment <id> --passes <n> --start-ts <ms> --now-ts <ms>');
    return;
  }

  const halting = resolveHalting(cwd);
  const gates = (halting.gates && typeof halting.gates === 'object' ? halting.gates : {}) as Record<string, Record<string, unknown>>;
  const g = (gates[gate] && typeof gates[gate] === 'object' ? gates[gate] : {});

  const maxPasses = Number.isFinite(Number(g.max_passes)) ? Number(g.max_passes) : 3;
  const wallClockSeconds = Number.isFinite(Number(g.wall_clock_seconds)) ? Number(g.wall_clock_seconds) : 1800;
  const capOutcome = (typeof g.cap_outcome === 'string' ? g.cap_outcome : 'stop-and-rescope') as CapOutcome;

  const nowIso = new Date(nowMs).toISOString();

  const result = gateCap.runGateCapCheck(
    { gate, passes, maxPasses, startMs, nowMs, wallClockSeconds, capOutcome, nowIso },
    { logPath: haltingLog.haltingLogPath(cwd), increment },
  );

  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

function emit(result: unknown, raw: boolean): void {
  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

function handleSeal(args: string[], raw: boolean, error: (m: string, r?: string) => void): void {
  const file = parseFlag(args, '--file');
  if (!file) {
    error('Usage: ferrox-tools query gate.seal --file <path> [--store <root>]');
    return;
  }
  emit(gateSeal.sealPut({ filePath: file, storeRoot: parseFlag(args, '--store') }), raw);
}

function handleVerifySeal(args: string[], raw: boolean, error: (m: string, r?: string) => void): void {
  const uri = parseFlag(args, '--uri');
  if (!uri) {
    error('Usage: ferrox-tools query gate.verify-seal --uri sealed:sha256:<hash> [--store <root>]');
    return;
  }
  const got = gateSeal.sealGet({ ref: uri, storeRoot: parseFlag(args, '--store') });
  // Never print sealed content: the verdict carries hash + size only (trust boundary).
  emit(got.ok === true ? { ok: true, hash: got.hash, bytes: got.content.length, path: got.path } : got, raw);
}

function handleSampleMutants(args: string[], raw: boolean, error: (m: string, r?: string) => void): void {
  const runId = parseFlag(args, '--run-id');
  const gateId = parseFlag(args, '--gate-id');
  const poolRaw = parseFlag(args, '--pool');
  const kRaw = parseFlag(args, '--k');
  const usage =
    'Usage: ferrox-tools query gate.sample-mutants --run-id <id> --gate-id <id> --pool <json array of {id, fixture}> [--k <n>]';
  if (!runId || !gateId || poolRaw === undefined) {
    error(usage);
    return;
  }
  let pool: unknown;
  try {
    pool = JSON.parse(poolRaw);
  } catch {
    error(usage);
    return;
  }
  if (!Array.isArray(pool)) {
    error(usage);
    return;
  }
  const k = kRaw !== undefined && Number.isFinite(Number(kRaw)) ? Number(kRaw) : undefined;
  emit(mutantRotation.sampleMutants({ runId, gateId, pool, k }), raw);
}

function routeGateCommand({ args, cwd, raw, error }: RouteGateCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: GATE_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown gate subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'cap-check': () => handleCapCheck(args, cwd, raw, error),
      'seal': () => handleSeal(args, raw, error),
      'verify-seal': () => handleVerifySeal(args, raw, error),
      'sample-mutants': () => handleSampleMutants(args, raw, error),
    },
  });
}

export = { routeGateCommand };
