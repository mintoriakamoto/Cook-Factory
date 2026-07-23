'use strict';

/**
 * v1.13 Part 2 Wave 0 CLI integration tests.
 *
 *   model.resolve-tier -> FF-B26 thin wrap of the model-backend ladderModel
 *     lookup over config `model.tier_models` (A13). JSON output; a ladder
 *     miss carries a loud NOT IN LADDER notice.
 *   doctor -> the A14 team-manifest line: ok (N roles, M bound) / INVALID
 *     (first error) / none.
 *
 * Pattern: spawn `node ferrox-core/bin/ferrox-tools.cjs ...` in a hermetic
 * temp cwd (gate-first-verbs-cli pattern) and assert on the output shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');
const teamManifestLib = require('../ferrox-core/bin/lib/team-manifest.cjs');

function makeProject(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-wave0-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config, null, 2) + '\n');
  return dir;
}

function runCli(cwd, args) {
  const res = spawnSync(process.execPath, [FERROX_TOOLS, '--cwd', cwd, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function runVerb(cwd, verb, flags) {
  const res = runCli(cwd, ['query', verb, ...flags, '--raw']);
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = undefined;
  }
  return { ...res, json };
}

const LADDER_CONFIG = {
  model: {
    tier_models: {
      standard: 'flux-pinned-claude-fable-5',
      deep: 'flux-pinned-claude-opus-4-8',
    },
  },
};

test('model.resolve-tier resolves a ladder rung to its model id', () => {
  const cwd = makeProject(LADDER_CONFIG);
  const r = runVerb(cwd, 'model.resolve-tier', ['--tier', 'standard']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.tier, 'standard');
  assert.equal(r.json.modelId, 'flux-pinned-claude-fable-5');
  assert.equal(r.json.inLadder, true);
  assert.equal(r.json.reason, 'ok');
  assert.equal(r.json.notice, undefined);
});

test('model.resolve-tier is loud on a ladder miss and fails closed on a missing flag', () => {
  const cwd = makeProject(LADDER_CONFIG);
  const miss = runVerb(cwd, 'model.resolve-tier', ['--tier', 'mythic']);
  assert.equal(miss.status, 0, miss.stderr);
  assert.equal(miss.json.modelId, null);
  assert.equal(miss.json.inLadder, false);
  assert.equal(miss.json.reason, 'unknown-tier');
  assert.match(miss.json.notice, /NOT IN LADDER/);
  assert.match(miss.json.notice, /mythic/);

  const noFlag = runVerb(cwd, 'model.resolve-tier', []);
  assert.notEqual(noFlag.status, 0, 'a missing --tier must exit nonzero');
});

function validTeamMd(roles) {
  const manifest = {
    schema: 'team-manifest/v1',
    derived_from: { brainstorm: 'demo-topic-2026-07-23', milestone: 'v1.13' },
    manifest_hash: '',
    roles,
  };
  return teamManifestLib.serializeTeamManifest(manifest);
}

const INLINE_ROLE = {
  id: 'builder',
  charter: 'Own the src surface end to end and hand off with receipts.',
  rationale: 'the brief calls for a builder seat',
  non_redundancy: 'sole writer of the src surface',
  provenance: '(stance: guided, confirmed at exit)',
  binding: { inline: true },
  tier: 'standard',
  owns: ['src/**'],
  reviews: [],
};

const BOUND_ROLE = {
  id: 'reviewer',
  charter: 'Review every src change against the phase contract.',
  rationale: 'a second eye on the only write surface',
  non_redundancy: 'reviews, never writes',
  provenance: '(stance: guided, confirmed at exit)',
  binding: { agent: 'ferrox-code-reviewer' },
  owns: [],
  reviews: ['src/**'],
};

test('doctor reports team manifest: none when TEAM.md is absent', () => {
  const cwd = makeProject();
  const r = runCli(cwd, ['doctor']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /team manifest: none/);
});

test('doctor reports role and binding counts for a valid TEAM.md', () => {
  const cwd = makeProject();
  fs.writeFileSync(path.join(cwd, '.planning', 'TEAM.md'), validTeamMd([INLINE_ROLE, BOUND_ROLE]));
  const r = runCli(cwd, ['doctor']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /team manifest: ok \(2 roles, 1 bound\)/);
});

test('doctor injects the catalog agent roster: a ghost-bound role degrades and never counts as bound', () => {
  const cwd = makeProject();
  const ghost = { ...BOUND_ROLE, binding: { agent: 'ghost-agent-nobody-ships' } };
  fs.writeFileSync(path.join(cwd, '.planning', 'TEAM.md'), validTeamMd([INLINE_ROLE, ghost]));
  const r = runCli(cwd, ['doctor']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /team manifest: ok \(2 roles, 0 bound\)/,
    'W_UNKNOWN_AGENT must degrade the ghost seat to the inline rung in the bound count'
  );
});

test('doctor reports the first error for an invalid TEAM.md', () => {
  const cwd = makeProject();
  // All-letter hex: an unquoted all-digit scalar would YAML-parse as a number.
  const stale = validTeamMd([INLINE_ROLE]).replace(/manifest_hash: [0-9a-f]{64}/, `manifest_hash: ${'f'.repeat(64)}`);
  fs.writeFileSync(path.join(cwd, '.planning', 'TEAM.md'), stale);
  const r = runCli(cwd, ['doctor']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /team manifest: INVALID \(manifest_hash/);
});
