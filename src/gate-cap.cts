/**
 * HALT-01 gate.cap-check core (D-02, D-03).
 *
 * The single source of truth for "max N passes" across the delivery line. Given
 * a gate id, its current pass count, and a start/now timestamp pair, it decides
 * `continue` vs the gate's resolved cap_outcome and records WHICH cap fired:
 *   - pass-cap:   passes >= maxPasses.
 *   - wall-clock: elapsed = (nowMs - startMs)/1000 >= wallClockSeconds.
 * Whichever cap fires first forces termination, with evidence of which one.
 *
 * Deterministic-time invariant (plan-check W1): NO Date.now anywhere. All time
 * arrives as explicit startMs / nowMs numbers; the run-log `ts` is the caller's
 * nowIso, never a clock read — so every cap-verb test is reproducible.
 *
 * ADR-457 build-at-publish: this TS source compiles to the gitignored artifact
 * ferrox-core/bin/lib/gate-cap.cjs. CJS module shape (`export =`) matches the
 * halting-log / eval module style. The module owns NO stdout — the router
 * (Plan 06) owns CLI output; here we only decide and (on a fired cap) log.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import haltingLog = require('./halting-log.cjs');

/** A terminal cap-outcome the gate resolves to when a cap fires. */
type CapOutcome = 'ship-with-backlog' | 'stop-and-rescope' | 'escalate-to-human';

/** The three (and only) valid terminal cap-outcomes (D-01). */
const VALID_CAP_OUTCOMES: ReadonlySet<CapOutcome> = new Set<CapOutcome>([
  'ship-with-backlog',
  'stop-and-rescope',
  'escalate-to-human',
]);

/**
 * HIGH-3 fail-CLOSED normalization. A gate's cap_outcome MUST be one of the
 * three terminal outcomes. Any missing / out-of-enum / non-string value (incl.
 * the dangerous "continue", which would silently disable the cap) collapses to
 * the SAFE default `stop-and-rescope` — so a fired trigger can never resolve to
 * a non-terminal "keep looping" state.
 */
function normalizeCapOutcome(capOutcome: unknown): CapOutcome {
  return (typeof capOutcome === 'string' && VALID_CAP_OUTCOMES.has(capOutcome as CapOutcome))
    ? (capOutcome as CapOutcome)
    : 'stop-and-rescope';
}

/** Which cap fired, or 'none' when the gate is still under both budgets. */
type GateTrigger = 'pass-cap' | 'wall-clock' | 'none';

/** Pure inputs to the cap decision — no fs, no clock. */
interface GateCapInput {
  /** Gate id being guarded (e.g. "plan-check"). */
  gate: string;
  /** Current pass count for this gate. */
  passes: number;
  /** Resolved max_passes budget. */
  maxPasses: number;
  /** Gate start timestamp in epoch ms (explicit — never a clock read). */
  startMs: number;
  /** Current timestamp in epoch ms (explicit — never a clock read). */
  nowMs: number;
  /** Resolved wall_clock_seconds budget. */
  wallClockSeconds: number;
  /** The gate's resolved cap_outcome. */
  capOutcome: CapOutcome;
}

/** The cap decision plus the trigger that produced it. */
interface GateCapResult {
  /** 'continue' when under both caps, otherwise the gate's cap_outcome. */
  decision: 'continue' | CapOutcome;
  /** Which cap fired: 'pass-cap' | 'wall-clock' | 'none'. */
  trigger: GateTrigger;
  /** Echoed gate id. */
  gate: string;
  /** Echoed cap_outcome (the terminal outcome if a cap fires). */
  cap_outcome: CapOutcome;
}

/** Options for the logging wrapper — an explicit log file + the increment id. */
interface RunGateCapOptions {
  logPath: string;
  increment: string;
}

/** The wrapper input carries everything the pure decision needs plus the ts. */
interface RunGateCapInput extends GateCapInput {
  /** Caller-supplied ISO timestamp, recorded verbatim as the run-log `ts`. */
  nowIso: string;
}

/**
 * PURE cap decision. Pass-cap is evaluated first, so when BOTH caps are crossed
 * simultaneously the documented tie-break resolves to 'pass-cap' (the discrete
 * pass count is the more specific signal). No fs, no clock.
 */
function evaluateGateCap(input: GateCapInput): GateCapResult {
  const { gate, passes, maxPasses, startMs, nowMs, wallClockSeconds, capOutcome } = input;
  const elapsedSeconds = (nowMs - startMs) / 1000;

  // HIGH-3: resolve the cap_outcome fail-CLOSED. An invalid value must never let
  // a fired trigger slip through as 'continue' (or any non-terminal string).
  const safeCapOutcome = normalizeCapOutcome(capOutcome);

  let trigger: GateTrigger;
  if (passes >= maxPasses) {
    trigger = 'pass-cap';
  } else if (elapsedSeconds >= wallClockSeconds) {
    trigger = 'wall-clock';
  } else {
    trigger = 'none';
  }

  return {
    decision: trigger === 'none' ? 'continue' : safeCapOutcome,
    trigger,
    gate,
    cap_outcome: safeCapOutcome,
  };
}

/**
 * Thin logging wrapper. Runs the pure decision, and when a cap fires appends
 * exactly ONE run-log entry naming the exact trigger (the T-03-04 repudiation
 * mitigation: no gate fires without evidence). The continue path appends
 * nothing. The recorded `ts` is the caller's nowIso, never a clock read.
 */
function runGateCapCheck(input: RunGateCapInput, opts: RunGateCapOptions): GateCapResult {
  const result = evaluateGateCap(input);
  if (result.trigger !== 'none') {
    haltingLog.appendHaltingLog(
      {
        ts: input.nowIso,
        gate: result.gate,
        trigger: result.trigger,
        cap_outcome: result.cap_outcome,
        increment: opts.increment,
      },
      { path: opts.logPath },
    );
  }
  return result;
}

export = { evaluateGateCap, runGateCapCheck, normalizeCapOutcome, VALID_CAP_OUTCOMES };
