'use strict';

/**
 * MILESTONE v1.12 Wave 3: exit-as-intake seam receipts.
 *
 * Two halves. (1) Mechanical assertions on the WORKFLOW DOCS: the repo's
 * workflows are prompts, not executable code, so this file asserts the text
 * contracts that make brainstorm ingestion real in new-project (BOTH the
 * interactive path AND the auto path, so the skip-chain gap can never
 * silently return), discuss-phase, new-milestone, and plan-phase, plus the
 * unchanged promotion rule in brainstorm.md. (2) The countable receipt: a
 * fixture BRAINSTORM.md with 3 exit-confirmed decisions and a fixture
 * question list run through the real parser lib
 * (ferrox-core/bin/lib/brainstorm-intake.cjs), proving N in = N out,
 * provenance parsed, hedged items never promoted, and 0 re-askable
 * questions in both interactive and auto modes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WF = (name) => path.join(ROOT, 'ferrox-core', 'workflows', name);
const read = (f) => fs.readFileSync(f, 'utf8');

const newProject = read(WF('new-project.md'));
const discussPhase = read(WF('discuss-phase.md'));
const newMilestone = read(WF('new-milestone.md'));
const planPhase = read(WF('plan-phase.md'));
const brainstorm = read(WF('brainstorm.md'));

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'brainstorm-seam');
const FIXTURE_MD = path.join(FIXTURE_DIR, 'BRAINSTORM.md');
const FIXTURE_QS = path.join(FIXTURE_DIR, 'questions.json');

const { parseBrainstormArtifact, classifyQuestions } = require('../ferrox-core/bin/lib/brainstorm-intake.cjs');

// Shared contract strings. Every workflow that consumes Decisions must carry
// all 4: detection, deterministic parsing, OFF LIMITS, reopen-by-name.
const DETECT = '.planning/brainstorms/*/BRAINSTORM.md';
const PARSER_REF = 'brainstorm-intake.cjs';
const OFF_LIMITS = 'never re-ask a decided item unprompted';
const REOPEN = 'reopening a decision by name always works';
const ACK = 'locked decisions; using it as intake';

const CONSUMERS = [
  ['new-project.md', newProject],
  ['discuss-phase.md', discussPhase],
  ['new-milestone.md', newMilestone],
  ['plan-phase.md', planPhase],
];

// ─── The 4 consumer workflows: ingestion + OFF LIMITS + reopen-by-name ───────

test('every consumer workflow detects brainstorm artifacts and names the parsing contract', () => {
  for (const [name, doc] of CONSUMERS) {
    assert.ok(doc.includes(DETECT), `${name} detects ${DETECT}`);
    assert.ok(doc.includes(PARSER_REF), `${name} names the deterministic parsing contract`);
    assert.ok(doc.includes('confirmed at exit'), `${name} requires exit provenance`);
  }
});

test('every consumer workflow carries the OFF LIMITS rule and the reopen-by-name escape', () => {
  for (const [name, doc] of CONSUMERS) {
    assert.ok(doc.includes(OFF_LIMITS), `${name} carries the OFF LIMITS sentence`);
    assert.ok(doc.includes(REOPEN), `${name} carries the reopen-by-name rule`);
    assert.match(doc, /fair game/, `${name} keeps Notes/Open Questions askable`);
  }
});

test('every consumer workflow acknowledges ingestion in 1 line', () => {
  for (const [name, doc] of CONSUMERS) {
    assert.ok(doc.includes(ACK), `${name} carries the 1-line acknowledgment`);
  }
});

// ─── new-project: BOTH paths, so the auto skip-chain gap cannot return ───────

test('new-project interactive path: Step 2c detection with most-recent-first selection', () => {
  assert.match(newProject, /## 2c\. Prior Brainstorm Detection/);
  assert.match(newProject, /ls -dt \.planning\/brainstorms\/\*\/BRAINSTORM\.md/);
  assert.match(newProject, /most recent first/i);
  assert.match(newProject, /offer selection/i);
  assert.match(newProject, /Found a brainstorm from \{date\} on \{topic\} with \{N\} locked decisions; using it as intake\./);
});

test('new-project Step 3: OFF-LIMITS list threaded into the questioning rules', () => {
  const step3 = newProject.split('## 3. Deep Questioning')[1].split('## 4. Write PROJECT.md')[0];
  assert.match(step3, /Brainstorm OFF-LIMITS rule/);
  assert.ok(step3.includes(OFF_LIMITS), 'questioning rules carry the OFF LIMITS sentence');
  assert.ok(step3.includes(REOPEN), 'questioning rules carry the reopen-by-name rule');
  assert.match(step3, /fair game and GOOD question seeds/);
});

test('new-project auto path: Step 4 synthesis ingests brainstorm decisions itself', () => {
  const step4 = newProject.split('## 4. Write PROJECT.md')[1].split('## 5. Workflow Preferences')[0];
  assert.match(step4, /Auto mode brainstorm ingestion/, 'the auto branch of Step 4 owns the read');
  assert.match(step4, /ls -dt \.planning\/brainstorms\/\*\/BRAINSTORM\.md/, 'auto branch reads the artifacts directly');
  assert.ok(step4.includes(PARSER_REF), 'auto branch uses the deterministic contract');
  assert.match(step4, /never silently skipped/, 'decisions must LAND in auto mode');
  assert.match(step4, /Key Decisions table/, 'auto merge target is the Key Decisions table');
});

test('new-project auto skip-chain: both skip sentences forward to the Step 4 ingestion', () => {
  assert.match(
    newProject,
    /Skip to Step 4[^\n]*\n?[^\n]*does NOT skip brainstorm ingestion/,
    'the Step 2 auto skip names the ingestion explicitly'
  );
  assert.match(
    newProject,
    /Proceed to Step 4 \(skip Steps 3 and 5\)\. Brainstorm ingestion is not lost/,
    'the Step 2a auto skip names the ingestion explicitly'
  );
});

test('new-project Key Decisions table: brainstorm rows carry provenance in both modes', () => {
  assert.match(newProject, /\[Brainstorm decision text\] \| Brainstorm \{slug\}-\{date\} \(stance: \{stance\}, confirmed at exit\)/);
  assert.match(newProject, /in both interactive and auto modes/);
});

// ─── discuss-phase, new-milestone, plan-phase specifics ──────────────────────

test('discuss-phase: ingestion extends the existing prior-decisions machinery', () => {
  const step = discussPhase.split('<step name="load_prior_context">')[1].split('</step>')[0];
  assert.match(step, /Brainstorm artifacts \(exit-as-intake\)/);
  assert.match(step, /Add each exit-confirmed Decision to `<prior_decisions>` as a locked entry/);
  assert.match(step, /From Brainstorms \(exit-confirmed Decisions with provenance, marked OFF LIMITS\)/);
  assert.match(step, /gray-area seeds/);
});

test('new-milestone: brainstorm scan lives beside the seed scan with the route filter', () => {
  assert.match(newMilestone, /## 2\.6\. Scan Brainstorm Artifacts/);
  assert.match(newMilestone, /## 2\.5\. Scan Planted Seeds[\s\S]*## 2\.6\. Scan Brainstorm Artifacts/, 'ordering: seeds then brainstorms');
  assert.match(newMilestone, /`status:` is `captured`/);
  assert.match(newMilestone, /Next Step section routes to `\/ferrox:new-milestone` \(the seed-milestone exit\)/);
  assert.match(newMilestone, /auto-select ALL in `--auto` mode/);
});

test('plan-phase: decisions surface to the planner as locked constraints, not re-litigated', () => {
  assert.match(planPhase, /## 4\.2\. Ingest Brainstorm Decisions \(exit-as-intake\)/);
  assert.match(planPhase, /the planner does not re-litigate them/);
  assert.match(planPhase, /BRAINSTORM_PATHS/);
  assert.match(planPhase, /\{BRAINSTORM_PATHS\} \(Brainstorm artifacts from step 4\.2/, 'planner files_to_read carries the artifacts');
});

// ─── brainstorm.md: the promotion rule is unchanged ──────────────────────────

test('brainstorm.md promotion rule and provenance format are untouched', () => {
  assert.match(brainstorm, /Decisions section may only contain\s+exit-confirmed items/);
  assert.match(brainstorm, /\(stance: \{guided\|generative\|sounding-board\}, confirmed at exit\)/);
  assert.match(brainstorm, /OFF LIMITS means never re-ask\s+unprompted, not immutable/);
  assert.match(brainstorm, /reopening a decision by name always\s+works/);
  assert.match(brainstorm, /Park closes without promoting anything, and that is\s+success, not failure/);
});

// ─── The parser: N in = N out, provenance parsed, hedges never promoted ──────

const fixtureText = read(FIXTURE_MD);
const intake = parseBrainstormArtifact(fixtureText);

test('parser: frontmatter fields land', () => {
  assert.equal(intake.frontmatter.template, 'software');
  assert.equal(intake.frontmatter.status, 'captured');
});

test('parser: N in = N out (every provenance line in the fixture becomes exactly 1 decision)', () => {
  const provenanceLines = (fixtureText.match(/\(stance: (guided|generative|sounding-board), confirmed at exit\)/g) || []).length;
  assert.equal(provenanceLines, 3, 'fixture carries 3 exit-confirmed decisions');
  assert.equal(intake.decisions.length, provenanceLines, 'N in = N out');
});

test('parser: provenance parsed per decision', () => {
  const stances = intake.decisions.map((d) => d.stance);
  assert.deepEqual(stances, ['guided', 'sounding-board', 'generative']);
  for (const d of intake.decisions) {
    assert.equal(d.confirmedAtExit, true);
    assert.ok(!/\(stance:/.test(d.text), 'provenance stripped from text');
  }
});

test('parser: an unconfirmed item inside Decisions is demoted, never promoted (fail-closed)', () => {
  assert.equal(intake.demoted.length, 1);
  assert.match(intake.demoted[0], /WebRTC/);
  assert.ok(intake.notes.includes(intake.demoted[0]), 'demoted item stays askable as a note');
  assert.ok(!intake.decisions.some((d) => /WebRTC/.test(d.text)), 'demoted item is not a decision');
});

test('parser: hedged items in Notes never classify as decisions', () => {
  assert.equal(intake.notes.filter((n) => /^(Maybe|Leaning)/.test(n)).length, 2, 'hedged notes present');
  for (const d of intake.decisions) {
    assert.ok(!/^(Maybe|Leaning|Mobile might)/.test(d.text), `hedge promoted to decision: ${d.text}`);
  }
});

test('parser: open questions extracted and freely askable', () => {
  assert.equal(intake.openQuestions.length, 2);
  assert.match(intake.openQuestions[0], /Which CRDT library/);
});

test('parser: never throws on garbage', () => {
  for (const junk of [null, undefined, 42, {}, '', '## Decisions\n\ngarbage', '---\nbroken']) {
    const r = parseBrainstormArtifact(junk);
    assert.ok(Array.isArray(r.decisions) && Array.isArray(r.notes) && Array.isArray(r.openQuestions));
  }
});

// ─── The seam receipt: 0 re-askable questions, both modes ────────────────────

test('receipt (interactive): every decision-re-asking question is filtered; re-askable is 0', () => {
  const spec = JSON.parse(read(FIXTURE_QS));
  const texts = spec.questions.map((q) => q.text);
  const { offLimits, askable } = classifyQuestions(intake.decisions, texts);

  for (const q of spec.questions) {
    if (q.expected === 'off-limits') {
      const hit = offLimits.find((o) => o.question === q.text);
      assert.ok(hit, `${q.id} must be off-limits`);
      assert.equal(hit.decision, q.reasks, `${q.id} names the decision it re-asks`);
    } else {
      assert.ok(askable.includes(q.text), `${q.id} must stay askable`);
    }
  }

  const reaskable = askable.filter(
    (text) => spec.questions.find((q) => q.text === text).expected === 'off-limits'
  ).length;
  assert.equal(reaskable, 0);

  console.log(`decisions ingested: ${intake.decisions.length}, re-askable: ${reaskable}`);
  console.log(
    `seam receipt (interactive): decisions ingested: ${intake.decisions.length}, ` +
      `questions skipped as off-limits: ${offLimits.length}, questions asked: ${askable.length}, re-askable: ${reaskable}`
  );
});

test('receipt (auto): no questions asked, every decision still lands', () => {
  const askedInAuto = [];
  const { offLimits, askable } = classifyQuestions(intake.decisions, askedInAuto);
  assert.equal(offLimits.length, 0);
  assert.equal(askable.length, 0);
  assert.equal(intake.decisions.length, 3, 'all 3 decisions available to land in PROJECT.md');
  console.log(
    `seam receipt (auto): decisions ingested: ${intake.decisions.length}, ` +
      'questions asked: 0, re-askable: 0'
  );
});

// ─── Editorial floor on the new surfaces ─────────────────────────────────────

test('no em or en dashes in the new seam surfaces', () => {
  const files = [
    path.join(ROOT, 'src', 'brainstorm-intake.cts'),
    FIXTURE_MD,
    FIXTURE_QS,
    __filename,
  ];
  for (const file of files) {
    const text = read(file);
    assert.ok(!text.includes('\u2014'), `em dash in ${path.relative(ROOT, file)}`);
    assert.ok(!text.includes('\u2013'), `en dash in ${path.relative(ROOT, file)}`);
  }
});
