#!/usr/bin/env node
'use strict';

/**
 * lint-antiloop-gate.cjs: Phase 15 of milestone v1.14 (Fleet Mode).
 *
 * THE 3 ANTI-LOOP RULES AS A NON-ZERO EXIT CODE. Plan 01 built an append-only event log
 * and a hermetic fold; plan 02 gave them CLI verbs. Neither of those fails a build. D4
 * says that if it is not enforced by an artifact that fails closed it does not count as
 * delivered, so this script is where the 3 rules acquire a real exit code, wired as the
 * terminal link of `lint:ci`.
 *
 * WHY: on 2026-07-25 all 4 anti-loop mechanisms in this repository were prose, and they
 * failed to stop a live loop in this very tree. A rule an agent can read and then not
 * follow is not a mechanism.
 *
 * THIS SCRIPT FORMATS AND EXITS. THE FOLD DECIDES. Every rule is applied through
 * `ferrox-core/bin/lib/antiloop-gate.cjs` and none of them is re-implemented here. A
 * second implementation of a rule is a second thing to drift.
 *
 * ---------------------------------------------------------------------------
 * THE SUBJECT PREDICATE IS PINNED, AND IT IS LOAD BEARING
 * ---------------------------------------------------------------------------
 * A phase CONTEXT is a subject of this gate if and only if it contains the exact
 * case-insensitive phrase `anti-loop governance`. It is NOT the looser `anti-loop`.
 * Measured on the live tree when this landed: the exact phrase selects 1 committed file
 * and the looser one selects 5, of which 4 carry no budget sentence at all. The looser
 * predicate would turn `lint:ci` red the moment this link landed, on 4 historical files
 * this phase never promised to bring into compliance. That is the wave-ordering failure
 * `scripts/lint-governance-scope.cjs:59-61` exists to prevent, caused by the gate rather
 * than prevented by it.
 *
 * `--print-subject-count` exists so a committed criterion can ASSERT the count rather
 * than report it. Exit 0 on a gate that selected zero subjects is indistinguishable from
 * exit 0 on a gate that checked real work.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DEFAULT RUN HAS 2 SUBJECTS AND NOT 1
 * ---------------------------------------------------------------------------
 * The event log at `.planning/antiloop-log.jsonl` is GITIGNORED local run evidence, of
 * the same class as the halting log. In continuous integration it is normally absent, and
 * a gate whose only subject is an absent file exits 0 forever and proves nothing. So the
 * default run also scans the committed phase directories for every CONTEXT that declares
 * anti-loop governance and requires each one to carry a budget sentence the plan 01
 * parser accepts. Those declarations are the subject that always exists.
 *
 * ---------------------------------------------------------------------------
 * NO WAIVER OF ANY KIND
 * ---------------------------------------------------------------------------
 * There is no skip list, no fence array, no exemption constant and no environment
 * variable that turns a rule off. A committed test greps this source for a bypass-shaped
 * DECLARATION rather than for the plain words, so this paragraph cannot trip the check
 * that enforces it.
 *
 * FERROX_ANTILOOP_GATE_ROOT overrides the project root. IT MOVES WHERE THE GATE LOOKS
 * AND NEVER WHETHER IT ENFORCES, and the 2 are easy to conflate while only 1 of them is
 * safe. It exists so the tests drive every invocation against a scratch tree as a real
 * child process instead of mutating committed files, matching the seam
 * `scripts/lint-governance-scope.cjs:81-86` already uses. The built-lib path is
 * deliberately NOT overridden by it, which is what lets the missing-build guard be
 * exercised by copying this script alone.
 *
 * ---------------------------------------------------------------------------
 * THE COMPOSITION WITH THE STRENGTH GATE (D8, quoted verbatim from the plan 01 header at
 * src/antiloop-gate.cts:49-73 rather than paraphrased, so the 2 files cannot drift on the
 * 1 point CONTEXT says must not be inferred)
 * ---------------------------------------------------------------------------
 * The 2 gates answer 2 different questions and neither supersedes the other.
 *
 * The strength gate at `src/strength-severity-route.cts` asks whether a finding
 * may be DEFERRED to the backlog. For a security-category finding the answer is
 * no, at any severity. That is requirement STRONG-04, it returns a block decision
 * with the reason security-never-backlog at `src/strength-severity-route.cts:77-81`,
 * and this phase does not touch it.
 *
 * This module asks whether a review round may BLOCK further progress. The answer
 * is only when the finding carries a command that failed at the moment it was
 * filed. Severity buys nothing here, in either direction.
 *
 * The concrete consequence, implemented by `evaluateBudgetSpentDisposition`: when
 * a budget is spent the disposition sweeps the remaining findings into backlog
 * rows regardless of severity, and that sweep MUST NOT swallow a
 * security-category finding. A remaining security finding resolves the pair to
 * escalate-to-human instead, so the review still closes and no further round is
 * granted, while the security finding reaches a human rather than a backlog row.
 * Rule 3 is unweakened by this: that same finding is still not blocking. Closing
 * the review and escalating 1 finding are different acts.
 *
 * The security category set is an EXPLICIT input, taken the way
 * `src/strength-severity-route.cts:17-18` takes it. It is never re-derived here.
 *
 * Usage:
 *   node scripts/lint-antiloop-gate.cjs
 *       fold the local event log when it exists, and validate every committed budget
 *       declaration
 *   node scripts/lint-antiloop-gate.cjs --log <path>
 *       fold 1 explicit log, the mutation battery entry point
 *   node scripts/lint-antiloop-gate.cjs --declares <path>
 *       exit 0 when that file declares anti-loop governance and 1 when it does not. This
 *       is the source of truth D7's condition previously lacked, and
 *       ferrox-core/workflows/execute-plan.md names it
 *   node scripts/lint-antiloop-gate.cjs --print-subject-count
 *       print the number of committed subjects the default run selects
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.FERROX_ANTILOOP_GATE_ROOT
  ? path.resolve(process.env.FERROX_ANTILOOP_GATE_ROOT)
  : REPO_ROOT;
const PLANNING = path.join(ROOT, '.planning');
const PHASES_DIR = path.join(PLANNING, 'phases');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');
const GATE_LIB = path.join(LIB_DIR, 'antiloop-gate.cjs');
const LOG_LIB = path.join(LIB_DIR, 'antiloop-log.cjs');

/** The pinned subject predicate. Exact phrase, matched case-insensitively. */
const SUBJECT_PHRASE = 'anti-loop governance';

/**
 * The security category set, an EXPLICIT input per D8. It is passed to the shipped
 * disposition function and never re-derived from a finding.
 */
const SECURITY_CATEGORIES = Object.freeze(['security']);

const USAGE = [
  'Accepted flags:',
  '  node scripts/lint-antiloop-gate.cjs',
  '  node scripts/lint-antiloop-gate.cjs --log <path>',
  '  node scripts/lint-antiloop-gate.cjs --declares <path>',
  '  node scripts/lint-antiloop-gate.cjs --print-subject-count',
  'There is no flag that turns a rule off.',
].join('\n');

function loadLibs() {
  try {
    return { gate: require(GATE_LIB), log: require(LOG_LIB) };
  } catch {
    throw new ExitError(
      1,
      'ferrox-core/bin/lib/antiloop-gate.cjs or antiloop-log.cjs is missing. Run:\n'
        + '  npm run build:lib',
    );
  }
}

/** `<file>:<line>: [CODE] message`, with the offending text quoted beneath it. */
function formatError(e) {
  const where = typeof e.line === 'number' ? `${e.file}:${e.line}` : e.file;
  const head = `  ${where}: [${e.code}] ${e.message}`;
  if (typeof e.text === 'string' && e.text.trim() !== '') return `${head}\n      ${e.text.trim()}`;
  return head;
}

function report(errors, context) {
  if (errors.length === 0) return;
  throw new ExitError(
    1,
    `${errors.length} anti-loop problem${errors.length === 1 ? '' : 's'} in ${context}:\n`
      + errors.map(formatError).join('\n')
      + '\nFix: a pair with no declared budget needs a budget-declared event written before its '
      + 'first round opens. A pair whose budget is spent closes: record every remaining finding '
      + 'as a backlog row and open no further round. A finding that requested blocking without a '
      + 'command that failed when it was filed is a prediction, so it takes an id and ships past. '
      + 'A committed CONTEXT that declares anti-loop governance needs 1 bolded review budget '
      + 'sentence naming a digit count of rounds and how many cross-audit lineages are budgeted. '
      + 'Confirm the declaration with:\n'
      + '  node scripts/lint-antiloop-gate.cjs --declares <path>',
  );
}

/** Resolve symlinks where possible, so a link cannot walk the containment check. */
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    /* the path may not exist yet; fall through to its directory */
  }
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch {
    return p;
  }
}

/**
 * The containment check. It runs BEFORE the file is opened, so a refused path is never
 * read and no byte of it can reach the operator. Same shape as
 * `scripts/lint-governance-scope.cjs:313-323`.
 */
function containedPath(rawPath, flag) {
  const resolved = path.resolve(process.cwd(), rawPath);
  const rootReal = canonical(ROOT);
  const targetReal = canonical(resolved);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new ExitError(
      1,
      `refusing to read "${rawPath}": ${flag} reads a path inside the project root only, and `
        + `that path resolves outside ${rootReal}. The file was not opened.`,
    );
  }
  return resolved;
}

/** The pinned predicate, in 1 place, used by every mode that needs it. */
function declaresAntiloopGovernance(text) {
  return typeof text === 'string' && text.toLowerCase().includes(SUBJECT_PHRASE);
}

function readOrRefuse(absolute, rel) {
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    throw new ExitError(1, `${rel} could not be read. Restore the file or correct the path.`);
  }
}

/**
 * Every committed phase CONTEXT that declares anti-loop governance, in directory order.
 * A tree with no phases directory yields none rather than throwing, because a project
 * that has never planned a phase has no subjects, not a broken layout.
 */
function selectSubjects() {
  const subjects = [];
  let entries;
  try {
    entries = fs.readdirSync(PHASES_DIR, { withFileTypes: true });
  } catch {
    return subjects;
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of names) {
    const absolute = path.join(PHASES_DIR, name, 'CONTEXT.md');
    let text;
    try {
      text = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    if (!declaresAntiloopGovernance(text)) continue;
    subjects.push({ absolute, rel: path.relative(ROOT, absolute), text });
  }
  return subjects;
}

/**
 * Apply the 3 rules to every pair in a folded log. Rules 1 and 2 come from
 * `evaluateGateOpen`, rule 3 from `evaluateFindingBlocking`, and the D8 terminal outcome
 * of a closed review from `evaluateBudgetSpentDisposition`. The gate-open outcome field
 * is deliberately NOT reported for a closed review: the disposition owns that answer, and
 * reporting the gate's default would sweep a security finding into a backlog row in the
 * operator's message while the shipped composition says it escalates.
 */
function checkEvents(gate, events, rel) {
  const errors = [];
  const summaries = [];
  const pairs = gate.foldAntiloopEvents(events);

  for (const state of pairs.values()) {
    const open = gate.evaluateGateOpen({
      events,
      artifact: state.artifact,
      question: state.question,
    });
    const pair = `pair "${state.artifact}" / "${state.question}"`;

    if (open.decision === 'refuse-open') {
      errors.push({
        file: rel,
        code: open.code,
        message: `${pair} at ${open.rounds} round(s): ${open.message}`,
      });
    } else if (open.decision === 'close-review') {
      const disposition = gate.evaluateBudgetSpentDisposition({
        findings: state.findings,
        securityCategories: SECURITY_CATEGORIES,
      });
      errors.push({
        file: rel,
        code: open.code,
        message: `${pair}: ${open.message} Terminal outcome ${disposition.outcome}: `
          + disposition.message,
      });
    } else {
      summaries.push(
        `${pair}: ${open.rounds} rounds of ${open.max_rounds}, `
          + `${open.lineages} lineages of ${open.max_lineages}, ${open.decision}`,
      );
    }

    for (const finding of state.findings) {
      const requested = finding !== null && typeof finding === 'object'
        ? finding.blocking_requested
        : undefined;
      if (requested !== true) continue;
      const verdict = gate.evaluateFindingBlocking({ finding });
      if (verdict.blocking) continue;
      errors.push({ file: rel, code: verdict.code, message: `${pair}: ${verdict.message}` });
    }
  }

  return { errors, summaries, pairCount: pairs.size };
}

/** Validate the committed budget declarations. Returns the errors and the subject list. */
function checkSubjects(gate, subjects) {
  const errors = [];
  for (const subject of subjects) {
    const parsed = gate.parseBudgetDeclaration(subject.text, subject.rel);
    if (parsed !== null && typeof parsed === 'object' && parsed.ok === true) continue;
    errors.push(parsed);
  }
  return errors;
}

function parseArgs(argv) {
  let logPath = null;
  let declaresPath = null;
  let printSubjectCount = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--log' || arg === '--declares') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ExitError(1, `${arg} needs a value.\n${USAGE}`);
      }
      if (arg === '--log') logPath = value;
      else declaresPath = value;
      i++;
      continue;
    }
    if (arg === '--print-subject-count') {
      printSubjectCount = true;
      continue;
    }
    throw new ExitError(1, `unrecognised argument "${arg}".\n${USAGE}`);
  }

  const modes = [logPath !== null, declaresPath !== null, printSubjectCount].filter(Boolean);
  if (modes.length > 1) {
    throw new ExitError(1, `the modes are mutually exclusive; pass 1 at a time.\n${USAGE}`);
  }
  return { logPath, declaresPath, printSubjectCount };
}

function main() {
  const { logPath, declaresPath, printSubjectCount } = parseArgs(process.argv.slice(2));
  const { gate, log } = loadLibs();

  if (printSubjectCount) {
    process.stdout.write(`${selectSubjects().length}\n`);
    return;
  }

  if (declaresPath !== null) {
    const absolute = containedPath(declaresPath, '--declares');
    const rel = path.relative(ROOT, absolute) || path.basename(absolute);
    const text = readOrRefuse(absolute, rel);
    if (!declaresAntiloopGovernance(text)) {
      throw new ExitError(
        1,
        `${rel} does not declare anti-loop governance: it carries no "${SUBJECT_PHRASE}" `
          + 'section, so the anti-loop ratchet does not scope it and the moves it forbids stay '
          + 'available. This exit code is the source of truth for that condition.',
      );
    }
    console.log(`ok lint-antiloop-gate: ${rel} declares anti-loop governance`);
    return;
  }

  if (logPath !== null) {
    const absolute = containedPath(logPath, '--log');
    const rel = path.relative(ROOT, absolute) || path.basename(absolute);
    let events;
    try {
      events = log.readAntiloopLog({ path: absolute });
    } catch (e) {
      throw new ExitError(1, `${rel} could not be folded: ${e && e.message ? e.message : e}`);
    }
    const result = checkEvents(gate, events, rel);
    report(result.errors, rel);
    const detail = result.summaries.length === 0 ? '' : `\n  ${result.summaries.join('\n  ')}`;
    console.log(
      `ok lint-antiloop-gate: ${rel}, ${result.pairCount} pair(s) folded, all 3 rules `
        + `pass${detail}`,
    );
    return;
  }

  const subjects = selectSubjects();
  const errors = checkSubjects(gate, subjects);

  const logFile = log.antiloopLogPath(ROOT);
  const logRel = path.relative(ROOT, logFile);
  let logNote = `no local event log at ${logRel}, so 0 pairs were folded. The log is gitignored `
    + 'local run evidence, which is why the committed budget declarations are the subject that '
    + 'always exists';
  if (fs.existsSync(logFile)) {
    let events;
    try {
      events = log.readAntiloopLog({ path: logFile });
    } catch (e) {
      throw new ExitError(1, `${logRel} could not be folded: ${e && e.message ? e.message : e}`);
    }
    const result = checkEvents(gate, events, logRel);
    for (const e of result.errors) errors.push(e);
    logNote = `${result.pairCount} pair(s) folded from ${logRel}`;
  }

  report(errors, 'the committed budget declarations and the local event log');

  const names = subjects.map((s) => s.rel).join(', ');
  console.log(
    `ok lint-antiloop-gate: ${subjects.length} committed budget declaration`
      + `${subjects.length === 1 ? '' : 's'} validated`
      + `${names === '' ? '' : ` (${names})`}; ${logNote}`,
  );
}

module.exports = { parseArgs, declaresAntiloopGovernance, formatError };

if (require.main === module) runMain(main);
