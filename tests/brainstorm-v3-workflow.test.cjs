'use strict';

/**
 * MILESTONE v1.12 Wave 1: brainstorm v3 workflow doc + touchpoints + fixtures.
 *
 * Scope discipline: conversation QUALITY is gate-hostile and never scored.
 * This file asserts only what is mechanically assertable about the WORKFLOW
 * DOC and its touchpoints: required blocks present, locked wording landed,
 * routing updated, descriptions updated, editorial floor held, dead command
 * names absent, and the documentation fixtures existing with the right shape.
 * The fixture transcripts themselves are review artifacts, not scored runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, 'ferrox-core', 'workflows', 'brainstorm.md');
const DO_MD = path.join(ROOT, 'ferrox-core', 'workflows', 'do.md');
const COMMAND = path.join(ROOT, 'commands', 'ferrox', 'brainstorm.md');
const SKILL = path.join(ROOT, 'skills', 'ferrox-brainstorm', 'SKILL.md');
const HELP_DEFAULT = path.join(ROOT, 'ferrox-core', 'workflows', 'help', 'modes', 'default.md');
const HELP_FULL = path.join(ROOT, 'ferrox-core', 'workflows', 'help', 'modes', 'full.md');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'brainstorm-v3');
const GATE = path.join(ROOT, 'gates', 'skill-instruction-files', 'gate.cjs');

const read = (f) => fs.readFileSync(f, 'utf8');
const doc = read(WORKFLOW);

// ─── The workflow doc: required blocks and locked wording ────────────────────

test('stance router block: silent selection, 3 stances, never announced', () => {
  assert.match(doc, /<stance_router>/, 'stance router block present');
  assert.match(doc, /SILENT read of the opening move plus domain signals/);
  assert.match(doc, /Never announce the stance/);
  for (const stance of ['Guided', 'Generative', 'Sounding board']) {
    assert.ok(doc.includes(stance), `router table names the ${stance} stance`);
  }
});

test('stance router: 2-message rule for ambiguous openings', () => {
  assert.match(doc, /2-message rule/);
  assert.match(doc, /1 grounding reflection[\s\S]{0,80}1 open question/);
  assert.match(doc, /second user message resolves the route/);
});

test('stance router: overrides are plain language, examples are illustrations not an enum', () => {
  assert.match(doc, /Overrides are ANY plain-language steering/);
  assert.match(doc, /no privileged\s+vocabulary and no enum/);
  assert.match(doc, /illustrations, not a list/);
});

test('stance router: drift is monotone (diverge toward converge) and user-triggered', () => {
  assert.match(doc, /Drift is monotone and user-triggered/);
  assert.match(doc, /diverge toward converge/);
  assert.match(doc, /only in response to a convergent user move/);
  assert.match(doc, /reverse moves happen only on explicit user steering/i);
});

test('domain step: config read, classify once, config-set, vocabulary discipline', () => {
  assert.match(doc, /<domain_step>/);
  assert.match(doc, /ferrox-tools config-get domain --raw/);
  assert.match(doc, /ferrox-tools config-set domain <value>/);
  assert.match(doc, /stored verbatim/);
  assert.match(doc, /selectGate\(\)/);
  assert.match(doc, /Domain vocabulary discipline/);
  assert.match(doc, /no tests, deploys, builds, CI, refactors/);
});

test('generative mode: 1 intake batch, no drip, pre-checked options, widen, pool-kill escape, GO', () => {
  assert.match(doc, /<generative_mode>/);
  assert.match(doc, /1 intake batch, then silence/);
  assert.match(doc, /5 to 6 easy questions/);
  assert.match(doc, /not sure is fine/);
  assert.match(doc, /no drip, no follow-up interrogation/);
  assert.match(doc, /4 to 6 concrete named options/);
  assert.match(doc, /why it fits\s+you/);
  assert.match(doc, /feasibility line/);
  assert.match(doc, /"widen" is a first-class\s+move/);
  assert.match(doc, /disclose the class of options you previously\s+discarded and why/);
  assert.match(doc, /kills more\s+than half the candidate pool, surface the constraint/);
  assert.match(doc, /Banned\s+output: a list of options with no eventual decision/);
  assert.match(doc, /runner-up held in reserve/);
});

test('sounding board: collaborator block, fact-vs-judgment gate, capture tax, anchors, readiness', () => {
  assert.match(doc, /<sounding_board_mode>/);
  assert.match(doc, /creative collaborator, not a questionnaire/);
  assert.match(doc, /Do NOT use AskUserQuestion unless the user asks for a specific decision/);
  assert.match(doc, /Do NOT structure replies as numbered option lists/);
  assert.match(doc, /Do NOT announce the mode, ever/);
  assert.match(doc, /Fact-vs-judgment gate/);
  assert.match(doc, /Content-triggered capture with the capture tax/);
  assert.match(doc, /3 or more new substantive points/);
  assert.match(
    doc,
    /every capture carries exactly 1 concrete pushback with a named\s+stake/,
    'the capture tax sentence is load-bearing and locked'
  );
  assert.match(doc, /scales with idea density, never\s+with turn count/);
  assert.match(doc, /VERBATIM anchor/);
  assert.match(doc, /Silent brief-completeness tracking/);
  assert.match(doc, /Readiness check \(soft exit\)/);
});

test('house rules: the Wave 0.5 fact carve-out wording landed', () => {
  assert.match(doc, /Fact questions are the single carve-out/);
  assert.match(doc, /the answer exists only in the\s+user's head/);
  assert.match(doc, /nothing to verify and no pick to fake; ask plainly/);
  assert.match(doc, /could\s+more verification produce this answer without the user\?/);
  assert.match(doc, /discharged by recommending on craft consequences/);
  assert.match(doc, /never by claiming the user's decision/);
});

test('exit gates: stance-keyed, promotion rule, park first-class', () => {
  assert.match(doc, /<exit_gates>/);
  assert.match(doc, /GO gate \(guided and generative\)/);
  assert.match(doc, /Recap-confirm \(sounding board\)/);
  assert.match(doc, /"sounds decided"/);
  assert.match(doc, /"still open"/);
  assert.match(doc, /blesses or corrects the\s+split in 1 move/);
  assert.match(doc, /Decisions section may only contain\s+exit-confirmed items/);
  assert.match(doc, /provenance \(stance \+ confirmed at exit\)/);
  assert.match(doc, /first-class successful\s+exit/);
  assert.match(doc, /OFF LIMITS means never re-ask\s+unprompted, not immutable/);
});

test('artifact template: frontmatter gains template and status fields', () => {
  assert.match(doc, /template: \{software\|book\|campaign\}/);
  assert.match(doc, /status: \{captured\|parked\}/);
});

test('session record: append-only SESSION-NOTES.md with stable checkpoint ids', () => {
  assert.match(doc, /<session_record>/);
  assert.match(doc, /SESSION-NOTES\.md/);
  assert.match(doc, /APPEND-ONLY/);
  assert.match(doc, /ck-001/);
  assert.match(doc, /in-progress \| parked \| captured/);
  assert.match(doc, /offer to resume/);
  assert.match(doc, /never rewrite prior\s+checkpoints/);
});

test('TEXT_MODE adapter paragraph and research degradation line present', () => {
  assert.match(doc, /<text_mode>/);
  assert.match(doc, /replace every `AskUserQuestion`\s+call with a plain-text numbered list/);
  assert.match(doc, /non-Claude runtimes \(OpenAI Codex, Gemini CLI/);
  assert.match(doc, /run the research inline and\s+visibly/);
});

test('per-stance matrix: research and companion timing keyed to stance', () => {
  assert.match(doc, /NEVER auto-fired\s+mid-riff, not even under `--research`/);
  assert.match(doc, /research the topic BEFORE the first reply, visibly/);
  assert.match(doc, /DEFER this\s+offer to the first genuinely visual moment/);
  assert.match(doc, /Generative option tables MAY render in the companion/);
});

test('boundary sentence: explore vs brainstorm', () => {
  assert.match(doc, /codebase-grounded Socratic ideation/);
  assert.match(doc, /topic\s+ideation with stances/);
});

test('kept from v2: credits, hard gate, DESIGN.md binding, structural check, 3 exits', () => {
  assert.match(doc, /Superpowers brainstorming by Obra \(MIT\)/);
  assert.match(doc, /ijfw \(internal port\)/, 'internal-port credit line for the ijfw blocks');
  assert.match(doc, /<hard_gate>/);
  assert.match(doc, /DESIGN\.md exists at project root, it is binding/);
  assert.match(doc, /gates\/brainstorm-artifact\/gate\.cjs/);
  assert.match(doc, /exactly 3 exits/);
  assert.match(doc, /<discipline_invariants>/);
});

test('guided mode keeps ambiguity scoring and degree-vs-kind scoring', () => {
  assert.match(doc, /Ambiguity scoring before interrogation/);
  assert.match(doc, /blast radius/);
  assert.match(doc, /Degree-vs-kind scoring on option cards/);
  assert.match(doc, /false precision/);
});

// ─── v1.13 Part 2 Wave 1: the team moment inside the promote/seed exits ─────

test('team assembly: block present, fires only on promote/seed after Step 12, never on park or decline', () => {
  assert.match(doc, /<team_assembly>/);
  assert.match(doc, /route 1\s+\(promote\) or route 2 \(seed\), AFTER the Step 12 artifact approval gate/);
  assert.match(doc, /Park \(route 3\) never assembles a team/);
  assert.match(doc, /neither does declining\s+all 3 routes/);
});

test('step 13 keeps exactly 3 exits and runs the team moment inside routes 1 and 2, never as a 4th exit', () => {
  assert.match(doc, /## Step 13: Route the result \(exactly 3 exits\)/);
  const step13 = doc.split('## Step 13')[1].split('</process>')[0];
  assert.match(step13, /run `<team_assembly>` BEFORE executing the route/);
  assert.match(step13, /Park assembles no team/);
  assert.match(step13, /never a 4th exit/);
});

test('A1 blessing gate: full charter verbatim with owns/reviews globs, never a rationale summary', () => {
  assert.match(doc, /FULL charter VERBATIM/);
  assert.match(doc, /including its `owns` and `reviews` globs/);
  assert.match(doc, /never a rationale summary/);
  assert.match(doc, /what the user blesses is what dispatch runs/);
  assert.match(doc, /Blessed roles carry exit provenance/);
  assert.match(doc, /Unblessed or edited-out roles\s+become Notes in the artifact, never manifest rows/);
});

test('register-aware presentation: hiring feel for guided/generative, recap prose for sounding board', () => {
  assert.match(doc, /hired, not configured/);
  assert.match(doc, /every specialist earns their seat/);
  assert.match(doc, /swap qa for a performance engineer/);
  assert.match(doc, /recap prose register/);
  assert.match(doc, /1 blessing move/);
  assert.match(doc, /NO option-list wizard/);
});

test('solo outcome is first-class, floor of 1, non-redundancy collapse', () => {
  assert.match(doc, /no second seat survives the non-redundancy test/);
  assert.match(doc, /floor of 1/);
  assert.match(doc, /never an anticlimax/);
  assert.match(doc, /collapses into another seat/);
});

test('derivation reads the work; templates are priors; binding ladder carries tiers not model ids', () => {
  assert.match(doc, /Derive from the WORK/);
  assert.match(doc, /PRIORS only, never fences/);
  assert.match(doc, /composes across domains/);
  assert.match(doc, /binds by reference/);
  assert.match(doc, /Tiers, never model ids, on both rungs/);
  assert.match(doc, /`non_redundancy` line naming its distinct write-surface, expertise,\s+or verification duty/);
});

test('A8: an existing roster gets a diff through the governed mutation ops, never a silent rewrite', () => {
  assert.match(doc, /roster DIFF/);
  assert.match(doc, /`addTeamRole`,\s+`removeTeamRole`, `swapTeamRole`/);
  assert.match(doc, /A silent rewrite is a workflow failure/);
});

test('A11: the machine receipt format is pinned and the validator command targets the real lib', () => {
  assert.match(doc, /team-manifest\/v1: K\/K checks, N roles, M bound/);
  assert.match(doc, /ferrox-core\/bin\/lib\/team-manifest\.cjs/);
  assert.match(doc, /a bare prose "team\s+assembled" line is a workflow failure/);
  assert.match(doc, /the station never leaves an\s+invalid manifest behind/);
});

test('TEAM.md only after blessing, the only representation, committed as its own commit', () => {
  assert.match(doc, /Materialize ONLY after blessing/);
  assert.match(doc, /ONLY representation of the roster/);
  assert.match(doc, /no\s+team block rides `BRAINSTORM\.md`/);
  assert.match(doc, /Commit TEAM\.md as its OWN commit/);
  assert.match(doc, /`derived_from`/);
  assert.match(doc, /`manifest_hash`/);
});

test('team assembly credits ijfw-team', () => {
  const block = doc.split('\n<team_assembly>\n')[1].split('\n</team_assembly>')[0];
  assert.match(block, /ijfw-team, internal port, with credit/);
});

// ─── Dogfood: the doc passes its own gate ────────────────────────────────────

test('the rewritten workflow doc scores 6/6 on the skill-instruction-files gate', () => {
  const res = spawnSync(process.execPath, [GATE, '--workspace', ROOT, WORKFLOW], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(res.status, 0, `gate must exit 0:\n${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /gate: 6\/6/);
});

// ─── Touchpoints ─────────────────────────────────────────────────────────────

test('do.md routes brainstorming intent to /ferrox:brainstorm with the explore boundary respected', () => {
  const doMd = read(DO_MD);
  assert.match(doMd, /Brainstorming a topic[^|]*\| `\/ferrox:brainstorm` \|/);
  assert.match(doMd, /against the existing codebase \| `\/ferrox:explore` \|/);
  assert.ok(
    !/brainstorming[^|]*\| `\/ferrox:discuss-phase`/i.test(doMd),
    'discuss-phase no longer owns the brainstorming intent'
  );
});

test('command and generated skill descriptions name the 3 stances', () => {
  for (const file of [COMMAND, SKILL]) {
    const text = read(file);
    assert.match(text, /description: .*3 silent stances/, `${path.basename(file)} description updated`);
    assert.match(text, /sounding board/i, `${path.basename(file)} names the sounding board`);
    assert.ok(
      !/description: .*recommendation-first questions/.test(text),
      `${path.basename(file)} description no longer leads with recommendation-first questions`
    );
  }
});

test('help modes describe the v3 stance model', () => {
  assert.match(read(HELP_DEFAULT), /\/ferrox:brainstorm[^|]*\| Topic brainstorm in 3 silent stances/);
  const full = read(HELP_FULL);
  assert.match(full, /\/ferrox:brainstorm[^`]*`.*: Topic brainstorm in 1 of 3 stances/);
  assert.match(full, /stance-keyed/);
});

// ─── Editorial floor and dead names on every new or rewritten surface ────────

const NEW_PROSE_FILES = () => [
  WORKFLOW,
  COMMAND,
  SKILL,
  path.join(FIXTURE_DIR, 'guided-opening.md'),
  path.join(FIXTURE_DIR, 'generative-opening.md'),
  path.join(FIXTURE_DIR, 'sounding-board-opening.md'),
  path.join(FIXTURE_DIR, 'mid-session-drift.md'),
  path.join(FIXTURE_DIR, 'sycophancy-challenge.md'),
  path.join(FIXTURE_DIR, 'domain-vocabulary-book.md'),
  __filename,
];

test('no em or en dashes in the new prose surfaces', () => {
  for (const file of NEW_PROSE_FILES()) {
    const text = read(file);
    assert.ok(!text.includes('\u2014'), `em dash in ${path.relative(ROOT, file)}`);
    assert.ok(!text.includes('\u2013'), `en dash in ${path.relative(ROOT, file)}`);
  }
});

test('the 5 dead command names do not reappear on any touched surface', () => {
  const dead = ['add-phase', 'edit-phase', 'remove-phase', 'add-todo', 'add-backlog'];
  const surfaces = [...NEW_PROSE_FILES(), DO_MD, HELP_DEFAULT, HELP_FULL];
  for (const file of surfaces) {
    const text = read(file);
    for (const name of dead) {
      assert.ok(
        !text.includes(`/ferrox-${name}`) && !text.includes(`/ferrox:${name}`),
        `dead command /ferrox-${name} referenced in ${path.relative(ROOT, file)}`
      );
    }
  }
});

test('workflow doc references no dead workflow or gate files', () => {
  // Every backticked repo-relative path without placeholders must exist.
  const spanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = spanRe.exec(doc)) !== null) {
    const token = m[1].trim();
    if (token.includes('{') || token.includes('*') || token.includes(' ')) continue;
    if (!/^[\w.@-]+(?:\/[\w.@-]+)+$/.test(token)) continue;
    if (!/\.[A-Za-z0-9]+$/.test(token)) continue;
    if (token.startsWith('.planning/brainstorms/')) continue; // session-created at runtime
    assert.ok(fs.existsSync(path.join(ROOT, token)), `dead reference in workflow doc: ${token}`);
  }
});

// ─── Golden fixtures: existence and shape (never conversation quality) ───────

const FIXTURES = [
  'guided-opening.md',
  'generative-opening.md',
  'sounding-board-opening.md',
  'mid-session-drift.md',
  'sycophancy-challenge.md',
  'domain-vocabulary-book.md',
];

test('all 6 documentation fixtures exist with Transcript and Expected shape sections', () => {
  for (const name of FIXTURES) {
    const file = path.join(FIXTURE_DIR, name);
    assert.ok(fs.existsSync(file), `missing fixture ${name}`);
    const text = read(file);
    assert.match(text, /## Transcript/, `${name} has a Transcript section`);
    assert.match(text, /## Expected shape/, `${name} has an Expected shape section`);
    assert.match(text, /User:/, `${name} carries at least 1 user turn`);
    assert.match(text, /Agent:/, `${name} carries at least 1 agent turn`);
  }
});

test('sycophancy fixture: the expected shape demands a named-stake challenge', () => {
  const text = read(path.join(FIXTURE_DIR, 'sycophancy-challenge.md'));
  assert.match(text, /named stake/);
  assert.match(text, /capture tax/);
  assert.match(text, /Failure shape/, 'the mutant (agreement with no stake) is documented');
});

test('domain-vocabulary fixture: agent lines carry no software vocabulary', () => {
  const text = read(path.join(FIXTURE_DIR, 'domain-vocabulary-book.md'));
  const transcript = text.split('## Expected shape')[0];
  const agentLines = [];
  let inAgent = false;
  for (const line of transcript.split('\n')) {
    if (/^Agent:/.test(line)) inAgent = true;
    else if (/^User:/.test(line) || /^##/.test(line)) inAgent = false;
    if (inAgent) agentLines.push(line);
  }
  const agentText = agentLines.join('\n');
  assert.ok(agentText.length > 50, 'agent side extracted');
  const banned = /\b(tests?|deploys?|deployment|CI|pipelines?|refactors?|units?|coverage|sprints?|backlog|codebase|repo)\b/i;
  const hit = agentText.match(banned);
  assert.equal(hit, null, `software vocabulary on the agent side of a book session: ${hit && hit[0]}`);
});
