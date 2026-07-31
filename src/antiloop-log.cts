/**
 * Append-only anti-loop event log (phase 15, D6).
 *
 * The single evidence surface every anti-loop verb writes to:
 * `.planning/antiloop-log.jsonl`, one JSON object per line. Every review budget
 * and every round counter in the system is DERIVED by folding this file
 * (`src/antiloop-gate.cts`), never hand maintained. A counter stored as a
 * mutable number is a current-state claim, and this milestone exists because
 * those rot.
 *
 * WHY THIS EXISTS: on 2026-07-25 all 4 anti-loop mechanisms in this repo were
 * prose, and they failed to stop a live loop. The plans converged 4 to 1 to 0
 * blockers, 3 more reviewer lineages were then added, the count went back above
 * 20, and a re-plan was proposed. The counter reset because it was scoped to the
 * gate instance rather than to the question being asked. D4 states the
 * consequence: a rule an agent can read and then not follow is not a mechanism.
 * The log is the state, so the state cannot be argued with.
 *
 * TWO HARD INVARIANTS (see tests/antiloop-gate.test.cjs):
 *   1. Append-only. Writes go through fs.appendFileSync. The log is never
 *      truncated or rewritten, so a recorded round can never be silently
 *      dropped (threat T-15-01, mitigate).
 *   2. Caller-supplied timestamps. This module NEVER reads the wall clock; an
 *      entry's `ts` is whatever the caller passes through. That is what makes
 *      the phase 15 mutation battery deterministic.
 *
 * ONE DELIBERATE DEPARTURE FROM THE ANALOG `src/halting-log.cts`. There, a line
 * that will not parse is silently skipped, which is defensible because that log
 * is write-on-fire evidence and dropping a corrupt line loses 1 record. Here it
 * is not defensible. This log IS the state: every counter and every budget is
 * derived from it, so silently skipping a line LOWERS a derived round count.
 * That is the exact counter-reset defect this phase exists to close, arriving
 * through the back door. An unparseable line therefore THROWS, naming the
 * 1-based line number and the log path so the repair is obvious.
 *
 * Line splitting uses the carriage-return-tolerant pattern. `local/no-crlf-fragile-split`
 * rejects the bare newline literal over a readFileSync result, and
 * `src/halting-log.cts:80` is a pre-rule file that must not be copied here.
 *
 * ADR-457 build-at-publish: this TS source compiles to the artifact
 * ferrox-core/bin/lib/antiloop-log.cjs, which is TRACKED and committed (see the
 * phase 14.1 governance-manifest precedent). CJS module shape (`export =`)
 * matches the halting-log / gate-cap module style. The module owns NO stdout.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * One append-only anti-loop event record.
 *
 * `artifact` and `question` are the counter key (see counterKey in
 * `src/antiloop-gate.cts`). `gate` and `lineage`, when present, are PROVENANCE
 * only: they let a human see which gate and which reviewer produced a round,
 * and they are structurally unable to reach the key.
 *
 * The open index signature is copied from `src/halting-log.cts:37`: each event
 * kind supplies its own fields without a new interface per kind.
 */
interface AntiloopLogEntry {
  /** Caller-supplied timestamp (ISO string or epoch ms). Never read here. */
  ts: string | number;
  /** Event kind: budget-declared | round-opened | round-closed | finding-filed. */
  kind: string;
  /** The artifact under review, half of the counter key. */
  artifact?: string;
  /** The question being asked of it, the other half of the counter key. */
  question?: string;
  /** Each event kind attaches its own fields and its own provenance. */
  [k: string]: unknown;
}

/** Options for read/append. `path` targets an explicit log file. */
interface AntiloopLogOptions {
  path?: string;
}

/**
 * Resolve the canonical event-log path for a project:
 * <cwd>/.planning/antiloop-log.jsonl. Shape copied from
 * `src/halting-log.cts:47-51`.
 */
function antiloopLogPath(cwd: string): string {
  return path.join(cwd, '.planning', 'antiloop-log.jsonl');
}

/**
 * Append exactly 1 JSONL record, creating the file and any missing parent
 * directory. Append mode only: existing content is preserved verbatim and this
 * function never truncates or overwrites.
 */
function appendAntiloopEvent(entry: AntiloopLogEntry, opts: AntiloopLogOptions = {}): void {
  const target = opts.path;
  if (typeof target !== 'string' || target === '') {
    throw new Error('appendAntiloopEvent: opts.path is required');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, JSON.stringify(entry) + '\n');
}

/**
 * Read the log in append order. A missing file returns [] rather than throwing,
 * because a project that has never opened a gate has an empty history, not a
 * broken one.
 *
 * Blank and whitespace-only lines are skipped, so a trailing newline never
 * yields a phantom entry. A line that will not parse THROWS, naming the 1-based
 * line number and the path. See the departure note in the header: a silent skip
 * here would lower a derived counter.
 */
function readAntiloopLog(opts: AntiloopLogOptions = {}): AntiloopLogEntry[] {
  const target = opts.path;
  if (typeof target !== 'string' || target === '') {
    throw new Error('readAntiloopLog: opts.path is required');
  }
  if (!fs.existsSync(target)) return [];
  const raw = fs.readFileSync(target, 'utf8');
  const lines = raw.split(/\r?\n/);
  const entries: AntiloopLogEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(
        `readAntiloopLog: line ${i + 1} of ${target} is not valid JSON. `
          + 'The fold derives every round count and every budget from this file, so a '
          + 'skipped line would silently lower a counter. Repair that line by hand, then re-run.',
      );
    }
    entries.push(parsed as AntiloopLogEntry);
  }
  return entries;
}

export = { antiloopLogPath, appendAntiloopEvent, readAntiloopLog };
