/**
 * MODEL-01..03 model.* CLI router (Plan 05).
 *
 * Exposes the three Plan 02 model-tiering cores as the locked-name verbs
 * `ferrox_run query model.<verb>`:
 *   - model.route       (MODEL-01, model-route core)
 *   - model.escalate    (MODEL-02, model-escalate core — the one-hop cap)
 *   - model.risk-grade  (MODEL-03, model-risk-grade core)
 *
 * The router is the SOLE place operator-supplied CLI flags enter the pure cores.
 * It resolves the operator's `model.*` block via loadConfig (Plan 01 propagation)
 * — stage_tiers / default_tier / tier_order / max_escalations / risk_boundaries —
 * and forwards EXPLICIT inputs to the cores, which reach for no config, git, or
 * clock. A missing required flag fails closed on the error() InvalidArgs path
 * (non-zero, no crash — threat T-06-12); alias drift is guarded by the
 * check-alias-drift MODEL family entry (threat T-06-13).
 *
 * Determinism: no Date.now here. The model cores carry no timestamp — every
 * decision derives from EXPLICIT flags + config-resolved model inputs.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/model-command-router.cjs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelRoute = require('./model-route.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelEscalate = require('./model-escalate.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelRiskGrade = require('./model-risk-grade.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelBackend = require('./model-backend.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import anvilExecutor = require('./anvil-executor.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import anvilEligibility = require('./anvil-eligibility.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import anvilCandidateGate = require('./anvil-candidate-gate.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gateFirstExecutor = require('./gate-first-executor.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import crucibleRoute = require('./crucible-route.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;

interface RouteModelCommandOptions {
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

/**
 * Resolve the operator's model block from config (Plan 01 propagation). A load
 * failure collapses to an empty block; the per-key resolvers below then supply
 * the manifest defaults.
 */
function resolveModel(cwd: string): Record<string, unknown> {
  try {
    const cfg = loadConfig(cwd);
    const m = cfg && typeof cfg.model === 'object' && cfg.model !== null ? cfg.model : {};
    return m as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The manifest model default — the authoritative fallback when a config drops the
 * model block entirely. Read once from the sibling
 * ferrox-core/bin/shared/config-defaults.manifest.json (../shared relative to the
 * compiled router in bin/lib) and cached.
 */
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

/** Resolve a model object-map key (stage_tiers) with a manifest-default fallback. */
function resolveObject(model: Record<string, unknown>, key: string): Record<string, unknown> {
  const fromCfg = model[key];
  if (fromCfg && typeof fromCfg === 'object' && !Array.isArray(fromCfg)) return fromCfg as Record<string, unknown>;
  const fromManifest = manifestModel()[key];
  return fromManifest && typeof fromManifest === 'object' && !Array.isArray(fromManifest)
    ? (fromManifest as Record<string, unknown>)
    : {};
}

/** Resolve a model string-list key with a manifest-default fallback. */
function resolveList(model: Record<string, unknown>, key: string): string[] {
  const fromCfg = model[key];
  if (Array.isArray(fromCfg) && fromCfg.length > 0) return fromCfg as string[];
  const fromManifest = manifestModel()[key];
  return Array.isArray(fromManifest) ? (fromManifest as string[]) : [];
}

/** Resolve a model string key with a manifest-default fallback. */
function resolveString(model: Record<string, unknown>, key: string): string {
  const fromCfg = model[key];
  if (typeof fromCfg === 'string' && fromCfg !== '') return fromCfg;
  const fromManifest = manifestModel()[key];
  return typeof fromManifest === 'string' ? fromManifest : '';
}

/** Resolve a model numeric key with a manifest-default fallback. */
function resolveNumber(model: Record<string, unknown>, key: string, dflt: number): number {
  const fromCfg = model[key];
  if (typeof fromCfg === 'number' && Number.isFinite(fromCfg)) return fromCfg;
  const fromManifest = manifestModel()[key];
  return typeof fromManifest === 'number' && Number.isFinite(fromManifest) ? fromManifest : dflt;
}

function writeJson(result: unknown, raw: boolean): void {
  process.stdout.write((raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n');
}

function handleRoute(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const stage = parseFlag(args, '--stage');
  const wantsDump = args.includes('--dump');
  // Require either a --stage lookup or an explicit --dump; neither is InvalidArgs
  // (a bare route with no target is a caller error, not a silent whole-map dump).
  if (stage === undefined && !wantsDump) {
    error('Usage: ferrox-tools query model.route --stage <stage> | --dump', 'InvalidArgs');
    return;
  }
  const model = resolveModel(cwd);
  const result = modelRoute.evaluateRoute({
    stage: wantsDump ? undefined : stage,
    stageTiers: resolveObject(model, 'stage_tiers'),
    defaultTier: resolveString(model, 'default_tier'),
    dump: wantsDump,
  });
  writeJson(result, raw);
}

function handleEscalate(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const from = parseFlag(args, '--from');
  const attemptRaw = parseFlag(args, '--attempt');
  const attempt = Number(attemptRaw);
  if (from === undefined || attemptRaw === undefined || !Number.isFinite(attempt)) {
    error('Usage: ferrox-tools query model.escalate --from <tier> --attempt <n>', 'InvalidArgs');
    return;
  }
  const model = resolveModel(cwd);
  const result = modelEscalate.evaluateEscalate({
    from,
    attempt,
    tierOrder: resolveList(model, 'tier_order'),
    maxEscalations: resolveNumber(model, 'max_escalations', 1),
  });
  writeJson(result, raw);
}

function handleRiskGrade(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const selfGrade = parseFlag(args, '--self-grade');
  if (selfGrade === undefined) {
    error('Usage: ferrox-tools query model.risk-grade --self-grade <grade> [--paths <a,b>] [--categories <a,b>]', 'InvalidArgs');
    return;
  }
  const model = resolveModel(cwd);
  const result = modelRiskGrade.evaluateRiskGrade({
    paths: parseList(parseFlag(args, '--paths')),
    categories: parseList(parseFlag(args, '--categories')),
    riskBoundaries: resolveList(model, 'risk_boundaries'),
    selfGrade,
  });
  writeJson(result, raw);
}

/**
 * FLUX-02 model.backend — resolve the transport + model-id for a tier with graceful
 * degradation. This is the IMPURE shell: it probes the operator's env for the model
 * key (presence only — the VALUE is never read into a variable, logged, or returned)
 * and PATH for the fallback CLIs, then forwards booleans to the pure resolver.
 *
 * SECRET BOUNDARY: the key env-var NAME comes from `model.provider.key_env` (default
 * FERROX_MODEL_KEY); we only test `process.env[name] != null && != ''`. No flux
 * internals, no key value, ever leave this function.
 */
function handleBackend(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const tier = parseFlag(args, '--tier');
  if (tier === undefined) {
    error('Usage: ferrox-tools query model.backend --tier <rung> [--stage <stage>]', 'InvalidArgs');
    return;
  }
  const model = resolveModel(cwd);
  const providerBlock = (model.provider && typeof model.provider === 'object' && !Array.isArray(model.provider))
    ? (model.provider as Record<string, unknown>)
    : {};
  const provider = typeof providerBlock.type === 'string'
    ? providerBlock.type
    : (typeof model.provider === 'string' ? model.provider : undefined);
  const keyEnv = typeof providerBlock.key_env === 'string' && providerBlock.key_env !== ''
    ? providerBlock.key_env
    : 'FERROX_MODEL_KEY';

  // presence-only probe — never capture the value
  const fluxKeyPresent = typeof process.env[keyEnv] === 'string' && process.env[keyEnv] !== '';
  // CLI fallback availability: any panel CLI on PATH (checked without executing it)
  const cliAvailable = ['codex', 'gemini'].some((bin) => hasOnPath(bin));

  const result = modelBackend.resolveModelBackend({
    provider,
    tierModels: resolveObject(model, 'tier_models'),
    tier,
    fluxKeyPresent,
    cliAvailable,
  });
  writeJson(result, raw);
}

/**
 * ANV-05 model.anvil-run — CONSUME-ONLY shell-out to `~/dev/anvil/anvil.py`. Reads the
 * spec + gate from files the caller emitted, resolves anvilPath from
 * `model.anvil_executor.anvil_path` (default ~/dev/anvil/anvil.py), runs the gated loop,
 * and prints { ran, parsed, candidatePresent, candidatePath, decision }. It NEVER lands
 * the candidate — the workflow must route candidatePath through the unchanged merge-gate.
 * `.keys.env` is never touched here; anvil owns its own key.
 */
function handleAnvilRun(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const label = parseFlag(args, '--label');
  const specFile = parseFlag(args, '--spec-file');
  const gateFile = parseFlag(args, '--gate-file');
  const scratchDir = parseFlag(args, '--scratch');
  if (label === undefined || specFile === undefined || gateFile === undefined || scratchDir === undefined) {
    error('Usage: ferrox-tools query model.anvil-run --label <l> --spec-file <p> --gate-file <p> --scratch <dir> [--budget <n>]', 'InvalidArgs');
    return;
  }
  const model = resolveModel(cwd);
  const anvilBlock = (model.anvil_executor && typeof model.anvil_executor === 'object' && !Array.isArray(model.anvil_executor))
    ? (model.anvil_executor as Record<string, unknown>)
    : {};
  const anvilPath = typeof anvilBlock.anvil_path === 'string' && anvilBlock.anvil_path !== ''
    ? anvilBlock.anvil_path
    : path.join(process.env.HOME || '', 'dev', 'anvil', 'anvil.py');
  const budget = Number(parseFlag(args, '--budget'));

  let spec = '';
  let gateScript = '';
  try {
    spec = fs.readFileSync(specFile, 'utf8');
    gateScript = fs.readFileSync(gateFile, 'utf8');
  } catch {
    error(`Cannot read spec/gate file`, 'InvalidArgs');
    return;
  }

  const result = anvilExecutor.runAnvil({
    anvilPath,
    scratchDir,
    label,
    spec,
    gateScript,
    budget: Number.isFinite(budget) ? budget : 12,
  });
  // never echo the candidate BODY — only its path + the decision (keeps output lean + safe)
  writeJson({
    ran: result.ran,
    // top-level `action` so a workflow can `--pick action` (the pick helper is top-level only)
    action: result.decision.action,
    green: result.parsed.green,
    parsed: result.parsed,
    candidatePresent: result.candidatePresent,
    candidatePath: result.candidatePath,
    decision: result.decision,
    reason: result.reason,
  }, raw);
}

/**
 * Resolve the operator's `model.gate_first` block ({} when absent). Keys: enabled,
 * cheap, ladder, budget, seed_n — the native counterpart of `model.anvil_executor`.
 */
function gateFirstBlock(model: Record<string, unknown>): Record<string, unknown> {
  return model.gate_first && typeof model.gate_first === 'object' && !Array.isArray(model.gate_first)
    ? (model.gate_first as Record<string, unknown>)
    : {};
}

/** Resolve the provider key-env NAME (presence-only probes; the VALUE is never read out). */
function providerKeyEnv(model: Record<string, unknown>): string {
  const providerBlock = (model.provider && typeof model.provider === 'object' && !Array.isArray(model.provider))
    ? (model.provider as Record<string, unknown>)
    : {};
  return typeof providerBlock.key_env === 'string' && providerBlock.key_env !== ''
    ? providerBlock.key_env
    : 'FERROX_MODEL_KEY';
}

/**
 * UGE-08 model.gate-first-eligibility — the universal routing consult. Forwards explicit
 * flags to the pure UGE-06 predicate (evaluateGateFirstEligibility) and prints
 * { eligible, route, reasons, depth, crucibleAvailable }. Router-shell probes (the
 * handleBackend pattern — booleans only, never values):
 *   --executor-available omitted -> presence-only probe of the provider key env (the
 *     native driver needs the OpenAI-compatible transport, nothing else);
 *   --enabled omitted            -> `model.gate_first.enabled`, DEFAULT TRUE — gate-first
 *     is the DEFAULT executor for eligible increments (v1.8); the config key is the opt-OUT.
 *   crucibleAvailable            -> probeCrucibleAvailable() PATH lookup (UGE-07), so the
 *     route=crucible branch needs no second consult.
 */
function handleGateFirstEligibility(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const domain = parseFlag(args, '--domain');
  if (domain === undefined) {
    error('Usage: ferrox-tools query model.gate-first-eligibility --domain <d> [--depth <fast|full>] [--gate-present true|false] [--executor-available true|false] [--enabled true|false]', 'InvalidArgs');
    return;
  }
  const model = resolveModel(cwd);
  const executorRaw = parseFlag(args, '--executor-available');
  const enabledRaw = parseFlag(args, '--enabled');
  const keyEnv = providerKeyEnv(model);

  const executorAvailable = executorRaw !== undefined
    ? executorRaw === 'true'
    : typeof process.env[keyEnv] === 'string' && process.env[keyEnv] !== '';
  const enabled = enabledRaw !== undefined
    ? enabledRaw === 'true'
    : gateFirstBlock(model).enabled !== false;

  const result = anvilEligibility.evaluateGateFirstEligibility({
    depth: parseFlag(args, '--depth'),
    domain,
    gatePresent: parseFlag(args, '--gate-present') === 'true',
    executorAvailable,
    enabled,
  });
  writeJson({ ...result, crucibleAvailable: crucibleRoute.probeCrucibleAvailable() }, raw);
}

/** Resolve a string[] from a gate_first config key, else the given literals. */
function gateFirstList(block: Record<string, unknown>, key: string, dflt: string[]): string[] {
  const v = block[key];
  if (Array.isArray(v)) {
    const list = v.filter((s): s is string => typeof s === 'string' && s !== '');
    if (list.length > 0) return list;
  }
  return dflt;
}

// No `model.gate_first` config and no flag -> sensible literals: the cheap pool mirrors the
// proven cheap-pool-plus-gate lane (BENCHMARK-v1.7 — minimax-class cheap models behind a gate
// hit 100% at 1/7-1/38 frontier cost); the ladder is spec §3's per-check escalation order
// (fable -> opus). Override via `model.gate_first.{cheap,ladder}` or --cheap/--ladder.
const DEFAULT_GATE_FIRST_CHEAP = ['flux-pinned-minimax-m3', 'flux-pinned-qwen-plus', 'flux-pinned-deepseek-v4-pro'];
const DEFAULT_GATE_FIRST_LADDER = ['flux-pinned-claude-fable-5', 'flux-pinned-claude-opus-4-8'];

/**
 * UGE-08 model.gate-first-run — the NATIVE gated cheap-loop (UGE-05 driver) as a verb.
 * Reads the spec the caller emitted, wires runGateFirst through createDefaultEffects
 * (openai-client transport + canonical gate-runner), and prints the run result with the
 * ANV-03 taxonomy at top level: green candidate -> action 'accept-candidate' (the candidate
 * file STILL faces the unchanged verify + merge-gate); anything else -> 'reject' /
 * 'fallback-normal'. The candidate BODY is never echoed — finalText goes to a scratch file
 * and only its PATH is printed (the anvil-run output discipline).
 * `--gate-cmd` is comma-separated argv (e.g. `python3,.planning/gates/x.gate.py`); the
 * artifact path is appended by gate-runner. Trust boundary (spec §4) holds end-to-end:
 * builders only ever see check identifiers, never the gate.
 */
function handleGateFirstRun(args: string[], cwd: string, raw: boolean, error: (m: string, r?: string) => void): void {
  const specFile = parseFlag(args, '--spec-file');
  const gateCmdRaw = parseFlag(args, '--gate-cmd');
  const domain = parseFlag(args, '--domain');
  if (specFile === undefined || gateCmdRaw === undefined || domain === undefined) {
    error('Usage: ferrox-tools query model.gate-first-run --spec-file <p> --gate-cmd <cmd[,arg,..]> --domain <d> [--cheap <csv>] [--ladder <csv>] [--budget <n>] [--seed-n <n>] [--timeout-ms <n>] [--base-url <url>] [--key-env <name>] [--scratch <dir>]', 'InvalidArgs');
    return;
  }
  const gateCmd = parseList(gateCmdRaw);
  if (gateCmd.length === 0) {
    error('Usage: ferrox-tools query model.gate-first-run --spec-file <p> --gate-cmd <cmd[,arg,..]> --domain <d> [...]', 'InvalidArgs');
    return;
  }
  let spec = '';
  try {
    spec = fs.readFileSync(specFile, 'utf8');
  } catch {
    error('Cannot read spec file', 'InvalidArgs');
    return;
  }

  const model = resolveModel(cwd);
  const gf = gateFirstBlock(model);
  const providerBlock = (model.provider && typeof model.provider === 'object' && !Array.isArray(model.provider))
    ? (model.provider as Record<string, unknown>)
    : {};

  const cheapFlag = parseList(parseFlag(args, '--cheap'));
  const ladderFlag = parseList(parseFlag(args, '--ladder'));
  const cheap = cheapFlag.length > 0 ? cheapFlag : gateFirstList(gf, 'cheap', DEFAULT_GATE_FIRST_CHEAP);
  const ladder = ladderFlag.length > 0 ? ladderFlag : gateFirstList(gf, 'ladder', DEFAULT_GATE_FIRST_LADDER);
  const budgetRaw = Number(parseFlag(args, '--budget'));
  const budget = Number.isFinite(budgetRaw) ? budgetRaw : resolveNumber(gf, 'budget', 12);
  const seedRaw = Number(parseFlag(args, '--seed-n'));
  const seedN = Number.isFinite(seedRaw) ? seedRaw : resolveNumber(gf, 'seed_n', 3);
  const timeoutRaw = Number(parseFlag(args, '--timeout-ms'));
  const perCallTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined;

  const baseUrlFlag = parseFlag(args, '--base-url');
  const baseUrl = baseUrlFlag !== undefined && baseUrlFlag !== ''
    ? baseUrlFlag
    : typeof providerBlock.base_url === 'string' ? providerBlock.base_url : '';
  const keyEnvFlag = parseFlag(args, '--key-env');
  const keyEnv = keyEnvFlag !== undefined && keyEnvFlag !== '' ? keyEnvFlag : providerKeyEnv(model);

  let scratchDir = parseFlag(args, '--scratch') ?? '';
  try {
    if (scratchDir === '') {
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-first-run-'));
    } else {
      fs.mkdirSync(scratchDir, { recursive: true });
    }
  } catch {
    error('Cannot create scratch dir', 'InvalidArgs');
    return;
  }

  const effects = gateFirstExecutor.createDefaultEffects({ baseUrl, keyEnv, scratchDir });

  // runGateFirst is async (real HTTP + subprocess gate). The router contract is sync-dispatch,
  // so this handler floats the promise: runMain uses process.exitCode (never process.exit), the
  // event loop stays alive until the climb resolves, and runGateFirst never throws by design —
  // the catch below is a belt-and-braces fence so a pathological failure can't become an
  // unhandled rejection.
  void (async () => {
    const res = await gateFirstExecutor.runGateFirst({
      spec,
      gateCmd,
      config: { cheap, ladder, budget, seedN, perCallTimeoutMs },
      effects,
    });
    // Candidate to disk, PATH-only on stdout (never the body).
    let candidatePath = '';
    if (typeof res.finalText === 'string' && res.finalText !== '') {
      candidatePath = path.join(scratchDir, 'final-artifact.txt');
      fs.writeFileSync(candidatePath, res.finalText);
    }
    // ANV-03 taxonomy, natively: green + candidate -> accept-candidate; else reject/fallback.
    const decision = anvilCandidateGate.decideAnvilCandidate({
      parsed: { green: res.solved },
      candidatePresent: candidatePath !== '',
    });
    writeJson({
      // top-level `action` so a workflow can `--pick action` (anvil-run parity)
      action: decision.action,
      solved: res.solved,
      score: res.score,
      fails: res.fails,
      stopReason: res.stopReason,
      roundsUsed: res.roundsUsed,
      escalated: res.escalated,
      costUsd: res.costUsd,
      domain,
      candidatePath: candidatePath !== '' ? candidatePath : null,
      scratchDir,
      decision,
      log: res.log,
    }, raw);
  })().catch((e: unknown) => {
    process.stderr.write(`gate-first-run failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}

/** True if `bin` resolves on PATH — a lookup only, the binary is never executed. */
function hasOnPath(bin: string): boolean {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (d === '') continue;
    try {
      if (fs.existsSync(path.join(d, bin))) return true;
    } catch {
      /* ignore unreadable PATH entry */
    }
  }
  return false;
}

function routeModelCommand({ args, cwd, raw, error }: RouteModelCommandOptions): void {
  routeCjsCommandFamily({
    args,
    subcommands: MODEL_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) => `Unknown model subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'route': () => handleRoute(args, cwd, raw, error),
      'escalate': () => handleEscalate(args, cwd, raw, error),
      'risk-grade': () => handleRiskGrade(args, cwd, raw, error),
      'backend': () => handleBackend(args, cwd, raw, error),
      'anvil-run': () => handleAnvilRun(args, cwd, raw, error),
      'gate-first-eligibility': () => handleGateFirstEligibility(args, cwd, raw, error),
      'gate-first-run': () => handleGateFirstRun(args, cwd, raw, error),
    },
  });
}

export = { routeModelCommand };
