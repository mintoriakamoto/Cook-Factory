'use strict';

/**
 * Phase 21 plan 01 (v1.14 Fleet Mode): the behaviour battery for the question
 * layer, `scripts/fleet-ask.cjs`.
 *
 * These tests lock the properties that make the chokepoint worth having, rather
 * than locking the function names:
 *
 *   - ORDERING BY INDEX, never by presence. The recommendation is proven to come
 *     first by COMPARING INDEXES in the joined text, because a presence check is
 *     satisfied by a renderer that leads with the numbers and mentions the pick
 *     at the bottom, which is the exact defect the chokepoint exists to prevent.
 *   - THE PRODUCER IS THE AUTHORITY. The round trip case drives the SHIPPED
 *     `foldRunRecord` and `projectBoard` over a synthetic event array and feeds
 *     their real output into the fold, so the fold is measured against what the
 *     producers emit rather than against what this file believes they emit. The
 *     first draft of this suite called both producers as `fn({ events })` and
 *     got an empty record back, silently: both take the array POSITIONALLY.
 *   - AN EMPTY PAYLOAD IS NOT A HEALTHY ONE. The empty case asserts the signal
 *     is `none` AND asserts it is NOT `clear`, because those 2 states reported
 *     with 1 word is how an absent payload gets read as an all clear.
 *   - COUNTERS, NOT FLAGS. Every fold case asserts the ask COUNT and the exact
 *     cause, so an implementation that reports a condition and drops it from the
 *     list cannot pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  RECOMMENDED_MARKER,
  LEGAL_MOVES,
  LEGAL_MOVE_IDS,
  ASK_CAUSES,
  ASK_SIGNALS,
  SEVERITY,
  RUN_SCOPE_NODE,
  RUNFOLD_UNKNOWN_STATUS,
  DEFAULT_THRESHOLDS,
  ROUNDS_PARK,
  BLOCKING_FENCE_MIN,
  renderQuestion,
  buildEscalationMenu,
  foldAsks,
  contract,
} = require('../scripts/fleet-ask.cjs');

const MODULE_PATH = path.join(__dirname, '..', 'scripts', 'fleet-ask.cjs');
const MODULE_SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

function goodQuestion(extra) {
  return {
    subject: 'pick the execution mode for phase 21',
    recommendation: 'fleet',
    why: 'width 3 with no lane overlap, so 3 nodes can run at once',
    options: [
      { id: 'fleet', label: 'Fleet mode', description: 'run the wave in parallel' },
      { id: 'solo', label: 'Solo mode', description: 'run the wave serially' },
    ],
    ...extra,
  };
}

function emptyBoard() {
  return { completed: [], leases: {}, queue: { tickets: [], held_by: null }, attempts: {} };
}

function emptyRunRecord() {
  return {
    run_id: null,
    workers: [],
    nodes: [],
    demonstrated_width: { value: 0, exact: true, unknown_intervals: 0 },
    rounds_per_artifact: {},
    false_green: { landed: 0, later_failed: 0, unknown: 0 },
  };
}

/** Index of a bracketed option token in the joined render. Bracketed so an id
 * that is a substring of another id cannot produce a false position. */
function tokenIndex(lines, id) {
  return lines.join('\n').indexOf(`[${id}]`);
}

function causesOf(result) {
  return result.asks.map((ask) => ask.cause);
}

/* ------------------------------------------------------------------------ *
 * Task 1: renderQuestion, the accepted path
 * ------------------------------------------------------------------------ */

test('an accepted question puts the pick on line 0 and the reason on line 1', () => {
  const result = renderQuestion(goodQuestion());
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.lines));
  assert.ok(result.lines.length >= 4);
  assert.match(result.lines[0], /^Recommendation: /);
  assert.ok(result.lines[0].includes('[fleet]'));
  assert.ok(result.lines[0].includes(RECOMMENDED_MARKER));
  assert.match(result.lines[1], /^Why: /);
  assert.ok(result.lines[1].includes('width 3 with no lane overlap'));
});

test('ORDERING BY INDEX: the recommendation precedes every other option and the reason', () => {
  const result = renderQuestion(goodQuestion());
  assert.equal(result.ok, true);

  const recommendationAt = tokenIndex(result.lines, 'fleet');
  const otherAt = tokenIndex(result.lines, 'solo');
  const reasonAt = result.lines.join('\n').indexOf('width 3 with no lane overlap');

  // A non zero arm count first: an index of -1 means the token was never
  // rendered, and a comparison against -1 passes for a render that omitted it.
  assert.ok(recommendationAt >= 0, 'the recommendation id must appear in the render');
  assert.ok(otherAt >= 0, 'the other option id must appear in the render');
  assert.ok(reasonAt >= 0, 'the reason must appear in the render');

  assert.ok(
    recommendationAt < otherAt,
    `recommendation at ${recommendationAt} must precede the other option at ${otherAt}`,
  );
  assert.ok(
    recommendationAt < reasonAt,
    `recommendation at ${recommendationAt} must precede the reason at ${reasonAt}`,
  );
});

test('ORDERING HOLDS even when the subject names another option first', () => {
  // This is the arm that justifies rendering the subject LAST. A caller writing
  // "solo or fleet?" as its subject would, with a subject first renderer, put
  // the rejected option ahead of the pick and produce a bare menu.
  const result = renderQuestion(goodQuestion({ subject: 'solo or fleet for this wave' }));
  assert.equal(result.ok, true);

  const recommendationAt = tokenIndex(result.lines, 'fleet');
  const otherAt = tokenIndex(result.lines, 'solo');
  assert.ok(recommendationAt >= 0 && otherAt >= 0);
  assert.ok(recommendationAt < otherAt);
  // and the subject is still carried, not dropped to win the comparison
  assert.ok(result.lines.join('\n').includes('solo or fleet for this wave'));
});

test('the recommended option is the only one carrying the marker', () => {
  const result = renderQuestion(goodQuestion());
  assert.equal(result.ok, true);
  const marked = result.lines.filter((line) => line.includes(RECOMMENDED_MARKER));
  // line 0 and the recommended option row. Exactly 2, never the rejected rows.
  assert.equal(marked.length, 2);
  assert.ok(marked[1].includes('[fleet]'));
  assert.ok(!marked[1].includes('[solo]'));
});

test('the marker is exported as a constant so no call site spells its own', () => {
  assert.equal(RECOMMENDED_MARKER, '(Recommended)');
  assert.equal(contract().marker, RECOMMENDED_MARKER);
});

test('every offered option is rendered, so the render drops nothing', () => {
  const question = goodQuestion();
  question.options.push({ id: 'hybrid', label: 'Hybrid', description: 'wave 1 solo then fleet' });
  const result = renderQuestion(question);
  assert.equal(result.ok, true);
  assert.equal(question.options.length, 3);
  for (const option of question.options) {
    assert.ok(tokenIndex(result.lines, option.id) >= 0, `${option.id} must be rendered`);
  }
});

/* ------------------------------------------------------------------------ *
 * Task 2: LEGAL_MOVES and the escalation menu
 * ------------------------------------------------------------------------ */

test('LEGAL_MOVES has EXACTLY 4 entries, and they are the governance moves', () => {
  assert.equal(LEGAL_MOVES.length, 4);
  assert.deepEqual(LEGAL_MOVE_IDS, ['descope', 'change-approach', 'documented-fence', 'park']);
});

test('LEGAL_MOVES is frozen, entry by entry, so a fifth move cannot be pushed in', () => {
  assert.equal(Object.isFrozen(LEGAL_MOVES), true);
  assert.equal(LEGAL_MOVES.length, 4);
  for (const move of LEGAL_MOVES) {
    assert.equal(Object.isFrozen(move), true);
    assert.ok(move.id.length > 0);
    assert.ok(move.label.length > 0);
    assert.ok(move.description.length > 0);
  }
});

test('the menu goes THROUGH renderQuestion and is accepted by it', () => {
  // The structural property of the whole plan: the menu is recommendation first
  // by construction, because the only renderer refuses anything else.
  const built = buildEscalationMenu({
    ask: { node_id: '21-03', cause: ASK_CAUSES.ROUNDS_EXCEEDED, severity: SEVERITY.HIGH },
    rounds: 2,
    blockingSet: ['21-04'],
  });
  assert.equal(built.ok, true);
  const rendered = renderQuestion(built.question);
  assert.equal(rendered.ok, true, `renderQuestion refused the menu: ${rendered.message}`);
  assert.ok(rendered.lines[0].includes(RECOMMENDED_MARKER));
});

test('the menu offers all 4 legal moves and no others, recommendation first', () => {
  const built = buildEscalationMenu({
    ask: { node_id: '21-03', cause: ASK_CAUSES.FALSE_GREEN, severity: SEVERITY.HIGH },
    rounds: 1,
    blockingSet: [],
  });
  assert.equal(built.ok, true);
  const offered = built.question.options.map((option) => option.id);
  assert.equal(offered.length, 4);
  assert.deepEqual([...offered].sort(), [...LEGAL_MOVE_IDS].sort());
  assert.equal(offered[0], built.question.recommendation);
});

test('THE RANKING TABLE: each of the 6 causes maps to its stated move', () => {
  const expected = [
    [ASK_CAUSES.ROUNDS_EXCEEDED, 'descope'],
    [ASK_CAUSES.FALSE_GREEN, 'change-approach'],
    [ASK_CAUSES.OPEN_INTERVAL, 'park'],
    [ASK_CAUSES.WIDTH_UNKNOWN, 'documented-fence'],
    [ASK_CAUSES.LEASE_RECLAIMED, 'documented-fence'],
    [ASK_CAUSES.STUCK_TRUNK, 'park'],
  ];
  assert.equal(expected.length, 6, 'all 6 causes must be driven, never a subset');
  for (const [cause, move] of expected) {
    const built = buildEscalationMenu({
      ask: { node_id: 'n1', cause, severity: SEVERITY.HIGH },
      rounds: 0,
      blockingSet: [],
    });
    assert.equal(built.ok, true);
    assert.equal(built.question.recommendation, move, `cause ${cause}`);
  }
});

test('PRECEDENCE: the round ratchet forces park and outranks the blocking rule', () => {
  const built = buildEscalationMenu({
    // the table would say descope, and the blocking rule would say fence
    ask: { node_id: 'n1', cause: ASK_CAUSES.ROUNDS_EXCEEDED, severity: SEVERITY.HIGH },
    rounds: ROUNDS_PARK,
    blockingSet: ['a', 'b', 'c', 'd'],
  });
  assert.equal(built.ok, true);
  assert.equal(built.question.recommendation, 'park');
  assert.ok(built.question.why.includes(String(ROUNDS_PARK)));
});

test('PRECEDENCE: a wide blocking set forces a fence and outranks the cause table', () => {
  const built = buildEscalationMenu({
    ask: { node_id: 'n1', cause: ASK_CAUSES.ROUNDS_EXCEEDED, severity: SEVERITY.HIGH },
    rounds: 1,
    blockingSet: new Array(BLOCKING_FENCE_MIN).fill('x'),
  });
  assert.equal(built.ok, true);
  assert.equal(built.question.recommendation, 'documented-fence');
});

test('PRECEDENCE: a low severity ask is fenced rather than descoped or parked', () => {
  const built = buildEscalationMenu({
    ask: { node_id: 'n1', cause: ASK_CAUSES.STUCK_TRUNK, severity: SEVERITY.LOW },
    rounds: 0,
    blockingSet: [],
  });
  assert.equal(built.ok, true);
  assert.equal(built.question.recommendation, 'documented-fence');
});

test('an unrecognised cause is fenced rather than acted on blind', () => {
  const built = buildEscalationMenu({
    ask: { node_id: 'n1', cause: 'something-nobody-declared', severity: SEVERITY.HIGH },
    rounds: 0,
    blockingSet: [],
  });
  assert.equal(built.ok, true);
  assert.equal(built.question.recommendation, 'documented-fence');
});

test('DETERMINISM: separately constructed equal inputs yield an identical menu', () => {
  const first = buildEscalationMenu({
    ask: { node_id: '21-05', cause: ASK_CAUSES.OPEN_INTERVAL, severity: SEVERITY.HIGH },
    rounds: 2,
    blockingSet: ['21-04', '21-03'],
  });
  const second = buildEscalationMenu({
    // built from scratch, different literal objects, and the blocking set is a
    // Set rather than an array, so only the SIZE can be what is being read
    ask: { severity: SEVERITY.HIGH, cause: ASK_CAUSES.OPEN_INTERVAL, node_id: '21-05' },
    blockingSet: new Set(['21-03', '21-04']),
    rounds: 2,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.question.recommendation, second.question.recommendation);
  assert.deepEqual(first.question, second.question);
});

test('THE SELECTION READS NO CLOCK AND NO PROCESS IDENTITY', () => {
  const forbidden = ['Date.now', 'new Date(', 'process.hrtime', 'process.pid', 'Math.random', 'process.env'];
  const detect = (text) => forbidden.filter((token) => text.includes(token));

  // Non zero arms first: an empty token list makes the assertion below vacuous.
  assert.equal(forbidden.length, 6);
  // The detector is PROVEN ABLE TO REPORT before it is believed on the real file.
  assert.deepEqual(detect('const t = Date.now(); const r = Math.random();'), ['Date.now', 'Math.random']);
  assert.deepEqual(detect(MODULE_SOURCE), []);
});

/* ------------------------------------------------------------------------ *
 * Task 3: foldAsks
 * ------------------------------------------------------------------------ */

test('AN EMPTY RUN RECORD REPORTS NO SIGNAL, and that is NOT an all clear', () => {
  const result = foldAsks({ board: emptyBoard(), runRecord: emptyRunRecord() });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 0);
  assert.equal(result.signal, ASK_SIGNALS.NONE);
  // the load bearing half: `none` and `clear` are distinct states
  assert.notEqual(result.signal, ASK_SIGNALS.CLEAR);
  assert.notEqual(ASK_SIGNALS.NONE, ASK_SIGNALS.CLEAR);
});

test('evidence present with nothing wrong reports CLEAR, distinct from NONE', () => {
  const runRecord = emptyRunRecord();
  runRecord.workers = [{ node_id: '21-01', status: 'closed' }];
  runRecord.nodes = [{ node_id: '21-01', attempts: [] }];
  const result = foldAsks({ board: emptyBoard(), runRecord });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 0);
  assert.equal(result.signal, ASK_SIGNALS.CLEAR);
});

test('CAUSE 1: a lease epoch above 1 raises a reclaim ask for that node', () => {
  const board = emptyBoard();
  board.leases['21-04'] = { node_id: '21-04', lease_epoch: 2, state: 'held', worker_id: 'w2' };
  const result = foldAsks({ board, runRecord: emptyRunRecord() });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 1);
  assert.equal(result.asks[0].cause, ASK_CAUSES.LEASE_RECLAIMED);
  assert.equal(result.asks[0].node_id, '21-04');
  assert.equal(result.asks[0].observed, 2);
  assert.equal(result.asks[0].evidence, 'board.leases.21-04.lease_epoch');
  assert.equal(result.signal, ASK_SIGNALS.ASKS);
});

test('CAUSE 1 BOUNDARY: epoch exactly 1 is the first claim and raises nothing', () => {
  const board = emptyBoard();
  board.leases['21-04'] = { node_id: '21-04', lease_epoch: 1, state: 'held', worker_id: 'w1' };
  const result = foldAsks({ board, runRecord: emptyRunRecord() });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 0);
  assert.equal(result.signal, ASK_SIGNALS.CLEAR);
});

test('CAUSE 2: a worker at the fold unknown marker raises an open interval ask', () => {
  const runRecord = emptyRunRecord();
  runRecord.workers = [
    { worker_id: 'w1', node_id: '21-02', status: RUNFOLD_UNKNOWN_STATUS },
    { worker_id: 'w2', node_id: '21-02', status: RUNFOLD_UNKNOWN_STATUS },
    { worker_id: 'w3', node_id: '21-02', status: 'closed' },
  ];
  const result = foldAsks({ board: emptyBoard(), runRecord });
  assert.equal(result.ok, true);
  const open = result.asks.filter((ask) => ask.cause === ASK_CAUSES.OPEN_INTERVAL);
  // 1 ask per node carrying the COUNT, never 1 ask per open interval
  assert.equal(open.length, 1);
  assert.equal(open[0].node_id, '21-02');
  assert.equal(open[0].observed, 2);
  assert.equal(open[0].evidence, 'runRecord.workers[].status');
});

test('CAUSE 3: a width that is not exact raises a width unknown ask', () => {
  const runRecord = emptyRunRecord();
  runRecord.demonstrated_width = { value: 2, exact: false, unknown_intervals: 3 };
  const result = foldAsks({ board: emptyBoard(), runRecord });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 1);
  assert.equal(result.asks[0].cause, ASK_CAUSES.WIDTH_UNKNOWN);
  assert.equal(result.asks[0].node_id, RUN_SCOPE_NODE);
  assert.equal(result.asks[0].severity, SEVERITY.MEDIUM);
  assert.equal(result.asks[0].observed, 3);
});

test('CAUSE 3 SECOND ARM: an absent width claim over real intervals still asks', () => {
  // "exact is not false" is vacuously satisfied by a width field that is not
  // there at all, which is the vacuous truth defect this arm exists to close.
  const runRecord = emptyRunRecord();
  delete runRecord.demonstrated_width;
  runRecord.workers = [{ worker_id: 'w1', node_id: '21-01', status: 'closed' }];
  const result = foldAsks({ board: emptyBoard(), runRecord });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 1);
  assert.equal(result.asks[0].cause, ASK_CAUSES.WIDTH_UNKNOWN);
  assert.equal(result.asks[0].observed, 'absent');
});

test('CAUSE 3 THIRD ARM: an absent width claim over NO evidence stays no signal', () => {
  const runRecord = emptyRunRecord();
  delete runRecord.demonstrated_width;
  const result = foldAsks({ board: emptyBoard(), runRecord });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 0);
  assert.equal(result.signal, ASK_SIGNALS.NONE);
});

test('CAUSE 4: a rounds entry at its threshold raises a rounds ask', () => {
  const runRecord = emptyRunRecord();
  runRecord.rounds_per_artifact = { '21-03': DEFAULT_THRESHOLDS.rounds, '21-04': 1 };
  const result = foldAsks({ board: emptyBoard(), runRecord });
  assert.equal(result.ok, true);
  const rounds = result.asks.filter((ask) => ask.cause === ASK_CAUSES.ROUNDS_EXCEEDED);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].node_id, '21-03');
  assert.equal(rounds[0].observed, DEFAULT_THRESHOLDS.rounds);
  assert.equal(rounds[0].evidence, 'runRecord.rounds_per_artifact.21-03');
});

test('CAUSE 4: the threshold is overridable through the argument', () => {
  const runRecord = emptyRunRecord();
  runRecord.rounds_per_artifact = { '21-03': 2 };
  const strict = foldAsks({ board: emptyBoard(), runRecord, thresholds: { rounds: 2 } });
  const loose = foldAsks({ board: emptyBoard(), runRecord, thresholds: { rounds: 9 } });
  assert.equal(strict.asks.length, 1);
  assert.equal(strict.thresholds.rounds, 2);
  assert.equal(loose.asks.length, 0);
  assert.equal(loose.thresholds.rounds, 9);
  // an override of 1 key leaves the other default in place
  assert.equal(strict.thresholds.leaseEpoch, DEFAULT_THRESHOLDS.leaseEpoch);
});

test('CAUSE 5: a false green later failure count above 0 raises an ask', () => {
  const runRecord = emptyRunRecord();
  runRecord.false_green = { landed: 4, later_failed: 1, unknown: 0 };
  const result = foldAsks({ board: emptyBoard(), runRecord });
  assert.equal(result.ok, true);
  const falseGreen = result.asks.filter((ask) => ask.cause === ASK_CAUSES.FALSE_GREEN);
  assert.equal(falseGreen.length, 1);
  assert.equal(falseGreen[0].observed, 1);
  assert.equal(falseGreen[0].evidence, 'runRecord.false_green.later_failed');
});

test('CAUSE 6: a trunk held on a ticket the board already completed raises an ask', () => {
  const board = emptyBoard();
  board.queue.tickets = [
    { node_id: '21-02', attempt_id: 'a1', ticket: 7, worker_id: 'w1', entered_at: 1, acquired_at: 2, completed_at: 3 },
  ];
  board.queue.held_by = { node_id: '21-02', attempt_id: 'a1', ticket: 7, worker_id: 'w1', acquired_at: 2, state: 'held' };
  const result = foldAsks({ board, runRecord: emptyRunRecord() });
  assert.equal(result.ok, true);
  const stuck = result.asks.filter((ask) => ask.cause === ASK_CAUSES.STUCK_TRUNK);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].node_id, '21-02');
  assert.equal(stuck[0].observed, 'ticket already completed');
  assert.equal(stuck[0].evidence, 'board.queue.held_by');
});

test('CAUSE 6 SECOND ARM: a holder naming a ticket the board does not carry', () => {
  const board = emptyBoard();
  board.queue.held_by = { node_id: '21-02', attempt_id: 'a1', ticket: 99, worker_id: 'w1', state: 'held' };
  const result = foldAsks({ board, runRecord: emptyRunRecord() });
  assert.equal(result.ok, true);
  const stuck = result.asks.filter((ask) => ask.cause === ASK_CAUSES.STUCK_TRUNK);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].observed, 'no matching ticket');
});

test('CAUSE 6 NEGATIVE ARM: a holder on a live uncompleted ticket raises nothing', () => {
  const board = emptyBoard();
  board.queue.tickets = [
    { node_id: '21-02', attempt_id: 'a1', ticket: 7, worker_id: 'w1', entered_at: 1, acquired_at: 2, completed_at: null },
  ];
  board.queue.held_by = { node_id: '21-02', attempt_id: 'a1', ticket: 7, worker_id: 'w1', state: 'held' };
  const result = foldAsks({ board, runRecord: emptyRunRecord() });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 0);
  assert.equal(result.signal, ASK_SIGNALS.CLEAR);
});

test('ALL 6 CAUSES fire together and the list is sorted high severity first', () => {
  const board = emptyBoard();
  board.leases['21-04'] = { node_id: '21-04', lease_epoch: 3, state: 'held' };
  board.queue.held_by = { node_id: '21-02', attempt_id: 'a1', ticket: 99, state: 'held' };
  const runRecord = emptyRunRecord();
  runRecord.workers = [{ worker_id: 'w1', node_id: '21-01', status: RUNFOLD_UNKNOWN_STATUS }];
  runRecord.demonstrated_width = { value: 1, exact: false, unknown_intervals: 1 };
  runRecord.rounds_per_artifact = { '21-03': 5 };
  runRecord.false_green = { landed: 2, later_failed: 2, unknown: 0 };

  const result = foldAsks({ board, runRecord });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 6);
  assert.deepEqual([...causesOf(result)].sort(), [
    ASK_CAUSES.FALSE_GREEN,
    ASK_CAUSES.LEASE_RECLAIMED,
    ASK_CAUSES.OPEN_INTERVAL,
    ASK_CAUSES.ROUNDS_EXCEEDED,
    ASK_CAUSES.STUCK_TRUNK,
    ASK_CAUSES.WIDTH_UNKNOWN,
  ].sort());

  // the medium severity width ask sorts last, behind all 5 high ones
  assert.equal(result.asks[result.asks.length - 1].cause, ASK_CAUSES.WIDTH_UNKNOWN);
  const severities = result.asks.map((ask) => ask.severity);
  assert.equal(severities.filter((s) => s === SEVERITY.HIGH).length, 5);
  assert.equal(severities.filter((s) => s === SEVERITY.MEDIUM).length, 1);
});

test('T-21-04: an ask carries no filesystem path and no command line', () => {
  const board = emptyBoard();
  board.leases['21-04'] = { node_id: '21-04', lease_epoch: 2, state: 'held', worker_id: '/tmp/w' };
  const runRecord = emptyRunRecord();
  runRecord.rounds_per_artifact = { '21-03': 9 };
  const result = foldAsks({ board, runRecord });
  assert.equal(result.ok, true);
  assert.ok(result.asks.length > 0, 'a zero ask list makes this assertion vacuous');
  for (const ask of result.asks) {
    assert.deepEqual(Object.keys(ask).sort(), ['cause', 'evidence', 'node_id', 'observed', 'severity']);
    for (const value of Object.values(ask)) {
      if (typeof value !== 'string') continue;
      assert.ok(!value.includes('/'), `ask field carried a path separator: ${value}`);
      assert.ok(!value.includes('\\'), `ask field carried a path separator: ${value}`);
    }
  }
});

/* ------------------------------------------------------------------------ *
 * The producer is the authority
 * ------------------------------------------------------------------------ */

test('THE PRODUCER IS THE AUTHORITY: the unknown marker matches the shipped fold', () => {
  const runfold = require('../ferrox-core/bin/lib/fleet-runfold.cjs');
  assert.equal(RUNFOLD_UNKNOWN_STATUS, runfold.RUNFOLD_UNKNOWN);
});

test('THE PRODUCER IS THE AUTHORITY: real producer output drives 3 causes', () => {
  const { foldRunRecord } = require('../ferrox-core/bin/lib/fleet-runfold.cjs');
  const { projectBoard } = require('../ferrox-core/bin/lib/fleet-board.cjs');

  // Both producers take the event ARRAY positionally. Passing `{ events }`
  // returns an empty record with no error, which is how a consumer built on a
  // transcribed shape ends up measuring its own assumptions.
  const runId = 'r-21-01';
  const events = [
    { kind: 'run_started', ts: 1, run_id: runId },
    { kind: 'claim_acquired', ts: 2, run_id: runId, node_id: '21-01', worker_id: 'w1', lease_epoch: 2, expires_at_ms: 99 },
    { kind: 'worker_started', ts: 3, run_id: runId, worker_id: 'w1', node_id: '21-01', attempt_id: 'a1', lease_epoch: 2 },
  ];

  const runRecord = foldRunRecord(events);
  const board = projectBoard(events);

  // the producers really did emit the 3 signals, asserted before the fold runs
  assert.equal(runRecord.workers.length, 1);
  assert.equal(runRecord.workers[0].status, RUNFOLD_UNKNOWN_STATUS);
  assert.equal(runRecord.demonstrated_width.exact, false);
  assert.equal(board.leases['21-01'].lease_epoch, 2);

  const result = foldAsks({ board, runRecord });
  assert.equal(result.ok, true);
  assert.equal(result.signal, ASK_SIGNALS.ASKS);
  assert.equal(result.asks.length, 3);
  assert.deepEqual([...causesOf(result)].sort(), [
    ASK_CAUSES.LEASE_RECLAIMED,
    ASK_CAUSES.OPEN_INTERVAL,
    ASK_CAUSES.WIDTH_UNKNOWN,
  ].sort());
});

test('THE PRODUCER IS THE AUTHORITY: an empty real fold reports no signal', () => {
  const { foldRunRecord } = require('../ferrox-core/bin/lib/fleet-runfold.cjs');
  const { projectBoard } = require('../ferrox-core/bin/lib/fleet-board.cjs');
  const result = foldAsks({ board: projectBoard([]), runRecord: foldRunRecord([]) });
  assert.equal(result.ok, true);
  assert.equal(result.asks.length, 0);
  assert.equal(result.signal, ASK_SIGNALS.NONE);
});

/* ------------------------------------------------------------------------ *
 * The end to end shape 3 later plans depend on
 * ------------------------------------------------------------------------ */

test('END TO END: a real ask becomes a menu that the renderer accepts', () => {
  const board = emptyBoard();
  board.leases['21-04'] = { node_id: '21-04', lease_epoch: 4, state: 'held' };
  const folded = foldAsks({ board, runRecord: emptyRunRecord() });
  assert.equal(folded.ok, true);
  assert.equal(folded.asks.length, 1);

  const built = buildEscalationMenu({ ask: folded.asks[0], rounds: 1, blockingSet: [] });
  assert.equal(built.ok, true);

  const rendered = renderQuestion(built.question);
  assert.equal(rendered.ok, true, `renderQuestion refused: ${rendered.message}`);
  const recommendationAt = tokenIndex(rendered.lines, built.question.recommendation);
  assert.ok(recommendationAt >= 0);
  for (const id of LEGAL_MOVE_IDS) {
    if (id === built.question.recommendation) continue;
    const otherAt = tokenIndex(rendered.lines, id);
    assert.ok(otherAt >= 0, `${id} must be offered`);
    assert.ok(recommendationAt < otherAt, `${id} must follow the recommendation`);
  }
});

test('the exported contract names every code, move, cause and signal', () => {
  const shape = contract();
  assert.equal(Object.keys(shape.ask_error_codes).length, 5);
  assert.equal(Object.keys(shape.menu_error_codes).length, 3);
  assert.equal(shape.legal_moves.length, 4);
  assert.equal(Object.keys(shape.ask_causes).length, 6);
  assert.equal(Object.keys(shape.ask_signals).length, 3);
});
