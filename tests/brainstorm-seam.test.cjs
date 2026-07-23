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

// ─── v1.13 Part 2 Wave 1: the team assembly station inside promote/seed ──────

const teamLib = require('../ferrox-core/bin/lib/team-manifest.cjs');

test('brainstorm.md: the team moment is inside routes 1 and 2 only; park stays untouched success', () => {
  assert.match(brainstorm, /run `<team_assembly>` BEFORE executing the route/);
  assert.match(brainstorm, /Park \(route 3\) never assembles a team/);
  assert.match(brainstorm, /Park closes without promoting anything, and that is\s+success, not failure/);
  assert.match(brainstorm, /never a 4th exit/);
});

test('brainstorm.md: TEAM.md is the only representation; the artifact skeletons carry no team block', () => {
  assert.match(brainstorm, /ONLY representation of the roster/);
  const step10 = brainstorm.split('## Step 10')[1].split('## Step 11')[0];
  assert.ok(!/team-manifest/.test(step10), 'no team-manifest fence in the artifact templates');
  assert.ok(!/## Team/.test(step10), 'no Team section in the artifact skeletons');
  assert.ok(!/TEAM\.md/.test(step10), 'Step 10 writes BRAINSTORM.md only');
});

test('brainstorm.md: the A11 receipt format and the A8 governed-mutation route are pinned', () => {
  assert.ok(brainstorm.includes('team-manifest/v1: K/K checks, N roles, M bound'), 'machine receipt format pinned');
  assert.match(brainstorm, /roster DIFF/);
  assert.match(brainstorm, /A silent rewrite is a workflow failure/);
});

test('the documented receipt command runs against the real lib and emits the pinned machine format', () => {
  // Build a blessed 2-role roster through the lib itself (1 inline seat,
  // 1 agent-bound seat), then run the workflow doc's own bash block against
  // it, so the doc's command and the lib can never drift apart silently.
  const manifest = {
    schema: 'team-manifest/v1',
    derived_from: { brainstorm: 'realtime-collab-2026-07-23', milestone: 'v1.13' },
    manifest_hash: '',
    roles: [
      {
        id: 'sync-engineer',
        charter: 'Own the CRDT sync engine end to end: data model, merge semantics, and offline queue.',
        rationale: 'The Decisions lock CRDT sync as the core of the build.',
        non_redundancy: 'Sole writer of the sync engine surface.',
        provenance: '(stance: guided, confirmed at exit)',
        binding: { inline: true },
        tier: 'standard',
        owns: ['src/sync/**'],
        reviews: [],
      },
      {
        id: 'reviewer',
        charter: 'Review every sync engine change for merge-semantics regressions before it lands.',
        rationale: 'Conflict handling is the highest-risk decision in the brief.',
        non_redundancy: 'Verification duty only; owns no write surface.',
        provenance: '(stance: guided, confirmed at exit)',
        binding: { agent: 'ferrox-code-reviewer' },
        owns: [],
        reviews: ['src/sync/**'],
      },
    ],
  };
  const teamMd = teamLib.serializeTeamManifest(manifest);
  const parsed = teamLib.parseTeamManifest(teamMd);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));

  // Extract the bash block that carries the validator invocation from the doc.
  const bashBlocks = brainstorm.split('```bash').slice(1).map((s) => s.split('```')[0]);
  const script = bashBlocks.find((b) => b.includes('team-manifest.cjs'));
  assert.ok(script, 'the workflow doc documents the validator invocation');

  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-receipt-'));
  const teamPath = path.join(tmp, 'TEAM.md');
  fs.writeFileSync(teamPath, teamMd);
  const patched = script.replace('".planning/TEAM.md"', JSON.stringify(teamPath));
  assert.notEqual(patched, script, 'the documented command reads .planning/TEAM.md');

  const res = spawnSync('bash', ['-c', patched], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, `receipt command must exit 0:\n${res.stdout}${res.stderr}`);
  const receipt = res.stdout.trim();
  assert.match(receipt, /^team-manifest\/v1: (\d+)\/\1 checks, 2 roles, 1 bound$/);
  assert.equal(
    Number(receipt.match(/^team-manifest\/v1: (\d+)\//)[1]),
    teamLib.PARSE_CODES.length,
    'the K/K denominator is the honest parse-evaluable set, never the full CODES map'
  );
  console.log(`seam receipt (team): ${receipt}`);
});

test('the receipt denominator is PARSE_CODES: mutation-only refusals never inflate K/K', () => {
  const bashBlocks = brainstorm.split('```bash').slice(1).map((s) => s.split('```')[0]);
  const script = bashBlocks.find((b) => b.includes('team-manifest.cjs'));
  assert.ok(script, 'the workflow doc documents the validator invocation');
  assert.match(script, /const checks = tm\.PARSE_CODES;/, 'the snippet takes the exported honest denominator');
  assert.ok(!script.includes('Object.keys(tm.CODES)'), 'the inflated all-E_-codes denominator is retired');
  for (const code of ['E_ROLE_EXISTS', 'E_ROLE_NOT_FOUND', 'E_ROLE_LIVE_IN_PLAN']) {
    assert.ok(!teamLib.PARSE_CODES.includes(code), `${code} is mutation-only and stays out of the denominator`);
  }
  const allParseEvaluable = Object.keys(teamLib.CODES).filter(
    (c) => c.startsWith('E_') && !['E_ROLE_EXISTS', 'E_ROLE_NOT_FOUND', 'E_ROLE_LIVE_IN_PLAN'].includes(c)
  );
  assert.deepEqual([...teamLib.PARSE_CODES], allParseEvaluable, 'PARSE_CODES is exactly the parse-evaluable E_ set');
});

test('the receipt command injects the catalog agent roster: a ghost-bound seat never counts as bound', () => {
  const bashBlocks = brainstorm.split('```bash').slice(1).map((s) => s.split('```')[0]);
  const script = bashBlocks.find((b) => b.includes('team-manifest.cjs'));
  assert.ok(script, 'the workflow doc documents the validator invocation');
  assert.match(script, /model-catalog\.cjs/, 'the snippet consults the model catalog for the agent roster');
  assert.match(script, /AGENT_DEFAULT_TIERS/, 'the roster is the catalog agent set');
  assert.match(script, /catch \{ agents = undefined; \}/, 'a missing catalog degrades to no roster check');

  const manifest = {
    schema: 'team-manifest/v1',
    derived_from: { brainstorm: 'realtime-collab-2026-07-23', milestone: 'v1.13' },
    manifest_hash: '',
    roles: [
      {
        id: 'builder',
        charter: 'Own the src surface end to end and hand off with receipts.',
        rationale: 'the brief calls for a builder seat',
        non_redundancy: 'sole writer of the src surface',
        provenance: '(stance: guided, confirmed at exit)',
        binding: { inline: true },
        tier: 'standard',
        owns: ['src/**'],
        reviews: [],
      },
      {
        id: 'phantom-eye',
        charter: 'Review every src change for regressions.',
        rationale: 'a second eye on the only write surface',
        non_redundancy: 'reviews, never writes',
        provenance: '(stance: guided, confirmed at exit)',
        binding: { agent: 'ghost-agent-nobody-ships' },
        owns: [],
        reviews: ['src/**'],
      },
    ],
  };
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-receipt-ghost-'));
  const teamPath = path.join(tmp, 'TEAM.md');
  fs.writeFileSync(teamPath, teamLib.serializeTeamManifest(manifest));
  const patched = script.replace('".planning/TEAM.md"', JSON.stringify(teamPath));
  const res = spawnSync('bash', ['-c', patched], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.equal(res.status, 0, `receipt command must exit 0:\n${res.stdout}${res.stderr}`);
  assert.match(
    res.stdout.trim(),
    /^team-manifest\/v1: (\d+)\/\1 checks, 2 roles, 0 bound$/,
    'the ghost-bound seat degrades to the inline rung in the bound count (W_UNKNOWN_AGENT is live)'
  );
});

test('the receipt command carries the shared FERROX_TOOLS shim and the TEAM_LIB fallback chain', () => {
  const bashBlocks = brainstorm.split('```bash').slice(1).map((s) => s.split('```')[0]);
  const script = bashBlocks.find((b) => b.includes('team-manifest.cjs'));
  assert.ok(script, 'the workflow doc documents the validator invocation');
  assert.match(script, /_FERROX_SHIM_NAME="ferrox-tools\.cjs"/, 'the standard shim resolves FERROX_TOOLS first');
  assert.match(script, /require\(process\.argv\[1\]\)/, 'the lib path arrives as argv, never a cwd-relative require');
  assert.ok(!script.includes('require("./ferrox-core'), 'no cwd-relative lib require survives (installed layouts)');
  for (const root of [
    '"${FERROX_TOOLS%/*}/lib/team-manifest.cjs"',
    '"$HOME/.claude/ferrox-core/bin/lib/team-manifest.cjs"',
    '"./.claude/ferrox-core/bin/lib/team-manifest.cjs"',
    '"./ferrox-core/bin/lib/team-manifest.cjs"',
  ]) {
    assert.ok(script.includes(root), `TEAM_LIB fallback chain tries ${root}`);
  }
  assert.match(script, /ERROR: team-manifest\.cjs not found; tried:/, 'a total miss errors loudly naming every tried path');
});

test('the receipt command runs from an installed layout (~/.claude style, no dev repo in reach)', () => {
  const bashBlocks = brainstorm.split('```bash').slice(1).map((s) => s.split('```')[0]);
  const script = bashBlocks.find((b) => b.includes('team-manifest.cjs'));
  assert.ok(script, 'the workflow doc documents the validator invocation');

  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'team-receipt-installed-'));
  const proj = path.join(scratch, 'proj');
  const fakeHome = path.join(scratch, 'home');
  const binDir = path.join(proj, '.claude', 'ferrox-core', 'bin');
  fs.mkdirSync(path.join(binDir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(binDir, 'vendor'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });

  // The installed tree: file copies, no node_modules, no dev repo above it.
  const devBin = path.join(ROOT, 'ferrox-core', 'bin');
  fs.copyFileSync(path.join(devBin, 'ferrox-tools.cjs'), path.join(binDir, 'ferrox-tools.cjs'));
  fs.copyFileSync(path.join(devBin, 'lib', 'team-manifest.cjs'), path.join(binDir, 'lib', 'team-manifest.cjs'));
  fs.copyFileSync(path.join(devBin, 'vendor', 'js-yaml-4.2.0.cjs'), path.join(binDir, 'vendor', 'js-yaml-4.2.0.cjs'));

  const manifest = {
    schema: 'team-manifest/v1',
    derived_from: { brainstorm: 'realtime-collab-2026-07-23', milestone: 'v1.13' },
    manifest_hash: '',
    roles: [
      {
        id: 'solo-builder',
        charter: 'Own the whole surface end to end and hand off with receipts.',
        rationale: 'A 1-seat roster is the floor and the installed smoke needs only 1.',
        non_redundancy: 'Sole seat.',
        provenance: '(stance: guided, confirmed at exit)',
        binding: { inline: true },
        tier: 'standard',
        owns: ['src/**'],
        reviews: [],
      },
    ],
  };
  fs.writeFileSync(path.join(proj, '.planning', 'TEAM.md'), teamLib.serializeTeamManifest(manifest));

  // HOME points at an empty scratch home, cwd is not a git repo: the shim must
  // land on the project-local .claude tree and TEAM_LIB must follow it there.
  const res = spawnSync('bash', ['-c', script], {
    cwd: proj,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HOME: fakeHome, CLAUDE_CONFIG_DIR: '', CLAUDE_ENV_FILE: '' },
  });
  assert.equal(res.status, 0, `installed-layout receipt must exit 0:\n${res.stdout}${res.stderr}`);
  assert.match(res.stdout.trim(), /^team-manifest\/v1: (\d+)\/\1 checks, 1 roles, 0 bound$/m);
  console.log(`seam receipt (installed layout): ${res.stdout.trim().split('\n').pop()}`);
});

test('the receipt command fails closed on an invalid manifest and still emits the machine line', () => {
  const bashBlocks = brainstorm.split('```bash').slice(1).map((s) => s.split('```')[0]);
  const script = bashBlocks.find((b) => b.includes('team-manifest.cjs'));
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'team-receipt-bad-'));
  const teamPath = path.join(tmp, 'TEAM.md');
  fs.writeFileSync(teamPath, '# TEAM\n\nno fenced team block here\n');
  const patched = script.replace('".planning/TEAM.md"', JSON.stringify(teamPath));
  const res = spawnSync('bash', ['-c', patched], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(res.status, 0, 'INVALID must exit nonzero');
  assert.match(res.stdout, /^team-manifest\/v1: \d+\/\d+ checks, 0 roles, 0 bound/m);
  assert.match(res.stdout, /FAIL E_TEAM_BLOCK_MISSING/);
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
