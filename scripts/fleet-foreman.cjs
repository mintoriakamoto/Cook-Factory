#!/usr/bin/env node
'use strict';

/**
 * fleet-foreman.cjs: Phase 21 of milestone v1.14 (Fleet Mode), the 4 verbs.
 *
 * The foreman is the only thing a human talks to while a fleet is running. It
 * reads the board, explains what the board says, takes the human's calls into a
 * contract amendment, and presents the ratchet escalation menu when a node hits
 * an anti loop break.
 *
 * THE PROPERTY THAT FIXES EVERY SHAPE IN THIS FILE: the foreman changes the
 * board, and the board changes the workers. It never commands a worker directly.
 * So nothing has to be reachable at the moment a decision is made, and the
 * amendment is an OVERLAY on a projection rather than a message sent to a
 * process that may already be dead.
 *
 * WHY THIS LIVES UNDER `scripts/` RATHER THAN AS A BUILT LIB, which is a
 * DECISION and not an oversight, in the register `scripts/gen-workgraph.cjs`
 * already uses. A built lib costs 2 lines of shared write surface that every
 * other plan in the repository contends on: an `eslint.config.mjs` entry and a
 * `docs/INVENTORY-MANIFEST.json` row, and that contention is a measured width
 * limiter. A script costs neither: the eslint config already carries a recursive
 * glob over every `.cjs` file under `scripts`, the inventory manifest enumerates
 * built libs and command families rather than scripts, and
 * `scripts/lint-test-file-count.cjs` does not list `scripts/` among its
 * production directories, so this module's 2 test files are uncapped. It owns no
 * governed surface, appears in no lint chain, and writes no registry.
 *
 * THE 3 FLEET LIBS IT CONSUMES ARE READ AT EXECUTION, NEVER TRANSCRIBED. The
 * producer is the authority. Every field name this module reads was taken by
 * driving the shipped folds over a synthetic event array and looking at what
 * came back, and the 2 producers TAKE THE EVENT ARRAY POSITIONALLY. Called as
 * `projectBoard({ events })` or `foldRunRecord({ events })` they return an empty
 * board and an empty record with NO error at all, and the empty record reports
 * `demonstrated_width.exact` as true, which is a literal all clear over a log
 * that was never read. A consumer built that way folds silence forever. Every
 * call below is positional and a committed case pins the trap.
 *
 * IT ADDS NO RUN LOG EVENT KIND. The amendment ledger is its own store beside
 * the run log, so the event vocabulary is untouched and this file cannot collide
 * with the lane that is extending it.
 *
 * IT REWRITES NO PLAN DOCUMENT. A running fleet editing a plan document in place
 * is a write race against every planner and checker in the repository. A
 * committed assertion reads this module's own source and confirms it names no
 * plan document path, which is the proof rather than the promise.
 *
 * Usage:
 *   node scripts/fleet-foreman.cjs read
 *   node scripts/fleet-foreman.cjs explain
 *   node scripts/fleet-foreman.cjs menu [--ask <id>]
 *   node scripts/fleet-foreman.cjs amend --author <who> --node <id> \
 *     --replacement <text> [--reason <why>] [--removes <must-have>]
 *
 * FERROX_FOREMAN_ROOT overrides the project root, so every case can be driven
 * against a scratch tree as a real child process. Same seam
 * `scripts/gen-workgraph.cjs` uses.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const {
  RECOMMENDED_MARKER,
  ASK_SIGNALS,
  RUNFOLD_UNKNOWN_STATUS,
  renderQuestion,
  buildEscalationMenu,
  foldAsks,
} = require('./fleet-ask.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

/**
 * The 3 fleet libs this module consumes, by name. Exported so the battery drives
 * the unavailable arm once PER MODULE rather than once, and so a fourth
 * dependency cannot be added without a case noticing.
 */
const LIB_NAMES = Object.freeze(['fleet-runlog', 'fleet-board', 'fleet-runfold']);

/** The function each lib must actually export for the seam to be usable. */
const LIB_REQUIRED_EXPORTS = Object.freeze({
  'fleet-runlog': ['fleetRunlogPath', 'readFleetRunlog'],
  'fleet-board': ['projectBoard'],
  'fleet-runfold': ['foldRunRecord'],
});

/** Every reason a foreman verb refuses. Callers branch on a code, never prose. */
const FOREMAN_ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'E_FOREMAN_UNAVAILABLE',
  NO_SUCH_ASK: 'E_FOREMAN_NO_SUCH_ASK',
});

/** Every reason the amendment validator refuses. */
const AMEND_ERROR_CODES = Object.freeze({
  UNKNOWN_NODE: 'E_AMEND_UNKNOWN_NODE',
  NO_REASON: 'E_AMEND_NO_REASON',
  NO_AUTHOR: 'E_AMEND_NO_AUTHOR',
  DEFERRED_DELIVERY: 'E_AMEND_DEFERRED_DELIVERY',
  WEAKENS_GATE: 'E_AMEND_WEAKENS_GATE',
});

/**
 * THE SCOPE REDUCTION GUARD.
 *
 * This guard exists because A CONTRACT THAT WAS QUIETLY REDUCED READS IDENTICAL
 * TO ONE THAT WAS MET. An amendment that says the delivery moved to later is not
 * a change to what the node owes, it is the same debt with the due date removed,
 * and the run that follows reports green against a contract nobody is tracking.
 * Cutting scope is legal and is what the descope move on the escalation menu is
 * for, but it has to be recorded AS a cut with a reason rather than smuggled in
 * as a postponement.
 *
 * The list is deliberately SHORT, EXPLICIT and EXPORTED, so a reviewer can check
 * it by eye and the battery can drive every entry. The refusal names the phrase
 * it matched, so a human can see exactly what tripped it rather than arguing
 * with a verdict.
 */
const DEFERRAL_PATTERNS = Object.freeze([
  'defer',
  'postpone',
  'punt',
  'later phase',
  'next phase',
  'future phase',
  'later milestone',
  'next milestone',
  'revisit later',
  'to be determined',
  'for now',
]);

/**
 * THE GATE WEAKENING GUARD.
 *
 * The amend verb is the one place a human changes what a running fleet must
 * deliver, and the moves this milestone's anti loop governance forbids outright
 * are exactly the ones that would arrive through here: weakening a gate,
 * lowering a declared threshold, or retroactively changing a success criterion
 * so that work already done now satisfies it. Those are not scope decisions, they
 * are the measurement being edited to match the result, and a ledger entry
 * recording one is a record of the evidence being rewritten rather than of the
 * contract being changed.
 *
 * Gates stay hard enforcing. An amendment cannot soften one, and this is the
 * refusal that says so out loud rather than trusting the author not to try.
 */
const GATE_WEAKENING_PATTERNS = Object.freeze([
  'weaken the gate',
  'lower the threshold',
  'lower the bar',
  'reduce the threshold',
  'skip the gate',
  'disable the gate',
  'bypass the gate',
  'relax the gate',
  'downgrade the severity',
  'retroactively',
]);

/** The 3 states the explain verb can report about a run as a whole. */
const EXPLAIN_SIGNALS = Object.freeze({
  NO_EVENTS: 'no-events',
  RESOLVED: 'resolved',
  ACTIVE: 'active',
});

/* ------------------------------------------------------------------------ *
 * Small helpers. Every one is total: no input throws.
 * ------------------------------------------------------------------------ */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The unavailable result. It carries `missing`, which NAMES the specific path or
 * module that could not be reached, and it NEVER carries a board.
 *
 * An absent payload reported as an empty board is the "nothing is missing"
 * failure this project has already shipped once, where an install assertion
 * counted paths in a payload that was absent entirely and reported success. A
 * calm dashboard over a run log that is not there is that same defect wearing an
 * interface, so the absence is the headline here rather than a footnote.
 */
function unavailable(missing, detail) {
  return {
    ok: false,
    code: FOREMAN_ERROR_CODES.UNAVAILABLE,
    missing,
    detail: detail === undefined ? '' : String(detail),
  };
}

/* ------------------------------------------------------------------------ *
 * The lib seam
 * ------------------------------------------------------------------------ */

/**
 * The real default: a guarded require of the built lib, following the shape
 * `scripts/gen-workgraph.cjs` uses so a caller learns which build command to
 * run rather than reading a stack trace.
 *
 * The seam is INJECTED so the unavailable arm is drivable without deleting
 * anything from the working tree, and the default is real so the live path is
 * honest rather than a permanently stubbed one.
 */
function defaultLoad(name) {
  // The name is 1 of the 3 in LIB_NAMES, which is a frozen list, so this
  // resolves a fixed set of paths rather than an arbitrary caller string.
  return require(path.join(LIB_DIR, `${name}.cjs`));
}

/**
 * Load the 3 fleet libs, or report which one could not be reached.
 *
 * @returns {{ok: true, libs: object}|{ok: false, code: string, missing: string, detail: string}}
 */
function loadLibs(load) {
  const loader = typeof load === 'function' ? load : defaultLoad;
  const libs = {};

  for (const name of LIB_NAMES) {
    const modulePath = path.join('ferrox-core', 'bin', 'lib', `${name}.cjs`);
    let mod;
    try {
      mod = loader(name);
    } catch (err) {
      // The verb NEVER throws out of here. A foreman that dies on a missing lib
      // gives the human a stack trace where a named absence was the answer.
      return unavailable(
        modulePath,
        `${err && err.message ? err.message : String(err)}. Build it with: npm run build:lib`,
      );
    }
    if (!isPlainObject(mod) && typeof mod !== 'function') {
      return unavailable(modulePath, 'the module resolved to something that is not a module');
    }
    for (const fnName of LIB_REQUIRED_EXPORTS[name]) {
      if (typeof mod[fnName] !== 'function') {
        return unavailable(
          modulePath,
          `it exports no ${fnName}, so this seam cannot be driven against it`,
        );
      }
    }
    libs[name] = mod;
  }

  return { ok: true, libs };
}

/* ------------------------------------------------------------------------ *
 * VERB 1: read the board
 * ------------------------------------------------------------------------ */

/**
 * Read the run log for a root and fold it into the board and the run record.
 *
 * @param {{root?: string, load?: Function, runId?: string}} input
 * @returns {{ok: true, board: object, runRecord: object, events: object[], logPath: string}
 *          |{ok: false, code: string, missing: string, detail: string}}
 */
function readBoard(input) {
  const { root, load, runId } = isPlainObject(input) ? input : {};
  if (!isFilledString(root)) {
    return unavailable('root', 'readBoard requires a project root and none was supplied');
  }

  const loaded = loadLibs(load);
  if (loaded.ok !== true) return loaded;
  const { libs } = loaded;

  // The path comes from the SHIPPED helper. This module spells no store path of
  // its own, so 1 convention governs where the evidence lives.
  let logPath;
  try {
    logPath = libs['fleet-runlog'].fleetRunlogPath(root);
  } catch (err) {
    return unavailable(
      path.join('ferrox-core', 'bin', 'lib', 'fleet-runlog.cjs'),
      `the path helper threw: ${err && err.message ? err.message : String(err)}`,
    );
  }

  // The shipped reader returns [] for an absent file, because a run that has not
  // started has an empty history rather than a broken one. That is right for the
  // reader and WRONG for this verb: an empty history and an absent log are the
  // same 2 states the "nothing is missing" defect confuses, so the absence is
  // checked HERE and reported by name.
  if (!fs.existsSync(logPath)) {
    return unavailable(
      logPath,
      'no run log exists at that path, so there is no board to read. This is an '
        + 'absence of evidence rather than a fleet with nothing wrong.',
    );
  }

  let events;
  try {
    events = libs['fleet-runlog'].readFleetRunlog({ path: logPath });
  } catch (err) {
    // The reader throws on an unparseable line BY DESIGN, naming the 1 based
    // line number and the path, because every derived figure comes from that
    // file. Its message is carried through verbatim so the diagnosis survives
    // the verb boundary rather than being paraphrased into uselessness.
    return unavailable(logPath, err && err.message ? err.message : String(err));
  }

  let board;
  let runRecord;
  try {
    // POSITIONAL, both of them. See the header.
    board = libs['fleet-board'].projectBoard(events);
    runRecord = isFilledString(runId)
      ? libs['fleet-runfold'].foldRunRecord(events, { run_id: runId })
      : libs['fleet-runfold'].foldRunRecord(events);
  } catch (err) {
    // A log holding more than 1 run refuses to fold without a filter, which is a
    // real diagnosis and not a crash. It reaches the human as written.
    return unavailable(logPath, err && err.message ? err.message : String(err));
  }

  return { ok: true, board, runRecord, events, logPath };
}

/* ------------------------------------------------------------------------ *
 * VERB 2: explain the state
 * ------------------------------------------------------------------------ */

/**
 * Explain a board and a run record in words, with a count beside every category.
 *
 * PURE over its 2 arguments. It requires nothing, reads no file and READS NO
 * CLOCK: the instant arrives as an explicit `nowMs`, following the shape the
 * shipped gate cap lib already uses for time.
 *
 * EVERY UNKNOWN IS RENDERED AS AN UNKNOWN, with its own line and its own count.
 * A worker that died without an end event makes the width unknowable rather than
 * approximate, and a foreman that quietly counts such a worker as running or as
 * finished is the interface undoing the fold's honesty. The closed count and the
 * unknown count PARTITION the intervals, so an unknown cannot be absorbed into
 * either neighbour without the totals disagreeing.
 *
 * EXPIRY WITH NO CLOCK IS `null`, NOT 0. The shipped `isLeaseExpired` returns
 * false when the instant is absent, which is correct for a reclaim decision and
 * would be a substituted answer here: it would report every lease as live. An
 * unjudgeable lease is counted under `expiry_unknown` instead.
 *
 * @param {{board?: object, runRecord?: object, nowMs?: number}} input
 * @returns {{ok: true, lines: string[], counts: object, signal: string}
 *          |{ok: false, code: string, missing: string, detail: string}}
 */
function explainState(input) {
  const { board, runRecord, nowMs } = isPlainObject(input) ? input : {};
  const absent = [];
  if (!isPlainObject(board)) absent.push('board');
  if (!isPlainObject(runRecord)) absent.push('runRecord');
  if (absent.length > 0) {
    return unavailable(
      absent.join(' and '),
      'explainState requires both a board and a run record. Explaining an absent '
        + 'input would render an empty dashboard over nothing.',
    );
  }

  const leases = isPlainObject(board.leases) ? board.leases : {};
  const queue = isPlainObject(board.queue) ? board.queue : {};
  const tickets = Array.isArray(queue.tickets) ? queue.tickets : [];
  const completed = Array.isArray(board.completed) ? board.completed : [];
  const workers = Array.isArray(runRecord.workers) ? runRecord.workers : [];
  const width = isPlainObject(runRecord.demonstrated_width)
    ? runRecord.demonstrated_width
    : null;

  const clockKnown = isFiniteNumber(nowMs);

  const held = [];
  const released = [];
  const reclaimed = [];
  const expired = [];
  const expiryUnknown = [];

  for (const nodeId of Object.keys(leases)) {
    const lease = leases[nodeId];
    if (!isPlainObject(lease)) continue;
    if (lease.state === 'held') held.push(nodeId);
    if (lease.state === 'released') released.push(nodeId);
    // A reclaim advances the epoch. The projection keeps exactly 1 lease per
    // node, the current one, so a displaced holder is not in this table and an
    // epoch above 1 is the surviving evidence that somebody was displaced.
    if (isFiniteNumber(lease.lease_epoch) && lease.lease_epoch > 1) reclaimed.push(nodeId);

    if (lease.state !== 'held') continue;
    if (!clockKnown || !isFiniteNumber(lease.expires_at_ms)) {
      expiryUnknown.push(nodeId);
    } else if (nowMs >= lease.expires_at_ms) {
      expired.push(nodeId);
    }
  }

  const closedWorkers = [];
  const unknownWorkers = [];
  for (const worker of workers) {
    if (!isPlainObject(worker)) continue;
    if (worker.status === RUNFOLD_UNKNOWN_STATUS) unknownWorkers.push(worker);
    else closedWorkers.push(worker);
  }

  const openTickets = tickets.filter(
    (ticket) => isPlainObject(ticket) && (ticket.completed_at === null || ticket.completed_at === undefined),
  );
  const trunk = isPlainObject(queue.held_by) ? queue.held_by : null;

  const counts = {
    held: held.length,
    released: released.length,
    reclaimed: reclaimed.length,
    expired: clockKnown ? expired.length : null,
    expiry_unknown: expiryUnknown.length,
    queued: tickets.length,
    queued_open: openTickets.length,
    trunk_held: trunk === null ? 0 : 1,
    completed: completed.length,
    workers_closed: closedWorkers.length,
    workers_unknown: unknownWorkers.length,
    width_unknown_intervals: width !== null && isFiniteNumber(width.unknown_intervals)
      ? width.unknown_intervals
      : 0,
  };

  const hasEvidence = workers.length > 0
    || Object.keys(leases).length > 0
    || tickets.length > 0
    || completed.length > 0
    || trunk !== null;

  const unresolved = counts.held > 0
    || counts.workers_unknown > 0
    || counts.trunk_held > 0
    || counts.queued_open > 0
    || counts.width_unknown_intervals > 0
    || (width !== null && width.exact !== true);

  let signal = EXPLAIN_SIGNALS.ACTIVE;
  if (!hasEvidence) signal = EXPLAIN_SIGNALS.NO_EVENTS;
  else if (!unresolved) signal = EXPLAIN_SIGNALS.RESOLVED;

  const lines = [];

  // Line 0 states which of the 3 it is, and the 3 are worded DIFFERENTLY on
  // purpose. A run carrying no events at all and a run whose events all resolved
  // are not the same fact, and reporting them with 1 sentence is exactly how an
  // absent payload gets read as a healthy one.
  if (signal === EXPLAIN_SIGNALS.NO_EVENTS) {
    lines.push(
      'Run status: NO EVENTS. This run record and board carry no events at all, '
        + 'so nothing below describes work that happened. This is an absence of '
        + 'evidence, not a fleet with nothing wrong.',
    );
  } else if (signal === EXPLAIN_SIGNALS.RESOLVED) {
    lines.push(
      'Run status: RESOLVED. Every worker interval closed, every lease reached a '
        + 'settled state, and nothing is holding the trunk.',
    );
  } else {
    lines.push('Run status: ACTIVE. Work is claimed, held or unresolved.');
  }

  lines.push(`Claimed and held: ${counts.held}${held.length > 0 ? ` (${namesOf(held, leases)})` : ''}`);
  lines.push(`Released: ${counts.released}${released.length > 0 ? ` (${released.join(', ')})` : ''}`);
  lines.push(
    `Leases reclaimed from a prior holder: ${counts.reclaimed}`
      + `${reclaimed.length > 0 ? ` (${reclaimed.join(', ')})` : ''}`,
  );

  if (counts.expired === null) {
    lines.push(
      `Leases expired: UNKNOWN. No instant was supplied, so expiry cannot be `
        + `judged for ${counts.expiry_unknown} held lease`
        + `${counts.expiry_unknown === 1 ? '' : 's'}. Reporting 0 here would be a `
        + 'substituted answer rather than a measured one.',
    );
  } else {
    lines.push(
      `Leases expired: ${counts.expired}${expired.length > 0 ? ` (${expired.join(', ')})` : ''}`,
    );
    if (counts.expiry_unknown > 0) {
      lines.push(
        `Leases whose expiry is UNKNOWN: ${counts.expiry_unknown} `
          + `(${expiryUnknown.join(', ')}), because the lease carries no expiry stamp.`,
      );
    }
  }

  lines.push(`Queued for the trunk: ${counts.queued} ticket`
    + `${counts.queued === 1 ? '' : 's'}, ${counts.queued_open} still open`);
  lines.push(
    trunk === null
      ? 'Trunk holder: nobody is holding the trunk.'
      : `Trunk holder: ${String(trunk.worker_id)} on node ${String(trunk.node_id)} `
        + `at ticket ${String(trunk.ticket)}.`,
  );
  lines.push(`Completed: ${counts.completed}${completed.length > 0 ? ` (${completed.join(', ')})` : ''}`);
  lines.push(`Worker intervals closed: ${counts.workers_closed}`);

  // The unknowns get their OWN line and their OWN count, always, including when
  // the count is 0. A category that disappears when it is empty is a category a
  // reader stops looking for.
  lines.push(
    `Worker intervals UNKNOWN: ${counts.workers_unknown}`
      + `${unknownWorkers.length > 0
        ? ` (${unknownWorkers.map((w) => `${String(w.node_id)} by ${String(w.worker_id)}`).join(', ')})`
        : ''}`
      + '. An interval with no end event is neither running nor finished, and it '
      + 'is counted in neither.',
  );

  if (width === null) {
    lines.push('Demonstrated width: UNKNOWN. The run record carries no width claim at all.');
  } else if (width.exact === true) {
    lines.push(`Demonstrated width: ${String(width.value)}, exact.`);
  } else {
    lines.push(
      `Demonstrated width: ${String(width.value)} is a LOWER BOUND and is not exact, `
        + `because ${counts.width_unknown_intervals} interval`
        + `${counts.width_unknown_intervals === 1 ? '' : 's'} could not be placed. `
        + 'A width that cannot be known is reported as unknowable rather than approximated.',
    );
  }

  return { ok: true, lines, counts, signal };
}

/** Render a held node with its holder, so a count is never the only answer. */
function namesOf(nodeIds, leases) {
  return nodeIds
    .map((nodeId) => {
      const lease = leases[nodeId];
      const worker = isPlainObject(lease) ? lease.worker_id : undefined;
      const epoch = isPlainObject(lease) ? lease.lease_epoch : undefined;
      return `${nodeId} by ${String(worker)} at epoch ${String(epoch)}`;
    })
    .join(', ');
}

/* ------------------------------------------------------------------------ *
 * VERB 4: present the ratchet escalation menu
 * ------------------------------------------------------------------------ */

/**
 * The stable identity of an ask. The fold emits no id of its own, and a human
 * needs something to name on the command line, so the id is derived from the 2
 * fields that make an ask unique within a fold.
 */
function askIdOf(ask) {
  if (!isPlainObject(ask)) return '';
  return `${String(ask.node_id)}:${String(ask.cause)}`;
}

/**
 * Present the ratchet escalation menu for 1 ask.
 *
 * THIS FUNCTION FORMATS NO QUESTION. The menu is BUILT by the question layer and
 * RENDERED by the question layer, so a bare list of moves cannot be presented
 * from here even by accident. The only lines this verb contributes are the
 * selection statement above the rendered question. That is the whole point of a
 * chokepoint: a phase that mentions the rule 3 times can drift 3 ways, and a
 * phase with 1 refusing chokepoint can only drift by deleting it.
 *
 * "Try again" is not on the menu and cannot be put on it from here: the legal
 * move list lives in the question layer and it refuses the 2 forbidden requests
 * by name.
 *
 * @param {{board?: object, runRecord?: object, askId?: string, thresholds?: object}} input
 */
function presentMenu(input) {
  const {
    board, runRecord, askId, thresholds, requestedMove,
  } = isPlainObject(input) ? input : {};

  const folded = foldAsks({ board, runRecord, thresholds });
  // The question layer's own refusal reaches the caller as written. Paraphrasing
  // a library's diagnosis is how a precise message becomes a vague one.
  if (folded.ok !== true) return folded;

  const { asks, signal } = folded;
  const available = asks.map(askIdOf);

  if (asks.length === 0) {
    if (isFilledString(askId)) return noSuchAsk(askId, available);
    // NONE and CLEAR are kept distinct all the way to the human. An empty ask
    // list over a record with nothing in it is not an all clear.
    return {
      ok: true,
      presented: false,
      signal,
      asks,
      lines: [
        signal === ASK_SIGNALS.NONE
          ? 'No escalation menu. The fold found NO EVIDENCE to read, so this is an '
            + 'absence rather than an all clear.'
          : 'No escalation menu. The fold read real evidence and found no condition '
            + 'that needs a human.',
      ],
    };
  }

  let ask;
  let selectedAutomatically;
  if (isFilledString(askId)) {
    ask = asks.find((candidate) => askIdOf(candidate) === askId);
    if (ask === undefined) return noSuchAsk(askId, available);
    selectedAutomatically = false;
  } else {
    // The fold returns a total order with the worst first, so the head IS the
    // highest severity ask.
    [ask] = asks;
    selectedAutomatically = true;
  }

  const rounds = isPlainObject(runRecord) && isPlainObject(runRecord.rounds_per_artifact)
    ? runRecord.rounds_per_artifact[ask.node_id]
    : undefined;

  // The blocking set is every open ask. A break with several open conditions is
  // a systemic state rather than 1 node, and the question layer's own ranking
  // turns a wide blocking set into a fence for exactly that reason.
  // `requestedMove` is passed STRAIGHT THROUGH to the question layer, which is
  // the only place that knows which moves are legal. A human who tells the
  // foreman to just try again hits the governance refusal by name rather than
  // being quietly given a menu that has no such option on it, and the foreman
  // never has to carry a copy of the forbidden list to make that happen.
  const built = buildEscalationMenu({
    ask,
    rounds: isFiniteNumber(rounds) ? rounds : 0,
    blockingSet: asks,
    requestedMove,
  });
  if (built.ok !== true) return built;

  const rendered = renderQuestion(built.question);
  if (rendered.ok !== true) return rendered;

  const header = selectedAutomatically
    ? `Foreman selected the highest severity ask: ${askIdOf(ask)} graded ${String(ask.severity)}, `
      + `out of ${asks.length} open.`
    : `Ask ${askIdOf(ask)} graded ${String(ask.severity)}, out of ${asks.length} open.`;

  return {
    ok: true,
    presented: true,
    signal,
    ask,
    ask_id: askIdOf(ask),
    asks,
    available,
    selected_automatically: selectedAutomatically,
    question: built.question,
    lines: [header, ...rendered.lines],
  };
}

/**
 * The unknown ask refusal LISTS the ids that exist. A refusal that says only
 * that the id was not found leaves the human exactly where they started, and
 * this verb's entire purpose is to be the thing a human can talk to.
 */
function noSuchAsk(askId, available) {
  return {
    ok: false,
    code: FOREMAN_ERROR_CODES.NO_SUCH_ASK,
    available,
    message: available.length === 0
      ? `no ask matches "${askId}", and there are no open asks at all`
      : `no ask matches "${askId}". The open asks are: ${available.join(', ')}`,
  };
}

/* ------------------------------------------------------------------------ *
 * VERB 3: amend the contract
 * ------------------------------------------------------------------------ */

/**
 * The amendment ledger path, DERIVED from the shipped run log path helper rather
 * than written as a second constant.
 *
 * The derivation reads what the helper returns for a root and places the ledger
 * beside it, in the same directory, with the same extension and a parallel name.
 * Writing an independent constant here would mean 2 conventions governing 2
 * stores that are meant to sit together, and the first time the run log moved
 * the ledger would silently stay behind.
 */
function amendmentLedgerPath(root, load) {
  const loaded = loadLibs(load);
  if (loaded.ok !== true) return null;
  return ledgerBesideLog(loaded.libs['fleet-runlog'].fleetRunlogPath(root));
}

function ledgerBesideLog(logPath) {
  const dir = path.dirname(logPath);
  const ext = path.extname(logPath);
  const base = path.basename(logPath, ext);
  // `fleet-runlog` becomes `fleet-amendments`, so the family prefix the helper
  // chose is preserved rather than re-decided here. A log whose name does not
  // carry the family suffix keeps its whole stem, so the 2 stores still sit
  // together instead of the derivation quietly producing an unrelated name.
  const FAMILY = 'runlog';
  const prefix = base.endsWith(FAMILY) ? base.slice(0, -FAMILY.length) : `${base}-`;
  return path.join(dir, `${prefix}amendments${ext}`);
}

/**
 * The real default append: the same durable protocol the run log uses.
 *
 * A plain append gives neither mutual exclusion nor durability, and the foreman
 * is a SECOND WRITER beside the loop by definition, so the plain append is
 * exactly the inherited gap this store must not reproduce. Open, write, sync and
 * close run inside the shared file lock, and the descriptor is closed in a
 * `finally` so a throw between the write and the sync cannot leak it.
 */
function defaultAppend(target, line) {
  // Required here rather than at module load so a tree without the built lib can
  // still reach every pure verb above, and so the seam stays injectable.
  const atomic = require(path.join(LIB_DIR, 'atomic-state.cjs'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomic.withFileLock(target, () => {
    const fd = fs.openSync(target, 'a');
    try {
      fs.writeFileSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      try {
        fs.closeSync(fd);
      } catch { /* already closed */ }
    }
  });
}

/** Every node the board knows about, from all 3 places the projection names one. */
function nodesOnBoard(board) {
  const ids = new Set();
  if (!isPlainObject(board)) return ids;
  if (isPlainObject(board.leases)) for (const id of Object.keys(board.leases)) ids.add(id);
  if (isPlainObject(board.attempts)) for (const id of Object.keys(board.attempts)) ids.add(id);
  if (Array.isArray(board.completed)) for (const id of board.completed) ids.add(String(id));
  return ids;
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(isFilledString).map((entry) => entry.trim());
  if (isFilledString(value)) return [value.trim()];
  return [];
}

function refuseAmend(code, detail, matched) {
  const out = { ok: false, code, detail };
  if (matched !== undefined) out.matched = matched;
  return out;
}

/** The first pattern the text contains, or null. Lowercased on both sides. */
function firstMatch(text, patterns) {
  const lowered = String(text).toLowerCase();
  for (const pattern of patterns) {
    if (lowered.includes(pattern)) return pattern;
  }
  return null;
}

/**
 * Validate an amendment, then append exactly 1 record to the ledger.
 *
 * VALIDATION RUNS COMPLETELY BEFORE ANYTHING IS OPENED, and nothing is written
 * on any refusal. The order is FIXED so a request carrying 2 defects produces a
 * deterministic code that a case can assert on:
 *
 *   1. author        an unattributed change cannot be recorded at all, so this
 *                    runs first: there is no point validating the content of a
 *                    request nobody is willing to sign
 *   2. node          the amendment must be about something that exists
 *   3. reason        a removal with no recorded reason is a scope cut with no
 *                    evidence behind it
 *   4. gate          the replacement must not weaken a gate, lower a declared
 *                    threshold, or retroactively edit a criterion
 *   5. deferral      the replacement must CHANGE the delivery rather than
 *                    postpone it
 *
 * The instant arrives as an explicit `nowIso` rather than being read from a
 * clock inside the logic, so 2 runs over equal inputs produce equal records.
 *
 * @param {{root?: string, board?: object, amendment?: object, append?: Function,
 *          load?: Function, nowIso?: string}} input
 */
function amendContract(input) {
  const {
    root, board, amendment, append, load, nowIso,
  } = isPlainObject(input) ? input : {};

  if (!isFilledString(root)) {
    return unavailable('root', 'amendContract requires a project root and none was supplied');
  }
  if (!isPlainObject(board)) {
    return unavailable(
      'board',
      'amendContract requires the board, because an amendment naming a node that '
        + 'is not on it cannot be caught without it',
    );
  }

  const request = isPlainObject(amendment) ? amendment : {};

  // 1. Author. An absent amendment lands here too: it carries no author either.
  if (!isFilledString(request.author)) {
    return refuseAmend(
      AMEND_ERROR_CODES.NO_AUTHOR,
      'the amendment records no author. An unattributed change to what a node '
        + 'must deliver is a scope change nobody can be asked about later, so the '
        + 'ledger is not permitted to contain one.',
    );
  }

  // 2. Node.
  const known = nodesOnBoard(board);
  const nodeId = isFilledString(request.node_id) ? request.node_id.trim() : '';
  if (nodeId === '' || !known.has(nodeId)) {
    const listed = [...known].sort();
    return refuseAmend(
      AMEND_ERROR_CODES.UNKNOWN_NODE,
      `the amendment names node "${nodeId}", which is not on the board. `
        + (listed.length === 0
          ? 'The board carries no nodes at all.'
          : `The nodes on the board are: ${listed.join(', ')}.`),
    );
  }

  // 3. A removal needs a reason.
  const removes = asList(request.removes);
  const adds = asList(request.adds);
  const reason = isFilledString(request.reason) ? request.reason.trim() : '';
  if (removes.length > 0 && reason === '') {
    return refuseAmend(
      AMEND_ERROR_CODES.NO_REASON,
      `the amendment removes ${removes.length} must have `
        + `(${removes.join(', ')}) and records no reason. A cut with no reason is `
        + 'indistinguishable from a delivery that was never attempted.',
    );
  }

  const replacement = isFilledString(request.replacement) ? request.replacement.trim() : '';

  // 4. The gate guard runs BEFORE the deferral guard, because an amendment that
  // both weakens a gate and postpones the work is first of all an edit to the
  // measurement, and that is the more serious of the 2 findings.
  const weakening = firstMatch(replacement, GATE_WEAKENING_PATTERNS);
  if (weakening !== null) {
    return refuseAmend(
      AMEND_ERROR_CODES.WEAKENS_GATE,
      `the replacement text contains "${weakening}", which weakens a gate, lowers a `
        + 'declared threshold or retroactively edits a criterion. Gates stay hard '
        + 'enforcing: an amendment may change what a node delivers, never the '
        + 'measurement that decides whether it did.',
      weakening,
    );
  }

  // 5. The deferral guard.
  const deferral = firstMatch(replacement, DEFERRAL_PATTERNS);
  if (deferral !== null) {
    return refuseAmend(
      AMEND_ERROR_CODES.DEFERRED_DELIVERY,
      `the replacement text contains "${deferral}", which postpones the delivery `
        + 'rather than changing it. A contract that was quietly reduced reads '
        + 'identical to one that was met. Cut the scope and record why, or change '
        + 'the approach, but do not move the same debt to later.',
      deferral,
    );
  }

  // Everything below this line is a side effect, and nothing above it was one.
  const ledgerPath = amendmentLedgerPath(root, load);
  if (ledgerPath === null) {
    return unavailable(
      path.join('ferrox-core', 'bin', 'lib', 'fleet-runlog.cjs'),
      'the ledger path is derived from the shipped run log path helper, and that '
        + 'lib could not be reached',
    );
  }

  const record = {
    ts: isFilledString(nowIso) ? nowIso : new Date().toISOString(),
    author: request.author.trim(),
    node_id: nodeId,
    kind: isFilledString(request.kind) ? request.kind.trim() : 'amend',
    removes,
    adds,
    replacement,
    reason,
  };

  const writer = typeof append === 'function' ? append : defaultAppend;
  try {
    writer(ledgerPath, `${JSON.stringify(record)}\n`);
  } catch (err) {
    return unavailable(ledgerPath, err && err.message ? err.message : String(err));
  }

  return { ok: true, record, ledgerPath };
}

/**
 * Read the amendment ledger in append order. An absent ledger is an empty list,
 * because a run nobody has amended has no amendments rather than a broken store.
 */
function readAmendments(root, load) {
  const ledgerPath = amendmentLedgerPath(root, load);
  if (ledgerPath === null || !fs.existsSync(ledgerPath)) return [];
  const raw = fs.readFileSync(ledgerPath, 'utf8');
  const records = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') continue;
    records.push(JSON.parse(line));
  }
  return records;
}

/**
 * A deep copy that preserves the prototype of every object it walks, so a null
 * prototype map stays a null prototype map. Only own enumerable keys are copied,
 * which is what keeps a poisoned prototype from being copied INTO the result.
 */
function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (typeof value !== 'object' || value === null) return value;
  const out = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  for (const key of Object.keys(value)) out[key] = deepCopy(value[key]);
  return out;
}

/**
 * Overlay the amendment ledger onto a board and return a NEW board.
 *
 * It mutates neither argument. The board is a PROJECTION, and a projection is
 * never patched in place: patching one would mean the overlay and the fold could
 * disagree about what the board says, with no way to tell which had been applied.
 * Rebuilding is always correct because the ledger is append only.
 *
 * Records are applied IN LEDGER ORDER and the last one wins, which is what makes
 * the ledger itself the evidence: the whole history stays readable under
 * `amendments`, and only the resolved answer sits under `contract`.
 */
function applyAmendments(board, records) {
  const source = isPlainObject(board) ? board : {};
  // A structural copy that PRESERVES THE NULL PROTOTYPE the projection uses for
  // its node keyed maps. A JSON round trip loses it, and losing it is not a
  // cosmetic difference: node ids are keys, so a node named `__proto__` or
  // `constructor` behaves like an ordinary key on a null prototype map and
  // reaches the object prototype on an ordinary one. An overlay that quietly
  // downgraded that would hand the amendment path a prototype pollution seam.
  const next = deepCopy(source);
  next.amendments = Object.create(null);
  next.contract = Object.create(null);

  const list = Array.isArray(records) ? records : [];
  for (const record of list) {
    if (!isPlainObject(record)) continue;
    const nodeId = isFilledString(record.node_id) ? record.node_id : null;
    if (nodeId === null) continue;

    if (next.amendments[nodeId] === undefined) next.amendments[nodeId] = [];
    next.amendments[nodeId].push(deepCopy(record));

    const current = next.contract[nodeId] ?? { removed: [], added: [] };
    next.contract[nodeId] = {
      removed: [...current.removed, ...asList(record.removes)],
      added: [...current.added, ...asList(record.adds)],
      replacement: isFilledString(record.replacement)
        ? record.replacement
        : current.replacement,
      reason: isFilledString(record.reason) ? record.reason : current.reason,
      amended_by: record.author,
      amended_at: record.ts,
      amendment_count: next.amendments[nodeId].length,
    };
  }

  return next;
}

/* ------------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------------ */

const VERBS = Object.freeze(['read', 'explain', 'amend', 'menu']);

const USAGE = [
  '  node scripts/fleet-foreman.cjs read',
  '  node scripts/fleet-foreman.cjs explain',
  '  node scripts/fleet-foreman.cjs menu [--ask <id>] [--move <legal move>]',
  '  node scripts/fleet-foreman.cjs amend --author <who> --node <id> \\',
  '    --replacement <text> [--reason <why>] [--removes <must-have>]',
].join('\n');

function projectRoot() {
  return process.env.FERROX_FOREMAN_ROOT
    ? path.resolve(process.env.FERROX_FOREMAN_ROOT)
    : REPO_ROOT;
}

/** `runMain` passes NO arguments to main, so argv is read from process.argv. */
function readArgv(argv) {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const flag = (name) => {
    const at = argv.indexOf(`--${name}`);
    if (at === -1) return undefined;
    const value = argv[at + 1];
    return value === undefined || value.startsWith('--') ? '' : value;
  };
  return {
    verb: positional.length > 0 ? positional[0] : null,
    ask: flag('ask'),
    move: flag('move'),
    author: flag('author'),
    node: flag('node'),
    replacement: flag('replacement'),
    reason: flag('reason'),
    removes: flag('removes'),
  };
}

/** Turn any verb refusal into an ExitError, naming what was missing. */
function refuseToExit(result) {
  if (result.code === FOREMAN_ERROR_CODES.UNAVAILABLE) {
    throw new ExitError(
      1,
      `foreman: unavailable. Missing: ${result.missing}\n${result.detail}`,
    );
  }
  throw new ExitError(1, `foreman: ${result.code}. ${result.message ?? result.detail ?? ''}`);
}

function main() {
  const args = readArgv(process.argv.slice(2));

  if (args.verb === null) {
    throw new ExitError(
      1,
      `fleet-foreman.cjs needs 1 of the ${VERBS.length} verbs `
        + `(${VERBS.join(', ')}) as its first argument, and none was given. Run:\n${USAGE}`,
    );
  }
  if (!VERBS.includes(args.verb)) {
    throw new ExitError(
      1,
      `fleet-foreman.cjs does not know the verb "${args.verb}". `
        + `The verbs are ${VERBS.join(', ')}. Run:\n${USAGE}`,
    );
  }

  const root = projectRoot();
  const read = readBoard({ root });
  if (read.ok !== true) refuseToExit(read);

  if (args.verb === 'read') {
    process.stdout.write(`${JSON.stringify({
      log_path: read.logPath,
      events: read.events.length,
      board: read.board,
      run_record: read.runRecord,
    }, null, 2)}\n`);
    return;
  }

  if (args.verb === 'explain') {
    const explained = explainState({ board: read.board, runRecord: read.runRecord, nowMs: Date.now() });
    if (explained.ok !== true) refuseToExit(explained);
    process.stdout.write(`${explained.lines.join('\n')}\n`);
    return;
  }

  if (args.verb === 'menu') {
    const presented = presentMenu({
      board: read.board,
      runRecord: read.runRecord,
      askId: args.ask,
      requestedMove: args.move,
    });
    if (presented.ok !== true) refuseToExit(presented);
    process.stdout.write(`${presented.lines.join('\n')}\n`);
    return;
  }

  const amended = amendContract({
    root,
    board: read.board,
    amendment: {
      author: args.author,
      node_id: args.node,
      replacement: args.replacement,
      reason: args.reason,
      removes: args.removes,
    },
  });
  if (amended.ok !== true) refuseToExit(amended);

  process.stdout.write(`${JSON.stringify({
    ledger_path: amended.ledgerPath,
    record: amended.record,
  }, null, 2)}\n`);
}

if (require.main === module) runMain(main);

module.exports = {
  FOREMAN_ERROR_CODES,
  AMEND_ERROR_CODES,
  EXPLAIN_SIGNALS,
  DEFERRAL_PATTERNS,
  GATE_WEAKENING_PATTERNS,
  LIB_NAMES,
  LIB_REQUIRED_EXPORTS,
  RECOMMENDED_MARKER,
  readBoard,
  explainState,
  presentMenu,
  askIdOf,
  ledgerBesideLog,
  amendmentLedgerPath,
  amendContract,
  applyAmendments,
  readAmendments,
  readArgv,
};
