'use strict';

/**
 * Phase 19 plan 02 task 1: the blackboard projection and the lease predicates.
 *
 * TWO CASES HERE ARE BUILT SO THEY CAN FAIL, RATHER THAN BUILT SO THEY PASS.
 *
 * The permutation case (D6, and D4's rebuildability rule) does NOT call
 * `projectBoard` twice on the same array. That proves 1 concrete serialization
 * repeats and nothing about independence from arrival order. It builds a SECOND
 * explicit ordering of the same events, interleaving 2 independent nodes the
 * opposite way round, and asserts the 2 boards are deep equal. An implementation
 * that leaked insertion order into `completed`, `attempts` or `tickets` goes red
 * on that case and green on the repeated call.
 *
 * The TTL boundary case asserts the EXACT equality instant, not a comfortable
 * millisecond either side of it. An off by 1 at the boundary is the difference
 * between a reclaim and a double holder, and `>` versus `>=` is invisible to a
 * case that only probes now-1 and now+1.
 *
 * Every case that involves time pins BOTH `FERROX_TEST_MODE` and `FERROX_NOW_MS`.
 * `ferrox-core/bin/lib/clock.cjs:34-36` returns null unless the test mode flag is
 * set and `:60-64` falls back to the platform clock when the pin is null, so
 * setting 1 of the 2 leaves code reading real time while APPEARING pinned. This
 * module takes every instant as a parameter and must never consult that clock at
 * all, so the pin exists to make a regression that starts consulting it
 * deterministic rather than flaky.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const board = require('../ferrox-core/bin/lib/fleet-board.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-board.cjs');

/** The pinned instant every time-bearing case runs at. */
const PINNED_NOW = 1785000000000;

/**
 * Pin BOTH clock variables for the duration of `body`, then restore exactly what
 * was there before, including absence.
 */
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

/** A run-scoped event, with the common 3 filled in. */
function ev(kind, fields) {
  return Object.assign({ ts: PINNED_NOW, kind, run_id: 'r1' }, fields);
}

test('the built artifact exists and exports the pure surface plan 03 and plan 04 both consume', () => {
  assert.ok(require('node:fs').existsSync(BUILT_LIB), `${BUILT_LIB} must be built and committed`);
  assert.equal(typeof board.projectBoard, 'function');
  assert.equal(typeof board.isLeaseExpired, 'function');
  assert.equal(typeof board.isReclaimable, 'function');
  assert.equal(typeof board.nextLeaseEpoch, 'function');
  assert.deepEqual(
    board.LEASE_STATES,
    { HELD: 'held', RELEASED: 'released', RECLAIMED: 'reclaimed' },
  );
  assert.ok(Object.isFrozen(board.LEASE_STATES), 'LEASE_STATES must be frozen');
});

test('folding an empty event array yields no leases, no completed nodes and an empty queue', () => {
  const b = board.projectBoard([]);
  assert.deepEqual(b.completed, []);
  assert.deepEqual(Object.keys(b.leases), []);
  assert.deepEqual(b.queue.tickets, []);
  assert.equal(b.queue.held_by, null);
  assert.deepEqual(Object.keys(b.attempts), []);
});

test('a claim followed by a renewal yields 1 held lease whose epoch the renewal did not change', () => {
  withPinnedClock(PINNED_NOW, () => {
    const b = board.projectBoard([
      ev('claim_acquired', {
        node_id: 'n1', worker_id: 'wA', lease_epoch: 3,
        expires_at_ms: PINNED_NOW + 1000,
      }),
      ev('lease_renewed', {
        ts: PINNED_NOW + 400, node_id: 'n1', worker_id: 'wA', lease_epoch: 3,
        expires_at_ms: PINNED_NOW + 1400,
      }),
    ]);
    assert.equal(Object.keys(b.leases).length, 1);
    const lease = b.leases.n1;
    assert.equal(lease.state, board.LEASE_STATES.HELD);
    assert.equal(lease.worker_id, 'wA');
    assert.equal(lease.lease_epoch, 3, 'a renewal must not advance the epoch');
    assert.equal(lease.acquired_at_ms, PINNED_NOW);
    assert.equal(lease.renewed_at_ms, PINNED_NOW + 400, 'a renewal DOES move renewed_at_ms');
    assert.equal(lease.expires_at_ms, PINNED_NOW + 1400, 'a renewal DOES extend the deadline');
  });
});

test('a renewal at a stale epoch is ignored, so a displaced worker cannot resurrect its lease', () => {
  withPinnedClock(PINNED_NOW, () => {
    const b = board.projectBoard([
      ev('claim_acquired', {
        node_id: 'n1', worker_id: 'wA', lease_epoch: 1, expires_at_ms: PINNED_NOW + 100,
      }),
      ev('lease_reclaimed', {
        ts: PINNED_NOW + 200, node_id: 'n1', worker_id: 'wB', lease_epoch: 2,
        prior_worker_id: 'wA', prior_lease_epoch: 1, reason: 'expired',
        expires_at_ms: PINNED_NOW + 1200,
      }),
      // wA does not know it was displaced and keeps renewing at its old epoch.
      ev('lease_renewed', {
        ts: PINNED_NOW + 300, node_id: 'n1', worker_id: 'wA', lease_epoch: 1,
        expires_at_ms: PINNED_NOW + 9999,
      }),
    ]);
    const lease = b.leases.n1;
    assert.equal(lease.worker_id, 'wB', 'the stale renewal must not restore the prior holder');
    assert.equal(lease.lease_epoch, 2);
    assert.equal(lease.expires_at_ms, PINNED_NOW + 1200, 'the stale renewal must not extend');
    assert.equal(lease.renewed_at_ms, PINNED_NOW + 200);
  });
});

test('a reclaim yields 1 held lease at the higher epoch and the prior holder is no longer the holder', () => {
  withPinnedClock(PINNED_NOW, () => {
    const b = board.projectBoard([
      ev('claim_acquired', { node_id: 'n1', worker_id: 'wA', lease_epoch: 1 }),
      ev('lease_reclaimed', {
        ts: PINNED_NOW + 50, node_id: 'n1', worker_id: 'wB', lease_epoch: 2,
        prior_worker_id: 'wA', prior_lease_epoch: 1, reason: 'holder-dead',
      }),
    ]);
    assert.equal(Object.keys(b.leases).length, 1);
    const lease = b.leases.n1;
    assert.equal(lease.state, board.LEASE_STATES.HELD);
    assert.equal(lease.lease_epoch, 2);
    assert.equal(lease.worker_id, 'wB');
    assert.notEqual(lease.worker_id, 'wA');
  });
});

test('a claim at an epoch below the current one is ignored, so a stale writer cannot roll the node back', () => {
  const b = board.projectBoard([
    ev('claim_acquired', { node_id: 'n1', worker_id: 'wB', lease_epoch: 5 }),
    ev('claim_acquired', { node_id: 'n1', worker_id: 'wA', lease_epoch: 2 }),
  ]);
  assert.equal(b.leases.n1.worker_id, 'wB');
  assert.equal(b.leases.n1.lease_epoch, 5);
});

test('a release yields no held lease for that node, and the record survives so the epoch does not restart', () => {
  const b = board.projectBoard([
    ev('claim_acquired', { node_id: 'n1', worker_id: 'wA', lease_epoch: 4 }),
    ev('lease_released', { ts: PINNED_NOW + 10, node_id: 'n1', worker_id: 'wA', lease_epoch: 4 }),
  ]);
  assert.equal(b.leases.n1.state, board.LEASE_STATES.RELEASED);
  assert.notEqual(b.leases.n1.state, board.LEASE_STATES.HELD);
  assert.equal(
    board.nextLeaseEpoch(b, 'n1'), 5,
    'a cleanly released node must hand the next holder N+1, never 1',
  );
});

test('a release at a stale epoch is ignored, so a displaced worker cannot release a lease it lost', () => {
  const b = board.projectBoard([
    ev('claim_acquired', { node_id: 'n1', worker_id: 'wA', lease_epoch: 1 }),
    ev('lease_reclaimed', {
      node_id: 'n1', worker_id: 'wB', lease_epoch: 2,
      prior_worker_id: 'wA', prior_lease_epoch: 1, reason: 'expired',
    }),
    ev('lease_released', { node_id: 'n1', worker_id: 'wA', lease_epoch: 1 }),
  ]);
  assert.equal(b.leases.n1.state, board.LEASE_STATES.HELD);
  assert.equal(b.leases.n1.worker_id, 'wB');
});

test('completed is derived from the fixed worker_ended outcome enum, never from the open land result', () => {
  const b = board.projectBoard([
    ev('worker_ended', { node_id: 'nB', worker_id: 'w1', attempt_id: 'a1', outcome: 'completed' }),
    ev('worker_ended', { node_id: 'nA', worker_id: 'w2', attempt_id: 'a2', outcome: 'completed' }),
    ev('worker_ended', { node_id: 'nC', worker_id: 'w3', attempt_id: 'a3', outcome: 'failed' }),
    ev('worker_ended', { node_id: 'nD', worker_id: 'w4', attempt_id: 'a4', outcome: 'abnormal' }),
  ]);
  assert.deepEqual(b.completed, ['nA', 'nB'], 'sorted by node id, and only outcome completed');
});

test('the projection is identical for 2 permutations that differ only in the order of events touching different nodes', () => {
  withPinnedClock(PINNED_NOW, () => {
    // Two independent causal streams. Reordering ACROSS streams is a permutation
    // of the same run; reordering WITHIN a stream would be a different run.
    const streamA = [
      ev('claim_acquired', { node_id: 'nA', worker_id: 'wA', lease_epoch: 1, expires_at_ms: PINNED_NOW + 500 }),
      ev('queue_entered', { ts: PINNED_NOW + 1, node_id: 'nA', attempt_id: 'a1', ticket: 0 }),
      ev('worker_ended', { ts: PINNED_NOW + 2, node_id: 'nA', worker_id: 'wA', attempt_id: 'a1', outcome: 'completed' }),
    ];
    const streamB = [
      ev('claim_acquired', { node_id: 'nB', worker_id: 'wB', lease_epoch: 1, expires_at_ms: PINNED_NOW + 700 }),
      ev('queue_entered', { ts: PINNED_NOW + 3, node_id: 'nB', attempt_id: 'b1', ticket: 1 }),
      ev('worker_ended', { ts: PINNED_NOW + 4, node_id: 'nB', worker_id: 'wB', attempt_id: 'b1', outcome: 'completed' }),
    ];

    const orderingOne = [streamA[0], streamA[1], streamA[2], streamB[0], streamB[1], streamB[2]];
    const orderingTwo = [streamB[0], streamA[0], streamB[1], streamA[1], streamB[2], streamA[2]];

    assert.notDeepEqual(
      orderingOne.map((e) => `${e.kind}:${e.node_id}`),
      orderingTwo.map((e) => `${e.kind}:${e.node_id}`),
      'the 2 orderings must genuinely differ, or this case cannot fail',
    );

    assert.deepEqual(board.projectBoard(orderingOne), board.projectBoard(orderingTwo));
  });
});

test('attempts are collected per node from every attempt-bearing kind and returned sorted', () => {
  const b = board.projectBoard([
    ev('gate_started', { node_id: 'nA', attempt_id: 'a3' }),
    ev('queue_entered', { node_id: 'nA', attempt_id: 'a1', ticket: 0 }),
    ev('gate_ended', { node_id: 'nA', attempt_id: 'a2', verdict: 'green' }),
    // A repeat of a3 must not duplicate: attempts is a distinct set.
    ev('land_completed', { node_id: 'nA', attempt_id: 'a3', result: 'landed' }),
  ]);
  assert.deepEqual(b.attempts.nA, ['a1', 'a2', 'a3']);
});

test('identifiers are coerced without collapsing 2 distinct objects onto 1 key', () => {
  // A bare String() maps every object to the same string, so 2 different object
  // valued attempt ids would fold into 1 attempt. Same defect class as the
  // separator, reached from a different direction.
  const b = board.projectBoard([
    ev('gate_started', { node_id: 'nA', attempt_id: { a: 1 } }),
    ev('gate_started', { node_id: 'nA', attempt_id: { a: 2 } }),
  ]);
  assert.equal(b.attempts.nA.length, 2, 'String() would collapse both onto [object Object]');
});

test('the composite ticket key is joined on NUL, so 2 different node and attempt pairs cannot collide', () => {
  // On a printable separator, node 'nA x' + attempt 'aB' and node 'nA' +
  // attempt 'x aB' join to the same string, and the second land_completed would
  // close the first pair's ticket.
  const b = board.projectBoard([
    ev('queue_entered', { node_id: 'nA x', attempt_id: 'aB', ticket: 0 }),
    ev('queue_entered', { node_id: 'nA', attempt_id: 'x aB', ticket: 1 }),
  ]);
  assert.equal(b.queue.tickets.length, 2, 'a printable separator would fold these into 1 ticket');
  assert.deepEqual(b.queue.tickets.map((t) => t.ticket), [0, 1]);
});

test('tickets are returned sorted by ticket number regardless of the order they entered in', () => {
  const b = board.projectBoard([
    ev('queue_entered', { node_id: 'nC', attempt_id: 'c1', ticket: 2 }),
    ev('queue_entered', { node_id: 'nA', attempt_id: 'a1', ticket: 0 }),
    ev('queue_entered', { node_id: 'nB', attempt_id: 'b1', ticket: 1 }),
  ]);
  assert.deepEqual(b.queue.tickets.map((t) => t.ticket), [0, 1, 2]);
});

test('a queue_acquired without a matching land_completed leaves that ticket as the holder, and the completion clears it', () => {
  withPinnedClock(PINNED_NOW, () => {
    const entered = ev('queue_entered', { node_id: 'nA', attempt_id: 'a1', ticket: 0 });
    const acquired = ev('queue_acquired', {
      ts: PINNED_NOW + 5, node_id: 'nA', attempt_id: 'a1', ticket: 0, worker_id: 'wA',
    });
    const held = board.projectBoard([entered, acquired]);
    assert.notEqual(held.queue.held_by, null);
    assert.equal(held.queue.held_by.worker_id, 'wA');
    assert.equal(held.queue.held_by.ticket, 0);
    assert.equal(held.queue.tickets[0].completed_at, null);

    const cleared = board.projectBoard([
      entered,
      acquired,
      ev('land_completed', { ts: PINNED_NOW + 9, node_id: 'nA', attempt_id: 'a1', result: 'landed' }),
    ]);
    assert.equal(cleared.queue.held_by, null);
    assert.equal(cleared.queue.tickets[0].completed_at, PINNED_NOW + 9);
  });
});

test('isLeaseExpired is true exactly at the deadline, and the exact equality instant is EXPIRED', () => {
  withPinnedClock(PINNED_NOW, () => {
    const lease = board.projectBoard([
      ev('claim_acquired', {
        node_id: 'n1', worker_id: 'wA', lease_epoch: 1, expires_at_ms: PINNED_NOW + 1000,
      }),
    ]).leases.n1;

    assert.equal(board.isLeaseExpired(lease, PINNED_NOW + 999), false, 'a ms short is not expired');
    assert.equal(
      board.isLeaseExpired(lease, PINNED_NOW + 1000), true,
      'AT the deadline is expired: > instead of >= here is a double holder',
    );
    assert.equal(board.isLeaseExpired(lease, PINNED_NOW + 1001), true);
  });
});

test('a lease with no readable deadline is not expired, which is the safe direction', () => {
  const lease = board.projectBoard([
    ev('claim_acquired', { node_id: 'n1', worker_id: 'wA', lease_epoch: 1 }),
  ]).leases.n1;
  assert.equal(lease.expires_at_ms, null);
  assert.equal(
    board.isLeaseExpired(lease, PINNED_NOW + 1e9), false,
    'a wedge is recoverable through the liveness arm; a double holder is not recoverable at all',
  );
});

test('isReclaimable is true when expired, true when the holder is dead, and false when live and alive', () => {
  withPinnedClock(PINNED_NOW, () => {
    const lease = board.projectBoard([
      ev('claim_acquired', {
        node_id: 'n1', worker_id: 'wA', lease_epoch: 1, expires_at_ms: PINNED_NOW + 1000,
      }),
    ]).leases.n1;

    assert.equal(
      board.isReclaimable(lease, PINNED_NOW + 1000, { alive: true }), true,
      'expired, even though the holder is still alive: a wedged process must be reclaimable',
    );
    assert.equal(
      board.isReclaimable(lease, PINNED_NOW, { alive: false }), true,
      'the holder is gone, so waiting out the whole TTL wastes the whole TTL',
    );
    assert.equal(
      board.isReclaimable(lease, PINNED_NOW, { alive: true }), false,
      'live lease, live holder: not reclaimable',
    );
    assert.equal(
      board.isReclaimable(lease, PINNED_NOW, undefined), false,
      'an ABSENT verdict is not a dead verdict',
    );
  });
});

test('a released lease is not reclaimable, because a free node is acquired rather than reclaimed', () => {
  const b = board.projectBoard([
    ev('claim_acquired', { node_id: 'n1', worker_id: 'wA', lease_epoch: 1, expires_at_ms: 1 }),
    ev('lease_released', { node_id: 'n1', worker_id: 'wA', lease_epoch: 1 }),
  ]);
  assert.equal(board.isReclaimable(b.leases.n1, PINNED_NOW, { alive: false }), false);
});

test('nextLeaseEpoch returns the current epoch plus 1, and 1 for a node that has never been leased', () => {
  const b = board.projectBoard([
    ev('claim_acquired', { node_id: 'n1', worker_id: 'wA', lease_epoch: 7 }),
  ]);
  assert.equal(board.nextLeaseEpoch(b, 'n1'), 8);
  assert.equal(board.nextLeaseEpoch(b, 'nUnknown'), 1);
  assert.equal(board.nextLeaseEpoch(board.projectBoard([]), 'n1'), 1);
});

test('the projection does not mutate the events it was handed', () => {
  const events = [
    ev('claim_acquired', { node_id: 'n1', worker_id: 'wA', lease_epoch: 1 }),
    ev('queue_entered', { node_id: 'n1', attempt_id: 'a1', ticket: 0 }),
  ];
  const before = JSON.stringify(events);
  board.projectBoard(events);
  assert.equal(JSON.stringify(events), before);
});

// ─── plan 03: the write side ─────────────────────────────────────────────────
//
// Everything above this line drives the PURE half plan 02 shipped. Everything
// below drives the 4 write verbs, the liveness seam and the log wins repair.
//
// THE 2 CASES BUILT SO THEY CAN FAIL, RATHER THAN BUILT SO THEY PASS:
//
//   1. THE CLAIM RACE runs 8 REAL child processes released from a barrier, not 8
//      sequential calls in 1 process. D7 names "a lock test that never actually
//      races" as the first of 4 things that pass trivially for a concurrent
//      system, and 8 sequential calls is exactly that test. The case additionally
//      asserts OBSERVED OVERLAP (the last child was released before the first
//      one finished), which is the only line that can catch a race that quietly
//      stopped racing.
//
//   2. THE LOG FIRST ORDERING is proven by MAKING THE PROJECTION WRITE FAIL,
//      never by reading both files after a call that succeeded. After a
//      successful claim both stores carry the claim, so reading both proves
//      nothing about which was written first. Pointing the projection at a path
//      that cannot be renamed over produces the real crash residue: the call
//      throws, the log carries the event, the projection does not, and the fold
//      of the log rebuilds the truth. Reverse the 2 writes and the log is EMPTY
//      after that same failure, so this case is the ordering assertion.
//
// Every time bearing case pins BOTH clock variables through `withPinnedClock`,
// for the reason stated at the top of this file.

const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');

const SCRATCH_ROOTS = [];

/** A throwaway fixture: its own log and its own projection, in its own directory. */
function fixture(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-board-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return {
    dir,
    logPath: path.join(dir, '.planning', 'fleet-runlog.jsonl'),
    projectionPath: path.join(dir, '.planning', 'fleet-board.json'),
  };
}

/** Every event in the log, in append order. [] when the log does not exist yet. */
function logEvents(logPath) {
  return runlog.readFleetRunlog({ path: logPath });
}

/** How many records of `kind` name `nodeId`. The refusal cases pin this to 0. */
function countKind(logPath, kind, nodeId) {
  return logEvents(logPath).filter((e) => e.kind === kind && e.node_id === nodeId).length;
}

/** The materialised projection, parsed. null when the file is absent. */
function readProjection(projectionPath) {
  if (!fs.existsSync(projectionPath)) return null;
  return JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
}

/** The base every write verb needs, so a case names only what it varies. */
function baseOpts(fx) {
  return {
    logPath: fx.logPath,
    projectionPath: fx.projectionPath,
    runId: 'run-plan03',
    ttlMs: 30_000,
    nowMs: PINNED_NOW,
  };
}

/** Assert `body` throws with exactly `code`, and that the log did not grow. */
function refuses(code, logPath, body) {
  const before = logEvents(logPath).length;
  assert.throws(body, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return true;
  });
  assert.equal(
    logEvents(logPath).length, before,
    'a refusal must append NOTHING: a verb that wrote before refusing leaves evidence of a claim that was never granted',
  );
}

test('the write surface plan 03 adds is exported, and its error codes are frozen', () => {
  assert.equal(typeof board.claimNode, 'function');
  assert.equal(typeof board.renewLease, 'function');
  assert.equal(typeof board.releaseLease, 'function');
  assert.equal(typeof board.currentHolder, 'function');
  for (const code of [
    'E_FLEET_NODE_HELD', 'E_FLEET_STALE_EPOCH', 'E_FLEET_NOT_HOLDER',
    'E_FLEET_NOT_RECLAIMABLE', 'E_FLEET_BAD_IDENTIFIER',
  ]) {
    assert.equal(board.FLEET_BOARD_ERROR_CODES[code], code, `${code} must be present and self-named`);
  }
  assert.ok(Object.isFrozen(board.FLEET_BOARD_ERROR_CODES), 'FLEET_BOARD_ERROR_CODES must be frozen');
});

test('a claim records the claimant identity, so the liveness arm has something to judge later', () => {
  withPinnedClock(PINNED_NOW, () => {
    // A lease with no holder record can NEVER be crash reclaimed: the liveness
    // arm has nothing to probe, so the node waits out the whole TTL even when the
    // worker is provably gone. Recording the identity at claim time is therefore
    // a correctness requirement rather than telemetry.
    const fx = fixture('holder-recorded');
    const lease = board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    assert.equal(lease.holder.pid, process.pid, 'the claiming process stamps its own pid by default');
    assert.equal(typeof lease.holder.pid_start, 'string');
    assert.ok(lease.holder.pid_start.length > 0, 'and the start stamp that makes the pid reuse safe');
    assert.equal(readProjection(fx.projectionPath).leases.n1.holder.pid, process.pid);

    const self = board.currentHolder();
    assert.equal(self.pid, process.pid);
    assert.equal(self.pid_start, lease.holder.pid_start);
  });
});

test('claiming a free node succeeds at epoch 1, appends claim_acquired, and leaves the projection holding it', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('claim-free');
    const lease = board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });

    assert.equal(lease.node_id, 'n1');
    assert.equal(lease.worker_id, 'wA');
    assert.equal(lease.lease_epoch, 1, 'a node with no prior lease takes epoch 1');
    assert.equal(lease.state, board.LEASE_STATES.HELD);
    assert.equal(lease.expires_at_ms, PINNED_NOW + 30_000);

    // The LOG carries it.
    const events = logEvents(fx.logPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'claim_acquired');
    assert.equal(events[0].run_id, 'run-plan03');
    assert.equal(events[0].lease_epoch, 1);

    // The PROJECTION carries it, and equals the fold of the log.
    const projected = readProjection(fx.projectionPath);
    assert.equal(projected.leases.n1.worker_id, 'wA');
    assert.equal(projected.leases.n1.state, board.LEASE_STATES.HELD);
    assert.deepEqual(projected, JSON.parse(JSON.stringify(board.projectBoard(events))));
  });
});

test('claiming a node already held is refused with E_FLEET_NODE_HELD and appends nothing', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('claim-held');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_NODE_HELD, fx.logPath, () => {
      board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wB' });
    });
    assert.equal(readProjection(fx.projectionPath).leases.n1.worker_id, 'wA', 'the refused claimant must not appear');
  });
});

test('THE DECISION READS THE LOG, so a projection that lost a claim the log carries still refuses a second claimant', () => {
  withPinnedClock(PINNED_NOW, () => {
    // This is the exact residue of a crash between the append and the projection
    // write: the log is AHEAD and the projection is BEHIND. A verb that decided
    // from the projection would find the node free and grant a SECOND claim at
    // the same epoch, which `projectBoard` would then honour, which is 2 workers
    // holding 1 node. Deciding from the log is what makes the log first ordering
    // recoverable rather than merely tidy.
    const fx = fixture('log-wins-decision');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });

    // Roll the projection back to empty, by hand, exactly as a lost write would.
    fs.writeFileSync(fx.projectionPath, JSON.stringify(board.projectBoard([]), null, 2) + '\n');
    assert.equal(readProjection(fx.projectionPath).leases.n1, undefined, 'the projection really has lost the claim');
    assert.equal(countKind(fx.logPath, 'claim_acquired', 'n1'), 1, 'the log really still carries it');

    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_NODE_HELD, fx.logPath, () => {
      board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wB' });
    });
  });
});

test('renewing with the matching worker and epoch extends the deadline and leaves the epoch unchanged', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('renew-ok');
    const claimed = board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });

    const renewed = board.renewLease({
      ...baseOpts(fx), nodeId: 'n1', workerId: 'wA',
      leaseEpoch: claimed.lease_epoch, nowMs: PINNED_NOW + 5_000,
    });

    assert.equal(renewed.lease_epoch, claimed.lease_epoch, 'a renewal NEVER changes the epoch');
    assert.equal(renewed.expires_at_ms, PINNED_NOW + 35_000, 'a renewal DOES extend the deadline');
    assert.equal(renewed.renewed_at_ms, PINNED_NOW + 5_000);
    assert.equal(countKind(fx.logPath, 'lease_renewed', 'n1'), 1);

    const projected = readProjection(fx.projectionPath);
    assert.equal(projected.leases.n1.lease_epoch, 1);
    assert.equal(projected.leases.n1.expires_at_ms, PINNED_NOW + 35_000);
  });
});

test('a long running worker renews past its ORIGINAL deadline and is never refused, which is what SC1 asks for', () => {
  withPinnedClock(PINNED_NOW, () => {
    // The whole point of the logical lease layer. `src/atomic-state.cts` refuses
    // a hold past half its stale window; a heartbeat renewed lease does not,
    // because the transaction lock is taken and dropped inside each heartbeat.
    const fx = fixture('long-worker');
    const claimed = board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', ttlMs: 1_000 });
    let now = PINNED_NOW;
    for (let beat = 1; beat <= 60; beat++) {
      now += 500;
      const renewed = board.renewLease({
        ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', ttlMs: 1_000,
        leaseEpoch: claimed.lease_epoch, nowMs: now,
      });
      assert.equal(renewed.lease_epoch, 1, `heartbeat ${beat} must not advance the epoch`);
    }
    assert.ok(now > PINNED_NOW + 15_000, 'the run outlasted the transaction lock hold budget by construction');
    assert.equal(countKind(fx.logPath, 'lease_renewed', 'n1'), 60);
    assert.equal(readProjection(fx.projectionPath).leases.n1.expires_at_ms, now + 1_000);
  });
});

test('renewing at a mismatched epoch is refused with E_FLEET_STALE_EPOCH and appends nothing', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('renew-stale');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_STALE_EPOCH, fx.logPath, () => {
      board.renewLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 2 });
    });
  });
});

test('renewing with a mismatched worker identity is refused with E_FLEET_NOT_HOLDER and appends nothing', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('renew-not-holder');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_HOLDER, fx.logPath, () => {
      board.renewLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wB', leaseEpoch: 1 });
    });
  });
});

test('renewing a node with no lease at all is refused with E_FLEET_NOT_HOLDER', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('renew-absent');
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_HOLDER, fx.logPath, () => {
      board.renewLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1 });
    });
  });
});

test('a worker that already RELEASED cannot keep heartbeating: the state check refuses it and the log does not grow', () => {
  withPinnedClock(PINNED_NOW, () => {
    // Dropping the HELD check from the holder gate leaves this call matching on
    // BOTH the epoch and the identity, because a released record keeps both. The
    // renewal is then appended, the fold ignores it because the lease is not
    // held, and the board looks correct while the RUN RECORD carries heartbeats
    // for a lease nobody owns. D3 computes demonstrated width and per node
    // latency out of exactly these records, so a phantom renewal is a corrupted
    // published figure rather than a cosmetic one, and it is invisible to any
    // assertion that only reads the projection.
    const fx = fixture('released-heartbeat');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    board.releaseLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1 });
    assert.equal(readProjection(fx.projectionPath).leases.n1.state, board.LEASE_STATES.RELEASED);

    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_HOLDER, fx.logPath, () => {
      board.renewLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1 });
    });
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_HOLDER, fx.logPath, () => {
      board.releaseLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1 });
    });
    assert.equal(
      countKind(fx.logPath, 'lease_renewed', 'n1'), 0,
      'not 1 phantom heartbeat reached the run record',
    );
  });
});

test('releasing with the matching worker and epoch frees the node for a new claim at the NEXT epoch', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('release');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    const released = board.releaseLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1 });
    assert.equal(released.state, board.LEASE_STATES.RELEASED);
    assert.equal(countKind(fx.logPath, 'lease_released', 'n1'), 1);

    const next = board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wB' });
    assert.equal(next.lease_epoch, 2, 'a cleanly released node hands the next holder N+1, never 1');
    assert.equal(readProjection(fx.projectionPath).leases.n1.worker_id, 'wB');
  });
});

test('releasing at a stale epoch is refused with E_FLEET_STALE_EPOCH, and by a non-holder with E_FLEET_NOT_HOLDER', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('release-refusals');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_STALE_EPOCH, fx.logPath, () => {
      board.releaseLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 99 });
    });
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_HOLDER, fx.logPath, () => {
      board.releaseLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wB', leaseEpoch: 1 });
    });
  });
});

test('an identifier that is not a non-empty string is REFUSED rather than coerced', () => {
  withPinnedClock(PINNED_NOW, () => {
    // A bare String() maps every object onto `[object Object]`, so 2 distinct
    // nodes collapse onto 1 key and the second silently shares the first's lease.
    // That is the identical defect plan 02 recorded against the manager, reached
    // from the write side, and it is a double holder rather than a lost dispatch.
    const fx = fixture('bad-id');
    const code = board.FLEET_BOARD_ERROR_CODES.E_FLEET_BAD_IDENTIFIER;
    refuses(code, fx.logPath, () => board.claimNode({ ...baseOpts(fx), nodeId: { a: 1 }, workerId: 'wA' }));
    refuses(code, fx.logPath, () => board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: { a: 1 } }));
    refuses(code, fx.logPath, () => board.claimNode({ ...baseOpts(fx), nodeId: '', workerId: 'wA' }));
    refuses(code, fx.logPath, () => board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 42 }));
    assert.equal(fs.existsSync(fx.projectionPath), false, 'a refused identifier writes no projection either');
  });
});

test('a TTL that is not a positive number is refused, because a lease that cannot expire wedges its node', () => {
  withPinnedClock(PINNED_NOW, () => {
    // ttlMs 0 makes `expires_at_ms` equal `nowMs`, and `isLeaseExpired` is true AT
    // the deadline, so the lease is born reclaimable. A negative TTL is born
    // already expired. Both hand the node to the next caller instantly, which is
    // the double holder this whole layer exists to prevent, arriving through the
    // arithmetic rather than through a race.
    const fx = fixture('bad-ttl');
    const code = board.FLEET_BOARD_ERROR_CODES.E_FLEET_BAD_IDENTIFIER;
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '30000', undefined]) {
      refuses(code, fx.logPath, () => board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', ttlMs }));
    }
    // And the same door on the heartbeat, or a renewal could un-expire nothing.
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    refuses(code, fx.logPath, () => {
      board.renewLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1, ttlMs: 0 });
    });
  });
});

test('an instant that is not a finite number is refused, so no verb can silently stamp a lease with NaN', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('bad-now');
    const code = board.FLEET_BOARD_ERROR_CODES.E_FLEET_BAD_IDENTIFIER;
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, '1785000000000', null, undefined]) {
      refuses(code, fx.logPath, () => board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', nowMs }));
    }
  });
});

test('THE LOG IS WRITTEN BEFORE THE PROJECTION: a failed projection write leaves the log ahead and rebuildable', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('log-first');
    fs.mkdirSync(path.dirname(fx.projectionPath), { recursive: true });
    // A non-empty DIRECTORY at the projection path. The lock still opens (it is a
    // sibling), the read is tolerated, the append succeeds, and the rename onto a
    // directory cannot succeed. That is a real failure, not a simulated one.
    fs.mkdirSync(fx.projectionPath, { recursive: true });
    fs.writeFileSync(path.join(fx.projectionPath, 'occupied'), 'x');

    assert.throws(
      () => board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' }),
      /./,
      'the projection write must fail loudly rather than be swallowed',
    );

    // THE ASSERTION. The log carries the claim even though the call threw. If the
    // projection were written FIRST, the write would have failed before the
    // append and this count would be 0.
    assert.equal(
      countKind(fx.logPath, 'claim_acquired', 'n1'), 1,
      'the event must already be in the log when the projection write fails; reversing the 2 writes makes this 0',
    );

    // And the truth is rebuildable from the log alone, which is why this ordering
    // is the recoverable one.
    const rebuilt = board.projectBoard(logEvents(fx.logPath));
    assert.equal(rebuilt.leases.n1.worker_id, 'wA');
    assert.equal(rebuilt.leases.n1.lease_epoch, 1);
    assert.equal(rebuilt.leases.n1.state, board.LEASE_STATES.HELD);
  });
});

// ─── the 8 process claim race ────────────────────────────────────────────────

const RACERS = 8;

/**
 * The racer. A real process, because 8 claimants in 1 process share a descriptor
 * table and an event loop and therefore cannot exercise a CROSS PROCESS lock.
 *
 * argv: libPath logPath projectionPath startFile resultFile nodeId workerId nowMs
 */
const RACER_SOURCE = `'use strict';
const fs = require('node:fs');
const [libPath, logPath, projectionPath, startFile, resultFile, nodeId, workerId, nowRaw] = process.argv.slice(2);
const board = require(libPath);

process.stdout.write('READY\\n');
// Busy wait, deliberately: a timer hands the barrier a scheduling quantum and
// staggers the release, which is the thing this construction exists to avoid.
while (!fs.existsSync(startFile)) { /* spin */ }
const releasedAt = Date.now();

let outcome;
try {
  const lease = board.claimNode({
    logPath, projectionPath, runId: 'run-race', nodeId, workerId,
    ttlMs: 30000, nowMs: Number(nowRaw),
  });
  outcome = { won: true, epoch: lease.lease_epoch };
} catch (err) {
  outcome = { won: false, code: err.code || null, message: String(err.message).slice(0, 200) };
}
fs.writeFileSync(resultFile, JSON.stringify({ workerId, releasedAt, finishedAt: Date.now(), ...outcome }));
`;

test('8 REAL child processes racing 1 node produce exactly 1 holder, 7 coded refusals and exactly 1 claim_acquired', async () => {
  const fx = fixture('race');
  const racerPath = path.join(fx.dir, 'racer.cjs');
  fs.writeFileSync(racerPath, RACER_SOURCE);
  fs.mkdirSync(path.dirname(fx.logPath), { recursive: true });
  const startFile = path.join(fx.dir, 'START');

  const resultFiles = [];
  const exits = [];
  const readies = [];

  for (let idx = 0; idx < RACERS; idx++) {
    const resultFile = path.join(fx.dir, `result-${idx}`);
    resultFiles.push(resultFile);
    const child = spawn(
      process.execPath,
      [
        racerPath, BUILT_LIB, fx.logPath, fx.projectionPath, startFile, resultFile,
        'contested', `w${idx}`, String(PINNED_NOW),
      ],
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
        announceLost(new Error(`racer ${idx} exited ${code} before the barrier: ${stderr}`));
        if (code === 0) resolve();
        else reject(new Error(`racer ${idx} exited ${code}: ${stderr}`));
      });
    }));
  }

  await Promise.all(readies);
  fs.writeFileSync(startFile, 'go');
  await Promise.all(exits);

  const reports = resultFiles.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  assert.equal(reports.length, RACERS, 'every racer reported');

  // OBSERVED OVERLAP. Without this the rest of the case is a story: 8 claimants
  // that serialized at process startup never contended at all.
  const lastRelease = Math.max(...reports.map((r) => r.releasedAt));
  const firstFinish = Math.min(...reports.map((r) => r.finishedAt));
  assert.ok(
    lastRelease <= firstFinish,
    `the racers did not overlap: the last was released at ${lastRelease} but the first had finished at `
      + `${firstFinish}. A lock test that never actually races is D7's first named trap, so this is a `
      + 'failure of the TEST, not of the module.',
  );

  const winners = reports.filter((r) => r.won);
  const losers = reports.filter((r) => !r.won);
  assert.equal(winners.length, 1, `exactly 1 holder, saw ${winners.length}: ${JSON.stringify(reports)}`);
  assert.equal(losers.length, RACERS - 1, `${RACERS - 1} refusals`);
  assert.equal(winners[0].epoch, 1, 'the single winner took epoch 1');
  for (const loser of losers) {
    assert.equal(
      loser.code, board.FLEET_BOARD_ERROR_CODES.E_FLEET_NODE_HELD,
      `every loser is refused by CODE, not by a crash: ${loser.message}`,
    );
  }

  // The log is the evidence, and it must carry exactly 1 grant.
  assert.equal(
    countKind(fx.logPath, 'claim_acquired', 'contested'), 1,
    'exactly 1 claim_acquired for the contested node: a second grant in the log is a double holder on disk',
  );
  const folded = board.projectBoard(logEvents(fx.logPath));
  assert.equal(folded.leases.contested.worker_id, winners[0].workerId);
  assert.equal(readProjection(fx.projectionPath).leases.contested.worker_id, winners[0].workerId);

  // No holder died inside the transaction, so nothing is left to stall the line.
  assert.equal(fs.existsSync(fx.projectionPath + '.lock'), false, 'no surviving projection lockfile');
  assert.equal(fs.existsSync(fx.logPath + '.lock'), false, 'no surviving log lockfile');
});

// ─── plan 03 task 2: reclaim, the liveness seam and the log wins repair ──────
//
// THE LIVENESS SEAM IS DRIVEN BOTH WAYS FROM BOTH SIDES. `probeLiveness` takes
// its 2 halves as injectable dependencies, so the dead arms are reachable here
// without killing anything, and `tests/fleet-board-crash.test.cjs` drives the
// DEFAULT implementation against a process that was genuinely killed. Neither
// file alone is sufficient: an injected probe proves the reclaim logic and
// proves nothing about the probe, and a real kill proves the probe and cannot
// reach the arms that do not happen on the test machine.
//
// THE UNREADABLE ARMS ARE ASSERTED TO REPORT ALIVE. A probe that failed open
// toward the RECLAIMER would let an unreadable answer steal a live worker's
// lease, and a double holder corrupts a worktree unrecoverably while a wedge
// does not. The direction of the failure is the mitigation, so it is asserted
// rather than described.

/**
 * A synthetic claimant identity, so a forced probe can be made to AGREE with what
 * the claim recorded. Using the real process identity here would make
 * `fixedProbe(true)` disagree with the recorded stamp and report dead, which
 * would quietly turn the "holder is alive" refusal case into a second copy of the
 * "holder is dead" case and stop it testing the refusal at all.
 */
const SYNTHETIC_HOLDER = Object.freeze({ pid: 4242, pid_start: 'synthetic start stamp' });

/** A probe that always answers the same way, for driving the reclaim arms. */
function fixedProbe(alive) {
  return {
    pidExists: () => alive,
    readPidStart: () => (alive ? SYNTHETIC_HOLDER.pid_start : null),
  };
}

/** A pid that is certainly gone: a real child, spawned and reaped. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve) => { child.on('exit', resolve); });
  return pid;
}

test('the reclaim surface and the liveness seam are exported', () => {
  assert.equal(typeof board.reclaimLease, 'function');
  assert.equal(typeof board.reconcileBoard, 'function');
  assert.equal(typeof board.probeLiveness, 'function');
});

test('reclaiming an EXPIRED lease succeeds, names the prior holder and epoch, and mints the next epoch', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('reclaim-expired');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', ttlMs: 1_000 });

    const reclaimed = board.reclaimLease({
      ...baseOpts(fx), nodeId: 'n1', workerId: 'wB', nowMs: PINNED_NOW + 1_000,
      // The holder is ALIVE. A wedged process that stopped renewing must still be
      // reclaimable, or a hung worker holds its node for the rest of the run.
      deps: fixedProbe(true),
    });

    assert.equal(reclaimed.lease_epoch, 2, 'the reclaim mints prior epoch plus 1');
    assert.equal(reclaimed.worker_id, 'wB');
    assert.equal(reclaimed.state, board.LEASE_STATES.HELD);

    const event = logEvents(fx.logPath).find((e) => e.kind === 'lease_reclaimed');
    assert.equal(event.prior_worker_id, 'wA');
    assert.equal(event.prior_lease_epoch, 1);
    assert.equal(event.reason, 'expired');
    assert.equal(event.lease_epoch, 2);
  });
});

test('reclaiming a LIVE lease whose holder is alive is refused with E_FLEET_NOT_RECLAIMABLE and appends nothing', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('reclaim-refused');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', holder: SYNTHETIC_HOLDER });
    // The probe AGREES with the recorded stamp, so the verdict is genuinely alive
    // rather than a mismatch wearing an alive label.
    assert.equal(board.probeLiveness(SYNTHETIC_HOLDER, fixedProbe(true)).reason, 'pid_and_start_stamp_match');
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_RECLAIMABLE, fx.logPath, () => {
      board.reclaimLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wB', deps: fixedProbe(true) });
    });
    assert.equal(readProjection(fx.projectionPath).leases.n1.worker_id, 'wA', 'the live holder keeps its node');
  });
});

test('reclaiming a LIVE lease whose holder is provably dead succeeds WITHOUT waiting for the TTL', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('reclaim-dead');
    const claimed = board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', ttlMs: 3_600_000 });

    // The lease is NOT expired at this instant, so a TTL only reclaim would have
    // to wait an hour. There is NO clock advance below: nowMs is the claim instant.
    assert.equal(board.isLeaseExpired(claimed, PINNED_NOW), false, 'the lease is live, so only the liveness arm can fire');

    const reclaimed = board.reclaimLease({
      ...baseOpts(fx), nodeId: 'n1', workerId: 'wB', nowMs: PINNED_NOW, deps: fixedProbe(false),
    });
    assert.equal(reclaimed.lease_epoch, 2);
    assert.equal(reclaimed.worker_id, 'wB');
    const event = logEvents(fx.logPath).find((e) => e.kind === 'lease_reclaimed');
    assert.equal(event.reason, 'holder_dead', 'the reason names which arm fired, so a reader can tell them apart');
  });
});

test('THE FENCE: after a reclaim the prior holder renewing at the prior epoch is refused with E_FLEET_STALE_EPOCH', () => {
  withPinnedClock(PINNED_NOW, () => {
    // Without this assertion the epoch is decoration. It is the 1 mechanism that
    // stops a displaced worker from resuming as if it still held its lease.
    const fx = fixture('stale-fence');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', ttlMs: 3_600_000 });
    board.reclaimLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wB', deps: fixedProbe(false) });

    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_STALE_EPOCH, fx.logPath, () => {
      board.renewLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1 });
    });
    // The prior holder mismatches on BOTH the epoch and the identity here, and the
    // required code is the EPOCH one: it tells the worker its lease was taken,
    // rather than that it was never the holder. That is why the checks run in a
    // fixed order.
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_STALE_EPOCH, fx.logPath, () => {
      board.releaseLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1 });
    });
    assert.equal(readProjection(fx.projectionPath).leases.n1.worker_id, 'wB');
  });
});

test('reclaiming a node with no held lease is refused WITHOUT probing, because a free node is claimed rather than reclaimed', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('reclaim-free');
    const code = board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_RECLAIMABLE;

    // A counting probe. The state check and `isReclaimable` BOTH refuse a
    // non-held lease, so a case that only asserted the refusal cannot tell which
    // one answered and the early check would be unobservable. What the early
    // check uniquely buys is that no process listing is spawned inside a held
    // transaction for a node that was never held, and that the diagnostic says
    // "nothing to reclaim" rather than "taking it now would produce 2 holders".
    // Both are asserted here, so the check has behaviour of its own to fail on.
    let probes = 0;
    const counting = { pidExists: () => { probes++; return false; }, readPidStart: () => null };

    refuses(code, fx.logPath, () => {
      board.reclaimLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wB', deps: counting });
    });

    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', holder: SYNTHETIC_HOLDER });
    board.releaseLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1 });

    let refusal = null;
    try {
      board.reclaimLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wB', deps: counting });
    } catch (err) {
      refusal = err;
    }
    assert.equal(refusal.code, code);
    assert.match(
      refusal.message, /nothing to reclaim/,
      'a released node is refused BY THE STATE CHECK, which says what is actually wrong',
    );
    assert.equal(
      probes, 0,
      'a node that is not held must be refused before the liveness probe runs: probing spawns a process '
        + 'listing, and doing that inside a held transaction to answer a question already settled is work '
        + 'that lengthens every other worker\'s wait',
    );
  });
});

test('the DEFAULT liveness probe reports dead for a pid that does not exist', async () => {
  const pid = await deadPid();
  const verdict = board.probeLiveness({ pid, pid_start: 'whatever was recorded' });
  assert.equal(verdict.alive, false, `pid ${pid} was reaped before this assertion ran`);
  assert.equal(verdict.reason, 'pid_absent');
});

test('the DEFAULT liveness probe reports dead for a LIVE pid whose recorded start stamp does not match', () => {
  // This process is certainly alive, so the pid arm cannot be what answers. Only
  // the start stamp binding can, and without it a recycled pid resurrects a
  // claimant that died: os.kill(pid, 0) says "a process exists", never "THE
  // process exists". Same binding the vendored engine uses at ratchet:1499.
  const verdict = board.probeLiveness({ pid: process.pid, pid_start: 'Thu Jan  1 00:00:00 1999' });
  assert.equal(verdict.alive, false, 'a live pid wearing a different start stamp is a different process');
  assert.equal(verdict.reason, 'start_stamp_mismatch');

  const self = board.currentHolder();
  const matching = board.probeLiveness(self);
  assert.equal(matching.alive, true, 'and this very process reports alive against its own stamp');
  assert.equal(matching.reason, 'pid_and_start_stamp_match');
});

test('EVERY UNREADABLE ARM OF THE PROBE REPORTS ALIVE, so an unreadable probe can never steal a live lease', () => {
  const cases = [
    [null, 'holder_record_unreadable'],
    [undefined, 'holder_record_unreadable'],
    ['not-an-object', 'holder_record_unreadable'],
    [{ pid: 'nope', pid_start: 'x' }, 'pid_unreadable'],
    [{ pid: 0, pid_start: 'x' }, 'pid_unreadable'],
    [{ pid: -1, pid_start: 'x' }, 'pid_unreadable'],
    [{ pid: 1.5, pid_start: 'x' }, 'pid_unreadable'],
  ];
  for (const [holder, reason] of cases) {
    const verdict = board.probeLiveness(holder);
    assert.equal(verdict.alive, true, `${JSON.stringify(holder)} must fail closed toward the holder`);
    assert.equal(verdict.reason, reason);
  }

  // An unknowable presence check, and an unreadable start stamp, both report alive.
  const unknowable = board.probeLiveness({ pid: 4242, pid_start: 'x' }, { pidExists: () => null });
  assert.equal(unknowable.alive, true);
  assert.equal(unknowable.reason, 'pid_presence_unknowable');

  const unreadableStamp = board.probeLiveness(
    { pid: 4242, pid_start: 'x' },
    { pidExists: () => true, readPidStart: () => null },
  );
  assert.equal(unreadableStamp.alive, true);
  assert.equal(unreadableStamp.reason, 'start_stamp_unreadable');

  // A holder recorded with NO binding is treated as alive while its pid lives,
  // matching the conservative branch at ratchet:1499.
  const noBinding = board.probeLiveness({ pid: 4242, pid_start: '' }, { pidExists: () => true });
  assert.equal(noBinding.alive, true);
  assert.equal(noBinding.reason, 'no_start_binding_recorded');
});

test('an unreadable probe does NOT authorise a reclaim: the refusal survives when the probe cannot answer', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('probe-unreadable');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    refuses(board.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_RECLAIMABLE, fx.logPath, () => {
      board.reclaimLease({
        ...baseOpts(fx), nodeId: 'n1', workerId: 'wB',
        deps: { pidExists: () => null, readPidStart: () => null },
      });
    });
  });
});

test('reconcileBoard REBUILDS a projection that disagrees with the log, and the rebuilt projection equals the fold', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('reconcile-rebuild');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    board.claimNode({ ...baseOpts(fx), nodeId: 'n2', workerId: 'wB' });

    // Corrupt the projection ON PURPOSE. This is D7's construction of driving a
    // guard against a case where the thing it detects IS present.
    const corrupted = readProjection(fx.projectionPath);
    delete corrupted.leases.n2;
    corrupted.leases.n1.worker_id = 'an-imposter';
    corrupted.completed = ['a-node-that-never-completed'];
    fs.writeFileSync(fx.projectionPath, JSON.stringify(corrupted, null, 2) + '\n');

    const outcome = board.reconcileBoard({ logPath: fx.logPath, projectionPath: fx.projectionPath });
    assert.equal(outcome.agreed, false, 'the disagreement must be reported, not silently repaired');
    assert.equal(outcome.rebuilt, true);

    const repaired = readProjection(fx.projectionPath);
    const fold = JSON.parse(JSON.stringify(board.projectBoard(logEvents(fx.logPath))));
    assert.deepEqual(repaired, fold, 'the log wins and the projection equals its fold');
    assert.equal(repaired.leases.n1.worker_id, 'wA');
    assert.equal(repaired.leases.n2.worker_id, 'wB');
    assert.deepEqual(repaired.completed, []);
  });
});

test('reconcileBoard rebuilds a projection that is MISSING or unparseable, rather than throwing', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('reconcile-absent');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });

    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing 1 named file to reproduce a lost projection write
    fs.rmSync(fx.projectionPath, { force: true });
    let outcome = board.reconcileBoard({ logPath: fx.logPath, projectionPath: fx.projectionPath });
    assert.equal(outcome.agreed, false);
    assert.equal(outcome.rebuilt, true);
    assert.equal(readProjection(fx.projectionPath).leases.n1.worker_id, 'wA');

    fs.writeFileSync(fx.projectionPath, 'this is not json at all');
    outcome = board.reconcileBoard({ logPath: fx.logPath, projectionPath: fx.projectionPath });
    assert.equal(outcome.rebuilt, true, 'an unparseable projection is a DISAGREEING projection, never a fatal one');
    assert.equal(readProjection(fx.projectionPath).leases.n1.worker_id, 'wA');
  });
});

test('reconcileBoard on an AGREEING projection reports agreement and REWRITES NOTHING', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('reconcile-agree');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    board.renewLease({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA', leaseEpoch: 1, nowMs: PINNED_NOW + 10 });

    // The inode is the evidence. `atomicWriteFileSync` renames a fresh temp file
    // into place, so ANY rewrite changes it. Comparing content would not catch a
    // rewrite that happened to produce the same bytes, and "rewrites nothing" is
    // the claim being made.
    const before = fs.statSync(fx.projectionPath);
    const outcome = board.reconcileBoard({ logPath: fx.logPath, projectionPath: fx.projectionPath });
    const after = fs.statSync(fx.projectionPath);

    assert.equal(outcome.agreed, true);
    assert.equal(outcome.rebuilt, false);
    assert.equal(after.ino, before.ino, 'an agreeing reconcile must not rename a new file over the projection');
    assert.equal(after.mtimeMs, before.mtimeMs);
  });
});

test('reconcileBoard compares CONTENT, so a semantically identical projection with different key order does not churn', () => {
  withPinnedClock(PINNED_NOW, () => {
    // The projection is a file that every worker's transaction rewrites and that
    // a reconcile pass may run against repeatedly. If agreement were decided by
    // raw serialization, any producer that emitted the same content in a
    // different key order (a formatter, a jq filter, a later writer) would make
    // every reconcile report disagreement and rename a fresh file over a
    // contended path forever. Comparing content is what stops a cosmetic
    // difference becoming permanent churn.
    const fx = fixture('reconcile-key-order');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    board.claimNode({ ...baseOpts(fx), nodeId: 'n2', workerId: 'wB' });

    const reverseKeys = (node) => {
      if (Array.isArray(node)) return node.map(reverseKeys);
      if (node === null || typeof node !== 'object') return node;
      const out = {};
      for (const key of Object.keys(node).reverse()) out[key] = reverseKeys(node[key]);
      return out;
    };

    const shuffled = reverseKeys(readProjection(fx.projectionPath));
    const shuffledText = JSON.stringify(shuffled, null, 2) + '\n';
    const foldText = JSON.stringify(board.projectBoard(logEvents(fx.logPath)), null, 2) + '\n';
    assert.notEqual(
      shuffledText, foldText,
      'the 2 serializations must genuinely differ, or this case cannot fail',
    );
    assert.deepEqual(shuffled, JSON.parse(foldText), 'and they must carry identical content');

    fs.writeFileSync(fx.projectionPath, shuffledText);
    const before = fs.statSync(fx.projectionPath);
    const outcome = board.reconcileBoard({ logPath: fx.logPath, projectionPath: fx.projectionPath });
    const after = fs.statSync(fx.projectionPath);

    assert.equal(outcome.agreed, true, 'the same content in a different key order IS agreement');
    assert.equal(outcome.rebuilt, false);
    assert.equal(after.ino, before.ino, 'and nothing was renamed over the contended projection path');
  });
});

test('reconcileBoard leaves the LOG untouched: a repair never invents an event', () => {
  withPinnedClock(PINNED_NOW, () => {
    const fx = fixture('reconcile-log-untouched');
    board.claimNode({ ...baseOpts(fx), nodeId: 'n1', workerId: 'wA' });
    const before = fs.readFileSync(fx.logPath, 'utf8');
    fs.writeFileSync(fx.projectionPath, JSON.stringify(board.projectBoard([]), null, 2) + '\n');
    board.reconcileBoard({ logPath: fx.logPath, projectionPath: fx.projectionPath });
    assert.equal(
      fs.readFileSync(fx.logPath, 'utf8'), before,
      'the projection is derived, so repairing it can only ever read the log',
    );
  });
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
