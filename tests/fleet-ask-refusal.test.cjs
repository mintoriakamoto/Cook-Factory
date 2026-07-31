'use strict';

/**
 * Phase 21 plan 01 (v1.14 Fleet Mode): the FIRING battery for the question
 * layer, `scripts/fleet-ask.cjs`.
 *
 * Every refusal here is driven against a case that CONTAINS the defect the
 * refusal detects, so each one is observed firing rather than assumed. The
 * defect class this project ships at every phase is a guard that cannot fire,
 * and a battery of refusals nobody ever triggered is exactly that guard.
 *
 * 3 rules this file follows and states, because they are the difference
 * between a real firing battery and a decorative one:
 *
 *   1. ASSERT THE COUNTER, NOT THE FLAG. Every refusal case asserts the exact
 *      code AND asserts the payload is ABSENT (`lines` for a render, `question`
 *      for a menu). A flag assertion alone passes for an implementation that
 *      reports a refusal and renders the thing anyway, which is the failure mode
 *      that matters: a bare menu that also printed an error nobody read.
 *   2. A NON ZERO ARM COUNT FIRST. Every table driven loop asserts its own case
 *      count before it iterates. "Every arm passed" is vacuously true of 0 arms.
 *   3. A TEST THAT IMPORTS CANNOT SEE WHAT `main` DOES. The CLI arms spawn the
 *      script as a real CHILD PROCESS and read its exit code and its streams.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  RECOMMENDED_MARKER,
  ASK_ERROR_CODES,
  MENU_ERROR_CODES,
  LEGAL_MOVE_IDS,
  ASK_CAUSES,
  SEVERITY,
  RUNFOLD_UNKNOWN_STATUS,
  renderQuestion,
  buildEscalationMenu,
  foldAsks,
} = require('../scripts/fleet-ask.cjs');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'fleet-ask.cjs');

const OPTIONS = [
  { id: 'fleet', label: 'Fleet mode' },
  { id: 'solo', label: 'Solo mode' },
];

/** Assert a refusal fired with the expected code AND rendered nothing. */
function assertRefused(result, code, label) {
  assert.equal(result.ok, false, `${label}: expected a refusal`);
  assert.equal(result.code, code, `${label}: wrong refusal code`);
  assert.equal(result.lines, undefined, `${label}: REFUSED and rendered anyway`);
  assert.equal(result.question, undefined, `${label}: REFUSED and built a menu anyway`);
  assert.ok(
    typeof result.message === 'string' && result.message.length > 0,
    `${label}: a refusal with no message tells the caller nothing`,
  );
}

/* ------------------------------------------------------------------------ *
 * Refusal 1: E_ASK_NO_RECOMMENDATION
 * ------------------------------------------------------------------------ */

test('REFUSAL 1 FIRES: a question with no usable recommendation is refused', () => {
  const cases = [
    ['recommendation absent', { why: 'a reason', options: OPTIONS }],
    ['recommendation null', { recommendation: null, why: 'a reason', options: OPTIONS }],
    ['recommendation empty', { recommendation: '', why: 'a reason', options: OPTIONS }],
    ['recommendation whitespace only', { recommendation: '   ', why: 'a reason', options: OPTIONS }],
    ['recommendation not a string', { recommendation: 7, why: 'a reason', options: OPTIONS }],
    ['a pick with NO REASON', { recommendation: 'fleet', options: OPTIONS }],
    ['a pick whose reason is whitespace', { recommendation: 'fleet', why: '  ', options: OPTIONS }],
  ];
  assert.equal(cases.length, 7, 'the arm count must be non zero and known');

  for (const [label, question] of cases) {
    assertRefused(renderQuestion(question), ASK_ERROR_CODES.NO_RECOMMENDATION, label);
  }
});

test('REFUSAL 1 FIRES: a non object argument never throws and is refused', () => {
  const cases = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'fleet'],
    ['a number', 3],
    ['an array', [{ id: 'fleet' }]],
  ];
  assert.equal(cases.length, 5);

  for (const [label, input] of cases) {
    let result;
    assert.doesNotThrow(() => { result = renderQuestion(input); }, `${label}: must never throw`);
    assertRefused(result, ASK_ERROR_CODES.NO_RECOMMENDATION, label);
  }
});

/* ------------------------------------------------------------------------ *
 * Refusal 2: E_ASK_RECOMMENDATION_NOT_OFFERED
 * ------------------------------------------------------------------------ */

test('REFUSAL 2 FIRES: a recommendation that is not among the offered options', () => {
  const result = renderQuestion({
    subject: 'pick the mode',
    recommendation: 'hybrid',
    why: 'it is the middle path',
    options: OPTIONS,
  });
  assertRefused(result, ASK_ERROR_CODES.RECOMMENDATION_NOT_OFFERED, 'recommendation not offered');
  assert.ok(result.message.includes('hybrid'), 'the refusal must name the offending recommendation');
});

test('REFUSAL 2 FIRES: an ABSENT or EMPTY option list is not vacuously satisfying', () => {
  // "the recommendation is among the options" is trivially true of a list that
  // is not there at all. These 3 arms close that vacuous truth.
  const cases = [
    ['options absent', { recommendation: 'fleet', why: 'r' }],
    ['options empty', { recommendation: 'fleet', why: 'r', options: [] }],
    ['options not an array', { recommendation: 'fleet', why: 'r', options: { id: 'fleet' } }],
    ['options carry no ids', { recommendation: 'fleet', why: 'r', options: [{ label: 'Fleet' }] }],
  ];
  assert.equal(cases.length, 4);

  for (const [label, question] of cases) {
    assertRefused(renderQuestion(question), ASK_ERROR_CODES.RECOMMENDATION_NOT_OFFERED, label);
  }
});

/* ------------------------------------------------------------------------ *
 * Refusal 3: E_ASK_RECOMMENDATION_NOT_FIRST
 * ------------------------------------------------------------------------ */

test('REFUSAL 3 FIRES: a BARE MENU whose first option is not the recommendation', () => {
  // This is the shape the whole chokepoint exists to refuse: every number is
  // correct, the recommendation is present and real, and a reader still meets a
  // rejected option before the pick.
  const result = renderQuestion({
    subject: 'serial or fleet for this wave',
    recommendation: 'fleet',
    why: 'width 3 with no lane overlap',
    options: [
      { id: 'solo', label: 'Solo mode' },
      { id: 'fleet', label: 'Fleet mode' },
    ],
  });
  assertRefused(result, ASK_ERROR_CODES.RECOMMENDATION_NOT_FIRST, 'recommendation offered second');
  assert.ok(result.message.includes('fleet'));
  assert.ok(result.message.includes('solo'));
});

/* ------------------------------------------------------------------------ *
 * Refusal 4: E_ASK_RECOMMENDATION_UNMARKED
 * ------------------------------------------------------------------------ */

test('REFUSAL 4 FIRES: a recommended option carrying a marker that is not the constant', () => {
  const cases = [
    ['marker stripped to empty', ''],
    ['marker nulled', null],
    ['marker spelled by hand', '(rec)'],
    ['marker in the wrong case', '(recommended)'],
  ];
  assert.equal(cases.length, 4);

  for (const [label, marker] of cases) {
    const result = renderQuestion({
      subject: 'pick the mode',
      recommendation: 'fleet',
      why: 'width 3 with no lane overlap',
      options: [{ id: 'fleet', label: 'Fleet mode', marker }, { id: 'solo', label: 'Solo mode' }],
    });
    assertRefused(result, ASK_ERROR_CODES.RECOMMENDATION_UNMARKED, label);
  }
});

test('REFUSAL 4 DOES NOT fire when the caller supplies the exported constant', () => {
  // The negative arm. A refusal that fires on everything is not a guard, it is a
  // wall, and this proves refusal 4 discriminates.
  const result = renderQuestion({
    subject: 'pick the mode',
    recommendation: 'fleet',
    why: 'width 3 with no lane overlap',
    options: [
      { id: 'fleet', label: 'Fleet mode', marker: RECOMMENDED_MARKER },
      { id: 'solo', label: 'Solo mode' },
    ],
  });
  assert.equal(result.ok, true);
  assert.ok(result.lines[0].includes(RECOMMENDED_MARKER));
});

/* ------------------------------------------------------------------------ *
 * Refusals 5 to 7: the escalation menu
 * ------------------------------------------------------------------------ */

const SAMPLE_ASK = Object.freeze({
  node_id: '21-03',
  cause: ASK_CAUSES.ROUNDS_EXCEEDED,
  severity: SEVERITY.HIGH,
});

test('REFUSAL 5 FIRES: a move outside the 4 legal ones is refused BY NAME', () => {
  const cases = ['add-a-lane', 'escalate-to-sean', 'ship-it', 'descoped'];
  assert.equal(cases.length, 4);

  for (const requestedMove of cases) {
    const result = buildEscalationMenu({
      ask: SAMPLE_ASK, rounds: 1, blockingSet: [], requestedMove,
    });
    assertRefused(result, MENU_ERROR_CODES.ILLEGAL_MOVE, requestedMove);
    assert.ok(
      result.message.includes(requestedMove),
      `the refusal must name the offending id "${requestedMove}"`,
    );
    for (const legal of LEGAL_MOVE_IDS) {
      assert.ok(result.message.includes(legal), 'the refusal must list the legal moves');
    }
  }
});

test('REFUSAL 6 FIRES: "try again" is refused with its OWN code, naming the rule', () => {
  const cases = ['try again', 'try-again', 'retry', 'again', 'rerun', 'Try Again', '  RETRY  '];
  assert.equal(cases.length, 7);

  for (const requestedMove of cases) {
    const result = buildEscalationMenu({
      ask: SAMPLE_ASK, rounds: 2, blockingSet: [], requestedMove,
    });
    assertRefused(result, MENU_ERROR_CODES.RETRY_FORBIDDEN, requestedMove);
    // the message names the GOVERNANCE RULE rather than restating the request
    assert.ok(result.message.includes('anti loop governance'));
    assert.ok(!result.message.includes(String(requestedMove).trim()) || result.message.includes('try again'));
  }
});

test('REFUSAL 7 FIRES: a new phase or subphase is refused with its OWN code', () => {
  const cases = ['new-phase', 'new phase', 'subphase', 'sub-phase', 'split-phase', 'insert-phase', 'NEW PHASE'];
  assert.equal(cases.length, 7);

  for (const requestedMove of cases) {
    const result = buildEscalationMenu({
      ask: SAMPLE_ASK, rounds: 2, blockingSet: [], requestedMove,
    });
    assertRefused(result, MENU_ERROR_CODES.NEW_PHASE_FORBIDDEN, requestedMove);
    assert.ok(result.message.includes('anti loop governance'));
    assert.ok(result.message.includes('14.1'), 'the refusal must cite the recorded cost');
  }
});

test('THE 3 MENU CODES ARE DISTINCT, so a forbidden move is never a generic illegal one', () => {
  const codes = new Set([
    MENU_ERROR_CODES.ILLEGAL_MOVE,
    MENU_ERROR_CODES.RETRY_FORBIDDEN,
    MENU_ERROR_CODES.NEW_PHASE_FORBIDDEN,
  ]);
  assert.equal(codes.size, 3);

  const retry = buildEscalationMenu({ ask: SAMPLE_ASK, requestedMove: 'retry' });
  const newPhase = buildEscalationMenu({ ask: SAMPLE_ASK, requestedMove: 'subphase' });
  const illegal = buildEscalationMenu({ ask: SAMPLE_ASK, requestedMove: 'ship-it' });
  assert.notEqual(retry.code, illegal.code);
  assert.notEqual(newPhase.code, illegal.code);
  assert.notEqual(retry.code, newPhase.code);
});

test('A LEGAL requested move is NOT refused, so refusal 5 discriminates', () => {
  assert.equal(LEGAL_MOVE_IDS.length, 4);
  for (const requestedMove of LEGAL_MOVE_IDS) {
    const result = buildEscalationMenu({ ask: SAMPLE_ASK, rounds: 1, blockingSet: [], requestedMove });
    assert.equal(result.ok, true, `${requestedMove} is legal and must not be refused`);
    assert.equal(result.code, undefined);
  }
});

test('THE MENU REFUSES with no ask at all, rather than inventing a reason', () => {
  const cases = [
    ['no input object', undefined],
    ['null input', null],
    ['input with no ask', { rounds: 2, blockingSet: [] }],
    ['ask is null', { ask: null, rounds: 2 }],
  ];
  assert.equal(cases.length, 4);

  for (const [label, input] of cases) {
    let result;
    assert.doesNotThrow(() => { result = buildEscalationMenu(input); }, `${label}: must never throw`);
    assertRefused(result, ASK_ERROR_CODES.NO_INPUT, label);
  }
});

/* ------------------------------------------------------------------------ *
 * Refusal 8: E_ASK_NO_INPUT on the fold
 * ------------------------------------------------------------------------ */

test('REFUSAL 8 FIRES: the fold names WHICH argument was absent', () => {
  const board = { leases: {}, queue: { tickets: [], held_by: null } };
  const runRecord = { workers: [], nodes: [] };

  const noBoard = foldAsks({ board: null, runRecord });
  assertRefused(noBoard, ASK_ERROR_CODES.NO_INPUT, 'board absent');
  assert.ok(noBoard.message.includes('board'));
  assert.ok(!noBoard.message.includes('runRecord'), 'it must not name an argument that was present');

  const noRecord = foldAsks({ board, runRecord: undefined });
  assertRefused(noRecord, ASK_ERROR_CODES.NO_INPUT, 'runRecord absent');
  assert.ok(noRecord.message.includes('runRecord'));

  const neither = foldAsks({});
  assertRefused(neither, ASK_ERROR_CODES.NO_INPUT, 'both absent');
  assert.ok(neither.message.includes('board'));
  assert.ok(neither.message.includes('runRecord'));

  for (const input of [undefined, null, 'board', 42, []]) {
    let result;
    assert.doesNotThrow(() => { result = foldAsks(input); });
    assertRefused(result, ASK_ERROR_CODES.NO_INPUT, `non object input ${String(input)}`);
  }
});

test('REFUSAL 8: an absent input NEVER comes back as an empty ask list', () => {
  const result = foldAsks({ board: null, runRecord: null });
  assert.equal(result.ok, false);
  assert.equal(result.asks, undefined, 'a refusal must not carry an ask list at all');
  assert.equal(result.signal, undefined, 'a refusal must not carry a signal that reads as healthy');
});

/* ------------------------------------------------------------------------ *
 * Ordering: the fold is a total order, not an insertion order
 * ------------------------------------------------------------------------ */

test('ORDERING: 2 semantically equal inputs built in a DIFFERENT insertion order fold identically', () => {
  // Objects, Maps and arrays all preserve insertion order in JavaScript, so a
  // fold that returns its collection order returns a different list when the
  // same facts arrive in a different order. Only a total sort survives this.
  const buildA = () => {
    const leases = {};
    leases['21-09'] = { node_id: '21-09', lease_epoch: 2 };
    leases['21-02'] = { node_id: '21-02', lease_epoch: 3 };
    leases['21-05'] = { node_id: '21-05', lease_epoch: 4 };
    const rounds = {};
    rounds['21-07'] = 5;
    rounds['21-01'] = 6;
    return {
      board: { leases, queue: { tickets: [], held_by: null } },
      runRecord: {
        workers: [
          { worker_id: 'wz', node_id: '21-08', status: RUNFOLD_UNKNOWN_STATUS },
          { worker_id: 'wa', node_id: '21-03', status: RUNFOLD_UNKNOWN_STATUS },
        ],
        nodes: [],
        demonstrated_width: { value: 2, exact: true, unknown_intervals: 0 },
        rounds_per_artifact: rounds,
        false_green: { landed: 0, later_failed: 0, unknown: 0 },
      },
    };
  };

  const buildB = () => {
    const leases = {};
    leases['21-05'] = { node_id: '21-05', lease_epoch: 4 };
    leases['21-09'] = { node_id: '21-09', lease_epoch: 2 };
    leases['21-02'] = { node_id: '21-02', lease_epoch: 3 };
    const rounds = {};
    rounds['21-01'] = 6;
    rounds['21-07'] = 5;
    return {
      board: { queue: { tickets: [], held_by: null }, leases },
      runRecord: {
        false_green: { landed: 0, later_failed: 0, unknown: 0 },
        rounds_per_artifact: rounds,
        demonstrated_width: { unknown_intervals: 0, exact: true, value: 2 },
        nodes: [],
        workers: [
          { worker_id: 'wa', node_id: '21-03', status: RUNFOLD_UNKNOWN_STATUS },
          { worker_id: 'wz', node_id: '21-08', status: RUNFOLD_UNKNOWN_STATUS },
        ],
      },
    };
  };

  const first = foldAsks(buildA());
  const second = foldAsks(buildB());

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  // A NON ZERO count first: 2 empty lists are identical for the wrong reason.
  assert.equal(first.asks.length, 7);
  assert.equal(second.asks.length, 7);
  assert.deepEqual(first.asks, second.asks);

  // and the order really is the declared total order, not either insertion order
  const nodeIds = first.asks.map((ask) => ask.node_id);
  assert.deepEqual(nodeIds, [...nodeIds].sort());
});

/* ------------------------------------------------------------------------ *
 * The CLI, observed as a real child process
 * ------------------------------------------------------------------------ */

function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
}

test('CHILD PROCESS: the script with no argument REFUSES and exits 1', () => {
  const run = runScript([]);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes('--contract'), 'the refusal must name the usage');
});

test('CHILD PROCESS: --contract exits 0 and prints the contract the later plans read', () => {
  const run = runScript(['--contract']);
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');

  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.marker, RECOMMENDED_MARKER);
  assert.equal(parsed.legal_moves.length, 4);
  assert.deepEqual(parsed.legal_moves, LEGAL_MOVE_IDS);
  assert.equal(Object.keys(parsed.ask_causes).length, 6);
  assert.equal(parsed.ask_error_codes.NO_RECOMMENDATION, ASK_ERROR_CODES.NO_RECOMMENDATION);
  assert.equal(parsed.menu_error_codes.RETRY_FORBIDDEN, MENU_ERROR_CODES.RETRY_FORBIDDEN);
});

test('ALL 8 REFUSAL CODES ARE DISTINCT STRINGS', () => {
  const all = [...Object.values(ASK_ERROR_CODES), ...Object.values(MENU_ERROR_CODES)];
  assert.equal(all.length, 8);
  assert.equal(new Set(all).size, 8);
  for (const code of all) {
    assert.match(code, /^E_(ASK|MENU)_[A-Z_]+$/);
  }
});
