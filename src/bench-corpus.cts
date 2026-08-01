/**
 * bench-corpus: the benchmark corpus as a derived document.
 *
 * Phase 22 of milestone v1.14 (Fleet Mode). Answers 3 questions about the
 * corpus under `.planning/bench-harness/`, and 1 question about the corpus as a
 * whole:
 *
 *   1. WHAT IS IN IT. `indexCorpus` scans a tree handed in as an argument and
 *      emits the `bench-corpus/v1` document: every task, every artifact path it
 *      has, every artifact it lacks, and a hash that identifies the work a lane
 *      was asked to do.
 *   2. DID A GATE ACTUALLY REPORT. `parseGateScore` reads 1 gate invocation's
 *      stdout and returns a score or a REFUSAL.
 *   3. CAN THE GATE FIRE. `discriminate` folds 6 captured stdout strings into 1
 *      of 4 verdicts using the 3 fixture discipline.
 *   4. CAN THE CORPUS SEPARATE ANYTHING. `detectSaturation` reports a score set
 *      on which every observation is full, which is the recorded v1.6 outcome
 *      and the condition under which a benchmark can discriminate only on cost.
 *
 * WHY THIS OWNS NO COMMITTED MANIFEST, which is a DECISION and not an oversight.
 * `scripts/gen-workgraph.cjs:12-21` argues the same case for the same reason: a
 * derived query over files changes the moment anyone edits an input, and a
 * committed snapshot with a drift check would turn `lint:ci` red on work that is
 * going perfectly well. The corpus index has that shape. It answers a question;
 * it is not a governed surface with a right answer at rest. The consequence is
 * the point: with no committed manifest there is no shared file between the
 * plans that extend the corpus, so they run in 1 wave instead of queueing.
 *
 * HERMETIC IN THE SENSE THAT MATTERS HERE. This module reads the filesystem,
 * because a corpus index is a query over a tree. It takes that tree as an
 * argument, resolves no repository root of its own, reads no configuration,
 * spawns no child process, owns no stdout and never imports, evaluates or
 * requires a benchmark candidate. Running a gate belongs to
 * `scripts/bench-corpus-check.cjs`; the verdict logic here takes already
 * captured text, which is what lets the whole of it be tested at the byte level
 * with no Python involved.
 *
 * SORTING IS EXPLICIT AT EVERY LIST. `readdirSync` order is never trusted, so 2
 * scans of the same tree emit the same bytes on any platform.
 *
 * A SCORE OF 0 AND A GATE THAT NEVER REPORTED ARE DIFFERENT CLAIMS. The 12
 * inherited gates print `gate: 0/18` deliberately when they cannot load the
 * candidate, and that is a legitimate score of 0. A gate that crashed prints no
 * summary line at all. The 2 cases are 1 line apart in the output and opposite
 * in meaning, so the parser refuses the second and scores the first.
 *
 * ADR-457 build-at-publish: compiles to ferrox-core/bin/lib/bench-corpus.cjs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ─── the vocabulary ──────────────────────────────────────────────────────────

const SCHEMA = 'bench-corpus/v1';

/** The corpus subdirectories, named once. */
const DIR_SPECS = 'specs';
const DIR_GATES = 'gates';
const DIR_HIDDEN = 'hidden';
const DIR_REFERENCE = 'reference';
const DIR_MUTANT = 'mutant';
const DIR_SHALLOW = 'shallow';
const DIR_MULTI = 'multi';

/** The 4 file names inside a multi file task directory. */
const MULTI_SPEC = 'SPEC.md';
const MULTI_GATE = 'gate.py';
const MULTI_HIDDEN = 'hidden.py';
const MULTI_STRUCTURE = 'structure.json';

const SPEC_SUFFIX = '.md';
const GATE_SUFFIX = '.py';

/**
 * The artifacts the hash digests. Fixtures are DELIBERATELY absent: they
 * validate gates and are never built by a lane, so editing one must not
 * invalidate a comparison between 2 arms. That exclusion is T-22-01-04.
 */
const HASHED_KINDS = ['spec', 'gate', 'hidden', 'structure'] as const;

/** Every artifact a task can carry, in the order gaps are reported. */
const ARTIFACT_KINDS = [
  'spec',
  'gate',
  'structure',
  'hidden',
  'reference',
  'mutant',
  'shallow',
] as const;

/** Artifacts without which a task is not a task, whoever authored it. */
const ALWAYS_BLOCKING = ['spec', 'gate', 'structure'] as const;

/** The summary line 1 gate invocation prints as its last line. */
const SUMMARY_SHAPE = /^(gate|hidden):\s*(\d+)\s*\/\s*(\d+)\s*$/;

/** The per check failure lines. The visible gates print 1, the hidden gates the other. */
const FAILURE_SHAPE = /^H?FAIL\s+(.*)$/;

/** How many lines of unreadable output a refusal quotes back. */
const REFUSAL_CONTEXT_LINES = 3;

const E_ROOT_MISSING = 'E_BENCH_CORPUS_ROOT_MISSING';
const E_DUPLICATE_TASK = 'E_BENCH_CORPUS_DUPLICATE_TASK';
const E_NO_SUMMARY = 'E_BENCH_GATE_NO_SUMMARY';
const E_ZERO_TOTAL = 'E_BENCH_GATE_ZERO_TOTAL';
const E_IMPOSSIBLE_SCORE = 'E_BENCH_GATE_IMPOSSIBLE_SCORE';

// ─── types ───────────────────────────────────────────────────────────────────

type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
type Axis = 'gate' | 'hidden';
type Severity = 'coverage' | 'blocking';
type TaskKind = 'single' | 'multi';

interface CorpusError {
  ok: false;
  code: string;
  message: string;
  task?: string;
}

interface Structure {
  task: string;
  files: string[];
  edges: string[][];
  seam: string[];
  depth: number;
  permitted_width: number;
}

interface Task {
  id: string;
  kind: TaskKind;
  spec: string | null;
  gate: string | null;
  hidden: string | null;
  reference: string | null;
  mutant: string | null;
  shallow: string | null;
  structure: Structure | null;
}

interface Gap {
  task: string;
  missing: ArtifactKind;
  severity: Severity;
}

interface Coverage {
  tasks: number;
  with_hidden: number;
  with_reference: number;
  with_mutant: number;
  with_shallow: number;
  missing_hidden: string[];
}

interface CorpusIndex {
  schema: string;
  root: string;
  tasks: Task[];
  coverage: Coverage;
  gaps: Gap[];
  corpus_hash: string;
}

interface IndexResult {
  ok: boolean;
  index: CorpusIndex | null;
  errors: CorpusError[];
}

interface Score {
  ok: true;
  axis: Axis;
  passed: number;
  total: number;
  pct: number;
  failures: string[];
}

interface Refusal {
  ok: false;
  axis: Axis;
  code: string;
  message: string;
}

type ScoreResult = Score | Refusal;

interface AxisPair {
  gate: string | null;
  hidden: string | null;
}

interface Presence {
  reference: boolean;
  mutant: boolean;
  shallow: boolean;
  hidden: boolean;
}

interface ScoredPair {
  gate: ScoreResult | null;
  hidden: ScoreResult | null;
}

interface Discrimination {
  task: string;
  reference: ScoredPair;
  mutant: ScoredPair;
  shallow: ScoredPair;
  verdict: 'discriminating' | 'gate-cannot-fire' | 'no-depth' | 'incomplete';
  reasons: string[];
}

interface Saturation {
  axis: Axis;
  n: number;
  full: number;
  distinct_pct: number;
  verdict: 'discriminating' | 'saturated';
  note: string;
}

function err(code: string, message: string, task?: string): CorpusError {
  const e: CorpusError = { ok: false, code, message };
  if (typeof task === 'string' && task !== '') e.task = task;
  return e;
}

// ─── filesystem helpers ──────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Sorted directory entries. `readdirSync` order is never trusted. */
function listSorted(dir: string): string[] {
  if (!isDir(dir)) return [];
  try {
    return fs.readdirSync(dir).slice().sort();
  } catch {
    return [];
  }
}

/**
 * A path relative to the relativisation base, with forward slash separators.
 *
 * T-22-01-06: no absolute path ever reaches the document. A path that escapes
 * the base is returned as its basename rather than as a `..` walk, because a
 * document that names a directory above the repository is exactly the leak this
 * guards against.
 */
function relative(base: string, full: string): string {
  const rel = path.relative(base, full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(full);
  return rel.split(path.sep).join('/');
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ─── the scanner ─────────────────────────────────────────────────────────────

/**
 * Parse a multi file task's `structure.json`.
 *
 * Returns null when the file is absent, will not parse, or carries no `files`
 * array. An absent structure must NEVER read as a structure with 0 files: the
 * first is a gap to report, the second is a claim that the task has no files.
 */
function readStructure(file: string): Structure | null {
  if (!isFile(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.files)) return null;
  const strings = (v: unknown): string[] =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').slice().sort();
  const edges = (Array.isArray(o.edges) ? o.edges : [])
    .filter((e): e is string[] => Array.isArray(e) && e.every((x) => typeof x === 'string'))
    .map((e) => e.slice())
    .sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : a.join('\u0000') > b.join('\u0000') ? 1 : 0));
  return {
    task: typeof o.task === 'string' ? o.task : '',
    files: strings(o.files),
    edges,
    seam: strings(o.seam),
    depth: typeof o.depth === 'number' ? o.depth : 0,
    permitted_width: typeof o.permitted_width === 'number' ? o.permitted_width : 0,
  };
}

function scanSingleTasks(root: string, base: string): Task[] {
  const tasks: Task[] = [];
  for (const name of listSorted(path.join(root, DIR_SPECS))) {
    if (!name.endsWith(SPEC_SUFFIX)) continue;
    const id = name.slice(0, -SPEC_SUFFIX.length);
    if (id === '') continue;
    const sibling = (dir: string): string | null => {
      const full = path.join(root, dir, `${id}${GATE_SUFFIX}`);
      return isFile(full) ? relative(base, full) : null;
    };
    tasks.push({
      id,
      kind: 'single',
      spec: relative(base, path.join(root, DIR_SPECS, name)),
      gate: sibling(DIR_GATES),
      hidden: sibling(DIR_HIDDEN),
      reference: sibling(DIR_REFERENCE),
      mutant: sibling(DIR_MUTANT),
      shallow: sibling(DIR_SHALLOW),
      structure: null,
    });
  }
  return tasks;
}

function scanMultiTasks(root: string, base: string): Task[] {
  const tasks: Task[] = [];
  const multiRoot = path.join(root, DIR_MULTI);
  for (const id of listSorted(multiRoot)) {
    const dir = path.join(multiRoot, id);
    if (!isDir(dir)) continue;
    const member = (name: string): string | null => {
      const full = path.join(dir, name);
      return isFile(full) ? relative(base, full) : null;
    };
    const fixtureDir = (name: string): string | null => {
      const full = path.join(dir, name);
      return isDir(full) ? relative(base, full) : null;
    };
    tasks.push({
      id,
      kind: 'multi',
      spec: member(MULTI_SPEC),
      gate: member(MULTI_GATE),
      hidden: member(MULTI_HIDDEN),
      reference: fixtureDir(DIR_REFERENCE),
      mutant: fixtureDir(DIR_MUTANT),
      shallow: fixtureDir(DIR_SHALLOW),
      structure: readStructure(path.join(dir, MULTI_STRUCTURE)),
    });
  }
  return tasks;
}

// ─── the pairing validator ───────────────────────────────────────────────────

/**
 * 1 gap row per missing artifact.
 *
 * The severity distinction is the whole point and it is carried by an INJECTED
 * set of task ids this phase added, never inferred from a date or a filename. An
 * inherited task with no hidden gate is a finding about the corpus. The same
 * absence on a task this phase added is a defect in this phase's work. A
 * validator that reported 1 severity for both would either turn the checker red
 * on the inherited floor, which gets the checker switched off, or stay green on
 * a defect, which is worse.
 */
function findGaps(tasks: Task[], added: Set<string>): Gap[] {
  const gaps: Gap[] = [];
  for (const t of tasks) {
    for (const kind of ARTIFACT_KINDS) {
      if (kind === 'structure' && t.kind !== 'multi') continue;
      const value = kind === 'structure' ? t.structure : t[kind];
      if (value !== null) continue;
      const severity: Severity =
        (ALWAYS_BLOCKING as readonly string[]).includes(kind) || added.has(t.id)
          ? 'blocking'
          : 'coverage';
      gaps.push({ task: t.id, missing: kind, severity });
    }
  }
  return gaps.slice().sort((a, b) => {
    if (a.task !== b.task) return a.task < b.task ? -1 : 1;
    return ARTIFACT_KINDS.indexOf(a.missing) - ARTIFACT_KINDS.indexOf(b.missing);
  });
}

function summarise(tasks: Task[]): Coverage {
  const count = (pick: (t: Task) => unknown): number =>
    tasks.filter((t) => pick(t) !== null).length;
  return {
    tasks: tasks.length,
    with_hidden: count((t) => t.hidden),
    with_reference: count((t) => t.reference),
    with_mutant: count((t) => t.mutant),
    with_shallow: count((t) => t.shallow),
    missing_hidden: tasks
      .filter((t) => t.hidden === null)
      .map((t) => t.id)
      .slice()
      .sort(),
  };
}

/**
 * The hash that identifies a corpus.
 *
 * It exists for 1 reason: 2 arms of a benchmark can only be compared if they ran
 * the identical corpus. It digests only the artifacts a lane is asked to satisfy
 * (T-22-01-03), and is blind to the fixtures that validate the gates
 * (T-22-01-04).
 */
function hashCorpus(root: string, base: string, tasks: Task[]): string {
  const lines: string[] = [];
  for (const t of tasks) {
    for (const kind of HASHED_KINDS) {
      let rel: string | null = null;
      if (kind === 'structure') {
        rel = t.kind === 'multi' && t.structure !== null
          ? relative(base, path.join(root, DIR_MULTI, t.id, MULTI_STRUCTURE))
          : null;
      } else {
        rel = t[kind];
      }
      if (rel === null) continue;
      const full = path.resolve(base, rel);
      if (!isFile(full)) continue;
      lines.push(`${rel}:${sha256(fs.readFileSync(full))}`);
    }
  }
  return sha256(lines.slice().sort().join('\n'));
}

/**
 * The `bench-corpus/v1` document for 1 corpus tree.
 *
 * `root` is the corpus tree and is REQUIRED. `repoRoot` is the base every path
 * is made relative to and defaults to `root`, so a test can pin both to a
 * scratch directory and a caller can emit repository relative paths. Neither is
 * resolved from the environment, from a configuration file or from `__dirname`.
 */
function indexCorpus(options: unknown): IndexResult {
  const o = (options === null || typeof options !== 'object' ? {} : options) as Record<string, unknown>;
  const root = typeof o.root === 'string' ? o.root : '';
  const base = typeof o.repoRoot === 'string' && o.repoRoot !== '' ? o.repoRoot : root;
  const added = new Set(
    (Array.isArray(o.addedTasks) ? o.addedTasks : []).filter((x): x is string => typeof x === 'string'),
  );

  if (root === '' || !isDir(root)) {
    return {
      ok: false,
      index: null,
      errors: [
        err(
          E_ROOT_MISSING,
          `the corpus root ${JSON.stringify(root)} is not a directory, so there is nothing to `
            + 'index. An absent corpus is an error rather than a corpus with 0 tasks.',
        ),
      ],
    };
  }

  const singles = scanSingleTasks(root, base);
  const multis = scanMultiTasks(root, base);

  const errors: CorpusError[] = [];
  const singleIds = new Set(singles.map((t) => t.id));
  for (const m of multis) {
    if (!singleIds.has(m.id)) continue;
    errors.push(
      err(
        E_DUPLICATE_TASK,
        `the task id ${JSON.stringify(m.id)} appears under both ${DIR_SPECS}/ and `
          + `${DIR_MULTI}/. 2 tasks with 1 id cannot be scored apart, so this is an error `
          + 'rather than a merge. Rename one of them.',
        m.id,
      ),
    );
  }
  if (errors.length > 0) return { ok: false, index: null, errors };

  const tasks = singles.concat(multis).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    ok: true,
    index: {
      schema: SCHEMA,
      root: relative(base, root),
      tasks,
      coverage: summarise(tasks),
      gaps: findGaps(tasks, added),
      corpus_hash: hashCorpus(root, base, tasks),
    },
    errors: [],
  };
}

// ─── the gate score parser ───────────────────────────────────────────────────

/**
 * Read 1 gate invocation's stdout into a score, or REFUSE.
 *
 * 3 rules, and each of them exists because of a specific way a benchmark lies to
 * itself:
 *
 *   - The LAST matching summary line wins (T-22-01-02). A failure description
 *     that happens to carry the summary shape must not shift the score, and a
 *     first match parser is the natural mistake.
 *   - No summary line at all is a REFUSAL naming the axis and quoting what it
 *     did read, so a gate that crashed is diagnosable rather than silent.
 *   - A total of 0 is a REFUSAL (T-22-01-01). A score out of 0 is not a score,
 *     and it is the exact shape a broken gate produces. `gate: 0/18` is a
 *     legitimate score of 0 and is NOT refused: the 2 are 1 character apart and
 *     they mean opposite things.
 */
function parseGateScore(text: unknown, axis: unknown): ScoreResult {
  const wanted: Axis = axis === 'hidden' ? 'hidden' : 'gate';
  const raw = typeof text === 'string' ? text : '';
  const lines = raw.split(/\r?\n/);

  const failures: string[] = [];
  let last: { passed: number; total: number } | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const fail = FAILURE_SHAPE.exec(trimmed);
    if (fail !== null) {
      failures.push(fail[1]);
      continue;
    }
    const m = SUMMARY_SHAPE.exec(trimmed);
    if (m === null || m[1] !== wanted) continue;
    last = { passed: Number(m[2]), total: Number(m[3]) };
  }

  if (last === null) {
    const head = lines
      .filter((l) => l.trim() !== '')
      .slice(0, REFUSAL_CONTEXT_LINES)
      .join(' | ');
    return {
      ok: false,
      axis: wanted,
      code: E_NO_SUMMARY,
      message:
        `no \`${wanted}: N/M\` summary line was printed, so this invocation reported no score at `
        + 'all. A gate that crashed is not a score of 0. It read: '
        + (head === '' ? '(nothing)' : JSON.stringify(head)),
    };
  }

  if (last.total === 0) {
    return {
      ok: false,
      axis: wanted,
      code: E_ZERO_TOTAL,
      message:
        `the summary line reported \`${wanted}: ${last.passed}/0\`. A score out of 0 is not a `
        + 'score, it is the shape a gate with no checks produces.',
    };
  }

  if (last.passed > last.total) {
    return {
      ok: false,
      axis: wanted,
      code: E_IMPOSSIBLE_SCORE,
      message:
        `the summary line reported \`${wanted}: ${last.passed}/${last.total}\`, and more checks `
        + 'cannot pass than were run.',
    };
  }

  return {
    ok: true,
    axis: wanted,
    passed: last.passed,
    total: last.total,
    pct: Math.round((last.passed / last.total) * 1000) / 10,
    failures,
  };
}

function isFull(s: ScoreResult | null): boolean {
  return s !== null && s.ok === true && s.passed === s.total;
}

function describe(label: string, s: ScoreResult | null): string {
  if (s === null) return `${label} did not run`;
  if (s.ok === false) return `${label} refused: ${s.message}`;
  return `${label} scored ${s.passed} of ${s.total}`;
}

// ─── the discrimination record ───────────────────────────────────────────────

/**
 * Fold 6 captured stdout strings into 1 of 4 verdicts.
 *
 * PURE. It runs nothing. Candidate source is only ever executed by a child
 * `python3` in `scripts/bench-corpus-check.cjs` (T-22-01-05), and this function
 * never sees a path, only text somebody else captured.
 *
 * `gate-cannot-fire` and `no-depth` are DISTINCT verdicts because they are
 * distinct defects. The first says the visible gate has no power against a known
 * bad candidate. The second says nothing the hidden gate asks lies beyond the
 * visible gate, so the task cannot produce spread whatever the gate does.
 */
function discriminate(input: unknown): Discrimination {
  const o = (input === null || typeof input !== 'object' ? {} : input) as Record<string, unknown>;
  const task = typeof o.task === 'string' ? o.task : '';
  const stdout = (o.stdout === null || typeof o.stdout !== 'object' ? {} : o.stdout) as Record<string, unknown>;
  const presentRaw = (o.present === null || typeof o.present !== 'object' ? {} : o.present) as Record<string, unknown>;

  const pairOf = (name: string): AxisPair => {
    const p = (stdout[name] === null || typeof stdout[name] !== 'object' ? {} : stdout[name]) as Record<string, unknown>;
    return {
      gate: typeof p.gate === 'string' ? p.gate : null,
      hidden: typeof p.hidden === 'string' ? p.hidden : null,
    };
  };

  const present: Presence = {
    reference: presentRaw.reference !== false,
    mutant: presentRaw.mutant !== false,
    shallow: presentRaw.shallow !== false,
    hidden: presentRaw.hidden !== false,
  };

  const scoreOf = (p: AxisPair): ScoredPair => ({
    gate: p.gate === null ? null : parseGateScore(p.gate, 'gate'),
    hidden: p.hidden === null ? null : parseGateScore(p.hidden, 'hidden'),
  });

  const reference = scoreOf(pairOf('reference'));
  const mutant = scoreOf(pairOf('mutant'));
  const shallow = scoreOf(pairOf('shallow'));

  const record = (verdict: Discrimination['verdict'], reasons: string[]): Discrimination => ({
    task,
    reference,
    mutant,
    shallow,
    verdict,
    reasons,
  });

  // 1. Absence. A missing fixture or a missing hidden gate is not a verdict
  //    about the gate, it is a statement that the question was not asked.
  const absent: string[] = [];
  if (!present.reference) absent.push('the reference fixture is absent');
  if (!present.mutant) absent.push('the mutant fixture is absent');
  if (!present.shallow) absent.push('the shallow fixture is absent');
  if (!present.hidden) absent.push('the hidden gate is absent, so shallow is undefined for this task');
  if (absent.length > 0) return record('incomplete', absent);

  // 2. A refusal anywhere. A crashed gate cannot certify anything.
  const refusals = [
    ['reference visible', reference.gate],
    ['reference hidden', reference.hidden],
    ['mutant visible', mutant.gate],
    ['mutant hidden', mutant.hidden],
    ['shallow visible', shallow.gate],
    ['shallow hidden', shallow.hidden],
  ]
    .filter(([, s]) => s === null || (s as ScoreResult).ok === false)
    .map(([label, s]) => describe(label as string, s as ScoreResult | null));
  if (refusals.length > 0) return record('incomplete', refusals);

  // 3. The 2 named defects, checked before the pass, so a corpus cannot be
  //    called discriminating while carrying one.
  if (isFull(mutant.gate)) {
    return record('gate-cannot-fire', [
      `the mutant scored full on the visible axis (${describe('mutant visible', mutant.gate)}), so `
        + 'the visible gate has no power against a known bad candidate',
    ]);
  }
  if (isFull(shallow.gate) && isFull(shallow.hidden)) {
    return record('no-depth', [
      'the shallow fixture scored full on BOTH axes, so nothing the hidden gate asks lies beyond '
        + 'the visible gate and this task cannot produce spread',
    ]);
  }

  // 4. The pass, and every way of falling short of it, named.
  const shortfalls: string[] = [];
  if (!isFull(reference.gate)) shortfalls.push(describe('the reference on the visible axis', reference.gate) + ', and a reference must score full');
  if (!isFull(reference.hidden)) shortfalls.push(describe('the reference on the hidden axis', reference.hidden) + ', and a reference must score full');
  if (!isFull(shallow.gate)) {
    shortfalls.push(
      describe('the shallow fixture on the visible axis', shallow.gate)
        + ', so it is a second mutant rather than a hardness proof',
    );
  }
  if (shortfalls.length > 0) return record('incomplete', shortfalls);

  return record('discriminating', [
    describe('reference visible', reference.gate),
    describe('reference hidden', reference.hidden),
    describe('mutant visible', mutant.gate),
    describe('shallow visible', shallow.gate),
    describe('shallow hidden', shallow.hidden),
  ]);
}

// ─── the saturation detector ─────────────────────────────────────────────────

/**
 * Report a score set that cannot separate anything.
 *
 * This is D13 item 4. The recorded failure of the v1.6 shootout is that every
 * lane scored 100 percent on the visible gate, so the benchmark could
 * discriminate only on cost. `saturated` fires when every observation is full,
 * or when every observation carries the identical percentage whatever that
 * percentage is.
 *
 * A SINGLE OBSERVATION IS NEVER CALLED SATURATED. 1 score has no distribution,
 * and calling it saturated would let a detector fire on a corpus nobody has run
 * twice.
 */
function detectSaturation(input: unknown): Saturation {
  const o = (input === null || typeof input !== 'object' ? {} : input) as Record<string, unknown>;
  const axis: Axis = o.axis === 'hidden' ? 'hidden' : 'gate';
  const pcts = (Array.isArray(o.pcts) ? o.pcts : []).filter(
    (x): x is number => typeof x === 'number' && Number.isFinite(x),
  );
  const n = pcts.length;
  const full = pcts.filter((p) => p >= 100).length;
  const distinct = new Set(pcts).size;

  if (n < 2) {
    return {
      axis,
      n,
      full,
      distinct_pct: distinct,
      verdict: 'discriminating',
      note:
        `${n} observation${n === 1 ? '' : 's'} on the ${axis} axis has no distribution, so `
        + 'saturation is not claimed. Saturation needs at least 2 observations.',
    };
  }

  if (full === n) {
    return {
      axis,
      n,
      full,
      distinct_pct: distinct,
      verdict: 'saturated',
      note:
        `all ${n} observations scored full on the ${axis} axis. This axis is SATURATED and NON `
        + 'DISCRIMINATING: it separates nothing, and any comparison drawn from it rests on some '
        + 'other number. This is the recorded v1.6 outcome.',
    };
  }

  if (distinct === 1) {
    return {
      axis,
      n,
      full,
      distinct_pct: distinct,
      verdict: 'saturated',
      note:
        `all ${n} observations carry the identical percentage ${pcts[0]} on the ${axis} axis. `
        + 'This axis is SATURATED and NON DISCRIMINATING even though it is not at full.',
    };
  }

  return {
    axis,
    n,
    full,
    distinct_pct: distinct,
    verdict: 'discriminating',
    note:
      `${full} of ${n} observations scored full on the ${axis} axis across ${distinct} distinct `
      + 'percentages, so the axis separates at least 2 candidates.',
  };
}

// ─── honest gaps ─────────────────────────────────────────────────────────────
//
// What this module does NOT do, stated plainly so a later reader does not assume
// more than it delivers:
//
//   - It has no opinion on whether a task is WORTH running. It reports what the
//     corpus contains and whether the gates can fire; it cannot tell an easy
//     task from a hard one except through the shallow fixture, which is exactly
//     why the shallow fixture exists.
//   - It never runs a gate. Every score it folds was captured by somebody else,
//     so a caller that captured stderr instead of stdout gets refusals rather
//     than wrong numbers, which is the intended failure direction.
//   - It does not verify that a reference fixture is the code a record claims.
//     Provenance is carried in each fixture's header comment and is a human
//     readable claim, not a checked one.
//   - `corpus_hash` proves 2 corpora are byte identical in the artifacts a lane
//     must satisfy. It proves nothing about the lane, the model or the runner.
//   - The saturation detector reads a list of numbers. Which observations belong
//     in 1 cohort is the caller's judgment, and the answer changes with it: the
//     same 18 archived percentages are non saturated as 1 pool and saturated on
//     3 of the 5 tasks when grouped per task. Both readings are reported rather
//     than 1 being chosen silently.

export = {
  indexCorpus,
  parseGateScore,
  discriminate,
  detectSaturation,
  SCHEMA,
  ARTIFACT_KINDS,
  HASHED_KINDS,
  E_ROOT_MISSING,
  E_DUPLICATE_TASK,
  E_NO_SUMMARY,
  E_ZERO_TOTAL,
  E_IMPOSSIBLE_SCORE,
};
