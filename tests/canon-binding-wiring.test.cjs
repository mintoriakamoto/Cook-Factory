'use strict';

/**
 * MILESTONE v1.13 Wave 2: binding wiring (canon store into the executor,
 * planner/verifier domain conditioning, template shapes).
 *
 * Text-contract assertions in the prose-lane-fences idiom: the workflow
 * surfaces are prompts, not executable code, so the contract is that the
 * exact shipped text is present, the canon rows ride the same NONCODE_DOMAIN
 * build-time ternary Wave 0 introduced, and the software-path text at every
 * touched site is still present verbatim (byte-identical software dispatch).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const EXEC = read('ferrox-core/workflows/execute-phase.md');
const PLANNER = read('agents/ferrox-planner.md');
const PLAN_PHASE = read('ferrox-core/workflows/plan-phase.md');
const VERIFIER = read('agents/ferrox-verifier.md');
const VERIFY_WORK = read('ferrox-core/workflows/verify-work.md');
const T_PROJECT = read('ferrox-core/templates/project.md');
const T_REQUIREMENTS = read('ferrox-core/templates/requirements.md');
const T_ROADMAP = read('ferrox-core/templates/roadmap.md');
const T_PHASE_PROMPT = read('ferrox-core/templates/phase-prompt.md');
const ROADMAPPER = read('agents/ferrox-roadmapper.md');
const NEW_PROJECT = read('ferrox-core/workflows/new-project.md');

const CONTRACT_FIELDS = [
  'pov',
  'scene_date',
  'location',
  'threads',
  'flashback',
  'required_on_stage',
  'word_count_target',
  'beats',
];

// ─── 1. Executor binding: canon rows in files_to_read, NONCODE_DOMAIN-gated ──

test('W2-01: executor files_to_read carries LORE.md, SOURCES.md, and book/SPINE.md rows', () => {
  const block = /<files_to_read>([\s\S]*?)<\/files_to_read>/.exec(EXEC);
  assert.ok(block, 'files_to_read block must exist');
  assert.match(block[1], /\$\{PROJECT_ROOT\}\/LORE\.md \(Canon store/);
  assert.match(block[1], /\$\{PROJECT_ROOT\}\/SOURCES\.md \(Sources ledger/);
  assert.match(block[1], /\$\{PROJECT_ROOT\}\/book\/SPINE\.md \(Spine manifest/);
});

test('W2-02: the canon rows ride the NONCODE_DOMAIN ternary (software rows render nothing)', () => {
  const block = /<files_to_read>([\s\S]*?)<\/files_to_read>/.exec(EXEC)[1];
  const gated = /\$\{NONCODE_DOMAIN \? `([\s\S]*?)` : ''\}/.exec(block);
  assert.ok(gated, 'canon rows must be wrapped in the NONCODE_DOMAIN ternary');
  assert.match(gated[1], /LORE\.md/);
  assert.match(gated[1], /SOURCES\.md/);
  assert.match(gated[1], /book\/SPINE\.md/);
});

test('W2-03: executor dispatch names ferrox-chapter-drafter and injects the trusted contract', () => {
  const gated = /\$\{NONCODE_DOMAIN \? `\s*<chapter_drafting>([\s\S]*?)<\/chapter_drafting>\s*` : ''\}/.exec(EXEC);
  assert.ok(gated, 'chapter_drafting block must be NONCODE_DOMAIN-gated');
  const body = gated[1];
  assert.match(body, /ferrox-chapter-drafter is the\s+drafting agent/);
  assert.match(body, /agents\/ferrox-chapter-drafter\.md/);
  assert.match(body, /PLANNER-AUTHORED and\s+TRUSTED/);
  assert.match(body, /<chapter_contract>[\s\S]*<\/chapter_contract>/);
  for (const f of CONTRACT_FIELDS) {
    assert.match(body, new RegExp(`\\{chapter_contract\\.${f}\\}`), `contract carries ${f}`);
  }
  assert.match(body, /additional_on_stage/);
  assert.match(body, /Research-domain plans carry no chapter contract/);
  assert.match(body, /SOURCES\.md ledger/);
});

test('W2-04: software files_to_read rows and the Wave 0 tdd ternary are untouched', () => {
  assert.ok(EXEC.includes("- ${PROJECT_ROOT}/.planning/config.json (Config, if exists)"));
  assert.ok(EXEC.includes('- ${PROJECT_ROOT}/.planning/PROJECT.md (Project context — core value, requirements, evolution rules)'));
  assert.ok(EXEC.includes('- ${PROJECT_ROOT}/.planning/STATE.md (State)'));
  assert.ok(EXEC.includes("${NONCODE_DOMAIN ? '' : '@~/.claude/ferrox-core/references/tdd.md'}"));
  assert.ok(EXEC.includes('${AGENT_SKILLS}'), 'AGENT_SKILLS injection still present');
});

// ─── 2. Planner conditioning: contract frontmatter + chapter-shaped tasks ────

test('W2-05: planner frontmatter schema carries the chapter_contract block with all A1 fields', () => {
  assert.match(PLANNER, /chapter_contract:\s+# BOOK-DOMAIN ONLY/);
  const schema = /chapter_contract:[\s\S]*?beats: \[\]/.exec(PLANNER);
  assert.ok(schema, 'chapter_contract schema block must close with beats');
  for (const f of CONTRACT_FIELDS) {
    assert.match(schema[0], new RegExp(`${f}:`), `schema carries ${f}`);
  }
  assert.match(schema[0], /touch: \[\]/);
  assert.match(schema[0], /open: \[\]/);
  assert.match(schema[0], /close: \[\]/);
});

test('W2-06: planner field table documents chapter_contract as trusted and spine-derived', () => {
  assert.match(PLANNER, /\| `chapter_contract` \| No \| BOOK-DOMAIN ONLY/);
  assert.match(PLANNER, /derived from the spine manifest `book\/SPINE\.md` \+ the LORE\.md canon-facts block/);
});

test('W2-07: planner carries the non-code task shaping section (machine floor, no build commands)', () => {
  assert.match(PLANNER, /## Non-Code Domain Task Shaping \(v1\.13 Wave 2\)/);
  assert.match(PLANNER, /Tasks are chapter-shaped/);
  assert.match(PLANNER, /Never emit tsc\/npm\/build commands for a prose increment/);
  assert.match(PLANNER, /word count within 10 percent of word_count_target/);
  assert.match(PLANNER, /Tasks are report-shaped/);
  assert.match(PLANNER, /sources ledger \(`SOURCES\.md`\) named in read_first/);
  assert.match(PLANNER, /Software and every other code domain: everything below is skipped and planning is unchanged\./);
});

test('W2-08: plan-phase downstream_consumer names the chapter_contract handoff', () => {
  assert.match(PLAN_PHASE, /`chapter_contract:` frontmatter block \(pov, scene_date, location, threads touch\/open\/close, flashback, required_on_stage, word_count_target, beats\)/);
  assert.match(PLAN_PHASE, /execute-phase injects it verbatim into the drafting prompt as the TRUSTED side/);
  assert.match(PLAN_PHASE, /Research-domain plans instead carry report-shaped tasks naming the `SOURCES\.md` ledger/);
});

test('W2-09: planner software schema and gate-metadata surfaces untouched', () => {
  assert.ok(PLANNER.includes('domain: code                # OPTIONAL'));
  assert.ok(PLANNER.includes('gate_present: false         # OPTIONAL'));
  assert.match(PLAN_PHASE, /OPTIONAL gate metadata frontmatter \(UGE-02\)/);
});

// ─── 3. Verifier + verify-work: spine-backward contract checks ───────────────

test('W2-10: verifier carries the chapter-contract spine-backward check', () => {
  assert.match(VERIFIER, /\*\*Chapter-contract spine-backward check \(v1\.13 Wave 2\):\*\*/);
  assert.match(VERIFIER, /draft exists at its slug path \(`book\/chapters\/ch-<slug>\.md`/);
  assert.match(VERIFIER, /ECHOES the trusted contract fields exactly/);
  assert.match(VERIFIER, /within 10 percent of `word_count_target`/);
  assert.match(VERIFIER, /declared threads and pov match the plan/);
});

test('W2-11: verifier software wiring greps untouched', () => {
  assert.ok(VERIFIER.includes('grep -r "import.*$artifact_name" "${search_path:-src/}" --include="*.ts" --include="*.tsx"'));
  assert.match(VERIFIER, /\*\*Artifact-type guard \(v1\.13 Wave 0, B3\):\*\*/);
});

test('W2-12: verify-work adds the Chapter Contract Test beside the Deliverable Shape Test', () => {
  assert.match(VERIFY_WORK, /name: "Chapter Contract Test"/);
  assert.match(VERIFY_WORK, /frontmatter echoes the plan's trusted chapter_contract exactly/);
  assert.match(VERIFY_WORK, /within 10 percent of word_count_target/);
  assert.match(VERIFY_WORK, /declared threads and POV match the plan/);
  // Wave 0 branches intact
  assert.match(VERIFY_WORK, /name: "Deliverable Shape Test"/);
  assert.match(VERIFY_WORK, /name: "Cold Start Smoke Test"/);
});

// ─── 4. Template shapes (the MISALIGN list) + roadmapper + new-project ───────

test('W2-13: project.md constraints get domain-neutral guidance plus book/research examples', () => {
  assert.match(T_PROJECT, /constraints state what binds the work and why, whatever the deliverable is/);
  assert.match(T_PROJECT, /\*\*Voice\*\* \(book\)/);
  assert.match(T_PROJECT, /\*\*Word count\*\* \(book\)/);
  assert.match(T_PROJECT, /\*\*Sources\*\* \(research\)/);
  assert.match(T_PROJECT, /SOURCES\.md ledger entry/);
  // software text untouched
  assert.ok(T_PROJECT.includes('Common types: Tech stack, Timeline, Budget, Dependencies, Compatibility, Performance, Security'));
});

test('W2-14: requirements.md completion criteria gain chapter/report examples beside tests', () => {
  assert.match(T_REQUIREMENTS, /A book chapter is "Complete" when/);
  assert.match(T_REQUIREMENTS, /word count is within 10 percent of word_count_target/);
  assert.match(T_REQUIREMENTS, /A research report is "Complete" when/);
  assert.match(T_REQUIREMENTS, /every claim maps to a SOURCES\.md ledger entry/);
  // software criteria untouched
  assert.ok(T_REQUIREMENTS.includes('Feature is verified (tests pass, manual check done)'));
});

test('W2-15: roadmap.md carries the book phase example with word_count_target + beats in must_haves', () => {
  assert.match(T_ROADMAP, /a book phase is a part or chapter cluster/);
  assert.match(T_ROADMAP, /word_count_target/);
  assert.match(T_ROADMAP, /beats/);
  assert.match(T_ROADMAP, /chapter_contract/);
  // software guidance untouched
  assert.ok(T_ROADMAP.includes('- Flow downstream to `must_haves` in plan-phase'));
  assert.ok(T_ROADMAP.includes('- Format: "User can [action]" or "[Thing] works/exists"'));
});

test('W2-16: phase-prompt.md carries a chapter worked example with a machine-floor verify', () => {
  const example = /<!-- Non-code domain worked example \(v1\.13\)([\s\S]*?)<\/task>/.exec(T_PHASE_PROMPT);
  assert.ok(example, 'chapter worked example must exist');
  const body = example[0];
  assert.match(body, /Draft chapter ch-vault-heist against the chapter contract/);
  assert.match(body, /book\/chapters\/ch-vault-heist\.md/);
  assert.match(body, /book\/SPINE\.md, LORE\.md/);
  assert.match(body, /word count within 10 percent of word_count_target/i);
  assert.ok(!/\btsc\b/.test(body), 'chapter example verify must not shell out to tsc');
  assert.ok(!/npm (test|run)/.test(body), 'chapter example verify must not shell out to npm');
  // software task template untouched
  assert.ok(T_PHASE_PROMPT.includes('<verify>[Command or check to prove it worked]</verify>'));
  assert.ok(T_PHASE_PROMPT.includes('<name>Task 1: [Action-oriented name]</name>'));
});

test('W2-17: roadmapper truth test is domain-neutral (A9)', () => {
  assert.ok(!ROADMAPPER.includes('verifiable by a human using the application.'), 'software-only wording removed');
  assert.match(ROADMAPPER, /verifiable by a human using the deliverable: the running application for software, the draft chapters or the report for book and research domains/);
  // the software worked example stays
  assert.ok(ROADMAPPER.includes('- User can log out from any page'));
});

test('W2-18: new-project research prompts phrase per domain and the book path offers canon-init (A9)', () => {
  assert.match(NEW_PROJECT, /\*\*Domain phrasing \(v1\.13 Wave 2, A9\):\*\*/);
  assert.match(NEW_PROJECT, /Software projects keep the wording below byte-identical/);
  assert.match(NEW_PROJECT, /\*\*Book-domain close \(v1\.13 Wave 2, A9\):\*\*/);
  assert.match(NEW_PROJECT, /\/ferrox:canon-init: initialize LORE\.md, the declared canon store/);
  // software research prompts untouched
  assert.ok(NEW_PROJECT.includes("What's the standard 2025 stack for [domain]?"));
  assert.ok(NEW_PROJECT.includes("What do [domain] products have? What's table stakes vs differentiating?".replace('do [domain] products have', 'features do [domain] products have')));
});
