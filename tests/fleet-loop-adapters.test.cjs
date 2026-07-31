'use strict';

/**
 * Phase 20 SC2, the PRECONDITION half: the adapter probe wired into the dispatch
 * path, asserting the whole control plane chain, and observed blocking a run.
 *
 * ─── WHY THIS FILE EXISTS SEPARATELY FROM tests/fleet-probe.test.cjs ──────────
 *
 * That file proves the probe MODULE answers correctly. This file proves the
 * RUNNING SYSTEM consults it. Plan 20-04 shipped the module and a `fleet doctor`
 * verb, and nothing ran either before a run started, so `ferrox fleet doctor`
 * could report READY on a repository whose control plane was broken while
 * `--run` started anyway. That is the exact state that produced the first real
 * dispatch's 32 refusing workers.
 *
 * ─── EVERY RULE IS ASSERTED BY NAME ──────────────────────────────────────────
 *
 * `adaptersVerdict` refuses under 4 named rules and every arm below asserts
 * WHICH one answered rather than that something refused. Two rules that both
 * fire on 1 observation would otherwise be indistinguishable, and defence in
 * depth no assertion can tell apart is defence no mutation battery can remove.
 *
 * ─── THE ARM THAT MATTERS MOST ───────────────────────────────────────────────
 *
 * The refusing arm asserts a SPAWN COUNTER wrapped around the injected worker
 * seam is still at 0. Asserting only that `dispatch_allowed` is false would pass
 * for an implementation that reports a refusal and dispatches anyway, which is a
 * guard that announces rather than a guard that fires.
 *
 * ─── SPEND ───────────────────────────────────────────────────────────────────
 *
 * No arm reaches a metered adapter. Every probe is injected except the chain,
 * which runs against a scratch fixture repository through the engine's own
 * `mock` lane, and the mock lane reaches no network and no model.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const loop = require('../scripts/fleet-loop.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const LOOP_SCRIPT = path.join(REPO_ROOT, 'scripts', 'fleet-loop.cjs');

const SCRATCH_ROOTS = [];

/**
 * The fixture that owns the ADAPTER ROSTER the 1 CHILD PROCESS arm in this file
 * runs under. Same fixture, same reason and same guard as
 * `tests/fleet-loop-cli.test.cjs`, whose ADAPTER_FIXTURE_PROJECT comment carries
 * the full account.
 *
 * In short: a NON EMPTY roster makes the fourth precondition spawn every adapter
 * in it with a real prompt, so once plan 23-05 configured this repository's own
 * roster for the live A/B, any arm that reached the preflight through the CLI
 * started making real paid calls to 3 vendors from a unit suite. Every OTHER arm
 * in this file injects `runProbe` and never had that exposure. This one is a
 * child process on purpose and cannot inject, so it supplies its own roster
 * instead, and it is an EMPTY one because `checkAdapters` returns on
 * `roster.length === 0` before the probe loop is reached.
 *
 * The project name is distinct from the CLI file's so the 2 files cannot delete
 * each other's fixture when the runner interleaves them.
 */
const ADAPTER_FIXTURE_PROJECT = 'fleet-adapters-cli-fixture';
const ADAPTER_FIXTURE_DIR = path.join(REPO_ROOT, '.planning', ADAPTER_FIXTURE_PROJECT);

/** The roster the fixture declares. Empty, and explicitly so. */
const FIXTURE_ROSTER = [];

test.before(() => {
  fs.mkdirSync(ADAPTER_FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ADAPTER_FIXTURE_DIR, 'config.json'),
    `${JSON.stringify({ fleet: { adapters: FIXTURE_ROSTER } }, null, 2)}\n`,
  );
});

function scratch(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-adapters-${tag}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

test.after(() => {
  try {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
    fs.rmSync(ADAPTER_FIXTURE_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* best effort */ }
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

/**
 * The roster the CHILD would resolve, read through the shipped precedence walk
 * rather than by re-reading the file this test wrote. See `runCli` in
 * tests/fleet-loop-cli.test.cjs for why this is a guard and not a comment.
 */
function rosterTheChildWouldSee() {
  const ca = require('../ferrox-core/bin/lib/capability-activation.cjs');
  let registry = {};
  try { registry = require('../ferrox-core/bin/lib/capability-registry.cjs'); } catch { /* absent */ }
  const saved = process.env.FERROX_PROJECT;
  process.env.FERROX_PROJECT = ADAPTER_FIXTURE_PROJECT;
  try {
    const resolved = ca.resolveConfigKey('fleet.adapters', { config: {}, cwd: REPO_ROOT, registry });
    return Array.isArray(resolved.value) ? resolved.value : null;
  } finally {
    if (saved === undefined) delete process.env.FERROX_PROJECT;
    else process.env.FERROX_PROJECT = saved;
  }
}

/** A green observation. Every arm below spoils exactly 1 field of it. */
function observation(over = {}) {
  return {
    config_key: loop.ADAPTERS_CONFIG_KEY,
    roster: ['mock'],
    verdicts: [{ identity: 'mock', verdict: 'READY', reason: null }],
    roster_verdict: { verdict: 'READY', reason: null, not_ready: [] },
    chain: { ran: true, card_minted: true, worker_completed: true },
    ...over,
  };
}

// ═══ TASK 1: the verdict, and its 4 named rules ═════════════════════════════

test('a non empty roster, every probe READY and a chain that closed is allowed', () => {
  const verdict = loop.adaptersVerdict(observation());
  assert.equal(verdict.ok, true);
  assert.equal(verdict.rule, 'adapters_observed_green');
  assert.equal(verdict.refused_because, null);
});

test('an EMPTY ROSTER refuses under its own rule and can never be allowed', () => {
  // CONTEXT D6.3 and D8 both name this: "every adapter passed" is vacuously true
  // of 0 adapters, and this repository has already shipped that shape once.
  const verdict = loop.adaptersVerdict(observation({ roster: [], verdicts: [] }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, 'empty-roster');
  assert.match(verdict.refused_because, /empty-roster/);
  assert.match(verdict.refused_because, /fleet\.adapters/);

  // The rule is judged on the ROSTER, not on the summary of it. An observation
  // carrying 0 adapters and a planted READY summary still refuses, so the empty
  // roster cannot be talked into passing by whatever computed the summary.
  const planted = loop.adaptersVerdict(observation({
    roster: [],
    verdicts: [],
    roster_verdict: { verdict: 'READY', reason: null, not_ready: [] },
  }));
  assert.equal(planted.ok, false);
  assert.equal(planted.rule, 'empty-roster');

  // A roster of empty strings is 0 named adapters wearing a length.
  const blank = loop.adaptersVerdict(observation({ roster: ['', '   '], verdicts: [] }));
  assert.equal(blank.rule, 'empty-roster');
});

test('an adapter that is not READY refuses, and EVERY such adapter is named', () => {
  const verdict = loop.adaptersVerdict(observation({
    roster: ['claude', 'codex', 'mock'],
    verdicts: [
      { identity: 'claude', verdict: 'NOT_READY', reason: 'no-nonce' },
      { identity: 'codex', verdict: 'NOT_READY', reason: 'exit' },
      { identity: 'mock', verdict: 'READY', reason: null },
    ],
    roster_verdict: { verdict: 'NOT_READY', reason: null, not_ready: ['claude', 'codex'] },
  }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, 'adapter-not-ready');
  // BOTH, not only the first. A message that names 1 of 2 dead lanes sends an
  // operator to fix half of the problem and run again.
  assert.match(verdict.refused_because, /claude/);
  assert.match(verdict.refused_because, /codex/);
  // The reason the PROBE assigned travels with the name.
  assert.match(verdict.refused_because, /no-nonce/);
  assert.match(verdict.refused_because, /exit/);
});

test('an adapter the engine cannot dispatch to keeps the reason the probe assigned', () => {
  // The probe already classified it `not-dispatchable`. Reclassifying it here
  // would lose the only sentence that tells an operator the lane needs a
  // DIVERGENCES entry and a re pin rather than a login.
  const verdict = loop.adaptersVerdict(observation({
    roster: ['wayland-core'],
    verdicts: [{ identity: 'wayland-core', verdict: 'NOT_READY', reason: 'not-dispatchable' }],
    roster_verdict: { verdict: 'NOT_READY', reason: null, not_ready: ['wayland-core'] },
  }));
  assert.equal(verdict.rule, 'adapter-not-ready');
  assert.match(verdict.refused_because, /wayland-core/);
  assert.match(verdict.refused_because, /not-dispatchable/);
});

test('a chain that minted no card refuses under chain-no-card', () => {
  const verdict = loop.adaptersVerdict(observation({
    chain: { ran: true, card_minted: false, worker_completed: false },
  }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, 'chain-no-card');
  assert.match(verdict.refused_because, /chain-no-card/);
});

test('a chain whose worker did not complete refuses under chain-worker-incomplete', () => {
  const verdict = loop.adaptersVerdict(observation({
    chain: { ran: true, card_minted: true, worker_completed: false, worker_status: 2 },
  }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, 'chain-worker-incomplete');
  assert.match(verdict.refused_because, /chain-worker-incomplete/);
  // The 2 chain refusals are DISTINCT rules. A single `chain-failed` rule would
  // be 2 refusals wearing 1 name, and no case could tell them apart.
  assert.notEqual('chain-no-card', verdict.rule);
});

test('a chain that never ran refuses rather than passing on an absent observation', () => {
  const verdict = loop.adaptersVerdict(observation({ chain: { ran: false } }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, 'chain-no-card');
});

// ── the check half, impure only by injection ────────────────────────────────

test('the check returns the fixed shape, and its refusal names the rule', () => {
  const probed = [];
  const result = loop.checkAdapters({
    roster: ['mock'],
    nonce: 'FXP-fixed',
    runProbe: (input) => {
      probed.push(input);
      return { identity: input.identity, verdict: 'NOT_READY', reason: 'empty', bin: 'echo' };
    },
    runChain: () => assert.fail('a dead adapter must refuse BEFORE the chain spends time'),
  });

  assert.equal(result.name, 'adapters');
  assert.equal(result.ok, false);
  assert.equal(result.observed.rule, 'adapter-not-ready');
  assert.match(result.refused_because, /adapter-not-ready/);
  // The observed field carries the roster, the per adapter verdicts and the
  // chain result, so a refusal is diagnostic rather than an assertion.
  assert.deepEqual(result.observed.roster, ['mock']);
  assert.equal(result.observed.verdicts.length, 1);
  assert.equal(result.observed.verdicts[0].reason, 'empty');
  assert.equal(result.observed.chain.ran, false);
  assert.equal(result.observed.chain.skipped, 'adapter-not-ready');

  // 1 call per configured adapter, all carrying the SAME nonce, and no process
  // was spawned by this arm at all.
  assert.equal(probed.length, 1);
  assert.equal(probed[0].nonce, 'FXP-fixed');
});

test('the check probes every configured adapter with 1 nonce and then runs the chain', () => {
  const probed = [];
  const chains = [];
  const result = loop.checkAdapters({
    roster: ['mock', 'claude'],
    runProbe: (input) => {
      probed.push(input);
      return { identity: input.identity, verdict: 'READY', reason: null, bin: 'x' };
    },
    runChain: (deps) => {
      chains.push(deps);
      return { ran: true, card_minted: true, worker_completed: true, work_id: 'abc123' };
    },
  });

  assert.equal(result.ok, true, `the check refused: ${result.refused_because}`);
  assert.equal(result.observed.rule, 'adapters_observed_green');
  assert.deepEqual(probed.map((p) => p.identity), ['mock', 'claude']);
  assert.equal(new Set(probed.map((p) => p.nonce)).size, 1, '1 nonce per run, not 1 per adapter');
  assert.match(probed[0].nonce, /^FXP-/);
  assert.equal(chains.length, 1, 'the chain runs exactly once for the whole roster');
  assert.equal(result.observed.chain.work_id, 'abc123');
});

test('an empty roster spends NOTHING: no probe call and no chain', () => {
  let probes = 0;
  let chains = 0;
  const result = loop.checkAdapters({
    roster: [],
    runProbe: () => { probes += 1; return { identity: 'x', verdict: 'READY', reason: null }; },
    runChain: () => { chains += 1; return { ran: true, card_minted: true, worker_completed: true }; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.observed.rule, 'empty-roster');
  assert.equal(probes, 0);
  assert.equal(chains, 0);
  assert.match(result.refused_because, /fleet\.adapters/);
});

test('the roster comes from the project config and not from this machine', () => {
  // CONTEXT D8 names the trivial pass: a probe that is green because every
  // adapter happens to be installed on the machine running it has made the
  // machine its test fixture. So the roster is READ from a project, and a
  // project that declares 2 adapters is observed probing exactly those 2.
  const root = scratch('roster');
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.planning', 'config.json'),
    JSON.stringify({ fleet: { adapters: ['codex', 'mock'] } }, null, 2),
  );
  assert.deepEqual(loop.readAdapterRoster(root), ['codex', 'mock']);

  const bare = scratch('roster-empty');
  fs.mkdirSync(path.join(bare, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(bare, '.planning', 'config.json'), JSON.stringify({}));
  assert.deepEqual(loop.readAdapterRoster(bare), []);
});

// ═══ TASK 2: the chain, through the mock adapter, at no spend ═══════════════

test('the chain spawn environment carries all 3 required variables', () => {
  const env = loop.chainSpawnEnv('/tmp/probe-home');
  // Without it the engine falls back to a path in the operator's own home
  // directory, which is the thing SC5 exists to stop.
  assert.equal(env.RATCHET_HOME, '/tmp/probe-home');
  // The vendored tree is byte pinned and 5 guards assert it carries no bytecode.
  // A bare invocation writes bytecode into it and turns 8 suite tests red.
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  // The zero spend lane. It reaches no network and no model.
  assert.equal(typeof env.RATCHET_MOCK_CMD, 'string');
  assert.notEqual(env.RATCHET_MOCK_CMD, '');
});

test('the chain builds its OWN fixture and borrows nothing from the working tree', () => {
  const seen = [];
  const result = loop.runControlPlaneChain({
    ensureControlPlane: (input) => {
      seen.push(input);
      return { home: input.home, cards: { [loop.CHAIN_NODE_ID]: { work_id: 'deadbeef01', worktree: '/x/wt' } } };
    },
    runWorker: () => ({ status: 0, stdout: 'verdict clean', stderr: '' }),
  });

  assert.equal(seen.length, 1);
  // A fixture repository, and NOT this one. Minting a probe card among the real
  // work cards would put a card for a node that does not exist into the store
  // `exec` reads.
  assert.notEqual(seen[0].repoRoot, REPO_ROOT);
  assert.ok(seen[0].repoRoot.startsWith(result.scratch), 'the fixture repo must live inside the scratch tree');
  assert.ok(seen[0].home.startsWith(result.scratch), 'the engine home must live inside the scratch tree');
  assert.deepEqual(seen[0].nodes, [loop.CHAIN_NODE_ID]);
  assert.equal(result.card_minted, true);
  assert.equal(result.worker_completed, true);
  // The scratch fixture is gone whether the chain passed or failed.
  assert.equal(fs.existsSync(result.scratch), false);
  assert.equal(result.scratch_removed, true);
});

test('the chain dispatches the WORK ID and never the node id', () => {
  // `ratchet-exec:701` matches an OPEN card on `work_id`, a content hash, and the
  // workgraph node id is the card SLUG. Passing the slug refuses with exit 2,
  // which is what all 32 workers of the first real dispatch did.
  const workers = [];
  loop.runControlPlaneChain({
    ensureControlPlane: (input) => ({
      home: input.home,
      cards: { [loop.CHAIN_NODE_ID]: { work_id: 'deadbeef01', worktree: '/x/wt' } },
    }),
    runWorker: (input) => { workers.push(input); return { status: 0, stdout: '', stderr: '' }; },
  });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].workId, 'deadbeef01');
  assert.notEqual(workers[0].workId, loop.CHAIN_NODE_ID);
});

test('a chain that minted no card reports it, and the check refuses under chain-no-card', () => {
  const chain = loop.runControlPlaneChain({
    ensureControlPlane: (input) => ({ home: input.home, cards: {} }),
    runWorker: () => assert.fail('no card means there is nothing to dispatch'),
  });
  assert.equal(chain.ran, true);
  assert.equal(chain.card_minted, false);
  assert.equal(chain.worker_completed, false);
  assert.equal(fs.existsSync(chain.scratch), false, 'the fixture is removed on the failing path too');

  const result = loop.checkAdapters({
    roster: ['mock'],
    runProbe: (input) => ({ identity: input.identity, verdict: 'READY', reason: null }),
    runChain: () => chain,
  });
  assert.equal(result.ok, false);
  assert.equal(result.observed.rule, 'chain-no-card');
});

test('a chain whose worker exits non zero refuses under chain-worker-incomplete', () => {
  const chain = loop.runControlPlaneChain({
    ensureControlPlane: (input) => ({
      home: input.home,
      cards: { [loop.CHAIN_NODE_ID]: { work_id: 'deadbeef01', worktree: '/x/wt' } },
    }),
    runWorker: () => ({ status: 2, stdout: '', stderr: 'exec: no OPEN card' }),
  });
  assert.equal(chain.card_minted, true);
  assert.equal(chain.worker_status, 2);
  assert.equal(chain.worker_completed, false);
  assert.equal(fs.existsSync(chain.scratch), false);

  const result = loop.checkAdapters({
    roster: ['mock'],
    runProbe: (input) => ({ identity: input.identity, verdict: 'READY', reason: null }),
    runChain: () => chain,
  });
  assert.equal(result.ok, false);
  assert.equal(result.observed.rule, 'chain-worker-incomplete');
});

test('a control plane that throws is reported as a refusal rather than crashing the preflight', () => {
  const chain = loop.runControlPlaneChain({
    ensureControlPlane: () => { throw new Error('REMOTES RED: origin does not match the manifest'); },
    runWorker: () => assert.fail('nothing to dispatch'),
  });
  assert.equal(chain.card_minted, false);
  assert.match(chain.error, /REMOTES RED/);
  assert.equal(fs.existsSync(chain.scratch), false);
});

test('THE REAL CHAIN: 1 card is minted and 1 worker reaches completion, at no spend', () => {
  // ROADMAP.md:477-479 binds SC2's probe to asserting card creation AND a worker
  // reaching completion end to end, not merely that an adapter answers. This is
  // the arm that observes it, against a scratch fixture repository, through the
  // engine's own mock lane, with no network, no model and no agent spend.
  //
  // ─── WHY THE ENGINE UNDER TEST IS A COPY THIS FILE OWNS ───────────────────
  //
  // RUNNING THE FLEET MUST NOT MUTATE THE ENGINE IT RUNS, and the assertion
  // below is the one that catches a violation. Pointed at the tracked tree it
  // would be VACUOUS the moment anything else had already written a
  // `__pycache__` there, which is exactly how this defect survived its first
  // measurement: a before and after comparison passes when the damage predates
  // the arm. So the subject is a copy nobody else touches, and the assertion is
  // ABSENCE rather than sameness.
  const engineSource = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet');
  const subject = scratch('engine-copy');
  fs.mkdirSync(path.join(subject, 'ferrox-core', 'bin', 'vendor'), { recursive: true });
  fs.cpSync(engineSource, path.join(subject, 'ferrox-core', 'bin', 'vendor', 'ratchet'), { recursive: true });
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
  fs.rmSync(path.join(subject, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', '__pycache__'), {
    recursive: true, force: true, maxRetries: 5, retryDelay: 50,
  });
  const subjectPycache = path.join(
    subject, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', '__pycache__',
  );
  assert.equal(fs.existsSync(subjectPycache), false, 'the subject copy did not start clean');

  const vendorPycache = path.join(engineSource, 'bin', '__pycache__');
  const pycacheBefore = fs.existsSync(vendorPycache);

  const chain = loop.runControlPlaneChain({ repoRoot: subject });

  assert.equal(chain.ran, true, `the chain did not run: ${chain.error}`);
  assert.equal(chain.card_minted, true, `no card was minted: ${chain.error}`);
  assert.match(String(chain.work_id), /^[A-Za-z0-9]+$/, 'the work id is a content hash, not a slug');
  assert.notEqual(chain.work_id, loop.CHAIN_NODE_ID);
  assert.ok(String(chain.worktree).length > 0, 'take returns the isolated worktree it created');
  assert.equal(chain.worker_status, 0, `the worker did not complete: ${chain.worker_stderr}`);
  assert.equal(chain.worker_completed, true);
  assert.equal(chain.adapter, 'mock');
  assert.equal(fs.existsSync(chain.scratch), false, 'the fixture is removed on the success path');

  // THE GUARD. `ratchet-exec:714-722` spawns its grant helper with a scrubbed
  // environment whitelist that does not carry `PYTHONDONTWRITEBYTECODE`, so
  // setting that variable on our own spawns is necessary and NOT sufficient:
  // the helper imports the kernel with bytecode writing enabled whatever the
  // caller set. The chain therefore runs the engine from a copy inside its own
  // scratch tree, and the tree it was pointed at comes back clean.
  assert.equal(fs.existsSync(subjectPycache), false,
    'the chain wrote compiled bytecode into the engine it ran, which is the byte pinned tree');
  assert.ok(String(chain.engine_root).startsWith(chain.scratch),
    'the engine the chain ran must live inside the scratch tree it deletes');
  assert.equal(fs.existsSync(vendorPycache), pycacheBefore, 'the chain touched the tracked engine');

  // And the whole thing is judged green by the pure verdict, so the chain and
  // the rule that reads it agree about what a passing chain looks like.
  const verdict = loop.adaptersVerdict(observation({ chain }));
  assert.equal(verdict.ok, true, `the verdict refused a passing chain: ${verdict.refused_because}`);
});

// ═══ TASK 3: wired into the dispatch path, and OBSERVED blocking a run ══════

/** A preflight whose adapters check refused, in the shape runPreflight returns. */
function refusedPreflight(rule = 'empty-roster') {
  return {
    checks: [
      { name: 'base', ok: true, observed: {}, refused_because: null },
      { name: 'serializer', ok: true, observed: {}, refused_because: null },
      { name: 'reclaim', ok: true, observed: {}, refused_because: null },
      {
        name: 'adapters',
        ok: false,
        observed: { roster: [], rule, config_key: loop.ADAPTERS_CONFIG_KEY },
        refused_because: `${rule}: 0 adapters are configured, so nothing was proven`,
      },
    ],
    check_names: [...loop.CHECK_NAMES],
    dispatch_allowed: false,
  };
}

function allowedPreflight() {
  return {
    checks: loop.CHECK_NAMES.map((name) => ({ name, ok: true, observed: {}, refused_because: null })),
    check_names: [...loop.CHECK_NAMES],
    dispatch_allowed: true,
  };
}

test('the preflight carries 4 checks and adapters is one of them', () => {
  assert.equal(loop.CHECK_NAMES.length, 4);
  assert.ok(loop.CHECK_NAMES.includes('adapters'));
  assert.ok(Object.isFrozen(loop.CHECK_NAMES));
});

test('a refusing adapters check alone makes dispatch_allowed false', async () => {
  const green = (name) => () => ({ name, ok: true, observed: {}, refused_because: null });
  const preflight = await loop.runPreflight({
    checkBase: green('base'),
    checkSerializer: green('serializer'),
    checkReclaim: green('reclaim'),
    checkAdapters: () => ({
      name: 'adapters',
      ok: false,
      observed: { roster: ['claude'], rule: 'adapter-not-ready' },
      refused_because: 'adapter-not-ready: claude (no-nonce)',
    }),
  });

  // There is no partial dispatch and no per check override: a precondition that
  // can be waived is a preference.
  assert.equal(preflight.dispatch_allowed, false);
  assert.deepEqual(preflight.checks.map((c) => c.name), [...loop.CHECK_NAMES]);

  // The refusal names the check AND prints what was observed.
  const rendered = loop.renderRefusal(preflight);
  assert.match(rendered, /REFUSED adapters/);
  assert.match(rendered, /adapter-not-ready/);
  assert.match(rendered, /observed:/);
  assert.match(rendered, /claude/);
});

test('THE REFUSAL BLOCKS THE RUN: the spawn counter is still at 0', async () => {
  // ─── WHY A COUNTER AND NOT A FLAG ─────────────────────────────────────────
  //
  // Asserting `dispatch_allowed === false` passes for an implementation that
  // reports a refusal and dispatches anyway. That is a guard that announces
  // rather than a guard that fires, and telling those 2 apart is the whole
  // subject of this phase. So the worker seam is WRAPPED and counted.
  const root = scratch('blocked');
  const logPath = path.join(root, 'fleet-runlog.jsonl');
  let spawns = 0;
  const spawnWorker = () => { spawns += 1; assert.fail('a refused run must spawn no worker'); };

  let printed = '';
  const summary = await loop.runLoop({
    cwd: root,
    phase: '20',
    logPath,
    tokenDir: root,
    runId: 'run-adapters-refused',
    capacity: 4,
    clock: () => 1700000000000,
    preflight: refusedPreflight('adapter-not-ready'),
    spawnWorker,
    write: (s) => { printed += s; },
  });

  assert.equal(spawns, 0, 'the worker seam was reached on a refused run');
  assert.equal(summary.dispatch_allowed, false);
  assert.equal(summary.stopped_by, 'preflight_refused');
  assert.deepEqual(summary.dispatched, []);
  assert.match(printed, /REFUSED adapters/);

  // A refused run is STILL A RUN and still brackets itself, so the record shows
  // a run that dispatched nothing rather than showing nothing at all.
  const events = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.kind), ['run_started', 'run_closed']);
  assert.equal(events[0].graph_generation, null, 'no graph was loaded, so none is claimed');
  assert.equal(events[1].stopped_by, 'preflight_refused');
  assert.equal(new Set(events.map((e) => e.run_id)).size, 1);
  assert.equal(events.filter((e) => e.kind === 'worker_started').length, 0);
});

/** A repository shaped fixture with a scannable phase directory and 0 nodes. */
function mainFixture(tag) {
  const root = scratch(tag);
  fs.mkdirSync(path.join(root, '.planning', 'phases', '98-preflight-order'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.planning', 'phases', '98-preflight-order', 'NOTES.md'),
    '# fixture\n\nA phase directory with no plans, so the graph is empty.\n',
  );
  return root;
}

test('a REFUSED run never reaches the control plane, so it mints no card and no worktree', async () => {
  // Today the dispatch branch called `ensureControlPlane` first, which mints a
  // card and a REAL git worktree per node, and only then reached the preflight.
  // A refused run had therefore already created everything before it refused,
  // which is side effect before validation and would make the refusal above
  // meaningless.
  const root = mainFixture('main-refused');
  const logPath = path.join(root, 'fleet-runlog.jsonl');
  const preflight = refusedPreflight();
  const ensureCalls = [];
  const driveCalls = [];
  let out = '';
  let err = '';

  const code = await loop.main({
    argv: ['98', '--run', '--raw', `--log=${logPath}`],
    repoRoot: root,
    runPreflight: async () => preflight,
    // The stand in DOES what the real one does: it creates the engine home. So
    // the assertion below observes an absent side effect rather than the absence
    // of a call to something that might have failed anyway.
    ensureControlPlane: (input) => {
      ensureCalls.push(input);
      fs.mkdirSync(path.join(root, '.ferrox', 'ratchet-home', 'state'), { recursive: true });
      return { home: path.join(root, '.ferrox', 'ratchet-home'), cards: {} };
    },
    runLoop: async (opts) => {
      driveCalls.push(opts);
      return {
        run_id: 'run-refused', dispatch_allowed: false, preflight: opts.preflight,
        stopped_by: 'preflight_refused', passes: [], dispatched: [], parked: [],
      };
    },
    write: (s) => { out += s; },
    writeErr: (s) => { err += s; },
  });

  assert.equal(code, 1);
  assert.equal(ensureCalls.length, 0, 'the control plane ran on a refused run');
  assert.equal(fs.existsSync(path.join(root, '.ferrox')), false,
    'a refused run left an engine home behind');

  // And it STILL calls the driver, because the refusal path is what writes
  // `run_started` and `run_closed`. An early return here would mint nothing,
  // which is correct, and would leave NO RECORD THAT A RUN WAS ATTEMPTED.
  assert.equal(driveCalls.length, 1, 'main returned early and lost the run record');
  assert.equal(driveCalls[0].preflight, preflight, 'the computed preflight was not passed through');
  assert.deepEqual(driveCalls[0].cards, {});
  assert.match(err, /REFUSED adapters/);
  assert.match(out, /"dispatch_allowed":false/);
});

test('a PASSING run still reaches the control plane and then the loop, preflighting ONCE', async () => {
  const root = mainFixture('main-passing');
  const logPath = path.join(root, 'fleet-runlog.jsonl');
  fs.writeFileSync(logPath, [
    JSON.stringify({ ts: 1, kind: 'run_started', run_id: 'run-ok', graph_generation: null, phase: '98' }),
    JSON.stringify({ ts: 2, kind: 'run_closed', run_id: 'run-ok', stopped_by: 'drained' }),
    '',
  ].join('\n'));

  const preflight = allowedPreflight();
  let preflights = 0;
  const ensureCalls = [];
  const driveCalls = [];
  let out = '';

  const code = await loop.main({
    argv: ['98', '--run', '--raw', `--log=${logPath}`],
    repoRoot: root,
    runPreflight: async () => { preflights += 1; return preflight; },
    ensureControlPlane: (input) => {
      ensureCalls.push(input);
      return { home: path.join(root, '.ferrox', 'ratchet-home'), cards: {} };
    },
    runLoop: async (opts) => {
      driveCalls.push(opts);
      return {
        run_id: 'run-ok', dispatch_allowed: true, preflight: opts.preflight,
        stopped_by: 'drained', passes: [], dispatched: [], parked: [], blocked_on_human: [],
      };
    },
    write: (s) => { out += s; },
    writeErr: () => {},
  });

  assert.equal(code, 0);
  // The reorder did not turn the working path off.
  assert.equal(ensureCalls.length, 1);
  assert.equal(ensureCalls[0].phase, '98');
  assert.deepEqual(ensureCalls[0].nodes, []);
  assert.equal(driveCalls.length, 1);
  // ONCE. The preflight creates a worktree and races 2 lands every time it runs,
  // so computing it in `main` and letting `runLoop` compute it again would pay
  // that twice and could in principle disagree with itself.
  assert.equal(preflights, 1);
  assert.equal(driveCalls[0].preflight, preflight);

  // The record is still folded and printed on the dispatching path.
  const printed = JSON.parse(out.split(/\r?\n/).filter((l) => l.startsWith('{')).pop());
  assert.equal(printed.run_record.run_id, 'run-ok');
  assert.ok(Object.prototype.hasOwnProperty.call(printed, 'control_plane'));
});

/** What the live engine home looks like, narrowly enough not to be flaky. */
function ratchetHomeSnapshot() {
  const home = path.join(REPO_ROOT, '.ferrox', 'ratchet-home');
  if (!fs.existsSync(home)) return { exists: false };
  const cards = path.join(home, 'state', 'workcards.json');
  const worktrees = path.join(home, 'worktrees');
  return {
    exists: true,
    cards: fs.existsSync(cards) ? fs.readFileSync(cards, 'utf8') : null,
    worktrees: fs.existsSync(worktrees) ? fs.readdirSync(worktrees).sort() : null,
  };
}

test('THROUGH THE CLI: a refused run writes its run record and touches no engine home', () => {
  // ─── WHY THIS ARM IS A CHILD PROCESS ──────────────────────────────────────
  //
  // An arm that calls `runLoop` directly cannot observe an early return in
  // `main`, because it never runs `main` at all. That is the same blind spot
  // that hid the missing `runLoop` wire through the whole of phase 19: A GAP
  // BETWEEN A LIBRARY AND ITS ENTRYPOINT IS INVISIBLE TO EVERY TEST THAT IMPORTS
  // THE LIBRARY.
  //
  // The phase is deliberately one with NO directory. If the ordering ever
  // regressed, `main` would build the graph before the control plane and refuse
  // there, so this arm cannot mint real cards or real git worktrees in the
  // primary tree on its way to producing the refusal. A check must not be able
  // to cause the damage it is testing for.
  const logPath = path.join(scratch('cli-refused'), 'refused.jsonl');
  const before = ratchetHomeSnapshot();

  // THE ZERO SPEND GUARD, checked BEFORE the spawn. A non empty roster here
  // would make the child probe every identity in it with a real, paid call. See
  // ADAPTER_FIXTURE_PROJECT.
  const roster = rosterTheChildWouldSee();
  assert.deepEqual(
    roster, FIXTURE_ROSTER,
    'REFUSING TO SPAWN. The adapter fixture no longer resolves to an empty roster, so this spawn '
      + `would probe ${JSON.stringify(roster)} by invoking each one as a real, paid model call.`,
  );

  const r = spawnSync(process.execPath, [LOOP_SCRIPT, '99', '--run', '--raw', `--log=${logPath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, FERROX_PROJECT: ADAPTER_FIXTURE_PROJECT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(r.signal, null, `the CLI was killed by ${r.signal}. stderr:\n${r.stderr}`);
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  // The fixture declares an empty roster, so the fourth precondition refuses.
  assert.match(r.stderr, /REFUSED adapters/);
  assert.match(r.stderr, /fleet\.adapters/);
  // NAMED, so this arm cannot be satisfied by an adapters refusal that came back
  // from 3 real probes. That distinction is the difference between a suite that
  // refuses and a suite that pays to be told no.
  assert.match(r.stderr, /empty-roster: 0 adapters are configured/);
  // The graph was never built, because the preconditions answered first.
  assert.doesNotMatch(r.stderr, /has no phase directory/);

  const events = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.kind), ['run_started', 'run_closed']);
  assert.equal(events[1].stopped_by, 'preflight_refused');
  assert.equal(new Set(events.map((e) => e.run_id)).size, 1);

  // No card and no worktree were minted in the primary tree.
  assert.deepEqual(ratchetHomeSnapshot(), before);
});
