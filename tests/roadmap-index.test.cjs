'use strict';

/**
 * roadmap-index: the properties under lock, not the functions.
 *
 *   - HERMETIC: no clock, no filesystem, no child process inside the pure lib.
 *     That is what makes `--check` meaningful and what keeps the lib out of the
 *     D3c cycle: the function that reads STATE.md is `extractCurrentMilestone`,
 *     and this lib never imports it.
 *   - ORDER-STABLE: a shuffled entry array renders byte-identically to the
 *     sorted one. Rendering the same ORDERED list twice proves nothing; a
 *     filesystem enumeration change is the real threat.
 *   - SHAPE-PRESERVING: every rendered index line satisfies all 3 reader
 *     patterns in src/phase.cts, constructed here from the same phase-id
 *     sources the SDK constructs them from, so a shape change fails here
 *     rather than in production.
 *   - FAIL LOUD: a malformed region names the file, the 1-based line, and the
 *     offending line, and is NEVER silently overwritten. Silently overwriting
 *     is how a generator eats a human's work.
 *   - SELF-HEALING: a completion date is rendered only for an entry whose
 *     DERIVED status is the complete status, so a carried date cannot outlive
 *     the state it claims.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LIB_DIR = path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib');
const LIB_PATH = path.join(LIB_DIR, 'roadmap-index.cjs');
const lib = require(LIB_PATH);
const phaseId = require(path.join(LIB_DIR, 'phase-id.cjs'));

// ─── builders ────────────────────────────────────────────────────────────────

function entry(over) {
  return Object.assign(
    {
      number: '14',
      name: 'The Milestone Index',
      parenthetical: '',
      description: '',
      planCount: 1,
      summaryCount: 1,
      status: 'Executed',
      completedDate: '',
    },
    over,
  );
}

const BASE_ENTRIES = [
  entry({
    number: '14',
    name: 'The Milestone Index',
    description: 'Machine-readable milestone frontmatter',
    status: 'Complete',
    completedDate: '2026-07-25',
  }),
  entry({
    number: '14.1',
    name: 'Governance Truth',
    parenthetical: '(INSERTED 2026-07-25 after cross-audit)',
    description: 'Lifecycle-aware current-milestone resolution',
    planCount: 4,
    summaryCount: 2,
    status: 'In Progress',
  }),
  entry({
    number: '15',
    name: 'Prove the Premise',
    description: 'Anti-loop discipline. STOP-or-GO',
    planCount: 0,
    summaryCount: 0,
    status: 'Not started',
  }),
];

const DEFAULT_DETAILS = [
  '### Phase 14: The Milestone Index',
  '',
  '**Goal**: index the milestones.',
  '',
  '### Phase 14.1: Governance Truth (INSERTED)',
  '',
  '**Goal**: no false current state.',
  '',
  '### Phase 15: Prove the Premise',
  '',
  '**Goal**: measure before building.',
];

const DEFAULT_SCOPE = '> **Scope: milestone v1.14 (Fleet Mode).** Fixture roadmap.';

/**
 * Build a roadmap fixture. `phasesBody` and `progressBody` are line arrays that
 * land inside `## Phases` and `## Progress` respectively.
 */
function roadmap(opts) {
  const o = opts || {};
  const lines = [
    '# Roadmap: Fixture',
    '',
    o.scope === undefined ? DEFAULT_SCOPE : o.scope,
    '',
    '## Phases',
    '',
  ];
  for (const l of o.phasesBody || []) lines.push(l);
  lines.push('');
  lines.push('## Phase Details');
  lines.push('');
  for (const l of o.detailsBody || DEFAULT_DETAILS) lines.push(l);
  lines.push('');
  lines.push('## Progress');
  lines.push('');
  for (const l of o.progressBody || []) lines.push(l);
  lines.push('');
  return lines.join('\n');
}

function splitRegion(rendered) {
  return rendered.split('\n');
}

function generatedRoadmap(entries) {
  return roadmap({
    phasesBody: splitRegion(lib.renderPhaseIndex(entries || BASE_ENTRIES)),
    progressBody: splitRegion(lib.renderProgressSection(entries || BASE_ENTRIES)),
  });
}

function codes(errors) {
  return errors.map((e) => e.code);
}

// The 3 reader patterns, built from the SAME phase-id sources src/phase.cts
// builds them from. R1 is the `updateBullet` flip pattern (src/phase.cts
// :1781-1784), which by design only matches an UNCHECKED box, so the assertion
// below normalises `[x]` back to `[ ]` before testing it. R2 is the 3-source
// phase-number scan bullet pattern (:802). R3 is the lowest-outstanding
// override pattern (:2145-2148).
function readerPatterns(num) {
  const esc = phaseId.phaseMarkdownRegexSource(num);
  return {
    r1: new RegExp(
      `^[ \\t]*(-\\s*\\[)[ ](\\]\\s*(?:\\*\\*)?\\s*Phase\\s+${esc}${phaseId.OPTIONAL_PHASE_TAG_SOURCE}[:\\s][^\\n]*)`,
      'i',
    ),
    r2: /^[ \t]*-[ \t]*\[[^\]]{0,200}\][ \t]*\*{0,2}Phase[ \t]+(\d+)(?=[:.\s*]|$)/i,
    r3: new RegExp(
      `-\\s*\\[(x| )\\]\\s*(?:\\*\\*|__)?\\s*Phase\\s+(${phaseId.PHASE_NUMBER_TOKEN_SOURCE})(?:\\s*\\([^)\\n]{0,200}\\))?\\s*:\\s*([^\\n*]+)`,
      'i',
    ),
  };
}

// ─── the region locator ──────────────────────────────────────────────────────

test('a roadmap carrying no generated notice reports both regions missing by name', () => {
  const text = roadmap({
    phasesBody: ['- [ ] **Phase 14: The Milestone Index**'],
    progressBody: ['| Phase | Plans Complete | Status | Completed |'],
  });
  const located = lib.locateRegions(text, 'ROADMAP.md');
  assert.equal(located.ok, false, 'a roadmap with no notice is not compliant');
  const missing = located.errors.filter((e) => e.code === 'E_ROADMAP_REGION_MISSING');
  assert.equal(missing.length, 2, 'both regions report their own missing notice');
  const messages = missing.map((e) => e.message).join('\n');
  assert.match(messages, /## Phases/, 'the phases region names its own heading');
  assert.match(messages, /## Progress/, 'the progress region names its own heading');
});

test('both notices present yields 2 spans, and the phase index span stops before the next level 2 heading', () => {
  const text = generatedRoadmap();
  const located = lib.locateRegions(text, 'ROADMAP.md');
  assert.equal(located.ok, true, JSON.stringify(located.errors, null, 2));
  const lines = text.split('\n');
  const phases = located.regions.phases;
  assert.ok(phases, 'the phase index region resolves');
  assert.ok(
    lines[phases.startLine - 1].startsWith(lib.NOTICE_SENTINEL),
    'the span starts at the notice line',
  );
  assert.match(
    lines[phases.endLine],
    /^## Phase Details/,
    'the line after the span end is the next level 2 heading',
  );
  assert.ok(located.regions.progress, 'the progress region resolves');
});

test('a notice under a heading that is neither Phases nor Progress is an orphan naming that heading', () => {
  const text = [
    '# Roadmap: Fixture',
    '',
    '## Overview',
    '',
    lib.NOTICE_SENTINEL + ' from disk.',
    '',
    '## Phases',
    '',
    '## Phase Details',
    '',
    '## Progress',
    '',
  ].join('\n');
  const located = lib.locateRegions(text, 'ROADMAP.md');
  const orphan = located.errors.find((e) => e.code === 'E_ROADMAP_REGION_ORPHAN');
  assert.ok(orphan, 'an orphan notice is reported: ' + codes(located.errors).join(', '));
  assert.match(orphan.message, /Overview/, 'the orphan message names the heading it found');
});

test('2 notices under one heading is a duplicate, never a last-one-wins merge', () => {
  const notice = lib.renderPhaseIndex(BASE_ENTRIES);
  const text = roadmap({
    phasesBody: splitRegion(notice).concat(splitRegion(notice)),
    progressBody: splitRegion(lib.renderProgressSection(BASE_ENTRIES)),
  });
  const located = lib.locateRegions(text, 'ROADMAP.md');
  const dup = located.errors.find((e) => e.code === 'E_ROADMAP_REGION_DUPLICATE');
  assert.ok(dup, 'a duplicate notice is reported: ' + codes(located.errors).join(', '));
  assert.match(dup.message, /## Phases/, 'the duplicate message names its heading');
});

test('a prose line inside the phase index region fails loud with its 1-based line and its text', () => {
  const body = splitRegion(lib.renderPhaseIndex(BASE_ENTRIES));
  body.splice(body.length - 1, 0, 'A human wrote this sentence here.');
  const text = roadmap({
    phasesBody: body,
    progressBody: splitRegion(lib.renderProgressSection(BASE_ENTRIES)),
  });
  const located = lib.locateRegions(text, 'ROADMAP.md');
  const bad = located.errors.find((e) => e.code === 'E_ROADMAP_INDEX_INTERLEAVED');
  assert.ok(bad, 'the interleaved line is reported: ' + codes(located.errors).join(', '));
  assert.equal(bad.file, 'ROADMAP.md', 'the error names the file');
  assert.equal(bad.text, 'A human wrote this sentence here.', 'the error carries the offending line');
  const lines = text.split('\n');
  assert.equal(
    lines[bad.line - 1],
    'A human wrote this sentence here.',
    'the reported line number is 1-based over the whole file',
  );
});

test('a prose line inside the progress region fails loud with its own code', () => {
  const body = splitRegion(lib.renderProgressSection(BASE_ENTRIES));
  body.push('Someone added a note under the table.');
  const text = roadmap({
    phasesBody: splitRegion(lib.renderPhaseIndex(BASE_ENTRIES)),
    progressBody: body,
  });
  const located = lib.locateRegions(text, 'ROADMAP.md');
  const bad = located.errors.find((e) => e.code === 'E_ROADMAP_PROGRESS_INTERLEAVED');
  assert.ok(bad, 'the interleaved line is reported: ' + codes(located.errors).join(', '));
  assert.equal(bad.text, 'Someone added a note under the table.');
});

// ─── the phase list ──────────────────────────────────────────────────────────

test('the phase list comes from the detail headings, in decimal-aware ascending order', () => {
  const text = roadmap({
    phasesBody: [],
    detailsBody: [
      '### Phase 15: Prove the Premise',
      '',
      '### Phase 14.1: Governance Truth (INSERTED)',
      '',
      '### Phase 14: The Milestone Index',
      '',
    ],
    progressBody: [],
  });
  const collected = lib.collectPhaseEntries(text, 'ROADMAP.md');
  assert.equal(collected.ok, true, JSON.stringify(collected.errors));
  assert.deepEqual(
    collected.entries.map((e) => e.number),
    ['14', '14.1', '15'],
    '14.1 sorts after 14 and before 15',
  );
  assert.equal(collected.entries[1].name, 'Governance Truth', 'the trailing tag is not part of the name');
  assert.equal(collected.entries[1].parenthetical, '(INSERTED)', 'the heading tag is carried as the parenthetical');
});

test('1.9 sorts before 1.10, which a lexicographic compare gets wrong', () => {
  const text = roadmap({
    phasesBody: [],
    detailsBody: [
      '### Phase 1.10: Ten',
      '',
      '### Phase 1.9: Nine',
      '',
    ],
    progressBody: [],
  });
  const collected = lib.collectPhaseEntries(text, 'ROADMAP.md');
  assert.deepEqual(collected.entries.map((e) => e.number), ['1.9', '1.10']);
});

test('a heading folded inside a details block cannot inject a phase entry', () => {
  const text = roadmap({
    phasesBody: [],
    detailsBody: [
      '<details>',
      '',
      '### Phase 9: A Shipped Milestone Phase',
      '',
      '</details>',
      '',
      '### Phase 14: The Milestone Index',
      '',
    ],
    progressBody: [],
  });
  const collected = lib.collectPhaseEntries(text, 'ROADMAP.md');
  assert.deepEqual(collected.entries.map((e) => e.number), ['14'], 'the folded phase is not indexed');
});

test('2 headings claiming one phase number is a loud duplicate', () => {
  const text = roadmap({
    phasesBody: [],
    detailsBody: [
      '### Phase 14: The Milestone Index',
      '',
      '### Phase 14: A Second Claim',
      '',
    ],
    progressBody: [],
  });
  const collected = lib.collectPhaseEntries(text, 'ROADMAP.md');
  assert.equal(collected.ok, false);
  assert.ok(
    collected.errors.some((e) => e.code === 'E_ROADMAP_DUPLICATE_PHASE'),
    'the duplicate is reported: ' + codes(collected.errors).join(', '),
  );
});

// ─── the phase index renderer ────────────────────────────────────────────────

test('an index entry carries its bold phase label, its parenthetical, then its description', () => {
  const rendered = lib.renderPhaseIndex([
    entry({
      number: '14.1',
      name: 'Governance Truth',
      parenthetical: '(INSERTED 2026-07-25 after cross-audit)',
      description: 'Lifecycle-aware current-milestone resolution',
      status: 'In Progress',
    }),
  ]);
  assert.match(
    rendered,
    /^- \[ \] \*\*Phase 14\.1: Governance Truth\*\* \(INSERTED 2026-07-25 after cross-audit\) - Lifecycle-aware current-milestone resolution$/m,
  );
});

test('a complete entry renders a checked box and a trailing completion parenthetical', () => {
  const rendered = lib.renderPhaseIndex([
    entry({ number: '14', name: 'The Milestone Index', description: 'Index', status: 'Complete', completedDate: '2026-07-25' }),
  ]);
  assert.match(rendered, /^- \[x\] \*\*Phase 14: The Milestone Index\*\* - Index \(completed 2026-07-25\)$/m);
});

test('a carried date is discarded for an entry whose derived status is not the complete status', () => {
  const rendered = lib.renderPhaseIndex([
    entry({ number: '14', name: 'The Milestone Index', status: 'Executed', completedDate: '2026-07-25' }),
  ]);
  assert.ok(!rendered.includes('completed 2026-07-25'), 'a date cannot outlive the state it claims');
  assert.match(rendered, /^- \[ \] \*\*Phase 14: The Milestone Index\*\*$/m);
});

test('every rendered index line satisfies all 3 src/phase.cts reader patterns for its own phase number', () => {
  const rendered = lib.renderPhaseIndex(BASE_ENTRIES);
  const entryLines = rendered.split('\n').filter((l) => /^- \[[ x]\]/.test(l));
  assert.equal(entryLines.length, BASE_ENTRIES.length, 'one line per entry');
  for (let i = 0; i < entryLines.length; i++) {
    const line = entryLines[i];
    const num = BASE_ENTRIES[i].number;
    const p = readerPatterns(num);
    const unchecked = line.replace(/^- \[x\]/, '- [ ]');
    assert.ok(p.r1.test(unchecked), `R1 (the updateBullet flip) must resolve for phase ${num}: ${line}`);
    assert.ok(p.r2.test(line), `R2 (the phase-number scan) must resolve for phase ${num}: ${line}`);
    assert.ok(p.r3.test(line), `R3 (the lowest-outstanding override) must resolve for phase ${num}: ${line}`);
  }
});

// ─── the progress renderer ───────────────────────────────────────────────────

test('the progress section names every phase in ascending order and carries the 4 canonical columns', () => {
  const rendered = lib.renderProgressSection(BASE_ENTRIES);
  assert.match(rendered, /^\*\*Execution Order:\*\*$/m);
  assert.ok(
    rendered.includes('Phases execute in numeric order: 14 → 14.1 → 15'),
    'the execution order line names every phase number in ascending order',
  );
  assert.match(rendered, /^\| Phase \| Plans Complete \| Status \| Completed \|$/m);
});

test('the integer row pattern selects the integer row and rejects the decimal row of the same digits', () => {
  const rendered = lib.renderProgressSection(BASE_ENTRIES);
  const rows = rendered.split('\n').filter((l) => l.startsWith('| 14'));
  const firstCell = (row) => row.split('|')[1].trim();
  const integerRow = rows.find((r) => firstCell(r).startsWith('14.') && !firstCell(r).startsWith('14.1'));
  const decimalRow = rows.find((r) => firstCell(r).startsWith('14.1'));
  assert.ok(integerRow && decimalRow, 'both rows rendered');
  const integerPattern = /^14\.?(?:\s|$)/i;
  assert.ok(integerPattern.test(firstCell(integerRow)), 'the integer pattern matches the integer row');
  assert.ok(!integerPattern.test(firstCell(decimalRow)), 'the integer pattern must NOT match the decimal row');
});

test('a phase with no plans renders 0/TBD and the not-started status', () => {
  const rendered = lib.renderProgressSection([
    entry({ number: '15', name: 'Prove the Premise', planCount: 0, summaryCount: 0, status: 'Not started' }),
  ]);
  assert.match(rendered, /^\| 15\. Prove the Premise \| 0\/TBD \| Not started \| - \|$/m);
});

test('a phase with plans renders matched summaries over plans, and a hyphen when it has no date', () => {
  const rendered = lib.renderProgressSection([
    entry({ number: '14.1', name: 'Governance Truth', parenthetical: '(INSERTED)', planCount: 4, summaryCount: 2, status: 'In Progress' }),
  ]);
  assert.match(rendered, /^\| 14\.1 Governance Truth \(INSERTED\) \| 2\/4 \| In Progress \| - \|$/m);
});

// ─── carried values ──────────────────────────────────────────────────────────

test('the carried labels come back per phase number, and an absent phase carries nothing', () => {
  const rendered = lib.renderPhaseIndex(BASE_ENTRIES);
  const carried = lib.extractCarriedLabels(rendered);
  assert.equal(carried['14.1'].parenthetical, '(INSERTED 2026-07-25 after cross-audit)');
  assert.equal(carried['14.1'].description, 'Lifecycle-aware current-milestone resolution');
  assert.equal(carried['14'].description, 'Machine-readable milestone frontmatter');
  assert.equal(carried['14'].parenthetical, '', 'an entry with no parenthetical carries an empty one');
  assert.equal(carried['99'], undefined, 'a phase absent from the region carries nothing');
});

test('a carried description never swallows the completion parenthetical', () => {
  const rendered = lib.renderPhaseIndex([
    entry({ number: '14', name: 'The Milestone Index', description: 'Index', status: 'Complete', completedDate: '2026-07-25' }),
  ]);
  const carried = lib.extractCarriedLabels(rendered);
  assert.equal(carried['14'].description, 'Index', 'the stamped date is state, not a label');
});

test('a carried completion value survives only when it is a real date', () => {
  const region = [
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 14. The Milestone Index | 1/1 | Complete | 2026-07-25 |',
    '| 14.1 Governance Truth | 2/4 | In Progress | soon |',
    '| 15. Prove the Premise | 0/TBD | Not started | - |',
  ].join('\n');
  const dates = lib.extractCarriedDates(region);
  assert.equal(dates['14'], '2026-07-25');
  assert.equal(dates['14.1'], undefined, 'a non-date value is discarded, matching the shipped self-heal rule');
  assert.equal(dates['15'], undefined);
});

// ─── the scope assertion ─────────────────────────────────────────────────────

function group(over) {
  return Object.assign({ milestone: '1.14', name: 'Fleet Mode', lifecycle: 'active', shipped: [], artifact_kind: 'milestone', parts: [], progress: { done: 0, total: 0 } }, over);
}

test('the scope assertion agrees with the single active milestone', () => {
  const text = generatedRoadmap();
  assert.equal(lib.assertScope(text, [group({})], 'ROADMAP.md'), null);
});

test('the scope assertion names both versions when the roadmap scope disagrees with the active milestone', () => {
  const text = generatedRoadmap();
  const bad = lib.assertScope(text, [group({ milestone: '1.15', name: 'Later' })], 'ROADMAP.md');
  assert.ok(bad, 'a disagreement is an error');
  assert.match(bad.message, /1\.14/, 'the message names the declared version');
  assert.match(bad.message, /1\.15/, 'the message names the active version');
});

test('zero active milestones and more than 1 active milestone are both errors, each with its own message', () => {
  const text = generatedRoadmap();
  const none = lib.assertScope(text, [group({ lifecycle: 'complete' })], 'ROADMAP.md');
  const many = lib.assertScope(
    text,
    [group({}), group({ milestone: '1.15', name: 'Later' })],
    'ROADMAP.md',
  );
  assert.ok(none, 'zero active is an error');
  assert.ok(many, 'more than 1 active is an error');
  assert.notEqual(none.message, many.message, 'the caller owns 2 distinct messages');
});

// ─── determinism ─────────────────────────────────────────────────────────────

test('a shuffled entry array renders byte-identically to the sorted one', () => {
  const sorted = BASE_ENTRIES.slice();
  const shuffled = [BASE_ENTRIES[2], BASE_ENTRIES[0], BASE_ENTRIES[1]];
  assert.equal(lib.renderPhaseIndex(shuffled), lib.renderPhaseIndex(sorted));
  assert.equal(lib.renderProgressSection(shuffled), lib.renderProgressSection(sorted));
});

test('rendering twice from the same inputs returns the same bytes', () => {
  assert.equal(lib.renderPhaseIndex(BASE_ENTRIES), lib.renderPhaseIndex(BASE_ENTRIES));
  assert.equal(lib.renderProgressSection(BASE_ENTRIES), lib.renderProgressSection(BASE_ENTRIES));
});

// ─── hermeticity, asserted rather than claimed ───────────────────────────────

test('the built lib reads no disk, no clock, and no child process', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  for (const forbidden of [
    "require('fs')",
    'require("fs")',
    "require('node:fs')",
    'require("node:fs")',
    "require('child_process')",
    'require("child_process")',
    "require('node:child_process')",
    'Date.now',
    'new Date',
    'extractCurrentMilestone',
  ]) {
    assert.ok(
      !src.includes(forbidden),
      `the pure lib must not contain ${forbidden}; hermeticity is what makes --check meaningful`,
    );
  }
});

test('the pure lib never reads the state file, so it cannot close the D3c cycle', () => {
  const src = fs.readFileSync(LIB_PATH, 'utf8');
  assert.ok(!src.includes('STATE.md'), 'the generator lib names no path into the state file');
});

// ─── the impure scan and the generator ───────────────────────────────────────

const os = require('node:os');
const { spawnSync } = require('node:child_process');

const scan = require(path.join(LIB_DIR, 'roadmap-index-scan.cjs'));
const commands = require(path.join(LIB_DIR, 'commands.cjs'));
const scanPhasePlans = require(path.join(LIB_DIR, 'plan-scan.cjs'));
const GENERATOR = path.join(__dirname, '..', 'scripts', 'gen-roadmap-index.cjs');

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
].join('\n');

const SCRATCH_SCOPE = '> **Scope: milestone v1.14 (Fleet Mode).** Scratch fixture.';

function scratchRoadmap(over) {
  const o = over || {};
  return [
    '# Roadmap: Scratch',
    '',
    SCRATCH_SCOPE,
    '',
    '## Phases',
    '',
    '**Phase Numbering:**',
    '',
    '- Integer phases: planned work',
    '',
  ]
    .concat(o.phasesBody || ['- [ ] **Phase 14: The Milestone Index** - Index the milestones'])
    .concat([
      '',
      '## Phase Details',
      '',
      '### Phase 14: The Milestone Index',
      '',
      '**Goal**: index the milestones.',
      '',
      '### Phase 15: Prove the Premise',
      '',
      '**Goal**: measure before building.',
      '',
      '## Progress',
      '',
    ])
    .concat(o.progressBody || [
      '**Execution Order:**',
      'Phases execute in numeric order: 14 → 15',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|----------------|--------|-----------|',
      '| 14. The Milestone Index | 1/1 | Complete | 2026-07-25 |',
      '| 15. Prove the Premise | 0/TBD | Not started | - |',
    ])
    .concat([''])
    .join('\n');
}

const SCRATCH_ROOTS = [];

function scratchProject(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-roadmap-index-'));
  SCRATCH_ROOTS.push(root);
  const planning = path.join(root, '.planning');
  fs.mkdirSync(path.join(planning, 'phases'), { recursive: true });
  fs.writeFileSync(
    path.join(planning, 'MILESTONE-v1.14-FLEET-MODE.md'),
    o.milestone === undefined ? MILESTONE_ARTIFACT : o.milestone,
    'utf8',
  );
  const phases = o.phases || { '14-milestone-index': ['14-01-PLAN.md', '14-01-SUMMARY.md'] };
  for (const dir of Object.keys(phases)) {
    const full = path.join(planning, 'phases', dir);
    fs.mkdirSync(full, { recursive: true });
    for (const f of phases[dir]) fs.writeFileSync(path.join(full, f), '# fixture\n', 'utf8');
  }
  fs.writeFileSync(
    path.join(planning, 'ROADMAP.md'),
    o.roadmap === undefined ? scratchRoadmap() : o.roadmap,
    'utf8',
  );
  return root;
}

function roadmapPathOf(root) {
  return path.join(root, '.planning', 'ROADMAP.md');
}

function runGenerator(root, flag) {
  const args = [GENERATOR];
  if (flag) args.push(flag);
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { FERROX_ROADMAP_INDEX_ROOT: root }),
  });
}

test('the scan returns one record per phase detail heading, carrying its counts and its derived status', () => {
  const root = scratchProject({});
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const result = scan.scanPhaseEntries(root, text);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.entries.map((e) => e.number), ['14', '15']);
  const fourteen = result.entries[0];
  assert.equal(fourteen.name, 'The Milestone Index');
  assert.equal(fourteen.planCount, 1);
  assert.equal(fourteen.summaryCount, 1);
});

test('a phase with a heading and no directory on disk yields zero plans and the not-started status', () => {
  const root = scratchProject({});
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const fifteen = scan.scanPhaseEntries(root, text).entries.find((e) => e.number === '15');
  assert.equal(fifteen.planCount, 0, 'phase 15 has no directory');
  assert.equal(fifteen.summaryCount, 0);
  assert.equal(fifteen.status, 'Not started', 'the pending default is the committed table casing');
});

test('a directory on disk with no heading in the current phase details never enters the render', () => {
  const root = scratchProject({
    phases: {
      '14-milestone-index': ['14-01-PLAN.md', '14-01-SUMMARY.md'],
      '08-dogfood': ['08-01-PLAN.md', '08-01-SUMMARY.md'],
    },
  });
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const numbers = scan.scanPhaseEntries(root, text).entries.map((e) => e.number);
  assert.ok(!numbers.includes('8') && !numbers.includes('08'), 'a shipped milestone directory is ignored');
});

test('the status the scan reports equals the status the shipped derivation reports for the same directory', () => {
  const root = scratchProject({
    phases: { '14-milestone-index': ['14-01-PLAN.md', '14-02-PLAN.md', '14-01-SUMMARY.md'] },
  });
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const fourteen = scan.scanPhaseEntries(root, text).entries.find((e) => e.number === '14');
  const dir = path.join(root, '.planning', 'phases', '14-milestone-index');
  const counts = scanPhasePlans(dir);
  assert.equal(
    fourteen.status,
    commands.determinePhaseStatus(counts.planCount, counts.summaryCount, dir, 'Not started'),
    'the scan calls the shipped derivation rather than reimplementing it',
  );
});

test('the generator with no flag writes both regions to stdout and touches no file', () => {
  const root = scratchProject({});
  const before = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const run = runGenerator(root, null);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes(lib.NOTICE_SENTINEL), 'the notice is on stdout');
  assert.ok(run.stdout.includes('| Phase | Plans Complete | Status | Completed |'), 'the table is on stdout');
  assert.equal(fs.readFileSync(roadmapPathOf(root), 'utf8'), before, 'no file was touched');
});

test('the write flag rewrites only the 2 regions and leaves every byte outside them identical', () => {
  const root = scratchProject({});
  const before = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const run = runGenerator(root, '--write');
  assert.equal(run.status, 0, run.stderr);
  const after = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const outside = (text) => {
    const located = lib.locateRegions(text, 'ROADMAP.md');
    const spans = [located.regions.phases, located.regions.progress]
      .filter(Boolean)
      .sort((a, b) => a.startOffset - b.startOffset);
    let out = '';
    let cursor = 0;
    for (const s of spans) {
      out += text.slice(cursor, s.startOffset);
      cursor = s.endOffset;
    }
    return out + text.slice(cursor);
  };
  assert.equal(
    outside(after).replace(/\n+/g, '\n'),
    outside(before).replace(/\n+/g, '\n'),
    'the bytes outside the 2 regions are preserved',
  );
  assert.ok(after.includes('**Phase Numbering:**'), 'the hand-written block above the region survives');
  assert.ok(after.includes('**Goal**: measure before building.'), 'the hand-written Phase Details survive');
});

test('the check flag exits 0 against a regenerated file and names it as up to date', () => {
  const root = scratchProject({});
  assert.equal(runGenerator(root, '--write').status, 0);
  const run = runGenerator(root, '--check');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ROADMAP\.md is up to date\./);
});

test('a second write is a no-op, which is what makes the check meaningful', () => {
  const root = scratchProject({});
  assert.equal(runGenerator(root, '--write').status, 0);
  const first = fs.readFileSync(roadmapPathOf(root), 'utf8');
  assert.equal(runGenerator(root, '--write').status, 0);
  assert.equal(fs.readFileSync(roadmapPathOf(root), 'utf8'), first, 'the second write changed nothing');
});

test('a drifted region exits 1 with a run line and a 2 space indented fixing command', () => {
  const root = scratchProject({});
  assert.equal(runGenerator(root, '--write').status, 0);
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  fs.writeFileSync(roadmapPathOf(root), text.replace('The Milestone Index**', 'The Milestone IndeX**'), 'utf8');
  const run = runGenerator(root, '--check');
  assert.equal(run.status, 1, 'drift fails the check');
  const message = run.stdout + run.stderr;
  assert.match(message, /is stale/, 'the message names what is wrong');
  assert.match(message, /Run:/, 'the message carries a run line');
  assert.match(message, /\n {2}node scripts\/gen-roadmap-index\.cjs --write/, 'the fix is indented 2 spaces');
});

test('a foreign line inside a generated region fails the check and the write refuses to overwrite it', () => {
  const root = scratchProject({});
  assert.equal(runGenerator(root, '--write').status, 0);
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const marker = '- [ ] **Phase 15:';
  const injected = text.replace(marker, 'A human wrote this here.\n' + marker);
  fs.writeFileSync(roadmapPathOf(root), injected, 'utf8');

  const checkRun = runGenerator(root, '--check');
  assert.equal(checkRun.status, 1, 'the interleaved line fails the check');
  assert.match(checkRun.stdout + checkRun.stderr, /E_ROADMAP_INDEX_INTERLEAVED/);
  assert.match(checkRun.stdout + checkRun.stderr, /A human wrote this here\./, 'the offending line is quoted');

  const writeRun = runGenerator(root, '--write');
  assert.equal(writeRun.status, 1, 'the write refuses rather than overwriting');
  assert.equal(
    fs.readFileSync(roadmapPathOf(root), 'utf8'),
    injected,
    'not one byte was overwritten',
  );
});

test('a scope declaration naming another milestone exits 1', () => {
  const root = scratchProject({
    roadmap: scratchRoadmap().replace('v1.14 (Fleet Mode)', 'v1.15 (Later)'),
  });
  const run = runGenerator(root, '--check');
  assert.equal(run.status, 1);
  assert.match(run.stdout + run.stderr, /1\.15/);
  assert.match(run.stdout + run.stderr, /1\.14/);
});

test('zero active milestones and more than 1 active milestone each exit 1 with their own message', () => {
  const noneRoot = scratchProject({
    milestone: MILESTONE_ARTIFACT.replace('lifecycle: active', 'lifecycle: complete'),
  });
  const noneRun = runGenerator(noneRoot, '--check');
  assert.equal(noneRun.status, 1);
  const noneMessage = noneRun.stdout + noneRun.stderr;
  assert.match(noneMessage, /lifecycle: active/, 'the fix names the frontmatter key to set');

  const manyRoot = scratchProject({});
  fs.writeFileSync(
    path.join(manyRoot, '.planning', 'MILESTONE-v1.15-LATER.md'),
    MILESTONE_ARTIFACT.replace('"1.14"', '"1.15"').replace('"Fleet Mode"', '"Later"'),
    'utf8',
  );
  const manyRun = runGenerator(manyRoot, '--check');
  assert.equal(manyRun.status, 1);
  const manyMessage = manyRun.stdout + manyRun.stderr;
  assert.notEqual(noneMessage, manyMessage, 'the 2 cases carry different messages');
});

test('a missing built lib produces the build command rather than a module-not-found stack', () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-roadmap-index-nolib-'));
  SCRATCH_ROOTS.push(isolated);
  fs.mkdirSync(path.join(isolated, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(GENERATOR, path.join(isolated, 'scripts', 'gen-roadmap-index.cjs'));
  fs.copyFileSync(
    path.join(__dirname, '..', 'scripts', 'lib', 'cli-exit.cjs'),
    path.join(isolated, 'scripts', 'lib', 'cli-exit.cjs'),
  );
  const run = spawnSync(process.execPath, [path.join(isolated, 'scripts', 'gen-roadmap-index.cjs'), '--check'], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { FERROX_ROADMAP_INDEX_ROOT: isolated }),
  });
  assert.equal(run.status, 1);
  const message = run.stdout + run.stderr;
  assert.match(message, /npm run build:lib/, 'the missing build names its fix command');
  assert.ok(!message.includes('MODULE_NOT_FOUND'), 'no raw module resolution stack reaches the operator');
});

test('the shared rebuild is idempotent and preserves every byte outside the 2 regions', () => {
  const root = scratchProject({});
  const original = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const first = scan.rebuildRoadmapRegions(root, original);
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  const second = scan.rebuildRoadmapRegions(root, first.text);
  assert.equal(second.text, first.text, 'a second rebuild is a no-op');
  assert.ok(first.text.includes('**Phase Numbering:**'));
  assert.ok(first.text.includes('**Goal**: measure before building.'));
});

test('a completion date override lands in both regions, because both render from that one value', () => {
  const root = scratchProject({
    phases: { '14-milestone-index': ['14-01-PLAN.md', '14-01-SUMMARY.md', '14-VERIFICATION.md'] },
  });
  fs.writeFileSync(
    path.join(root, '.planning', 'phases', '14-milestone-index', '14-VERIFICATION.md'),
    '---\nstatus: passed\n---\n',
    'utf8',
  );
  const original = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const rebuilt = scan.rebuildRoadmapRegions(root, original, { 14: '2026-07-26' });
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.errors));
  assert.ok(rebuilt.text.includes('(completed 2026-07-26)'), 'the index entry carries the stamped date');
  assert.ok(rebuilt.text.includes('| 2026-07-26 |'), 'the completed column carries the same value');
});

test('a roadmap with no phase detail headings is left alone rather than emptied', () => {
  const bulletsOnly = [
    '# Roadmap: Scratch',
    '',
    SCRATCH_SCOPE,
    '',
    '## Phases',
    '',
    '- [ ] **Phase 14: The Milestone Index**',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '',
  ].join('\n');
  const root = scratchProject({ roadmap: bulletsOnly });
  const rebuilt = scan.rebuildRoadmapRegions(root, bulletsOnly);
  assert.equal(rebuilt.text, bulletsOnly, 'no headings means no source, so the render is a no-op');
});

test('the impure scan reads no state file and never calls the function that does', () => {
  const src = fs.readFileSync(path.join(LIB_DIR, 'roadmap-index-scan.cjs'), 'utf8');
  assert.ok(!src.includes('STATE.md'), 'the scan names no path into the state file');
  assert.ok(!src.includes('extractCurrentMilestone'), 'the scan never calls the function that reads it');
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

// ─── the 6 reconciled region writers ─────────────────────────────────────────
//
// A scan of the pre-existing suite found ZERO references to the progress table
// columns, to the completion parenthetical, or to these 6 commands, so the
// writes retired in this plan had no coverage at all. These cases are the
// first, which is a reason to make them thorough rather than thin.

const TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

const SDK_STATE = [
  '---',
  'ferrox_state_version: 1.0',
  'milestone: v1.14',
  'milestone_name: Fleet Mode',
  'current_phase: 14',
  'current_phase_name: milestone-index',
  'current_plan: 1',
  'status: executing',
  'progress:',
  '  total_phases: 1',
  '  completed_phases: 0',
  '  total_plans: 1',
  '  completed_plans: 0',
  '---',
  '',
  '# Project State',
  '',
  '## Current Position',
  '',
  'Phase: 14 (milestone-index)',
  'Plan: 1 of 1 in current phase',
  'Status: Executing Phase 14',
  'Last activity: 2026-07-25',
  '',
].join('\n');

function sdkProject(opts) {
  const o = opts || {};
  const root = scratchProject({
    phases: o.phases || {
      '14-milestone-index': ['14-01-PLAN.md', '14-01-SUMMARY.md'],
    },
    roadmap: o.roadmap,
  });
  const planning = path.join(root, '.planning');
  fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify({ phase_naming: 'sequential' }), 'utf8');
  fs.writeFileSync(path.join(planning, 'STATE.md'), o.state === undefined ? SDK_STATE : o.state, 'utf8');
  assert.equal(runGenerator(root, '--write').status, 0, 'the scratch roadmap starts compliant');
  return root;
}

function runTools(root, args) {
  return spawnSync(process.execPath, [TOOLS].concat(args).concat(['--cwd', root]), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { FERROX_ROADMAP_INDEX_ROOT: root }),
  });
}

/** The regions of the post-command file must equal a fresh render of it. */
function assertRegionsMatchFreshRender(root, command) {
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const fresh = scan.rebuildRoadmapRegions(root, text);
  assert.equal(fresh.ok, true, `${command}: the roadmap must still render, got ${JSON.stringify(fresh.errors)}`);
  assert.equal(fresh.text, text, `${command}: the generated regions must be byte-identical to a fresh render`);
  const run = runGenerator(root, '--check');
  assert.equal(run.status, 0, `${command}: the drift check must pass immediately afterward. ${run.stdout}${run.stderr}`);
}

/** All 3 src/phase.cts readers must still resolve against the result. */
function assertReadersResolve(root, phaseNumber, command) {
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const p = readerPatterns(phaseNumber);
  const entryLine = text
    .split(/\r?\n/)
    .find((l) => new RegExp(`^- \\[[ x]\\] \\*\\*Phase ${phaseNumber.replace('.', '\\.')}:`).test(l));
  assert.ok(entryLine, `${command}: phase ${phaseNumber} has an index entry`);
  assert.ok(p.r1.test(entryLine.replace(/^- \[x\]/, '- [ ]')), `${command}: R1 resolves for phase ${phaseNumber}`);
  assert.ok(p.r2.test(entryLine), `${command}: R2 resolves for phase ${phaseNumber}`);
  assert.ok(p.r3.test(entryLine), `${command}: R3 resolves for phase ${phaseNumber}`);
}

test('phase add leaves both regions equal to a fresh render, so a new phase appears without a second command', () => {
  const root = sdkProject({});
  const run = runTools(root, ['phase', 'add', 'A Brand New Phase']);
  assert.equal(run.status, 0, run.stderr);
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  assert.match(text, /- \[ \] \*\*Phase 16: A Brand New Phase\*\*/, 'phase add: the index entry appeared');
  assert.match(text, /\| 16\. A Brand New Phase \| 0\/TBD \|/, 'phase add: the progress row appeared');
  assertRegionsMatchFreshRender(root, 'phase add');
  assertReadersResolve(root, '16', 'phase add');
});

test('phase add-batch leaves both regions equal to a fresh render', () => {
  const root = sdkProject({});
  const run = runTools(root, ['phase', 'add-batch', '--descriptions', JSON.stringify(['First Added', 'Second Added'])]);
  assert.equal(run.status, 0, run.stderr);
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  assert.match(text, /- \[ \] \*\*Phase 16: First Added\*\*/, 'phase add-batch: the first entry appeared');
  assert.match(text, /- \[ \] \*\*Phase 17: Second Added\*\*/, 'phase add-batch: the second entry appeared');
  assertRegionsMatchFreshRender(root, 'phase add-batch');
  assertReadersResolve(root, '17', 'phase add-batch');
});

test('phase insert leaves both regions equal to a fresh render, and the inserted entry carries its tag', () => {
  const root = sdkProject({});
  const run = runTools(root, ['phase', 'insert', '14', 'An Urgent Insertion']);
  assert.equal(run.status, 0, run.stderr);
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  assert.match(
    text,
    /- \[ \] \*\*Phase 14\.1: An Urgent Insertion\*\* \(INSERTED\)/,
    'phase insert: the decimal entry carries its parenthetical',
  );
  assertRegionsMatchFreshRender(root, 'phase insert');
  assertReadersResolve(root, '14.1', 'phase insert');
});

test('phase remove leaves both regions equal to a fresh render, with the removed entry absent from both', () => {
  const root = sdkProject({});
  const run = runTools(root, ['phase', 'remove', '15', '--force']);
  assert.equal(run.status, 0, run.stderr);
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  assert.ok(!text.includes('Prove the Premise'), 'phase remove: the removed phase is gone from every region');
  assertRegionsMatchFreshRender(root, 'phase remove');
  assertReadersResolve(root, '14', 'phase remove');
});

test('phase complete leaves both regions equal to a fresh render and stamps one date into both', () => {
  const root = sdkProject({});
  fs.writeFileSync(
    path.join(root, '.planning', 'phases', '14-milestone-index', '14-VERIFICATION.md'),
    '---\nstatus: passed\n---\n\n# Verified\n',
    'utf8',
  );
  const run = runTools(root, ['phase', 'complete', '14']);
  assert.equal(run.status, 0, run.stderr);
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const stamp = /\(completed (\d{4}-\d{2}-\d{2})\)/.exec(text);
  assert.ok(stamp, 'phase complete: the index entry carries a completion stamp');
  assert.match(text, /^- \[x\] \*\*Phase 14: /m, 'phase complete: the box is checked');
  assert.ok(
    text.includes(`| ${stamp[1]} |`),
    'phase complete: the Completed column carries the same date, because both render from one value',
  );
  assert.match(text, /\| 14\. The Milestone Index \| 1\/1 \| Complete \|/, 'phase complete: the row reads Complete');
  assertRegionsMatchFreshRender(root, 'phase complete');
  assertReadersResolve(root, '14', 'phase complete');
});

test('roadmap update-plan-progress leaves both regions equal to a fresh render', () => {
  const root = sdkProject({
    phases: { '14-milestone-index': ['14-01-PLAN.md', '14-02-PLAN.md', '14-01-SUMMARY.md'] },
  });
  const run = runTools(root, ['roadmap', 'update-plan-progress', '14']);
  assert.equal(run.status, 0, run.stderr);
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  assert.match(text, /\| 14\. The Milestone Index \| 1\/2 \| In Progress \| - \|/, 'the row follows the directory');
  assert.match(text, /^- \[ \] \*\*Phase 14: /m, 'an unverified phase keeps an unchecked box');
  assertRegionsMatchFreshRender(root, 'roadmap update-plan-progress');
  assertReadersResolve(root, '14', 'roadmap update-plan-progress');
});

test('the lowest-outstanding override still finds a lower outstanding phase after a completion', () => {
  const root = sdkProject({
    phases: {
      '14-milestone-index': ['14-01-PLAN.md'],
      '15-prove-the-premise': ['15-01-PLAN.md', '15-01-SUMMARY.md'],
    },
  });
  fs.writeFileSync(
    path.join(root, '.planning', 'phases', '15-prove-the-premise', '15-VERIFICATION.md'),
    '---\nstatus: passed\n---\n',
    'utf8',
  );
  const run = runTools(root, ['phase', 'complete', '15']);
  assert.equal(run.status, 0, run.stderr);
  const text = fs.readFileSync(roadmapPathOf(root), 'utf8');
  const p = readerPatterns('14');
  const outstanding = text
    .split(/\r?\n/)
    .find((l) => /^- \[ \] \*\*Phase 14:/.test(l));
  assert.ok(outstanding, 'phase 14 is still an unchecked entry the override can find');
  assert.ok(p.r3.test(outstanding), 'the override pattern resolves against it');
  assertRegionsMatchFreshRender(root, 'the lowest-outstanding override');
});

test('completing a phase writes the DISK-derived counters even when the progress table disagrees', () => {
  // The committed table claims 2 complete phases out of 2. The directories hold
  // 1 phase with 1 plan and 1 summary. The state counters must follow the disk.
  const lyingProgress = [
    '**Execution Order:**',
    'Phases execute in numeric order: 14 → 15',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 14. The Milestone Index | 9/9 | Complete | 2020-01-01 |',
    '| 15. Prove the Premise | 9/9 | Complete | 2020-01-01 |',
  ];
  const root = scratchProject({
    phases: { '14-milestone-index': ['14-01-PLAN.md', '14-01-SUMMARY.md'] },
    roadmap: scratchRoadmap({ progressBody: lyingProgress }),
  });
  fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ phase_naming: 'sequential' }), 'utf8');
  fs.writeFileSync(path.join(root, '.planning', 'STATE.md'), SDK_STATE, 'utf8');
  fs.writeFileSync(
    path.join(root, '.planning', 'phases', '14-milestone-index', '14-VERIFICATION.md'),
    '---\nstatus: passed\n---\n',
    'utf8',
  );
  const run = runTools(root, ['phase', 'complete', '14']);
  assert.equal(run.status, 0, run.stderr);
  const state = fs.readFileSync(path.join(root, '.planning', 'STATE.md'), 'utf8');
  assert.match(state, /^ {2}total_phases: 1$/m, 'total_phases follows the 1 phase directory, not the 2 table rows');
  assert.match(state, /^ {2}total_plans: 1$/m, 'total_plans follows the 1 plan file, not the claimed 9');
  assert.match(state, /^ {2}completed_plans: 1$/m, 'completed_plans follows the 1 summary file');
});

test('the retired region writers are gone rather than bypassed', () => {
  const phaseSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'phase.cts'), 'utf8');
  const roadmapSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'roadmap.cts'), 'utf8');
  const lifecycleSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'phase-lifecycle.cts'), 'utf8');
  assert.ok(!phaseSrc.includes('updateBullet'), 'the checkbox flip and its explanatory comments are gone');
  assert.ok(!phaseSrc.includes('editProgressHeadingSlice'), 'the progress slice helper is gone');
  assert.ok(!roadmapSrc.includes('editProgressTableSlice'), 'the progress table slice helper is gone');
  assert.ok(!roadmapSrc.includes('updateTableCell'), 'the table cell writes and their import are gone');
  assert.ok(phaseSrc.includes('updateTableCell'), 'the traceability cell writes in phase.cts are NOT collateral damage');
  assert.ok(phaseSrc.includes('withPhaseSection'), 'the hand-written Phase Details writes survived');
  assert.ok(
    !lifecycleSrc.includes('export function deriveProgressFromRoadmap'),
    'the last edge from the generated regions into the state counters is removed',
  );
});

// ─── FF-B48: the 2 residual STATE-reads-ROADMAP edges, settled ───────────────
//
// `buildStateFrontmatter` still reads ROADMAP.md twice: the retired-phase
// EXCLUSION (`extractRetiredPhaseNumbers`, src/state.cts) which scans `~~Phase
// N~~` strikethrough spans, and the `milestoneBounded` probe which tests for a
// versioned level 1 to 3 heading. Neither can raise a counter. The open
// question FF-B48 filed was whether making ROADMAP.md generated turns them into
// a real loop. It does not, and these 2 cases pin the reason MECHANICALLY
// rather than by argument: the generated regions contain neither of the 2
// shapes those readers look for, so both readers can only ever see
// hand-written bytes.

test('no rendered region emits a strikethrough span, so the retired-phase exclusion never reads a generated byte', () => {
  const rendered = lib.renderPhaseIndex(BASE_ENTRIES) + '\n' + lib.renderProgressSection(BASE_ENTRIES);
  assert.ok(!rendered.includes('~'), 'a tilde in a generated region would feed extractRetiredPhaseNumbers');
  const live = fs.readFileSync(path.join(__dirname, '..', '.planning', 'ROADMAP.md'), 'utf8');
  const located = lib.locateRegions(live, 'ROADMAP.md');
  for (const kind of ['phases', 'progress']) {
    const span = located.regions[kind];
    assert.ok(span, `the live ${kind} region resolves`);
    assert.ok(!lib.regionText(live, span).includes('~'), `the live ${kind} region carries no strikethrough`);
  }
});

test('no rendered region emits a markdown heading, so the milestone-bounded probe never reads a generated byte', () => {
  const rendered = lib.renderPhaseIndex(BASE_ENTRIES) + '\n' + lib.renderProgressSection(BASE_ENTRIES);
  for (const line of rendered.split('\n')) {
    assert.ok(!/^#{1,6}\s/.test(line), `a heading inside a generated region would feed the bounded probe: ${line}`);
  }
});
