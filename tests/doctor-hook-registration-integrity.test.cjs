'use strict';

/**
 * `ferrox-tools doctor` hook-registration integrity (FF-B513) and explicit
 * version-skew verdict (FF-B514).
 *
 * ## Why this exists
 *
 * Doctor reported install paths and versions. It never verified that the hooks
 * those installs REGISTERED still exist on disk, and it printed the global and
 * project versions without ever comparing them. Either check would have caught
 * the FF-B511 orphaned-registration outage before the user did: a project whose
 * `settings.local.json` still registered 15 hooks whose files had been deleted
 * reported all-clear.
 *
 * ## Non-vacuity is load-bearing
 *
 * "No missing hooks were reported" is vacuously true when the scan found nothing
 * to check, which is the same silent-empty-enumeration defect class. The healthy
 * arm therefore asserts a VERIFIED COUNT > 0, and the broken arm asserts the
 * specific missing path is named.
 *
 * ## Scratch only
 *
 * Every run uses an `fs.mkdtempSync` project with HOME and USERPROFILE
 * redirected inside it. The developer's real ~/.claude is never touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const TOOLS = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'ferrox-tools.cjs');

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

/**
 * Build a scratch project that looks like a Ferrox project root, with a
 * settings.local.json registering `hookFiles` and only those of `presentFiles`
 * actually written to disk.
 */
function makeProject({ hookFiles, presentFiles }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-doctor-'));
  const proj = path.join(root, 'proj');
  const fakeHome = path.join(root, 'home');
  fs.mkdirSync(path.join(proj, '.claude', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });

  for (const f of presentFiles) {
    fs.writeFileSync(path.join(proj, '.claude', 'hooks', f), '// present\n');
  }
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: hookFiles.map((f) => ({
          type: 'command',
          command: `"/usr/bin/node" "$CLAUDE_PROJECT_DIR"/.claude/hooks/${f}`,
        })),
      }],
    },
  };
  fs.writeFileSync(
    path.join(proj, '.claude', 'settings.local.json'),
    JSON.stringify(settings, null, 2) + '\n',
  );
  SCRATCH_ROOTS.push(root);
  return { root, proj, fakeHome };
}

function runDoctor(scratch) {
  const res = spawnSync(process.execPath, [TOOLS, 'doctor'], {
    cwd: scratch.proj,
    env: {
      PATH: process.env.PATH,
      HOME: scratch.fakeHome,
      USERPROFILE: scratch.fakeHome,
    },
    encoding: 'utf8',
  });
  // doctor emits its report as a single JSON-encoded string, so the report's
  // own newlines arrive as literal backslash-n. Decode to real lines before
  // asserting, otherwise every per-line assertion silently sees one long line.
  const raw = `${res.stdout || ''}${res.stderr || ''}`;
  let out = raw;
  try {
    const decoded = JSON.parse(raw.trim());
    if (typeof decoded === 'string') out = decoded;
  } catch { /* not JSON-wrapped — use the raw text */ }
  return { status: res.status, out };
}

test('FF-B513: doctor reports every registered hook present when the files exist', () => {
  const scratch = makeProject({
    hookFiles: ['ferrox-prompt-guard.js', 'ferrox-read-guard.js'],
    presentFiles: ['ferrox-prompt-guard.js', 'ferrox-read-guard.js'],
  });

  const { status, out } = runDoctor(scratch);
  assert.equal(status, 0, `doctor must exit 0:\n${out}`);

  const line = out.split('\n').find((l) => l.includes('hook registrations:'));
  assert.ok(line, `doctor must emit a hook registrations line:\n${out}`);

  // NON-VACUITY: the verified count must be > 0, otherwise "all present" is a
  // statement about the empty set.
  const m = line.match(/ok \((\d+) verified/);
  assert.ok(m, `expected an ok line with a verified count, got: ${line}`);
  assert.ok(Number(m[1]) > 0, `verified count must be > 0, got ${m && m[1]}`);
  assert.ok(!out.includes('MISSING'), `no hook should be reported missing:\n${out}`);

});

test('FF-B513: doctor names the registered hooks whose files are gone', () => {
  // The FF-B511 shape: registrations survive, the files do not.
  const scratch = makeProject({
    hookFiles: ['ferrox-prompt-guard.js', 'ferrox-read-guard.js', 'my-own-guard.js'],
    presentFiles: ['my-own-guard.js'],
  });

  const { status, out } = runDoctor(scratch);
  // Reports and never fails: doctor still exits 0 in the firing case.
  assert.equal(status, 0, `doctor must still exit 0 when it finds orphans:\n${out}`);

  assert.match(out, /hook registrations: 2 of 3 point at MISSING files\./, out);
  assert.ok(out.includes('ferrox-prompt-guard.js'), `must name the first orphan:\n${out}`);
  assert.ok(out.includes('ferrox-read-guard.js'), `must name the second orphan:\n${out}`);
  // The hook that IS on disk must not be reported as missing.
  const missingLines = out.split('\n').filter((l) => l.trim().startsWith('missing:'));
  assert.equal(missingLines.length, 2, `expected exactly 2 missing lines, got:\n${missingLines.join('\n')}`);
  assert.ok(
    !missingLines.some((l) => l.includes('my-own-guard.js')),
    `a hook present on disk must not be reported missing:\n${missingLines.join('\n')}`,
  );

});

/**
 * Plant a stub install (the files doctor probes: the cli entry point plus a
 * VERSION) at `coreDir` so the skew comparison has two versions to compare.
 */
function plantStubInstall(coreDir, version) {
  fs.mkdirSync(path.join(coreDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(coreDir, 'bin', 'ferrox-tools.cjs'), '// stub\n');
  fs.writeFileSync(path.join(coreDir, 'VERSION'), `${version}\n`);
}

test('FF-B514: doctor states the version-skew verdict instead of leaving it to the reader', () => {
  // Skewed: global and project installs report different versions.
  const skewed = makeProject({ hookFiles: [], presentFiles: [] });
  plantStubInstall(path.join(skewed.fakeHome, '.claude', 'ferrox-core'), '1.14.0');
  plantStubInstall(path.join(skewed.proj, '.claude', 'ferrox-core'), '1.15.0');

  const skewResult = runDoctor(skewed);
  assert.equal(skewResult.status, 0, `doctor must exit 0:\n${skewResult.out}`);
  // NON-VACUITY: both installs must actually have been detected, else there is
  // no pair to compare and the verdict line would be correctly absent.
  assert.match(skewResult.out, /global install: .*1\.14\.0/, skewResult.out);
  assert.match(skewResult.out, /project install: .*1\.15\.0/, skewResult.out);
  assert.match(
    skewResult.out,
    /version skew: YES\. global 1\.14\.0 vs project 1\.15\.0\./,
    `doctor must state the skew verdict:\n${skewResult.out}`,
  );

  // Matched: same version in both places.
  const matched = makeProject({ hookFiles: [], presentFiles: [] });
  plantStubInstall(path.join(matched.fakeHome, '.claude', 'ferrox-core'), '1.15.0');
  plantStubInstall(path.join(matched.proj, '.claude', 'ferrox-core'), '1.15.0');

  const matchResult = runDoctor(matched);
  assert.equal(matchResult.status, 0, `doctor must exit 0:\n${matchResult.out}`);
  assert.match(
    matchResult.out,
    /version skew: no \(both 1\.15\.0\)/,
    `doctor must state the no-skew verdict:\n${matchResult.out}`,
  );
});

test('FF-B513: a malformed settings.local.json does not take doctor down', () => {
  const scratch = makeProject({ hookFiles: [], presentFiles: [] });
  fs.writeFileSync(
    path.join(scratch.proj, '.claude', 'settings.local.json'),
    '{ "hooks": { broken,,, }',
  );

  const { status, out } = runDoctor(scratch);
  assert.equal(status, 0, `doctor must exit 0 on a malformed settings file:\n${out}`);
  assert.ok(
    out.includes('hook registrations:'),
    `doctor must still emit the hook registrations line:\n${out}`,
  );
  assert.ok(!out.includes('unavailable'), `the scan must degrade quietly, not error:\n${out}`);

});
