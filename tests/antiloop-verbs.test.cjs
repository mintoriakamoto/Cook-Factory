'use strict';

/**
 * antiloop.* verbs: the properties under lock, not the functions.
 *
 *   - REAL EXIT CODES. Every case drives `ferrox-core/bin/ferrox-tools.cjs` as a CHILD
 *     PROCESS, so the exit code and the message text are both the ones an operator sees.
 *     Calling the exported router function proves the logic and proves nothing about the
 *     verb. Plan 01 already proved the fold with 51 tests against the built libs; this
 *     file proves that an agent running a command feels the refusal. No test in this file
 *     requires the router module.
 *   - PAIRED NEGATIVE AND CONTROL. Each of the 3 rules gets a negative case and a positive
 *     control ADJACENT and named as a pair. A file of red assertions proves a gate is loud,
 *     not that it discriminates. The control is what attributes the refusal to the rule
 *     rather than to any other cause, and each pair differs in exactly 1 input.
 *   - RULE 2 IS THE 2026-07-25 SEQUENCE. 3 rounds under 1 gate name, then a freshly named
 *     cross-audit gate with a new reviewer lineage. A gate-keyed counter reports round 1
 *     and grants the open. The pair-keyed fold reports 3 and refuses.
 *   - RULE 3 INVERTS SEVERITY ON PURPOSE. The negative case is `critical` with no
 *     reproducible command and it does NOT block. The control is `low` with a command that
 *     exited non-zero and it DOES block. A severity-routed gate would have returned the
 *     opposite pair, which is the inversion rule 3 exists to forbid.
 *   - NO ESCAPE HATCH. 4 plausible names for a flag that would buy another round are each
 *     driven at the command line and asserted to exit non-zero. This group is the standing
 *     guard against a future contributor adding one to unblock themselves, which is the
 *     literal 2026-07-25 failure expressed as an argument.
 *   - NOTHING TOUCHES THE LIVE SIDECAR. Every case writes to a scratch log under a
 *     temporary root, and a final case asserts the project's own
 *     `.planning/antiloop-log.jsonl` is byte identical across the whole file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TOOLS = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const ROUTER_SRC = path.join(REPO_ROOT, 'src', 'antiloop-command-router.cts');
const ROUTER_LIB = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'lib', 'antiloop-command-router.cjs');
const LIVE_SIDECAR = path.join(REPO_ROOT, '.planning', 'antiloop-log.jsonl');

const SPAWN_OPTS = { encoding: 'utf8', cwd: REPO_ROOT };

const SCRATCH_ROOTS = [];

/** A fresh scratch log path. The file itself is NOT created; a refused verb must not create it. */
function scratchLog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-antiloop-verbs-'));
  SCRATCH_ROOTS.push(root);
  return path.join(root, 'antiloop-log.jsonl');
}

/** Combined stdout and stderr, because a refusal reports through stderr and a success through stdout. */
function out(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

/** Count lines in a scratch log that contain a needle. Never a tail read. */
function countLines(logPath, needle) {
  if (!fs.existsSync(logPath)) return 0;
  return fs
    .readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes(needle)).length;
}

/** The live sidecar's content, or null when the project has never opened a gate. */
function liveSidecarSnapshot() {
  return fs.existsSync(LIVE_SIDECAR) ? fs.readFileSync(LIVE_SIDECAR, 'utf8') : null;
}

const LIVE_SIDECAR_BEFORE = liveSidecarSnapshot();

test.after(() => {
  for (const root of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* a scratch tree that will not delete is not a test failure */
    }
  }
});

// ─── Dispatch: the family is reachable at all ─────────────────────────────────

test('the antiloop family is dispatched rather than reported unknown', () => {
  const log = scratchLog();
  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.status', '--artifact', 'x', '--question', 'y', '--log', log],
    SPAWN_OPTS,
  );
  assert.equal(
    r.status,
    0,
    'status over an empty log must exit 0. A non-zero exit here means the family never '
      + `reached the router at all. Output: ${out(r)}`,
  );
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.rounds, 0, 'a pair with no events derives 0 rounds, not a stored default');
  assert.equal(parsed.budget.declared, false, 'a pair with no budget event reports an undeclared budget');
});

test('an unknown antiloop subcommand names the available ones', () => {
  const r = spawnSync(process.execPath, [TOOLS, 'query', 'antiloop.extend-budget'], SPAWN_OPTS);
  assert.notEqual(r.status, 0, 'an invented subcommand must not succeed');
  const text = out(r);
  assert.match(text, /Unknown antiloop subcommand/, `expected the unknown-subcommand message, got: ${text}`);
  assert.match(text, /declare-budget/, 'the message must enumerate the real verbs');
});

// ─── RULE 1: a gate with no declared budget cannot open ───────────────────────

test('RULE 1 NEGATIVE: open-round with no declared budget refuses and appends nothing', () => {
  const log = scratchLog();
  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.open-round',
      '--artifact', 'P', '--question', 'q', '--gate', 'g', '--lineage', 'a', '--log', log],
    SPAWN_OPTS,
  );
  assert.notEqual(r.status, 0, 'an unbudgeted open must exit non-zero at the command line');
  assert.match(
    out(r),
    /E_LOOP_BUDGET_UNDECLARED/,
    'the refusal must name the code. A verb that exits 1 with a bare message cannot be '
      + 'distinguished from a verb that refused the filename',
  );
  assert.equal(
    fs.existsSync(log),
    false,
    'a refused open must append NOTHING. A naive implementation that logged the attempt '
      + 'would leave a file here and inflate the derived count of the next call',
  );
});

test('RULE 1 POSITIVE CONTROL: the identical open is permitted once a budget exists', () => {
  const log = scratchLog();
  const declared = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.declare-budget',
      '--artifact', 'P', '--question', 'q', '--max-rounds', '3', '--max-lineages', '2', '--log', log],
    SPAWN_OPTS,
  );
  assert.equal(declared.status, 0, `declaring a budget must succeed. Output: ${out(declared)}`);

  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.open-round',
      '--artifact', 'P', '--question', 'q', '--gate', 'g', '--lineage', 'a', '--log', log],
    SPAWN_OPTS,
  );
  assert.equal(
    r.status,
    0,
    'the SAME command that was refused above is permitted here, and the only difference is '
      + `the budget line. That difference IS the discrimination. Output: ${out(r)}`,
  );
  assert.equal(JSON.parse(r.stdout).rounds, 1, 'the permitted open reports a derived count of 1');
});

test('RULE 1: a second budget declaration for the same pair is refused', () => {
  const log = scratchLog();
  const args = [TOOLS, 'query', 'antiloop.declare-budget',
    '--artifact', 'P', '--question', 'q', '--max-rounds', '3', '--max-lineages', '2', '--log', log];
  const first = spawnSync(process.execPath, args, SPAWN_OPTS);
  assert.equal(first.status, 0, `the first declaration must succeed. Output: ${out(first)}`);

  const second = spawnSync(process.execPath, args, SPAWN_OPTS);
  assert.notEqual(
    second.status,
    0,
    'a second declaration must fail. Re-declaring a budget mid-review is the same '
      + 'loop-extending move as renaming a gate, and a verb that accepted it would let an '
      + 'unbounded review disguise itself as a bounded one',
  );
  assert.equal(
    countLines(log, 'budget-declared'),
    1,
    'the refused declaration must not append. A naive implementation that appended and let '
      + 'the fold ignore the later line would leave a misleading budget in the evidence file',
  );
});

test('RULE 1: an absent required flag exits non-zero naming the flag', () => {
  const log = scratchLog();
  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.declare-budget',
      '--artifact', 'P', '--question', 'q', '--max-rounds', '3', '--log', log],
    SPAWN_OPTS,
  );
  assert.notEqual(r.status, 0, 'a budget missing its lineage allowance has not bounded the loop');
  assert.match(out(r), /--max-lineages/, 'the usage line must name the flag that was absent');
  assert.equal(fs.existsSync(log), false, 'a rejected declaration appends nothing');
});

// ─── RULE 2: a rename plus a lineage swap cannot reset the counter ────────────

test('RULE 2 NEGATIVE: a renamed gate and a new lineage cannot buy a 4th round against a 3 round budget', () => {
  const log = scratchLog();
  spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.declare-budget',
      '--artifact', 'P', '--question', 'q', '--max-rounds', '3', '--max-lineages', '2', '--log', log],
    SPAWN_OPTS,
  );
  for (let i = 0; i < 3; i++) {
    const seeded = spawnSync(
      process.execPath,
      [TOOLS, 'query', 'antiloop.open-round',
        '--artifact', 'P', '--question', 'q', '--gate', 'plan-check', '--lineage', 'internal', '--log', log],
      SPAWN_OPTS,
    );
    assert.equal(seeded.status, 0, `seed round ${i + 1} must open. Output: ${out(seeded)}`);
  }

  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.open-round',
      '--artifact', 'P', '--question', 'q',
      '--gate', 'cross-audit-round-1', '--lineage', 'gemini', '--log', log],
    SPAWN_OPTS,
  );
  assert.notEqual(
    r.status,
    0,
    'this is the literal 2026-07-25 move: rename the gate, swap the reviewer, open again. '
      + 'It must fail',
  );
  const text = out(r);
  assert.match(text, /E_LOOP_BUDGET_SPENT/, `the refusal must name the spent-budget code. Got: ${text}`);
  assert.match(
    text,
    /rounds 3 of 3/,
    'the derived count must be reported as 3. A gate-keyed counter would have reported 1 here, '
      + 'because the gate name is new, and would have granted the open. The count binds to the '
      + `(artifact, question) pair, so the rename buys nothing. Got: ${text}`,
  );
  assert.equal(
    countLines(log, 'round-opened'),
    3,
    'the refused 4th open must not append. 3 rounds opened, 3 rounds recorded',
  );
});

test('RULE 2 POSITIVE CONTROL: the identical sequence under a 4 round budget opens and reports 4', () => {
  const log = scratchLog();
  spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.declare-budget',
      '--artifact', 'P', '--question', 'q', '--max-rounds', '4', '--max-lineages', '2', '--log', log],
    SPAWN_OPTS,
  );
  for (let i = 0; i < 3; i++) {
    spawnSync(
      process.execPath,
      [TOOLS, 'query', 'antiloop.open-round',
        '--artifact', 'P', '--question', 'q', '--gate', 'plan-check', '--lineage', 'internal', '--log', log],
      SPAWN_OPTS,
    );
  }

  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.open-round',
      '--artifact', 'P', '--question', 'q',
      '--gate', 'cross-audit-round-1', '--lineage', 'gemini', '--log', log],
    SPAWN_OPTS,
  );
  assert.equal(
    r.status,
    0,
    'the byte-identical 4th open is permitted here, and the only difference from the negative '
      + `case is the declared allowance. That is what attributes the refusal to the budget. Output: ${out(r)}`,
  );
  const parsed = JSON.parse(r.stdout);
  assert.equal(
    parsed.rounds,
    4,
    'the permitted open reports a derived count of 4, produced by re-folding the log rather '
      + 'than by incrementing a stored number',
  );
  assert.equal(parsed.lineages, 2, 'the second reviewing lineage is counted as a set member');
});

// ─── RULE 3: only a reproducible failure blocks ───────────────────────────────

test('RULE 3 NEGATIVE: a critical finding with an empty reproducible value cannot block, and is still recorded', () => {
  const log = scratchLog();
  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.file-finding',
      '--artifact', 'P', '--question', 'q', '--finding-id', 'F1',
      '--severity', 'critical', '--category', 'correctness',
      '--blocking', '--reproducible', '', '--log', log],
    SPAWN_OPTS,
  );
  assert.notEqual(r.status, 0, 'requesting blocking without a command that failed must exit non-zero');
  assert.match(
    out(r),
    /E_LOOP_UNREPRODUCIBLE_BLOCKING/,
    'the refusal must name the unreproducible code',
  );
  assert.equal(
    countLines(log, '"blocking":false'),
    1,
    'the finding must still be APPENDED as non-blocking. Rule 3 has 2 halves: the non-zero '
      + 'exit is what an agent feels, and the recorded row is what keeps the finding from being '
      + 'lost. A naive implementation that dropped the finding would be a silent delete wearing '
      + 'the costume of a strict gate',
  );
});

test('RULE 3 POSITIVE CONTROL: a low finding with a command that failed does block', () => {
  const log = scratchLog();
  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.file-finding',
      '--artifact', 'P', '--question', 'q', '--finding-id', 'F1',
      '--severity', 'low', '--category', 'correctness',
      '--blocking', '--reproducible', 'npm test -- --files tests/antiloop-gate.test.cjs',
      '--reproducible-exit', '1', '--log', log],
    SPAWN_OPTS,
  );
  assert.equal(r.status, 0, `a reproducible failure may block. Output: ${out(r)}`);
  assert.equal(
    countLines(log, '"blocking":true'),
    1,
    'the severity is the LOWEST here and the HIGHEST in the negative case above. A '
      + 'severity-routed gate would have blocked the critical case and shipped this low one, '
      + 'which is the exact inversion rule 3 forbids. The decision is made on reproducibility '
      + 'and never on severity',
  );
});

test('RULE 3: a command that exited 0 is a prediction and does not block', () => {
  const log = scratchLog();
  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.file-finding',
      '--artifact', 'P', '--question', 'q', '--finding-id', 'F2',
      '--severity', 'critical', '--category', 'correctness',
      '--blocking', '--reproducible', 'npm test', '--reproducible-exit', '0', '--log', log],
    SPAWN_OPTS,
  );
  assert.notEqual(
    r.status,
    0,
    'a command that did not fail when the finding was filed is a prediction. A naive '
      + 'implementation that checked only for a non-empty command string would have blocked here',
  );
  assert.equal(countLines(log, '"blocking":false'), 1, 'the prediction still gets an identifier and ships past');
});

// ─── The escape hatches that do not exist ─────────────────────────────────────

test('NO ESCAPE HATCH: 4 plausible waiver flags are each rejected at the command line', () => {
  const log = scratchLog();
  spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.declare-budget',
      '--artifact', 'P', '--question', 'q', '--max-rounds', '1', '--max-lineages', '2', '--log', log],
    SPAWN_OPTS,
  );

  const waivers = [['--force'], ['--continue'], ['--reset'], ['--rounds', '0']];
  for (const waiver of waivers) {
    const r = spawnSync(
      process.execPath,
      [TOOLS, 'query', 'antiloop.open-round',
        '--artifact', 'P', '--question', 'q', '--gate', 'g', '--lineage', 'a',
        ...waiver, '--log', log],
      SPAWN_OPTS,
    );
    assert.notEqual(
      r.status,
      0,
      `${waiver[0]} must be rejected. On 2026-07-25 the counter reset because a human said to `
        + 'keep going. This assertion is the standing guard against that sentence arriving as an '
        + 'argument instead',
    );
    assert.match(
      out(r),
      /unrecognised flag/,
      `${waiver[0]} must be reported as unrecognised rather than silently ignored. An ignored `
        + 'argument is how a rejected flag becomes an accepted one by accident',
    );
    assert.match(out(r), /Accepted:/, `${waiver[0]} rejection must name the accepted flag set`);
  }
});

test('NO ESCAPE HATCH: the shipped source and the built lib declare no waiver flag', () => {
  const waiverPattern = /--(force|reset|continue)/;
  const src = fs.readFileSync(ROUTER_SRC, 'utf8');
  const lib = fs.readFileSync(ROUTER_LIB, 'utf8');

  // The guard is proven to discriminate before it is trusted: the same pattern
  // MUST match a synthetic line that does carry such a flag. A guard that never
  // fires passes every test anybody thinks to write.
  assert.equal(
    waiverPattern.test('const x = parseFlag(args, "--force");'),
    true,
    'the waiver pattern must match a line that DOES carry a waiver flag, or this whole test is inert',
  );
  assert.equal(waiverPattern.test('const x = 1;'), false, 'the waiver pattern must not match a plain line');

  assert.equal(waiverPattern.test(src), false, 'the router source declares no waiver flag anywhere');
  assert.equal(waiverPattern.test(lib), false, 'the built router lib declares no waiver flag anywhere');
});

test('NO ESCAPE HATCH: this file drives the CLI and never requires the router module', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  assert.equal(
    /require\([^)]*antiloop-command-router/.test(self),
    false,
    'an exported-function call proves the fold, which plan 01 already proved, and proves '
      + 'nothing about the verb an operator runs',
  );
  assert.equal(
    /require\([^)]*antiloop-gate/.test(self),
    false,
    'the same applies to the fold: this file is about exit codes, not about return values',
  );
});

// ─── The D8 composition at the command line ───────────────────────────────────

test('D8: a remaining unreproducible security finding escalates instead of becoming a backlog row', () => {
  const log = scratchLog();
  spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.declare-budget',
      '--artifact', 'P', '--question', 'q', '--max-rounds', '1', '--max-lineages', '2', '--log', log],
    SPAWN_OPTS,
  );
  spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.open-round',
      '--artifact', 'P', '--question', 'q', '--gate', 'plan-check', '--lineage', 'internal', '--log', log],
    SPAWN_OPTS,
  );
  spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.file-finding',
      '--artifact', 'P', '--question', 'q', '--finding-id', 'S1',
      '--severity', 'high', '--category', 'security',
      '--blocking', '--reproducible', '', '--log', log],
    SPAWN_OPTS,
  );

  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.status', '--artifact', 'P', '--question', 'q', '--log', log],
    SPAWN_OPTS,
  );
  assert.equal(r.status, 0, `status is read-only and always exits 0. Output: ${out(r)}`);
  const text = r.stdout;
  assert.match(
    text,
    /escalate-to-human/,
    'a spent budget sweeps its remaining findings into backlog rows, and that sweep must not '
      + 'swallow a security finding. Requirement STRONG-04 would be silently inverted otherwise',
  );
  assert.equal(
    /ship-with-backlog/.test(text),
    false,
    'the backlog outcome must not appear anywhere in the payload. A reader offered 2 outcomes '
      + 'will take the weaker one',
  );
  const parsed = JSON.parse(text);
  assert.equal(parsed.disposition.outcome, 'escalate-to-human', 'the disposition is the authority here');
  assert.deepEqual(parsed.disposition.security_findings, ['S1'], 'the escalated finding is named');
  assert.equal(
    parsed.blocking_findings.length,
    0,
    'rule 3 is unweakened by the escalation: that same finding is still not blocking. Closing '
      + 'the review and escalating 1 finding are different acts',
  );
});

test('D8: a spent budget with no security finding resolves to the backlog sweep', () => {
  const log = scratchLog();
  spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.declare-budget',
      '--artifact', 'P', '--question', 'q', '--max-rounds', '1', '--max-lineages', '2', '--log', log],
    SPAWN_OPTS,
  );
  spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.file-finding',
      '--artifact', 'P', '--question', 'q', '--finding-id', 'C1',
      '--severity', 'critical', '--category', 'correctness',
      '--blocking', '--reproducible', '', '--log', log],
    SPAWN_OPTS,
  );

  const r = spawnSync(
    process.execPath,
    [TOOLS, 'query', 'antiloop.status', '--artifact', 'P', '--question', 'q', '--log', log],
    SPAWN_OPTS,
  );
  assert.equal(r.status, 0, `status must exit 0. Output: ${out(r)}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(
    parsed.disposition.outcome,
    'ship-with-backlog',
    'this is the control for the escalation above: the only difference is the finding category, '
      + 'so the escalation is attributable to the security category and not to the spent budget',
  );
});

// ─── The live sidecar was never touched ───────────────────────────────────────

test('no case in this file wrote to the project sidecar', () => {
  assert.equal(
    liveSidecarSnapshot(),
    LIVE_SIDECAR_BEFORE,
    'every case passes --log pointing at a scratch root. A test that wrote to '
      + '.planning/antiloop-log.jsonl would poison the project\'s own review evidence',
  );
});
