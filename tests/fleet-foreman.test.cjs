'use strict';

/**
 * Phase 21 plan 04 (v1.14 Fleet Mode): the battery for the foreman's read,
 * explain and menu verbs in `scripts/fleet-foreman.cjs`.
 *
 * What these cases lock, and why each is shaped the way it is:
 *
 *   - AN ABSENT PAYLOAD IS NOT A HEALTHY ONE. The unavailable cases assert the
 *     refusal NAMES the missing path or the missing module, and they also assert
 *     that no board came back. "Nothing is missing" was vacuously true of a
 *     payload that was absent entirely once already in this project, and a
 *     foreman that renders an absent run log as a calm empty dashboard is that
 *     same defect wearing an interface.
 *   - THE PRODUCER IS THE AUTHORITY. The round trip case drives the SHIPPED
 *     `projectBoard` and `foldRunRecord` over a synthetic event array and
 *     ASSERTS THE SIGNALS ARE PRESENT IN PRODUCER OUTPUT BEFORE the foreman
 *     folds them. Both producers take the event array POSITIONALLY: called as
 *     `fn({ events })` they return an empty record with NO error, and
 *     `foldRunRecord({ events })` returns `demonstrated_width.exact === true`,
 *     which is a literal all clear. A consumer built that way folds silence
 *     forever. There is a dedicated case below that pins that trap.
 *   - COUNTERS, NEVER FLAGS. Every explain case asserts the COUNT in the
 *     returned table and asserts the rendered line carries it. A flag assertion
 *     passes for an implementation that reports a category and drops its
 *     members, which is exactly how an unterminated worker gets counted as
 *     finished.
 *   - ORDERING BY INDEX. The menu case proves the recommendation leads by
 *     COMPARING CHARACTER INDEXES in the joined text, because a presence check
 *     is satisfied by a renderer that leads with the numbers.
 *   - A TEST THAT IMPORTS A LIBRARY CANNOT SEE WHAT `main` DOES, so the CLI is
 *     driven as a real CHILD PROCESS and its exit code and streams are read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  FOREMAN_ERROR_CODES,
  LIB_NAMES,
  readBoard,
  explainState,
  presentMenu,
  askIdOf,
} = require('../scripts/fleet-foreman.cjs');

const {
  RECOMMENDED_MARKER,
  ASK_ERROR_CODES,
  MENU_ERROR_CODES,
  LEGAL_MOVE_IDS,
  ASK_CAUSES,
  ASK_SIGNALS,
  RUNFOLD_UNKNOWN_STATUS,
  renderQuestion,
} = require('../scripts/fleet-ask.cjs');

const { projectBoard } = require('../ferrox-core/bin/lib/fleet-board.cjs');
const { foldRunRecord } = require('../ferrox-core/bin/lib/fleet-runfold.cjs');
const { fleetRunlogPath } = require('../ferrox-core/bin/lib/fleet-runlog.cjs');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'fleet-foreman.cjs');

/* ------------------------------------------------------------------------ *
 * Scratch trees
 * ------------------------------------------------------------------------ */

const SCRATCH_ROOTS = [];

function scratchRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-foreman-'));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/** Write an event array into the canonical run log location for a scratch root. */
function plantRunlog(root, lines) {
  const target = fleetRunlogPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  return target;
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

/* ------------------------------------------------------------------------ *
 * A synthetic run carrying every category the foreman must render
 * ------------------------------------------------------------------------ */

const RUN = 'run-foreman';
const ts = (minute) => new Date(Date.UTC(2026, 6, 26, 12, minute, 0)).toISOString();

/**
 * n1 completes cleanly and releases. n2 is reclaimed from w2 at epoch 2 and its
 * first worker interval is left OPEN, which is the unknown. n1 also takes and
 * holds the trunk ticket. Every category the explain verb reports has a member.
 */
function populatedEvents() {
  return [
    { ts: ts(0), kind: 'run_started', run_id: RUN, graph_generation: 'g1' },
    { ts: ts(1), kind: 'claim_acquired', run_id: RUN, node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
    { ts: ts(2), kind: 'worker_started', run_id: RUN, worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', lease_epoch: 1 },
    { ts: ts(3), kind: 'worker_ended', run_id: RUN, worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', outcome: 'completed' },
    { ts: ts(4), kind: 'lease_released', run_id: RUN, node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
    { ts: ts(5), kind: 'claim_acquired', run_id: RUN, node_id: 'n2', worker_id: 'w2', lease_epoch: 1 },
    { ts: ts(6), kind: 'worker_started', run_id: RUN, worker_id: 'w2', node_id: 'n2', attempt_id: 'a2', lease_epoch: 1 },
    { ts: ts(7), kind: 'lease_reclaimed', run_id: RUN, node_id: 'n2', worker_id: 'w3', lease_epoch: 2, prior_worker_id: 'w2', prior_lease_epoch: 1, reason: 'lease expired' },
    { ts: ts(8), kind: 'queue_entered', run_id: RUN, node_id: 'n1', attempt_id: 'a1', ticket: 1 },
    { ts: ts(9), kind: 'queue_acquired', run_id: RUN, node_id: 'n1', attempt_id: 'a1', ticket: 1, worker_id: 'w1' },
  ];
}

/* ------------------------------------------------------------------------ *
 * THE PRODUCER CONTRACT, asserted before anything folds it
 * ------------------------------------------------------------------------ */

test('PRODUCER FIRST: the shipped folds carry every signal the foreman reads, driven POSITIONALLY', () => {
  const events = populatedEvents();
  const board = projectBoard(events);
  const record = foldRunRecord(events);

  // The board signals. Asserted NON ZERO first, so a later emptiness is loud.
  assert.equal(Object.keys(board.leases).length, 2, 'the producer emits 2 leases');
  assert.equal(board.leases.n1.state, 'released');
  assert.equal(board.leases.n2.state, 'held');
  assert.equal(board.leases.n2.lease_epoch, 2, 'a reclaim advances the epoch past 1');
  assert.equal(board.completed.length, 1);
  assert.deepEqual(board.completed, ['n1']);
  assert.equal(board.queue.tickets.length, 1);
  assert.ok(board.queue.held_by !== null, 'the producer emits a trunk holder');

  // The run record signals.
  assert.equal(record.workers.length, 2, 'the producer emits 2 worker intervals');
  const open = record.workers.filter((w) => w.status === RUNFOLD_UNKNOWN_STATUS);
  assert.equal(open.length, 1, 'exactly 1 interval was left open');
  assert.equal(record.demonstrated_width.exact, false, 'an open interval makes width inexact');
  assert.equal(record.demonstrated_width.unknown_intervals, 1);
});

test('THE TRAP: the named argument form folds SILENTLY to an empty all clear', () => {
  const events = populatedEvents();

  // No throw, no refusal, no signal. This is the shape a consumer built on
  // `fn({ events })` would fold forever while reporting a healthy fleet.
  const board = projectBoard({ events });
  const record = foldRunRecord({ events });

  assert.equal(Object.keys(board.leases).length, 0, 'the named form returns an EMPTY board with no error');
  assert.equal(record.workers.length, 0, 'the named form returns an EMPTY record with no error');
  assert.equal(
    record.demonstrated_width.exact,
    true,
    'and it reports width as EXACT, which is a literal all clear over an unread log',
  );

  // The foreman is built on the positional form, so it disagrees with the trap.
  const honest = foldRunRecord(events);
  assert.notEqual(honest.demonstrated_width.exact, record.demonstrated_width.exact);
});

/* ------------------------------------------------------------------------ *
 * readBoard: the unavailable arms, each on a case carrying the defect
 * ------------------------------------------------------------------------ */

test('REQUIRED FAILING ARM: a root with no run log is UNAVAILABLE and NAMES the missing path', () => {
  const root = scratchRoot();
  const expected = fleetRunlogPath(root);
  assert.equal(fs.existsSync(expected), false, 'the defect is genuinely present: no log on disk');

  const result = readBoard({ root });

  assert.equal(result.ok, false);
  assert.equal(result.code, FOREMAN_ERROR_CODES.UNAVAILABLE);
  assert.ok(result.missing.includes(expected), `the refusal must name ${expected}, got ${result.missing}`);
  assert.equal(result.board, undefined, 'an absent log NEVER comes back as an ok result carrying an empty board');
  assert.equal(result.runRecord, undefined);
});

test('REQUIRED FAILING ARM: each of the 3 fleet libs, refused one at a time, is NAMED', () => {
  const root = scratchRoot();
  plantRunlog(root, populatedEvents());

  assert.equal(LIB_NAMES.length, 3, 'the seam covers exactly the 3 fleet libs');

  let fired = 0;
  for (const refused of LIB_NAMES) {
    const load = (name) => {
      if (name === refused) throw new Error(`Cannot find module '${name}'`);
      // The seam under test resolves by name, so this stand in does too.
      return require(path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib', `${name}.cjs`));
    };

    const result = readBoard({ root, load });
    assert.equal(result.ok, false, `refusing ${refused} must not return an ok result`);
    assert.equal(result.code, FOREMAN_ERROR_CODES.UNAVAILABLE);
    assert.ok(result.missing.includes(refused), `the refusal must name ${refused}, got ${result.missing}`);
    assert.equal(result.board, undefined);
    fired += 1;
  }

  assert.equal(fired, 3, 'all 3 module refusals were observed, not just the first');
});

test('REQUIRED FAILING ARM: the load seam NEVER throws out of the verb', () => {
  const root = scratchRoot();
  plantRunlog(root, populatedEvents());

  const load = () => { throw new TypeError('the seam exploded'); };
  const result = readBoard({ root, load });

  assert.equal(result.ok, false);
  assert.equal(result.code, FOREMAN_ERROR_CODES.UNAVAILABLE);
  assert.ok(typeof result.detail === 'string' && result.detail.includes('the seam exploded'), 'the thrown diagnosis survives');
});

test("REQUIRED FAILING ARM: an unparseable line is UNAVAILABLE carrying the READER'S own message", () => {
  const root = scratchRoot();
  const target = plantRunlog(root, [
    JSON.stringify({ ts: ts(0), kind: 'run_started', run_id: RUN, graph_generation: 'g1' }),
    '{ this is not json',
  ]);

  const result = readBoard({ root });

  assert.equal(result.ok, false);
  assert.equal(result.code, FOREMAN_ERROR_CODES.UNAVAILABLE);
  assert.ok(result.detail.includes('line 2'), 'the reader names the 1 based line number and it survives');
  assert.ok(result.detail.includes(target), 'the reader names the path and it survives');
  assert.equal(result.board, undefined, 'a torn log NEVER folds to a board');
});

test('readBoard over a real log returns the board, the run record and the events', () => {
  const root = scratchRoot();
  plantRunlog(root, populatedEvents());

  const result = readBoard({ root });

  assert.equal(result.ok, true);
  assert.equal(result.events.length, 10, 'every planted line was read');
  assert.equal(Object.keys(result.board.leases).length, 2, 'the board is the POSITIONAL fold, not the empty one');
  assert.equal(result.runRecord.workers.length, 2);
  assert.equal(result.runRecord.demonstrated_width.exact, false);
});

/* ------------------------------------------------------------------------ *
 * explainState: counters, and an unknown that stays an unknown
 * ------------------------------------------------------------------------ */

test('explainState reports every category with its own COUNT', () => {
  const events = populatedEvents();
  const board = projectBoard(events);
  const runRecord = foldRunRecord(events);

  const out = explainState({ board, runRecord });
  assert.equal(out.ok, true);

  const c = out.counts;
  assert.equal(c.held, 1, 'n2 is held at epoch 2');
  assert.equal(c.released, 1, 'n1 released cleanly');
  assert.equal(c.reclaimed, 1, 'n2 carries an epoch above 1, which is a reclaim');
  assert.equal(c.completed, 1);
  assert.equal(c.queued, 1);
  assert.equal(c.trunk_held, 1);
  assert.equal(c.workers_closed, 1);
  assert.equal(c.workers_unknown, 1);

  const text = out.lines.join('\n');
  assert.ok(text.includes('n2'), 'the held node is named, not just counted');
  assert.ok(text.includes('w1'), 'the holder of the trunk is named');
});

test('THE UNKNOWN STAYS UNKNOWN: an open interval is never folded into held or completed', () => {
  const events = populatedEvents();
  const board = projectBoard(events);
  const runRecord = foldRunRecord(events);

  const out = explainState({ board, runRecord });
  const c = out.counts;

  // The producer emitted 2 intervals, 1 closed and 1 open.
  assert.equal(runRecord.workers.length, 2);
  assert.equal(c.workers_unknown, 1, 'the open interval is counted as UNKNOWN');
  assert.equal(c.workers_closed, 1, 'and NOT added to the closed count');
  assert.equal(
    c.workers_closed + c.workers_unknown,
    runRecord.workers.length,
    'the 2 counts partition the intervals, so an unknown cannot be double counted either',
  );
  assert.equal(c.completed, 1, 'the open interval did NOT raise the completed count');
  assert.equal(c.width_unknown_intervals, 1);

  const text = out.lines.join('\n');
  assert.ok(/UNKNOWN/.test(text), 'the unknown gets its own rendered line');
  assert.ok(
    text.includes('width'),
    'a width that cannot be known is stated rather than approximated',
  );
});

test('EXPIRY WITH NO CLOCK IS UNKNOWN, not zero expired', () => {
  const events = populatedEvents();
  const board = projectBoard(events);
  const runRecord = foldRunRecord(events);

  // No nowMs supplied. The shipped `isLeaseExpired` returns FALSE for an absent
  // clock, which would report every lease as live. That is a substituted answer
  // and the foreman must not repeat it.
  const blind = explainState({ board, runRecord });
  assert.equal(blind.counts.expired, null, 'with no clock the expired count is UNKNOWN rather than 0');
  assert.ok(blind.counts.expiry_unknown >= 1, 'and the leases it could not judge are counted');
  assert.ok(blind.lines.join('\n').includes('UNKNOWN'), 'the unknown is rendered');

  // With a clock and no expiry stamp on the lease, expiry is still unknowable.
  const timed = explainState({ board, runRecord, nowMs: Date.parse(ts(30)) });
  assert.equal(timed.counts.expired, 0, 'with a clock the count becomes a real 0');
  assert.notEqual(timed.counts.expired, blind.counts.expired, 'the 2 answers are DISTINCT, so null is not a spelled 0');
});

test('an expired lease is counted as expired once a clock is supplied', () => {
  const board = {
    completed: [],
    attempts: {},
    queue: { tickets: [], held_by: null },
    leases: {
      n1: { node_id: 'n1', worker_id: 'w1', lease_epoch: 1, state: 'held', acquired_at_ms: 1000, renewed_at_ms: 1000, expires_at_ms: 2000, holder: null },
    },
  };
  const runRecord = { workers: [], nodes: [], demonstrated_width: { value: 0, exact: true, unknown_intervals: 0 }, rounds_per_artifact: {}, false_green: { landed: 0, later_failed: 0, unknown: 0 } };

  const out = explainState({ board, runRecord, nowMs: 5000 });
  assert.equal(out.counts.expired, 1);
  assert.equal(out.counts.expiry_unknown, 0);
  assert.ok(out.lines.join('\n').includes('expired'));
});

test('AN EMPTY BUT VALID PAIR IS WORDED DIFFERENTLY FROM A CLEAN RUN', () => {
  const emptyBoard = { completed: [], leases: {}, queue: { tickets: [], held_by: null }, attempts: {} };
  const emptyRecord = foldRunRecord([]);

  const empty = explainState({ board: emptyBoard, runRecord: emptyRecord });
  assert.equal(empty.ok, true);
  assert.equal(empty.signal, 'no-events');

  // A run whose events all resolved cleanly: 1 node claimed, worked, ended and released.
  const cleanEvents = [
    { ts: ts(0), kind: 'run_started', run_id: RUN, graph_generation: 'g1' },
    { ts: ts(1), kind: 'claim_acquired', run_id: RUN, node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
    { ts: ts(2), kind: 'worker_started', run_id: RUN, worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', lease_epoch: 1 },
    { ts: ts(3), kind: 'worker_ended', run_id: RUN, worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', outcome: 'completed' },
    { ts: ts(4), kind: 'lease_released', run_id: RUN, node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
  ];
  const clean = explainState({ board: projectBoard(cleanEvents), runRecord: foldRunRecord(cleanEvents) });
  assert.equal(clean.signal, 'resolved');

  assert.notEqual(empty.signal, clean.signal, 'the 2 states are NOT reported with 1 word');
  assert.notEqual(
    empty.lines[0],
    clean.lines[0],
    'an absence of evidence reads differently from evidence that resolved',
  );
  assert.ok(empty.lines.join('\n').includes('no events'), 'the empty case says so in words');
});

test('explainState is PURE over its 2 arguments and mutates neither', () => {
  const events = populatedEvents();
  const board = projectBoard(events);
  const runRecord = foldRunRecord(events);
  const boardBefore = JSON.stringify(board);
  const recordBefore = JSON.stringify(runRecord);

  explainState({ board, runRecord });

  assert.equal(JSON.stringify(board), boardBefore);
  assert.equal(JSON.stringify(runRecord), recordBefore);
});

/* ------------------------------------------------------------------------ *
 * presentMenu: the chokepoint, reached from a second surface
 * ------------------------------------------------------------------------ */

function askFixture() {
  const events = populatedEvents();
  return { board: projectBoard(events), runRecord: foldRunRecord(events) };
}

test('presentMenu renders through the chokepoint and LEADS WITH THE RECOMMENDATION, by index', () => {
  const { board, runRecord } = askFixture();
  const out = presentMenu({ board, runRecord });

  assert.equal(out.ok, true);
  assert.equal(out.presented, true);

  const text = out.lines.join('\n');
  const recommendedIndex = text.indexOf(RECOMMENDED_MARKER);
  assert.ok(recommendedIndex >= 0, 'the marker is present at all');

  // The index of the FIRST non recommended move id must come after the marker.
  const others = LEGAL_MOVE_IDS.filter((id) => id !== out.question.recommendation);
  assert.equal(others.length, 3);
  for (const id of others) {
    const at = text.indexOf(id);
    assert.ok(at > recommendedIndex, `"${id}" appears at ${at}, at or before the recommendation at ${recommendedIndex}`);
  }
});

test('presentMenu with no askId selects the HIGHEST SEVERITY ask and SAYS it selected', () => {
  const { board, runRecord } = askFixture();
  const out = presentMenu({ board, runRecord });

  assert.equal(out.ok, true);
  assert.equal(out.ask.severity, 'high', 'the fold sorts high first and the verb takes the head');
  assert.ok(out.selected_automatically === true);
  assert.ok(
    out.lines.join('\n').includes('selected'),
    'the human is told the foreman picked which ask to escalate',
  );
});

test('REQUIRED FAILING ARM: an unknown askId is REFUSED and the refusal LISTS the ids that exist', () => {
  const { board, runRecord } = askFixture();

  const out = presentMenu({ board, runRecord, askId: 'nope:not-a-cause' });

  assert.equal(out.ok, false);
  assert.equal(out.code, FOREMAN_ERROR_CODES.NO_SUCH_ASK);
  assert.ok(out.message.includes('nope:not-a-cause'), 'the refusal names the id that was asked for');
  assert.ok(Array.isArray(out.available) && out.available.length > 0, 'and it carries the ids that DO exist');
  for (const id of out.available) {
    assert.ok(out.message.includes(id), `the refusal message lists ${id} rather than leaving the human where they started`);
  }
});

test('a named askId selects exactly that ask', () => {
  const { board, runRecord } = askFixture();
  const first = presentMenu({ board, runRecord });
  const id = askIdOf(first.ask);

  const out = presentMenu({ board, runRecord, askId: id });
  assert.equal(out.ok, true);
  assert.equal(askIdOf(out.ask), id);
  assert.equal(out.selected_automatically, false);
});

test('AN EMPTY ASK LIST IS NOT AN ALL CLEAR: no evidence and nothing wrong read differently', () => {
  const emptyBoard = { completed: [], leases: {}, queue: { tickets: [], held_by: null }, attempts: {} };
  const noEvidence = presentMenu({ board: emptyBoard, runRecord: foldRunRecord([]) });
  assert.equal(noEvidence.ok, true);
  assert.equal(noEvidence.presented, false);
  assert.equal(noEvidence.signal, ASK_SIGNALS.NONE);

  const cleanEvents = [
    { ts: ts(0), kind: 'run_started', run_id: RUN, graph_generation: 'g1' },
    { ts: ts(1), kind: 'claim_acquired', run_id: RUN, node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
    { ts: ts(2), kind: 'worker_started', run_id: RUN, worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', lease_epoch: 1 },
    { ts: ts(3), kind: 'worker_ended', run_id: RUN, worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', outcome: 'completed' },
    { ts: ts(4), kind: 'lease_released', run_id: RUN, node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
  ];
  const clean = presentMenu({ board: projectBoard(cleanEvents), runRecord: foldRunRecord(cleanEvents) });
  assert.equal(clean.presented, false);
  assert.equal(clean.signal, ASK_SIGNALS.CLEAR);

  assert.notEqual(noEvidence.signal, clean.signal, 'an absent payload is NOT reported with the same word as a healthy one');
});

test('REQUIRED FAILING ARM: a question with its recommendation STRIPPED is refused by the chokepoint', () => {
  const { board, runRecord } = askFixture();
  const out = presentMenu({ board, runRecord });
  assert.equal(out.ok, true, 'the intact question renders, so the refusal below is not a permanent condition');

  // Strip the recommendation and drive the SAME chokepoint the foreman uses.
  const stripped = { ...out.question };
  delete stripped.recommendation;
  const refused = renderQuestion(stripped);

  assert.equal(refused.ok, false);
  assert.equal(refused.code, ASK_ERROR_CODES.NO_RECOMMENDATION);

  // And a bare menu with the options reordered so the pick is not first.
  const reordered = { ...out.question, options: [...out.question.options].reverse() };
  const refusedOrder = renderQuestion(reordered);
  assert.equal(refusedOrder.ok, false);
  assert.equal(refusedOrder.code, ASK_ERROR_CODES.RECOMMENDATION_NOT_FIRST);
});

test('presentMenu FORMATS NO QUESTION OF ITS OWN: the rendered lines are the chokepoint output verbatim', () => {
  const { board, runRecord } = askFixture();
  const out = presentMenu({ board, runRecord });

  const direct = renderQuestion(out.question);
  assert.equal(direct.ok, true);
  assert.deepEqual(
    out.lines.filter((line) => direct.lines.includes(line)),
    direct.lines,
    'every chokepoint line appears verbatim, so this verb is not reformatting the question',
  );
});

test('the source of the foreman formats no question of its own', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
  assert.ok(src.includes('renderQuestion'), 'it calls the chokepoint');
  assert.ok(!src.includes('(Recommended)'), 'it never spells the marker, so it cannot render a menu by hand');
});

test('the ask cause vocabulary comes from the question layer rather than a copy', () => {
  const { board, runRecord } = askFixture();
  const out = presentMenu({ board, runRecord });
  assert.ok(
    Object.values(ASK_CAUSES).includes(out.ask.cause),
    `the selected ask carries a cause from the shipped table, got ${out.ask.cause}`,
  );
});

/* ------------------------------------------------------------------------ *
 * Anti loop governance: the 2 forbidden moves, reached through the foreman
 *
 * The escalation menu offers exactly the 4 legal moves. "Try again" is the
 * unbounded loop itself and it is NOT on the menu, and splitting into a new
 * phase or subphase is not either. These cases prove the foreman cannot present
 * or accept one, and the acceptance arm proves the refusals are not a function
 * that refuses every requested move.
 * ------------------------------------------------------------------------ */

test('THE MENU OFFERS EXACTLY THE 4 LEGAL MOVES AND NO RETRY', () => {
  const { board, runRecord } = askFixture();
  const out = presentMenu({ board, runRecord });

  const offered = out.question.options.map((option) => option.id);
  assert.equal(offered.length, 4, 'exactly 4 options, so a fifth cannot be slipped on');
  assert.deepEqual([...offered].sort(), [...LEGAL_MOVE_IDS].sort());

  for (const forbidden of ['try-again', 'try again', 'retry', 'again', 'rerun', 'new-phase', 'subphase', 'split-phase']) {
    assert.ok(!offered.includes(forbidden), `"${forbidden}" must NOT be an offered move`);
  }
});

test('REQUIRED FAILING ARM: asking the foreman to TRY AGAIN is REFUSED by name', () => {
  const { board, runRecord } = askFixture();

  let fired = 0;
  for (const requestedMove of ['try again', 'try-again', 'retry', 'rerun', 'again']) {
    const out = presentMenu({ board, runRecord, requestedMove });
    assert.equal(out.ok, false, `"${requestedMove}" must be refused`);
    assert.equal(out.code, MENU_ERROR_CODES.RETRY_FORBIDDEN);
    assert.ok(out.message.includes('anti loop governance'), 'the refusal names the rule it hit');
    fired += 1;
  }
  assert.equal(fired, 5, 'every retry phrasing was observed refused, not just the first');
});

test('REQUIRED FAILING ARM: asking the foreman to SPLIT INTO A NEW PHASE is REFUSED by name', () => {
  const { board, runRecord } = askFixture();

  let fired = 0;
  for (const requestedMove of ['new-phase', 'subphase', 'split phase', 'insert-phase']) {
    const out = presentMenu({ board, runRecord, requestedMove });
    assert.equal(out.ok, false, `"${requestedMove}" must be refused`);
    assert.equal(out.code, MENU_ERROR_CODES.NEW_PHASE_FORBIDDEN);
    fired += 1;
  }
  assert.equal(fired, 4, 'every phase splitting phrasing was observed refused');
});

test('THE ACCEPTANCE ARM: each of the 4 legal moves IS accepted, so the refusals discriminate', () => {
  const { board, runRecord } = askFixture();

  let accepted = 0;
  for (const requestedMove of LEGAL_MOVE_IDS) {
    const out = presentMenu({ board, runRecord, requestedMove });
    assert.equal(out.ok, true, `"${requestedMove}" is legal and must be accepted`);
    assert.equal(out.presented, true);
    accepted += 1;
  }
  assert.equal(accepted, 4, 'all 4 legal moves were accepted');
});

test('CHILD PROCESS: the command line cannot request a retry either', () => {
  const root = scratchRoot();
  plantRunlog(root, populatedEvents());

  const refused = runScript(['menu', '--move', 'try again'], root);
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(MENU_ERROR_CODES.RETRY_FORBIDDEN), refused.stderr);
  assert.equal(refused.stdout, '', 'no menu is printed alongside the refusal');

  // The same seam accepts a legal move, so the refusal above is not a permanent
  // condition of the flag.
  const accepted = runScript(['menu', '--move', 'park'], root);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.ok(accepted.stdout.includes(RECOMMENDED_MARKER));
});

/* ------------------------------------------------------------------------ *
 * The CLI, observed as a real child process
 * ------------------------------------------------------------------------ */

function runScript(args, root) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FERROX_FOREMAN_ROOT: root },
  });
}

test('CHILD PROCESS: no verb REFUSES and exits 1, naming the verbs', () => {
  const root = scratchRoot();
  const run = runScript([], root);

  assert.equal(run.status, 1);
  for (const verb of ['read', 'explain', 'amend', 'menu']) {
    assert.ok(run.stderr.includes(verb), `the usage names the ${verb} verb`);
  }
});

test('CHILD PROCESS: an unknown verb REFUSES and exits 1', () => {
  const root = scratchRoot();
  const run = runScript(['frobnicate'], root);
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('frobnicate'));
});

test('CHILD PROCESS: explain against a tree with NO RUN LOG names the missing path and exits 1', () => {
  const root = scratchRoot();
  const expected = fleetRunlogPath(root);
  const run = runScript(['explain'], root);

  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes(expected), `the CLI names ${expected}`);
  assert.ok(run.stderr.toLowerCase().includes('unavailable'), 'and it says unavailable rather than printing a calm empty board');
  assert.equal(run.stdout, '', 'NOTHING is printed to stdout, so no dashboard is rendered over an absent log');
});

test('CHILD PROCESS: all 4 verbs are reachable and each reports unavailable on an empty tree', () => {
  const root = scratchRoot();
  let fired = 0;
  for (const verb of ['read', 'explain', 'menu', 'amend']) {
    const run = runScript([verb], root);
    assert.equal(run.status, 1, `${verb} exits 1 with no log`);
    assert.ok(run.stderr.length > 0, `${verb} explains itself`);
    fired += 1;
  }
  assert.equal(fired, 4, 'all 4 verbs were driven, not just the first');
});

test('CHILD PROCESS: read over a real log prints the board as JSON and exits 0', () => {
  const root = scratchRoot();
  plantRunlog(root, populatedEvents());

  const run = runScript(['read'], root);
  assert.equal(run.status, 0, run.stderr);

  const parsed = JSON.parse(run.stdout);
  assert.equal(Object.keys(parsed.board.leases).length, 2);
  assert.equal(parsed.run_record.workers.length, 2);
  assert.equal(parsed.run_record.demonstrated_width.exact, false);
});

test('CHILD PROCESS: explain over a real log prints the categories and exits 0', () => {
  const root = scratchRoot();
  plantRunlog(root, populatedEvents());

  const run = runScript(['explain'], root);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('UNKNOWN'), 'the unknown category reaches the human');
  assert.ok(run.stdout.includes('n2'), 'the held node is named');
});

test('CHILD PROCESS: menu over a real log leads with the recommendation and exits 0', () => {
  const root = scratchRoot();
  plantRunlog(root, populatedEvents());

  const run = runScript(['menu'], root);
  assert.equal(run.status, 0, run.stderr);

  const at = run.stdout.indexOf(RECOMMENDED_MARKER);
  assert.ok(at >= 0, 'the marker reaches the human');
  const recommended = LEGAL_MOVE_IDS.find((id) => run.stdout.includes(`[${id}] ${RECOMMENDED_MARKER}`));
  assert.ok(recommended !== undefined, 'the recommended move is marked in the printed text');
  for (const id of LEGAL_MOVE_IDS.filter((m) => m !== recommended)) {
    assert.ok(run.stdout.indexOf(id) > at, `${id} must appear after the recommendation`);
  }
});
