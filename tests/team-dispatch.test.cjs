'use strict';

/**
 * MILESTONE v1.13 Part 2 Wave 3: dispatch + trust.
 *
 * Two halves, the team-seam pattern. (1) Mechanical assertions on the WORKFLOW
 * + AGENT DOCS: execute-phase carries the step 2.6 role-stamp dispatch
 * preflight (A2 re-validation against the LIVE TEAM.md, stale stamp = STOP
 * with the named re-stamp or re-bless fix mirroring plan-checker T3), the A8
 * loud roleless degrade receipt and the A10 tier ladder miss receipt in their
 * exact pinned formats, the ROLE_ASSIGNED conditional injection block (the
 * chapter_contract precedent generalized, always dispatched on
 * ferrox-executor, never a subagent_type swap), the A13 FAST-05 swap of the
 * inline tier mapping to the model.resolve-tier verb, and the documented
 * TEAM.md mutation stale-stamp sweep; the verifier carries the role-charter
 * echo check; the executor carries the echo-not-author SUMMARY discipline.
 * (2) Countable receipts: the 2 documented node scripts are EXTRACTED from
 * execute-phase.md verbatim and executed against fixtures through the real
 * parser lib, proving the preflight verdicts (role, stale-stamp,
 * charter-drift, degrade) and the sweep's stale-stamp detection actually run
 * as written.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(f, 'utf8');

const executePhase = read(path.join(ROOT, 'ferrox-core', 'workflows', 'execute-phase.md'));
const verifier = read(path.join(ROOT, 'agents', 'ferrox-verifier.md'));
const executor = read(path.join(ROOT, 'agents', 'ferrox-executor.md'));

const TEAM_LIB = path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'team-manifest.cjs');
const {
  parseTeamManifest,
  computeTeamManifestHash,
  serializeTeamManifest,
} = require(TEAM_LIB);

// The pinned receipt formats (A8 + A10). Byte-exact contract strings.
const DEGRADE_RECEIPT = "ROLE DEGRADE: role '<id>' absent from live TEAM.md; dispatched roleless";
const LADDER_MISS_RECEIPT =
  "TIER LADDER MISS: role '<id>' tier '<tier>' not in model.tier_models; dispatched on the default executor model";

// The step 2.6 section of execute-phase.md.
const preflight = executePhase.includes('2.6. **Role-stamp dispatch preflight')
  ? executePhase.split('2.6. **Role-stamp dispatch preflight')[1].split('3. **Spawn executor agents:**')[0]
  : '';

// ─── execute-phase: the step 2.6 preflight (A2 + A8 + A10) ───────────────────

test('execute-phase: the role-stamp dispatch preflight step exists between worktree gate and spawn', () => {
  assert.notEqual(preflight, '', 'step 2.6 role-stamp dispatch preflight is present');
  assert.match(preflight, /ROLE_ASSIGNED=false/, 'absent stamp keys mean a roleless dispatch');
  assert.match(preflight, /zero behavior change \(A9\)/, 'A9 is an explicit acceptance criterion');
});

test('execute-phase: A2 re-validation runs against the LIVE TEAM.md through the parser lib', () => {
  assert.match(preflight, /A2 dispatch re-validation/);
  assert.match(preflight, /LIVE `\.planning\/TEAM\.md` at\s+dispatch time/);
  for (const fn of ['parseTeamManifest', 'verifyTeamManifestHash', 'computeTeamManifestHash']) {
    assert.ok(preflight.includes(fn), `preflight names the ${fn} export`);
  }
  assert.match(preflight, /lib\/team-manifest\.cjs/, 'the deterministic contract is named');
});

test('execute-phase: a stale stamp STOPS dispatch with the named fix, mirroring plan-checker T3', () => {
  assert.match(preflight, /`stop` with `stale-stamp`:\*\* STOP\. Do NOT dispatch/);
  assert.match(preflight, /mirrors\s+plan-checker Check T3 exactly/);
  assert.match(preflight, /\*\*re-stamp\*\*/);
  assert.match(preflight, /\*\*re-bless\*\*/);
  assert.match(preflight, /never silently strip the stamp/);
});

test('execute-phase: a drifted charter stamp STOPS dispatch with the named fix, mirroring plan-checker T2', () => {
  assert.match(preflight, /`stop` with `charter-drift`:\*\* STOP\. Do NOT dispatch/);
  assert.match(preflight, /no longer byte-identical to the live TEAM\.md charter/);
  assert.match(preflight, /mirrors plan-checker Check T2 exactly/);
  assert.match(preflight, /never patch the stamp inline to force a\s+dispatch/);
  assert.match(preflight, /seat\.charter !== stampedCharter/, 'the snippet byte-compares the plan charter stamp');
  assert.match(preflight, /"\$STAMPED_CHARTER"/, 'the plan role_charter is the 4th snippet input');
});

test('execute-phase: the A8 roleless degrade receipt is pinned byte for byte and recorded loudly', () => {
  assert.ok(preflight.includes(DEGRADE_RECEIPT), 'the exact degrade receipt line is pinned');
  assert.match(preflight, /dispatch ROLELESS, loudly/);
  assert.match(preflight, /wave log AND record it in\s+the step 6 wave report/);
  assert.match(preflight, /A silent degrade is forbidden/);
});

test('execute-phase: the A10 tier ladder miss surfaces the NOT IN LADDER notice, never silently null', () => {
  assert.ok(preflight.includes(LADDER_MISS_RECEIPT), 'the exact ladder miss receipt line is pinned');
  assert.match(preflight, /`NOT IN LADDER`\s+notice: SURFACE the notice verbatim/);
  assert.match(preflight, /Never a silently null model id/);
  assert.match(preflight, /model\.resolve-tier --tier "<tier>"/, 'role tiers resolve through the FF-B26 verb');
});

test('execute-phase: dispatch is ALWAYS ferrox-executor; the binding never swaps subagent_type (A7)', () => {
  assert.match(preflight, /\*\*Dispatch is ALWAYS ferrox-executor \(A7\)\.\*\*/);
  assert.match(preflight, /NEVER a `subagent_type` swap/);
  assert.match(preflight, /BOTH dispatch `subagent_type="ferrox-executor"`/);
  assert.match(preflight, /blessed TEAM\.md charter text on both rungs/);
});

test('execute-phase: agent-bound roles without a tier take the catalog default; FORCE_FRONTIER still wins', () => {
  assert.match(preflight, /NO explicit `tier`: the model resolves via\s+the catalog default/);
  assert.match(preflight, /`FORCE_FRONTIER` still wins over any role tier/);
  assert.match(preflight, /a boundary plan can never be routed\s+down by a role/);
});

// ─── execute-phase: the ROLE_ASSIGNED injection block (A7) ───────────────────

test('execute-phase: the dispatch prompt carries the ROLE_ASSIGNED conditional role_charter block', () => {
  assert.match(executePhase, /\$\{ROLE_ASSIGNED \? `/, 'the injection is conditional on ROLE_ASSIGNED');
  assert.match(executePhase, /<role_assignment>[\s\S]*<\/role_assignment>/);
  assert.match(executePhase, /<role_charter>\s*role_id: \{role_id\}\s*\{role_charter\}\s*<\/role_charter>/);
});

test('execute-phase: the injected charter is trusted, planner-stamped, and echo-not-author', () => {
  const block = executePhase.split('${ROLE_ASSIGNED ? `')[1].split('</role_assignment>')[0];
  assert.match(block, /PLANNER-STAMPED and TRUSTED/);
  assert.match(block, /VERBATIM from the plan's role_charter frontmatter stamp/);
  assert.match(block, /ECHO it, never author it/);
  assert.match(block, /do not restate, extend, trim, or\s+reinterpret the charter/);
  assert.match(block, /SUMMARY\.md\s+frontmatter must echo role_id and\s+role_charter byte for byte/);
});

// ─── execute-phase: the A13 FAST-05 verb swap ────────────────────────────────

test('execute-phase: FAST-05 resolves EXECUTOR_TIER through model.resolve-tier; the inline mapping is gone', () => {
  assert.match(executePhase, /model\.resolve-tier --tier "\$EXECUTOR_TIER"/);
  assert.match(executePhase, /FF-B26 is CLOSED \(v1\.13 P2 W3, A13\)/);
  assert.ok(!executePhase.includes('Known wiring gap (FF-B26)'), 'the wiring-gap caveat is retired');
  assert.ok(
    !executePhase.includes("through the operator's `tier_models` block directly"),
    'the inline tier_models mapping instruction is retired'
  );
  const fast05 = executePhase.split('FF-B26 is CLOSED')[1].split('Universal gate-first router')[0];
  assert.match(fast05, /SURFACE the notice verbatim/, 'the FAST-05 seam also surfaces the A10 notice');
  assert.match(fast05, /Never pass a null\/empty model\s*#?\s*id silently/);
});

// ─── execute-phase: the documented mutation stale-stamp sweep ────────────────

test('execute-phase: the TEAM.md mutation stale-stamp sweep is documented as a deterministic procedure', () => {
  assert.match(preflight, /\*\*TEAM\.md mutation stale-stamp sweep \(A2\/A8\)\.\*\*/);
  assert.match(preflight, /\.planning\/phases\/\*\/\*-PLAN\.md/);
  assert.match(preflight, /NAMED for re-stamp/);
  assert.match(preflight, /STALE STAMP: /);
  assert.match(preflight, /the sweep never edits a plan itself/);
});

test('the preflight and plan-checker parse sites inject the catalog agent roster defensively (A10)', () => {
  const planChecker = read(path.join(ROOT, 'agents', 'ferrox-plan-checker.md'));
  for (const [name, doc] of [
    ['execute-phase 2.6 preflight', preflight],
    ['plan-checker 7d snippet', planChecker],
  ]) {
    assert.match(doc, /model-catalog\.cjs/, `${name} consults the model catalog for the agent roster`);
    assert.match(doc, /AGENT_DEFAULT_TIERS/, `${name} takes the catalog agent set as the roster`);
    assert.match(doc, /catch \{ agents = undefined; \}/, `${name} degrades to no roster check on a missing catalog`);
    assert.match(doc, /agents === undefined \? undefined : \{ agents \}/, `${name} passes the roster into parseTeamManifest`);
  }
});

// ─── TEAM_LIB resolution: 1 shared idiom, byte-identical at every site ───────

test('the TEAM_LIB fallback idiom is byte-identical across all 4 documented sites', () => {
  const brainstorm = read(path.join(ROOT, 'ferrox-core', 'workflows', 'brainstorm.md'));
  const planChecker = read(path.join(ROOT, 'agents', 'ferrox-plan-checker.md'));

  // Every site carries exactly the same 2 lines (modulo code-fence indent):
  // the 4-candidate for-loop and the loud all-paths error.
  const pattern = /^\s*(TEAM_LIB=""; for _tl in [^\n]+)\n\s*(if \[ -z "\$TEAM_LIB" \][^\n]+)$/gm;
  const sites = [];
  for (const [name, doc, expected] of [
    ['execute-phase.md', executePhase, 2],
    ['brainstorm.md', brainstorm, 1],
    ['ferrox-plan-checker.md', planChecker, 1],
  ]) {
    const hits = [...doc.matchAll(pattern)];
    assert.equal(hits.length, expected, `${name} carries ${expected} TEAM_LIB resolution block(s)`);
    for (const hit of hits) sites.push([name, `${hit[1]}\n${hit[2]}`]);
  }
  assert.equal(sites.length, 4, '4 sites total');
  const canonical = sites[0][1];
  for (const [name, block] of sites) {
    assert.equal(block, canonical, `TEAM_LIB idiom drifted in ${name}`);
  }
  for (const root of [
    '"${FERROX_TOOLS%/*}/lib/team-manifest.cjs"',
    '"$HOME/.claude/ferrox-core/bin/lib/team-manifest.cjs"',
    '"./.claude/ferrox-core/bin/lib/team-manifest.cjs"',
    '"./ferrox-core/bin/lib/team-manifest.cjs"',
  ]) {
    assert.ok(canonical.includes(root), `the idiom tries ${root}`);
  }
  assert.match(canonical, /ERROR: team-manifest\.cjs not found; tried:/, 'a total miss errors loudly naming every tried path');
  assert.ok(
    !executePhase.includes('TEAM_LIB="${FERROX_TOOLS%/*}/lib/team-manifest.cjs"\n'),
    'the PATH-fragile 1-line assignment is retired (a global bin shim has no ../lib)'
  );
});

// ─── verifier + executor: the echo trust split ───────────────────────────────

test('verifier: the role-charter echo check mirrors the chapter_contract echo discipline', () => {
  assert.match(verifier, /\*\*Role-charter echo check \(v1\.13 Part 2 Wave 3\):\*\*/);
  const rule = verifier.split('**Role-charter echo check (v1.13 Part 2 Wave 3):**')[1].split('\n\n')[0];
  assert.match(rule, /SUMMARY\.md frontmatter must ECHO the stamp/);
  assert.match(rule, /EXACTLY, byte for byte/);
  assert.match(rule, /the planner stamps, the executor echoes, never authors/);
  assert.match(rule, /FAIL, named as a role-charter echo mismatch/);
  assert.ok(rule.includes(DEGRADE_RECEIPT), 'the degrade receipt exception carries the exact pinned line');
  assert.match(rule, /Roleless plans \(no stamp keys\) are untouched/);
});

test('executor: the SUMMARY discipline carries the echo-not-author line for role_charter', () => {
  assert.match(executor, /\*\*Team-staffed plans \(v1\.13 P2 W3\):\*\*/);
  assert.match(executor, /ECHO `role_id` and `role_charter` byte for byte from the plan stamp/);
  assert.match(executor, /You echo the role_charter, never author it/);
  assert.match(executor, /role_id \/ role_charter \/ team_manifest_hash when present/, 'load_plan parses the stamp keys');
});

// ─── Fixture receipts: the documented scripts actually run as written ────────

const PROVENANCE = '(stance: guided, confirmed at exit)';

function role(id, extra = {}) {
  return {
    id,
    charter: `Own the ${id} surface end to end and hand off with receipts.`,
    rationale: `the brief calls for a dedicated ${id} seat`,
    non_redundancy: `sole writer of the ${id} surface`,
    provenance: PROVENANCE,
    binding: { inline: true },
    tier: 'standard',
    owns: [`src/${id}/**`],
    reviews: [],
    ...extra,
  };
}

function teamMd(roles) {
  return serializeTeamManifest({
    schema: 'team-manifest/v1',
    derived_from: { brainstorm: 'demo-topic-2026-07-23', milestone: 'v1.13' },
    manifest_hash: '',
    roles,
  });
}

/** Extract the body of a documented `node -e '...'` block following a marker. */
function extractNodeScript(doc, marker) {
  const from = doc.indexOf(marker);
  assert.ok(from !== -1, `marker present: ${marker}`);
  const open = doc.indexOf("node -e '", from);
  assert.ok(open !== -1, 'node -e block follows the marker');
  const start = open + "node -e '".length;
  const close = doc.indexOf("' \"$TEAM_LIB\"", start);
  assert.ok(close !== -1, 'the block closes with the TEAM_LIB argument');
  return doc.slice(start, close);
}

function runScript(body, cwd, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['-e', body, ...args], { cwd, encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

test('receipt: the documented preflight script returns role / stale-stamp / charter-drift / degrade verdicts', () => {
  const body = extractNodeScript(preflight, 'A2 dispatch re-validation');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-team-dispatch-'));
  fs.mkdirSync(path.join(tmp, '.planning'), { recursive: true });
  const md = teamMd([role('builder')]);
  fs.writeFileSync(path.join(tmp, '.planning', 'TEAM.md'), md);
  const live = parseTeamManifest(md).manifest.manifest_hash;
  const charter = role('builder').charter;

  const fresh = JSON.parse(runScript(body, tmp, [TEAM_LIB, live, 'builder', charter]).out);
  assert.equal(fresh.verdict, 'role');
  assert.equal(fresh.charter, charter, 'the injected charter is the TEAM.md charter text');

  const stale = JSON.parse(runScript(body, tmp, [TEAM_LIB, 'f'.repeat(64), 'builder', charter]).out);
  assert.equal(stale.verdict, 'stop');
  assert.equal(stale.reason, 'stale-stamp');
  assert.equal(stale.live_hash, live, 'the stop names the live hash for the re-stamp');

  const drift = JSON.parse(runScript(body, tmp, [TEAM_LIB, live, 'builder', charter + ' quietly extended']).out);
  assert.equal(drift.verdict, 'stop');
  assert.equal(drift.reason, 'charter-drift');
  assert.equal(drift.role_id, 'builder', 'the stop names the drifted role for the re-stamp');

  const missing = JSON.parse(runScript(body, tmp, [TEAM_LIB, live, 'ghost', charter]).out);
  assert.equal(missing.verdict, 'degrade');
  assert.equal(missing.reason, 'role-missing');

  fs.unlinkSync(path.join(tmp, '.planning', 'TEAM.md'));
  const absent = JSON.parse(runScript(body, tmp, [TEAM_LIB, live, 'builder', charter]).out);
  assert.equal(absent.verdict, 'degrade');
  assert.equal(absent.reason, 'team-md-absent');

  console.log(`team dispatch receipt: preflight verdicts role/stale-stamp/charter-drift/degrade x2 proven, live hash ${live.slice(0, 12)}`);
});

test('receipt: the documented stale-stamp sweep names stale plans and passes fresh ones', () => {
  const body = extractNodeScript(preflight, 'TEAM.md mutation stale-stamp sweep');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-team-sweep-'));
  const phaseDir = path.join(tmp, '.planning', 'phases', '01-demo');
  fs.mkdirSync(phaseDir, { recursive: true });
  const md = teamMd([role('builder')]);
  fs.writeFileSync(path.join(tmp, '.planning', 'TEAM.md'), md);
  const live = parseTeamManifest(md).manifest.manifest_hash;

  const plan = (hash) =>
    `---\nphase: 01-demo\nplan: 1\nrole_id: builder\nrole_charter: "x"\nteam_manifest_hash: "${hash}"\n---\n`;
  fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), plan(live));
  // Body-text decoys: hash-shaped lines OUTSIDE the frontmatter block must
  // never flag. 01-03 is fresh with a stale-looking line quoted in its body;
  // 01-04 has no frontmatter at all, only the decoy line in prose.
  fs.writeFileSync(
    path.join(phaseDir, '01-03-PLAN.md'),
    plan(live) + `\n## Notes\n\nA quoted receipt, not a stamp:\n\nteam_manifest_hash: "${'b'.repeat(64)}"\n`
  );
  fs.writeFileSync(
    path.join(phaseDir, '01-04-PLAN.md'),
    `# Roleless plan\n\nProse only, and a decoy line:\n\nteam_manifest_hash: "${'c'.repeat(64)}"\n`
  );

  const clean = runScript(body, tmp, [TEAM_LIB]);
  assert.equal(clean.code, 0, `body decoys must not flag:\n${clean.out}`);
  assert.match(clean.out, /stale-stamp sweep: 0 stale role stamps/);

  fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), plan('a'.repeat(64)));
  const dirty = runScript(body, tmp, [TEAM_LIB]);
  assert.equal(dirty.code, 1, 'a stale stamp exits 1');
  assert.match(dirty.out, /stale-stamp sweep: 1 stale role stamp\(s\)/);
  assert.match(dirty.out, /STALE STAMP: .*01-02-PLAN\.md/);
  assert.ok(!dirty.out.includes('01-01-PLAN.md'), 'the fresh stamp is never named');
  assert.ok(!dirty.out.includes('01-03-PLAN.md'), 'a fresh plan with a body decoy is never named');
  assert.ok(!dirty.out.includes('01-04-PLAN.md'), 'a frontmatterless plan with a body decoy is never named');

  assert.equal(computeTeamManifestHash(parseTeamManifest(md).manifest), live, 'sweep compares against the recomputed live hash');
  console.log('team dispatch receipt: sweep 0-stale pass + 1-stale named, exit codes 0/1');
});

// ─── Editorial floor on the new surfaces ─────────────────────────────────────

test('no em or en dashes in the Wave 3 sections and this file', () => {
  const sections = [
    ['execute-phase 2.6 preflight', preflight],
    ['execute-phase role_assignment block', executePhase.split('${ROLE_ASSIGNED ? `')[1].split("` : ''}")[0]],
    ['verifier echo rule', verifier.split('**Role-charter echo check (v1.13 Part 2 Wave 3):**')[1].split('\n\n')[0]],
    ['executor echo line', executor.split('**Team-staffed plans (v1.13 P2 W3):**')[1].split('\n\n')[0]],
    ['team-dispatch.test.cjs', read(__filename)],
  ];
  for (const [name, text] of sections) {
    assert.ok(!text.includes('\u2014'), `em dash in ${name}`);
    assert.ok(!text.includes('\u2013'), `en dash in ${name}`);
  }
});
