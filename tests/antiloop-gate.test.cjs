'use strict';

/**
 * The anti-loop mechanism, tested as PROPERTIES rather than as functions.
 *
 * On 2026-07-25 all 4 anti-loop mechanisms in this repo were prose, and they
 * failed to stop a live loop. The plans converged 4 to 1 to 0 blockers, 3 more
 * reviewer lineages were then added, the count went back above 20, and a re-plan
 * was proposed. D4 states the consequence: a rule an agent can read and then not
 * follow is not a mechanism. Every test below locks a property that makes 1 of
 * the 3 rules mechanical, so a future edit that turns a rule back into advice is
 * a committed test failure.
 *
 * THE PROPERTIES UNDER LOCK:
 *   1. A gate whose log carries no declared budget for its (artifact, question)
 *      pair cannot open, and a malformed budget refuses rather than falling back.
 *   2. The round count is DERIVED by folding on the normalized pair. Renaming the
 *      gate and swapping the reviewing lineage are no-ops by construction.
 *   3. A finding with an empty reproducible field cannot be marked blocking at
 *      any severity, because the deciding function has no severity parameter.
 *   4. The D8 composition: a security finding is neither gated on reproducibility
 *      nor swept into the backlog when the budget is spent.
 *
 * EVERY TEST RUNS AGAINST THE BUILT LIBS under ferrox-core/bin/lib, never against
 * the TypeScript source. The built artifact is what ships and what plan 04's gate
 * loads; proving the source correct proves nothing about the artifact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  antiloopLogPath,
  appendAntiloopEvent,
  readAntiloopLog,
} = require('../ferrox-core/bin/lib/antiloop-log.cjs');

const gate = require('../ferrox-core/bin/lib/antiloop-gate.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const GATE_LIB_PATH = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'antiloop-gate.cjs');

/** Scratch roots created by these tests, removed by 1 shared cleanup loop. */
const SCRATCH_ROOTS = [];

function tmpLogPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-antiloop-'));
  SCRATCH_ROOTS.push(dir);
  return path.join(dir, name === undefined ? 'antiloop-log.jsonl' : name);
}

test.after(() => {
  for (const root of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* a scratch tree that will not delete is not a test failure */
    }
  }
});

const budgetEvent = {
  ts: '2026-07-26T00:00:00.000Z',
  kind: 'budget-declared',
  artifact: 'phase-15 plans',
  question: 'have these plans been reviewed?',
  max_rounds: 3,
  max_lineages: 1,
};
const roundEvent = {
  ts: '2026-07-26T01:00:00.000Z',
  kind: 'round-opened',
  artifact: 'phase-15 plans',
  question: 'have these plans been reviewed?',
  gate: 'plan-check',
  lineage: 'internal',
};

// ─── the append-only primitive ───────────────────────────────────────────────

test('the log is append-only: a second write leaves the first record byte identical', () => {
  const p = tmpLogPath();
  assert.equal(fs.existsSync(p), false, 'precondition: file absent');

  appendAntiloopEvent(budgetEvent, { path: p });
  assert.equal(fs.existsSync(p), true, 'file created on the first append');
  const afterFirst = fs.readFileSync(p, 'utf8');
  assert.equal(
    afterFirst.split(/\r?\n/).filter((l) => l !== '').length,
    1,
    'exactly 1 JSONL line written',
  );
  assert.ok(afterFirst.endsWith('\n'), 'the line is newline terminated');

  appendAntiloopEvent(roundEvent, { path: p });
  const afterSecond = fs.readFileSync(p, 'utf8');
  assert.ok(
    afterSecond.startsWith(afterFirst),
    'the first record is byte identical after the second write; a rewrite would fail this',
  );

  const entries = readAntiloopLog({ path: p });
  assert.equal(entries.length, 2, 'both records readable');
  assert.deepEqual(entries[0], budgetEvent, 'the first record survives in order');
  assert.deepEqual(entries[1], roundEvent, 'the second record is appended after it');
});

test('a missing parent directory is created rather than throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-antiloop-'));
  SCRATCH_ROOTS.push(root);
  const p = path.join(root, 'nested', 'deeper', 'antiloop-log.jsonl');

  appendAntiloopEvent(budgetEvent, { path: p });

  assert.equal(readAntiloopLog({ path: p }).length, 1, 'the record landed under a created parent');
});

test('an absent opts.path throws and the message names the missing option', () => {
  assert.throws(
    () => appendAntiloopEvent(budgetEvent, {}),
    /path/,
    'appendAntiloopEvent must refuse an unspecified target',
  );
  assert.throws(() => readAntiloopLog({}), /path/, 'readAntiloopLog must refuse the same way');
});

test('a missing log file reads as an empty history, not a throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-antiloop-'));
  SCRATCH_ROOTS.push(root);
  assert.deepEqual(readAntiloopLog({ path: path.join(root, 'absent.jsonl') }), []);
});

test('blank and whitespace-only lines never yield a phantom entry', () => {
  const p = tmpLogPath();
  appendAntiloopEvent(budgetEvent, { path: p });
  fs.appendFileSync(p, '\n\n   \n');

  const entries = readAntiloopLog({ path: p });
  assert.equal(entries.length, 1, 'a trailing newline is not a record');
  assert.deepEqual(entries[0], budgetEvent);
});

test('a carriage-return separated log reads identically to a newline separated one', () => {
  const crlf = tmpLogPath('crlf.jsonl');
  const lf = tmpLogPath('lf.jsonl');
  const body = [JSON.stringify(budgetEvent), JSON.stringify(roundEvent)];
  fs.writeFileSync(crlf, body.join('\r\n') + '\r\n\r\n', 'utf8');
  fs.writeFileSync(lf, body.join('\n') + '\n', 'utf8');

  assert.deepEqual(
    readAntiloopLog({ path: crlf }),
    readAntiloopLog({ path: lf }),
    'src/halting-log.cts:80 splits on a bare newline and gets this wrong; this module must not',
  );
  assert.equal(readAntiloopLog({ path: crlf }).length, 2);
});

test('an unparseable line THROWS naming its 1-based number, so no counter is silently lowered', () => {
  const p = tmpLogPath();
  fs.writeFileSync(p, JSON.stringify(budgetEvent) + '\nnot json\n', 'utf8');

  assert.throws(
    () => readAntiloopLog({ path: p }),
    (e) => /line 2\b/.test(e.message) && e.message.includes(p),
    'the message must name line 2 and the path; a silent skip would drop a round and reset a counter',
  );
});

test('the recorded ts is the caller value, so the module never reads the wall clock', () => {
  const p = tmpLogPath();
  const pinned = '1999-12-31T23:59:59.000Z';
  appendAntiloopEvent({ ...budgetEvent, ts: pinned }, { path: p });

  assert.equal(readAntiloopLog({ path: p })[0].ts, pinned, 'ts round-trips exactly');
});

test('antiloopLogPath resolves to <cwd>/.planning/antiloop-log.jsonl', () => {
  const cwd = path.join(os.tmpdir(), 'some-project');
  assert.equal(antiloopLogPath(cwd), path.join(cwd, '.planning', 'antiloop-log.jsonl'));
});

test('the log module exports exactly its 3 names', () => {
  const lib = require('../ferrox-core/bin/lib/antiloop-log.cjs');
  assert.deepEqual(
    Object.keys(lib).sort(),
    ['antiloopLogPath', 'appendAntiloopEvent', 'readAntiloopLog'],
    'plan 02 writes through this surface and plan 04 reads through it',
  );
});

// ─── RULE 2: the counter binds to the pair, never to the gate ────────────────

const PAIR = { artifact: 'phase-15 plans', question: 'have these plans been reviewed?' };

/** Build a budget-declared event for the shared pair. */
function budget(maxRounds, maxLineages) {
  return { ts: 1, kind: 'budget-declared', ...PAIR, max_rounds: maxRounds, max_lineages: maxLineages };
}

/** Build a round-opened event carrying its gate and lineage as provenance. */
function round(ts, gateId, lineage) {
  return { ts, kind: 'round-opened', ...PAIR, gate: gateId, lineage };
}

test('the counter key normalizes case and whitespace, so 1 pair is 1 counter', () => {
  assert.equal(
    gate.counterKey(PAIR),
    gate.counterKey({ artifact: '  PHASE-15 PLANS ', question: 'Have These Plans Been Reviewed?' }),
    'a pair written with different capitalization is the same question, so it is the same counter',
  );
  assert.notEqual(
    gate.counterKey(PAIR),
    gate.counterKey({ artifact: PAIR.artifact, question: 'are these plans secure?' }),
    'a different question is a different counter; the key must still discriminate',
  );
});

test('the counter key is structurally unable to read gate or lineage', () => {
  assert.equal(
    gate.counterKey(PAIR),
    gate.counterKey({ ...PAIR, gate: 'cross-audit', lineage: 'gemini' }),
    'gate and lineage are provenance fields; adding them must not fork the counter',
  );
  const params = gate.counterKey.toString().slice(
    gate.counterKey.toString().indexOf('(') + 1,
    gate.counterKey.toString().indexOf(')'),
  );
  assert.ok(!/gate|lineage/.test(params), 'the key function takes no gate and no lineage parameter');
});

test('folding an empty event array yields an empty map', () => {
  const pairs = gate.foldAntiloopEvents([]);
  assert.equal(pairs instanceof Map, true, 'the fold returns a map keyed by counter key');
  assert.equal(pairs.size, 0);
  assert.equal(gate.foldAntiloopEvents(undefined).size, 0, 'a non-array input folds to nothing');
});

test('the fold derives the round count and carries the declared budget', () => {
  const pairs = gate.foldAntiloopEvents([
    budget(3, 1),
    round(2, 'plan-check', 'internal'),
    round(3, 'plan-check', 'internal'),
    round(4, 'plan-check', 'internal'),
  ]);
  const state = pairs.get(gate.counterKey(PAIR));
  assert.equal(state.rounds, 3, 'the count is derived from the events, never supplied');
  assert.deepEqual(state.budget, { declared: true, max_rounds: 3, max_lineages: 1 });
  assert.equal(state.lineages.size, 1, '1 distinct reviewing lineage so far');
});

test('THE 2026-07-25 REPLAY: a gate rename plus a lineage swap is round 4, not round 1', () => {
  const events = [
    budget(3, 1),
    round(2, 'plan-check', 'internal'),
    round(3, 'plan-check', 'internal'),
    round(4, 'plan-check', 'internal'),
    round(5, 'cross-audit-round-1', 'gemini'),
  ];
  const state = gate.foldAntiloopEvents(events).get(gate.counterKey(PAIR));

  assert.equal(
    state.rounds,
    4,
    'a gate-keyed counter reports 1 here and permits the open. That IS the 2026-07-25 failure: '
      + 'internal rounds 1 to 3 followed by a freshly named cross-audit read as round 1 again.',
  );
  assert.equal(state.lineages.size, 2, 'the lineage swap is visible as provenance, not as a reset');

  const decision = gate.evaluateGateOpen({ events, ...PAIR });
  assert.equal(decision.rounds, 4, 'the gate sees the same derived count');
  assert.equal(decision.code, 'E_LOOP_BUDGET_SPENT', 'and refuses to open a 4th round on a 3 budget');
  assert.equal(decision.outcome, 'ship-with-backlog');
});

test('the same 5 events under a wider budget permit the open, so the gate discriminates', () => {
  const events = [
    budget(5, 5),
    round(2, 'plan-check', 'internal'),
    round(3, 'plan-check', 'internal'),
    round(4, 'plan-check', 'internal'),
    round(5, 'cross-audit-round-1', 'gemini'),
  ];
  const decision = gate.evaluateGateOpen({ events, ...PAIR });
  assert.equal(decision.rounds, 4, 'the count is unchanged; only the allowance moved');
  assert.equal(decision.decision, 'open-ok', 'a gate stuck red would fail this control');
});

test('reaching the lineage allowance closes the review, so a lineage cannot buy a round', () => {
  const events = [budget(9, 2), round(2, 'g1', 'internal'), round(3, 'g2', 'gemini')];
  const decision = gate.evaluateGateOpen({ events, ...PAIR });
  assert.equal(decision.rounds, 2, 'still well under the 9 round allowance');
  assert.equal(decision.code, 'E_LOOP_BUDGET_SPENT', 'the 2nd distinct lineage spends the budget');
});

// ─── RULE 1: an unbudgeted gate cannot open ──────────────────────────────────

test('a pair with no budget event cannot open', () => {
  const decision = gate.evaluateGateOpen({ events: [round(1, 'plan-check', 'internal')], ...PAIR });
  assert.equal(decision.code, 'E_LOOP_BUDGET_UNDECLARED');
  assert.equal(decision.decision, 'refuse-open');
  assert.equal(decision.outcome, 'stop-and-rescope', 'the fail-closed default of src/gate-cap.cts:34-45');
});

test('5 malformed round allowances all refuse rather than falling back', () => {
  for (const bad of [undefined, -1, 2.5, Infinity, '3', NaN, null]) {
    const decision = gate.evaluateGateOpen({ events: [budget(bad, 1)], ...PAIR });
    assert.equal(
      decision.code,
      'E_LOOP_BUDGET_UNDECLARED',
      `a malformed allowance (${String(bad)}) must refuse. A fallback of 3 passes, which `
        + 'src/gate-command-router.cts:6-8 supplies, would let this through as a real budget.',
    );
    assert.equal(decision.max_rounds, 0, 'the allowance collapses to 0, never to a fallback');
  }
});

test('a budget missing its lineage allowance has not bounded the loop', () => {
  const decision = gate.evaluateGateOpen({
    events: [{ ts: 1, kind: 'budget-declared', ...PAIR, max_rounds: 3 }],
    ...PAIR,
  });
  assert.equal(decision.code, 'E_LOOP_BUDGET_UNDECLARED', 'both allowances are required');
});

test('a budget declared AFTER the first round already ran is a number fitted to the spend', () => {
  const decision = gate.evaluateGateOpen({
    events: [round(1, 'plan-check', 'internal'), budget(9, 9)],
    ...PAIR,
  });
  assert.equal(decision.code, 'E_LOOP_BUDGET_UNDECLARED');
});

test('a second budget declaration cannot raise the allowance mid review', () => {
  const events = [budget(1, 1), round(2, 'g1', 'internal'), budget(99, 99)];
  const decision = gate.evaluateGateOpen({ events, ...PAIR });
  assert.equal(decision.max_rounds, 1, 'the first declaration wins');
  assert.equal(decision.code, 'E_LOOP_BUDGET_SPENT', 're-declaring is the same move as renaming');
});

test('a well formed budget with room permits the open', () => {
  const decision = gate.evaluateGateOpen({ events: [budget(3, 2)], ...PAIR });
  assert.equal(decision.decision, 'open-ok');
  assert.equal(decision.code, null);
});

test('an unknown event kind is counted rather than thrown, so it is visible', () => {
  const pairs = gate.foldAntiloopEvents([budget(3, 1), { ts: 2, kind: 'future-kind', ...PAIR }]);
  const state = pairs.get(gate.counterKey(PAIR));
  assert.deepEqual(state.ignored_kinds, ['future-kind']);
  assert.equal(state.rounds, 0, 'an unknown kind is not a round');
});

// ─── RULE 3: only a reproducible failure blocks ──────────────────────────────

test('an empty reproducible field cannot block at ANY severity', () => {
  for (const severity of ['critical', 'high', 'medium', 'low', undefined]) {
    for (const reproducible of [undefined, '', '   ', null, 7]) {
      const result = gate.evaluateFindingBlocking({
        finding: { finding_id: 'F1', severity, reproducible, reproducible_exit: 1, blocking_requested: true },
      });
      assert.equal(result.blocking, false, `severity ${String(severity)} must buy nothing`);
      assert.equal(result.code, 'E_LOOP_UNREPRODUCIBLE_BLOCKING');
    }
  }
});

test('a failing command blocks at the LOWEST severity, which is rule 3 stated the other way', () => {
  const result = gate.evaluateFindingBlocking({
    finding: {
      finding_id: 'F1',
      severity: 'low',
      reproducible: 'npm test -- --files tests/antiloop-gate.test.cjs',
      reproducible_exit: 1,
    },
  });
  assert.equal(result.blocking, true);
  assert.equal(result.reason, 'reproducible-failure');
});

test('a command that exited 0 is a prediction, so it does not block', () => {
  const result = gate.evaluateFindingBlocking({
    finding: { finding_id: 'F1', severity: 'critical', reproducible: 'npm test', reproducible_exit: 0 },
  });
  assert.equal(result.blocking, false);
  assert.equal(result.reason, 'command-did-not-fail');
});

test('there is nowhere to pass a severity: the absence of the parameter IS the enforcement', () => {
  const src = gate.evaluateFindingBlocking.toString();
  const params = src.slice(src.indexOf('(') + 1, src.indexOf(')'));
  assert.ok(
    !/severity/.test(params),
    'slicing on the closing paren rather than the first brace is load bearing: the destructuring '
      + 'brace form degenerates to the function name and can never match',
  );
  assert.equal(gate.evaluateFindingBlocking.length, 1, 'no second positional parameter either');
});

// ─── D8: the composition with the shipped strength gate ──────────────────────

test('D8: a remaining security finding escalates instead of becoming a backlog row', () => {
  const finding = {
    finding_id: 'F1',
    category: 'security',
    severity: 'low',
    reproducible: '',
    blocking_requested: true,
  };

  const disposition = gate.evaluateBudgetSpentDisposition({
    findings: [finding],
    securityCategories: ['security'],
  });
  assert.equal(
    disposition.outcome,
    'escalate-to-human',
    'sweeping it into the backlog would silently invert STRONG-04, which '
      + 'src/strength-severity-route.cts:77-81 enforces at any severity. Relaxing this half is '
      + 'forbidden by D8.',
  );
  assert.deepEqual(disposition.security_findings, ['F1']);

  assert.equal(
    gate.evaluateFindingBlocking({ finding }).blocking,
    false,
    'and rule 3 is NOT weakened to let it block. Relaxing this half is forbidden by D8 too.',
  );
});

test('D8 control: a non-security finding still ships to the backlog when the budget is spent', () => {
  const disposition = gate.evaluateBudgetSpentDisposition({
    findings: [{ finding_id: 'F1', category: 'correctness', severity: 'high', reproducible: '' }],
    securityCategories: ['security'],
  });
  assert.equal(disposition.outcome, 'ship-with-backlog');
});

test('a blank security category never matches a blank finding category', () => {
  const disposition = gate.evaluateBudgetSpentDisposition({
    findings: [{ finding_id: 'F1', severity: 'high' }],
    securityCategories: ['', '  '],
  });
  assert.equal(disposition.outcome, 'ship-with-backlog');
});

// ─── the budget declared in visible human prose ──────────────────────────────

test('the live phase 15 CONTEXT budget sentence parses without that file being rewritten', () => {
  const contextPath = path.join(
    REPO_ROOT, '.planning', 'phases', '15-prove-the-premise', 'CONTEXT.md',
  );
  const parsed = gate.parseBudgetDeclaration(fs.readFileSync(contextPath, 'utf8'), 'CONTEXT.md');

  assert.notEqual(parsed.ok, false, 'the parser was matched to a sentence a human already wrote');
  assert.equal(parsed.max_rounds, 3, '3 internal checker rounds for planning');
  assert.deepEqual(parsed.allowances[0], { rounds: 3, question: 'planning' });
  assert.equal(parsed.cross_audit_budgeted, false, 'no cross-audit lineage is budgeted');
  assert.equal(
    parsed.max_lineages,
    2,
    'the only PERMITTED lineage is the one running the declared rounds, and an allowance is the '
      + 'count AT WHICH evaluateGateOpen closes, so the allowance is 2. An allowance of 1 would '
      + 'close the review the moment the first reviewer opened its first round.',
  );
  assert.deepEqual(
    parsed.allowances,
    [{ rounds: 3, question: 'planning' }, { rounds: 2, question: 'plan at execution' }],
    'both declared allowances are carried, so a caller selects its own question',
  );
});

test('a lineage allowance of 2 permits the 1 budgeted lineage and closes on a 2nd', () => {
  const withLineage = (lineage) => ({
    ts: '2026-07-26T01:00:00.000Z',
    kind: 'round-opened',
    artifact: 'A',
    question: 'q',
    gate: 'plan-check',
    lineage,
  });
  const budget = {
    ts: '2026-07-26T00:00:00.000Z',
    kind: 'budget-declared',
    artifact: 'A',
    question: 'q',
    max_rounds: 9,
    max_lineages: 2,
  };

  const permitted = gate.evaluateGateOpen({
    events: [budget, withLineage('internal')],
    artifact: 'A',
    question: 'q',
  });
  assert.equal(
    permitted.decision,
    'open-ok',
    'the budgeted lineage must be able to run; this is the off-by-one the battery surfaced',
  );

  const closed = gate.evaluateGateOpen({
    events: [budget, withLineage('internal'), withLineage('gemini')],
    artifact: 'A',
    question: 'q',
  });
  assert.equal(closed.code, 'E_LOOP_BUDGET_SPENT', 'an unbudgeted 2nd lineage closes the review');
});

test('prose carrying no budget sentence is an undeclared budget, not a permissive one', () => {
  const parsed = gate.parseBudgetDeclaration('# A file\n\nNo budget anywhere.\n', 'X.md');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'E_LOOP_BUDGET_UNDECLARED');
});

test('a budget sentence stating rounds but no lineage rule is refused', () => {
  const parsed = gate.parseBudgetDeclaration(
    '**The review budget for this phase is 4 rounds for planning.** Nothing about lineages.',
    'X.md',
  );
  assert.equal(parsed.ok, false, 'adding a reviewer would otherwise be unbounded');
  assert.equal(parsed.code, 'E_LOOP_BUDGET_UNDECLARED');
});

test('parseBudgetDeclaration never throws on hostile input', () => {
  for (const input of [undefined, null, '', 42, {}, '**review budget**']) {
    const parsed = gate.parseBudgetDeclaration(input, 'X.md');
    assert.equal(parsed.ok, false, `input ${String(input)} must return an error, never throw`);
  }
});

// ─── the invariants that keep the mechanism a mechanism ──────────────────────

test('the vocabulary agrees with the shipped gate-cap set, checked rather than commented', () => {
  const capLib = require('../ferrox-core/bin/lib/gate-cap.cjs');
  assert.deepEqual(
    [...gate.ANTILOOP_TERMINAL_OUTCOMES].sort(),
    [...capLib.VALID_CAP_OUTCOMES].sort(),
    '2 counter models in 1 tree must not disagree silently',
  );
  assert.equal(Object.isFrozen(gate.ANTILOOP_TERMINAL_OUTCOMES), true);
  assert.equal(Object.isFrozen(gate.ANTILOOP_ERROR_CODES), true);
});

test('the fold is hermetic: the built lib imports no module at all', () => {
  const source = fs.readFileSync(GATE_LIB_PATH, 'utf8');
  const imports = source.match(/require\(/g);
  assert.equal(
    imports,
    null,
    'importing the gate-cap lib would drag the halting log and its filesystem module into this '
      + 'import graph and destroy the contract that makes the mutation battery deterministic',
  );
});

test('no export lowers a derived count, checked over export NAMES not over file text', () => {
  const offenders = Object.keys(gate).filter((k) => /reset|decrement|clear|setcount|setround/i.test(k));
  assert.deepEqual(offenders, [], 'a count that can be lowered is a count that will be lowered');
});

test('no exported function accepts a round count as an argument', () => {
  for (const [name, value] of Object.entries(gate)) {
    if (typeof value !== 'function') continue;
    const src = value.toString();
    const params = src.slice(src.indexOf('(') + 1, src.indexOf(')'));
    assert.ok(
      !/\brounds?\b|\bpasses\b|\bcount\b/i.test(params),
      `${name} must derive its count, not receive one. src/gate-cap.cts:55 takes passes as a `
        + 'caller-supplied scalar, and whoever calls it can pass 0.',
    );
  }
});

// ─── the mutation battery: 7 committed fixtures, 4 broken on purpose ─────────
//
// A review round ends when a reviewer runs out of things to say, which is why the
// 2026-07-25 loop never terminated. This battery terminates by construction: the
// mutation list is fixed at 7, it is committed, and every case produces a
// reproducible failure rather than an argument. Of the 7, 4 break the artifact
// once per rule and 3 pass it once per rule. A battery in which every case fails
// proves the gate is stuck red rather than that it discriminates, so each mutation
// below is named beside the control that attributes its refusal to the right cause.

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'antiloop');

/** The 7 committed fixtures, read once at module top level. */
const FIXTURES = {
  noBudget: readAntiloopLog({ path: path.join(FIXTURE_DIR, 'no-budget.jsonl') }),
  budgetOk: readAntiloopLog({ path: path.join(FIXTURE_DIR, 'budget-ok.jsonl') }),
  gateRenameReset: readAntiloopLog({ path: path.join(FIXTURE_DIR, 'gate-rename-reset.jsonl') }),
  gateRenameBudget4: readAntiloopLog({ path: path.join(FIXTURE_DIR, 'gate-rename-budget-4.jsonl') }),
  blockingUnreproducible: readAntiloopLog({
    path: path.join(FIXTURE_DIR, 'blocking-unreproducible.jsonl'),
  }),
  blockingReproducible: readAntiloopLog({
    path: path.join(FIXTURE_DIR, 'blocking-reproducible.jsonl'),
  }),
  securityUnreproducible: readAntiloopLog({
    path: path.join(FIXTURE_DIR, 'security-unreproducible.jsonl'),
  }),
};

/** The pair a fixture is about, taken from its own first line rather than restated here. */
function pairOf(events) {
  return { artifact: events[0].artifact, question: events[0].question };
}

/** The findings a fixture files, in log order. */
function findingsOf(events) {
  return events.filter((ev) => ev.kind === 'finding-filed');
}

test('MUTATION 1, rule 1: a log with no budget event anywhere cannot open a gate', () => {
  const events = FIXTURES.noBudget;
  const result = gate.evaluateGateOpen({ events, ...pairOf(events) });

  assert.equal(
    result.code,
    'E_LOOP_BUDGET_UNDECLARED',
    'the mutation removed the allocation, which is the 2026-07-25 condition in which there was '
      + 'always room for 1 more auditor. A gate that falls back to a default allowance returns '
      + 'open-ok here.',
  );
  assert.equal(result.decision, 'refuse-open');
});

test('CONTROL 1, rule 1: the identical log with the budget restored permits the open', () => {
  const events = FIXTURES.budgetOk;
  const result = gate.evaluateGateOpen({ events, ...pairOf(events) });

  assert.equal(
    result.decision,
    'open-ok',
    'without this control the refusal in no-budget.jsonl could come from a gate stuck red',
  );
  assert.equal(result.rounds, 1, 'the 1 round already opened is derived from the log');
});

test('MUTATION 2, rule 2: THE 2026-07-25 REPLAY, a rename plus a lineage swap is round 4', () => {
  const events = FIXTURES.gateRenameReset;
  const result = gate.evaluateGateOpen({ events, ...pairOf(events) });

  assert.equal(
    result.rounds,
    4,
    'a GATE-KEYED counter reports 1 here, because the 4th round carries a different gate name and '
      + 'a different lineage. That is literally what happened on 2026-07-25: internal rounds 1 to '
      + '3 were followed by a cross-audit treated as round 1, the count went back above 20, and a '
      + 're-plan was proposed.',
  );
  assert.equal(
    result.code,
    'E_LOOP_BUDGET_SPENT',
    'a budget of 3 is spent at 4 rounds no matter whose name is on the gate',
  );
  assert.equal(
    result.outcome,
    'ship-with-backlog',
    'a spent budget closes the review rather than granting another round',
  );
});

test('CONTROL 2, rule 2: the identical 5 lines under a wider budget still count 4 and permit', () => {
  const events = FIXTURES.gateRenameBudget4;
  const result = gate.evaluateGateOpen({ events, ...pairOf(events) });

  assert.equal(result.rounds, 4, 'the count is unchanged by the allowance; only the verdict moves');
  assert.equal(
    result.decision,
    'open-ok',
    'so the refusal in gate-rename-reset.jsonl is attributable to the derived count and to '
      + 'nothing else',
  );
});

test('MUTATION 3, rule 3: an empty reproducible field cannot block at the HIGHEST severity', () => {
  const finding = findingsOf(FIXTURES.blockingUnreproducible)[0];
  assert.equal(finding.severity, 'critical', 'the fixture files this at the highest severity');

  const result = gate.evaluateFindingBlocking({ finding });
  assert.equal(
    result.blocking,
    false,
    'severity was never the question. On 2026-07-25 the severity floor did not stop the loop '
      + 'because the findings were genuinely HIGH. A severity-weighted implementation blocks here.',
  );
  assert.equal(result.code, 'E_LOOP_UNREPRODUCIBLE_BLOCKING');
});

test('CONTROL 3, rule 3: a command that failed at filing time blocks at the LOWEST severity', () => {
  const finding = findingsOf(FIXTURES.blockingReproducible)[0];
  assert.equal(finding.severity, 'low', 'the severity inversion against mutation 3 is deliberate');

  assert.equal(
    gate.evaluateFindingBlocking({ finding }).blocking,
    true,
    'the decision is made on reproducibility and never on severity. This pair is the whole '
      + 'discrimination: critical does not block without a run, low does block with one.',
  );
});

test('MUTATION 4, D8: a remaining security finding escalates AND is still non-blocking', () => {
  const findings = findingsOf(FIXTURES.securityUnreproducible);
  assert.equal(findings.length, 1);

  const disposition = gate.evaluateBudgetSpentDisposition({
    findings,
    securityCategories: ['security'],
  });
  assert.equal(
    disposition.outcome,
    'escalate-to-human',
    'the budget-spent sweep must NOT turn a security finding into a backlog row. Doing so '
      + 'silently inverts STRONG-04, which src/strength-severity-route.cts:77-81 enforces at any '
      + 'severity. A naive implementation returns ship-with-backlog here.',
  );

  assert.equal(
    gate.evaluateFindingBlocking({ finding: findings[0] }).blocking,
    false,
    'and rule 3 is not weakened to compensate. Relaxing either half is forbidden by D8.',
  );
});

test('the spent budget in the D8 fixture is derived, not asserted by the fixture', () => {
  const events = FIXTURES.securityUnreproducible;
  const result = gate.evaluateGateOpen({ events, ...pairOf(events) });

  assert.equal(
    result.code,
    'E_LOOP_BUDGET_SPENT',
    'mutation 4 is the budget-spent disposition, so the budget has to actually be spent. If this '
      + 'pair still permitted an open, the escalation above would be testing a state the log '
      + 'never reaches.',
  );
});

test('the battery is exactly 7 fixtures and every one forbids its own repair', () => {
  const files = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.jsonl')).sort();
  assert.equal(
    files.length,
    7,
    'the mutation list is fixed at 7 and committed, which is what makes this battery terminate '
      + 'by construction where a review round does not',
  );

  for (const file of files) {
    const first = readAntiloopLog({ path: path.join(FIXTURE_DIR, file) })[0];
    assert.equal(first.kind, 'fixture-note', `${file} opens with its own provenance line`);
    assert.match(
      String(first.note),
      /never/i,
      `${file} must carry the never-repair instruction INSIDE the file. A future contributor who `
        + 'tidies these silently deletes the battery, so the warning cannot live only in the test.',
    );
    assert.ok(String(first.mutation).length > 0, `${file} names the mutation it carries`);
    assert.ok(String(first.reproduces).length > 0, `${file} names the defect it reproduces`);
  }
});

test('the fixture-note line is ignored by the fold rather than counted as a round', () => {
  const events = FIXTURES.budgetOk;
  const folded = gate.foldAntiloopEvents(events);
  const state = folded.get(gate.counterKey(pairOf(events)));

  assert.equal(state.rounds, 1, 'the note is not a round');
  assert.deepEqual(
    state.ignored_kinds,
    ['fixture-note'],
    'an unknown kind is recorded rather than silently dropped, so a future event kind is visible',
  );
});

test('the battery cannot be defeated by shipping a function that lowers a derived count', () => {
  const offenders = Object.keys(gate).filter((k) => /reset|decrement|clear|setcount|setround/i.test(k));
  assert.deepEqual(
    offenders,
    [],
    'checked over EXPORT NAMES rather than over file text on purpose: a text grep over a file '
      + 'whose own header explains why these concepts are absent would be tripped by the '
      + 'documentation that explains their absence.',
  );
});
