'use strict';

/**
 * Acceptance tests for the strength wiring (05-09).
 *
 * This is a file-reading test — it asserts the DOCUMENTED MODEL is actually
 * present and greppable, so the strength model cannot silently rot or over-claim.
 * It proves five things:
 *   1. strength.md exists, is non-empty, documents all eight strength verbs, and
 *      contains a `ferrox-tools query strength.` usage token.
 *   2. strength.md documents `ferrox-merge-gate-guard.js` as the PreToolUse enforcer
 *      AND states the merge-gate + hook are un-bypassable at the tool layer.
 *   3. The honesty caveats are present — the independent judge is orchestration
 *      protocol (the verb enforces judge ≠ author, it does NOT spawn the agent) and
 *      the mutation harness is bounded.
 *   4. gates.md and ship.md both cite strength.merge-gate at the ship/merge point.
 *   5. hooks/hooks.json registers ferrox-merge-gate-guard.js under PreToolUse.
 *
 * Every assertion is a hard assert. node --test exits non-zero on any failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const STRENGTH_MD = 'ferrox-core/references/strength.md';
const GATES_MD = 'ferrox-core/references/gates.md';
const SHIP_MD = 'ferrox-core/workflows/ship.md';
const HOOKS_JSON = 'hooks/hooks.json';

// The eight locked-name strength verbs (must match command-aliases.cts /
// strength-command-router.cts exactly — the Phase-4 doc/code token lesson).
const EIGHT_VERBS = [
  'strength.judge-check',
  'strength.severity-route',
  'strength.receipt',
  'strength.verify-receipt',
  'strength.mutation-check',
  'strength.burndown-check',
  'strength.coverage-source',
  'strength.merge-gate',
];

test('strength.md exists, documents all eight strength verbs + a ferrox-tools usage token', () => {
  assert.ok(exists(STRENGTH_MD), `${STRENGTH_MD} must exist`);
  const s = read(STRENGTH_MD);
  assert.ok(s.trim().length > 0, 'strength.md must be non-empty');
  for (const verb of EIGHT_VERBS) {
    assert.ok(s.includes(verb), `strength.md must document ${verb}`);
  }
  // A real usage token, not just a bare mention of the verbs.
  assert.match(
    s,
    /ferrox-tools query strength\./,
    'strength.md must contain a "ferrox-tools query strength." usage token',
  );
});

test('strength.md documents ONLY the decision tokens the strength cores emit (doc/code consistency)', () => {
  const s = read(STRENGTH_MD);
  // Real terminal tokens the cores emit:
  //   judge-check     -> accepted / rejected-self-judged
  //   severity-route  -> block / synthesize-high / route-backlog
  //   verify-receipt  -> missing / never-red / valid
  //   mutation-check  -> killed / survived
  //   burndown-check  -> ok / blocked
  //   merge-gate      -> pass / block (+ reasons[])
  for (const tok of [
    'rejected-self-judged',
    'synthesize-high',
    'route-backlog',
    'never-red',
    'survived',
    'input-verb-error',
  ]) {
    assert.ok(s.includes(tok), `strength.md must document the "${tok}" decision token`);
  }
  // No strength verb emits a bare "rejected" or "invalid" decision — their presence
  // as an emitted decision token would be doc/code drift.
  assert.ok(
    !/"decision":\s*"invalid"/.test(s),
    'strength.md must NOT document a "decision":"invalid" token — no strength verb emits it',
  );
  assert.ok(
    !/"decision":\s*"rejected"/.test(s),
    'strength.md must NOT document a bare "decision":"rejected" token — judge-check emits "rejected-self-judged"',
  );
});

test('strength.md names ferrox-merge-gate-guard.js as the PreToolUse enforcer, un-bypassable at the tool layer', () => {
  const s = read(STRENGTH_MD);
  assert.ok(
    s.includes('ferrox-merge-gate-guard.js'),
    'strength.md must cite ferrox-merge-gate-guard.js as the enforcing hook',
  );
  assert.ok(
    /PreToolUse/.test(s),
    'strength.md must describe the enforcer as a PreToolUse hook',
  );
  assert.ok(
    /un-bypassable at the tool layer/i.test(s),
    'strength.md must state the merge-gate + hook are un-bypassable at the tool layer',
  );
  assert.ok(
    /fail(s|-| )?closed/i.test(s),
    'strength.md must state the enforcer fails closed',
  );
  assert.ok(
    /FF-B10/.test(s),
    'strength.md must cite FF-B10 as the un-bypassable enforcement backlog item',
  );
});

test('strength.md is honest: independent judge is orchestration protocol (verb enforces judge ≠ author, not spawning)', () => {
  const s = read(STRENGTH_MD);
  assert.ok(
    /orchestration protocol/i.test(s),
    'strength.md must state the independent judge is orchestration protocol',
  );
  // The verb enforces judge ≠ author — it does NOT spawn the agent.
  assert.ok(
    /judge\s*(≠|!=|not\s+equal|≠\s*author)/i.test(s) || /judge ≠ author/.test(s),
    'strength.md must state the verb only enforces judge ≠ author',
  );
  assert.ok(
    /does\s*\**\s*NOT\s*\**\s*spawn|not\s+claim\s+the\s+verb\s+spawns|verb\s+does\s+not\s+spawn/i.test(s),
    'strength.md must state the verb does NOT spawn the independent judge agent',
  );
});

test('strength.md is honest: the mutation harness is bounded, not a full framework', () => {
  const s = read(STRENGTH_MD);
  assert.ok(
    /bounded/i.test(s),
    'strength.md must state the mutation harness is bounded',
  );
  assert.ok(
    /not a (full|general) mutation-testing framework|not a full framework/i.test(s),
    'strength.md must state the mutation harness is NOT a full mutation-testing framework',
  );
});

test('ship/merge wiring: gates.md and ship.md both cite strength.merge-gate at the ship/merge point', () => {
  const g = read(GATES_MD);
  assert.ok(
    g.includes('strength.merge-gate'),
    'gates.md must cite strength.merge-gate at the ship/merge point',
  );
  assert.ok(
    /ferrox-merge-gate-guard\.js/.test(g),
    'gates.md must note the ferrox-merge-gate-guard.js hook enforces the merge gate',
  );

  const sh = read(SHIP_MD);
  assert.ok(
    sh.includes('strength.merge-gate'),
    'ship.md must consult strength.merge-gate before creating/merging the PR',
  );
  assert.ok(
    /ferrox-merge-gate-guard\.js/.test(sh),
    'ship.md must note the PreToolUse hook independently enforces the merge gate',
  );
});

test('hooks.json registers ferrox-merge-gate-guard.js under PreToolUse', () => {
  const raw = read(HOOKS_JSON);
  const parsed = JSON.parse(raw);
  const preToolUse = parsed.hooks && parsed.hooks.PreToolUse;
  assert.ok(Array.isArray(preToolUse), 'hooks.json must have a PreToolUse array');
  const commands = preToolUse
    .flatMap((entry) => (Array.isArray(entry.hooks) ? entry.hooks : []))
    .map((h) => h.command || '');
  assert.ok(
    commands.some((c) => c.includes('ferrox-merge-gate-guard.js')),
    'hooks.json PreToolUse must register ferrox-merge-gate-guard.js',
  );
});
