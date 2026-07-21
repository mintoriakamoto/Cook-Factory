/**
 * COORD-02 coord.ownership-check core.
 *
 * The post-plan wave guard. Given the files a plan DECLARED it would modify
 * (its `files_modified`) and the files it ACTUALLY touched, it decides whether
 * the plan stayed inside its declared footprint. An actual write not present in
 * the declared set is a HARD `wave-invalidating` signal — never a swallowed
 * warning — because an undeclared write means the wave scheduler reasoned about
 * the wrong file set and any parallel sibling may now be corrupt (threat
 * T-04-04, mitigate).
 *
 * The core takes the ACTUAL touched set as an EXPLICIT input — there is NO
 * hidden git call in the tested path, so every decision is deterministic. A CLI
 * convenience wrapper (Plan 05 router) may derive `actual` from `git diff`, but
 * the decision core never reaches for the clock or the repo.
 *
 * Paths are normalized (leading ./ stripped, `\` separators -> `/`) before the
 * subset comparison, so 'a.ts', './a.ts', and 'a\\b.ts' cannot be used to spell
 * a declared path differently and dodge the check.
 *
 * Deterministic-time invariant: no Date.now. The run-log `ts` is the caller's
 * explicit nowIso, recorded verbatim.
 *
 * ADR-457 build-at-publish: this TS source compiles to the gitignored artifact
 * ferrox-core/bin/lib/coord-ownership-check.cjs. CJS module shape (`export =`)
 * matches the gate-cap / rescope-check module style. The module owns NO stdout —
 * the router (Plan 05) owns CLI output; here we only decide and (on a fired
 * wave-invalidating) log one evidence entry.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import haltingLog = require('./halting-log.cjs');

/** Pure inputs to the ownership decision — declared vs actual file sets. */
interface OwnershipInput {
  /** Paths the plan declared it would modify (files_modified). */
  declared: string[];
  /** Paths the plan actually touched (explicit — never a hidden git call here). */
  actual: string[];
}

/** The ownership decision plus the list of undeclared writes (normalized). */
interface OwnershipResult {
  /** 'ok' when actual ⊆ declared, else 'wave-invalidating' (a hard signal). */
  decision: 'ok' | 'wave-invalidating';
  /** The normalized actual paths absent from the declared set (in encounter order). */
  undeclared: string[];
}

/** Options for the logging wrapper — an explicit log file + the increment id. */
interface RunOwnershipOptions {
  logPath: string;
  increment: string;
}

/** The wrapper input carries the decision inputs plus the caller ts. */
interface RunOwnershipInput extends OwnershipInput {
  /** Caller-supplied ISO timestamp, recorded verbatim as the run-log `ts`. */
  nowIso: string;
}

/**
 * Normalize a path for the subset comparison: `\` -> `/`, then strip any leading
 * `./` segments. So './src/a.ts', 'src/a.ts', and 'src\\a.ts' all collapse to
 * the same canonical 'src/a.ts'.
 */
function normalizePath(p: string): string {
  let s = String(p).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * PURE ownership decision. undeclared = the normalized actual paths not present
 * in the normalized declared set (deduplicated, in first-encounter order). The
 * decision is 'wave-invalidating' when undeclared is non-empty (a HARD signal),
 * else 'ok'. No fs, no clock.
 */
function evaluateOwnership(input: OwnershipInput): OwnershipResult {
  const declaredSet = new Set((input.declared ?? []).map(normalizePath));
  const undeclared: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.actual ?? []) {
    const norm = normalizePath(raw);
    if (!declaredSet.has(norm) && !seen.has(norm)) {
      seen.add(norm);
      undeclared.push(norm);
    }
  }
  return {
    decision: undeclared.length > 0 ? 'wave-invalidating' : 'ok',
    undeclared,
  };
}

/**
 * Thin logging wrapper. Runs the pure decision, and on 'wave-invalidating'
 * appends EXACTLY ONE run-log entry to the shared JSONL evidence surface
 * (gate:'coord-ownership', trigger:'undeclared-write', the undeclared list, and
 * the caller's nowIso verbatim as `ts`). The 'ok' path appends nothing. This is
 * the COORD-02 observability guarantee: an undeclared write can never be
 * invalidated silently (threat T-04-04).
 */
function runOwnershipCheck(input: RunOwnershipInput, opts: RunOwnershipOptions): OwnershipResult {
  const result = evaluateOwnership(input);
  if (result.decision === 'wave-invalidating') {
    haltingLog.appendHaltingLog(
      {
        ts: input.nowIso,
        gate: 'coord-ownership',
        trigger: 'undeclared-write',
        cap_outcome: 'wave-invalidating',
        increment: opts.increment,
        undeclared: result.undeclared,
      },
      { path: opts.logPath },
    );
  }
  return result;
}

export = { evaluateOwnership, runOwnershipCheck, normalizePath };
