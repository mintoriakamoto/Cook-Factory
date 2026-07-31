'use strict';

/**
 * governance-scope-lint: the properties under lock, not the functions.
 *
 *   - REAL EXIT CODES: every case drives `scripts/lint-governance-scope.cjs` as a CHILD
 *     PROCESS, so the exit code and the message text are both the ones an operator sees.
 *     Calling an exported function proves the logic and proves nothing about the gate.
 *   - PER FILE RULE SETS: the state file is checked on its FRONTMATTER declaration plus
 *     its structural contract and is deliberately NOT asked for a prose declaration,
 *     because plan 02 deleted every prose surface it had. The 2 prose-bearing files are
 *     checked on the visible declaration plus the body. A test that treated the 3 files
 *     alike would pass while the checker contradicted the structure it guards.
 *   - THE SC4 END TO END PROOF: the committed regression fixture, whose declaration is
 *     CORRECT and whose body is STALE, must be rejected by the SHIPPED SCRIPT through a
 *     single named invocation, and the output must name the stale-body error code. Exit 1
 *     alone cannot distinguish "detected the defect" from "refused the filename".
 *   - THE VERSIONLESS GUARANTEE HOLDS THROUGH THE GATE: a prose line naming no version at
 *     all, inserted into the state file, fails. 3 of the 4 drifts observed in that file on
 *     2026-07-25 named no version, so a gate that only caught versioned claims would have
 *     missed 3 of 4 real cases.
 *   - NO EXEMPTION: the shipped script declares no skip list, fence array or allowlist of
 *     any kind, and a committed test greps the source for one rather than trusting prose.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-governance-scope.cjs');
const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'governance',
  'STATE-declaration-ok-body-stale.md',
);

// ─── builders ────────────────────────────────────────────────────────────────

const MILESTONE_ARTIFACT = [
  '---',
  'milestone: "1.14"',
  'name: "Fleet Mode"',
  'lifecycle: active',
  'shipped: []',
  'artifact_kind: milestone',
  '---',
  '',
  '# Fleet Mode',
  '',
  'A scratch artifact.',
  '',
].join('\n');

const SCRATCH_STATE = [
  '---',
  'ferrox_state_version: 1.0',
  'milestone: v1.14',
  'milestone_name: Fleet Mode',
  'current_phase: 14.1',
  'current_phase_name: governance-truth',
  'status: executing',
  'last_updated: "2026-07-25T15:29:51.936Z"',
  'last_activity: 2026-07-25',
  'progress:',
  '  total_phases: 2',
  '  completed_phases: 1',
  '  total_plans: 5',
  '  completed_plans: 4',
  'current_plan: 2',
  '---',
  '',
  '# Project State',
  '',
  '## Current Position',
  '',
  'Phase: 14.1 (governance-truth)',
  'Plan: 4 of 4 in current phase',
  'Status: Ready to execute',
  'Last activity: 2026-07-25',
  '',
].join('\n');

const SCRATCH_PROJECT = [
  '# Scratch Project',
  '',
  '> **Scope: milestone v1.14 (Fleet Mode).** The durable contract only. Position lives',
  '> in the state file.',
  '',
  '## Requirements',
  '',
  '- [x] **R1 Forked spine** (shipped_in: v1.14, Phase 1): the spine is forked.',
  '- [ ] **R2 Fleet mode** (shipped_in: pending, Phase 21): the fleet is not built yet.',
  '',
].join('\n');

const SCRATCH_ROADMAP = [
  '# Roadmap: Scratch',
  '',
  '> **Scope: milestone v1.14 (Fleet Mode).** The phase projection of the artifact.',
  '',
  '## Phases',
  '',
  '- [ ] **Phase 14: The Milestone Index** - Index the milestones',
  '',
].join('\n');

const SCRATCH_ROOTS = [];

function scratchProject(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-gov-scope-'));
  SCRATCH_ROOTS.push(root);
  const planning = path.join(root, '.planning');
  fs.mkdirSync(planning, { recursive: true });
  fs.writeFileSync(
    path.join(planning, 'MILESTONE-v1.14-FLEET-MODE.md'),
    o.milestone === undefined ? MILESTONE_ARTIFACT : o.milestone,
    'utf8',
  );
  if (o.secondMilestone !== undefined) {
    fs.writeFileSync(path.join(planning, 'MILESTONE-v1.15-LATER.md'), o.secondMilestone, 'utf8');
  }
  fs.writeFileSync(
    path.join(planning, 'STATE.md'),
    o.state === undefined ? SCRATCH_STATE : o.state,
    'utf8',
  );
  fs.writeFileSync(
    path.join(planning, 'PROJECT.md'),
    o.project === undefined ? SCRATCH_PROJECT : o.project,
    'utf8',
  );
  fs.writeFileSync(
    path.join(planning, 'ROADMAP.md'),
    o.roadmap === undefined ? SCRATCH_ROADMAP : o.roadmap,
    'utf8',
  );
  return root;
}

/** Drive the shipped script as a real child process. */
function run(args, root) {
  const env = Object.assign({}, process.env);
  if (root !== undefined) env.FERROX_GOVERNANCE_SCOPE_ROOT = root;
  const result = spawnSync(process.execPath, [SCRIPT].concat(args || []), {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env,
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
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

// ─── the shipped script exists and is wired ──────────────────────────────────

test('the checker ships as a script and is a link in the lint:ci chain', () => {
  assert.ok(fs.existsSync(SCRIPT), 'scripts/lint-governance-scope.cjs must be committed');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const chain = pkg.scripts['lint:ci'];
  assert.match(
    chain,
    /node scripts\/lint-governance-scope\.cjs/,
    'the checker must run inside lint:ci, not in a bespoke test-only runner',
  );
  assert.ok(
    !String(pkg.scripts['lint:generated-sync']).includes('lint-governance-scope'),
    'this is a pure lint and not a generator, so it does not join the generated-sync chain',
  );
});

test('the shipped script declares no exemption constant of any kind', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const offenders = src
    .split(/\r?\n/)
    .filter((l) => /^\s*(?:const|let|var)\s+\w*(?:SKIP|EXEMPT|ALLOW|FENCE|IGNORE|WAIVE)\w*\s*=/i.test(l));
  assert.deepEqual(
    offenders,
    [],
    'a committed exemption is how a global invariant quietly stops applying to the file it was written for',
  );
});

test('the default run names the 3 governance files it inspects', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  for (const name of ['STATE.md', 'PROJECT.md', 'ROADMAP.md']) {
    assert.ok(src.includes(name), `${name} must be one of the inspected files`);
  }
});

// ─── the default run, against the real repository ────────────────────────────

test('run with no arguments against the repository as it stands, the checker exits 0', () => {
  const r = run([]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^ok lint-governance-scope:/m, 'the success line names the check');
  assert.match(r.output, /\.planning\/STATE\.md/);
  assert.match(r.output, /\.planning\/PROJECT\.md/);
  assert.match(r.output, /\.planning\/ROADMAP\.md/);
});

test('a compliant scratch tree exits 0, so the pass is not an artefact of the live repository', () => {
  const r = run([], scratchProject({}));
  assert.equal(r.status, 0, r.output);
});

// ─── the prose-bearing rule set ──────────────────────────────────────────────

test('a current-state claim naming a superseded milestone in PROJECT.md fails, with the file and the 1-based line', () => {
  const lines = SCRATCH_PROJECT.split(/\r?\n/);
  lines.splice(5, 0, '**Current focus:** v1.1 "Reach and Triage"');
  const root = scratchProject({ project: lines.join('\n') });
  const r = run([], root);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_STALE_BODY/);
  assert.match(r.output, /PROJECT\.md:6/, 'the 1-based line number of the inserted claim');
  assert.match(r.output, /Current focus/, 'the offending line is quoted back');
});

test('a current-state claim written as a HEADING in PROJECT.md fails, even though it names no version', () => {
  const project = `${SCRATCH_PROJECT}\n## Current Milestone\n`;
  const r = run([], scratchProject({ project }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_HEADING_CLAIM/);
  assert.match(r.output, /PROJECT\.md/);
  assert.match(r.output, /Current Milestone/, 'the offending heading is quoted back');
  assert.ok(
    !/v\d+\.\d+/.test('## Current Milestone'),
    'the specimen names no version, so the versioned body check cannot see it and the heading rule is what catches it',
  );
});

test('a hand-written numbered phase heading in ROADMAP.md stays legitimate, so the heading rule did not over-match', () => {
  const roadmap = `${SCRATCH_ROADMAP}\n### Phase 14: The Milestone Index\n\nDetail prose about the phase.\n`;
  const r = run([], scratchProject({ roadmap }));
  assert.equal(r.status, 0, r.output);
});

test('removing the scope declaration from PROJECT.md fails with the missing-declaration code', () => {
  const project = SCRATCH_PROJECT.split(/\r?\n/)
    .filter((l) => !/\*\*Scope: milestone/.test(l))
    .join('\n');
  const r = run([], scratchProject({ project }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_SCOPE_MISSING/);
  assert.match(r.output, /PROJECT\.md/);
});

test('removing the scope declaration from ROADMAP.md fails with the missing-declaration code', () => {
  const roadmap = SCRATCH_ROADMAP.split(/\r?\n/)
    .filter((l) => !/\*\*Scope: milestone/.test(l))
    .join('\n');
  const r = run([], scratchProject({ roadmap }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_SCOPE_MISSING/);
  assert.match(r.output, /ROADMAP\.md/);
});

test('a declaration naming a version other than the active one fails with the mismatch code', () => {
  const project = SCRATCH_PROJECT.replace('v1.14 (Fleet Mode)', 'v1.13 (Creative Line)');
  const r = run([], scratchProject({ project }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_SCOPE_MISMATCH/);
  assert.match(r.output, /v1\.13/);
  assert.match(r.output, /v1\.14/, 'the message names BOTH versions, not just the wrong one');
});

test('a shipped pointer naming a version that never shipped fails the SC6 gate', () => {
  const project = SCRATCH_PROJECT.replace('shipped_in: v1.14', 'shipped_in: v9.9');
  const r = run([], scratchProject({ project }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_SHIPPED_IN_UNRESOLVED/);
  assert.match(r.output, /R1/, 'the failing requirement is named');
});

test('the shipped-pointer gate applies to PROJECT.md and not to ROADMAP.md', () => {
  const roadmap = `${SCRATCH_ROADMAP}\n- [x] **R9 Something** (shipped_in: v9.9): not a requirement ledger.\n`;
  const r = run([], scratchProject({ roadmap }));
  assert.equal(r.status, 0, r.output);
});

// ─── the structural rule set ─────────────────────────────────────────────────

test('the state file is NOT asked for a prose declaration, because it has no prose left to rot', () => {
  const r = run([], scratchProject({}));
  assert.equal(r.status, 0, r.output);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(
    src,
    /prose[- ]declaration/i,
    'the reason the state file carries no prose-declaration rule is written in the script itself',
  );
});

test('a state frontmatter milestone key naming a version other than the active one fails', () => {
  const state = SCRATCH_STATE.replace('milestone: v1.14', 'milestone: v1.1');
  const r = run([], scratchProject({ state }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_SCOPE_MISMATCH/);
  assert.match(r.output, /STATE\.md/);
  assert.ok(
    !/add one bolded sentence/i.test(r.output),
    'the state file is never told to add a prose declaration line',
  );
});

test('a state file with no frontmatter milestone key fails, naming the frontmatter key rather than a prose line', () => {
  const state = SCRATCH_STATE.split(/\r?\n/)
    .filter((l) => !/^milestone: /.test(l))
    .join('\n');
  const r = run([], scratchProject({ state }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_SCOPE_MISSING/);
  assert.match(r.output, /frontmatter/i);
});

test('free prose in the state file fails EVEN WHEN IT NAMES NO VERSION AT ALL', () => {
  const state = `${SCRATCH_STATE}Ratchet is absorbed as the fleet engine, same pattern as before.\n`;
  const r = run([], scratchProject({ state }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_STATE_PROSE/);
  assert.ok(
    !/v\d+\.\d+/.test('Ratchet is absorbed as the fleet engine, same pattern as before.'),
    'the specimen names no version, which is what makes this case the versionless proof',
  );
});

test('a section outside the closed set fails in the state file', () => {
  const state = `${SCRATCH_STATE}\n## Accumulated Context\n\nDecisions live here again.\n`;
  const r = run([], scratchProject({ state }));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /E_GOV_STATE_SECTION/);
});

// ─── the single-file mode, which is the SC4 end to end entry point ───────────

test('the committed SC4 fixture is REJECTED by the shipped gate, and the output names the stale-body code', () => {
  assert.ok(fs.existsSync(FIXTURE), 'the SC4 regression fixture must stay committed');
  const r = run(['--kind', 'state', '--file', path.relative(REPO_ROOT, FIXTURE)]);
  assert.equal(r.status, 1, r.output);
  assert.match(
    r.output,
    /E_GOV_STALE_BODY/,
    'exit 1 alone cannot distinguish detecting the defect from refusing the filename',
  );
  assert.ok(
    !/is not a recognised governance file/.test(r.output),
    'the --kind flag overrides base name inference, so the fixture reaches the rule it exists to prove',
  );
});

test('the single-file mode passes the current state file', () => {
  const r = run(['--file', '.planning/STATE.md']);
  assert.equal(r.status, 0, r.output);
});

test('a path outside the repository root is REFUSED, and no content of it is printed', () => {
  const r = run(['--file', '/etc/hosts']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /repository root/i, 'the refusal names the constraint it enforces');
  assert.ok(!/localhost/.test(r.output), 'no content of the refused file reaches the operator');
  assert.ok(!/127\.0\.0\.1/.test(r.output), 'no content of the refused file reaches the operator');
});

test('an unrecognised base name is a loud failure naming the 3 recognised files', () => {
  const r = run(['--file', 'package.json']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /STATE\.md/);
  assert.match(r.output, /PROJECT\.md/);
  assert.match(r.output, /ROADMAP\.md/);
});

test('an unrecognised --kind value is a loud failure naming the 3 rule sets', () => {
  const r = run(['--kind', 'bogus', '--file', '.planning/STATE.md']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /state/);
  assert.match(r.output, /project/);
  assert.match(r.output, /roadmap/);
});

test('an unrecognised argument is a loud failure carrying the usage line', () => {
  const r = run(['--everything']);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /--file/);
});

// ─── D1 resolution and the missing build ─────────────────────────────────────

test('zero active artifacts and more than 1 active artifact are both loud, and carry different messages', () => {
  const inactive = MILESTONE_ARTIFACT.replace('lifecycle: active', 'lifecycle: complete');
  const noneRun = run([], scratchProject({ milestone: inactive }));
  assert.equal(noneRun.status, 1, noneRun.output);
  assert.match(noneRun.output, /lifecycle: active/);

  const second = MILESTONE_ARTIFACT.replace('"1.14"', '"1.15"').replace('"Fleet Mode"', '"Later"');
  const manyRun = run([], scratchProject({ secondMilestone: second }));
  assert.equal(manyRun.status, 1, manyRun.output);
  assert.notEqual(
    noneRun.output,
    manyRun.output,
    'the 2 D1 failure modes must be distinguishable by an operator',
  );
});

test('a missing built lib produces the build command rather than a module-not-found stack', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-gov-scope-nolib-'));
  SCRATCH_ROOTS.push(isolated);
  fs.mkdirSync(path.join(isolated, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(isolated, 'scripts', 'lint-governance-scope.cjs'));
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'lib', 'cli-exit.cjs'),
    path.join(isolated, 'scripts', 'lib', 'cli-exit.cjs'),
  );
  const result = spawnSync(
    process.execPath,
    [path.join(isolated, 'scripts', 'lint-governance-scope.cjs')],
    {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { FERROX_GOVERNANCE_SCOPE_ROOT: isolated }),
    },
  );
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /npm run build:lib/, 'the missing build names its fix command');
  assert.ok(!output.includes('MODULE_NOT_FOUND'), 'no raw module resolution stack reaches the operator');
});
