'use strict';

/**
 * Phase 14.1 plan 02 — the D3d surgery on `.planning/STATE.md`.
 *
 * Three tasks put their assertions here:
 *   task 1 — the 4 curated-context verbs write the active milestone artifact
 *   task 2 — the free-prose sections are deleted and every remaining mutating
 *            verb has an explicit fate, with the rebuild audit trail moved to
 *            an append-only sidecar
 *   task 3 — completePhase derives progress from disk, and a list-driven
 *            conformance loop drives every mutation-flagged subcommand
 *
 * The acceptance signal throughout is `checkStateStructure` from plan 01
 * returning an EMPTY array. It is a FLAT array of findings, not a result union.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const FERROX_TOOLS = path.join(REPO, 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const gov = require(path.join(REPO, 'ferrox-core', 'bin', 'lib', 'governance-manifest.cjs'));

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A STATE.md that `checkStateStructure` accepts with zero findings. */
function conformingState() {
  return [
    '---',
    'ferrox_state_version: 1.0',
    'milestone: v9.0',
    'milestone_name: Scratch',
    'current_phase: 1',
    'current_phase_name: scratch',
    'current_plan: 1',
    'status: executing',
    'last_updated: "2026-07-25T00:00:00.000Z"',
    'last_activity: 2026-07-25',
    'progress:',
    '  total_phases: 1',
    '  completed_phases: 0',
    '  total_plans: 1',
    '  completed_plans: 0',
    '  percent: 0',
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '',
    'Phase: 1 (scratch)',
    'Plan: 1 of 1',
    'Status: Ready to execute',
    'Last activity: 2026-07-25',
    '',
    '## Performance Metrics',
    '',
    '| Plan | Duration | Tasks | Files |',
    '|------|----------|-------|-------|',
    '',
  ].join('\n');
}

function milestoneArtifact({ version = '9.0', name = 'Scratch', lifecycle = 'active', part } = {}) {
  const fm = ['---', `milestone: "${version}"`, `name: "${name}"`, `lifecycle: ${lifecycle}`, 'shipped: []'];
  if (part !== undefined) fm.push(`part: ${part}`);
  fm.push('artifact_kind: milestone', '---', '');
  return fm.concat([
    `# MILESTONE v${version} - ${name.toUpperCase()}`,
    '',
    '## Decisions (locked)',
    '',
    '- A hand-authored decision that machine appends must never join.',
    '',
  ]).join('\n');
}

/** Build a hermetic project tree. Returns its absolute path. */
function makeProject(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-state-'));
  const planning = path.join(dir, '.planning');
  fs.mkdirSync(path.join(planning, 'phases'), { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify({}, null, 2) + '\n');
  fs.writeFileSync(path.join(planning, 'STATE.md'), opts.state ?? conformingState());
  const artifacts = opts.artifacts ?? [{ file: 'MILESTONE-v9.0-SCRATCH.md', text: milestoneArtifact() }];
  for (const a of artifacts) fs.writeFileSync(path.join(planning, a.file), a.text);
  return dir;
}

function planningFile(dir, name) {
  return path.join(dir, '.planning', name);
}

function readPlanning(dir, name) {
  return fs.readFileSync(planningFile(dir, name), 'utf8');
}

/** Spawn a state subcommand. Returns { status, stdout, stderr, json }. */
function runVerb(cwd, verb, flags = []) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags],
    { encoding: 'utf8' },
  );
  let json;
  try { json = JSON.parse(res.stdout.trim()); } catch { json = undefined; }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

function structureFindings(text) {
  return gov.checkStateStructure(text, 'STATE.md');
}

// ─── Task 1: the 4 curated-context verbs ─────────────────────────────────────

test('add-decision writes the active milestone artifact and leaves STATE.md byte-identical', () => {
  const dir = makeProject();
  const before = readPlanning(dir, 'STATE.md');
  const r = runVerb(dir, 'state.add-decision', ['--phase', '14.1', '--summary', 'the scheduler is deterministic code']);
  assert.equal(r.status, 0, `add-decision exited ${r.status}: ${r.stderr}`);
  assert.equal(r.json.added, true);
  const artifact = readPlanning(dir, 'MILESTONE-v9.0-SCRATCH.md');
  assert.match(artifact, /^## Decisions Log$/m, 'the machine-owned decisions log section was created');
  assert.match(artifact, /the scheduler is deterministic code/);
  assert.equal(readPlanning(dir, 'STATE.md'), before, 'STATE.md must be byte-identical after add-decision');
});

test('the machine-owned decisions section is distinct from the hand-authored locked block', () => {
  const dir = makeProject();
  runVerb(dir, 'state.add-decision', ['--phase', '1', '--summary', 'machine entry']);
  const artifact = readPlanning(dir, 'MILESTONE-v9.0-SCRATCH.md');
  const locked = artifact.slice(artifact.indexOf('## Decisions (locked)'), artifact.indexOf('## Decisions Log'));
  assert.ok(!locked.includes('machine entry'), 'a machine append must never land inside the curated locked block');
});

test('add-blocker and resolve-blocker write the artifact blockers section, never STATE.md', () => {
  const dir = makeProject();
  const before = readPlanning(dir, 'STATE.md');
  const add = runVerb(dir, 'state.add-blocker', ['--text', 'Kimi lineage offline']);
  assert.equal(add.status, 0, add.stderr);
  assert.equal(add.json.added, true);
  let artifact = readPlanning(dir, 'MILESTONE-v9.0-SCRATCH.md');
  assert.match(artifact, /^## Blockers$/m);
  assert.match(artifact, /Kimi lineage offline/);
  assert.equal(readPlanning(dir, 'STATE.md'), before, 'STATE.md must be byte-identical after add-blocker');

  const res = runVerb(dir, 'state.resolve-blocker', ['--text', 'Kimi lineage offline']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.resolved, true);
  artifact = readPlanning(dir, 'MILESTONE-v9.0-SCRATCH.md');
  assert.ok(!artifact.includes('Kimi lineage offline'), 'the resolved row is removed from the artifact');
  assert.equal(readPlanning(dir, 'STATE.md'), before, 'STATE.md must be byte-identical after resolve-blocker');
});

test('add-roadmap-evolution writes the artifact and preserves its duplicate-detection result value', () => {
  const dir = makeProject();
  const before = readPlanning(dir, 'STATE.md');
  const first = runVerb(dir, 'state.add-roadmap-evolution', ['--phase', '15', '--action', 'inserted', '--note', 'anti-loop rollout']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.added, true);
  const artifact = readPlanning(dir, 'MILESTONE-v9.0-SCRATCH.md');
  assert.match(artifact, /^## Roadmap Evolution$/m);
  assert.match(artifact, /anti-loop rollout/);

  const second = runVerb(dir, 'state.add-roadmap-evolution', ['--phase', '15', '--action', 'inserted', '--note', 'anti-loop rollout']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.added, false, 'a replay reports added:false');
  assert.equal(second.json.reason, 'duplicate', 'the insert-phase checklist reads this value');
  assert.equal(readPlanning(dir, 'STATE.md'), before, 'STATE.md must be byte-identical after add-roadmap-evolution');
});

test('re-running add-decision with text already present adds no duplicate row', () => {
  const dir = makeProject();
  runVerb(dir, 'state.add-decision', ['--phase', '1', '--summary', 'idempotent entry']);
  runVerb(dir, 'state.add-decision', ['--phase', '1', '--summary', 'idempotent entry']);
  const artifact = readPlanning(dir, 'MILESTONE-v9.0-SCRATCH.md');
  const hits = artifact.split(/\r?\n/).filter((l) => l.includes('idempotent entry'));
  assert.equal(hits.length, 1, 'the artifact gains no duplicate row');
});

test('with no active artifact all 4 verbs fail loud, name a run line and a fixing command, and write nothing', () => {
  const artifacts = [{ file: 'MILESTONE-v9.0-SCRATCH.md', text: milestoneArtifact({ lifecycle: 'draft' }) }];
  for (const [verb, flags] of [
    ['state.add-decision', ['--summary', 'x']],
    ['state.add-blocker', ['--text', 'x']],
    ['state.resolve-blocker', ['--text', 'x']],
    ['state.add-roadmap-evolution', ['--phase', '1', '--note', 'x']],
  ]) {
    const dir = makeProject({ artifacts });
    const beforeState = readPlanning(dir, 'STATE.md');
    const beforeArtifact = readPlanning(dir, 'MILESTONE-v9.0-SCRATCH.md');
    const r = runVerb(dir, verb, flags);
    assert.notEqual(r.status, 0, `${verb} must exit non-zero when nothing is active`);
    assert.match(r.stderr, /lifecycle: active/, `${verb} names the problem`);
    assert.match(r.stderr, /^Run:$/m, `${verb} carries a run line`);
    assert.match(r.stderr, /^ {2}\S/m, `${verb} carries a fixing command indented 2 spaces`);
    assert.equal(readPlanning(dir, 'STATE.md'), beforeState, `${verb} wrote nothing to STATE.md`);
    assert.equal(readPlanning(dir, 'MILESTONE-v9.0-SCRATCH.md'), beforeArtifact, `${verb} wrote nothing to the artifact`);
  }
});

test('with more than one active artifact the failure fires with a different message', () => {
  const dir = makeProject({
    artifacts: [
      { file: 'MILESTONE-v9.0-SCRATCH.md', text: milestoneArtifact() },
      { file: 'MILESTONE-v9.1-OTHER.md', text: milestoneArtifact({ version: '9.1', name: 'Other' }) },
    ],
  });
  const r = runVerb(dir, 'state.add-decision', ['--summary', 'x']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /more than 1/, 'the multiple-active case carries its own message');
  assert.match(r.stderr, /^Run:$/m);
});

test('a multi-part active milestone group targets the highest numbered part', () => {
  const dir = makeProject({
    artifacts: [
      { file: 'MILESTONE-v9.0-SCRATCH.md', text: milestoneArtifact({ part: 1 }) },
      { file: 'MILESTONE-v9.0-SCRATCH-TWO.md', text: milestoneArtifact({ part: 2 }) },
    ],
  });
  const r = runVerb(dir, 'state.add-decision', ['--phase', '1', '--summary', 'part pin']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readPlanning(dir, 'MILESTONE-v9.0-SCRATCH-TWO.md').includes('part pin'), 'part 2 is the target');
  assert.ok(!readPlanning(dir, 'MILESTONE-v9.0-SCRATCH.md').includes('part pin'), 'part 1 is untouched');
});

test('no curated-context verb creates any section in STATE.md', () => {
  const dir = makeProject();
  runVerb(dir, 'state.add-decision', ['--phase', '1', '--summary', 'a']);
  runVerb(dir, 'state.add-blocker', ['--text', 'b']);
  runVerb(dir, 'state.add-roadmap-evolution', ['--phase', '1', '--note', 'c']);
  runVerb(dir, 'state.resolve-blocker', ['--text', 'b']);
  const state = readPlanning(dir, 'STATE.md');
  assert.deepEqual(structureFindings(state), [], 'STATE.md still satisfies checkStateStructure');
  for (const forbidden of ['Decisions', 'Blockers', 'Accumulated Context', 'Roadmap Evolution']) {
    assert.ok(
      !new RegExp(`^#{2,3} ${forbidden}`, 'm').test(state),
      `no verb may create a ${forbidden} section in STATE.md`,
    );
  }
});

// ─── Task 2: the deletions, the sidecar, and the settled verbs ───────────────

const SIDECAR = 'state-rebuild-log.jsonl';

/** A conforming STATE.md carrying deliberate Current Phase Name drift. */
function driftedState(name) {
  return conformingState().replace(
    'Last activity: 2026-07-25',
    `Last activity: 2026-07-25\nCurrent Phase Name: ${name}`,
  );
}

function sidecarPath(dir) {
  return path.join(dir, '.planning', SIDECAR);
}

function sidecarLines(dir) {
  if (!fs.existsSync(sidecarPath(dir))) return [];
  return fs.readFileSync(sidecarPath(dir), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
}

test('record-session writes frontmatter keys only and gains STATE.md no section', () => {
  const dir = makeProject();
  const r = runVerb(dir, 'state.record-session', ['--stopped-at', 'Completed 14.1-02-PLAN.md']);
  assert.equal(r.status, 0, r.stderr);
  const state = readPlanning(dir, 'STATE.md');
  assert.match(state, /^stopped_at: .*14\.1-02/m, 'the stopped_at frontmatter key carries the value');
  assert.deepEqual(structureFindings(state), [], 'STATE.md still satisfies checkStateStructure');
  assert.ok(!/^## Session/m.test(state), 'no session section is created');
});

test('record-session REPLACES a pre-existing stopped_at rather than reverting to it', () => {
  // The body has no session source since D3d, so the steady-state post-sync's
  // stopped_at preservation rule would restore the prior value forever. This
  // case is the guard against that regression.
  const dir = makeProject({ state: conformingState().replace('status: executing', 'status: executing\nstopped_at: an older session') });
  const r = runVerb(dir, 'state.record-session', ['--stopped-at', 'a newer session']);
  assert.equal(r.status, 0, r.stderr);
  const state = readPlanning(dir, 'STATE.md');
  assert.match(state, /^stopped_at: a newer session$/m, 'the new value wins');
  assert.ok(!state.includes('an older session'), 'the prior value is gone, not restored');
  assert.deepEqual(structureFindings(state), []);
});

test('record-session accepts and ignores the resume pointer with a named deprecation line', () => {
  const dir = makeProject();
  const r = runVerb(dir, 'state.record-session', ['--stopped-at', 'x', '--resume-file', '.planning/whatever.md']);
  assert.equal(r.status, 0, 'the 6 calling workflows must keep working');
  assert.match(r.stderr, /resume-file/, 'the deprecation names the argument');
  assert.match(r.stderr, /milestone artifact/i, 'the deprecation names the derived source');
  const state = readPlanning(dir, 'STATE.md');
  assert.ok(!/Resume file/i.test(state), 'no resume pointer is stored');
  assert.ok(!/^## Session/m.test(state), 'no session section is created');
  assert.deepEqual(structureFindings(state), []);
});

test('prune archives from the metrics section only and reports zero for the removed targets', () => {
  const state = conformingState()
    .replace('current_phase: 1', 'current_phase: 9')
    .replace('| Plan | Duration | Tasks | Files |', '| Plan | Duration | Tasks | Files |\n| 1 | 5 | 2 | 3 |');
  const dir = makeProject({ state });
  const r = runVerb(dir, 'state.prune', ['--keep-recent', '3']);
  assert.equal(r.status, 0, r.stderr);
  const sections = (r.json.archived ?? []).map((s) => s.section);
  for (const gone of ['Decisions', 'Recently Completed', 'Blockers (resolved)']) {
    assert.ok(!sections.includes(gone), `${gone} no longer exists and must not be reported as archived`);
  }
  assert.deepEqual(structureFindings(readPlanning(dir, 'STATE.md')), []);
});

test('rebuild on a file missing all 4 deleted sections creates none of them', () => {
  const dir = makeProject();
  const r = runVerb(dir, 'state.rebuild', []);
  assert.equal(r.status, 0, r.stderr);
  const state = readPlanning(dir, 'STATE.md');
  assert.deepEqual(structureFindings(state), []);
  for (const gone of ['Project Reference', 'Accumulated Context', 'Deferred Items', 'Session Continuity', 'Rebuild Log']) {
    assert.ok(!new RegExp(`^## ${gone}`, 'm').test(state), `rebuild must not create ## ${gone}`);
  }
});

test('a rebuild that finds no drift writes nothing to the sidecar', () => {
  const dir = makeProject();
  runVerb(dir, 'state.rebuild', []);
  assert.equal(sidecarLines(dir).length, 0, 'idempotency: no drift means no sidecar line');
});

test('a DRIFTED rebuild puts the drifted text in the sidecar and removes it from the state file', () => {
  const dir = makeProject({ state: driftedState('DRIFTED-SPECIMEN-A') });
  const r = runVerb(dir, 'state.rebuild', []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.rebuilt, true, 'the emitting path ran, so a mutation was reported');
  const state = readPlanning(dir, 'STATE.md');
  const sidecar = sidecarLines(dir).join('\n');
  assert.ok(sidecar.includes('DRIFTED-SPECIMEN-A'), 'the drifted text is present in the sidecar');
  assert.ok(!state.includes('DRIFTED-SPECIMEN-A'), 'the drifted text is absent from the state file');
  assert.deepEqual(structureFindings(state), [], 'the guard is green on the rebuilt file');
  assert.ok(!/^## Rebuild Log/m.test(state), 'the audit trail never lands in the file it audits');
});

test('every sidecar line parses as JSON and carries all 6 audit fields', () => {
  const dir = makeProject({ state: driftedState('DRIFTED-SPECIMEN-B') });
  runVerb(dir, 'state.rebuild', []);
  const lines = sidecarLines(dir);
  assert.ok(lines.length >= 1, 'at least one entry was written');
  for (const line of lines) {
    const o = JSON.parse(line);
    for (const field of ['timestamp', 'kind', 'section', 'before', 'after', 'reason']) {
      assert.ok(field in o, `the sidecar entry carries ${field}, so no audit information was traded for the move`);
    }
  }
});

test('the sidecar is append-only: a second drifted rebuild leaves the first run byte-identical', () => {
  const dir = makeProject({ state: driftedState('DRIFTED-FIRST') });
  runVerb(dir, 'state.rebuild', []);
  const first = sidecarLines(dir);
  assert.ok(first.length >= 1);
  fs.writeFileSync(planningFile(dir, 'STATE.md'), driftedState('DRIFTED-SECOND'));
  runVerb(dir, 'state.rebuild', []);
  const second = sidecarLines(dir);
  assert.ok(second.length > first.length, 'the second run appended');
  assert.deepEqual(second.slice(0, first.length), first, 'the first run lines are byte-identical');
});

test('the importer composes a document that satisfies checkStateStructure', () => {
  const importer = require(path.join(REPO, 'ferrox-core', 'bin', 'lib', 'ferrox2-import.cjs'));
  const phaseMap = [
    { milestoneId: 'm1', milestoneTitle: 'One', slice: { title: 'First Slice', done: true, tasks: [] }, phaseNum: 1 },
    { milestoneId: 'm1', milestoneTitle: 'One', slice: { title: 'Second Slice', done: false, tasks: [] }, phaseNum: 2 },
  ];
  const dir = makeProject();
  const composed = importer.buildStateMd(phaseMap);
  fs.writeFileSync(planningFile(dir, 'STATE.md'), composed);
  const findings = structureFindings(readPlanning(dir, 'STATE.md'));
  assert.deepEqual(findings, [], `ferrox2-import composes a non-conforming STATE.md: ${JSON.stringify(findings)}`);
  assert.ok(!/ of \d+ \(/.test(composed), 'the importer emits the SDK phase template, not an out-of-total denominator');
});

test('milestone-switch resets the position section and creates no deleted section', () => {
  const dir = makeProject();
  const r = runVerb(dir, 'state.milestone-switch', ['--milestone', 'v9.1', '--name', 'Next']);
  assert.equal(r.status, 0, r.stderr);
  const state = readPlanning(dir, 'STATE.md');
  for (const gone of ['Project Reference', 'Accumulated Context', 'Deferred Items', 'Session Continuity']) {
    assert.ok(!new RegExp(`^## ${gone}`, 'm').test(state), `milestone-switch must not create ## ${gone}`);
  }
  assert.deepEqual(structureFindings(state), []);
});

test('a field update targeting a deleted-section name warns and skips rather than creating the section', () => {
  const dir = makeProject();
  const before = readPlanning(dir, 'STATE.md');
  // `state update` takes positional field and value (src/state-command-router.cts:95).
  const r = runVerb(dir, 'state.update', ['Resume File', 'somewhere.md']);
  const state = readPlanning(dir, 'STATE.md');
  assert.ok(!/^## Session/m.test(state), 'no section is created for an absent field');
  assert.deepEqual(structureFindings(state), []);
  assert.equal(r.json.updated, false, 'the miss is reported rather than swallowed');
  assert.match(r.json.reason, /not found in STATE\.md/, 'and it names the absent field');
  assert.equal(state, before, 'nothing was written');
});

test('the live .planning/STATE.md satisfies checkStateStructure', () => {
  const live = fs.readFileSync(path.join(REPO, '.planning', 'STATE.md'), 'utf8');
  const findings = structureFindings(live);
  assert.deepEqual(findings, [], `live STATE.md is non-conforming: ${JSON.stringify(findings, null, 2)}`);
});

test('the live STATE.md keeps the milestone frontmatter key in the shape roadmap-parser regexes', () => {
  const live = fs.readFileSync(path.join(REPO, '.planning', 'STATE.md'), 'utf8');
  // The literal pattern at src/roadmap-parser.cts:59.
  const m = live.match(/^milestone:\s*(.+)/m);
  assert.notEqual(m, null, 'extractCurrentMilestone must still find the key');
  assert.match(m[1].trim(), /^v?\d+(\.\d+)*$/, 'and it captures the active version');
});

test('the deleted sections are gone from the live state file and the template', () => {
  const anchored = /^## (Project Reference|Accumulated Context|Deferred Items|Session Continuity|Rebuild Log)/m;
  const live = fs.readFileSync(path.join(REPO, '.planning', 'STATE.md'), 'utf8');
  const template = fs.readFileSync(path.join(REPO, 'ferrox-core', 'templates', 'state.md'), 'utf8');
  assert.ok(!anchored.test(live), 'no deleted heading survives in .planning/STATE.md');
  assert.ok(!anchored.test(template), 'no deleted heading survives in ferrox-core/templates/state.md');
});

// ─── Task 3: the broken cycle and the list-driven conformance loop ───────────

const aliases = require(path.join(REPO, 'ferrox-core', 'bin', 'lib', 'command-aliases.cjs'));

/**
 * One invocation per mutation-flagged state subcommand. Keyed by subcommand so
 * the loop below can assert this table covers the alias list EXACTLY: a
 * subcommand added later without a case fails the test rather than sliding by.
 */
const CONFORMANCE_INVOCATIONS = {
  'update': ['Status', 'Ready to plan'],
  'patch': ['{"Status":"Ready to plan"}'],
  'begin-phase': ['--phase', '2', '--name', 'next-phase', '--plans', '3'],
  'advance-plan': [],
  'record-metric': ['--phase', '1', '--plan', '1', '--duration', '5', '--tasks', '2', '--files', '3'],
  'update-progress': [],
  'add-decision': ['--phase', '1', '--summary', 'a conformance decision'],
  'add-blocker': ['--text', 'a conformance blocker'],
  'resolve-blocker': ['--text', 'a conformance blocker'],
  'record-session': ['--stopped-at', 'a conformance session'],
  'signal-waiting': ['--type', 'decision_point', '--question', 'which one'],
  'signal-resume': [],
  'planned-phase': ['--phase', '1', '--plans', '2'],
  'sync': [],
  'prune': ['--keep-recent', '3'],
  'rebuild': [],
  'milestone-switch': ['--milestone', 'v9.1', '--name', 'Next'],
  'add-roadmap-evolution': ['--phase', '2', '--note', 'a conformance evolution'],
};

const ALLOWED_H2 = new Set(['Current Position', 'Performance Metrics', 'Operator Next Steps']);

test('every mutation-flagged state subcommand has a conformance case', () => {
  const flagged = aliases.STATE_COMMAND_ALIASES.filter((e) => e.mutation).map((e) => e.subcommand).sort();
  const covered = Object.keys(CONFORMANCE_INVOCATIONS).sort();
  assert.deepEqual(
    covered,
    flagged,
    'a mutation-flagged subcommand with no conformance case would leave STATE.md unguarded; add one to CONFORMANCE_INVOCATIONS',
  );
});

test('driving every mutating subcommand leaves checkStateStructure green', () => {
  for (const entry of aliases.STATE_COMMAND_ALIASES.filter((e) => e.mutation)) {
    const verb = entry.subcommand;
    const flags = CONFORMANCE_INVOCATIONS[verb];
    assert.ok(flags !== undefined, `${verb}: no conformance case`);
    const dir = makeProject();
    const r = runVerb(dir, entry.canonical, flags);
    assert.equal(r.status, 0, `${verb}: exited ${r.status}: ${r.stderr}`);
    const state = readPlanning(dir, 'STATE.md');
    assert.deepEqual(
      structureFindings(state),
      [],
      `${verb}: left STATE.md structurally non-conforming`,
    );
    for (const line of state.split(/\r?\n/)) {
      const m = /^## (.+)$/.exec(line);
      if (m) {
        assert.ok(ALLOWED_H2.has(m[1].trim()), `${verb}: created the forbidden section "${m[1].trim()}"`);
      }
    }
  }
});

test('the drifted-input rebuild case: mutation reported, guard green, drift in the sidecar and not in the file', () => {
  const dir = makeProject({ state: driftedState('DRIFTED-CONFORMANCE') });
  const r = runVerb(dir, 'state.rebuild', []);
  const state = readPlanning(dir, 'STATE.md');
  const sidecar = sidecarLines(dir).join('\n');
  assert.equal(r.json.rebuilt, true, 'a mutation was reported, so the emitting path ran');
  assert.deepEqual(structureFindings(state), [], 'the guard is green on the result');
  assert.ok(sidecar.includes('DRIFTED-CONFORMANCE'), 'the drifted text is in the sidecar');
  assert.ok(!state.includes('DRIFTED-CONFORMANCE'), 'the drifted text is not in the state file');
});

test('completePhase writes the DISK-derived counters even when the roadmap disagrees', () => {
  const dir = makeProject();
  const phases = path.join(dir, '.planning', 'phases');
  // Two phase dirs on disk: phase 1 complete (1 plan, 1 summary), phase 2 not.
  fs.mkdirSync(path.join(phases, '01-first'), { recursive: true });
  fs.writeFileSync(path.join(phases, '01-first', '01-01-PLAN.md'), '# plan\n');
  fs.writeFileSync(path.join(phases, '01-first', '01-01-SUMMARY.md'), '# summary\n');
  fs.writeFileSync(path.join(phases, '01-first', '01-VERIFICATION.md'), '---\nstatus: passed\n---\n\n# Verification\n');
  fs.mkdirSync(path.join(phases, '02-second'), { recursive: true });
  fs.writeFileSync(path.join(phases, '02-second', '02-01-PLAN.md'), '# plan\n');
  // A roadmap that DELIBERATELY disagrees with disk: it claims 9 phases, all done.
  fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '## v9.0 Scratch',
    '',
    '### Phase 1: First',
    '**Status:** Complete',
    '',
    '### Phase 2: Second',
    '**Status:** Complete',
    '',
    '### Phase 3: Third',
    '**Status:** Complete',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');

  const r = runVerb(dir, 'phase.complete', ['--phase', '1']);
  assert.equal(r.status, 0, `phase.complete exited ${r.status}: ${r.stderr}`);
  const state = readPlanning(dir, 'STATE.md');
  assert.deepEqual(structureFindings(state), [], 'a real completePhase write leaves the file conforming');
  const progress = /progress:\n([\s\S]*?)(?=\n[a-z_]+:|\n---)/.exec(state);
  assert.notEqual(progress, null, 'the progress counters survive');
  assert.match(progress[1], /completed_phases: 1\b/, 'disk says 1 phase complete, and disk wins over the roadmap');
  assert.match(progress[1], /total_phases: 2\b/, 'disk says 2 phase directories, and disk wins over the roadmap');
});

test('the retained clock keys keep working after a completePhase write', () => {
  const dir = makeProject();
  const phases = path.join(dir, '.planning', 'phases');
  fs.mkdirSync(path.join(phases, '01-first'), { recursive: true });
  fs.writeFileSync(path.join(phases, '01-first', '01-01-PLAN.md'), '# plan\n');
  fs.writeFileSync(path.join(phases, '01-first', '01-01-SUMMARY.md'), '# summary\n');
  fs.writeFileSync(path.join(phases, '01-first', '01-VERIFICATION.md'), '---\nstatus: passed\n---\n\n# Verification\n');
  fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## v9.0 Scratch\n\n### Phase 1: First\n');
  runVerb(dir, 'phase.complete', ['--phase', '1']);
  const state = readPlanning(dir, 'STATE.md');
  const lastUpdated = /^last_updated: "?([^"\n]+)"?$/m.exec(state);
  assert.notEqual(lastUpdated, null, 'the ISO last-updated value is retained, not stripped');
  assert.match(lastUpdated[1], /^\d{4}-\d{2}-\d{2}T/, 'and it is an ISO timestamp');
  assert.deepEqual(structureFindings(state), [], 'a fresh wall clock write leaves the file conforming');

  // src/clock.cts:100 binds the date-only fields to the host local calendar day,
  // so a date-only key must never name a day AHEAD of the last-updated date.
  const localDay = new Date(lastUpdated[1]);
  const localDayStr = [
    localDay.getFullYear(),
    String(localDay.getMonth() + 1).padStart(2, '0'),
    String(localDay.getDate()).padStart(2, '0'),
  ].join('-');
  for (const key of ['last_activity', 'paused_at']) {
    const m = new RegExp(`^${key}: (\\d{4}-\\d{2}-\\d{2})$`, 'm').exec(state);
    if (m) assert.ok(m[1] <= localDayStr, `${key} (${m[1]}) must never be ahead of the local day (${localDayStr})`);
  }
});

test('one named disk derivation feeds both completePhase and the rebuild path', () => {
  const stateLib = require(path.join(REPO, 'ferrox-core', 'bin', 'lib', 'state.cjs'));
  assert.equal(
    typeof stateLib.scanPhaseInventory,
    'function',
    'the shared phase-directory scan must be one exported named function, not two private copies',
  );
  const dir = makeProject();
  const phases = path.join(dir, '.planning', 'phases');
  fs.mkdirSync(path.join(phases, '01-first'), { recursive: true });
  fs.writeFileSync(path.join(phases, '01-first', '01-01-PLAN.md'), '# plan\n');
  fs.writeFileSync(path.join(phases, '01-first', '01-01-SUMMARY.md'), '# summary\n');
  fs.mkdirSync(path.join(phases, '14.1-decimal'), { recursive: true });
  fs.writeFileSync(path.join(phases, '14.1-decimal', '14.1-01-PLAN.md'), '# plan\n');

  const inventory = stateLib.scanPhaseInventory(dir);
  const derived = stateLib.deriveProgressFromPhaseDirs(dir);
  assert.equal(inventory.length, 2, 'a decimal phase directory is not dropped by the shared scan');
  assert.equal(derived.total_phases, inventory.length, 'both consumers see the same phase set');
  assert.equal(derived.completed_phases, 1);
  assert.equal(derived.total_plans, 2);
  assert.equal(derived.completed_plans, 1);
});
