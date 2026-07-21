'use strict';

/**
 * RED→GREEN regression for CRITICAL-1: `halting.*` config is silently dropped.
 *
 * Pre-fix, config-loader.cjs curated `_baseConfig` never copied the `halting`
 * block, so `loadConfig(cwd).halting` was `undefined` and every per-gate
 * `cap_outcome` / `max_passes` / `wall_clock_seconds`, `rescope.max_attempts`,
 * `human_sla_seconds` and `ship_clock_seconds` override was inert — the cap
 * verbs ran on hard-coded fallbacks regardless of what the operator configured.
 *
 * These tests use NON-DEFAULT values (cap_outcome != stop-and-rescope, budgets
 * != 86400, max_passes != 3, wall_clock != 1800, max_attempts != 2) and assert
 * the CONFIGURED values survive resolution — both at the loadConfig seam and
 * end-to-end through the `gate.cap-check` CLI. Every one of these FAILS before
 * the loader fix (cfg.halting undefined) and passes after it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadConfig } = require('../ferrox-core/bin/lib/config-loader.cjs');
const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

// Deliberately NON-DEFAULT everywhere so a fallback can never masquerade as a
// resolved value.
const NON_DEFAULT_HALTING = {
  gates: {
    'plan-check': {
      max_passes: 9, // fallback is 3
      wall_clock_seconds: 60, // fallback is 1800
      cap_outcome: 'ship-with-backlog', // fallback is stop-and-rescope
    },
  },
  rescope: { max_attempts: 5 }, // fallback is 2
  human_sla_seconds: 120, // fallback is 86400
  ship_clock_seconds: 120, // fallback is 86400
};

function makeProject(halting) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-halting-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ halting }, null, 2) + '\n',
  );
  return dir;
}

function runVerb(cwd, verb, flags) {
  const res = spawnSync(
    process.execPath,
    [FERROX_TOOLS, '--cwd', cwd, 'query', verb, ...flags, '--raw'],
    { encoding: 'utf8' },
  );
  let json;
  try { json = JSON.parse(res.stdout.trim()); } catch { json = undefined; }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

test('loadConfig propagates the whole halting block (CRITICAL-1)', () => {
  const cwd = makeProject(NON_DEFAULT_HALTING);
  const cfg = loadConfig(cwd);
  assert.ok(cfg.halting && typeof cfg.halting === 'object', 'halting block must be resolved, not dropped');
  assert.deepEqual(cfg.halting.gates['plan-check'], {
    max_passes: 9,
    wall_clock_seconds: 60,
    cap_outcome: 'ship-with-backlog',
  });
  assert.equal(cfg.halting.rescope.max_attempts, 5);
  assert.equal(cfg.halting.human_sla_seconds, 120);
  assert.equal(cfg.halting.ship_clock_seconds, 120);
});

test('a partial halting block still resolves defaults for the untouched keys', () => {
  // Operator only overrides the ship clock; the rest must fall back to manifest
  // defaults rather than vanishing.
  const cwd = makeProject({ ship_clock_seconds: 300 });
  const cfg = loadConfig(cwd);
  assert.ok(cfg.halting && typeof cfg.halting === 'object');
  assert.equal(cfg.halting.ship_clock_seconds, 300, 'configured value wins');
  assert.equal(cfg.halting.human_sla_seconds, 86400, 'untouched key keeps its default');
  assert.equal(cfg.halting.rescope.max_attempts, 2, 'untouched nested default preserved');
});

test('gate.cap-check honors a configured non-default cap_outcome and wall-clock budget', () => {
  const cwd = makeProject(NON_DEFAULT_HALTING);
  // passes (0) is under max_passes (9), so ONLY the 60s wall-clock can fire.
  // now-ts 61s > 60s budget -> wall-clock trigger -> the CONFIGURED cap_outcome.
  const r = runVerb(cwd, 'gate.cap-check', [
    '--gate', 'plan-check', '--increment', 'INC-CFG',
    '--passes', '0', '--start-ts', '0', '--now-ts', '61000',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json, `expected JSON, got: ${r.stdout}`);
  assert.equal(r.json.trigger, 'wall-clock', 'the configured 60s budget must fire at 61s');
  assert.equal(r.json.decision, 'ship-with-backlog', 'the configured cap_outcome must be returned, not the fallback');
  assert.equal(r.json.cap_outcome, 'ship-with-backlog');
});

test('gate.cap-check stays green under the configured budget (no premature fire)', () => {
  const cwd = makeProject(NON_DEFAULT_HALTING);
  // 59s < 60s budget and 0 < 9 passes -> continue.
  const r = runVerb(cwd, 'gate.cap-check', [
    '--gate', 'plan-check', '--increment', 'INC-CFG2',
    '--passes', '0', '--start-ts', '0', '--now-ts', '59000',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'continue');
  assert.equal(r.json.trigger, 'none');
});
