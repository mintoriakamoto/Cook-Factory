/**
 * workgraph: the `workgraph/v1` document contract and its pure core.
 *
 * PURE parser, resolver, classifier, orderer, assembler and validator for the
 * phase work graph (Phase 17, v1.14 Fleet Mode). Mirrors `roadmap-index.cts` in
 * shape: a vocabulary block, a result union carrying a code, explicit sorts that
 * never consult input order, an `## Honest gaps` block at the foot, and an
 * `export =` object literal.
 *
 * WHY THIS EXISTS: `.planning/MEASUREMENT-v1.14-PARALLELISM.md` replayed 10
 * phases and measured pooled true parallel width at 3.20. The dominant limiter
 * was not code coupling and not bookkeeping, it was DECLARED dependency edges
 * with nothing behind them: phases 02, 04 and 05 each named a config-block plan
 * as a prerequisite for cores that provably never imported config, and the
 * plans' own frontmatter admitted the values arrived as explicit router-supplied
 * inputs. That is worth about 0.6 of width per phase. So the highest value thing
 * this graph can do is tell a REAL edge from a DECLARED one, and say which
 * evidence backs it.
 *
 * HERMETIC BY CONTRACT (this is what makes the byte level tests real):
 *   - no filesystem module, no process spawning module, no clock, no network
 *   - callers pass source text, records and path sets in; this module reads
 *     nothing and resolves against an INJECTED set of existing paths
 *   - every emitted array is sorted EXPLICITLY, so a filesystem enumeration
 *     change upstream cannot alter the emitted bytes
 *   - `detectImpurity` below is the same property expressed as a predicate, and
 *     the test fires it at a synthetic source that DOES name a forbidden module
 *     before it fires it at this module's own build output
 *
 * FAIL LOUD: nothing here throws. A specifier that resolves to no file returns a
 * miss carrying the specifier text, and the caller records it. A scan that
 * quietly discards what it cannot resolve reports an empty import graph after a
 * rename and nobody notices.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/workgraph.cjs.
 */

// ─── the vocabulary ──────────────────────────────────────────────────────────

/** The shipped schema string. A document naming any other version is rejected. */
const SCHEMA_VERSION = 'workgraph/v1';

/** The 2 node kinds. A seam node schedules ahead of everything that needs it. */
const NODE_KINDS = ['plan', 'seam'] as const;

/** The 3 verdicts a declared edge can carry. */
const VERDICTS = ['backed', 'unbacked', 'unproven'] as const;

/**
 * The 3 reasons an edge can be unproven rather than unbacked.
 *
 * `dynamic-specifier-unresolved` was added by phase 25. `scanImports` cannot
 * follow `require(CONSTANT)`, and that form is idiomatic in `scripts/`, which
 * phase 25 also started reading for the first time. Without this reason a real
 * dependency carried by a dynamic specifier reads as `unbacked`, which is a
 * FALSE statement about the planner rather than an honest statement about the
 * scan. ABSENCE OF VISIBLE EVIDENCE IS NOT EVIDENCE OF ABSENCE, and UNKNOWN IS
 * NEVER 0.
 */
const UNPROVEN_REASONS = [
  'out-of-scan-scope',
  'endpoint-absent-from-disk',
  'dynamic-specifier-unresolved',
] as const;

/** The 4 import shapes this repository actually writes. */
const IMPORT_FORMS = ['import-equals', 'esm', 'side-effect', 'require'] as const;

/** The 4 extensions a specifier may resolve to, in candidate order. */
const SOURCE_EXTENSIONS = ['.cts', '.ts', '.cjs', '.js'] as const;

/** Compiled output extension to the TypeScript source extension it came from. */
const COMPILED_TO_SOURCE: Array<[string, string]> = [
  ['.cjs', '.cts'],
  ['.mjs', '.mts'],
  ['.js', '.ts'],
];

/** A file whose name carries this marker declares types and imports no values. */
const DECLARATION_MARKER = /\.d\.[cm]?ts$/;

/** Module ids this lib must never name, checked by `detectImpurity`. */
const FORBIDDEN_MODULE_IDS = [
  'fs',
  'fs/promises',
  'child_process',
  'worker_threads',
  'net',
  'http',
  'https',
];

/** Clock reads, written as patterns so this source never carries the literal. */
const CLOCK_SHAPES = [
  /\bDate\s*\.\s*now\s*\(/,
  /\bnew\s+Date\s*\(/,
  /\bperformance\s*\.\s*now\s*\(/,
  /\bprocess\s*\.\s*hrtime\b/,
];

// ─── the import shapes ───────────────────────────────────────────────────────
//
// Anchored forms first, then the unanchored require scan as the fallback. The
// rule is: recognize the 4 shapes this repo writes, name anything else dynamic,
// and never guess. A full expression parse is not attempted and is not needed.

const IMPORT_EQUALS_SHAPE = /^\s*import\s+[A-Za-z_$][\w$]*\s*=\s*require\(\s*(['"])([^'"]*)\1\s*\)/;
const ESM_FROM_SHAPE = /^\s*import\s+(type\s+)?[^;]*?\sfrom\s*(['"])([^'"]*)\2/;
const SIDE_EFFECT_SHAPE = /^\s*import\s*(['"])([^'"]*)\1\s*;?\s*$/;
const ESM_OPEN_SHAPE = /^\s*import\s+(type\s+)?\{[^}]*$/;
const ESM_CLOSE_SHAPE = /^\s*\}\s*from\s*(['"])([^'"]*)\1/;
const BARE_REQUIRE_SHAPE = /require\(\s*(['"])([^'"]*)\1\s*\)/g;

// ─── the closed grammar the constant folder reads ────────────────────────────
//
// Phase 27. `DYNAMIC_REQUIRE_SHAPE` used to be
// `/require\(\s*([A-Za-z_$][\w$.]*)\s*\)/g`, which demanded a closing paren
// DIRECTLY after the identifier. `require(path.join(LIB_DIR, 'x'))` has an
// opening paren there, so it matched neither that shape nor
// `BARE_REQUIRE_SHAPE` and the parser emitted NOTHING for it. A file whose only
// couplings use that idiom was never recorded as unfollowable, so nothing
// degraded and an edge resting on it could be adjudicated `unbacked`. That is a
// latent false accusation generator, and 82 sites in this tree write it.
//
// The replacement is a balanced paren scan rather than a wider regex, because
// the argument text is the input the folder needs and a regex cannot carry a
// nested call out intact.

const STRING_LITERAL_SHAPE = /^(['"])((?:[^'"\\]|\\.)*)\1$/;
const IDENTIFIER_SHAPE = /^[A-Za-z_$][\w$]*$/;
const PATH_CALL_SHAPE = /^path\s*\.\s*(join|resolve)\s*\(/;
/**
 * A whole-line `const` binding, semicolon REQUIRED. The semicolon is the guard
 * that keeps a continuation line out: `const A = B` followed by `.replace(...)`
 * on the next line would otherwise fold to whatever `B` folds to, which is a
 * confidently wrong answer rather than a refusal.
 */
const CONST_BINDING_SHAPE = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(.+);\s*$/;
/** A leading separator or a drive letter, both of which leave repo-relative space. */
const ABSOLUTE_SHAPE = /^(?:[/\\]|[A-Za-z]:)/;
/**
 * The identifier chain bound. `LIB_DIR` to `REPO_ROOT` to `path.resolve(__dirname, '..')`
 * consumes 5, so 8 clears the deepest chain this tree writes with room to spare
 * while still terminating on a cycle the `seen` set somehow missed.
 */
const MAX_FOLD_DEPTH = 8;

// ─── types ───────────────────────────────────────────────────────────────────

type NodeKind = (typeof NODE_KINDS)[number];
type Verdict = (typeof VERDICTS)[number];
type UnprovenReason = (typeof UNPROVEN_REASONS)[number];
type ImportForm = (typeof IMPORT_FORMS)[number];

interface WorkgraphError {
  ok: false;
  code: string;
  message: string;
  subject?: string;
}

interface ImportSpec {
  /** Empty exactly when `dynamic` is true. */
  specifier: string;
  form: ImportForm;
  type_only: boolean;
  /**
   * True when the specifier does not begin with a period.
   *
   * HARDCODED FALSE FOR A DYNAMIC SPEC, and that is load bearing rather than
   * incidental. `scanImports` skips an external spec outright, and a folded
   * repo-relative path does not begin with a period, so recomputing this from
   * folded text would swallow EVERY folded edge while every test stayed green.
   */
  external: boolean;
  dynamic: boolean;
  /**
   * The raw argument text of a dynamic require, which is what the constant
   * folder reads. Empty exactly when `dynamic` is false.
   *
   * Carried on the spec rather than re-read from the file elsewhere, because a
   * second reader of the same line is a second place for the 2 readers to
   * disagree about what the line says.
   */
  dynamic_argument: string;
  /** 1 based line of the statement that produced this result. */
  line: number;
}

interface FoldHit {
  ok: true;
  /** A normalized repo-relative path. Never absolute, never empty. */
  specifier: string;
}

interface FoldMiss {
  ok: false;
  reason: string;
}

type FoldResult = FoldHit | FoldMiss;

interface ParseResult {
  ok: boolean;
  results: ImportSpec[];
}

interface ResolveHit {
  ok: true;
  path: string;
  in_scan_root: boolean;
}

interface ResolveMiss {
  ok: false;
  reason: 'no-file-resolves';
  from: string;
  specifier: string;
}

type ResolveResult = ResolveHit | ResolveMiss;

function err(code: string, message: string, subject?: string): WorkgraphError {
  const e: WorkgraphError = { ok: false, code, message };
  if (typeof subject === 'string' && subject !== '') e.subject = subject;
  return e;
}

// ─── line arithmetic ─────────────────────────────────────────────────────────

/**
 * Tolerant line split (`local/no-crlf-fragile-split`), the shipped pattern from
 * `roadmap-index.cts`. The carriage return is dropped from the line text.
 */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charAt(i) === '\n') {
      let line = text.slice(start, i);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
      start = i + 1;
      if (i === text.length) break;
    }
  }
  return lines;
}

interface CommentState {
  inBlock: boolean;
}

/**
 * Return the code half of 1 line, with comment text removed and string literals
 * preserved, carrying block comment state across the call.
 *
 * The block state is the whole point. A doc comment in this repo can carry a
 * full import line as an example, and a scanner that inspects each line in
 * isolation manufactures an import edge out of prose. That is a false BACKED
 * verdict, which is the exact failure this module exists to detect, committed
 * by the detector itself.
 */
function stripLineComments(line: string, state: CommentState): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.inBlock) {
      const end = line.indexOf('*/', i);
      if (end === -1) return out;
      state.inBlock = false;
      i = end + 2;
      continue;
    }
    const ch = line.charAt(i);
    const next = line.charAt(i + 1);
    if (ch === '/' && next === '/') return out;
    if (ch === '/' && next === '*') {
      state.inBlock = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      i += 1;
      while (i < line.length) {
        if (line.charAt(i) === '\\') {
          i += 2;
          continue;
        }
        if (line.charAt(i) === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += line.slice(start, i);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The code half of a whole source text, line structure preserved. */
function stripSourceComments(text: unknown): string {
  if (typeof text !== 'string' || text === '') return '';
  const state: CommentState = { inBlock: false };
  return splitLines(text)
    .map((line) => stripLineComments(line, state))
    .join('\n');
}

// ─── the import source parser ────────────────────────────────────────────────

function isDeclarationFile(filename: unknown): boolean {
  return typeof filename === 'string' && DECLARATION_MARKER.test(filename);
}

function spec(
  specifier: string,
  form: ImportForm,
  typeOnly: boolean,
  line: number,
  dynamic: boolean,
  dynamicArgument?: string,
): ImportSpec {
  return {
    specifier,
    form,
    type_only: typeOnly,
    external: !dynamic && !specifier.startsWith('.'),
    dynamic,
    dynamic_argument: dynamic && typeof dynamicArgument === 'string' ? dynamicArgument : '',
    line,
  };
}

/**
 * The index of the parenthesis closing the one at `openIndex`, or -1 when the
 * line does not close it. String literals are skipped whole, so a paren inside
 * a quoted argument cannot unbalance the count.
 */
function matchingParen(text: string, openIndex: number): number {
  if (text.charAt(openIndex) !== '(') return -1;
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text.charAt(i) === '\\') {
          i += 2;
          continue;
        }
        if (text.charAt(i) === ch) {
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return -1;
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * The argument text of every `require(...)` call on 1 line of code, balanced
 * parens honoured. This is the replacement for the old identifier-only dynamic
 * shape: it SEES `require(path.join(...))` where that shape saw nothing.
 */
function dynamicRequireArguments(code: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < code.length) {
    const at = code.indexOf('require(', i);
    if (at === -1) break;
    const open = at + 'require('.length - 1;
    const close = matchingParen(code, open);
    if (close === -1) {
      i = open + 1;
      continue;
    }
    const argument = code.slice(open + 1, close).trim();
    if (argument !== '') found.push(argument);
    i = close + 1;
  }
  return found;
}

/**
 * Every whole-line `const` binding in a file, by name. A name bound more than
 * once maps to null: 2 bindings mean the folder cannot say which one reaches
 * the require site, and a folder that guesses is exactly the instrument this
 * phase exists to avoid building.
 */
function collectConstBindings(fileText: string): Map<string, string | null> {
  const bindings = new Map<string, string | null>();
  for (const line of splitLines(stripSourceComments(fileText))) {
    const match = CONST_BINDING_SHAPE.exec(line);
    if (match === null) continue;
    const name = match[1];
    const value = match[2].trim();
    if (bindings.has(name)) {
      bindings.set(name, null);
      continue;
    }
    bindings.set(name, value === '' ? null : value);
  }
  return bindings;
}

/** Top level comma separated arguments, or null when the text is unbalanced. */
function splitArguments(inner: string): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    const ch = inner.charAt(i);
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      let closed = false;
      while (i < inner.length) {
        if (inner.charAt(i) === '\\') {
          i += 2;
          continue;
        }
        if (inner.charAt(i) === ch) {
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return null;
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (ch === ',' && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  if (depth !== 0) return null;
  args.push(inner.slice(start));
  return args;
}

/**
 * The closed grammar, and NOTHING outside it. 5 forms fold:
 *
 *   1. a string literal
 *   2. `__dirname`, which is known: the directory of the file being scanned
 *   3. `path.join(a, b, ...)` where every argument folds
 *   4. `path.resolve(a, b, ...)` where every argument folds
 *   5. an identifier whose binding in the SAME file is a `const` initialised to
 *      a form that folds, transitively and depth bounded
 *
 * Everything else refuses: a conditional, a function call, a template literal,
 * an environment read, a member expression, an identifier bound in another
 * file. `scripts/fleet-glass.cjs:104` binds
 * `ROOT = process.env.FERROX_GLASS_ROOT ? ... : REPO_ROOT`, and a folder that
 * resolves that asserts a coupling which is wrong exactly when the variable is
 * set, which is exactly when the read only battery runs.
 */
function foldExpression(
  expr: string,
  dir: string,
  bindings: Map<string, string | null>,
  seen: Set<string>,
  depth: number,
): FoldResult {
  const text = expr.trim();
  if (text === '') return { ok: false, reason: 'empty-expression' };
  if (depth > MAX_FOLD_DEPTH) return { ok: false, reason: 'fold-depth-exceeded' };

  const literal = STRING_LITERAL_SHAPE.exec(text);
  if (literal !== null) {
    const value = literal[2];
    if (value.indexOf('\\') !== -1) return { ok: false, reason: 'escaped-literal' };
    if (ABSOLUTE_SHAPE.test(value)) return { ok: false, reason: 'absolute-literal' };
    return { ok: true, specifier: value };
  }

  if (text === '__dirname') return { ok: true, specifier: dir };

  if (PATH_CALL_SHAPE.test(text)) {
    const open = text.indexOf('(');
    const close = matchingParen(text, open);
    // The call must be the WHOLE expression. `path.join(a, b).slice(1)` closes
    // early, and folding its prefix would answer a question nobody asked.
    if (close === -1 || close !== text.length - 1) return { ok: false, reason: 'not-a-whole-call' };
    const args = splitArguments(text.slice(open + 1, close));
    if (args === null || args.length === 0) return { ok: false, reason: 'unparsable-arguments' };
    const parts: string[] = [];
    for (const argument of args) {
      const folded = foldExpression(argument, dir, bindings, seen, depth + 1);
      if (!folded.ok) return folded;
      parts.push(folded.specifier);
    }
    return { ok: true, specifier: parts.join('/') };
  }

  if (IDENTIFIER_SHAPE.test(text)) {
    if (seen.has(text)) return { ok: false, reason: 'self-referential-binding' };
    const bound = bindings.get(text);
    if (bound === undefined) return { ok: false, reason: 'no-binding-in-file' };
    if (bound === null) return { ok: false, reason: 'ambiguous-binding' };
    const next = new Set(seen);
    next.add(text);
    return foldExpression(bound, dir, bindings, next, depth + 1);
  }

  return { ok: false, reason: 'outside-the-closed-grammar' };
}

/**
 * Fold 1 dynamic require argument to a repo-relative specifier, or refuse.
 *
 * PURE AND TOTAL: it reads no disk, asks no clock and throws on no input. A
 * folded specifier is handed to `resolveSpecifier`, the SAME resolver a literal
 * specifier uses, because 2 resolvers can disagree about what a specifier means
 * and the disagreement is silent.
 */
function foldSpecifier(argumentText: unknown, fromPath: unknown, fileText: unknown): FoldResult {
  const expr = typeof argumentText === 'string' ? argumentText : '';
  if (expr === '') return { ok: false, reason: 'no-argument-text' };
  const dir = dirOf(normalizePath(fromPath));
  const text = typeof fileText === 'string' ? fileText : '';
  const folded = foldExpression(expr, dir, collectConstBindings(text), new Set<string>(), 0);
  if (!folded.ok) return folded;
  const normalized = normalizePath(folded.specifier);
  if (normalized === '') return { ok: false, reason: 'folds-to-nothing' };
  if (normalized === '..' || normalized.startsWith('../')) {
    return { ok: false, reason: 'escapes-the-repository' };
  }
  return { ok: true, specifier: normalized };
}

/**
 * Every specifier the source text imports, with its form and its type_only flag.
 *
 * A specifier that lives only inside a comment produces nothing. A require call
 * whose argument is an identifier produces a DYNAMIC result carrying no
 * specifier, because the caller has to know the scan could not read it rather
 * than believe the file imports nothing.
 */
function parseImportSources(text: unknown, filename?: unknown): ParseResult {
  const results: ImportSpec[] = [];
  if (typeof text !== 'string' || text === '') return { ok: true, results };

  const declared = isDeclarationFile(filename);
  const state: CommentState = { inBlock: false };
  let pendingEsm: { type_only: boolean } | null = null;

  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const code = stripLineComments(lines[i], state);
    const lineNo = i + 1;
    if (code.trim() === '') continue;

    if (pendingEsm !== null) {
      const close = ESM_CLOSE_SHAPE.exec(code);
      if (close !== null) {
        results.push(spec(close[2], 'esm', declared || pendingEsm.type_only, lineNo, false));
        pendingEsm = null;
        continue;
      }
      if (code.includes('}')) pendingEsm = null;
      continue;
    }

    const equals = IMPORT_EQUALS_SHAPE.exec(code);
    if (equals !== null) {
      results.push(spec(equals[2], 'import-equals', declared, lineNo, false));
      continue;
    }

    const esm = ESM_FROM_SHAPE.exec(code);
    if (esm !== null) {
      results.push(spec(esm[3], 'esm', declared || esm[1] !== undefined, lineNo, false));
      continue;
    }

    const side = SIDE_EFFECT_SHAPE.exec(code);
    if (side !== null) {
      results.push(spec(side[2], 'side-effect', declared, lineNo, false));
      continue;
    }

    const open = ESM_OPEN_SHAPE.exec(code);
    if (open !== null) {
      pendingEsm = { type_only: open[1] !== undefined };
      continue;
    }

    // The fallback. This covers a require bound by a declaration and a bare
    // require that is not the whole of one, which are the same shape once the
    // anchored import statements above have been taken off the line.
    BARE_REQUIRE_SHAPE.lastIndex = 0;
    let m = BARE_REQUIRE_SHAPE.exec(code);
    let matched = false;
    while (m !== null) {
      matched = true;
      results.push(spec(m[2], 'require', declared, lineNo, false));
      m = BARE_REQUIRE_SHAPE.exec(code);
    }
    if (matched) continue;

    // The dynamic fallback, WIDENED in phase 27. It now carries the argument
    // text out so the constant folder has something to read, and it recognizes
    // any balanced argument rather than a bare identifier alone. The specifier
    // stays empty and `external` stays false, so the documented invariant on
    // `ImportSpec.specifier` is preserved exactly.
    for (const argument of dynamicRequireArguments(code)) {
      results.push(spec('', 'require', declared, lineNo, true, argument));
    }
  }

  return { ok: true, results };
}

// ─── path normalization and the specifier resolver ───────────────────────────

/**
 * 1 spelling per path. Separators become the forward slash form, a leading
 * current directory prefix is stripped, empty segments collapse and parent
 * segments are folded, so the plain form, the leading dot form and the backslash
 * form of 1 path compare equal.
 */
function normalizePath(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  const parts: string[] = [];
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push('..');
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function dirOf(filePath: string): string {
  const normalized = normalizePath(filePath);
  const cut = normalized.lastIndexOf('/');
  return cut === -1 ? '' : normalized.slice(0, cut);
}

/** True when the path sits at or under 1 of the scan roots. */
function isInScanRoot(filePath: string, scanRoots: unknown): boolean {
  const roots = Array.isArray(scanRoots) ? scanRoots : [];
  for (const raw of roots) {
    const root = normalizePath(raw);
    if (root === '') continue;
    if (filePath === root || filePath.startsWith(root + '/')) return true;
  }
  return false;
}

function toPathSet(existing: unknown): Set<string> {
  const set = new Set<string>();
  if (existing instanceof Set) {
    for (const value of existing) set.add(normalizePath(value));
    return set;
  }
  if (Array.isArray(existing)) {
    for (const value of existing) set.add(normalizePath(value));
  }
  return set;
}

/**
 * Resolve 1 specifier against an INJECTED set of existing paths. Never reads a
 * disk. The candidate order is taken literally and the first hit wins, because a
 * resolver that collects every candidate and picks a winner later has 2 places
 * to be wrong instead of 1.
 */
function resolveSpecifier(
  fromPath: unknown,
  specifier: unknown,
  existing: unknown,
  scanRoots?: unknown,
): ResolveResult {
  const from = normalizePath(fromPath);
  const raw = typeof specifier === 'string' ? specifier : '';
  const set = toPathSet(existing);

  const base = raw.startsWith('.') ? normalizePath(dirOf(from) + '/' + raw) : normalizePath(raw);

  const candidates: string[] = [base];
  for (const [compiled, source] of COMPILED_TO_SOURCE) {
    if (base.endsWith(compiled)) candidates.push(base.slice(0, base.length - compiled.length) + source);
  }
  for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(base + '/index' + ext);

  for (const candidate of candidates) {
    if (candidate !== '' && set.has(candidate)) {
      return { ok: true, path: candidate, in_scan_root: isInScanRoot(candidate, scanRoots) };
    }
  }
  return { ok: false, reason: 'no-file-resolves', from, specifier: raw };
}

// ─── the hermeticity predicate ───────────────────────────────────────────────

/**
 * Every forbidden module id and clock read the source text names.
 *
 * Written as a predicate rather than as a test assertion so it can be fired at a
 * synthetic POSITIVE first. A detector observed only in its passing direction is
 * a guard nobody has proven can fire, which is the defect class this whole phase
 * is built to stop repeating.
 */
function detectImpurity(text: unknown, filename?: unknown): string[] {
  const found: string[] = [];
  if (typeof text !== 'string' || text === '') return found;

  for (const result of parseImportSources(text, filename).results) {
    if (!result.external) continue;
    const id = result.specifier.startsWith('node:') ? result.specifier.slice(5) : result.specifier;
    if (FORBIDDEN_MODULE_IDS.includes(id)) found.push('module ' + result.specifier);
  }

  const code = stripSourceComments(text);
  for (const shape of CLOCK_SHAPES) {
    if (shape.test(code)) found.push('clock ' + shape.source);
  }

  return found.slice().sort();
}

// ─── the declared edge classifier ────────────────────────────────────────────

interface NodeInput {
  id: string;
  kind?: string;
  wave?: number;
  task_count?: number;
  autonomous?: boolean;
  has_summary?: boolean;
  write_lane?: string[];
  depends_on?: string[];
  hot_seams?: { decision: string; matched: string[] };
  governance_seams?: { matched: string[]; files: string[] };
  role?: null | { id: string; surface: string; glob: string };
  tier?: Record<string, unknown>;
}

interface EdgeRecord {
  from: string;
  to: string;
  declared: boolean;
  verdict: Verdict;
  backing: string[];
  evidence: string[];
  unproven_reason: UnprovenReason | null;
}

interface ImportEdgeRecord {
  from: string;
  to: string;
  form: string;
  type_only: boolean;
}

interface SeamViolationRecord {
  seam: string;
  dependent: string;
  reason: string;
  importer: string;
  imported: string;
}

interface ClassifyInput {
  nodes?: NodeInput[];
  import_edges?: ImportEdgeRecord[];
  existing?: unknown;
  scan_roots?: unknown;
  /**
   * Files carrying at least 1 dynamic specifier the scan could not follow.
   * INJECTED like everything else here, so this module still reads nothing.
   * A node whose write lane names one of these cannot be called `unbacked`.
   */
  dynamic_unresolved?: unknown;
}

const KIND_SEAM: NodeKind = 'seam';
const KIND_PLAN: NodeKind = 'plan';
// A NUL cannot occur in a node id, which is why it is the separator. It is written
// as an ESCAPE rather than a literal byte: a literal NUL makes grep report this
// file as binary and hides every search in it, which is FF-B273. The runtime value
// is unchanged. Do not 'simplify' this back to a literal.
const PAIR_SEPARATOR = '\u0000';

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function laneOf(record: NodeInput): string[] {
  const seen = new Set<string>();
  for (const raw of asArray<string>(record.write_lane)) {
    const normalized = normalizePath(raw);
    if (normalized !== '') seen.add(normalized);
  }
  return Array.from(seen).sort();
}

function resolveScanRoots(value: unknown): string[] {
  const roots = asArray<string>(value)
    .map((r) => normalizePath(r))
    .filter((r) => r !== '');
  return roots.length > 0 ? roots : ['src'];
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 1 edge record per declared dependency, sorted by dependent id then
 * prerequisite id, classified against the 3 verdicts of the document contract.
 *
 * The 3 inputs are INJECTED and nothing else is consulted, which is what makes
 * the byte level tests real. Rule 4 of the contract, the unproven verdict, is
 * load bearing rather than defensive: a plan that has not executed yet has
 * created none of its files, so a classifier without it would accuse every
 * freshly planned edge, the signal would become noise, and the next person would
 * loosen the guard until it could not fire at all. An unbacked verdict is issued
 * ONLY where the scan could have seen a backing and did not.
 */
function classifyEdges(input: ClassifyInput): { edges: EdgeRecord[]; warnings: string[] } {
  const source: ClassifyInput = input === null || typeof input !== 'object' ? {} : input;
  const nodes = asArray<NodeInput>(source.nodes).filter(
    (n) => n !== null && typeof n === 'object' && typeof n.id === 'string' && n.id !== '',
  );
  const scanRoots = resolveScanRoots(source.scan_roots);
  const existing = toPathSet(source.existing);
  const dynamicUnresolved = toPathSet(source.dynamic_unresolved);

  const byId = new Map<string, NodeInput>();
  const lanes = new Map<string, string[]>();
  const pathToNodes = new Map<string, string[]>();
  for (const record of nodes) {
    byId.set(record.id, record);
    const lane = laneOf(record);
    lanes.set(record.id, lane);
    for (const filePath of lane) {
      const owners = pathToNodes.get(filePath);
      if (owners === undefined) pathToNodes.set(filePath, [record.id]);
      else owners.push(record.id);
    }
  }

  // The import index, folded to node pairs once. Linear in the write lanes
  // rather than quadratic in the node count, and 1 place where a path is
  // normalized. The direction is preserved: the key is importer then imported,
  // so an import running the other way cannot launder a declared edge.
  const importBacking = new Map<string, string[]>();
  for (const edge of asArray<ImportEdgeRecord>(source.import_edges)) {
    if (edge === null || typeof edge !== 'object') continue;
    const importer = normalizePath(edge.from);
    const imported = normalizePath(edge.to);
    if (importer === '' || imported === '') continue;
    for (const dependent of pathToNodes.get(importer) || []) {
      for (const prerequisite of pathToNodes.get(imported) || []) {
        if (dependent === prerequisite) continue;
        const key = dependent + PAIR_SEPARATOR + prerequisite;
        const evidence = importBacking.get(key);
        const text = importer + ' imports ' + imported;
        if (evidence === undefined) importBacking.set(key, [text]);
        else if (!evidence.includes(text)) evidence.push(text);
      }
    }
  }

  const inScope = (id: string): boolean =>
    (lanes.get(id) || []).some((p) => isInScanRoot(p, scanRoots));
  const onDisk = (id: string): boolean =>
    (lanes.get(id) || []).some((p) => isInScanRoot(p, scanRoots) && existing.has(p));
  /**
   * True when this node writes a file the scan read but could not fully follow,
   * because it carries a dynamic specifier. Such a node's missing backing is a
   * statement about the SCAN, so its edges degrade to unproven.
   */
  const hasUnfollowableDynamic = (id: string): boolean =>
    (lanes.get(id) || []).some((p) => dynamicUnresolved.has(p));

  const edges: EdgeRecord[] = [];
  const warnings: string[] = [];
  const dependents = nodes.slice().sort((a, b) => compareStrings(a.id, b.id));

  for (const dependent of dependents) {
    const declared = Array.from(new Set(asArray<string>(dependent.depends_on))).sort(compareStrings);
    for (const prerequisiteId of declared) {
      if (typeof prerequisiteId !== 'string' || prerequisiteId === '') continue;
      if (!byId.has(prerequisiteId)) {
        warnings.push(
          `node ${dependent.id} declares depends_on ${prerequisiteId}, which is not a node in `
            + 'this phase, so no edge is emitted for it',
        );
        continue;
      }

      const dependentLane = lanes.get(dependent.id) || [];
      const prerequisiteLane = new Set(lanes.get(prerequisiteId) || []);
      const shared = dependentLane.filter((p) => prerequisiteLane.has(p)).sort(compareStrings);
      const imported = (importBacking.get(dependent.id + PAIR_SEPARATOR + prerequisiteId) || [])
        .slice()
        .sort(compareStrings);

      const backing: string[] = [];
      const evidence: string[] = [];
      if (shared.length > 0) {
        backing.push('file');
        for (const filePath of shared) evidence.push('both write lanes name ' + filePath);
      }
      if (imported.length > 0) {
        backing.push('import');
        for (const text of imported) evidence.push(text);
      }

      let verdict: Verdict = 'backed';
      let unprovenReason: UnprovenReason | null = null;
      if (backing.length === 0) {
        if (!inScope(dependent.id) || !inScope(prerequisiteId)) {
          verdict = 'unproven';
          unprovenReason = 'out-of-scan-scope';
        } else if (!onDisk(dependent.id) || !onDisk(prerequisiteId)) {
          verdict = 'unproven';
          unprovenReason = 'endpoint-absent-from-disk';
        } else if (
          hasUnfollowableDynamic(dependent.id) || hasUnfollowableDynamic(prerequisiteId)
        ) {
          // Ordered AFTER the 2 reach tests on purpose: a node the scan never
          // opened cannot be described by what its text contains.
          verdict = 'unproven';
          unprovenReason = 'dynamic-specifier-unresolved';
        } else {
          verdict = 'unbacked';
        }
      }

      edges.push({
        from: dependent.id,
        to: prerequisiteId,
        declared: true,
        verdict,
        backing,
        evidence,
        unproven_reason: unprovenReason,
      });
    }
  }

  return { edges, warnings: warnings.slice().sort(compareStrings) };
}

// ─── the total order ─────────────────────────────────────────────────────────

function kindRank(kind: unknown): number {
  return kind === KIND_SEAM ? 0 : 1;
}

function waveOf(record: NodeInput): number {
  return typeof record.wave === 'number' && Number.isFinite(record.wave) ? record.wave : 0;
}

/**
 * The total order: wave ascending, then seam before plan, then id ascending as a
 * plain string compare. Input order is never consulted, following the same
 * discipline as `sortEntries` in `roadmap-index.cts`.
 */
function computeSchedule(nodes: unknown): { schedule: string[]; order: Record<string, number> } {
  const records = asArray<NodeInput>(nodes).filter(
    (n) => n !== null && typeof n === 'object' && typeof n.id === 'string' && n.id !== '',
  );
  const sorted = records.slice().sort((a, b) => {
    const wave = waveOf(a) - waveOf(b);
    if (wave !== 0) return wave;
    const kind = kindRank(a.kind) - kindRank(b.kind);
    if (kind !== 0) return kind;
    return compareStrings(a.id, b.id);
  });
  const schedule = sorted.map((n) => n.id);
  const order: Record<string, number> = {};
  for (let i = 0; i < schedule.length; i++) order[schedule[i]] = i;
  return { schedule, order };
}

// ─── the seam ordering property ──────────────────────────────────────────────

interface SeamInput {
  nodes?: NodeInput[];
  edges?: EdgeRecord[];
  import_edges?: ImportEdgeRecord[];
  order?: Record<string, number>;
}

/**
 * Every pair that breaks the seam ordering property, derived from the nodes, the
 * write lanes, the declared edges and the import edges.
 *
 * The order is taken as an ARGUMENT rather than recomputed here, for 2 reasons.
 * The validator has to re-derive this property from a document whose order it
 * did not compute, and the declared dependent arm is otherwise a guard that
 * cannot fire: waves already come from the declared graph, so a declared
 * dependent is always later by construction. The arm that can actually occur is
 * the importing dependent with no declared edge, the hidden dependent.
 */
function deriveSeamViolations(input: SeamInput): SeamViolationRecord[] {
  const source: SeamInput = input === null || typeof input !== 'object' ? {} : input;
  const nodes = asArray<NodeInput>(source.nodes).filter(
    (n) => n !== null && typeof n === 'object' && typeof n.id === 'string' && n.id !== '',
  );
  const order: Record<string, number> =
    source.order === null || typeof source.order !== 'object' ? {} : source.order;
  const edges = asArray<EdgeRecord>(source.edges);
  const importEdges = asArray<ImportEdgeRecord>(source.import_edges);

  const lanes = new Map<string, Set<string>>();
  for (const record of nodes) lanes.set(record.id, new Set(laneOf(record)));

  const violations: SeamViolationRecord[] = [];
  for (const seam of nodes) {
    if (seam.kind !== KIND_SEAM) continue;
    const seamOrder = order[seam.id];
    if (typeof seamOrder !== 'number') continue;
    const seamLane = lanes.get(seam.id) || new Set<string>();

    for (const dependent of nodes) {
      if (dependent.id === seam.id) continue;
      const dependentOrder = order[dependent.id];
      if (typeof dependentOrder !== 'number') continue;
      if (seamOrder < dependentOrder) continue;

      if (edges.some((e) => e !== null && typeof e === 'object' && e.from === dependent.id && e.to === seam.id)) {
        violations.push({
          seam: seam.id,
          dependent: dependent.id,
          reason: `${dependent.id} declares an edge to seam ${seam.id} but does not schedule after it`,
          importer: '',
          imported: '',
        });
      }

      const dependentLane = lanes.get(dependent.id) || new Set<string>();
      for (const edge of importEdges) {
        if (edge === null || typeof edge !== 'object') continue;
        const importer = normalizePath(edge.from);
        const imported = normalizePath(edge.to);
        if (!dependentLane.has(importer) || !seamLane.has(imported)) continue;
        violations.push({
          seam: seam.id,
          dependent: dependent.id,
          reason: `${dependent.id} imports the write lane of seam ${seam.id} but does not schedule after it`,
          importer,
          imported,
        });
      }
    }
  }

  return violations.sort(
    (a, b) =>
      compareStrings(a.seam, b.seam)
      || compareStrings(a.dependent, b.dependent)
      || compareStrings(a.importer, b.importer)
      || compareStrings(a.imported, b.imported),
  );
}

// ─── the assembler ───────────────────────────────────────────────────────────

const DEFAULT_GENERATED = {
  plan_index: 'phase-plan-index',
  hot_seams: 'coordination.hot_seams',
  governance_seams: 'coordination.shared_state_paths',
  roles: 'team-manifest',
  tiers: 'model.resolve-tier',
  imports: 'workgraph require scan',
};

const DEFAULT_TIER = {
  stage: 'execute',
  tier: '',
  model_id: null,
  ladder_miss: '',
  risk_grade: '',
  risk_matched: [] as string[],
};

interface AssembleInput extends ClassifyInput {
  phase?: string;
  generated?: Record<string, unknown>;
  scan?: {
    files?: number;
    edges?: number;
    external?: number;
    out_of_root?: number;
    folded?: number;
    unfolded?: number;
  };
  seam_gaps?: unknown[];
  unresolved_imports?: unknown[];
  warnings?: string[];
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The whole document, every key present including the empty arrays.
 *
 * A key that appears only when it has content forces every consumer to handle 2
 * shapes, and the validator would then have to accept both.
 */
function assembleWorkgraph(input: AssembleInput): {
  ok: boolean;
  document: Record<string, unknown>;
  errors: WorkgraphError[];
} {
  const source: AssembleInput = input === null || typeof input !== 'object' ? {} : input;
  const errors: WorkgraphError[] = [];
  const scanRoots = resolveScanRoots(source.scan_roots);

  const records: NodeInput[] = [];
  for (const record of asArray<NodeInput>(source.nodes)) {
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || record.id === '') {
      errors.push(err('E_WG_NODE_MISSING_FIELD', 'a node record carries no id and is dropped'));
      continue;
    }
    records.push(record);
  }

  const classified = classifyEdges({
    nodes: records,
    import_edges: source.import_edges,
    existing: source.existing,
    scan_roots: scanRoots,
    dynamic_unresolved: source.dynamic_unresolved,
  });
  const { schedule, order } = computeSchedule(records);
  const seamViolations = deriveSeamViolations({
    nodes: records,
    edges: classified.edges,
    import_edges: source.import_edges,
    order,
  });

  const byId = new Map<string, NodeInput>();
  for (const record of records) byId.set(record.id, record);

  const nodes = schedule.map((id, index) => {
    const record = byId.get(id) as NodeInput;
    const kind = record.kind === KIND_SEAM ? KIND_SEAM : KIND_PLAN;
    const hotSeams = record.hot_seams === null || typeof record.hot_seams !== 'object'
      ? { decision: 'parallel-ok', matched: [] as string[] }
      : {
        decision: typeof record.hot_seams.decision === 'string' ? record.hot_seams.decision : 'parallel-ok',
        matched: asArray<string>(record.hot_seams.matched).slice().sort(compareStrings),
      };
    const governanceSeams = record.governance_seams === null || typeof record.governance_seams !== 'object'
      ? { matched: [] as string[], files: [] as string[] }
      : {
        matched: asArray<string>(record.governance_seams.matched).slice().sort(compareStrings),
        files: asArray<string>(record.governance_seams.files).map(normalizePath).sort(compareStrings),
      };
    return {
      id: record.id,
      kind,
      wave: waveOf(record),
      schedule_order: index,
      task_count: countOf(record.task_count),
      autonomous: record.autonomous === true,
      has_summary: record.has_summary === true,
      write_lane: laneOf(record),
      hot_seams: hotSeams,
      governance_seams: governanceSeams,
      role: record.role === null || typeof record.role !== 'object' ? null : record.role,
      tier: record.tier === null || typeof record.tier !== 'object'
        ? Object.assign({}, DEFAULT_TIER)
        : Object.assign({}, DEFAULT_TIER, record.tier),
    };
  });

  const importEdges = asArray<ImportEdgeRecord>(source.import_edges)
    .filter((e) => e !== null && typeof e === 'object')
    .map((e) => ({
      from: normalizePath(e.from),
      to: normalizePath(e.to),
      form: typeof e.form === 'string' ? e.form : 'require',
      type_only: e.type_only === true,
    }))
    .sort(
      (a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to) || compareStrings(a.form, b.form),
    );

  const scan = source.scan === null || typeof source.scan !== 'object' ? {} : source.scan;
  const warnings = asArray<string>(source.warnings)
    .concat(classified.warnings)
    .slice()
    .sort(compareStrings);

  const document: Record<string, unknown> = {
    schema: SCHEMA_VERSION,
    phase: typeof source.phase === 'string' ? source.phase : '',
    generated: Object.assign({}, DEFAULT_GENERATED, source.generated, { scan_roots: scanRoots }),
    nodes,
    edges: classified.edges,
    import_edges: importEdges,
    schedule,
    seam_violations: seamViolations,
    seam_gaps: asArray<Record<string, unknown>>(source.seam_gaps)
      .slice()
      .sort((a, b) => compareStrings(String(a.path), String(b.path)) || compareStrings(String(a.node), String(b.node))),
    unresolved_imports: asArray<Record<string, unknown>>(source.unresolved_imports)
      .slice()
      .sort(
        (a, b) =>
          compareStrings(String(a.from), String(b.from)) || compareStrings(String(a.specifier), String(b.specifier)),
      ),
    scan: {
      files: countOf(scan.files),
      edges: countOf(scan.edges),
      external: countOf(scan.external),
      out_of_root: countOf(scan.out_of_root),
      // Additive counters, phase 27. Every existing reader of this block names
      // its keys, so 2 more cannot change what any of them reads, and no schema
      // version moves for a counter.
      folded: countOf(scan.folded),
      unfolded: countOf(scan.unfolded),
    },
    warnings,
  };

  return { ok: errors.length === 0, document, errors };
}

// ─── the schema validator ────────────────────────────────────────────────────

/**
 * The 15 failure modes, 1 code each. Every code is driven by its own named
 * mutation in `tests/workgraph.test.cjs`, and the test asserts the pairing is a
 * bijection: an unpaired code is a check nobody proved, and an unpaired mutation
 * is a hole.
 */
const WG_CODES = [
  'E_WG_SCHEMA_MISSING',
  'E_WG_SCHEMA_VERSION',
  'E_WG_NOT_OBJECT',
  'E_WG_NODES_NOT_ARRAY',
  'E_WG_NODE_DUPLICATE',
  'E_WG_NODE_MISSING_FIELD',
  'E_WG_NODE_BAD_KIND',
  'E_WG_EDGE_DANGLING',
  'E_WG_EDGE_SELF',
  'E_WG_EDGE_UNEVIDENCED',
  'E_WG_EDGE_BAD_VERDICT',
  'E_WG_WAVE_INVERSION',
  'E_WG_SEAM_AFTER_DEPENDENT',
  'E_WG_SCHEDULE_INCOMPLETE',
  'E_WG_IMPORT_OUT_OF_SCOPE',
];

/** Every key a node must carry. `role` is nullable, so presence is what counts. */
const REQUIRED_NODE_FIELDS = [
  'id',
  'kind',
  'wave',
  'schedule_order',
  'task_count',
  'autonomous',
  'has_summary',
  'write_lane',
  'hot_seams',
  'governance_seams',
  'role',
  'tier',
];

function violationKey(v: SeamViolationRecord): string {
  return [v.seam, v.dependent, v.importer, v.imported].join(PAIR_SEPARATOR);
}

/**
 * The document contract restated as a predicate. Never throws, including on a
 * null, a string, a number and an array.
 *
 * The seam ordering property is RE-DERIVED from the nodes, the write lanes and
 * the import edges rather than read out of the document's own violations array.
 * A document that computed a violation and then failed to report it is the only
 * interesting way for the seam rule to fail, and a validator that trusted the
 * array would be a guard that cannot fire.
 */
function validateWorkgraph(doc: unknown): { ok: boolean; errors: WorkgraphError[] } {
  const errors: WorkgraphError[] = [];

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push(err('E_WG_NOT_OBJECT', 'a workgraph document must be a plain object'));
    return { ok: false, errors };
  }
  const document = doc as Record<string, unknown>;

  if (!Object.prototype.hasOwnProperty.call(document, 'schema')) {
    errors.push(err('E_WG_SCHEMA_MISSING', 'the document carries no schema key'));
  } else if (document.schema !== SCHEMA_VERSION) {
    errors.push(
      err(
        'E_WG_SCHEMA_VERSION',
        `the document names schema ${JSON.stringify(document.schema)}, and only `
          + `${JSON.stringify(SCHEMA_VERSION)} is shipped`,
      ),
    );
  }

  const nodes = document.nodes;
  const nodeIds = new Set<string>();
  const waveById = new Map<string, number>();
  if (!Array.isArray(nodes)) {
    errors.push(err('E_WG_NODES_NOT_ARRAY', 'the nodes key is not an array'));
  } else {
    const seenOrders = new Set<number>();
    for (const record of nodes) {
      if (record === null || typeof record !== 'object') {
        errors.push(err('E_WG_NODE_MISSING_FIELD', 'a node entry is not an object'));
        continue;
      }
      const entry = record as Record<string, unknown>;
      const id = typeof entry.id === 'string' ? entry.id : '';
      for (const field of REQUIRED_NODE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(entry, field)) {
          errors.push(err('E_WG_NODE_MISSING_FIELD', `node ${id} carries no ${field} key`, id));
        }
      }
      if (id !== '') {
        if (nodeIds.has(id)) {
          errors.push(err('E_WG_NODE_DUPLICATE', `2 nodes carry the id ${id}`, id));
        }
        nodeIds.add(id);
        if (typeof entry.wave === 'number') waveById.set(id, entry.wave);
      }
      if (typeof entry.schedule_order === 'number') {
        if (seenOrders.has(entry.schedule_order)) {
          errors.push(
            err(
              'E_WG_NODE_DUPLICATE',
              `2 nodes carry the schedule order ${entry.schedule_order}, and it is unique`,
              id,
            ),
          );
        }
        seenOrders.add(entry.schedule_order);
      }
      if (!NODE_KINDS.includes(entry.kind as NodeKind)) {
        errors.push(
          err('E_WG_NODE_BAD_KIND', `node ${id} carries kind ${JSON.stringify(entry.kind)}`, id),
        );
      }
    }
  }

  const edges = Array.isArray(document.edges) ? (document.edges as EdgeRecord[]) : [];
  for (const edge of edges) {
    if (edge === null || typeof edge !== 'object') continue;
    const label = `${edge.from} to ${edge.to}`;
    if (edge.from === edge.to) {
      errors.push(err('E_WG_EDGE_SELF', `edge ${label} names 1 node as its own prerequisite`, label));
    } else if (Array.isArray(nodes)) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        errors.push(err('E_WG_EDGE_DANGLING', `edge ${label} names an id absent from the nodes`, label));
      }
    }

    const verdict = edge.verdict;
    const backing = Array.isArray(edge.backing) ? edge.backing : [];
    const evidence = Array.isArray(edge.evidence) ? edge.evidence : [];
    const reason = edge.unproven_reason;
    if (!VERDICTS.includes(verdict)) {
      errors.push(err('E_WG_EDGE_BAD_VERDICT', `edge ${label} carries verdict ${JSON.stringify(verdict)}`, label));
    } else if (verdict === 'unproven' && !UNPROVEN_REASONS.includes(reason as UnprovenReason)) {
      errors.push(
        err('E_WG_EDGE_BAD_VERDICT', `edge ${label} is unproven and names no valid reason`, label),
      );
    } else if (verdict !== 'unproven' && reason !== null) {
      errors.push(
        err('E_WG_EDGE_BAD_VERDICT', `edge ${label} is ${verdict} and still names an unproven reason`, label),
      );
    }
    if (verdict !== 'backed' && backing.length > 0) {
      errors.push(
        err('E_WG_EDGE_BAD_VERDICT', `edge ${label} is ${verdict} and still names a backing`, label),
      );
    }
    if (verdict === 'backed' && (evidence.length === 0 || backing.length === 0)) {
      errors.push(
        err(
          'E_WG_EDGE_UNEVIDENCED',
          `edge ${label} claims a backed verdict and names no reason behind it`,
          label,
        ),
      );
    }

    const dependentWave = waveById.get(edge.from);
    const prerequisiteWave = waveById.get(edge.to);
    if (typeof dependentWave === 'number' && typeof prerequisiteWave === 'number') {
      if (prerequisiteWave > dependentWave) {
        errors.push(
          err(
            'E_WG_WAVE_INVERSION',
            `edge ${label} names a prerequisite in wave ${prerequisiteWave} for a dependent in `
              + `wave ${dependentWave}`,
            label,
          ),
        );
      }
    }
  }

  const schedule = document.schedule;
  if (!Array.isArray(schedule)) {
    errors.push(err('E_WG_SCHEDULE_INCOMPLETE', 'the schedule key is not an array'));
  } else if (Array.isArray(nodes)) {
    const scheduled = new Set<string>(schedule as string[]);
    for (const id of nodeIds) {
      if (!scheduled.has(id)) {
        errors.push(err('E_WG_SCHEDULE_INCOMPLETE', `node ${id} is absent from the schedule`, id));
      }
    }
    for (const id of schedule as string[]) {
      if (!nodeIds.has(id)) {
        errors.push(err('E_WG_SCHEDULE_INCOMPLETE', `the schedule names ${id}, which is not a node`, id));
      }
    }
    for (const record of nodes) {
      if (record === null || typeof record !== 'object') continue;
      const entry = record as Record<string, unknown>;
      if (typeof entry.id !== 'string' || typeof entry.schedule_order !== 'number') continue;
      if ((schedule as string[]).indexOf(entry.id) !== entry.schedule_order) {
        errors.push(
          err(
            'E_WG_SCHEDULE_INCOMPLETE',
            `node ${entry.id} claims schedule order ${entry.schedule_order} and sits elsewhere in `
              + 'the schedule',
            entry.id,
          ),
        );
      }
    }
  }

  const generated = document.generated === null || typeof document.generated !== 'object'
    ? {}
    : (document.generated as Record<string, unknown>);
  const scanRoots = resolveScanRoots(generated.scan_roots);
  const importEdges = Array.isArray(document.import_edges)
    ? (document.import_edges as ImportEdgeRecord[])
    : [];
  for (const edge of importEdges) {
    if (edge === null || typeof edge !== 'object') continue;
    const from = normalizePath(edge.from);
    const to = normalizePath(edge.to);
    if (!isInScanRoot(from, scanRoots) || !isInScanRoot(to, scanRoots)) {
      errors.push(
        err(
          'E_WG_IMPORT_OUT_OF_SCOPE',
          `import edge ${from} to ${to} leaves the declared scan roots ${scanRoots.join(', ')}`,
          from + PAIR_SEPARATOR + to,
        ),
      );
    }
  }

  if (Array.isArray(nodes)) {
    const order: Record<string, number> = {};
    for (const record of nodes) {
      if (record === null || typeof record !== 'object') continue;
      const entry = record as Record<string, unknown>;
      if (typeof entry.id === 'string' && typeof entry.schedule_order === 'number') {
        order[entry.id] = entry.schedule_order;
      }
    }
    const implied = deriveSeamViolations({
      nodes: nodes as NodeInput[],
      edges,
      import_edges: importEdges,
      order,
    });
    const reported = new Set<string>(
      (Array.isArray(document.seam_violations) ? (document.seam_violations as SeamViolationRecord[]) : [])
        .filter((v) => v !== null && typeof v === 'object')
        .map(violationKey),
    );
    for (const violation of implied) {
      if (reported.has(violationKey(violation))) continue;
      errors.push(
        err(
          'E_WG_SEAM_AFTER_DEPENDENT',
          `seam ${violation.seam} does not schedule before ${violation.dependent}, and the `
            + 'document reports no violation for the pair',
          violation.seam + PAIR_SEPARATOR + violation.dependent,
        ),
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── honest gaps ─────────────────────────────────────────────────────────────
//
// What this module does NOT guarantee, stated plainly so a later reader does not
// assume more than it delivers:
//
//   - The parser is a line scanner, not an expression parser. It recognizes the
//     4 shapes this repo writes and names anything else dynamic. A require call
//     assembled from concatenated fragments is invisible to it and is not
//     reported as dynamic either, because nothing on the line looks like a call.
//   - The comment stripper tracks block state and string literals but has no
//     model of a regular expression literal. A regex containing the block
//     comment opener would confuse it. No source in this repo writes one.
//   - A specifier that appears inside a string literal is read as an import when
//     the surrounding text also looks like a require call. This is the price of
//     not writing an expression parser, and it is the direction that OVER
//     reports rather than the direction that manufactures a silent gap.
//   - The resolver has no opinion on whether a resolved file is reachable at
//     runtime. It answers only whether a path is in the injected set.
//   - The validator does not verify that a write lane matches what the plan
//     actually wrote. It reads the lane the document declares.
//   - The validator does not verify that an import edge reflects the tree at any
//     moment other than the scan that produced it.
//   - The validator has no opinion on whether a declared edge SHOULD exist. It
//     reports what the document says and whether the document is internally
//     consistent, which is a different and smaller claim.
//   - An unbacked verdict is a statement about the SCAN, not about intent. A
//     dependency carried by a shared runtime contract that neither plan names in
//     its write lane and neither file imports is invisible here and is reported
//     unbacked. That is the direction that prompts a human to name the reason.

export = {
  parseImportSources,
  foldSpecifier,
  resolveSpecifier,
  normalizePath,
  stripSourceComments,
  detectImpurity,
  splitLines,
  isInScanRoot,
  classifyEdges,
  computeSchedule,
  deriveSeamViolations,
  assembleWorkgraph,
  validateWorkgraph,
  err,
  WG_CODES,
  SCHEMA_VERSION,
  NODE_KINDS,
  VERDICTS,
  UNPROVEN_REASONS,
  IMPORT_FORMS,
  SOURCE_EXTENSIONS,
  FORBIDDEN_MODULE_IDS,
};
