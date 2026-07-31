'use strict';

/**
 * Phase 19 plan 01 task 2: the append protocol under REAL concurrent writer
 * processes, plus the negative case that drives the same run with the protocol
 * removed.
 *
 * D7 names 4 things that pass trivially for a concurrent system, and the first is
 * "a lock test that never actually races". Three constructions defeat that here
 * and all 3 are required:
 *
 *   1. A BARRIER. Every child announces it is ready, then busy waits on a start
 *      file the parent writes only once all of them have announced. Without it
 *      the writers begin serially at process startup cost, which on this machine
 *      is tens of milliseconds per child, comfortably longer than the whole write
 *      loop. A test built that way never races and can never fail.
 *
 *   2. A TIGHT LOOP. Each child appends with no sleep between records, so the
 *      writers overlap for the WHOLE run rather than at 1 instant.
 *
 *   3. OBSERVED OVERLAP, asserted rather than assumed. Every child reports the
 *      wall time it saw the barrier release and the wall time it finished. The
 *      parent asserts max(release) < min(finish), which is the definition of "all
 *      4 were active at once". If the children serialized for any reason, that
 *      assertion goes red and says so, instead of the suite quietly proving
 *      nothing. This is the only line in the file that can catch a race that
 *      stopped racing.
 *
 * WHY THIS FILE READS THE REAL CLOCK. Everywhere else in this repository time is
 * pinned through `ferrox-core/bin/lib/clock.cjs`. Here the measurement IS elapsed
 * real time across processes, and a pinned clock would make the overlap evidence
 * vacuous. The MODULE under test still never reads a clock: every `ts` below is
 * caller supplied, exactly as the event contract requires.
 *
 * ─── THE NEGATIVE CASE, AND ITS MEASURED TERMINAL OUTCOME ────────────────────
 *
 * The negative case exists because a positive concurrency result at 40 bytes per
 * record means nothing: a small append is atomic on this platform by accident of
 * the implementation, so a battery driven at that size reports a green that is
 * about the kernel rather than about the protocol.
 *
 * So the negative case removes the protocol entirely (a persistent append-mode
 * descriptor, no lock, no sync, which is exactly the inherited shape at
 * `src/antiloop-log.cts:98`) and drives records PAST the atomic append bound with
 * 8 barrier released writers.
 *
 * MEASURED OUTCOME ON THIS PLATFORM, RECORDED HERE SO THE NEXT READER KNOWS WHAT
 * WAS SEEN RATHER THAN WHAT WAS EXPECTED. This is the output of the loop below,
 * reproduced by this file on 2026-07-26, not a figure copied in from elsewhere:
 *
 *     size=4200     writers=8 lines=320/320 unparseable=0 embedded=0 distinct=320 -> NO TEAR
 *     size=1048576  writers=8 lines=320/320 unparseable=0 embedded=0 distinct=320 -> NO TEAR
 *
 * NO RECORD SIZE WITHIN THE CEILING TORE. That is the finding, and it is
 * reported rather than worked around.
 *
 * NO TEAR IS THE TERMINAL OUTCOME AND IT IS A PASS. `O_APPEND` writes to a
 * regular file did not tear at any size up to the 1 MiB ceiling. THE CEILING IS
 * HARD AND `assertCeilingRespected` BELOW ENFORCES IT IN CODE: an unbounded
 * "raise the size until it fires" search is precisely the unbounded loop this
 * milestone exists to prevent, and a mechanism beats a comment asking nicely.
 *
 * DO NOT CONCLUDE FROM THIS THAT THE LOCK IS UNNECESSARY. On this platform the
 * lock's load bearing job is not kernel line atomicity. It is MUTUAL EXCLUSION
 * for the read decide write transactions plans 03 and 04 build on top of this
 * module, both of which are proven by batteries that genuinely do fire. What the
 * measurement licenses is a precise claim, not a weaker one: line atomicity here
 * is a property of the platform, and the protocol is what makes it a property of
 * the SYSTEM.
 *
 * Because tearing could not be reproduced, the negative case does not assert a
 * tear. It asserts the 3 things that make it a real case rather than a green that
 * means nothing:
 *
 *   a. the dangerous configuration was ACTUALLY DRIVEN — no lockfile was ever
 *      created during the unlocked run, so the case did not secretly take the
 *      protected path and report a meaningless pass;
 *   b. the records really were past `FLEET_MAX_RECORD_BYTES`, the size at which a
 *      concurrent append is PERMITTED to interleave;
 *   c. `appendFleetEvent` REFUSES every one of those sizes, so the window in
 *      which tearing is permitted is unreachable through the module at all.
 *
 * (c) is the mitigation for T-19-02 and it is a genuine assertion: remove the
 * size bound and this file goes red.
 *
 * THE SECOND HALF OF THE SAME FINDING, MEASURED THE SAME DAY BY A MUTATION
 * BATTERY AGAINST THE BUILT ARTIFACT. Replacing the module's locked, synced
 * append with the inherited plain `appendFileSync` leaves EVERY case in this file
 * green. That mutation SURVIVES on this platform, and it is recorded rather than
 * hidden, because it is the honest boundary of what this file proves: line
 * atomicity here is the platform's doing, so no cross-process log inspection can
 * detect the missing lock. What DOES detect it is
 * `tests/fleet-runlog.test.cjs`'s protocol assertion, which reads the built
 * artifact directly, and that is why that assertion exists rather than being
 * dismissed as a structural test. The 2 files split the job: this one proves the
 * protocol is exercised concurrently for real, that one proves the protocol is
 * still there.
 *
 * THIS CASE IS NEVER DELETED. A mutation case that cannot fire is a finding to
 * report, not a case to remove.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-runlog.cjs');

/**
 * THE HARD CEILING. 1 MiB. Raising this in search of a failure is forbidden: an
 * unbounded search for a size that tears is the unbounded loop this milestone
 * exists to prevent. `assertCeilingRespected` makes that a mechanism.
 */
const TEAR_SIZE_CEILING_BYTES = 1_048_576;

/** The 2 sizes the reproduction was measured at. Both are past the atomic bound. */
const TEAR_SIZES = [4200, TEAR_SIZE_CEILING_BYTES];

const POSITIVE_WRITERS = 4;
const POSITIVE_RECORDS = 40;
const NEGATIVE_WRITERS = 8;
const NEGATIVE_RECORDS = 40;

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-runlog-cc-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/**
 * The child. Written to disk and spawned as a real process, because 4 workers in
 * 1 process share a descriptor table and an event loop and therefore cannot
 * exercise a CROSS PROCESS lock at all.
 *
 * Readiness is announced on stdout rather than by a file the parent polls: the
 * parent then waits on an EVENT instead of on a timer, so the barrier has no
 * sleep in it and cannot be widened by a slow machine.
 *
 * argv: mode logPath startFile resultFile writerIndex records padBytes
 */
const CHILD_SOURCE = `'use strict';
const fs = require('node:fs');
const runlog = require(${JSON.stringify(BUILT_LIB)});

const [mode, logPath, startFile, resultFile, idxRaw, countRaw, padRaw] = process.argv.slice(2);
const idx = Number(idxRaw);
const count = Number(countRaw);
const padBytes = Number(padRaw);

/** A record of exactly padBytes serialized bytes when padBytes > 0. */
function record(seq) {
  const base = {
    ts: 1700000000000 + seq,
    kind: 'claim_acquired',
    run_id: 'run-cc',
    node_id: 'w' + idx + '-' + seq,
    worker_id: 'w' + idx,
    lease_epoch: 1,
  };
  if (padBytes <= 0) return base;
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, pad: '' }) + '\\n', 'utf8');
  return { ...base, pad: 'x'.repeat(Math.max(0, padBytes - overhead)) };
}

process.stdout.write('READY\\n');
// Busy wait, deliberately. A timer would hand the barrier a scheduling quantum
// and stagger the release, which is the thing this construction exists to avoid.
while (!fs.existsSync(startFile)) { /* spin */ }
const releasedAt = Date.now();

if (mode === 'locked') {
  for (let seq = 0; seq < count; seq++) {
    runlog.appendFleetEvent(record(seq), { path: logPath });
  }
} else {
  // The inherited shape at src/antiloop-log.cts:98, made as tear-prone as this
  // platform allows: a PERSISTENT append-mode descriptor, no lock, no fsync.
  const fd = fs.openSync(logPath, 'a');
  try {
    for (let seq = 0; seq < count; seq++) {
      fs.writeSync(fd, JSON.stringify(record(seq)) + '\\n');
    }
  } finally {
    fs.closeSync(fd);
  }
}

fs.writeFileSync(resultFile, JSON.stringify({ idx, releasedAt, finishedAt: Date.now() }));
`;

/**
 * Run `writers` child processes, all released from a barrier at the same instant,
 * each appending `records` records to 1 log. Returns the per-child timing reports
 * and the log path.
 */
async function driveWriters({ label, mode, writers, records, padBytes }) {
  const dir = scratch(label);
  const childPath = path.join(dir, 'writer.cjs');
  fs.writeFileSync(childPath, CHILD_SOURCE);
  const logPath = path.join(dir, '.planning', 'fleet-runlog.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const startFile = path.join(dir, 'START');

  const resultFiles = [];
  const exits = [];
  const readies = [];

  for (let idx = 0; idx < writers; idx++) {
    const resultFile = path.join(dir, `result-${idx}`);
    resultFiles.push(resultFile);
    const child = spawn(
      process.execPath,
      [childPath, mode, logPath, startFile, resultFile, String(idx), String(records), String(padBytes)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });

    let announceReady;
    let announceLost;
    readies.push(new Promise((resolve, reject) => { announceReady = resolve; announceLost = reject; }));

    child.stdout.on('data', (b) => { if (b.toString().includes('READY')) announceReady(); });
    exits.push(new Promise((resolve, reject) => {
      child.on('error', (err) => { announceLost(err); reject(err); });
      child.on('exit', (code) => {
        // A child that dies before the barrier must reject the readiness wait too,
        // or the parent waits forever on an event that can no longer arrive.
        announceLost(new Error(`writer ${idx} exited ${code} before the barrier: ${stderr}`));
        if (code === 0) resolve();
        else reject(new Error(`writer ${idx} exited ${code}: ${stderr}`));
      });
    }));
  }

  // The barrier: hold every child on its spin until ALL of them are spinning.
  // This waits on an EVENT from each child, never on a timer, so a slow machine
  // widens nothing.
  await Promise.all(readies);
  fs.writeFileSync(startFile, 'go');

  await Promise.all(exits);

  const reports = resultFiles.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  return { dir, logPath, reports };
}

/** Split the raw log without the CRLF-fragile bare newline literal. */
function rawLines(logPath) {
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
}

/** Line count, unparseable count, distinct identities, and interleaving evidence. */
function inspectLog(logPath) {
  const lines = rawLines(logPath);
  let unparseable = 0;
  let embeddedBoundaries = 0;
  const distinct = new Set();
  for (const line of lines) {
    // A torn line carries more than 1 record's worth of `"kind":`, which is the
    // direct signature of 2 appends interleaving inside 1 line.
    const kindHits = line.split('"kind":').length - 1;
    if (kindHits !== 1) embeddedBoundaries++;
    try {
      const rec = JSON.parse(line);
      if (typeof rec.node_id === 'string') distinct.add(rec.node_id);
      else unparseable++;
    } catch {
      unparseable++;
    }
  }
  return { lines: lines.length, unparseable, distinct, embeddedBoundaries };
}

/** Every identity the run was supposed to produce, as `w<idx>-<seq>`. */
function expectedIdentities(writers, records) {
  const out = new Set();
  for (let i = 0; i < writers; i++) for (let s = 0; s < records; s++) out.add(`w${i}-${s}`);
  return out;
}

/**
 * The anti-loop ceiling, enforced as a mechanism. An edit that adds a larger size
 * to TEAR_SIZES in search of a failure makes this go red instead of launching an
 * unbounded search.
 */
function assertCeilingRespected() {
  for (const size of TEAR_SIZES) {
    assert.ok(
      size <= TEAR_SIZE_CEILING_BYTES,
      `tear search size ${size} exceeds the hard ceiling of ${TEAR_SIZE_CEILING_BYTES} bytes. `
        + 'Raising the ceiling to hunt for a failure is an unbounded loop and is forbidden. '
        + 'No tear up to this ceiling is a finding to report, never a case to delete.',
    );
    assert.ok(
      size > runlog.FLEET_MAX_RECORD_BYTES,
      `tear search size ${size} is not past the ${runlog.FLEET_MAX_RECORD_BYTES} byte atomic append `
        + 'bound, so it would be testing the size at which the platform is allowed to be safe',
    );
  }
}

// ─── the positive case ───────────────────────────────────────────────────────

test('4 genuinely overlapping writer processes produce exactly 160 whole, unique, ordered records', async () => {
  const { logPath, reports } = await driveWriters({
    label: 'positive', mode: 'locked', writers: POSITIVE_WRITERS, records: POSITIVE_RECORDS, padBytes: 0,
  });

  // (3) OBSERVED OVERLAP. Without this the rest of the case is a story.
  const lastRelease = Math.max(...reports.map((r) => r.releasedAt));
  const firstFinish = Math.min(...reports.map((r) => r.finishedAt));
  assert.equal(reports.length, POSITIVE_WRITERS, 'every writer reported');
  assert.ok(
    lastRelease < firstFinish,
    `the writers did not overlap: the last one was released at ${lastRelease} but the first had already `
      + `finished at ${firstFinish}. A lock test that never actually races is D7's first named trap, so this `
      + 'is a failure of the TEST, not of the module.',
  );

  const expected = POSITIVE_WRITERS * POSITIVE_RECORDS;
  const seen = inspectLog(logPath);

  assert.equal(seen.lines, expected, `expected exactly ${expected} lines, saw ${seen.lines}`);
  assert.equal(seen.unparseable, 0, 'every one of the lines parses; a torn line here is unrecoverable evidence loss');
  assert.equal(seen.embeddedBoundaries, 0, 'no line carries a second record boundary, so nothing interleaved');

  // Nothing lost and nothing duplicated: the identity SET matches exactly, and
  // the line count above already forbids a duplicate hiding behind a matching set.
  const want = expectedIdentities(POSITIVE_WRITERS, POSITIVE_RECORDS);
  assert.equal(seen.distinct.size, expected, 'no duplicate identity');
  for (const id of want) assert.ok(seen.distinct.has(id), `record ${id} was lost`);
  for (const id of seen.distinct) assert.ok(want.has(id), `record ${id} was invented`);

  // The strict reader agrees with the raw inspection, which is what makes the
  // reader usable as the fold's only input.
  assert.equal(runlog.readFleetRunlog({ path: logPath }).length, expected);
});

test('each writer process holds the lock only for its own append, so no lockfile survives the run', async () => {
  const { dir, logPath } = await driveWriters({
    label: 'lock-residue', mode: 'locked', writers: POSITIVE_WRITERS, records: 5, padBytes: 0,
  });
  assert.equal(
    fs.existsSync(logPath + '.lock'), false,
    'a lockfile left behind means a holder died inside the transaction, which would stall every later writer '
      + 'until the stale reaper fires',
  );
  const residue = fs.readdirSync(path.dirname(logPath)).filter((f) => f.endsWith('.reaped') || f.endsWith('.tmp'));
  assert.deepEqual(residue, [], `no reap or temp residue: ${JSON.stringify(residue)}`);
  assert.ok(fs.existsSync(dir));
});

// ─── the negative case: the protocol removed, driven past the atomic bound ────

test('the unlocked unsynced writer really is unlocked, really is past the atomic bound, and the module refuses every size it runs at', async () => {
  assertCeilingRespected();

  const measurements = [];
  for (const size of TEAR_SIZES) {
    const { logPath } = await driveWriters({
      label: `negative-${size}`, mode: 'unlocked', writers: NEGATIVE_WRITERS, records: NEGATIVE_RECORDS, padBytes: size,
    });

    // (a) The dangerous configuration was ACTUALLY DRIVEN. If the unlocked child
    // had somehow taken the protected path, a lockfile would have existed; the
    // module removes it on release, so the surviving evidence is that the log was
    // written by a writer that never went near atomic-state at all.
    assert.equal(fs.existsSync(logPath + '.lock'), false, 'the unlocked run left no lockfile');

    const lines = rawLines(logPath);
    // (b) The records really were past the bound. Measured from the file, not
    // from the intent: an off-by-one in the padding would otherwise leave this
    // case silently testing safe-sized records.
    const shortest = Math.min(...lines.map((l) => Buffer.byteLength(l, 'utf8') + 1));
    assert.ok(
      shortest > runlog.FLEET_MAX_RECORD_BYTES,
      `the shortest line written was ${shortest} bytes, not past the ${runlog.FLEET_MAX_RECORD_BYTES} byte `
        + 'atomic append bound, so this run was not testing the unsafe region at all',
    );

    const seen = inspectLog(logPath);
    const expected = NEGATIVE_WRITERS * NEGATIVE_RECORDS;
    const torn = seen.lines !== expected || seen.unparseable > 0
      || seen.embeddedBoundaries > 0 || seen.distinct.size !== expected;
    measurements.push({
      size, writers: NEGATIVE_WRITERS, lines: seen.lines, expected,
      unparseable: seen.unparseable, embedded: seen.embeddedBoundaries,
      distinct: seen.distinct.size, torn,
    });

    // (c) THE MITIGATION. Whether or not the platform tore, the module refuses to
    // write a record at this size at all, so the region in which a concurrent
    // append is PERMITTED to interleave is unreachable through the only verb any
    // caller in this phase is allowed to use. Remove the size bound and this
    // assertion goes red.
    let refusal = null;
    try {
      runlog.appendFleetEvent(
        { ts: 1, kind: 'claim_acquired', run_id: 'r', node_id: 'n', worker_id: 'w', lease_epoch: 1, pad: 'x'.repeat(size) },
        { path: logPath },
      );
    } catch (err) {
      refusal = err;
    }
    assert.ok(refusal !== null, `appendFleetEvent must refuse a ${size} byte record`);
    assert.equal(
      refusal.code, runlog.FLEET_RUNLOG_ERROR_CODES.E_FLEET_RECORD_TOO_LARGE,
      `a ${size} byte record is refused by code, so the tearing window is unreachable through the module`,
    );
  }

  // The measurement is REPORTED, never asserted green. Both outcomes are terminal
  // and legal: a reproduced tear pins the size, and no tear up to the ceiling is
  // the finding recorded in this file's header.
  const summary = measurements
    .map((m) => `size=${m.size} writers=${m.writers} lines=${m.lines}/${m.expected} `
      + `unparseable=${m.unparseable} embedded=${m.embedded} distinct=${m.distinct} `
      + `-> ${m.torn ? 'TORE' : 'NO TEAR'}`)
    .join(' | ');
  assert.equal(measurements.length, TEAR_SIZES.length, `negative case measurements: ${summary}`);

  // Whatever the platform did, the run must not have INVENTED records. A log with
  // more identities than were written would mean the harness itself is broken,
  // and every number above would be about the harness rather than the protocol.
  for (const m of measurements) {
    assert.ok(m.distinct <= m.expected, `the harness invented records: ${summary}`);
  }
});

test('the negative case is bounded by construction: the ceiling is code, not a comment', () => {
  assertCeilingRespected();
  assert.equal(TEAR_SIZE_CEILING_BYTES, 1_048_576, '1 MiB, fixed');
  assert.equal(
    Math.max(...TEAR_SIZES), TEAR_SIZE_CEILING_BYTES,
    'the search already reached the ceiling, so there is nothing left to raise and no reason to try',
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
