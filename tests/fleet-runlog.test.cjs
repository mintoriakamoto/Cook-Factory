'use strict';

/**
 * Phase 19 plan 01 task 1: the fleet event vocabulary, the durable concurrent
 * append and the strict reader.
 *
 * D7 is the design of this file. The defect class this repository ships every
 * time is a guard that cannot fire, so every assertion below is shaped so that
 * removing the thing it guards makes it go red. Three shapes in particular:
 *
 * 1. Every coded refusal is asserted by BRANCHING ON `err.code`, never by
 *    matching prose. A test that matches a message passes on a rewritten message
 *    and fails on a corrected one, which is exactly backwards.
 *
 * 2. Every refusal case asserts the log file is BYTE IDENTICAL before and after
 *    the refused call. "It threw" is not the property. The property is that
 *    nothing was written, and a validator that opened the file, wrote, and then
 *    threw would sail through an assert.throws on its own.
 *
 * 3. The bound case is driven from BOTH sides. A test that only asserts an
 *    oversized record is refused passes on a module that refuses everything. The
 *    1-byte-under case is what makes the bound a bound rather than a wall.
 *
 * The protocol assertion at the end reads the BUILT artifact rather than the TS
 * source, because the built artifact is what every caller loads. It is the
 * regression guard for the inherited gap D4 names at `src/antiloop-log.cts:98`:
 * a plain append call carries neither mutual exclusion nor durability, and a
 * later edit that reintroduced one would otherwise pass every behavioral case in
 * this file, since a plain append behaves identically with 1 writer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-runlog.cjs');

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-runlog-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/** A scratch log path that does not exist yet. */
function logPath(label) {
  return path.join(scratch(label), '.planning', 'fleet-runlog.jsonl');
}

/** Raw bytes of the log, or the sentinel null when it does not exist. */
function snapshot(target) {
  try {
    return fs.readFileSync(target).toString('base64');
  } catch {
    return null;
  }
}

/** A well formed claim_acquired record. */
function claim(overrides = {}) {
  return {
    ts: 1_700_000_000_000,
    kind: 'claim_acquired',
    run_id: 'run-a',
    node_id: '19-01',
    worker_id: 'w1',
    lease_epoch: 1,
    ...overrides,
  };
}

/**
 * A record whose serialized line plus newline is EXACTLY `targetBytes`. The pad
 * is ASCII, so 1 character is 1 byte and the arithmetic is exact rather than
 * approximate. An approximate size would make the boundary cases untrustworthy.
 */
function sizedEvent(targetBytes, base) {
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, pad: '' }) + '\n', 'utf8');
  const padLen = targetBytes - overhead;
  assert.ok(padLen >= 0, `sizedEvent: base record already exceeds ${targetBytes} bytes`);
  return { ...base, pad: 'x'.repeat(padLen) };
}

/** Run `fn`, return the thrown error, and fail loudly when nothing was thrown. */
function thrown(fn, why) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail(`expected a throw: ${why}`);
}

const CODES = runlog.FLEET_RUNLOG_ERROR_CODES;

// ─── the vocabulary itself ───────────────────────────────────────────────────

test('the vocabulary is exactly the 16 kinds the event contract fixes, and it is frozen', () => {
  assert.equal(runlog.FLEET_EVENT_KINDS.length, 16, 'the contract fixes 16 kinds');
  assert.deepEqual([...runlog.FLEET_EVENT_KINDS], [
    'run_started', 'run_closed',
    'worker_started', 'worker_ended',
    'claim_acquired', 'lease_renewed', 'lease_released', 'lease_reclaimed',
    'queue_entered', 'queue_acquired',
    'gate_started', 'gate_ended',
    'land_completed', 'post_land_truth',
    'node_parked', 'park_alarm',
  ]);
  assert.ok(Object.isFrozen(runlog.FLEET_EVENT_KINDS), 'a vocabulary a call site can extend is not a vocabulary');
  assert.ok(Object.isFrozen(runlog.FLEET_EVENT_REQUIRED_FIELDS), 'the required field map is frozen too');
  assert.ok(Object.isFrozen(runlog.FLEET_COMMON_FIELDS));
  assert.ok(Object.isFrozen(CODES));
  assert.deepEqual([...runlog.FLEET_COMMON_FIELDS], ['ts', 'kind', 'run_id']);
  assert.equal(runlog.FLEET_MAX_RECORD_BYTES, 4096, 'the POSIX atomic append bound');
});

test('every kind the schema names has a required field entry, and the phase 22 fields are all reachable', () => {
  for (const kind of runlog.FLEET_EVENT_KINDS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(runlog.FLEET_EVENT_REQUIRED_FIELDS, kind),
      `kind ${kind} has no required field entry, so its record could never be validated`,
    );
  }
  // Derived backwards from D3's table: without any 1 of these, a metric phase 22
  // must produce becomes impossible to compute.
  const all = new Set(runlog.FLEET_COMMON_FIELDS);
  for (const fields of Object.values(runlog.FLEET_EVENT_REQUIRED_FIELDS)) {
    for (const f of fields) all.add(f);
  }
  for (const needed of ['run_id', 'graph_generation', 'node_id', 'attempt_id', 'lease_epoch', 'ticket', 'outcome', 'classification', 'verdict', 'result']) {
    assert.ok(all.has(needed), `phase 22 cannot compute without ${needed}`);
  }
  assert.deepEqual(
    [...runlog.FLEET_EVENT_REQUIRED_FIELDS.worker_ended],
    ['worker_id', 'node_id', 'attempt_id', 'outcome'],
    'an explicit end event including on abnormal exit is what makes width knowable',
  );
  assert.deepEqual(
    [...runlog.FLEET_EVENT_REQUIRED_FIELDS.post_land_truth],
    ['node_id', 'attempt_id', 'classification'],
    'post land truth is recorded in its own right, never derived from a gate verdict',
  );
});

test('fleetRunlogPath resolves under .planning, and both verbs refuse an implicit path', () => {
  assert.equal(runlog.fleetRunlogPath('/x/y'), path.join('/x/y', '.planning', 'fleet-runlog.jsonl'));
  assert.throws(() => runlog.appendFleetEvent(claim()), /opts\.path is required/);
  assert.throws(() => runlog.appendFleetEvent(claim(), { path: '' }), /opts\.path is required/);
  assert.throws(() => runlog.readFleetRunlog(), /opts\.path is required/);
  assert.throws(() => runlog.readFleetRunlog({ path: '' }), /opts\.path is required/);
});

// ─── the happy path ──────────────────────────────────────────────────────────

test('a known kind carrying every required field appends and reads back identical', () => {
  const target = logPath('roundtrip');
  const entry = claim();
  runlog.appendFleetEvent(entry, { path: target });
  const read = runlog.readFleetRunlog({ path: target });
  assert.equal(read.length, 1);
  assert.deepEqual(read[0], entry, 'the record read back is the record written, field for field');
});

test('one record of every 1 of the 16 kinds round trips', () => {
  const target = logPath('all-kinds');
  const bank = {
    run_started: { graph_generation: 7 },
    run_closed: {},
    worker_started: { worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', lease_epoch: 1 },
    worker_ended: { worker_id: 'w1', node_id: 'n1', attempt_id: 'a1', outcome: 'abnormal' },
    claim_acquired: { node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
    lease_renewed: { node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
    lease_released: { node_id: 'n1', worker_id: 'w1', lease_epoch: 1 },
    lease_reclaimed: { node_id: 'n1', worker_id: 'w2', lease_epoch: 2, prior_worker_id: 'w1', prior_lease_epoch: 1, reason: 'lease-expired' },
    queue_entered: { node_id: 'n1', attempt_id: 'a1', ticket: 1 },
    queue_acquired: { node_id: 'n1', attempt_id: 'a1', ticket: 1, worker_id: 'w1' },
    gate_started: { node_id: 'n1', attempt_id: 'a1' },
    gate_ended: { node_id: 'n1', attempt_id: 'a1', verdict: 'green' },
    land_completed: { node_id: 'n1', attempt_id: 'a1', result: 'landed' },
    post_land_truth: { node_id: 'n1', attempt_id: 'a1', classification: 'held' },
    node_parked: { node_id: 'n1', reason: 'blocked-on-human', attempts: 2, on_critical_path: true },
    park_alarm: { node_id: 'n1', scope: 'node', route: 'synchronous', parked_count: 1, budget: 3 },
  };
  const written = [];
  for (const kind of runlog.FLEET_EVENT_KINDS) {
    const entry = { ts: 1000, kind, run_id: 'run-a', ...bank[kind] };
    runlog.appendFleetEvent(entry, { path: target });
    written.push(entry);
  }
  assert.deepEqual(runlog.readFleetRunlog({ path: target }), written);
});

test('appends preserve order: 3 sequential appends read back in the order written', () => {
  const target = logPath('order');
  for (const seq of [0, 1, 2]) {
    runlog.appendFleetEvent(claim({ node_id: `n-${seq}`, ts: 1000 + seq }), { path: target });
  }
  const read = runlog.readFleetRunlog({ path: target });
  assert.deepEqual(read.map((e) => e.node_id), ['n-0', 'n-1', 'n-2']);
});

// ─── the park vocabulary, phase 20 SC1 ───────────────────────────────────────

/** A well formed node_parked record. */
function parked(overrides = {}) {
  return {
    ts: 1_700_000_000_000,
    kind: 'node_parked',
    run_id: 'run-a',
    node_id: '20-03',
    reason: 'blocked-on-human',
    attempts: 2,
    on_critical_path: true,
    ...overrides,
  };
}

/** A well formed park_alarm record. */
function alarm(overrides = {}) {
  return {
    ts: 1_700_000_000_001,
    kind: 'park_alarm',
    run_id: 'run-a',
    node_id: '20-03',
    scope: 'node',
    route: 'synchronous',
    parked_count: 1,
    budget: 3,
    ...overrides,
  };
}

test('node_parked accepts a complete record and refuses one with on_critical_path absent', () => {
  const target = logPath('park-node');
  const entry = parked();
  runlog.appendFleetEvent(entry, { path: target });
  assert.deepEqual(runlog.readFleetRunlog({ path: target }), [entry]);

  const before = snapshot(target);
  const short = parked();
  delete short.on_critical_path;
  const err = thrown(
    () => runlog.appendFleetEvent(short, { path: target }),
    'on_critical_path is absent, so the synchronous alarm route could never be told from the queued one',
  );
  assert.equal(err.code, CODES.E_FLEET_MISSING_FIELD, 'callers branch on the code, never on the prose');
  assert.match(err.message, /on_critical_path/, 'the refusal names the absent field');
  assert.equal(snapshot(target), before, 'a refused append writes NOTHING; the log is byte identical');
});

test('park_alarm accepts a complete record and refuses one with route absent', () => {
  const target = logPath('park-alarm');
  const entry = alarm();
  runlog.appendFleetEvent(entry, { path: target });
  assert.deepEqual(runlog.readFleetRunlog({ path: target }), [entry]);

  const before = snapshot(target);
  const short = alarm();
  delete short.route;
  const err = thrown(
    () => runlog.appendFleetEvent(short, { path: target }),
    'route is absent, and D7.5 requires the 2 alarm routes distinguishable in the run record',
  );
  assert.equal(err.code, CODES.E_FLEET_MISSING_FIELD);
  assert.match(err.message, /route/, 'the refusal names the absent field');
  assert.equal(snapshot(target), before, 'a refused append writes NOTHING; the log is byte identical');
});

test('a budget scoped park_alarm still carries parked_count and budget, so every alarm states the distance to the budget', () => {
  const target = logPath('park-alarm-budget');
  const entry = alarm({ scope: 'budget', route: 'queued', parked_count: 3 });
  runlog.appendFleetEvent(entry, { path: target });
  assert.deepEqual(runlog.readFleetRunlog({ path: target }), [entry]);

  const before = snapshot(target);
  const short = alarm({ scope: 'budget', route: 'queued', parked_count: 3 });
  delete short.parked_count;
  const err = thrown(() => runlog.appendFleetEvent(short, { path: target }), 'parked_count is absent');
  assert.equal(err.code, CODES.E_FLEET_MISSING_FIELD);
  assert.equal(snapshot(target), before);
});

test('neither park kind carries attempt_id, so the derived attempt bearing set at fleet-runfold.cts:184 does not grow', () => {
  const map = runlog.FLEET_EVENT_REQUIRED_FIELDS;
  const attemptBearing = runlog.FLEET_EVENT_KINDS.filter(
    (k) => map[k].includes('node_id') && map[k].includes('attempt_id'),
  );
  for (const kind of ['node_parked', 'park_alarm']) {
    assert.ok(runlog.FLEET_EVENT_KINDS.includes(kind), `${kind} is in the vocabulary`);
    assert.ok(
      !map[kind].includes('attempt_id'),
      `${kind} must not carry attempt_id. A park is a statement about a NODE across all of its attempts, and a `
        + 'kind carrying both node_id and attempt_id joins the set derived at src/fleet-runfold.cts:184, which the '
        + 'battery at tests/fleet-runfold.test.cjs walks against a hand written bank.',
    );
    assert.ok(!attemptBearing.includes(kind), `${kind} stays out of the derived attempt bearing set`);
    assert.ok(map[kind].includes('node_id'), `${kind} DOES carry node_id, so a parked node appears in the fold`);
  }
  assert.deepEqual(
    [...map.node_parked],
    ['node_id', 'reason', 'attempts', 'on_critical_path'],
    'attempts carries the count instead of attempt_id',
  );
  assert.deepEqual(
    [...map.park_alarm],
    ['node_id', 'scope', 'route', 'parked_count', 'budget'],
  );
});

// ─── the 3 append refusals: each asserts the file is untouched ────────────────

test('an unknown kind is refused with E_FLEET_UNKNOWN_KIND and nothing is written', () => {
  const target = logPath('unknown-kind');
  runlog.appendFleetEvent(claim(), { path: target });
  const before = snapshot(target);

  const err = thrown(
    () => runlog.appendFleetEvent({ ts: 1, kind: 'worker_exploded', run_id: 'run-a' }, { path: target }),
    'worker_exploded is not 1 of the 16 kinds',
  );
  assert.equal(err.code, CODES.E_FLEET_UNKNOWN_KIND, 'callers branch on the code, never on the prose');
  assert.equal(snapshot(target), before, 'a refused append writes NOTHING; the log is byte identical');
});

test('a known kind missing 1 required field is refused with E_FLEET_MISSING_FIELD and names the field', () => {
  const target = logPath('missing-field');
  runlog.appendFleetEvent(claim(), { path: target });
  const before = snapshot(target);

  // lease_epoch is what tells a renewal apart from a reclaim after a crash.
  const short = claim();
  delete short.lease_epoch;
  const err = thrown(() => runlog.appendFleetEvent(short, { path: target }), 'lease_epoch is absent');
  assert.equal(err.code, CODES.E_FLEET_MISSING_FIELD);
  assert.match(err.message, /lease_epoch/, 'the refusal names the absent field so the repair is obvious');
  assert.equal(snapshot(target), before, 'nothing written');

  // A common field is required on every kind, not only the kind specific ones.
  const noRun = claim();
  delete noRun.run_id;
  const err2 = thrown(() => runlog.appendFleetEvent(noRun, { path: target }), 'run_id is absent');
  assert.equal(err2.code, CODES.E_FLEET_MISSING_FIELD);
  assert.match(err2.message, /run_id/);
  assert.equal(snapshot(target), before, 'nothing written');

  // An explicit undefined is absence, not presence. A `field in entry` check
  // would pass here and write a record carrying `undefined`, which JSON.stringify
  // then DROPS, producing a silently short record on disk.
  const undef = claim({ lease_epoch: undefined });
  const err3 = thrown(() => runlog.appendFleetEvent(undef, { path: target }), 'lease_epoch is explicitly undefined');
  assert.equal(err3.code, CODES.E_FLEET_MISSING_FIELD);
  assert.equal(snapshot(target), before, 'nothing written');
});

test('a record at or past FLEET_MAX_RECORD_BYTES is refused with E_FLEET_RECORD_TOO_LARGE and nothing is written', () => {
  const target = logPath('too-large');
  runlog.appendFleetEvent(claim(), { path: target });
  const before = snapshot(target);

  for (const size of [runlog.FLEET_MAX_RECORD_BYTES, runlog.FLEET_MAX_RECORD_BYTES + 1, runlog.FLEET_MAX_RECORD_BYTES * 4]) {
    const big = sizedEvent(size, claim());
    assert.equal(
      Buffer.byteLength(JSON.stringify(big) + '\n', 'utf8'), size,
      'the fixture is exactly the size it claims, or the boundary proves nothing',
    );
    const err = thrown(() => runlog.appendFleetEvent(big, { path: target }), `${size} bytes is at or past the bound`);
    assert.equal(err.code, CODES.E_FLEET_RECORD_TOO_LARGE);
    assert.equal(snapshot(target), before, 'a torn line is unrecoverable, so an oversized record is never written at all');
  }
});

test('a record 1 byte under the bound is accepted, so the bound is a bound and not a wall', () => {
  const target = logPath('under-bound');
  const justUnder = sizedEvent(runlog.FLEET_MAX_RECORD_BYTES - 1, claim());
  assert.equal(Buffer.byteLength(JSON.stringify(justUnder) + '\n', 'utf8'), runlog.FLEET_MAX_RECORD_BYTES - 1);
  runlog.appendFleetEvent(justUnder, { path: target });
  const read = runlog.readFleetRunlog({ path: target });
  assert.equal(read.length, 1, 'the largest legal record lands');
  assert.deepEqual(read[0], justUnder);
});

test('the refusals fire in a fixed order, so a record with 2 defects produces a deterministic code', () => {
  const target = logPath('order-of-refusal');
  // Unknown kind AND oversized: the kind check runs first.
  const both = sizedEvent(runlog.FLEET_MAX_RECORD_BYTES + 100, { ts: 1, kind: 'not_a_kind', run_id: 'run-a' });
  const err = thrown(() => runlog.appendFleetEvent(both, { path: target }), 'two defects at once');
  assert.equal(err.code, CODES.E_FLEET_UNKNOWN_KIND, 'kind is checked before size');
  assert.equal(snapshot(target), null, 'a refused append does not even create the file');
});

// ─── the strict reader ───────────────────────────────────────────────────────

test('reading a log whose file does not exist returns an empty array rather than throwing', () => {
  const target = logPath('absent');
  assert.deepEqual(runlog.readFleetRunlog({ path: target }), [], 'a run that has not started has an empty history, not a broken one');
});

test('a blank or whitespace only line is skipped, so a trailing newline yields no phantom record', () => {
  const target = logPath('blanks');
  runlog.appendFleetEvent(claim({ node_id: 'n-0' }), { path: target });
  runlog.appendFleetEvent(claim({ node_id: 'n-1' }), { path: target });
  // Trailing newline plus a whitespace only line, exactly what a hand edit leaves.
  fs.appendFileSync(target, '\n   \n\t\n');
  const read = runlog.readFleetRunlog({ path: target });
  assert.equal(read.length, 2, 'a phantom record would inflate every count folded out of this file');
  assert.deepEqual(read.map((e) => e.node_id), ['n-0', 'n-1']);
});

test('a line that will not parse throws E_FLEET_LOG_UNPARSEABLE naming the 1-based line number and the path', () => {
  const target = logPath('unparseable');
  runlog.appendFleetEvent(claim({ node_id: 'n-0' }), { path: target });
  fs.appendFileSync(target, '{"kind":"claim_acquired",TORN\n');
  runlog.appendFleetEvent(claim({ node_id: 'n-2' }), { path: target });

  const err = thrown(() => runlog.readFleetRunlog({ path: target }), 'line 2 is torn');
  assert.equal(err.code, CODES.E_FLEET_LOG_UNPARSEABLE);
  assert.match(err.message, /line 2\b/, '1-based, so it matches what an editor shows');
  assert.ok(err.message.includes(target), 'the refusal names the path so the repair is obvious');
});

test('the reader THROWS on a torn line rather than skipping it, which is what stops a published figure being silently lowered', () => {
  const target = logPath('no-silent-skip');
  for (const seq of [0, 1, 2]) runlog.appendFleetEvent(claim({ node_id: `n-${seq}` }), { path: target });
  const clean = runlog.readFleetRunlog({ path: target });
  assert.equal(clean.length, 3);

  // Tear the middle line in place. A reader that skipped would return 2 records
  // and report a lower width, a lower round count and a lower false green rate,
  // all without a single error anywhere.
  const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
  lines[1] = lines[1].slice(0, 20);
  fs.writeFileSync(target, lines.join('\n'));

  const err = thrown(() => runlog.readFleetRunlog({ path: target }), 'the middle line is truncated');
  assert.equal(err.code, CODES.E_FLEET_LOG_UNPARSEABLE);
});

// ─── the append protocol, asserted against the artifact callers actually load ──

test('the append protocol is locked and synced, and is NOT the inherited plain append at antiloop-log.cts:98', () => {
  const built = fs.readFileSync(BUILT_LIB, 'utf8');
  assert.ok(
    built.includes('withFileLock'),
    'the append runs inside withFileLock, the shipped primitive D2 names; without it 2 read decide write '
      + 'transactions in plans 03 and 04 can interleave',
  );
  assert.ok(
    built.includes('fsyncSync'),
    'the descriptor is synced before it is closed; without it a returned append is in the page cache, not on the medium',
  );
  // The CALL form, not the name. The header comment names the inherited helper in
  // prose, and a substring check on the bare name went red on that comment the
  // first time this ran, which is a guard firing on the wrong thing. A call is
  // `fs.appendFileSync(`; a mention is not.
  assert.ok(
    !/\bappendFileSync\s*\(/.test(built),
    'the convenience append helper carries neither mutual exclusion nor durability. It behaves identically '
      + 'with 1 writer, so every behavioral case above would still pass if it were reintroduced. This line is '
      + 'the only thing that catches that regression.',
  );
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
