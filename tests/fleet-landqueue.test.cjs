'use strict';

/**
 * Phase 19 plan 02 task 2: the land queue's derived ticket ordering and the token
 * predicates.
 *
 * THE CASE BUILT SO IT CAN FAIL IS `a caller that is not the head is refused with
 * NO HOLDER PRESENT`. T-19-12 is a token check that looks only at the holder,
 * which lets a late entrant jump every ticket ahead of it. That defect is INVISIBLE
 * to the obvious case, because the obvious case has a holder and a holder-only
 * check refuses it for the wrong reason and still reports refused. So the case
 * here clears the holder first, and asserts both the refusal AND its code. A
 * holder-only implementation returns allowed on that row.
 *
 * The wedge case is built the same way. A crashed lander that could never be
 * judged gone would hold the trunk for the whole run (T-19-11), so both arms are
 * driven: an expired holder and a holder whose liveness verdict says dead. The
 * third row drives the case where the thing is NOT present, a live holder that is
 * alive, and asserts it does block. Without that row an implementation that always
 * says "not blocking" passes the first 2.
 *
 * Every case that involves time pins BOTH `FERROX_TEST_MODE` and `FERROX_NOW_MS`,
 * because `ferrox-core/bin/lib/clock.cjs:34-36` returns null unless the test mode
 * flag is set and `:60-64` falls back to the platform clock when the pin is null,
 * so setting 1 of the 2 leaves code reading real time while APPEARING pinned.
 *
 * ─── PLAN 04 ADDS THE WRITE SIDE BELOW ───────────────────────────────────────
 *
 * Plan 02 built the predicates. Plan 04 builds the 4 write verbs plus `runLand`,
 * and the cases for them start at "the write verbs" below. Two constructions in
 * that section carry the weight, and both exist because of a NAMED defect:
 *
 *   1. THE TOKEN PATH IS DERIVED FROM THE REPO KEY AND NOTHING ELSE. The vendored
 *      claim at `ratchet:824-830` keys on `os.path.realpath(expand(c["worktree"]))`,
 *      so 2 lands on 2 worktrees of 1 repository never see each other. The case
 *      here builds exactly that pairing, 2 distinct worktree paths against 1
 *      repoKey, and asserts the second is REFUSED. A worktree scoped token returns
 *      allowed on that row, which is the whole of GATE 4 reproduced in 1
 *      assertion.
 *
 *   2. A REFUSAL WRITES NOTHING. Every refusal row asserts the log length is
 *      UNCHANGED, not merely that a code came back. An implementation that
 *      appends `queue_acquired` and then reports refused would leave the
 *      projection believing the trunk is held by a caller that never landed,
 *      wedging it for the rest of the run. The code alone cannot catch that.
 *
 * The clock source case does NOT pin through the environment. It supplies an
 * explicit `clock` function returning an instant 6 years in the past and asserts
 * every emitted `ts` is that instant, so a module that reached for the platform
 * clock is caught by the value rather than by a code reading guard. 19-01 recorded
 * a protocol guard that fired on a header COMMENT rather than on behaviour; these
 * cases drive behaviour for that reason.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const queue = require('../ferrox-core/bin/lib/fleet-landqueue.cjs');
const board = require('../ferrox-core/bin/lib/fleet-board.cjs');
const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-landqueue.cjs');

const PINNED_NOW = 1785000000000;

/**
 * A clearly PAST instant for the clock source case, 2020 rather than 2026.
 *
 * The value matters. `PINNED_NOW` above sits within a few days of real wall time,
 * so a module that read `Date.now()` would produce a `ts` close enough to it that
 * a loose assertion could not tell the 2 apart. This one cannot be confused with
 * a platform clock read by anybody, including a future reader.
 */
const PAST_INSTANT = 1600000000000;

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-landqueue-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/** The base options every write verb case shares. `logPath` and `repoKey` are required. */
function baseOpts(dir, over) {
  return Object.assign({
    logPath: path.join(dir, '.planning', 'fleet-runlog.jsonl'),
    tokenDir: path.join(dir, '.planning'),
    repoKey: 'ferroxfactory/core',
    runId: 'run-lq',
    nodeId: 'n0',
    attemptId: 'a0',
    workerId: 'w0',
    nowMs: PINNED_NOW,
    ttlMs: 60000,
    liveness: { alive: true },
  }, over);
}

function readLog(opts) {
  return runlog.readFleetRunlog({ path: opts.logPath });
}

function kindsOf(opts) {
  return readLog(opts).map((e) => e.kind);
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

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

function ev(kind, fields) {
  return Object.assign({ ts: PINNED_NOW, kind, run_id: 'r1' }, fields);
}

/** N entrants, ticket derived from the count of prior entries, exactly as D4 requires. */
function entrants(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(ev('queue_entered', {
      ts: PINNED_NOW + i, node_id: `n${i}`, attempt_id: `a${i}`, ticket: queue.nextTicket(out),
    }));
  }
  return out;
}

test('the built artifact exists and exports the pure surface plan 04 consumes', () => {
  assert.ok(fs.existsSync(BUILT_LIB), `${BUILT_LIB} must be built and committed`);
  assert.equal(typeof queue.projectQueue, 'function');
  assert.equal(typeof queue.nextTicket, 'function');
  assert.equal(typeof queue.queueHead, 'function');
  assert.equal(typeof queue.mayAcquireToken, 'function');
  assert.deepEqual(queue.LANDQUEUE_ERROR_CODES, {
    E_FLEET_NOT_QUEUE_HEAD: 'E_FLEET_NOT_QUEUE_HEAD',
    E_FLEET_TOKEN_HELD: 'E_FLEET_TOKEN_HELD',
    E_FLEET_BAD_REPO_KEY: 'E_FLEET_BAD_REPO_KEY',
    E_FLEET_TOKEN_WAIT_TIMEOUT: 'E_FLEET_TOKEN_WAIT_TIMEOUT',
  });
  assert.ok(Object.isFrozen(queue.LANDQUEUE_ERROR_CODES), 'the codes must be frozen');
});

test('the write surface plan 04 adds is exported', () => {
  for (const verb of [
    'landTokenPath', 'enterLandQueue', 'acquireLandToken', 'releaseLandToken',
    'withLandToken', 'runLand', 'landCommandSpec',
  ]) {
    assert.equal(typeof queue[verb], 'function', `${verb} must be exported`);
  }
});

test('the ticket for a new entrant is the count of prior queue_entered events, derived and never stored', () => {
  assert.equal(queue.nextTicket([]), 0, 'the first entrant takes ticket 0');
  const log = entrants(3);
  assert.deepEqual(log.map((e) => e.ticket), [0, 1, 2]);
  assert.equal(queue.nextTicket(log), 3, 'the next entrant takes 3, counted from the log');

  // Events of every other kind are not entries and must not advance the ticket.
  const noisy = [
    ...log,
    ev('gate_started', { node_id: 'n0', attempt_id: 'a0' }),
    ev('claim_acquired', { node_id: 'n0', worker_id: 'w0', lease_epoch: 1 }),
    ev('land_completed', { node_id: 'n0', attempt_id: 'a0', result: 'landed' }),
  ];
  assert.equal(queue.nextTicket(noisy), 3, 'only queue_entered counts');
});

test('projectQueue is the board fold, so the queue and the board cannot describe different runs', () => {
  const log = entrants(2);
  assert.deepEqual(queue.projectQueue(log), board.projectBoard(log).queue);
});

test('queueHead returns the lowest ticket that entered and has not completed, and null for an empty queue', () => {
  assert.equal(queue.queueHead(queue.projectQueue([])), null, 'an empty queue has no head');

  const log = entrants(3);
  assert.equal(queue.queueHead(queue.projectQueue(log)), 0);

  // Ticket 0 completes: the head advances to 1, not to "the next one inserted".
  const afterFirst = [
    ...log,
    ev('queue_acquired', { ts: PINNED_NOW + 10, node_id: 'n0', attempt_id: 'a0', ticket: 0, worker_id: 'w0' }),
    ev('land_completed', { ts: PINNED_NOW + 11, node_id: 'n0', attempt_id: 'a0', result: 'landed' }),
  ];
  assert.equal(queue.queueHead(queue.projectQueue(afterFirst)), 1);
});

test('a queue whose every ticket has completed has no head, which is not the same as ticket 0', () => {
  const log = [
    ev('queue_entered', { node_id: 'n0', attempt_id: 'a0', ticket: 0 }),
    ev('queue_acquired', { ts: PINNED_NOW + 1, node_id: 'n0', attempt_id: 'a0', ticket: 0, worker_id: 'w0' }),
    ev('land_completed', { ts: PINNED_NOW + 2, node_id: 'n0', attempt_id: 'a0', result: 'landed' }),
  ];
  assert.equal(queue.queueHead(queue.projectQueue(log)), null);
});

test('queueHead does not depend on the tickets array being sorted', () => {
  const q = { tickets: [
    { ticket: 5, completed_at: null },
    { ticket: 2, completed_at: null },
    { ticket: 9, completed_at: null },
  ] };
  assert.equal(queue.queueHead(q), 2);
});

test('a queue_acquired without a matching land_completed leaves that ticket as the current holder', () => {
  withPinnedClock(PINNED_NOW, () => {
    const log = [
      ...entrants(2),
      ev('queue_acquired', {
        ts: PINNED_NOW + 10, node_id: 'n0', attempt_id: 'a0', ticket: 0, worker_id: 'w0',
        expires_at_ms: PINNED_NOW + 5000,
      }),
    ];
    const q = queue.projectQueue(log);
    assert.notEqual(q.held_by, null);
    assert.equal(q.held_by.ticket, 0);
    assert.equal(q.held_by.worker_id, 'w0');
  });
});

test('a land_completed clears the holder and advances the head to the next ticket', () => {
  withPinnedClock(PINNED_NOW, () => {
    const log = [
      ...entrants(2),
      ev('queue_acquired', {
        ts: PINNED_NOW + 10, node_id: 'n0', attempt_id: 'a0', ticket: 0, worker_id: 'w0',
        expires_at_ms: PINNED_NOW + 5000,
      }),
      ev('land_completed', { ts: PINNED_NOW + 20, node_id: 'n0', attempt_id: 'a0', result: 'landed' }),
    ];
    const q = queue.projectQueue(log);
    assert.equal(q.held_by, null);
    assert.equal(queue.queueHead(q), 1);
  });
});

test('mayAcquireToken is true only when there is no live holder AND the caller is the head', () => {
  withPinnedClock(PINNED_NOW, () => {
    const q = queue.projectQueue(entrants(3));
    assert.equal(q.held_by, null);
    const verdict = queue.mayAcquireToken(q, 0, PINNED_NOW, { alive: true });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.code, null);
    assert.equal(verdict.head, 0);
  });
});

test('mayAcquireToken refuses a caller that is not the head EVEN WITH NO HOLDER PRESENT', () => {
  withPinnedClock(PINNED_NOW, () => {
    const q = queue.projectQueue(entrants(3));
    assert.equal(
      q.held_by, null,
      'the holder must be absent, or a holder-only check would refuse for the wrong reason and this case could not fire',
    );
    const verdict = queue.mayAcquireToken(q, 2, PINNED_NOW, { alive: true });
    assert.equal(verdict.allowed, false, 'a late entrant must not jump the 2 tickets ahead of it');
    assert.equal(verdict.code, queue.LANDQUEUE_ERROR_CODES.E_FLEET_NOT_QUEUE_HEAD);
    assert.equal(verdict.head, 0);
  });
});

test('mayAcquireToken refuses the head when a LIVE holder is landing, with the token-held code', () => {
  withPinnedClock(PINNED_NOW, () => {
    const log = [
      ...entrants(2),
      ev('queue_acquired', {
        ts: PINNED_NOW + 10, node_id: 'n0', attempt_id: 'a0', ticket: 0, worker_id: 'w0',
        expires_at_ms: PINNED_NOW + 5000,
      }),
    ];
    const q = queue.projectQueue(log);
    const verdict = queue.mayAcquireToken(q, 0, PINNED_NOW + 20, { alive: true });
    assert.equal(verdict.allowed, false);
    assert.equal(
      verdict.code, queue.LANDQUEUE_ERROR_CODES.E_FLEET_TOKEN_HELD,
      'the 2 refusals have different remedies, so they must have different codes',
    );
    assert.equal(verdict.holder_ticket, 0);
  });
});

test('an EXPIRED holder does not block, so a wedged lander cannot hold the trunk for the whole run', () => {
  withPinnedClock(PINNED_NOW, () => {
    const log = [
      ev('queue_entered', { node_id: 'n0', attempt_id: 'a0', ticket: 0 }),
      ev('queue_acquired', {
        ts: PINNED_NOW, node_id: 'n0', attempt_id: 'a0', ticket: 0, worker_id: 'w0',
        expires_at_ms: PINNED_NOW + 1000,
      }),
    ];
    const q = queue.projectQueue(log);
    // Before the deadline the SAME holder does block. Without this arm the case
    // cannot tell "expiry is honoured" from "nothing ever blocks".
    assert.equal(queue.mayAcquireToken(q, 0, PINNED_NOW + 999, { alive: true }).allowed, false);
    assert.equal(queue.mayAcquireToken(q, 0, PINNED_NOW + 1000, { alive: true }).allowed, true);
  });
});

test('a holder whose liveness verdict says DEAD does not block, even well inside its deadline', () => {
  withPinnedClock(PINNED_NOW, () => {
    const log = [
      ev('queue_entered', { node_id: 'n0', attempt_id: 'a0', ticket: 0 }),
      ev('queue_acquired', {
        ts: PINNED_NOW, node_id: 'n0', attempt_id: 'a0', ticket: 0, worker_id: 'w0',
        expires_at_ms: PINNED_NOW + 1000000,
      }),
    ];
    const q = queue.projectQueue(log);
    assert.equal(queue.mayAcquireToken(q, 0, PINNED_NOW + 5, { alive: false }).allowed, true);
    assert.equal(
      queue.mayAcquireToken(q, 0, PINNED_NOW + 5, { alive: true }).allowed, false,
      'the same holder with a live verdict DOES block, which is what makes the row above mean something',
    );
  });
});

test('a stuck land holder and a stuck node lease are judged by the identical predicate', () => {
  withPinnedClock(PINNED_NOW, () => {
    const holder = queue.projectQueue([
      ev('queue_entered', { node_id: 'n0', attempt_id: 'a0', ticket: 0 }),
      ev('queue_acquired', {
        ts: PINNED_NOW, node_id: 'n0', attempt_id: 'a0', ticket: 0, worker_id: 'w0',
        expires_at_ms: PINNED_NOW + 1000,
      }),
    ]).held_by;
    const lease = board.projectBoard([
      ev('claim_acquired', {
        node_id: 'n0', worker_id: 'w0', lease_epoch: 1, expires_at_ms: PINNED_NOW + 1000,
      }),
    ]).leases.n0;

    for (const now of [PINNED_NOW, PINNED_NOW + 999, PINNED_NOW + 1000, PINNED_NOW + 1e6]) {
      for (const alive of [true, false]) {
        assert.equal(
          board.isReclaimable(holder, now, { alive }),
          board.isReclaimable(lease, now, { alive }),
          `the 2 records must agree at now=${now} alive=${alive}`,
        );
      }
    }
  });
});

test('a refused verdict always names a code and an allowed verdict never does', () => {
  withPinnedClock(PINNED_NOW, () => {
    const q = queue.projectQueue(entrants(2));
    const allowed = queue.mayAcquireToken(q, 0, PINNED_NOW, { alive: true });
    const refused = queue.mayAcquireToken(q, 1, PINNED_NOW, { alive: true });
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.code, null);
    assert.equal(refused.allowed, false);
    assert.ok(
      Object.values(queue.LANDQUEUE_ERROR_CODES).includes(refused.code),
      'a refusal must carry 1 of the declared codes, so a caller never branches on prose',
    );
  });
});

test('an empty queue allows nobody, because there is nobody whose turn it is', () => {
  const q = queue.projectQueue([]);
  const verdict = queue.mayAcquireToken(q, 0, PINNED_NOW, { alive: true });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, queue.LANDQUEUE_ERROR_CODES.E_FLEET_NOT_QUEUE_HEAD);
  assert.equal(verdict.head, null);
});

test('the token is repo scoped and singular: 2 entrants on 2 different nodes contend for 1 token', () => {
  withPinnedClock(PINNED_NOW, () => {
    // The vendored engine keys its land claim on the WORKTREE PATH
    // (ratchet:824-830), so 2 lands on 2 worktrees of the same repository exclude
    // nobody. Here the 2 entrants are different nodes with different attempts, and
    // exactly 1 of them may hold the token.
    const log = [
      ev('queue_entered', { node_id: 'nAlpha', attempt_id: 'aA', ticket: 0 }),
      ev('queue_entered', { ts: PINNED_NOW + 1, node_id: 'nBeta', attempt_id: 'aB', ticket: 1 }),
      ev('queue_acquired', {
        ts: PINNED_NOW + 2, node_id: 'nAlpha', attempt_id: 'aA', ticket: 0, worker_id: 'wA',
        expires_at_ms: PINNED_NOW + 60000,
      }),
    ];
    const q = queue.projectQueue(log);
    const alpha = queue.mayAcquireToken(q, 0, PINNED_NOW + 3, { alive: true });
    const beta = queue.mayAcquireToken(q, 1, PINNED_NOW + 3, { alive: true });
    assert.equal(alpha.allowed, false, 'the current holder does not re-acquire');
    assert.equal(beta.allowed, false, 'a different worktree is NOT a different token');
    assert.equal(
      [alpha, beta].filter((v) => v.allowed).length, 0,
      '1 writer to the trunk, ever',
    );
  });
});

test('the module refuses to LOAD against a vocabulary that lost the entry kind', () => {
  // The ticket IS the count of that kind, so a silent rename would hand every
  // entrant ticket 0 and make every entrant the head. That is SC4 defeated by a
  // typo, and it would look like an empty queue rather than a broken one.
  //
  // This case DRIVES the assertion rather than reading for its name. A textual
  // guard here is worthless and was observed to be worthless: deleting the call
  // and leaving `_assertVocabulary` in a comment kept a name-matching assertion
  // green, which is the identical trap 19-01 recorded when a protocol guard fired
  // on a header comment. So the vocabulary is really taken away, the module is
  // really re-required, and the throw is really observed.
  const runlogPath = require.resolve('../ferrox-core/bin/lib/fleet-runlog.cjs');
  const landqueuePath = require.resolve('../ferrox-core/bin/lib/fleet-landqueue.cjs');
  const runlogMod = require(runlogPath);
  const originalKinds = runlogMod.FLEET_EVENT_KINDS;

  try {
    runlogMod.FLEET_EVENT_KINDS = Object.freeze(
      originalKinds.filter((k) => k !== 'queue_entered'),
    );
    assert.ok(
      !runlogMod.FLEET_EVENT_KINDS.includes('queue_entered'),
      'the kind must really be absent, or this case cannot fire',
    );
    delete require.cache[landqueuePath];
    assert.throws(
      () => require(landqueuePath),
      /not in the run log vocabulary/,
      'loading against a vocabulary with no entry kind must throw, not return a queue that is always empty',
    );
  } finally {
    runlogMod.FLEET_EVENT_KINDS = originalKinds;
    delete require.cache[landqueuePath];
    require(landqueuePath);
  }

  // And the restored module works, so the case left nothing broken behind it.
  assert.equal(require(landqueuePath).nextTicket([
    { ts: 1, kind: 'queue_entered', run_id: 'r1', node_id: 'n0', attempt_id: 'a0', ticket: 0 },
  ]), 1);
  assert.ok(fs.existsSync(BUILT_LIB));
});

// ─── the write verbs (plan 04 task 1) ────────────────────────────────────────

test('entering the queue appends queue_entered carrying the ticket derived from prior entries', () => {
  const dir = scratch('enter');
  const first = baseOpts(dir);
  assert.equal(queue.enterLandQueue(first).ticket, 0, 'the first entrant takes ticket 0');
  const second = baseOpts(dir, { nodeId: 'n1', attemptId: 'a1', nowMs: PINNED_NOW + 1 });
  assert.equal(queue.enterLandQueue(second).ticket, 1, 'the ticket is counted from the log');

  const log = readLog(first);
  assert.deepEqual(log.map((e) => e.kind), ['queue_entered', 'queue_entered']);
  assert.deepEqual(log.map((e) => e.ticket), [0, 1]);
  assert.deepEqual(log.map((e) => e.ts), [PINNED_NOW, PINNED_NOW + 1]);
});

test('acquiring with the head ticket and no holder succeeds and appends queue_acquired', () => {
  const dir = scratch('acquire-head');
  const opts = baseOpts(dir);
  const { ticket } = queue.enterLandQueue(opts);
  const verdict = queue.acquireLandToken(Object.assign({}, opts, { ticket }));
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.code, null);
  assert.deepEqual(kindsOf(opts), ['queue_entered', 'queue_acquired']);

  const acquired = readLog(opts)[1];
  assert.equal(acquired.ticket, 0);
  assert.equal(acquired.worker_id, 'w0');
  assert.equal(
    acquired.expires_at_ms, PINNED_NOW + 60000,
    'the holder must carry a deadline, or an expired lander could never be judged expired and would wedge the trunk',
  );
});

test('the supplied holder identity is carried onto queue_acquired, and omitted when absent', () => {
  // Found by a surviving mutation: dropping the holder field entirely left the
  // suite green. It is not cosmetic. Once the landing process is gone the run
  // record is the ONLY place a later liveness probe can recover the pid it needs
  // to judge that holder dead, and the dead holder arm is what stops a crashed
  // lander wedging the trunk.
  const dir = scratch('holder-identity');
  const withHolder = baseOpts(dir, { holder: { pid: 4321, pid_start: '99887766' } });
  const entered = queue.enterLandQueue(withHolder);
  queue.acquireLandToken(Object.assign({}, withHolder, { ticket: entered.ticket }));

  const acquired = readLog(withHolder).find((e) => e.kind === 'queue_acquired');
  assert.deepEqual(acquired.holder, { pid: 4321, pid_start: '99887766' });

  // And a caller that supplies none writes none, rather than a null that a probe
  // would have to tell apart from a real absent pid.
  const bare = baseOpts(dir, { nodeId: 'n1', attemptId: 'a1', nowMs: PINNED_NOW + 30 });
  queue.releaseLandToken(Object.assign({}, withHolder, { nowMs: PINNED_NOW + 20 }));
  const bareTicket = queue.enterLandQueue(bare);
  queue.acquireLandToken(Object.assign({}, bare, { ticket: bareTicket.ticket }));
  const second = readLog(bare).filter((e) => e.kind === 'queue_acquired')[1];
  assert.equal(Object.prototype.hasOwnProperty.call(second, 'holder'), false);
});

test('acquiring with a NON HEAD ticket and NO HOLDER is refused and appends NOTHING', () => {
  const dir = scratch('acquire-nonhead');
  const a = baseOpts(dir);
  const b = baseOpts(dir, { nodeId: 'n1', attemptId: 'a1', nowMs: PINNED_NOW + 1 });
  queue.enterLandQueue(a);
  const { ticket } = queue.enterLandQueue(b);
  assert.equal(ticket, 1);

  const before = readLog(a).length;
  const verdict = queue.acquireLandToken(Object.assign({}, b, { ticket }));
  assert.equal(verdict.allowed, false, 'a late entrant must not jump the ticket ahead of it');
  assert.equal(verdict.code, queue.LANDQUEUE_ERROR_CODES.E_FLEET_NOT_QUEUE_HEAD);
  assert.equal(
    readLog(a).length, before,
    'a refusal that still appended queue_acquired would leave the projection believing the trunk is held',
  );
  assert.equal(queue.projectQueue(readLog(a)).held_by, null);
});

test('acquiring while a LIVE holder is landing is refused and appends NOTHING', () => {
  const dir = scratch('acquire-held');
  const a = baseOpts(dir);
  const b = baseOpts(dir, { nodeId: 'n1', attemptId: 'a1', nowMs: PINNED_NOW + 1 });
  const first = queue.enterLandQueue(a);
  const second = queue.enterLandQueue(b);
  assert.equal(queue.acquireLandToken(Object.assign({}, a, { ticket: first.ticket })).allowed, true);

  const before = readLog(a).length;
  // Ticket 1 is now the head only once ticket 0 completes; drive the HOLDER arm by
  // asking with ticket 0 again, which IS the head and is blocked purely by the holder.
  const verdict = queue.acquireLandToken(Object.assign({}, a, {
    ticket: first.ticket, nowMs: PINNED_NOW + 10,
  }));
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, queue.LANDQUEUE_ERROR_CODES.E_FLEET_TOKEN_HELD);
  assert.equal(readLog(a).length, before, 'a refused acquisition writes nothing');
  assert.equal(second.ticket, 1);
});

test('releasing appends land_completed and lets the NEXT ticket acquire', () => {
  const dir = scratch('release');
  const a = baseOpts(dir);
  const b = baseOpts(dir, { nodeId: 'n1', attemptId: 'a1', workerId: 'w1', nowMs: PINNED_NOW + 1 });
  const first = queue.enterLandQueue(a);
  const second = queue.enterLandQueue(b);
  queue.acquireLandToken(Object.assign({}, a, { ticket: first.ticket }));

  // Before the release the next ticket is NOT the head, so this arm proves the
  // release is what advances it rather than time passing.
  assert.equal(
    queue.acquireLandToken(Object.assign({}, b, { ticket: second.ticket })).allowed, false,
    'ticket 1 must be blocked while ticket 0 holds, or the release below proves nothing',
  );

  queue.releaseLandToken(Object.assign({}, a, { nowMs: PINNED_NOW + 20, result: 'landed' }));
  assert.deepEqual(kindsOf(a), ['queue_entered', 'queue_entered', 'queue_acquired', 'land_completed']);

  const after = queue.acquireLandToken(Object.assign({}, b, {
    ticket: second.ticket, nowMs: PINNED_NOW + 21,
  }));
  assert.equal(after.allowed, true, 'the next ticket acquires once the holder completes');
});

// ─── the repo scoped token, which is GATE 4 in 1 assertion ───────────────────

test('the token path is derived from the repoKey and NOT from the worktree', () => {
  const dir = scratch('tokenpath');
  const wtA = path.join(dir, 'worktrees', 'agent-alpha');
  const wtB = path.join(dir, 'worktrees', 'agent-beta');
  const tokenDir = path.join(dir, '.planning');

  const forA = queue.landTokenPath({ tokenDir, repoKey: 'ferroxfactory/core', worktree: wtA });
  const forB = queue.landTokenPath({ tokenDir, repoKey: 'ferroxfactory/core', worktree: wtB });
  assert.equal(
    forA, forB,
    'the vendored claim at ratchet:824-830 keys on the worktree path, which is exactly why 2 worktrees must resolve to 1 token here',
  );

  const otherRepo = queue.landTokenPath({ tokenDir, repoKey: 'ferroxfactory/other', worktree: wtA });
  assert.notEqual(forA, otherRepo, '2 different trunks are 2 different tokens');

  // 2 keys whose readable slug COLLIDES after sanitisation must still resolve to
  // 2 files. The slug is a convenience for an operator; distinctness rests
  // entirely on the digest of the whole key. Without the digest these 2 would
  // share a token and the serializer would exclude the wrong pair while reporting
  // success, which is the printable-separator collision reached from a third
  // direction (see `src/fleet-board.cts:86`).
  const slugA = queue.landTokenPath({ tokenDir, repoKey: 'acme/core' });
  const slugB = queue.landTokenPath({ tokenDir, repoKey: 'acme-core' });
  assert.notEqual(
    slugA, slugB,
    'acme/core and acme-core sanitise to the same slug, so only the digest keeps them apart',
  );
});

test('2 entrants on 2 DIFFERENT worktrees of 1 repository contend for the SAME token', () => {
  const dir = scratch('two-worktrees');
  const wtAlpha = path.join(dir, 'worktrees', 'agent-alpha');
  const wtBeta = path.join(dir, 'worktrees', 'agent-beta');

  const alpha = baseOpts(dir, { nodeId: 'nAlpha', attemptId: 'aA', workerId: 'wA', worktree: wtAlpha });
  const beta = baseOpts(dir, {
    nodeId: 'nBeta', attemptId: 'aB', workerId: 'wB', worktree: wtBeta, nowMs: PINNED_NOW + 1,
  });
  assert.notEqual(wtAlpha, wtBeta, 'the 2 worktree paths must really differ, or this case cannot fire');
  assert.equal(alpha.repoKey, beta.repoKey, 'and the repoKey must really be shared');

  const first = queue.enterLandQueue(alpha);
  const second = queue.enterLandQueue(beta);
  assert.equal(queue.acquireLandToken(Object.assign({}, alpha, { ticket: first.ticket })).allowed, true);

  const contended = queue.acquireLandToken(Object.assign({}, beta, {
    ticket: second.ticket, nowMs: PINNED_NOW + 5,
  }));
  assert.equal(
    contended.allowed, false,
    'a DIFFERENT worktree is not a different token: this is the row a worktree scoped token fails, and it is GATE 4',
  );
  assert.equal(queue.projectQueue(readLog(alpha)).held_by.node_id, 'nAlpha', '1 writer to the trunk, ever');
});

test('a non-string repoKey is refused with a code, because String(value) maps every object to one key', () => {
  const dir = scratch('badkey');
  for (const bad of [null, undefined, '', 42, { repo: 'core' }, ['core']]) {
    assert.throws(
      () => queue.landTokenPath({ tokenDir: dir, repoKey: bad }),
      (err) => err.code === queue.LANDQUEUE_ERROR_CODES.E_FLEET_BAD_REPO_KEY,
      `repoKey ${JSON.stringify(bad)} must be refused with a code, never coerced`,
    );
  }
  assert.equal(typeof queue.landTokenPath({ tokenDir: dir, repoKey: 'ok/key' }), 'string');
});

test('the token snapshot is written and AGREES with the fold, without ever being decided from', () => {
  // Two mutations survived here and this case answers one of them. Deleting the
  // snapshot write entirely left the suite green, because the snapshot is a
  // DERIVED CACHE and every decision in the module folds the log instead. That
  // design is deliberate and it is what makes a crash between the append and the
  // snapshot recoverable. But an artifact an operator reads still has to be
  // written, and still has to agree with the truth it is derived from.
  const dir = scratch('snapshot');
  const a = baseOpts(dir);
  const b = baseOpts(dir, { nodeId: 'n1', attemptId: 'a1', workerId: 'w1', nowMs: PINNED_NOW + 1 });
  const first = queue.enterLandQueue(a);
  queue.enterLandQueue(b);
  queue.acquireLandToken(Object.assign({}, a, { ticket: first.ticket }));

  const tokenPath = queue.landTokenPath(a);
  assert.ok(fs.existsSync(tokenPath), `${tokenPath} must be written`);
  const snapshot = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  const folded = queue.projectQueue(readLog(a));

  assert.equal(snapshot.repo_key, 'ferroxfactory/core');
  assert.equal(snapshot.head, queue.queueHead(folded), 'the snapshot head must equal the folded head');
  assert.equal(snapshot.held_by.node_id, folded.held_by.node_id);
  assert.equal(snapshot.held_by.ticket, folded.held_by.ticket);
  assert.deepEqual(snapshot.open_tickets, [0, 1]);

  // A CORRUPTED snapshot changes no decision, because the log is the truth. This
  // runs while ticket 0 still holds, so the snapshot's lie is the only thing that
  // could grant entry.
  fs.writeFileSync(tokenPath, JSON.stringify({ head: 999, held_by: null, open_tickets: [] }));
  assert.equal(
    queue.acquireLandToken(Object.assign({}, b, { ticket: 1, nowMs: PINNED_NOW + 5 })).allowed,
    false,
    'a snapshot claiming the trunk is free must not let a second lander in',
  );

  // And the snapshot must TRACK the head rather than report a fixed one. Checking
  // only the state above would pass a snapshot hardcoded to head 0, because 0 IS
  // the head at that instant. So the head is advanced and the snapshot re-read,
  // which also proves the release rewrites the file the corruption above clobbered.
  queue.releaseLandToken(Object.assign({}, a, { nowMs: PINNED_NOW + 20, result: 'landed' }));
  const advanced = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  assert.equal(advanced.head, 1, 'the snapshot head must advance with the fold, not sit at 0');
  assert.equal(advanced.held_by, null, 'and the trunk must read as free once the holder completed');
  assert.deepEqual(advanced.open_tickets, [1]);
});

// ─── the wedge arms: a crashed lander must not hold the trunk for the run ────

test('a holder whose lease EXPIRED does not block a new acquisition', () => {
  const dir = scratch('expired');
  const a = baseOpts(dir, { ttlMs: 1000 });
  const b = baseOpts(dir, { nodeId: 'n1', attemptId: 'a1', workerId: 'w1', nowMs: PINNED_NOW + 1 });
  const first = queue.enterLandQueue(a);
  queue.enterLandQueue(b);
  queue.acquireLandToken(Object.assign({}, a, { ticket: first.ticket }));

  // The SAME holder inside its deadline DOES block. Without this arm the row
  // below cannot tell "expiry is honoured" from "nothing ever blocks".
  assert.equal(
    queue.acquireLandToken(Object.assign({}, a, { ticket: 0, nowMs: PINNED_NOW + 999 })).allowed,
    false,
  );
  assert.equal(
    queue.acquireLandToken(Object.assign({}, a, { ticket: 0, nowMs: PINNED_NOW + 1000 })).allowed,
    true,
    'a lander that died holding the token must not wedge the trunk for the whole run',
  );
});

test('a holder whose LIVENESS VERDICT says dead does not block, even well inside its deadline', () => {
  const dir = scratch('dead');
  const a = baseOpts(dir, { ttlMs: 1000000 });
  const first = queue.enterLandQueue(a);
  queue.acquireLandToken(Object.assign({}, a, { ticket: first.ticket }));

  assert.equal(
    queue.acquireLandToken(Object.assign({}, a, {
      ticket: 0, nowMs: PINNED_NOW + 5, liveness: { alive: false },
    })).allowed,
    true,
  );
  assert.equal(
    queue.acquireLandToken(Object.assign({}, a, {
      ticket: 0, nowMs: PINNED_NOW + 5, liveness: { alive: true },
    })).allowed,
    false,
    'the same holder with a live verdict DOES block, which is what makes the row above mean something',
  );
});

test('a DIFFERENT ticket takes over from a dead holder, and the displacement is WRITTEN', () => {
  // This is the row the expiry arm alone does NOT cover, and it was found by
  // building it rather than by reasoning about it. A crashed holder leaves its
  // ticket OPEN forever, so `queueHead` keeps returning that ticket and every
  // later entrant is refused with E_FLEET_NOT_QUEUE_HEAD. The trunk is then wedged
  // by the very ticket the expiry arm just judged dead, and the 2 single-holder
  // rows above stay green throughout.
  const dir = scratch('reclaim-crossticket');
  const dead = baseOpts(dir, { ttlMs: 1000 });
  const next = baseOpts(dir, { nodeId: 'n1', attemptId: 'a1', workerId: 'w1', nowMs: PINNED_NOW + 1 });
  const deadTicket = queue.enterLandQueue(dead);
  const nextTicketOut = queue.enterLandQueue(next);
  queue.acquireLandToken(Object.assign({}, dead, { ticket: deadTicket.ticket }));
  assert.notEqual(nextTicketOut.ticket, deadTicket.ticket, 'the 2 tickets must really differ, or this case cannot fire');

  // Inside the dead holder's deadline the successor is correctly blocked.
  assert.equal(
    queue.acquireLandToken(Object.assign({}, next, { ticket: nextTicketOut.ticket, nowMs: PINNED_NOW + 999 })).allowed,
    false,
  );

  const verdict = queue.acquireLandToken(Object.assign({}, next, {
    ticket: nextTicketOut.ticket, nowMs: PINNED_NOW + 5000,
  }));
  assert.equal(verdict.allowed, true, 'a crashed lander must not wedge the trunk for the whole run');
  assert.equal(verdict.reclaimed, true, 'the displacement is reported to the caller');

  // And the run record SAYS a lander was displaced, rather than the head silently
  // skipping a ticket in a way no reader of the log could reproduce.
  const log = readLog(dead);
  const completions = log.filter((e) => e.kind === 'land_completed');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].node_id, 'n0');
  assert.equal(completions[0].result, 'reclaimed');
  assert.deepEqual(kindsOf(dead), [
    'queue_entered', 'queue_entered', 'queue_acquired', 'land_completed', 'queue_acquired',
  ]);
});

test('a DIFFERENT ticket takes over from a holder judged dead by LIVENESS, not only by expiry', () => {
  // Found by a surviving mutation rather than by reasoning. Replacing the
  // `opts.liveness` the reclaim arm passes to `isReclaimable` with `null` left the
  // whole suite green, because the cross-ticket reclaim row above drives EXPIRY
  // and the liveness rows above are all same-ticket, so they reach the holder arm
  // of `mayAcquireToken` instead of the reclaim arm. The uncovered case is a
  // crashed lander with a long TTL: known dead, but wedging its successor until
  // the deadline anyway. The behaviour was already right; the guard was missing.
  const dir = scratch('reclaim-liveness');
  const dead = baseOpts(dir, { ttlMs: 100000000 });
  const next = baseOpts(dir, { nodeId: 'n1', attemptId: 'a1', workerId: 'w1', nowMs: PINNED_NOW + 1 });
  const deadTicket = queue.enterLandQueue(dead);
  const nextOut = queue.enterLandQueue(next);
  queue.acquireLandToken(Object.assign({}, dead, { ticket: deadTicket.ticket }));

  // With a LIVE verdict the successor is blocked, well inside the deadline. This
  // arm is what stops the row below meaning "nothing ever blocks".
  assert.equal(
    queue.acquireLandToken(Object.assign({}, next, {
      ticket: nextOut.ticket, nowMs: PINNED_NOW + 5, liveness: { alive: true },
    })).allowed,
    false,
  );

  const verdict = queue.acquireLandToken(Object.assign({}, next, {
    ticket: nextOut.ticket, nowMs: PINNED_NOW + 5, liveness: { alive: false },
  }));
  assert.equal(
    verdict.allowed, true,
    'a holder known dead must be displaced now, not at the end of a TTL it will never reach',
  );
  assert.equal(verdict.reclaimed, true);
  assert.equal(readLog(dead).filter((e) => e.kind === 'land_completed')[0].result, 'reclaimed');
});

// ─── withLandToken: a block is a WAIT, and the release is in a finally ───────

/** A clock that advances a fixed step per read, so the wait path is driven without real time. */
function steppingClock(start, step) {
  let n = 0;
  const fn = () => start + (step * n++);
  fn.reads = () => n;
  return fn;
}

test('withLandToken WAITS through a live holder rather than erroring, then runs its body', () => {
  const dir = scratch('wait');
  const holderOpts = baseOpts(dir, { ttlMs: 500 });
  const first = queue.enterLandQueue(holderOpts);
  queue.acquireLandToken(Object.assign({}, holderOpts, { ticket: first.ticket }));

  const clock = steppingClock(PINNED_NOW, 100);
  let ran = 0;
  const waiter = baseOpts(dir, {
    nodeId: 'n1', attemptId: 'a1', workerId: 'w1',
    nowMs: undefined, clock, pollIntervalMs: 0, waitTimeoutMs: 100000,
  });
  const out = queue.withLandToken(waiter, () => { ran++; return { result: 'landed' }; });

  assert.equal(ran, 1, 'the body runs exactly once, once the wedged holder aged out');
  assert.deepEqual(out, { result: 'landed' });
  assert.ok(
    clock.reads() > 2,
    `the acquisition must really have polled rather than succeeding first try (reads=${clock.reads()})`,
  );
  assert.deepEqual(kindsOf(holderOpts).slice(-2), ['queue_acquired', 'land_completed']);
});

test('withLandToken gives up on its deadline with a coded refusal and never runs its body', () => {
  const dir = scratch('timeout');
  const holderOpts = baseOpts(dir, { ttlMs: 100000000 });
  const first = queue.enterLandQueue(holderOpts);
  queue.acquireLandToken(Object.assign({}, holderOpts, { ticket: first.ticket }));

  let ran = 0;
  const waiter = baseOpts(dir, {
    nodeId: 'n1', attemptId: 'a1', workerId: 'w1',
    nowMs: undefined, clock: steppingClock(PINNED_NOW, 100), pollIntervalMs: 0, waitTimeoutMs: 500,
  });
  assert.throws(
    () => queue.withLandToken(waiter, () => { ran++; }),
    (err) => err.code === queue.LANDQUEUE_ERROR_CODES.E_FLEET_TOKEN_WAIT_TIMEOUT,
    'a wait that never ends is the unbounded loop this milestone exists to prevent',
  );
  assert.equal(ran, 0, 'the body must not run when the token was never taken');
});

test('the wait is bounded by ATTEMPTS too, so a FROZEN clock cannot spin the queue forever', () => {
  // Found by a mutation that HUNG rather than failed, which is the worst outcome a
  // guard can have because a hang has no verdict. Making `releaseLandToken`
  // complete a fixed identity meant no real ticket ever closed, and the waiter
  // then spun without end: time here is caller supplied by design, and this suite
  // supplies a CONSTANT nowMs, so `now - startedAt` is identically 0 and a deadline
  // expressed only in milliseconds can never be reached. The clock bound alone is
  // not a bound. This case drives exactly that configuration.
  const dir = scratch('frozen-clock');
  const holder = baseOpts(dir, { ttlMs: 100000000 });
  const first = queue.enterLandQueue(holder);
  queue.acquireLandToken(Object.assign({}, holder, { ticket: first.ticket }));

  let ran = 0;
  const waiter = baseOpts(dir, {
    nodeId: 'n1', attemptId: 'a1', workerId: 'w1',
    // A CONSTANT instant, and a deadline that can therefore never be reached.
    nowMs: PINNED_NOW, pollIntervalMs: 0, waitTimeoutMs: 100000, maxPolls: 25,
  });
  assert.throws(
    () => queue.withLandToken(waiter, () => { ran++; }),
    (err) => err.code === queue.LANDQUEUE_ERROR_CODES.E_FLEET_TOKEN_WAIT_TIMEOUT
      && /25 attempts/.test(err.message),
    'the attempt ceiling must refuse where the frozen clock never can',
  );
  assert.equal(ran, 0, 'and the body must not run, because the token was never taken');
});

test('withLandToken releases the token when its body THROWS, so a crash cannot lock the trunk', () => {
  const dir = scratch('throwing-body');
  const a = baseOpts(dir, { pollIntervalMs: 0, waitTimeoutMs: 100000 });
  assert.throws(
    () => queue.withLandToken(a, () => { throw new Error('land blew up'); }),
    /land blew up/,
  );
  assert.equal(
    queue.projectQueue(readLog(a)).held_by, null,
    'a throw inside the body must not leave the trunk held',
  );

  const b = baseOpts(dir, {
    nodeId: 'n1', attemptId: 'a1', workerId: 'w1', nowMs: PINNED_NOW + 30,
    pollIntervalMs: 0, waitTimeoutMs: 100000,
  });
  let ran = 0;
  queue.withLandToken(b, () => { ran++; });
  assert.equal(ran, 1, 'a second entrant acquires afterward, which is the row a missing finally fails');
});

// ─── runLand: the 5 events the run record needs (plan 04 task 2) ─────────────

/** A stub land command. Never spawns anything: the real gate was measured at 40 seconds. */
function stubLand(over) {
  return () => Object.assign({ code: 0, verdict: 'green', result: 'landed' }, over);
}

test('a completed land emits the 5 events in order', () => {
  const dir = scratch('runland-order');
  const opts = baseOpts(dir, {
    pollIntervalMs: 0, waitTimeoutMs: 100000, landCommand: stubLand(),
  });
  const out = queue.runLand(opts);
  assert.deepEqual(out, { code: 0, verdict: 'green', result: 'landed' });
  assert.deepEqual(kindsOf(opts), [
    'queue_entered', 'queue_acquired', 'gate_started', 'gate_ended', 'land_completed',
  ]);
});

test('gate_ended carries the reported verdict and land_completed carries the result', () => {
  const dir = scratch('runland-fields');
  const opts = baseOpts(dir, {
    pollIntervalMs: 0, waitTimeoutMs: 100000,
    landCommand: stubLand({ verdict: 'amber', result: 'landed-with-retry' }),
  });
  queue.runLand(opts);
  const log = readLog(opts);
  assert.equal(log.find((e) => e.kind === 'gate_ended').verdict, 'amber');
  assert.equal(log.find((e) => e.kind === 'land_completed').result, 'landed-with-retry');
});

test('a land command that exits NON ZERO still closes its interval', () => {
  const dir = scratch('runland-nonzero');
  const opts = baseOpts(dir, {
    pollIntervalMs: 0, waitTimeoutMs: 100000,
    landCommand: stubLand({ code: 2, verdict: 'red', result: 'aborted:rebase' }),
  });
  const out = queue.runLand(opts);
  assert.equal(out.code, 2);
  assert.deepEqual(kindsOf(opts), [
    'queue_entered', 'queue_acquired', 'gate_started', 'gate_ended', 'land_completed',
  ]);
  assert.equal(
    readLog(opts).find((e) => e.kind === 'gate_ended').verdict, 'red',
    'an open interval would silently degrade the phase 22 figure for gate cost under load',
  );
});

test('a land command that THROWS still closes its interval AND releases the token', () => {
  const dir = scratch('runland-throw');
  const opts = baseOpts(dir, {
    pollIntervalMs: 0, waitTimeoutMs: 100000,
    landCommand: () => { throw new Error('spawn failed'); },
  });
  assert.throws(() => queue.runLand(opts), /spawn failed/);
  assert.deepEqual(kindsOf(opts), [
    'queue_entered', 'queue_acquired', 'gate_started', 'gate_ended', 'land_completed',
  ]);
  assert.equal(
    readLog(opts).find((e) => e.kind === 'gate_ended').verdict, 'unknown',
    'D3 requires an unterminated interval to fold to an explicit unknown rather than to nothing',
  );

  const next = baseOpts(dir, {
    nodeId: 'n1', attemptId: 'a1', workerId: 'w1', nowMs: PINNED_NOW + 50,
    pollIntervalMs: 0, waitTimeoutMs: 100000, landCommand: stubLand(),
  });
  assert.equal(queue.runLand(next).code, 0, 'a second entrant lands afterward');
});

test('the default seam targets the vendored engine land entrypoint with the worktree as its argument', () => {
  const spec = queue.landCommandSpec({
    worktree: '/tmp/wt-alpha', repoRoot: REPO_ROOT,
  });
  assert.equal(
    spec.command, path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', 'ratchet'),
    'the seam names the vendored entrypoint by path rather than by a shell string',
  );
  assert.deepEqual(
    spec.args, ['land', '/tmp/wt-alpha', '--no-fuse'],
    'the verb and the worktree keep the positions they held before the review flag was added',
  );
  assert.ok(fs.existsSync(spec.command), 'the entrypoint the spec names must really be on disk');
});

/**
 * THE REVIEW FLAG, AND WHY THE ABSENCE ASSERTION IS THE HALF THAT MATTERS.
 *
 * The engine requires exactly 1 of its 2 review flags at step 3 of 4 and aborts
 * with exit 2 when neither is present (`ratchet:1069-1073`). This seam used to
 * pass neither, so every automatic land would have aborted there the moment
 * FF-B217's suite problem was resolved. That was never observed because the run
 * in front of it stopped 1 step earlier.
 *
 * The 2 flags are NOT interchangeable. One records a skip on the record, the
 * other records that a review was PERFORMED, journals the station as `review`
 * and hashes the diff it was performed against. The fleet has no adversarial
 * reviewer in its loop, so passing the second would put a review nobody did onto
 * the permanent record: a false green, which is the defect class this phase
 * exists to eliminate.
 *
 * So the positive half is not enough. An edit that passed BOTH flags, or that
 * swapped them for a quieter log line, satisfies "carries the skip flag" and
 * still lands the lie. The absence assertion is what refuses it, and it reads
 * the exported constant rather than a literal so a rename cannot slip past by
 * making the assertion name a flag the seam no longer uses.
 */
test('the land carries the review flag that records a SKIP, and never the one that CLAIMS a review', () => {
  const spec = queue.landCommandSpec({ worktree: '/tmp/wt-beta', repoRoot: REPO_ROOT });

  assert.equal(queue.RATCHET_REVIEW_SKIP_FLAG, '--no-fuse');
  assert.equal(queue.RATCHET_REVIEW_CLAIM_FLAG, '--fuse-done');
  assert.notEqual(
    queue.RATCHET_REVIEW_SKIP_FLAG, queue.RATCHET_REVIEW_CLAIM_FLAG,
    'if the 2 constants ever collapse to 1 value, both assertions below become vacuous',
  );

  assert.ok(
    spec.args.includes(queue.RATCHET_REVIEW_SKIP_FLAG),
    'without a review flag the engine aborts at step 3 of 4, so the seam must carry exactly 1',
  );
  assert.equal(
    spec.args.includes(queue.RATCHET_REVIEW_CLAIM_FLAG), false,
    'the fleet has no reviewer, so claiming a review would record a false green on every land',
  );
  assert.equal(
    spec.args.filter(
      (a) => a === queue.RATCHET_REVIEW_SKIP_FLAG || a === queue.RATCHET_REVIEW_CLAIM_FLAG,
    ).length,
    1,
    'the engine requires EXACTLY 1 of the 2, so passing both is as wrong as passing neither',
  );
});

/**
 * THE LAND CHILD'S ENVIRONMENT, AND THE ARM THAT HAD TO BE ABLE TO FAIL.
 *
 * The worker seam pins `PYTHONDONTWRITEBYTECODE` on its child because the
 * vendored tree is byte pinned and 5 guards assert it carries no bytecode. The
 * land seam inherited the ambient environment instead, so the half of the chain
 * that runs LAST was the half that could still mutate the engine it runs.
 *
 * The trivial pass here is asserting the value while the ambient environment
 * already carries it: that arm is green against a seam that does nothing at all.
 * So the ambient value is set to the OPPOSITE first, and the assertion is that
 * the built environment overrides it. A merge, or an inherit, fails that row.
 *
 * The home is asserted both ways for the same reason: supplied, it must reach
 * the child, because the engine otherwise reads the operator's personal control
 * plane and a land REBASES and PUSHES against whatever that manifest declares.
 * Absent, nothing may be invented, because a fabricated home would be a path the
 * caller never chose.
 */
test('the land child gets bytecode writing pinned OFF even when the ambient value says otherwise', () => {
  const before = process.env.PYTHONDONTWRITEBYTECODE;
  try {
    process.env.PYTHONDONTWRITEBYTECODE = '0';
    const env = queue.landSpawnEnv({});
    assert.equal(
      env.PYTHONDONTWRITEBYTECODE, '1',
      'an inherited 0 must be overridden, or running the fleet writes bytecode into the byte '
        + 'pinned vendored tree and turns 8 suite tests red',
    );
  } finally {
    if (before === undefined) delete process.env.PYTHONDONTWRITEBYTECODE;
    else process.env.PYTHONDONTWRITEBYTECODE = before;
  }
});

test('the land child gets the engine home the caller supplied, and none invented when it did not', () => {
  const scoped = queue.landSpawnEnv({ ratchetHome: '/tmp/scoped-home' });
  assert.equal(scoped.RATCHET_HOME, '/tmp/scoped-home');

  const before = process.env.RATCHET_HOME;
  try {
    delete process.env.RATCHET_HOME;
    assert.equal(
      Object.prototype.hasOwnProperty.call(queue.landSpawnEnv({}), 'RATCHET_HOME'), false,
      'with nothing supplied the seam must invent nothing, so the engine falls back on its own '
        + 'documented resolution rather than on a path this module made up',
    );
    assert.equal(queue.landSpawnEnv({ ratchetHome: '' }).RATCHET_HOME, undefined);
  } finally {
    if (before !== undefined) process.env.RATCHET_HOME = before;
  }
});

test('runLand forwards the engine home to the land seam rather than dropping it', () => {
  const dir = scratch('land-home-forward');
  let seen = null;
  const opts = baseOpts(dir, {
    pollIntervalMs: 0,
    waitTimeoutMs: 100000,
    ratchetHome: '/tmp/forwarded-home',
    landCommand: (ctx) => { seen = ctx; return { code: 0, verdict: 'green', result: 'landed' }; },
  });
  assert.equal(queue.runLand(opts).code, 0);
  assert.equal(
    seen.ratchetHome, '/tmp/forwarded-home',
    'a home the caller minted has to reach the command, or the land acts against a control plane '
      + 'nobody chose',
  );
});

test('a caller that supplies NEITHER a clock NOR nowMs is refused, never handed platform time', () => {
  // Found by a surviving mutation. Inserting `return Date.now();` ahead of the
  // throw in `_nowOf` left the whole suite green, because every other case supplies
  // one or the other and the fallback branch was never driven. That is exactly the
  // trap `clock.cjs:35` and `:64` set: a fallback lets a caller believe it pinned
  // time while the code underneath reads the wall clock, and a module that can do
  // that cannot be driven by a mutation battery at all.
  const dir = scratch('no-clock');
  const opts = baseOpts(dir, { nowMs: undefined, clock: undefined });
  assert.throws(
    () => queue.enterLandQueue(opts),
    /opts.nowMs or opts.clock is REQUIRED/,
    'the absence of a supplied instant must be a refusal, not a silent platform clock read',
  );
  assert.equal(
    fs.existsSync(opts.logPath), false,
    'and nothing is written on that refusal',
  );

  // A non-finite clock reading is refused too, or NaN would flow into every
  // timestamp and every expiry comparison silently.
  assert.throws(
    () => queue.enterLandQueue(baseOpts(dir, { nowMs: undefined, clock: () => Number.NaN })),
    /non-finite instant/,
  );
});

test('when BOTH a clock and a nowMs are supplied the CLOCK wins, so instants are not frozen', () => {
  // Found by a surviving mutation. Reversing the precedence left the suite green
  // because no case supplied both, and the reversal is not cosmetic: a caller that
  // set both would emit all 5 events at 1 frozen instant, so gate_started and
  // gate_ended would coincide and phase 22 would read the land gate cost as 0ms.
  // A figure that is silently 0 is worse than a figure that is missing.
  const dir = scratch('clock-precedence');
  let reads = 0;
  const opts = baseOpts(dir, {
    nowMs: PINNED_NOW,
    clock: () => PAST_INSTANT + (reads++ * 10),
    pollIntervalMs: 0, waitTimeoutMs: 100000, landCommand: stubLand(),
  });
  queue.runLand(opts);

  const stamps = readLog(opts).map((e) => e.ts);
  assert.equal(stamps.length, 5);
  for (const ts of stamps) {
    assert.ok(
      ts >= PAST_INSTANT && ts < PINNED_NOW,
      `the clock must win over nowMs; ${ts} came from the frozen value`,
    );
  }
  assert.ok(
    new Set(stamps).size > 1,
    'the 5 instants must actually advance, or the gate interval collapses to 0ms',
  );
});

test('every emitted timestamp comes from the caller supplied clock and never from the platform clock', () => {
  const dir = scratch('clock-source');
  const opts = baseOpts(dir, {
    nowMs: undefined, clock: () => PAST_INSTANT,
    pollIntervalMs: 0, waitTimeoutMs: 100000, landCommand: stubLand(),
  });
  queue.runLand(opts);
  const stamps = readLog(opts).map((e) => e.ts);
  assert.equal(stamps.length, 5);
  for (const ts of stamps) {
    assert.equal(
      ts, PAST_INSTANT,
      `every ts must be the supplied instant; ${ts} is a platform clock read`,
    );
  }
});

// ─── FF-B216: THE LAND THAT NEEDS NO GITHUB, AND THE SEAM THAT CAN LEAVE ─────
//
// 2 defects in 1 function's neighbourhood, and the cases below are built to
// fail on the code that had them.
//
//   1. `landCommandSpec` joined `repoRoot` with the vendored entrypoint, so
//      `repoRoot` meant both the trunk being landed INTO and the tree the engine
//      is read OUT of. Those coincide only in this repository. Pointed anywhere
//      else the seam resolved a Python file that is not there.
//   2. The vendored `land` verb is GitHub shaped end to end: force with lease,
//      `gh pr create`, abort exit 2 when that fails, and `--merge` is `gh pr
//      merge --squash --auto`. FF-B231 records that even on this project's own
//      remote, branch protection is absent and auto merge is off, so the chain
//      terminates at an OPEN PULL REQUEST a human clicks. There is no local merge
//      path in the engine anywhere.
//
// THE ACCEPTANCE CONDITION IS MEASURED, NOT ASSERTED. `gh` is removed from PATH
// and PROBED absent, the repo landed into is a scratch fixture that is not this
// repository, and the assertion is a COUNTER plus file bytes rather than a
// boolean: the trunk's commit count must INCREASE and the increment's content
// must be on the trunk afterwards. A boolean "landed" is exactly what a lander
// that landed nothing would also return.

/** The instant every local land arm stamps its merge commit with. */
const LOCAL_LAND_NOW = 1785000123000;

/**
 * A real git repository with a real trunk and a real worker branch.
 *
 * ISOLATED FROM THE OPERATOR'S GIT CONFIG on purpose. A global `core.hooksPath`,
 * a global `commit.gpgsign` or a global identity would otherwise decide whether
 * these arms pass on 1 machine and fail on another, and an arm whose verdict
 * depends on the machine is not a measurement.
 */
function landFixture(label, over) {
  const opts = Object.assign({ conflicting: false }, over);
  const dir = scratch(label);
  const repo = path.join(dir, 'trunk-repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(dir, 'no-hooks'), { recursive: true });

  const git = (...args) => {
    const proc = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(
      proc.status, 0,
      `fixture git ${args.join(' ')} failed: ${proc.stderr || proc.stdout}`,
    );
    return String(proc.stdout ?? '').trim();
  };

  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.email', 'fixture@localhost');
  git('config', 'user.name', 'fixture');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(dir, 'no-hooks'));

  fs.writeFileSync(path.join(repo, 'trunk.txt'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');

  git('checkout', '-q', '-b', 'work');
  fs.writeFileSync(path.join(repo, 'increment.txt'), 'the increment\n');
  if (opts.conflicting) fs.writeFileSync(path.join(repo, 'trunk.txt'), 'base\nfrom the worker\n');
  git('add', '.');
  git('commit', '-q', '-m', 'worker increment');

  git('checkout', '-q', 'main');
  if (opts.conflicting) {
    fs.writeFileSync(path.join(repo, 'trunk.txt'), 'base\nfrom the trunk\n');
    git('add', '.');
    git('commit', '-q', '-m', 'trunk moved');
  }

  return { dir, repo, git };
}

/** Everything about the trunk that a land must move, or that a refusal must not. */
function trunkState(fixture) {
  return {
    tip: fixture.git('rev-parse', 'refs/heads/main'),
    count: Number(fixture.git('rev-list', '--count', 'refs/heads/main')),
    tree: fixture.git('rev-parse', 'refs/heads/main^{tree}'),
    status: fixture.git('status', '--porcelain'),
    trunkFile: fs.readFileSync(path.join(fixture.repo, 'trunk.txt'), 'utf8'),
  };
}

/**
 * Run `body` with `gh` GONE FROM PATH, proved by probing for it.
 *
 * The probe is the whole point. "The lander does not call gh" is a claim about
 * code; "gh cannot be called from here" is a fact about the process, and only the
 * second one can fail. git is probed in the same breath, because a PATH that
 * removed git too would make every arm below pass for the wrong reason.
 */
function withoutGh(label, body) {
  const dir = scratch(label);
  const bin = path.join(dir, 'nogh-bin');
  fs.mkdirSync(bin, { recursive: true });

  const which = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' });
  assert.equal(which.status, 0, 'this arm needs a real git on PATH to begin with');
  const realGit = String(which.stdout).trim();
  fs.symlinkSync(realGit, path.join(bin, 'git'));

  const prior = process.env.PATH;
  process.env.PATH = bin;
  try {
    const ghProbe = spawnSync('gh', ['--version'], { encoding: 'utf8' });
    assert.ok(
      ghProbe.error !== undefined && ghProbe.error !== null,
      'gh is still reachable, so this arm would prove nothing about a machine without it',
    );
    const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    assert.equal(gitProbe.status, 0, 'git must still be reachable, or every arm below fails vacuously');
    return body();
  } finally {
    process.env.PATH = prior;
  }
}

test('the fixture really carries an increment on a branch and a trunk with history, before anything lands', () => {
  const fixture = landFixture('local-land-nonvacuity');
  const before = trunkState(fixture);

  assert.ok(before.count > 0, 'a trunk with no commits makes every "nothing broke" assertion vacuous');
  assert.equal(
    fs.existsSync(path.join(fixture.repo, 'increment.txt')), false,
    'the increment must be ABSENT from the trunk checkout, or landing it proves nothing',
  );
  assert.notEqual(
    fixture.git('rev-parse', 'refs/heads/work'), before.tip,
    'the worker branch must really carry a commit the trunk does not have',
  );
  assert.equal(before.status, '', 'the fixture trunk must start clean');
});

test('a local land merges the worker branch into the trunk of ANOTHER repository with gh absent from PATH', () => {
  const fixture = landFixture('local-land-headline');
  const before = trunkState(fixture);
  const opts = baseOpts(fixture.dir, {
    pollIntervalMs: 0,
    waitTimeoutMs: 100000,
    nowMs: LOCAL_LAND_NOW,
    // THE TRUNK IS NOT THIS REPOSITORY, and the ENGINE IS. That split is defect 1:
    // before this change these were 1 argument, so pointing the fleet at any other
    // project resolved a Python entrypoint that is not in it.
    repoRoot: fixture.repo,
    engineRoot: REPO_ROOT,
    landStrategy: queue.LAND_STRATEGY.LOCAL,
    branch: 'work',
    mainline: 'main',
  });

  const outcome = withoutGh('local-land-headline-path', () => queue.runLand(opts));

  assert.equal(outcome.verdict, 'green', `the land refused: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.result, 'landed');

  const after = trunkState(fixture);
  assert.ok(
    after.count > before.count,
    `the trunk commit count must INCREASE: it was ${before.count} and is ${after.count}`,
  );
  assert.notEqual(after.tip, before.tip, 'the trunk tip must have moved');
  assert.equal(
    fs.readFileSync(path.join(fixture.repo, 'increment.txt'), 'utf8'), 'the increment\n',
    'the worker\'s change must be present on the trunk checkout, byte for byte',
  );
  assert.equal(
    fixture.git('merge-base', '--is-ancestor', 'refs/heads/work', 'refs/heads/main'), '',
    'the worker branch must be an ancestor of the trunk, which is what landed means',
  );
  assert.equal(after.status, '', 'a land must leave the trunk checkout clean');

  // THE QUEUE SEMANTICS ARE UNTOUCHED. The same 5 events in the same order, and
  // the ticket closes with the lander's own result rather than with a default.
  assert.deepEqual(kindsOf(opts), [
    'queue_entered', 'queue_acquired', 'gate_started', 'gate_ended', 'land_completed',
  ]);
  assert.equal(readLog(opts).find((e) => e.kind === 'gate_ended').verdict, 'green');
  assert.equal(readLog(opts).find((e) => e.kind === 'land_completed').result, 'landed');
});

test('a local land that CONFLICTS refuses by name and leaves the trunk byte identical', () => {
  const fixture = landFixture('local-land-conflict', { conflicting: true });
  const before = trunkState(fixture);
  assert.ok(before.count > 1, 'the trunk must carry the divergent commit, or there is no conflict to drive');

  const opts = baseOpts(fixture.dir, {
    pollIntervalMs: 0,
    waitTimeoutMs: 100000,
    nowMs: LOCAL_LAND_NOW,
    repoRoot: fixture.repo,
    engineRoot: REPO_ROOT,
    landStrategy: queue.LAND_STRATEGY.LOCAL,
    branch: 'work',
    mainline: 'main',
  });

  const outcome = withoutGh('local-land-conflict-path', () => queue.landLocal({
    ticket: 0,
    nowMs: LOCAL_LAND_NOW,
    nodeId: 'n0',
    attemptId: 'a0',
    repoRoot: fixture.repo,
    engineRoot: REPO_ROOT,
    landStrategy: queue.LAND_STRATEGY.LOCAL,
    branch: 'work',
    mainline: 'main',
  }));

  // THE ATTEMPT HAPPENED. Asserted BEFORE the absence of damage, because "nothing
  // broke" is vacuously true of a lander that returned before touching git at all.
  assert.equal(outcome.refusal, queue.LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_CONFLICT);
  assert.equal(outcome.result, `refused:${queue.LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_CONFLICT}`);
  assert.equal(outcome.verdict, 'red');
  assert.notEqual(outcome.code, 0, 'a refusal must never report the exit code of a success');
  assert.match(
    outcome.detail, /CONFLICT/,
    'the refusal must carry git\'s own conflict report, which only a real merge attempt produces',
  );
  assert.match(outcome.detail, /trunk\.txt/, 'the conflict must name the file the 2 sides both changed');
  assert.equal(outcome.before, before.tip, 'the refusal must name the trunk tip it read');

  const after = trunkState(fixture);
  assert.deepEqual(after, before, 'a refused land must leave the trunk byte identical');
  assert.equal(
    fs.existsSync(path.join(fixture.repo, '.git', 'MERGE_HEAD')), false,
    'a half applied merge would leave MERGE_HEAD behind, and a half applied trunk is worse than a refusal',
  );
  assert.equal(
    fs.readFileSync(path.join(fixture.repo, 'trunk.txt'), 'utf8').includes('<<<<<<<'), false,
    'a refused land must not write conflict markers into the trunk\'s files',
  );

  // AND THE REFUSAL REACHES THE RUN RECORD rather than being swallowed into a
  // green. A caller that gave up must never leave the increment unlanded while
  // the record says it landed.
  const through = withoutGh('local-land-conflict-record', () => queue.runLand(opts));
  assert.equal(through.verdict, 'red');
  assert.equal(
    readLog(opts).find((e) => e.kind === 'land_completed').result,
    `refused:${queue.LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_CONFLICT}`,
  );
  assert.deepEqual(trunkState(fixture), before, 'the seam path must not damage the trunk either');
});

test('a local land refuses a dirty trunk and a branch that is not there, and moves nothing', () => {
  const dirty = landFixture('local-land-dirty');
  const beforeDirty = trunkState(dirty);
  fs.writeFileSync(path.join(dirty.repo, 'trunk.txt'), 'a human is editing this\n');

  const dirtyOutcome = queue.landLocal({
    ticket: 0, nowMs: LOCAL_LAND_NOW, nodeId: 'n0', attemptId: 'a0',
    repoRoot: dirty.repo, branch: 'work', mainline: 'main',
  });
  assert.equal(dirtyOutcome.refusal, queue.LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_DIRTY_TRUNK);
  assert.equal(dirtyOutcome.verdict, 'red');
  assert.equal(
    dirty.git('rev-parse', 'refs/heads/main'), beforeDirty.tip,
    'the trunk must not move when the lander refuses a dirty checkout',
  );

  const missing = landFixture('local-land-missing-branch');
  const beforeMissing = trunkState(missing);
  const missingOutcome = queue.landLocal({
    ticket: 0, nowMs: LOCAL_LAND_NOW, nodeId: 'n0', attemptId: 'a0',
    repoRoot: missing.repo, branch: 'no-such-branch', mainline: 'main',
  });
  assert.equal(missingOutcome.refusal, queue.LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_NO_BRANCH);
  assert.deepEqual(trunkState(missing), beforeMissing, 'a missing branch must move nothing');

  const notARepo = scratch('local-land-not-a-repo');
  const notARepoOutcome = queue.landLocal({
    ticket: 0, nowMs: LOCAL_LAND_NOW, nodeId: 'n0', attemptId: 'a0',
    repoRoot: notARepo, branch: 'work', mainline: 'main',
  });
  assert.equal(notARepoOutcome.refusal, queue.LAND_ERROR_CODES.E_FLEET_LAND_LOCAL_NOT_A_REPO);
});

test('the land seam names the ENGINE root separately from the trunk, and refuses an absent one', () => {
  const fixture = landFixture('local-land-engine-split');

  // DEFECT 1 REPRODUCED. The trunk is another project, and that project has no
  // vendored Python engine in it. Before the split this returned a path under the
  // TRUNK and the failure surfaced as an ENOENT from a spawn against a path
  // nobody chose.
  assert.throws(
    () => queue.landCommandSpec({ worktree: path.join(fixture.dir, 'wt'), repoRoot: fixture.repo }),
    (err) => err.code === queue.LAND_ERROR_CODES.E_FLEET_NO_ENGINE_ROOT
      && /engineRoot/.test(err.message),
    'an unresolvable engine must refuse at the seam that can name the missing input',
  );

  const spec = queue.landCommandSpec({
    worktree: path.join(fixture.dir, 'wt'), repoRoot: fixture.repo, engineRoot: REPO_ROOT,
  });
  assert.equal(
    spec.command,
    path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', 'ratchet'),
    'with an engine root supplied the seam reads the engine from THERE and the trunk from elsewhere',
  );
  assert.ok(fs.existsSync(spec.command), 'the entrypoint the spec names must really be on disk');

  // The same refusal the worker seam makes, stated positively: an engine inside
  // the tree being landed into is the tree the interpreter would write bytecode
  // into.
  assert.throws(
    () => queue.landCommandSpec({
      worktree: path.join(fixture.dir, 'wt'),
      repoRoot: REPO_ROOT,
      engineRoot: path.join(REPO_ROOT, 'ferrox-core'),
    }),
    (err) => err.code === queue.LAND_ERROR_CODES.E_FLEET_ENGINE_ROOT_INSIDE_REPO,
  );
});

test('with no strategy named the seam is the engine it has always been, and an unknown name refuses', () => {
  // THE FENCE. The default arm still produces exactly the command it produced
  // before the local lander existed.
  const spec = queue.landCommandSpec({ worktree: '/tmp/wt-fence', repoRoot: REPO_ROOT });
  assert.equal(
    spec.command,
    path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', 'ratchet'),
  );
  assert.deepEqual(spec.args, ['land', '/tmp/wt-fence', '--no-fuse']);

  // And the DISPATCH defaults to the engine, proved without spawning it: a
  // context whose repo carries no engine takes the engine path and refuses there.
  const fixture = landFixture('local-land-fence');
  assert.throws(
    () => queue.defaultLandCommand({
      ticket: 0, nowMs: LOCAL_LAND_NOW, nodeId: 'n0', attemptId: 'a0',
      repoRoot: fixture.repo, branch: 'work', mainline: 'main',
    }),
    (err) => err.code === queue.LAND_ERROR_CODES.E_FLEET_NO_ENGINE_ROOT,
    'an unnamed strategy must still be the engine, not the local lander',
  );
  assert.deepEqual(
    trunkState(fixture).tip, fixture.git('rev-parse', 'refs/heads/main'),
    'the default path must not have landed anything locally',
  );
  assert.equal(
    fs.existsSync(path.join(fixture.repo, 'increment.txt')), false,
    'the default path must NOT have merged the worker branch',
  );

  // AN UNKNOWN STRATEGY REFUSES RATHER THAN FALLING BACK. A caller that asked for
  // a lander this seam does not have must never silently get the GitHub shaped
  // one, because that one terminates at an open pull request.
  assert.throws(
    () => queue.defaultLandCommand({
      ticket: 0, nowMs: LOCAL_LAND_NOW, nodeId: 'n0', attemptId: 'a0',
      repoRoot: fixture.repo, landStrategy: 'github', branch: 'work', mainline: 'main',
    }),
    (err) => err.code === queue.LAND_ERROR_CODES.E_FLEET_UNKNOWN_LAND_STRATEGY,
  );
});

test('a local land of a branch already on the trunk reports that distinctly and writes no empty merge', () => {
  const fixture = landFixture('local-land-already');
  fixture.git('merge', '--ff-only', '-q', 'work');
  const before = trunkState(fixture);
  assert.ok(
    fs.existsSync(path.join(fixture.repo, 'increment.txt')),
    'the increment must already be on the trunk for this arm to mean anything',
  );

  const outcome = queue.landLocal({
    ticket: 0, nowMs: LOCAL_LAND_NOW, nodeId: 'n0', attemptId: 'a0',
    repoRoot: fixture.repo, branch: 'work', mainline: 'main',
  });
  assert.equal(outcome.verdict, 'green');
  assert.equal(
    outcome.result, 'landed:already-merged',
    'an increment that is already on the trunk is landed, and it is named apart from a merge',
  );
  assert.deepEqual(trunkState(fixture), before, 'an already merged branch must add no empty merge commit');
});
