'use strict';

/**
 * antiloop-gate-lint: the properties under lock, not the functions.
 *
 *   - REAL EXIT CODES. Every case drives `scripts/lint-antiloop-gate.cjs` as a CHILD
 *     PROCESS. Plan 01 proved the FOLD bites by calling exported functions; this file
 *     proves the GATE bites. Those are 2 different claims, and calling an exported
 *     function proves the logic and proves nothing about the gate. No test in this file
 *     calls an exported gate function directly.
 *   - 3 ADJACENT NEGATIVE AND CONTROL PAIRS, 1 PER RULE, plus the D8 security case. Each
 *     negative asserts its named error code, and the rule 2 pair asserts the DERIVED
 *     ROUND COUNT as well, because exit 1 alone cannot distinguish detecting the rename
 *     from failing for an unrelated reason.
 *   - THE DEFAULT RUN IS NOT VACUOUS. The local event log is gitignored, so in continuous
 *     integration it is normally absent and a gate whose only subject is an absent file
 *     exits 0 forever. The committed budget declarations are the subject that always
 *     exists, the subject COUNT is asserted rather than reported, and a scratch tree with
 *     the declaration deleted is asserted to fail.
 *   - NO WAIVER. The shipped source is grepped for a bypass-shaped DECLARATION rather
 *     than for the plain words, so the header sentence promising no such construct cannot
 *     trip the check that enforces it.
 *   - THE CHAIN LINK IS UNDER TEST. Removing the gate from `lint:ci` to make a build pass
 *     breaks a committed test rather than passing quietly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-antiloop-gate.cjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'antiloop');
const PHASE_15_CONTEXT = path.join(
  REPO_ROOT,
  '.planning',
  'phases',
  '15-prove-the-premise',
  'CONTEXT.md',
);
/** A committed phase context that does NOT carry the pinned subject phrase. */
const NON_SUBJECT_CONTEXT = path.join(
  REPO_ROOT,
  '.planning',
  'phases',
  '14.1-governance-truth',
  'CONTEXT.md',
);

const SCRATCH_ROOTS = [];

/** Merge the project-root seam into a child environment. */
function envWith(root) {
  const env = Object.assign({}, process.env);
  if (root !== undefined) env.FERROX_ANTILOOP_GATE_ROOT = root;
  return env;
}

/** Everything the operator sees, both streams together. */
function out(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

/**
 * A scratch project root carrying 1 phase directory whose CONTEXT declares anti-loop
 * governance. `dropBudget` removes every line naming the review budget, which is the
 * committed-subject mutation.
 */
function scratchProject(dropBudget) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-antiloop-gate-'));
  SCRATCH_ROOTS.push(root);
  const phaseDir = path.join(root, '.planning', 'phases', '15-prove-the-premise');
  fs.mkdirSync(phaseDir, { recursive: true });
  let text = fs.readFileSync(PHASE_15_CONTEXT, 'utf8');
  if (dropBudget === true) {
    text = text
      .split(/\r?\n/)
      .filter((l) => !/review budget/i.test(l))
      .join('\n');
  }
  fs.writeFileSync(path.join(phaseDir, 'CONTEXT.md'), text, 'utf8');
  return root;
}

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

// ─── the gate ships and is wired ─────────────────────────────────────────────

test('the gate ships as a committed script', () => {
  assert.ok(fs.existsSync(SCRIPT), 'scripts/lint-antiloop-gate.cjs must be committed');
});

test('the gate is the TERMINAL link of the lint:ci chain', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const chain = String(pkg.scripts['lint:ci']);
  assert.match(
    chain,
    /node scripts\/lint-antiloop-gate\.cjs/,
    'the gate must run inside lint:ci, not in a bespoke test-only runner. Removing the link to '
      + 'make a build pass is exactly what this assertion exists to catch',
  );
  assert.match(
    chain.trim(),
    /node scripts\/lint-antiloop-gate\.cjs$/,
    'the gate is the TERMINAL link, matching the phase 14.1 precedent, so every artifact it '
      + 'inspects has already been checked by the links above it',
  );
  assert.ok(
    !String(pkg.scripts['lint:generated-sync']).includes('lint-antiloop-gate'),
    'this is a policy checker and not a generator validator, so it does not join the '
      + 'generated-sync chain, following the resolution provenance lint precedent',
  );
});

test('the shipped gate declares no waiver construct of any kind', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const offenders = src
    .split(/\r?\n/)
    .filter((l) => /^\s*(?:const|let|var)\s+\w*(?:SKIP|ALLOW|EXEMPT|WAIV|BYPASS|DISABLE)\w*\s*=/i
      .test(l));
  assert.deepEqual(
    offenders,
    [],
    'a committed waiver is how a hard gate quietly becomes advisory. The check matches a '
      + 'DECLARATION rather than a word, so the header sentence promising no such construct '
      + 'cannot trip it',
  );
});

test('the shipped gate pins the subject predicate to the exact phrase, not the looser one', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(
    src,
    /anti-loop governance/,
    'the subject predicate is the exact phrase; the looser phrase selects 4 committed contexts '
      + 'that carry no budget sentence and would turn the chain red on landing',
  );
});

// ─── the default run, against this repository ────────────────────────────────

test('the default run against this repository exits 0 and names the count of validated budgets', () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: process.env,
  });
  const output = out(r);
  assert.equal(r.status, 0, output);
  assert.match(output, /^ok lint-antiloop-gate:/m, 'a silent pass is not the style here');
  assert.match(output, /[1-9]\d* committed budget declarations? validated/, 'the success line names a non-zero count');
  assert.match(output, /15-prove-the-premise/, 'and names the subject it validated');
});

test('THE SUBJECT COUNT IS ASSERTED: the default run never selects zero subjects', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--print-subject-count'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: process.env,
  });
  assert.equal(r.status, 0, out(r));
  const count = Number(String(r.stdout).trim());
  assert.ok(
    Number.isInteger(count) && count >= 1,
    'exit 0 on a gate that selected ZERO subjects is indistinguishable from exit 0 on a gate '
      + 'that checked real work, so the count must be a whole number of at least 1. '
      + `observed: ${JSON.stringify(String(r.stdout).trim())}`,
  );
});

// ─── rule 1: a gate with no declared budget cannot open ──────────────────────

test('RULE 1 NEGATIVE: the no-budget fixture exits 1 naming the undeclared-budget code', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--log', path.join(FIXTURES, 'no-budget.jsonl')],
    { encoding: 'utf8', cwd: REPO_ROOT, env: process.env },
  );
  const output = out(r);
  assert.equal(r.status, 1, output);
  assert.match(output, /E_LOOP_BUDGET_UNDECLARED/, output);
});

test('RULE 1 CONTROL: the budget-ok fixture exits 0', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--log', path.join(FIXTURES, 'budget-ok.jsonl')],
    { encoding: 'utf8', cwd: REPO_ROOT, env: process.env },
  );
  assert.equal(r.status, 0, out(r));
});

// ─── rule 2: the counter binds to the pair, never to the gate instance ───────

test('RULE 2 NEGATIVE: the gate-rename fixture exits 1, names the spent code, and reports 4 rounds', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--log', path.join(FIXTURES, 'gate-rename-reset.jsonl')],
    { encoding: 'utf8', cwd: REPO_ROOT, env: process.env },
  );
  const output = out(r);
  assert.equal(r.status, 1, output);
  assert.match(output, /E_LOOP_BUDGET_SPENT/, output);
  assert.match(
    output,
    /4 of 3 rounds/,
    'a gate-keyed counter reports 1 round here. Asserting the derived count is what attributes '
      + 'the refusal to the rename rather than to an unrelated failure',
  );
});

test('RULE 2 CONTROL: the same 5 lines under a wider allowance exit 0 and still report 4 rounds', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--log', path.join(FIXTURES, 'gate-rename-budget-4.jsonl')],
    { encoding: 'utf8', cwd: REPO_ROOT, env: process.env },
  );
  const output = out(r);
  assert.equal(r.status, 0, output);
  assert.match(
    output,
    /4 rounds/,
    'the count is 4 under both fixtures, so only the declared allowance decides the verdict',
  );
});

// ─── rule 3: an unreproducible finding cannot be blocking ────────────────────

test('RULE 3 NEGATIVE: the unreproducible blocking fixture exits 1 naming the unreproducible code', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--log', path.join(FIXTURES, 'blocking-unreproducible.jsonl')],
    { encoding: 'utf8', cwd: REPO_ROOT, env: process.env },
  );
  const output = out(r);
  assert.equal(r.status, 1, output);
  assert.match(output, /E_LOOP_UNREPRODUCIBLE_BLOCKING/, output);
});

test('RULE 3 CONTROL: the reproducible blocking fixture exits 0 at the LOWEST severity', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--log', path.join(FIXTURES, 'blocking-reproducible.jsonl')],
    { encoding: 'utf8', cwd: REPO_ROOT, env: process.env },
  );
  assert.equal(r.status, 0, out(r));
});

// ─── D8 through the shipped gate ─────────────────────────────────────────────

test('D8: a remaining security finding escalates to a human and is NOT swept into a backlog row', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--log', path.join(FIXTURES, 'security-unreproducible.jsonl')],
    { encoding: 'utf8', cwd: REPO_ROOT, env: process.env },
  );
  const output = out(r);
  assert.equal(r.status, 1, output);
  assert.match(output, /escalate-to-human/, output);
  assert.ok(
    !output.includes('ship-with-backlog'),
    'sweeping a security finding into a backlog row would silently invert STRONG-04, which '
      + 'src/strength-severity-route.cts enforces at any severity',
  );
});

// ─── the default run is not vacuous ──────────────────────────────────────────

test('THE DEFAULT RUN IS NOT VACUOUS: a committed context with its budget sentence deleted fails', () => {
  const root = scratchProject(true);
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: envWith(root),
  });
  const output = out(r);
  assert.equal(r.status, 1, output);
  assert.match(output, /E_LOOP_BUDGET_UNDECLARED/, output);
  assert.match(output, /15-prove-the-premise/, 'the failing file is named');
  assert.match(output, /CONTEXT\.md/, 'the failing file is named');
});

test('THE DEFAULT RUN CONTROL: the same scratch root with the budget sentence intact exits 0', () => {
  const root = scratchProject(false);
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: envWith(root),
  });
  const output = out(r);
  assert.equal(r.status, 0, output);
  assert.match(output, /1 committed budget declaration/, output);
});

// ─── containment ─────────────────────────────────────────────────────────────

test('a log path outside the project root is REFUSED, and no content of it is printed', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--log', '/etc/hosts'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: process.env,
  });
  const output = out(r);
  assert.equal(r.status, 1, output);
  assert.match(output, /project root/i, 'the refusal names the constraint it enforces');
  assert.ok(!/localhost/.test(output), 'no content of the refused file reaches the operator');
  assert.ok(!/127\.0\.0\.1/.test(output), 'no content of the refused file reaches the operator');
});

// ─── the declares mode, which is D7's source of truth ────────────────────────

test('--declares exits 0 for a context that declares anti-loop governance', () => {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--declares', path.relative(REPO_ROOT, PHASE_15_CONTEXT)],
    { encoding: 'utf8', cwd: REPO_ROOT, env: process.env },
  );
  assert.equal(r.status, 0, out(r));
});

test('--declares exits 1 for a context that declares none, under the PINNED predicate', () => {
  assert.ok(
    fs.existsSync(NON_SUBJECT_CONTEXT),
    'the negative specimen must stay committed, or this pair stops discriminating',
  );
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--declares', path.relative(REPO_ROOT, NON_SUBJECT_CONTEXT)],
    { encoding: 'utf8', cwd: REPO_ROOT, env: process.env },
  );
  const output = out(r);
  assert.equal(r.status, 1, output);
  assert.ok(
    /anti-loop governance/.test(output),
    'the refusal names the phrase it looked for, so the condition is mechanical rather than a '
      + 'judgement call',
  );
});

// ─── argument handling and the missing build ─────────────────────────────────

test('an unrecognised flag is a loud failure naming the accepted flags', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--skip-rule', '2'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: process.env,
  });
  const output = out(r);
  assert.equal(r.status, 1, output);
  assert.match(output, /--log/, output);
  assert.match(output, /--declares/, output);
  assert.match(output, /--print-subject-count/, output);
});

test('a flag needing a value is a loud failure rather than a silent no-op', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--log'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: process.env,
  });
  assert.equal(r.status, 1, out(r));
});

test('a missing built lib produces the build command rather than a module-not-found stack', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-antiloop-gate-nolib-'));
  SCRATCH_ROOTS.push(isolated);
  fs.mkdirSync(path.join(isolated, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(isolated, 'scripts', 'lint-antiloop-gate.cjs'));
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'lib', 'cli-exit.cjs'),
    path.join(isolated, 'scripts', 'lib', 'cli-exit.cjs'),
  );
  const r = spawnSync(
    process.execPath,
    [path.join(isolated, 'scripts', 'lint-antiloop-gate.cjs')],
    { encoding: 'utf8', env: envWith(isolated) },
  );
  const output = out(r);
  assert.equal(r.status, 1, output);
  assert.match(output, /npm run build:lib/, 'the missing build names its fix command');
  assert.ok(
    !output.includes('MODULE_NOT_FOUND'),
    'no raw module resolution stack reaches the operator',
  );
});
