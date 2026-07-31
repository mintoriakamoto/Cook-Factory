#!/usr/bin/env node
'use strict';

/**
 * gen-proof-report.cjs: Phase 22 of milestone v1.14 (Fleet Mode). The report
 * renderer that publishes the verdict.
 *
 * `.planning/TEST-AND-BENCHMARK-DESIGN.md:228` states what this exists for: the
 * value of Proof is not that it validates the milestone, it is that it can
 * invalidate it. So this renderer carries 1 of 4 verdicts and all 4 are
 * reachable, and INSUFFICIENT is a legitimate published outcome rather than a
 * failure of the phase.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS GENERATOR OWNS NO LINT LINK
 * ---------------------------------------------------------------------------
 *
 * `scripts/gen-workgraph.cjs:12-21` argues this exact case. Every other
 * generator in this repository renders a governed surface with a right answer at
 * rest, so a committed snapshot plus a `--check` link is right for those. This
 * one answers a QUESTION. Its inputs change every time a measurement is taken,
 * and a drift check over it inside `lint:ci` would turn the gate red on work
 * that is going perfectly well. So: no npm alias, no `lint:ci` link. `--check`
 * exists for a human who wants to know whether the published document still
 * matches its inputs.
 *
 * ONE INPUT IS DELIBERATELY VOLATILE AND IT IS NAMED IN THE DOCUMENT. The
 * historical land failure rate is a query over git history, so it moves whenever
 * a commit lands. `--check` reporting section 6 as changed after new commits is
 * the check working, not the check being wrong.
 *
 * ---------------------------------------------------------------------------
 * HOW A RECORD BECOMES AN ARM, STATED SO A READER CAN CHECK IT
 * ---------------------------------------------------------------------------
 *
 * The records directory holds 2 unrelated kinds of record and folding them
 * together would be a category error with real consequences: the land gate
 * harness writes `arm: serial` with its own corpus hash, so a reader that
 * grouped by the `arm` field alone would put a land gate timing run into the
 * serial baseline and then refuse the whole comparison for a corpus mismatch.
 *
 * A record is an ARM record when ALL of these hold:
 *   1. it validates through the shipped validator with 0 errors
 *   2. its `run_started` names an arm and carries a corpus hash
 *   3. it carries at least 1 `land_completed`
 *
 * Rule 3 is the one that separates the 2 kinds, and it is not an invented
 * marker. An arm exists to land increments and be measured on them; a run that
 * landed nothing is not a comparison input, which is the same rule
 * `scripts/bench-run.cjs` already enforces at the emitter with its 0 attempted
 * refusal. Every record that is NOT an arm record is listed BY NAME in section 2
 * with the reason, so nothing is dropped silently.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE BEFORE NUMBERS
 * ---------------------------------------------------------------------------
 *
 * Section 2 is rendered BEFORE section 3 on purpose. A reader who sees the
 * numbers first will remember them whatever the labels said. A metric whose
 * state is not `known` renders as the state word and its reason, never as a
 * blank and never as 0.
 *
 * Usage:
 *   node scripts/gen-proof-report.cjs
 *   node scripts/gen-proof-report.cjs --check
 *   node scripts/gen-proof-report.cjs --records DIR --out FILE --permitted 3
 *
 * Flags:
 *   --records DIR   the run record directory, default .planning/proof/
 *   --out FILE      the document, default .planning/PROOF-v1.14.md
 *   --permitted N   override the permitted width instead of asking gen-workgraph
 *   --phase P       the phase the permitted width is read from, default 22
 *   --guards FILE   override the observed guard table. The test seam for the
 *                   row with no named test
 *   --history MODE  `run` asks bench-land-gate.cjs, `off` reports it unavailable
 *   --check         render to memory and exit 1 when the written file differs,
 *                   naming the differing sections
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_RECORDS = path.join(REPO_ROOT, '.planning', 'proof');
const DEFAULT_OUT = path.join(REPO_ROOT, '.planning', 'PROOF-v1.14.md');
const FOLD_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'proof-fold.cjs');
const CORPUS_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'bench-corpus.cjs');
const WORKGRAPH = path.join(REPO_ROOT, 'scripts', 'gen-workgraph.cjs');
const LAND_GATE = path.join(REPO_ROOT, 'scripts', 'bench-land-gate.cjs');
const CORPUS_ROOT = path.join(REPO_ROOT, '.planning', 'bench-harness');
const CORPUS_FLOOR = path.join(REPO_ROOT, 'scripts', 'bench-corpus-floor.cjs');
const DEFAULT_OVERHEAD = path.join(REPO_ROOT, '.planning', 'proof', 'fleet-overhead.json');

const DEFAULT_PHASE = '22';
const UNAVAILABLE = 'unavailable';

/** The refusal artifact `scripts/bench-run.cjs` writes. See `loadRefusals`. */
const REFUSAL_SCHEMA = 'bench-run-refusal/v1';

/**
 * The 4 things a benchmark passes TRIVIALLY, from CONTEXT D13, each with the
 * plan and the test that was OBSERVED firing it.
 *
 * THE RENDERER FAILS WHEN A ROW HAS NO NAMED TEST. A report that claims a guard
 * exists without naming where it was seen to fire is the defect class this whole
 * phase reports on, so the report is refused rather than published with a row
 * that asserts an unobserved guard.
 */
const OBSERVED_GUARDS = [
  {
    id: 'D13.1',
    trivial_pass: 'a benchmark that reports numbers with no baseline to compare against',
    positive_case: 'a fleet arm with an EMPTY serial list',
    reported: 'INSUFFICIENT, and the refusal names the missing serial arm',
    plan: '22-04',
    test: 'tests/proof-fold.test.cjs, the no baseline refusal and its mutant',
  },
  {
    id: 'D13.2',
    trivial_pass: 'a width calculation that cannot distinguish permitted from demonstrated',
    positive_case: 'permitted 5 against a demonstrated 1',
    reported: 'permitted 5, demonstrated 1, gap 4, and the verdict is byte identical at permitted 1',
    plan: '22-04',
    test: 'tests/proof-fold.test.cjs, the permitted width credits nothing mutant',
  },
  {
    id: 'D13.3',
    trivial_pass: 'a false green rate computed only from runs that were green',
    positive_case: 'every gate_ended green with 2 post_land_truth classified false_green, and a second case with 0 classifications',
    reported: 'a non zero rate on the first, and UNDEFINED rather than 0 on the second',
    plan: '22-04 and its gap closure',
    test: 'tests/proof-fold.test.cjs, the unmeasured false green arms',
  },
  {
    id: 'D13.4',
    trivial_pass: 'a corpus where every task scores 100',
    positive_case: 'a score set where every lane scored full on the visible axis',
    reported: 'SATURATED and NON DISCRIMINATING, with a mutant arm as the control reporting discriminating',
    plan: '22-01 and 22-06',
    test: 'tests/bench-run.test.cjs, the saturation arm and its control',
  },
];

// ─── argv ────────────────────────────────────────────────────────────────────

function flagValue(argv, name) {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return i + 1 < argv.length ? argv[i + 1] : '';
    if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
  }
  return null;
}

function readArgv(argv) {
  const records = flagValue(argv, 'records');
  const out = flagValue(argv, 'out');
  const permitted = flagValue(argv, 'permitted');
  const guards = flagValue(argv, 'guards');
  const phase = flagValue(argv, 'phase');
  const history = flagValue(argv, 'history');
  const antiloop = flagValue(argv, 'antiloop');
  const floorTasks = flagValue(argv, 'floor-tasks');
  const floorBin = flagValue(argv, 'floor-bin');
  const floorOverhead = flagValue(argv, 'floor-overhead');
  return {
    antiloop: antiloop === null || antiloop === '' ? null : path.resolve(antiloop),
    help: argv.includes('--help'),
    check: argv.includes('--check'),
    records: records === null || records === '' ? DEFAULT_RECORDS : path.resolve(records),
    out: out === null || out === '' ? DEFAULT_OUT : path.resolve(out),
    permitted: permitted === null || permitted === '' ? null : Number(permitted),
    guards: guards === null || guards === '' ? null : path.resolve(guards),
    phase: phase === null || phase === '' ? DEFAULT_PHASE : phase,
    history: history === null || history === '' ? 'run' : history,
    // THE SUBSET THE FLOOR IS COMPUTED FOR, and it is never defaulted to the
    // whole corpus. A floor computed for a scope the run did not use is a number
    // that LOOKS measured and answers a different question, which is the
    // misattribution plan 22-05 guard 11 exists to catch.
    floorTasks: floorTasks === null || floorTasks === '' ? null : floorTasks,
    // The substitution seam, mirroring 23-02's. Substituting the SCRIPT keeps the
    // real child process path under test: a case that read a floor out of a file
    // would leave the only path that matters untested.
    floorBin: floorBin === null || floorBin === '' ? CORPUS_FLOOR : path.resolve(floorBin),
    floorOverhead: floorOverhead === null || floorOverhead === '' ? DEFAULT_OVERHEAD : path.resolve(floorOverhead),
  };
}

// ─── loading ─────────────────────────────────────────────────────────────────

function loadLibs() {
  try {
    return { fold: require(FOLD_LIB), corpus: require(CORPUS_LIB) };
  } catch {
    throw new ExitError(
      1,
      'this renderer needs ferrox-core/bin/lib/proof-fold.cjs and bench-corpus.cjs. Run:\n'
        + '  npm run build:lib',
    );
  }
}

function parseJsonl(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push(null);
    }
  }
  return rows;
}

function startedOf(events) {
  const row = events.find((e) => e !== null && typeof e === 'object' && e.kind === 'run_started');
  return row === undefined ? null : row;
}

function countKind(events, kind) {
  return events.filter((e) => e !== null && typeof e === 'object' && e.kind === kind).length;
}

/**
 * Read every record and CLASSIFY it, keeping the reason a record is not an arm.
 *
 * Nothing is dropped silently. A record that fails any of the 3 arm rules is
 * still carried, with the rule it failed, so section 2 can name it.
 */
/**
 * The anti loop log rounds per artifact is folded from, or null when none exists.
 *
 * FF-B274: no anti loop log exists anywhere in this repository, and the path the
 * fold reads is gitignored so it could not travel into a fresh worktree even if
 * it did. The metric is therefore UNKNOWN on every arm, for a reason that is
 * NOT the reason cost is dark and NOT the reason the false green rate is dark.
 * The path is a flag so the fold's KNOWN direction can be driven, because a fold
 * observed only in its dark direction is a fold nobody has shown can report.
 */
function antiloopPath(argv) {
  if (argv.antiloop !== null) return fs.existsSync(argv.antiloop) ? argv.antiloop : null;
  const standard = path.join(REPO_ROOT, '.planning', 'antiloop-log.jsonl');
  return fs.existsSync(standard) ? standard : null;
}

function loadRecords(libs, dir, logPath) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    const events = parseJsonl(fs.readFileSync(file, 'utf8'));
    const validation = libs.fold.validateRunRecord(events);
    const started = startedOf(events);
    const doc = libs.fold.assembleFoldDocument(
      logPath === null ? { events } : { events, antiloopLogPath: logPath },
    );
    // The LANDED count from the shipped partition, never the raw event count.
    // `src/fleet-landqueue.cts:561` emits `land_completed` from a `finally`, so a
    // land that aborted, was reclaimed, or never got its turn still produces one.
    // A record whose every land aborted landed nothing and is not an arm.
    const lands = doc.landed;
    const rawLands = countKind(events, 'land_completed');

    const failures = [];
    if (!validation.ok) {
      failures.push(`refused by the shipped validator with ${[...new Set(validation.errors.map((e) => e.code))].sort().join(', ')}`);
    }
    if (started === null || typeof started.arm !== 'string' || started.arm === '') {
      failures.push('run_started names no arm');
    }
    if (started === null || typeof started.corpus_hash !== 'string' || started.corpus_hash === '') {
      failures.push('run_started carries no corpus_hash');
    }
    if (lands === 0) {
      failures.push(rawLands === 0
        ? 'the record carries 0 land_completed events, so it landed no increment to be measured on'
        : `the record carries ${rawLands} land_completed event${rawLands === 1 ? '' : 's'} and 0 of them `
          + 'is in the shipped LANDED family, so it landed no increment to be measured on');
    }

    out.push({
      name,
      file,
      events,
      started,
      arm: started === null ? '' : String(started.arm || ''),
      provenance: started === null ? UNAVAILABLE : String(started.provenance || UNAVAILABLE),
      corpus_hash: started === null ? '' : String(started.corpus_hash || ''),
      graph_generation: started === null ? '' : String(started.graph_generation || ''),
      lands,
      isArm: failures.length === 0,
      reason: failures.join('; '),
      doc: failures.length === 0 ? doc : null,
      contention: libs.fold.foldLandGateContention(events),
      gateCost: libs.fold.foldLandGateCost(events),
    });
  }
  return out;
}

/**
 * The published refusal artifacts, which are the ONLY evidence of why a fleet
 * arm is absent.
 *
 * ─── WHY THIS EXISTS, AND IT IS THIS PHASE'S OWN DEFECT CLASS ────────────────
 *
 * This renderer used to assert a cause on the bare condition that no fleet arm
 * was present: it said the phase 19 preflight refused dispatch. That sentence
 * was TRUE of the published run and it would have been emitted WORD FOR WORD
 * over a fleet arm that dispatched, opened 2 overlapping worker intervals and
 * merely landed nothing. A reader could not tell "correctly refused" from "did
 * not work", which are the 2 outcomes that must never be confusable in a report
 * whose whole value is honesty about what was and was not measured.
 *
 * It survived a 25 mutant battery because it is PROSE rather than a number: a
 * battery that mutates code and checks folds cannot see a sentence that is true
 * today and would be equally emitted when false.
 *
 * **A cause is now asserted ONLY when an artifact carries it.** With no
 * artifact the report says the cause was NOT RECORDED and names that as a gap,
 * rather than inferring a refusal from an absence.
 */
function loadRefusals(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    if (parsed.schema !== REFUSAL_SCHEMA) continue;
    if (typeof parsed.reason !== 'string' || parsed.reason === '') continue;
    out.push({ ...parsed, file: name });
  }
  return out;
}

/**
 * The SUPERSEDED records, which are on disk and are deliberately out of the
 * verdict's input set.
 *
 * ─── WHY THIS IS DERIVED AND NOT A SENTENCE SOMEBODY TYPED ───────────────────
 *
 * A measurement that a later fix invalidates is evidence about the apparatus it
 * ran on, so it is MOVED into a subdirectory rather than deleted. Both readers
 * above are non recursive `readdirSync` calls with extension filters, so a moved
 * record leaves the verdict's input set while remaining on disk and in git
 * history.
 *
 * The report must SAY that, and a sentence typed into the renderer would be
 * emitted word for word over a directory holding no superseded record at all.
 * That is the FF-B284 class. So the COUNT and the SUBDIRECTORY NAMES are read
 * off the disk, and the limit disappears entirely when there is nothing to
 * report. The arm that drives the false direction renders over a directory with
 * no subdirectory and asserts the sentence is absent.
 */
function loadSuperseded(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(sub);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const count = fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl')).length;
    if (count === 0) continue;
    out.push({ dir: name, count });
  }
  return out;
}

/**
 * What is known about the fleet arm, and it is 1 of exactly 5 states.
 *
 * The states are kept apart because they are different facts about the run, and
 * collapsing any 2 of them is what the repair above exists to stop.
 *
 * FF-B289, AND IT IS THE FIFTH STATE. This function previously returned `ran` the
 * instant a fleet record existed, so a refusal artifact sitting in the SAME
 * directory was silently consumed and section 9 then emitted that no refusal was
 * recorded over a directory holding one. That sentence is true today only because
 * no fleet arm has ever run; the first run that writes a record into
 * `.planning/proof/` alongside the refusal artifact already there makes it false,
 * and it would be emitted word for word. A record and a refusal are 2 FACTS, and
 * the reader reports both rather than letting the first branch eat the second.
 */
/**
 * The pooled fleet cell for 1 SC3 metric row.
 *
 * FF-B353. THE 2 METRICS WITH NO POOLING RULE SAY SO RATHER THAN RENDERING BLANK
 * OR REPEATING THE FIRST RECORD. Land gate cost is a curve over concurrency and
 * cost per landed increment has no emitter at all, and neither enters any verdict
 * rule, so pooling them would be inventing a statistic to fill a cell.
 */
function pooledCell(pooled, key) {
  if (key === 'wall_clock_to_land') {
    return pooled.wall_clock_ms === null
      ? `\`${UNAVAILABLE}\`: at least 1 fleet record does not know its wall clock, so the arm has no mean`
      : `**${num(pooled.wall_clock_ms)} ms**, the MEAN over ${pooled.records} record`
        + `${pooled.records === 1 ? '' : 's'}`;
  }
  if (key === 'demonstrated_width') {
    return pooled.demonstrated_width === null
      ? `\`${UNAVAILABLE}\`: at least 1 fleet record does not know its width`
      : `**${num(pooled.demonstrated_width)} workers**, the MINIMUM over ${pooled.records} record`
        + `${pooled.records === 1 ? '' : 's'}, so 1 wide run cannot vouch for a narrow one`;
  }
  if (key === 'false_green_rate') {
    return pooled.false_green === null
      ? `\`${UNAVAILABLE}\`: at least 1 fleet record reports no rate, or reports one with no landed count to weight it by`
      : `**${num(pooled.false_green.rate)} ratio**, the POOLED COUNT: `
        + `${num(pooled.false_green.false_greens)} false green`
        + `${pooled.false_green.false_greens === 1 ? '' : 's'} over `
        + `${num(pooled.false_green.landed)} landed increments`;
  }
  if (key === 'rounds_per_artifact') {
    return pooled.rounds_per_artifact === null
      ? `\`${UNAVAILABLE}\`: at least 1 fleet record does not know its round count, so the arm figure is EXCLUDED rather than averaged over the records that did report`
      : `**${num(pooled.rounds_per_artifact)} rounds**, the MEAN over ${pooled.records} record`
        + `${pooled.records === 1 ? '' : 's'}`;
  }
  return `\`${UNAVAILABLE}\`: no pooling rule, and this metric enters no verdict rule`;
}

/**
 * The MEAN OF THE PER RECORD false green rates, which is the pooling this report
 * does NOT use.
 *
 * FF-B353. It is computed only so the published paragraph can show the reader
 * both numbers and say which one decided. A mean of rates weights a record that
 * decided few increments exactly as heavily as one that decided many, and on the
 * live records the 2 figures differ. Null unless EVERY fleet record knows its
 * rate: a mean over the subset that reported would be a third number.
 */
function fleetMeanOfRates(fleetRecords) {
  if (fleetRecords.length === 0) return null;
  const rates = [];
  for (const record of fleetRecords) {
    const metric = record.doc.metrics.false_green_rate;
    if (metric === undefined || metric.state !== 'known' || typeof metric.value !== 'number') return null;
    rates.push(metric.value);
  }
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

function fleetStatus(records, fleetRecords, refusals) {
  if (fleetRecords.length > 0) {
    if (refusals.length > 0) {
      return { state: 'ran-and-refusal-present', evidence: refusals[refusals.length - 1] };
    }
    return { state: 'ran', evidence: null };
  }

  // A record that DECLARES itself the fleet arm but did not qualify. The arm
  // ran; it produced nothing comparable. That is emphatically not a refusal.
  const declared = records.filter((r) => !r.isArm && r.arm === 'fleet');
  if (declared.length > 0) {
    return { state: 'ran-not-comparable', evidence: declared[0] };
  }
  if (refusals.length > 0) return { state: 'refused', evidence: refusals[refusals.length - 1] };
  return { state: 'absent-cause-unrecorded', evidence: null };
}

// ─── spend, DERIVED from the records rather than asserted ────────────────────

/**
 * The sentence describing WHAT THE ARMS MEASURE, generated from the folded mix.
 *
 * It is a function rather than 3 inline branches because section 2 and section 7
 * both need it and section 9 needs its limit form, and 3 copies of a derived
 * sentence is 3 chances for 1 of them to drift back into a literal.
 */
function sourcesSentence(sources) {
  if (sources.state !== 'known') {
    return 'No arm record carries a `candidate_source` on any `worker_started`, so what these arms '
      + 'built from is `unavailable`. It is not claimed either way, because every property over 0 '
      + 'attempted nodes is vacuously true.';
  }
  const mix = sources.rows.map(([name, n]) => `${n} \`${name}\``).join(', ');
  if (sources.live === sources.attempted) {
    return `All ${sources.attempted} attempted nodes across every arm record were built by a LIVE `
      + 'adapter dispatch. **So these arms ARE a measurement of an agent**, and the wall clock below '
      + 'includes real model latency rather than the replay of a committed fixture. A reference '
      + 'fixture scores full on both axes BY DEFINITION, and there are 0 of them here.';
  }
  if (sources.live === 0) {
    return `0 of ${sources.attempted} attempted nodes were built by a live adapter dispatch. The mix `
      + `is ${mix}. **So these arms measure the HARNESS, the GATES and the COORDINATION STRUCTURE, `
      + 'they do NOT measure an agent, and no number below is evidence about any model.** FF-B276.';
  }
  return `${sources.live} of ${sources.attempted} attempted nodes were built by a LIVE adapter `
    + `dispatch and the rest were not. The mix is ${mix}. **So these arms are a MIXED measurement**, `
    + 'and a reference fixture scores full on both axes by definition, so any saturation over the non '
    + 'live nodes is partly a tautology. FF-B276 and FF-B278.';
}

/** A usd figure at 2 decimals with no trailing 0 padding, so 1.25 stays 1.25. */
function round2(value) {
  const rounded = Math.round(Number(value) * 100) / 100;
  return String(rounded);
}

/**
 * What this phase SPENT, folded out of the arm records.
 *
 * FF-B288, AND IT IS A FALSE SENTENCE RATHER THAN A BROKEN FOLD. The document
 * used to state, unconditionally and whatever the records held, that no network
 * access was taken and no agent spend occurred. A mutation battery cannot see
 * that defect: the sentence is TRUE today and would be emitted byte for byte when
 * false. FF-B284 records the class. So the claim is DERIVED here and each
 * direction of it has an arm that renders it over a world where it is false.
 *
 * The derivation turns on PROVENANCE and not on the presence of a `usd` field,
 * because the 2 are different facts. An archived candidate carries the spend that
 * produced it MONTHS AGO, and a replay of that candidate dispatches nothing. So
 * spend a replayed record carries is INHERITED, not incurred, and reporting it as
 * this phase's spend would be the mirror of the defect being repaired.
 *
 * A live arm whose lane reported NO figure yields UNKNOWN and never 0. A rate of
 * 0 and a rate nobody measured are different claims, and only 1 of them closes
 * FF-B253.
 */
function spendFacts(armRecords) {
  const live = armRecords.filter((r) => r.provenance === 'measured');
  const sum = (rows) => {
    let total = 0;
    let events = 0;
    for (const record of rows) {
      for (const e of record.events) {
        if (e === null || typeof e !== 'object') continue;
        if (typeof e.usd !== 'number' || !Number.isFinite(e.usd)) continue;
        events += 1;
        total += e.usd;
      }
    }
    return { total, events };
  };
  const incurred = sum(live);
  const inherited = sum(armRecords.filter((r) => r.provenance !== 'measured'));
  return {
    liveRecords: live.length,
    totalRecords: armRecords.length,
    incurredUsd: incurred.total,
    incurredEvents: incurred.events,
    inheritedUsd: inherited.total,
    inheritedEvents: inherited.events,
    // KNOWN only when a live arm ran AND at least 1 event carried a figure.
    state: live.length === 0 ? 'not-dispatched' : (incurred.events === 0 ? UNAVAILABLE : 'known'),
  };
}

/**
 * WHERE THE CANDIDATES CAME FROM, folded from `candidate_source`.
 *
 * FF-B284 AGAIN, AND THIS IS THE SAME DEFECT AS FF-B288. The document carried 6
 * sentences hardcoding phase 22's mix, that 15 of 20 attempted nodes were built
 * from committed REFERENCE implementations and that the live builder was never
 * run. Every one of them was TRUE when it was written and every one of them
 * became FALSE the moment a live arm ran, and they would have been published word
 * for word. A number that looks measured and is a literal is the thing this phase
 * exists to report on, so the mix is DERIVED and the prose is generated from it.
 */
function candidateSources(armRecords) {
  const counts = new Map();
  let attempted = 0;
  for (const record of armRecords) {
    for (const e of record.events) {
      if (e === null || typeof e !== 'object' || e.kind !== 'worker_started') continue;
      const source = typeof e.candidate_source === 'string' && e.candidate_source !== ''
        ? e.candidate_source
        : 'unrecorded';
      counts.set(source, (counts.get(source) || 0) + 1);
      attempted += 1;
    }
  }
  const rows = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
  return {
    attempted,
    rows,
    live: counts.get('live') || 0,
    reference: counts.get('reference') || 0,
    archived: counts.get('archived') || 0,
    // KNOWN only over a non zero attempted set. Every property over 0 attempted
    // nodes is vacuously true, including "every node came from an agent".
    state: attempted === 0 ? UNAVAILABLE : 'known',
  };
}

/** The distinct adapter identities the records dispatched with, from `lane`. */
function laneIdentities(armRecords) {
  const lanes = new Set();
  for (const record of armRecords) {
    for (const e of record.events) {
      if (e === null || typeof e !== 'object') continue;
      if (typeof e.lane !== 'string' || e.lane === '') continue;
      lanes.add(e.lane);
    }
  }
  return [...lanes].sort();
}

// ─── the per node agent latency, against the corpus floor ────────────────────

/**
 * The MEASURED per node agent latency, folded from the records.
 *
 * The median rather than the mean, because 1 adapter call that hit its timeout
 * would drag a mean far enough to change the comparison, and the question being
 * asked is what a typical dispatch cost in wall clock.
 *
 * No record carrying a runtime yields `unavailable`, NEVER 0. A latency of 0
 * would clear no floor at all and would report that the corpus discriminated
 * nothing, which is a conclusion nobody measured.
 */
function measuredLatency(armRecords) {
  const values = [];
  for (const record of armRecords) {
    for (const e of record.events) {
      if (e === null || typeof e !== 'object' || e.kind !== 'worker_ended') continue;
      const ms = Number(e.recorded_runtime_ms);
      if (!Number.isFinite(ms) || ms <= 0) continue;
      values.push(ms);
    }
  }
  if (values.length === 0) {
    return {
      state: UNAVAILABLE,
      value: null,
      n: 0,
      reason: 'no `worker_ended` event in any arm record carries a positive `recorded_runtime_ms`, '
        + 'so no agent latency was recorded. An absent latency is unavailable rather than 0, because '
        + 'a latency of 0 clears no floor and would report a discrimination nobody measured',
    };
  }
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  return {
    state: 'known', value: median, n: values.length, min: values[0], max: values[values.length - 1],
  };
}

/**
 * `L_min` for THIS RUN'S EXACT SUBSET, by invoking the plan 03 instrument.
 *
 * IT IS A CHILD PROCESS AND IT IS NEVER A NUMBER RETYPED FROM A PLAN. A floor a
 * document transcribed is a floor nobody can recompute, and it goes stale the
 * moment the corpus moves. `permittedWidth` above takes the same shape for the
 * same reason.
 *
 * A refusal, a crash or an unparseable document yields `unavailable` WITH THE
 * REASON, never 0. And a floor whose own named subset differs from the subset the
 * run used is REFUSED rather than published: it is a real number computed for a
 * different question, which is exactly the misattribution that survives review
 * because it looks measured.
 */
function corpusFloor(argv) {
  if (argv.floorTasks === null) {
    return {
      state: UNAVAILABLE,
      value: null,
      reason: 'no `--floor-tasks` subset was named, so no floor was requested. The floor is computed '
        + 'for the subset a run actually attempted and is never defaulted to the whole corpus',
      source: null,
    };
  }
  const args = [
    argv.floorBin, '--floor', '--tasks', argv.floorTasks,
    '--overhead', argv.floorOverhead, '--raw',
  ];
  const source = `node ${path.relative(REPO_ROOT, argv.floorBin)} --floor --tasks ${argv.floorTasks} `
    + `--overhead ${path.relative(REPO_ROOT, argv.floorOverhead)} --raw`;
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env },
  });
  let document = null;
  try {
    document = JSON.parse(String(result.stdout || ''));
  } catch {
    document = null;
  }
  if (document === null || typeof document !== 'object') {
    return {
      state: UNAVAILABLE,
      value: null,
      source,
      reason: 'the floor instrument produced no parseable document, so the floor is unavailable '
        + 'rather than 0',
    };
  }

  // VALIDATE BEFORE READING THE NUMBER. A floor computed for another subset is a
  // correct number answering a different question.
  const named = Array.isArray(document.tasks) ? [...document.tasks].sort() : [];
  const asked = argv.floorTasks.split(',').map((t) => t.trim()).filter((t) => t !== '').sort();
  if (named.join(',') !== asked.join(',')) {
    return {
      state: UNAVAILABLE,
      value: null,
      source,
      reason: `the instrument computed for \`${named.join(',')}\` and this run attempted `
        + `\`${asked.join(',')}\`, so the floor is for a DIFFERENT scope and is refused rather than `
        + 'published. A floor misattributed to another subset is a number that looks measured',
    };
  }

  const refusals = Array.isArray(document.refusals) ? document.refusals : [];
  const floor = document.floor === null || document.floor === undefined ? null : document.floor;
  if (floor === null || !Number.isFinite(Number(floor.l_min_ms))) {
    const codes = refusals.map((r) => String(r && r.code)).filter((c) => c !== 'undefined');
    const detail = refusals.length > 0 ? String(refusals[0].detail) : 'the instrument returned no floor and named no refusal';
    return {
      state: UNAVAILABLE,
      value: null,
      source,
      refusalCodes: codes,
      reason: `the instrument REFUSED${codes.length > 0 ? ` with ${codes.join(', ')}` : ''}: ${detail}`,
    };
  }
  return {
    state: 'known',
    value: Number(floor.l_min_ms),
    source,
    tasks: named,
    rounds: Number(document.rounds),
    nodes: Number(document.nodes),
    inputs: {
      f_run_ms: Number(floor.f_run_ms), f_node_ms: Number(floor.f_node_ms), sigma_ms: Number(floor.sigma_ms),
    },
  };
}

// ─── permitted width, from a child process and never from a run record ───────

/**
 * PERMITTED width: the maximum node count over any single wave, read from
 * `gen-workgraph.cjs` as a real child process.
 *
 * It is NEVER read from a run record. `MEASUREMENT-v1.14-PARALLELISM.md` finding
 * 3 records that this repository's permitted width has been 3 to 5 throughout
 * its history while its demonstrated width was 1, so the 2 numbers come from 2
 * sources and a module that read both from 1 place would eventually be asked to
 * reconcile them.
 *
 * A command that fails yields `unavailable`, NEVER 0. A permitted width of 0
 * would report a gap that makes any demonstrated width look like a triumph.
 */
function permittedWidth(argv) {
  if (argv.permitted !== null && Number.isFinite(argv.permitted)) {
    return { value: argv.permitted, source: `the --permitted ${argv.permitted} argument`, state: 'known' };
  }
  const result = spawnSync(process.execPath, [WORKGRAPH, argv.phase, '--raw'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env },
  });
  let document = null;
  try {
    document = JSON.parse(String(result.stdout || ''));
  } catch {
    document = null;
  }
  if (document === null || !Array.isArray(document.nodes) || document.nodes.length === 0) {
    return {
      value: null,
      state: UNAVAILABLE,
      source: `scripts/gen-workgraph.cjs ${argv.phase} reported no usable document`,
      reason: 'the permitted width command produced no document with nodes, so the number is '
        + 'unavailable rather than 0. A permitted width of 0 would report a gap that flatters any '
        + 'demonstrated width',
    };
  }
  const perWave = new Map();
  for (const node of document.nodes) {
    const wave = Number(node.wave);
    if (!Number.isFinite(wave)) continue;
    perWave.set(wave, (perWave.get(wave) || 0) + 1);
  }
  if (perWave.size === 0) {
    return {
      value: null,
      state: UNAVAILABLE,
      source: `scripts/gen-workgraph.cjs ${argv.phase}`,
      reason: 'no node in the document declares a wave, so no maximum over a wave exists',
    };
  }
  const waves = [...perWave.entries()].sort((a, b) => a[0] - b[0]);
  return {
    value: Math.max(...waves.map((w) => w[1])),
    state: 'known',
    source: `scripts/gen-workgraph.cjs ${argv.phase}, the maximum node count over any single wave`,
    waves,
  };
}

// ─── the historical land failure rate, from its own producer ─────────────────

/**
 * SC4, obtained by asking the producer.
 *
 * FF-B260: `bench-land-gate.cjs --history` emits NO run record, so this number
 * is not foldable out of the records directory. It is obtained by invoking that
 * command as a child process and reading its stated output, and its provenance,
 * its bound and its caveats travel through verbatim. Nothing here retypes the
 * number: whatever the producer says is what is published.
 */
function historicalRate(argv) {
  if (argv.history === 'off') {
    return { state: UNAVAILABLE, reason: 'the history query was disabled with --history off', caveats: [] };
  }
  const result = spawnSync(process.execPath, [LAND_GATE, '--history'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env },
  });
  const stdout = String(result.stdout || '');
  if (result.status !== 0 || stdout.trim() === '') {
    return {
      state: UNAVAILABLE,
      reason: `scripts/bench-land-gate.cjs --history exited ${String(result.status)} and produced no `
        + 'usable output, so the historical rate is unavailable rather than estimated',
      caveats: [],
    };
  }
  const fields = new Map();
  const caveats = [];
  for (const line of stdout.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key.startsWith('caveat')) {
      caveats.push(value);
      continue;
    }
    if (!fields.has(key)) fields.set(key, value);
  }
  const rate = fields.get('rate');
  if (rate === undefined || rate === UNAVAILABLE) {
    return {
      state: UNAVAILABLE,
      reason: 'the history query ran and reported no rate, which is its own unavailable outcome and '
        + 'is not a rate of 0',
      caveats,
    };
  }
  return {
    state: 'known',
    rate: Number(rate),
    provenance: fields.get('provenance') || UNAVAILABLE,
    bound: fields.get('bound') || '',
    subjects_read: fields.get('subjects_read') || '',
    landed_pairs: fields.get('landed_pairs') || '',
    failed_later_pairs: fields.get('failed_later_pairs') || '',
    failed_later: fields.get('failed_later') || '',
    query: fields.get('query') || '',
    caveats,
  };
}

// ─── the land gate curve, assembled ACROSS records ───────────────────────────

/**
 * FF-B258: `foldLandGateCost` computes a degradation only WITHIN a single
 * record, and each land gate record is 1 configuration. So a per record
 * degradation of 1.0 is NOT a flat curve, it is a curve with 1 point on it, and
 * the curve is an assembly ACROSS records keyed on the configuration each one
 * declares.
 */
function landGateCurve(records) {
  const rows = [];
  for (const record of records) {
    if (record.started === null) continue;
    const gates = Number(record.started.requested_gates);
    const load = Number(record.started.requested_load);
    if (!Number.isFinite(gates)) continue;
    const cost = record.gateCost;
    if (cost.state !== 'known' || cost.buckets.length === 0) continue;

    // The raw durations, derived here for the MINIMUM alone. The median and the
    // maximum come from the shipped fold, which stays authoritative for both.
    const starts = new Map();
    for (const e of record.events) {
      if (e === null || typeof e !== 'object') continue;
      if (e.kind === 'gate_started') starts.set(`${e.attempt_id}`, e.ts);
    }
    const durations = [];
    let green = 0;
    let red = 0;
    for (const e of record.events) {
      if (e === null || typeof e !== 'object' || e.kind !== 'gate_ended') continue;
      const start = starts.get(`${e.attempt_id}`);
      if (start !== undefined) durations.push(e.ts - start);
      if (e.verdict === 'green') green += 1;
      else red += 1;
    }
    const bucket = cost.buckets[cost.buckets.length - 1];
    rows.push({
      record: record.name,
      gates,
      load: Number.isFinite(load) ? load : 0,
      n: bucket.n,
      min_ms: durations.length === 0 ? null : Math.min(...durations),
      median_ms: bucket.median_ms,
      max_ms: bucket.max_ms,
      green,
      red,
    });
  }
  rows.sort((a, b) => (a.load - b.load) || (a.gates - b.gates));
  return rows;
}

// ─── rendering helpers ───────────────────────────────────────────────────────

function num(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNAVAILABLE;
  return String(Number(Number(value).toFixed(6)));
}

/**
 * A metric rendered as its state and its reason whenever it is not known.
 *
 * NEVER a blank and NEVER 0. A rate of 0 and a rate nobody measured are
 * different claims, and only 1 of them is evidence.
 */
function metricCell(metric) {
  if (metric === undefined || metric === null) return 'absent';
  if (metric.state !== 'known') {
    const reason = typeof metric.reason === 'string' && metric.reason !== '' ? metric.reason : 'no reason recorded';
    return `\`${metric.state}\`: ${reason}`;
  }
  if (Array.isArray(metric.buckets)) {
    const parts = metric.buckets.map((b) => `${b.concurrency} gates ${num(b.median_ms)} ms`);
    return `\`known\`: ${parts.join(', ')}`;
  }
  const unit = typeof metric.unit === 'string' && metric.unit !== '' ? ` ${metric.unit}` : '';
  return `\`known\`: ${num(metric.value)}${unit}`;
}

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

const METRIC_ROWS = [
  ['wall clock to land', 'wall_clock_to_land'],
  ['demonstrated parallel width', 'demonstrated_width'],
  ['land gate cost under load', 'land_gate_cost'],
  ['false green rate', 'false_green_rate'],
  ['rounds per artifact', 'rounds_per_artifact'],
  ['cost per landed increment', 'cost_per_landed_increment'],
];

// ─── the document ────────────────────────────────────────────────────────────

function render(input) {
  const {
    records, armRecords, serial, fleetRecords, fleetInfo, verdict, permitted, history, curve, corpus, guards,
    spend, latency, floor, lanes, sources, subset, superseded, selection, threshold,
  } = input;
  const L = [];
  const absent = [];

  const pooled = verdict.pooled_fleet;
  // The number this report REFUSES to publish as the rate, computed so the
  // refusal is visible rather than asserted. Null unless every fleet record
  // reported, because a mean over the subset that happened to report would be a
  // third number nobody asked for.
  const meanOfRates = fleetMeanOfRates(fleetRecords);

  // FF-B353. The VERDICT is pooled over every fleet record. This name is the
  // record a per record COLUMN shows, and every place it is used says which
  // record it is and how many others there are, exactly as the serial column
  // has done since FF-B282. A column that showed 1 of N without saying so is
  // how the fold came to select 1 of N in the first place.
  const fleet = fleetRecords.length === 0 ? null : fleetRecords[0];

  const demonstrated = verdict.demonstrated_width;
  const gap = verdict.width_gap;

  L.push('# Proof: is the fleet actually faster');
  L.push('');
  L.push('The v1.14 Fleet Mode measurement, phase 22. Generated by '
    + '`node scripts/gen-proof-report.cjs`, which is not linked into `lint:ci` because its inputs '
    + 'change every time a measurement is taken.');
  L.push('');

  // ── 1. the verdict ─────────────────────────────────────────────────────────
  L.push('## 1. The verdict');
  L.push('');
  L.push(`**${verdict.verdict}**`);
  L.push('');
  L.push('The rule that decided it, and the numbers, so a reader can recompute it by hand.');
  L.push('');
  for (const reason of verdict.reasons) L.push(`- ${reason}`);
  if (verdict.refusals.length > 0) {
    L.push('');
    L.push(`The ${verdict.refusals.length} refusal${verdict.refusals.length === 1 ? '' : 's'} that fired, all of them and not merely the first:`);
    L.push('');
    for (const refusal of verdict.refusals) L.push(`- ${refusal}`);
  }
  L.push('');
  L.push('| input | value |');
  L.push('|---|---|');
  L.push(`| serial arm records | ${serial.length} |`);
  L.push(`| fleet arm records | ${verdict.fleet_records} |`);
  L.push(`| sigma, the observed serial spread | ${verdict.sigma_ms === null ? UNAVAILABLE : `${num(verdict.sigma_ms)} ms`} |`);
  L.push(`| the fleet repeat spread, which enters no rule | ${verdict.fleet_spread_ms === null ? UNAVAILABLE : `${num(verdict.fleet_spread_ms)} ms`} |`);
  L.push(`| permitted width | ${permitted.state === 'known' ? num(permitted.value) : UNAVAILABLE} |`);
  L.push(`| demonstrated width | ${demonstrated === null ? UNAVAILABLE : num(demonstrated)} |`);
  L.push(`| corpus hash | ${verdict.corpus_hash === '' ? UNAVAILABLE : `\`${verdict.corpus_hash}\``} |`);
  L.push('');
  L.push('`INSUFFICIENT` is a legitimate published outcome and is more honest than a manufactured '
    + 'number. It is not a failure of the phase: an apparatus that can only confirm is not a '
    + 'measurement.');
  L.push('');
  // FF-B353, and the sentence is DERIVED from the verdict document rather than
  // asserted here, so it cannot describe a pooling the fold is not doing.
  L.push(`**The fleet arm is POOLED over every one of its ${verdict.fleet_records} records, and is `
    + 'no longer a selection of 1.** ' + escapeCell(verdict.pooling));
  L.push('');
  // DERIVED, never asserted. Every number and every verdict word in this
  // paragraph is computed from the records present, including what the
  // SUPERSEDED single record fold would have returned for each one, so the
  // paragraph cannot outlive the facts it describes.
  L.push('**FF-B353 is the repair.** `compareArms` took the serial side as a LIST and the fleet side '
    + 'as a SINGLE document, so this generator folded `fleetRecords[0]` and the DIRECTORY ORDER '
    + 'decided the published verdict.');
  L.push('');
  if (selection.length === 0) {
    L.push('No fleet record is present, so there is nothing to select between and nothing to pool.');
  } else {
    L.push('| fleet record | the verdict this record ALONE would have published |');
    L.push('|---|---|');
    for (const row of selection) L.push(`| \`${escapeCell(row.name)}\` | **${row.verdict}** |`);
    L.push('');
    L.push(selection.length === 1
      ? `The arm holds 1 record, so the pooled fold returns exactly what that record reports. `
        + 'Selection is the defect, not the count.'
      : (new Set(selection.map((r) => r.verdict)).size > 1
        ? `Those ${selection.length} records DISAGREE, so the order they were read in decided the `
          + 'published result. That is the coin flip FF-B353 removed.'
        : `Those ${selection.length} records happen to agree here, which is luck rather than a `
          + 'reason to publish 1 of them. They are pooled.'));
  }
  L.push('');
  if (pooled.false_green !== null) {
    L.push(`Pooled, the fleet false green count is ${num(pooled.false_green.false_greens)} over `
      + `${num(pooled.false_green.landed)} landed increments, which is `
      + `${num(pooled.false_green.rate)}. A mean of the per record rates would instead have been `
      + `${meanOfRates === null ? UNAVAILABLE : num(meanOfRates)}, and it weights a record that `
      + 'decided few increments as heavily as one that decided many.');
    L.push('');
  }
  L.push('**Sigma is pooled over every serial record, across both reported shapes.** The 2 shapes '
    + 'build the identical node set and land the identical count in 2 different orders, so pooling '
    + 'them gives a LARGER spread than either shape alone and therefore a harder bar for a POSITIVE. '
    + 'That is the conservative direction on purpose. A per shape sigma is recorded in the plan 22-06 '
    + 'summary and is smaller.');
  L.push('');

  // ── 2. what was measured and what was not ──────────────────────────────────
  L.push('## 2. What was measured and what was not');
  L.push('');
  L.push('**This table comes before the numbers on purpose.** A reader who sees the numbers first '
    + 'will remember them whatever the labels said.');
  L.push('');
  L.push('| arm | record | provenance | landed | demonstrated width | corpus hash |');
  L.push('|---|---|---|---|---|---|');
  if (armRecords.length === 0) {
    L.push(`| ${UNAVAILABLE} | none | ${UNAVAILABLE} | 0 | ${UNAVAILABLE} | ${UNAVAILABLE} |`);
  }
  for (const record of armRecords) {
    const width = record.doc.metrics.demonstrated_width;
    L.push(`| ${record.arm} | \`${record.name}\` | \`${record.provenance}\` | ${record.doc.landed} | `
      + `${width.state === 'known' ? num(width.value) : `\`${width.state}\``} | \`${record.corpus_hash.slice(0, 12)}\` |`);
  }
  L.push('');

  const nonArm = records.filter((r) => !r.isArm);
  L.push('### Records present that are NOT arm records');
  L.push('');
  L.push('A record joins an arm only when it validates with 0 errors, names an arm, carries a corpus '
    + 'hash, and carries at least 1 `land_completed`. The last rule is what separates a corpus arm '
    + 'from a land gate timing run: the land gate harness writes `arm: serial` with its own corpus '
    + 'hash, and a reader grouping on that field alone would put a timing run into the baseline and '
    + 'then refuse the whole comparison for a corpus mismatch. Nothing is dropped silently.');
  L.push('');
  if (nonArm.length === 0) {
    L.push('None. Every record in the directory is an arm record.');
  } else {
    L.push('| record | why it is not an arm record |');
    L.push('|---|---|');
    for (const record of nonArm) L.push(`| \`${record.name}\` | ${escapeCell(record.reason)} |`);
  }
  L.push('');

  L.push('### What was NOT run');
  L.push('');
  L.push('| arm | state | reason |');
  L.push('|---|---|---|');
  if (fleetRecords.length === 0) {
    absent.push('a fleet arm');
    if (fleetInfo.state === 'refused') {
      const r = fleetInfo.evidence;
      L.push(`| fleet | **not run, REFUSED** | the dispatch entry point \`${escapeCell(r.entry_point)}\` `
        + 'is present and CALLABLE, and its own preflight refused dispatch. The verbatim reason is '
        + `quoted in section 9 and was read from \`${escapeCell(r.file)}\`. |`);
    } else if (fleetInfo.state === 'ran-not-comparable') {
      L.push(`| fleet | **ran, but produced no comparable record** | \`${escapeCell(fleetInfo.evidence.name)}\` `
        + `declares itself the fleet arm and was excluded: ${escapeCell(fleetInfo.evidence.reason)}. `
        + '**This is NOT a refusal.** The arm ran. |');
    } else {
      absent.push('any recorded cause for the absent fleet arm');
      L.push('| fleet | **not run, and THE CAUSE WAS NOT RECORDED** | no fleet arm record and no '
        + 'refusal artifact is present, so this document does not know why. It does NOT infer a '
        + 'refusal from an absence: a reader could not then tell a correct refusal from something '
        + 'that did not work. |');
    }
  }
  if (serial.length === 0) {
    absent.push('a serial baseline');
    L.push(`| serial | **not run** | the records directory holds no serial arm record, so there is no baseline. |`);
  } else {
    L.push(`| serial | run | ${serial.length} records, provenance \`${serial[0].provenance}\`. |`);
  }
  // ── FF-B288. THE SPEND AND NETWORK SENTENCES ARE DERIVED, NOT ASSERTED ─────
  //
  // Both used to be emitted unconditionally, whatever the records held. They are
  // now folded out of the arm records by `spendFacts`, and each direction has a
  // case that renders it over a world where it is false and asserts it absent. A
  // mutation battery could never have caught this: the sentence was TRUE, and it
  // would have been emitted byte for byte the moment it stopped being.
  if (spend.liveRecords === 0) {
    L.push('| live builder | **not run** | no arm record carries provenance `measured`, so no adapter '
      + 'was dispatched by this run. |');
    L.push('');
    L.push(`**No agent was dispatched anywhere in this phase.** 0 of ${spend.totalRecords} arm `
      + `record${spend.totalRecords === 1 ? '' : 's'} carries provenance \`measured\`, which is the `
      + 'value the runner assigns at the point a real adapter invocation is built. '
      + (spend.inheritedEvents === 0
        ? 'No record carries a `usd` figure at all.'
        : `The **${round2(spend.inheritedUsd)} usd** across ${spend.inheritedEvents} events in these `
          + 'records is INHERITED from the archived candidates the replay reads, not incurred here. '
          + 'Reporting it as this phase\'s spend would be the mirror of the defect this sentence was '
          + 'repaired to close.'));
    L.push('');
  } else {
    L.push(`| live builder | **RAN** | ${spend.liveRecords} of ${spend.totalRecords} arm `
      + `record${spend.totalRecords === 1 ? '' : 's'} carries provenance \`measured\`, so a real `
      + `adapter was dispatched${lanes.length === 0 ? '' : ` on ${lanes.map((l) => `\`${l}\``).join(', ')}`}. |`);
    L.push('');
    if (spend.state === 'known') {
      L.push(`**This phase DISPATCHED REAL AGENTS AND SPENT MONEY.** The lanes reported `
        + `**${round2(spend.incurredUsd)} usd** across ${spend.incurredEvents} events carrying a `
        + `figure, folded from the ${spend.liveRecords} record${spend.liveRecords === 1 ? '' : 's'} `
        + 'whose provenance is `measured`. Network access WAS taken: that is what a live dispatch is.');
    } else {
      L.push('**This phase DISPATCHED REAL AGENTS, and the spend is `unknown`.** '
        + `${spend.liveRecords} record${spend.liveRecords === 1 ? '' : 's'} carries provenance `
        + '`measured`, so network access WAS taken, and no event in any of them carries a `usd` '
        + 'figure. **So the spend is `unknown` and is NOT written as 0.** A rate of 0 and a rate '
        + 'nobody measured are different claims, and only the first would close FF-B253.');
    }
    L.push('');
  }

  // ── THE IDENTITY INVARIANT, PUBLISHED AS A NUMBER RATHER THAN ASSUMED ──────
  //
  // T-23-05-13. A serial arm on 1 model against a fleet arm on another confounds
  // MODEL SPEED with CONCURRENCY, and the difference measured is then 2
  // differences added together with no way to separate them. The whole spend
  // would buy a number answering a different question. So the set is folded over
  // every record of BOTH arms and its SIZE is published: a reader checks the
  // number rather than trusting that the arms were configured alike.
  //
  // THE RECORD COUNT IS ASSERTED NON ZERO FIRST, because a distinct set of size 1
  // is also exactly what 0 records with 1 default would produce. This renders
  // OUTSIDE the spend branch on purpose: the identity set is a fact about the
  // records whether or not a live arm ran, and a reader must be able to see that
  // it was checked rather than skipped.
  if (armRecords.length === 0) {
    L.push('**The dispatch identity set is `unavailable`.** There are 0 arm records, and every '
      + 'property over an empty set is vacuously true, so no invariant is claimed here.');
  } else if (lanes.length === 0) {
    L.push(`**The dispatch identity set is \`${UNAVAILABLE}\`.** All ${armRecords.length} arm `
      + `record${armRecords.length === 1 ? '' : 's'} are present and none carries a \`lane\`, which `
      + 'is the field the identity rides on. So the identity is NOT RECORDED rather than shared, and '
      + 'no invariant is claimed over it.');
  } else if (lanes.length === 1) {
    L.push('**Both arms dispatched to the SAME single identity.** The distinct dispatch identities '
      + `across all ${armRecords.length} arm records number exactly **1**: \`${lanes[0]}\`. This is `
      + 'the invariant that makes the comparison a measurement of CONCURRENCY. Had the arms differed '
      + 'here, the number below would be model speed and concurrency added together with no way to '
      + 'separate them.');
  } else {
    L.push('**THE ARMS DID NOT DISPATCH TO A SINGLE IDENTITY.** The distinct dispatch identities '
      + `across all ${armRecords.length} arm records number **${lanes.length}**: `
      + `${lanes.map((l) => `\`${l}\``).join(', ')}. **So any wall clock difference between the arms `
      + 'confounds model speed with concurrency**, and no speedup claimed over these records is a '
      + 'claim about coordination. This is reported rather than corrected, because correcting it '
      + 'after the fact would mean choosing which records to discard.');
  }
  L.push('');

  // FF-B281. This caveat governs how every number below is read, and it belongs
  // where the labels are rather than 200 lines later. Section 2 comes before the
  // numbers ON PURPOSE, and a caveat published after them is a caveat a reader
  // meets too late.
  L.push(`**What these arms are a measurement OF, before any number is read.** ${sourcesSentence(sources)}`);
  L.push('');

  // ── 3. the 6 metrics ───────────────────────────────────────────────────────
  L.push('## 3. The 6 metrics');
  L.push('');
  L.push('1 row per SC3 metric. A metric whose state is not `known` renders as the state word and its '
    + 'reason, never as a blank and never as 0.');
  L.push('');
  // FF-B282. The serial column shows 1 record, so it SAYS which one and it
  // publishes the spread beside it. A single number drawn from 4 without saying
  // so reads as the arm's value rather than as 1 observation of it.
  if (serial.length > 1) {
    const walls = serial
      .map((r) => r.doc.metrics.wall_clock_to_land)
      .filter((m) => m !== undefined && m.state === 'known')
      .map((m) => m.value);
    L.push(`**The serial column is 1 of ${serial.length} records, \`${serial[0].name}\`.** `
      + (walls.length > 1
        ? `Its wall clock to land spans ${num(Math.min(...walls))} to ${num(Math.max(...walls))} ms `
          + `across all ${serial.length}, and that spread IS sigma. Every other metric reads the same `
          + 'state on every record.'
        : 'Every other metric reads the same state on every record.'));
    L.push('');
  }
  // FF-B353. The fleet column gets the SAME treatment, and it needs it more: the
  // fleet column showing 1 of 2 records without saying so is the prose form of
  // the fold defect this row repaired.
  if (fleetRecords.length > 1) {
    const rates = fleetRecords
      .map((r) => r.doc.metrics.false_green_rate)
      .filter((m) => m !== undefined && m.state === 'known')
      .map((m) => m.value);
    L.push(`**The fleet column is 1 of ${fleetRecords.length} records, \`${fleetRecords[0].name}\`, `
      + 'and the POOLED column beside it is what the verdict actually read.** '
      + (rates.length > 1 && Math.min(...rates) !== Math.max(...rates)
        ? `Its false green rate spans ${num(Math.min(...rates))} to ${num(Math.max(...rates))} across `
          + `all ${fleetRecords.length}, so the single record column is 1 observation of the arm and `
          + 'never the arm.'
        : `The ${fleetRecords.length} records agree on the false green rate, which is luck rather `
          + 'than a reason to read 1 of them.'));
    L.push('');
  }
  L.push(`| metric | serial arm${serial.length > 1 ? `, \`${serial[0].name}\`` : ''} `
    + `| fleet arm${fleetRecords.length > 1 ? `, \`${fleetRecords[0].name}\`` : ''} `
    + `| fleet arm POOLED over ${fleetRecords.length} record${fleetRecords.length === 1 ? '' : 's'} |`);
  L.push('|---|---|---|---|');
  for (const [label, key] of METRIC_ROWS) {
    const s = serial.length === 0 ? null : serial[0].doc.metrics[key];
    const f = fleet === null ? null : fleet.doc.metrics[key];
    const sCell = s === null ? `\`${UNAVAILABLE}\`: no serial arm record was present` : metricCell(s);
    const fCell = f === null
      ? `\`${UNAVAILABLE}\`: ${fleetInfo.state === 'ran-not-comparable' ? 'the fleet arm ran and produced no comparable record' : 'no fleet arm was run'}`
      : metricCell(f);
    L.push(`| ${label} | ${escapeCell(sCell)} | ${escapeCell(fCell)} | ${escapeCell(pooledCell(pooled, key))} |`);
  }
  L.push('');
  L.push('### Why each dark metric is dark, and the 4 causes are different');
  L.push('');
  L.push('A report that listed these as merely unavailable would hide that only 1 of them is fixable '
    + 'by spending money.');
  L.push('');
  L.push('| metric | cause | id |');
  L.push('|---|---|---|');
  L.push('| demonstrated width | reports, and `known` 1 on the serial arm, which is correct BY '
    + 'DEFINITION for a width 1 arm rather than a limitation | none |');
  L.push('| land gate cost | reports on the land gate records. The SC3 fold looks for a `concurrency` '
    + 'field, and contention on a single holder mutex is queue depth, which section 5 now derives | FF-B252, largely invalid as filed |');
  // DERIVED. FF-B284, and this row was a LIVE false sentence. It asserted flatly
  // that the rate is UNDEFINED on any fleet arm because `verifyPostLand` reaches
  // no command line path. That was true while no fleet arm had ever classified
  // anything, and it would be emitted WORD FOR WORD over a fleet arm sitting in
  // the table 12 lines above it reporting a number. Whether the fleet arm
  // reported one is now READ OFF THE FOLD.
  // FF-B353. The number quoted here is the POOLED one, which is the number the
  // verdict read. Quoting `fleetRecords[0]` in the prose while the verdict read
  // the pooled figure would put 2 different rates for 1 arm in 1 document.
  L.push('| false green rate | reports `known` 0 on the serial arm from DECIDED classifications. '
    + `${pooled.false_green !== null
      ? `The fleet arm reported \`known\` ${num(pooled.false_green.rate)} POOLED over `
        + `${pooled.records} record${pooled.records === 1 ? '' : 's'} from its own DECIDED `
        + 'classifications, so FF-B272 is EVIDENCED CLOSED by a real arm here rather than by a test'
      : 'It is UNDEFINED on any fleet arm, because `verifyPostLand` is wired to no command line '
        + 'path'} | FF-B272 |`);
  L.push('| rounds per artifact | UNKNOWN for every arm: no anti loop log exists anywhere in this '
    + 'repository, so the metric has no source at all | FF-B274 |');
  // DERIVED. This row previously stated that the run spends nothing, which is a
  // claim about THIS run and was a literal. Over a run that dispatched live it
  // reports what the lane actually did instead.
  L.push(`| cost per landed increment | ${spend.liveRecords === 0
    ? 'no live dispatch occurred, so there is nothing for a lane to have reported'
    : (spend.state === 'known'
      ? `the lanes reported ${round2(spend.incurredUsd)} usd, and the figure is DILUTED whenever an `
        + 'arm mixes candidate sources'
      : 'a live dispatch DID occur and the lane reported no per call figure at all, so the metric is '
        + 'UNKNOWN rather than 0')} | FF-B253 and FF-B275 |`);
  L.push('');

  // ── 4. width ───────────────────────────────────────────────────────────────
  L.push('## 4. Width');
  L.push('');
  L.push('| number | value | source |');
  L.push('|---|---|---|');
  L.push(`| PERMITTED | ${permitted.state === 'known' ? num(permitted.value) : `\`${UNAVAILABLE}\``} | ${escapeCell(permitted.source)} |`);
  L.push(`| DEMONSTRATED | ${demonstrated === null ? `\`${UNAVAILABLE}\`` : num(demonstrated)} | the fleet arm run record fold |`);
  L.push(`| GAP | ${gap === null ? `\`${UNAVAILABLE}\`` : num(gap)} | permitted minus demonstrated |`);
  if (permitted.state !== 'known') {
    absent.push('the permitted width');
  }
  if (demonstrated === null) {
    absent.push('a demonstrated width');
  }
  L.push('');
  L.push('**The verdict credits only the DEMONSTRATED number.** '
    + '`.planning/MEASUREMENT-v1.14-PARALLELISM.md` finding 3 is the reason: this repository\'s '
    + 'permitted width has been 3 to 5 throughout its history while its demonstrated width was 1, '
    + 'and 0 of 28 same level plan pairs in v1.0 overlap in wall clock. Permitted width is what a '
    + 'fleet COULD have exploited and is never a width anything demonstrated.');
  L.push('');
  L.push('### AVAILABLE width, the third number, from plan 22-06');
  L.push('');
  L.push('A serial arm demonstrates a width of 1 by construction, so the demonstrated number alone '
    + 'cannot separate a sound decomposition held to 1 by policy from a decomposition that was never '
    + 'there. Plan 22-06 added AVAILABLE width, computed from the nodes actually built and the edges '
    + 'actually declared.');
  L.push('');
  L.push('| task | declared permitted | available | demonstrated |');
  L.push('|---|---|---|---|');
  L.push('| `ledger` | 2 | **2** | 1 |');
  L.push('| `router` | 2 | **2** | 1 |');
  L.push('| `schedule` | 2 | **2** | 1 |');
  L.push('');
  L.push('Available equals declared on all 3 multi module tasks, so the decomposition is SOUND and a '
    + 'fleet arm would have real width 2 to exploit on 3 tasks. The width of 1 in the baseline is the '
    + 'serial arm doing what a serial arm must do.');
  L.push('');

  // ── 5. the land gate ───────────────────────────────────────────────────────
  L.push('## 5. The land gate');
  L.push('');
  if (curve.length === 0) {
    absent.push('the land gate cost curve');
    L.push(`**\`${UNAVAILABLE}\`.** No record in the records directory carries a closed gate interval `
      + 'with a usable configuration, so there is no cost curve, no degradation ratio and no cold '
      + 'single gate median. The whole section is unavailable rather than partially rendered from '
      + 'whatever happened to be present.');
    L.push('');
  } else {
    const baseline = curve.find((r) => r.gates === 1 && r.load === 0) || null;
    const warm = baseline === null ? null : baseline.min_ms;
    L.push('**FF-B258.** `foldLandGateCost` computes a degradation only WITHIN a single record and '
      + 'each record below is 1 configuration, so a per record degradation of 1.0 is a curve with 1 '
      + 'point on it rather than a flat curve. The curve is assembled ACROSS records here, keyed on '
      + 'the configuration each record declares.');
    L.push('');
    L.push('| configuration | record | n | minimum ms | median ms | maximum ms | green | red |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const row of curve) {
      L.push(`| ${row.gates} gate${row.gates === 1 ? '' : 's'}, ${row.load} background build${row.load === 1 ? '' : 's'} `
        + `| \`${row.record}\` | ${row.n} | ${row.min_ms === null ? UNAVAILABLE : num(row.min_ms)} `
        + `| ${num(row.median_ms)} | ${num(row.max_ms)} | ${row.green} | ${row.red} |`);
    }
    L.push('');
    if (warm !== null) {
      L.push(`**The warm single gate baseline is ${num(warm)} ms and the cold one is ${num(baseline.max_ms)} ms.** `
        + 'Cold means the eslint cache was deleted first, which is what a fresh worktree gets and is '
        + 'the method `MEASUREMENT-v1.14-PARALLELISM.md` used.');
      L.push('');
      L.push('| configuration | median ms | ratio against the warm baseline |');
      L.push('|---|---|---|');
      for (const row of curve) {
        const ratio = warm === 0 ? null : row.median_ms / warm;
        L.push(`| ${row.gates} gate${row.gates === 1 ? '' : 's'}, ${row.load} background build${row.load === 1 ? '' : 's'} `
          + `| ${num(row.median_ms)} | ${ratio === null ? UNAVAILABLE : num(ratio)} |`);
      }
      L.push('');
      L.push('### The 2 arms point in OPPOSITE directions, and that is the finding');
      L.push('');
      L.push('- **Concurrent gates degrade badly**, and worse, the gate stops passing at all under '
        + 'them.');
      L.push('- **Background build load barely degrades**, and the curve is effectively FLAT from 2 '
        + 'builds to 4.');
      L.push('- **The land gate is a SINGLE HOLDER MUTEX and never runs concurrent gates**, so the '
        + 'FLAT curve is the one that governs real throughput. A reader who takes the concurrent gate '
        + 'ratio as the operating condition will draw the wrong conclusion.');
      L.push('');
      L.push('### The red gates are FALSE REDS, not false greens');
      L.push('');
      L.push('Every red above was chased rather than reported. All are `spawnSync npm ETIMEDOUT` in '
        + '`tests/release-tarball-smoke.install.test.cjs` under CPU contention. The same suite passes '
        + 'serially and the tracked tree was byte identical after every run, so the gate does not '
        + 'become logically wrong under contention: it becomes slower, and 1 test\'s fixed install '
        + 'timeout converts that slowness into a red. Recorded as FF-B257. They must not be read as '
        + 'gate failures without this qualification.');
      L.push('');
      L.push('### The divergence from the 40 second figure, stated and NOT reconciled');
      L.push('');
      L.push('| source | figure |');
      L.push('|---|---|');
      L.push('| `.planning/MEASUREMENT-v1.14-PARALLELISM.md` | 40 s cold, 36 s warm, at 1430 tests |');
      L.push(`| this measurement | ${num(baseline.max_ms / 1000)} s cold, ${num(warm / 1000)} s warm |`);
      L.push('');
      L.push('The figure the milestone leaned on is stale by roughly a factor of 3 while the suite '
        + 'grew by roughly 1.62 times, so test count alone does not account for it. No attempt is '
        + 'made here to reconcile the 2 numbers. **This bears on the Speculation park recorded in '
        + '`.planning/ROADMAP.md` phase 22, which was parked on the reasoning that optimising a 40 '
        + 'second gate is optimising a non problem.** That premise is restated here against the '
        + 'measured figure. This report does not unpark Speculation and does not propose rebuilding '
        + 'it: publishing the number is the whole job and the decision belongs to a human.');
      L.push('');
    }
  }

  L.push('### Contention depth, DERIVED rather than read from a field');
  L.push('');
  L.push('2 quantities, named apart and never merged. PROCESS CONCURRENCY is the `concurrency` field '
    + 'a harness that starts N gate processes can observe directly, and plan 22-05 writes it. '
    + 'CONTENTION DEPTH is how many increments were inside the land queue when a gate began, which '
    + 'nothing records and which plan 22-07 derives by pairing `queue_entered` with `land_completed`.');
  L.push('');
  L.push('| record | contention depth | state |');
  L.push('|---|---|---|');
  for (const record of records) {
    const c = record.contention;
    L.push(`| \`${record.name}\` | ${c.depth === null ? `\`${UNAVAILABLE}\`` : num(c.depth)} | \`${c.state}\`: ${escapeCell(c.reason === '' ? 'derived' : c.reason)} |`);
  }
  if (records.length === 0) L.push(`| none | \`${UNAVAILABLE}\` | no record was present |`);
  L.push('');
  const anyDepth = records.some((r) => r.contention.state === 'known');
  if (!anyDepth) {
    absent.push('a derived land gate contention depth');
    L.push('**No published record yields a contention depth**, and the 2 reasons are different facts. '
      + 'The land gate harness records describe no queue at all because they time gate processes '
      + 'directly. The corpus baseline records carry land completions for increments that were never '
      + 'seen to queue, because the corpus runner lands in process. Both become a real number with no '
      + 'further code change the moment a run through `src/fleet-landqueue.cts` is recorded, which is '
      + 'exactly what that module emits its 5 instants for.');
    L.push('');
  }

  // ── 6. the land failure rate ───────────────────────────────────────────────
  L.push('## 6. The land failure rate');
  L.push('');
  L.push('**This is SC4 and it is the number Speculation was always gated on.** The 3 numbers below '
    + 'are 3 different things, so each carries its own provenance and 1 being absent does not remove '
    + 'the other 2.');
  L.push('');
  L.push('| number | value | provenance | against the 10 percent gate |');
  L.push('|---|---|---|---|');

  const seeded = serial.length === 0 ? null : serial[0].doc.metrics.false_green_rate;
  if (seeded === null) {
    L.push(`| seeded and measured | \`${UNAVAILABLE}\` | none | ${UNAVAILABLE} |`);
  } else if (seeded.state === 'known') {
    L.push(`| measured on the serial arm | ${num(seeded.value)} | \`${serial[0].provenance}\` | `
      + `${seeded.value > threshold ? '**ABOVE**' : 'at or below'} |`);
  } else {
    L.push(`| measured on the serial arm | \`${seeded.state}\` | \`${serial[0].provenance}\` | ${UNAVAILABLE} |`);
  }

  if (history.state === 'known') {
    L.push(`| historical, over this repository | ${num(history.rate)} | \`${history.provenance}\`, `
      + `bound \`${history.bound}\` | ${history.rate > threshold ? '**ABOVE**' : 'at or below'} |`);
  } else {
    absent.push('the historical land failure rate');
    L.push(`| historical, over this repository | \`${UNAVAILABLE}\` | none | ${UNAVAILABLE} |`);
  }

  // FF-B353. The POOLED rate, because that is the rate the verdict read, and its
  // comparison against the threshold declared in CONTEXT D8 is now filled in
  // rather than left unavailable: the number exists, so the comparison exists.
  if (fleetRecords.length === 0) {
    L.push(`| on a fleet corpus run | \`${UNAVAILABLE}\` | no fleet arm was run | ${UNAVAILABLE} |`);
  } else if (pooled.false_green === null) {
    L.push(`| on a fleet corpus run | \`${UNAVAILABLE}\` | ${pooled.records} fleet record`
      + `${pooled.records === 1 ? '' : 's'}, at least 1 of which reports no poolable rate | ${UNAVAILABLE} |`);
  } else {
    L.push(`| on a fleet corpus run, POOLED over ${pooled.records} record`
      + `${pooled.records === 1 ? '' : 's'} | ${num(pooled.false_green.rate)} `
      + `(${num(pooled.false_green.false_greens)} over ${num(pooled.false_green.landed)}) | `
      + `\`${fleetRecords[0].provenance}\` | `
      + `${pooled.false_green.rate > threshold ? '**ABOVE**' : 'at or below'} |`);
  }
  L.push('');

  if (history.state === 'known') {
    L.push('### The historical number, its query and its caveats');
    L.push('');
    L.push('| field | value |');
    L.push('|---|---|');
    L.push(`| rate | **${num(history.rate)}** |`);
    L.push(`| provenance | \`${history.provenance}\` |`);
    L.push(`| bound | \`${history.bound}\` |`);
    L.push(`| subjects read | ${history.subjects_read} |`);
    L.push(`| landed pairs | ${history.landed_pairs} |`);
    L.push(`| failed later pairs | ${history.failed_later_pairs} |`);
    L.push(`| query | \`${escapeCell(history.query)}\` |`);
    L.push('');
    L.push(`Failed later: ${history.failed_later}`);
    L.push('');
    L.push('The caveats, published with the number rather than buried:');
    L.push('');
    for (let i = 0; i < history.caveats.length; i++) L.push(`${i + 1}. ${history.caveats[i]}`);
    L.push('');
    L.push('**It is a LOWER BOUND and must never be quoted as the measured land failure rate.** It is '
      + 'also a query over git history, so it moves whenever a commit lands, which makes it the 1 '
      + 'deliberately volatile input of this document.');
    L.push('');
  } else {
    L.push(`**\`${UNAVAILABLE}\`.** ${history.reason}`);
    L.push('');
  }

  // ── 7. the corpus ──────────────────────────────────────────────────────────
  L.push('## 7. The corpus');
  L.push('');
  L.push('| property | value |');
  L.push('|---|---|');
  L.push(`| tasks | ${corpus.total} |`);
  L.push(`| single file tasks | ${corpus.single} |`);
  L.push(`| multi file tasks, the only ones with declared parallel structure | ${corpus.multi} |`);
  L.push(`| tasks carrying a hidden gate | ${corpus.hidden} of ${corpus.total} |`);
  L.push(`| corpus hash | \`${corpus.hash}\` |`);
  // THE SUBSET THAT RAN, published beside the corpus it was drawn from. The hash
  // digests the whole TREE and is invariant under the selection, so 2 arms can
  // carry 1 identical hash while attempting DIFFERENT work. The hash is the guard
  // on the tree; this row is what lets a reader check the selection.
  L.push(`| tasks the run ATTEMPTED | ${subset === null ? `\`${UNAVAILABLE}\`, no subset was declared`
    : `\`${escapeCell(subset)}\``} |`);
  L.push('');
  L.push(`**The hidden gate coverage gap is reported rather than filled.** The ${corpus.withoutHidden.length} `
    + `task${corpus.withoutHidden.length === 1 ? '' : 's'} with no hidden gate: `
    + `${corpus.withoutHidden.map((t) => `\`${t}\``).join(', ')}. For those the \`shallow\` fixture is `
    + 'undefined by construction, so no discrimination beyond the visible gate can be shown for them.');
  L.push('');
  L.push('### Saturation, per arm');
  L.push('');
  L.push('| arm | record | observations | at full | distinct | verdict |');
  L.push('|---|---|---|---|---|---|');
  if (armRecords.length === 0) {
    L.push(`| ${UNAVAILABLE} | none | 0 | 0 | 0 | \`${UNAVAILABLE}\` |`);
  }
  for (const record of armRecords) {
    const s = record.saturation;
    // THE VERDICT IS NOT QUOTED OVER FEWER THAN 2 OBSERVATIONS. The shipped
    // detector returns `discriminating` for an EMPTY axis while its own note
    // says saturation is not claimed there, so a reader taking the verdict word
    // alone would read "this corpus separates candidates" off 0 observations.
    // That is a verdict nobody measured, and it is adapted at the reader rather
    // than by editing the detector. Recorded as FF-B269.
    const verdict = s.n < 2 ? `not claimed over ${s.n} observations` : s.verdict;
    L.push(`| ${record.arm} | \`${record.name}\` | ${s.n} | ${s.full} | ${s.distinct_pct} | \`${verdict}\` |`);
  }
  L.push('');
  L.push('**A SATURATED visible axis separates nothing, and it is the recorded v1.6 outcome this '
    + `apparatus exists to be able to reproduce.** ${sourcesSentence(sources)}`);
  L.push('');

  // ── 7b. whether the corpus DISCRIMINATED, as a number ─────────────────────
  //
  // The saturation table above answers whether the GATES separate candidates.
  // This answers the other half, which is whether the per node work is large
  // enough that a fleet has anything to win: an agent latency at or below the
  // harness floor means the coordination structure is drowned by fixed cost and
  // the comparison measures the harness. `L_min` is obtained by INVOKING the
  // instrument for this run's exact subset, never retyped from a plan.
  L.push('### Whether the corpus discriminated: the measured latency against the floor');
  L.push('');
  L.push('| number | value | source |');
  L.push('|---|---|---|');
  if (latency.state === 'known') {
    L.push(`| measured per node agent latency, median | **${latency.value} ms** | folded from `
      + `${latency.n} \`recorded_runtime_ms\` values on \`worker_ended\` across ${armRecords.length} `
      + `arm records, range ${latency.min} to ${latency.max} ms |`);
  } else {
    L.push(`| measured per node agent latency, median | \`${UNAVAILABLE}\` | ${escapeCell(latency.reason)} |`);
  }
  if (floor.state === 'known') {
    L.push(`| \`L_min\`, the corpus floor | **${floor.value} ms** | \`${escapeCell(floor.source)}\`, `
      + `computed for \`${floor.tasks.join(',')}\` over ${floor.nodes} nodes in ${floor.rounds} rounds |`);
  } else {
    L.push(`| \`L_min\`, the corpus floor | \`${UNAVAILABLE}\` | ${escapeCell(floor.reason)} |`);
  }
  if (latency.state === 'known' && floor.state === 'known' && floor.value > 0) {
    const ratio = (latency.value / floor.value).toFixed(1);
    const cleared = latency.value > floor.value;
    L.push(`| the comparison | ${latency.value} ms is ${cleared ? 'ABOVE' : 'AT OR BELOW'} the floor of `
      + `${floor.value} ms, a ratio of **${ratio}** | recompute it: divide the median by the floor |`);
    L.push('');
    L.push(`**So the corpus ${cleared ? 'DISCRIMINATED' : 'DID NOT discriminate'}.** `
      + (cleared
        ? 'The per node agent latency is larger than the fixed cost of running the harness, so a '
          + 'saving from coordination is a thing the wall clock can show rather than a thing the '
          + 'fixed cost absorbs.'
        : 'The per node agent latency is at or under the fixed cost of running the harness, so any '
          + 'wall clock difference between the arms is dominated by the harness rather than by the '
          + 'work, and no saving from coordination could be separated from it.'));
  } else {
    L.push('| the comparison | **not made** | 1 of the 2 numbers is unavailable |');
    L.push('');
    L.push('**Whether the corpus discriminated is NOT ANSWERED, and the comparison could NOT be '
      + 'made.** The 2 numbers it needs are published above with their states, and 1 of them is '
      + 'unavailable. This is reported as an absence rather than filled with an estimate: a floor '
      + 'nobody measured propagates straight into the answer and produces a wrong verdict rather '
      + 'than a conservative one.');
  }
  L.push('');

  // ── 8. guards observed to fire ─────────────────────────────────────────────
  L.push('## 8. Guards that were observed to fire');
  L.push('');
  L.push('1 row per named trivial pass from `CONTEXT.md` D13, with the plan and the test that fired '
    + 'it. **A report that claims a guard exists without naming where it was seen to fire is the '
    + 'defect class this phase reports on**, so the renderer refuses to publish a row with no named '
    + 'test.');
  L.push('');
  L.push('| id | what passes trivially | the positive case | what the guard reported | plan | test |');
  L.push('|---|---|---|---|---|---|');
  for (const guard of guards) {
    L.push(`| ${guard.id} | ${escapeCell(guard.trivial_pass)} | ${escapeCell(guard.positive_case)} | `
      + `${escapeCell(guard.reported)} | ${guard.plan} | \`${escapeCell(guard.test)}\` |`);
  }
  L.push('');

  // ── 9. what this report does not claim ─────────────────────────────────────
  L.push('## 9. What this report does not claim');
  L.push('');
  L.push('Written last and generated from what the other sections found absent, so it cannot drift '
    + 'from them.');
  L.push('');
  L.push('### Absent inputs, collected from the sections above');
  L.push('');
  if (absent.length === 0) {
    L.push('None. Every input the verdict needs was present.');
  } else {
    for (const item of absent) L.push(`- ${item}`);
  }
  L.push('');
  L.push('### Named limits');
  L.push('');
  // EVERY LIMIT IS DERIVED OR IS A STANDING PROPERTY OF THE APPARATUS. The list
  // is built as an array so the numbering cannot drift when a limit is added,
  // and so a limit whose condition no longer holds DISAPPEARS instead of being
  // published as a false sentence. That is the FF-B284 class again.
  const limits = [];
  limits.push(`**What these arms measure.** ${sourcesSentence(sources)}`);
  if (spend.liveRecords === 0) {
    limits.push('**The live builder was NOT run.** No arm record carries provenance `measured`, so '
      + 'no adapter was dispatched and no number here is evidence about any model. FF-B262.');
  } else {
    limits.push(`**The live builder RAN, and what it cost is ${spend.state === 'known'
      ? `${round2(spend.incurredUsd)} usd as reported by the lane`
      : '`unknown`'}.** ${spend.state === 'known'
      ? 'FF-B253 closes by a number for this run.'
      : 'The lane reported no per call figure on any of the dispatches, so cost per landed increment '
        + 'is UNDEFINED and **is not written as 0**. FF-B253 does NOT close by a number here: a rate '
        + 'of 0 and a rate nobody measured are different claims, and reporting the first would be a '
        + 'fabricated figure.'}`);
  }
  if (corpus.withoutHidden.length > 0) {
    // THE SHORTFALL IS NAMED AGAINST THE SUBSET THAT RAN, not against the whole
    // corpus. A task with no hidden gate that was never attempted cannot weaken
    // this run's false green rate, and reporting it as if it could would overstate
    // the caveat as badly as omitting it would understate it.
    const attempted = subset === null ? null : subset.split(',').map((t) => t.trim());
    const affected = attempted === null
      ? null
      : corpus.withoutHidden.filter((t) => attempted.includes(t));
    limits.push(`**${corpus.withoutHidden.length} of the ${corpus.total} corpus tasks carry no hidden `
      + 'gate**, so `shallow` is undefined for them by construction and no depth beyond the visible '
      + `gate can be shown for them. ${affected === null
        ? 'Whether any of them was in this run is not declared, so the shortfall on the false green '
          + 'rate is not bounded here.'
        : (affected.length === 0
          ? `**0 of them were in this run**, whose attempted subset is \`${escapeCell(subset)}\`, so `
            + 'the false green rate below carries no shortfall from this cause.'
          : `**${affected.length} of them WERE in this run**: `
            + `${affected.map((t) => `\`${t}\``).join(', ')}. The false green rate below is blind on `
            + 'those tasks.')} FF-B277.`);
  }
  limits.push('**The historical land failure rate is a LOWER BOUND**, derived from commit subjects '
    + 'alone. A failure repaired silently inside a later plan is invisible to it, which pushes the '
    + 'number down, and a repair committed during a plan\'s own execution is counted, which pushes it '
    + 'up. It must never be quoted as the measured rate.');
  // ── FF-B284 REPAIR, AND IT IS THIS SECTION'S OWN DEFECT CLASS ──────────────
  //
  // This limit used to end with the flat assertion that rounds are "the clause
  // that held the verdict below POSITIVE". That was TRUE while the POSITIVE
  // branch pushed its rounds blocker unconditionally, and FF-B346 removed that
  // blocker: unknown rounds are now excluded from the gate in BOTH directions.
  // The sentence would have been emitted WORD FOR WORD over a verdict that no
  // round count went anywhere near, which is the FF-B284 class exactly.
  //
  // So the clause is DERIVED, and it is derived from the SAME condition the
  // shipped rule uses: rounds bear on the gate only when they are KNOWN on every
  // arm. Reading the verdict's prose instead would be wrong, because the POSITIVE
  // reason names rounds even when it is naming them as EXCLUDED.
  const roundsDecided = armRecords.length > 0 && armRecords.every((r) => r.doc !== null
    && r.doc.metrics.rounds_per_artifact !== undefined
    && r.doc.metrics.rounds_per_artifact !== null
    && r.doc.metrics.rounds_per_artifact.state === 'known');
  const roundsClause = roundsDecided
    ? '**A clause naming rounds appears in the verdict above**, so this metric did bear on the '
      + 'outcome, and no log was manufactured to move it.'
    : '**No clause in the verdict above names rounds, so this metric decided nothing here.** '
      + 'Unknown rounds are excluded from the gate in BOTH directions rather than blocking a '
      + 'POSITIVE a corpus arm could never clear, FF-B346, and no round count is fabricated to '
      + 'fill the gap.';
  limits.push('**Rounds per artifact is UNKNOWN for every arm**, because no anti loop log exists '
    + 'anywhere in this repository. A benchmark run opens no review rounds of its own, so this metric '
    + `may be structurally inapplicable to a corpus arm. ${roundsClause} FF-B274.`);
  limits.push('**A replayed arm can never return POSITIVE.** Replayed latencies exhibit no '
    + 'contention, no queueing and no gate degradation by construction, so they can show a ceiling '
    + 'and can show a regression and cannot show that a fleet is faster. This is a guard, not a '
    + 'limitation.');
  // ── THE LIMITS THIS RUN ITSELF CREATES ────────────────────────────────────
  limits.push('**The fleet arm\'s concurrency is its OWN build children, not the loop\'s plan '
    + 'dispatch.** No bridge from corpus nodes onto `scripts/fleet-loop.cjs` plan dispatch is built '
    + 'and none is claimed. The loop was invoked for its PREFLIGHT, which is the gate on whether the '
    + 'fleet arm may run at all, and not as the thing that scheduled these nodes. FF-B267.');
  limits.push('**A task lands only on a FULL visible gate.** `scripts/bench-run.cjs` sets `landed` '
    + 'from whether the visible gate scored every check, so a task 1 check short emits no '
    + '`land_completed` and no `post_land_truth` and contributes to neither the wall clock nor the '
    + 'false green rate. The landed counts below are therefore a subset of the attempted nodes, and '
    + 'the bar was NOT lowered to obtain a comparison.');
  if (floor.state !== 'known') {
    limits.push('**The corpus floor comparison could NOT be made, so whether the corpus '
      + `discriminated is not answered by a number.** ${escapeCell(floor.reason)} The measured `
      + `latency is published beside it regardless, and a floor nobody measured was NOT substituted `
      + 'with an estimate: a deflated floor produces an UNEARNED POSITIVE, which is the mirror of the '
      + 'inflated floor this refusal exists to prevent. FF-B312.');
  }
  // ── THE SUPERSEDED MEASUREMENTS, DERIVED FROM THE DIRECTORY ────────────────
  //
  // Present only when a superseded record is actually on disk. Over a records
  // directory holding no subdirectory this limit DOES NOT APPEAR, which is the
  // required failing arm for a sentence that would otherwise be a literal.
  if (Array.isArray(superseded) && superseded.length > 0) {
    const total = superseded.reduce((sum, s) => sum + s.count, 0);
    const named = superseded.map((s) => `\`${escapeCell(s.dir)}/\` holding ${s.count} `
      + `record${s.count === 1 ? '' : 's'}`).join(', ');
    limits.push(`**${total} SUPERSEDED record${total === 1 ? ' is' : 's are'} retained on disk and `
      + `deliberately outside this verdict's input set**, under ${named}. A record is superseded when `
      + 'the apparatus that produced it no longer exists, and this repository has superseded records '
      + 'for exactly 2 reasons. **The corpus hash MOVED**, so records taken against the old tree are '
      + 'not comparable and `corpus_hash` is what refuses to compare across it. **And the fleet '
      + 'scheduler was REPAIRED**: FF-B343, a scan that stopped at the first blocked node instead of '
      + 'skipping it; FF-B344, a batch barrier that left a freed lane idle until its slowest sibling '
      + 'exited; and FF-B345, a dispatch width silently clamped to the per task declared width. '
      + 'FF-B346 separately removed a blocker that made POSITIVE unreachable. **A verdict published '
      + 'from a superseded record describes an apparatus that is gone**, and this document does not '
      + 'carry one forward. **They are MOVED and never deleted**, because a superseded measurement is '
      + 'real evidence about the apparatus it ran on and destroying it would destroy the record of '
      + 'what was wrong. Both directory readers here are non recursive, so a subdirectory is out of '
      + 'the input set while remaining on disk and in git history.');
  }
  limits.push('**The false green rate is computed from DECIDED classifications only.** A task that '
    + 'never landed has no classification at all, so the rate is over the increments that landed and '
    + 'not over everything attempted. A rate of 0 over a small decided set is a weaker statement than '
    + 'the same rate over a large one, and the decided count is published beside it.');
  for (let i = 0; i < limits.length; i++) L.push(`${i + 1}. ${limits[i]}`);
  L.push('');
  L.push('### Why the fleet arm is absent, from the artifact that recorded it');
  L.push('');
  if (fleetInfo.state === 'refused') {
    const r = fleetInfo.evidence;
    L.push(`Read from \`${escapeCell(r.file)}\` in the records directory. **The reason is quoted `
      + 'verbatim from the preflight and is not retyped here.**');
    L.push('');
    for (const check of r.refused_checks) {
      L.push('```');
      L.push(`${check.name}: ${check.refused_because}`);
      L.push('```');
      L.push('');
    }
    if (Array.isArray(r.green_checks) && r.green_checks.length > 0) {
      L.push(`Preconditions observed GREEN: ${r.green_checks.map((c) => `\`${c}\``).join(', ')}. `
        + 'So the loop is present and working, and it refused for a stated reason rather than '
        + 'failing.');
      L.push('');
    }
    // ── FF-B287. EACH CLAUSE DERIVED FROM ITS OWN FIELD ────────────────────
    //
    // This used to assert, immediately after printing the roster count it had
    // just read, that the run cost nothing and no adapter was configured. With a
    // roster of 3 and a refusal from a check that is NOT the adapters check, the
    // document would have read "held 3 entries" and then that nothing was
    // configured, in adjacent clauses of 1 sentence. So each clause now comes
    // from the field that decides it: the roster LENGTH for whether adapters were
    // configured, and the REFUSING CHECK IDENTITY for whether any was invoked. A
    // preflight that refused at `adapters` never reached a probe; one that
    // refused at `base` or `serializer` may have probed every lane in the roster.
    const roster = Array.isArray(r.adapter_roster) ? r.adapter_roster : [];
    const refusedNames = (Array.isArray(r.refused_checks) ? r.refused_checks : [])
      .map((c) => String(c && c.name)).filter((n) => n !== 'undefined' && n !== '');
    const refusedAtAdapters = refusedNames.includes('adapters');
    L.push(`The adapter roster read from \`${escapeCell(r.adapter_config_key)}\` held `
      + `${roster.length} entries${roster.length === 0 ? '' : `: ${roster.map((a) => `\`${escapeCell(String(a))}\``).join(', ')}`}. `
      + `The refusing check is \`${refusedNames.join('`, `')}\`.`);
    L.push('');
    if (roster.length === 0) {
      L.push('**So no adapter was configured, none was invoked, and no model endpoint was '
        + 'contacted.** The roster is empty, so there was nothing to probe, and a probe that never '
        + 'ran reached nothing. Every clause is read off the artifact rather than asserted, and this '
        + 'is the world in which the statement is TRUE.');
    } else if (refusedAtAdapters) {
      L.push(`**${roster.length} adapters WERE configured, and the preflight refused AT the adapters `
        + 'check.** So the roster is not empty and the refusal is about the lanes themselves. Whether '
        + 'a probe reached a model endpoint before refusing is not recorded in this artifact, so this '
        + 'document does not claim either way.');
    } else {
      L.push(`**${roster.length} adapters WERE configured, and the preflight refused at `
        + `\`${refusedNames.join('`, `')}\` rather than at the adapters check.** So this document `
        + 'makes NO claim about the roster being unset and NO claim about what the run cost: a '
        + 'preflight that refused elsewhere may have probed every lane in the roster first, and the '
        + 'artifact does not record whether it did.');
    }
  } else if (fleetInfo.state === 'ran-and-refusal-present') {
    // ── FF-B289. BOTH FACTS, RATHER THAN THE FIRST CONSUMING THE SECOND ────
    const r = fleetInfo.evidence;
    L.push('**The fleet arm RAN AND a refusal artifact is also present.** These are 2 facts about '
      + 'the directory and both are reported. A reader who saw only the record would not know a '
      + 'refusal had been recorded, and a document that reported no refusal over a directory holding '
      + `one would be stating something false. Read from \`${escapeCell(r.file)}\`:`);
    L.push('');
    L.push('```');
    L.push(String(r.reason));
    L.push('```');
    L.push('');
    L.push('**The refusal does NOT invalidate the arm that ran and the arm does NOT retire the '
      + 'refusal.** A refusal artifact records a dispatch attempt that correctly declined; the arm '
      + 'record records one that proceeded. Which came first is not derivable from either, so this '
      + 'document does not order them.');
  } else if (fleetInfo.state === 'ran-not-comparable') {
    L.push(`The fleet arm RAN. \`${escapeCell(fleetInfo.evidence.name)}\` declares itself the fleet `
      + `arm and was excluded from the comparison because ${escapeCell(fleetInfo.evidence.reason)}. `
      + '**No refusal is claimed**, because none was recorded.');
  } else if (fleetRecords.length === 0) {
    L.push('**Not recorded.** No fleet arm record and no refusal artifact is present, so this '
      + 'document cannot say why the fleet arm is absent, and it does not guess. Inferring a refusal '
      + 'from an absence would let a reader mistake something that did not work for something that '
      + 'correctly declined to run.');
  } else {
    L.push('Not applicable: a fleet arm is present and is reported in section 2, and no refusal '
      + 'artifact is present in the records directory.');
  }
  L.push('');
  L.push('### The wire shape divergence from phase 19, by field name');
  L.push('');
  L.push('`CONTEXT.md` D10 declared a wire shape and phase 19 shipped a different one. **The producer '
    + 'is the authority**, so the reader adapted and the divergence is recorded here. The validator '
    + 'was NEVER widened to accept both shapes: a validator that accepts 2 shapes cannot tell a '
    + 'malformed record from a new one.');
  L.push('');
  L.push('| field | D10 declared | what ships | what the reader did |');
  L.push('|---|---|---|---|');
  L.push('| `kind` spelling | hyphenated, `run-started` | underscored, `run_started` | adopted the shipped spelling |');
  L.push('| kind count | 11, then a correction naming 14 | **16** | reads the shipped constant at runtime and transcribes nothing |');
  L.push('| `worker_ended.outcome` | `done`, `failed`, `abandoned` | `completed`, `failed`, **`abnormal`** | an abnormal exit CLOSES an interval and the arm emits `abnormal` |');
  L.push('| `post_land_truth.classification` | `held`, `failed-later` | `held`, **`false_green`**, `unknown` | the false green numerator is `false_green`, and `unknown` is NOT a classification |');
  L.push('| `gate_ended.outcome` | `outcome` | **`verdict`** | validates `verdict` |');
  L.push('| `gate_started.concurrency` | declared | not written by the land queue | the SC3 fold reports UNKNOWN by name, and section 5 DERIVES contention depth instead |');
  L.push('| a `cost` kind carrying `usd` | declared | **no such kind exists** | cost reads `usd` off any event carrying one, UNDEFINED when none does |');
  L.push('| `land_completed.result` | implied a closed set | free form, for example `aborted:exit-3` | classified by FAMILY, and an unrecognised family is UNKNOWN |');
  L.push('| `run_started.arm`, `.provenance`, `.corpus_hash` | declared on `run_started` | **NONE of the 3 is written by `scripts/fleet-loop.cjs`** | see below |');
  L.push('');
  L.push('### FF-B280, and exactly what the reader supplied');
  L.push('');
  L.push('`scripts/fleet-loop.cjs` contains exactly 2 `run_started` appends, on the preflight refused '
    + 'path and on the dispatching path, and both append exactly `{ ts, kind, run_id, '
    + 'graph_generation, phase }`. The phase 22 validator requires `arm`, `provenance` and '
    + '`corpus_hash` in addition. **So a fully live and fully successful fleet run produces a record '
    + 'refused with 3 codes at event 0, and the fleet arm was unfoldable regardless of spend.**');
  L.push('');
  L.push('It was closed AT THE READER and nowhere else, and the 3 supplied fields are named here '
    + 'because a reader that silently repairs a producer is indistinguishable from one that '
    + 'fabricates:');
  L.push('');
  L.push('| field | what the reader supplied | why it may |');
  L.push('|---|---|---|');
  L.push('| `arm` | `fleet` | the fleet arm reader knows which arm it is |');
  L.push('| `provenance` | `measured` only for a real dispatch, and `unavailable` for a refused or replayed one | it knows whether a dispatch happened |');
  L.push('| `corpus_hash` | the hash from the run context it already holds | it indexed that corpus itself |');
  L.push('');
  L.push('The codes observed BEFORE adaptation were `E_PR_ARM_UNKNOWN`, `E_PR_CORPUS_HASH_MISSING` '
    + 'and `E_PR_PROVENANCE_UNKNOWN`, and the completed record validates with 0 errors. **The '
    + '`corpus_hash` requirement was NOT relaxed.** It is the single guard that refuses to compare 2 '
    + 'arms which did not run the same work, and removing it would quietly destroy the comparison '
    + 'this milestone exists to make. No phase 19 or phase 20 emitter was edited.');
  L.push('');
  L.push('### The fleet arm parallelism, stated rather than claimed');
  L.push('');
  L.push('The fleet arm\'s loop probe observes the real phase 19 dispatch entry point, and its '
    + 'concurrency is its own build child processes rather than the loop\'s own plan dispatch. No '
    + 'harness isolation flag appears anywhere in the runner, and the per node workspace follows the '
    + 'loop\'s own `worktreeOf` convention. **Bridging corpus nodes onto the loop\'s plan dispatch is '
    + 'not built and is not claimed.** Because the loop refuses, no fleet dispatch happened at all, '
    + 'so nothing in this document rests on that path.');
  L.push('');
  L.push('---');
  L.push('');
  L.push('*Every number above carries a provenance and a state. A metric that is not `known` is '
    + 'rendered as its state and its reason, never as 0.*');
  L.push('');

  return `${L.join('\n')}`;
}

// ─── the check idiom ─────────────────────────────────────────────────────────

/** Split a rendered document into named sections, so a difference can be named. */
function sectionsOf(text) {
  const map = new Map();
  let current = 'the preamble';
  const buffer = [];
  const flush = () => {
    map.set(current, buffer.join('\n'));
    buffer.length = 0;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      flush();
      current = line.slice(3).trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return map;
}

function differingSections(rendered, written) {
  const a = sectionsOf(rendered);
  const b = sectionsOf(written);
  const names = [...new Set([...a.keys(), ...b.keys()])];
  return names.filter((name) => a.get(name) !== b.get(name));
}

// ─── main ────────────────────────────────────────────────────────────────────

function loadGuards(argv) {
  if (argv.guards === null) return OBSERVED_GUARDS;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(argv.guards, 'utf8'));
  } catch (error) {
    throw new ExitError(1, `[E_PR_GUARDS_UNREADABLE] --guards ${argv.guards}: ${String(error && error.message)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new ExitError(1, '[E_PR_GUARDS_UNREADABLE] --guards must name a JSON array of guard rows.');
  }
  return parsed;
}

/**
 * A guard row with no named test FAILS the render.
 *
 * The row would otherwise assert that a guard exists while naming nowhere it was
 * seen to fire, which is exactly the claim this phase exists to report on. The
 * count is asserted non zero FIRST, because "every guard has a test" is
 * vacuously true of 0 guards.
 */
function assertGuardsObserved(guards) {
  if (guards.length === 0) {
    throw new ExitError(
      1,
      '[E_PR_GUARDS_EMPTY] the guard table is empty, so section 8 would claim nothing at all. '
        + '"every guard was observed firing" is vacuously true of 0 guards.',
    );
  }
  const unobserved = guards.filter(
    (g) => g === null || typeof g !== 'object' || typeof g.test !== 'string' || g.test.trim() === '',
  );
  if (unobserved.length > 0) {
    const names = unobserved.map((g) => (g !== null && typeof g === 'object' && g.id !== undefined ? String(g.id) : 'an unnamed row'));
    throw new ExitError(
      1,
      `[E_PR_GUARD_UNOBSERVED] ${unobserved.length} guard row${unobserved.length === 1 ? '' : 's'} `
        + `name${unobserved.length === 1 ? 's' : ''} no test: ${names.join(', ')}. A report that claims a `
        + 'guard exists without naming where it was seen to fire is the defect class this phase '
        + 'reports on, so the render is refused rather than published.',
    );
  }

  // FF-B283, AND IT IS THE SAME DEFECT CLASS AS THE ONE ABOVE. Checking only
  // that the string is non empty is a check that cannot fail on a name that is
  // simply wrong: `tests/there-is-no-such-file.test.cjs` would satisfy it. The
  // named file must EXIST, so a renamed or deleted test turns the render red
  // rather than leaving section 8 quietly pointing at nothing.
  const missing = [];
  for (const guard of guards) {
    const named = String(guard.test).split(',')[0].trim();
    if (named === '' || fs.existsSync(path.resolve(REPO_ROOT, named))) continue;
    missing.push(`${String(guard.id)} names ${named}`);
  }
  if (missing.length > 0) {
    throw new ExitError(
      1,
      `[E_PR_GUARD_TEST_MISSING] ${missing.length} guard row${missing.length === 1 ? '' : 's'} `
        + `name${missing.length === 1 ? 's' : ''} a test file that does not exist: ${missing.join('; ')}. `
        + 'A row pointing at a file nobody can open is a guard claimed and not observed, which is '
        + 'exactly what section 8 exists to rule out.',
    );
  }
}

function corpusFacts(libs) {
  const scan = libs.corpus.indexCorpus({ root: CORPUS_ROOT, repoRoot: REPO_ROOT, addedTasks: [] });
  if (!scan.ok) {
    return { total: 0, single: 0, multi: 0, hidden: 0, withoutHidden: [], hash: UNAVAILABLE };
  }
  const tasks = scan.index.tasks;
  const withoutHidden = tasks.filter((t) => t.hidden === null).map((t) => t.id).sort();
  return {
    total: tasks.length,
    single: tasks.filter((t) => t.kind === 'single').length,
    multi: tasks.filter((t) => t.kind === 'multi').length,
    hidden: tasks.length - withoutHidden.length,
    withoutHidden,
    hash: scan.index.corpus_hash,
  };
}

/** The visible gate percentages a record recorded, so saturation is DERIVED. */
function saturationOf(libs, record) {
  const pcts = [];
  for (const e of record.events) {
    if (e === null || typeof e !== 'object' || e.kind !== 'gate_ended') continue;
    if (e.gate !== 'visible') continue;
    const passed = Number(e.passed);
    const total = Number(e.total);
    if (!Number.isFinite(passed) || !Number.isFinite(total) || total === 0) continue;
    pcts.push((passed / total) * 100);
  }
  return libs.corpus.detectSaturation({ axis: 'gate', pcts });
}

function main() {
  const argv = readArgv(process.argv.slice(2));
  if (argv.help) {
    process.stdout.write('  node scripts/gen-proof-report.cjs [--records DIR] [--out FILE] '
      + '[--permitted N] [--phase P] [--guards FILE] [--antiloop FILE] [--history run|off] [--check]\n');
    return;
  }

  const libs = loadLibs();
  const guards = loadGuards(argv);
  // SIDE EFFECT AFTER VALIDATION. The guard table is checked before anything is
  // rendered and long before anything is written.
  assertGuardsObserved(guards);

  const records = loadRecords(libs, argv.records, antiloopPath(argv));
  for (const record of records) record.saturation = saturationOf(libs, record);
  const armRecords = records.filter((r) => r.isArm);
  const serial = armRecords.filter((r) => r.arm === 'serial');
  const fleetRecords = armRecords.filter((r) => r.arm === 'fleet');

  const refusals = loadRefusals(argv.records);
  const fleetInfo = fleetStatus(records, fleetRecords, refusals);

  const permitted = permittedWidth(argv);
  const history = historicalRate(argv);
  const curve = landGateCurve(records.filter((r) => !r.isArm));
  const corpus = corpusFacts(libs);

  // FF-B353. EVERY fleet record enters the fold, exactly as every serial record
  // always did. This read `fleetRecords[0]`, so with 2 fleet records on disk the
  // DIRECTORY ORDER decided the published verdict, and the 2 live records
  // disagree: folding the first alone returns NEGATIVE and folding the second
  // alone returns POSITIVE.
  const verdict = libs.fold.compareArms({
    serial: serial.map((r) => r.doc),
    fleet: fleetRecords.map((r) => r.doc),
    permitted_width: permitted.state === 'known' ? permitted.value : null,
  });

  // FF-B353. WHAT THE SUPERSEDED SINGLE RECORD FOLD WOULD HAVE RETURNED, one
  // entry per fleet record, so the report can state whether the selection
  // actually decided anything on the records present instead of asserting it
  // from memory. `compareArms` reads no clock, no file and no configuration, so
  // calling it once per record costs nothing and changes nothing.
  const selection = fleetRecords.map((r) => ({
    name: r.name,
    verdict: libs.fold.compareArms({
      serial: serial.map((s) => s.doc),
      fleet: [r.doc],
      permitted_width: permitted.state === 'known' ? permitted.value : null,
    }).verdict,
  }));

  // DERIVED, not asserted. FF-B288 for the spend, and the floor comparison for
  // whether the corpus discriminated. Both are computed BEFORE anything renders
  // and both report a state rather than a 0 when they have no input.
  const spend = spendFacts(armRecords);
  const sources = candidateSources(armRecords);
  const lanes = laneIdentities(armRecords);
  const latency = measuredLatency(armRecords);
  const floor = corpusFloor(argv);

  const superseded = loadSuperseded(argv.records);

  const rendered = render({
    records, armRecords, serial, fleetRecords, fleetInfo, verdict, permitted, history, curve, corpus, guards,
    spend, latency, floor, lanes, sources, subset: argv.floorTasks, superseded, selection,
    // The threshold is READ FROM THE LIBRARY that gates on it, never transcribed.
    // It was declared in CONTEXT D8 before any run, and a report holding its own
    // copy is a report that can disagree with the gate it is describing.
    threshold: libs.fold.FALSE_GREEN_THRESHOLD,
  });

  if (argv.check) {
    if (!fs.existsSync(argv.out)) {
      throw new ExitError(1, `[E_PR_NOT_WRITTEN] ${path.relative(REPO_ROOT, argv.out)} does not exist, so there is nothing to check.`);
    }
    const written = fs.readFileSync(argv.out, 'utf8');
    if (written === rendered) return;
    const differing = differingSections(rendered, written);
    process.stderr.write(
      `[E_PR_STALE] ${path.relative(REPO_ROOT, argv.out)} no longer matches its inputs. Differing `
        + `section${differing.length === 1 ? '' : 's'}: ${differing.join(' | ')}\n`
        + 'Re render with:\n  node scripts/gen-proof-report.cjs\n',
    );
    return 1;
  }

  fs.mkdirSync(path.dirname(argv.out), { recursive: true });
  fs.writeFileSync(argv.out, rendered, 'utf8');
  process.stderr.write(
    `${path.relative(REPO_ROOT, argv.out)}: verdict ${verdict.verdict}, ${armRecords.length} arm `
      + `record${armRecords.length === 1 ? '' : 's'} of ${records.length}, `
      + `${serial.length} serial and ${fleetRecords.length} fleet\n`,
  );
}

if (require.main === module) runMain(main);

module.exports = { readArgv, sectionsOf, differingSections, assertGuardsObserved, OBSERVED_GUARDS };
