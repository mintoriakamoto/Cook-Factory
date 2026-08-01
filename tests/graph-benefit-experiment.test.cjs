'use strict';

/**
 * Phase 29 plan 01: the guards of the GRAPH-07 measured experiment.
 *
 * EVERY ARM IN THIS FILE RUNS AT 0 REAL SPEND. `ferrox-core/bin/lib/external-cli.cjs`
 * is pure by injection: supplying `run` replaces the spawn entirely, so no adapter
 * is ever invoked here. The 2 arms that drive the CLI do so as a real child
 * process in `--mock` mode, which injects an in process runner and spawns nothing.
 *
 * THE 2 REQUIRED FAILING ARMS ARE PERMANENT, not a ritual performed once and
 * deleted. A guard that has never been seen firing is a guard nobody has evidence
 * for, and this whole phase exists to stop a flattering measurement.
 *
 *   ARM 1  the budget guard is pointed at an implementation that WARNS instead of
 *          refusing, and the guard is asserted to FAIL. The assertion that catches
 *          it is a COUNT OF ACTUAL RUNNER INVOCATIONS, never a flag, because a
 *          flag assertion passes for an implementation that reports a refusal and
 *          invokes anyway. That is precisely what the warning implementation does.
 *
 *   ARM 2  the scorer guard is pointed at a deliberately WRONG answer key and is
 *          asserted to report a MISS. A scorer that reports success against a key
 *          it was never given is measuring nothing, and every recall figure this
 *          phase publishes would be decoration.
 *
 * THE VACUITY GUARD IS SEPARATE AND IS ALSO PERMANENT. Recall over an empty key is
 * either 0 over 0 or, worse, 1 by a convenience branch. `scoreDeclaration` refuses
 * an empty key outright and this file asserts that refusal, so the corpus rule's
 * "at least 2 backed edges" is load bearing rather than decorative.
 *
 * UNKNOWN IS NEVER 0. The absence arm drives an adapter that exits non zero and
 * asserts the cell carries a null score and a reason, that its recall is not 0,
 * and that the per arm completion counter falls BELOW the arm count. "Every arm
 * passed" is vacuously true of 0 arms, so the counter travels with its denominator.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const experiment = require('../scripts/graph-benefit-experiment.cjs');

const P = 'phase 29 plan 01';
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'graph-benefit-experiment.cjs');
const LIB_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib');

const {
  ABSENCE_REASONS,
  ARMS,
  BudgetRefusal,
  CORPUS_MIN_BACKED,
  CORPUS_SIZE,
  EMPTY_DECLARATION,
  MAX_CALLS,
  MIN_CONTRIBUTING_PHASES,
  T1_MIN_MEAN_GAIN,
  armsDifferInExactly1Block,
  assertNoAnswerLeak,
  buildKeyForPhase,
  buildPrompt,
  createBudget,
  deriveTokens,
  edgeKey,
  foldVerdict,
  invokeCell,
  mockRun,
  parseDeclaration,
  phaseNumeric,
  readArgv,
  readReportedTokens,
  scoreDeclaration,
  selectCorpus,
} = experiment;

const SEAMS = {
  probe: require(path.join(LIB_DIR, 'fleet-probe.cjs')),
  cli: require(path.join(LIB_DIR, 'external-cli.cjs')),
  scan: require(path.join(LIB_DIR, 'workgraph-scan.cjs')),
};

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A spawnSync shaped runner that counts its own calls. The count IS the guard. */
function countingRunner(reply) {
  const calls = [];
  const run = (bin, args, options) => {
    calls.push({ bin, args, options });
    return typeof reply === 'function' ? reply(bin, args, options) : reply;
  };
  return { run, calls };
}

/** A work graph document carrying 1 edge of each verdict. */
function mixedVerdictDocument() {
  return {
    phase: 'FX',
    nodes: [{ id: 'FX-01' }, { id: 'FX-02' }, { id: 'FX-03' }, { id: 'FX-04' }],
    edges: [
      { from: 'FX-02', to: 'FX-01', verdict: 'backed', evidence: ['a imports b'] },
      { from: 'FX-03', to: 'FX-01', verdict: 'backed', evidence: ['c imports b'] },
      { from: 'FX-04', to: 'FX-01', verdict: 'unbacked', evidence: [] },
      { from: 'FX-04', to: 'FX-02', verdict: 'unproven', evidence: [] },
    ],
  };
}

// ─── THE BROKEN IMPLEMENTATIONS THE 2 REQUIRED ARMS ARE POINTED AT ───────────

/**
 * A budget that WARNS instead of refusing. This is the defect the required arm
 * exists to catch: it records that it went over and then increments and returns,
 * so the caller invokes the adapter anyway. Its `spent()` is even honest about
 * the overrun, which is exactly why a flag assertion would not catch it.
 */
function warnOnlyBudget(max) {
  let calls = 0;
  const warnings = [];
  return {
    max,
    warnings,
    spent() { return calls; },
    remaining() { return max - calls; },
    spend() {
      if (calls >= max) warnings.push(`WARNING: budget of ${max} exceeded at invocation ${calls + 1}`);
      calls += 1;
      return calls;
    },
  };
}

// ─── THE 2 GUARDS, EXTRACTED SO THEY CAN BE POINTED ANYWHERE ─────────────────

/**
 * The budget guard. Given a budget factory, drive `max` invocations and then 1
 * more, and assert the runner was invoked EXACTLY `max` times.
 *
 * THE COUNTER ASSERTION COMES FIRST AND IS THE ONE THAT MATTERS. The refusal
 * assertion below it is a secondary nicety: an implementation can report a
 * refusal and invoke anyway, and only the count of real invocations can tell the
 * difference.
 */
function assertBudgetRefuses(makeBudget, max) {
  const budget = makeBudget(max);
  const counting = countingRunner({ status: 0, stdout: 'EDGE FX-02 -> FX-01\n', stderr: '' });
  const call = () => invokeCell({
    identity: 'mock',
    prompt: 'a bounded prompt',
    budget,
    seams: SEAMS,
    run: counting.run,
    timeoutMs: 1_000,
    cwd: REPO_ROOT,
  });

  for (let i = 0; i < max; i += 1) call();

  let refusal = null;
  try {
    call();
  } catch (err) {
    if (!(err instanceof BudgetRefusal)) throw err;
    refusal = err;
  }

  assert.equal(
    counting.calls.length,
    max,
    `${P}: the runner was ACTUALLY INVOKED ${counting.calls.length} times against a budget of ${max}. `
    + `Invocation ${max + 1} was not refused, it was MADE. A budget that reports a refusal and invokes `
    + 'anyway is a warning, and this experiment spends real money.',
  );
  assert.notEqual(
    refusal,
    null,
    `${P}: invocation ${max + 1} did not throw a BudgetRefusal. Budget spent(): ${budget.spent()}.`,
  );
  return refusal;
}

/**
 * The scorer guard. Assert the scorer agrees with the key it was given, meaning
 * it reports 0 misses and full recall for a declaration that IS the key.
 *
 * Pointed at the true key this passes. Pointed at a WRONG key it must report a
 * miss, and the required arm below asserts exactly that.
 */
function assertScorerAgreesWithKey({ declared, key, neutral }) {
  const score = scoreDeclaration({ declared, key, neutral });
  assert.equal(
    score.missed.length,
    0,
    `${P}: the scorer reported ${score.missed.length} MISSED key edge(s) ${JSON.stringify(score.missed)} `
    + `at recall ${score.recall.toFixed(3)}, for a declaration of ${JSON.stringify(declared)} against key `
    + `${JSON.stringify(key)}.`,
  );
  assert.equal(
    score.recall,
    1,
    `${P}: the scorer reported recall ${score.recall.toFixed(3)} where the declaration equals the key.`,
  );
  return score;
}

// ─── REQUIRED FAILING ARM 1: the budget, driven against a WARNING ────────────

test(`${P}: REQUIRED ARM 1, the budget guard FAILS against an implementation that warns`, () => {
  // The correct implementation passes the guard. This is the control for the arm.
  const refusal = assertBudgetRefuses(createBudget, 4);
  assert.match(
    refusal.message,
    /REFUSED and was NOT made/,
    `${P}: the refusal message no longer states that no call followed it`,
  );

  // The warning implementation must FAIL the very same guard.
  let observed = null;
  try {
    assertBudgetRefuses(warnOnlyBudget, 4);
  } catch (err) {
    observed = err;
  }

  assert.notEqual(
    observed,
    null,
    `${P}: the budget guard PASSED against an implementation that warns instead of refusing. The guard `
    + 'cannot fire, so it is proving nothing about the 48 call cap.',
  );
  assert.match(
    observed.message,
    /ACTUALLY INVOKED 5 times against a budget of 4/,
    `${P}: the guard failed for the wrong reason. Observed: ${observed.message}`,
  );
});

test(`${P}: the warning implementation really does invoke past its own budget`, () => {
  const budget = warnOnlyBudget(2);
  const counting = countingRunner({ status: 0, stdout: `${EMPTY_DECLARATION}\n`, stderr: '' });
  for (let i = 0; i < 3; i += 1) {
    invokeCell({
      identity: 'mock', prompt: 'p', budget, seams: SEAMS, run: counting.run, timeoutMs: 1_000, cwd: REPO_ROOT,
    });
  }
  assert.equal(counting.calls.length, 3, `${P}: the warning fixture did not overrun, so arm 1 proves nothing`);
  assert.equal(budget.warnings.length, 1, `${P}: the warning fixture did not warn`);
});

// ─── REQUIRED FAILING ARM 2: the scorer, driven against a WRONG key ──────────

test(`${P}: REQUIRED ARM 2, the scorer reports a MISS against a deliberately wrong key`, () => {
  const trueKey = [edgeKey('FX-02', 'FX-01'), edgeKey('FX-03', 'FX-01')];
  const declared = [...trueKey];

  // The control: against the key it was given, the scorer agrees.
  const agreed = assertScorerAgreesWithKey({ declared, key: trueKey, neutral: [] });
  assert.equal(agreed.recall, 1, `${P}: the control arm did not reach full recall`);

  // The arm: a key naming edges the declaration never made.
  const wrongKey = [edgeKey('FX-09', 'FX-08'), edgeKey('FX-07', 'FX-08')];
  let observed = null;
  try {
    assertScorerAgreesWithKey({ declared, key: wrongKey, neutral: [] });
  } catch (err) {
    observed = err;
  }

  assert.notEqual(
    observed,
    null,
    `${P}: the scorer reported SUCCESS against a key it was never given. A scorer that cannot report a `
    + 'miss is measuring nothing, and every recall figure in this experiment would be decoration.',
  );
  assert.match(
    observed.message,
    /reported 2 MISSED key edge\(s\)/,
    `${P}: the scorer failed for the wrong reason. Observed: ${observed.message}`,
  );

  // And the miss is a real 0, arrived at honestly, not a refusal to answer.
  const missScore = scoreDeclaration({ declared, key: wrongKey, neutral: [] });
  assert.equal(missScore.recall, 0, `${P}: a declaration sharing no edge with the key did not score 0`);
  assert.deepEqual(missScore.missed.slice().sort(), wrongKey.slice().sort(), `${P}: the missed set is wrong`);
  assert.equal(missScore.unmatchedCount, 2, `${P}: the 2 declared edges with no counterpart were not counted`);
});

// ─── the vacuity guard ───────────────────────────────────────────────────────

test(`${P}: the scorer REFUSES an empty key, because recall over nothing is vacuous`, () => {
  for (const empty of [[], null, undefined]) {
    assert.throws(
      () => scoreDeclaration({ declared: ['FX-02>FX-01'], key: empty, neutral: [] }),
      /empty key/i,
      `${P}: the scorer accepted ${JSON.stringify(empty)} as a key. A phase with nothing to find would `
      + 'then report a recall figure, which is the vacuous pass this phase exists to close.',
    );
  }
});

test(`${P}: the corpus is non empty and every member carries a non empty key`, () => {
  const census = experiment.runCensus({ cwd: REPO_ROOT, buildGraph: SEAMS.scan.buildWorkgraph });
  const corpus = selectCorpus(census);

  assert.ok(
    corpus.length > 0,
    `${P}: the corpus is empty, so there is nothing to measure and no recall figure means anything`,
  );
  assert.ok(corpus.length <= CORPUS_SIZE, `${P}: the corpus exceeded ${CORPUS_SIZE}`);

  let keyTotal = 0;
  for (const row of corpus) {
    const { key } = buildKeyForPhase(row.document);
    assert.ok(
      key.length >= CORPUS_MIN_BACKED,
      `${P}: corpus phase ${row.phase} carries ${key.length} key edges, under the ${CORPUS_MIN_BACKED} floor`,
    );
    keyTotal += key.length;
  }
  assert.ok(keyTotal > 0, `${P}: the whole key is empty`);
});

// ─── the key is `backed` edges only, in both directions ─────────────────────

test(`${P}: the key admits backed edges only and neutralises unbacked and unproven`, () => {
  const { key, neutral } = buildKeyForPhase(mixedVerdictDocument());

  assert.deepEqual(
    key.slice().sort(),
    ['FX-02>FX-01', 'FX-03>FX-01'],
    `${P}: the key is not exactly the backed edges`,
  );
  assert.equal(key.includes('FX-04>FX-01'), false, `${P}: an unbacked edge entered the key`);
  assert.equal(key.includes('FX-04>FX-02'), false, `${P}: an unproven edge entered the key`);
  assert.deepEqual(
    neutral.slice().sort(),
    ['FX-04>FX-01', 'FX-04>FX-02'],
    `${P}: the neutral zone is not exactly the unbacked plus unproven edges`,
  );
});

test(`${P}: a declared edge matching a neutral edge is neither credit nor penalty`, () => {
  const { key, neutral } = buildKeyForPhase(mixedVerdictDocument());
  const declared = [...key, 'FX-04>FX-02'];
  const score = scoreDeclaration({ declared, key, neutral });

  assert.equal(score.recall, 1, `${P}: declaring an unproven edge cost recall`);
  assert.equal(
    score.unmatchedCount,
    0,
    `${P}: an unproven edge was counted as a declaration with no counterpart. unproven means the scan `
    + 'could not see, and penalising it would measure the instrument rather than the model.',
  );
  assert.equal(score.neutralHitCount, 1, `${P}: the neutral hit was not recorded at all`);
});

test(`${P}: the corpus rule is mechanical and excludes phases under the floor`, () => {
  const census = [
    { phase: '01', error: null, backed: 9 },
    { phase: '02', error: null, backed: 1 },
    { phase: '03', error: null, backed: 5 },
    { phase: '04', error: null, backed: 5 },
    { phase: '05', error: 'unreadable', backed: 99 },
    { phase: '06', error: null, backed: 0 },
  ];
  const corpus = selectCorpus(census);
  assert.deepEqual(
    corpus.map((c) => c.phase),
    ['01', '03', '04'],
    `${P}: the corpus rule is not rank by backed descending then ascending phase, over a floor of `
    + `${CORPUS_MIN_BACKED}, excluding phases whose graph could not be built`,
  );
});

test(`${P}: 14.1 sorts between 14 and 15`, () => {
  assert.ok(phaseNumeric('14') < phaseNumeric('14.1'), `${P}: 14.1 does not sort after 14`);
  assert.ok(phaseNumeric('14.1') < phaseNumeric('15'), `${P}: 14.1 does not sort before 15`);
});

// ─── the arms differ in exactly 1 variable ──────────────────────────────────

test(`${P}: the 2 arms differ in exactly 1 block, and the control never sees the graph`, () => {
  const shared = {
    goal: 'a phase goal',
    planPayload: 'PLAN FX-01\n  objective: x\n\nPLAN FX-02\n  objective: y\n',
    priorGraph: 'phase 00\n  00-02 depends on 00-01\n',
  };
  const promptA = buildPrompt({ arm: 'A', ...shared });
  const promptB = buildPrompt({ arm: 'B', ...shared });

  const verdict = armsDifferInExactly1Block({ promptA, promptB });
  assert.equal(verdict.ok, true, `${P}: the arms are not a controlled pair: ${verdict.reason}`);

  assert.equal(promptB.includes('PRIOR LANDED WORK GRAPH.'), false, `${P}: the control arm saw the graph`);
  assert.equal(promptA.includes('PRIOR LANDED WORK GRAPH.'), true, `${P}: the graph arm did not see the graph`);
  assert.ok(promptA.includes(shared.planPayload), `${P}: arm A lost the plan payload`);
  assert.ok(promptB.includes(shared.planPayload), `${P}: arm B lost the plan payload`);
});

test(`${P}: armsDifferInExactly1Block CATCHES a control arm that leaked the graph`, () => {
  const shared = { goal: 'g', planPayload: 'THE PLANS\nPLAN FX-01\n', priorGraph: 'phase 00\n' };
  const promptA = buildPrompt({ arm: 'A', ...shared });
  const leaked = `${buildPrompt({ arm: 'B', ...shared })}\nPRIOR LANDED WORK GRAPH.\n`;
  const verdict = armsDifferInExactly1Block({ promptA, promptB: leaked });
  assert.equal(verdict.ok, false, `${P}: a control arm carrying the graph block was accepted`);
  assert.match(verdict.reason, /control arm received the graph/, `${P}: wrong reason: ${verdict.reason}`);
});

// ─── the answer never reaches a prompt ──────────────────────────────────────

test(`${P}: a prompt carrying an answer edge is REFUSED`, () => {
  const key = [edgeKey('FX-02', 'FX-01')];
  assert.throws(
    () => assertNoAnswerLeak({ prompt: 'blah EDGE FX-02 -> FX-01 blah', key, phase: 'FX' }),
    /carries the answer edge/,
    `${P}: a prompt naming a key edge in the answer format was accepted`,
  );
  assert.throws(
    () => assertNoAnswerLeak({ prompt: 'FX-02 depends on FX-01', key, phase: 'FX' }),
    /carries the answer edge/,
    `${P}: a prompt naming a key edge in prose form was accepted`,
  );
  assert.doesNotThrow(
    () => assertNoAnswerLeak({ prompt: 'FX-01 and FX-02 are both plans', key, phase: 'FX' }),
    `${P}: a prompt merely naming the 2 plans was refused`,
  );
});

test(`${P}: every real corpus prompt passes the leak check and the control check`, () => {
  const census = experiment.runCensus({ cwd: REPO_ROOT, buildGraph: SEAMS.scan.buildWorkgraph });
  const corpus = selectCorpus(census);
  for (const row of corpus) {
    const { key } = buildKeyForPhase(row.document);
    const goal = experiment.readPhaseGoal({ cwd: REPO_ROOT, phase: row.phase, dir: row.dir });
    const planPayload = experiment.buildPlanPayload({ cwd: REPO_ROOT, dir: row.dir, document: row.document });
    const priorGraph = experiment.renderPriorGraph({ census, phase: row.phase });
    const promptA = buildPrompt({ arm: 'A', goal, planPayload, priorGraph });
    const promptB = buildPrompt({ arm: 'B', goal, planPayload, priorGraph });

    assert.equal(
      armsDifferInExactly1Block({ promptA, promptB }).ok,
      true,
      `${P}: phase ${row.phase} arms are not a controlled pair`,
    );
    assert.doesNotThrow(
      () => assertNoAnswerLeak({ prompt: promptA, key, phase: row.phase }),
      `${P}: the arm A prompt for phase ${row.phase} carries the answer`,
    );
    assert.doesNotThrow(
      () => assertNoAnswerLeak({ prompt: promptB, key, phase: row.phase }),
      `${P}: the arm B prompt for phase ${row.phase} carries the answer`,
    );
  }
});

test(`${P}: the prior graph block never carries the phase under test or a later phase`, () => {
  const census = experiment.runCensus({ cwd: REPO_ROOT, buildGraph: SEAMS.scan.buildWorkgraph });
  for (const phase of ['03', '07', '22']) {
    const rendered = experiment.renderPriorGraph({ census, phase });
    for (const line of rendered.split(/\r?\n/)) {
      const match = /^phase (\S+)$/.exec(line);
      if (match === null) continue;
      assert.ok(
        phaseNumeric(match[1]) < phaseNumeric(phase),
        `${P}: the prior graph for phase ${phase} carried phase ${match[1]}, which is not prior`,
      );
    }
  }
});

// ─── parsing: silence is not the claim that there are 0 edges ───────────────

test(`${P}: an unreadable answer is UNPARSEABLE and is never an empty declaration`, () => {
  const declined = parseDeclaration('I am not able to help with that request.');
  assert.equal(declined.ok, false, `${P}: a refusal parsed as a declaration`);
  assert.equal(
    declined.reason,
    ABSENCE_REASONS.UNPARSEABLE,
    `${P}: a refusal was not recorded as unparseable`,
  );

  const blank = parseDeclaration('   \n  \n');
  assert.equal(blank.ok, false, `${P}: blank output parsed as a declaration`);
  assert.equal(blank.reason, ABSENCE_REASONS.EMPTY, `${P}: blank output was not recorded as empty`);

  const none = parseDeclaration(`${EMPTY_DECLARATION}\n`);
  assert.equal(none.ok, true, `${P}: the explicit empty declaration was not accepted`);
  assert.deepEqual(none.edges, [], `${P}: the empty declaration produced edges`);
});

test(`${P}: the parser reads a decorated answer and drops self edges and duplicates`, () => {
  const parsed = parseDeclaration([
    '```',
    '- **EDGE FX-02 -> FX-01**',
    '  EDGE FX-03 -> FX-01',
    'EDGE FX-03 -> FX-01',
    'EDGE FX-04 -> FX-04',
    'some prose the model added anyway',
    '```',
  ].join('\n'));

  assert.equal(parsed.ok, true, `${P}: a decorated answer was rejected`);
  assert.deepEqual(parsed.edges, ['FX-02>FX-01', 'FX-03>FX-01'], `${P}: wrong edge set: ${JSON.stringify(parsed.edges)}`);
  assert.equal(parsed.selfEdges, 1, `${P}: the self edge was not counted`);
});

// ─── UNKNOWN IS NEVER 0: the absence arm ────────────────────────────────────

test(`${P}: an adapter that exits non zero is an ABSENCE with a reason, never a 0`, () => {
  const budget = createBudget(4);
  const counting = countingRunner({ status: 7, stdout: '', stderr: 'HTTP 429 rate limited' });
  const cell = invokeCell({
    identity: 'mock', prompt: 'p', budget, seams: SEAMS, run: counting.run, timeoutMs: 1_000, cwd: REPO_ROOT,
  });

  assert.equal(cell.completed, false, `${P}: a non zero exit was treated as a completion`);
  assert.equal(cell.reason, ABSENCE_REASONS.EXIT, `${P}: wrong absence reason: ${cell.reason}`);
  assert.match(cell.detail, /429/, `${P}: the absence lost the adapter's own reason`);
  assert.equal(cell.declared, undefined, `${P}: an absence carried a declaration`);
  assert.equal(counting.calls.length, 1, `${P}: the seam was not invoked exactly once`);
  assert.equal(budget.spent(), 1, `${P}: a failed call did not count against the budget`);
});

test(`${P}: an absent adapter is an ABSENCE, and its cell never reaches the aggregate`, () => {
  const budget = createBudget(4);
  const counting = countingRunner({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
  const cell = invokeCell({
    identity: 'mock', prompt: 'p', budget, seams: SEAMS, run: counting.run, timeoutMs: 1_000, cwd: REPO_ROOT,
  });
  assert.equal(cell.completed, false, `${P}: an absent adapter was treated as a completion`);
  assert.equal(cell.reason, ABSENCE_REASONS.ABSENT, `${P}: wrong absence reason: ${cell.reason}`);
});

test(`${P}: an absence drops its PARTNER from the aggregate and the counter falls below the arm count`, () => {
  const corpus = [{ phase: 'FX', backed: 2 }, { phase: 'FY', backed: 2 }];
  const adapters = ['mock'];
  const cells = [
    { phase: 'FX', adapter: 'mock', arm: 'A', completed: true, reason: null, score: { recall: 1 } },
    { phase: 'FX', adapter: 'mock', arm: 'B', completed: true, reason: null, score: { recall: 0.5 } },
    { phase: 'FY', adapter: 'mock', arm: 'A', completed: true, reason: null, score: { recall: 1 } },
    { phase: 'FY', adapter: 'mock', arm: 'B', completed: false, reason: ABSENCE_REASONS.EXIT, score: null },
  ];

  const fold = foldVerdict({ cells, corpus, adapters });

  assert.equal(fold.pairedCells, 1, `${P}: an unpaired cell entered the aggregate`);
  assert.equal(fold.t1.meanA, 1, `${P}: the arm A mean absorbed an unpaired cell`);
  assert.equal(fold.t1.meanB, 0.5, `${P}: the arm B mean scored an absence as 0`);
  assert.equal(fold.perPhase.find((p) => p.phase === 'FY').delta, null, `${P}: an absent pair produced a delta`);
  assert.equal(fold.perPhase.find((p) => p.phase === 'FY').pairs, 0, `${P}: an absent pair was counted as a pair`);

  assert.equal(fold.completion.B.completed, 1, `${P}: the arm B completion counter is wrong`);
  assert.equal(fold.completion.B.attempted, 2, `${P}: the arm B denominator is wrong`);
  assert.ok(
    fold.completion.B.completed < fold.completion.B.attempted,
    `${P}: the completion counter did not fall below the arm count for an arm that lost a cell`,
  );
  assert.equal(fold.droppedPairs.length, 1, `${P}: the dropped pair was not recorded`);
  assert.equal(fold.droppedPairs[0].armB, ABSENCE_REASONS.EXIT, `${P}: the dropped pair lost its reason`);
});

test(`${P}: a run that lost too much of its corpus is INCONCLUSIVE, not NO`, () => {
  const corpus = Array.from({ length: CORPUS_SIZE }, (_, i) => ({ phase: `F${i}`, backed: 2 }));
  const adapters = ['mock'];
  const cells = [];
  // Only 2 phases complete, well under the MIN_CONTRIBUTING_PHASES floor.
  for (const phase of ['F0', 'F1']) {
    cells.push({ phase, adapter: 'mock', arm: 'A', completed: true, reason: null, score: { recall: 1 } });
    cells.push({ phase, adapter: 'mock', arm: 'B', completed: true, reason: null, score: { recall: 0 } });
  }
  const fold = foldVerdict({ cells, corpus, adapters });
  assert.equal(
    fold.verdict,
    'INCONCLUSIVE',
    `${P}: a run contributing ${fold.t2.contributingPhases} of ${CORPUS_SIZE} phases reported `
    + `${fold.verdict}. Below ${MIN_CONTRIBUTING_PHASES} contributing phases the experiment measured `
    + 'too little to answer either way.',
  );
  assert.equal(fold.vacuity.satisfied, false, `${P}: the vacuity guard reported satisfied`);
});

// ─── the pre registered threshold, implemented as pre registered ────────────

test(`${P}: T1 and T2 are BOTH required, and either one failing is a NO`, () => {
  const corpus = Array.from({ length: CORPUS_SIZE }, (_, i) => ({ phase: `F${i}`, backed: 2 }));
  const adapters = ['mock'];

  /** Build a full corpus of pairs from a per phase (recallA, recallB) list. */
  const build = (pairs) => pairs.flatMap(([phase, a, b]) => ([
    { phase, adapter: 'mock', arm: 'A', completed: true, reason: null, score: { recall: a } },
    { phase, adapter: 'mock', arm: 'B', completed: true, reason: null, score: { recall: b } },
  ]));

  // 1 phase carries the whole effect: the aggregate clears T1, T2 refuses.
  const carried = build(corpus.map((c, i) => (i === 0 ? [c.phase, 1, 0] : [c.phase, 0.5, 0.5])));
  const carriedFold = foldVerdict({ cells: carried, corpus, adapters });
  assert.ok(carriedFold.t1.meanGain >= T1_MIN_MEAN_GAIN, `${P}: the carried fixture did not clear T1`);
  assert.equal(carriedFold.t2.passed, false, `${P}: T2 accepted an effect living in 1 phase of 8`);
  assert.equal(
    carriedFold.verdict,
    'NO',
    `${P}: an aggregate gain carried entirely by 1 phase reported ${carriedFold.verdict}. T2 exists `
    + 'precisely because an aggregate can hide 1 task carrying the whole effect.',
  );

  // Broad but tiny: T2 passes on every phase, T1 refuses.
  const tiny = build(corpus.map((c) => [c.phase, 0.51, 0.5]));
  const tinyFold = foldVerdict({ cells: tiny, corpus, adapters });
  assert.equal(tinyFold.t2.passed, true, `${P}: T2 refused a gain positive on every phase`);
  assert.equal(tinyFold.t1.passed, false, `${P}: T1 accepted a gain under ${T1_MIN_MEAN_GAIN}`);
  assert.equal(tinyFold.verdict, 'NO', `${P}: a gain under the threshold reported ${tinyFold.verdict}`);

  // Both: the only path to YES.
  const both = build(corpus.map((c) => [c.phase, 0.7, 0.5]));
  const bothFold = foldVerdict({ cells: both, corpus, adapters });
  assert.equal(bothFold.verdict, 'YES', `${P}: a broad gain over the threshold reported ${bothFold.verdict}`);
});

test(`${P}: the experiment CAN return YES, so a NO is a result and not a construction`, () => {
  const corpus = Array.from({ length: CORPUS_SIZE }, (_, i) => ({ phase: `F${i}`, backed: 2 }));
  const cells = corpus.flatMap((c) => ([
    { phase: c.phase, adapter: 'mock', arm: 'A', completed: true, reason: null, score: { recall: 1 } },
    { phase: c.phase, adapter: 'mock', arm: 'B', completed: true, reason: null, score: { recall: 0 } },
  ]));
  const fold = foldVerdict({ cells, corpus, adapters: ['mock'] });
  assert.equal(fold.verdict, 'YES', `${P}: a total sweep for arm A reported ${fold.verdict}`);
});

// ─── measurement is measured, and unknown is null ───────────────────────────

test(`${P}: a vendor token count is null when absent, never 0`, () => {
  assert.equal(readReportedTokens('EDGE FX-02 -> FX-01'), null, `${P}: an absent token count was not null`);
  assert.equal(readReportedTokens(''), null, `${P}: empty output did not yield null`);
  assert.equal(readReportedTokens('tokens used: 1,234'), 1234, `${P}: a reported count was not read`);
  assert.equal(readReportedTokens('Total tokens: 900'), 900, `${P}: a reported total was not read`);
});

test(`${P}: derived tokens come from measured bytes at the stated divisor`, () => {
  assert.equal(deriveTokens(0), 0, `${P}: 0 bytes did not derive 0 tokens`);
  assert.equal(deriveTokens(4), 1, `${P}: the divisor changed`);
  assert.equal(deriveTokens(5), 2, `${P}: the derivation does not round up`);
});

test(`${P}: every call records its own wall time and byte counts`, () => {
  const budget = createBudget(2);
  const counting = countingRunner({ status: 0, stdout: 'EDGE FX-02 -> FX-01\n', stderr: '' });
  const cell = invokeCell({
    identity: 'mock', prompt: 'a prompt', budget, seams: SEAMS, run: counting.run, timeoutMs: 1_000, cwd: REPO_ROOT,
  });
  assert.equal(cell.completed, true, `${P}: the control call did not complete`);
  assert.equal(cell.promptBytes, Buffer.byteLength('a prompt', 'utf8'), `${P}: the prompt bytes are wrong`);
  assert.equal(cell.responseBytes, Buffer.byteLength('EDGE FX-02 -> FX-01\n', 'utf8'), `${P}: the response bytes are wrong`);
  assert.equal(typeof cell.wallMs, 'number', `${P}: no wall time was recorded`);
  assert.equal(cell.tokensReported, null, `${P}: an unreported token count was not null`);
});

// ─── the CLI, driven as a real child process ────────────────────────────────

function runCli(argv, extraEnv) {
  return spawnSync(process.execPath, [RUNNER, ...argv], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...(extraEnv || {}) },
  });
}

test(`${P}: no verb prints usage and exits non zero rather than spending`, () => {
  const proc = runCli([]);
  assert.notEqual(proc.status, 0, `${P}: a bare invocation exited 0`);
  assert.match(proc.stderr, /needs a verb/, `${P}: no usage was printed. stderr: ${proc.stderr}`);
  assert.match(proc.stderr, /--live/, `${P}: the usage does not name the spending lane`);
});

test(`${P}: run REFUSES without an explicit lane, so no default spends`, () => {
  for (const argv of [['run'], ['run', '--mock', '--live']]) {
    const proc = runCli(argv);
    assert.notEqual(proc.status, 0, `${P}: '${argv.join(' ')}' exited 0`);
    assert.match(
      proc.stderr,
      /exactly 1 of --mock or --live/,
      `${P}: '${argv.join(' ')}' did not refuse. stderr: ${proc.stderr}`,
    );
  }
});

test(`${P}: the census verb prints the corpus and its key size`, () => {
  const proc = runCli(['census']);
  assert.equal(proc.status, 0, `${P}: census exited ${proc.status}. stderr: ${proc.stderr}`);
  assert.match(proc.stdout, /^corpus: /m, `${P}: census printed no corpus`);
  assert.match(proc.stdout, /^key size: \d+ backed edges$/m, `${P}: census printed no key size`);
});

test(`${P}: the runner completes an end to end pass against the mock adapter at 0 spend`, () => {
  const out = path.join(os.tmpdir(), `ferrox-graph-benefit-${process.pid}-${Date.now()}.json`);
  try {
    const proc = runCli(['run', '--mock', `--out=${out}`]);
    assert.equal(proc.status, 0, `${P}: the mock run exited ${proc.status}. stderr: ${proc.stderr}`);
    assert.match(proc.stdout, /^verdict: (YES|NO|INCONCLUSIVE)$/m, `${P}: no verdict was printed`);
    assert.match(proc.stdout, /^per phase paired delta:$/m, `${P}: no per phase paired delta was printed`);
    assert.match(proc.stdout, /^completion arm A: \d+ complete of \d+ attempted/m, `${P}: no completion counter`);
    assert.match(proc.stdout, /^recorded absences: \d+$/m, `${P}: no absence roster`);
    assert.match(proc.stdout, /derived tokens total: \d+/, `${P}: no derived token total`);

    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(record.cells.length > 0, `${P}: the mock run recorded 0 cells`);
    assert.ok(record.budget.spent <= MAX_CALLS, `${P}: the mock run exceeded the budget`);
    assert.equal(record.stopped, null, `${P}: the mock run stopped early: ${JSON.stringify(record.stopped)}`);
    assert.equal(record.keySize > 0, true, `${P}: the mock run scored against an empty key`);

    // The mock is ARM BLIND, so a correct pipeline must carry that through to NO.
    assert.equal(
      record.fold.t1.meanGain,
      0,
      `${P}: an arm blind adapter produced a non zero gain of ${record.fold.t1.meanGain}. Either the arms `
      + 'are not a controlled pair or the fold is not paired.',
    );
    assert.equal(
      record.fold.verdict,
      'NO',
      `${P}: an arm blind adapter produced ${record.fold.verdict}. The pipeline cannot carry a null result.`,
    );
    for (const arm of ARMS) {
      const completion = record.fold.completion[arm];
      assert.equal(
        completion.completed,
        completion.planned,
        `${P}: arm ${arm} completed ${completion.completed} of ${completion.planned} planned cells`,
      );
    }
  } finally {
    try { fs.unlinkSync(out); } catch { /* the run may not have written it */ }
  }
});

test(`${P}: --limit can only LOWER the budget, never raise it`, () => {
  const raise = readArgv(['run', '--mock', '--limit=9999']);
  assert.equal(raise.limit, '9999', `${P}: the flag was not read`);
  const requested = Number.parseInt(raise.limit, 10);
  assert.equal(
    Math.min(requested, MAX_CALLS),
    MAX_CALLS,
    `${P}: a limit above ${MAX_CALLS} would raise the cap. A flag that can raise a cap is not a cap.`,
  );
  const budget = createBudget(Math.min(requested, MAX_CALLS));
  assert.equal(budget.max, MAX_CALLS, `${P}: the budget was raised above ${MAX_CALLS}`);
});

test(`${P}: the live roster is exactly claude, codex and gemini, and never kimi`, () => {
  assert.deepEqual(
    [...experiment.LIVE_ADAPTERS].sort(),
    ['claude', 'codex', 'gemini'],
    `${P}: the live roster changed`,
  );
  assert.equal(
    experiment.LIVE_ADAPTERS.includes('kimi'),
    false,
    `${P}: kimi entered the roster. It is EXCLUDED per FF-B225 and making it dispatchable needs a byte `
    + 'pinned vendored edit plus a DIVERGENCES re pin.',
  );
});

test(`${P}: the mock runner is arm blind, which is what makes the mock lane honest`, () => {
  const prompt = 'PLAN FX-01\nPLAN FX-02\nPLAN FX-03\n';
  const withGraph = `PRIOR LANDED WORK GRAPH.\nphase 00\n  00-02 depends on 00-01\n${prompt}`;
  assert.deepEqual(
    mockRun('mock', [prompt]).stdout,
    mockRun('mock', [withGraph]).stdout,
    `${P}: the mock adapter answered the 2 arms differently, so the mock lane could manufacture an effect`,
  );
});
