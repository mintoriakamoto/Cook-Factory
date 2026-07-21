/**
 * Append-only halting run-log (D-03).
 *
 * The single evidence surface every Phase-3 cap verb writes to when a gate
 * fires: `.planning/halting-log.jsonl`, one JSON object per line. Phase 5
 * receipts and Phase 8 DOG-02 read this log to prove WHICH trigger halted a
 * loop (pass-cap vs wall-clock) and to what cap_outcome.
 *
 * Two hard invariants (see tests/halting-log.test.cjs):
 *   1. Append-only. Writes use fs.appendFileSync — the log is never truncated
 *      or rewritten, so a fired-gate record can never be silently dropped
 *      (threat T-03-01, mitigate).
 *   2. Caller-supplied timestamps. The module NEVER reads the wall clock; the
 *      entry's `ts` is whatever the cap verb passes through (its explicit
 *      --now-ts). This keeps every cap-verb test deterministic.
 *
 * ADR-457 build-at-publish: this TS source compiles to the gitignored artifact
 * ferrox-core/bin/lib/halting-log.cjs. CJS module shape (`export =`) matches the
 * existing lock-module style (see eval.cts / config-schema.cts).
 */

import fs from 'node:fs';
import path from 'node:path';

/** One append-only halting run-log record. */
interface HaltingLogEntry {
  /** Caller-supplied timestamp (ISO string or epoch ms) — never read here. */
  ts: string | number;
  /** Gate id that fired (e.g. "plan-check", "wave-audit"). */
  gate: string;
  /** Which trigger fired the cap: "pass-cap" | "wall-clock" (or verb-specific). */
  trigger: string;
  /** The terminal cap-outcome the gate resolved to. */
  cap_outcome: string;
  /** The increment the gate was guarding. */
  increment: string;
  /** Cap verbs may attach extra provenance fields. */
  [k: string]: unknown;
}

/** Options for read/append — `path` targets an explicit log file. */
interface HaltingLogOptions {
  path?: string;
}

/**
 * Resolve the canonical run-log path for a project: <cwd>/.planning/halting-log.jsonl.
 */
function haltingLogPath(cwd: string): string {
  return path.join(cwd, '.planning', 'halting-log.jsonl');
}

/**
 * Append exactly one JSONL record to the log, creating the file (and any
 * missing parent directory) if absent. Append mode only — the existing content
 * is preserved verbatim; this function never truncates or overwrites.
 */
function appendHaltingLog(entry: HaltingLogEntry, opts: HaltingLogOptions = {}): void {
  const target = opts.path;
  if (typeof target !== 'string' || target === '') {
    throw new Error('appendHaltingLog: opts.path is required');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, JSON.stringify(entry) + '\n');
}

/**
 * Read the log in append order. A missing file returns [] (not a throw).
 * Blank / whitespace-only lines are skipped so a trailing newline never yields
 * a phantom entry.
 */
function readHaltingLog(opts: HaltingLogOptions = {}): HaltingLogEntry[] {
  const target = opts.path;
  if (typeof target !== 'string' || target === '') {
    throw new Error('readHaltingLog: opts.path is required');
  }
  if (!fs.existsSync(target)) return [];
  const raw = fs.readFileSync(target, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as HaltingLogEntry);
}

export = { appendHaltingLog, readHaltingLog, haltingLogPath };
