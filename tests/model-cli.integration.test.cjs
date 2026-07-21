'use strict';

/**
 * End-to-end CLI integration/acceptance test for the three Phase-6 model verbs
 * (Plan 05).
 *
 * Spawns `node ferrox-core/bin/ferrox-tools.cjs query model.<verb> <flags>` via
 * child_process.spawnSync in a hermetic temp cwd whose `.planning/config.json`
 * carries a real model block (stage_tiers map, tier_order small/mid/frontier,
 * max_escalations 1, the six risk boundaries). Proves the full dispatch seam:
 * dot-split -> case 'model' -> routeModelCommand -> the Plan 02 core -> decision
 * JSON on stdout at exit 0, with the operator's model.* block resolved from config.
 *
 * All inputs are EXPLICIT (no Date.now anywhere in the path), so the decisions are
 * deterministic. model.route with NO --stage / --dump proves the InvalidArgs path
 * exits non-zero without a crash (threat T-06-12).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

/** Create a hermetic temp project dir with a real model block. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-model-cli-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      {
        model: {
          stage_tiers: {
            verify: 'frontier',
            plan: 'frontier',
            build: 'mid',
            execute: 'mid',
            grunt: 'small',
          },
          default_tier: 'mid',
          tier_order: ['small', 'mid', 'frontier'],
          max_escalations: 1,
          risk_boundaries: ['auth', 'crypto', 'payments', 'pii', 'deserialization', 'network-file'],
        },
      },
      null,
      2,
    ) + '\n',
  );
  return dir;
}

/** Spawn a ferrox-tools query verb; return { status, json, stdout, stderr }. */
function runVerb(cwd, verb, flags) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags, '--raw'],
    { encoding: 'utf8' },
  );
  let json;
  try {
    json = JSON.parse(res.stdout.trim());
  } catch {
    json = undefined;
  }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

// ─── (a) model.route — config-resolved stage -> tier + inspectable dump ──────────

test('model.route resolves a config stage to its tier over the CLI at exit 0', () => {
  const cwd = makeProject();
  const verify = runVerb(cwd, 'model.route', ['--stage', 'verify']);
  const build = runVerb(cwd, 'model.route', ['--stage', 'build']);
  const grunt = runVerb(cwd, 'model.route', ['--stage', 'grunt']);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(verify.json.tier, 'frontier', 'verify routes to frontier');
  assert.equal(build.json.tier, 'mid', 'build routes to the mid workhorse');
  assert.equal(grunt.json.tier, 'small', 'grunt routes to the small tier');
});

test('model.route --dump returns the whole inspectable stage->tier map', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.route', ['--dump']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json.map && typeof r.json.map === 'object', `expected a map object, got: ${r.stdout}`);
  assert.equal(r.json.map.verify, 'frontier');
  assert.equal(r.json.map.grunt, 'small');
});

// ─── (b) model.escalate — the one-hop cap over the CLI ───────────────────────────

test('model.escalate allows exactly one hop and refuses the second over the CLI', () => {
  const cwd = makeProject();
  const first = runVerb(cwd, 'model.escalate', ['--from', 'small', '--attempt', '1']);
  const second = runVerb(cwd, 'model.escalate', ['--from', 'mid', '--attempt', '2']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.json.decision, 'escalate');
  assert.equal(first.json.tier, 'mid', 'small escalates one hop to mid');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.json.decision, 'refused', 'a second escalation is capped (one-hop)');
});

// ─── (c) model.risk-grade — boundary overrides self-grade ────────────────────────

test('model.risk-grade forces high-risk on a boundary path, overriding a low self-grade', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.risk-grade', ['--paths', 'src/auth/login.ts', '--self-grade', 'low']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.grade, 'high-risk', 'a boundary path cannot self-downgrade');
  assert.equal(r.json.forcesFrontier, true);
  assert.equal(r.json.forcesTrident, true);
  assert.ok(r.json.matched.includes('auth'));
});

test('model.risk-grade returns the self-grade for a benign path', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.risk-grade', ['--paths', 'src/util/format.ts', '--self-grade', 'low']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.grade, 'low', 'a non-boundary path keeps the self-grade');
  assert.equal(r.json.forcesFrontier, false);
  assert.equal(r.json.forcesTrident, false);
  assert.deepEqual(r.json.matched, []);
});

// ─── InvalidArgs — missing required flag exits non-zero without a crash ──────────

test('model.route with no --stage and no --dump exits non-zero via InvalidArgs (no crash)', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'model.route', []);
  assert.notEqual(r.status, 0, 'a missing route target must exit non-zero');
  assert.match(r.stderr, /Usage: ferrox-tools query model\.route/);
});
