/**
 * Phase 15 plan 02: the `antiloop.*` CLI verbs.
 *
 * Plan 01 built an append only event log and a hermetic fold. Nothing could
 * append to that log, so the mechanism was a library with no user. D4 is
 * explicit that a rule an agent can read and then not follow is not a
 * mechanism. These 4 verbs are what make the 3 rules unavoidable: an agent that
 * wants to open a review round runs a command, and the command exits non zero
 * when the budget was never declared or is already spent.
 *
 *   - antiloop.declare-budget  (MUTATION, appends 1 budget-declared event)
 *   - antiloop.open-round      (MUTATION, appends 1 round-opened event)
 *   - antiloop.file-finding    (MUTATION, appends 1 finding-filed event)
 *   - antiloop.status          (read only)
 *
 * THE LOAD BEARING OMISSION. There is no flag that supplies a round count,
 * resets a counter, forces an open, or carries a review past a spent budget.
 * On 2026-07-25 the counter in this repo reset because a human said to keep
 * going, so there is deliberately nothing here for a human to say. Any flag
 * this router does not recognise exits non zero naming the accepted set, which
 * closes the whole class rather than 4 names of it. A committed test drives 4
 * plausible names for such a flag and asserts each is rejected.
 *
 * THE SEAM. This file owns config and IO. The plan 01 fold owns every decision.
 * That is the division stated at `src/coord-hot-seam-check.cts:24-27` and
 * reproduced from `src/coord-command-router.cts:152-164`: parse the flags, fail
 * loud when a required flag is absent, resolve the config derived list, forward
 * the resolved values into the PURE core, write the result as JSON. No decision
 * logic belongs here, because the fold has to stay hermetic for the plan 01
 * mutation battery to stay fast and deterministic.
 *
 * EVERY NUMBER IS DERIVED (D6). No verb stores a current state claim. Even the
 * count printed after a permitted open is produced by re counting the log, so
 * the number the operator reads is a fold result rather than an increment.
 *
 * THE SECURITY SET (D8). `status` resolves `strength.security_categories` from
 * the loaded config, with the shipped manifest as the fallback, and forwards it
 * into the plan 01 disposition call. It is never re derived and never hard
 * coded here, so this router cannot drift from the strength gate at
 * `src/strength-severity-route.cts`, which this phase does not touch.
 *
 * ADR-457 build-at-publish: compiles to the TRACKED artifact
 * ferrox-core/bin/lib/antiloop-command-router.cjs. Plan 01 recorded why both
 * anti loop libs are committed rather than ignored: `lint:ci` does not run the
 * lib build, so plan 04's gate would fail on a fresh clone with a missing lib
 * error before `pretest` ever built it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ANTILOOP_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import antiloopLog = require('./antiloop-log.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import antiloopGate = require('./antiloop-gate.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoader = require('./config-loader.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
const { loadConfig } = configLoader;

interface RouteAntiloopCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
}

type ErrorFn = (message: string, reason?: string) => void;

/**
 * The shape every appended event shares: a caller supplied timestamp and a
 * kind, plus whatever fields that kind carries. Matches `AntiloopLogEntry` at
 * `src/antiloop-log.cts:60-71`.
 */
interface AppendableEvent {
  ts: string;
  kind: string;
  [k: string]: unknown;
}

/** A parsed flag set, or null when parsing already reported the failure. */
interface ParsedFlags {
  values: Record<string, string>;
  booleans: Record<string, boolean>;
}

/**
 * The complete accepted flag surface, 1 entry per verb.
 *
 * This object IS the enforcement of the no escape hatch rule. A flag absent
 * from these lists is rejected, so a future contributor cannot unblock
 * themselves by inventing an argument: they would have to edit this table, in a
 * commit, under review, which is exactly the visibility that was missing on
 * 2026-07-25.
 *
 * Deliberately absent from every list: any flag carrying a round count, any
 * flag that clears a counter, any flag that overrides a refusal, and any flag
 * that carries a review past a spent budget.
 */
const ACCEPTED_FLAGS: Record<string, { values: string[]; booleans: string[] }> = {
  'declare-budget': {
    values: ['artifact', 'question', 'max-rounds', 'max-lineages', 'declared-by', 'log', 'now-ts'],
    booleans: [],
  },
  'open-round': {
    values: ['artifact', 'question', 'gate', 'lineage', 'log', 'now-ts'],
    booleans: [],
  },
  'file-finding': {
    values: [
      'artifact',
      'question',
      'finding-id',
      'severity',
      'category',
      'reproducible',
      'reproducible-exit',
      'summary',
      'log',
      'now-ts',
    ],
    booleans: ['blocking'],
  },
  status: {
    values: ['artifact', 'question', 'log'],
    booleans: [],
  },
};

/** Manifest relative location of the shipped config defaults, read from bin/lib. */
const MANIFEST_RELATIVE = ['..', 'shared', 'config-defaults.manifest.json'];

function acceptedFlagList(verb: string): string {
  const spec = ACCEPTED_FLAGS[verb];
  if (spec === undefined) return '';
  const all = spec.values.map((v) => `--${v} <value>`).concat(spec.booleans.map((b) => `--${b}`));
  return all.join(', ');
}

/**
 * Strict argument parse. An unrecognised flag, a bare positional, or a value
 * flag with nothing after it all fail loud, following the parse behavior at
 * `scripts/lint-governance-scope.cjs:269-338` where an unrecognised argument
 * throws rather than being ignored. Silently ignoring an argument is how a
 * rejected flag becomes an accepted one by accident.
 */
function parseStrict(rest: string[], verb: string, error: ErrorFn): ParsedFlags | null {
  const spec = ACCEPTED_FLAGS[verb];
  const values: Record<string, string> = {};
  const booleans: Record<string, boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      error(
        `antiloop.${verb}: unexpected argument "${token}". Every input is a named flag. `
          + `Accepted: ${acceptedFlagList(verb)}`,
      );
      return null;
    }
    const name = token.slice(2);
    if (spec.booleans.includes(name)) {
      booleans[name] = true;
      continue;
    }
    if (spec.values.includes(name)) {
      if (i + 1 >= rest.length) {
        error(`antiloop.${verb}: ${token} requires a value. Accepted: ${acceptedFlagList(verb)}`);
        return null;
      }
      values[name] = rest[i + 1];
      i++;
      continue;
    }
    error(
      `antiloop.${verb}: unrecognised flag ${token}. Accepted: ${acceptedFlagList(verb)}. `
        + 'There is deliberately no flag that supplies a round count, clears a counter, '
        + 'overrides a refusal, or carries a review past a spent budget. A spent budget '
        + 'leaves 5 legal moves: descope, split, change approach, fence, or park.',
    );
    return null;
  }

  return { values, booleans };
}

/** Report the first absent required flag by name, or null when all are present. */
function missingRequired(parsed: ParsedFlags, verb: string, required: string[], error: ErrorFn): boolean {
  for (const name of required) {
    const v = parsed.values[name];
    if (v === undefined || v.trim() === '') {
      error(
        `antiloop.${verb}: --${name} is required and was not supplied. `
          + `Usage: ferrox-tools query antiloop.${verb} ${required.map((r) => `--${r} <value>`).join(' ')}`,
      );
      return true;
    }
  }
  return false;
}

/** A usable allowance is a finite non negative integer, matching normalizeBudget. */
function parseAllowance(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Resolve the log path. The default resolves through the plan 01 path resolver
 * so these verbs and the plan 04 gate always read the same file. `--log` exists
 * so a test can drive a real child process against a scratch file instead of
 * the live sidecar; it changes WHICH log is read, never what the log means.
 */
function resolveLogPath(values: Record<string, string>, cwd: string): string {
  const explicit = values.log;
  if (typeof explicit === 'string' && explicit !== '') {
    return path.isAbsolute(explicit) ? explicit : path.join(cwd, explicit);
  }
  return antiloopLog.antiloopLogPath(cwd);
}

/**
 * The caller supplied timestamp, resolved ONCE at the top of a handler and
 * never inside the core. `--now-ts` accepts epoch milliseconds so a test can
 * pin the value; the plan 01 log module never reads the wall clock itself.
 */
function resolveNowIso(values: Record<string, string>): string {
  const raw = values['now-ts'];
  const ms = Number(raw);
  if (raw !== undefined && Number.isFinite(ms)) return new Date(ms).toISOString();
  return new Date().toISOString();
}

/**
 * The strength block from the loaded config. A load failure collapses to an
 * empty block rather than crashing the verb, which is the try and catch to
 * empty idiom at `src/gate-command-router.cts:53-60`. An unparseable project
 * config must not be able to stop a review from closing.
 */
function resolveStrength(cwd: string): Record<string, unknown> {
  try {
    const cfg = loadConfig(cwd);
    const s = cfg && typeof cfg.strength === 'object' && cfg.strength !== null ? cfg.strength : {};
    return s as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * The shipped manifest default for the security category set, read from the
 * sibling ferrox-core/bin/shared/config-defaults.manifest.json and cached. The
 * list is NOT written out here: a literal copy in this file is exactly the
 * drift D8 forbids.
 */
let manifestSecurityCache: string[] | undefined;
function manifestSecurityCategories(): string[] {
  if (manifestSecurityCache !== undefined) return manifestSecurityCache;
  try {
    const manifestPath = path.join(__dirname, ...MANIFEST_RELATIVE);
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const strength =
      parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).strength : undefined;
    const list =
      strength && typeof strength === 'object'
        ? (strength as Record<string, unknown>).security_categories
        : undefined;
    manifestSecurityCache = Array.isArray(list) ? (list as string[]) : [];
  } catch {
    manifestSecurityCache = [];
  }
  return manifestSecurityCache;
}

/** Config value when present, else the shipped manifest default. Never invented. */
function resolveSecurityCategories(cwd: string): string[] {
  const v = resolveStrength(cwd).security_categories;
  if (Array.isArray(v) && v.length > 0) return v as string[];
  return manifestSecurityCategories();
}

/**
 * Write the payload to stdout SYNCHRONOUSLY, looping short counts, using the
 * same loop as `src/io.cts:108-125`.
 *
 * `fs.writeSync(1, ...)` rather than `process.stdout.write` because
 * `ferrox-tools.cjs:840` patches `fs.writeSync` to CAPTURE every fd 1 write and
 * flushes the buffer only after the command promise settles. Going through the
 * patched call is what makes `--pick` and the large payload @file redirection
 * work for these verbs.
 *
 * THE CONSEQUENCE, and it is why no refusal path here prints JSON: `error`
 * calls `process.exit`, so the capture buffer is discarded and a payload
 * written to stdout before a refusal reaches a terminal and reaches a piped
 * reader as 0 bytes. Every derived number a refusal needs to report therefore
 * travels in the error MESSAGE. A refusal that prints nothing to a test harness
 * is not a gate, and this was observed rather than assumed.
 */
function writeJson(result: unknown, raw: boolean): void {
  const data = (raw ? JSON.stringify(result) : JSON.stringify(result, null, 2)) + '\n';
  const buf = Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EAGAIN' || code === 'EINTR') continue;
      if (code === 'EPIPE') return;
      throw err;
    }
  }
}

function readLog(logPath: string, error: ErrorFn): Record<string, unknown>[] | null {
  try {
    return antiloopLog.readAntiloopLog({ path: logPath });
  } catch (err) {
    // readAntiloopLog THROWS on a line it cannot parse, naming the line number.
    // Surfacing that as a non zero exit is the point: a skipped line would
    // lower a derived count, which is the defect this phase exists to close.
    error(err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ─── declare-budget ───────────────────────────────────────────────────────────

/**
 * Rule 1 has a writer. The budget must exist before the first round opens, so a
 * SECOND declaration for the same pair is refused: it is either a mistake or an
 * attempt to extend a budget that is already spent, and both must fail rather
 * than append. The fold already ignores a later declaration when it reads, and
 * refusing at the write point means the log never carries the misleading line
 * at all.
 */
function handleDeclareBudget(rest: string[], cwd: string, raw: boolean, error: ErrorFn): void {
  const parsed = parseStrict(rest, 'declare-budget', error);
  if (parsed === null) return;
  if (missingRequired(parsed, 'declare-budget', ['artifact', 'question', 'max-rounds', 'max-lineages'], error)) {
    return;
  }

  const maxRounds = parseAllowance(parsed.values['max-rounds']);
  const maxLineages = parseAllowance(parsed.values['max-lineages']);
  if (maxRounds === null) {
    error('antiloop.declare-budget: --max-rounds must be a non negative integer, and it is the count AT WHICH the review closes.');
    return;
  }
  if (maxLineages === null) {
    error('antiloop.declare-budget: --max-lineages must be a non negative integer, and it is the count AT WHICH the review closes. Budget 2 to permit 1 reviewing lineage.');
    return;
  }

  const artifact = parsed.values.artifact;
  const question = parsed.values.question;
  const logPath = resolveLogPath(parsed.values, cwd);
  const events = readLog(logPath, error);
  if (events === null) return;

  const pairs = antiloopGate.foldAntiloopEvents(events);
  const state = pairs.get(antiloopGate.counterKey({ artifact, question }));
  if (state !== undefined && state.budget_event_index !== -1) {
    error(
      `antiloop.declare-budget: a review budget is already declared for this pair at `
        + `${state.budget.max_rounds} rounds and ${state.budget.max_lineages} lineages. `
        + 'A budget is declared once, before the first round opens. Re declaring it is how an '
        + 'unbounded review disguises itself as a bounded one, so nothing was appended.',
    );
    return;
  }

  const ts = resolveNowIso(parsed.values);
  const entry: AppendableEvent = {
    ts,
    kind: 'budget-declared',
    artifact,
    question,
    max_rounds: maxRounds,
    max_lineages: maxLineages,
  };
  const declaredBy = parsed.values['declared-by'];
  if (declaredBy !== undefined) entry.declared_by = declaredBy;

  antiloopLog.appendAntiloopEvent(entry, { path: logPath });
  writeJson(
    {
      declared: true,
      artifact,
      question,
      key: antiloopGate.counterKey({ artifact, question }),
      max_rounds: maxRounds,
      max_lineages: maxLineages,
      log: logPath,
      message:
        `the review budget for this pair is (${maxRounds} rounds, ${maxLineages} lineages). `
        + 'Both allowances are the count at which the review closes.',
    },
    raw,
  );
}

// ─── open-round ───────────────────────────────────────────────────────────────

/**
 * Rules 1 and 2 at the command line. The decision is the plan 01 fold's, not
 * this file's.
 *
 * A refused open appends NOTHING. Appending a refused round would inflate the
 * derived count, which is a different bug and would make the refusal itself
 * change the number the next caller reads.
 *
 * A permitted open appends 1 round-opened event carrying the gate and the
 * lineage as PROVENANCE. Neither reaches the counter key, so renaming the gate
 * and swapping the lineage, which is the literal 2026-07-25 move, buys nothing.
 */
function handleOpenRound(rest: string[], cwd: string, raw: boolean, error: ErrorFn): void {
  const parsed = parseStrict(rest, 'open-round', error);
  if (parsed === null) return;
  if (missingRequired(parsed, 'open-round', ['artifact', 'question', 'gate', 'lineage'], error)) return;

  const artifact = parsed.values.artifact;
  const question = parsed.values.question;
  const logPath = resolveLogPath(parsed.values, cwd);
  const events = readLog(logPath, error);
  if (events === null) return;

  const decision = antiloopGate.evaluateGateOpen({ events, artifact, question });
  if (decision.decision !== 'open-ok') {
    // EVERY derived number goes in the MESSAGE, not on stdout. See the note on
    // writeJson: `ferrox-tools.cjs` buffers fd 1 and flushes after the promise
    // settles, and `error` exits the process first, so a refusal payload
    // written to stdout would reach a terminal and reach a test harness as 0
    // bytes. A refusal that prints nothing to a harness is not a gate.
    error(
      `antiloop.open-round: ${decision.code} (${decision.decision}). `
        + `rounds ${decision.rounds} of ${decision.max_rounds}, `
        + `lineages ${decision.lineages} of ${decision.max_lineages}. `
        + `${decision.message} Nothing was appended: a refused round must not inflate the count.`,
    );
    return;
  }

  const ts = resolveNowIso(parsed.values);
  antiloopLog.appendAntiloopEvent(
    {
      ts,
      kind: 'round-opened',
      artifact,
      question,
      lineage: parsed.values.lineage,
      gate: parsed.values.gate,
    },
    { path: logPath },
  );

  // Re fold rather than add 1: the number the operator sees is derived too.
  const after = readLog(logPath, error);
  if (after === null) return;
  const state = antiloopGate.foldAntiloopEvents(after).get(decision.key);
  writeJson(
    {
      decision: 'open-ok',
      code: null,
      key: decision.key,
      artifact,
      question,
      gate: parsed.values.gate,
      lineage: parsed.values.lineage,
      rounds: state === undefined ? 0 : state.rounds,
      lineages: state === undefined ? 0 : state.lineages.size,
      max_rounds: decision.max_rounds,
      max_lineages: decision.max_lineages,
      log: logPath,
    },
    raw,
  );
}

// ─── file-finding ─────────────────────────────────────────────────────────────

/**
 * Rule 3 at the command line, and BOTH of its halves.
 *
 * The finding is recorded with the RESULT of the plan 01 evaluation, never with
 * the value the caller requested. When blocking was requested and refused, the
 * verb exits non zero, because that is what an executing agent feels, AND still
 * appends the finding as non blocking, because rule 3 says an unreproducible
 * finding gets an identifier and ships past rather than disappearing. Dropping
 * it would be a silent delete wearing the costume of a strict gate.
 *
 * Severity is recorded and is never consulted. `evaluateFindingBlocking` has no
 * severity parameter, so this router has nowhere to send one.
 */
function handleFileFinding(rest: string[], cwd: string, raw: boolean, error: ErrorFn): void {
  const parsed = parseStrict(rest, 'file-finding', error);
  if (parsed === null) return;
  if (missingRequired(parsed, 'file-finding', ['artifact', 'question', 'finding-id', 'severity', 'category'], error)) {
    return;
  }

  const artifact = parsed.values.artifact;
  const question = parsed.values.question;
  const logPath = resolveLogPath(parsed.values, cwd);
  const reproducible = parsed.values.reproducible === undefined ? '' : parsed.values.reproducible;
  const exitRaw = parsed.values['reproducible-exit'];
  const exitNum = Number(exitRaw);
  const reproducibleExit = exitRaw !== undefined && Number.isFinite(exitNum) ? exitNum : null;
  const blockingRequested = parsed.booleans.blocking === true;

  const finding = {
    finding_id: parsed.values['finding-id'],
    category: parsed.values.category,
    severity: parsed.values.severity,
    reproducible,
    reproducible_exit: reproducibleExit,
  };
  const verdict = antiloopGate.evaluateFindingBlocking({ finding });

  const ts = resolveNowIso(parsed.values);
  const entry: AppendableEvent = {
    ts,
    kind: 'finding-filed',
    artifact,
    question,
    finding_id: finding.finding_id,
    category: finding.category,
    severity: finding.severity,
    reproducible,
    reproducible_exit: reproducibleExit,
    blocking: verdict.blocking,
    blocking_requested: blockingRequested,
  };
  const summary = parsed.values.summary;
  if (summary !== undefined) entry.summary = summary;

  antiloopLog.appendAntiloopEvent(entry, { path: logPath });

  if (blockingRequested && !verdict.blocking) {
    // The durable record is the appended log line, which is already on disk.
    // The refusal goes in the MESSAGE for the same reason as open-round: stdout
    // written before `error` never reaches a piped reader.
    error(
      `antiloop.file-finding: ${verdict.code} (${verdict.reason}). ${verdict.message} `
        + `Finding ${verdict.finding_id} was appended to ${logPath} as non blocking and keeps `
        + 'its identifier, so it ships past as a backlog row rather than being lost.',
    );
    return;
  }

  writeJson({ recorded: true, log: logPath, event: entry, verdict }, raw);
}

// ─── status ───────────────────────────────────────────────────────────────────

/**
 * Read only. Every number reported here is folded from the log at read time.
 *
 * The findings are split by re running the plan 01 blocking evaluation over
 * each recorded finding rather than by trusting the `blocking` field the log
 * carries, so a hand edited log line cannot promote itself.
 *
 * The disposition is computed over the NON blocking findings, because those are
 * precisely the ones a spent budget would sweep into backlog rows. A blocking
 * finding is not swept; it blocks. D8 is the constraint on that sweep: if any
 * swept finding carries a security category the batch escalates to a human
 * instead, and the security set arrives from config rather than from here.
 *
 * This verb deliberately reports the gate `decision` and `code` and NOT the
 * gate's terminal outcome, because the disposition below is the authority on
 * what happens to the remaining findings and 2 outcome strings in 1 payload
 * would let a reader take the weaker one.
 */
function handleStatus(rest: string[], cwd: string, raw: boolean, error: ErrorFn): void {
  const parsed = parseStrict(rest, 'status', error);
  if (parsed === null) return;
  if (missingRequired(parsed, 'status', ['artifact', 'question'], error)) return;

  const artifact = parsed.values.artifact;
  const question = parsed.values.question;
  const logPath = resolveLogPath(parsed.values, cwd);
  const events = readLog(logPath, error);
  if (events === null) return;

  const key = antiloopGate.counterKey({ artifact, question });
  const state = antiloopGate.foldAntiloopEvents(events).get(key);
  const findings = state === undefined ? [] : state.findings;

  const blocking: unknown[] = [];
  const nonBlocking: Record<string, unknown>[] = [];
  for (const f of findings) {
    const verdict = antiloopGate.evaluateFindingBlocking({ finding: f });
    if (verdict.blocking) blocking.push({ finding: f, verdict });
    else nonBlocking.push(f);
  }

  const gate = antiloopGate.evaluateGateOpen({ events, artifact, question });
  const disposition = antiloopGate.evaluateBudgetSpentDisposition({
    findings: nonBlocking,
    securityCategories: resolveSecurityCategories(cwd),
  });

  writeJson(
    {
      artifact,
      question,
      key,
      log: logPath,
      budget: state === undefined ? { declared: false, max_rounds: 0, max_lineages: 0 } : state.budget,
      rounds: state === undefined ? 0 : state.rounds,
      rounds_closed: state === undefined ? 0 : state.rounds_closed,
      lineages: state === undefined ? 0 : state.lineages.size,
      lineage_names: state === undefined ? [] : Array.from(state.lineages),
      gate: { decision: gate.decision, code: gate.code, message: gate.message },
      blocking_findings: blocking,
      non_blocking_findings: nonBlocking,
      disposition,
      ignored_kinds: state === undefined ? [] : state.ignored_kinds,
    },
    raw,
  );
}

function routeAntiloopCommand({ args, cwd, raw, error }: RouteAntiloopCommandOptions): void {
  const rest = args.slice(2);
  routeCjsCommandFamily({
    args,
    subcommands: ANTILOOP_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_s: string, available: string[]) =>
      `Unknown antiloop subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'declare-budget': () => handleDeclareBudget(rest, cwd, raw, error),
      'open-round': () => handleOpenRound(rest, cwd, raw, error),
      'file-finding': () => handleFileFinding(rest, cwd, raw, error),
      status: () => handleStatus(rest, cwd, raw, error),
    },
  });
}

export = { routeAntiloopCommand };
