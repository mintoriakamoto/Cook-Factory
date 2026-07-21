'use strict';

/**
 * UGE-04 red-green tests — the pure ratcheted-climb state machine (ANVIL-PORT-SPEC.md §3).
 *
 * Port-fidelity semantics under test, each with a dedicated case:
 *   - better(): strict > on score[0]; at equal score accept ONLY a STRICT SUBSET of fails
 *     (set semantics on FULL untruncated check strings). NEVER compare lengths — the documented
 *     oscillation bug has a dedicated anti-ping-pong regression test.
 *   - probe -> ensemble(on failure) -> ratcheted surgical climb -> single consolidation -> stop.
 *   - target = first failing check with an untried model; model order = untried cheap sorted by
 *     wins desc (tie: cheap order); escalate to ladder only when cheap is exhausted for the target.
 *   - tried-memory keyed on FULL check string, persists across accepts, pruned to still-failing
 *     checks on accept, fully reset on consolidation accept. wins[model]++ on ratchet accepts.
 *   - stops: green / budget (call count) / plateau (after the one consolidation) / no-seed.
 *
 * PURE: decisions only — no I/O, no model calls, no clock. applyResult returns a NEW state.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createClimbState, betterCandidate, nextStep, applyResult } = require('../ferrox-core/bin/lib/gate-climb.cjs');

/** Drive a fresh state through a failed probe so tests start in the climb phase. */
function climbStateAfterProbe({ cheap, ladder = [], budget = 30, seedN = 1, fails, score = [1, fails.length + 1] }) {
  let s = createClimbState({ cheap, ladder, budget, seedN });
  const step = nextStep(s);
  assert.equal(step.action, 'probe');
  return applyResult(s, step, { text: 'probe-text', score, fails, accepted: true });
}

// ---------- betterCandidate: the two ratchet invariants ----------

test('betterCandidate: anything beats no best at all', () => {
  assert.equal(betterCandidate({ score: [0, 5], fails: ['a', 'b'] }, null), true);
  assert.equal(betterCandidate({ score: [0, 5], fails: ['a'] }, undefined), true);
});

test('betterCandidate: strict > on score[0] accepts — even with MORE fails listed', () => {
  const best = { score: [3, 7], fails: ['a'] };
  assert.equal(betterCandidate({ score: [4, 7], fails: ['b', 'c', 'd'] }, best), true);
});

test('betterCandidate: lower score rejects — even with subset fails', () => {
  const best = { score: [4, 7], fails: ['a', 'b'] };
  assert.equal(betterCandidate({ score: [3, 7], fails: ['a'] }, best), false);
});

test('betterCandidate: equal score, no change rejects (strict >, not >=)', () => {
  const best = { score: [4, 7], fails: ['a', 'b'] };
  assert.equal(betterCandidate({ score: [4, 7], fails: ['a', 'b'] }, best), false);
});

test('betterCandidate: equal score + STRICT SUBSET of fails accepts (fixed >=1, introduced 0)', () => {
  const best = { score: [4, 7], fails: ['a', 'b', 'c'] };
  assert.equal(betterCandidate({ score: [4, 7], fails: ['a', 'c'] }, best), true);
  assert.equal(betterCandidate({ score: [4, 7], fails: [] }, best), true);
});

test('betterCandidate: equal score + superset or overlap with a NEW fail rejects', () => {
  const best = { score: [4, 7], fails: ['a', 'b'] };
  assert.equal(betterCandidate({ score: [4, 7], fails: ['a', 'b', 'c'] }, best), false);
  assert.equal(betterCandidate({ score: [4, 7], fails: ['a', 'z'] }, best), false);
});

test('betterCandidate: NEVER compares lengths — fewer fails but not a subset rejects', () => {
  const best = { score: [4, 7], fails: ['a', 'b', 'c'] };
  // one fail vs three, but 'z' is a NEW fail: length-comparison would accept, set-subset must not
  assert.equal(betterCandidate({ score: [4, 7], fails: ['z'] }, best), false);
});

test('betterCandidate: set semantics — duplicate fail strings are deduped', () => {
  const best = { score: [4, 7], fails: ['a', 'b'] };
  assert.equal(betterCandidate({ score: [4, 7], fails: ['a', 'a'] }, best), true);
  // dupes of the same set are NOT a strict subset
  assert.equal(betterCandidate({ score: [4, 7], fails: ['a', 'a', 'b'] }, best), false);
});

test('betterCandidate: full untruncated check strings — long names differing late are distinct', () => {
  const prefix = 'test_parse_csv_with_quoted_multiline_fields_and_embedded_delimiters_case_';
  const best = { score: [4, 7], fails: [`${prefix}A`, `${prefix}B`] };
  // same 74-char prefix; only the tail differs — must be treated as a NEW fail, so reject
  assert.equal(betterCandidate({ score: [4, 7], fails: [`${prefix}C`] }, best), false);
  assert.equal(betterCandidate({ score: [4, 7], fails: [`${prefix}A`] }, best), true);
});

test('regression: anti-oscillation — equal-count different fails must NOT ping-pong', () => {
  const candA = { score: [5, 7], fails: ['check-one', 'check-two'] };
  const candB = { score: [5, 7], fails: ['check-two', 'check-three'] };
  // neither is a strict subset of the other -> neither ever displaces the other
  assert.equal(betterCandidate(candB, candA), false);
  assert.equal(betterCandidate(candA, candB), false);
  // simulate the old length-based loop: best must stay pinned forever
  let best = candA;
  for (let i = 0; i < 20; i++) {
    const challenger = i % 2 === 0 ? candB : candA;
    if (betterCandidate(challenger, best)) best = challenger;
  }
  assert.deepEqual(best, candA);
});

test('betterCandidate: garbage input never throws', () => {
  assert.doesNotThrow(() => betterCandidate(undefined, null));
  assert.doesNotThrow(() => betterCandidate({}, { score: [1, 2], fails: ['a'] }));
  assert.doesNotThrow(() => betterCandidate({ score: 'x', fails: 'y' }, {}));
});

// ---------- createClimbState / probe / ensemble ----------

test('createClimbState: defaults — budget 12, zero calls, nothing consolidated', () => {
  const s = createClimbState({ cheap: ['c1'], ladder: ['L1'] });
  assert.equal(s.budget, 12);
  assert.equal(s.calls, 0);
  assert.equal(s.consolidated, false);
  assert.equal(s.best, null);
});

test('nextStep: fresh state -> probe with cheap[0] (ONE cheap build first)', () => {
  const s = createClimbState({ cheap: ['c1', 'c2'], ladder: [], budget: 12, seedN: 3 });
  assert.deepEqual(nextStep(s), { action: 'probe', model: 'c1' });
});

test('nextStep: no cheap models -> stop no-seed', () => {
  const s = createClimbState({ cheap: [], ladder: ['L1'] });
  assert.deepEqual(nextStep(s), { action: 'stop', reason: 'no-seed' });
});

test('probe green on first call -> stop green (the dominant cost saver)', () => {
  let s = createClimbState({ cheap: ['c1'], ladder: [], budget: 12, seedN: 3 });
  const step = nextStep(s);
  s = applyResult(s, step, { text: 'good', score: [5, 5], fails: [], accepted: true });
  assert.equal(s.calls, 1);
  assert.deepEqual(nextStep(s), { action: 'stop', reason: 'green' });
});

test('probe failure -> ensemble with cheap[1..seedN)', () => {
  const s = climbStateAfterProbe({ cheap: ['c1', 'c2', 'c3', 'c4'], seedN: 3, fails: ['fA'] });
  assert.deepEqual(nextStep(s), { action: 'ensemble', models: ['c2', 'c3'] });
});

test('ensemble results: internal ratchet keeps the best; calls count each build', () => {
  let s = climbStateAfterProbe({ cheap: ['c1', 'c2', 'c3'], seedN: 3, fails: ['fA', 'fB'], score: [1, 3] });
  const step = nextStep(s);
  assert.equal(step.action, 'ensemble');
  s = applyResult(s, step, [
    { model: 'c2', text: 'w', score: [1, 3], fails: ['fA', 'fZ'] }, // equal score, NOT a subset -> rejected
    { model: 'c3', text: 'v', score: [2, 3], fails: ['fB'] }, // strictly better -> accepted
  ]);
  assert.equal(s.calls, 3);
  assert.deepEqual(s.best.fails, ['fB']);
  assert.equal(s.best.text, 'v');
  assert.equal(s.wins.c3, 1);
  assert.equal(s.wins.c2 || 0, 0);
  assert.equal(nextStep(s).action, 'surgical');
});

test('ensemble skipped when there are no cheap[1..seedN) models -> straight to surgical', () => {
  const s = climbStateAfterProbe({ cheap: ['c1'], seedN: 3, fails: ['fA'] });
  assert.equal(nextStep(s).action, 'surgical');
});

// ---------- surgical climb: target + model selection ----------

test('surgical: target = FIRST failing check; others capped at 8; tier cheap', () => {
  const fails = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}`);
  const s = climbStateAfterProbe({ cheap: ['c1', 'c2'], fails });
  const step = nextStep(s);
  assert.equal(step.action, 'surgical');
  assert.equal(step.target, 'f00');
  assert.equal(step.tier, 'cheap');
  assert.equal(step.others.length, 8);
  assert.deepEqual(step.others, fails.slice(1, 9));
  assert.ok(!step.others.includes('f00'));
});

test('surgical: rejected attempt is remembered — same model never retried on that check', () => {
  let s = climbStateAfterProbe({ cheap: ['c1', 'c2'], fails: ['fA'] });
  let step = nextStep(s);
  assert.equal(step.model, 'c1');
  s = applyResult(s, step, { text: 'no', score: [1, 2], fails: ['fA'], accepted: false });
  step = nextStep(s);
  assert.equal(step.action, 'surgical');
  assert.equal(step.target, 'fA');
  assert.equal(step.model, 'c2');
});

test('surgical: model order = untried cheap sorted by wins desc (tie: cheap order)', () => {
  // c2 lands an accept -> c2 outranks c1 for the NEXT fresh target
  let s = climbStateAfterProbe({ cheap: ['c1', 'c2'], fails: ['fA', 'fB'], score: [1, 3] });
  let step = nextStep(s); // fA with c1 (all wins 0 -> cheap order)
  assert.deepEqual([step.target, step.model], ['fA', 'c1']);
  s = applyResult(s, step, { text: 'no', score: [1, 3], fails: ['fA', 'fB'], accepted: false });
  step = nextStep(s); // fA with c2
  assert.deepEqual([step.target, step.model], ['fA', 'c2']);
  s = applyResult(s, step, { text: 'yes', score: [2, 3], fails: ['fB'], accepted: true }); // wins.c2 = 1
  step = nextStep(s); // fresh target fB: c2 (1 win) outranks c1 (0)
  assert.deepEqual([step.target, step.model], ['fB', 'c2']);
});

test('surgical: escalate ONLY when cheap exhausted for the target — per-check, ladder order', () => {
  let s = climbStateAfterProbe({ cheap: ['c1'], ladder: ['fable', 'opus'], fails: ['fA', 'fB'], score: [0, 2] });
  let step = nextStep(s);
  assert.deepEqual([step.target, step.model, step.tier], ['fA', 'c1', 'cheap']);
  s = applyResult(s, step, { text: 'no', score: [0, 2], fails: ['fA', 'fB'], accepted: false });
  step = nextStep(s); // cheap exhausted for fA -> escalate, ladder order
  assert.deepEqual([step.target, step.model, step.tier], ['fA', 'fable', 'escalate']);
  s = applyResult(s, step, { text: 'no', score: [0, 2], fails: ['fA', 'fB'], accepted: false });
  step = nextStep(s);
  assert.deepEqual([step.target, step.model, step.tier], ['fA', 'opus', 'escalate']);
  s = applyResult(s, step, { text: 'no', score: [0, 2], fails: ['fA', 'fB'], accepted: false });
  step = nextStep(s); // fA fully exhausted -> move to fB, back at cheap tier
  assert.deepEqual([step.target, step.model, step.tier], ['fB', 'c1', 'cheap']);
});

test('tried-memory: keyed on FULL check string (long names differing late stay distinct)', () => {
  const prefix = 'test_roundtrip_of_quoted_fields_with_embedded_newlines_and_escaped_quotes_case_';
  let s = climbStateAfterProbe({ cheap: ['c1'], fails: [`${prefix}alpha`, `${prefix}beta`], score: [0, 2] });
  let step = nextStep(s);
  assert.equal(step.target, `${prefix}alpha`);
  s = applyResult(s, step, { text: 'no', score: [0, 2], fails: [`${prefix}alpha`, `${prefix}beta`], accepted: false });
  step = nextStep(s); // alpha exhausted for c1; beta must still be fully untried
  assert.equal(step.target, `${prefix}beta`);
  assert.equal(step.model, 'c1');
});

test('tried-memory: persists across accepts; pruned to still-failing checks', () => {
  let s = climbStateAfterProbe({ cheap: ['c1', 'c2'], fails: ['fA', 'fB'], score: [1, 3] });
  let step = nextStep(s); // fA/c1
  s = applyResult(s, step, { text: 'no', score: [1, 3], fails: ['fA', 'fB'], accepted: false });
  step = nextStep(s); // fB is NOT the target yet; fA still has c2 untried
  assert.deepEqual([step.target, step.model], ['fA', 'c2']);
  // c2 attempt keeps fB failing but ALSO keeps fA -> rejected; then c1 fixes fA via accept
  s = applyResult(s, step, { text: 'no', score: [1, 3], fails: ['fA', 'fB'], accepted: false });
  step = nextStep(s); // fA exhausted (no ladder) -> target fB, model c1
  assert.deepEqual([step.target, step.model], ['fB', 'c1']);
  s = applyResult(s, step, { text: 'better', score: [2, 3], fails: ['fA'], accepted: true });
  // fB now passes (pruned from tried); fA STILL failing — its tried memory must persist:
  // c1 and c2 were both tried on fA before the accept, so fA has no untried cheap left.
  step = nextStep(s);
  assert.equal(step.action, 'consolidate');
});

test('acceptance defaults to the ratchet when the caller omits `accepted`', () => {
  let s = climbStateAfterProbe({ cheap: ['c1', 'c2'], fails: ['fA', 'fB'], score: [1, 3] });
  let step = nextStep(s);
  // equal score, non-subset fails, no accepted flag -> internally rejected
  s = applyResult(s, step, { text: 'swap', score: [1, 3], fails: ['fA', 'fZ'] });
  assert.deepEqual(s.best.fails, ['fA', 'fB']);
  step = nextStep(s);
  // strict subset, no accepted flag -> internally accepted
  s = applyResult(s, step, { text: 'sub', score: [1, 3], fails: ['fB'] });
  assert.deepEqual(s.best.fails, ['fB']);
});

// ---------- consolidation, plateau, budget, purity ----------

test('consolidation: fires once at plateau — best-track-record cheap model, first 10 fails', () => {
  const fails = Array.from({ length: 12 }, (_, i) => `g${String(i).padStart(2, '0')}`);
  let s = climbStateAfterProbe({ cheap: ['c1'], fails, score: [0, 12], budget: 40 });
  // exhaust c1 on every failing check
  let step = nextStep(s);
  while (step.action === 'surgical') {
    s = applyResult(s, step, { text: 'no', score: [0, 12], fails, accepted: false });
    step = nextStep(s);
  }
  assert.equal(step.action, 'consolidate');
  assert.equal(step.model, 'c1');
  assert.equal(step.fails.length, 10);
  assert.deepEqual(step.fails, fails.slice(0, 10));
});

test('consolidation accept: FULL tried reset — climbing resumes fresh', () => {
  let s = climbStateAfterProbe({ cheap: ['c1'], fails: ['fA'], score: [0, 2], budget: 20 });
  let step = nextStep(s);
  s = applyResult(s, step, { text: 'no', score: [0, 2], fails: ['fA'], accepted: false });
  step = nextStep(s);
  assert.equal(step.action, 'consolidate');
  s = applyResult(s, step, { text: 'rebuilt', score: [1, 2], fails: ['fB'], accepted: true });
  assert.equal(s.consolidated, true);
  step = nextStep(s); // tried fully reset -> c1 is available again, now for fB
  assert.deepEqual([step.action, step.target, step.model], ['surgical', 'fB', 'c1']);
});

test('consolidation reject -> second plateau stops with best-so-far intact', () => {
  let s = climbStateAfterProbe({ cheap: ['c1'], fails: ['fA'], score: [0, 2], budget: 20 });
  let step = nextStep(s);
  s = applyResult(s, step, { text: 'no', score: [0, 2], fails: ['fA'], accepted: false });
  step = nextStep(s);
  assert.equal(step.action, 'consolidate');
  s = applyResult(s, step, { text: 'worse', score: [0, 2], fails: ['fA', 'fC'], accepted: false });
  assert.equal(s.consolidated, true);
  assert.deepEqual(nextStep(s), { action: 'stop', reason: 'plateau' });
  assert.deepEqual(s.best.fails, ['fA']); // best-so-far always survives
});

test('budget: call count exhausts -> stop budget', () => {
  let s = climbStateAfterProbe({ cheap: ['c1', 'c2'], fails: ['fA'], budget: 2 });
  const step = nextStep(s);
  assert.equal(step.action, 'surgical');
  s = applyResult(s, step, { text: 'no', score: [1, 2], fails: ['fA'], accepted: false });
  assert.equal(s.calls, 2);
  assert.deepEqual(nextStep(s), { action: 'stop', reason: 'budget' });
});

test('green wins over budget: a green best stops green even at budget exhaustion', () => {
  let s = climbStateAfterProbe({ cheap: ['c1'], fails: ['fA'], budget: 2 });
  const step = nextStep(s);
  s = applyResult(s, step, { text: 'done', score: [2, 2], fails: [], accepted: true });
  assert.equal(s.calls, 2);
  assert.deepEqual(nextStep(s), { action: 'stop', reason: 'green' });
});

test('purity: applyResult returns a NEW state and never mutates its input', () => {
  const s0 = climbStateAfterProbe({ cheap: ['c1', 'c2'], fails: ['fA'] });
  const snapshot = JSON.stringify(s0);
  const step = nextStep(s0);
  const s1 = applyResult(s0, step, { text: 'x', score: [2, 2], fails: [], accepted: true });
  assert.equal(JSON.stringify(s0), snapshot);
  assert.notEqual(s1, s0);
  assert.equal(s1.calls, s0.calls + 1);
});

test('garbage inputs never throw', () => {
  assert.doesNotThrow(() => createClimbState(undefined));
  assert.doesNotThrow(() => createClimbState({ cheap: 'nope', budget: -3, seedN: 'x' }));
  const s = createClimbState({ cheap: ['c1'] });
  assert.doesNotThrow(() => nextStep(s));
  assert.doesNotThrow(() => applyResult(s, { action: 'stop', reason: 'green' }, { text: '', score: [0, 1], fails: [] }));
  assert.doesNotThrow(() => applyResult(s, nextStep(s), {}));
});
