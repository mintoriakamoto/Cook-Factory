'use strict';

/**
 * End-to-end CLI integration/acceptance test for the Phase-6 trident + rtk verbs
 * (Plan 06), INJECTED-input only (no --live, no real codex/gemini/rtk spawn).
 *
 * Spawns `node ferrox-core/bin/ferrox-tools.cjs query trident.audit|rtk.wrap|rtk.report`
 * via child_process.spawnSync in a hermetic temp cwd whose `.planning/config.json`
 * carries the model block (trident_checkpoints = the two names, rtk.enabled). Proves
 * the full dispatch seam: dot-split -> case 'trident'/'rtk' -> the router -> the pure
 * Plan 03/04 core -> decision JSON on stdout at exit 0, with allowed checkpoints /
 * the rtk flag resolved from config and the panel / presence / output INJECTED.
 *
 * The anti-loop heart: trident.audit refuses --open-ended as 'unbounded-invocation'
 * over the CLI (T-06-06), refuses a caller-family-in-panel member (cross-lineage
 * exclusion), and refuses a bogus checkpoint — a single deterministic pass, no loop.
 *
 * All inputs are EXPLICIT (no Date.now anywhere), so decisions are deterministic.
 * One verb is invoked with a missing required flag to prove the InvalidArgs path
 * exits non-zero without a crash (T-06-12).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

/** Create a hermetic temp project dir with a real model block (checkpoints + rtk). */
function makeProject(rtkEnabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-trident-rtk-cli-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      {
        model: {
          trident_checkpoints: ['plan-lock-gap-audit', 'high-risk-wave-audit'],
          rtk: { enabled: rtkEnabled },
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

// ─── (a) trident.audit — valid bounded call, cross-lineage + consensus tagging ───

test('trident.audit completes a bounded cross-lineage audit and tags a consensus finding', () => {
  const cwd = makeProject();
  const panel = JSON.stringify([
    { family: 'codex', findings: ['missing-authz', 'weak-hash'] },
    { family: 'gemini', findings: ['missing-authz'] },
  ]);
  const r = runVerb(cwd, 'trident.audit', [
    '--caller-family', 'claude', '--checkpoint', 'plan-lock-gap-audit', '--panel', panel,
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'complete');
  assert.equal(r.json.pass, 'single', 'a single bounded pass — no loop');
  assert.ok(!r.json.panel_families.includes('claude'), 'the caller family is excluded from the panel');
  assert.ok(r.json.consensus.includes('missing-authz'), 'a finding raised by two families is consensus');
  assert.ok(r.json.contested.includes('weak-hash'), 'a single-family finding stays contested');
});

// ─── (b) trident.audit — caller family present in the panel is refused ───────────

test('trident.audit refuses a panel that includes the caller family (cross-lineage)', () => {
  const cwd = makeProject();
  const panel = JSON.stringify([
    { family: 'claude', findings: ['x'] },
    { family: 'gemini', findings: ['y'] },
  ]);
  const r = runVerb(cwd, 'trident.audit', [
    '--caller-family', 'claude', '--checkpoint', 'plan-lock-gap-audit', '--panel', panel,
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'refused');
  assert.equal(r.json.reason, 'caller-family-in-panel');
});

// ─── (c) trident.audit — an invalid checkpoint is refused ────────────────────────

test('trident.audit refuses a checkpoint outside the two allowed', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'trident.audit', [
    '--caller-family', 'claude', '--checkpoint', 'some-bogus', '--panel', '[]',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'refused');
  assert.equal(r.json.reason, 'invalid-checkpoint');
});

// ─── (d) trident.audit — an open-ended invocation is refused (anti-loop) ──────────

test('trident.audit refuses an --open-ended invocation as unbounded (the anti-loop bound)', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'trident.audit', [
    '--caller-family', 'claude', '--checkpoint', 'plan-lock-gap-audit', '--panel', '[]', '--open-ended',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'refused');
  assert.equal(r.json.reason, 'unbounded-invocation');
});

test('trident.audit refuses a --loop-until-clean invocation as unbounded', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'trident.audit', [
    '--caller-family', 'claude', '--checkpoint', 'plan-lock-gap-audit', '--panel', '[]', '--loop-until-clean',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'refused');
  assert.equal(r.json.reason, 'unbounded-invocation');
});

// ─── (e) rtk.wrap — enabled + present wraps; disabled OR absent passes through ────

test('rtk.wrap wraps the command when enabled AND rtk is present', () => {
  const cwd = makeProject(true);
  const r = runVerb(cwd, 'rtk.wrap', ['--command', 'git,status', '--rtk-present', 'true']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'wrap');
  assert.deepEqual(r.json.wrapped, ['rtk', 'git', 'status']);
});

test('rtk.wrap passes through unchanged when rtk is absent (graceful degrade)', () => {
  const cwd = makeProject(true);
  const r = runVerb(cwd, 'rtk.wrap', ['--command', 'git,status', '--rtk-present', 'false']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'passthrough');
  assert.deepEqual(r.json.wrapped, ['git', 'status'], 'the original command is unchanged');
});

test('rtk.wrap passes through unchanged when the flag is disabled in config', () => {
  const cwd = makeProject(false);
  const r = runVerb(cwd, 'rtk.wrap', ['--command', 'git,status', '--rtk-present', 'true']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'passthrough', 'a disabled flag never wraps even with rtk present');
  assert.deepEqual(r.json.wrapped, ['git', 'status']);
});

// ─── (f) rtk.report — parses the saved figure from rtk's own output ──────────────

test('rtk.report parses the saved-token figure from injected rtk output', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'rtk.report', ['--rtk-output', 'Tokens saved: 45,231 (73% reduction)']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.saved, 45231);
  assert.equal(r.json.pct, 73);
  assert.equal(r.json.source, 'rtk', 'the figure is echoed from rtk, never fabricated');
});

// ─── InvalidArgs — missing required flag exits non-zero without a crash ──────────

test('rtk.wrap with no --command exits non-zero via InvalidArgs (no crash)', () => {
  const cwd = makeProject();
  const r = runVerb(cwd, 'rtk.wrap', ['--rtk-present', 'true']);
  assert.notEqual(r.status, 0, 'a missing required flag must exit non-zero');
  assert.match(r.stderr, /Usage: ferrox-tools query rtk\.wrap/);
});
