'use strict';

/**
 * Phase 19 plan 04 task 3: GATE 4. Mutual exclusion of the land token, proven with
 * REAL processes, and observed FAILING with the serializer bypassed.
 *
 * THIS FILE IS THE ENTRY GATE. Dispatch in plan 05 is gated on it, so it has to be
 * able to fail, and the bypassed arm below is the evidence that it can.
 *
 * ─── WHAT IS BEING EXCLUDED, AND WHY THE VENDORED ENGINE DOES NOT ────────────
 *
 * FF-B115, reproduced in full and re-verified against the tree this file ships
 * with. `repo_lock` is defined at `ratchet:456` and its own docstring states its
 * purpose: "two lanes must not race fetch to merge on the same canonical tree". It
 * has exactly 1 caller in the entire vendored tree, `sync` at `:477`. `land` at
 * `:807` never acquires it. The claim `land` DOES take at `:824-830` keys on
 * `os.path.realpath(expand(c["worktree"])) == wt`, so a second land on a DIFFERENT
 * worktree of the same repository passes straight through into `_land_gate`, whose
 * first 2 actions are `fetch_with_ttl(..., fresh=True)` at `:926` and
 * `git rebase origin/mainline` at `:930`. Upstream names the hazard in its own
 * words at `:911`.
 *
 * THE SEVERITY IS CARRIED HONESTLY AND NOT INFLATED. The push at `:1101` is
 * `--force-with-lease` on the FEATURE branch. The harm is a raced fetch and rebase
 * and a suite running on an unstable base. It is recoverable. It is NOT a mainline
 * overwrite. This battery is built for the real hazard.
 *
 * That is why every child below names a DIFFERENT worktree path and the SAME
 * repoKey. That pairing is precisely what the vendored claim fails to exclude, and
 * it is the pairing a worktree scoped token would also fail to exclude.
 *
 * ─── THE 3 CONSTRUCTIONS THAT STOP THIS PASSING TRIVIALLY ────────────────────
 *
 * D7 names "a lock test with 1 writer" as one of the 4 things that pass trivially
 * for a concurrent system. All 3 of these are required and none is decoration:
 *
 *   1. REAL PROCESSES. 6 workers in 1 process share a descriptor table and an
 *      event loop, so they cannot exercise a CROSS PROCESS lock at all.
 *
 *   2. A BARRIER. Each child announces READY on stdout and then spins on a start
 *      file the parent writes only once ALL 6 have announced. Without it the
 *      children begin serially at process startup cost, which on this machine is
 *      tens of milliseconds per child, and 6 lands that never overlapped in the
 *      first place would pass a serializer that does nothing. The barrier is what
 *      defeats "they started serially because of process startup cost".
 *
 *   3. THE BYPASSED ARM ASSERTS THE OVERLAP POSITIVELY. It does not assert that
 *      the positive battery's assertion throws. It runs the identical 6 children
 *      with token acquisition skipped and asserts an overlapping interval pair IS
 *      found, so the failure is a mutation that was OBSERVED rather than one that
 *      was inferred, and the observed overlap is named in the test output.
 *
 * ─── WHAT WAS OBSERVED, RECORDED RATHER THAN EXPECTED ────────────────────────
 *
 * Measured on this machine on 2026-07-27 with STUB_LAND_MS pinned at 250. These
 * are the diagnostics this file emitted, not figures copied in from elsewhere:
 *
 *   bypassed intervals, relative to the first entry:
 *     lane 0: [+0ms, +253ms]   lane 1: [+0ms, +253ms]   lane 2: [+0ms, +253ms]
 *     lane 3: [+0ms, +256ms]   lane 4: [+0ms, +251ms]   lane 5: [+0ms, +254ms]
 *     -> 15 of 15 pairs overlapped, entry spread 0ms, widest overlap 254ms
 *
 *   serialized intervals, relative to the first entry:
 *     lane 3: [+0ms, +256ms]      lane 2: [+292ms, +552ms]
 *     lane 1: [+586ms, +846ms]    lane 0: [+879ms, +1139ms]
 *     lane 5: [+1173ms, +1433ms]  lane 4: [+1465ms, +1725ms]
 *     -> 0 of 15 pairs overlapped, 6 of 6 completed, acquisition order equalled
 *        entry order (lane 3 took ticket 0, lane 4 took ticket 5)
 *
 * The entry spread of 0ms in the bypassed arm is what the barrier bought: all 6
 * children entered the land window inside the same millisecond, so the serialized
 * arm's clean separation cannot be explained by process startup skew.
 *
 * The pinned value and the observed overlap are recorded in `19-04-SUMMARY.md`.
 *
 * STUB_LAND_MS IS PINNED AND ITS CEILING IS ENFORCED IN CODE. If the bypassed run
 * ever stops overlapping, the sleep is too short relative to process startup skew
 * and the value is raised until the overlap is observed again, then re-pinned. An
 * UNBOUNDED "raise it until it fires" search is the unbounded loop this milestone
 * exists to prevent, so `STUB_LAND_CEILING_MS` makes the bound a mechanism rather
 * than a comment asking nicely. THE BYPASSED CASE IS NEVER DELETED AND ITS
 * ASSERTION IS NEVER SOFTENED. A mutation case that cannot fire is the defect class
 * D7 exists to stop, and it is a finding to report, not a case to remove.
 *
 * ─── WHY THE BYPASS LIVES IN THE CHILD AND NOT IN THE MODULE ─────────────────
 *
 * The plan called for "an injected bypass flag". It is injected HERE, as the
 * child's mode argument, rather than as an option on `runLand`. A production
 * bypass flag would be a supported way to defeat SC4 in the field, and SC4 is a
 * correctness serializer. The mutation is identical either way: the same 6
 * children, the same barrier, the same stub, the same interval measurement, with
 * the token acquisition skipped and the land command called directly.
 *
 * ─── WHY THIS FILE READS THE REAL CLOCK ──────────────────────────────────────
 *
 * Everywhere else in this repository time is pinned through
 * `ferrox-core/bin/lib/clock.cjs`, and pinning it means pinning BOTH
 * `FERROX_TEST_MODE` and `FERROX_NOW_MS`, because `:35` returns null without the
 * flag and `:64` falls back to the platform clock when the pin is null. Here the
 * measurement IS elapsed real time across processes, and a pinned clock would make
 * the overlap evidence vacuous. The MODULE under test still never reads a clock:
 * each child supplies `clock: () => Date.now()` explicitly, exactly as the caller
 * supplied time contract requires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');
const queue = require('../ferrox-core/bin/lib/fleet-landqueue.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-landqueue.cjs');

/** 6 lanes, each on its own worktree of 1 repository. */
const LANES = 6;

/**
 * The pinned stub land duration, ms. Long enough that 6 barrier released children
 * overlap when nothing excludes them. See the header for what was observed at this
 * value and for the rule that governs changing it.
 */
const STUB_LAND_MS = 250;

/**
 * The hard ceiling on STUB_LAND_MS. Raising the sleep past this in search of an
 * overlap is forbidden: an unbounded search is the unbounded loop this milestone
 * exists to prevent. `assertPinnedSleepBounded` makes that a mechanism.
 */
const STUB_LAND_CEILING_MS = 2000;

/** The 1 trunk all 6 lanes write. Different worktrees, same repository. */
const REPO_KEY = 'ferroxfactory/core';

const SCRATCH_ROOTS = [];
const LIVE_CHILDREN = new Set();

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-landrace-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/**
 * The child, written to disk and spawned as a real process.
 *
 * argv: mode logPath tokenDir startFile resultFile worktree idx stubMs
 *
 * `mode` is `serialized` (the real thing) or `bypass` (the mutation: the token is
 * never acquired and the land command is called directly).
 *
 * Readiness is announced on stdout rather than by a file the parent polls, so the
 * parent waits on an EVENT rather than on a timer and a slow machine widens
 * nothing.
 */
const CHILD_SOURCE = `'use strict';
const fs = require('node:fs');
const queue = require(${JSON.stringify(BUILT_LIB)});

const [mode, logPath, tokenDir, startFile, resultFile, worktree, idxRaw, stubRaw] = process.argv.slice(2);
const idx = Number(idxRaw);
const stubMs = Number(stubRaw);

/** Sleep without a hot CPU spin, so the measured window is the sleep and not scheduler noise. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const window = { enterAt: null, exitAt: null };

/**
 * The stub land. It records the instants it entered and left the land window and
 * sleeps between them. This IS the critical section: if 2 of these windows
 * overlap, 2 lands were inside the vendored engine's fetch and rebase at once.
 */
function stubLand() {
  window.enterAt = Date.now();
  sleepSync(stubMs);
  window.exitAt = Date.now();
  return { code: 0, verdict: 'green', result: 'landed' };
}

process.stdout.write('READY\\n');
// Busy wait, deliberately. A timer would hand the barrier a scheduling quantum and
// stagger the release, which is the thing this construction exists to avoid.
while (!fs.existsSync(startFile)) { /* spin */ }
const releasedAt = Date.now();

let ticket = null;
let outcome = null;
let failure = null;
try {
  if (mode === 'serialized') {
    const opts = {
      logPath,
      tokenDir,
      repoKey: ${JSON.stringify(REPO_KEY)},
      runId: 'run-race',
      nodeId: 'node-' + idx,
      attemptId: 'attempt-' + idx,
      workerId: 'worker-' + idx,
      worktree,
      clock: () => Date.now(),
      ttlMs: 60000,
      liveness: { alive: true },
      pollIntervalMs: 5,
      waitTimeoutMs: 120000,
      landCommand: stubLand,
    };
    outcome = queue.runLand(opts);
    // The ticket is recovered from the log rather than returned, because the log is
    // what the parent asserts ordering against.
    const events = require(${JSON.stringify(path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-runlog.cjs'))})
      .readFleetRunlog({ path: logPath });
    const mine = events.find((e) => e.kind === 'queue_acquired' && e.node_id === 'node-' + idx);
    ticket = mine ? mine.ticket : null;
  } else {
    // THE MUTATION. Token acquisition is skipped entirely and the land command is
    // called directly. Everything else about this child is identical.
    outcome = stubLand();
  }
} catch (err) {
  failure = String((err && err.stack) || err);
}

fs.writeFileSync(resultFile, JSON.stringify({
  idx, mode, worktree, releasedAt, ticket, outcome, failure,
  enterAt: window.enterAt, exitAt: window.exitAt,
}));
if (failure !== null) process.exitCode = 1;
`;

/**
 * Run the 6 lane battery in `mode`, all children released from 1 barrier.
 *
 * Returns the per-child reports and the log path. A child that dies before the
 * barrier rejects the readiness wait too, or the parent would wait forever on an
 * event that can no longer arrive.
 */
async function driveLanes({ label, mode, stubMs }) {
  const dir = scratch(label);
  const childPath = path.join(dir, 'lane.cjs');
  fs.writeFileSync(childPath, CHILD_SOURCE);
  const tokenDir = path.join(dir, '.planning');
  const logPath = path.join(tokenDir, 'fleet-runlog.jsonl');
  fs.mkdirSync(tokenDir, { recursive: true });
  const startFile = path.join(dir, 'START');

  const resultFiles = [];
  const readies = [];
  const exits = [];

  for (let idx = 0; idx < LANES; idx++) {
    // A DIFFERENT worktree per lane, and ONE repoKey for all of them. That pairing
    // is what ratchet:824-830 fails to exclude, and it is the whole point.
    const worktree = path.join(dir, 'worktrees', `agent-${idx}`);
    fs.mkdirSync(worktree, { recursive: true });
    const resultFile = path.join(dir, `result-${idx}.json`);
    resultFiles.push(resultFile);

    const child = spawn(
      process.execPath,
      [childPath, mode, logPath, tokenDir, startFile, resultFile, worktree, String(idx), String(stubMs)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    LIVE_CHILDREN.add(child);

    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });

    let announceReady;
    let announceLost;
    readies.push(new Promise((resolve, reject) => { announceReady = resolve; announceLost = reject; }));
    child.stdout.on('data', (b) => { if (b.toString().includes('READY')) announceReady(); });

    exits.push(new Promise((resolve, reject) => {
      child.on('error', (err) => { announceLost(err); reject(err); });
      child.on('exit', (code) => {
        LIVE_CHILDREN.delete(child);
        announceLost(new Error(`lane ${idx} exited ${code} before the barrier: ${stderr}`));
        if (code === 0) resolve();
        else reject(new Error(`lane ${idx} exited ${code}: ${stderr}`));
      });
    }));
  }

  // The barrier: hold every child on its spin until ALL of them are spinning. This
  // waits on an EVENT from each child, never on a timer.
  await Promise.all(readies);
  fs.writeFileSync(startFile, 'go');
  await Promise.all(exits);

  const reports = resultFiles.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  return { dir, logPath, reports };
}

/** Every pair of land windows that overlapped, with the overlap width in ms. */
function overlappingPairs(reports) {
  const windows = reports
    .map((r) => ({ idx: r.idx, enterAt: r.enterAt, exitAt: r.exitAt }))
    .filter((w) => typeof w.enterAt === 'number' && typeof w.exitAt === 'number')
    .sort((a, b) => a.enterAt - b.enterAt);

  const found = [];
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i];
      const b = windows[j];
      const width = Math.min(a.exitAt, b.exitAt) - Math.max(a.enterAt, b.enterAt);
      if (width > 0) found.push({ a, b, width });
    }
  }
  return { windows, found };
}

/** A readable rendering of the real intervals, for the failure message and the record. */
function renderWindows(windows) {
  const base = Math.min(...windows.map((w) => w.enterAt));
  return windows
    .map((w) => `lane ${w.idx}: [+${w.enterAt - base}ms, +${w.exitAt - base}ms]`)
    .join('  ');
}

/** The bound on the pinned sleep, as a mechanism rather than as a comment. */
function assertPinnedSleepBounded() {
  assert.ok(
    STUB_LAND_MS <= STUB_LAND_CEILING_MS,
    `STUB_LAND_MS=${STUB_LAND_MS} is past the ${STUB_LAND_CEILING_MS}ms ceiling. `
    + 'An unbounded search for a sleep that overlaps is the unbounded loop this milestone prevents.',
  );
}

test.after(() => {
  for (const child of LIVE_CHILDREN) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  LIVE_CHILDREN.clear();
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

test('the pinned stub sleep is inside its declared ceiling', () => {
  assertPinnedSleepBounded();
});

test('THE MUTATION: the identical 6 lanes with token acquisition BYPASSED overlap', async (t) => {
  assertPinnedSleepBounded();
  const { reports } = await driveLanes({ label: 'bypass', mode: 'bypass', stubMs: STUB_LAND_MS });

  assert.equal(reports.length, LANES);
  for (const r of reports) {
    assert.equal(r.failure, null, `lane ${r.idx} failed: ${r.failure}`);
    assert.equal(r.mode, 'bypass', 'the bypassed arm must really have skipped acquisition');
    assert.equal(r.ticket, null, 'a bypassed lane takes no ticket, or it did not bypass anything');
  }

  const { windows, found } = overlappingPairs(reports);
  assert.equal(windows.length, LANES, 'every lane must have recorded a land window');

  const rendered = renderWindows(windows);
  const spread = Math.max(...windows.map((w) => w.enterAt)) - Math.min(...windows.map((w) => w.enterAt));
  t.diagnostic(`bypassed intervals: ${rendered}`);
  t.diagnostic(`bypassed: ${found.length} of 15 pairs overlapped, entry spread ${spread}ms, widest overlap ${found.length > 0 ? Math.max(...found.map((p) => p.width)) : 0}ms`);

  assert.ok(
    found.length > 0,
    'THE MUTATION DID NOT FIRE. With acquisition bypassed at least 1 pair of land windows must '
    + `overlap, and none did. Observed intervals: ${rendered}. The pinned sleep `
    + `(STUB_LAND_MS=${STUB_LAND_MS}) is too short relative to process startup skew: raise it, `
    + `re-observe the overlap, re-pin it, and record what was seen. Do NOT delete this case and `
    + 'do NOT soften this assertion.',
  );
});

test('6 real processes on 6 worktrees of 1 repository produce ZERO overlapping land windows', async (t) => {
  assertPinnedSleepBounded();
  const { logPath, reports } = await driveLanes({
    label: 'serialized', mode: 'serialized', stubMs: STUB_LAND_MS,
  });

  // 1. All 6 completed. The serializer EXCLUDED rather than deadlocked, which is
  //    the arm that a serializer refusing everybody would fail.
  assert.equal(reports.length, LANES);
  for (const r of reports) {
    assert.equal(r.failure, null, `lane ${r.idx} failed: ${r.failure}`);
    assert.deepEqual(r.outcome, { code: 0, verdict: 'green', result: 'landed' });
    assert.equal(typeof r.enterAt, 'number');
    assert.equal(typeof r.exitAt, 'number');
  }

  // 2. Every lane took a DISTINCT ticket. The ticket is the count of prior entries,
  //    so 2 entrants reading the log at the same instant would compute the same
  //    number, both believe they were the head, and both land. This is the arm that
  //    proves the ENTRY is locked, not merely the acquisition.
  const tickets = reports.map((r) => r.ticket).sort((a, b) => a - b);
  assert.deepEqual(tickets, [0, 1, 2, 3, 4, 5], 'the derived ticket must be assigned under the lock');

  // 3. No 2 land windows overlapped. Exactly 1 land held the trunk at any moment.
  const { windows, found } = overlappingPairs(reports);
  const rendered = renderWindows(windows);
  const spread = Math.max(...windows.map((w) => w.enterAt)) - Math.min(...windows.map((w) => w.enterAt));
  t.diagnostic(`serialized intervals: ${rendered}`);
  t.diagnostic(`serialized: ${found.length} of 15 pairs overlapped, entry spread ${spread}ms`);

  assert.equal(
    found.length, 0,
    '2 lands held the trunk at once, which is FF-B115 reproduced against the serializer. '
    + `Overlaps: ${found.map((p) => `lane ${p.a.idx} and lane ${p.b.idx} by ${p.width}ms`).join(', ')}. `
    + `Intervals: ${rendered}`,
  );

  // 4. The queue is FIRST IN FIRST OUT. Acquisition order equals entry order, so
  //    the serializer is a queue and not a scramble.
  const events = runlog.readFleetRunlog({ path: logPath });
  const acquiredOrder = events.filter((e) => e.kind === 'queue_acquired').map((e) => e.ticket);
  assert.deepEqual(
    acquiredOrder, [0, 1, 2, 3, 4, 5],
    'a later ticket acquired ahead of an earlier one, so the queue is not first in first out',
  );

  // 5. And the fold agrees the trunk ended free with all 6 tickets closed.
  const projected = queue.projectQueue(events);
  assert.equal(projected.held_by, null, 'the trunk must be free once every lane completed');
  assert.equal(projected.tickets.length, LANES);
  for (const row of projected.tickets) {
    assert.notEqual(row.completed_at, null, `ticket ${row.ticket} never completed`);
  }
});

test('the serialized run emits the 5 event kinds for every one of the 6 lanes', async () => {
  const { logPath, reports } = await driveLanes({
    label: 'events', mode: 'serialized', stubMs: STUB_LAND_MS,
  });
  for (const r of reports) assert.equal(r.failure, null, `lane ${r.idx} failed: ${r.failure}`);

  const events = runlog.readFleetRunlog({ path: logPath });
  for (let idx = 0; idx < LANES; idx++) {
    const mine = events.filter((e) => e.node_id === `node-${idx}`).map((e) => e.kind);
    assert.deepEqual(
      mine, ['queue_entered', 'queue_acquired', 'gate_started', 'gate_ended', 'land_completed'],
      `lane ${idx} must leave a closed interval, or phase 22 cannot separate queue wait from gate cost`,
    );
  }
  assert.equal(events.length, LANES * 5, 'no lane wrote an event it did not account for');
});
