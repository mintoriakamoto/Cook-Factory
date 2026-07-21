/**
 * MEM-02 recall + capture — thin, deterministic layers over the Plan 02
 * bi-temporal fact store (memory-fact.cjs).
 *
 * `recall(subject, nowTs, limit)` returns the prior decisions/patterns for a
 * subject that are valid-now (delegates valid-now selection to memory-fact
 * getValidAt's half-open window), keeping only facts whose predicate is in the
 * decision/pattern set (matched CASE-INSENSITIVELY — the CONTEXT case-sensitivity
 * trap), most-recent (`recorded_at` desc) first, truncated to `limit`.
 *
 * `capture(...)` writes a decision/surprise fact and is SUPERSEDE-BY-DEFAULT:
 * every capture first closes any open same-subject+predicate prior, THEN appends
 * the new fact — both in ONE atomic memory-fact.supersedeAndAddFact transaction —
 * so recall can never return two valid-now facts for one subject+predicate (H-1).
 * The `--contradicts` flag is preserved for caller intent/API stability but is now
 * semantically moot (the default already supersedes). Every mutation delegates to
 * memory-fact so the retain-don't-delete invariant cannot be bypassed here.
 *
 * `limit` and `predicates` are EXPLICIT inputs (the Plan 04 router passes
 * memory.recall_limit) — the core reads no config, git, or clock; all timestamps
 * are explicit (no Date.now).
 *
 * ADR-457 build-at-publish: this TS source compiles to the gitignored artifact
 * ferrox-core/bin/lib/memory-recall-capture.cjs. `export =` CJS shape; no stdout.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import memoryFact = require('./memory-fact.cjs');

/** The default decision/pattern predicate set recall filters on (lower-case). */
const DECISION_PREDICATES = ['decided', 'chose', 'pattern', 'prefers'];

interface Fact {
  subject: string;
  predicate: string;
  object: string;
  valid_from: number;
  valid_to: number | null;
  confidence: number;
  recorded_at: number;
}

/**
 * Return the prior decisions/patterns for `subject` valid at `nowTs`, filtered to
 * the (lower-cased) predicate set, most-recent first, truncated to `limit`.
 * Read-only.
 */
function recall(opts: {
  statePath: string;
  subject: string;
  nowTs: number;
  limit: number;
  predicates?: string[];
}): Fact[] {
  const predSet = new Set(
    (opts.predicates ?? DECISION_PREDICATES).map((p) => String(p).toLowerCase()),
  );
  const validNow: Fact[] = memoryFact.getValidAt({
    statePath: opts.statePath,
    ts: opts.nowTs,
    subject: opts.subject,
  });
  return validNow
    .filter((f) => predSet.has(String(f.predicate).toLowerCase()))
    .sort((a, b) => b.recorded_at - a.recorded_at)
    .slice(0, opts.limit);
}

/**
 * Write a decision/surprise fact, SUPERSEDE-BY-DEFAULT. Closes every open prior
 * for this subject+predicate (valid_to = validFrom — retain, never delete) AND
 * appends the new fact inside ONE atomic memory-fact.supersedeAndAddFact write, so
 * recall never returns two valid-now facts for one subject+predicate and no
 * transient empty-recall window is observable (H-1b/H-1c).
 *
 * `contradicts` is accepted for API stability / caller intent but no longer
 * changes behavior — supersession is unconditional now. Returns the added fact.
 * MUTATION (delegated to memory-fact's atomic write).
 */
function capture(opts: {
  statePath: string;
  subject: string;
  predicate: string;
  object: string;
  recordedAt: number;
  validFrom: number;
  confidence?: number;
  contradicts?: boolean;
}): Fact {
  return memoryFact.supersedeAndAddFact({
    statePath: opts.statePath,
    subject: opts.subject,
    predicate: opts.predicate,
    object: opts.object,
    validFrom: opts.validFrom,
    recordedAt: opts.recordedAt,
    confidence: opts.confidence,
  });
}

export = { recall, capture, DECISION_PREDICATES };
