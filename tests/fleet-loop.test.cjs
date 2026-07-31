'use strict';

/**
 * Phase 19 plan 05 tasks 1 and 2: the dispatch preconditions and the level
 * triggered driver.
 *
 * ─── WHAT THIS FILE REFUSES TO DO ────────────────────────────────────────────
 *
 * D7 names the defect class this project has shipped in every phase that did not
 * guard against it, and the brief names 4 traps that pass trivially HERE
 * specifically. Each one is answered by construction rather than by intention:
 *
 *   an auto land test where the delivery was never clean
 *     -> the clean arm asserts the worker really exited 0 AND that the land seam
 *        was really invoked for that attempt, counted by the seam itself.
 *
 *   a "human is not the closer" assertion that never exercises a human gate
 *     -> the land runs inside the worker's own exit handler with no prompt, no
 *        checkpoint and no caller re-entry, and the case asserts the land
 *        completed inside a single `runLoop` await with no second call.
 *
 *   a driver test that never actually spawns a worker
 *     -> every worker is a REAL child process running a real script from disk,
 *        with a real exit code and, in the abnormal case, a real signal it sends
 *        to itself.
 *
 *   a run record assertion on a log the test itself wrote by hand
 *     -> every assertion below reads a log the DRIVER produced. Nothing here
 *        hand writes a fleet event.
 *
 * ─── THE 3 CHECKS ARE EACH DRIVEN BOTH WAYS ──────────────────────────────────
 *
 * A guard nobody has watched fail is not a guard. Every check has a committed
 * refusing arm and the refusal is OBSERVED rather than inferred: the bypassed
 * serializer arm asserts an overlap was measured, the forked base arm asserts the
 * 2 resolved HEADs really differ, and the forced alive reclaim arm establishes
 * that the holder really is dead BEFORE the probe is made to say otherwise.
 *
 * ─── WHY THE BASE CHECK RUNS AGAINST SCRATCH REPOSITORIES ────────────────────
 *
 * The check creates and removes a REAL worktree, so pointing it at this
 * repository from a test would add and remove worktrees of the tree the suite is
 * running in. Every case below builds its own git repository with its own
 * vendored file count, which also lets the count arm be driven at a value this
 * repository cannot have. The live repository is exercised once, by hand, through
 * `node scripts/fleet-loop.cjs 19 --preflight`, and that result is recorded in
 * the plan summary.
 *
 * ─── TIME ────────────────────────────────────────────────────────────────────
 *
 * The driver takes every instant from an injected clock. Where a case needs a
 * pinned instant it passes `clock: () => PINNED`, which is the caller supplied
 * time contract the whole milestone uses. Where a case measures REAL elapsed
 * overlap across processes, pinning would make the evidence vacuous, so the
 * children read `Date.now()` explicitly and the module under test still never
 * reads a clock of its own.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const loop = require('../scripts/fleet-loop.cjs');
const runlog = require('../ferrox-core/bin/lib/fleet-runlog.cjs');
const boardLib = require('../ferrox-core/bin/lib/fleet-board.cjs');
const runfold = require('../ferrox-core/bin/lib/fleet-runfold.cjs');
const landqueue = require('../ferrox-core/bin/lib/fleet-landqueue.cjs');

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-loop-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here, following tests/fleet-landqueue-race.test.cjs
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

// ── git scratch repositories ────────────────────────────────────────────────

/** Run git in a scratch repository, refusing loudly rather than returning junk. */
function git(cwd, args) {
  const proc = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(
    proc.status, 0,
    `git ${args.join(' ')} failed in ${path.basename(cwd)}: ${proc.stderr}`,
  );
  return proc.stdout.trim();
}

/**
 * A real git repository carrying `vendoredFiles` files under the vendored engine
 * path, with `commits` commits so a prior commit is nameable.
 *
 * The vendored count is a parameter because the count arm has to be driven at a
 * value the real drop does not have, and a check that can only ever be run
 * against a tree that satisfies it is a check nobody has watched refuse.
 */
function makeRepo(label, { vendoredFiles = loop.EXPECTED_VENDORED_FILES, commits = 2 } = {}) {
  const root = scratch(label);
  git(root, ['init', '--quiet', '--initial-branch', 'main']);
  git(root, ['config', 'user.email', 'fleet@example.invalid']);
  git(root, ['config', 'user.name', 'Fleet Preflight']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.hooksPath', path.join(root, '.no-hooks')]);

  const vendorDir = path.join(root, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin');
  fs.mkdirSync(vendorDir, { recursive: true });
  for (let i = 0; i < vendoredFiles; i++) {
    fs.writeFileSync(path.join(vendorDir, `engine-${i}`), `vendored ${i}\n`);
  }
  fs.writeFileSync(path.join(root, 'README.md'), 'scratch\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'vendor drop']);

  const shas = [git(root, ['rev-parse', 'HEAD'])];
  for (let c = 1; c < commits; c++) {
    fs.writeFileSync(path.join(root, `later-${c}.md`), `later ${c}\n`);
    git(root, ['add', '-A']);
    git(root, ['commit', '--quiet', '-m', `later ${c}`]);
    shas.push(git(root, ['rev-parse', 'HEAD']));
  }
  return { root, shas, head: shas[shas.length - 1] };
}

/** How many worktrees this repository currently has, primary included. */
function worktreeCount(root) {
  const porcelain = git(root, ['worktree', 'list', '--porcelain']);
  return porcelain.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).length;
}

// ── the synthetic project the driver runs over ──────────────────────────────

/**
 * A scratch project holding `count` plan files in 1 phase, all in 1 wave so every
 * node is ready at once and capacity is what limits concurrency.
 */
function makeProject(label, { phase = '07', slug = 'synth', count = 6, dependsOn = {} } = {}) {
  const root = scratch(label);
  const phaseDir = path.join(root, '.planning', 'phases', `${phase}-${slug}`);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    const id = `${phase}-${String(i).padStart(2, '0')}`;
    const deps = dependsOn[id] ?? [];
    const frontmatter = [
      '---',
      `phase: ${phase}-${slug}`,
      `plan: ${String(i).padStart(2, '0')}`,
      'type: execute',
      'wave: 1',
      `depends_on: [${deps.join(', ')}]`,
      'files_modified:',
      `  - src/node-${i}.cts`,
      'autonomous: true',
      '---',
      '',
      '<tasks>',
      '<task type="auto">',
      `  <name>node ${i}</name>`,
      '</task>',
      '</tasks>',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(phaseDir, `${id}-PLAN.md`), frontmatter);
  }
  const planning = path.join(root, '.planning');
  return {
    root,
    phase,
    logPath: path.join(planning, 'fleet-runlog.jsonl'),
    projectionPath: path.join(planning, 'fleet-board.json'),
    tokenDir: planning,
  };
}

/**
 * The stub worker, a REAL script run as a REAL child process.
 *
 * argv: sleepMs mode markerDir nodeId attemptId
 *
 * `mode` is `ok` (exit 0), `fail` (exit 1), `signal` (send itself the uncatchable
 * signal), or `fail-once` (exit 1 on attempt 1 for this node, 0 afterwards, using
 * a marker file so the decision survives across processes).
 */
const WORKER_SOURCE = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const [sleepRaw, mode, markerDir, nodeId, attemptId] = process.argv.slice(2);

function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

fs.mkdirSync(markerDir, { recursive: true });
fs.appendFileSync(path.join(markerDir, 'spawned.log'), nodeId + ' ' + attemptId + '\\n');
sleepSync(Number(sleepRaw));

if (mode === 'signal') {
  process.kill(process.pid, 'SIGKILL');
  sleepSync(5000);
}
if (mode === 'fail') { process.exitCode = 1; }
if (mode === 'fail-once') {
  const marker = path.join(markerDir, 'failed-' + nodeId.replace(/[^A-Za-z0-9_.-]/g, '_'));
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'once');
    process.exitCode = 1;
  }
}
`;

/** Write the stub worker to disk once per project and return a spawn seam. */
function stubWorkerSeam(project, { sleepMs = 0, modeOf = () => 'ok' } = {}) {
  const scriptPath = path.join(project.root, 'stub-worker.cjs');
  fs.writeFileSync(scriptPath, WORKER_SOURCE);
  const markerDir = path.join(project.root, 'markers');
  const spawned = [];
  const seam = (ctx) => {
    spawned.push({
      node_id: ctx.nodeId,
      attempt_id: ctx.attemptId,
      worker_id: ctx.workerId,
      lease_epoch: ctx.leaseEpoch,
      // Read the log AT SPAWN TIME. This is what drives the ordering row: the
      // claim has to be in the log already, and reading it off the finished log
      // afterwards would prove only that both events exist.
      claim_present_at_spawn: runlog.readFleetRunlog({ path: project.logPath })
        .some((e) => e.kind === 'claim_acquired' && e.node_id === ctx.nodeId),
      worker_started_present_at_spawn: runlog.readFleetRunlog({ path: project.logPath })
        .some((e) => e.kind === 'worker_started' && e.attempt_id === ctx.attemptId),
    });
    return spawn(process.execPath, [
      scriptPath, String(sleepMs), modeOf(ctx), markerDir, String(ctx.nodeId), String(ctx.attemptId),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  seam.spawned = spawned;
  return seam;
}

/** A land seam that records every invocation and reports the verdict it is told. */
function stubLandSeam(verdictOf = () => 'green') {
  const calls = [];
  const seam = (ctx) => {
    const verdict = verdictOf(ctx);
    calls.push({ node_id: ctx.nodeId, attempt_id: ctx.attemptId, verdict });
    return verdict === 'green'
      ? { code: 0, verdict: 'green', result: 'landed' }
      : { code: 1, verdict: 'red', result: 'aborted:exit-1' };
  };
  seam.calls = calls;
  return seam;
}

/** A preflight result shaped like the real one, for cases that are not testing it. */
function allowedPreflight() {
  return {
    checks: loop.CHECK_NAMES.map((name) => ({ name, ok: true, observed: {}, refused_because: null })),
    check_names: [...loop.CHECK_NAMES],
    dispatch_allowed: true,
  };
}

/** Read the log the DRIVER wrote. Nothing in this file hand writes a fleet event. */
function readLog(project) {
  return runlog.readFleetRunlog({ path: project.logPath });
}

const PINNED_NOW = 1750000000000;

// ═══ THE VERDICT RULES, DRIVEN ONE AT A TIME ════════════════════════════════
//
// A first version of this file asserted only on checks driven against real
// systems. A mutation battery then removed 10 individual refusal rules one at a
// time and NOT ONE went red, because every case drove the checks only against
// systems where those conditions already held. That is the defect class D7 names,
// found by measurement rather than by review.
//
// So each check's verdict is now a pure function of its observation, and every
// rule below is driven against an observation in which the thing it detects IS
// present. The observation halves are still real and are still asserted; these
// rows are what make the judgement half able to fail.

/** A base observation that satisfies every rule, as a starting point to break. */
function baseObservation(overrides = {}) {
  return Object.assign({
    base_ref: 'head',
    start_point: 'abc123',
    primary_head: 'abc123',
    worktree_created: true,
    worktree_head: 'abc123',
    heads_match: true,
    vendored_files: loop.EXPECTED_VENDORED_FILES,
    expected_vendored_files: loop.EXPECTED_VENDORED_FILES,
    commit_distance_from_remote_head: 0,
  }, overrides);
}

/** A serializer observation that satisfies every rule. */
function serializerObservation(overrides = {}) {
  return Object.assign({
    lane_mode: 'serialized',
    lanes: 2,
    stub_ms: loop.SERIALIZER_STUB_MS,
    repo_key: 'x/y',
    worktrees: ['/w/lane-0', '/w/lane-1'],
    windows: [{ lane: 0, enter_at: 10, exit_at: 20 }, { lane: 1, enter_at: 30, exit_at: 40 }],
    entry_spread_ms: 20,
    overlapping_pairs: [],
    widest_overlap_ms: 0,
  }, overrides);
}

/** A reclaim observation that satisfies every rule. */
function reclaimObservation(overrides = {}) {
  return Object.assign({
    killed_by_signal: 'SIGKILL',
    exit_code: null,
    lease_released_events: 0,
    lease_state_after_kill: 'held',
    lease_epoch_after_kill: 1,
    lease_expired_at_probe: false,
    default_probe: { alive: false, reason: 'pid_absent' },
    reclaim_attempted: true,
    reclaim_granted: true,
    reclaim_reason: 'holder_dead',
    reclaimed_epoch: 2,
    stale_renewal_refused: true,
    stale_renewal_code: boardLib.FLEET_BOARD_ERROR_CODES.E_FLEET_STALE_EPOCH,
    liveness_forced: false,
  }, overrides);
}

test('every base verdict rule is driven against an observation where the thing it detects IS present', () => {
  assert.equal(loop.baseVerdict(baseObservation()).ok, true);

  const rows = [
    ['worktree_created', { worktree_created: false }],
    ['heads_match', { heads_match: false, worktree_head: 'deadbee' }],
    ['vendored_files', { vendored_files: loop.EXPECTED_VENDORED_FILES - 1 }],
  ];
  for (const [rule, breakage] of rows) {
    const verdict = loop.baseVerdict(baseObservation(breakage));
    assert.equal(verdict.ok, false, `${rule} did not refuse`);
    assert.equal(verdict.rule, rule, `${rule} was answered by ${verdict.rule} instead`);
    assert.ok(verdict.refused_because.length > 20, 'a refusal must say what was observed');
  }

  // The commit distance NEVER reaches the verdict. Both a large distance and an
  // unknown one leave every rule satisfied.
  assert.equal(loop.baseVerdict(baseObservation({ commit_distance_from_remote_head: 751 })).ok, true);
  assert.equal(loop.baseVerdict(baseObservation({ commit_distance_from_remote_head: null })).ok, true);
});

test('every serializer verdict rule is driven against an observation where the thing it detects IS present', () => {
  assert.equal(loop.serializerVerdict(serializerObservation()).ok, true);

  const rows = [
    ['stub_ceiling', { stub_ms: loop.SERIALIZER_STUB_CEILING_MS + 1 }],
    ['windows_recorded', { windows: [{ lane: 0, enter_at: 10, exit_at: 20 }] }],
    // A lane count that is met but on 1 shared worktree: the pairing the vendored
    // claim at ratchet:824-830 fails to exclude is 2 worktrees of 1 repository, so
    // a check racing 2 lanes on 1 worktree would pass against a worktree scoped
    // token and would prove nothing about the defect it exists to detect.
    ['distinct_worktrees', { worktrees: ['/w/shared', '/w/shared'] }],
    ['no_overlap', { overlapping_pairs: [{ a: 0, b: 1, width: 42 }], widest_overlap_ms: 42 }],
  ];
  for (const [rule, breakage] of rows) {
    const verdict = loop.serializerVerdict(serializerObservation(breakage));
    assert.equal(verdict.ok, false, `${rule} did not refuse`);
    assert.equal(verdict.rule, rule, `${rule} was answered by ${verdict.rule} instead`);
  }
});

test('every reclaim verdict rule is driven against an observation where the thing it detects IS present', () => {
  assert.equal(loop.reclaimVerdict(reclaimObservation()).ok, true);

  const rows = [
    ['killed_by_signal', { killed_by_signal: 'SIGTERM' }],
    ['killed_by_signal', { killed_by_signal: null }],
    ['lease_released_events', { lease_released_events: 1 }],
    ['lease_state', { lease_state_after_kill: 'released' }],
    // The reap window: an unreaped child is a zombie that still holds its pid, so
    // a probe run before the exit was awaited reports ALIVE.
    ['default_probe', { default_probe: { alive: true, reason: 'pid_and_start_stamp_match' } }],
    ['default_probe', { default_probe: null }],
    ['lease_expired', { lease_expired_at_probe: true }],
    ['reclaim_granted', { reclaim_granted: false, reclaim_reason: 'E_FLEET_NOT_RECLAIMABLE' }],
    ['reclaim_reason', { reclaim_reason: 'lease_expired' }],
    ['epoch_advanced', { reclaimed_epoch: 1 }],
    ['stale_renewal_refused', { stale_renewal_refused: false, stale_renewal_code: null }],
    ['stale_renewal_code', { stale_renewal_code: 'E_FLEET_NOT_HOLDER' }],
  ];
  for (const [rule, breakage] of rows) {
    const verdict = loop.reclaimVerdict(reclaimObservation(breakage));
    assert.equal(verdict.ok, false, `${JSON.stringify(breakage)} did not refuse`);
    assert.equal(verdict.rule, rule, `${rule} was answered by ${verdict.rule} instead`);
  }

  // Before the reclaim is attempted, only the PRE rules may answer, and a clean
  // pre-observation is allowed to proceed rather than refused for a missing
  // post-condition.
  const pre = loop.reclaimVerdict(reclaimObservation({
    reclaim_attempted: false, reclaim_granted: false, reclaim_reason: null,
    reclaimed_epoch: null, stale_renewal_refused: false, stale_renewal_code: null,
  }));
  assert.equal(pre.ok, true);
  assert.equal(pre.rule, 'reclaim_pre_conditions_green');
  for (const rule of loop.RECLAIM_PRE_RULES) {
    assert.ok(typeof rule === 'string' && rule.length > 0);
  }
});

test('2 land windows that merely TOUCH do not overlap', () => {
  // The conservative tie break, and the same one `src/fleet-runfold.cts` takes for
  // demonstrated width: [10,20] and [20,30] demonstrate 1 land at a time, not 2.
  // Counting a width of 0 as an overlap would make the serializer check refuse a
  // correctly serialized pair.
  const touching = loop.overlappingPairs([
    { idx: 0, enterAt: 10, exitAt: 20 },
    { idx: 1, enterAt: 20, exitAt: 30 },
  ]);
  assert.equal(touching.windows.length, 2);
  assert.deepEqual(touching.found, []);

  // 1 millisecond of genuine overlap IS an overlap.
  const overlapping = loop.overlappingPairs([
    { idx: 0, enterAt: 10, exitAt: 21 },
    { idx: 1, enterAt: 20, exitAt: 30 },
  ]);
  assert.equal(overlapping.found.length, 1);
  assert.equal(overlapping.found[0].width, 1);

  // A window with no recorded instants is dropped rather than counted as a point.
  const partial = loop.overlappingPairs([
    { idx: 0, enterAt: 10, exitAt: 20 },
    { idx: 1, enterAt: null, exitAt: null },
  ]);
  assert.equal(partial.windows.length, 1);
});

test('the serializer check REFUSES a pinned sleep past its ceiling, without sleeping it', async () => {
  const started = Date.now();
  const result = await loop.checkSerializer({
    stubMs: loop.SERIALIZER_STUB_CEILING_MS + 1,
    repoKey: 'preflight/ceiling',
  });
  assert.equal(result.ok, false);
  assert.equal(result.observed.rule, 'stub_ceiling');
  assert.match(result.refused_because, /ceiling/);
  // It refused rather than sleeping: no lane ran at all.
  assert.deepEqual(result.observed.windows, []);
  assert.ok(Date.now() - started < loop.SERIALIZER_STUB_CEILING_MS);
});

// ═══ TASK 1: the dispatch preconditions ═════════════════════════════════════

test('preflight returns a checks array and dispatch_allowed is the conjunction', async () => {
  const green = (name) => () => ({ name, ok: true, observed: {}, refused_because: null });
  const red = (name) => () => ({ name, ok: false, observed: { driven: true }, refused_because: 'planted' });

  // Keyed off CHECK_NAMES rather than written out, so a check added to the
  // preflight cannot be silently left out of the conjunction assertion. Phase 20
  // added `adapters` as the fourth and this loop covered it without an edit.
  const INJECTION_OF = {
    base: 'checkBase',
    serializer: 'checkSerializer',
    reclaim: 'checkReclaim',
    adapters: 'checkAdapters',
  };
  for (const name of loop.CHECK_NAMES) {
    assert.ok(INJECTION_OF[name] !== undefined, `no injection point known for check ${name}`);
  }
  const inject = (failing) => Object.fromEntries(
    loop.CHECK_NAMES.map((name) => [INJECTION_OF[name], failing === name ? red(name) : green(name)]),
  );

  const all = await loop.runPreflight(inject(null));
  assert.deepEqual(all.checks.map((c) => c.name), [...loop.CHECK_NAMES]);
  assert.equal(all.dispatch_allowed, true);

  // Each of them, refused ALONE. A conjunction that only fires when everything
  // is red is not a conjunction.
  for (const failing of loop.CHECK_NAMES) {
    const result = await loop.runPreflight(inject(failing));
    assert.equal(result.dispatch_allowed, false, `${failing} alone must refuse dispatch`);
    assert.equal(result.checks.find((c) => c.name === failing).ok, false);
    assert.equal(result.checks.filter((c) => c.ok).length, loop.CHECK_NAMES.length - 1);
  }
});

test('the base check creates a REAL worktree and reports ok only when its HEAD equals the primary HEAD', () => {
  const repo = makeRepo('base-ok');
  const before = worktreeCount(repo.root);

  const result = loop.checkBase({ repoRoot: repo.root });
  assert.equal(result.ok, true, `base check refused: ${result.refused_because}`);
  assert.equal(result.observed.worktree_head, repo.head);
  assert.equal(result.observed.primary_head, repo.head);
  assert.equal(result.observed.heads_match, true);
  // The comparison is against a worktree that really existed: the count went up
  // and came back down.
  assert.equal(worktreeCount(repo.root), before, 'the created worktree must be gone');
});

test('the base check counts the vendored engine files and refuses below the drop count', () => {
  const short = makeRepo('base-short', { vendoredFiles: loop.EXPECTED_VENDORED_FILES - 1 });
  const result = loop.checkBase({ repoRoot: short.root });

  // The HEAD arm PASSED and the vendored arm is what refused, so the 2 arms are
  // separately observable rather than covering each other.
  assert.equal(result.observed.heads_match, true);
  assert.equal(result.observed.vendored_files, loop.EXPECTED_VENDORED_FILES - 1);
  assert.equal(result.ok, false);
  assert.match(result.refused_because, /vendored engine files/);

  const exact = makeRepo('base-exact');
  const okResult = loop.checkBase({ repoRoot: exact.root });
  assert.equal(okResult.observed.vendored_files, loop.EXPECTED_VENDORED_FILES);
  assert.equal(okResult.ok, true);
});

test('THE MUTATION: a base check driven against a worktree forked from a DIFFERENT commit refuses, and leaves no worktree behind', () => {
  const repo = makeRepo('base-forked', { commits: 3 });
  const older = repo.shas[0];
  assert.notEqual(older, repo.head, 'the 2 commits must really differ or this case proves nothing');
  const before = worktreeCount(repo.root);

  const result = loop.checkBase({ repoRoot: repo.root, baseRef: older });

  assert.equal(result.ok, false, 'a worktree forked from a different commit must NOT be dispatched into');
  assert.equal(result.observed.worktree_head, older);
  assert.equal(result.observed.primary_head, repo.head);
  assert.equal(result.observed.heads_match, false);
  assert.match(result.refused_because, /resolved HEAD/);

  // The `finally` arm: a preflight that leaks a worktree on every red run is a
  // denial of service against the next run.
  assert.equal(worktreeCount(repo.root), before, 'the failing run must remove the worktree it created');
});

test('the commit distance is a DIAGNOSTIC and never changes the verdict', () => {
  const repo = makeRepo('base-distance', { commits: 4 });

  // With no remote at all the distance is simply unknown, and the verdict stands.
  const noRemote = loop.checkBase({ repoRoot: repo.root });
  assert.equal(noRemote.observed.commit_distance_from_remote_head, null);
  assert.equal(noRemote.ok, true);

  // Now point the remote default head 3 commits behind. This is the exact
  // condition every worktree agent hit tonight, and it is STILL not a verdict:
  // with the base reference configured to fork from HEAD a large distance is
  // expected rather than wrong.
  git(repo.root, ['update-ref', 'refs/remotes/origin/HEAD', repo.shas[0]]);
  const stale = loop.checkBase({ repoRoot: repo.root });
  assert.equal(stale.observed.commit_distance_from_remote_head, 3);
  assert.equal(stale.ok, true, 'a large commit distance must not refuse dispatch');
  assert.equal(stale.observed.heads_match, true);
});

test('the serializer check races 2 REAL stub lands on 1 repoKey and reports ok only when they do not overlap', async (t) => {
  const result = await loop.checkSerializer({ repoKey: 'preflight/serializer-positive' });

  assert.equal(result.observed.lane_mode, 'serialized');
  assert.equal(result.observed.windows.length, 2, 'both lanes must have recorded a land window');
  t.diagnostic(`serialized windows: ${JSON.stringify(result.observed.windows)}`);
  t.diagnostic(`serialized: ${result.observed.overlapping_pairs.length} overlapping pair(s)`);
  assert.deepEqual(result.observed.overlapping_pairs, []);
  assert.equal(result.ok, true, `serializer check refused: ${result.refused_because}`);
});

test('THE MUTATION: the serializer check with acquisition BYPASSED observes an overlap and refuses', async (t) => {
  const result = await loop.checkSerializer({
    laneMode: 'bypass',
    repoKey: 'preflight/serializer-bypassed',
  });

  assert.equal(result.observed.lane_mode, 'bypass');
  assert.equal(result.observed.windows.length, 2);
  t.diagnostic(`bypassed windows: ${JSON.stringify(result.observed.windows)}`);
  t.diagnostic(
    `bypassed: ${result.observed.overlapping_pairs.length} overlapping pair(s), `
    + `entry spread ${result.observed.entry_spread_ms}ms, widest ${result.observed.widest_overlap_ms}ms`,
  );

  // The refusal is an OBSERVED overlap and not an inferred one. If this ever
  // stops firing the pinned stub sleep is too short relative to process startup
  // skew: raise it inside its ceiling, re-observe, re-pin, and record what was
  // seen. Do NOT delete this case and do NOT soften this assertion.
  assert.ok(
    result.observed.overlapping_pairs.length > 0,
    'THE MUTATION DID NOT FIRE. With acquisition bypassed the 2 land windows must overlap, and '
    + `they did not: ${JSON.stringify(result.observed.windows)}`,
  );
  assert.ok(result.observed.widest_overlap_ms > 0);
  assert.equal(result.ok, false);
  assert.match(result.refused_because, /overlapped/);
});

test('the reclaim check kills a REAL holder and reports ok only when the reclaim and the epoch fence both hold', async (t) => {
  const result = await loop.checkReclaim({});

  assert.equal(result.observed.killed_by_signal, 'SIGKILL', 'the holder must be killed, not asked to stop');
  assert.equal(result.observed.lease_released_events, 0, 'no handler could have run, so none may have');
  assert.equal(result.observed.lease_state_after_kill, 'held');
  assert.equal(result.observed.lease_expired_at_probe, false, 'the TTL arm must not be what answered');
  assert.equal(result.observed.default_probe.alive, false);
  assert.equal(result.observed.reclaim_reason, 'holder_dead');
  assert.ok(result.observed.reclaimed_epoch > result.observed.lease_epoch_after_kill);
  assert.equal(result.observed.stale_renewal_code, boardLib.FLEET_BOARD_ERROR_CODES.E_FLEET_STALE_EPOCH);
  assert.equal(result.ok, true, `reclaim check refused: ${result.refused_because}`);
  t.diagnostic(`reclaim: epoch ${result.observed.lease_epoch_after_kill} to ${result.observed.reclaimed_epoch}, reason ${result.observed.reclaim_reason}`);
});

test('THE MUTATION: a reclaim check whose holder was NOT killed uncatchably refuses BEFORE attempting any reclaim', async () => {
  // The 3rd refusing arm, and the one that makes the early return observable.
  // The holder is sent a CATCHABLE signal, so a pre condition fails, and the
  // counting seam records that no reclaim was ever attempted. Attempting a
  // reclaim against a holder that was never provably killed would prove nothing
  // whichever way it went, and probing spawns a process listing inside a held
  // transaction to answer a settled question.
  const attempts = [];
  const result = await loop.checkReclaim({
    killSignal: 'SIGTERM',
    reclaimLease: (opts) => { attempts.push(opts.nodeId); throw new Error('must not be reached'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.observed.killed_by_signal, 'SIGTERM');
  assert.equal(result.observed.rule, 'killed_by_signal');
  assert.equal(result.observed.reclaim_attempted, false);
  assert.equal(
    attempts.length, 0,
    'the pre conditions failed, so no reclaim may have been attempted at all',
  );
  assert.match(result.refused_because, /nothing proved a crash reclaim/);
});

test('THE MUTATION: the reclaim check with the liveness probe FORCED ALIVE refuses', async () => {
  const result = await loop.checkReclaim({
    // A function so the injection sees the holder record the child really wrote.
    // Reporting the REAL claimant alive is a stronger forcing than reporting it
    // unreadable, because the unreadable arms are fail-closed by design.
    reclaimDeps: (holder) => ({
      pidExists: () => true,
      readPidStart: () => (holder === null || holder === undefined ? '' : holder.pid_start),
    }),
  });

  // The holder really is dead. The default probe ran first and said so, and only
  // then was the injected probe made to disagree.
  assert.equal(result.observed.killed_by_signal, 'SIGKILL');
  assert.equal(result.observed.default_probe.alive, false);
  assert.equal(result.observed.liveness_forced, true);
  assert.equal(result.ok, false, 'a reclaim granted against a live holder would produce 2 holders');
  assert.equal(result.observed.reclaim_reason, boardLib.FLEET_BOARD_ERROR_CODES.E_FLEET_NOT_RECLAIMABLE);
  assert.match(result.refused_because, /refused a provably dead holder/);
});

// ═══ TASK 2: the level triggered driver ═════════════════════════════════════

test('the driver dispatches NOTHING when preflight refuses, and emits no worker_started', async () => {
  const project = makeProject('refused', { count: 3 });
  const worker = stubWorkerSeam(project);
  const land = stubLandSeam();

  const refused = {
    checks: [
      { name: 'base', ok: true, observed: {}, refused_because: null },
      { name: 'serializer', ok: false, observed: { overlapping_pairs: [{ a: 0, b: 1, width: 42 }] }, refused_because: 'planted overlap' },
      { name: 'reclaim', ok: true, observed: {}, refused_because: null },
    ],
    check_names: [...loop.CHECK_NAMES],
    dispatch_allowed: false,
  };

  let printed = '';
  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'refused/repo',
    runId: 'run-refused',
    capacity: 3,
    clock: () => PINNED_NOW,
    preflight: refused,
    spawnWorker: worker,
    landCommand: land,
    write: (s) => { printed += s; },
  });

  assert.equal(result.dispatch_allowed, false);
  assert.equal(result.stopped_by, 'preflight_refused');

  // Counted, not inferred from an exit code.
  const events = readLog(project);
  assert.equal(events.filter((e) => e.kind === 'worker_started').length, 0);
  assert.equal(events.filter((e) => e.kind === 'claim_acquired').length, 0);
  assert.equal(worker.spawned.length, 0, 'the spawn seam must never have been called');
  assert.equal(land.calls.length, 0);

  // The refusal names WHICH check refused and WHAT WAS OBSERVED, never merely
  // that something failed.
  assert.match(printed, /REFUSED serializer/);
  assert.match(printed, /observed:/);
  assert.match(printed, /planted overlap/);
});

test('a full run brackets itself with run_started carrying run_id and graph_generation, and run_closed', async () => {
  const project = makeProject('bracket', { count: 2 });
  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'bracket/repo',
    runId: 'run-bracket',
    capacity: 2,
    clock: () => PINNED_NOW,
    preflight: allowedPreflight(),
    spawnWorker: stubWorkerSeam(project),
    landCommand: stubLandSeam(),
  });

  const events = readLog(project);
  const started = events.filter((e) => e.kind === 'run_started');
  const closed = events.filter((e) => e.kind === 'run_closed');
  assert.equal(started.length, 1, 'exactly 1 run_started, or the fold reads the wrong generation');
  assert.equal(closed.length, 1);
  assert.equal(started[0].run_id, 'run-bracket');
  assert.match(started[0].graph_generation, /^sha256:[0-9a-f]{64}$/);
  assert.equal(started[0].graph_generation, result.graph_generation);
  for (const event of events) assert.equal(event.run_id, 'run-bracket', 'EVERY event carries run_id');

  // The generation is a function of the graph and of nothing else: the same
  // plans yield the same value from a second, independent project.
  const twin = makeProject('bracket-twin', { count: 2 });
  const twinResult = await loop.runLoop({
    cwd: twin.root,
    phase: twin.phase,
    logPath: twin.logPath,
    projectionPath: twin.projectionPath,
    tokenDir: twin.tokenDir,
    repoKey: 'bracket-twin/repo',
    runId: 'run-bracket-twin',
    capacity: 2,
    clock: () => PINNED_NOW,
    preflight: allowedPreflight(),
    spawnWorker: stubWorkerSeam(twin),
    landCommand: stubLandSeam(),
  });
  assert.equal(twinResult.graph_generation, result.graph_generation);
});

test('each pass dispatches EXACTLY what managerPass returned, in the order it returned it', async () => {
  // 6 nodes, capacity 2, so the pass truncates and the ORDER is what decides who
  // runs first. If the driver had an opinion of its own this is where it would
  // show.
  const project = makeProject('order', { count: 6 });
  const worker = stubWorkerSeam(project, { sleepMs: 30 });

  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'order/repo',
    runId: 'run-order',
    capacity: 2,
    clock: () => PINNED_NOW,
    heartbeatMs: 10,
    preflight: allowedPreflight(),
    spawnWorker: worker,
    landCommand: stubLandSeam(),
  });

  assert.equal(result.stopped_by, 'drained');
  for (const pass of result.passes) {
    assert.deepEqual(
      pass.dispatched, pass.decided,
      `pass ${pass.pass} dispatched ${JSON.stringify(pass.dispatched)} for a decision of `
      + `${JSON.stringify(pass.decided)}`,
    );
  }

  // The concatenated decisions equal the worker_started order in the log, which
  // is the same claim made against the artifact rather than against the return
  // value.
  const decided = result.passes.flatMap((p) => p.decided);
  const startedOrder = readLog(project)
    .filter((e) => e.kind === 'worker_started')
    .map((e) => e.node_id);
  assert.deepEqual(startedOrder, decided);

  // And the FIRST pass took the 2 lowest schedule orders, so the truncation
  // honoured the graph's total order rather than an arrival order.
  assert.deepEqual(result.passes[0].decided, ['07-01', '07-02']);
  assert.equal(result.passes[0].free_capacity, 2);
});

test('a node is CLAIMED before its worker is spawned, and worker_started carries that claim epoch', async () => {
  const project = makeProject('claim-first', { count: 3 });
  const worker = stubWorkerSeam(project);

  await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'claim-first/repo',
    runId: 'run-claim-first',
    capacity: 3,
    clock: () => PINNED_NOW,
    preflight: allowedPreflight(),
    spawnWorker: worker,
    landCommand: stubLandSeam(),
  });

  assert.equal(worker.spawned.length, 3);
  for (const record of worker.spawned) {
    // Observed AT SPAWN TIME, inside the seam, not read off the finished log.
    assert.equal(
      record.claim_present_at_spawn, true,
      `${record.node_id} was spawned before its claim reached the log`,
    );
    assert.equal(
      record.worker_started_present_at_spawn, true,
      `${record.node_id} was spawned before it was announced`,
    );
  }

  const events = readLog(project);
  for (const record of worker.spawned) {
    const claim = events.find((e) => e.kind === 'claim_acquired' && e.node_id === record.node_id);
    const started = events.find((e) => e.kind === 'worker_started' && e.attempt_id === record.attempt_id);
    assert.equal(started.lease_epoch, claim.lease_epoch);
    assert.equal(record.lease_epoch, claim.lease_epoch);
    assert.ok(events.indexOf(claim) < events.indexOf(started));
  }
});

test('the heartbeat renews a running worker WITHOUT changing the epoch', async () => {
  const project = makeProject('heartbeat', { count: 1 });
  // The worker outlives many heartbeat intervals, so the renewals are real rather
  // than incidental.
  const worker = stubWorkerSeam(project, { sleepMs: 300 });

  await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'heartbeat/repo',
    runId: 'run-heartbeat',
    capacity: 1,
    clock: () => PINNED_NOW,
    ttlMs: 3600000,
    heartbeatMs: 15,
    preflight: allowedPreflight(),
    spawnWorker: worker,
    landCommand: stubLandSeam(),
  });

  const events = readLog(project);
  const claim = events.find((e) => e.kind === 'claim_acquired');
  const renewals = events.filter((e) => e.kind === 'lease_renewed' && e.node_id === claim.node_id);
  assert.ok(renewals.length >= 2, `expected repeated heartbeats, saw ${renewals.length}`);
  for (const renewal of renewals) {
    assert.equal(
      renewal.lease_epoch, claim.lease_epoch,
      'a renewal that advanced the epoch would make lease_epoch unable to tell a heartbeat from a reclaim',
    );
    assert.equal(renewal.worker_id, claim.worker_id);
  }
});

test('a worker that exits cleanly ends with outcome completed and its lease is released', async () => {
  const project = makeProject('clean-exit', { count: 2 });
  await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'clean-exit/repo',
    runId: 'run-clean-exit',
    capacity: 2,
    clock: () => PINNED_NOW,
    preflight: allowedPreflight(),
    spawnWorker: stubWorkerSeam(project),
    landCommand: stubLandSeam(),
  });

  const events = readLog(project);
  const ends = events.filter((e) => e.kind === 'worker_ended');
  assert.equal(ends.length, 2);
  for (const end of ends) {
    assert.equal(end.outcome, 'completed');
    assert.equal(end.exit_code, 0);
    assert.equal(end.signal, null);
  }
  const projected = boardLib.projectBoard(events);
  for (const lease of Object.values(projected.leases)) {
    assert.equal(lease.state, boardLib.LEASE_STATES.RELEASED);
  }
});

test('a worker that exits non zero ends with outcome failed and its lease is released', async () => {
  const project = makeProject('failed-exit', { count: 1 });
  const land = stubLandSeam();

  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'failed-exit/repo',
    runId: 'run-failed-exit',
    capacity: 1,
    clock: () => PINNED_NOW,
    // A failed node is left for a later attempt, so the run is bounded by the
    // pass ceiling. That is a bound on the LOOP and not a retry policy: D1
    // excludes park budgets by name and phase 20 owns them.
    maxPasses: 3,
    preflight: allowedPreflight(),
    spawnWorker: stubWorkerSeam(project, { modeOf: () => 'fail' }),
    landCommand: land,
  });

  assert.equal(result.stopped_by, 'pass_ceiling');
  const events = readLog(project);
  const ends = events.filter((e) => e.kind === 'worker_ended');
  assert.ok(ends.length >= 1);
  for (const end of ends) {
    assert.equal(end.outcome, 'failed');
    assert.equal(end.exit_code, 1);
  }
  assert.equal(land.calls.length, 0, 'a failed delivery must never reach the land');
  const projected = boardLib.projectBoard(events);
  assert.equal(projected.leases['07-01'].state, boardLib.LEASE_STATES.RELEASED);
});

test('a worker killed by a signal ends with outcome abnormal and leaves NO open interval', async () => {
  const project = makeProject('abnormal-exit', { count: 1 });
  const land = stubLandSeam();

  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'abnormal-exit/repo',
    runId: 'run-abnormal',
    capacity: 1,
    clock: () => PINNED_NOW,
    maxPasses: 2,
    preflight: allowedPreflight(),
    spawnWorker: stubWorkerSeam(project, { modeOf: () => 'signal' }),
    landCommand: land,
  });

  assert.equal(result.stopped_by, 'pass_ceiling');
  const events = readLog(project);
  const ends = events.filter((e) => e.kind === 'worker_ended');
  assert.ok(ends.length >= 1);
  for (const end of ends) {
    // The outcome is asserted in the LOG, not merely that the loop survived.
    assert.equal(end.outcome, 'abnormal');
    assert.equal(end.signal, 'SIGKILL');
  }
  assert.equal(land.calls.length, 0, 'an abnormal delivery must never reach the land');

  // The interval is CLOSED. An abnormal end is knowledge, and the fold says so.
  const record = runfold.foldRunRecord(events);
  assert.equal(record.demonstrated_width.unknown_intervals, 0);
  assert.equal(record.demonstrated_width.exact, true);
  for (const w of record.workers) assert.notEqual(w.ended_at, null);
});

test('SC3: a CLEAN delivery is landed by the loop itself, with no human step', async () => {
  const project = makeProject('sc3', { count: 3 });
  const worker = stubWorkerSeam(project);
  const land = stubLandSeam(() => 'green');
  let postLandCalls = 0;

  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'sc3/repo',
    runId: 'run-sc3',
    capacity: 3,
    clock: () => PINNED_NOW,
    preflight: allowedPreflight(),
    spawnWorker: worker,
    landCommand: land,
    verifyPostLand: () => { postLandCalls += 1; return 'held'; },
  });

  // ONE call to runLoop, no prompt, no checkpoint, no second entry. Everything
  // below happened inside that single await.
  assert.equal(result.stopped_by, 'drained');

  const events = readLog(project);
  // The delivery really WAS clean: every worker exited 0.
  const ends = events.filter((e) => e.kind === 'worker_ended');
  assert.equal(ends.length, 3);
  for (const end of ends) assert.equal(end.outcome, 'completed');

  // And the land really ran, counted by the seam itself.
  assert.equal(land.calls.length, 3);
  for (const call of land.calls) assert.equal(call.verdict, 'green');

  // The 5 land window instants exist for every node, so phase 22 can separate
  // queue wait from gate cost from land latency.
  for (let i = 1; i <= 3; i++) {
    const nodeId = `07-0${i}`;
    const kinds = events.filter((e) => e.node_id === nodeId).map((e) => e.kind);
    for (const required of [
      'claim_acquired', 'worker_started', 'worker_ended', 'lease_released',
      'queue_entered', 'queue_acquired', 'gate_started', 'gate_ended',
      'land_completed', 'post_land_truth',
    ]) {
      assert.ok(kinds.includes(required), `${nodeId} is missing ${required}`);
    }
  }

  // post_land_truth is RECORDED from the seam and never derived from the gate
  // verdict, per D3.
  assert.equal(postLandCalls, 3);
  const truths = events.filter((e) => e.kind === 'post_land_truth');
  assert.equal(truths.length, 3);
  for (const truth of truths) assert.equal(truth.classification, 'held');

  // Every node is complete, so the loop closed the delivery itself.
  const record = runfold.foldRunRecord(events);
  assert.equal(record.false_green.landed, 3);
  assert.equal(record.false_green.unknown, 0);
});

/**
 * FF-B232. THE LAND SEAM'S ENVIRONMENT, DRIVEN THROUGH THE DRIVER.
 *
 * `src/fleet-landqueue.cts` already owns the 2 halves of this: `landSpawnEnv`
 * pins `PYTHONDONTWRITEBYTECODE` and honours a `ratchetHome` the caller supplies,
 * and `runLand` forwards that home to the command. Both are covered in
 * `tests/fleet-landqueue.test.cjs`. NEITHER of those rows can see the defect this
 * one is for, because both start at `runLand` and the defect is 1 level above it:
 * the driver passed `ratchetHome` to `spawnWorker` and NOT to `runLand`, so the
 * seam that received nothing had nothing to forward.
 *
 * ─── WHY THE AMBIENT ENVIRONMENT IS SET TO A DECOY ───────────────────────────
 *
 * A run with an unset ambient home would fail this row for the weak reason: the
 * value would be absent rather than wrong. The hazard FF-B232 records is worse
 * than absent. An operator with a personal `~/.ratchet` naming this repository
 * gets a land that REBASES onto the mainline that manifest declares and PUSHES to
 * the remote it names. So the ambient value is set to a decoy personal home
 * first, and the assertion is that the repo scoped home BEATS it. A driver that
 * drops the home inherits the decoy and this row names it in the failure.
 *
 * ─── WHY A REAL CHILD RATHER THAN AN OBJECT ──────────────────────────────────
 *
 * The land seam composes its environment through `landSpawnEnv` exactly as
 * `defaultLandCommand` does at the spawn, so the stub here composes it the same
 * way and hands it to a REAL child that reports what it actually read. An
 * assertion on the returned object would prove the object; the engine reads an
 * environment, and this reads back what an engine in that position would get.
 */
test('FF-B232: the land seam gets the repo scoped engine home, beating a personal one', async () => {
  const project = makeProject('land-home', { count: 1 });
  const scopedHome = path.join(project.root, '.ferrox', 'ratchet-home');
  fs.mkdirSync(path.join(scopedHome, 'state'), { recursive: true });
  const decoyHome = path.join(project.root, 'operator-personal-ratchet-home');

  const observed = [];
  const land = (ctx) => {
    const probe = spawnSync(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify({'
        + 'home: process.env.RATCHET_HOME ?? null,'
        + 'bytecode: process.env.PYTHONDONTWRITEBYTECODE ?? null}))',
    ], { encoding: 'utf8', env: landqueue.landSpawnEnv(ctx) });
    assert.equal(probe.status, 0, `the environment probe did not run: ${probe.stderr}`);
    observed.push({
      ctx_home: typeof ctx.ratchetHome === 'string' ? ctx.ratchetHome : null,
      child: JSON.parse(probe.stdout),
    });
    return { code: 0, verdict: 'green', result: 'landed' };
  };

  const beforeHome = process.env.RATCHET_HOME;
  const beforeBytecode = process.env.PYTHONDONTWRITEBYTECODE;
  let result;
  try {
    process.env.RATCHET_HOME = decoyHome;
    process.env.PYTHONDONTWRITEBYTECODE = '0';
    result = await loop.runLoop({
      cwd: project.root,
      phase: project.phase,
      logPath: project.logPath,
      projectionPath: project.projectionPath,
      tokenDir: project.tokenDir,
      repoKey: 'land-home/repo',
      runId: 'run-land-home',
      capacity: 1,
      clock: () => PINNED_NOW,
      preflight: allowedPreflight(),
      spawnWorker: stubWorkerSeam(project),
      ratchetHome: scopedHome,
      landCommand: land,
    });
  } finally {
    if (beforeHome === undefined) delete process.env.RATCHET_HOME;
    else process.env.RATCHET_HOME = beforeHome;
    if (beforeBytecode === undefined) delete process.env.PYTHONDONTWRITEBYTECODE;
    else process.env.PYTHONDONTWRITEBYTECODE = beforeBytecode;
  }

  assert.equal(result.stopped_by, 'drained');
  assert.equal(observed.length, 1, 'the land never ran, so this row would prove nothing');

  assert.equal(
    observed[0].ctx_home, scopedHome,
    'the driver did not hand the land seam the home it minted, so the seam had nothing to forward',
  );
  assert.equal(
    observed[0].child.home, scopedHome,
    'the land child read a control plane the fleet did not choose. It got '
      + `${JSON.stringify(observed[0].child.home)} while the repo scoped home is `
      + `${JSON.stringify(scopedHome)}`,
  );
  assert.equal(
    observed[0].child.bytecode, '1',
    'an inherited 0 reached the land child, so the land can write bytecode into the byte pinned '
      + 'vendored tree',
  );

  // The worker half is asserted in the SAME run rather than in a separate row,
  // because the whole point of FF-B232 is that the 2 halves of 1 chain disagreed.
  // A row that watched only the land could go green again on a fix that moved the
  // scoping off the worker.
  assert.equal(
    landqueue.landSpawnEnv({ ratchetHome: scopedHome }).RATCHET_HOME,
    loop.workerSpawnOptions({ ratchetHome: scopedHome }).env.RATCHET_HOME,
    'the 2 seams of 1 chain must resolve the same control plane',
  );
});

test('a delivery that is NOT clean is not landed, and the node is left for a later attempt', async () => {
  const project = makeProject('not-clean', { count: 1 });
  const land = stubLandSeam(() => 'green');
  const worker = stubWorkerSeam(project, { modeOf: () => 'fail-once' });

  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'not-clean/repo',
    runId: 'run-not-clean',
    capacity: 1,
    clock: () => PINNED_NOW,
    maxPasses: 20,
    preflight: allowedPreflight(),
    spawnWorker: worker,
    landCommand: land,
  });

  // The node WAS retried, and the run drained once the second attempt landed.
  assert.equal(result.stopped_by, 'drained');
  assert.equal(worker.spawned.length, 2);

  const events = readLog(project);
  const ends = events.filter((e) => e.kind === 'worker_ended');
  assert.deepEqual(ends.map((e) => e.outcome), ['failed', 'completed']);

  // Attempt 1 reached NO land at all. Attempt 2 did.
  assert.deepEqual(land.calls.map((c) => c.attempt_id), ['run-not-clean/07-01#2']);
  const landedAttempts = events.filter((e) => e.kind === 'land_completed').map((e) => e.attempt_id);
  assert.deepEqual(landedAttempts, ['run-not-clean/07-01#2']);
  assert.equal(
    events.some((e) => e.kind === 'gate_started' && e.attempt_id === 'run-not-clean/07-01#1'), false,
    'the unclean attempt must not have entered the land gate',
  );

  // 2 rounds for 1 artifact, derived by the fold.
  const record = runfold.foldRunRecord(events);
  assert.equal(record.rounds_per_artifact['07-01'], 2);

  // THE EPOCH ARM. The second attempt's claim takes epoch 2, because the first
  // released cleanly and `nextLeaseEpoch` hands the next holder N plus 1. Every
  // other case in this file only ever sees epoch 1, so an announcement carrying a
  // HARDCODED epoch would be indistinguishable there and is distinguishable here.
  const claims = events.filter((e) => e.kind === 'claim_acquired');
  const starts = events.filter((e) => e.kind === 'worker_started');
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map((e) => e.lease_epoch), [1, 2]);
  assert.deepEqual(starts.map((e) => e.lease_epoch), [1, 2]);
  assert.equal(
    starts[1].lease_epoch, claims[1].lease_epoch,
    'worker_started must carry the epoch the claim returned, not a constant',
  );
  assert.equal(worker.spawned[1].lease_epoch, 2, 'the spawn seam is handed the same epoch');
});

test('a bounded stop CLOSES the interval of a worker that was still running', async () => {
  const project = makeProject('bounded-stop', { count: 1 });
  // The worker outlives the pass ceiling, so the loop stops with it still running.
  const worker = stubWorkerSeam(project, { sleepMs: 800 });

  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'bounded-stop/repo',
    runId: 'run-bounded-stop',
    capacity: 1,
    clock: () => PINNED_NOW,
    maxPasses: 1,
    waitTickMs: 10,
    preflight: allowedPreflight(),
    spawnWorker: worker,
    landCommand: stubLandSeam(),
  });

  assert.equal(result.stopped_by, 'pass_ceiling');
  assert.equal(worker.spawned.length, 1, 'the worker really was dispatched');

  const events = readLog(project);
  const ends = events.filter((e) => e.kind === 'worker_ended');
  assert.equal(ends.length, 1, 'a bounded stop must still close every interval it can');
  assert.equal(
    ends[0].outcome, 'abnormal',
    'the worker was terminated by the bounded stop, so its end is abnormal rather than completed',
  );
  assert.equal(ends[0].signal, 'SIGKILL');
  assert.equal(events.some((e) => e.kind === 'run_closed'), true);

  // And the fold agrees the run is exact: a bounded stop must not make the width
  // unknowable.
  const record = runfold.foldRunRecord(events);
  assert.equal(record.demonstrated_width.unknown_intervals, 0);
  assert.equal(record.demonstrated_width.exact, true);
});

test('post_land_truth is emitted for EVERY attempt that reached the land, and defaults to unknown', async () => {
  const project = makeProject('post-land', { count: 2 });
  const land = stubLandSeam(() => 'green');

  await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'post-land/repo',
    runId: 'run-post-land',
    capacity: 2,
    clock: () => PINNED_NOW,
    preflight: allowedPreflight(),
    spawnWorker: stubWorkerSeam(project),
    landCommand: land,
    // No verifyPostLand seam at all.
  });

  const events = readLog(project);
  const landed = events.filter((e) => e.kind === 'land_completed').map((e) => e.attempt_id).sort();
  const truths = events.filter((e) => e.kind === 'post_land_truth');
  assert.deepEqual(truths.map((e) => e.attempt_id).sort(), landed);
  for (const truth of truths) {
    // Never `held`. D3 is explicit that a false green rate cannot be inferred
    // from a green gate by definition, so an unverified land is UNKNOWN.
    assert.equal(truth.classification, 'unknown');
  }

  const record = runfold.foldRunRecord(events);
  assert.equal(record.false_green.landed, 2);
  assert.equal(record.false_green.unknown, 2);
  assert.equal(record.false_green.later_failed, 0);
});

test('a seam that reports a classification outside the frozen set is recorded as unknown, never written through', async () => {
  const project = makeProject('bad-classification', { count: 1 });

  await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'bad-classification/repo',
    runId: 'run-bad-classification',
    capacity: 1,
    clock: () => PINNED_NOW,
    preflight: allowedPreflight(),
    spawnWorker: stubWorkerSeam(project),
    landCommand: stubLandSeam(),
    verifyPostLand: () => 'definitely-fine',
  });

  const truths = readLog(project).filter((e) => e.kind === 'post_land_truth');
  assert.equal(truths.length, 1);
  assert.equal(truths[0].classification, 'unknown');
  assert.deepEqual([...loop.POST_LAND_CLASSIFICATIONS], ['held', 'false_green', 'unknown']);
});

test('the pass loop is bounded by an ATTEMPT CEILING as well as by a clock', async () => {
  const project = makeProject('ceiling', { count: 1 });

  // A CONSTANT instant, which is how every case in this milestone supplies time.
  // `now - startedAt` is then identically 0, so a deadline expressed only in
  // milliseconds is unreachable and the clock bound alone is not a bound. This is
  // the exact shape plan 04 found as a real hang.
  const result = await loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'ceiling/repo',
    runId: 'run-ceiling',
    capacity: 1,
    clock: () => PINNED_NOW,
    deadlineMs: 1,
    maxPasses: 4,
    // THE PARK CEILING IS RAISED PAST THE PASS BUDGET ON PURPOSE, because this
    // arm is about the PASS ceiling. Phase 20 SC1 added a NODE level bound whose
    // default is 3, and at that default the failing node here parks on pass 3 and
    // the run then drains, which would make this case report `drained` and prove
    // nothing about the loop bound it was written to prove. The 2 bounds are
    // different questions: the pass ceiling bounds the RUN, the park ceiling
    // bounds a NODE.
    parkAfterAttempts: 1000,
    preflight: allowedPreflight(),
    spawnWorker: stubWorkerSeam(project, { modeOf: () => 'fail' }),
    landCommand: stubLandSeam(),
  });

  assert.equal(
    result.stopped_by, 'pass_ceiling',
    'with a constant clock the deadline is unreachable, so the ceiling is what must stop the loop',
  );
  assert.equal(result.passes.length, 4);
});

test('the graph inputs come from the document and the driver recomputes no order', () => {
  const document = {
    schema: 'workgraph/v1',
    phase: '07',
    schedule: ['07-02', '07-01'],
    nodes: [
      { id: '07-02', schedule_order: 9 },
      { id: '07-01', schedule_order: 4 },
    ],
    edges: [
      { from: '07-02', to: '07-01', declared: true },
      { from: '07-02', to: '07-99', declared: false },
    ],
  };
  const inputs = loop.graphInputs(document);

  // The order is taken VERBATIM. 9 and 4 are not 0 and 1, and the driver does not
  // renumber them.
  assert.deepEqual(inputs.schedule_order, { '07-02': 9, '07-01': 4 });
  // Only DECLARED edges become dependencies.
  assert.deepEqual(inputs.nodes, [
    { id: '07-02', depends_on: ['07-01'] },
    { id: '07-01', depends_on: [] },
  ]);

  // The generation changes when the graph changes and not otherwise.
  const same = loop.graphGeneration(document, loop.graphInputs(document));
  assert.equal(loop.graphGeneration(document, inputs), same);
  const moved = JSON.parse(JSON.stringify(document));
  moved.nodes[0].schedule_order = 10;
  assert.notEqual(loop.graphGeneration(moved, loop.graphInputs(moved)), same);
});

test('completion is LANDING and not exiting, and the composite key cannot collide', () => {
  // A worker that exited 0 whose land came back red is NOT complete. Marking it
  // complete on the exit code alone would mean the node is never attempted again.
  const redGate = [
    { kind: 'worker_ended', node_id: 'n1', attempt_id: 'n1#1', outcome: 'completed' },
    { kind: 'gate_ended', node_id: 'n1', attempt_id: 'n1#1', verdict: 'red' },
    { kind: 'land_completed', node_id: 'n1', attempt_id: 'n1#1', result: 'aborted:exit-1' },
  ];
  assert.deepEqual(loop.landedNodes(redGate), []);

  const greenGate = [
    { kind: 'gate_ended', node_id: 'n1', attempt_id: 'n1#1', verdict: 'green' },
    { kind: 'land_completed', node_id: 'n1', attempt_id: 'n1#1', result: 'landed' },
  ];
  assert.deepEqual(loop.landedNodes(greenGate), ['n1']);

  // A green gate on one attempt must not mark a DIFFERENT attempt landed.
  const crossed = [
    { kind: 'gate_ended', node_id: 'n1', attempt_id: 'n1#1', verdict: 'green' },
    { kind: 'land_completed', node_id: 'n1', attempt_id: 'n1#2', result: 'landed' },
  ];
  assert.deepEqual(loop.landedNodes(crossed), []);

  // THE COLLIDING PAIR. `a b` with attempt `c` and `a` with attempt `b c` are
  // different pairs. Joined on a printable separator they are the same string,
  // and 1 node's green gate would mark the other landed.
  const colliding = [
    { kind: 'gate_ended', node_id: 'a b', attempt_id: 'c', verdict: 'green' },
    { kind: 'land_completed', node_id: 'a', attempt_id: 'b c', result: 'landed' },
  ];
  assert.deepEqual(loop.landedNodes(colliding), []);
});

test('the derived state is scoped to its own run, so a second run over 1 log does not inherit the first run as done', () => {
  // FF-B121 on the WRITE side. `foldRunRecord` refuses to merge 2 runs; a driver
  // that merged them in its own derived state would do silently what the fold
  // refuses to do, and the second run would dispatch nothing at all.
  const shared = [
    { kind: 'worker_started', run_id: 'alpha', node_id: 'n1', attempt_id: 'n1#1' },
    { kind: 'gate_ended', run_id: 'alpha', node_id: 'n1', attempt_id: 'n1#1', verdict: 'green' },
    { kind: 'land_completed', run_id: 'alpha', node_id: 'n1', attempt_id: 'n1#1', result: 'landed' },
    { kind: 'worker_started', run_id: 'beta', node_id: 'n2', attempt_id: 'n2#1' },
  ];

  assert.deepEqual(loop.landedNodes(shared, 'alpha'), ['n1']);
  assert.deepEqual(
    loop.landedNodes(shared, 'beta'), [],
    'run beta landed nothing of its own, so nothing of its own is complete',
  );
  // Unfiltered, every event folds, which is what a caller inspecting a log with 1
  // run in it wants.
  assert.deepEqual(loop.landedNodes(shared), ['n1']);

  // The attempt counter is scoped the same way, or a second run would continue
  // the first run's numbering and rounds_per_artifact would describe 2 runs.
  assert.equal(loop.priorAttempts(shared, 'n1', 'alpha'), 1);
  assert.equal(loop.priorAttempts(shared, 'n1', 'beta'), 0);
  assert.equal(loop.scopedToRun(shared, 'beta').length, 1);
});

test('an attempt id is unique across the whole LOG, because the land queue keys a ticket on it', async () => {
  // `src/fleet-board.cts:399` keys a land queue ticket on the pair (node_id,
  // attempt_id) and DROPS a second `queue_entered` bearing a key it has already
  // seen. So a driver that minted `<node>#1` in 2 runs sharing 1 log would have
  // the second run's ticket vanish from the queue and its land would poll for its
  // whole timeout. This case drives the 2 runs and asserts the ids differ.
  const project = makeProject('attempt-ids', { count: 1 });
  const worker = stubWorkerSeam(project);

  const drive = (runId) => loop.runLoop({
    cwd: project.root,
    phase: project.phase,
    logPath: project.logPath,
    projectionPath: project.projectionPath,
    tokenDir: project.tokenDir,
    repoKey: 'attempt-ids/repo',
    runId,
    capacity: 1,
    clock: () => PINNED_NOW,
    maxPasses: 10,
    // Bounded hard, so a wedged queue REFUSES rather than stalling this case.
    landWaitTimeoutMs: 5000,
    landMaxPolls: 40,
    landPollIntervalMs: 5,
    preflight: allowedPreflight(),
    spawnWorker: worker,
    landCommand: stubLandSeam(),
  });

  const alpha = await drive('run-alpha');
  const beta = await drive('run-beta');
  assert.equal(alpha.stopped_by, 'drained');
  assert.equal(beta.stopped_by, 'drained', 'the second run must land its own node, not stall on a dropped ticket');

  const events = readLog(project);
  const ids = events.filter((e) => e.kind === 'worker_started').map((e) => e.attempt_id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, 'the 2 runs must not share an attempt id');
  assert.deepEqual(ids.sort(), ['run-alpha/07-01#1', 'run-beta/07-01#1']);

  // Both tickets really reached the queue, so neither was dropped as a duplicate.
  const entered = events.filter((e) => e.kind === 'queue_entered');
  assert.equal(entered.length, 2);
  const queue = boardLib.projectBoard(events).queue;
  assert.equal(queue.tickets.length, 2);
  for (const row of queue.tickets) assert.notEqual(row.completed_at, null);
  assert.equal(queue.held_by, null);
});
