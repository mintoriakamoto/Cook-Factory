'use strict';

/**
 * REACH-CODEX-01 / FF-B24 — the merge-gate guard registers on Codex PreToolUse
 * ALONGSIDE the context-monitor, and reinstall is idempotent.
 *
 * reconcileCodexHooksJsonEvent used to strip ALL managed hooks and add back one,
 * so registering the guard on PreToolUse clobbered the context-monitor. The
 * scoped-strip (`preserveOtherManaged` + `scriptName`) plus adding the guard to
 * the codex-hooks-json managed set fixes both: the guard co-exists with the
 * monitor, and reinstall dedups instead of accumulating.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const surface = require('../ferrox-core/bin/lib/runtime-hooks-surface.cjs');

const RUNNER = '/usr/bin/node';

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffb24-'));
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks', 'ferrox-context-monitor.js'), '//x');
  fs.writeFileSync(path.join(dir, 'hooks', 'ferrox-merge-gate-guard.js'), '//x');
  return dir;
}

// Mirror the install order: context-monitor first (default reconcile), then the
// guard with preserveOtherManaged.
function installOnce(dir) {
  surface.ensureCodexHooksJsonEvent(dir, 'PreToolUse', {
    absoluteRunner: RUNNER, platform: 'linux', scriptName: 'ferrox-context-monitor.js',
  });
  surface.ensureCodexHooksJsonEvent(dir, 'PreToolUse', {
    absoluteRunner: RUNNER, platform: 'linux', scriptName: 'ferrox-merge-gate-guard.js',
    preserveOtherManaged: true,
  });
}

function preToolUse(dir) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8'));
  return (j.hooks && j.hooks.PreToolUse) || [];
}

test('FF-B24: guard registers on PreToolUse WITHOUT clobbering context-monitor', () => {
  const dir = project();
  installOnce(dir);
  const s = JSON.stringify(preToolUse(dir));
  assert.ok(s.includes('ferrox-merge-gate-guard.js'), 'guard must be registered');
  assert.ok(s.includes('ferrox-context-monitor.js'), 'context-monitor must survive');
});

test('FF-B24: reinstall is idempotent (no accumulation)', () => {
  const dir = project();
  installOnce(dir);
  installOnce(dir);
  installOnce(dir);
  const pre = preToolUse(dir);
  const s = JSON.stringify(pre);
  assert.equal(pre.length, 2, 'exactly 2 PreToolUse entries after 3 installs');
  assert.equal((s.match(/merge-gate-guard/g) || []).length, 1, 'exactly one guard ref');
  assert.equal((s.match(/context-monitor/g) || []).length, 1, 'exactly one monitor ref');
});

test('FF-B24: removeCodexHooksJsonEvent strips the now-managed guard on uninstall', () => {
  const dir = project();
  installOnce(dir);
  surface.removeCodexHooksJsonEvent(dir, 'PreToolUse');
  let remains = false;
  try {
    remains = JSON.stringify(preToolUse(dir)).includes('merge-gate-guard');
  } catch { remains = false; } // hooks.json removed entirely == clean
  assert.equal(remains, false, 'guard must not survive uninstall');
});
