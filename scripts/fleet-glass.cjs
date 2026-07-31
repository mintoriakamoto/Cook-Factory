#!/usr/bin/env node
'use strict';

/**
 * fleet-glass.cjs: Phase 21 of milestone v1.14 (Fleet Mode), the read only glass.
 *
 * Four views over data Ferrox already produces:
 *
 *   1. the GRAPH, from the `workgraph/v1` document, every declared edge
 *      carrying its own verdict and its evidence
 *   2. the LEASES, from the board projection, every lease carrying its state,
 *      its epoch, its holder and both of its instants
 *   3. the ASKS, from the fold in `scripts/fleet-ask.cjs`, every ask leading
 *      with its recommended move
 *   4. the WATCH, the LIVE one: the run log read on a poll and repainted, every
 *      worker lane with its elapsed time and, above all of them, the measured
 *      concurrency counter. The first 3 views answer what the state IS. This
 *      one answers what the fleet is DOING, which is the only question a human
 *      actually stands in front of during a parallel run.
 *
 * THIS MODULE WRITES NOTHING. That is not a nice property of this surface, it
 * is the defining one, because the thing a human stares at during a live
 * parallel run must never be able to perturb the run it is displaying. A view
 * that can mutate state is not a view.
 *
 * AND THAT SENTENCE PROVES NOTHING, which is the point of how it is checked.
 * The read only property is proven by `tests/fleet-glass-readonly.test.cjs`,
 * which snapshots the WHOLE scratch tree, every relative path with its size and
 * its modification time, runs each of the 3 views through this CLI as a real
 * child process, snapshots again and compares. It compares the tree rather than
 * counting writes, because a write counter can only see the writes somebody
 * remembered to instrument and the failure that check exists to catch is the
 * write nobody thought of. The same comparison is driven once against a variant
 * that DOES write and is observed FAILING, so the check is known to be able to
 * fire rather than merely known to be green.
 *
 * THE VENDORED SPA IS UNTOUCHED BY DECISION AND NOT BY OMISSION.
 * `ferrox-core/bin/vendor/ratchet/bin/ratchet-glass` is a 2439 line read only
 * mission control SPA, byte pinned by phase 18 against its divergence ledger.
 * This phase changes 0 bytes of the vendored tree and opens 0 ledger entries,
 * because a divergence against a 2439 line Python SPA to render a Ferrox side
 * data model would be a cost paid at every future upstream sync for a view
 * Ferrox can own outright. Wiring these views into that SPA is a separate,
 * later, ledger gated move. It is a known non goal, recorded here so a future
 * reader does not mistake the omission for an oversight.
 *
 * WHY THIS LIVES UNDER `scripts/` RATHER THAN AS A BUILT LIB, in the register
 * `scripts/gen-workgraph.cjs` already uses for the same call: a built lib costs
 * 2 lines of shared write surface that every other plan in the repository
 * contends on, an `eslint.config.mjs` entry and a `docs/INVENTORY-MANIFEST.json`
 * row, and FF-B119 measures that contention as a real width limiter. A script
 * costs neither. This phase therefore adds 4 scripts and 0 libs.
 *
 * EVERY RENDERER IS PURE. `renderGraphView`, `renderLeaseView` and
 * `renderAskView` take plain objects, read no file and read no clock, and they
 * do not mutate their arguments. All the loading happens at the CLI seam below,
 * which is what decouples these views from phase 19's landing date and what
 * makes every case in the battery drivable from a hand built fixture.
 *
 * AN EMPTY PANEL, A NO SIGNAL PANEL AND AN UNAVAILABLE PANEL ARE 3 DIFFERENT
 * FACTS and they carry 3 different wordings. A view with 1 rendering for all 3
 * tells a human that nothing is wrong when the truth is that nothing was read,
 * and that is the single worst thing a dashboard can do.
 *
 * IT FORMATS NO QUESTION OF ITS OWN. Every ask goes through `renderQuestion`
 * from `scripts/fleet-ask.cjs`, which is the only function in this phase that
 * may put a question to a human and which REFUSES to render one that does not
 * lead with a recommendation. Glass and the foreman must not be able to
 * disagree about how a question is asked, and the only way to guarantee that is
 * for both to have exactly 1 renderer between them.
 *
 * Usage:
 *   node scripts/fleet-glass.cjs graph <phase>   # the work graph and its edges
 *   node scripts/fleet-glass.cjs leases          # the leases and the trunk
 *   node scripts/fleet-glass.cjs asks            # the open asks, pick first
 *   node scripts/fleet-glass.cjs watch <phase>   # the LIVE fleet, repainted
 *       --frames <n>    stop after n frames. 0 means until the run closes.
 *       --interval <ms> how long to wait between reads. 1000 by default.
 *
 * FERROX_GLASS_ROOT overrides the project root, matching the seam
 * `scripts/gen-workgraph.cjs` uses, so the read only battery can drive every
 * view against a scratch tree as a real child process.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const {
  foldAsks,
  buildEscalationMenu,
  renderQuestion,
  ASK_SIGNALS,
} = require('./fleet-ask.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.FERROX_GLASS_ROOT
  ? path.resolve(process.env.FERROX_GLASS_ROOT)
  : REPO_ROOT;
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

/** The 3 built libs this CLI seam reaches for, named as the human would fix them. */
const SCAN_MODULE = 'ferrox-core/bin/lib/workgraph-scan.cjs';
const BOARD_MODULE = 'ferrox-core/bin/lib/fleet-board.cjs';
const RUNFOLD_MODULE = 'ferrox-core/bin/lib/fleet-runfold.cjs';
const RUNLOG_MODULE = 'ferrox-core/bin/lib/fleet-runlog.cjs';

/* ------------------------------------------------------------------------ *
 * Constants. Every wording a panel can carry is a NAMED EXPORT, so the tests
 * assert against THESE CONSTANTS rather than against copied strings. A copied
 * string is how 2 panels start saying the same thing about 2 different facts.
 * ------------------------------------------------------------------------ */

const GLASS_ERROR_CODES = Object.freeze({ UNAVAILABLE: 'E_GLASS_UNAVAILABLE' });

/**
 * The 3 edge verdicts, worded as 3 DIFFERENT CLAIMS, because they are 3
 * different claims and a view that words them the same way is lying about 2 of
 * them.
 *
 * BACKED: the scan looked and found the coupling.
 * UNBACKED: the scan looked, reached both endpoints, and found nothing. That is
 *   a finding about the PLANNER rather than a defect in the graph, which is how
 *   `scripts/gen-workgraph.cjs` already characterises it in its own header, and
 *   it is why an unbacked edge never changes that generator's exit code either.
 * UNPROVEN: the scan could not reach the files involved, so it neither confirms
 *   nor denies. In THIS phase that is the expected verdict on all 3 declared
 *   edges, because the scan root is `src` and every module here is a script. A
 *   view that rendered unproven as a problem would report every edge in its own
 *   phase as broken, which is why this wording names the instrument's REACH and
 *   never the edge.
 */
const VERDICT_WORDING = Object.freeze({
  backed: 'BACKED: the scan reached both endpoints and found the coupling.',
  unbacked: 'UNBACKED: the scan reached both endpoints and found no coupling between them. '
    + 'That is a finding about the planner who declared it, not a fault in the graph, '
    + 'and it changes no exit code anywhere.',
  unproven: 'UNPROVEN: the scan could not reach the files involved, so it neither confirms '
    + 'nor denies this edge. This is the instrument reporting its own reach. '
    + 'A scripts to scripts edge reads this way because the scan root is src.',
});

const PANEL_WORDING = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE: nothing was read, so nothing can be said here.',
  EMPTY_GRAPH: 'EMPTY: this document was read and it declares no nodes at all.',
  EMPTY_LEASES: 'EMPTY: this projection was read and it carries no lease at all.',
  NO_SIGNAL: 'NO SIGNAL: the fold had no evidence to read at all, which is not an all clear.',
  NO_OPEN_ASKS: 'NO OPEN ASKS: the fold read real evidence and raised no condition.',
  TRUNK: 'TRUNK, the land queue',
  EPOCH_ADVANCED: 'EPOCH ADVANCED: this lease was taken from a previous holder, '
    + 'so it is a reclaim after a crash rather than a renewal.',
  QUESTION_REFUSED: 'QUESTION REFUSED by the chokepoint',
});

const RULE = '-'.repeat(78);

/* ------------------------------------------------------------------------ *
 * Small helpers. Every one of these is total: no input throws.
 * ------------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** A count with its noun pluralized. Digits always, never a spelled number. */
function count(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** A value a human can read, where an absent one says so rather than showing blank. */
function shown(value) {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * An instant as BOTH its raw milliseconds and its readable form.
 *
 * Both, rather than either. The raw number is what the run log actually
 * carries and what a reader needs in order to check this panel against the
 * log, and `1785024002000` is not something a human can read at a glance
 * during a live run. Dropping either one costs a real reader something.
 *
 * STILL PURE: `toISOString` formats the number it is given and reads no clock,
 * so 2 renders of the same board remain identical. An absent instant says
 * `unknown` and NEVER 0, because 0 is a real instant and an absent reading is
 * not a reading of 0.
 */
function shownInstant(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return shown(value);
  try {
    return `${value} (${new Date(value).toISOString()})`;
  } catch {
    return `${value} (not a representable instant)`;
  }
}

/**
 * The unavailable panel. Every view degrades to THIS rather than to an empty
 * one, and it always names WHAT could not be read. An unavailable panel that
 * does not name the thing it could not reach sends a human looking through the
 * whole tree for it.
 */
function unavailablePanel(title, missing) {
  const lines = [RULE, `${title}  ${PANEL_WORDING.UNAVAILABLE}`, RULE];
  lines.push('  could not read:');
  for (const line of String(missing).split(/\r?\n/)) lines.push(`    ${line}`);
  lines.push('');
  lines.push('  This panel is a NAMED unavailable, not an empty view. The difference');
  lines.push('  matters: an empty view says the fleet has nothing to report, and this');
  lines.push('  panel says the reader could not reach the report at all.');
  return lines;
}

/* ------------------------------------------------------------------------ *
 * 1. The graph view
 * ------------------------------------------------------------------------ */

/**
 * Load the `workgraph/v1` document for 1 phase, or refuse with a NAMED missing.
 *
 * The `load` seam is injected so the refusal arms are drivable without breaking
 * the built tree. The real default is a guarded require of the shipped scan
 * lib, following `scripts/gen-workgraph.cjs:62-72`.
 *
 * The scan library's OWN refusal message is carried through INTACT rather than
 * paraphrased, because it already names the fix and the exact command to run,
 * and a paraphrase of a good error message is a worse error message.
 *
 * @param {{root?: string, phase?: string, load?: Function}} input
 * @returns {{ok: true, document: object}
 *          |{ok: false, code: string, missing: string}}
 */
function loadGraph(input) {
  const source = isPlainObject(input) ? input : {};
  const root = isFilledString(source.root) ? source.root : ROOT;
  const phase = isFilledString(source.phase) ? source.phase : '';
  const load = typeof source.load === 'function'
    ? source.load
    : () => require(path.join(LIB_DIR, 'workgraph-scan.cjs'));

  let scan;
  try {
    scan = load();
  } catch (error) {
    return {
      ok: false,
      code: GLASS_ERROR_CODES.UNAVAILABLE,
      missing: `${SCAN_MODULE}\n${error && error.message ? error.message : String(error)}\n`
        + 'Fix: run:\n  npm run build:lib',
    };
  }
  if (!scan || typeof scan.buildWorkgraph !== 'function') {
    return {
      ok: false,
      code: GLASS_ERROR_CODES.UNAVAILABLE,
      missing: `${SCAN_MODULE} loaded but exports no buildWorkgraph`,
    };
  }

  const built = scan.buildWorkgraph({ cwd: root, phase });
  if (!built || (built.ok !== true && isFilledString(built.message))) {
    return {
      ok: false,
      code: GLASS_ERROR_CODES.UNAVAILABLE,
      missing: built && built.message ? built.message : `the graph for phase ${phase}`,
    };
  }
  return { ok: true, document: built.document };
}

/**
 * Render the graph. PURE over the document object: no file, no clock, and the
 * argument is never mutated.
 *
 * @param {object} document a `workgraph/v1` document
 * @returns {string[]} lines
 */
function renderGraphView(document) {
  if (!isPlainObject(document) || !Array.isArray(document.nodes)) {
    return unavailablePanel(
      'GRAPH',
      'the workgraph document is absent or malformed, so it declares no nodes to read',
    );
  }

  const phase = isFilledString(document.phase) ? document.phase : 'unnamed';
  const nodes = document.nodes.filter(isPlainObject);
  const edges = Array.isArray(document.edges) ? document.edges.filter(isPlainObject) : [];

  if (nodes.length === 0) {
    return [
      RULE,
      `GRAPH  phase ${phase}`,
      RULE,
      `  ${PANEL_WORDING.EMPTY_GRAPH}`,
      `  It carries ${count(0, 'node', 'nodes')}.`,
      '',
      '  That is an EMPTY graph and not a missing one. The document was read and',
      '  it declares nothing. A phase that could not be read at all renders a',
      '  different panel, which names what it could not reach.',
    ];
  }

  // Group by wave. Sorted numerically, so wave 10 does not land between 1 and 2.
  const waves = new Map();
  for (const node of nodes) {
    const wave = typeof node.wave === 'number' && Number.isFinite(node.wave) ? node.wave : 0;
    if (!waves.has(wave)) waves.set(wave, []);
    waves.get(wave).push(node);
  }
  const waveKeys = [...waves.keys()].sort((a, b) => a - b);

  const lines = [
    RULE,
    `GRAPH  phase ${phase}`,
    RULE,
    `  ${count(nodes.length, 'node', 'nodes')}, `
      + `${count(waveKeys.length, 'wave', 'waves')}, `
      + `${count(edges.length, 'declared edge', 'declared edges')}`,
    '',
  ];

  for (const wave of waveKeys) {
    const inWave = [...waves.get(wave)].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    lines.push(`  Wave ${wave}  (${count(inWave.length, 'node', 'nodes')} in parallel)`);
    for (const node of inWave) {
      const lane = Array.isArray(node.write_lane) ? node.write_lane.length : 0;
      const tasks = typeof node.task_count === 'number' ? node.task_count : 0;
      lines.push(
        `    ${String(node.id).padEnd(8)} ${String(node.kind ?? 'unknown').padEnd(8)} `
          + `${count(tasks, 'task', 'tasks')}, `
          + `${count(lane, 'file', 'files')} in its write lane`,
      );
    }
    lines.push('');
  }

  lines.push('  Declared edges');
  if (edges.length === 0) {
    lines.push('    none. This phase declares no edge between its own plans.');
  }
  for (const edge of edges) {
    lines.push(`    ${shown(edge.from)} depends on ${shown(edge.to)}`);
    const verdict = isFilledString(edge.verdict) ? edge.verdict : 'unknown';
    const wording = VERDICT_WORDING[verdict]
      ?? `${verdict.toUpperCase()}: this verdict is not one the view knows how to word.`;
    for (const chunk of wording.split(/(?<=\.)\s+/)) lines.push(`      ${chunk}`);
    if (isFilledString(edge.unproven_reason)) {
      lines.push(`      reason: ${edge.unproven_reason}`);
    }
    const evidence = Array.isArray(edge.evidence) ? edge.evidence : [];
    if (evidence.length === 0) {
      lines.push('      evidence: none was found, which is what the verdict above says.');
    }
    for (const item of evidence) lines.push(`      evidence: ${shown(item)}`);
  }

  const warnings = Array.isArray(document.warnings) ? document.warnings : [];
  if (warnings.length > 0) {
    lines.push('');
    lines.push(`  Instrument notes (${count(warnings.length, 'note', 'notes')})`);
    for (const warning of warnings) lines.push(`    ${shown(warning)}`);
  }

  return lines;
}

/* ------------------------------------------------------------------------ *
 * 2. The lease view
 * ------------------------------------------------------------------------ */

/**
 * Render the leases and the trunk. PURE over the board projection.
 *
 * The field names below were read from the SHIPPED producer on 2026-07-26,
 * `ferrox-core/bin/lib/fleet-board.cjs`, rather than transcribed from any
 * document, per CONTEXT D10:
 *
 *   board.leases[node].{node_id, worker_id, lease_epoch, state,
 *                       acquired_at_ms, renewed_at_ms, expires_at_ms, holder}
 *                                                    fleet-board.cjs:265-283
 *   board.queue.tickets[].{node_id, attempt_id, ticket, worker_id,
 *                          entered_at, acquired_at, completed_at}
 *                                                    fleet-board.cjs:323-331
 *   board.queue.held_by                              fleet-board.cjs:344-352
 *
 * @param {object} board a board projection
 * @returns {string[]} lines
 */
function renderLeaseView(board) {
  if (!isPlainObject(board)) {
    return unavailablePanel(
      'LEASES',
      'the board projection is absent, so no lease could be read',
    );
  }

  const leases = isPlainObject(board.leases) ? board.leases : {};
  const nodeKeys = Object.keys(leases).sort();
  const queue = isPlainObject(board.queue) ? board.queue : {};
  const tickets = Array.isArray(queue.tickets) ? queue.tickets.filter(isPlainObject) : [];
  const held = isPlainObject(queue.held_by) ? queue.held_by : null;

  const lines = [
    RULE,
    `LEASES  ${count(nodeKeys.length, 'node holds a lease', 'nodes hold a lease')}`,
    RULE,
  ];

  if (nodeKeys.length === 0) {
    lines.push(`  ${PANEL_WORDING.EMPTY_LEASES}`);
    lines.push('');
    lines.push('  That is an EMPTY projection and not an absent one. The events were');
    lines.push('  read and no node has claimed a lease yet.');
  }

  for (const key of nodeKeys) {
    const lease = isPlainObject(leases[key]) ? leases[key] : {};
    const epoch = typeof lease.lease_epoch === 'number' ? lease.lease_epoch : 0;
    lines.push(
      `  ${String(key).padEnd(10)} ${String(lease.state ?? 'unknown').padEnd(10)} `
        + `epoch ${epoch}`,
    );
    lines.push(`      holder    ${shown(lease.worker_id)}  ${shown(lease.holder)}`);
    lines.push(`      acquired  ${shownInstant(lease.acquired_at_ms)}`);
    lines.push(`      renewed   ${shownInstant(lease.renewed_at_ms)}`);
    lines.push(`      expires   ${shownInstant(lease.expires_at_ms)}`);
    // An epoch above 1 is the difference between a renewal and a reclaim after a
    // crash, and that distinction is the entire reason the epoch exists. A view
    // that shows the number without saying what it means makes a human who has
    // never seen this system read past the most important row on the panel.
    if (epoch > 1) {
      lines.push(`      ${PANEL_WORDING.EPOCH_ADVANCED}`);
      lines.push(`      It has been claimed ${count(epoch, 'time', 'times')} in total.`);
    }
  }

  lines.push('');
  lines.push(`  ${PANEL_WORDING.TRUNK}`);
  if (held === null) {
    lines.push('    nobody is holding the trunk right now.');
  } else {
    lines.push(
      `    held by ${shown(held.node_id)} on ticket ${shown(held.ticket)} `
        + `(${shown(held.worker_id)}) since ${shownInstant(held.acquired_at)}`,
    );
  }
  if (tickets.length === 0) {
    lines.push('    no ticket has been drawn.');
  }
  for (const row of tickets) {
    const state = row.completed_at !== null && row.completed_at !== undefined
      ? 'landed'
      : (row.acquired_at !== null && row.acquired_at !== undefined ? 'landing' : 'waiting');
    lines.push(
      `    ticket ${String(shown(row.ticket)).padEnd(4)} ${state.padEnd(8)} `
        + `${shown(row.node_id)}  entered ${shown(row.entered_at)}`,
    );
  }

  return lines;
}

/* ------------------------------------------------------------------------ *
 * 3. The ask view, through the phase chokepoint
 * ------------------------------------------------------------------------ */

/**
 * Render the open asks, each one leading with its recommended move.
 *
 * THIS FUNCTION FORMATS NO QUESTION. It folds, it builds each menu, and it
 * hands each menu to `renderQuestion` from `scripts/fleet-ask.cjs`, which is the
 * only function in this phase permitted to put a question to a human. The
 * chokepoint's lines are placed on the panel with an indent and no other
 * change, so the ordering property it guarantees, the pick first and the
 * numbers after, holds here exactly as it holds in the verdict and in the
 * foreman.
 *
 * The `build` and `render` seams exist so the refusal arm is drivable. They
 * default to the real chokepoint.
 *
 * @param {{board?: object, runRecord?: object, thresholds?: object,
 *          build?: Function, render?: Function}} input
 * @returns {string[]} lines
 */
function renderAskView(input) {
  const source = isPlainObject(input) ? input : {};
  const build = typeof source.build === 'function' ? source.build : buildEscalationMenu;
  const render = typeof source.render === 'function' ? source.render : renderQuestion;

  const folded = foldAsks({
    board: source.board,
    runRecord: source.runRecord,
    thresholds: source.thresholds,
  });

  if (folded.ok !== true) {
    return unavailablePanel('ASKS', `${folded.code}\n${folded.message}`);
  }

  const asks = folded.asks;
  const lines = [
    RULE,
    `ASKS  ${count(asks.length, 'open ask', 'open asks')}`,
    RULE,
  ];

  // NO SIGNAL and NO OPEN ASKS are DELIBERATELY different panels. An empty ask
  // list over a run record with nothing in it is not an all clear, it is a fold
  // that had nothing to read, and reporting those 2 states with 1 wording is
  // exactly how an absent payload gets read as a healthy one.
  if (asks.length === 0) {
    if (folded.signal === ASK_SIGNALS.NONE) {
      lines.push(`  ${PANEL_WORDING.NO_SIGNAL}`);
      lines.push('');
      lines.push('  There were no leases, no tickets, no workers and no rounds to fold.');
      lines.push('  Nothing has been observed yet, so nothing can be concluded yet.');
    } else {
      lines.push(`  ${PANEL_WORDING.NO_OPEN_ASKS}`);
      lines.push('');
      lines.push('  Real evidence was read and no condition rose to a question. This is');
      lines.push('  the all clear, and it is a different statement from the one above.');
    }
    return lines;
  }

  asks.forEach((item, index) => {
    lines.push('');
    lines.push(
      `  ${index + 1} of ${asks.length}   node ${shown(item.node_id)}   `
        + `${shown(item.cause)}   severity ${shown(item.severity)}`,
    );
    lines.push(`      evidence  ${shown(item.evidence)}  observed ${shown(item.observed)}`);

    // The blocking set is the asks sharing THIS cause, which is what makes the
    // menu's own systemic reason ("N items are blocked on <cause>") true rather
    // than merely printed.
    const sameCause = asks.filter((other) => other.cause === item.cause);
    const rounds = isPlainObject(source.runRecord)
      && isPlainObject(source.runRecord.rounds_per_artifact)
      ? source.runRecord.rounds_per_artifact[item.node_id]
      : undefined;

    const menu = build({ ask: item, rounds, blockingSet: sameCause });
    if (!menu || menu.ok !== true) {
      lines.push(`      ${PANEL_WORDING.QUESTION_REFUSED}`);
      lines.push(`        ${menu ? menu.code : 'no result'}: ${menu ? menu.message : ''}`);
      return;
    }
    const rendered = render(menu.question);
    if (!rendered || rendered.ok !== true) {
      lines.push(`      ${PANEL_WORDING.QUESTION_REFUSED}`);
      lines.push(`        ${rendered ? rendered.code : 'no result'}: ${rendered ? rendered.message : ''}`);
      lines.push('        A refused question is the guard working. It is reported here');
      lines.push('        rather than dropped, because a silently dropped ask is an ask');
      lines.push('        nobody answers.');
      return;
    }
    for (const line of rendered.lines) lines.push(`    ${line}`);
  });

  return lines;
}

/* ------------------------------------------------------------------------ *
 * 4. The watch view, the LIVE one
 *
 * The other 3 views answer "what is the state right now". This one answers
 * "what is the fleet DOING", which is a different question and the only one a
 * human actually stands in front of during a parallel run.
 *
 * THE NUMBER THIS VIEW EXISTS FOR IS THE CONCURRENCY COUNTER. Everything else
 * on the frame is context for it. `.planning/MEASUREMENT-v1.14-PARALLELISM.md`
 * established that no phase in this repository had ever demonstrably run in
 * parallel, and the whole milestone is the attempt to make that figure real and
 * then legible. So this panel reports 2 counters side by side: how many workers
 * are running THIS INSTANT, and the PEAK reached so far.
 *
 * AND BOTH ARE MEASURED, NEVER ASSUMED. The recorded phase 22 defect is a
 * demonstrated width that turned out to be a property of the emit loop rather
 * than a property of the run: a view that painted the LANE COUNT would report
 * the same 3 for 3 workers that overlapped and for 3 workers that took strict
 * turns, and only 1 of those runs was parallel. `computeConcurrency` therefore
 * runs a real interval sweep over the worker rows, and
 * `tests/fleet-glass-watch.test.cjs` drives BOTH fixtures through it and
 * asserts 3 against 1. A lane count implementation passes the first and fails
 * the second, which is what makes that arm a required failing arm rather than
 * a second green tick.
 *
 * AT AN EQUAL INSTANT AN END IS SWEPT BEFORE A START, matching judgement call 3
 * in `src/fleet-runfold.cts:427`. Two intervals that merely touch, [10,20] and
 * [20,30], demonstrate width 1 and never 2. A demonstrated figure must never
 * round up.
 *
 * UNKNOWN IS NEVER 0 ANYWHERE ON THIS FRAME. A worker that has started and not
 * reported an end contributes to the live count but leaves the peak INEXACT and
 * says so. A worker whose start will not convert to an instant is counted in
 * `unknown_intervals` and is never quietly dropped, because a dropped interval
 * lowers the very figure the milestone publishes. An absent graph makes the
 * node TOTAL unknown and never 0, since 0 of 0 landed reads as a finished run.
 *
 * A BLANK BOARD MUST READ AS "NOTHING LOADED" AND NEVER AS "NOTHING WRONG".
 * The producers take their event array POSITIONALLY, and `foldRunRecord({
 * events })` returns an EMPTY record with NO ERROR. So the CLI seam below reads
 * the event count first and refuses to paint a frame over an empty read.
 *
 * STILL READ ONLY, and now in a loop. A poll is a read repeated, so nothing
 * about this view weakens the property proven in
 * `tests/fleet-glass-readonly.test.cjs`. The loop is bounded by `--frames` so
 * every test terminates, and the frame is PURE over its model: it takes the
 * instant as an argument and reads no clock, which is what makes 2 renders of
 * the same model identical.
 * ------------------------------------------------------------------------ */

/** The 5 states a node can be in, as the frame paints them. */
const WATCH_NODE_STATES = Object.freeze({
  WAITING: 'waiting',
  RUNNING: 'running',
  GATED: 'gated',
  LANDED: 'landed',
  PARKED: 'parked',
});

/** The 1 word this frame uses for every reading it could not take. Never 0. */
const WATCH_UNKNOWN = 'UNKNOWN';

const WATCH_WORDING = Object.freeze({
  NO_SIGNAL: 'NO SIGNAL: the run log was read and it carries no event at all. '
    + 'That is nothing loaded, and it is not an all clear.',
  NO_LANES: 'NO LANE HAS OPENED YET: the run exists and no worker has started, '
    + 'so there is a run to watch and nothing yet to see in it.',
  RUN_OPEN: 'THE RUN IS STILL OPEN. This watch stopped first, so every figure '
    + 'below is a reading taken mid run rather than a total.',
  RUN_CLOSED: 'THE RUN CLOSED while this watch was open, so these figures cover '
    + 'the whole run.',
  TOTAL_UNKNOWN: 'the graph could not be read, so the node total is UNKNOWN. '
    + 'It is not 0, because 0 of 0 landed reads as a finished run.',
  PEAK_INEXACT: 'the peak is a floor and not a total: at least 1 interval could '
    + 'not be read, so the real peak is this number or higher.',
});

/** An instant as epoch milliseconds, or null when it cannot be established. */
function toMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * A duration as `hh:mm:ss`, or UNKNOWN. A negative or absent extent is UNKNOWN
 * and never `00:00:00`, because a reading of 0 seconds and no reading at all
 * are 2 different facts and only 1 of them is a measurement.
 */
function shownDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return WATCH_UNKNOWN;
  const total = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * The concurrency counters, by INTERVAL SWEEP over the lanes.
 *
 * PURE, and it reads no clock: `now` is supplied. Returns a COUNTER for each
 * figure rather than a flag, so a caller can assert 3 against 1 rather than
 * assert that parallelism happened.
 *
 * @param {Array<object>} lanes lane rows carrying started_at_ms and ended_at_ms
 * @param {number|null} now the frame instant, or null when it is unknown
 * @returns {{now: number|null, now_unknown: number, peak: number,
 *            peak_exact: boolean, unknown_intervals: number}}
 */
function computeConcurrency(lanes, now) {
  const rows = Array.isArray(lanes) ? lanes.filter(isPlainObject) : [];
  const instant = typeof now === 'number' && Number.isFinite(now) ? now : null;
  const points = [];
  let unknownIntervals = 0;
  let liveNow = 0;
  let liveUnknown = 0;

  for (const lane of rows) {
    const start = typeof lane.started_at_ms === 'number' ? lane.started_at_ms : null;
    const end = typeof lane.ended_at_ms === 'number' ? lane.ended_at_ms : null;
    if (start === null) {
      // An end with no start, or a start that will not convert. The extent is
      // unknown in 1 direction and the interval is COUNTED as unknown rather
      // than dropped, because a dropped interval lowers the published figure.
      unknownIntervals += 1;
      if (end === null) liveUnknown += 1;
      continue;
    }
    if (end === null) {
      // Still open. Its extent runs to the frame instant, and with no frame
      // instant there is no extent to sweep at all.
      if (instant === null) { unknownIntervals += 1; liveUnknown += 1; continue; }
      if (start <= instant) liveNow += 1;
      points.push({ t: start, delta: +1 });
      points.push({ t: Math.max(instant, start), delta: -1 });
      continue;
    }
    points.push({ t: start, delta: +1 });
    points.push({ t: end, delta: -1 });
  }

  // An END before a START at an equal instant, so 2 intervals that merely touch
  // demonstrate width 1. A demonstrated figure never rounds up.
  points.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));
  let running = 0;
  let peak = 0;
  for (const point of points) {
    running += point.delta;
    if (running > peak) peak = running;
  }

  return {
    now: instant === null ? null : liveNow,
    now_unknown: liveUnknown,
    peak,
    peak_exact: unknownIntervals === 0,
    unknown_intervals: unknownIntervals,
  };
}

/** The state of every node, folded out of the events the log really carries. */
function foldNodeStates(events, lanes) {
  const facts = new Map();
  const factsFor = (id) => {
    if (!facts.has(id)) {
      facts.set(id, {
        id, landed: false, parked: false, park_reason: null,
        queued: false, gating: false, ticket: null, worker: null, seen: true,
      });
    }
    return facts.get(id);
  };

  for (const event of events) {
    const kind = typeof event.kind === 'string' ? event.kind : '';
    if (event.node_id === undefined || event.node_id === null) continue;
    const row = factsFor(String(event.node_id));
    if (kind === 'land_completed') row.landed = true;
    else if (kind === 'node_parked') {
      row.parked = true;
      if (row.park_reason === null && isFilledString(event.reason)) row.park_reason = event.reason;
    } else if (kind === 'queue_entered') {
      row.queued = true;
      if (row.ticket === null && event.ticket !== undefined) row.ticket = event.ticket;
    } else if (kind === 'queue_acquired' || kind === 'gate_started') row.gating = true;
  }

  for (const lane of lanes) {
    if (lane.node_id === null) continue;
    const row = factsFor(lane.node_id);
    if (lane.state === WATCH_NODE_STATES.RUNNING) row.worker = lane.worker_id;
  }
  return facts;
}

/**
 * The whole watch model, folded from the events, the run record and the graph.
 *
 * PURE: no file, no clock, and no argument is mutated. `now` is supplied.
 *
 * The node state precedence is parked, then landed, then gated, then running,
 * then waiting. Parked leads because a park is the 1 terminal state a human has
 * to act on. A node whose worker ended and which has not reached the queue is
 * painted GATED rather than running, because waiting for the trunk IS the gate
 * from the point of view of somebody watching the wave drain.
 *
 * @param {{events?: Array, runRecord?: object, graph?: object, now?: number}} input
 */
function foldWatch(input) {
  const source = isPlainObject(input) ? input : {};
  const events = Array.isArray(source.events) ? source.events.filter(isPlainObject) : [];
  const runRecord = isPlainObject(source.runRecord) ? source.runRecord : null;
  const graph = isPlainObject(source.graph) && Array.isArray(source.graph.nodes)
    ? source.graph
    : null;
  const now = toMs(source.now);

  const workerRows = runRecord && Array.isArray(runRecord.workers) ? runRecord.workers : [];
  const lanes = workerRows.filter(isPlainObject).map((worker) => {
    const started = toMs(worker.started_at);
    const ended = toMs(worker.ended_at);
    let state = WATCH_UNKNOWN;
    if (ended !== null) state = 'ended';
    else if (started !== null) state = WATCH_NODE_STATES.RUNNING;
    let elapsed = null;
    if (started !== null) {
      const stop = ended !== null ? ended : now;
      if (stop !== null) elapsed = stop - started;
    }
    return {
      worker_id: worker.worker_id === undefined || worker.worker_id === null
        ? null
        : String(worker.worker_id),
      node_id: worker.node_id === undefined || worker.node_id === null
        ? null
        : String(worker.node_id),
      attempt_id: worker.attempt_id === undefined || worker.attempt_id === null
        ? null
        : String(worker.attempt_id),
      started_at_ms: started,
      ended_at_ms: ended,
      outcome: worker.outcome ?? null,
      state,
      elapsed_ms: elapsed,
    };
  });

  const facts = foldNodeStates(events, lanes);
  const declared = new Map();
  if (graph !== null) {
    for (const node of graph.nodes.filter(isPlainObject)) {
      if (node.id === undefined || node.id === null) continue;
      declared.set(String(node.id), {
        wave: typeof node.wave === 'number' && Number.isFinite(node.wave) ? node.wave : null,
      });
    }
  }

  const ids = [...new Set([...declared.keys(), ...facts.keys()])].sort();
  const nodes = ids.map((id) => {
    const fact = facts.get(id) ?? null;
    const meta = declared.get(id) ?? null;
    let state = WATCH_NODE_STATES.WAITING;
    if (fact !== null) {
      if (fact.parked) state = WATCH_NODE_STATES.PARKED;
      else if (fact.landed) state = WATCH_NODE_STATES.LANDED;
      else if (fact.queued || fact.gating) state = WATCH_NODE_STATES.GATED;
      else if (fact.worker !== null) state = WATCH_NODE_STATES.RUNNING;
    }
    return {
      id,
      wave: meta === null ? null : meta.wave,
      declared: meta !== null,
      state,
      worker: fact === null ? null : fact.worker,
      ticket: fact === null ? null : fact.ticket,
      park_reason: fact === null ? null : fact.park_reason,
    };
  });

  const landed = nodes.filter((n) => n.state === WATCH_NODE_STATES.LANDED).length;
  const parked = nodes.filter((n) => n.state === WATCH_NODE_STATES.PARKED);
  const startedAt = runRecord === null ? null : toMs(runRecord.run_started_at);
  const closedAt = runRecord === null ? null : toMs(runRecord.run_closed_at);

  return {
    events_read: events.length,
    run_id: runRecord === null ? null : runRecord.run_id,
    run_started_at_ms: startedAt,
    run_closed_at_ms: closedAt,
    run_closed: closedAt !== null,
    wall_clock_ms: startedAt === null
      ? null
      : (closedAt !== null ? closedAt - startedAt : (now === null ? null : now - startedAt)),
    now,
    lanes,
    concurrency: computeConcurrency(lanes, now),
    nodes,
    // UNKNOWN and never 0: an unread graph does not declare 0 nodes.
    nodes_total: graph === null ? null : declared.size,
    nodes_landed: landed,
    parked,
  };
}

/** One column of a fixed width table, so every frame lines up under the last. */
function cell(value, width) {
  return String(value === null || value === undefined ? '-' : value).padEnd(width);
}

/** The concurrency panel, the reason this whole view exists. */
function renderConcurrencyPanel(model) {
  const c = model.concurrency;
  const nowShown = c.now === null ? WATCH_UNKNOWN : String(c.now);
  const lines = [
    '  CONCURRENCY',
    `    running this instant   ${cell(nowShown, 8)}`
      + (c.now_unknown > 0 ? `plus ${count(c.now_unknown, 'lane', 'lanes')} whose extent is UNKNOWN` : ''),
    `    peak so far            ${cell(c.peak, 8)}`
      + (c.peak_exact ? 'measured by interval sweep, exact' : WATCH_WORDING.PEAK_INEXACT),
    `    unknown intervals      ${cell(c.unknown_intervals, 8)}`,
  ];
  // The bar is the counter drawn, never the counter replaced. It is built from
  // the swept figure, so a lane that is not running cannot put a block on it.
  if (c.now !== null) {
    const blocks = '#'.repeat(c.now);
    const rest = '.'.repeat(Math.max(0, model.lanes.length - c.now));
    lines.push(`    [${blocks}${rest}]  ${count(c.now, 'worker is', 'workers are')} moving right now`);
  }
  return lines;
}

/** The worker lanes, 1 row each, aligned. */
function renderLanePanel(model) {
  const lines = ['', `  WORKER LANES   ${count(model.lanes.length, 'lane', 'lanes')}`];
  if (model.lanes.length === 0) {
    lines.push(`    ${WATCH_WORDING.NO_LANES}`);
    return lines;
  }
  lines.push(`    ${cell('WORKER', 12)}${cell('NODE', 10)}${cell('ATTEMPT', 10)}`
    + `${cell('STATE', 10)}${cell('ELAPSED', 11)}OUTCOME`);
  for (const lane of model.lanes) {
    lines.push(`    ${cell(lane.worker_id, 12)}${cell(lane.node_id, 10)}${cell(lane.attempt_id, 10)}`
      + `${cell(lane.state, 10)}${cell(shownDuration(lane.elapsed_ms), 11)}${cell(lane.outcome, 1)}`);
  }
  return lines;
}

/** The graph, grouped by wave, so a wave can be watched draining. */
function renderNodePanel(model) {
  const total = model.nodes_total === null ? WATCH_UNKNOWN : String(model.nodes_total);
  const lines = [
    '',
    `  NODES   ${model.nodes_landed} landed of ${total}, `
      + `${count(model.parked.length, 'node parked', 'nodes parked')}`,
  ];
  if (model.nodes_total === null) lines.push(`    ${WATCH_WORDING.TOTAL_UNKNOWN}`);
  if (model.nodes.length === 0) {
    lines.push('    no node has been declared and none has been observed.');
    return lines;
  }

  const waves = new Map();
  for (const node of model.nodes) {
    const key = node.wave === null ? Number.POSITIVE_INFINITY : node.wave;
    if (!waves.has(key)) waves.set(key, []);
    waves.get(key).push(node);
  }
  for (const key of [...waves.keys()].sort((a, b) => a - b)) {
    const inWave = waves.get(key);
    const done = inWave.filter((n) => n.state === WATCH_NODE_STATES.LANDED).length;
    const label = Number.isFinite(key) ? `WAVE ${key}` : 'WAVE UNKNOWN';
    lines.push(`    ${cell(label, 14)}${done} of ${inWave.length} landed`);
    for (const node of inWave) {
      let detail = '';
      if (node.state === WATCH_NODE_STATES.RUNNING) detail = `worker ${shown(node.worker)}`;
      else if (node.state === WATCH_NODE_STATES.GATED && node.ticket !== null) {
        detail = `ticket ${shown(node.ticket)}`;
      } else if (node.state === WATCH_NODE_STATES.PARKED) {
        detail = `reason ${node.park_reason === null ? WATCH_UNKNOWN : node.park_reason}`;
      } else if (!node.declared) detail = 'observed in the log, not declared in the graph';
      lines.push(`      ${cell(node.id, 12)}${cell(node.state, 10)}${detail}`);
    }
  }
  return lines;
}

/**
 * One painted frame. PURE over the model: 2 renders of the same model are
 * identical, which is what lets a battery assert on the text.
 */
function renderWatchFrame(model, meta) {
  if (!isPlainObject(model)) {
    return unavailablePanel('WATCH', 'no watch model was folded, so no frame can be painted');
  }
  const info = isPlainObject(meta) ? meta : {};
  const phase = isFilledString(info.phase) ? info.phase : 'unnamed';
  const frame = typeof info.frame === 'number' ? info.frame : 0;
  const of = typeof info.frames === 'number' && info.frames > 0 ? ` of ${info.frames}` : '';

  const lines = [
    RULE,
    `FLEET GLASS   watch   phase ${phase}   frame ${frame}${of}`,
    RULE,
  ];

  if (model.events_read === 0) {
    lines.push(`  ${WATCH_WORDING.NO_SIGNAL}`);
    return lines;
  }

  lines.push(`  run ${shown(model.run_id)}   started ${shownInstant(model.run_started_at_ms)}`);
  lines.push(`  ${count(model.events_read, 'event', 'events')} read, `
    + `wall clock ${shownDuration(model.wall_clock_ms)}, `
    + `${model.run_closed ? 'run CLOSED' : 'run OPEN'}`);
  lines.push('');
  lines.push(...renderConcurrencyPanel(model));
  lines.push(...renderLanePanel(model));
  lines.push(...renderNodePanel(model));
  // The columns are padded to a fixed width so they line up under each other,
  // and the padding on the LAST column of a row is invisible clutter that shows
  // up in a diff and in a pasted frame. Trimmed at the edge, never inside.
  return lines.map((line) => line.replace(/\s+$/, ''));
}

/**
 * The closing summary, painted once when the watch stops.
 *
 * It NAMES which of the 2 things ended. A summary that reports a mid run
 * reading in the same words as a finished run is how a partial figure gets
 * quoted as a total.
 */
function renderWatchSummary(model, meta) {
  if (!isPlainObject(model)) {
    return unavailablePanel('WATCH SUMMARY', 'no watch model was folded, so nothing can be summarised');
  }
  const info = isPlainObject(meta) ? meta : {};
  const phase = isFilledString(info.phase) ? info.phase : 'unnamed';
  const painted = typeof info.frames_painted === 'number' ? info.frames_painted : 0;
  const c = model.concurrency;
  const total = model.nodes_total === null ? WATCH_UNKNOWN : String(model.nodes_total);

  // NOTHING LOADED IS NOT NOTHING WRONG, and it is not a run of 0 either.
  // `renderWatchFrame` already refuses to paint a counter over an empty read;
  // this summary has to refuse just as hard, because a closing line reading
  // `max concurrency observed 0` is a fabricated measurement of a run nobody
  // ever read. Every figure below is a reading that was never taken, so every
  // figure is UNKNOWN. Only `frames painted` survives, because the frames
  // really were painted.
  if (model.events_read === 0) {
    return [
      '',
      RULE,
      `CLOSING SUMMARY   watch   phase ${phase}`,
      RULE,
      `  ${WATCH_WORDING.NO_SIGNAL}`,
      '',
      `    wall clock               ${WATCH_UNKNOWN}`,
      `    max concurrency observed ${WATCH_UNKNOWN}`,
      `    nodes landed             ${WATCH_UNKNOWN}`,
      `    nodes parked             ${WATCH_UNKNOWN}`,
      `    frames painted           ${painted}`,
    ];
  }

  const lines = [
    '',
    RULE,
    `CLOSING SUMMARY   watch   phase ${phase}`,
    RULE,
    `  ${model.run_closed ? WATCH_WORDING.RUN_CLOSED : WATCH_WORDING.RUN_OPEN}`,
    '',
    `    wall clock               ${shownDuration(model.wall_clock_ms)}`,
    `    max concurrency observed ${c.peak}`
      + (c.peak_exact ? '' : `  (a floor: ${count(c.unknown_intervals, 'interval', 'intervals')} UNKNOWN)`),
    `    nodes landed             ${model.nodes_landed} of ${total}`,
    `    nodes parked             ${model.parked.length}`,
  ];
  for (const node of model.parked) {
    lines.push(`      ${cell(node.id, 12)}reason ${node.park_reason === null ? WATCH_UNKNOWN : node.park_reason}`);
  }
  lines.push(`    frames painted           ${painted}`);
  return lines.map((line) => line.replace(/\s+$/, ''));
}

/* ------------------------------------------------------------------------ *
 * The CLI seam. ALL the loading happens here and nowhere above.
 * ------------------------------------------------------------------------ */

/** A guarded require that names the module a human has to fix. */
function requireLib(file, label) {
  try {
    return { ok: true, lib: require(path.join(LIB_DIR, file)) };
  } catch (error) {
    return {
      ok: false,
      missing: `${label}\n${error && error.message ? error.message : String(error)}\n`
        + 'Fix: run:\n  npm run build:lib',
    };
  }
}

/**
 * Read the run log and project it.
 *
 * TWO THINGS THIS DOES ON PURPOSE.
 *
 * 1. It checks the log EXISTS before reading it. `readFleetRunlog` returns an
 *    empty array for a file that is not there, so a seam that trusted it would
 *    render an absent log and an empty log identically, and the absent one
 *    would reach a human as a healthy fleet with nothing to report.
 * 2. It calls both producers POSITIONALLY. `projectBoard(events)` and
 *    `foldRunRecord(events)` take the array as their FIRST ARGUMENT.
 *    `projectBoard({ events })` returns a COMPLETELY EMPTY projection with NO
 *    ERROR, and for a view that is the worst available failure: a blank board
 *    reads as "nothing wrong" rather than as "nothing loaded". A committed case
 *    in `tests/fleet-glass.test.cjs` drives both call shapes and observes the
 *    object wrapped one coming back empty, so this is a checked property rather
 *    than a remembered one.
 */
function loadRun(root) {
  const runlog = requireLib('fleet-runlog.cjs', RUNLOG_MODULE);
  if (!runlog.ok) return { ok: false, missing: runlog.missing };

  const logPath = runlog.lib.fleetRunlogPath(root);
  if (!fs.existsSync(logPath)) {
    return {
      ok: false,
      missing: `${logPath}\n`
        + 'There is no fleet run log at that path, so there is no run to display.\n'
        + 'This is an ABSENT log, which is a different fact from an empty one.',
    };
  }

  const board = requireLib('fleet-board.cjs', BOARD_MODULE);
  if (!board.ok) return { ok: false, missing: board.missing };
  const runfold = requireLib('fleet-runfold.cjs', RUNFOLD_MODULE);
  if (!runfold.ok) return { ok: false, missing: runfold.missing };

  let events;
  try {
    events = runlog.lib.readFleetRunlog({ path: logPath });
  } catch (error) {
    return {
      ok: false,
      missing: `${logPath}\n${error && error.message ? error.message : String(error)}`,
    };
  }

  // POSITIONAL. See the note above. Never `fn({ events })`.
  return {
    ok: true,
    path: logPath,
    events,
    board: board.lib.projectBoard(events),
    runRecord: runfold.lib.foldRunRecord(events),
  };
}

/** How many events were read, stated so an empty log cannot pass as a full one. */
function provenanceLines(run) {
  return [
    `  read ${count(run.events.length, 'event', 'events')} from ${run.path}`,
    '',
  ];
}

const USAGE = [
  '  node scripts/fleet-glass.cjs graph <phase>   # the work graph and its edges',
  '  node scripts/fleet-glass.cjs leases          # the leases and the trunk',
  '  node scripts/fleet-glass.cjs asks            # the open asks, pick first',
  '  node scripts/fleet-glass.cjs watch <phase>   # the LIVE fleet, repainted',
  '        --frames <n>    stop after n frames. 0 means until the run closes.',
  '        --interval <ms> how long to wait between reads. 1000 by default.',
].join('\n');

/** A named flag with a numeric value, or its default when it is absent. */
function numericFlag(argv, name, fallback) {
  const at = argv.indexOf(name);
  if (at === -1 || at + 1 >= argv.length) return fallback;
  const parsed = Number(argv[at + 1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** A pause between polls. The ONLY thing in this file that waits. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Read once and fold once. Every frame calls this, which is what makes the
 * watch a READ REPEATED rather than a new kind of access.
 *
 * The graph is reloaded every frame on purpose: a node added to the phase mid
 * run should appear on the board, and re reading a document is still a read.
 */
function readWatchModel(root, phase, now) {
  const run = loadRun(root);
  if (!run.ok) return { ok: false, missing: run.missing };
  const graph = loadGraph({ root, phase });
  return {
    ok: true,
    path: run.path,
    model: foldWatch({
      events: run.events,
      runRecord: run.runRecord,
      graph: graph.ok ? graph.document : null,
      now,
    }),
  };
}

/**
 * The watch loop.
 *
 * BOUNDED BY `frames` so every test terminates. An unbounded polling loop in a
 * battery is a hung suite, and a hung suite is indistinguishable from a passing
 * one until somebody notices the clock.
 *
 * The screen is cleared only on a real terminal. Piped into a file or a test,
 * the frames are appended, so the battery reads plain text and the SUMMARY can
 * paste a frame verbatim.
 */
async function watchLoop(options) {
  const { root, phase, frames, intervalMs, write, clock } = options;
  const isTerminal = process.stdout.isTTY === true;
  let painted = 0;
  let last = null;

  for (;;) {
    const now = clock();
    const read = readWatchModel(root, phase, now);
    painted += 1;
    const meta = { phase, frame: painted, frames };

    if (!read.ok) {
      // An unavailable read is PAINTED rather than swallowed. A watch that
      // showed a blank screen while the log was missing would read as a calm
      // fleet.
      write(`${unavailablePanel(`WATCH  phase ${phase}`, read.missing).join('\n')}\n`);
    } else {
      last = read.model;
      if (isTerminal) write('\u001b[2J\u001b[H');
      write(`${renderWatchFrame(read.model, meta).join('\n')}\n`);
      if (read.model.run_closed) break;
    }

    if (frames > 0 && painted >= frames) break;
    await sleep(intervalMs);
  }

  if (last === null) {
    write(`${unavailablePanel('WATCH SUMMARY', 'no frame ever read a run, so there is nothing to summarise').join('\n')}\n`);
    return 1;
  }
  write(`${renderWatchSummary(last, { phase, frames_painted: painted }).join('\n')}\n`);

  // A LOG THAT OPENED AND CARRIED NOTHING IS NOT A SUCCESSFUL WATCH.
  // The file being readable is not the same fact as the run being observable,
  // and an exit code of 0 is the machine readable claim that nothing is wrong.
  // The refusal is deferred to here rather than raised on the first empty frame
  // on purpose: a human may legitimately open the watch a moment BEFORE the
  // fleet writes its first event, and quitting on frame 1 would break the very
  // use this view exists for. So the loop polls out its whole budget, and only
  // then reports that nothing was ever loaded.
  return last.events_read === 0 ? 1 : 0;
}

/** `runMain` passes NO arguments to main, so argv is read from process.argv. */
async function main() {
  const argv = process.argv.slice(2);
  const verb = argv.length > 0 ? argv[0] : '';
  let lines;

  if (verb === 'watch') {
    const phase = argv.length > 1 && !argv[1].startsWith('--') ? argv[1] : '';
    if (!isFilledString(phase)) {
      throw new ExitError(
        1,
        'the watch view needs a phase as its second argument, and none was given. Run:\n'
          + USAGE,
      );
    }
    return watchLoop({
      root: ROOT,
      phase,
      frames: numericFlag(argv, '--frames', 0),
      intervalMs: numericFlag(argv, '--interval', 1000),
      write: (text) => process.stdout.write(text),
      clock: () => Date.now(),
    });
  }

  if (verb === 'graph') {
    const phase = argv.length > 1 ? argv[1] : '';
    if (!isFilledString(phase)) {
      throw new ExitError(
        1,
        'the graph view needs a phase as its second argument, and none was given. Run:\n'
          + USAGE,
      );
    }
    const loaded = loadGraph({ root: ROOT, phase });
    lines = loaded.ok
      ? renderGraphView(loaded.document)
      : unavailablePanel(`GRAPH  phase ${phase}`, loaded.missing);
  } else if (verb === 'leases' || verb === 'asks') {
    const run = loadRun(ROOT);
    if (!run.ok) {
      lines = unavailablePanel(verb === 'leases' ? 'LEASES' : 'ASKS', run.missing);
    } else if (verb === 'leases') {
      lines = [...provenanceLines(run), ...renderLeaseView(run.board)];
    } else {
      lines = [
        ...provenanceLines(run),
        ...renderAskView({ board: run.board, runRecord: run.runRecord }),
      ];
    }
  } else {
    throw new ExitError(
      1,
      `fleet-glass.cjs has 4 views and ${JSON.stringify(verb)} is not one of them. Run:\n`
        + USAGE,
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

if (require.main === module) runMain(main);

module.exports = {
  GLASS_ERROR_CODES,
  VERDICT_WORDING,
  PANEL_WORDING,
  WATCH_WORDING,
  WATCH_NODE_STATES,
  WATCH_UNKNOWN,
  loadGraph,
  renderGraphView,
  renderLeaseView,
  renderAskView,
  unavailablePanel,
  computeConcurrency,
  foldWatch,
  renderWatchFrame,
  renderWatchSummary,
  shownDuration,
};
