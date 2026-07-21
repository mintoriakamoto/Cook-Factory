/**
 * UGE-05 — the native gate-first climb DRIVER (ANVIL-PORT-SPEC.md §3 at fidelity).
 *
 * Dependency-injected orchestrator around the PURE gate-climb state machine (UGE-04): the loop is
 * `nextStep(state)` -> perform the action via injected effects -> `applyResult`. All I/O crosses the
 * `effects` seam — { generate, runGate, writeArtifact, now, polish? } — so the whole driver is fully
 * testable with stubs (no network, no subprocess in unit tests).
 *
 * Shape: probe green-first-call -> done (the dominant cost saver). Ensemble on probe failure —
 * SEQUENTIAL by design (determinism beats parallelism here). Then ratcheted surgical climb with
 * per-check escalation and the single consolidation, per the state machine. Stop reasons are
 * surfaced verbatim.
 *
 * TRUST BOUNDARY (spec §4, non-negotiable): every builder prompt carries ONLY check identifier
 * strings from fails[] — never gate source, never expected values, never the gate command/path.
 * The prompt builders take (spec, text, check-ids) and structurally CANNOT see the gate.
 *
 * Resilience: a per-call timeout bounds EVERY generate call; a generate throw/timeout yields no
 * candidate — it is logged as a sentinel result (score [-1,1], which any real gate result strictly
 * beats and which still consumes budget so a dead provider terminates) — the run never crashes.
 *
 * Post-green QUAL-01 hook: when `effects.polish` is provided and the climb ends green, the polished
 * text is RE-GATED and kept ONLY if decideKeep() accepts (quality-pipeline), the score did not drop,
 * and the gate is still fully green — the non-regressive fence, ported as settled in spec §7.
 *
 * Result: { solved, score, fails, roundsUsed, escalated, stopReason, finalText, log, costUsd } —
 * spirit-compatible with anvil's {score, solved, fails_left, rounds, cost, log, final_text}.
 *
 * createDefaultEffects() is the thin real-effects factory: generate adapts to the openai-client
 * chat surface (the OpenAI-compatible transport model-backend resolves to; model ids come from the
 * caller's resolveModelBackend-driven config), runGate drives the canonical gate-runner contract,
 * writeArtifact persists candidates to a scratch dir. The chat function is injectable so the
 * adapter itself is fully stub-tested — no network in tests.
 *
 * ADR-457: compiles to ferrox-core/bin/lib/gate-first-executor.cjs. `export =` shape. Never throws.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gateClimb = require('./gate-climb.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import qualityPipeline = require('./quality-pipeline.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import gateRunner = require('./gate-runner.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import openaiClient = require('./openai-client.cjs');

type Score = [number, number];

interface GenerateArgs {
  model: string;
  system: string;
  prompt: string;
  temperature: number;
  maxTokens?: number;
  timeoutMs: number;
}

interface Effects {
  generate?: (args: GenerateArgs) => unknown;
  runGate?: (args: { gateCmd: unknown; artifactPath: string; text: string }) => unknown;
  writeArtifact?: (text: string) => unknown;
  now?: () => unknown;
  polish?: (text: string) => unknown;
}

interface LogEntry {
  at: number;
  action: string;
  model?: string;
  target?: string;
  ok: boolean;
  score?: Score;
  fails?: string[];
  note?: string;
}

interface GateFirstResult {
  solved: boolean;
  score: Score;
  fails: string[];
  roundsUsed: number;
  escalated: boolean;
  stopReason: string;
  finalText: string;
  log: LogEntry[];
  costUsd: number;
}

const SYSTEM_PROMPT =
  'You are a build model. Follow the task spec exactly and emit only what is requested.';
const BUILD_TEMPERATURE = 0.2;
/** Consolidation rebuilds run hotter (spec §3: temp 0.7). */
const CONSOLIDATE_TEMPERATURE = 0.7;
const DEFAULT_PER_CALL_TIMEOUT_MS = 120000;
/** Sentinel check id for a generate that threw/timed out — our own string, never gate-derived. */
const CALL_FAILED_CHECK = '<model-call-failed>';

/** PURE. Strip fences: the artifact is the LAST fenced block of the reply; no block -> trimmed reply. */
function extractArtifact(reply?: unknown): string {
  if (typeof reply !== 'string') return '';
  // allow-adhoc-markdown: model-reply artifact extraction needs the LAST block with ANY info string; the sectionizer's extractFencedBlock is info-string-keyed and stripFencedCode discards block content
  const re = /```[^\n]*\n?([\s\S]*?)```/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) last = m[1];
  if (last !== null) return last.replace(/\n+$/, '');
  return reply.trim();
}

/** PURE. Build prompt (spec §3): spec verbatim + emit ONLY the complete artifact, single fenced block. */
function buildProbePrompt(spec: unknown): string {
  const s = typeof spec === 'string' ? spec : '';
  return (
    `${s}\n\n` +
    'Emit ONLY the complete artifact: reply with a single fenced code block containing the entire ' +
    'artifact, and nothing else.'
  );
}

/** Keep only check-identifier strings (the trust boundary: identifiers are the ONLY gate feedback). */
function checkIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string' && f !== '') : [];
}

/**
 * PURE. Surgical repair prompt (spec §3): spec + current best text + the target failing check +
 * up to 8 other failing check NAMES + fix-without-regressing. Identifiers only — this builder never
 * sees the gate, so nothing gate-derived can leak.
 */
function buildSurgicalPrompt(spec: unknown, currentText: unknown, target: unknown, others?: unknown): string {
  const s = typeof spec === 'string' ? spec : '';
  const text = typeof currentText === 'string' ? currentText : '';
  const t = typeof target === 'string' ? target : '';
  const capped = checkIds(others).slice(0, 8);
  const othersBlock =
    capped.length > 0 ? `Other failing checks:\n${capped.map((f) => `- ${f}`).join('\n')}\n\n` : '';
  return (
    `${s}\n\n` +
    `Current best artifact:\n\`\`\`\n${text}\n\`\`\`\n\n` +
    `This check FAILS: ${t}\n\n` +
    othersBlock +
    'Fix the failing check without regressing anything that already passes. ' +
    'Emit ONLY the complete corrected artifact as a single fenced code block.'
  );
}

/** PURE. Consolidation prompt (spec §3): spec + "prior solution FAILS these checks, fix ALL" + first 10. */
function buildConsolidationPrompt(spec: unknown, fails?: unknown): string {
  const s = typeof spec === 'string' ? spec : '';
  const first10 = checkIds(fails).slice(0, 10);
  return (
    `${s}\n\n` +
    `A prior solution FAILS these checks, fix ALL of them:\n` +
    `${first10.map((f) => `- ${f}`).join('\n')}\n\n` +
    'Rebuild the solution from scratch. Emit ONLY the complete artifact as a single fenced code block.'
  );
}

/** Fail-closed gate-outcome normalizer: garbage -> score [0,1] + '<gate-error>'. */
function normalizeGateOutcome(raw: unknown): { score: Score; fails: string[] } {
  const r = raw && typeof raw === 'object' ? (raw as { score?: unknown; fails?: unknown }) : {};
  const fails = checkIds(r.fails);
  if (
    Array.isArray(r.score) &&
    r.score.length >= 2 &&
    typeof r.score[0] === 'number' &&
    Number.isFinite(r.score[0]) &&
    typeof r.score[1] === 'number' &&
    Number.isFinite(r.score[1])
  ) {
    return { score: [r.score[0], r.score[1]], fails };
  }
  return { score: [0, 1], fails: fails.length > 0 ? fails : ['<gate-error>'] };
}

/** Bound a promise: reject after `ms` so one hung provider call can never stall the run. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!(Number.isFinite(ms) && ms > 0)) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('per-call timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/**
 * IMPURE (via injected effects only). Run the full native gate-first climb for one spec.
 * Never throws — every failure path degrades to a not-solved result with the log telling why.
 */
async function runGateFirst(opts?: {
  spec?: unknown;
  gateCmd?: unknown;
  config?: {
    cheap?: unknown;
    ladder?: unknown;
    budget?: unknown;
    seedN?: unknown;
    perCallTimeoutMs?: unknown;
    maxTokens?: unknown;
  };
  effects?: Effects;
}): Promise<GateFirstResult> {
  const o = opts && typeof opts === 'object' ? opts : {};
  const spec = typeof o.spec === 'string' ? o.spec : '';
  const cfg = o.config && typeof o.config === 'object' ? o.config : {};
  const fx: Effects = o.effects && typeof o.effects === 'object' ? o.effects : {};
  const perCallTimeoutMs =
    typeof cfg.perCallTimeoutMs === 'number' && Number.isFinite(cfg.perCallTimeoutMs) && cfg.perCallTimeoutMs > 0
      ? cfg.perCallTimeoutMs
      : DEFAULT_PER_CALL_TIMEOUT_MS;
  const maxTokens =
    typeof cfg.maxTokens === 'number' && Number.isFinite(cfg.maxTokens) && cfg.maxTokens > 0
      ? Math.floor(cfg.maxTokens)
      : undefined;

  const log: LogEntry[] = [];
  let costUsd = 0;
  let escalated = false;
  let stopReason = 'budget'; // pathological-fallback only; the loop always overwrites it

  const now = (): number => {
    try {
      const t = typeof fx.now === 'function' ? fx.now() : Date.now();
      return typeof t === 'number' && Number.isFinite(t) ? t : 0;
    } catch {
      return 0;
    }
  };

  /** One model call, timeout-bounded. Failure -> { ok:false } — logged by the caller, never thrown. */
  const generateOnce = async (
    model: string,
    prompt: string,
    temperature: number
  ): Promise<{ ok: true; text: string } | { ok: false; note: string }> => {
    try {
      if (typeof fx.generate !== 'function') throw new Error('no generate effect');
      const raw = await withTimeout(
        Promise.resolve(fx.generate({ model, system: SYSTEM_PROMPT, prompt, temperature, maxTokens, timeoutMs: perCallTimeoutMs })),
        perCallTimeoutMs
      );
      const r = raw && typeof raw === 'object' ? (raw as { text?: unknown; costUsd?: unknown }) : {};
      if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd > 0) costUsd += r.costUsd;
      return { ok: true, text: extractArtifact(r.text) };
    } catch (e) {
      return { ok: false, note: `generate-failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  /** Write + gate one candidate. Any effect failure fails CLOSED (score [0,1]), never throws. */
  const gateOnce = async (text: string): Promise<{ score: Score; fails: string[] }> => {
    try {
      if (typeof fx.writeArtifact !== 'function' || typeof fx.runGate !== 'function') {
        throw new Error('no gate effects');
      }
      const artifactPath = String(await Promise.resolve(fx.writeArtifact(text)));
      const raw = await Promise.resolve(fx.runGate({ gateCmd: o.gateCmd, artifactPath, text }));
      return normalizeGateOutcome(raw);
    } catch {
      return { score: [0, 1], fails: ['<gate-error>'] };
    }
  };

  /**
   * Build + gate one candidate for the state machine. A generate failure yields the sentinel
   * candidate (score [-1,1]) — it consumes budget, seeds nothing a real result can't beat, and is
   * never sent to the gate.
   */
  const performBuild = async (
    action: string,
    model: string,
    prompt: string,
    temperature: number,
    target?: string
  ): Promise<{ model: string; text: string; score: Score; fails: string[] }> => {
    const g = await generateOnce(model, prompt, temperature);
    if (!g.ok) {
      log.push({ at: now(), action, model, target, ok: false, note: g.note });
      return { model, text: '', score: [-1, 1], fails: [CALL_FAILED_CHECK] };
    }
    const gr = await gateOnce(g.text);
    log.push({ at: now(), action, model, target, ok: true, score: gr.score, fails: gr.fails });
    return { model, text: g.text, score: gr.score, fails: gr.fails };
  };

  let state = gateClimb.createClimbState({ cheap: cfg.cheap, ladder: cfg.ladder, budget: cfg.budget, seedN: cfg.seedN });

  // Progress is guaranteed (every non-stop step consumes >= 1 budget call), so this terminates;
  // the iteration cap is a pure belt-and-braces guard.
  for (let guard = 0; guard < 10000; guard++) {
    const step = gateClimb.nextStep(state);
    if (step.action === 'stop') {
      stopReason = step.reason;
      log.push({ at: now(), action: 'stop', ok: true, note: step.reason });
      break;
    }
    if (step.action === 'probe') {
      const res = await performBuild('probe', step.model, buildProbePrompt(spec), BUILD_TEMPERATURE);
      state = gateClimb.applyResult(state, step, res);
    } else if (step.action === 'ensemble') {
      // Sequential on purpose: determinism beats parallelism here.
      const results = [];
      for (const model of step.models) {
        results.push(await performBuild('ensemble', model, buildProbePrompt(spec), BUILD_TEMPERATURE));
      }
      state = gateClimb.applyResult(state, step, results);
    } else if (step.action === 'surgical') {
      if (step.tier === 'escalate') escalated = true;
      const bestText = state.best && typeof state.best.text === 'string' ? state.best.text : '';
      const prompt = buildSurgicalPrompt(spec, bestText, step.target, step.others);
      const res = await performBuild('surgical', step.model, prompt, BUILD_TEMPERATURE, step.target);
      state = gateClimb.applyResult(state, step, res);
    } else if (step.action === 'consolidate') {
      const prompt = buildConsolidationPrompt(spec, step.fails);
      const res = await performBuild('consolidate', step.model, prompt, CONSOLIDATE_TEMPERATURE);
      state = gateClimb.applyResult(state, step, res);
    } else {
      break; // unreachable with a well-formed state machine
    }
  }

  const best = state.best;
  let finalText = best && typeof best.text === 'string' ? best.text : '';
  let score: Score = best && Array.isArray(best.score) ? [best.score[0], best.score[1]] : [0, 1];
  if (score[0] < 0) score = [0, score[1]]; // sentinel-only run: report a plain fail-closed score
  let fails = best ? checkIds(best.fails) : [];
  const solved = stopReason === 'green';

  // Post-green QUAL-01 hook: polish, RE-GATE, keep only the non-regressive still-green result.
  if (solved && typeof fx.polish === 'function' && finalText !== '') {
    try {
      const polished = await Promise.resolve(fx.polish(finalText));
      if (typeof polished === 'string' && polished !== '' && polished !== finalText) {
        const g = await gateOnce(polished);
        const decision = qualityPipeline.decideKeep({ gateBefore: score[0], gateAfter: g.score[0] });
        const keep = decision.keep === true && g.score[0] >= score[0] && g.fails.length === 0;
        log.push({
          at: now(),
          action: 'polish',
          ok: keep,
          score: g.score,
          fails: g.fails,
          note: keep ? 'polish-kept' : `polish-reverted: ${decision.reason}`,
        });
        if (keep) {
          finalText = polished;
          score = g.score;
          fails = g.fails;
        }
      }
    } catch (e) {
      log.push({ at: now(), action: 'polish', ok: false, note: `polish-error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return {
    solved,
    score,
    fails,
    roundsUsed: state.calls,
    escalated,
    stopReason,
    finalText,
    log,
    costUsd,
  };
}

type ChatFn = (args: {
  baseUrl: string;
  keyEnv: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  timeoutMs?: number;
}) => Promise<{ text: string; model?: string }>;

/**
 * The thin real-effects factory. `generate` adapts to the repo's awaitable OpenAI-compatible chat
 * surface (openai-client — the transport resolveModelBackend picks when provider='flux'; the model
 * ids in config.cheap/ladder come from the caller's tier_models resolution). `chat` is injectable
 * so every path is stub-testable with zero network. runGate drives the canonical gate-runner.
 */
function createDefaultEffects(opts?: {
  baseUrl?: unknown;
  keyEnv?: unknown;
  scratchDir?: unknown;
  gateTimeoutMs?: unknown;
  chat?: unknown;
}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl : '';
  const keyEnv = typeof o.keyEnv === 'string' ? o.keyEnv : '';
  const gateTimeoutMs =
    typeof o.gateTimeoutMs === 'number' && Number.isFinite(o.gateTimeoutMs) && o.gateTimeoutMs > 0
      ? o.gateTimeoutMs
      : undefined;
  const chat: ChatFn = typeof o.chat === 'function' ? (o.chat as ChatFn) : openaiClient.chatCompletion;
  let scratch = typeof o.scratchDir === 'string' && o.scratchDir !== '' ? o.scratchDir : '';
  let counter = 0;

  const ensureScratch = (): string => {
    if (scratch === '') {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-first-'));
    } else {
      fs.mkdirSync(scratch, { recursive: true });
    }
    return scratch;
  };

  return {
    generate: async (a: GenerateArgs) => {
      const res = await chat({
        baseUrl,
        keyEnv,
        model: a.model,
        messages: [
          { role: 'system', content: a.system },
          { role: 'user', content: a.prompt },
        ],
        temperature: a.temperature,
        timeoutMs: a.timeoutMs,
      });
      return { text: res && typeof res.text === 'string' ? res.text : '' };
    },
    runGate: (a: { gateCmd?: unknown; artifactPath?: unknown }) =>
      gateRunner.runGate({
        gateCmd: (a && (a.gateCmd as string | string[])) || undefined,
        artifactPath: a && typeof a.artifactPath === 'string' ? a.artifactPath : undefined,
        timeoutMs: gateTimeoutMs,
      }),
    writeArtifact: (text: string) => {
      const dir = ensureScratch();
      counter += 1;
      const p = path.join(dir, `artifact-${counter}.txt`);
      fs.writeFileSync(p, typeof text === 'string' ? text : '');
      return p;
    },
    now: () => Date.now(),
  };
}

export = {
  runGateFirst,
  createDefaultEffects,
  extractArtifact,
  buildProbePrompt,
  buildSurgicalPrompt,
  buildConsolidationPrompt,
};
