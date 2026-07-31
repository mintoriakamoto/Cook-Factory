'use strict';

/**
 * Phase 21 plan 05 (v1.14 Fleet Mode): the rendering battery for glass,
 * `scripts/fleet-glass.cjs`.
 *
 * WHAT THIS FILE LOCKS, and why each property is here rather than a render
 * smoke test:
 *
 *   - 3 STATES, 3 WORDINGS. An empty panel, a no signal panel and an
 *     unavailable panel are 3 DIFFERENT FACTS. A view with 1 rendering for all
 *     3 tells a human staring at a live run that nothing is wrong when the
 *     truth is that nothing was read. Every pair of those wordings is asserted
 *     DISTINCT here, so collapsing 2 of them turns this file red.
 *   - NON ZERO OUTPUT BEFORE ANY OTHER CLAIM. Every render case asserts the
 *     line count is above 0 before asserting what the lines say. "The render
 *     contains no defect" is vacuously true of a renderer that returned
 *     nothing at all.
 *   - ORDERING BY INDEX, never by presence, matching the assertions plans
 *     21-03 and 21-04 make against the same chokepoint. The recommended move
 *     is proven to come first by COMPARING INDEXES of the bracketed id tokens,
 *     because a presence check passes for a panel that leads with the numbers
 *     and mentions the pick at the bottom.
 *   - THE PRODUCER IS THE AUTHORITY (CONTEXT D10). The round trip case drives
 *     the SHIPPED `projectBoard` and `foldRunRecord` over a synthetic event
 *     array and renders their REAL output, so the views are measured against
 *     what the producers emit rather than against what this file believes they
 *     emit.
 *   - THE POSITIONAL TRAP IS ASSERTED, NOT REMEMBERED. Both producers take the
 *     event array POSITIONALLY, and `fn({ events })` returns a COMPLETELY
 *     EMPTY record with NO ERROR. For a VIEW that is the worst available
 *     failure, because a blank board reads as "nothing wrong" rather than as
 *     "nothing loaded". A dedicated case drives BOTH call shapes and observes
 *     the object wrapped one coming back empty, so the trap is a committed
 *     observation rather than a comment somebody may delete.
 *
 * The read only property is NOT proven here. It is proven by comparing the
 * whole scratch tree in `tests/fleet-glass-readonly.test.cjs`, because a
 * renderer test that asserts the render did not throw passes for a renderer
 * that rewrites a lease (CONTEXT D8 item 4).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const glass = require('../scripts/fleet-glass.cjs');
const ask = require('../scripts/fleet-ask.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GLASS_CLI = path.join(REPO_ROOT, 'scripts', 'fleet-glass.cjs');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

/** Join rendered lines for an index comparison over the whole panel. */
function textOf(lines) {
  assert.ok(Array.isArray(lines), 'a renderer returns an array of lines');
  assert.ok(lines.length > 0, 'NON ZERO output first: an empty render proves nothing');
  return lines.join('\n');
}

/**
 * The index of an option id as the renderer brackets it. Bracketed on purpose:
 * a bare `park` also occurs inside the word `parking` in a reason line, and an
 * index comparison against a substring of a different word measures nothing.
 */
function idIndex(text, id) {
  return text.indexOf(`[${id}]`);
}

function runCli(args, env) {
  return spawnSync(process.execPath, [GLASS_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}) },
  });
}

function graphDocument(extra) {
  return {
    schema: 'workgraph/v1',
    phase: '21',
    nodes: [
      {
        id: '21-01', kind: 'seam', wave: 1, task_count: 3,
        write_lane: ['scripts/fleet-ask.cjs', 'tests/fleet-ask.test.cjs'],
      },
      {
        id: '21-05', kind: 'leaf', wave: 2, task_count: 3,
        write_lane: ['scripts/fleet-glass.cjs'],
      },
    ],
    edges: [],
    seam_violations: [],
    seam_gaps: [],
    warnings: [],
    ...(extra ?? {}),
  };
}

function heldLease(nodeId, epoch, state) {
  return {
    node_id: nodeId,
    worker_id: `worker-${nodeId}`,
    lease_epoch: epoch,
    state,
    acquired_at_ms: 1000,
    renewed_at_ms: 2000,
    expires_at_ms: 9000,
    holder: { pid: 4242, host: 'h1', boot_id: 'b1' },
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

/* ------------------------------------------------------------------------ *
 * 1. The graph view
 * ------------------------------------------------------------------------ */

test('the graph view groups nodes by wave and shows id, kind, task count and lane size', () => {
  const lines = glass.renderGraphView(graphDocument());
  const text = textOf(lines);

  assert.match(text, /Wave 1/, 'wave 1 is named');
  assert.match(text, /Wave 2/, 'wave 2 is named');
  assert.match(text, /21-01/, 'the first node id is rendered');
  assert.match(text, /21-05/, 'the second node id is rendered');
  assert.match(text, /seam/, 'the node kind is rendered');
  assert.match(text, /3 tasks/, 'the task count is rendered');
  assert.match(text, /2 files/, 'the write lane SIZE is rendered for the 2 file node');
  assert.match(text, /1 file\b/, 'the write lane size is singular for the 1 file node');
  // Wave 1 must be rendered before wave 2. A view that groups by wave and then
  // prints the groups in map order is not grouping by wave.
  assert.ok(text.indexOf('Wave 1') < text.indexOf('Wave 2'), 'waves render in order');
});

test('every declared edge renders with its verdict and its evidence lines', () => {
  const document = graphDocument({
    edges: [{
      from: '21-05', to: '21-01', declared: true, verdict: 'backed',
      backing: ['scripts/fleet-glass.cjs'],
      evidence: ['scripts/fleet-glass.cjs requires scripts/fleet-ask.cjs'],
    }],
  });
  const text = textOf(glass.renderGraphView(document));

  assert.match(text, /21-05/, 'the edge source is named');
  assert.match(text, /21-01/, 'the edge target is named');
  assert.ok(
    text.includes('scripts/fleet-glass.cjs requires scripts/fleet-ask.cjs'),
    'the evidence line reaches the panel verbatim',
  );
});

test('the 3 verdicts render with 3 DISTINCT wordings', () => {
  const wordings = glass.VERDICT_WORDING;
  const values = [wordings.backed, wordings.unbacked, wordings.unproven];
  for (const value of values) {
    assert.equal(typeof value, 'string');
    assert.ok(value.length > 0, 'NON ZERO wording');
  }
  assert.equal(new Set(values).size, 3, '3 verdicts, 3 wordings, no collapse');

  // The verdict names are read from the SHIPPED validator rather than copied,
  // so a producer that renames one turns this red instead of rendering blank.
  const lib = require(path.join(LIB_DIR, 'workgraph.cjs'));
  assert.deepEqual(
    [...lib.VERDICTS].sort(),
    Object.keys(wordings).sort(),
    'glass words exactly the verdicts the shipped validator accepts',
  );
});

test('an unproven edge is worded as the instrument REACH, never as a defect', () => {
  const document = graphDocument({
    edges: [{
      from: '21-05', to: '21-01', declared: true, verdict: 'unproven',
      backing: [], evidence: [], unproven_reason: 'out-of-scan-scope',
    }],
  });
  const text = textOf(glass.renderGraphView(document));

  assert.match(text, /out-of-scan-scope/, 'the unproven reason is carried through');
  assert.ok(
    /reach/i.test(glass.VERDICT_WORDING.unproven),
    'the unproven wording names the instrument REACH',
  );
  // The defect vocabulary must not appear on an unproven edge. This phase's own
  // 3 declared edges are all unproven, so a view that words unproven as broken
  // would report every edge in its own phase as broken.
  for (const defectWord of ['broken', 'defect in the edge', 'invalid', 'failed']) {
    assert.ok(
      !glass.VERDICT_WORDING.unproven.toLowerCase().includes(defectWord),
      `unproven is not worded with "${defectWord}"`,
    );
  }
});

test('an unbacked edge renders as a finding about the PLANNER', () => {
  const document = graphDocument({
    edges: [{
      from: '21-05', to: '21-01', declared: true, verdict: 'unbacked',
      backing: [], evidence: [],
    }],
  });
  const text = textOf(glass.renderGraphView(document));
  assert.match(text, /planner/i, 'unbacked is a finding about the planner');
  assert.ok(
    glass.VERDICT_WORDING.unbacked !== glass.VERDICT_WORDING.unproven,
    'unbacked and unproven are different claims and read differently',
  );
});

test('a document with 0 nodes renders an EXPLICIT empty panel naming the phase', () => {
  const text = textOf(glass.renderGraphView(graphDocument({ nodes: [], phase: '77' })));
  assert.match(text, /77/, 'the empty panel names the phase it is empty for');
  assert.match(text, /0 nodes/, 'the empty panel states the count it found');
  assert.ok(
    text.includes(glass.PANEL_WORDING.EMPTY_GRAPH),
    'the empty panel carries the empty wording',
  );
  assert.ok(
    !text.includes(glass.PANEL_WORDING.UNAVAILABLE),
    'an EMPTY graph is not an UNAVAILABLE one and must not borrow its wording',
  );
});

test('a malformed document renders the unavailable panel, distinct from the empty one', () => {
  for (const bad of [null, undefined, 'a string', 42, [], { nodes: 'not an array' }]) {
    const text = textOf(glass.renderGraphView(bad));
    assert.ok(
      text.includes(glass.PANEL_WORDING.UNAVAILABLE),
      `a ${JSON.stringify(bad)} document is UNAVAILABLE, never empty`,
    );
    assert.ok(
      !text.includes(glass.PANEL_WORDING.EMPTY_GRAPH),
      'a malformed document must not borrow the empty wording',
    );
  }
});

test('renderGraphView is PURE: 2 calls over the same document are identical', () => {
  const document = graphDocument({
    edges: [{
      from: '21-05', to: '21-01', declared: true, verdict: 'unproven',
      backing: [], evidence: [], unproven_reason: 'out-of-scan-scope',
    }],
  });
  const first = glass.renderGraphView(document);
  const second = glass.renderGraphView(document);
  assert.ok(first.length > 0, 'NON ZERO output before the equality claim');
  assert.deepEqual(first, second, 'no clock and no file, so 2 runs agree');
  // And the input is not mutated.
  assert.equal(document.nodes.length, 2, 'the renderer did not touch its argument');
});

/* ------------------------------------------------------------------------ *
 * 2. loadGraph and the unavailable path
 * ------------------------------------------------------------------------ */

test('loadGraph refuses with E_GLASS_UNAVAILABLE and NAMES the module when the lib will not load', () => {
  const result = glass.loadGraph({
    root: REPO_ROOT,
    phase: '21',
    load: () => { throw new Error('cannot find module workgraph-scan.cjs'); },
  });
  assert.equal(result.ok, false, 'a refused load is not ok');
  assert.equal(result.code, glass.GLASS_ERROR_CODES.UNAVAILABLE);
  assert.ok(typeof result.missing === 'string' && result.missing.length > 0,
    'the missing field NAMES what could not be reached');
  assert.match(result.missing, /workgraph-scan/, 'it names the module by name');
});

test('loadGraph carries the SCAN LIBRARY OWN refusal message rather than paraphrasing it', () => {
  const refusal = 'phase 99 has no phase directory, so there is no graph to emit (Phase not found).\n'
    + 'Fix: name a phase that exists, which you can list with:\n'
    + '  node ferrox-core/bin/ferrox-tools.cjs phase list';
  const result = glass.loadGraph({
    root: REPO_ROOT,
    phase: '99',
    load: () => ({ buildWorkgraph: () => ({ ok: false, message: refusal, document: {} }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, glass.GLASS_ERROR_CODES.UNAVAILABLE);
  assert.ok(
    result.missing.includes('Fix: name a phase that exists'),
    'the library refusal reaches the panel INTACT, because it already names the fix and the command',
  );
});

test('loadGraph over the REAL scan lib returns the real phase 21 document', () => {
  const result = glass.loadGraph({ root: REPO_ROOT, phase: '21' });
  assert.equal(result.ok, true, 'the shipped scan lib loads and builds');
  assert.ok(
    Array.isArray(result.document.nodes) && result.document.nodes.length > 0,
    'NON ZERO node count: an empty document here would mean the loader is wired wrong',
  );
});

test('the CLI names a missing phase as unavailable in a REAL child process', () => {
  const run = runCli(['graph', '99']);
  const out = `${run.stdout}${run.stderr}`;
  assert.ok(out.length > 0, 'NON ZERO output from the child process');
  assert.ok(
    out.includes(glass.PANEL_WORDING.UNAVAILABLE),
    'a phase with no directory reaches the human as a NAMED unavailable panel',
  );
  assert.match(out, /no phase directory/, 'the scan library message survives the CLI seam');
});

test('the CLI renders the REAL phase 19 graph with a non zero node count', () => {
  const run = runCli(['graph', '19']);
  assert.equal(run.status, 0, `the real graph render exits 0: ${run.stderr}`);
  assert.ok(run.stdout.includes('19-01'), 'a real node id reaches stdout');
  assert.ok(
    !run.stdout.includes(glass.PANEL_WORDING.UNAVAILABLE),
    'a phase that exists is not rendered as unavailable',
  );
});

/* ------------------------------------------------------------------------ *
 * 3. The lease view
 * ------------------------------------------------------------------------ */

test('the lease view renders state, epoch, holder and both instants for every node', () => {
  const board = emptyBoard();
  board.leases['21-01'] = heldLease('21-01', 1, 'held');
  const text = textOf(glass.renderLeaseView(board));

  assert.match(text, /21-01/, 'the node id renders');
  assert.match(text, /held/, 'the lease state renders');
  assert.match(text, /epoch 1/, 'the epoch renders');
  assert.match(text, /worker-21-01/, 'the holder renders');
  assert.match(text, /1000/, 'the acquisition instant renders');
  assert.match(text, /2000/, 'the renewal instant renders');
});

test('an epoch above 1 renders its epoch AND says the lease was taken from a previous holder', () => {
  const board = emptyBoard();
  board.leases['21-02'] = heldLease('21-02', 3, 'held');
  const text = textOf(glass.renderLeaseView(board));

  assert.match(text, /epoch 3/, 'the advanced epoch is VISIBLE');
  assert.ok(
    text.includes(glass.PANEL_WORDING.EPOCH_ADVANCED),
    'an advanced epoch is the difference between a renewal and a reclaim after a crash, '
      + 'and that distinction is the whole reason the epoch exists',
  );

  // The epoch 1 case must NOT carry the advanced wording, or the marker means nothing.
  const first = emptyBoard();
  first.leases['21-01'] = heldLease('21-01', 1, 'held');
  const firstText = textOf(glass.renderLeaseView(first));
  assert.ok(
    !firstText.includes(glass.PANEL_WORDING.EPOCH_ADVANCED),
    'a first claim is NOT a reclaim, so the marker must not fire on epoch 1',
  );
});

test('the lease view renders the states the SHIPPED board produces', () => {
  const boardLib = require(path.join(LIB_DIR, 'fleet-board.cjs'));
  const board = emptyBoard();
  let n = 0;
  for (const state of Object.values(boardLib.LEASE_STATES)) {
    n += 1;
    board.leases[`21-0${n}`] = heldLease(`21-0${n}`, n, state);
  }
  assert.ok(n > 0, 'NON ZERO states read from the producer');
  const text = textOf(glass.renderLeaseView(board));
  for (const state of Object.values(boardLib.LEASE_STATES)) {
    assert.ok(text.includes(state), `the shipped state ${state} reaches the panel`);
  }
});

test('the trunk holder and the queue tickets render as their OWN panel', () => {
  const board = emptyBoard();
  board.queue.held_by = {
    node_id: '21-02', attempt_id: 'a2', ticket: 7, worker_id: 'w2',
    acquired_at: 5000, state: 'held', expires_at_ms: 9000,
  };
  board.queue.tickets = [
    { node_id: '21-02', attempt_id: 'a2', ticket: 7, worker_id: 'w2', entered_at: 4000, acquired_at: 5000, completed_at: null },
    { node_id: '21-03', attempt_id: 'a3', ticket: 8, worker_id: null, entered_at: 4500, acquired_at: null, completed_at: null },
  ];
  const text = textOf(glass.renderLeaseView(board));

  assert.ok(text.includes(glass.PANEL_WORDING.TRUNK), 'the trunk gets its own named panel');
  assert.match(text, /ticket 7/, 'the held ticket renders');
  assert.match(text, /ticket 8/, 'the waiting ticket renders');
  assert.ok(
    text.indexOf(glass.PANEL_WORDING.TRUNK) > text.indexOf('21-01') || !text.includes('21-01'),
    'the trunk panel is separate from the lease rows',
  );
});

test('an EMPTY board and an UNAVAILABLE board render 2 DIFFERENT panels', () => {
  const emptyText = textOf(glass.renderLeaseView(emptyBoard()));
  const unavailableText = textOf(glass.renderLeaseView(null));

  assert.ok(emptyText.includes(glass.PANEL_WORDING.EMPTY_LEASES),
    'an empty projection says it is empty');
  assert.ok(unavailableText.includes(glass.PANEL_WORDING.UNAVAILABLE),
    'an absent projection says it could not be read');
  assert.notEqual(emptyText, unavailableText,
    '1 rendering for 2 different facts is the vacuous payload failure CONTEXT D8 item 6 names');
  assert.ok(!emptyText.includes(glass.PANEL_WORDING.UNAVAILABLE),
    'the empty panel must not borrow the unavailable wording');
});

test('an instant renders as BOTH raw milliseconds and a readable form, and an absent one is UNKNOWN never 0', () => {
  const board = emptyBoard();
  board.leases['21-01'] = heldLease('21-01', 1, 'held');
  board.leases['21-01'].acquired_at_ms = 1785024002000;
  const text = textOf(glass.renderLeaseView(board));

  assert.match(text, /1785024002000/, 'the RAW instant is kept, so the panel is checkable against the log');
  assert.match(text, /2026-07-26T00:00:02\.000Z/, 'and a readable form is rendered beside it');

  // An absent instant is UNKNOWN and NEVER 0. 0 is a real instant, so
  // rendering an absent reading as 0 states a measurement that was not taken.
  const absent = emptyBoard();
  absent.leases['21-02'] = heldLease('21-02', 1, 'held');
  absent.leases['21-02'].acquired_at_ms = null;
  absent.leases['21-02'].expires_at_ms = null;
  const absentText = textOf(glass.renderLeaseView(absent));
  assert.match(absentText, /acquired {2}unknown/, 'an absent instant reads UNKNOWN');
  assert.ok(!/acquired {2}0\b/.test(absentText), 'and it is NEVER rendered as 0');

  // A real 0 is still rendered as 0, or "never 0" would be hiding a reading.
  const zero = emptyBoard();
  zero.leases['21-03'] = heldLease('21-03', 1, 'held');
  zero.leases['21-03'].acquired_at_ms = 0;
  const zeroText = textOf(glass.renderLeaseView(zero));
  assert.match(zeroText, /acquired {2}0 \(1970-01-01T00:00:00\.000Z\)/,
    'a genuine 0 instant is rendered as 0, because it is a real reading');
});

test('the instant renderer reads NO clock: 2 renders separated in time are identical', () => {
  const board = emptyBoard();
  board.leases['21-01'] = heldLease('21-01', 1, 'held');
  const first = glass.renderLeaseView(board);
  const second = glass.renderLeaseView(board);
  assert.ok(first.length > 0, 'NON ZERO output before the equality claim');
  assert.deepEqual(first, second, 'formatting a given number is pure');
});

test('renderLeaseView is PURE and does not mutate its argument', () => {
  const board = emptyBoard();
  board.leases['21-01'] = heldLease('21-01', 2, 'held');
  const before = JSON.stringify(board);
  const first = glass.renderLeaseView(board);
  const second = glass.renderLeaseView(board);
  assert.ok(first.length > 0, 'NON ZERO output before the equality claim');
  assert.deepEqual(first, second, '2 runs over equal input agree');
  assert.equal(JSON.stringify(board), before, 'the board is untouched');
});

/* ------------------------------------------------------------------------ *
 * 4. The ask view, through the phase chokepoint
 * ------------------------------------------------------------------------ */

test('every ask LEADS WITH its recommended move, asserted by INDEX comparison', () => {
  const board = emptyBoard();
  board.leases['21-02'] = heldLease('21-02', 3, 'held');
  const text = textOf(glass.renderAskView({ board, runRecord: emptyRunRecord() }));

  assert.ok(text.includes(ask.RECOMMENDED_MARKER), 'the recommended marker reaches the panel');

  // The recommended id must appear STRICTLY BEFORE every other legal move id.
  const recommended = 'documented-fence';
  const recommendedAt = idIndex(text, recommended);
  assert.ok(recommendedAt >= 0, `the recommended id ${recommended} is rendered`);
  for (const moveId of ask.LEGAL_MOVE_IDS) {
    if (moveId === recommended) continue;
    const otherAt = idIndex(text, moveId);
    assert.ok(otherAt >= 0, `the alternative ${moveId} is offered`);
    assert.ok(
      recommendedAt < otherAt,
      `the recommendation [${recommended}] at ${recommendedAt} comes before [${moveId}] at ${otherAt}`,
    );
  }
});

test('the ask view formats NO question of its own: it renders the chokepoint output verbatim', () => {
  const board = emptyBoard();
  board.leases['21-02'] = heldLease('21-02', 3, 'held');
  const lines = glass.renderAskView({ board, runRecord: emptyRunRecord() });
  const text = textOf(lines);

  const folded = ask.foldAsks({ board, runRecord: emptyRunRecord() });
  assert.equal(folded.ok, true);
  assert.ok(folded.asks.length > 0, 'NON ZERO asks before comparing renders');

  const menu = ask.buildEscalationMenu({ ask: folded.asks[0], rounds: 0, blockingSet: folded.asks });
  assert.equal(menu.ok, true);
  const rendered = ask.renderQuestion(menu.question);
  assert.equal(rendered.ok, true);
  assert.ok(rendered.lines.length > 0, 'NON ZERO chokepoint output');

  for (const line of rendered.lines) {
    assert.ok(
      text.includes(line.trim()),
      `the chokepoint line reaches the panel unreformatted: ${JSON.stringify(line.trim())}`,
    );
  }
});

test('the ask view renders SEVERAL severities and puts the worst first', () => {
  const board = emptyBoard();
  board.leases['21-02'] = heldLease('21-02', 3, 'held');
  const runRecord = emptyRunRecord();
  runRecord.workers = [{ worker_id: 'w1', node_id: '21-04', attempt_id: 'a1', status: 'UNKNOWN', started_at: 1 }];
  runRecord.demonstrated_width = { value: 2, exact: false, unknown_intervals: 1 };

  const folded = ask.foldAsks({ board, runRecord });
  assert.ok(folded.asks.length >= 3, 'NON ZERO and several asks in the fixture');
  const severities = new Set(folded.asks.map((a) => a.severity));
  assert.ok(severities.size > 1, 'the fixture really does carry several severities');

  const text = textOf(glass.renderAskView({ board, runRecord }));
  assert.ok(
    text.indexOf('high') < text.indexOf('medium'),
    'the worst severity is rendered first, matching the fold order',
  );
});

test('NO SIGNAL, NO OPEN ASKS and UNAVAILABLE are 3 DIFFERENT panels', () => {
  // No signal: a run record with nothing in it. The fold had nothing to read.
  const noSignal = textOf(glass.renderAskView({ board: emptyBoard(), runRecord: emptyRunRecord() }));

  // No open asks: real evidence present and no condition raised.
  const clearBoard = emptyBoard();
  clearBoard.leases['21-01'] = heldLease('21-01', 1, 'held');
  const clearRecord = emptyRunRecord();
  clearRecord.nodes = [{ node_id: '21-01', attempts: [] }];
  const clearFold = ask.foldAsks({ board: clearBoard, runRecord: clearRecord });
  assert.equal(clearFold.signal, ask.ASK_SIGNALS.CLEAR, 'the fixture really is a CLEAR fold');
  const clear = textOf(glass.renderAskView({ board: clearBoard, runRecord: clearRecord }));

  // Unavailable: an absent input.
  const unavailable = textOf(glass.renderAskView({ board: null, runRecord: null }));

  assert.ok(noSignal.includes(glass.PANEL_WORDING.NO_SIGNAL), 'the no signal panel is named');
  assert.ok(clear.includes(glass.PANEL_WORDING.NO_OPEN_ASKS), 'the no open asks panel is named');
  assert.ok(unavailable.includes(glass.PANEL_WORDING.UNAVAILABLE), 'the unavailable panel is named');

  const all = [noSignal, clear, unavailable];
  assert.equal(new Set(all).size, 3, '3 different facts, 3 different panels');
  assert.ok(!noSignal.includes(glass.PANEL_WORDING.NO_OPEN_ASKS),
    'an empty ask list is NOT an all clear');
  assert.ok(!clear.includes(glass.PANEL_WORDING.NO_SIGNAL),
    'an all clear is NOT a fold with nothing to read');
});

test('a chokepoint REFUSAL renders as a refusal, never as a silently dropped ask', () => {
  const board = emptyBoard();
  board.leases['21-02'] = heldLease('21-02', 3, 'held');
  const text = textOf(glass.renderAskView({
    board,
    runRecord: emptyRunRecord(),
    // A renderer seam that always refuses. The panel must SAY it was refused.
    render: () => ({ ok: false, code: 'E_ASK_NO_RECOMMENDATION', message: 'no pick' }),
  }));
  assert.ok(text.includes(glass.PANEL_WORDING.QUESTION_REFUSED),
    'a refused question is reported as a refusal');
  assert.match(text, /E_ASK_NO_RECOMMENDATION/, 'the refusal code reaches the human');
  assert.match(text, /21-02/, 'the ask it refused about is still named');
});

test('renderAskView is PURE and does not mutate its arguments', () => {
  const board = emptyBoard();
  board.leases['21-02'] = heldLease('21-02', 3, 'held');
  const runRecord = emptyRunRecord();
  const boardBefore = JSON.stringify(board);
  const recordBefore = JSON.stringify(runRecord);
  const first = glass.renderAskView({ board, runRecord });
  const second = glass.renderAskView({ board, runRecord });
  assert.ok(first.length > 0, 'NON ZERO output before the equality claim');
  assert.deepEqual(first, second, '2 runs over equal input agree');
  assert.equal(JSON.stringify(board), boardBefore, 'the board is untouched');
  assert.equal(JSON.stringify(runRecord), recordBefore, 'the run record is untouched');
});

/* ------------------------------------------------------------------------ *
 * 5. The producers are the authority, and the POSITIONAL trap
 * ------------------------------------------------------------------------ */

test('the views render what the SHIPPED producers actually emit, over a real event array', () => {
  const boardLib = require(path.join(LIB_DIR, 'fleet-board.cjs'));
  const foldLib = require(path.join(LIB_DIR, 'fleet-runfold.cjs'));

  const events = [
    { kind: 'run_started', ts: '2026-07-26T00:00:00.000Z', run_id: 'r1', graph_generation: 1 },
    { kind: 'worker_started', ts: '2026-07-26T00:00:01.000Z', run_id: 'r1', worker_id: 'w1', node_id: '21-01', attempt_id: 'a1' },
    { kind: 'claim_acquired', ts: '2026-07-26T00:00:02.000Z', run_id: 'r1', worker_id: 'w1', node_id: '21-01', attempt_id: 'a1', lease_epoch: 1, expires_at_ms: 99999 },
    { kind: 'lease_reclaimed', ts: '2026-07-26T00:00:30.000Z', run_id: 'r1', worker_id: 'w2', node_id: '21-01', attempt_id: 'a2', lease_epoch: 2, expires_at_ms: 99999 },
    { kind: 'queue_entered', ts: '2026-07-26T00:00:40.000Z', run_id: 'r1', worker_id: 'w2', node_id: '21-01', attempt_id: 'a2', ticket: 1 },
    { kind: 'queue_acquired', ts: '2026-07-26T00:00:41.000Z', run_id: 'r1', worker_id: 'w2', node_id: '21-01', attempt_id: 'a2', ticket: 1, expires_at_ms: 99999 },
  ];

  // POSITIONAL. Both producers take the array as their FIRST ARGUMENT.
  const board = boardLib.projectBoard(events);
  const runRecord = foldLib.foldRunRecord(events);

  assert.ok(Object.keys(board.leases).length > 0, 'NON ZERO leases from the real producer');
  assert.ok(runRecord.workers.length > 0, 'NON ZERO workers from the real producer');

  const leaseText = textOf(glass.renderLeaseView(board));
  assert.match(leaseText, /21-01/, 'the real node id renders');
  assert.match(leaseText, /epoch 2/, 'the real reclaimed epoch renders');
  assert.ok(leaseText.includes(glass.PANEL_WORDING.EPOCH_ADVANCED),
    'the real reclaim is marked as a reclaim');

  const askText = textOf(glass.renderAskView({ board, runRecord }));
  assert.ok(askText.includes(ask.RECOMMENDED_MARKER),
    'the real fold produces a real ask that leads with a recommendation');
});

test('THE POSITIONAL TRAP: the object wrapped call is OBSERVED returning an empty record', () => {
  const boardLib = require(path.join(LIB_DIR, 'fleet-board.cjs'));
  const foldLib = require(path.join(LIB_DIR, 'fleet-runfold.cjs'));
  const events = [
    { kind: 'claim_acquired', ts: '2026-07-26T00:00:02.000Z', run_id: 'r1', worker_id: 'w1', node_id: '21-01', attempt_id: 'a1', lease_epoch: 1, expires_at_ms: 99999 },
  ];

  // The RIGHT call. NON ZERO first, so the wrong call below is measured against
  // a known good reading rather than against another empty one.
  const rightBoard = boardLib.projectBoard(events);
  assert.ok(Object.keys(rightBoard.leases).length > 0, 'the positional call reads the events');

  // The WRONG call, and it does NOT throw. It returns a completely empty record.
  const wrongBoard = boardLib.projectBoard({ events });
  assert.equal(Object.keys(wrongBoard.leases).length, 0,
    'the object wrapped call silently returns 0 leases, which is why glass must never make it');
  const wrongRecord = foldLib.foldRunRecord({ events });
  assert.equal(wrongRecord.workers.length, 0,
    'the object wrapped fold silently returns 0 workers');

  // And this is why it matters for a VIEW specifically: the empty result renders
  // as a clean panel with no error anywhere in it. A blank board would read as
  // "nothing wrong" rather than as "nothing loaded".
  const wrongText = textOf(glass.renderLeaseView(wrongBoard));
  assert.ok(wrongText.includes(glass.PANEL_WORDING.EMPTY_LEASES),
    'the mis-driven projection renders as EMPTY, which is exactly the masquerade');
  assert.ok(!wrongText.includes(glass.PANEL_WORDING.UNAVAILABLE),
    'and it does NOT render as unavailable, because the projection really did load');
});

/* ------------------------------------------------------------------------ *
 * 6. The CLI seam degrades to a NAMED unavailable
 * ------------------------------------------------------------------------ */

test('the CLI names the MISSING RUN LOG PATH rather than rendering an empty board', () => {
  const scratch = path.join(REPO_ROOT, 'tests', '__glass_no_such_root__');
  for (const verb of ['leases', 'asks']) {
    const run = runCli([verb], { FERROX_GLASS_ROOT: scratch });
    const out = `${run.stdout}${run.stderr}`;
    assert.ok(out.length > 0, `NON ZERO output for ${verb}`);
    assert.ok(out.includes(glass.PANEL_WORDING.UNAVAILABLE),
      `${verb} over an absent run log is UNAVAILABLE, never empty`);
    assert.match(out, /fleet-runlog\.jsonl/,
      'the unavailable panel NAMES the path it could not read');
    assert.ok(!out.includes(glass.PANEL_WORDING.EMPTY_LEASES),
      'an absent log is not an empty board');
  }
});

test('the CLI refuses an unknown verb and names the 4 views', () => {
  const run = runCli(['sideways']);
  const out = `${run.stdout}${run.stderr}`;
  assert.notEqual(run.status, 0, 'an unknown verb exits non zero');
  for (const verb of ['graph', 'leases', 'asks', 'watch']) {
    assert.ok(out.includes(verb), `the usage names the ${verb} view`);
  }
  // The COUNT in the refusal is a fact about this CLI, so it is asserted rather
  // than left to drift the way it did when the watch view was added.
  assert.match(out, /has 4 views/, 'the refusal counts the views correctly');
});
