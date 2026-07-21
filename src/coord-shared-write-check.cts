/**
 * COORD-05 coord.shared-write-check core.
 *
 * The sole-writer guard for shared planning state. The orchestrator is the ONLY
 * actor permitted to write STATE.md / ROADMAP.md / BACKLOG.md; executors emit
 * changes to it and never write shared state directly. Given an actor role and a
 * target path, this returns `forbidden` when a non-orchestrator actor targets a
 * shared path, else `allowed`.
 *
 * This is the detection verb behind that documented rule (the un-bypassable
 * enforced version is the Phase-5 strength-gate story, FF-B10); it makes the
 * check REAL and consultable now.
 *
 * The matcher is the same anchored, dependency-free glob->RegExp approach as the
 * hot-seam core (no package dependency, threat T-04-SC): `**` spans segments,
 * `*` stays within one segment, everything anchored `^...$`. So a basename glob
 * (a double-star-slash before STATE.md) forbids a NESTED 'sub/STATE.md' too — a
 * path prefix cannot smuggle a shared write through (threat T-04-10).
 *
 * Only the LITERAL 'orchestrator' actor is the sole writer; any other role
 * (including near-misses) is treated as non-orchestrator (threat T-04-11). Both
 * `sharedPaths` and `actor` are EXPLICIT inputs — no config/git/clock here; the
 * Plan 05 router resolves coordination.shared_state_paths and passes them in.
 *
 * ADR-457 build-at-publish: this TS source compiles to the gitignored artifact
 * ferrox-core/bin/lib/coord-shared-write-check.cjs. `export =` CJS shape; no
 * stdout.
 */

/** Pure inputs to the shared-write decision. */
interface SharedWriteInput {
  /** The acting role. Only the literal 'orchestrator' is the sole writer. */
  actor: string;
  /** The path the actor wants to write. */
  targetPath: string;
  /** Resolved coordination.shared_state_paths glob patterns (explicit). */
  sharedPaths: string[];
}

/** The shared-write decision plus the matched shared pattern (when forbidden). */
interface SharedWriteResult {
  /** 'forbidden' for a non-orchestrator write to a shared path, else 'allowed'. */
  decision: 'forbidden' | 'allowed';
  /** The shared pattern that matched (only set on 'forbidden'), else null. */
  matched: string | null;
}

/** Regex metacharacters that must be escaped when translated literally. */
const REGEX_META = new Set('\\^$.|?+()[]{}'.split(''));

/**
 * Translate a shared-path glob to an ANCHORED RegExp. A double-star-slash means
 * zero-or-more whole path segments; a bare double-star means any characters
 * including separators; a single star means any characters within one segment.
 * Returns an anchored `^...$` RegExp so only a full-string match counts.
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (REGEX_META.has(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  // Case-INSENSITIVE (`i`): the dev/target filesystems are case-insensitive
  // (APFS on macOS, NTFS on Windows), so '.planning/state.md' and
  // '.planning/STATE.MD' resolve to the same shared file. A case-sensitive
  // matcher would let a non-orchestrator smuggle a shared write through by
  // varying case (Fix 1, extends threat T-04-10).
  return new RegExp('^' + re + '$', 'i');
}

/**
 * Normalize a path before matching: `\` separators -> `/`, then strip any
 * leading `./` so 'a/STATE.md', './a/STATE.md', and 'a\\STATE.md' compare equal.
 */
function normalizePath(p: string): string {
  let s = String(p).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * PURE shared-write decision. The orchestrator (exact match) is always allowed —
 * it is the sole writer. Any other actor is forbidden from writing a path that
 * matches any sharedPaths entry (the FIRST matching pattern is returned); a
 * non-shared path is allowed. No fs, no clock.
 */
function evaluateSharedWrite(input: SharedWriteInput): SharedWriteResult {
  if (input.actor === 'orchestrator') {
    return { decision: 'allowed', matched: null };
  }
  const norm = normalizePath(input.targetPath);
  for (const pattern of input.sharedPaths ?? []) {
    if (globToRegExp(pattern).test(norm)) {
      return { decision: 'forbidden', matched: pattern };
    }
  }
  return { decision: 'allowed', matched: null };
}

export = { evaluateSharedWrite, globToRegExp, normalizePath };
