'use strict';

/**
 * REACH-CODEX-01 (v1.1 Phase D) — the merge-gate guard must recognize a merge
 * run through a NON-Claude shell tool shape.
 *
 * Claude Code names the shell tool 'Bash' with a string `command`. Codex /
 * opencode / other AGENTS.md runtimes name it 'shell'/'Shell'/'local_shell' and
 * may pass the command as an argv ARRAY. Before the runtime-agnostic
 * extractShellCommand fix, a Codex `git merge` fell through to the MCP-tool
 * classifier, was NOT recognized as a merge, and exited 0 (UNGATED). This locks
 * the fix: a Codex-shaped merge is classified as a merge op and fails closed
 * (exit 2) when no valid gate evidence is present — parity with Claude's Bash.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'ferrox-merge-gate-guard.js');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-codex-guard-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
  // A Ferrox strength-gated project: the guard only enforces where this exists.
  fs.mkdirSync(path.join(dir, '.planning', 'strength'), { recursive: true });
  return dir;
}

function runHook(event) {
  const res = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(event), encoding: 'utf8' });
  return res.status;
}

test('REACH-CODEX-01: a Codex shell merge (argv ARRAY) is gated → blocks (exit 2)', () => {
  const cwd = tmpProject();
  const status = runHook({ tool_name: 'shell', tool_input: { command: ['git', 'merge', 'main'] }, cwd });
  assert.equal(status, 2, 'Codex-shaped array-command merge must be classified as a merge and fail closed');
});

test('REACH-CODEX-01: a Codex shell merge (string command) blocks too', () => {
  const cwd = tmpProject();
  const status = runHook({ tool_name: 'Shell', tool_input: { command: 'git merge --no-ff feature' }, cwd });
  assert.equal(status, 2);
});

test('REACH-CODEX-01: local_shell name is also recognized', () => {
  const cwd = tmpProject();
  const status = runHook({ tool_name: 'local_shell', tool_input: { command: ['git', 'merge', 'x'] }, cwd });
  assert.equal(status, 2);
});

test('REACH-CODEX-01: a Codex NON-merge shell command passes through (exit 0)', () => {
  const cwd = tmpProject();
  for (const command of [['ls', '-la'], ['git', 'status'], ['npm', 'test']]) {
    const status = runHook({ tool_name: 'shell', tool_input: { command }, cwd });
    assert.equal(status, 0, `'${command.join(' ')}' must pass through, got ${status}`);
  }
});

test('REACH-CODEX-01 (regression): Claude Bash merge still blocks', () => {
  const cwd = tmpProject();
  const status = runHook({ tool_name: 'Bash', tool_input: { command: 'git merge main' }, cwd });
  assert.equal(status, 2);
});

test('scope guard: a merge in a NON-Ferrox project (no .planning/strength/) passes through', () => {
  // A coexisting GSD project or any repo that never opted into Ferrox gating: the
  // globally-installed guard must NOT block its merges (exit 0), else Ferrox would
  // fail-close unrelated work.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-nongated-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}'); // GSD-style: .planning/ but no strength/
  const status = runHook({ tool_name: 'shell', tool_input: { command: ['git', 'merge', 'main'] }, cwd: dir });
  assert.equal(status, 0, 'non-Ferrox project merge must pass through, not block');
});
