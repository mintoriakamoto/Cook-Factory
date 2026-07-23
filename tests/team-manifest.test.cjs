'use strict';

/**
 * TEAM-01 tests: the team-manifest/v1 parser + mutation primitives (v1.13
 * Part 2 Wave 0).
 *
 * parseTeamManifest(markdown, options) -> { ok, manifest, errors, warnings }
 *   - exactly 1 fenced block opened by "```yaml team-manifest", YAML inside,
 *     the deterministic A3/A10 validators, injected tier + agent universes,
 *   - NEVER throws on bad input: findings come back as { code, path, message }.
 * addTeamRole/removeTeamRole/swapTeamRole re-validate the RESULT and refuse
 * invalid results; remove/swap honor injected plan role references (A8).
 * serializeTeamManifest emits stable order so manifest_hash is deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseTeamManifest,
  computeTeamManifestHash,
  verifyTeamManifestHash,
  addTeamRole,
  removeTeamRole,
  swapTeamRole,
  serializeTeamManifest,
  globsOverlap,
  CODES,
} = require('../ferrox-core/bin/lib/team-manifest.cjs');

// Fixture builder dumps YAML directly (the serializer under test refuses an
// invalid manifest, and half these fixtures are intentionally invalid).
const yaml = require('../ferrox-core/bin/vendor/js-yaml-4.2.0.cjs');

const PROVENANCE = '(stance: guided, confirmed at exit)';

/** Build a valid role object; override any field via extra. */
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

/** Hash a raw fixture the way the parser hashes its normalized manifest. */
function hashFor(m) {
  return computeTeamManifestHash({
    schema: m.schema,
    derived_from: m.derived_from,
    manifest_hash: '',
    roles: (m.roles || []).map((r) => ({
      ...r,
      binding: r.binding && typeof r.binding === 'object' ? r.binding : { inline: true },
      tier: r.tier === undefined ? null : r.tier,
      phase_scope: r.phase_scope === undefined ? null : r.phase_scope,
    })),
  });
}

/** Wrap roles in a TEAM.md document with a content-correct manifest_hash. */
function teamDoc(roles, extra = {}) {
  const m = {
    schema: 'team-manifest/v1',
    derived_from: { brainstorm: 'demo-topic-2026-07-23', milestone: 'v1.13' },
    manifest_hash: '',
    roles,
    ...extra,
  };
  m.manifest_hash = hashFor(m);
  return `# TEAM\n\n\`\`\`yaml team-manifest\n${yaml.dump(m, { lineWidth: 120, noRefs: true, sortKeys: false })}\`\`\`\n`;
}

// ---------- parser happy path ----------

test('a valid 2-role roster parses ok with typed roles and both binding rungs', () => {
  const md = teamDoc([
    role('builder'),
    role('reviewer', { binding: { agent: 'ferrox-code-reviewer' }, tier: null, owns: [], reviews: ['src/**'] }),
  ]);
  const r = parseTeamManifest(md, { tiers: ['standard'], agents: ['ferrox-code-reviewer'] });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
  assert.equal(r.manifest.schema, 'team-manifest/v1');
  assert.equal(r.manifest.derived_from.brainstorm, 'demo-topic-2026-07-23');
  assert.equal(r.manifest.roles.length, 2);
  assert.equal(r.manifest.roles[0].effective_binding, 'inline');
  assert.equal(r.manifest.roles[1].effective_binding, 'agent');
  assert.equal(r.manifest.roles[1].tier, null, 'tier stays optional for agent-bound roles (A14)');
});

test('solo roster (floor of 1) is valid; zero roles is not', () => {
  const solo = parseTeamManifest(teamDoc([role('generalist')]));
  assert.equal(solo.ok, true);

  const md = teamDoc([role('generalist')]).replace(/roles:[\s\S]*```/, 'roles: []\n```');
  const none = parseTeamManifest(md);
  assert.equal(none.ok, false);
  assert.ok(none.errors.some((e) => e.code === CODES.E_FLOOR_VIOLATION));
});

test('missing block, multiple blocks, unterminated fence, and garbage YAML all fail without throwing', () => {
  const none = parseTeamManifest('# Prose only\n\nNo roster block here.\n');
  assert.equal(none.ok, false);
  assert.equal(none.errors[0].code, CODES.E_TEAM_BLOCK_MISSING);

  const one = teamDoc([role('builder')]);
  const two = parseTeamManifest(one + '\n' + one);
  assert.equal(two.ok, false);
  assert.equal(two.errors[0].code, CODES.E_TEAM_BLOCK_MULTIPLE);

  const unterminated = parseTeamManifest('```yaml team-manifest\nschema: team-manifest/v1\n');
  assert.equal(unterminated.ok, false);
  assert.equal(unterminated.errors[0].code, CODES.E_TEAM_BLOCK_MISSING);

  const garbage = parseTeamManifest('```yaml team-manifest\n{{{ not yaml ]\n```\n');
  assert.equal(garbage.ok, false);
  assert.equal(garbage.errors[0].code, CODES.E_YAML_PARSE);

  assert.doesNotThrow(() => parseTeamManifest(undefined));
  assert.equal(parseTeamManifest(undefined).ok, false);
  assert.doesNotThrow(() => parseTeamManifest(42));
});

// ---------- schema-level validators ----------

test('wrong schema, missing derived_from, and hash problems are rejected', () => {
  const badSchema = parseTeamManifest('```yaml team-manifest\nschema: team-manifest/v2\n```\n');
  assert.equal(badSchema.ok, false);
  assert.equal(badSchema.errors[0].code, CODES.E_BAD_SCHEMA);

  const noDerived = teamDoc([role('builder')]).replace(/derived_from:\n\s+brainstorm: .*\n\s+milestone: .*\n/, '');
  const r = parseTeamManifest(noDerived);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === CODES.E_BAD_DERIVED_FROM));

  const badHash = teamDoc([role('builder')]).replace(/manifest_hash: [0-9a-f]{64}/, 'manifest_hash: nope');
  const h = parseTeamManifest(badHash);
  assert.equal(h.ok, false);
  assert.ok(h.errors.some((e) => e.code === CODES.E_BAD_HASH));

  // All-letter hex: an unquoted all-digit scalar would YAML-parse as a number.
  const stale = teamDoc([role('builder')]).replace(/manifest_hash: [0-9a-f]{64}/, `manifest_hash: ${'f'.repeat(64)}`);
  const s = parseTeamManifest(stale);
  assert.equal(s.ok, false);
  assert.ok(s.errors.some((e) => e.code === CODES.E_HASH_MISMATCH));
});

// ---------- role-level validators ----------

test('bad role id, duplicate id, and missing trusted fields are rejected', () => {
  const badId = parseTeamManifest(teamDoc([role('builder', { id: 'Not A Slug' })]));
  assert.ok(badId.errors.some((e) => e.code === CODES.E_BAD_ROLE_ID));

  const dup = parseTeamManifest(teamDoc([role('builder'), role('builder', { owns: ['docs/**'] })]));
  assert.ok(dup.errors.some((e) => e.code === CODES.E_DUPLICATE_ROLE_ID));

  const noCharter = parseTeamManifest(teamDoc([role('builder', { charter: '' })]));
  assert.ok(noCharter.errors.some((e) => e.code === CODES.E_BAD_CHARTER));

  const noRationale = parseTeamManifest(teamDoc([role('builder', { rationale: '' })]));
  assert.ok(noRationale.errors.some((e) => e.code === CODES.E_BAD_RATIONALE));

  const noNonRedundancy = parseTeamManifest(teamDoc([role('builder', { non_redundancy: '' })]));
  assert.ok(noNonRedundancy.errors.some((e) => e.code === CODES.E_BAD_NON_REDUNDANCY));
});

test('provenance must carry the exit-confirmed marker (A1)', () => {
  const missing = parseTeamManifest(teamDoc([role('builder', { provenance: 'seemed like a good idea' })]));
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.code === CODES.E_BAD_PROVENANCE));

  for (const stance of ['guided', 'generative', 'sounding-board']) {
    const ok = parseTeamManifest(teamDoc([role('builder', { provenance: `(stance: ${stance}, confirmed at exit)` })]));
    assert.equal(ok.ok, true, `stance ${stance} must pass`);
  }
});

test('binding must be exactly 1 of agent or inline; inline roles require a tier (A14)', () => {
  const neither = parseTeamManifest(teamDoc([role('builder', { binding: {} })]));
  assert.ok(neither.errors.some((e) => e.code === CODES.E_BAD_BINDING));

  const both = parseTeamManifest(teamDoc([role('builder', { binding: { agent: 'ferrox-executor', inline: true } })]));
  assert.ok(both.errors.some((e) => e.code === CODES.E_BAD_BINDING));

  const inlineNoTier = parseTeamManifest(teamDoc([role('builder', { tier: null })]));
  assert.equal(inlineNoTier.ok, false);
  assert.ok(inlineNoTier.errors.some((e) => e.code === CODES.E_MISSING_TIER));

  const boundNoTier = parseTeamManifest(teamDoc([role('builder', { binding: { agent: 'ferrox-executor' }, tier: null })]));
  assert.equal(boundNoTier.ok, true, 'agent-bound roles may omit tier');
});

test('every role needs a nonempty owns or reviews surface (A3)', () => {
  const bare = parseTeamManifest(teamDoc([role('builder', { owns: [], reviews: [] })]));
  assert.equal(bare.ok, false);
  assert.ok(bare.errors.some((e) => e.code === CODES.E_EMPTY_SURFACES));

  const reviewsOnly = parseTeamManifest(teamDoc([role('eye', { owns: [], reviews: ['src/**'] })]));
  assert.equal(reviewsOnly.ok, true);

  const badShape = parseTeamManifest(teamDoc([role('builder', { owns: 'src/**' })]));
  assert.ok(badShape.errors.some((e) => e.code === CODES.E_BAD_SURFACE));
});

test('phase_scope is optional but must be a nonempty string list when present', () => {
  const ok = parseTeamManifest(teamDoc([role('builder', { phase_scope: ['phase-1'] })]));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.manifest.roles[0].phase_scope, ['phase-1']);

  const bad = parseTeamManifest(teamDoc([role('builder', { phase_scope: [''] })]));
  assert.ok(bad.errors.some((e) => e.code === CODES.E_BAD_PHASE_SCOPE));
});

// ---------- owns-overlap / review-edge matrix (A3) ----------

test('overlap matrix: overlapping owns without a review edge is rejected', () => {
  const r = parseTeamManifest(teamDoc([
    role('alpha', { owns: ['src/**'] }),
    role('beta', { owns: ['src/lib/*.cjs'] }),
  ]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === CODES.E_OWNS_OVERLAP));
});

test('overlap matrix: a review edge in either direction legalizes the overlap', () => {
  const forward = parseTeamManifest(teamDoc([
    role('alpha', { owns: ['src/**'], reviews: ['src/lib/*.cjs'] }),
    role('beta', { owns: ['src/lib/*.cjs'] }),
  ]));
  assert.equal(forward.ok, true, 'alpha reviews beta\'s overlapping surface');

  const backward = parseTeamManifest(teamDoc([
    role('alpha', { owns: ['src/**'] }),
    role('beta', { owns: ['src/lib/*.cjs'], reviews: ['src/**'] }),
  ]));
  assert.equal(backward.ok, true, 'beta reviews alpha\'s overlapping surface');
});

test('overlap matrix: disjoint owns never trip the validator', () => {
  const r = parseTeamManifest(teamDoc([
    role('alpha', { owns: ['src/alpha/**'] }),
    role('beta', { owns: ['docs/*.md'] }),
  ]));
  assert.equal(r.ok, true);
});

test('globsOverlap decides wildcard co-matching deterministically', () => {
  assert.equal(globsOverlap('src/**', 'src/lib/team.cjs'), true);
  assert.equal(globsOverlap('src/*.ts', 'src/team.*'), true);
  assert.equal(globsOverlap('src/**', 'docs/*.md'), false);
  assert.equal(globsOverlap('**', 'anything/at/all.txt'), true);
  assert.equal(globsOverlap('src/a?.cjs', 'src/ab.cjs'), true);
  assert.equal(globsOverlap('src/a?.cjs', 'src/b.cjs'), false);
});

test('globsOverlap compares case-insensitively (case-differing paths still collide)', () => {
  assert.equal(globsOverlap('SRC/**', 'src/lib/team.cjs'), true);
  assert.equal(globsOverlap('src/Lib/*.cjs', 'src/lib/team.cjs'), true);
  assert.equal(globsOverlap('LORE.md', 'lore.md'), true);
  assert.equal(globsOverlap('SRC/**', 'docs/*.md'), false, 'case folding never invents an overlap');
});

test('case-differing owns surfaces trip the A3 overlap validator', () => {
  const r = parseTeamManifest(teamDoc([
    role('alpha', { owns: ['SRC/sync/**'] }),
    role('beta', { owns: ['src/sync/engine.cjs'] }),
  ]));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === CODES.E_OWNS_OVERLAP));
});

test('unsupported glob syntax in owns/reviews is refused with E_BAD_SURFACE (fail closed)', () => {
  for (const bad of ['src/{a,b}/**', 'src/[ab]/**', 'src\\lib\\**']) {
    const owns = parseTeamManifest(teamDoc([role('builder', { owns: [bad] })]));
    assert.equal(owns.ok, false, `owns glob ${JSON.stringify(bad)} must be refused`);
    const hit = owns.errors.find((e) => e.code === CODES.E_BAD_SURFACE);
    assert.ok(hit, `owns glob ${JSON.stringify(bad)} carries E_BAD_SURFACE`);
    assert.match(hit.message, /fail closed/);
    assert.match(hit.path, /owns\[0\]$/, 'the finding names the exact refused entry');

    const reviews = parseTeamManifest(teamDoc([role('eye', { owns: [], reviews: [bad] })]));
    assert.equal(reviews.ok, false, `reviews glob ${JSON.stringify(bad)} must be refused`);
    assert.ok(reviews.errors.some((e) => e.code === CODES.E_BAD_SURFACE && /reviews\[0\]$/.test(e.path)));
  }
  const clean = parseTeamManifest(teamDoc([role('builder', { owns: ['src/a-b.c?/**'] })]));
  assert.equal(clean.ok, true, 'the supported *, ?, ** syntax still passes');
});

// ---------- injected universes (A10) ----------

test('unknown tier warns but never refuses; no injected list means no check', () => {
  const md = teamDoc([role('builder', { tier: 'mythic' })]);
  const withList = parseTeamManifest(md, { tiers: ['standard', 'deep'] });
  assert.equal(withList.ok, true);
  assert.ok(withList.warnings.some((w) => w.code === CODES.W_UNKNOWN_TIER));

  const noList = parseTeamManifest(md);
  assert.equal(noList.ok, true);
  assert.deepEqual(noList.warnings, []);
});

test('unknown agent warns and degrades the role to the inline rung', () => {
  const md = teamDoc([role('eye', { binding: { agent: 'ghost-agent' }, tier: null, owns: [], reviews: ['src/**'] })]);
  const r = parseTeamManifest(md, { agents: ['ferrox-executor'] });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === CODES.W_UNKNOWN_AGENT));
  assert.equal(r.manifest.roles[0].effective_binding, 'inline');

  const known = parseTeamManifest(md, { agents: ['ghost-agent'] });
  assert.equal(known.manifest.roles[0].effective_binding, 'agent');
});

// ---------- mutation ops (A8; ijfw modify.js discipline) ----------

test('addTeamRole lands a valid role, recomputes the hash, and never mutates its input', () => {
  const base = parseTeamManifest(teamDoc([role('builder')])).manifest;
  const baseHash = base.manifest_hash;
  const r = addTeamRole(base, role('scribe', { owns: ['docs/**'] }));
  assert.equal(r.ok, true);
  assert.equal(r.manifest.roles.length, 2);
  assert.notEqual(r.manifest.manifest_hash, baseHash);
  assert.equal(verifyTeamManifestHash(r.manifest).ok, true);
  assert.equal(base.roles.length, 1, 'input manifest stays untouched');
  assert.equal(base.manifest_hash, baseHash);
});

test('addTeamRole refuses a duplicate id and refuses an invalid RESULT', () => {
  const base = parseTeamManifest(teamDoc([role('builder')])).manifest;
  const dup = addTeamRole(base, role('builder', { owns: ['docs/**'] }));
  assert.equal(dup.ok, false);
  assert.equal(dup.manifest, null);
  assert.ok(dup.errors.some((e) => e.code === CODES.E_ROLE_EXISTS));

  const overlapping = addTeamRole(base, role('rival', { owns: ['src/builder/deep/**'] }));
  assert.equal(overlapping.ok, false);
  assert.equal(overlapping.manifest, null, 'an invalid result is never returned');
  assert.ok(overlapping.errors.some((e) => e.code === CODES.E_OWNS_OVERLAP));
});

test('removeTeamRole enforces floor of 1, missing ids, and the A8 live-plan guard', () => {
  const two = parseTeamManifest(teamDoc([role('builder'), role('scribe', { owns: ['docs/**'] })])).manifest;

  const ok = removeTeamRole(two, 'scribe');
  assert.equal(ok.ok, true);
  assert.equal(ok.manifest.roles.length, 1);
  assert.equal(verifyTeamManifestHash(ok.manifest).ok, true);

  const last = removeTeamRole(ok.manifest, 'builder');
  assert.equal(last.ok, false);
  assert.ok(last.errors.some((e) => e.code === CODES.E_FLOOR_VIOLATION));

  const missing = removeTeamRole(two, 'phantom');
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.code === CODES.E_ROLE_NOT_FOUND));

  const live = removeTeamRole(two, 'scribe', { planRoleRefs: [{ role_id: 'scribe', file: '01-PLAN.md' }] });
  assert.equal(live.ok, false);
  assert.ok(live.errors.some((e) => e.code === CODES.E_ROLE_LIVE_IN_PLAN));
  assert.match(live.errors.find((e) => e.code === CODES.E_ROLE_LIVE_IN_PLAN).message, /01-PLAN\.md/);

  const forced = removeTeamRole(two, 'scribe', { planRoleRefs: ['scribe'], force: true });
  assert.equal(forced.ok, true);
  assert.ok(forced.warnings.some((w) => w.code === CODES.W_ROLE_LIVE_IN_PLAN));
});

test('swapTeamRole replaces in place, guards live plans, and refuses invalid results', () => {
  const two = parseTeamManifest(teamDoc([role('builder'), role('scribe', { owns: ['docs/**'] })])).manifest;

  const ok = swapTeamRole(two, 'scribe', role('perf-engineer', { owns: ['bench/**'] }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.manifest.roles.map((r) => r.id), ['builder', 'perf-engineer']);
  assert.equal(verifyTeamManifestHash(ok.manifest).ok, true);

  const collide = swapTeamRole(two, 'scribe', role('builder', { owns: ['bench/**'] }));
  assert.equal(collide.ok, false);
  assert.ok(collide.errors.some((e) => e.code === CODES.E_ROLE_EXISTS));

  const live = swapTeamRole(two, 'scribe', role('perf-engineer', { owns: ['bench/**'] }), { planRoleRefs: ['scribe'] });
  assert.equal(live.ok, false);
  assert.ok(live.errors.some((e) => e.code === CODES.E_ROLE_LIVE_IN_PLAN));

  const invalid = swapTeamRole(two, 'scribe', role('rival', { owns: ['src/builder/**'] }));
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((e) => e.code === CODES.E_OWNS_OVERLAP));

  assert.doesNotThrow(() => swapTeamRole(null, 1, undefined));
  assert.equal(swapTeamRole(null, 1, undefined).ok, false);
});

// ---------- serialize + hash stability ----------

test('serialize-parse roundtrip is lossless and the hash is stable across cycles', () => {
  const md = teamDoc([
    role('builder'),
    role('reviewer', { binding: { agent: 'ferrox-code-reviewer' }, tier: null, owns: [], reviews: ['src/**'], phase_scope: ['phase-2'] }),
  ]);
  const first = parseTeamManifest(md);
  assert.equal(first.ok, true);

  const again = serializeTeamManifest(first.manifest);
  const second = parseTeamManifest(again);
  assert.equal(second.ok, true);
  assert.equal(second.manifest.manifest_hash, first.manifest.manifest_hash, 'hash is stable across serialize cycles');
  assert.deepEqual(second.manifest.roles, first.manifest.roles);
});

test('serializeTeamManifest splices into existing markdown preserving surrounding prose bytes', () => {
  const fresh = teamDoc([role('builder')]);
  const wrapped = `# TEAM\n\nHand-written prose ABOVE stays.\n\n${fresh.slice(fresh.indexOf('```yaml team-manifest'))}\nHand-written prose BELOW stays.\n`;
  const parsed = parseTeamManifest(wrapped);
  assert.equal(parsed.ok, true);

  const grown = addTeamRole(parsed.manifest, role('scribe', { owns: ['docs/**'] }));
  const out = serializeTeamManifest(grown.manifest, wrapped);
  assert.ok(out.startsWith('# TEAM\n\nHand-written prose ABOVE stays.'));
  assert.ok(out.endsWith('Hand-written prose BELOW stays.\n'));
  const reparsed = parseTeamManifest(out);
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.manifest.roles.length, 2);
});

test('serializeTeamManifest never damages markdown it cannot handle', () => {
  const noBlock = '# Prose only\n\nNothing machine-owned here.\n';
  assert.equal(serializeTeamManifest({ garbage: true }, noBlock), noBlock);
  assert.equal(serializeTeamManifest(undefined), '');
});

test('computeTeamManifestHash never throws: non-manifest input returns null, valid manifests still hash', () => {
  for (const junk of [null, undefined, {}, 42, 'garbage', { roles: 'nope' }, { derived_from: {}, roles: [null] }]) {
    assert.doesNotThrow(() => computeTeamManifestHash(junk));
    assert.equal(computeTeamManifestHash(junk), null, `non-manifest input ${JSON.stringify(junk)} must hash to null`);
  }
  const m = parseTeamManifest(teamDoc([role('builder')])).manifest;
  assert.equal(computeTeamManifestHash(m), m.manifest_hash, 'a valid manifest still hashes to its declared hash');
});

test('verifyTeamManifestHash flags a drifted roster', () => {
  const m = parseTeamManifest(teamDoc([role('builder')])).manifest;
  assert.equal(verifyTeamManifestHash(m).ok, true);
  const drifted = { ...m, roles: [{ ...m.roles[0], charter: 'quietly rewritten charter text' }] };
  const v = verifyTeamManifestHash(drifted);
  assert.equal(v.ok, false);
  assert.notEqual(v.expected, v.actual);
  assert.deepEqual(verifyTeamManifestHash('garbage'), { ok: false, expected: null, actual: null });
});

// ---------- tracked-lib guard (the vendor-swallow lesson) ----------

test('compiled team-manifest.cjs is git-tracked like canon-facts.cjs (not swallowed by ignore rules)', () => {
  const out = spawnSync('git', ['ls-files', 'ferrox-core/bin/lib/team-manifest.cjs'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, `git ls-files failed: ${out.stderr}`);
  assert.match(out.stdout, /team-manifest\.cjs/, 'ferrox-core/bin/lib/team-manifest.cjs is not git-tracked; the ignore rules swallowed it');
});
