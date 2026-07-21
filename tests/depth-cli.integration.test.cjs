'use strict';

/**
 * FAST-01/FAST-02 end-to-end CLI integration — strength.depth-decide + the
 * depth-aware strength.merge-gate (v1.2 Fast Path).
 *
 * Locks the full seam in a hermetic git temp project:
 *   1. depth-decide RECORDS a persisted, auditable decision (fail-toward-full
 *      core, config-resolved risk boundaries);
 *   2. merge-gate --depth fast PASSES with NO receipts and NO mutation flags
 *      when the persisted decision is fast and the actual files re-grade clean;
 *   3. anti-gaming: claiming fast while --files touches a boundary -> the
 *      re-grade mismatches -> depth-decision-not-valid -> block;
 *   4. the ratchet (FAST-02): a fast-path BLOCK marks the requirement
 *      escalated, and the NEXT depth-decide returns full;
 *   5. zero regression: without --depth the gate still demands receipts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

/** Hermetic git temp project with strength stores + a coverage baseline. */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-depth-cli-'));
  fs.mkdirSync(path.join(dir, '.planning', 'strength'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ model: {}, strength: {} }, null, 2) + '\n',
  );
  // REQUIREMENTS.md with one COVERED requirement (`- [x]`) so coverage-delta
  //  lands (after=1 > before=0); coverage-source counts checkboxes, not tables.
  fs.writeFileSync(
    path.join(dir, '.planning', 'REQUIREMENTS.md'),
    '# Requirements\n\n- [x] **FAST-99** — test req\n',
  );
  fs.writeFileSync(
    path.join(dir, '.planning', 'strength', 'coverage-baseline.json'),
    JSON.stringify({ covered: 0 }) + '\n',
  );
  fs.writeFileSync(path.join(dir, '.planning', 'BACKLOG.md'), '# Backlog\n');
  execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', {
    cwd: dir,
  });
  return dir;
}

function runVerb(cwd, verb, flags) {
  const r = spawnSync(process.execPath, [FERROX_TOOLS, 'query', verb, ...flags, '--raw'], {
    cwd,
    encoding: 'utf8',
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    /* leave null */
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

/** The cheap-gate evidence flags every merge-gate call needs (fast or full). */
function baseGateFlags() {
  return [
    '--increment', 'INC-1',
    '--requirements', 'FAST-99',
    '--declared', 'src/ui/button.ts',
    '--actual', 'src/ui/button.ts',
    '--files', 'src/ui/button.ts',
    '--opened', '0',
    '--resolved', '0',
  ];
}

test('depth-decide records a fast decision for a clean increment', () => {
  const dir = makeProject();
  const r = runVerb(dir, 'strength.depth-decide', [
    '--requirement', 'FAST-99',
    '--paths', 'src/ui/button.ts',
    '--categories', 'frontend',
    '--self-grade', 'standard',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.depth, 'fast');
  assert.deepEqual(r.json.reasons, []);
  // persisted + auditable
  const store = JSON.parse(
    fs.readFileSync(path.join(dir, '.planning', 'strength', 'depth-decisions.json'), 'utf8'),
  );
  assert.equal(store.decisions['FAST-99'].depth, 'fast');
});

test('depth-decide forces full on a boundary path (config-default boundaries)', () => {
  const dir = makeProject();
  const r = runVerb(dir, 'strength.depth-decide', [
    '--requirement', 'FAST-99',
    '--paths', 'src/auth/login.ts',
    '--categories', 'backend',
    '--self-grade', 'standard',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.depth, 'full');
  assert.ok(r.json.reasons.includes('risk-boundary'));
});

test('merge-gate --depth fast PASSES with no receipts and no mutation flags', () => {
  const dir = makeProject();
  runVerb(dir, 'strength.depth-decide', [
    '--requirement', 'FAST-99',
    '--paths', 'src/ui/button.ts',
    '--categories', 'frontend',
    '--self-grade', 'standard',
  ]);
  const r = runVerb(dir, 'strength.merge-gate', [...baseGateFlags(), '--depth', 'fast']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'pass', JSON.stringify(r.json));
});

test('ANTI-GAMING: fast claim + boundary file in --files -> re-grade mismatch -> block', () => {
  const dir = makeProject();
  runVerb(dir, 'strength.depth-decide', [
    '--requirement', 'FAST-99',
    '--paths', 'src/ui/button.ts',
    '--categories', 'frontend',
    '--self-grade', 'standard',
  ]);
  const flags = baseGateFlags();
  // the ACTUAL merge touches auth — the decider never saw it
  flags[flags.indexOf('src/ui/button.ts')] = 'src/auth/login.ts'; // --declared
  flags[flags.indexOf('src/ui/button.ts')] = 'src/auth/login.ts'; // --actual
  flags[flags.indexOf('src/ui/button.ts')] = 'src/auth/login.ts'; // --files
  const r = runVerb(dir, 'strength.merge-gate', [...flags, '--depth', 'fast']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block');
  assert.ok(r.json.reasons.includes('depth-decision-not-valid'), JSON.stringify(r.json));
});

test('fast claim with NO persisted decision -> block: depth-decision-not-valid', () => {
  const dir = makeProject();
  const r = runVerb(dir, 'strength.merge-gate', [...baseGateFlags(), '--depth', 'fast']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block');
  assert.ok(r.json.reasons.includes('depth-decision-not-valid'));
});

test('RATCHET (FAST-02): a fast-path block escalates; next depth-decide returns full', () => {
  const dir = makeProject();
  runVerb(dir, 'strength.depth-decide', [
    '--requirement', 'FAST-99',
    '--paths', 'src/ui/button.ts',
    '--categories', 'frontend',
    '--self-grade', 'standard',
  ]);
  // Force a block on the fast path (open critical finding via --findings).
  const blocked = runVerb(dir, 'strength.merge-gate', [
    ...baseGateFlags(),
    '--depth', 'fast',
    '--findings', JSON.stringify([{ category: 'correctness', severity: 'critical' }]),
  ]);
  assert.equal(blocked.json.decision, 'block');
  // The ratchet must have marked the requirement escalated: full from now on.
  const again = runVerb(dir, 'strength.depth-decide', [
    '--requirement', 'FAST-99',
    '--paths', 'src/ui/button.ts',
    '--categories', 'frontend',
    '--self-grade', 'standard',
  ]);
  assert.equal(again.json.depth, 'full');
  assert.ok(again.json.reasons.includes('gate-failure-ratchet'), JSON.stringify(again.json));
});

test('ZERO REGRESSION: without --depth the gate still demands receipts + mutation flags', () => {
  const dir = makeProject();
  const r = runVerb(dir, 'strength.merge-gate', [
    ...baseGateFlags(),
    '--mutation-test', 'tests/x.test.cjs',
    '--mutation-flipped', 'true',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decision, 'block');
  assert.ok(r.json.reasons.includes('receipts-not-valid'));
});

test('depth-decide with missing --requirement exits non-zero (InvalidArgs)', () => {
  const dir = makeProject();
  const r = runVerb(dir, 'strength.depth-decide', ['--paths', 'a.ts']);
  assert.notEqual(r.status, 0);
});
