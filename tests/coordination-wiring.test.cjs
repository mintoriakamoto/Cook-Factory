'use strict';

/**
 * Acceptance tests for the coordination wiring (04-06).
 *
 * This is a file-reading test — it asserts the DOCUMENTED PROTOCOL is actually
 * present and greppable, so the coordination model cannot silently rot or
 * over-claim. It proves four things:
 *   1. coordination.md documents all five coord verbs + a ferrox_run query
 *      coord.* usage token.
 *   2. The mechanism-vs-protocol honesty: the verbs are NOT yet un-bypassable and
 *      must be consulted as protocol (Phase-5 / FF-B10 caveat present).
 *   3. COORD-01 honest scope: the shipped worktree one-writer guards exist and are
 *      non-empty, coordination.md says coord.ownership-check backs them, AND the
 *      explicit worktrees-DISABLED caveat is present (no silent over-claim of a
 *      live parallel run).
 *   4. Wave/commit wiring: execute-phase.md cites coord.hot-seam-check and
 *      coord.ownership-check; git-planning-commit.md cites coord.shared-write-check.
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

const COORD_MD = 'ferrox-core/references/coordination.md';
const EXECUTE_PHASE_MD = 'ferrox-core/workflows/execute-phase.md';
const GIT_COMMIT_MD = 'ferrox-core/references/git-planning-commit.md';
const WT_PATH_SAFETY_MD = 'ferrox-core/references/worktree-path-safety.md';
const WT_BRANCH_CHECK_MD = 'ferrox-core/references/worktree-branch-check.md';

const FIVE_VERBS = [
  'coord.ownership-check',
  'coord.hot-seam-check',
  'coord.alloc-migration',
  'coord.check-migration',
  'coord.shared-write-check',
];

test('coordination.md exists and documents all five coord verbs + a usage token', () => {
  assert.ok(exists(COORD_MD), `${COORD_MD} must exist`);
  const c = read(COORD_MD);
  assert.ok(c.trim().length > 0, 'coordination.md must be non-empty');
  for (const verb of FIVE_VERBS) {
    assert.ok(c.includes(verb), `coordination.md must document ${verb}`);
  }
  // A real ferrox_run query coord.* usage block, not just a bare mention.
  assert.match(
    c,
    /ferrox_run query coord\./,
    'coordination.md must contain a "ferrox_run query coord." usage token',
  );
});

test('coordination.md is honest: verbs are consulted PROTOCOL, not yet un-bypassable (Phase-5 / FF-B10)', () => {
  const c = read(COORD_MD);
  assert.ok(
    /not yet un-bypassable/i.test(c),
    'coordination.md must state the verbs are not yet un-bypassable at runtime',
  );
  assert.ok(
    /FF-B10/.test(c),
    'coordination.md must cite FF-B10 (Phase-5 strength-gate) as where un-bypassable enforcement lands',
  );
  assert.ok(
    /Phase-5/i.test(c),
    'coordination.md must scope un-bypassable enforcement to Phase-5',
  );
  assert.ok(
    /MUST consult/i.test(c) || /must be consulted/i.test(c),
    'coordination.md must state the verbs MUST be consulted as protocol',
  );
});

test('COORD-01 honest scope: shipped one-writer guards exist, ownership-check backs them, worktrees-OFF caveat explicit', () => {
  // The shipped guards must exist and be non-empty (no silent claim of guards that are missing).
  for (const guard of [WT_PATH_SAFETY_MD, WT_BRANCH_CHECK_MD]) {
    assert.ok(exists(guard), `${guard} (shipped COORD-01 guard) must exist`);
    assert.ok(read(guard).trim().length > 0, `${guard} must be non-empty`);
  }

  const c = read(COORD_MD);
  // ownership-check must be documented as the runtime backing of the one-writer guarantee.
  assert.ok(
    /coord\.ownership-check/.test(c) && /one-writer/i.test(c),
    'coordination.md must document coord.ownership-check backing the one-writer guarantee',
  );
  assert.ok(
    /COORD-01/.test(c),
    'coordination.md must have a COORD-01 section',
  );
  // The explicit worktrees-OFF caveat — the anti-over-claim assertion (T-04-15).
  assert.ok(
    /worktrees are DISABLED/i.test(c),
    'coordination.md must state worktrees are DISABLED on this build',
  );
  assert.ok(
    /NOT by a live parallel worktree run/i.test(c) ||
      /no live parallel/i.test(c),
    'coordination.md must state COORD-01 is verified by inspection + ownership check, NOT a live parallel run',
  );
});

test('wave/commit wiring: execute-phase.md cites hot-seam-check + ownership-check; git-planning-commit.md cites shared-write-check', () => {
  const w = read(EXECUTE_PHASE_MD);
  assert.ok(
    w.includes('coord.hot-seam-check'),
    'execute-phase.md must cite coord.hot-seam-check (consult before a wave parallelizes)',
  );
  assert.ok(
    w.includes('coord.ownership-check'),
    'execute-phase.md must cite coord.ownership-check (consult after each plan completes)',
  );

  const g = read(GIT_COMMIT_MD);
  assert.ok(
    g.includes('coord.shared-write-check'),
    'git-planning-commit.md sole-writer rule must cite coord.shared-write-check',
  );
});

test('doc/code token consistency: coordination.md documents ONLY the decision tokens the coord verbs emit (Fix 2)', () => {
  const c = read(COORD_MD);
  // Real terminal tokens the cores emit:
  //   ownership-check   -> ok / wave-invalidating
  //   check-migration   -> valid / rejected-uncentral
  //   hot-seam-check    -> serialize-global / parallel-ok
  //   shared-write-check-> forbidden / allowed
  assert.ok(c.includes('wave-invalidating'), 'coordination.md must document the ownership-check "wave-invalidating" token');
  assert.ok(/"decision":\s*"ok"/.test(c), 'coordination.md must document the ownership-check "ok" token');
  assert.ok(c.includes('rejected-uncentral'), 'coordination.md must document the check-migration "rejected-uncentral" token');
  // NO coord verb ever emits a bare "invalid" decision — its presence is doc/code drift.
  assert.ok(
    !/"decision":\s*"invalid"/.test(c),
    'coordination.md must NOT document a "decision":"invalid" token — no coord verb emits it',
  );
});

test('doc/code token consistency: execute-phase.md gates the ownership consult on wave-invalidating, not "not valid" (Fix 2)', () => {
  const w = read(EXECUTE_PHASE_MD);
  assert.ok(
    /wave-invalidating/.test(w),
    'execute-phase.md ownership consult must reference the real wave-invalidating decision',
  );
  assert.ok(
    !/is not `valid`/.test(w),
    'execute-phase.md must NOT gate the ownership consult on "is not `valid`" — coord.ownership-check emits ok / wave-invalidating, never `valid`',
  );
});

test('worktree-path-safety.md cross-references ownership-check with the honest caveat', () => {
  const p = read(WT_PATH_SAFETY_MD);
  assert.ok(
    p.includes('coord.ownership-check'),
    'worktree-path-safety.md must reference coord.ownership-check as the runtime backing',
  );
  assert.ok(
    /worktrees are DISABLED/i.test(p),
    'worktree-path-safety.md must keep the honest worktrees-off caveat',
  );
});
