'use strict';

/**
 * Local Claude uninstall symmetry test (FF-B511 regression guard).
 *
 * ## Why this exists
 *
 * A LOCAL Claude install registers its managed hooks in
 * `.claude/settings.local.json` — the #338 privacy split, so engineer-specific
 * absolute paths never land in the repo-shared `settings.json`. See the
 * `isLocalClaude` branch in `install()` (bin/install.js, `settingsFileByScope`).
 *
 * The uninstall path cleaned ONLY `path.join(targetDir, 'settings.json')`. It
 * deleted the hook FILES (`FERROX_UNINSTALL_HOOKS`) and left every registration
 * in `settings.local.json` behind. The result was a project where each of the 15
 * registered hooks pointed at a deleted file, so every tool call in that project
 * invoked missing paths.
 *
 * Two independent drifts produced it:
 *
 *   1. The removal target (`settings.json`, hardcoded) had drifted from the
 *      registration target (`hostBehaviors.settingsFileByScope`).
 *   2. `ferrox-worktree-path-guard.js` and `ferrox-graphify-update.sh` ARE
 *      registered by `applySettingsJsonHooks` but were absent from
 *      `MANAGED_HOOK_COMMAND_BASENAMES_BY_SURFACE['settings-json']`, so the
 *      per-hook strip walked past them even on the file it did clean. That one
 *      also affected GLOBAL installs.
 *
 * ## Non-vacuity is load-bearing
 *
 * "The non-Ferrox hooks and permissions survived" is vacuously true of a file
 * that had none, and "every registered hook path exists" is vacuously true of
 * zero registrations. Every arm below asserts its baseline counts are > 0 BEFORE
 * asserting anything about the outcome.
 *
 * ## Scratch only
 *
 * Every install goes to an `fs.mkdtempSync` directory with HOME, USERPROFILE and
 * CLAUDE_CONFIG_DIR all redirected inside it. The developer's real ~/.claude is
 * never read, written or otherwise touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const INSTALL_JS = path.join(REPO_ROOT, 'bin', 'install.js');

/**
 * Every scratch root this file creates, torn down in ONE place after the run.
 * A single cleanup site with the Windows EBUSY retry budget, matching the
 * established pattern in this suite.
 */
const SCRATCH_ROOTS = [];

test.after(() => {
  for (const root of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* a scratch tree that will not delete is not a test failure */
    }
  }
});

/** Non-Ferrox hook commands pre-seeded into the scratch settings file. */
const USER_HOOKS = Object.freeze({
  PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/my-own-guard.sh' }] },
  ],
  PostToolUse: [
    { matcher: '*', hooks: [{ type: 'command', command: 'node /opt/tooling/other-vendor-post.js' }] },
  ],
  SessionStart: [
    { hooks: [{ type: 'command', command: 'echo user-session-hook' }] },
  ],
});

/** Non-Ferrox permission entries pre-seeded into the scratch settings file. */
const USER_ALLOW = Object.freeze(['Bash(rtk:*)', 'Bash(gh pr view:*)', 'Read(//tmp/**)']);
const USER_DENY = Object.freeze(['Bash(curl:*)', 'Read(//etc/shadow)']);

function seedSettings() {
  return {
    worktree: { baseRef: 'head' },
    hooks: JSON.parse(JSON.stringify(USER_HOOKS)),
    permissions: { allow: [...USER_ALLOW], deny: [...USER_DENY] },
    myCustomKey: { keepMe: true },
  };
}

/**
 * Create a scratch project plus an isolated fake HOME. The user's own hook
 * script is written to disk so any missing path the orphan arm reports is
 * unambiguously a Ferrox orphan rather than a fixture artifact.
 */
function makeScratch(seed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-b511-'));
  const proj = path.join(root, 'proj');
  const fakeHome = path.join(root, 'home');
  fs.mkdirSync(path.join(proj, '.claude', 'hooks'), { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'hooks', 'my-own-guard.sh'), '#!/bin/sh\nexit 0\n');
  if (seed !== undefined) {
    fs.writeFileSync(
      path.join(proj, '.claude', 'settings.local.json'),
      typeof seed === 'string' ? seed : JSON.stringify(seed, null, 2) + '\n',
    );
  }
  SCRATCH_ROOTS.push(root);
  return { root, proj, fakeHome, settings: path.join(proj, '.claude', 'settings.local.json') };
}

/**
 * Spawn install.js with a SCRUBBED env so no ambient runtime config dir can leak
 * in and reach the developer's real install.
 */
function runInstaller(scratch, args) {
  return spawnSync(process.execPath, [INSTALL_JS, ...args], {
    cwd: scratch.proj,
    env: {
      PATH: process.env.PATH,
      HOME: scratch.fakeHome,
      USERPROFILE: scratch.fakeHome,
      CLAUDE_CONFIG_DIR: path.join(scratch.fakeHome, '.claude'),
    },
    encoding: 'utf8',
  });
}

/** Flatten a settings object's hook table to [event, command] pairs. */
function hookCommands(settings) {
  const out = [];
  for (const [event, entries] of Object.entries((settings && settings.hooks) || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of ((entry && entry.hooks) || [])) {
        out.push([event, hook && hook.command]);
      }
    }
  }
  return out;
}

const isFerrox = ([, command]) => /ferrox-/.test(String(command || ''));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Resolve the on-disk path a `$CLAUDE_PROJECT_DIR`-anchored hook command points
 * at, or null when the command is not project-anchored.
 */
function anchoredHookPath(projectDir, command) {
  const m = String(command || '').match(/\$CLAUDE_PROJECT_DIR"?\/([^\s"']+)/);
  return m ? path.join(projectDir, m[1]) : null;
}

test('FF-B511: local Claude uninstall strips Ferrox hooks from settings.local.json and preserves everything else', () => {
  const scratch = makeScratch(seedSettings());

  // NON-VACUITY: the fixture really does carry non-Ferrox content to preserve.
  const seeded = readJson(scratch.settings);
  const seededUserHooks = hookCommands(seeded);
  assert.ok(seededUserHooks.length > 0, 'fixture must seed at least one non-Ferrox hook command');
  assert.equal(seededUserHooks.filter(isFerrox).length, 0, 'fixture hooks must all be non-Ferrox');
  assert.ok(seeded.permissions.allow.length > 0, 'fixture must seed at least one allow entry');
  assert.ok(seeded.permissions.deny.length > 0, 'fixture must seed at least one deny entry');

  const install = runInstaller(scratch, ['--claude', '--local']);
  assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);

  // NON-VACUITY: the install really did register Ferrox hooks in THIS file, so
  // the post-uninstall assertion has something to have removed.
  const afterInstall = hookCommands(readJson(scratch.settings));
  assert.ok(
    afterInstall.filter(isFerrox).length > 0,
    'install must register Ferrox hooks in settings.local.json',
  );

  const uninstall = runInstaller(scratch, ['--claude', '--local', '--uninstall']);
  assert.equal(uninstall.status, 0, `uninstall failed:\n${uninstall.stdout}\n${uninstall.stderr}`);

  const after = readJson(scratch.settings);
  const remaining = hookCommands(after);

  // (a) ZERO remaining registrations referencing a Ferrox hook path.
  const orphans = remaining.filter(isFerrox);
  assert.deepEqual(
    orphans.map(([event, command]) => `${event}: ${command}`),
    [],
    'uninstall must leave no Ferrox hook registrations in settings.local.json',
  );

  // (b) The non-Ferrox hooks and permissions are unchanged.
  assert.deepEqual(after.hooks, JSON.parse(JSON.stringify(USER_HOOKS)), 'user hooks must be byte-identical');
  assert.deepEqual(after.permissions.allow, [...USER_ALLOW], 'user allow entries must be byte-identical');
  assert.deepEqual(after.permissions.deny, [...USER_DENY], 'user deny entries must be byte-identical');

  // Unrelated top-level keys survive untouched.
  assert.deepEqual(after.worktree, { baseRef: 'head' }, 'worktree key must survive');
  assert.deepEqual(after.myCustomKey, { keepMe: true }, 'unrelated user keys must survive');

});

test('FF-B511: after uninstall every hook path still registered in settings.local.json exists on disk', () => {
  const scratch = makeScratch(seedSettings());

  const install = runInstaller(scratch, ['--claude', '--local']);
  assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);

  // NON-VACUITY: the installed state must contain project-anchored registrations,
  // otherwise the property below is trivially satisfied.
  const installedAnchored = hookCommands(readJson(scratch.settings))
    .map(([, command]) => anchoredHookPath(scratch.proj, command))
    .filter(Boolean);
  assert.ok(installedAnchored.length > 0, 'install must produce project-anchored hook registrations');

  const uninstall = runInstaller(scratch, ['--claude', '--local', '--uninstall']);
  assert.equal(uninstall.status, 0, `uninstall failed:\n${uninstall.stdout}\n${uninstall.stderr}`);

  const remaining = hookCommands(readJson(scratch.settings));
  const remainingAnchored = remaining
    .map(([event, command]) => [event, anchoredHookPath(scratch.proj, command)])
    .filter(([, resolved]) => resolved !== null);

  // NON-VACUITY: at least one anchored registration must SURVIVE (the user's own
  // hook), so "all of them exist" is a real claim about a non-empty set.
  assert.ok(
    remainingAnchored.length > 0,
    'at least one project-anchored registration must survive so this property is non-vacuous',
  );

  const missing = remainingAnchored
    .filter(([, resolved]) => !fs.existsSync(resolved))
    .map(([event, resolved]) => `${event}: ${resolved}`);
  assert.deepEqual(missing, [], 'every registered hook path must exist on disk after uninstall');

});

test('FF-B511: uninstall is idempotent — a second run exits 0 and leaves the file byte-identical', () => {
  const scratch = makeScratch(seedSettings());

  const install = runInstaller(scratch, ['--claude', '--local']);
  assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);

  const first = runInstaller(scratch, ['--claude', '--local', '--uninstall']);
  assert.equal(first.status, 0, `first uninstall failed:\n${first.stdout}\n${first.stderr}`);
  const afterFirst = fs.readFileSync(scratch.settings, 'utf8');

  // NON-VACUITY: there is a real file with real content to keep stable.
  assert.ok(afterFirst.length > 0, 'settings.local.json must still have content after the first uninstall');
  assert.ok(hookCommands(JSON.parse(afterFirst)).length > 0, 'surviving user hooks must remain to be preserved');

  const second = runInstaller(scratch, ['--claude', '--local', '--uninstall']);
  assert.equal(second.status, 0, `second uninstall failed:\n${second.stdout}\n${second.stderr}`);
  assert.equal(
    fs.readFileSync(scratch.settings, 'utf8'),
    afterFirst,
    'a second uninstall must not modify settings.local.json',
  );

});

test('FF-B511: absent, empty and malformed settings.local.json do not crash the uninstall', () => {
  for (const [label, seed] of [
    ['absent', undefined],
    ['empty', ''],
    ['malformed', '{ "hooks": { broken,,, }'],
  ]) {
    const scratch = makeScratch(seed);
    const install = runInstaller(scratch, ['--claude', '--local']);
    assert.equal(install.status, 0, `[${label}] install failed:\n${install.stdout}\n${install.stderr}`);

    const uninstall = runInstaller(scratch, ['--claude', '--local', '--uninstall']);
    assert.equal(
      uninstall.status, 0,
      `[${label}] uninstall must exit 0:\n${uninstall.stdout}\n${uninstall.stderr}`,
    );
    // A malformed file is reported and skipped, never rewritten or deleted.
    if (label === 'malformed') {
      assert.equal(
        fs.readFileSync(scratch.settings, 'utf8'),
        '{ "hooks": { broken,,, }',
        'a malformed settings.local.json must be left exactly as the user wrote it',
      );
    }
  }
});

test('FF-B511 fence: a project with no local install is untouched by uninstall', () => {
  const scratch = makeScratch(seedSettings());
  const before = fs.readFileSync(scratch.settings, 'utf8');

  // NON-VACUITY: the fence file really carries content that could be damaged.
  const parsed = JSON.parse(before);
  assert.ok(hookCommands(parsed).length > 0, 'fence fixture must carry hook commands');
  assert.ok(parsed.permissions.allow.length > 0, 'fence fixture must carry allow entries');

  // No install has ever run in this project — only global hooks would apply.
  const uninstall = runInstaller(scratch, ['--claude', '--local', '--uninstall']);
  assert.equal(uninstall.status, 0, `uninstall failed:\n${uninstall.stdout}\n${uninstall.stderr}`);

  assert.equal(
    fs.readFileSync(scratch.settings, 'utf8'),
    before,
    'uninstalling from a project with no local install must not modify settings.local.json',
  );

});

test('FF-B511: every hook basename registered into the settings-json surface is strippable', () => {
  // Guards drift #2 directly and structurally, independent of any install run:
  // if applySettingsJsonHooks registers a basename that isManagedHookCommand does
  // not recognise, uninstall cannot remove it. This arm also covers the GLOBAL
  // settings.json path, where the same two names were orphaned.
  const { isManagedHookCommand } = require('../ferrox-core/bin/lib/shell-command-projection.cjs');
  const scratch = makeScratch(seedSettings());
  const install = runInstaller(scratch, ['--claude', '--local']);
  assert.equal(install.status, 0, `install failed:\n${install.stdout}\n${install.stderr}`);

  const registered = hookCommands(readJson(scratch.settings)).filter(isFerrox);
  // NON-VACUITY: there must be registrations to check.
  assert.ok(registered.length > 0, 'install must register Ferrox hooks to check');

  const unstrippable = registered
    .filter(([, command]) => !isManagedHookCommand(command, { surface: 'settings-json' }))
    .map(([event, command]) => `${event}: ${command}`);
  assert.deepEqual(
    unstrippable, [],
    'every registered Ferrox hook command must be recognised as managed on the settings-json surface',
  );

});
