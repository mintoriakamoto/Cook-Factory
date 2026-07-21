/**
 * COORD-03 coord.hot-seam-check core.
 *
 * The pre-parallelization wave guard. Given a plan's `filesModified` and the
 * resolved hot-seam glob list (`coordination.hot_seams`, Plan 01), it decides
 * whether the wave may run in parallel. Any file matching any seam pattern —
 * lockfiles, migration dirs, schema files, DI/registry files, codegen output,
 * and the FF-B12 shared halting-state files — forces `serialize-global`: those
 * surfaces cannot be safely written by two parallel plans, so the wave must run
 * them serially. An ordinary source path yields `parallel-ok`.
 *
 * The matcher IS the tested COORD-03 logic — a small, dependency-free
 * glob-to-RegExp translator (the package has no glob dependency by design,
 * threat T-04-SC). The match is ANCHORED full-string so a seam path can never
 * slip past as parallel-ok by matching only a prefix/suffix (threat T-04-05):
 *   - a double-star followed by a slash -> zero-or-more whole path segments
 *     (so a leading double-star-slash also matches zero segments).
 *   - a bare double-star -> any characters, including path separators.
 *   - a single star -> any characters WITHIN one path segment (never crosses a
 *     slash).
 *   - all regex metacharacters are escaped; the rest is matched literally.
 *
 * Both `filesModified` and `seams` are EXPLICIT inputs — the core reaches for no
 * config, git, or clock, so every decision is deterministic. The Plan 05 router
 * resolves `seams` from the loaded config and passes them in.
 *
 * ADR-457 build-at-publish: this TS source compiles to the gitignored artifact
 * ferrox-core/bin/lib/coord-hot-seam-check.cjs. `export =` CJS shape; no stdout.
 */

/** Pure inputs to the hot-seam decision. */
interface HotSeamInput {
  /** Paths a plan declares it will modify (files_modified). */
  filesModified: string[];
  /** Resolved coordination.hot_seams glob patterns (explicit — never read here). */
  seams: string[];
}

/** The hot-seam decision plus the distinct seam patterns that matched. */
interface HotSeamResult {
  /** 'serialize-global' when any file matches any seam, else 'parallel-ok'. */
  decision: 'serialize-global' | 'parallel-ok';
  /** The distinct seam patterns that matched (in first-encounter order). */
  matched: string[];
}

/** Regex metacharacters that must be escaped when translated literally. */
const REGEX_META = new Set('\\^$.|?+()[]{}'.split(''));

/**
 * Translate a hot-seam glob to an ANCHORED RegExp. Scans the pattern left to
 * right so a double-star, a single star, and the double-star-slash segment form
 * are disambiguated explicitly. Returns an anchored `^...$` RegExp so only a
 * full-string match counts (no unanchored slip-past).
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // Double-star — a multi-segment wildcard.
        if (glob[i + 2] === '/') {
          // Double-star-slash: zero-or-more complete path segments.
          re += '(?:.*/)?';
          i += 3;
        } else {
          // Bare double-star: any characters, including path separators.
          re += '.*';
          i += 2;
        }
      } else {
        // Single star: any characters within ONE segment (never crosses a slash).
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
  // (APFS on macOS, NTFS on Windows), so 'App/Migrations/x.sql' and
  // 'app/migrations/x.sql' are the same file. A case-sensitive matcher would
  // let a real seam slip past as parallel-ok by varying case (Fix 1, T-04-05).
  return new RegExp('^' + re + '$', 'i');
}

/**
 * Normalize a path before matching: `\` separators -> `/`, then strip any
 * leading `./` so 'src/a.ts', './src/a.ts', and 'src\\a.ts' compare equal.
 */
function normalizePath(p: string): string {
  let s = String(p).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * PURE hot-seam decision. A file matches a seam when its normalized path fully
 * matches the seam's anchored RegExp. Collects the DISTINCT matched seam
 * patterns (first-encounter order). decision is 'serialize-global' when any
 * match exists, else 'parallel-ok'. An empty/unresolved registry fails SAFE to
 * 'serialize-global' (Fix 4). No fs, no clock, no config.
 */
function evaluateHotSeam(input: HotSeamInput): HotSeamResult {
  // Fail-SAFE (Phase-4 cross-audit Fix 4): an empty or unresolved registry
  // cannot prove a path is NOT a seam, so we over-serialize rather than let a
  // real seam parallelize. Better to serialize a wave that did not need it than
  // to parallelize two writers of a shared surface.
  const seams = input.seams ?? [];
  if (seams.length === 0) {
    return { decision: 'serialize-global', matched: [] };
  }
  const compiled = seams.map((seam) => ({ seam, re: globToRegExp(seam) }));
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.filesModified ?? []) {
    const norm = normalizePath(raw);
    for (const { seam, re } of compiled) {
      if (re.test(norm) && !seen.has(seam)) {
        seen.add(seam);
        matched.push(seam);
      }
    }
  }
  return {
    decision: matched.length > 0 ? 'serialize-global' : 'parallel-ok',
    matched,
  };
}

export = { evaluateHotSeam, globToRegExp, normalizePath };
