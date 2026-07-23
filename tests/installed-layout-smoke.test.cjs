'use strict';

/**
 * Installed-layout smoke test (v1.11.1 hotfix regression guard).
 *
 * The installer file-copies ferrox-core/, scripts/, and hooks/ into the user's
 * .claude directory with NO node_modules and NO dependency manifest. Any bare
 * package require reachable from ferrox-tools.cjs startup therefore kills the
 * entire CLI on every user machine while working fine in this repo (where
 * node_modules exists). That exact failure shipped in 1.9.0 through 1.11.0:
 * gate-seal required js-yaml from node_modules and every fresh install died
 * with "Cannot find module 'js-yaml'" before parsing argv (field report,
 * 2026-07-23). The fix vendors the pinned dist at
 * ferrox-core/bin/vendor/js-yaml-4.2.0.cjs.
 *
 * This test runs the REAL installer into a scratch project and executes the
 * INSTALLED CLI, so any future dependency on node_modules in the installed
 * tree fails here instead of in the field.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTALL_JS = path.join(__dirname, '..', 'bin', 'install.js');

test('vendored runtime dependencies are git-tracked (not swallowed by ignore rules)', () => {
  // The 1.11.1 vendor file passed every local test while sitting UNTRACKED:
  // the global vendor/ gitignore pattern excluded it from both the git tree
  // and the npm tarball, so the "fix" would not have shipped. Working-tree
  // presence is not enough; assert git actually tracks the shipped vendor dir.
  const out = spawnSync('git', ['ls-files', 'ferrox-core/bin/vendor/'], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, `git ls-files failed: ${out.stderr}`);
  assert.match(out.stdout, /js-yaml-4\.2\.0\.cjs/, 'vendored js-yaml is not git-tracked; the ignore rules swallowed it again');
});

test('installed layout runs with no node_modules anywhere in reach', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-installed-smoke-'));
  const proj = path.join(scratch, 'proj');
  fs.mkdirSync(proj, { recursive: true });

  const install = spawnSync(process.execPath, [INSTALL_JS, '--claude', '--local'], {
    cwd: proj,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(install.status, 0, `installer failed:\n${install.stdout}\n${install.stderr}`);

  const installedCli = path.join(proj, '.claude', 'ferrox-core', 'bin', 'ferrox-tools.cjs');
  assert.ok(fs.existsSync(installedCli), 'installed ferrox-tools.cjs missing');
  assert.ok(
    !fs.existsSync(path.join(proj, '.claude', 'ferrox-core', 'node_modules')),
    'precondition broken: installed tree unexpectedly has node_modules'
  );

  // A real verb through the full startup require chain (which includes the
  // gate command router and therefore gate-seal). Any node_modules-dependent
  // require anywhere on that chain fails right here.
  const run = spawnSync(process.execPath, [installedCli, 'config-get', 'domain', '--default', 'unset'], {
    cwd: proj,
    encoding: 'utf8',
    timeout: 30000,
  });
  const combined = `${run.stdout}\n${run.stderr}`;
  assert.ok(
    !combined.includes('Cannot find module'),
    `installed CLI hit an unresolvable require:\n${combined}`
  );
  assert.equal(run.status, 0, `installed CLI exited nonzero:\n${combined}`);
  assert.match(run.stdout, /unset/, 'config-get did not produce the default value');

  // The sealed framework itself must load from the installed tree: gate.seal
  // with no arguments must produce a CONTROLLED usage error, never a module
  // resolution crash.
  const gateVerb = spawnSync(process.execPath, [installedCli, 'gate.seal'], {
    cwd: proj,
    encoding: 'utf8',
    timeout: 30000,
  });
  const gateOut = `${gateVerb.stdout}\n${gateVerb.stderr}`;
  assert.ok(
    !gateOut.includes('Cannot find module'),
    `gate verb hit an unresolvable require:\n${gateOut}`
  );
});
