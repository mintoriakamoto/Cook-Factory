'use strict';

/**
 * proof-fold: the properties under lock, not the functions.
 *
 *   - THE PRODUCER IS THE AUTHORITY. The kind vocabulary is read from
 *     `fleet-runlog.cjs` AT RUNTIME and never transcribed. Phase 20 added 2 kinds
 *     after phase 22's CONTEXT was written, so a test carrying a literal kind list
 *     would already be wrong. The bijection test below asserts against the shipped
 *     constant, so the next phase that adds a kind does not turn this file red.
 *   - BOTH FAILURE DIRECTIONS. Every error code is driven by its OWN named
 *     mutation, and the unmutated record is validated clean inside the SAME loop.
 *     A validator that accepts everything fails the mutation half; one that rejects
 *     everything fails the clean half. Neither can satisfy the battery.
 *   - NO GUESS EVER BECOMES A NUMBER. Every fold has a named `unknown` or
 *     `undefined` path and every one of those paths is driven here. A fold observed
 *     only in its known direction is a fold that will silently guess in production,
 *     and the guess points wherever its author expected.
 *   - PROOF CAN RETURN NO. All 4 verdicts and all 6 refusals are driven by name.
 *     NEGATIVE is observed twice, for 2 distinct reasons. Code that is never
 *     observed returning NEGATIVE is code that cannot.
 *   - NO NEGATIVE SENTINEL. An absent index is `null`, never `-1`. A negative
 *     sentinel is a valid argument to `slice`, so it stops being absent the moment
 *     anyone indexes with it.
 *   - HERMETIC. The lib reads no clock. Every instant arrives as a number in an
 *     event, which is what makes all 6 folds deterministic with no environment pin.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB_DIR = path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib');
const LIB_PATH = path.join(LIB_DIR, 'proof-fold.cjs');
const lib = require(LIB_PATH);
const runlog = require(path.join(LIB_DIR, 'fleet-runlog.cjs'));

// ─── the good record ─────────────────────────────────────────────────────────
//
// Every kind this module folds appears at least once, plus the 2 park kinds that
// carry `node_id` and deliberately do NOT carry `attempt_id`. That asymmetry is
// documented at `src/fleet-runlog.cts:132-138` and it is load bearing: a fold
// that assumes every node bearing kind also carries an attempt id is wrong on
// any run that parked a node.

function goodRecord() {
  return [
    {
      ts: 1000, kind: 'run_started', run_id: 'r1', graph_generation: 'g1',
      corpus_hash: 'CORPUS-A', arm: 'serial', provenance: 'measured',
    },
    { ts: 1010, kind: 'claim_acquired', run_id: 'r1', node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
    {
      ts: 1020, kind: 'worker_started', run_id: 'r1', worker_id: 'w1',
      node_id: 'n1', attempt_id: 'a1', lease_epoch: 1,
    },
    { ts: 1030, kind: 'queue_entered', run_id: 'r1', node_id: 'n1', attempt_id: 'a1', ticket: 1 },
    {
      ts: 1040, kind: 'queue_acquired', run_id: 'r1', node_id: 'n1',
      attempt_id: 'a1', ticket: 1, worker_id: 'w1',
    },
    {
      ts: 1050, kind: 'gate_started', run_id: 'r1', node_id: 'n1',
      attempt_id: 'a1', ticket: 1, gate: 'land', concurrency: 1,
    },
    {
      ts: 1090, kind: 'gate_ended', run_id: 'r1', node_id: 'n1',
      attempt_id: 'a1', gate: 'land', verdict: 'green',
    },
    { ts: 1100, kind: 'land_completed', run_id: 'r1', node_id: 'n1', attempt_id: 'a1', result: 'completed' },
    {
      ts: 1110, kind: 'post_land_truth', run_id: 'r1', node_id: 'n1',
      attempt_id: 'a1', classification: 'held',
    },
    {
      ts: 1120, kind: 'worker_ended', run_id: 'r1', worker_id: 'w1',
      node_id: 'n1', attempt_id: 'a1', outcome: 'completed',
    },
    {
      ts: 1130, kind: 'node_parked', run_id: 'r1', node_id: 'n2',
      reason: 'budget', attempts: 3, on_critical_path: false,
    },
    {
      ts: 1140, kind: 'park_alarm', run_id: 'r1', node_id: 'n2', scope: 'node',
      route: 'synchronous', parked_count: 1, budget: 4,
    },
    { ts: 1200, kind: 'run_closed', run_id: 'r1' },
  ];
}

function indexOfKind(rec, kind) {
  const i = rec.findIndex((e) => e && e.kind === kind);
  assert.ok(i >= 0, `fixture is missing kind ${kind}`);
  return i;
}

function dropKind(rec, kind) {
  rec.splice(indexOfKind(rec, kind), 1);
  return rec;
}

// ─── the mutation battery, 1 named mutation per error code ───────────────────
//
// The `E_PR_KIND_UNKNOWN` mutation is deliberately the HYPHENATED spelling the
// superseded CONTEXT D10 declared. The shipped library spells its kinds with
// underscores, so this row is simultaneously the code's driver and the proof
// that the underscored vocabulary is the one enforced.

const MUTATIONS = [
  {
    code: 'E_PR_NOT_ARRAY',
    name: 'the record is an object rather than an array of events',
    apply: () => ({ kind: 'run_started' }),
  },
  {
    code: 'E_PR_EVENT_NOT_OBJECT',
    name: 'an element is the number 42',
    apply: (rec) => { rec[1] = 42; return rec; },
  },
  {
    code: 'E_PR_KIND_MISSING',
    name: 'the claim event carries no kind at all',
    apply: (rec) => { delete rec[1].kind; return rec; },
  },
  {
    code: 'E_PR_KIND_UNKNOWN',
    name: 'a kind spelled with the superseded hyphen, run-started',
    apply: (rec) => { rec[1].kind = 'run-started'; return rec; },
  },
  {
    code: 'E_PR_TS_INVALID',
    name: 'a negative timestamp',
    apply: (rec) => { rec[1].ts = -1; return rec; },
  },
  {
    code: 'E_PR_RUN_NOT_STARTED',
    name: 'the run_started event is removed',
    apply: (rec) => dropKind(rec, 'run_started'),
  },
  {
    code: 'E_PR_RUN_NOT_CLOSED',
    name: 'the run_closed event is removed',
    apply: (rec) => dropKind(rec, 'run_closed'),
  },
  {
    code: 'E_PR_RUN_ID_MIXED',
    name: '2 distinct run_id values in 1 record',
    apply: (rec) => { rec[2].run_id = 'r2'; return rec; },
  },
  {
    code: 'E_PR_ARM_UNKNOWN',
    name: 'the arm is parallel, which is not serial and not fleet',
    apply: (rec) => { rec[0].arm = 'parallel'; return rec; },
  },
  {
    code: 'E_PR_PROVENANCE_UNKNOWN',
    name: 'the provenance is guessed',
    apply: (rec) => { rec[0].provenance = 'guessed'; return rec; },
  },
  {
    code: 'E_PR_CORPUS_HASH_MISSING',
    name: 'run_started carries no corpus_hash',
    apply: (rec) => { delete rec[0].corpus_hash; return rec; },
  },
  {
    code: 'E_PR_ATTEMPT_MISSING',
    name: 'an attempt bearing kind loses its attempt_id',
    apply: (rec) => { delete rec[indexOfKind(rec, 'worker_started')].attempt_id; return rec; },
  },
  {
    code: 'E_PR_WORKER_UNTERMINATED',
    name: 'the only worker_ended is removed, leaving an open interval',
    apply: (rec) => dropKind(rec, 'worker_ended'),
  },
  {
    code: 'E_PR_WORKER_END_UNMATCHED',
    name: 'a worker_ended for a worker that never started',
    apply: (rec) => {
      rec.splice(rec.length - 1, 0, {
        ts: 1150, kind: 'worker_ended', run_id: 'r1', worker_id: 'w9',
        node_id: 'n9', attempt_id: 'a9', outcome: 'completed',
      });
      return rec;
    },
  },
  {
    code: 'E_PR_GATE_END_UNMATCHED',
    name: 'the gate_started is removed, leaving a gate_ended with no start',
    apply: (rec) => dropKind(rec, 'gate_started'),
  },
  {
    code: 'E_PR_QUEUE_ACQUIRED_UNMATCHED',
    name: 'the queue_entered is removed, leaving a queue_acquired with no entry',
    apply: (rec) => dropKind(rec, 'queue_entered'),
  },
  {
    code: 'E_PR_OUTCOME_UNKNOWN',
    name: 'a gate verdict of yellow, outside the closed green red unknown enum',
    apply: (rec) => { rec[indexOfKind(rec, 'gate_ended')].verdict = 'yellow'; return rec; },
  },
  {
    code: 'E_PR_TS_NON_MONOTONIC',
    name: 'an event whose ts precedes the run_started ts',
    apply: (rec) => { rec[3].ts = 500; return rec; },
  },
];

// ─── task 1: the schema and its 18 codes ─────────────────────────────────────

test('the good record validates with 0 errors and every mutation is rejected with its own code', () => {
  // The non-zero count assertion comes FIRST. "every mutation was driven" is
  // vacuously true of an empty table, so the count is asserted before the loop
  // rather than inferred from it not throwing.
  assert.ok(MUTATIONS.length > 0, 'the mutation table is not empty');
  assert.equal(MUTATIONS.length, Object.keys(lib.PROOF_CODES).length);

  let cleanRuns = 0;
  let rejectedRuns = 0;

  for (const mutation of MUTATIONS) {
    // The clean half, inside the same loop as the mutated half. A validator that
    // rejects everything cannot get past this assertion.
    const clean = lib.validateRunRecord(goodRecord());
    assert.equal(clean.ok, true, `the unmutated record must validate clean (checked beside ${mutation.code})`);
    assert.deepEqual(clean.errors, [], `the unmutated record yields 0 errors (checked beside ${mutation.code})`);
    cleanRuns += 1;

    const mutated = lib.validateRunRecord(mutation.apply(goodRecord()));
    assert.equal(mutated.ok, false, `${mutation.code}: ${mutation.name} must be rejected`);
    const codes = mutated.errors.map((e) => e.code);
    assert.ok(
      codes.includes(mutation.code),
      `${mutation.code}: ${mutation.name} must produce its OWN code, got ${JSON.stringify(codes)}`,
    );
    rejectedRuns += 1;
  }

  // Counters, never flags. A validator that reported a refusal and validated
  // anyway would satisfy a boolean and fail these 2 numbers.
  assert.equal(cleanRuns, MUTATIONS.length);
  assert.equal(rejectedRuns, MUTATIONS.length);
});

test('the exported code list and the mutation table agree as sets, in both directions', () => {
  const exported = new Set(Object.keys(lib.PROOF_CODES));
  const driven = new Set(MUTATIONS.map((m) => m.code));

  assert.ok(exported.size > 0, 'the module exports at least 1 code');

  const undriven = [...exported].filter((c) => !driven.has(c));
  const unpaired = [...driven].filter((c) => !exported.has(c));

  assert.deepEqual(undriven, [], 'every exported code is driven by a mutation');
  assert.deepEqual(unpaired, [], 'every mutation drives an exported code');

  // Every code's value equals its key, so a caller can never branch on a typo
  // that silently resolves to undefined.
  for (const key of exported) assert.equal(lib.PROOF_CODES[key], key);
});

test('an event scoped error carries the 0 based index and a record scoped one carries null, never -1', () => {
  assert.ok(Object.keys(lib.PROOF_CODE_SCOPE).length > 0, 'the scope table is not empty');

  let eventScoped = 0;
  let recordScoped = 0;

  for (const mutation of MUTATIONS) {
    const record = mutation.apply(goodRecord());
    const result = lib.validateRunRecord(record);
    const error = result.errors.find((e) => e.code === mutation.code);
    assert.ok(error, `${mutation.code} produced no error to inspect`);

    const scope = lib.PROOF_CODE_SCOPE[mutation.code];
    if (scope === 'event') {
      assert.equal(typeof error.index, 'number', `${mutation.code} carries a numeric index`);
      assert.ok(error.index >= 0, `${mutation.code} index is 0 based and never a negative sentinel`);
      assert.ok(error.index < record.length, `${mutation.code} index is inside the record`);
      eventScoped += 1;
    } else {
      assert.equal(scope, 'record', `${mutation.code} has a declared scope`);
      assert.equal(error.index, null, `${mutation.code} carries an explicit null, never -1`);
      recordScoped += 1;
    }
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0, `${mutation.code} carries a human readable message`);
  }

  assert.ok(eventScoped > 0, 'at least 1 code is event scoped');
  assert.ok(recordScoped > 0, 'at least 1 code is record scoped');
  assert.equal(eventScoped + recordScoped, MUTATIONS.length);
});

test('the validator never throws on an array of junk', () => {
  let result;
  assert.doesNotThrow(() => {
    result = lib.validateRunRecord([null, 42, 'a string', { no: 'kind' }, [], undefined]);
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0, 'junk is reported rather than swallowed');
  for (const error of result.errors) {
    assert.ok(error.index === null || Number.isInteger(error.index));
    assert.ok(error.index === null || error.index >= 0, 'no negative index sentinel escapes');
  }
});

test('the kind vocabulary is read from the shipped library and is never transcribed here', () => {
  // The shipped constant is the authority. This asserts adoption without naming a
  // single kind, so the next phase that adds one does not turn this file red.
  assert.ok(runlog.FLEET_EVENT_KINDS.length > 0);
  assert.deepEqual([...lib.PROOF_EVENT_KINDS], [...runlog.FLEET_EVENT_KINDS]);

  // Every shipped kind is accepted by the validator's kind check. Driven from the
  // shipped list, so a kind added later is covered without editing this test.
  let checked = 0;
  for (const kind of runlog.FLEET_EVENT_KINDS) {
    const errors = lib.validateRunRecord([{ ts: 1, kind, run_id: 'r1' }]).errors;
    assert.ok(
      !errors.some((e) => e.code === 'E_PR_KIND_UNKNOWN'),
      `the shipped kind ${kind} must not be reported as unknown`,
    );
    checked += 1;
  }
  assert.equal(checked, runlog.FLEET_EVENT_KINDS.length);
  assert.ok(checked > 0, 'a vocabulary of 0 kinds would pass the loop above vacuously');
});

test('the park kinds carry a node with no attempt and do not trip the attempt check', () => {
  // `node_parked` and `park_alarm` carry `node_id` and deliberately carry no
  // `attempt_id`. The attempt bearing set is DERIVED from the shipped required
  // field map, so this asymmetry is honoured without being restated.
  const record = goodRecord();
  const result = lib.validateRunRecord(record);
  assert.equal(result.ok, true);

  const parkKinds = ['node_parked', 'park_alarm'];
  let observed = 0;
  for (const kind of parkKinds) {
    assert.ok(runlog.FLEET_EVENT_KINDS.includes(kind), `${kind} is still a shipped kind`);
    const fields = runlog.FLEET_EVENT_REQUIRED_FIELDS[kind];
    assert.ok(fields.includes('node_id'), `${kind} carries node_id`);
    assert.ok(!fields.includes('attempt_id'), `${kind} carries no attempt_id`);
    assert.ok(!lib.PROOF_ATTEMPT_KINDS.has(kind), `${kind} is outside the attempt bearing set`);
    observed += 1;
  }
  assert.equal(observed, parkKinds.length);

  // The positive direction: a kind that DOES carry an attempt is in the set, so
  // the assertion above is not passing because the set is empty.
  assert.ok(lib.PROOF_ATTEMPT_KINDS.size > 0);
  assert.ok(lib.PROOF_ATTEMPT_KINDS.has('worker_started'));
});

test('the module reads no clock and spawns no child process', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  for (const forbidden of ['Date.now', 'new Date', 'hrtime', 'child_process', 'process.exit']) {
    assert.ok(!src.includes(forbidden), `the built artifact must not reference ${forbidden}`);
  }
  // The positive direction: the grep above is only meaningful if the file has
  // content to grep. An empty file passes every "does not include" assertion.
  assert.ok(src.length > 2000, 'the built artifact is non trivial');
});

// ─── task 2 builders ─────────────────────────────────────────────────────────

const SCRATCH_ROOTS = [];

function scratchLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-fold-'));
  SCRATCH_ROOTS.push(dir);
  const file = path.join(dir, 'antiloop-log.jsonl');
  fs.writeFileSync(file, lines.length === 0 ? '' : lines.join('\n') + '\n');
  return file;
}

const RUN_START_TS = 1000;
const RUN_CLOSE_TS = 9000;

function framed(events, over) {
  return [
    Object.assign({
      ts: RUN_START_TS, kind: 'run_started', run_id: 'r1', graph_generation: 'g1',
      corpus_hash: 'CORPUS-A', arm: 'fleet', provenance: 'measured',
    }, over),
    ...events,
    { ts: RUN_CLOSE_TS, kind: 'run_closed', run_id: 'r1' },
  ];
}

function workerPair(id, startTs, endTs, outcome) {
  const base = { run_id: 'r1', worker_id: `w${id}`, node_id: `n${id}`, attempt_id: `a${id}` };
  return [
    Object.assign({ ts: startTs, kind: 'worker_started', lease_epoch: 1 }, base),
    Object.assign({ ts: endTs, kind: 'worker_ended', outcome: outcome || 'completed' }, base),
  ];
}

function gatePair(attempt, startTs, endTs, concurrency, gate) {
  const base = { run_id: 'r1', node_id: `n-${attempt}`, attempt_id: attempt };
  const named = gate === undefined ? {} : { gate };
  return [
    Object.assign({ ts: startTs, kind: 'gate_started', concurrency }, base, named),
    Object.assign({ ts: endTs, kind: 'gate_ended', verdict: 'green' }, base, named),
  ];
}

function landed(n, firstTs, step, extra) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(Object.assign({
      ts: firstTs + i * step, kind: 'land_completed', run_id: 'r1',
      node_id: `n${i}`, attempt_id: `a${i}`, result: 'completed',
    }, extra || {}));
  }
  return out;
}

function truths(n, firstTs, step, classification) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      ts: firstTs + i * step, kind: 'post_land_truth', run_id: 'r1',
      node_id: `n${i}`, attempt_id: `a${i}`, classification,
    });
  }
  return out;
}

// ─── task 2: demonstrated width ──────────────────────────────────────────────

test('width folds to 3 from 3 overlapping CLOSED worker intervals', () => {
  const record = framed([
    ...workerPair(1, 1010, 1900),
    ...workerPair(2, 1020, 1800),
    ...workerPair(3, 1030, 1700),
  ]);
  assert.equal(lib.validateRunRecord(record).ok, true, 'the fixture is a valid record');

  const width = lib.foldDemonstratedWidth(record);
  assert.equal(width.state, lib.METRIC_STATES.KNOWN);
  assert.equal(width.value, 3);
  assert.equal(width.unit, 'workers');
});

test('width is an explicit UNKNOWN for an unterminated interval, and is neither 3 nor 2', () => {
  const record = framed([
    ...workerPair(1, 1010, 1900),
    ...workerPair(2, 1020, 1800),
    ...workerPair(3, 1030, 1700),
  ]);
  // Drop worker 3's end event, leaving 1 interval open.
  const endIndex = record.findIndex((e) => e.kind === 'worker_ended' && e.worker_id === 'w3');
  assert.ok(endIndex > 0, 'the fixture carries the end event this test removes');
  record.splice(endIndex, 1);

  const width = lib.foldDemonstratedWidth(record);
  assert.equal(width.state, lib.METRIC_STATES.UNKNOWN);
  assert.equal(width.value, null);

  // The 2 numbers a guessing fold would produce, excluded by name.
  //   3: a fold that closes the dangling interval at run end.
  //   2: a fold that silently drops the dangling interval.
  // Manufacturing a positive result is easiest through the first of those.
  assert.notEqual(width.value, 3, 'a fold that closed the dangling interval at run end would say 3');
  assert.notEqual(width.value, 2, 'a fold that dropped the dangling interval would say 2');

  assert.match(width.reason, /1 /, 'the reason carries the count of unterminated intervals');
  assert.match(width.reason, /unterminated/i);

  // The validator reports the same fact independently. Reporting it in 1 place
  // only would let a caller that skips validation receive an inflated width.
  const errors = lib.validateRunRecord(record).errors.map((e) => e.code);
  assert.ok(errors.includes('E_PR_WORKER_UNTERMINATED'));
});

test('a worker_ended with outcome abnormal CLOSES its interval and yields a known width', () => {
  // A recorded abnormal exit is knowledge. An exit that was never recorded is not.
  const record = framed([
    ...workerPair(1, 1010, 1900),
    ...workerPair(2, 1020, 1800, 'abnormal'),
  ]);
  assert.ok(lib.WORKER_OUTCOMES.includes('abnormal'), 'abnormal is in the shipped outcome enum');
  assert.equal(lib.validateRunRecord(record).ok, true);

  const width = lib.foldDemonstratedWidth(record);
  assert.equal(width.state, lib.METRIC_STATES.KNOWN);
  assert.equal(width.value, 2);
});

test('width over 0 worker intervals is UNDEFINED, never a value of 0', () => {
  const width = lib.foldDemonstratedWidth(framed([]));
  assert.equal(width.state, lib.METRIC_STATES.UNDEFINED);
  assert.equal(width.value, null);
  assert.notEqual(width.value, 0, 'a maximum over 0 intervals is not a width of 0');
});

// ─── task 2: false green rate ────────────────────────────────────────────────

test('false green is 0.4 for a record whose every gate was GREEN', () => {
  // 5 landed increments, 5 classifications, 2 of them false_green, and every
  // gate_ended green. A rate computed from gate outcomes alone reads 0 here.
  const record = framed([
    ...gatePair('a0', 1100, 1150, 1),
    ...gatePair('a1', 1200, 1250, 1),
    ...gatePair('a2', 1300, 1350, 1),
    ...gatePair('a3', 1400, 1450, 1),
    ...gatePair('a4', 1500, 1550, 1),
    ...landed(5, 2000, 100),
    ...truths(2, 3000, 100, 'false_green'),
    ...truths(3, 3200, 100, 'held').map((e, i) => Object.assign(e, {
      node_id: `n${i + 2}`, attempt_id: `a${i + 2}`,
    })),
  ]);

  const gateVerdicts = record.filter((e) => e.kind === 'gate_ended').map((e) => e.verdict);
  assert.ok(gateVerdicts.length > 0, 'the record carries gates to be green');
  assert.deepEqual([...new Set(gateVerdicts)], ['green'], 'every gate in this record was green');

  const rate = lib.foldFalseGreenRate(record);
  assert.equal(rate.state, lib.METRIC_STATES.KNOWN);
  assert.equal(rate.value, 0.4);
  assert.equal(rate.unit, 'ratio');
});

test('false green with 0 post land classifications is UNDEFINED and the value is not 0', () => {
  const record = framed(landed(5, 2000, 100));
  const rate = lib.foldFalseGreenRate(record);

  assert.equal(rate.state, lib.METRIC_STATES.UNDEFINED);
  assert.equal(rate.value, null);
  assert.notEqual(rate.value, 0, 'a rate of 0 and a rate nobody measured are different claims');
  assert.match(rate.reason, /0 post_land_truth/);
});

test('false green with fewer classifications than landed is UNKNOWN with the shortfall named', () => {
  const record = framed([
    ...landed(5, 2000, 100),
    ...truths(3, 3000, 100, 'held'),
  ]);
  const rate = lib.foldFalseGreenRate(record);

  assert.equal(rate.state, lib.METRIC_STATES.UNKNOWN);
  assert.equal(rate.value, null);
  assert.match(rate.reason, /shortfall of 2/);
});

// ─── gap closure: the unmeasured false green guard ───────────────────────────
//
// The battery originally proved this guard against exactly 1 mutant: a record
// carrying 0 post_land_truth events. No emitter produces that shape.
// `scripts/fleet-loop.cjs:1957` sets `let classification = 'unknown'` inside a
// finally, so EVERY landed attempt gets a post_land_truth, and `verifyPostLand`
// at :1768 defaults to null with no CLI path setting it. So on a real run the
// record carries a FULL set of truths whose every value is the literal 'unknown'.
//
// The loop spells "nobody measured" as a VALUE, not as an absence, and a guard
// that only tests the absence cannot fire on the shape the producer emits.

function landAndTruth(n, classification, result) {
  const events = [];
  for (let i = 0; i < n; i++) {
    const node_id = `n-${i}`;
    const attempt_id = `a-${i}`;
    events.push({
      ts: 2000 + i, kind: 'land_completed', run_id: 'r1',
      node_id, attempt_id, result: result || 'completed',
    });
    if (classification !== null) {
      events.push({
        ts: 3000 + i, kind: 'post_land_truth', run_id: 'r1',
        node_id, attempt_id, classification,
      });
    }
  }
  return events;
}

test('an all unknown record is NOT known: the loop spells unmeasured as a VALUE', () => {
  // This is the shape scripts/fleet-loop.cjs emits on every real run today.
  const rate = lib.foldFalseGreenRate(framed(landAndTruth(5, 'unknown')));

  assert.notEqual(
    rate.state, lib.METRIC_STATES.KNOWN,
    'a run that classified nothing must not report a measured rate',
  );
  assert.equal(rate.state, lib.METRIC_STATES.UNDEFINED);
  assert.equal(rate.value, null);
  assert.notEqual(rate.value, 0, 'a fabricated 0 would clear the D8 POSITIVE gate');

  // The reason must distinguish this from the 0 classifications case. They are
  // different facts about the run: nothing was recorded, versus 5 things were
  // recorded and every one of them declined to decide.
  assert.match(rate.reason, /5/, 'the reason names how many undecided classifications there were');
  assert.match(rate.reason, /undecided/i);
});

test('a measured arm and a verified nothing arm are NOT byte identical', () => {
  // The defect made these 2 indistinguishable, both known 0. A fleet that
  // verified nothing would then clear the 0.1 threshold against a serial arm
  // whose rate came from a real hidden gate.
  const measured = lib.foldFalseGreenRate(framed(landAndTruth(5, 'held')));
  const verifiedNothing = lib.foldFalseGreenRate(framed(landAndTruth(5, 'unknown')));

  assert.notDeepEqual(
    { state: measured.state, value: measured.value },
    { state: verifiedNothing.state, value: verifiedNothing.value },
    'a measured arm and an arm that verified nothing must be distinguishable',
  );

  // The positive control, which stops the repair being the degenerate one that
  // makes everything undefined.
  assert.equal(measured.state, lib.METRIC_STATES.KNOWN, 'an all held record is a real measurement');
  assert.equal(measured.value, 0, 'and its rate is a real 0');
});

test('the 0 classifications reason and the all undecided reason are different facts', () => {
  const none = lib.foldFalseGreenRate(framed(landAndTruth(5, null)));
  const undecided = lib.foldFalseGreenRate(framed(landAndTruth(5, 'unknown')));

  assert.equal(none.state, lib.METRIC_STATES.UNDEFINED);
  assert.equal(undecided.state, lib.METRIC_STATES.UNDEFINED);
  assert.notEqual(none.reason, undecided.reason, 'the 2 cases report different reasons');
  assert.match(none.reason, /0 post_land_truth/);
});

test('a partly decided record still reports the shortfall against DECIDED, not raw truths', () => {
  // 5 landed. 2 decided held, 3 undecided. A guard counting raw truths sees 5
  // and reports known; the shortfall is really 3.
  const events = [
    ...landAndTruth(2, 'held'),
    ...landAndTruth(3, 'unknown').map((e, i) => Object.assign(e, {
      node_id: `n-x${i}`, attempt_id: `a-x${i}`,
    })),
  ];
  const rate = lib.foldFalseGreenRate(framed(events));

  assert.equal(rate.state, lib.METRIC_STATES.UNKNOWN);
  assert.equal(rate.value, null);
  assert.match(rate.reason, /shortfall of 3/);
});

test('false_green is still counted when the decided set is complete', () => {
  // The numerator must survive the partition. 5 landed, 5 decided, 2 false_green.
  const events = [
    ...landAndTruth(2, 'false_green'),
    ...landAndTruth(3, 'held').map((e, i) => Object.assign(e, {
      node_id: `n-h${i}`, attempt_id: `a-h${i}`,
    })),
  ];
  const rate = lib.foldFalseGreenRate(framed(events));

  assert.equal(rate.state, lib.METRIC_STATES.KNOWN);
  assert.equal(rate.value, 0.4);
});

// ─── gap closure: a failed land is not a landed increment ────────────────────
//
// `src/fleet-landqueue.cts:561` emits land_completed from a finally, so a land
// that aborted, was reclaimed or was abandoned still produces one. Counting
// those inflates the denominator of BOTH the false green rate and cost per
// landed increment, which moves both in the FLATTERING direction.

test('an aborted land is not a landed increment', () => {
  // 3 completed and 2 aborted. A fold counting every land_completed sees a
  // denominator of 5, which understates the false green rate.
  const events = [
    ...landAndTruth(3, 'false_green', 'completed'),
    ...landAndTruth(2, 'held', 'aborted').map((e, i) => Object.assign(e, {
      node_id: `n-ab${i}`, attempt_id: `a-ab${i}`,
    })),
  ];
  const rate = lib.foldFalseGreenRate(framed(events));

  assert.equal(rate.state, lib.METRIC_STATES.KNOWN);
  assert.equal(rate.value, 1, '3 false_green over 3 genuinely landed increments, not over 5');
  assert.notEqual(rate.value, 0.6, 'a denominator of 5 would report 0.6 and flatter the run');
});

test('the landed and not landed result families are driven from the module', () => {
  assert.ok(lib.LAND_RESULTS_LANDED.length > 0);
  assert.ok(lib.LAND_RESULTS_NOT_LANDED.length > 0);

  // Every family the shipped emitter can write is classified one way or the
  // other, so none of them falls into the unrecognised bucket.
  const shipped = ['completed', 'landed', 'aborted', 'reclaimed', 'abandoned', 'unknown'];
  let checked = 0;
  for (const family of shipped) {
    const known = lib.LAND_RESULTS_LANDED.includes(family) || lib.LAND_RESULTS_NOT_LANDED.includes(family);
    assert.ok(known, `the shipped result family ${family} must be classified`);
    checked += 1;
  }
  assert.equal(checked, shipped.length);
  assert.ok(checked > 0, 'a family list of 0 would pass the loop above vacuously');
});

test('a prefixed result is classified by its family, so aborted:exit-3 is not landed', () => {
  // src/fleet-landqueue.cts:862 writes `aborted:exit-${code}` and :770 writes
  // `abandoned:${lastCode}`, so the value carries a suffix the family does not.
  const events = [
    ...landAndTruth(2, 'held', 'landed'),
    ...landAndTruth(1, 'held', 'aborted:exit-3').map((e) => Object.assign(e, {
      node_id: 'n-p0', attempt_id: 'a-p0',
    })),
    ...landAndTruth(1, 'held', 'abandoned:7').map((e) => Object.assign(e, {
      node_id: 'n-p1', attempt_id: 'a-p1',
    })),
  ];
  const rate = lib.foldFalseGreenRate(framed(events));

  assert.equal(rate.state, lib.METRIC_STATES.KNOWN);
  assert.equal(rate.value, 0, '2 landed, both held');
  assert.match(rate.reason, /2 landed/, 'the denominator is named so it can be checked by hand');
});

test('an UNRECOGNISED result is reported, never silently included or excluded', () => {
  // `_normaliseOutcome` at src/fleet-landqueue.cts:866-873 passes ANY string
  // through as the result, so a custom land seam can invent one. The reader
  // genuinely cannot tell whether that increment landed, and guessing either way
  // is what this module refuses to do everywhere else.
  const rate = lib.foldFalseGreenRate(framed(landAndTruth(3, 'held', 'ok')));

  assert.equal(rate.state, lib.METRIC_STATES.UNKNOWN);
  assert.equal(rate.value, null);
  assert.match(rate.reason, /unrecognised/i);
  assert.match(rate.reason, /ok/, 'the offending value is named so it can be repaired');
});

test('cost per landed increment uses the same landed denominator', () => {
  // 2 completed and 2 aborted, 1 usd each. A denominator of 4 reports 1; the
  // honest answer over 2 genuinely landed increments is 2.
  const events = [
    ...landAndTruth(2, 'held', 'completed').map((e) => (
      e.kind === 'land_completed' ? Object.assign(e, { usd: 1 }) : e
    )),
    ...landAndTruth(2, 'held', 'aborted').map((e, i) => Object.assign(e, {
      node_id: `n-c${i}`, attempt_id: `a-c${i}`,
    })).map((e) => (e.kind === 'land_completed' ? Object.assign(e, { usd: 1 }) : e)),
  ];
  const cost = lib.foldCostPerLandedIncrement(framed(events));

  assert.equal(cost.state, lib.METRIC_STATES.KNOWN);
  assert.equal(cost.value, 2, '4 usd over 2 genuinely landed increments');
  assert.notEqual(cost.value, 1, 'a denominator of 4 would report 1 and flatter the run');
});

test('wall clock takes the maximum over LANDED increments only', () => {
  // The aborted land is the latest event in the record. Counting it would
  // stretch the wall clock past the last real landing.
  const events = [
    { ts: 4000, kind: 'land_completed', run_id: 'r1', node_id: 'n1', attempt_id: 'a1', result: 'completed' },
    { ts: 8000, kind: 'land_completed', run_id: 'r1', node_id: 'n2', attempt_id: 'a2', result: 'aborted' },
  ];
  const wall = lib.foldWallClockToLand(framed(events));

  assert.equal(wall.state, lib.METRIC_STATES.KNOWN);
  assert.equal(wall.value, 3000, '4000 minus the run_started ts of 1000');
  assert.notEqual(wall.value, 7000, 'counting the aborted land would report 7000');
});

test('a run whose every land aborted landed nothing', () => {
  const wall = lib.foldWallClockToLand(framed(landAndTruth(3, 'held', 'aborted')));
  assert.equal(wall.state, lib.METRIC_STATES.UNDEFINED);
  assert.match(wall.reason, /landed nothing/);
});

// ─── task 2: land gate cost ──────────────────────────────────────────────────

test('gate cost is a curve over concurrency, sorted ascending, never a single average', () => {
  const record = framed([
    ...gatePair('c1-x', 2000, 2100, 1),
    ...gatePair('c2-x', 3000, 3200, 2),
    ...gatePair('c2-y', 3000, 3400, 2),
    ...gatePair('c4-x', 4000, 4600, 4),
    ...gatePair('c4-y', 4000, 4800, 4),
    ...gatePair('c4-z', 4000, 5000, 4),
  ]);
  assert.equal(lib.validateRunRecord(record).ok, true);

  const cost = lib.foldLandGateCost(record);
  assert.equal(cost.state, lib.METRIC_STATES.KNOWN);
  assert.deepEqual(cost.buckets.map((b) => b.concurrency), [1, 2, 4], 'buckets ascend by concurrency');
  assert.deepEqual(cost.buckets.map((b) => b.n), [1, 2, 3]);
  assert.deepEqual(cost.buckets.map((b) => b.median_ms), [100, 300, 800]);
  assert.deepEqual(cost.buckets.map((b) => b.max_ms), [100, 400, 1000]);
  assert.equal(cost.baseline_ms, 100, 'the baseline is the median of the concurrency 1 bucket');
  assert.equal(cost.degradation, 8, 'the highest populated bucket over the baseline');
});

test('gate durations survive interleaved concurrent gates because matching is by attempt', () => {
  // Event order interleaves 3 gates. A matcher that pairs by order of appearance
  // reads medians 300 and max 600; the correct answer is median 100 and max 900.
  const record = framed([
    { ts: 2000, kind: 'gate_started', run_id: 'r1', node_id: 'nx', attempt_id: 'ax', concurrency: 3 },
    { ts: 2100, kind: 'gate_started', run_id: 'r1', node_id: 'ny', attempt_id: 'ay', concurrency: 3 },
    { ts: 2200, kind: 'gate_ended', run_id: 'r1', node_id: 'ny', attempt_id: 'ay', verdict: 'green' },
    { ts: 2300, kind: 'gate_started', run_id: 'r1', node_id: 'nz', attempt_id: 'az', concurrency: 3 },
    { ts: 2400, kind: 'gate_ended', run_id: 'r1', node_id: 'nz', attempt_id: 'az', verdict: 'green' },
    { ts: 2900, kind: 'gate_ended', run_id: 'r1', node_id: 'nx', attempt_id: 'ax', verdict: 'green' },
  ]);
  assert.equal(lib.validateRunRecord(record).ok, true);

  const cost = lib.foldLandGateCost(record);
  assert.equal(cost.state, lib.METRIC_STATES.KNOWN);
  assert.equal(cost.buckets.length, 1);
  assert.equal(cost.buckets[0].n, 3);
  assert.equal(cost.buckets[0].median_ms, 100, 'an order based matcher would read 300 here');
  assert.equal(cost.buckets[0].max_ms, 900, 'an order based matcher would read 600 here');
});

test('gate cost is UNKNOWN when a gate_ended has no matching start', () => {
  const record = framed([
    ...gatePair('c1-x', 2000, 2100, 1),
    ...gatePair('c1-y', 2200, 2300, 1),
  ]);
  const startIndex = record.findIndex((e) => e.kind === 'gate_started' && e.attempt_id === 'c1-y');
  assert.ok(startIndex > 0);
  record.splice(startIndex, 1);

  const cost = lib.foldLandGateCost(record);
  assert.equal(cost.state, lib.METRIC_STATES.UNKNOWN);
  assert.deepEqual(cost.buckets, []);
  assert.equal(cost.baseline_ms, null);
  assert.equal(cost.degradation, null);
  assert.match(cost.reason, /unmatched/i);
});

test('gate cost is UNKNOWN when the emitter records no concurrency on a gate_started', () => {
  // The shipped emitter at src/fleet-landqueue.cts:901-908 writes no concurrency
  // field. That is not a defect to paper over: whether the gate degrades under
  // contention is exactly the question, and a record that never says how many
  // gates were in flight cannot answer it. Reporting a number here would be an
  // average over a concurrency nobody measured.
  const record = framed([
    { ts: 2000, kind: 'gate_started', run_id: 'r1', node_id: 'nx', attempt_id: 'ax', ticket: 1 },
    { ts: 2100, kind: 'gate_ended', run_id: 'r1', node_id: 'nx', attempt_id: 'ax', verdict: 'green' },
  ]);
  assert.equal(lib.validateRunRecord(record).ok, true, 'the record is schema valid; only the metric is not computable');

  const cost = lib.foldLandGateCost(record);
  assert.equal(cost.state, lib.METRIC_STATES.UNKNOWN);
  assert.match(cost.reason, /concurrency/);
  assert.deepEqual(cost.buckets, []);
});

test('gate cost over 0 closed gate intervals is UNKNOWN, never an empty curve reported as known', () => {
  const cost = lib.foldLandGateCost(framed([]));
  assert.equal(cost.state, lib.METRIC_STATES.UNKNOWN);
  assert.deepEqual(cost.buckets, []);
  assert.match(cost.reason, /0 closed gate intervals/);
});

// ─── task 2: wall clock ──────────────────────────────────────────────────────

test('wall clock takes the MAXIMUM land timestamp, not the last land event in the array', () => {
  // The land events are deliberately out of ascending order. A fold that reads
  // the last element rather than the maximum reads 3000 minus 1000 and is wrong.
  const record = framed([
    { ts: 5000, kind: 'land_completed', run_id: 'r1', node_id: 'n1', attempt_id: 'a1', result: 'completed' },
    { ts: 8000, kind: 'land_completed', run_id: 'r1', node_id: 'n2', attempt_id: 'a2', result: 'completed' },
    { ts: 3000, kind: 'land_completed', run_id: 'r1', node_id: 'n3', attempt_id: 'a3', result: 'completed' },
  ]);

  const wall = lib.foldWallClockToLand(record);
  assert.equal(wall.state, lib.METRIC_STATES.KNOWN);
  assert.equal(wall.value, 7000, '8000 minus the run_started ts of 1000');
  assert.notEqual(wall.value, 2000, 'a fold reading the LAST array element would say 2000');
  assert.equal(wall.unit, 'ms');
});

test('wall clock is UNDEFINED for a run that landed nothing', () => {
  const wall = lib.foldWallClockToLand(framed([]));
  assert.equal(wall.state, lib.METRIC_STATES.UNDEFINED);
  assert.equal(wall.value, null);
  assert.match(wall.reason, /landed nothing/);
});

test('wall clock is UNKNOWN when the record carries no run_started', () => {
  const wall = lib.foldWallClockToLand([
    { ts: 5000, kind: 'land_completed', run_id: 'r1', node_id: 'n1', attempt_id: 'a1', result: 'completed' },
  ]);
  assert.equal(wall.state, lib.METRIC_STATES.UNKNOWN);
  assert.equal(wall.value, null);
});

// ─── task 2: rounds per artifact ─────────────────────────────────────────────

test('rounds per artifact folds through the SHIPPED reader, keyed on artifact and question', () => {
  const file = scratchLog([
    JSON.stringify({ ts: 1, kind: 'budget-declared', artifact: 'A.md', question: 'is it correct', allowance: 2 }),
    JSON.stringify({ ts: 2, kind: 'round-opened', artifact: 'A.md', question: 'is it correct' }),
    JSON.stringify({ ts: 3, kind: 'round-opened', artifact: 'A.md', question: 'is it correct' }),
    JSON.stringify({ ts: 4, kind: 'round-opened', artifact: 'B.md', question: 'is it safe' }),
    JSON.stringify({ ts: 5, kind: 'round-closed', artifact: 'B.md', question: 'is it safe' }),
  ]);

  const rounds = lib.foldRoundsPerArtifact(file);
  assert.equal(rounds.state, lib.METRIC_STATES.KNOWN);
  assert.equal(rounds.value, 1.5, '3 rounds over 2 distinct pairs of artifact and question');
  assert.equal(rounds.unit, 'rounds');
  assert.match(rounds.reason, /maximum 2/);
});

test('rounds per artifact is UNDEFINED for a log with 0 round-opened events', () => {
  const rounds = lib.foldRoundsPerArtifact(scratchLog([]));
  assert.equal(rounds.state, lib.METRIC_STATES.UNDEFINED);
  assert.equal(rounds.value, null);
  assert.notEqual(rounds.value, 0, 'a mean over 0 keys is not a mean of 0');
});

test('an unparseable anti loop log line THROWS through this fold rather than lowering the count', () => {
  const file = scratchLog([
    JSON.stringify({ ts: 1, kind: 'round-opened', artifact: 'A.md', question: 'q' }),
    '{ this is not json',
    JSON.stringify({ ts: 3, kind: 'round-opened', artifact: 'B.md', question: 'q' }),
  ]);

  assert.throws(
    () => lib.foldRoundsPerArtifact(file),
    (err) => {
      assert.match(err.message, /line 2/, 'the shipped reader names the 1 based line number');
      return true;
    },
    'a corrupt anti loop log is a corrupt measurement and must surface',
  );

  // The positive direction: the same fold succeeds once the bad line is gone, so
  // the throw above is the corrupt line rather than the fold being broken.
  const clean = lib.foldRoundsPerArtifact(scratchLog([
    JSON.stringify({ ts: 1, kind: 'round-opened', artifact: 'A.md', question: 'q' }),
    JSON.stringify({ ts: 3, kind: 'round-opened', artifact: 'B.md', question: 'q' }),
  ]));
  assert.equal(clean.state, lib.METRIC_STATES.KNOWN);
  assert.equal(clean.value, 1);
});

test('a missing anti loop log is an empty history, not a broken one', () => {
  const rounds = lib.foldRoundsPerArtifact(path.join(os.tmpdir(), 'proof-fold-absent-log.jsonl'));
  assert.equal(rounds.state, lib.METRIC_STATES.UNDEFINED);
});

// ─── task 2: cost per landed increment ───────────────────────────────────────

test('cost per landed increment is the usd sum over the landed count', () => {
  const record = framed(landed(4, 2000, 100).map((e, i) => Object.assign(e, { usd: i + 1 })));
  const cost = lib.foldCostPerLandedIncrement(record);

  assert.equal(cost.state, lib.METRIC_STATES.KNOWN);
  assert.equal(cost.value, 2.5, '1 plus 2 plus 3 plus 4, over 4 landed increments');
  assert.equal(cost.unit, 'usd');
});

test('cost is UNDEFINED when no event in the record carries a usd figure', () => {
  const cost = lib.foldCostPerLandedIncrement(framed(landed(4, 2000, 100)));
  assert.equal(cost.state, lib.METRIC_STATES.UNDEFINED);
  assert.equal(cost.value, null);
  assert.match(cost.reason, /usd/);
});

test('cost with spend and 0 landed increments is UNKNOWN, and is neither 0 nor infinity', () => {
  const record = framed([
    ...workerPair(1, 1010, 1900).map((e) => Object.assign(e, { usd: 3 })),
  ]);
  const cost = lib.foldCostPerLandedIncrement(record);

  assert.equal(cost.state, lib.METRIC_STATES.UNKNOWN);
  assert.equal(cost.value, null);
  assert.notEqual(cost.value, 0);
  assert.notEqual(cost.value, Infinity, 'dividing by 0 landed is not a cost per increment');
  assert.match(cost.reason, /0 landed/);
});

// ─── task 2: the assembler ───────────────────────────────────────────────────

test('the fold document carries all 6 metric keys even when 5 of them are not known', () => {
  const record = framed([
    { ts: 5000, kind: 'land_completed', run_id: 'r1', node_id: 'n1', attempt_id: 'a1', result: 'completed' },
  ]);
  const doc = lib.assembleFoldDocument({ events: record, antiloopLogPath: scratchLog([]) });

  const expected = [
    'wall_clock_to_land', 'demonstrated_width', 'land_gate_cost',
    'false_green_rate', 'rounds_per_artifact', 'cost_per_landed_increment',
  ];
  assert.deepEqual(Object.keys(doc.metrics).sort(), [...expected].sort());
  assert.equal(expected.length, 6, 'the key list this asserts against is not empty');

  assert.equal(doc.schema, lib.PROOF_FOLD_SCHEMA);
  assert.equal(doc.arm, 'fleet');
  assert.equal(doc.provenance, 'measured');
  assert.equal(doc.corpus_hash, 'CORPUS-A');
  assert.equal(doc.run_id, 'r1');
  assert.equal(doc.landed, 1);

  // 1 metric known, 5 not. No consumer has to handle 2 shapes.
  const notKnown = expected.filter((k) => doc.metrics[k].state !== lib.METRIC_STATES.KNOWN);
  assert.equal(notKnown.length, 5, `expected 5 not known, got ${JSON.stringify(notKnown)}`);
  assert.equal(doc.metrics.wall_clock_to_land.state, lib.METRIC_STATES.KNOWN);
  for (const key of notKnown) {
    // land_gate_cost is a CURVE and carries buckets rather than 1 value, on
    // purpose: an average over all concurrencies is the statistic that hides
    // degradation under contention. Its not known shape is an empty curve.
    if (key === 'land_gate_cost') {
      assert.deepEqual(doc.metrics[key].buckets, [], 'an unknown gate cost reports no curve');
      assert.equal(doc.metrics[key].baseline_ms, null);
      assert.equal(doc.metrics[key].degradation, null);
    } else {
      assert.equal(doc.metrics[key].value, null, `${key} carries no number while not known`);
    }
    assert.ok(doc.metrics[key].reason.length > 0, `${key} names what was missing`);
  }
});

test('every metric state in the assembled document is 1 of the 3 declared states', () => {
  const doc = lib.assembleFoldDocument({
    events: framed([...workerPair(1, 1010, 1900), ...landed(1, 2000, 100)]),
    antiloopLogPath: scratchLog([]),
  });
  const declared = new Set(Object.values(lib.METRIC_STATES));
  assert.equal(declared.size, 3);

  let checked = 0;
  for (const [key, metric] of Object.entries(doc.metrics)) {
    if (key === 'land_gate_cost') {
      assert.ok(metric.state === lib.METRIC_STATES.KNOWN || metric.state === lib.METRIC_STATES.UNKNOWN);
    } else {
      assert.ok(declared.has(metric.state), `${key} carries a declared state`);
      // value is non null exactly when the state is known.
      assert.equal(metric.value !== null, metric.state === lib.METRIC_STATES.KNOWN, `${key} value agrees with its state`);
    }
    checked += 1;
  }
  assert.equal(checked, 6);
});

// ─── task 3 builders ─────────────────────────────────────────────────────────

function metric(value, unit, state, reason) {
  return {
    value: state === lib.METRIC_STATES.KNOWN ? value : null,
    unit,
    state: state || lib.METRIC_STATES.KNOWN,
    reason: reason || '',
  };
}

/**
 * A fold document built directly, so the verdict is exercised over its real
 * input rather than over a record that has to be re-derived for every case. The
 * shape agreement test below pins this builder against the real assembler.
 */
function armDoc(over) {
  const o = over || {};
  return {
    schema: lib.PROOF_FOLD_SCHEMA,
    run_id: o.run_id || 'r1',
    arm: o.arm || 'serial',
    provenance: o.provenance || 'measured',
    corpus_hash: o.corpus_hash || 'CORPUS-A',
    graph_generation: 'g1',
    metrics: {
      wall_clock_to_land: o.wall === undefined
        ? metric(1000, 'ms', lib.METRIC_STATES.KNOWN)
        : metric(o.wall, 'ms', o.wallState || lib.METRIC_STATES.KNOWN, 'named'),
      demonstrated_width: o.width === undefined
        ? metric(3, 'workers', lib.METRIC_STATES.KNOWN)
        : metric(o.width, 'workers', o.widthState || lib.METRIC_STATES.KNOWN, 'named'),
      land_gate_cost: {
        state: lib.METRIC_STATES.KNOWN, buckets: [], baseline_ms: null, degradation: null, reason: '',
      },
      false_green_rate: o.falseGreen === undefined
        ? metric(0.05, 'ratio', lib.METRIC_STATES.KNOWN)
        : metric(o.falseGreen, 'ratio', o.falseGreenState || lib.METRIC_STATES.KNOWN, 'named'),
      rounds_per_artifact: o.rounds === undefined
        ? metric(2, 'rounds', lib.METRIC_STATES.KNOWN)
        : metric(o.rounds, 'rounds', o.roundsState || lib.METRIC_STATES.KNOWN, 'named'),
      cost_per_landed_increment: metric(1, 'usd', lib.METRIC_STATES.KNOWN),
    },
    // FF-B353. The landed count is the DENOMINATOR the false green rate divided
    // by, so pooling weights by it. It is settable here for exactly that reason:
    // a fixture whose landed count could not vary could not tell a pooled count
    // apart from a mean of rates.
    landed: o.landed === undefined ? 5 : o.landed,
    errors: [],
    warnings: [],
  };
}

/** The standard serial baseline: 2 runs, wall 1000 and 1100, so sigma is 100 and S is 1050. */
function serialPair(over) {
  return [
    armDoc(Object.assign({ wall: 1000 }, over)),
    armDoc(Object.assign({ wall: 1100 }, over)),
  ];
}

function firstNumbers(text) {
  return (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

// ─── task 3: the shape the verdict consumes is the shape the assembler emits ──

test('the hand built arm document has the same keys the real assembler emits', () => {
  const real = lib.assembleFoldDocument({
    events: framed([...workerPair(1, 1010, 1900), ...landed(1, 2000, 100)]),
    antiloopLogPath: scratchLog([]),
  });
  assert.deepEqual(Object.keys(armDoc()).sort(), Object.keys(real).sort());
  assert.deepEqual(Object.keys(armDoc().metrics).sort(), Object.keys(real.metrics).sort());
});

// ─── task 3: all 4 verdicts, driven by name ──────────────────────────────────

test('POSITIVE: a measured fleet beats a measured serial arm by more than sigma', () => {
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05, rounds: 2 })],
    permitted_width: 4,
  });

  assert.equal(result.schema, lib.PROOF_VERDICT_SCHEMA);
  assert.equal(result.verdict, lib.VERDICTS.POSITIVE);
  assert.deepEqual(result.refusals, []);
  assert.equal(result.sigma_ms, 100);
  assert.equal(result.demonstrated_width, 3);
  assert.equal(result.permitted_width, 4);
  assert.equal(result.width_gap, 1);
});

test('NEGATIVE: a fleet slower than serial by more than sigma', () => {
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 1400 })],
    permitted_width: null,
  });
  assert.equal(result.verdict, lib.VERDICTS.NEGATIVE);
  assert.deepEqual(result.refusals, []);
});

test('NEGATIVE is checked BEFORE POSITIVE: a faster fleet that landed broken work', () => {
  // Every POSITIVE condition holds except the false green rate, which is 0.15.
  // An ordering that checked POSITIVE first would report a win here.
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.15, rounds: 2 })],
    permitted_width: null,
  });
  assert.equal(result.verdict, lib.VERDICTS.NEGATIVE);
  assert.ok(
    result.reasons.some((r) => r.includes('0.15')),
    `the deciding rate must be named, got ${JSON.stringify(result.reasons)}`,
  );

  // The control: the identical case with a clean rate IS positive, so the
  // assertion above is the rate rather than some unrelated blocker.
  const control = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05, rounds: 2 })],
    permitted_width: null,
  });
  assert.equal(control.verdict, lib.VERDICTS.POSITIVE);
});

test('NEGATIVE: a fleet that was faster because it stopped reviewing', () => {
  // A fleet that is fast because its rounds per artifact collapsed is a
  // regression, and this clause is the only one that can catch it.
  const result = lib.compareArms({
    serial: serialPair({ rounds: 2 }),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05, rounds: 1 })],
    permitted_width: null,
  });
  assert.equal(result.verdict, lib.VERDICTS.NEGATIVE);
  assert.ok(result.reasons.some((r) => /rounds/i.test(r)));
});

test('MARGINAL: a difference at or inside sigma', () => {
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 1060 })],
    permitted_width: null,
  });
  assert.equal(result.verdict, lib.VERDICTS.MARGINAL);
  assert.deepEqual(result.refusals, []);
});

test('all 4 verdicts are reachable and each was observed at least once', () => {
  const observed = new Set();
  const cases = [
    lib.compareArms({ serial: serialPair(), fleet: [armDoc({ arm: 'fleet', wall: 800 })], permitted_width: null }),
    lib.compareArms({ serial: serialPair(), fleet: [armDoc({ arm: 'fleet', wall: 1400 })], permitted_width: null }),
    lib.compareArms({ serial: serialPair(), fleet: [armDoc({ arm: 'fleet', wall: 1060 })], permitted_width: null }),
    lib.compareArms({ serial: [], fleet: [armDoc({ arm: 'fleet' })], permitted_width: null }),
  ];
  for (const c of cases) observed.add(c.verdict);
  assert.equal(observed.size, 4, `expected all 4 verdicts, observed ${JSON.stringify([...observed])}`);
  assert.deepEqual([...observed].sort(), Object.values(lib.VERDICTS).slice().sort());
});

// ─── task 3: all 6 refusals, driven by name ──────────────────────────────────

const REFUSAL_CASES = [
  {
    refusal: 'no baseline',
    name: 'a fleet arm with an empty serial list',
    input: () => ({ serial: [], fleet: [armDoc({ arm: 'fleet' })], permitted_width: null }),
  },
  {
    // FF-B353. The missing fleet arm is named DIRECTLY rather than surfacing as
    // an unknown width, which is what a reader saw before the fleet side became
    // a list and is a symptom rather than the cause.
    refusal: 'no fleet arm',
    name: 'a serial baseline with an empty fleet list',
    input: () => ({ serial: serialPair(), fleet: [], permitted_width: null }),
  },
  {
    refusal: 'sigma undefined',
    name: 'exactly 1 serial run, so the spread cannot be measured',
    input: () => ({ serial: [armDoc({ wall: 1000 })], fleet: [armDoc({ arm: 'fleet' })], permitted_width: null }),
  },
  {
    refusal: 'corpus mismatch',
    name: '2 arms carrying different corpus hashes',
    input: () => ({
      serial: serialPair(),
      fleet: [armDoc({ arm: 'fleet', corpus_hash: 'CORPUS-B' })],
      permitted_width: null,
    }),
  },
  {
    refusal: 'width unknown',
    name: 'a fleet arm whose demonstrated width is unknown',
    input: () => ({
      serial: serialPair(),
      fleet: [armDoc({ arm: 'fleet', width: 3, widthState: lib.METRIC_STATES.UNKNOWN })],
      permitted_width: null,
    }),
  },
  {
    refusal: 'false green undefined',
    name: 'a fleet arm whose false green rate was never measured',
    input: () => ({
      serial: serialPair(),
      fleet: [armDoc({ arm: 'fleet', falseGreen: 0, falseGreenState: lib.METRIC_STATES.UNDEFINED })],
      permitted_width: null,
    }),
  },
  {
    refusal: 'wall clock unknown',
    name: 'a fleet arm with no usable wall clock',
    input: () => ({
      serial: serialPair(),
      fleet: [armDoc({ arm: 'fleet', wall: 800, wallState: lib.METRIC_STATES.UNKNOWN })],
      permitted_width: null,
    }),
  },
];

test('every refusal is driven by its own named case and yields INSUFFICIENT', () => {
  assert.ok(REFUSAL_CASES.length > 0, 'the refusal table is not empty');

  let driven = 0;
  for (const c of REFUSAL_CASES) {
    const result = lib.compareArms(c.input());
    assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT, `${c.refusal}: ${c.name}`);
    assert.ok(
      result.refusals.some((r) => r.startsWith(c.refusal)),
      `${c.refusal}: ${c.name} must name its own refusal, got ${JSON.stringify(result.refusals)}`,
    );
    driven += 1;
  }
  assert.equal(driven, REFUSAL_CASES.length);
});

test('the exported refusal list and the refusal case table agree as sets, both directions', () => {
  const exported = new Set(Object.values(lib.PROOF_REFUSALS));
  const driven = new Set(REFUSAL_CASES.map((c) => c.refusal));
  assert.ok(exported.size > 0);
  assert.deepEqual([...exported].filter((r) => !driven.has(r)), [], 'every refusal is driven');
  assert.deepEqual([...driven].filter((r) => !exported.has(r)), [], 'every case drives a refusal');
});

test('2 refusals firing at once BOTH appear, so a first match return cannot pass', () => {
  // An empty serial list is simultaneously no baseline and no measurable sigma.
  const result = lib.compareArms({ serial: [], fleet: [armDoc({ arm: 'fleet' })], permitted_width: null });
  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
  assert.ok(result.refusals.length >= 2, `expected 2 or more, got ${JSON.stringify(result.refusals)}`);
  assert.ok(result.refusals.some((r) => r.startsWith(lib.PROOF_REFUSALS.NO_BASELINE)));
  assert.ok(result.refusals.some((r) => r.startsWith(lib.PROOF_REFUSALS.SIGMA_UNDEFINED)));
});

test('D13 item 1: a fleet arm with NO serial baseline refuses and names the missing arm', () => {
  // A benchmark that reports numbers with no baseline is the named trivial pass.
  const result = lib.compareArms({
    serial: [],
    fleet: [armDoc({ arm: 'fleet', wall: 500, width: 4, falseGreen: 0, rounds: 5 })],
    permitted_width: 4,
  });
  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
  const refusal = result.refusals.find((r) => r.startsWith(lib.PROOF_REFUSALS.NO_BASELINE));
  assert.ok(refusal, 'the missing serial arm is named');
  assert.match(refusal, /serial/);
});

test('the corpus mismatch refusal names BOTH hashes', () => {
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', corpus_hash: 'CORPUS-B' })],
    permitted_width: null,
  });
  const refusal = result.refusals.find((r) => r.startsWith(lib.PROOF_REFUSALS.CORPUS_MISMATCH));
  assert.ok(refusal);
  assert.match(refusal, /CORPUS-A/);
  assert.match(refusal, /CORPUS-B/);
});

test('sigma_ms is null with exactly 1 serial run and the verdict is INSUFFICIENT', () => {
  const result = lib.compareArms({
    serial: [armDoc({ wall: 1000 })],
    fleet: [armDoc({ arm: 'fleet', wall: 800 })],
    permitted_width: null,
  });
  assert.equal(result.sigma_ms, null);
  assert.notEqual(result.sigma_ms, 0, 'an unmeasured spread is not a spread of 0');
  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
});

// ─── task 3: permitted width credits nothing ─────────────────────────────────

test('D13 item 2: permitted width is reported, the gap is reported, and no rule reads it', () => {
  const build = (permitted) => lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 1060, width: 1 })],
    permitted_width: permitted,
  });

  const wide = build(5);
  assert.equal(wide.permitted_width, 5);
  assert.equal(wide.demonstrated_width, 1);
  assert.equal(wide.width_gap, 4);

  // The real assertion: changing the permitted number does not move the verdict.
  // This is the exact error MEASUREMENT-v1.14-PARALLELISM finding 3 records, made
  // structurally impossible rather than merely discouraged.
  const narrow = build(1);
  assert.equal(narrow.permitted_width, 1);
  assert.equal(narrow.demonstrated_width, 1);
  assert.equal(narrow.width_gap, 0);

  assert.equal(wide.verdict, narrow.verdict, 'permitted width entered no rule');
  assert.deepEqual(wide.reasons, narrow.reasons, 'permitted width appears in no deciding reason');
  assert.deepEqual(wide.refusals, narrow.refusals);

  // And the guard is not passing because both verdicts are INSUFFICIENT.
  assert.notEqual(wide.verdict, lib.VERDICTS.INSUFFICIENT);
});

test('a permitted width of 5 cannot lift a demonstrated width of 1 into a POSITIVE', () => {
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 1, falseGreen: 0.05, rounds: 2 })],
    permitted_width: 5,
  });
  assert.notEqual(result.verdict, lib.VERDICTS.POSITIVE);
  assert.equal(result.verdict, lib.VERDICTS.MARGINAL);
  assert.ok(result.reasons.some((r) => /width/i.test(r)));
});

// ─── FF-B346: UNKNOWN rounds are excluded from the gate in BOTH directions ───
//
// THE DEFECT. The NEGATIVE branch guards its rounds comparison with
// `roundsComparable &&`, so an unknown round count could not make a run
// NEGATIVE. The POSITIVE branch pushed its rounds blocker UNCONDITIONALLY, so an
// unknown round count DID make a run fail POSITIVE. The apparatus could
// therefore return NEGATIVE on speed and could NEVER return POSITIVE, whatever
// any run measured.
//
// And the metric is not merely absent. `rounds_per_artifact` folds from
// `.planning/antiloop-log.jsonl`, whose only writer is `antiloop.open-round`, a
// lifecycle REVIEW mutation. A corpus arm builds modules and scores them with a
// gate; it opens no review round, so a corpus arm is STRUCTURALLY INCAPABLE of
// producing a round event and the blocker was permanent.

test('FF-B346: an otherwise POSITIVE pair with UNKNOWN rounds on both arms IS positive', () => {
  const unknown = { roundsState: lib.METRIC_STATES.UNKNOWN, rounds: null };
  const result = lib.compareArms({
    serial: serialPair(unknown),
    fleet: [armDoc(Object.assign({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05 }, unknown))],
    permitted_width: null,
  });

  assert.equal(
    result.verdict, lib.VERDICTS.POSITIVE,
    `an unknown round count must not block a win, got ${JSON.stringify(result.reasons)}`,
  );

  const row = result.reasons.find((r) => r.startsWith(lib.VERDICTS.POSITIVE));
  assert.ok(row, 'the POSITIVE reason row exists');
  assert.match(row, /rounds per artifact UNKNOWN/, 'and it states the metric is unknown');
  assert.match(row, /EXCLUDED from this gate/, 'and that it was excluded rather than assumed');
  assert.match(
    row, /structurally incapable of producing a round event/,
    'and WHY, so a reader does not read the exclusion as a metric somebody forgot to collect',
  );
  // IT DOES NOT CLAIM A COMPARISON NOBODY MADE.
  assert.equal(
    /at or above the serial arm/.test(row), false,
    'the sentence asserting the fleet reviewed at least as much is ABSENT when nothing was compared',
  );
  assert.equal(
    /\brounds per artifact 2\b/.test(row), false,
    'and no round count is fabricated to fill the hole',
  );
});

test('FF-B346: the CONTROL, the SAME unknown rounds cannot make a slower fleet NEGATIVE either', () => {
  // The symmetry, driven from the other side. If unknown rounds were treated as
  // a collapse this arm would carry a rounds reason next to its speed one.
  const unknown = { roundsState: lib.METRIC_STATES.UNKNOWN, rounds: null };
  const result = lib.compareArms({
    serial: serialPair(unknown),
    fleet: [armDoc(Object.assign({ arm: 'fleet', wall: 1400, width: 3, falseGreen: 0.05 }, unknown))],
    permitted_width: null,
  });

  assert.equal(result.verdict, lib.VERDICTS.NEGATIVE, 'it is NEGATIVE, and on SPEED');
  const rounds = result.reasons.filter((r) => /rounds/i.test(r));
  assert.deepEqual(rounds, [], 'no reason mentions rounds at all, in either direction');
});

test('FF-B346: REQUIRED FAILING ARM, a fleet that reviewed LESS is still NEGATIVE', () => {
  // The known case is untouched and it still fires. Removing the unknown blocker
  // without this arm would be indistinguishable from removing the rule.
  const result = lib.compareArms({
    serial: serialPair({ rounds: 3 }),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05, rounds: 1 })],
    permitted_width: null,
  });

  assert.equal(
    result.verdict, lib.VERDICTS.NEGATIVE,
    'a fleet that is fast because it stopped reviewing is a regression, not a win',
  );
  const row = result.reasons.find((r) => /rounds per artifact/i.test(r));
  assert.ok(row, `the rounds reason is named, got ${JSON.stringify(result.reasons)}`);
  const [fleetRounds, serialRounds] = firstNumbers(row.slice(row.indexOf('rounds per artifact')));
  assert.equal(fleetRounds, 1, 'the fleet count is stated');
  assert.equal(serialRounds, 3, 'beside the serial one');
});

test('FF-B346: the CONTROL, a fleet that reviewed AT LEAST AS MUCH is still POSITIVE', () => {
  // D8a both directions on the known case, so the NEGATIVE above is a property of
  // the numbers and not of the arm.
  const result = lib.compareArms({
    serial: serialPair({ rounds: 3 }),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05, rounds: 3 })],
    permitted_width: null,
  });
  assert.equal(result.verdict, lib.VERDICTS.POSITIVE);
  const row = result.reasons.find((r) => r.startsWith(lib.VERDICTS.POSITIVE));
  assert.match(row, /at or above the serial arm/, 'and the comparison IS stated, because it was made');
  assert.equal(/UNKNOWN/.test(row), false, 'the exclusion sentence is ABSENT when rounds are known');
});

test('FF-B346: excluding rounds does not excuse any OTHER POSITIVE condition', () => {
  // The blocker that was removed was permanent, so its removal has to be shown
  // NOT to have removed the gate. A run with unknown rounds and a demonstrated
  // width of 1 is still MARGINAL, and the reason names the width.
  const unknown = { roundsState: lib.METRIC_STATES.UNKNOWN, rounds: null };
  const result = lib.compareArms({
    serial: serialPair(unknown),
    fleet: [armDoc(Object.assign({ arm: 'fleet', wall: 800, width: 1, falseGreen: 0.05 }, unknown))],
    permitted_width: 5,
  });

  assert.equal(result.verdict, lib.VERDICTS.MARGINAL);
  assert.ok(
    result.reasons.some((r) => /demonstrated width/i.test(r)),
    `the width blocker still fires, got ${JSON.stringify(result.reasons)}`,
  );
  assert.equal(
    result.reasons.some((r) => /rounds/i.test(r)), false,
    'and rounds is not among the reasons, because it is excluded rather than blocking',
  );
});

// ─── task 3: a replayed arm can never return POSITIVE ────────────────────────

test('D7: an otherwise POSITIVE pair with a REPLAYED fleet arm returns MARGINAL', () => {
  const shared = { arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05, rounds: 2 };

  const measured = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc(Object.assign({}, shared, { provenance: 'measured' }))],
    permitted_width: null,
  });
  assert.equal(measured.verdict, lib.VERDICTS.POSITIVE, 'the control arm IS positive');

  const replayed = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc(Object.assign({}, shared, { provenance: 'replayed' }))],
    permitted_width: null,
  });
  assert.equal(replayed.verdict, lib.VERDICTS.MARGINAL);
  assert.ok(
    replayed.reasons.some((r) => /replayed|provenance/i.test(r)),
    `the provenance must be named, got ${JSON.stringify(replayed.reasons)}`,
  );
});

test('a replayed arm may still return NEGATIVE, because a regression is showable', () => {
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', provenance: 'replayed', wall: 1400 })],
    permitted_width: null,
  });
  assert.equal(result.verdict, lib.VERDICTS.NEGATIVE);
});

// ─── task 3: the reasons are recomputable by hand ────────────────────────────

test('reasons carry the numbers that decided, and the arithmetic recomputes', () => {
  const positive = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05, rounds: 2 })],
    permitted_width: null,
  });
  const pRow = positive.reasons.find((r) => r.startsWith(lib.VERDICTS.POSITIVE));
  assert.ok(pRow, `no POSITIVE reason row, got ${JSON.stringify(positive.reasons)}`);
  const [s, f, diff, sigma] = firstNumbers(pRow);
  assert.equal(s - f, diff, 'the stated difference is the stated S minus the stated F');
  assert.ok(diff > sigma, 'the stated difference exceeds the stated sigma');
  assert.equal(s, 1050);
  assert.equal(f, 800);
  assert.equal(sigma, positive.sigma_ms);

  const negative = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 1400 })],
    permitted_width: null,
  });
  const nRow = negative.reasons.find((r) => r.startsWith(lib.VERDICTS.NEGATIVE));
  assert.ok(nRow, `no NEGATIVE reason row, got ${JSON.stringify(negative.reasons)}`);
  const [nf, ns, nDiff, nSigma] = firstNumbers(nRow);
  assert.equal(nf - ns, nDiff);
  assert.ok(nDiff > nSigma);
});

test('a comparison with no fleet arm at all refuses rather than reporting the serial numbers', () => {
  const result = lib.compareArms({ serial: serialPair(), fleet: null, permitted_width: 3 });
  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
  assert.equal(result.fleet_records, 0, 'the arm carries 0 records and the COUNT says so');
  assert.ok(result.refusals.length > 0);
  // FF-B353. It names the MISSING ARM, not merely a width it could not read.
  assert.equal(
    result.refusals.filter((r) => r.startsWith(lib.PROOF_REFUSALS.NO_FLEET_ARM)).length, 1,
    `the missing fleet arm is named exactly once, got ${JSON.stringify(result.refusals)}`,
  );
  assert.equal(result.demonstrated_width, null);
  assert.equal(result.width_gap, null, 'an absent gap is null, never a negative sentinel');
});

test('the verdict never silently accepts a non array fleet argument', () => {
  // FF-B353. The superseded contract handed `fleet` a SINGLE document. A caller
  // that still does gets an empty arm and a refusal naming it, never a silent
  // coercion that would let the 1 record fold survive under the new signature.
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05, rounds: 2 }),
    permitted_width: null,
  });
  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
  assert.equal(result.fleet_records, 0);
  assert.equal(
    result.refusals.filter((r) => r.startsWith(lib.PROOF_REFUSALS.NO_FLEET_ARM)).length, 1,
  );

  // The control: the SAME document inside a list IS a POSITIVE, so the refusal
  // above is the shape of the argument and not the contents of the document.
  const control = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.05, rounds: 2 })],
    permitted_width: null,
  });
  assert.equal(control.verdict, lib.VERDICTS.POSITIVE);
  assert.equal(control.fleet_records, 1);
});

test('the verdict never silently accepts a non array serial argument', () => {
  const result = lib.compareArms({ serial: 'not an array', fleet: [armDoc({ arm: 'fleet' })], permitted_width: null });
  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
  assert.ok(result.refusals.some((r) => r.startsWith(lib.PROOF_REFUSALS.NO_BASELINE)));
});

// ─── FF-B353: BOTH ARMS ARE POOLED, AND NEITHER IS A SELECTION ──────────────
//
// THE DEFECT. `compareArms` took `serial` as a LIST and `fleet` as a SINGLE
// document, so the published caller folded `fleetRecords[0]` and the DIRECTORY
// ORDER decided the verdict. The 2 live fleet records really do disagree: one
// carries a false green rate of 0.5 over 8 landed increments and the other 0
// over 4, so the published result was a coin flip.
//
// THE POOLING RULES, each driven by its own case below:
//   wall clock, rounds   the MEAN, all or nothing across the arm's records
//   demonstrated width   the MINIMUM, so 1 wide run cannot vouch for a narrow one
//   false green rate     the pooled COUNTS, never a mean of the per record rates
//   repeat spread        reported, and entering no rule

/** The 2 live fleet records in shape: 4 false greens over 8 landed, then 0 over 4. */
function liveShapedFleet() {
  return [
    armDoc({ arm: 'fleet', wall: 202476, width: 6, falseGreen: 0.5, landed: 8, rounds: 2 }),
    armDoc({ arm: 'fleet', wall: 245373, width: 6, falseGreen: 0, landed: 4, rounds: 2 }),
  ];
}

/** The 2 live serial records in shape: wall 729747 and 736265, so sigma is 6518. */
function liveShapedSerial() {
  return [
    armDoc({ arm: 'serial', wall: 729747, width: 1, falseGreen: 0, landed: 4, rounds: 2 }),
    armDoc({ arm: 'serial', wall: 736265, width: 1, falseGreen: 0, landed: 4, rounds: 2 }),
  ];
}

test('FF-B353: the defect, 2 fleet records that disagree gave 2 different verdicts one at a time', () => {
  // This test EXISTS TO SHOW THE COIN FLIP WAS REAL. It folds each live shaped
  // record on its own, exactly as `fleetRecords[0]` did, and asserts the 2
  // answers differ. If they ever stop differing this test fails and says so,
  // because then the repair below would be proving nothing.
  const serial = liveShapedSerial();
  const fleet = liveShapedFleet();
  assert.equal(fleet.length, 2, 'the case needs 2 fleet records to be a selection at all');

  const perRecord = fleet.map((f) => lib.compareArms({ serial, fleet: [f], permitted_width: 5 }).verdict);
  assert.deepEqual(perRecord, [lib.VERDICTS.NEGATIVE, lib.VERDICTS.POSITIVE]);
  assert.equal(new Set(perRecord).size, 2, 'the 2 records disagree, so the order decided the answer');
});

test('FF-B353: the repair, the pooled verdict does not move when the records are reordered', () => {
  const serial = liveShapedSerial();
  const forward = lib.compareArms({ serial, fleet: liveShapedFleet(), permitted_width: 5 });
  const reversed = lib.compareArms({ serial, fleet: liveShapedFleet().reverse(), permitted_width: 5 });

  assert.equal(forward.fleet_records, 2, 'both records entered the fold');
  assert.equal(reversed.fleet_records, 2);
  assert.equal(forward.verdict, reversed.verdict, 'directory order decides nothing');
  assert.deepEqual(forward.reasons, reversed.reasons, 'and it moves no number in the published prose');
  assert.deepEqual(forward.refusals, reversed.refusals);
  assert.equal(forward.demonstrated_width, reversed.demonstrated_width);
  assert.equal(forward.fleet_spread_ms, reversed.fleet_spread_ms);

  // And the guard is not passing because both are INSUFFICIENT.
  assert.equal(forward.verdict, lib.VERDICTS.NEGATIVE);
  assert.equal(forward.refusals.length, 0, 'nothing refused, so the verdict is on the numbers');
});

test('FF-B353: the false green rate pools the COUNTS and is NOT a mean of the per record rates', () => {
  const result = lib.compareArms({
    serial: liveShapedSerial(), fleet: liveShapedFleet(), permitted_width: 5,
  });
  const row = result.reasons.find((r) => /false green rate/i.test(r));
  assert.ok(row, `the deciding rate is named, got ${JSON.stringify(result.reasons)}`);

  // 4 false greens over 12 landed increments is 0.333333. A mean of the 2 rates,
  // 0.5 and 0, is 0.25, which weights a record that decided 4 exactly as heavily
  // as one that decided 8. Both clear the threshold here, so this assertion is
  // the only thing separating the correct pooling from the flattering one.
  assert.match(row, /0\.333333/, 'the pooled count is published');
  assert.equal(/0\.25\b/.test(row), false, 'and the mean of rates is NOT');

  // THE COUNTS THEMSELVES ARE PUBLISHED, not merely the quotient. A reader handed
  // only 0.333333 cannot tell a pooled count from a mean of rates.
  assert.equal(result.pooled_fleet.false_green.false_greens, 4);
  assert.equal(result.pooled_fleet.false_green.landed, 12);
  assert.equal(result.pooled_fleet.false_green.rate, 4 / 12);
  assert.match(row, /4 false greens over 12 landed increments/);
  assert.match(
    row, /The rate is the POOLED COUNT over 2 fleet records/,
    'and the reason SAYS it is a pooled count, which is the load bearing claim',
  );
  assert.equal(result.pooled_fleet.records, 2);
  assert.equal(result.pooled_fleet.wall_clock_ms, (202476 + 245373) / 2);
  assert.equal(result.pooled_fleet.spread_ms, 245373 - 202476);
  assert.equal(result.pooled_fleet.demonstrated_width, 6);

  // The mean of rates, spelled out, so the number this fold REFUSES to publish is
  // in the test rather than only in a comment.
  const meanOfRates = (0.5 + 0) / 2;
  assert.equal(meanOfRates, 0.25);
  assert.notEqual(result.pooled_fleet.false_green.rate, meanOfRates);
});

test('FF-B353: REQUIRED FAILING ARM, the pooled fold CAN return POSITIVE', () => {
  // A gate that cannot return POSITIVE is the exact defect FF-B346 repaired and
  // must not be reintroduced by pooling. Every fleet record here carries a false
  // green rate of 0, and their landed counts DIFFER so the weighting is exercised
  // rather than trivially equal.
  const fleet = [
    armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 8, rounds: 2 }),
    armDoc({ arm: 'fleet', wall: 900, width: 4, falseGreen: 0, landed: 2, rounds: 2 }),
    armDoc({ arm: 'fleet', wall: 700, width: 3, falseGreen: 0, landed: 5, rounds: 2 }),
  ];
  assert.equal(fleet.length, 3, 'the pooled arm is not empty');
  assert.equal(new Set(fleet.map((f) => f.landed)).size, 3, 'and the weights differ');

  const result = lib.compareArms({ serial: serialPair(), fleet, permitted_width: 5 });
  assert.equal(
    result.verdict, lib.VERDICTS.POSITIVE,
    `a pooled arm that is clean and fast must still win, got ${JSON.stringify(result.reasons)}`,
  );
  assert.equal(result.refusals.length, 0);
  assert.equal(result.fleet_records, 3);
  // F is the MEAN of 800, 900 and 700, which is 800, and S is 1050.
  const row = result.reasons.find((r) => r.startsWith(lib.VERDICTS.POSITIVE));
  const [s, f, diff, sigma] = firstNumbers(row);
  assert.equal(s, 1050);
  assert.equal(f, 800, 'F is the mean over every fleet record, which a single document could never be');
  assert.equal(s - f, diff);
  assert.ok(diff > sigma);
  assert.equal(result.demonstrated_width, 3, 'the width is the MINIMUM of 3, 4 and 3');
});

test('FF-B353: REQUIRED FAILING ARM, 1 bad record among several still moves the pooled rate', () => {
  // Pooling must not be able to hide a broken run inside a majority of clean
  // ones. The control is the identical arm with the bad record made clean, and it
  // wins, so the NEGATIVE is the 1 record and not some unrelated blocker.
  const clean = () => [
    armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
    armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
    armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
  ];

  const control = lib.compareArms({ serial: serialPair(), fleet: clean(), permitted_width: 5 });
  assert.equal(control.verdict, lib.VERDICTS.POSITIVE, 'the all clean control wins');

  // 1 record of the 3 lands 3 false greens out of its 4. Pooled that is 3 over
  // 12, which is 0.25 and above the 0.1 threshold, so the arm is NEGATIVE even
  // though 2 of its 3 records were spotless.
  const spoiled = clean();
  spoiled[1] = armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.75, landed: 4, rounds: 2 });
  const result = lib.compareArms({ serial: serialPair(), fleet: spoiled, permitted_width: 5 });

  assert.equal(result.fleet_records, 3, 'all 3 records entered the fold');
  assert.equal(
    result.verdict, lib.VERDICTS.NEGATIVE,
    `a broken run inside a clean majority must still be visible, got ${JSON.stringify(result.reasons)}`,
  );
  const row = result.reasons.find((r) => /false green rate/i.test(r));
  assert.ok(row, 'the rate is named');
  assert.match(row, /0\.25\b/, '3 false greens over 12 landed increments is 0.25');
});

test('FF-B353: pooling over exactly 1 record reproduces that record, so nothing about a single run moved', () => {
  // The identity that makes the pooled denominator the right one. A pooled figure
  // that disagreed with the per record figure over a single record would put 2
  // different numbers for the same run into 1 published document.
  const rates = [0, 0.125, 0.5];
  let checked = 0;
  for (const rate of rates) {
    const doc = armDoc({ arm: 'fleet', wall: 1400, width: 3, falseGreen: rate, landed: 8, rounds: 2 });
    const result = lib.compareArms({ serial: serialPair(), fleet: [doc], permitted_width: 5 });
    assert.equal(result.fleet_records, 1);
    assert.equal(result.demonstrated_width, 3, 'the width is the record\'s own');
    assert.equal(result.fleet_spread_ms, null, '1 record has no repeat spread, and that is not a spread of 0');
    const row = result.reasons.find((r) => r.startsWith(lib.VERDICTS.NEGATIVE));
    const [f, s] = firstNumbers(row);
    assert.equal(f, 1400, 'F is the record\'s own wall clock');
    assert.equal(s, 1050);
    checked += 1;
  }
  assert.equal(checked, rates.length, 'every rate was checked');
});

test('FF-B353: the demonstrated width is the MINIMUM, so 1 wide run cannot vouch for a narrow one', () => {
  // A width of 1 is a serial run whatever the graph permitted, and an arm holding
  // one has not demonstrated width 4 just because another of its runs did.
  const fleet = [
    armDoc({ arm: 'fleet', wall: 800, width: 4, falseGreen: 0, landed: 4, rounds: 2 }),
    armDoc({ arm: 'fleet', wall: 800, width: 1, falseGreen: 0, landed: 4, rounds: 2 }),
  ];
  const result = lib.compareArms({ serial: serialPair(), fleet, permitted_width: 5 });

  assert.equal(result.demonstrated_width, 1, 'the minimum, never the maximum');
  assert.equal(result.width_gap, 4, 'and the gap is computed from it');
  assert.equal(result.verdict, lib.VERDICTS.MARGINAL);
  assert.ok(
    result.reasons.some((r) => /demonstrated width/i.test(r)),
    `the width blocker fires, got ${JSON.stringify(result.reasons)}`,
  );

  // The control: the SAME arm with the narrow run widened IS a POSITIVE, so the
  // MARGINAL above is the minimum and not some unrelated blocker.
  const control = lib.compareArms({
    serial: serialPair(),
    fleet: [fleet[0], armDoc({ arm: 'fleet', wall: 800, width: 2, falseGreen: 0, landed: 4, rounds: 2 })],
    permitted_width: 5,
  });
  assert.equal(control.verdict, lib.VERDICTS.POSITIVE);
  assert.equal(control.demonstrated_width, 2);
});

test('FF-B353: an UNKNOWN width on any 1 fleet record refuses the whole arm', () => {
  // All or nothing. A pooled width over the records that happened to report is a
  // number drawn from a sample the reader cannot see.
  const fleet = [
    armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
    armDoc({ arm: 'fleet', wall: 800, width: 3, widthState: lib.METRIC_STATES.UNKNOWN, falseGreen: 0, landed: 4, rounds: 2 }),
  ];
  const result = lib.compareArms({ serial: serialPair(), fleet, permitted_width: 5 });
  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
  assert.equal(result.demonstrated_width, null, 'never the 3 the other record reported');
  assert.equal(
    result.refusals.filter((r) => r.startsWith(lib.PROOF_REFUSALS.WIDTH_UNKNOWN)).length, 1,
  );
  const refusal = result.refusals.find((r) => r.startsWith(lib.PROOF_REFUSALS.WIDTH_UNKNOWN));
  assert.match(refusal, /known, unknown/, 'and the per record states are published, not collapsed');
});

test('FF-B353: an UNKNOWN wall clock or rounds on any 1 fleet record is handled all or nothing', () => {
  const wall = lib.compareArms({
    serial: serialPair(),
    fleet: [
      armDoc({ arm: 'fleet', wall: 800, falseGreen: 0, landed: 4, rounds: 2 }),
      armDoc({ arm: 'fleet', wall: 800, wallState: lib.METRIC_STATES.UNKNOWN, falseGreen: 0, landed: 4, rounds: 2 }),
    ],
    permitted_width: 5,
  });
  assert.equal(wall.verdict, lib.VERDICTS.INSUFFICIENT);
  assert.equal(
    wall.refusals.filter((r) => r.startsWith(lib.PROOF_REFUSALS.WALL_CLOCK_UNKNOWN)).length, 1,
  );
  assert.equal(wall.fleet_spread_ms, null, 'and no spread is derived from the 1 record that reported');

  // Rounds are EXCLUDED rather than refused, per FF-B346, and the exclusion is
  // all or nothing too: 1 unknown round count excludes the arm's round figure
  // rather than averaging the records that did report.
  const rounds = lib.compareArms({
    serial: serialPair({ rounds: 3 }),
    fleet: [
      armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 1 }),
      armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: null, roundsState: lib.METRIC_STATES.UNKNOWN }),
    ],
    permitted_width: 5,
  });
  assert.equal(rounds.verdict, lib.VERDICTS.POSITIVE, 'an unknown round count does not block');
  const row = rounds.reasons.find((r) => r.startsWith(lib.VERDICTS.POSITIVE));
  assert.match(row, /rounds per artifact UNKNOWN/, 'it is stated as unknown');
  assert.equal(
    /rounds per artifact 1\b/.test(row), false,
    'and the 1 record that DID report is not published as the arm\'s round count',
  );
});

test('FF-B353: a fleet rate with no landed count to weight it by refuses rather than pooling unweighted', () => {
  // A rate whose denominator went missing cannot be pooled with another. Treating
  // it as though it stood for 1 increment would flatten a large run into a small
  // one, and the direction that moves is toward whichever record reported least.
  const weightless = armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0.5, rounds: 2 });
  delete weightless.landed;
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 }), weightless],
    permitted_width: 5,
  });

  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
  const refusal = result.refusals.find((r) => r.startsWith(lib.PROOF_REFUSALS.FALSE_GREEN_UNDEFINED));
  assert.ok(refusal, `the pooling failure is named, got ${JSON.stringify(result.refusals)}`);
  assert.match(refusal, /1 fleet record/, 'and it COUNTS the offending records');
  assert.match(refusal, /no landed count to weight it by/);

  // The control: restoring the count makes the identical arm decide.
  weightless.landed = 4;
  const control = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 }), weightless],
    permitted_width: 5,
  });
  assert.equal(control.verdict, lib.VERDICTS.NEGATIVE, '2 false greens over 8 landed is 0.25');
  assert.deepEqual(control.refusals, []);
});

test('FF-B353: the fleet repeat spread is computed and PUBLISHED, and it enters no rule', () => {
  // It was computed nowhere at all while the fleet side held 1 document. It is
  // reported for the same reason `permitted_width` is, and it decides nothing:
  // the bar a POSITIVE clears is the SERIAL spread, declared before any run, and
  // a fleet that is noisy against itself does not widen its own bar afterwards.
  const tight = lib.compareArms({
    serial: serialPair(),
    fleet: [
      armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
      armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
    ],
    permitted_width: 5,
  });
  assert.equal(tight.fleet_spread_ms, 0, '2 identical wall clocks really are a spread of 0');
  assert.equal(tight.sigma_ms, 100, 'and sigma is still the serial spread');

  // A fleet spread 6 times sigma, with the SAME mean of 800, changes nothing.
  const noisy = lib.compareArms({
    serial: serialPair(),
    fleet: [
      armDoc({ arm: 'fleet', wall: 500, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
      armDoc({ arm: 'fleet', wall: 1100, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
    ],
    permitted_width: 5,
  });
  assert.equal(noisy.fleet_spread_ms, 600);
  assert.equal(noisy.fleet_spread_ms, tight.sigma_ms * 6, 'the spread really is 6 times sigma');
  assert.equal(noisy.verdict, tight.verdict, 'and the verdict did not move');
  assert.deepEqual(noisy.reasons, tight.reasons, 'nor did any published number');
});

test('FF-B353: an EMPTY fleet arm fires all 4 refusals it should, each exactly once', () => {
  // The refusals are all evaluated, so an empty arm reports 4 different facts
  // about itself and not merely the first. Before the fleet side became a list,
  // an absent arm arrived as `null` and 3 of these 4 came from reading states off
  // it; an empty LIST carries no state to read, so each is asserted here by name.
  const result = lib.compareArms({ serial: serialPair(), fleet: [], permitted_width: 3 });
  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
  assert.equal(result.fleet_records, 0);

  const expected = [
    lib.PROOF_REFUSALS.NO_FLEET_ARM,
    lib.PROOF_REFUSALS.WIDTH_UNKNOWN,
    lib.PROOF_REFUSALS.FALSE_GREEN_UNDEFINED,
    lib.PROOF_REFUSALS.WALL_CLOCK_UNKNOWN,
  ];
  let fired = 0;
  for (const refusal of expected) {
    assert.equal(
      result.refusals.filter((r) => r.startsWith(refusal)).length, 1,
      `${refusal} fires exactly once, got ${JSON.stringify(result.refusals)}`,
    );
    fired += 1;
  }
  assert.equal(fired, 4);
  assert.equal(result.refusals.length, 4, 'and no refusal fires that should not');

  // The wording names 0 RECORDS rather than rendering an empty gap. An arm
  // carrying 0 records and an arm whose every record refused are different facts.
  const width = result.refusals.find((r) => r.startsWith(lib.PROOF_REFUSALS.WIDTH_UNKNOWN));
  assert.match(width, /demonstrated width is absent: the arm carries 0 records/);
});

test('FF-B353: a corpus mismatch on the SECOND fleet record is still caught', () => {
  // A hash scan that read only the first fleet record would compare 2 arms over
  // different work and call it a comparison.
  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [
      armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
      armDoc({ arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2, corpus_hash: 'CORPUS-B' }),
    ],
    permitted_width: 5,
  });
  assert.equal(result.verdict, lib.VERDICTS.INSUFFICIENT);
  const refusal = result.refusals.find((r) => r.startsWith(lib.PROOF_REFUSALS.CORPUS_MISMATCH));
  assert.ok(refusal, `the mismatch is named, got ${JSON.stringify(result.refusals)}`);
  assert.match(refusal, /CORPUS-A/);
  assert.match(refusal, /CORPUS-B/);
  assert.equal(result.corpus_hash, '', 'and no single hash is published over 2 of them');
});

test('FF-B353: a REPLAYED provenance on the SECOND fleet record still blocks POSITIVE', () => {
  // D7 over a pooled arm. A provenance scan that read only the first record would
  // let a replayed run ride into a win behind a measured one, and a replayed arm
  // exhibits no contention by construction.
  const shared = { arm: 'fleet', wall: 800, width: 3, falseGreen: 0, landed: 4, rounds: 2 };
  const control = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc(shared), armDoc(Object.assign({}, shared, { provenance: 'measured' }))],
    permitted_width: 5,
  });
  assert.equal(control.verdict, lib.VERDICTS.POSITIVE, 'the all measured control IS positive');

  const result = lib.compareArms({
    serial: serialPair(),
    fleet: [armDoc(shared), armDoc(Object.assign({}, shared, { provenance: 'replayed' }))],
    permitted_width: 5,
  });
  assert.equal(result.verdict, lib.VERDICTS.MARGINAL);
  assert.ok(
    result.reasons.some((r) => /replayed/i.test(r)),
    `the replayed record must be named, got ${JSON.stringify(result.reasons)}`,
  );
});

test('FF-B353: the repeat spread is NOT the bar the NEGATIVE speed clause has to clear', () => {
  // The bar is SIGMA, the serial spread declared before any run. A fleet that is
  // noisy against itself does not get to widen its own bar afterwards, and this
  // arm is the case that separates the 2: it is slower than serial by more than
  // sigma and by LESS than its own repeat spread.
  const fleet = [
    armDoc({ arm: 'fleet', wall: 900, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
    armDoc({ arm: 'fleet', wall: 1900, width: 3, falseGreen: 0, landed: 4, rounds: 2 }),
  ];
  const result = lib.compareArms({ serial: serialPair(), fleet, permitted_width: 5 });

  // F is 1400, S is 1050, sigma is 100, and the fleet repeat spread is 1000.
  assert.equal(result.fleet_spread_ms, 1000);
  assert.equal(result.sigma_ms, 100);
  const row = result.reasons.find((r) => r.startsWith(lib.VERDICTS.NEGATIVE));
  assert.ok(row, `a NEGATIVE reason row exists, got ${JSON.stringify(result.reasons)}`);
  const [f, s, diff, sigma] = firstNumbers(row);
  assert.equal(f, 1400);
  assert.equal(s, 1050);
  assert.equal(f - s, diff);
  assert.equal(sigma, 100, 'the bar quoted in the reason is SIGMA, not the repeat spread');
  assert.ok(diff > sigma, 'and 350 clears it');
  assert.ok(diff < result.fleet_spread_ms, 'while falling well inside the repeat spread');
  assert.equal(
    result.verdict, lib.VERDICTS.NEGATIVE,
    'a slower fleet is NEGATIVE whatever its own noise, got '
      + JSON.stringify(result.reasons),
  );
});

test('FF-B353: the pooling method is published with the verdict, and it names the repair', () => {
  const result = lib.compareArms({
    serial: liveShapedSerial(), fleet: liveShapedFleet(), permitted_width: 5,
  });
  assert.equal(typeof result.pooling, 'string');
  assert.match(result.pooling, /FF-B353/, 'the row is named so a reader can look it up');
  assert.match(result.pooling, /MINIMUM/, 'the width rule is stated');
  assert.match(result.pooling, /COUNTS/, 'and so is the false green rule');
  assert.equal(result.serial_records, 2);
  assert.equal(result.fleet_records, 2);
  assert.equal(result.fleet.length, 2, 'the document carries every fleet record, not the first');
});

// ─── plan 07: the DERIVED contention fold ────────────────────────────────────
//
// 2 quantities, named apart and never merged:
//
//   PROCESS CONCURRENCY  the `concurrency` field plan 22-05's harness writes on
//                        `gate_started`. It is OBSERVED directly by the process
//                        that started the gates, and `foldLandGateCost` reads it.
//                        That path is untouched here.
//   CONTENTION DEPTH     how many increments were inside the land queue at the
//                        instant a gate began, DERIVED by pairing `queue_entered`
//                        with `land_completed`. Nothing records it as a field.
//
// FF-B252 is largely INVALID AS FILED and this fold is why.
// `src/fleet-landqueue.cts:875-889` states in its own words that the 5 land
// instants are emitted precisely so phase 22 can separate queue wait from gate
// cost from land latency. The figure was never missing. `foldLandGateCost` went
// looking for a `concurrency` field instead of folding the intervals that were
// put there for it, and the land gate is a single holder mutex, so a
// `concurrency` field on `gate_started` would have written a column of 1s that
// merely LOOKS measured.

/** A record carrying real land queue intervals, so a depth can be derived at all. */
function queuedRecord() {
  return [
    {
      ts: 1000, kind: 'run_started', run_id: 'q1', graph_generation: 'g1',
      corpus_hash: 'CORPUS-Q', arm: 'fleet', provenance: 'measured',
    },
    // n1 is alone in the queue when its gate starts: depth 1.
    { ts: 1010, kind: 'queue_entered', run_id: 'q1', node_id: 'n1', attempt_id: 'a1' },
    { ts: 1020, kind: 'gate_started', run_id: 'q1', node_id: 'n1', attempt_id: 'a1', gate: 'land' },
    { ts: 1120, kind: 'gate_ended', run_id: 'q1', node_id: 'n1', attempt_id: 'a1', gate: 'land', verdict: 'green' },
    { ts: 1130, kind: 'land_completed', run_id: 'q1', node_id: 'n1', attempt_id: 'a1', result: 'landed' },
    // n2 and n3 are both queued when n3's gate starts: depth 2.
    { ts: 2000, kind: 'queue_entered', run_id: 'q1', node_id: 'n2', attempt_id: 'a2' },
    { ts: 2010, kind: 'queue_entered', run_id: 'q1', node_id: 'n3', attempt_id: 'a3' },
    { ts: 2020, kind: 'gate_started', run_id: 'q1', node_id: 'n3', attempt_id: 'a3', gate: 'land' },
    { ts: 2320, kind: 'gate_ended', run_id: 'q1', node_id: 'n3', attempt_id: 'a3', gate: 'land', verdict: 'green' },
    { ts: 2330, kind: 'land_completed', run_id: 'q1', node_id: 'n3', attempt_id: 'a3', result: 'landed' },
    { ts: 2340, kind: 'land_completed', run_id: 'q1', node_id: 'n2', attempt_id: 'a2', result: 'landed' },
    { ts: 2400, kind: 'run_closed', run_id: 'q1' },
  ];
}

test('the contention fold derives a depth from the queue intervals that were always there', () => {
  const result = lib.foldLandGateContention(queuedRecord());
  assert.equal(result.state, lib.METRIC_STATES.KNOWN);
  assert.equal(result.depth, 2, 'n2 and n3 overlap in the queue, so the peak depth is 2');
  assert.deepEqual(
    result.buckets,
    [
      { depth: 1, n: 1, median_ms: 100, max_ms: 100 },
      { depth: 2, n: 1, median_ms: 300, max_ms: 300 },
    ],
    'each closed gate interval is placed at the depth observed at its START instant',
  );
  assert.equal(result.baseline_ms, 100);
  assert.equal(result.degradation, 3, 'the gate took 3 times as long at depth 2');
});

test('the contention fold reads NO concurrency field, so a record carrying one is folded identically', () => {
  const withField = queuedRecord().map((e) => (
    e.kind === 'gate_started' ? { ...e, concurrency: 99 } : e
  ));
  const derived = lib.foldLandGateContention(withField);
  const plain = lib.foldLandGateContention(queuedRecord());

  // A fold that read the field would report depth 99 and the whole point of
  // DERIVING it would be lost. The 2 quantities stay apart.
  assert.equal(derived.depth, 2, 'the derived depth ignores the recorded process concurrency entirely');
  assert.deepEqual(derived.buckets, plain.buckets);
});

test('an unterminated queue interval makes the contention depth unknown, never the end of the run', () => {
  // n2 enters the queue and never completes. A fold that closed it at run end
  // would report a depth larger than anything observed, and inflating the
  // contention number is the direction that flatters a land gate claim.
  const record = queuedRecord().filter(
    (e) => !(e.kind === 'land_completed' && e.attempt_id === 'a2'),
  );
  const result = lib.foldLandGateContention(record);

  assert.equal(result.state, lib.METRIC_STATES.UNKNOWN);
  assert.equal(result.depth, null);
  assert.deepEqual(result.buckets, []);
  assert.match(result.reason, /1 unterminated queue interval/);

  // The CONTROL: the same record with the completion restored folds to a number.
  assert.equal(lib.foldLandGateContention(queuedRecord()).state, lib.METRIC_STATES.KNOWN);
});

test('a land_completed with no queue_entered makes the contention depth unknown', () => {
  const record = queuedRecord().filter(
    (e) => !(e.kind === 'queue_entered' && e.attempt_id === 'a2'),
  );
  const result = lib.foldLandGateContention(record);
  assert.equal(result.state, lib.METRIC_STATES.UNKNOWN);
  assert.equal(result.depth, null);
  assert.match(result.reason, /1 land_completed/);
});

test('a record carrying no land queue events at all reports UNDEFINED, never a depth of 0', () => {
  const result = lib.foldLandGateContention(goodRecord().filter(
    (e) => e.kind !== 'queue_entered' && e.kind !== 'land_completed',
  ));
  assert.equal(result.state, lib.METRIC_STATES.UNDEFINED);
  assert.equal(result.depth, null, 'an absent depth is null, never 0 and never a negative sentinel');
  assert.notEqual(result.depth, 0, 'a depth of 0 and a depth nobody could derive are different claims');
  assert.match(result.reason, /no land queue events/);
});

test('a derived depth with no closed gate interval reports UNKNOWN rather than an empty curve', () => {
  const record = queuedRecord().filter((e) => e.kind !== 'gate_started' && e.kind !== 'gate_ended');
  const result = lib.foldLandGateContention(record);
  assert.equal(result.state, lib.METRIC_STATES.UNKNOWN);
  assert.match(result.reason, /0 closed gate intervals/);
});

test('the 6 SC3 metric keys are unchanged: the contention fold is a diagnostic, not a 7th metric', () => {
  const doc = lib.assembleFoldDocument({ events: queuedRecord() });
  assert.equal(Object.keys(doc.metrics).length, 6, 'the SC3 metric set is exactly 6 and this fold did not join it');
  assert.equal(doc.metrics.land_gate_contention, undefined);
  assert.equal(typeof lib.foldLandGateContention, 'function', 'and it is exported for a reader to call directly');
});

test('no published record can yield a contention depth, and the 2 reasons are different facts', () => {
  // The honest state of the repository today, MEASURED rather than assumed. This
  // assertion was written expecting 1 answer and the records gave 2, so it now
  // asserts the partition the data actually has. Neither state is a guess and
  // the distinction matters to a reader:
  //
  //   UNDEFINED  the land gate harness records describe no queue at all. They
  //              time gate processes directly and never enter one.
  //   UNKNOWN    the corpus baseline records carry land completions for
  //              increments that were never seen to queue, because the corpus
  //              runner lands in process and does not go through the land queue.
  //
  // Both become a real number with no change here the moment a run through
  // `src/fleet-landqueue.cts` is recorded, which is what that module emits its 5
  // instants for.
  const proofDir = path.join(__dirname, '..', '.planning', 'proof');
  const files = fs.readdirSync(proofDir).filter((f) => f.endsWith('.jsonl')).sort();
  assert.ok(files.length > 0, 'the published directory holds records at all');

  const states = { known: 0, unknown: 0, undefined: 0 };
  for (const file of files) {
    const events = fs.readFileSync(path.join(proofDir, file), 'utf8')
      .split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
    states[lib.foldLandGateContention(events).state] += 1;
  }

  assert.equal(states.known, 0, 'not 1 published record yields a derived contention depth');
  assert.ok(states.undefined > 0, 'some records describe no queue at all');
  assert.ok(states.unknown > 0, 'and some carry lands that were never seen to queue');
  assert.equal(states.undefined + states.unknown, files.length, 'every record lands in exactly 1 of the 2');
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
