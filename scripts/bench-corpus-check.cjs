#!/usr/bin/env node
'use strict';

/**
 * bench-corpus-check.cjs: Phase 22 of milestone v1.14 (Fleet Mode).
 *
 * The impure shell over the pure `bench-corpus` lib. It prints the
 * `bench-corpus/v1` index, and for every task that carries all 3 fixtures and a
 * hidden gate it runs 6 real gate invocations as child `python3` processes and
 * prints the discrimination record. For every task that does not, it prints the
 * coverage gap instead of a verdict.
 *
 * WHY THIS SCRIPT OWNS NO FILE AND APPEARS IN NO LINT CHAIN, which is a DECISION
 * and not an oversight, and it is the same decision `scripts/gen-workgraph.cjs`
 * states at its own head for the same reason. The corpus index is a derived
 * query over a directory. It changes the moment anyone adds a task, and a
 * committed snapshot with a `--check` link would turn `lint:ci` red on work that
 * is going perfectly well. So: no written artifact, no npm script alias, no
 * drift check. Do not add one out of habit.
 *
 * A COVERAGE GAP NEVER CHANGES THE EXIT CODE, with or without `--strict`. 7 of
 * the 12 inherited tasks carry no hidden gate. That is a finding about the
 * corpus, published rather than filled, and a checker that went red on it would
 * be switched off inside a week. `--strict` fires on a statement about the
 * corpus itself: a visible gate with no power, a task with no depth, a blocking
 * gap, or a gate that refused to report while every input it needed was present.
 *
 * NO NETWORK, NO KEY, NO MODEL. The only child process is the system `python3`,
 * running gates that already live in this repository. Absent `python3` the run
 * reports SKIPPED with a named reason and exits 0: it never reports a pass and
 * it never fails the run.
 *
 * CANDIDATE SOURCE IS NEVER EXECUTED BY THIS PROCESS. A candidate is only ever
 * passed as a path argument to a child `python3`. Nothing here requires,
 * imports or evaluates it.
 *
 * Usage:
 *   node scripts/bench-corpus-check.cjs             # print the report as indented JSON
 *   node scripts/bench-corpus-check.cjs --raw       # print it on 1 line
 *   node scripts/bench-corpus-check.cjs --strict    # exit 1 on a corpus level defect
 *   node scripts/bench-corpus-check.cjs --added=a,b # name the tasks this phase added
 *
 * FERROX_BENCH_CORPUS_ROOT overrides the corpus root. It exists so the tests can
 * drive every invocation against a scratch tree as a real child process rather
 * than depending on the committed corpus alone, matching the seam
 * `scripts/gen-workgraph.cjs` already uses.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CORPUS = path.join(REPO_ROOT, '.planning', 'bench-harness');
const CORPUS_ROOT = process.env.FERROX_BENCH_CORPUS_ROOT
  ? path.resolve(process.env.FERROX_BENCH_CORPUS_ROOT)
  : DEFAULT_CORPUS;
const LIB_PATH = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'bench-corpus.cjs');

/**
 * The base every emitted path is made relative to.
 *
 * The repository root when the corpus lives inside it, which is the real case
 * and gives repository relative paths. The corpus root itself when it does not,
 * which is the scratch tree case: relativising an external directory against
 * this repository would produce a `..` walk, and the lib refuses to emit one.
 */
const RELATIVE_BASE = CORPUS_ROOT === REPO_ROOT || CORPUS_ROOT.startsWith(REPO_ROOT + path.sep)
  ? REPO_ROOT
  : CORPUS_ROOT;

const INTERPRETER = 'python3';

/**
 * The 12 inherited task ids, named here rather than inferred.
 *
 * The pairing validator takes the set of tasks THIS PHASE ADDED as an injected
 * argument, and the contract forbids inferring that set from a date or a
 * filename. Naming the inherited floor explicitly is the injection: anything
 * outside this list is work this phase or a later one added, and its missing
 * fixtures are blocking rather than a coverage note. `--added` overrides the
 * derivation outright for a caller that wants to state the set directly.
 */
const INHERITED_TASKS = [
  'b64_strict',
  'csv_parse',
  'expr_interp',
  'jwt_alg',
  'parse_duration',
  'roman_parse',
  'safe_eval',
  'safe_redirect',
  'sanitize_path',
  'semver_cmp',
  'toposort',
  'url_canon',
];

const USAGE = [
  '  node scripts/bench-corpus-check.cjs',
  '  node scripts/bench-corpus-check.cjs --raw',
  '  node scripts/bench-corpus-check.cjs --strict',
  '  node scripts/bench-corpus-check.cjs --added=task-a,task-b',
].join('\n');

function loadLib() {
  try {
    return require(LIB_PATH);
  } catch {
    throw new ExitError(
      1,
      'ferrox-core/bin/lib/bench-corpus.cjs is missing. Run:\n  npm run build:lib',
    );
  }
}

/**
 * `runMain` passes NO arguments to main, so every flag is read from argv here.
 */
function readArgv(argv) {
  const added = [];
  for (const arg of argv) {
    if (!arg.startsWith('--added=')) continue;
    for (const id of arg.slice('--added='.length).split(',')) {
      if (id.trim() !== '') added.push(id.trim());
    }
  }
  return {
    raw: argv.includes('--raw'),
    strict: argv.includes('--strict'),
    added: added.length > 0 ? added : null,
    help: argv.includes('--help'),
  };
}

/** Whether a `python3` is reachable at all. Absent one, the run is SKIPPED. */
function probeInterpreter() {
  let result;
  try {
    result = spawnSync(INTERPRETER, ['--version'], { encoding: 'utf8' });
  } catch (error) {
    return { available: false, reason: String(error && error.message) };
  }
  if (result.error) {
    return {
      available: false,
      reason: `${INTERPRETER} could not be started: ${String(result.error.message)}`,
    };
  }
  if (result.status !== 0) {
    return {
      available: false,
      reason: `${INTERPRETER} --version exited ${String(result.status)}`,
    };
  }
  return { available: true, version: String(result.stdout || result.stderr || '').trim() };
}

/**
 * Run 1 gate against 1 candidate and return its stdout.
 *
 * Returns null when the process could not be started at all, which the pure
 * parser then never sees. A gate that ran and printed nothing usable returns its
 * text and is REFUSED by the parser, which is the difference that matters.
 */
function runGate(gatePath, candidatePath) {
  const result = spawnSync(INTERPRETER, [gatePath, candidatePath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) return null;
  return String(result.stdout || '');
}

function absolute(base, rel) {
  return rel === null ? null : path.resolve(base, rel);
}

/**
 * The discrimination record for 1 task, with the 6 gate invocations really run.
 */
function discriminateTask(lib, base, task) {
  const gate = absolute(base, task.gate);
  const hidden = absolute(base, task.hidden);
  const present = {
    reference: task.reference !== null,
    mutant: task.mutant !== null,
    shallow: task.shallow !== null,
    hidden: task.hidden !== null,
  };

  const capture = (fixtureRel) => {
    const fixture = absolute(base, fixtureRel);
    if (fixture === null || gate === null) return { gate: null, hidden: null };
    return {
      gate: runGate(gate, fixture),
      hidden: hidden === null ? null : runGate(hidden, fixture),
    };
  };

  return lib.discriminate({
    task: task.id,
    present,
    stdout: {
      reference: capture(task.reference),
      mutant: capture(task.mutant),
      shallow: capture(task.shallow),
    },
  });
}

/**
 * Every reason a strict run refuses, as printable lines.
 *
 * 4 reasons, and no others. A `coverage` gap is deliberately not among them.
 */
function strictReasons(report) {
  const reasons = [];
  for (const gap of report.index.gaps) {
    if (gap.severity !== 'blocking') continue;
    reasons.push(`  [E_BENCH_BLOCKING_GAP] ${gap.task} lacks its ${gap.missing}`);
  }
  for (const record of report.discrimination) {
    if (record.verdict === 'gate-cannot-fire') {
      reasons.push(`  [E_BENCH_GATE_CANNOT_FIRE] ${record.task}: ${record.reasons.join('; ')}`);
    }
    if (record.verdict === 'no-depth') {
      reasons.push(`  [E_BENCH_NO_DEPTH] ${record.task}: ${record.reasons.join('; ')}`);
    }
    // An `incomplete` verdict on a task whose fixtures and hidden gate were ALL
    // present can only mean a gate refused to report. That is a statement about
    // the corpus, so it refuses. An `incomplete` caused by an absent artifact is
    // a coverage note and stays green, which is the whole point of the split.
    if (record.verdict === 'incomplete' && record.equipped === true) {
      reasons.push(`  [E_BENCH_GATE_REFUSED] ${record.task}: ${record.reasons.join('; ')}`);
    }
  }
  return reasons;
}

function buildReport(lib, argv) {
  const first = lib.indexCorpus({ root: CORPUS_ROOT, repoRoot: RELATIVE_BASE, addedTasks: [] });
  if (!first.ok) {
    throw new ExitError(1, first.errors.map((e) => `[${e.code}] ${e.message}`).join('\n'));
  }

  const inherited = new Set(INHERITED_TASKS);
  const added = argv.added !== null
    ? argv.added
    : first.index.tasks.map((t) => t.id).filter((id) => !inherited.has(id));

  const scan = lib.indexCorpus({
    root: CORPUS_ROOT,
    repoRoot: RELATIVE_BASE,
    addedTasks: added,
  });
  if (!scan.ok) {
    throw new ExitError(1, scan.errors.map((e) => `[${e.code}] ${e.message}`).join('\n'));
  }

  const interpreter = probeInterpreter();
  const equipped = scan.index.tasks.filter(
    (t) => t.gate !== null && t.hidden !== null
      && t.reference !== null && t.mutant !== null && t.shallow !== null,
  );

  const discrimination = [];
  if (interpreter.available) {
    for (const task of scan.index.tasks) {
      const record = discriminateTask(lib, RELATIVE_BASE, task);
      record.equipped = equipped.some((t) => t.id === task.id);
      discrimination.push(record);
    }
  }

  return {
    schema: 'bench-corpus-check/v1',
    interpreter: interpreter.available
      ? { status: 'available', detail: interpreter.version }
      : { status: 'SKIPPED', detail: interpreter.reason },
    added_tasks: added.slice().sort(),
    index: scan.index,
    coverage_report: {
      tasks: scan.index.coverage.tasks,
      hidden_gate_coverage: `${scan.index.coverage.with_hidden} of ${scan.index.coverage.tasks}`,
      missing_hidden: scan.index.coverage.missing_hidden,
      fully_equipped: equipped.map((t) => t.id),
      coverage_gaps: scan.index.gaps.filter((g) => g.severity === 'coverage'),
      blocking_gaps: scan.index.gaps.filter((g) => g.severity === 'blocking'),
    },
    discrimination,
  };
}

function main() {
  const argv = readArgv(process.argv.slice(2));
  if (argv.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const lib = loadLib();
  const report = buildReport(lib, argv);

  process.stdout.write(
    `${argv.raw ? JSON.stringify(report) : JSON.stringify(report, null, 2)}\n`,
  );

  if (report.interpreter.status === 'SKIPPED') {
    // Never a pass and never a failure. A reader must be able to tell a
    // measurement that was not taken from one that came back empty.
    process.stderr.write(
      `SKIPPED: no ${INTERPRETER} is reachable, so no gate was run and no `
        + `discrimination verdict was computed. Reason: ${report.interpreter.detail}\n`,
    );
    return;
  }

  if (!argv.strict) return;

  const reasons = strictReasons(report);
  if (reasons.length === 0) return;

  // The report already reached stdout above, on purpose. A consumer that asked
  // for the data and got only an exit code has to run the command a second time
  // to find out what was wrong.
  process.stderr.write(
    'the corpus does not satisfy the strict discrimination contract:\n'
      + `${reasons.join('\n')}\n`
      + 'Fix: repair the named fixture or gate, then run:\n'
      + '  node scripts/bench-corpus-check.cjs --strict\n',
  );
  return 1;
}

if (require.main === module) runMain(main);

module.exports = { readArgv, strictReasons, INHERITED_TASKS };
