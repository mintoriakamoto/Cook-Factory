'use strict';

/**
 * MILESTONE v1.13 Part 2 Wave 2: the TEAM.md consumption seam.
 *
 * Two halves, the brainstorm-seam pattern. (1) Mechanical assertions on the
 * WORKFLOW + AGENT DOCS: new-project and new-milestone detect .planning/TEAM.md
 * by direct presence (A5: the manifest is the ONLY representation), acknowledge
 * in 1 line, and offer re-derivation when the manifest is FOREIGN (A4);
 * plan-phase and discuss-phase carry the "(if exists)" context line; the
 * planner doc carries the role stamp frontmatter (role_id + verbatim
 * role_charter + team_manifest_hash, the chapter_contract discipline
 * generalized); the plan-checker doc carries the team staffing integrity
 * checks including the A2 stale-stamp FAIL with a named fix. Absent TEAM.md is
 * zero behavior change everywhere (A9). (2) Countable receipts through the
 * real parser lib (ferrox-core/bin/lib/team-manifest.cjs): a stamped plan's
 * charter echo compares byte for byte, a roster mutation flips the stamp
 * stale, and the A3 non-redundancy validators refuse overlapping-owns and
 * empty-surface roles.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WF = (name) => path.join(ROOT, 'ferrox-core', 'workflows', name);
const AGENT = (name) => path.join(ROOT, 'agents', name);
const read = (f) => fs.readFileSync(f, 'utf8');

const newProject = read(WF('new-project.md'));
const newMilestone = read(WF('new-milestone.md'));
const planPhase = read(WF('plan-phase.md'));
const discussPhase = read(WF('discuss-phase.md'));
const planner = read(AGENT('ferrox-planner.md'));
const planChecker = read(AGENT('ferrox-plan-checker.md'));

const {
  parseTeamManifest,
  validateTeamManifest,
  computeTeamManifestHash,
  verifyTeamManifestHash,
  serializeTeamManifest,
  globsOverlap,
  CODES,
} = require('../ferrox-core/bin/lib/team-manifest.cjs');

// Shared contract strings. Both scanners must carry all of these.
const DETECT = 'ls .planning/TEAM.md';
const PARSER_REF = 'team-manifest.cjs';
const PARSE_FN = 'parseTeamManifest';
const ABSENT = 'skip silently, zero behavior change (A9)';
const ACK = 'Team manifest found: {N} roles ({M} bound to existing agents)';
const ONLY_REP = 'the ONLY representation of the team (A5: no parseBrainstormArtifact extension';
const FOREIGN = 'the manifest is FOREIGN';
const NO_SILENT = 'never silently consumed out of scope';
const REDERIVE = 're-derive the team for the new work shape';

const SCANNERS = [
  ['new-project.md', newProject],
  ['new-milestone.md', newMilestone],
];

// ─── The 2 scanners: direct presence detection + A4 scope match ──────────────

test('both scanners detect TEAM.md by direct presence and name the parsing contract', () => {
  for (const [name, doc] of SCANNERS) {
    assert.ok(doc.includes(DETECT), `${name} detects via ${DETECT}`);
    assert.ok(doc.includes(PARSER_REF), `${name} names the deterministic parsing contract`);
    assert.ok(doc.includes(PARSE_FN), `${name} names ${PARSE_FN}`);
    assert.ok(doc.includes(ONLY_REP), `${name} states TEAM.md is the only representation (A5)`);
  }
});

test('both scanners: absent TEAM.md is zero behavior change (A9)', () => {
  for (const [name, doc] of SCANNERS) {
    assert.ok(doc.includes(ABSENT), `${name} skips silently when TEAM.md is absent`);
  }
});

test('both scanners acknowledge a present roster in 1 line with the roster summary', () => {
  for (const [name, doc] of SCANNERS) {
    assert.ok(doc.includes(ACK), `${name} carries the 1-line roster acknowledgment`);
    assert.match(doc, /acknowledge in 1 line/, `${name} keeps the acknowledgment to 1 line`);
  }
});

test('both scanners: a foreign manifest is named FOREIGN and re-derivation is offered recommendation-first', () => {
  for (const [name, doc] of SCANNERS) {
    assert.match(doc, /derived_from/, `${name} reads derived_from for the scope match`);
    assert.match(doc, /Scope match \(A4\)/, `${name} carries the A4 scope match`);
    assert.ok(doc.includes(FOREIGN), `${name} names the foreign case plainly`);
    assert.ok(doc.includes(NO_SILENT), `${name} never consumes out of scope silently`);
    assert.ok(doc.includes(REDERIVE), `${name} recommends re-deriving for the new work shape`);
    assert.match(doc, /\(Recommended\)/, `${name} labels the recommended option`);
    assert.match(doc, /recommendation-first/, `${name} offers recommendation-first`);
  }
});

test('new-project: detection is its own step after the brainstorm scan', () => {
  assert.match(newProject, /## 2d\. Team Manifest Detection/);
  assert.match(
    newProject,
    /## 2c\. Prior Brainstorm Detection[\s\S]*## 2d\. Team Manifest Detection[\s\S]*## 3\. Deep Questioning/,
    'ordering: brainstorm scan, then team detection, then questioning'
  );
});

test('new-milestone: detection is its own step after the brainstorm scan', () => {
  assert.match(newMilestone, /## 2\.7\. Detect Team Manifest/);
  assert.match(
    newMilestone,
    /## 2\.6\. Scan Brainstorm Artifacts[\s\S]*## 2\.7\. Detect Team Manifest[\s\S]*## 3\. Determine Milestone Version/,
    'ordering: brainstorm scan, then team detection, then versioning'
  );
});

// ─── plan-phase + discuss-phase: the "(if exists)" context seam ──────────────

test('plan-phase: TEAM.md rides the planner files_to_read list with the "(if exists)" convention', () => {
  const open = planPhase.indexOf('\n<files_to_read>\n');
  const close = planPhase.indexOf('</files_to_read>');
  assert.ok(open !== -1 && close > open, 'the planner prompt carries a files_to_read block');
  const filesToRead = planPhase.slice(open, close);
  assert.match(filesToRead, /^- \.planning\/TEAM\.md \(Team Manifest:.*if exists\)$/m);
  assert.match(filesToRead, /Team-Staffed Plan Stamping/, 'the line points at the planner discipline');
});

test('discuss-phase: TEAM.md is 1 context line in load_prior_context, settled and never re-derived', () => {
  const step = discussPhase.split('<step name="load_prior_context">')[1].split('</step>')[0];
  assert.match(step, /cat \.planning\/TEAM\.md 2>\/dev\/null \|\| true/);
  assert.match(step, /\.planning\/TEAM\.md.*if exists/, 'carries the "(if exists)" convention');
  assert.match(step, /never re-derive or edit the team here/);
  assert.match(step, /absent means zero behavior change \(A9\)/);
});

// ─── ferrox-planner: the generalized chapter_contract discipline ─────────────

test('planner frontmatter template carries the 3 stamp keys', () => {
  assert.match(planner, /^role_id: ""/m);
  assert.match(planner, /^role_charter: ""/m);
  assert.match(planner, /^team_manifest_hash: ""/m);
});

test('planner frontmatter table carries a row per stamp key, mirroring the chapter_contract row', () => {
  assert.match(planner, /\| `chapter_contract` \| No \|/, 'the precedent row is still there');
  assert.match(planner, /\| `role_id` \| No \| TEAM-STAFFED ONLY \(v1\.13 P2 A4\)/);
  assert.match(planner, /\| `role_charter` \| No \| TEAM-STAFFED ONLY \(v1\.13 P2\)/);
  assert.match(planner, /\| `team_manifest_hash` \| No \| TEAM-STAFFED ONLY \(v1\.13 P2 A2\)/);
});

test('planner: the stamping discipline section carries scope match, verbatim copy, and the trust split', () => {
  assert.match(planner, /## Team-Staffed Plan Stamping \(v1\.13 Part 2 Wave 2\)/);
  const section = planner.split('## Team-Staffed Plan Stamping')[1].split('## Interface Context for Executors')[0];
  assert.match(section, /A4 scope match/, 'consumption is conditional on derived_from matching');
  assert.match(section, /derived_from/, 'scope match reads derived_from');
  assert.match(section, /VERBATIM, byte for byte/, 'the charter copy is verbatim');
  assert.match(section, /Never paraphrase/, 'paraphrase is forbidden');
  assert.match(section, /the executor echoes, never authors/, 'the trust split is stated');
  assert.match(section, /owns\[\]/, 'assignment matches owns[] surfaces');
  assert.match(section, /reviews\[\]/, 'reviews[] is the second match');
  assert.match(section, /files_modified/, 'the match target is the plan write surface');
  assert.match(section, /never force-fit or invent a role/);
  assert.match(section, /Roleless plans stay fully valid \(A9\)/);
});

// ─── ferrox-plan-checker: team staffing integrity ────────────────────────────

const checkerDim = planChecker.includes('## Dimension 7d: Team Staffing Integrity')
  ? planChecker.split('## Dimension 7d: Team Staffing Integrity')[1].split('## Dimension 8:')[0]
  : '';

test('plan-checker: the team dimension exists and skips silently when TEAM.md is absent (A9)', () => {
  assert.match(planChecker, /## Dimension 7d: Team Staffing Integrity \(if \.planning\/TEAM\.md exists\)/);
  assert.match(checkerDim, /skip SILENTLY \(A9\)/);
  assert.match(checkerDim, /unstamped plans stay fully valid/i);
});

test('plan-checker: role existence, byte-for-byte charter echo, and complete-stamp checks', () => {
  assert.match(checkerDim, /Check T1: role exists/);
  assert.match(checkerDim, /names a role present in TEAM\.md/);
  assert.match(checkerDim, /Check T2: charter echo, byte for byte/);
  assert.match(checkerDim, /EXACTLY, byte for byte/);
  assert.match(checkerDim, /Check T5: complete stamp/);
});

test('plan-checker: the A2 stale stamp FAILS with the named fix (re-stamp or re-bless)', () => {
  assert.match(checkerDim, /Check T3: stamp freshness \(A2\)/);
  assert.match(checkerDim, /\*\*re-stamp\*\*/);
  assert.match(checkerDim, /\*\*re-bless\*\*/);
  assert.match(checkerDim, /Never silently accept a stale stamp/);
  assert.match(checkerDim, /team_manifest_hash/);
});

test('plan-checker: A3 non-redundancy validators are consulted and failing roles refuse staffing', () => {
  assert.match(checkerDim, /Check T4: non-redundancy validators consulted \(A3\)/);
  assert.match(checkerDim, /E_OWNS_OVERLAP/);
  assert.match(checkerDim, /E_EMPTY_SURFACES/);
  assert.match(checkerDim, /REFUSED/);
  for (const fn of ['parseTeamManifest', 'validateTeamManifest', 'computeTeamManifestHash', 'verifyTeamManifestHash', 'globsOverlap']) {
    assert.ok(checkerDim.includes(fn), `checker names the ${fn} export`);
  }
});

// ─── Fixture receipts: the stamp lifecycle through the real parser lib ───────

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

// The serializer refuses invalid manifests, so intentionally broken fixtures
// dump YAML directly with a content-correct hash (the team-manifest.test.cjs
// fixture pattern).
const yaml = require('../ferrox-core/bin/vendor/js-yaml-4.2.0.cjs');

function rawTeamMd(roles) {
  const m = {
    schema: 'team-manifest/v1',
    derived_from: { brainstorm: 'demo-topic-2026-07-23', milestone: 'v1.13' },
    manifest_hash: '',
    roles,
  };
  m.manifest_hash = computeTeamManifestHash({
    schema: m.schema,
    derived_from: m.derived_from,
    manifest_hash: '',
    roles: roles.map((r) => ({
      ...r,
      tier: r.tier === undefined ? null : r.tier,
      phase_scope: r.phase_scope === undefined ? null : r.phase_scope,
    })),
  });
  return `# TEAM\n\n\`\`\`yaml team-manifest\n${yaml.dump(m, { lineWidth: 120, noRefs: true, sortKeys: false })}\`\`\`\n`;
}

test('receipt: a fresh stamp verifies (role exists, charter echoes byte for byte, hash matches live)', () => {
  const md = teamMd([role('builder'), role('reviewer', { owns: [], reviews: ['src/builder/**'] })]);
  const parsed = parseTeamManifest(md);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));

  // The planner stamp: copied verbatim from the parsed live manifest.
  const seat = parsed.manifest.roles.find((r) => r.id === 'builder');
  const stamp = {
    role_id: seat.id,
    role_charter: seat.charter,
    team_manifest_hash: parsed.manifest.manifest_hash,
  };

  // T1: the stamped role exists in the roster.
  assert.ok(parsed.manifest.roles.some((r) => r.id === stamp.role_id));
  // T2: the charter echo compares byte for byte.
  assert.equal(stamp.role_charter, seat.charter);
  // T3: the stamp matches the recomputed live hash, and the manifest self-verifies.
  assert.equal(stamp.team_manifest_hash, computeTeamManifestHash(parsed.manifest));
  assert.equal(verifyTeamManifestHash(parsed.manifest).ok, true);

  console.log(`team seam receipt: 2 roles parsed, stamp hash ${stamp.team_manifest_hash.slice(0, 12)} fresh`);
});

test('receipt: a roster mutation flips the old stamp stale (A2)', () => {
  const before = parseTeamManifest(teamMd([role('builder')]));
  assert.equal(before.ok, true);
  const stampedHash = before.manifest.manifest_hash;

  // The roster drifts: the charter is edited after stamping.
  const after = parseTeamManifest(
    teamMd([role('builder', { charter: 'Own the builder surface and also the docs.' })])
  );
  assert.equal(after.ok, true);
  assert.notEqual(after.manifest.manifest_hash, stampedHash, 'stale stamp detected');

  // And the tampered charter no longer echoes byte for byte.
  const seat = after.manifest.roles.find((r) => r.id === 'builder');
  assert.notEqual(seat.charter, role('builder').charter);
});

test('receipt: the A3 validators refuse overlapping owns and empty surfaces', () => {
  assert.equal(globsOverlap('src/a/**', 'src/a/deep/**'), true);
  assert.equal(globsOverlap('src/a/**', 'docs/**'), false);

  const overlap = parseTeamManifest(rawTeamMd([role('alpha', { owns: ['src/a/**'] }), role('beta', { owns: ['src/a/deep/**'] })]));
  assert.equal(overlap.ok, false);
  assert.ok(overlap.errors.some((e) => e.code === CODES.E_OWNS_OVERLAP), 'owns overlap without a review edge is refused');

  const empty = parseTeamManifest(rawTeamMd([role('alpha'), role('idle', { owns: [], reviews: [] })]));
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((e) => e.code === CODES.E_EMPTY_SURFACES), 'a role with no surfaces is refused');

  // validateTeamManifest is the same validator surface the checker consults.
  const reparsed = parseTeamManifest(teamMd([role('alpha')]));
  assert.equal(reparsed.ok, true);
  const revalidated = validateTeamManifest({ ...reparsed.manifest, roles: reparsed.manifest.roles.map((r) => ({ ...r })) }, undefined, { skipHashCheck: true });
  assert.equal(revalidated.ok, true);
});

// ─── Editorial floor on the new surfaces ─────────────────────────────────────

test('no em or en dashes in the Wave 2 sections and this file', () => {
  const sections = [
    ['new-project.md 2d', newProject.split('## 2d. Team Manifest Detection')[1].split('## 3. Deep Questioning')[0]],
    ['new-milestone.md 2.7', newMilestone.split('## 2.7. Detect Team Manifest')[1].split('## 3. Determine Milestone Version')[0]],
    ['planner stamping section', planner.split('## Team-Staffed Plan Stamping')[1].split('## Interface Context for Executors')[0]],
    ['plan-checker 7d', checkerDim],
    ['team-seam.test.cjs', read(__filename)],
  ];
  for (const [name, text] of sections) {
    assert.ok(!text.includes('\u2014'), `em dash in ${name}`);
    assert.ok(!text.includes('\u2013'), `en dash in ${name}`);
  }
});
