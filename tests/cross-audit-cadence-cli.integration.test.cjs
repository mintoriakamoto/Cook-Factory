'use strict';

/**
 * XAUD-01 end-to-end CLI — strength.cross-audit-cadence through ferrox-tools (v1.6).
 * Locks the verb wiring: flag parsing + config-resolved max-phases + the pure decider.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FERROX_TOOLS = path.join(__dirname, '..', 'ferrox-core', 'bin', 'ferrox-tools.cjs');

function project(strength) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xaud-cli-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ strength: strength || {} }, null, 2) + '\n');
  return dir;
}
function run(dir, flags) {
  return spawnSync(process.execPath,
    [FERROX_TOOLS, 'query', 'strength.cross-audit-cadence', ...flags, '--raw'],
    { cwd: dir, encoding: 'utf8' });
}

test('milestone-complete -> crossAudit true (XAUD-01 CLI)', () => {
  const r = run(project(), ['--event', 'milestone-complete']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).crossAudit, true);
});

test('mid-milestone plain phase defers (false)', () => {
  const r = run(project(), ['--event', 'phase-complete', '--phases-since-audit', '2']);
  assert.equal(JSON.parse(r.stdout).crossAudit, false);
});

test('config strength.cross_audit_max_phases tightens the trigger', () => {
  // max=2 -> a phase 2 since last audit now trips (would defer under the default 5)
  const r = run(project({ cross_audit_max_phases: 2 }), ['--event', 'phase-complete', '--phases-since-audit', '2']);
  assert.equal(JSON.parse(r.stdout).crossAudit, true);
  assert.match(JSON.parse(r.stdout).reason, /max-phases/);
});

test('missing --event fails closed (non-zero, no crash)', () => {
  const r = run(project(), ['--phases-since-audit', '1']);
  assert.notEqual(r.status, 0);
});
