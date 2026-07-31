'use strict';

/**
 * Phase 20 plan 04: SC2's probe half. `ferrox fleet doctor` probes every
 * configured adapter with a REAL prompt and refuses on anything short of a real
 * answer.
 *
 * WHY A PRESENCE PROBE IS NOT A PROBE, stated here because it is the whole
 * criterion. CONTEXT D6 records the evidence from this milestone's own 3 lineage
 * audit: 1 adapter needed 2 retries for a bad model alias and a wrong workspace
 * root, 1 burned its budget and never emitted a final report, and 1 returned a
 * hard 429 for an account with no balance. Every 1 of those 3 answers
 * `--version` correctly. So the verdict here requires a supplied nonce back out
 * of stdout, and the arm that carries the property is the one where the adapter
 * IS present, DOES exit 0, and answers WITHOUT the nonce.
 *
 * EVERY ARM DRIVES THE INJECTED RUN. `src/external-cli.cts` is pure by
 * injection: supplying `run` replaces the spawn entirely. That is what lets the
 * 429 arm, the timeout arm and the banner arm all be driven deterministically,
 * and it is what stops this file from making the machine it runs on into its own
 * test fixture. A probe battery that is green because the developer happens to
 * have 3 adapters installed has asserted nothing about the probe.
 *
 * THE COUNTER IS NOT DECORATION. `runProbe` is asserted to call the injected run
 * EXACTLY once for a dispatchable adapter and EXACTLY 0 times for one the engine
 * cannot dispatch to. The first pins the no retry contract the seam carries. The
 * second is the difference between refusing a dead lane and paying an adapter
 * vendor to tell us the lane is dead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../ferrox-core/bin/lib/fleet-probe.cjs');

const P = 'phase 20 plan 04';

const {
  ADAPTER_PROFILES,
  PROBE_VERDICTS,
  PROBE_REASONS,
  buildProbePrompt,
  buildProbeInvocation,
  evaluateProbe,
  evaluateRoster,
  runProbe,
} = probe;

/** A fixed nonce. The module holds no entropy, so the caller supplies one. */
const NONCE = 'FXP-0a1b2c3d4e5f6071';

/**
 * A spawnSync shaped runner that answers with the supplied result and counts its
 * own calls. The count is the assertion surface for the single shot contract.
 */
function countingRunner(reply) {
  const calls = [];
  const run = (bin, args, options) => {
    calls.push({ bin, args, options });
    return typeof reply === 'function' ? reply(bin, args, options) : reply;
  };
  return { run, calls };
}

// ─── PROBE_VERDICTS and PROBE_REASONS ────────────────────────────────────────

test(`${P}: the verdict and reason vocabularies are frozen and complete`, () => {
  assert.equal(Object.isFrozen(PROBE_VERDICTS), true, `${P}: PROBE_VERDICTS is not frozen`);
  assert.equal(Object.isFrozen(PROBE_REASONS), true, `${P}: PROBE_REASONS is not frozen`);
  assert.deepEqual(
    Object.values(PROBE_VERDICTS).sort(),
    ['ERROR', 'NOT_READY', 'READY'],
    `${P}: the verdict vocabulary changed`,
  );
  for (const required of ['absent', 'exit', 'empty', 'no-nonce', 'not-dispatchable', 'empty-roster']) {
    assert.ok(
      Object.values(PROBE_REASONS).includes(required),
      `${P}: the reason vocabulary lost ${required}. Observed: ${JSON.stringify(Object.values(PROBE_REASONS))}`,
    );
  }
});

// ─── buildProbePrompt and buildProbeInvocation ───────────────────────────────

test(`${P}: the prompt carries the nonce and asks for it back`, () => {
  const prompt = buildProbePrompt(NONCE);
  assert.equal(typeof prompt, 'string', `${P}: the prompt is not a string`);
  assert.ok(prompt.includes(NONCE), `${P}: the prompt does not carry the nonce. Observed: ${prompt}`);
});

test(`${P}: buildProbePrompt refuses a nonce that is not a non empty string`, () => {
  for (const bad of ['', null, undefined, 7, {}]) {
    assert.throws(
      () => buildProbePrompt(bad),
      /nonce/i,
      `${P}: buildProbePrompt accepted ${JSON.stringify(bad)} as a nonce. An empty nonce makes the ` +
        'containment check vacuously true, which is this phase\'s own defect class',
    );
  }
});

test(`${P}: buildProbeInvocation returns an argv array whose final element is the prompt`, () => {
  const prompt = buildProbePrompt(NONCE);
  for (const identity of Object.keys(ADAPTER_PROFILES)) {
    const invocation = buildProbeInvocation(identity, prompt);
    assert.equal(typeof invocation.bin, 'string', `${P}: ${identity} produced a non string bin`);
    assert.equal(Array.isArray(invocation.args), true, `${P}: ${identity} produced a non array argv`);
    assert.equal(
      invocation.args[invocation.args.length - 1],
      prompt,
      `${P}: ${identity}'s final argv element is not the prompt. Observed: ${JSON.stringify(invocation.args)}`,
    );
    assert.ok(
      invocation.args[invocation.args.length - 1].includes(NONCE),
      `${P}: ${identity}'s final argv element does not carry the nonce`,
    );
  }
});

test(`${P}: no adapter profile names an absolute path`, () => {
  // T-20-21. The seam resolves a bare binary name through PATH with shell false.
  // An absolute path here would also name a path outside this repository, which
  // the phase's hard constraints forbid outright.
  for (const [identity, argv] of Object.entries(ADAPTER_PROFILES)) {
    assert.equal(
      argv[0].includes('/') || argv[0].includes('\\'),
      false,
      `${P}: ${identity} names a path rather than a bare binary. Observed: ${argv[0]}`,
    );
  }
});

test(`${P}: buildProbeInvocation refuses an identity the probe does not carry`, () => {
  assert.throws(
    () => buildProbeInvocation('kimi', buildProbePrompt(NONCE)),
    /kimi/,
    `${P}: buildProbeInvocation invented an argv for an adapter with no profile`,
  );
});

test(`${P}: an explicit bin overrides the profile head and the rest of the argv is unchanged`, () => {
  const prompt = buildProbePrompt(NONCE);
  const base = buildProbeInvocation('codex', prompt);
  const overridden = buildProbeInvocation('codex', prompt, { bin: 'codex-canary' });
  assert.equal(overridden.bin, 'codex-canary', `${P}: the bin override was ignored`);
  assert.deepEqual(overridden.args, base.args, `${P}: the bin override changed the argv tail`);
});

// ─── evaluateProbe: the verdict mapping ──────────────────────────────────────

test(`${P}: READY needs exit 0 AND the nonce in stdout`, () => {
  const verdict = evaluateProbe({
    identity: 'claude',
    nonce: NONCE,
    result: { present: true, code: 0, stdout: `${NONCE}\n`, stderr: '' },
  });
  assert.equal(verdict.verdict, PROBE_VERDICTS.READY, `${P}: a real answer did not read READY`);
  assert.equal(verdict.reason, null, `${P}: a READY verdict carried a reason`);
  assert.equal(verdict.identity, 'claude', `${P}: the verdict lost its identity`);
});

test(`${P}: REQUIRED FAILING ARM, a present adapter that answers WITHOUT the nonce is NOT READY`, () => {
  // CONTEXT D8 row 1. This is the arm that makes the nonce matter. The adapter is
  // installed, it exits 0, and it produces plausible output. A presence probe and
  // a `--version` probe both pass here. This one must not.
  const banner = [
    'Welcome to the adapter. Model: sonnet-4-5. Workspace: /w.',
    'I am ready to help with your task.',
  ].join('\n');
  const verdict = evaluateProbe({
    identity: 'gemini',
    nonce: NONCE,
    result: { present: true, code: 0, stdout: banner, stderr: '' },
  });
  assert.equal(
    verdict.verdict,
    PROBE_VERDICTS.NOT_READY,
    `${P}: an adapter that answered without the nonce read ${verdict.verdict}. That is the exact defect ` +
      'this criterion exists to remove: a banner read as a working adapter',
  );
  assert.equal(verdict.reason, PROBE_REASONS.NO_NONCE, `${P}: the refusal carried the wrong reason`);
  assert.equal(banner.includes(NONCE), false, `${P}: the fixture banner carries the nonce, so the arm proved nothing`);
});

test(`${P}: an absent seam result is NOT READY with reason absent`, () => {
  // `present: false` is how the seam reports ENOENT, a timeout and any spawn
  // error. All 3 collapse here by design: none of them is an answer.
  const verdict = evaluateProbe({ identity: 'codex', nonce: NONCE, result: { present: false } });
  assert.equal(verdict.verdict, PROBE_VERDICTS.NOT_READY, `${P}: an absent adapter did not refuse`);
  assert.equal(verdict.reason, PROBE_REASONS.ABSENT, `${P}: the absent refusal carried the wrong reason`);
});

test(`${P}: a non zero exit refuses EVEN WHEN the nonce appears`, () => {
  // The 429 arm and the auth refusal arm. A rate limiter that helpfully echoes
  // the request back must not buy its way to READY on content alone.
  const verdict = evaluateProbe({
    identity: 'claude',
    nonce: NONCE,
    result: { present: true, code: 1, stdout: `error: 429. your prompt was ${NONCE}`, stderr: '' },
  });
  assert.equal(verdict.verdict, PROBE_VERDICTS.NOT_READY, `${P}: a non zero exit did not refuse`);
  assert.equal(verdict.reason, PROBE_REASONS.EXIT, `${P}: exit must beat content`);
});

test(`${P}: a null exit code, which is a signal death, refuses with reason exit`, () => {
  const verdict = evaluateProbe({
    identity: 'claude',
    nonce: NONCE,
    result: { present: true, code: null, stdout: NONCE, stderr: '' },
  });
  assert.equal(verdict.verdict, PROBE_VERDICTS.NOT_READY, `${P}: a signal death did not refuse`);
  assert.equal(verdict.reason, PROBE_REASONS.EXIT, `${P}: a signal death carried the wrong reason`);
});

test(`${P}: empty stdout on exit 0 refuses with reason empty`, () => {
  // The adapter that burned its budget and never emitted a final report.
  for (const stdout of ['', '   ', '\n\n\t']) {
    const verdict = evaluateProbe({
      identity: 'codex',
      nonce: NONCE,
      result: { present: true, code: 0, stdout, stderr: 'thinking...' },
    });
    assert.equal(
      verdict.verdict,
      PROBE_VERDICTS.NOT_READY,
      `${P}: stdout ${JSON.stringify(stdout)} did not refuse`,
    );
    assert.equal(verdict.reason, PROBE_REASONS.EMPTY, `${P}: an empty answer carried the wrong reason`);
  }
});

test(`${P}: REQUIRED FAILING ARM, an empty nonce can never buy a READY verdict`, () => {
  // `''.includes('')` is true for every string, so an empty nonce would make the
  // containment check vacuously true and every present adapter would read READY.
  // That is the same vacuous shape as the empty roster, 1 level down.
  for (const bad of ['', null, undefined, 0]) {
    const verdict = evaluateProbe({
      identity: 'claude',
      nonce: bad,
      result: { present: true, code: 0, stdout: 'anything at all', stderr: '' },
    });
    assert.notEqual(
      verdict.verdict,
      PROBE_VERDICTS.READY,
      `${P}: nonce ${JSON.stringify(bad)} produced READY. An empty nonce matches every string`,
    );
    assert.equal(verdict.verdict, PROBE_VERDICTS.ERROR, `${P}: a bad nonce is a caller error, not an adapter verdict`);
  }
});

test(`${P}: a missing result refuses rather than throwing`, () => {
  for (const bad of [undefined, null, {}, 'nope']) {
    const verdict = evaluateProbe({ identity: 'claude', nonce: NONCE, result: bad });
    assert.equal(
      verdict.verdict,
      PROBE_VERDICTS.NOT_READY,
      `${P}: result ${JSON.stringify(bad)} did not refuse`,
    );
  }
});

// ─── evaluateRoster: the roster verdict ──────────────────────────────────────

test(`${P}: REQUIRED FAILING ARM, an empty roster is an ERROR and can never be READY`, () => {
  // CONTEXT D6.3 and D8 row 2. "Every adapter passed" is vacuously true of 0
  // adapters. This repository already shipped that shape once inside `lint:ci`
  // at `scripts/lint-pr-check-project-dir.cjs`, repaired by plan 20-02.
  for (const roster of [[], null, undefined, 'claude', {}]) {
    const overall = evaluateRoster({ roster, verdicts: [] });
    assert.equal(
      overall.verdict,
      PROBE_VERDICTS.ERROR,
      `${P}: roster ${JSON.stringify(roster)} produced ${overall.verdict} rather than ERROR`,
    );
    assert.notEqual(
      overall.verdict,
      PROBE_VERDICTS.READY,
      `${P}: an empty roster reported READY, which is the vacuous pass this phase exists to remove`,
    );
    assert.equal(overall.reason, PROBE_REASONS.EMPTY_ROSTER, `${P}: the empty roster reason is wrong`);
  }
});

test(`${P}: an empty roster stays ERROR even when verdicts were somehow supplied`, () => {
  // A caller that passes 0 adapters but a stale verdict list must not fall
  // through to "nothing in the roster failed".
  const overall = evaluateRoster({
    roster: [],
    verdicts: [{ identity: 'claude', verdict: PROBE_VERDICTS.READY, reason: null }],
  });
  assert.equal(overall.verdict, PROBE_VERDICTS.ERROR, `${P}: a stale verdict list rescued an empty roster`);
});

test(`${P}: READY only when EVERY adapter in the roster is READY`, () => {
  const overall = evaluateRoster({
    roster: ['claude', 'codex'],
    verdicts: [
      { identity: 'claude', verdict: PROBE_VERDICTS.READY, reason: null },
      { identity: 'codex', verdict: PROBE_VERDICTS.READY, reason: null },
    ],
  });
  assert.equal(overall.verdict, PROBE_VERDICTS.READY, `${P}: a fully READY roster did not read READY`);
  assert.deepEqual(overall.not_ready, [], `${P}: a READY roster named a failing adapter`);
});

test(`${P}: NOT READY names EVERY adapter that was not READY, not only the first`, () => {
  const overall = evaluateRoster({
    roster: ['claude', 'codex', 'gemini'],
    verdicts: [
      { identity: 'claude', verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.ABSENT },
      { identity: 'codex', verdict: PROBE_VERDICTS.READY, reason: null },
      { identity: 'gemini', verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.NO_NONCE },
    ],
  });
  assert.equal(overall.verdict, PROBE_VERDICTS.NOT_READY, `${P}: a partly failing roster did not refuse`);
  assert.deepEqual(
    overall.not_ready,
    ['claude', 'gemini'],
    `${P}: the roster verdict named ${JSON.stringify(overall.not_ready)} rather than both failing adapters`,
  );
});

test(`${P}: a roster entry with NO verdict at all is not READY`, () => {
  // A probe that was never run is not a probe that passed. Silently treating a
  // missing verdict as a pass would let a dropped adapter read green.
  const overall = evaluateRoster({
    roster: ['claude', 'codex'],
    verdicts: [{ identity: 'claude', verdict: PROBE_VERDICTS.READY, reason: null }],
  });
  assert.equal(overall.verdict, PROBE_VERDICTS.NOT_READY, `${P}: a roster with an unprobed adapter read READY`);
  assert.deepEqual(overall.not_ready, ['codex'], `${P}: the unprobed adapter was not named`);
});

test(`${P}: an ERROR verdict for any single adapter carries up to the roster`, () => {
  const overall = evaluateRoster({
    roster: ['claude'],
    verdicts: [{ identity: 'claude', verdict: PROBE_VERDICTS.ERROR, reason: PROBE_REASONS.BAD_NONCE }],
  });
  assert.notEqual(overall.verdict, PROBE_VERDICTS.READY, `${P}: an errored adapter read READY at the roster level`);
});

// ─── runProbe: 1 adapter, 1 call, bounded ────────────────────────────────────

test(`${P}: runProbe calls the injected run EXACTLY once and never spawns`, () => {
  const { run, calls } = countingRunner({ status: 0, stdout: `${NONCE}`, stderr: '' });
  const verdict = runProbe({ identity: 'claude', nonce: NONCE, run });
  assert.equal(calls.length, 1, `${P}: runProbe called the seam ${calls.length} times, and the contract is exactly 1`);
  assert.equal(verdict.verdict, PROBE_VERDICTS.READY, `${P}: the injected READY answer did not read READY`);
  assert.equal(calls[0].bin, 'claude', `${P}: runProbe invoked the wrong binary`);
  assert.equal(calls[0].options.shell, false, `${P}: the seam was invoked with a shell`);
  assert.equal(
    calls[0].args[calls[0].args.length - 1].includes(NONCE),
    true,
    `${P}: the invocation did not carry the nonce`,
  );
});

test(`${P}: runProbe carries a bounded timeout into the seam`, () => {
  // T-20-20: a hung adapter must not stall a preflight that runs before every
  // fleet run. The bound is asserted as a finite positive number rather than as
  // a specific value, so tuning it is not a test edit.
  const { run, calls } = countingRunner({ status: 0, stdout: NONCE, stderr: '' });
  runProbe({ identity: 'codex', nonce: NONCE, run });
  const timeout = calls[0].options.timeout;
  assert.equal(typeof timeout, 'number', `${P}: the seam received no timeout`);
  assert.equal(Number.isFinite(timeout) && timeout > 0, true, `${P}: the timeout is not a bounded positive value`);
});

test(`${P}: an explicit timeout reaches the seam`, () => {
  const { run, calls } = countingRunner({ status: 0, stdout: NONCE, stderr: '' });
  runProbe({ identity: 'codex', nonce: NONCE, run, timeoutMs: 4321 });
  assert.equal(calls[0].options.timeout, 4321, `${P}: the supplied timeout was ignored`);
});

test(`${P}: runProbe maps a seam ENOENT onto absent without throwing`, () => {
  const enoent = () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; return { error: e }; };
  const { run, calls } = countingRunner(enoent);
  const verdict = runProbe({ identity: 'gemini', nonce: NONCE, run });
  assert.equal(calls.length, 1, `${P}: the ENOENT arm did not reach the seam exactly once`);
  assert.equal(verdict.verdict, PROBE_VERDICTS.NOT_READY, `${P}: an uninstalled adapter did not refuse`);
  assert.equal(verdict.reason, PROBE_REASONS.ABSENT, `${P}: the ENOENT refusal carried the wrong reason`);
});

test(`${P}: runProbe with a bad nonce refuses BEFORE spending a call`, () => {
  const { run, calls } = countingRunner({ status: 0, stdout: 'anything', stderr: '' });
  const verdict = runProbe({ identity: 'claude', nonce: '', run });
  assert.equal(verdict.verdict, PROBE_VERDICTS.ERROR, `${P}: an empty nonce did not error`);
  assert.equal(calls.length, 0, `${P}: a caller error still spent an adapter call`);
});

// ─── the `ferrox fleet doctor` verb ──────────────────────────────────────────

/**
 * The verb arms below drive the REAL command line interface as a child process
 * against a scratch project, so the 4 level activation precedence walk that
 * resolves `fleet.adapters` is exercised for real rather than mocked.
 *
 * Every roster used here is either EMPTY, or `mock`, or an adapter the engine
 * cannot dispatch to. None of them reaches a metered adapter, so the suite
 * spends nothing. `mock` answers by echoing the prompt back, which carries the
 * nonce, so the whole path runs end to end: roster resolution, invocation build,
 * the real seam with `shell: false`, the verdict, and the exit code.
 *
 * The scratch prefix deliberately carries NO fleet token, for the reason
 * `tests/fleet-doctor.test.cjs:48-57` records: the doctor prints absolute paths,
 * and a prefix carrying the token makes a "no fleet token anywhere" assertion
 * match the fixture's own directory name.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const CAPABILITY_JSON = path.join(REPO_ROOT, 'capabilities', 'fleet', 'capability.json');
const PROBE_SCRATCH_PREFIX = 'ferrox-fprobe-';
const PROBE_SCRATCH_ROOTS = [];

test(`${P}: the scratch prefix used by this file carries no fleet token`, () => {
  assert.equal(
    /fleet/i.test(PROBE_SCRATCH_PREFIX),
    false,
    `${P}: the scratch prefix carries a fleet token, so the doctor leak arm would match its own fixture path`,
  );
});

function scratchProject(label, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${PROBE_SCRATCH_PREFIX}${label}-`));
  PROBE_SCRATCH_ROOTS.push(root);
  fs.mkdirSync(path.join(root, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  return root;
}

function runCli(cwd, argv) {
  const res = spawnSync(process.execPath, [CLI, ...argv, '--cwd', cwd], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 120000,
  });
  let lines = [];
  try {
    const decoded = JSON.parse(res.stdout);
    if (typeof decoded === 'string') lines = decoded.split(/\r?\n/);
  } catch {
    lines = String(res.stdout || '').split(/\r?\n/);
  }
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', lines };
}

test(`${P}: REQUIRED FAILING ARM, an empty roster exits non zero and names the config key`, () => {
  // The default is an empty array, so a project that never configured the fleet
  // lands here. It must be told WHAT to set, and it must not exit 0.
  const root = scratchProject('emptyroster', { domain: 'unset' });
  const r = runCli(root, ['fleet', 'doctor']);
  assert.notEqual(r.status, 0, `${P}: an empty roster exited 0. Full output: ${r.stdout}${r.stderr}`);
  const all = `${r.stdout}\n${r.stderr}`;
  assert.ok(all.includes('fleet.adapters'), `${P}: the empty roster refusal did not name fleet.adapters. ${all}`);
  assert.ok(all.includes('empty-roster'), `${P}: the empty roster refusal did not carry its reason. ${all}`);
});

test(`${P}: an explicitly empty roster refuses exactly as an absent one does`, () => {
  const root = scratchProject('explicitempty', { fleet: { adapters: [] } });
  const r = runCli(root, ['fleet', 'doctor']);
  assert.notEqual(r.status, 0, `${P}: an explicitly empty roster exited 0`);
  assert.ok(
    `${r.stdout}${r.stderr}`.includes('fleet.adapters'),
    `${P}: the explicit empty roster refusal did not name the key`,
  );
});

test(`${P}: REQUIRED FAILING ARM, an adapter the engine cannot dispatch to is never READY`, () => {
  // kimi is carried by `ferrox-core/bin/shared/runtime-aliases.manifest.json`
  // and is NOT in the engine's PROFILES table, so it is configurable and not
  // dispatchable. It must get its own verdict rather than a green light on a
  // lane the fleet cannot use. Backlog row FF-B225 records the cost of changing
  // that. This arm spends nothing: no call is made for a lane with no profile.
  const root = scratchProject('kimi', { fleet: { adapters: ['kimi'] } });
  const r = runCli(root, ['fleet', 'doctor']);
  assert.notEqual(r.status, 0, `${P}: a non dispatchable adapter exited 0`);
  const all = `${r.stdout}\n${r.stderr}`;
  assert.ok(all.includes('kimi'), `${P}: the refusal did not name kimi. ${all}`);
  assert.ok(all.includes('not-dispatchable'), `${P}: the refusal did not carry not-dispatchable. ${all}`);
  assert.equal(
    r.lines.some((l) => /^kimi:\s*READY/.test(l)),
    false,
    `${P}: kimi reached a READY verdict. Observed: ${JSON.stringify(r.lines)}`,
  );
  assert.ok(
    r.lines.some((l) => /^kimi:\s*NOT_READY/.test(l)),
    `${P}: kimi produced no verdict line at all, so the arm above proved nothing. ` +
      `Observed: ${JSON.stringify(r.lines)}`,
  );
});

test(`${P}: the mock lane reaches READY end to end through the real seam`, { skip: process.platform === 'win32' ? 'no echo binary on win32' : false }, () => {
  // The zero spend lane. This is the ONLY arm in the repository that lets the
  // verb spawn a real process, and it proves the green path is reachable at all.
  // Without it every verb arm here would be a refusal, and a probe that has
  // never been observed passing is not a probe that has been observed working.
  const root = scratchProject('mock', { fleet: { adapters: ['mock'] } });
  const r = runCli(root, ['fleet', 'doctor']);
  assert.equal(r.status, 0, `${P}: the mock lane exited ${r.status}. stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.ok(
    r.lines.some((l) => l.startsWith('mock: READY')),
    `${P}: the mock lane produced no READY line. Observed: ${JSON.stringify(r.lines)}`,
  );
  assert.ok(
    r.lines.some((l) => l.startsWith('fleet: READY')),
    `${P}: the overall verdict line is missing. Observed: ${JSON.stringify(r.lines)}`,
  );
});

test(`${P}: 1 line per adapter, and a mixed roster refuses while still reporting the passing lane`, { skip: process.platform === 'win32' ? 'no echo binary on win32' : false }, () => {
  const root = scratchProject('mixed', { fleet: { adapters: ['mock', 'kimi'] } });
  const r = runCli(root, ['fleet', 'doctor']);
  assert.notEqual(r.status, 0, `${P}: a roster carrying a dead lane exited 0`);
  assert.ok(r.lines.some((l) => l.startsWith('mock: READY')), `${P}: the mock lane was not reported`);
  assert.ok(
    r.lines.some((l) => l.startsWith('kimi: NOT_READY (not-dispatchable')),
    `${P}: the kimi lane was not reported. Observed: ${JSON.stringify(r.lines)}`,
  );
});

test(`${P}: fleet with no subcommand refuses rather than doing something`, () => {
  const root = scratchProject('nosub', { domain: 'unset' });
  const r = runCli(root, ['fleet']);
  assert.notEqual(r.status, 0, `${P}: a bare fleet verb exited 0`);
  assert.ok(`${r.stdout}${r.stderr}`.includes('fleet doctor'), `${P}: the usage text does not name the verb`);
});

test(`${P}: ferrox doctor is untouched and still leaks no fleet token`, () => {
  // CONTEXT D6.4. `doctor` is a lookup that executes nothing and always exits 0.
  // This arm guards specifically against the edit this plan makes to
  // `ferrox-core/bin/ferrox-tools.cjs`, which is why it lives here as well as in
  // tests/fleet-doctor.test.cjs.
  const root = scratchProject('doctoruntouched', { domain: 'unset' });
  const r = runCli(root, ['doctor']);
  assert.equal(r.status, 0, `${P}: doctor exited ${r.status}. stderr: ${r.stderr}`);
  assert.equal(
    r.lines.filter((l) => /fleet/i.test(l)).length,
    0,
    `${P}: doctor leaked a fleet token for a project with no fleet configuration. ` +
      `Offending lines: ${JSON.stringify(r.lines.filter((l) => /fleet/i.test(l)))}`,
  );
  assert.ok(r.lines.some((l) => l.startsWith('running cli: ')), `${P}: doctor produced no output at all`);
});

// ─── the capability declaration ──────────────────────────────────────────────

test(`${P}: fleet.adapters is declared as an array defaulting to empty`, () => {
  const declared = JSON.parse(fs.readFileSync(CAPABILITY_JSON, 'utf8'));
  const key = declared.config['fleet.adapters'];
  assert.ok(key, `${P}: fleet.adapters is not declared in the capability config block`);
  assert.equal(key.type, 'array', `${P}: fleet.adapters is typed ${key.type} rather than array`);
  assert.deepEqual(key.default, [], `${P}: the default roster is not empty`);
});

test(`${P}: the fleet capability still contributes nothing on all 7 surfaces`, () => {
  // CONTEXT D6.5 and tests/fleet-doctor.test.cjs:449-457. Phase 18 SC3 holds by
  // this count being 0 rather than by argument. A `commands` entry for the new
  // verb would change the base install for every user who never enables the
  // fleet, which is why the verb is a case in the command line interface
  // instead. That test checks the INSTALLED registry; this one checks the
  // SOURCE declaration, so a source edit is caught without an install run.
  const declared = JSON.parse(fs.readFileSync(CAPABILITY_JSON, 'utf8'));
  for (const surface of ['skills', 'agents', 'commands', 'hooks', 'steps', 'contributions', 'gates']) {
    const value = declared[surface] || [];
    assert.equal(
      value.length,
      0,
      `${P}: the fleet capability declares ${value.length} ${surface}. Observed: ${JSON.stringify(value)}`,
    );
  }
});

test(`${P}: the generated capability registry carries the new key with the same default`, () => {
  const reg = require('../ferrox-core/bin/lib/capability-registry.cjs');
  const entry = reg.configSchema['fleet.adapters'];
  assert.ok(entry, `${P}: fleet.adapters is absent from the generated registry. Run npm run gen:capability-registry`);
  assert.deepEqual(entry.default, [], `${P}: the generated default roster is not empty`);
});

test.after(() => {
  for (const dir of PROBE_SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

// ─── the engine agreement check ──────────────────────────────────────────────

/**
 * The roster this project probes is a CLAIM about a file this project does not
 * author. `ferrox-core/bin/vendor/ratchet/bin/ratchet-exec` is byte pinned and
 * upstream owned, so the claim is checked against the real file on every run
 * rather than trusted as a copy.
 *
 * THE VACUOUS ARM IS THE ONE THAT MATTERS. An extractor that silently finds 0
 * identities agrees with every roster, and a regular expression that stops
 * matching after an upstream reformat produces exactly that. So the extractor is
 * driven against a text with no literal, against a literal carrying 0
 * identities, and against an unterminated literal, and it must REFUSE in all 3.
 *
 * Reading this file is not running it, so no interpreter byte cache is touched
 * and the byte pinned tree stays pristine.
 */

const ENGINE_EXEC = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet', 'bin', 'ratchet-exec');
const ALIAS_MANIFEST = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'shared', 'runtime-aliases.manifest.json');

function engineSource() {
  return fs.readFileSync(ENGINE_EXEC, 'utf8');
}

test(`${P}: the extractor reads real adapter identities out of the vendored engine`, () => {
  const engine = probe.extractEngineProfiles(engineSource());
  const identities = Object.keys(engine).sort();
  assert.ok(
    identities.length >= 4,
    `${P}: the extraction found ${identities.length} identities, which is fewer than the engine declares. ` +
      `Observed: ${JSON.stringify(identities)}`,
  );
  for (const expected of ['claude', 'codex', 'gemini', 'wayland-core']) {
    assert.ok(
      identities.includes(expected),
      `${P}: the extraction lost ${expected}. Observed: ${JSON.stringify(identities)}`,
    );
  }
  // A positive anchor, so an extractor that returns identities with empty argvs
  // cannot satisfy the agreement arm below by matching nothing against nothing.
  assert.deepEqual(
    engine.gemini,
    ['gemini', '--skip-trust', '-p'],
    `${P}: the extracted argv for gemini is not the literal the engine declares`,
  );
});

test(`${P}: every probed adapter carries the engine's argv prefix byte for byte`, () => {
  const engine = probe.extractEngineProfiles(engineSource());
  for (const [identity, argv] of Object.entries(ADAPTER_PROFILES)) {
    if (identity === probe.ENGINE_MOCK_IDENTITY) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(engine, identity),
      `${P}: this project probes ${identity}, which the engine's PROFILES table does not carry. Either the ` +
        'roster gained a lane the fleet cannot dispatch to, or upstream dropped one',
    );
    assert.deepEqual(
      [...argv],
      engine[identity],
      `${P}: the argv prefix for ${identity} has drifted from the engine's. ` +
        `Ours: ${JSON.stringify([...argv])}. The engine's: ${JSON.stringify(engine[identity])}`,
    );
  }
});

test(`${P}: every engine adapter this project does NOT probe is named with a reason`, () => {
  // The other direction. A table that names its own exclusions cannot silently
  // shrink, and a comment cannot be read by a test. Same shape as the
  // GUARD_SURFACE roster plan 20-01 built.
  const engine = probe.extractEngineProfiles(engineSource());
  for (const identity of Object.keys(engine)) {
    if (Object.prototype.hasOwnProperty.call(ADAPTER_PROFILES, identity)) continue;
    const reason = probe.NOT_PROBED[identity];
    assert.equal(
      typeof reason === 'string' && reason.trim().length > 0,
      true,
      `${P}: the engine dispatches to ${identity} and this project neither probes it nor names it in ` +
        'NOT_PROBED with a reason. An adapter dropped from scope with no signal is the silent shrink this ' +
        'phase exists to remove',
    );
  }
  assert.ok(
    Object.keys(probe.NOT_PROBED).length > 0,
    `${P}: NOT_PROBED is empty, so the arm above iterated nothing and proved nothing`,
  );
});

test(`${P}: NOT_PROBED carries no adapter that IS probed`, () => {
  // A stale exclusion is drift in the other direction: it would let a probed
  // adapter be quietly excused from the argv agreement above.
  for (const identity of Object.keys(probe.NOT_PROBED)) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(ADAPTER_PROFILES, identity),
      false,
      `${P}: ${identity} is both probed and excluded, so its argv agreement is never checked`,
    );
  }
});

test(`${P}: the mock exclusion is evidence backed rather than assumed`, () => {
  // `mock` is dispatchable by the engine and is NOT in its PROFILES table: the
  // engine special cases it before the table lookup. That is why it is exempt
  // from the argv agreement, and the exemption is read from the engine rather
  // than asserted here in prose.
  const source = engineSource();
  assert.ok(
    /if cli == "mock"/.test(source),
    `${P}: the engine no longer special cases the mock lane, so exempting it from the argv agreement is ` +
      'no longer justified',
  );
  const engine = probe.extractEngineProfiles(source);
  assert.equal(
    Object.prototype.hasOwnProperty.call(engine, probe.ENGINE_MOCK_IDENTITY),
    false,
    `${P}: mock now appears in the PROFILES table, so it should be held to the argv agreement like the rest`,
  );
});

test(`${P}: REQUIRED FAILING ARM, the extractor REFUSES an empty extraction`, () => {
  // The vacuous pass. A check that passes because it found nothing is the
  // "nothing is missing is vacuously true of an empty payload" shape, live in
  // this repository's own lint chain until plan 20-02 repaired it.
  assert.throws(
    () => probe.extractEngineProfiles('def main():\n    return 0\n'),
    /PROFILES/,
    `${P}: a text with no PROFILES literal did not refuse, so an upstream reformat would pass silently`,
  );
  assert.throws(
    () => probe.extractEngineProfiles('PROFILES = {\n    # every entry removed\n}\n'),
    /0 adapter identities/,
    `${P}: a PROFILES literal carrying 0 identities did not refuse`,
  );
  assert.throws(
    () => probe.extractEngineProfiles('PROFILES = {\n    "claude": ["claude", "-p"],\n'),
    /not terminated/,
    `${P}: an unterminated PROFILES literal did not refuse`,
  );
  for (const bad of ['', null, undefined, 7]) {
    assert.throws(
      () => probe.extractEngineProfiles(bad),
      /empty|PROFILES/i,
      `${P}: the extractor accepted ${JSON.stringify(bad)} as engine source`,
    );
  }
});

test(`${P}: the extractor accepts a well formed literal, so the refusals above are not blanket`, () => {
  const parsed = probe.extractEngineProfiles([
    'PROFILES = {',
    '    "alpha": ["alpha", "-p"],',
    '    # a comment between entries',
    '    "beta":  ["beta"],',
    '}',
    'argv = PROFILES[cli] + [prompt]',
  ].join('\n'));
  assert.deepEqual(parsed, { alpha: ['alpha', '-p'], beta: ['beta'] }, `${P}: the extractor mis-parsed a valid literal`);
});

// ─── kimi: the decision, its premise, and the verdict it gets ────────────────

test(`${P}: the premise of FF-B225 holds, read from both files rather than assumed`, () => {
  // The 2 rosters disagree in BOTH directions, and that disagreement is the
  // whole reason kimi is excluded rather than dropped.
  const aliases = JSON.parse(fs.readFileSync(ALIAS_MANIFEST, 'utf8'));
  const engine = probe.extractEngineProfiles(engineSource());
  assert.ok(
    Object.prototype.hasOwnProperty.call(aliases, 'kimi'),
    `${P}: kimi is no longer in the runtime alias manifest, so FF-B225's premise has changed`,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(engine, 'kimi'),
    false,
    `${P}: the engine now dispatches to kimi. FF-B225 can be closed and kimi added to the probe roster`,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(aliases, 'gemini'),
    false,
    `${P}: gemini is now in the alias manifest, so the recorded correction about the 2 rosters is stale`,
  );
});

test(`${P}: REQUIRED FAILING ARM, runProbe refuses a non dispatchable adapter and spends NO call`, () => {
  // The runner below would produce a READY verdict for any dispatchable adapter:
  // present, exit 0, and the nonce in stdout. kimi still refuses, and it refuses
  // BEFORE the seam is reached, so a lane the fleet cannot use costs nothing.
  const { run, calls } = countingRunner({ status: 0, stdout: NONCE, stderr: '' });
  const verdict = runProbe({ identity: 'kimi', nonce: NONCE, run });
  assert.equal(
    verdict.verdict,
    PROBE_VERDICTS.NOT_READY,
    `${P}: kimi read ${verdict.verdict} against an answer that would make any real adapter READY`,
  );
  assert.equal(verdict.reason, PROBE_REASONS.NOT_DISPATCHABLE, `${P}: the refusal carried the wrong reason`);
  assert.equal(calls.length, 0, `${P}: a lane the engine cannot dispatch to still spent ${calls.length} call(s)`);
});

test(`${P}: evaluateProbe cannot be talked into READY for a non dispatchable adapter`, () => {
  const verdict = evaluateProbe({
    identity: 'kimi',
    nonce: NONCE,
    result: { present: true, code: 0, stdout: NONCE, stderr: '' },
  });
  assert.equal(verdict.verdict, PROBE_VERDICTS.NOT_READY, `${P}: a perfect answer bought READY for a dead lane`);
  assert.equal(verdict.reason, PROBE_REASONS.NOT_DISPATCHABLE, `${P}: the refusal carried the wrong reason`);
});

test(`${P}: a roster carrying a non dispatchable adapter is never READY overall`, () => {
  const overall = evaluateRoster({
    roster: ['claude', 'kimi'],
    verdicts: [
      { identity: 'claude', verdict: PROBE_VERDICTS.READY, reason: null },
      { identity: 'kimi', verdict: PROBE_VERDICTS.NOT_READY, reason: PROBE_REASONS.NOT_DISPATCHABLE },
    ],
  });
  assert.equal(overall.verdict, PROBE_VERDICTS.NOT_READY, `${P}: a roster with a dead lane read READY`);
  assert.deepEqual(overall.not_ready, ['kimi'], `${P}: the dead lane was not named`);
});
