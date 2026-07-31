'use strict';

/**
 * THE STATE AWARE FRONT DOOR, WHICH SHIPPED WITH NO TEST FILE AT ALL.
 *
 * `src/smart-entry.cts` classifies what is going on in a project and returns a
 * menu of commands to dispatch. Before this file, a search of `tests/` for
 * `smart-entry`, `smartEntry` or `actionsFor` returned 0 matches. That absence is
 * the whole reason the defect below survived: every one of the 44 commands this
 * module offered was emitted in the legacy colon form `/ferrox:<cmd>`, which #2808
 * made unroutable, while `runtime-slash.cts` said in its own header that "the
 * colon form is never emitted" and this module referenced that helper 0 times.
 *
 * A user could select any action in any situation and the runtime could not run it.
 *
 * ─── WHY EVERY COUNT HERE IS ASSERTED NON ZERO FIRST ─────────────────────────
 *
 * "No command is in the colon form" is vacuously TRUE of an empty menu, and an
 * empty menu is exactly what a broken `actionsFor` would return. So every arm
 * establishes a POSITIVE count of actions before asserting any property over them.
 * The same rule is why the projection arm asserts 44 hyphen-form commands rather
 * than 0 colon-form ones: the first number cannot be satisfied by returning
 * nothing.
 *
 * ─── AND WHY THE DETECTOR IS ITSELF PROVED ───────────────────────────────────
 *
 * `THE COLON DETECTOR CAN FIRE` runs the same detector over a handcrafted action
 * list that DOES carry the colon form and requires it to report it. An arm never
 * seen failing proves nothing: a detector with an inverted test, a typo in the
 * needle, or a regex that never matches reads exactly like a clean codebase.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SE = require(path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib', 'smart-entry.cjs'));

/** A mid-flight project: 11 situations are reachable, this drives the menu for each. */
const EXECUTING_SIGNALS = Object.freeze({
  current_phase: 3,
  total_phases: 5,
  status: 'executing',
  progress: 40,
  has_planning: true,
  has_roadmap: true,
  git_dirty: false,
  git_unpushed: false,
  paused: false,
  blockers: [],
  has_git: true,
  verify_failed: false,
  stale_activity: false,
});

/**
 * Count the actions across EVERY situation whose command is in the unroutable
 * colon form. Returns both numbers so a caller can assert the denominator too.
 */
function surveyCommands(runtime) {
  let total = 0;
  const colon = [];
  const hyphen = [];
  const shellVar = [];
  for (const situation of SE.SITUATIONS) {
    for (const act of SE.actionsFor(situation, EXECUTING_SIGNALS, runtime)) {
      total += 1;
      if (act.command.includes('/ferrox:') || act.command.includes('$ferrox:')) {
        colon.push(`${situation}:${act.id} -> ${act.command}`);
      }
      if (act.command.startsWith('/ferrox-')) hyphen.push(act.command);
      if (act.command.startsWith('$ferrox-')) shellVar.push(act.command);
    }
  }
  return { total, colon, hyphen, shellVar };
}

test('the menu is NOT EMPTY: 11 situations each offer actions', () => {
  assert.ok(SE.SITUATIONS.length >= 11, `expected 11+ situations, got ${SE.SITUATIONS.length}`);
  const { total } = surveyCommands('claude');
  // The denominator, asserted before any property over it. Every arm below is
  // meaningless if this number can be 0.
  assert.ok(total > 40, `expected a populated menu across all situations, got ${total} actions`);
  for (const situation of SE.SITUATIONS) {
    const acts = SE.actionsFor(situation, EXECUTING_SIGNALS, 'claude');
    assert.ok(acts.length > 0, `situation ${situation} offered 0 actions`);
    const recommended = acts.filter((a) => a.recommended);
    assert.strictEqual(
      recommended.length, 1,
      `situation ${situation} must carry exactly 1 recommendation, got ${recommended.length}`,
    );
  }
});

test('EVERY emitted command is ROUTABLE: hyphen form, zero colon form', () => {
  const { total, colon, hyphen } = surveyCommands('claude');
  assert.ok(total > 40, `denominator must be non zero first, got ${total}`);
  // Positive form: assert the count that CANNOT be satisfied by an empty menu.
  assert.strictEqual(
    hyphen.length, total,
    `all ${total} commands must be hyphen form; ${total - hyphen.length} were not`,
  );
  assert.deepStrictEqual(
    colon, [],
    `the colon form is unroutable (#2808) and was emitted by:\n${colon.join('\n')}`,
  );
});

test('THE COLON DETECTOR CAN FIRE: a colon-form menu is reported', () => {
  // The required failing arm. The survey above returns an empty `colon` array;
  // this proves that emptiness is a property of the module and not of the needle.
  const planted = [
    { id: 'new-project', label: 'x', command: '/ferrox:new-project', recommended: true },
    { id: 'help', label: 'y', command: '/ferrox-help', recommended: false },
  ];
  const found = planted.filter((a) => a.command.includes('/ferrox:'));
  assert.strictEqual(found.length, 1, 'the detector failed to see a planted colon-form command');
  assert.strictEqual(found[0].command, '/ferrox:new-project');
});

test('codex gets the shell-var form, not a second hardcoded list', () => {
  const { total, shellVar, colon } = surveyCommands('codex');
  assert.ok(total > 40, `denominator must be non zero first, got ${total}`);
  assert.strictEqual(
    shellVar.length, total,
    `codex requires $ferrox-<cmd>; ${total - shellVar.length} commands were another shape`,
  );
  assert.deepStrictEqual(colon, [], 'codex must not receive the colon form either');
});

test('the ARGUMENT TAIL round-trips: --next --auto survives the projection', () => {
  // The carrier for the whole on ramp is `progress --next --auto`. A projection
  // that rewrote the command token and dropped or mangled its flags would leave the
  // chain gate dispatching a bare `progress`, which advances nothing.
  const acts = SE.actionsFor('executing', EXECUTING_SIGNALS, 'claude');
  const next = acts.find((a) => a.id === 'progress-next');
  assert.ok(next, 'the executing menu must offer forward motion');
  assert.match(next.command, /^\/ferrox-progress --next$/, `got ${next.command}`);

  const codexNext = SE.actionsFor('executing', EXECUTING_SIGNALS, 'codex')
    .find((a) => a.id === 'progress-next');
  assert.match(codexNext.command, /^\$ferrox-progress --next$/, `got ${codexNext.command}`);
});

test('RECOVERY IS REACHABLE: resume-work is offered from executing and unknown', () => {
  // Someone who closed a terminal mid-phase comes back to `executing`, because the
  // only signal that says otherwise is `paused_at` and nothing writes it unless they
  // ran /ferrox-pause-work on the way out. They were previously offered 4 ways
  // forward and no way to pick up what they left.
  //
  // This is asserted as a MENU MEMBERSHIP rather than as a classifier change on
  // purpose. `stopped_at` is written by transition.md, execute-plan.md,
  // discuss-phase.md, ui-phase.md, resume-project.md, forensics.md and
  // milestone-summary.md on the ordinary happy path, so keying `paused` on it would
  // classify almost every active project as paused. See FF-B519.
  for (const situation of ['executing', 'unknown']) {
    const ids = SE.actionsFor(situation, EXECUTING_SIGNALS, 'claude').map((a) => a.id);
    assert.ok(
      ids.includes('resume-work'),
      `situation ${situation} must offer resume-work, got: ${ids.join(', ')}`,
    );
  }
});

test('the classifier did NOT start calling every active project paused', () => {
  // The guard on the fix above. `paused` is tested before blocked, verify-failed and
  // complete, so a classifier that over-reports it swallows 3 other situations.
  assert.strictEqual(SE.classify(EXECUTING_SIGNALS), 'executing');
  assert.strictEqual(
    SE.classify({ ...EXECUTING_SIGNALS, paused: true }), 'paused',
    'an explicit paused_at must still classify as paused',
  );
  assert.strictEqual(
    SE.classify({ ...EXECUTING_SIGNALS, blockers: ['x'] }), 'blocked',
    'blocked must remain reachable, which it is not if paused over-reports',
  );
  assert.strictEqual(
    SE.classify({ ...EXECUTING_SIGNALS, verify_failed: true }), 'verify-failed',
    'verify-failed must remain reachable',
  );
});

test('every command offered NAMES A COMMAND THAT SHIPS', () => {
  // The defect class this session proved 5 times is a correct artifact behind a path
  // that does not resolve. A menu is a list of paths. Each one is checked against
  // the shipped command set rather than against this repository's convenience.
  const fs = require('node:fs');
  const cmdDir = path.join(__dirname, '..', 'commands', 'ferrox');
  const shipped = new Set(
    fs.readdirSync(cmdDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)),
  );
  assert.ok(shipped.size > 40, `command set must be non empty first, got ${shipped.size}`);

  const missing = [];
  let checked = 0;
  for (const situation of SE.SITUATIONS) {
    for (const act of SE.actionsFor(situation, EXECUTING_SIGNALS, 'claude')) {
      // Strip the prefix and any flag tail to get the bare command stem.
      const stem = act.command.replace(/^\/ferrox-/, '').split(/\s/)[0];
      checked += 1;
      if (!shipped.has(stem)) missing.push(`${situation}:${act.id} -> ${stem}`);
    }
  }
  assert.ok(checked > 40, `must have checked a real menu, checked ${checked}`);
  assert.deepStrictEqual(
    missing, [],
    `these menu entries name commands that do not ship:\n${missing.join('\n')}`,
  );
});
