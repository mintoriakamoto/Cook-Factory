'use strict';

/**
 * Phase 20 plan 03 task 3: the park state, FOLDED out of the run log.
 *
 * CONTEXT D7.2 applies phase 19's D4 rule without amendment: the park count is
 * DERIVED from the events on every pass and is never a number anybody maintains.
 * A derived counter cannot drift from its events; a maintained one eventually
 * always does. Two shapes in this file enforce that rather than assert it:
 *
 *   1. The count is read back from a log that was APPENDED TO between calls, and
 *      the second answer differs from the first. A module holding a running total
 *      would have to be told about the new events; this one is not told.
 *   2. The same event list folded twice returns an EQUAL result, so there is no
 *      state the first call could have left behind for the second.
 *
 * THE BUDGET ALARM IS ASSERTED TWICE, AS 2 SEPARATE OBSERVATIONS. CONTEXT D8:
 * "a budget alarm asserted only at the budget" passes for an alarm that is always
 * on. So it is asserted ABSENT at the budget minus 1 and PRESENT at the budget,
 * and a third case asserts it goes quiet once an alarm for it is already in the
 * log, which is what makes it fire once rather than on every pass afterwards.
 *
 * `on_critical_path` is READ OFF THE RECORDED EVENT and never recomputed from a
 * graph here. The graph at fold time may not be the graph at park time, and a
 * figure that changes when you re read it is not evidence.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const park = require('../ferrox-core/bin/lib/fleet-park.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BUILT_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'fleet-park.cjs');

let seq = 0;

/** A node_parked record, in the shape src/fleet-runlog.cts requires of one. */
function parked(nodeId, overrides = {}) {
  seq += 1;
  return {
    ts: 1_700_000_000_000 + seq,
    kind: 'node_parked',
    run_id: 'run-a',
    node_id: nodeId,
    reason: 'blocked-on-human',
    attempts: 1,
    on_critical_path: false,
    ...overrides,
  };
}

/** A park_alarm record. */
function alarm(nodeId, overrides = {}) {
  seq += 1;
  return {
    ts: 1_700_000_000_000 + seq,
    kind: 'park_alarm',
    run_id: 'run-a',
    node_id: nodeId,
    scope: 'node',
    route: 'queued',
    parked_count: 1,
    budget: 3,
    ...overrides,
  };
}

/** Some other kind, which the fold must simply ignore. */
function noise(nodeId) {
  seq += 1;
  return {
    ts: 1_700_000_000_000 + seq,
    kind: 'gate_ended',
    run_id: 'run-a',
    node_id: nodeId,
    attempt_id: 'a1',
    verdict: 'green',
  };
}

// ─── the empty and the ignored ───────────────────────────────────────────────

test('a log with no park events folds to a count of 0 and an empty parked list', () => {
  const state = park.foldParkState([], { runId: 'run-a' });
  assert.equal(state.park_count, 0);
  assert.deepEqual(state.parked, []);
  assert.equal(state.budget, park.DEFAULT_PARK_BUDGET, 'the default budget is 3, from CONTEXT D7.1');
  assert.equal(state.budget_alarm_due, false, 'no parks, no alarm');
  assert.equal(state.alarmed, false);
  assert.deepEqual(state.on_critical_path, { on: [], off: [] });

  const withNoise = park.foldParkState([noise('n1'), noise('n2')], { runId: 'run-a' });
  assert.equal(withNoise.park_count, 0, 'a gate event is not a park');
  assert.deepEqual(withNoise.parked, []);
});

// ─── the count is a count of NODES, and it is derived ────────────────────────

test('a node parked twice is 1 parked node, because the budget is a budget over PARKED NODES', () => {
  const events = [parked('n1'), parked('n2'), parked('n1', { attempts: 2 })];
  const state = park.foldParkState(events, { runId: 'run-a' });
  assert.equal(state.park_count, 2, 'a count over raw events would silently double the retry');
  assert.deepEqual(state.parked, ['n1', 'n2'], 'sorted, and a set');
});

test('the count is DERIVED on every call: appending an event changes the answer with nothing told to the module', () => {
  const events = [parked('n1')];
  assert.equal(park.foldParkState(events, { runId: 'run-a' }).park_count, 1);
  events.push(parked('n2'));
  assert.equal(
    park.foldParkState(events, { runId: 'run-a' }).park_count, 2,
    'a maintained total would have to be told about the new event; a derived one reads it',
  );
  // No state the first call could have left behind for the second.
  assert.deepEqual(
    park.foldParkState(events, { runId: 'run-a' }),
    park.foldParkState(events, { runId: 'run-a' }),
  );
});

test('the fold is scoped by run id, so a second run in the same log cannot inflate the first', () => {
  const events = [
    parked('n1'),
    parked('n2', { run_id: 'run-b' }),
    parked('n3', { run_id: 'run-b' }),
  ];
  const a = park.foldParkState(events, { runId: 'run-a' });
  assert.equal(a.park_count, 1, 'run-b parked 2 nodes and run-a must not be charged for them (the FF-B121 shape)');
  assert.deepEqual(a.parked, ['n1']);

  const b = park.foldParkState(events, { runId: 'run-b' });
  assert.equal(b.park_count, 2);
  assert.deepEqual(b.parked, ['n2', 'n3']);

  const all = park.foldParkState(events, {});
  assert.equal(all.park_count, 3, 'an absent run id folds everything, which is what a 1 run log wants');
});

// ─── the budget alarm: absent below, present at, quiet after ─────────────────

test('the budget alarm is NOT due at the budget minus 1', () => {
  const events = [parked('n1'), parked('n2')];
  const state = park.foldParkState(events, { runId: 'run-a', budget: 3 });
  assert.equal(state.park_count, 2);
  assert.equal(
    state.budget_alarm_due, false,
    'this is the observation an always-on alarm fails. Without it, a check asserted only at the budget passes '
      + 'for an alarm that was never off.',
  );
});

test('the budget alarm IS due at the budget', () => {
  const events = [parked('n1'), parked('n2'), parked('n3')];
  const state = park.foldParkState(events, { runId: 'run-a', budget: 3 });
  assert.equal(state.park_count, 3);
  assert.equal(state.budget_alarm_due, true, 'at the budget the fleet raises 1 loud alarm rather than stalling');
  assert.equal(state.alarmed, false, 'nothing has been written yet, so the alarm is DUE and not yet raised');
});

test('the budget alarm goes quiet once a budget scoped alarm for the run is in the log, even as parks keep arriving', () => {
  const base = [parked('n1'), parked('n2'), parked('n3')];
  const raised = [...base, alarm('n3', { scope: 'budget', parked_count: 3, budget: 3 })];
  const after = park.foldParkState(raised, { runId: 'run-a', budget: 3 });
  assert.equal(after.alarmed, true, 'the alarm is derived from the log for the same reason the count is');
  assert.equal(after.budget_alarm_due, false, 'due once, not on every pass after the budget');

  const more = [...raised, parked('n4'), parked('n5')];
  const later = park.foldParkState(more, { runId: 'run-a', budget: 3 });
  assert.equal(later.park_count, 5, 'past the budget');
  assert.equal(later.budget_alarm_due, false, 'a count above the budget does not make the alarm due again');
});

test('a NODE scoped alarm does not silence the budget alarm, because they answer different questions', () => {
  const events = [parked('n1'), parked('n2'), parked('n3'), alarm('n3', { scope: 'node', route: 'synchronous' })];
  const state = park.foldParkState(events, { runId: 'run-a', budget: 3 });
  assert.equal(state.alarmed, false, 'scope node is the per park alarm, not the budget one');
  assert.equal(state.budget_alarm_due, true);
});

test('a budget alarm raised by a DIFFERENT run does not silence this one', () => {
  const events = [
    parked('n1'), parked('n2'), parked('n3'),
    alarm('m9', { run_id: 'run-b', scope: 'budget', parked_count: 3, budget: 3 }),
  ];
  const state = park.foldParkState(events, { runId: 'run-a', budget: 3 });
  assert.equal(state.alarmed, false);
  assert.equal(state.budget_alarm_due, true);
});

test('the budget reported back is the budget the caller supplied, and an unreadable one falls to the default', () => {
  assert.equal(park.foldParkState([], { runId: 'run-a', budget: 7 }).budget, 7);
  assert.equal(park.foldParkState([], { runId: 'run-a', budget: 'lots' }).budget, park.DEFAULT_PARK_BUDGET);
  assert.equal(park.foldParkState([], {}).budget, park.DEFAULT_PARK_BUDGET);
  assert.equal(park.foldParkState([]).budget, park.DEFAULT_PARK_BUDGET, 'no options at all is a normal call');
});

// ─── on_critical_path is READ, never recomputed ──────────────────────────────

test('the fold reports which parks were on the critical path and which were not, off the recorded event', () => {
  const events = [
    parked('n1', { on_critical_path: true }),
    parked('n2', { on_critical_path: false }),
    parked('n3', { on_critical_path: true }),
  ];
  const state = park.foldParkState(events, { runId: 'run-a' });
  assert.deepEqual(state.on_critical_path, { on: ['n1', 'n3'], off: ['n2'] });
  // Both halves asserted. A fold that reported everything on, or everything off,
  // would satisfy only 1 of these.
  assert.deepEqual(state.parked, ['n1', 'n2', 'n3']);
  assert.equal(
    state.on_critical_path.on.length + state.on_critical_path.off.length, state.park_count,
    'every parked node lands in exactly 1 of the 2 lists',
  );
});

test('the fold takes NO graph, so it cannot recompute membership and cannot report a figure that moves', () => {
  assert.equal(park.foldParkState.length <= 2, true, 'foldParkState(events, options) and nothing else');
  const events = [parked('n1', { on_critical_path: true })];
  assert.deepEqual(park.foldParkState(events, { runId: 'run-a' }).on_critical_path, { on: ['n1'], off: [] });
  // The recorded flag wins even when it disagrees with any graph a caller might
  // hold, because the writer computed it once, at the park.
  const flipped = [parked('n1', { on_critical_path: false })];
  assert.deepEqual(park.foldParkState(flipped, { runId: 'run-a' }).on_critical_path, { on: [], off: ['n1'] });
});

test('a node parked twice with a changed flag reports the LAST recorded value, deterministically', () => {
  const events = [parked('n1', { on_critical_path: false }), parked('n1', { on_critical_path: true })];
  const state = park.foldParkState(events, { runId: 'run-a' });
  assert.equal(state.park_count, 1);
  assert.deepEqual(state.on_critical_path, { on: ['n1'], off: [] }, 'the latest statement about the node wins');
});

// ─── the artifact is registered ──────────────────────────────────────────────

test('the built park library is tracked and named in the inventory manifest under cli_modules', () => {
  assert.ok(fs.existsSync(BUILT_LIB), `${BUILT_LIB} must be built and committed`);
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'docs', 'INVENTORY-MANIFEST.json'), 'utf8'));
  const families = manifest.families || manifest;
  const flat = JSON.stringify(families);
  assert.ok(
    flat.includes('fleet-park.cjs'),
    'cli_modules is generated from ferrox-core/bin/lib/*.cjs on disk, so a new lib that never reached the '
      + 'manifest turns lint:generated-sync red',
  );
});
