/**
 * HALT-04 ship-clock.check core (D-02, D-03) — the first tooth of the Ship Clock.
 *
 * Measures wall-clock since the last coverage-advancing merge against
 * halting.ship_clock_seconds. RED signals autonomous descope-and-merge of the
 * already-passing subset, so a shippable, coverage-advancing increment lands
 * every session. Per D-04 the acceptance target is exactly this testable core
 * (RED fires + is logged); the "descope to the passing subset" routine is
 * documented protocol (Plan 07), not claimed here.
 *
 * Deterministic-time invariant: no Date.now. lastMergeMs / nowMs / budgetSeconds
 * / nowIso are explicit inputs; the run-log `ts` is the caller's nowIso verbatim.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/ship-clock-check.cjs. `export =` CJS shape; no stdout.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import haltingLog = require('./halting-log.cjs');

/** Inputs to a single ship-clock check. */
interface ShipClockInput {
  /** The increment the ship clock is guarding. */
  increment: string;
  /** Timestamp of the last coverage-advancing merge in epoch ms (explicit). */
  lastMergeMs: number;
  /** Current timestamp in epoch ms (explicit — never a clock read). */
  nowMs: number;
  /** Resolved halting.ship_clock_seconds budget. */
  budgetSeconds: number;
  /** Caller-supplied ISO timestamp, recorded verbatim on RED. */
  nowIso: string;
}

/** Injectable log location. */
interface ShipClockOptions {
  logPath: string;
}

/** The ship-clock decision plus the elapsed/budget it was measured against. */
interface ShipClockResult {
  decision: 'RED' | 'green';
  elapsed_seconds: number;
  budget_seconds: number;
}

/**
 * Evaluate the ship clock. On RED (elapsed >= budgetSeconds) a single run-log
 * entry naming the ship-clock trigger is appended (the T-03-10 repudiation
 * mitigation: RED never fires without evidence). The green path appends nothing.
 */
function runShipClockCheck(input: ShipClockInput, opts: ShipClockOptions): ShipClockResult {
  const { increment, lastMergeMs, nowMs, budgetSeconds, nowIso } = input;
  const elapsedSeconds = (nowMs - lastMergeMs) / 1000;

  if (elapsedSeconds >= budgetSeconds) {
    haltingLog.appendHaltingLog(
      {
        ts: nowIso,
        gate: 'ship-clock',
        trigger: 'ship-clock',
        cap_outcome: 'stop-and-rescope',
        increment,
      },
      { path: opts.logPath },
    );
    return { decision: 'RED', elapsed_seconds: elapsedSeconds, budget_seconds: budgetSeconds };
  }

  return { decision: 'green', elapsed_seconds: elapsedSeconds, budget_seconds: budgetSeconds };
}

export = { runShipClockCheck };
