'use strict';

/**
 * WHEN FERROX IS ALLOWED TO SPEAK UNPROMPTED.
 *
 * The offer layer is the half that CAN nag. A description is read silently by
 * the model and costs nothing; a prompt hook interrupts on every fire whether it
 * lands or not. So this file is written the way the module is: the default is
 * silence, and every arm that proves an offer fires is paired with arms proving
 * the 5 brakes stop it.
 *
 * ─── THE TWO FAILURE MODES, BOTH TESTED ──────────────────────────────────────
 *
 * Over-offering is the obvious one and the easy one to over-correct. A module
 * that never speaks passes every "does not nag" test ever written, and is the
 * exact failure this was built to fix. So:
 *
 *   - `EVERY OFFER CAN FIRE` proves each of the 3 is reachable with real state.
 *     An offer that cannot fire is dead code shipped as a feature, which is this
 *     project's recurring defect: a guard that cannot fire reads like coverage.
 *     The first draft of the hook hardcoded `fleetAvailable: false`, which made
 *     `fleet-it` unreachable, and only this arm would have caught it.
 *   - the brake arms prove it stays quiet everywhere else.
 *
 * Neither set alone is worth anything.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REG = require(path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'offer-registry.cjs'));

/** Baseline: a real project, at a seam, with nothing notable about it. */
function baseState(over = {}) {
  return {
    situation: 'needs-first-phase',
    hasPlanning: true,
    hasRoadmap: false,
    disjointPlans: 0,
    fleetAvailable: false,
    unpushedCommits: 0,
    dirty: false,
    ...over,
  };
}

const NO_MEMORY = () => ({ edges: {}, outcomes: {} });

/* ------------------------------------------------------------------------ *
 * The registry is real, and every offer in it can fire
 * ------------------------------------------------------------------------ */

test('the registry is NON EMPTY and every offer names a command that ships', () => {
  assert.ok(REG.OFFERS.length >= 3, `expected 3+ offers, got ${REG.OFFERS.length}`);
  const shipped = new Set(
    fs.readdirSync(path.join(ROOT, 'commands', 'ferrox'))
      .filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)),
  );
  assert.ok(shipped.size > 40, `shipped set must be real, got ${shipped.size}`);
  for (const o of REG.OFFERS) {
    assert.ok(shipped.has(o.command), `offer ${o.id} points at absent command ${o.command}`);
    // Brake 5 in copy form: the text must name the command it will run, or the
    // user is asked to accept something they cannot see.
    assert.ok(
      o.copy(baseState({ disjointPlans: 6, unpushedCommits: 3 })).includes(`/ferrox-${o.command}`),
      `offer ${o.id} copy must name /ferrox-${o.command}`,
    );
  }
});

test('EVERY OFFER CAN FIRE. An offer that cannot is dead code shipped as a feature', () => {
  // The required FIRING arm, and the mirror of every "required failing arm" in
  // this repository. The 3 states below are each the minimum that makes exactly
  // one offer eligible.
  const cases = [
    ['plan-it', 'build me a game about trains', baseState()],
    ['fleet-it', 'ok', baseState({ hasRoadmap: true, disjointPlans: 6, fleetAvailable: true })],
    ['ship-it', 'ok', baseState({
      hasRoadmap: true, situation: 'idle-stranded', unpushedCommits: 3,
    })],
  ];
  const fired = [];
  for (const [id, prompt, state] of cases) {
    const d = REG.decideOffer(prompt, state, NO_MEMORY());
    assert.ok(d.offer !== null, `offer ${id} could not be made reachable: ${d.silentBecause}`);
    assert.strictEqual(d.offer.id, id, `expected ${id}, got ${d.offer.id}`);
    assert.ok(d.text && d.text.length > 40, `${id} produced no usable copy`);
    fired.push(id);
  }
  // Counted, so adding a 4th offer without a firing case fails here.
  assert.strictEqual(
    fired.length, REG.OFFERS.length,
    `${fired.length} of ${REG.OFFERS.length} offers were proven reachable: ${fired.join(', ')}`,
  );
});

test('the copy NAMES SOMETHING THE USER HAS, which is what earns the interruption', () => {
  // "Six of these do not touch the same files" earns it. "Ferrox recommends the
  // planning workflow" does not, because it sells the process rather than the
  // outcome. Asserted on the 2 offers whose copy is state derived.
  const fleet = REG.decideOffer('ok', baseState({
    hasRoadmap: true, disjointPlans: 6, fleetAvailable: true,
  }), NO_MEMORY());
  assert.match(fleet.text, /\b6\b/, 'the fleet offer must state the actual plan count');

  const ship = REG.decideOffer('ok', baseState({
    hasRoadmap: true, situation: 'idle-stranded', unpushedCommits: 3,
  }), NO_MEMORY());
  assert.match(ship.text, /\b3 commits\b/, 'the ship offer must state the actual commit count');
});

/* ------------------------------------------------------------------------ *
 * Brake 1: bypass
 * ------------------------------------------------------------------------ */

test('BRAKE 1, bypass: a leading * or "ferrox off" silences one prompt', () => {
  for (const prompt of ['* build me a game', 'build me a game, ferrox off', 'FERROX OFF now']) {
    const d = REG.decideOffer(prompt, baseState(), NO_MEMORY());
    assert.strictEqual(d.offer, null, `"${prompt}" must be bypassed`);
    assert.strictEqual(d.silentBecause, 'bypassed');
  }
  // And the control: the same sentence WITHOUT the bypass does offer, or this
  // arm is passing for a module that never speaks.
  const control = REG.decideOffer('build me a game', baseState(), NO_MEMORY());
  assert.ok(control.offer, 'the control must fire, or the bypass arm proves nothing');
});

/* ------------------------------------------------------------------------ *
 * Brake 2: flight
 * ------------------------------------------------------------------------ */

test('BRAKE 2, flight: silent during all 4 mid-flight situations', () => {
  assert.strictEqual(REG.MID_FLIGHT.length, 4, 'the mid-flight set must be the declared 4');
  for (const situation of REG.MID_FLIGHT) {
    const d = REG.decideOffer('build me a game', baseState({ situation }), NO_MEMORY());
    assert.strictEqual(d.offer, null, `must be silent while ${situation}`);
    assert.strictEqual(d.silentBecause, `mid-flight:${situation}`);
  }
});

test('BRAKE 2 control: the SEAM situations are not muted', () => {
  // Without this, muting all 11 situations would pass the arm above.
  const d = REG.decideOffer('build me a game', baseState({ situation: 'no-project' }), NO_MEMORY());
  assert.ok(d.offer, `a seam situation must still be able to offer: ${d.silentBecause}`);
});

/* ------------------------------------------------------------------------ *
 * Brake 3: edges, the biggest anti-nag device
 * ------------------------------------------------------------------------ */

test('BRAKE 3, edge: an unchanged condition is not news, however many prompts pass', () => {
  const state = baseState();
  const memory = NO_MEMORY();

  const first = REG.decideOffer('build me a game', state, memory);
  assert.ok(first.offer, 'the first crossing must fire');

  // The hook records the edge on every evaluation, offered or not.
  memory.edges['plan-it'] = REG.edgeValue(first.offer, state);
  delete memory.outcomes['plan-it']; // isolate the edge brake from the budget brake

  // 50 further prompts, same standing condition. "This project has no roadmap"
  // is true for all of them and is news in none of them.
  let spoke = 0;
  for (let i = 0; i < 50; i += 1) {
    if (REG.decideOffer('build me a game', state, memory).offer) spoke += 1;
  }
  assert.strictEqual(spoke, 0, `a level was re-read as news ${spoke} times`);
});

test('BRAKE 3 control: a CHANGED condition fires again', () => {
  // Otherwise the edge brake is indistinguishable from permanent silence.
  const memory = NO_MEMORY();
  memory.edges['ship-it'] = REG.edgeValue(
    REG.OFFERS.find((o) => o.id === 'ship-it'),
    baseState({ hasRoadmap: true, situation: 'complete', unpushedCommits: 0 }),
  );
  const changed = baseState({ hasRoadmap: true, situation: 'idle-stranded', unpushedCommits: 4 });
  const d = REG.decideOffer('ok', changed, memory);
  assert.ok(d.offer, `a materially changed condition must fire: ${d.silentBecause}`);
  assert.strictEqual(d.offer.id, 'ship-it');
});

/* ------------------------------------------------------------------------ *
 * Brake 4: budgets
 * ------------------------------------------------------------------------ */

test('BRAKE 4, budget: at most 1 offer per prompt even when several are eligible', () => {
  const state = baseState({
    hasRoadmap: false, disjointPlans: 6, fleetAvailable: true,
    situation: 'idle-stranded', unpushedCommits: 3,
  });
  const d = REG.decideOffer('build me a game', state, NO_MEMORY());
  assert.ok(d.offer, 'something must be eligible for this arm to mean anything');
  // The decision returns exactly 1 offer by construction; priority decides which.
  assert.strictEqual(d.offer.id, 'plan-it', 'highest priority must win');
});

test('BRAKE 4, budget: a DECLINE is permanent for that offer', () => {
  const memory = NO_MEMORY();
  memory.outcomes['plan-it'] = 'declined';
  const d = REG.decideOffer('build me a game', baseState(), memory);
  assert.strictEqual(d.offer, null, 'a declined offer must never be raised again');
  // A user who said no answered the question; they did not defer it.
  const memory2 = NO_MEMORY();
  memory2.outcomes['plan-it'] = 'accepted';
  assert.strictEqual(
    REG.decideOffer('build me a game', baseState(), memory2).offer, null,
    'an accepted offer must not be raised again either',
  );
});

/* ------------------------------------------------------------------------ *
 * Brake 5: availability
 * ------------------------------------------------------------------------ */

test('BRAKE 5, availability: never offer a fleet where a fleet cannot run', () => {
  const runnable = baseState({ hasRoadmap: true, disjointPlans: 6, fleetAvailable: true });
  assert.ok(REG.decideOffer('ok', runnable, NO_MEMORY()).offer, 'control: it fires when available');

  const notRunnable = { ...runnable, fleetAvailable: false };
  const d = REG.decideOffer('ok', notRunnable, NO_MEMORY());
  assert.strictEqual(d.offer, null, 'an offer that would refuse on acceptance must not be made');
});

test('BRAKE 5: below the parallel threshold there is nothing to offer', () => {
  const d = REG.decideOffer('ok', baseState({
    hasRoadmap: true, disjointPlans: 3, fleetAvailable: true,
  }), NO_MEMORY());
  assert.strictEqual(d.offer, null, '3 disjoint plans is not a fleet');
});

/* ------------------------------------------------------------------------ *
 * The counters
 * ------------------------------------------------------------------------ */

test('UNKNOWN IS NEVER 0: an offer never shown has a NULL acceptance rate', () => {
  const stats = REG.foldOfferStats(['{"offer":"x","outcome":"accepted"}']);
  // shown 0, accepted 1 is a malformed log, and the point stands: a rate of 0
  // would retire an offer for failing at a job it was never given.
  const none = REG.foldOfferStats([]);
  assert.deepStrictEqual(none, {}, 'an empty log folds to no offers, not to zeroes');
  assert.strictEqual(stats['x'].acceptanceRate, null, 'shown 0 must yield null, never 0');
});

test('the counters COUNT, and the rate is a real quotient', () => {
  const log = [
    '{"offer":"a","outcome":"shown"}', '{"offer":"a","outcome":"accepted"}',
    '{"offer":"a","outcome":"shown"}', '{"offer":"a","outcome":"declined"}',
    '{"offer":"b","outcome":"missed"}',
    'not json at all',
    '',
  ];
  const s = REG.foldOfferStats(log);
  assert.strictEqual(s['a'].shown, 2);
  assert.strictEqual(s['a'].accepted, 1);
  assert.strictEqual(s['a'].declined, 1);
  assert.strictEqual(s['a'].acceptanceRate, 0.5);
  assert.strictEqual(s['b'].missed, 1, 'the MISS rate must be counted too');
  assert.strictEqual(s['b'].acceptanceRate, null, 'b was never shown');
});

test('AN OFFER THAT IS NOISE RETIRES ITSELF, and one with no evidence does not', () => {
  // This is what makes "is it annoying" a number rather than an argument.
  const noisy = [];
  for (let i = 0; i < 10; i += 1) noisy.push('{"offer":"nag","outcome":"shown"}');
  noisy.push('{"offer":"nag","outcome":"accepted"}'); // 1 in 10, below the floor
  assert.deepStrictEqual(REG.retiredOffers(REG.foldOfferStats(noisy)), ['nag']);

  // Below the minimum sample, one unlucky decline must NOT retire an offer.
  const thin = ['{"offer":"new","outcome":"shown"}', '{"offer":"new","outcome":"declined"}'];
  assert.deepStrictEqual(
    REG.retiredOffers(REG.foldOfferStats(thin)), [],
    `an offer shown fewer than ${REG.RETIREMENT_MIN_SHOWN} times has no evidence yet`,
  );

  // And a good offer is never retired.
  const good = [];
  for (let i = 0; i < 10; i += 1) {
    good.push('{"offer":"useful","outcome":"shown"}');
    good.push('{"offer":"useful","outcome":"accepted"}');
  }
  assert.deepStrictEqual(REG.retiredOffers(REG.foldOfferStats(good)), []);
});

/* ------------------------------------------------------------------------ *
 * The shipped hook, as a child process
 * ------------------------------------------------------------------------ */

const HOOK = path.join(ROOT, 'hooks', 'ferrox-offer.js');

function runHook(cwd, prompt) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, prompt }),
    encoding: 'utf-8',
    timeout: 10000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function scratchProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-offer-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

function cleanup(dir) {
  try {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* best effort */ }
}

test('THE HOOK NEVER BLOCKS, on every input including malformed ones', () => {
  // It runs before every prompt of every session. A hook that breaks a session to
  // deliver a suggestion has done more damage than the suggestion could repay.
  const cases = ['', 'not json', '{}', '{"cwd":"/nonexistent/xyz","prompt":"hi"}', '{"prompt":null}'];
  let ran = 0;
  for (const input of cases) {
    const res = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf-8', timeout: 10000 });
    ran += 1;
    assert.strictEqual(res.status, 0, `hook exited ${res.status} on input: ${input}`);
  }
  assert.strictEqual(ran, cases.length, 'every case must actually have run');
});

test('THE HOOK YIELDS when there is no .planning/, so it cannot claim another tool\'s prompt', () => {
  const dir = scratchProject({ 'README.md': 'hi' });
  try {
    const r = runHook(dir, 'build me a game about trains');
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '', 'a non Ferrox project must produce no output at all');
  } finally {
    cleanup(dir);
  }
});

test('THE HOOK SPEAKS on a real project at a seam, and then STOPS', () => {
  const dir = scratchProject({
    '.planning/config.json': '{"runtime":"claude"}',
    '.planning/STATE.md': '---\nstatus: unknown\n---\n# State\n',
  });
  try {
    const first = runHook(dir, 'build me a game about trains');
    assert.strictEqual(first.status, 0);
    assert.ok(first.stdout.includes('ferrox-offer'), `expected an offer, got: ${first.stdout}`);
    const payload = JSON.parse(first.stdout);
    assert.strictEqual(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.ok(payload.hookSpecificOutput.additionalContext.includes('/ferrox-new-project'));

    // The memory and the log are both written, or the counters are fiction.
    assert.ok(fs.existsSync(path.join(dir, '.planning', '.ferrox-offers.json')));
    const log = fs.readFileSync(path.join(dir, '.planning', '.ferrox-offers.jsonl'), 'utf-8');
    const rows = log.split(/\r?\n/).filter((l) => l.trim() !== '');
    assert.strictEqual(rows.length, 1, 'exactly 1 row must be logged for 1 offer');

    // And the budget holds across processes, which is the only place it matters.
    const second = runHook(dir, 'build me a game about trains');
    assert.strictEqual(second.stdout.trim(), '', 'the same offer must not repeat');
  } finally {
    cleanup(dir);
  }
});

test('REGISTRATION AND REMOVAL AGREE, statically (FF-B518, 4th instance)', () => {
  // This drift has now happened 3 times: issue 941, FF-B24, FF-B511. It happened
  // a 4th time while this hook was being written, and was caught only by running
  // a real uninstall: the file was deleted and the settings entry survived,
  // pointing at nothing. That is the shape that broke 3 of Sean's projects.
  //
  // 3 lists have to agree. The event list is now DERIVED by bin/install.js from
  // the registration side's export rather than restated, so this arm requires it
  // through the module instead of grepping the installer's source: a grep would
  // pass for a file that declares the right literal and never uses it.
  const { HOOKS_TO_COPY } = require(path.join(ROOT, 'scripts', 'build-hooks.js'));
  const hooksSurface = require(
    path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'runtime-hooks-surface.cjs'),
  );
  const { isManagedHookCommand } = require(
    path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'shell-command-projection.cjs'),
  );

  //  1. the file ships
  assert.ok(HOOKS_TO_COPY.includes('ferrox-offer.js'), 'the hook must be in the copy set');

  //  2. its EVENT is in the single managed set both sides use
  const events = hooksSurface.MANAGED_SETTINGS_HOOK_EVENTS;
  assert.ok(Array.isArray(events), 'the registration side must export its managed event set');
  assert.ok(events.length >= 12, `managed event set must be real, got ${events.length}`);
  assert.ok(
    events.includes('UserPromptSubmit'),
    'the offer hook registers on UserPromptSubmit; without it here, uninstall leaves the entry',
  );

  //  3. its COMMAND is recognised as managed, or the strip walks past it
  assert.strictEqual(
    isManagedHookCommand('"node" "$CLAUDE_PROJECT_DIR"/.claude/hooks/ferrox-offer.js',
      { surface: 'settings-json' }),
    true,
    'the strip filters on isManagedHookCommand; an unrecognised hook is never removed',
  );
});

test('THE HOOK IS SILENT MID FLIGHT, proven against a state that DOES classify as executing', () => {
  // The first version of this arm used a fixture with no ROADMAP.md, so the
  // classifier returned `needs-first-phase` and the flight brake was never
  // actually exercised. The roadmap and the phase count are both required.
  const dir = scratchProject({
    '.planning/config.json': '{"runtime":"claude"}',
    '.planning/ROADMAP.md': '# Roadmap\n## Phase 1: One\n## Phase 2: Two\n',
    '.planning/STATE.md': '---\nstatus: executing\ncurrent_phase: 2\ntotal_phases: 5\n---\n# State\n',
  });
  try {
    const smart = require(path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'smart-entry.cjs'));
    const situation = smart.classify(smart.detectSignals(dir));
    // Assert the PRECONDITION, so this arm cannot pass by mis-classifying.
    assert.strictEqual(situation, 'executing', `fixture must be mid flight, got ${situation}`);

    const r = runHook(dir, 'build me a game about trains');
    assert.strictEqual(r.stdout.trim(), '', 'must not interrupt work in progress');
  } finally {
    cleanup(dir);
  }
});
