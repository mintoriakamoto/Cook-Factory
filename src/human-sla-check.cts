/**
 * HALT-03 human-sla.check core (D-02, D-03, D-04).
 *
 * The human-SLA timer: given a checkpoint's open timestamp and an explicit now,
 * return `within` or `breached` against halting.human_sla_seconds. On breach the
 * increment is PARKED — an observable state transition written to an injectable
 * park-state file — and the event is logged. Per D-04 the enforceable core is
 * exactly this (breach fires + increment parks); pulling the next queued
 * increment forward is documented protocol (Plan 07), not claimed here.
 *
 * Deterministic-time invariant: no Date.now. openedMs / nowMs / slaSeconds /
 * nowIso are all explicit inputs; the park `ts` and run-log `ts` are the
 * caller's nowIso verbatim.
 *
 * ADR-457 build-at-publish: compiles to the gitignored artifact
 * ferrox-core/bin/lib/human-sla-check.cjs. `export =` CJS shape; no stdout.
 */

import fs from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import haltingLog = require('./halting-log.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import atomicState = require('./atomic-state.cjs');

/** Inputs to a single human-SLA check. */
interface HumanSlaInput {
  /** The increment whose human checkpoint is being timed. */
  increment: string;
  /** Checkpoint open timestamp in epoch ms (explicit — never a clock read). */
  openedMs: number;
  /** Current timestamp in epoch ms (explicit — never a clock read). */
  nowMs: number;
  /** Resolved halting.human_sla_seconds budget. */
  slaSeconds: number;
  /** Caller-supplied ISO timestamp, recorded verbatim on breach. */
  nowIso: string;
}

/** Injectable file locations — both explicit. */
interface HumanSlaOptions {
  parkPath: string;
  logPath: string;
}

/** The SLA decision plus the elapsed/budget it was measured against. */
interface HumanSlaResult {
  decision: 'within' | 'breached';
  elapsed_seconds: number;
  sla_seconds: number;
}

/** One observable park transition. */
interface ParkRecord {
  increment: string;
  status: 'parked';
  reason: 'human-sla-breach';
  ts: string;
}

/** Whole park file: a map of increment id -> its park record. */
type ParkState = Record<string, ParkRecord>;

/** Read the park map; a missing/blank file yields an empty map (no throw). */
function readParkState(parkPath: string): ParkState {
  if (!fs.existsSync(parkPath)) return {};
  const raw = fs.readFileSync(parkPath, 'utf8').trim();
  if (raw === '') return {};
  return JSON.parse(raw) as ParkState;
}

/**
 * Persist the park map atomically (temp file + rename). NOTE: the breach path in
 * runHumanSlaCheck performs its read-modify-write under the atomic-state file
 * lock; this helper only guarantees the write itself is crash-safe.
 */
function writeParkState(parkPath: string, state: ParkState): void {
  atomicState.atomicWriteFileSync(parkPath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Evaluate one human-SLA checkpoint. On breach (elapsed >= slaSeconds) the
 * increment is parked as an observable state transition and a single run-log
 * entry is appended (the T-03-08 repudiation mitigation: a breach never happens
 * without both a park record and a log line). The within path is a clean no-op:
 * no park record, no log entry.
 */
function runHumanSlaCheck(input: HumanSlaInput, opts: HumanSlaOptions): HumanSlaResult {
  const { increment, openedMs, nowMs, slaSeconds, nowIso } = input;
  const elapsedSeconds = (nowMs - openedMs) / 1000;

  if (elapsedSeconds >= slaSeconds) {
    // MEDIUM-4: the read-modify-write of the park map runs inside an exclusive
    // file lock so concurrent breaches can't lose a park record (temp + rename
    // makes the write itself atomic).
    atomicState.updateJsonFileAtomic<null>(opts.parkPath, (currentRaw: unknown) => {
      const state: ParkState =
        (currentRaw && typeof currentRaw === 'object' && !Array.isArray(currentRaw))
          ? (currentRaw as ParkState)
          : {};
      state[increment] = {
        increment,
        status: 'parked',
        reason: 'human-sla-breach',
        ts: nowIso,
      };
      return { next: state, result: null, changed: true };
    });

    haltingLog.appendHaltingLog(
      {
        ts: nowIso,
        gate: 'human-sla',
        trigger: 'human-sla',
        cap_outcome: 'escalate-to-human',
        increment,
      },
      { path: opts.logPath },
    );

    return { decision: 'breached', elapsed_seconds: elapsedSeconds, sla_seconds: slaSeconds };
  }

  return { decision: 'within', elapsed_seconds: elapsedSeconds, sla_seconds: slaSeconds };
}

export = { runHumanSlaCheck, readParkState, writeParkState };
