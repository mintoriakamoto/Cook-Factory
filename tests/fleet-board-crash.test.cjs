'use strict';

/**
 * Phase 19 plan 03 task 3: crash reclaim, proven by KILLING A REAL WORKER.
 *
 * D0's fifth entry gate was written as "prove the reclaim protocol by killing a
 * worker mid hold rather than by simulating one", and that instruction survived
 * the correction that withdrew 4 of the 5 gates. This file is that proof, and
 * every construction in it exists because the obvious cheaper version proves
 * nothing.
 *
 * ─── WHY A REAL CHILD, AND WHY THE UNCATCHABLE SIGNAL ────────────────────────
 *
 * A simulated dead worker is a worker whose record a test wrote by hand, and a
 * record written by hand proves the reclaim ARITHMETIC while proving nothing
 * about whether a genuinely crashed process is detectable at all. So the holder
 * here is a real child process that really claimed the node through the real
 * verb, and it is killed with SIGKILL, which cannot be caught, blocked or
 * ignored. That matters directly: no exit handler runs, so no `lease_released`
 * is ever emitted, which is exactly the state a crashed worker leaves behind. A
 * child that exits cleanly would release its lease on the way out and the node
 * would be free for ordinary reasons.
 *
 * ─── THE ASSERTION THAT MAKES THIS A LIVENESS PROOF: NO CLOCK ADVANCE ────────
 *
 * The lease is taken with an HOUR long TTL and every assertion runs at the SAME
 * pinned instant the claim was made at. The lease is therefore still live when
 * it is reclaimed, and a TTL only implementation would have to wait an hour. The
 * reclaim succeeding with no clock advance is what proves the LIVENESS arm fired
 * rather than the expiry arm, and a weaker version of this file that advanced
 * the clock would pass identically with the liveness arm deleted.
 *
 * ─── THE REAPING ORDER, WHICH IS EASY TO GET WRONG ──────────────────────────
 *
 * The kill is followed by an await on the child's exit BEFORE anything probes
 * it. A killed child whose parent has not reaped it is a ZOMBIE, and a zombie
 * still occupies its pid: `process.kill(pid, 0)` succeeds against one, and `ps`
 * still reports its original start stamp. A probe run inside that window would
 * correctly report ALIVE, and a file that probed there would be flaky rather
 * than wrong. Awaiting the exit event reaps the child and closes the window.
 *
 * That window is worth naming rather than hiding, because it is the seam failing
 * in its SAFE direction: an unreaped holder reads as alive, the node is not
 * taken from it, and the TTL arm still frees the node eventually. A wedge is
 * recoverable and a double holder is not.
 *
 * ─── THE MUTATION ROW IS COMMITTED, NOT RUN ONCE AND DELETED ────────────────
 *
 * The last case reclaims a node whose holder is FORCED to report alive and
 * asserts the refusal. That is the arm which goes green if the reclaim condition
 * is ever loosened to always allow, and D7 requires every check to be run once
 * against a case where the thing it detects is present. It is a permanent case.
 *
 * ─── BOTH CLOCK VARIABLES ARE PINNED, ALWAYS ────────────────────────────────
 *
 * `ferrox-core/bin/lib/clock.cjs:34-36` returns null without `FERROX_TEST_MODE`
 * and `:60-64` falls back to the platform clock when the pin is null, so setting
 * 1 of the 2 leaves an assertion reading real time while APPEARING pinned. The
 * unexpired assertion is precisely the assertion that would silently become
 * meaningless, so both are pinned for the parent AND inherited by the child.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const board = require('../ferrox-core/bin/lib/fleet-board.cjs');
const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-board.cjs');

/** The pinned instant every assertion in this file runs at. It NEVER advances. */
const PINNED_NOW = 1785000000000;

/** An hour. Long enough that the expiry arm cannot be what frees the node. */
const LONG_TTL_MS = 3_600_000;

/** The uncatchable signal. No handler runs, so no release is ever emitted. */
const UNCATCHABLE = 'SIGKILL';

const SCRATCH_ROOTS = [];
const LIVE_CHILDREN = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-board-crash-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/** Pin BOTH clock variables, then restore exactly what was there, absence included. */
function withPinnedClock(nowMs, body) {
  const priorMode = process.env.FERROX_TEST_MODE;
  const priorNow = process.env.FERROX_NOW_MS;
  process.env.FERROX_TEST_MODE = '1';
  process.env.FERROX_NOW_MS = String(nowMs);
  try {
    return body();
  } finally {
    if (priorMode === undefined) delete process.env.FERROX_TEST_MODE;
    else process.env.FERROX_TEST_MODE = priorMode;
    if (priorNow === undefined) delete process.env.FERROX_NOW_MS;
    else process.env.FERROX_NOW_MS = priorNow;
  }
}

/**
 * The worker. It claims a node through the REAL verb, records what it claimed,
 * announces itself, and then holds the lease indefinitely on an interval.
 *
 * It installs NO exit handler and NO signal handler on purpose. There is nothing
 * to install one for: the signal that ends it cannot be caught. Adding one would
 * only invite a later edit to make the shutdown graceful, which would quietly
 * turn this whole file into a test of an orderly release.
 *
 * argv: libPath logPath projectionPath readyFile nodeId workerId nowMs ttlMs
 */
const WORKER_SOURCE = `'use strict';
const fs = require('node:fs');
const [libPath, logPath, projectionPath, readyFile, nodeId, workerId, nowRaw, ttlRaw] = process.argv.slice(2);
const board = require(libPath);

const lease = board.claimNode({
  logPath, projectionPath, runId: 'run-crash', nodeId, workerId,
  ttlMs: Number(ttlRaw), nowMs: Number(nowRaw),
});

fs.writeFileSync(readyFile, JSON.stringify({
  pid: process.pid,
  holder: lease.holder,
  lease_epoch: lease.lease_epoch,
  expires_at_ms: lease.expires_at_ms,
}));
process.stdout.write('READY\\n');

// Hold the lease forever. The interval exists only to keep the event loop alive;
// the parent ends this process with a signal it cannot observe.
setInterval(() => { /* holding */ }, 1000);
`;

/**
 * Spawn a worker, wait for it to announce that it claimed, and return the child
 * plus what it reported. The wait is on an EVENT, never on a timer, so a slow
 * machine cannot turn it into a race.
 */
async function spawnHolder({ dir, logPath, projectionPath, nodeId, workerId }) {
  const workerPath = path.join(dir, 'worker.cjs');
  fs.writeFileSync(workerPath, WORKER_SOURCE);
  const readyFile = path.join(dir, `ready-${workerId}`);

  const child = spawn(
    process.execPath,
    [
      workerPath, BUILT_LIB, logPath, projectionPath, readyFile, nodeId, workerId,
      String(PINNED_NOW), String(LONG_TTL_MS),
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FERROX_TEST_MODE: '1', FERROX_NOW_MS: String(PINNED_NOW) },
    },
  );
  LIVE_CHILDREN.push(child);

  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString(); });

  await new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => { if (b.toString().includes('READY')) resolve(); });
    child.on('error', reject);
    // A child that dies before it announces must reject, or the parent waits
    // forever on an event that can no longer arrive.
    child.on('exit', (code) => {
      reject(new Error(`worker ${workerId} exited ${code} before it claimed: ${stderr}`));
    });
  });

  return { child, report: JSON.parse(fs.readFileSync(readyFile, 'utf8')) };
}

/**
 * End a child with the uncatchable signal AND WAIT FOR IT TO BE REAPED.
 *
 * The await is not politeness. See the header: an unreaped child is a zombie
 * that still holds its pid, so a probe run before this resolves would report the
 * holder alive and this file would be flaky rather than proving anything.
 */
async function killAndReap(child) {
  const exited = new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal })); });
  child.kill(UNCATCHABLE);
  return exited;
}

/** The materialised projection, parsed. */
function readProjection(projectionPath) {
  return JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
}

/** How many records of `kind` name `nodeId`. */
function countKind(logPath, kind, nodeId) {
  return runlog.readFleetRunlog({ path: logPath })
    .filter((e) => e.kind === kind && e.node_id === nodeId).length;
}

test('a worker killed while holding a LIVE lease has that lease reclaimed with NO clock advance', async () => {
  const dir = scratch('killed-holder');
  const logPath = path.join(dir, '.planning', 'fleet-runlog.jsonl');
  const projectionPath = path.join(dir, '.planning', 'fleet-board.json');
  const base = { logPath, projectionPath, runId: 'run-crash', ttlMs: LONG_TTL_MS, nowMs: PINNED_NOW };

  const { child, report } = await spawnHolder({
    dir, logPath, projectionPath, nodeId: 'doomed', workerId: 'wDead',
  });

  // The claim really happened, in another process, through the real verb.
  assert.equal(report.lease_epoch, 1);
  assert.equal(report.expires_at_ms, PINNED_NOW + LONG_TTL_MS);
  assert.equal(report.holder.pid, report.pid, 'the worker stamped its own identity onto the lease');
  assert.ok(report.holder.pid_start.length > 0, 'and a start stamp that makes the pid reuse safe');
  assert.equal(countKind(logPath, 'claim_acquired', 'doomed'), 1);

  const exit = await killAndReap(child);

  await withPinnedClock(PINNED_NOW, async () => {
    // 1. THE SIGNAL WAS UNCATCHABLE AND NO RELEASE WAS EMITTED.
    assert.equal(exit.signal, UNCATCHABLE, 'the worker was killed, never asked to stop');
    assert.equal(
      countKind(logPath, 'lease_released', 'doomed'), 0,
      'a crash emits no release: that is the whole difference between this and an orderly shutdown',
    );

    // 2. THE PROJECTION STILL SHOWS A HELD LEASE, owned by a worker that no
    //    longer exists. Without a reclaim protocol this node is claimed forever,
    //    which at width 1 nobody noticed because there was no second worker to
    //    starve.
    const stranded = readProjection(projectionPath).leases.doomed;
    assert.equal(stranded.state, board.LEASE_STATES.HELD);
    assert.equal(stranded.worker_id, 'wDead');
    assert.equal(stranded.lease_epoch, 1);

    // 3. AND THE LEASE IS NOT EXPIRED. This is the assertion that makes the rest
    //    of the case a liveness proof: a TTL only reclaim would have to wait an
    //    hour from here.
    assert.equal(
      board.isLeaseExpired(stranded, PINNED_NOW), false,
      'the lease is live at the pinned instant, so only the liveness arm can free this node',
    );

    // 4. THE DEFAULT PROBE, with nothing injected, reports the dead child dead.
    const verdict = board.probeLiveness(stranded.holder);
    assert.equal(verdict.alive, false, `the default probe must see pid ${report.pid} is gone`);
    assert.equal(verdict.reason, 'pid_absent');

    // 5. THE RECLAIM SUCCEEDS AT THE UNCHANGED INSTANT. `nowMs` is PINNED_NOW,
    //    the same value the claim was made at. No clock advanced anywhere.
    const reclaimed = board.reclaimLease({ ...base, nodeId: 'doomed', workerId: 'wRescue' });
    assert.equal(reclaimed.worker_id, 'wRescue');
    assert.equal(reclaimed.lease_epoch, 2, 'exactly 1 higher than the dead worker held');
    assert.equal(reclaimed.state, board.LEASE_STATES.HELD);

    const event = runlog.readFleetRunlog({ path: logPath }).find((e) => e.kind === 'lease_reclaimed');
    assert.equal(
      event.reason, 'holder_dead',
      'the recorded reason names the LIVENESS arm; "expired" here would mean the case proved nothing',
    );
    assert.equal(event.prior_worker_id, 'wDead');
    assert.equal(event.prior_lease_epoch, 1);

    // 6. THE FENCE. The dead worker's identity at its old epoch is refused. This
    //    is the assertion the epoch exists for; without it the epoch is
    //    decoration.
    assert.throws(
      () => board.renewLease({ ...base, nodeId: 'doomed', workerId: 'wDead', leaseEpoch: 1 }),
      (err) => {
        assert.equal(err.code, board.FLEET_BOARD_ERROR_CODES.E_FLEET_STALE_EPOCH);
        return true;
      },
      'a reclaimed worker resuming as if it still held its lease is the double holder the epoch prevents',
    );
    assert.equal(
      countKind(logPath, 'lease_renewed', 'doomed'), 0,
      'and the refused heartbeat appended nothing',
    );

    // 7. A SECOND WORKER TAKES THE NODE, at an epoch higher than the dead one's.
    board.releaseLease({ ...base, nodeId: 'doomed', workerId: 'wRescue', leaseEpoch: 2 });
    const fresh = board.claimNode({ ...base, nodeId: 'doomed', workerId: 'wSecond' });
    assert.equal(fresh.worker_id, 'wSecond');
    assert.ok(fresh.lease_epoch > 1, `epoch ${fresh.lease_epoch} is above the dead worker's 1`);
    assert.equal(fresh.lease_epoch, 3);

    // The projection and the log agree at the end, so nothing was left needing repair.
    const outcome = board.reconcileBoard({ logPath, projectionPath });
    assert.equal(outcome.agreed, true, 'the projection tracked the log through the whole crash and recovery');
    assert.equal(outcome.rebuilt, false);
  });
});

test('THE MUTATION ROW: the same reclaim with the probe FORCED to report alive is REFUSED', async () => {
  const dir = scratch('forced-alive');
  const logPath = path.join(dir, '.planning', 'fleet-runlog.jsonl');
  const projectionPath = path.join(dir, '.planning', 'fleet-board.json');
  const base = { logPath, projectionPath, runId: 'run-crash', ttlMs: LONG_TTL_MS, nowMs: PINNED_NOW };

  const { child, report } = await spawnHolder({
    dir, logPath, projectionPath, nodeId: 'guarded', workerId: 'wDead',
  });
  const exit = await killAndReap(child);

  await withPinnedClock(PINNED_NOW, async () => {
    assert.equal(exit.signal, UNCATCHABLE);

    // The holder really IS dead. Establishing that first is what makes the
    // refusal below meaningful: the guard is being driven against a case it
    // would otherwise allow, which is exactly D7's construction.
    assert.equal(board.probeLiveness(report.holder).alive, false, 'the real verdict is dead');

    const before = runlog.readFleetRunlog({ path: logPath }).length;
    assert.throws(
      () => board.reclaimLease({
        ...base, nodeId: 'guarded', workerId: 'wThief',
        deps: { pidExists: () => true, readPidStart: () => report.holder.pid_start },
      }),
      (err) => {
        assert.equal(err.code, board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_RECLAIMABLE);
        return true;
      },
      'this is the arm that goes green if the reclaim condition is ever loosened to always allow',
    );
    assert.equal(
      runlog.readFleetRunlog({ path: logPath }).length, before,
      'a refused reclaim appends nothing, so no record of a takeover that did not happen survives',
    );
    assert.equal(
      readProjection(projectionPath).leases.guarded.worker_id, 'wDead',
      'and the node still belongs to whoever the probe said was holding it',
    );
  });
});

test('a lease whose holder is dead is NOT reclaimable while the lease record itself is unreadable to the probe', async () => {
  const dir = scratch('no-holder-record');
  const logPath = path.join(dir, '.planning', 'fleet-runlog.jsonl');
  const projectionPath = path.join(dir, '.planning', 'fleet-board.json');
  const base = { logPath, projectionPath, runId: 'run-crash', ttlMs: LONG_TTL_MS, nowMs: PINNED_NOW };

  withPinnedClock(PINNED_NOW, () => {
    // A lease claimed with NO holder identity recorded. The liveness arm has
    // nothing to judge, so it fails closed toward the holder and the node waits
    // for its TTL. That is the cost of an unrecorded claimant, and it is why
    // `claimNode` records one by default rather than leaving it to a caller.
    board.claimNode({ ...base, nodeId: 'anonymous', workerId: 'wGhost', holder: null });
    assert.throws(
      () => board.reclaimLease({ ...base, nodeId: 'anonymous', workerId: 'wRescue' }),
      (err) => {
        assert.equal(err.code, board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_RECLAIMABLE);
        return true;
      },
    );
    // The TTL arm still frees it, which is why a wedge is recoverable.
    const reclaimed = board.reclaimLease({
      ...base, nodeId: 'anonymous', workerId: 'wRescue', nowMs: PINNED_NOW + LONG_TTL_MS,
    });
    assert.equal(reclaimed.lease_epoch, 2);
    const event = runlog.readFleetRunlog({ path: logPath }).find((e) => e.kind === 'lease_reclaimed');
    assert.equal(event.reason, 'expired');
  });
});

test.after(() => {
  // Kill anything still holding a lease, even when an assertion threw above, so
  // a failing run never leaves an orphan process behind.
  for (const child of LIVE_CHILDREN) {
    try { child.kill(UNCATCHABLE); } catch { /* already gone */ }
  }
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
