'use strict';

/**
 * Phase 14 (v1.14 Fleet Mode): the milestone-artifact contract.
 *
 * `.planning/MILESTONES.md` is GENERATED from `MILESTONE-v*.md` / `BENCHMARK-v*.md`
 * frontmatter so it cannot drift from the artifacts it indexes. These tests lock the
 * properties that make `gen-milestones.cjs --check` meaningful:
 *
 *   - HERMETIC: no clock, no git, no filesystem inside the lib.
 *   - ORDER-STABLE: shuffled input renders byte-identically. Rendering the same ORDERED
 *     list twice proves nothing; a filesystem enumeration change is the real threat.
 *   - FAIL LOUD: a malformed artifact errors and is never silently dropped, because a
 *     silently dropped artifact is exactly how an index rots while looking healthy.
 *   - The 1.9 vs 1.10 ordering trap, which a lexicographic sort gets wrong.
 *
 * Provenance: the phase exists because ROADMAP.md went 365 commits stale while 12
 * milestones shipped, leaving 3 conflicting answers to "what milestone are we on".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const lib = require(path.join(__dirname, '..', 'ferrox-core', 'bin', 'lib', 'milestone-manifest.cjs'));

function artifact(fm, body = '') {
  const keys = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `---\n${keys}\n---\n\n${body}`;
}

const BASE = {
  milestone: '"1.9"',
  name: '"The Gate Library"',
  lifecycle: 'complete',
  shipped: '["1.9.0"]',
  artifact_kind: 'milestone',
};

test('compareVersions sorts numerically, not lexicographically', () => {
  assert.ok(lib.compareVersions('1.9', '1.10') < 0, '1.9 must sort BEFORE 1.10');
  assert.ok(lib.compareVersions('1.10', '1.9') > 0);
  assert.equal(lib.compareVersions('1.13', '1.13'), 0);
  assert.ok(lib.compareVersions('1.2', '1.13') < 0);
  // a string sort would put '1.10' before '1.9'; this is the trap
  assert.notEqual(['1.9', '1.10'].sort()[0], ['1.9', '1.10'].sort(lib.compareVersions)[0]);
});

test('parses a well-formed artifact', () => {
  const r = lib.parseMilestoneArtifact(
    artifact(BASE, '- [x] done\n- [ ] open\n'),
    'MILESTONE-v1.9-GATE-LIBRARY.md',
  );
  assert.equal(r.ok, true);
  assert.equal(r.milestone, '1.9');
  assert.equal(r.lifecycle, 'complete');
  assert.deepEqual(r.shipped, ['1.9.0']);
  assert.equal(r.part, 1, 'part defaults to 1');
  assert.deepEqual(r.progress, { done: 1, total: 2 });
});

test('accepts BENCHMARK artifacts, so no stub files need inventing', () => {
  const r = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.7"', name: '"Deep Benchmark"', shipped: '[]', artifact_kind: 'benchmark' }),
    'BENCHMARK-v1.7.md',
  );
  assert.equal(r.ok, true);
  assert.equal(r.artifact_kind, 'benchmark');
});

test('missing frontmatter FAILS LOUD rather than being skipped', () => {
  const r = lib.parseMilestoneArtifact('# Just a heading\n', 'MILESTONE-v1.9-X.md');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_MILESTONE_FRONTMATTER');
});

test('filename version must match frontmatter version', () => {
  const r = lib.parseMilestoneArtifact(artifact(BASE), 'MILESTONE-v1.8-WRONG.md');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_MILESTONE_FILENAME_MISMATCH');
});

test('lifecycle is constrained', () => {
  const r = lib.parseMilestoneArtifact(
    artifact({ ...BASE, lifecycle: 'in-progress' }),
    'MILESTONE-v1.9-X.md',
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, 'E_MILESTONE_LIFECYCLE');
});

test('shipped must be a list, so a version group can carry 1.13.0 AND 1.13.1', () => {
  const scalar = lib.parseMilestoneArtifact(
    artifact({ ...BASE, shipped: '"1.9.0"' }),
    'MILESTONE-v1.9-X.md',
  );
  assert.equal(scalar.ok, false);
  assert.equal(scalar.code, 'E_MILESTONE_SHIPPED');

  const list = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.13"', shipped: '["1.13.0", "1.13.1"]' }),
    'MILESTONE-v1.13-CREATIVE-LINE.md',
  );
  assert.equal(list.ok, true);
  assert.deepEqual(list.shipped, ['1.13.0', '1.13.1']);
});

test('two artifacts sharing a version group and order by part', () => {
  const p1 = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.13"', name: '"Line"', shipped: '["1.13.0"]', part: '1' }),
    'MILESTONE-v1.13-CREATIVE-LINE.md',
  );
  const p2 = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.13"', name: '"Line"', shipped: '["1.13.0"]', part: '2' }),
    'MILESTONE-v1.13-PART2-DYNAMIC-TEAM.md',
  );
  // feed them in REVERSE part order; grouping must still order 1 then 2
  const c = lib.collectMilestones([p2, p1]);
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  assert.equal(c.groups.length, 1);
  assert.deepEqual(c.groups[0].parts.map((p) => p.part), [1, 2]);
});

test('conflicting group metadata is rejected, never last-write-wins', () => {
  const p1 = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.13"', name: '"Line"', shipped: '["1.13.0"]', part: '1' }),
    'MILESTONE-v1.13-CREATIVE-LINE.md',
  );
  const p2 = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.13"', name: '"DIFFERENT"', shipped: '["1.13.0"]', part: '2' }),
    'MILESTONE-v1.13-PART2-DYNAMIC-TEAM.md',
  );
  const c = lib.collectMilestones([p1, p2]);
  assert.equal(c.ok, false);
  assert.ok(c.errors.some((e) => e.code === 'E_MILESTONE_GROUP_CONFLICT'));
});

test('exactly one milestone may be lifecycle: active', () => {
  const a = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.13"', lifecycle: 'active', shipped: '[]' }),
    'MILESTONE-v1.13-X.md',
  );
  const b = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.14"', lifecycle: 'active', shipped: '[]' }),
    'MILESTONE-v1.14-Y.md',
  );
  const c = lib.collectMilestones([a, b]);
  assert.equal(c.ok, false);
  assert.ok(c.errors.some((e) => e.code === 'E_MILESTONE_MULTIPLE_ACTIVE'));
});

test('activeMilestone resolves the active group, NOT the numerically newest', () => {
  const older = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.14"', lifecycle: 'active', shipped: '[]' }),
    'MILESTONE-v1.14-FLEET-MODE.md',
  );
  const draft = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.15"', lifecycle: 'draft', shipped: '[]' }),
    'MILESTONE-v1.15-FUTURE.md',
  );
  const c = lib.collectMilestones([older, draft]);
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  const active = lib.activeMilestone(c.groups);
  assert.equal(active.milestone, '1.14', 'a drafted future milestone must NOT become current');
});

test('ORDER-STABLE: shuffled input renders byte-identically', () => {
  const versions = ['1.1', '1.2', '1.9', '1.10', '1.13', '1.14'];
  const parsed = versions.map((v) =>
    lib.parseMilestoneArtifact(
      artifact({ ...BASE, milestone: `"${v}"`, name: `"M ${v}"`, shipped: '[]' }),
      `MILESTONE-v${v}-X.md`,
    ),
  );
  const render = (list) => lib.renderMilestonesIndex(lib.collectMilestones(list).groups);
  const baseline = render(parsed);

  // deterministic permutations; no Math.random so the test itself stays hermetic
  const perms = [
    parsed.slice().reverse(),
    [parsed[3], parsed[0], parsed[5], parsed[1], parsed[4], parsed[2]],
    [parsed[2], parsed[3], parsed[1], parsed[5], parsed[0], parsed[4]],
  ];
  for (const p of perms) {
    assert.equal(render(p), baseline, 'render must not depend on input order');
  }
  // and 1.10 must appear after 1.9 in the output
  assert.ok(baseline.indexOf('| v1.9 |') < baseline.indexOf('| v1.10 |'));
});

test('renders unpublished milestones explicitly, never as a blank cell', () => {
  const e = lib.parseMilestoneArtifact(
    artifact({ ...BASE, milestone: '"1.5"', name: '"Autonomous Benchmark"', shipped: '[]', artifact_kind: 'benchmark' }),
    'BENCHMARK-v1.5-AUTONOMOUS.md',
  );
  const out = lib.renderMilestonesIndex(lib.collectMilestones([e]).groups);
  assert.ok(out.includes('not published'));
  assert.ok(!/\|\s*\|\s*\|/.test(out.split('\n').find((l) => l.startsWith('| v1.5'))));
});

test('selectArtifactFiles: MILESTONE always, BENCHMARK only when it opts in', () => {
  const sel = lib.selectArtifactFiles([
    { name: 'MILESTONE-v1.9-X.md', text: 'no frontmatter' },
    { name: 'BENCHMARK-v1.4-ANVIL.md', text: '# report about milestone 1.4' },
    { name: 'BENCHMARK-v1.7.md', text: '---\nmilestone: "1.7"\n---\n' },
    { name: 'AUDIT-2026-07-19.md', text: '---\nx: 1\n---\n' },
  ]).map((f) => f.name);
  assert.deepEqual(sel, ['MILESTONE-v1.9-X.md', 'BENCHMARK-v1.7.md']);
});

test('the real .planning artifacts all parse and yield exactly one active', () => {
  const fs = require('node:fs');
  const dir = path.join(__dirname, '..', '.planning');
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /^(MILESTONE|BENCHMARK)-v\d/.test(f) && f.endsWith('.md'))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  // BENCHMARK reports ABOUT a milestone (e.g. BENCHMARK-v1.4-ANVIL.md) are not artifacts;
  // only the two that carry frontmatter (v1.5, v1.7) opt in.
  const files = lib.selectArtifactFiles(candidates);
  // 16 since phase 14.1 plan 03 reconstructed MILESTONE-v1.0-FOUNDATION.md, which the v1
  // requirement ledger in PROJECT.md points its shipped_in pointers at; 17 since v1.16
  // (the on ramp) added its own artifact to claim 1.16.0 in `shipped`, which
  // gen-milestones --check requires of every version present in CHANGELOG.md;
  // 18 since v1.17 (graph engineering). v1.17 carried `lifecycle: draft` while
  // v1.14 held the single active slot this file's own "exactly one active" arm
  // enforces. On 2026-08-01 v1.14 was closed and v1.17 took the slot, so the
  // pin below moved 1.14 to 1.17. THE PIN IS KEPT, not loosened: it exists so
  // that a lifecycle flip is reported by a failing arm rather than absorbed
  // silently, and it did exactly that on the run that produced this edit.
  assert.equal(files.length, 18, `expected 18 artifacts, found ${files.length}`);
  const parsed = files.map((f) => lib.parseMilestoneArtifact(f.text, f.name));
  const bad = parsed.filter((p) => !p.ok);
  assert.deepEqual(bad, [], `unparseable artifacts: ${JSON.stringify(bad, null, 2)}`);
  const c = lib.collectMilestones(parsed);
  assert.equal(c.ok, true, JSON.stringify(c.errors, null, 2));
  const active = lib.activeMilestone(c.groups);
  assert.ok(active, 'exactly one artifact must be lifecycle: active');
  assert.equal(active.milestone, '1.17');
});
