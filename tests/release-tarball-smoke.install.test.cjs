'use strict';

/**
 * Tier 1 user simulation: THE PACKED ARTIFACT.
 *
 * Specified by .planning/TEST-AND-BENCHMARK-DESIGN.md section 2 Tier 1. Fills the
 * `install` suite, which scripts/run-tests.cjs has declared with 0 files.
 *
 * ## Why this file exists
 *
 * Every other test in this repository runs against the WORKING TREE. A user runs an
 * INSTALLED ARTIFACT. That gap has already broken 3 releases: js-yaml was required
 * from node_modules in 1.9.0 through 1.11.0 and every fresh install died. Phase 18
 * vendored 14103 lines of Python across 15 entrypoints into
 * ferrox-core/bin/vendor/ratchet/, and no test observed whether that payload
 * survives packaging and reaches an installed tree.
 *
 * The rule for this tier is: drive a child process, never import the thing under
 * test. A test that imports the module it is testing cannot detect a packaging
 * failure, and packaging failure is the specific way this project has broken users.
 *
 * ## The 3 stage chain this measures
 *
 *   working tree  --npm pack-->  tarball
 *                 --npm install -g--> global prefix package tree
 *                 --bin/install.js--> .claude runtime tree
 *
 * Each stage is asserted separately so a failure localises to the stage that lost
 * the payload rather than to the chain as a whole. Stage 3 is the highest value
 * assertion in the file: bin/install.js carries no reference to the vendor
 * directory by name, so whether the payload arrives is a property of HOW the
 * installer copies and is not readable from its source.
 *
 * ## Why the assertions are shaped the way they are
 *
 * 3 things would pass trivially here and are deliberately blocked:
 *
 *   1. A "the files are present" check passes on EMPTY files. Every entrypoint is
 *      therefore verified by sha256 against the pristine pin in UPSTREAM-MANIFEST.json,
 *      not by existence.
 *   2. A vendored payload check that COUNTS PATHS proves nothing about content. The
 *      count and the content are both asserted, and the count is asserted as an
 *      explicit equality against a pinned literal rather than as "nothing is absent",
 *      which is vacuously true when the payload is absent in its entirety.
 *   3. An absent interpreter test run on a machine where the interpreter IS present
 *      proves nothing. The scrubbed PATH is therefore proved to bite, by observing
 *      that every interpreter spelling fails to launch under it, before the arm that
 *      depends on the scrub is allowed to assert anything.
 *
 * ## Runtime
 *
 * Real `npm pack` plus a real `npm install -g` into a scratch prefix. Minutes, not
 * seconds. It has its own workflow (.github/workflows/install-smoke.yml) and
 * scripts/ci-test-scope.cjs already excludes it from the scoped lane, so it never
 * competes for the per-chunk timeout.
 *
 * Reuses scripts/release-tarball-smoke.cjs rather than reimplementing it: that
 * script owns the install, the bin resolution across Windows and POSIX, the version
 * assert and the init, behind a frozen result enum.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const { SMOKE, runSmoke } = require('../scripts/release-tarball-smoke.cjs');
const { PACKAGE_NAME } = require('../ferrox-core/bin/lib/package-identity.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const RATCHET_DIR = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet');
const MANIFEST_PATH = path.join(RATCHET_DIR, 'UPSTREAM-MANIFEST.json');

// Tar member paths are POSIX by the tar format's own contract, on every platform.
// npm prefixes every member of a pack tarball with `package/`.
const TAR_RATCHET_PREFIX = 'package/ferrox-core/bin/vendor/ratchet/';

// The vendored tree's own relative layout, as manifest keys spell it (POSIX).
const RATCHET_SEGMENTS = ['ferrox-core', 'bin', 'vendor', 'ratchet'];

/**
 * The count is pinned as a LITERAL, deliberately.
 *
 * Deriving the expected count from the same manifest that is being checked would
 * make the assertion self-satisfying: a drop that lost 14 of 15 entrypoints AND
 * rewrote the manifest to say 1 would pass. Pinning the literal means any change to
 * the size of the vendored surface has to be made here, by a human, on purpose.
 * This mirrors the pinned-literal convention already used by
 * tests/fleet-vendor-integrity.test.cjs.
 */
const EXPECTED_ENTRYPOINT_COUNT = 15;

// Interpreter spellings that must ALL fail to launch under the scrubbed PATH.
// If any of these still resolves, the scrub did not bite and the absent
// interpreter arm would be measuring nothing.
const INTERPRETER_SPELLINGS = ['python3', 'python', 'py'];

const CHILD_TIMEOUT_MS = 120_000;
const PACK_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Scratch directories
// ---------------------------------------------------------------------------

const SCRATCH_ROOTS = [];

function scratch(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-tarball-${tag}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// The oracle: the pristine pin written once in phase 18 plan 01
// ---------------------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

/**
 * The ledger is the ONLY exception path, and it is the same exception the hash
 * arm of tests/fleet-vendor-integrity.test.cjs already carries.
 *
 * Phase 18 plan 02 task 4 lands 3 recorded divergences on bin/ratchet-exec, so
 * the pristine pin is no longer what ships for that 1 file. Without this the
 * oracle rejects a correct write, which is the FF-B80 defect class: a guard
 * reporting a defect on the thing it was built to permit. The exception stays
 * deliberately narrow. It applies only to files the ledger NAMES, it substitutes
 * the ledger's own post hash and post byte length rather than waiving the check,
 * and a wrong post hash still fails, so the ledger is not a blanket waiver.
 *
 * Both substituted values come from the LEDGER, never from the shipped file. An
 * oracle that reads the file to learn what the file should be is not an oracle.
 */
const ledger = JSON.parse(fs.readFileSync(path.join(RATCHET_DIR, 'DIVERGENCES.json'), 'utf-8'));
/** @type {Map<string, { sha256: string, bytes: number }>} */
const LEDGERED = new Map();
for (const d of ledger.divergences || []) {
  assert.equal(
    typeof d.post_bytes,
    'number',
    `the divergence ledger entry for ${d.file} carries no post_bytes, so the byte length arm below ` +
      'would have to read the shipped file to learn its own expectation',
  );
  LEDGERED.set(d.file, { sha256: d.post_sha256, bytes: d.post_bytes });
}

/** @type {{ rel: string, sha256: string, bytes: number }[]} */
const ENTRYPOINTS = Object.entries(manifest.files)
  .filter(([, meta]) => meta.kind === 'entrypoint')
  .map(([rel, meta]) => {
    const override = LEDGERED.get(rel);
    return { rel, sha256: override ? override.sha256 : meta.sha256, bytes: override ? override.bytes : meta.bytes };
  })
  .sort((a, b) => a.rel.localeCompare(b.rel));

/**
 * Verify a directory that should hold the vendored tree, by CONTENT.
 *
 * Returns a report rather than asserting, so each of the 3 stages can attach its
 * own message and so the shape can be exercised against a planted defect.
 *
 * @param {string} rootDir Directory that should contain bin/ratchet* etc.
 * @returns {{ present: string[], missing: string[], empty: string[], corrupt: string[], bytes: number }}
 */
function auditVendoredTree(rootDir) {
  const present = [];
  const missing = [];
  const empty = [];
  const corrupt = [];
  let bytes = 0;

  for (const entry of ENTRYPOINTS) {
    // Manifest keys are POSIX; split and rejoin so this addresses correctly on Windows.
    const filePath = path.join(rootDir, ...entry.rel.split('/'));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      missing.push(entry.rel);
      continue;
    }
    present.push(entry.rel);
    const buf = fs.readFileSync(filePath);
    bytes += buf.length;
    if (buf.length === 0) {
      empty.push(entry.rel);
      continue;
    }
    if (sha256(buf) !== entry.sha256 || buf.length !== entry.bytes) {
      corrupt.push(entry.rel);
    }
  }

  return { present, missing, empty, corrupt, bytes };
}

/**
 * Assert a stage of the chain carried the whole vendored payload, intact.
 *
 * Asserts the COUNT as an explicit equality first. "nothing is missing" is
 * vacuously true when the payload is absent in its entirety, which is exactly the
 * acceptance-set-too-loose half of this project's recurring defect class.
 *
 * @param {string} rootDir
 * @param {string} stage Human name of the chain stage, for the failure message.
 */
function assertVendoredPayloadIntact(rootDir, stage) {
  const report = auditVendoredTree(rootDir);

  assert.equal(
    report.present.length,
    EXPECTED_ENTRYPOINT_COUNT,
    `${stage}: expected exactly ${EXPECTED_ENTRYPOINT_COUNT} vendored entrypoints, found ${report.present.length}. ` +
    `missing: ${report.missing.join(', ') || 'none'}`,
  );
  assert.deepEqual(
    report.empty,
    [],
    `${stage}: vendored entrypoints arrived as zero-byte files, which a presence check would have passed`,
  );
  assert.deepEqual(
    report.corrupt,
    [],
    `${stage}: vendored entrypoints do not hash to their pristine pin`,
  );

  const expectedBytes = ENTRYPOINTS.reduce((sum, e) => sum + e.bytes, 0);
  assert.equal(
    report.bytes,
    expectedBytes,
    `${stage}: total vendored entrypoint bytes disagree with the manifest`,
  );
}

/**
 * Locate the installed package root inside an `npm install -g --prefix` directory.
 * POSIX puts it under lib/node_modules, Windows directly under node_modules.
 */
function installedPkgRoot(installPrefix) {
  const segments = PACKAGE_NAME.split('/');
  const posix = path.join(installPrefix, 'lib', 'node_modules', ...segments);
  const win = path.join(installPrefix, 'node_modules', ...segments);
  return fs.existsSync(posix) ? posix : win;
}

// ---------------------------------------------------------------------------
// One-time setup: pack, list, extract, install, init
// ---------------------------------------------------------------------------

/** @type {{ tarball: string, members: string[], extractDir: string, smoke: any, fixtureDir: string, installPrefix: string, version: string }} */
const ctx = {};

before(() => {
  const packDir = scratch('pack');
  const extractDir = scratch('extract');
  const installPrefix = scratch('prefix');
  const fixtureDir = scratch('fixture');

  const repoPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
  ctx.version = String(repoPkg.version).trim();

  // --- Stage 1: pack the working tree -------------------------------------
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['pack', '--pack-destination', packDir, '--loglevel', 'error'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: PACK_TIMEOUT_MS,
    env: { ...process.env, npm_config_update_notifier: 'false', NO_UPDATE_NOTIFIER: '1' },
  });

  const tgz = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, `npm pack produced no .tgz in ${packDir}`);
  ctx.tarball = path.join(packDir, tgz);

  // Member NAMES. `tar -tzf` only, never the verbose listing: #1461 established
  // that the column layout of `tar -tv` differs between GNU and BSD tar and that
  // parsing it mis-anchors. Names are unambiguous.
  const listing = execFileSync('tar', ['-tzf', ctx.tarball], {
    encoding: 'utf-8',
    timeout: CHILD_TIMEOUT_MS,
  });
  ctx.members = listing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // Extract so the packed bytes themselves can be hashed, rather than inferring
  // tarball content from what survived a later install.
  execFileSync('tar', ['-xzf', ctx.tarball, '-C', extractDir], {
    encoding: 'utf-8',
    timeout: CHILD_TIMEOUT_MS,
  });
  ctx.extractDir = extractDir;

  // --- Stages 2 and 3: install the tarball, then run the installed installer.
  // runSmoke owns install, bin resolution, the version assert and the init.
  ctx.installPrefix = installPrefix;
  ctx.fixtureDir = fixtureDir;
  ctx.smoke = runSmoke({
    tarballPath: ctx.tarball,
    installPrefix,
    expectedVersion: ctx.version,
    fixtureDir,
  });
});

after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// 0. The oracle must be non-vacuous before anything leans on it
// ---------------------------------------------------------------------------

test('the vendored manifest is a usable oracle: 15 entrypoints, each with a real hash and a positive size', () => {
  // If this drifts, every content assertion below silently weakens, so it is
  // checked first and against a pinned literal rather than against itself.
  assert.equal(
    manifest.entrypoint_count,
    EXPECTED_ENTRYPOINT_COUNT,
    'the manifest no longer declares 15 entrypoints; the vendored surface changed and this test must be updated on purpose',
  );
  assert.equal(
    ENTRYPOINTS.length,
    EXPECTED_ENTRYPOINT_COUNT,
    'the manifest declares 15 entrypoints but a different number carry kind:"entrypoint"',
  );

  for (const entry of ENTRYPOINTS) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.rel}: manifest sha256 is not a sha256`);
    assert.ok(entry.bytes > 0, `${entry.rel}: manifest declares a zero-byte entrypoint`);
  }
});

// ---------------------------------------------------------------------------
// 1. npm pack
// ---------------------------------------------------------------------------

test('stage 1: npm pack produces a tarball carrying all 15 vendored entrypoints, byte-identical', () => {
  assert.ok(fs.existsSync(ctx.tarball), 'npm pack produced no tarball');

  // The .gitignore carries a blanket `vendor/` rule that is re-included by
  // `!ferrox-core/bin/vendor/**`. There is no .npmignore, so npm falls back to
  // gitignore semantics and whether npm's ignore walker honours that re-inclusion
  // the same way git does is precisely the question. This measures it.
  const packedEntrypoints = ctx.members.filter(
    (m) => m.startsWith(`${TAR_RATCHET_PREFIX}bin/`),
  );
  assert.equal(
    packedEntrypoints.length,
    EXPECTED_ENTRYPOINT_COUNT,
    `npm pack carried ${packedEntrypoints.length} vendored entrypoints, expected ${EXPECTED_ENTRYPOINT_COUNT}. ` +
    'A count of 0 means the tarball dropped the vendored engine entirely.',
  );

  const expectedMembers = ENTRYPOINTS.map((e) => `${TAR_RATCHET_PREFIX}${e.rel}`).sort();
  assert.deepEqual(
    packedEntrypoints.slice().sort(),
    expectedMembers,
    'the packed entrypoint set is not the manifest entrypoint set',
  );

  // Hash the PACKED bytes. Names in a listing say nothing about content.
  assertVendoredPayloadIntact(
    path.join(ctx.extractDir, 'package', ...RATCHET_SEGMENTS),
    'stage 1 (npm pack tarball)',
  );
});

// ---------------------------------------------------------------------------
// 2. npm install -g, then bin/install.js
// ---------------------------------------------------------------------------

test('stage 2: installing the tarball into a scratch prefix keeps all 15 vendored entrypoints intact', () => {
  assert.equal(
    ctx.smoke.code,
    SMOKE.OK,
    `release-tarball-smoke did not return OK: ${ctx.smoke.code} ${JSON.stringify(ctx.smoke.details)}`,
  );

  assertVendoredPayloadIntact(
    path.join(installedPkgRoot(ctx.installPrefix), ...RATCHET_SEGMENTS),
    'stage 2 (npm install -g prefix)',
  );
});

test('stage 3: the installer carries all 15 vendored entrypoints into the .claude runtime tree', () => {
  // The single highest-value assertion in this file. bin/install.js names no
  // vendor path, so whether the payload arrives is a property of how it copies.
  // The tree under test was produced by the INSTALLED installer from the PACKED
  // tarball, so this is the end of the real user chain, not a working-tree copy.
  const runtimeRoot = path.join(ctx.fixtureDir, '.claude', 'ferrox-core', 'bin', 'vendor', 'ratchet');

  assert.ok(
    fs.existsSync(path.join(ctx.fixtureDir, '.claude', 'ferrox-core')),
    'precondition broken: the installed installer did not produce a .claude runtime tree',
  );

  assertVendoredPayloadIntact(runtimeRoot, 'stage 3 (.claude runtime tree)');
});

// ---------------------------------------------------------------------------
// 2b. Planted defects: the payload detector must be able to fail
//
// An assertion never observed failing is not evidence. Each case below breaks a
// real copy of the vendored tree in a scratch directory and requires the SAME
// function the 3 stage assertions use to reject it. The 4 cases are chosen to be
// exactly the shapes that a weaker acceptance set would wave through.
// ---------------------------------------------------------------------------

/**
 * Copy the real vendored tree into a scratch directory so a defect can be planted
 * in it without touching the repository.
 */
function plantableCopy(tag) {
  const dir = scratch(`planted-${tag}`);
  fs.cpSync(RATCHET_DIR, dir, { recursive: true });
  return dir;
}

test('planted: an entirely absent payload is reported by the explicit count, not waved through', () => {
  // The vacuity case. "no vendored file is missing" is TRUE of a tree that has no
  // vendored files at all, which is what a base without the phase 18 drop looks
  // like. Only an explicit count equality rejects it.
  const dir = scratch('planted-absent');
  assert.throws(
    () => assertVendoredPayloadIntact(dir, 'planted absent'),
    /expected exactly 15 vendored entrypoints, found 0/,
    'an empty tree was accepted; the count assertion is vacuous',
  );
});

test('planted: a single removed entrypoint is reported', () => {
  const dir = plantableCopy('removed');
  fs.unlinkSync(path.join(dir, 'bin', 'ratchet-think'));
  assert.throws(
    () => assertVendoredPayloadIntact(dir, 'planted removed'),
    /expected exactly 15 vendored entrypoints, found 14/,
    'a removed entrypoint was accepted',
  );
});

test('planted: an entrypoint truncated to zero bytes is reported, which a presence check would pass', () => {
  const dir = plantableCopy('empty');
  fs.writeFileSync(path.join(dir, 'bin', 'ratchet-glass'), '');
  assert.throws(
    () => assertVendoredPayloadIntact(dir, 'planted empty'),
    /zero-byte files/,
    'a zero-byte entrypoint was accepted; the check is a presence check',
  );
});

test('planted: a single changed byte at equal length is reported, which a path count would pass', () => {
  // Same file count, same file sizes, same names. Only content verification can
  // see this, so it is the case that separates counting paths from checking bytes.
  const dir = plantableCopy('flipped');
  const target = path.join(dir, 'bin', 'ratchet-index');
  const buf = fs.readFileSync(target);
  const before = buf.length;
  buf[Math.floor(buf.length / 2)] ^= 0xff;
  fs.writeFileSync(target, buf);
  assert.equal(fs.statSync(target).size, before, 'the planted flip changed the length, weakening the case');

  assert.throws(
    () => assertVendoredPayloadIntact(dir, 'planted flipped'),
    /do not hash to their pristine pin/,
    'a changed byte was accepted; content is not being verified',
  );
});

// ---------------------------------------------------------------------------
// 3. The installed CLI is callable and reports its version
// ---------------------------------------------------------------------------

test('the installed CLI is callable and reports the packaged version', () => {
  // runSmoke already resolved the shipped bin across Windows and POSIX, invoked
  // it, and compared the installed package.json version, returning
  // BIN_NOT_CALLABLE or VERSION_MISMATCH otherwise.
  assert.equal(ctx.smoke.code, SMOKE.OK, `smoke did not reach OK: ${ctx.smoke.code}`);
  assert.equal(
    ctx.smoke.details.version,
    ctx.version,
    'the installed package reports a version other than the one that was packed',
  );

  // Then make the RUNTIME tree say its own version out loud, which is the thing a
  // user actually invokes. `doctor` is the verb that emits it.
  const runtimeCli = path.join(ctx.fixtureDir, '.claude', 'ferrox-core', 'bin', 'ferrox-tools.cjs');
  assert.ok(fs.existsSync(runtimeCli), 'installed runtime ferrox-tools.cjs is missing');

  const doctor = spawnSync(process.execPath, [runtimeCli, 'doctor'], {
    cwd: ctx.fixtureDir,
    encoding: 'utf-8',
    timeout: CHILD_TIMEOUT_MS,
  });
  const combined = `${doctor.stdout}\n${doctor.stderr}`;
  assert.ok(
    !combined.includes('Cannot find module'),
    `the installed runtime CLI hit an unresolvable require:\n${combined}`,
  );
  assert.equal(doctor.status, 0, `doctor exited nonzero:\n${combined}`);
  assert.ok(
    doctor.stdout.includes(`running version: ${ctx.version}`),
    `doctor did not report the packaged version ${ctx.version}:\n${doctor.stdout}`,
  );
});

// ---------------------------------------------------------------------------
// 4. The absent-interpreter arm
// ---------------------------------------------------------------------------

/**
 * Build an environment whose PATH is a single EMPTY directory.
 *
 * Windows resolves the variable case-insensitively and Node passes the block
 * through verbatim, so every casing already present is overwritten rather than
 * leaving a live one behind.
 */
function scrubbedPathEnv(emptyDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = emptyDir;
  if (process.platform === 'win32') env.Path = emptyDir;
  return env;
}

test('the scrubbed PATH actually bites: no interpreter spelling launches under it', () => {
  // Plan 18-01 could not drive the absent-interpreter branch and took a documented
  // fence, because Python is present on the development machine. That fence is what
  // this test closes. Without this guard the arm below would pass on a machine
  // where the interpreter IS present, which is the third trivially-passing shape
  // this file exists to refuse.
  const emptyDir = scratch('emptypath');
  assert.deepEqual(fs.readdirSync(emptyDir), [], 'the scrub directory is not empty');

  const env = scrubbedPathEnv(emptyDir);
  for (const spelling of INTERPRETER_SPELLINGS) {
    const probe = spawnSync(spelling, ['--version'], { env, encoding: 'utf-8', timeout: CHILD_TIMEOUT_MS });
    assert.notEqual(
      probe.status,
      0,
      `"${spelling}" still launched under the scrubbed PATH, so the scrub proves nothing`,
    );
  }
});

test('planted: the scrub proof itself fires when PATH is NOT scrubbed', () => {
  // The guard above is only worth having if it can fail. Under the REAL PATH of
  // this machine at least one interpreter spelling resolves, so the same
  // assertion, applied to an unscrubbed environment, must reject it. If this test
  // ever fails it means no interpreter is installed here, and the guard above
  // stopped being evidence rather than started being wrong.
  const launched = INTERPRETER_SPELLINGS.filter((spelling) => {
    const probe = spawnSync(spelling, ['--version'], { encoding: 'utf-8', timeout: CHILD_TIMEOUT_MS });
    return probe.status === 0;
  });
  assert.notEqual(
    launched.length,
    0,
    'no interpreter launched even with the real PATH, so the scrub proof above is measuring an already-absent interpreter',
  );
});

test('with no interpreter anywhere on PATH the installed CLI still runs an ordinary command', () => {
  // Decision D2 of the phase 18 context: the fleet is off by default and the
  // default path must survive with no interpreter present. Driven against the
  // INSTALLED runtime tree, as a child, with an absolute node path so the child
  // can start at all once PATH no longer resolves anything.
  const emptyDir = scratch('emptypath-run');
  const env = scrubbedPathEnv(emptyDir);

  const runtimeCli = path.join(ctx.fixtureDir, '.claude', 'ferrox-core', 'bin', 'ferrox-tools.cjs');
  const run = spawnSync(
    process.execPath,
    [runtimeCli, 'config-get', 'domain', '--default', 'unset'],
    { cwd: ctx.fixtureDir, env, encoding: 'utf-8', timeout: CHILD_TIMEOUT_MS },
  );

  const combined = `${run.stdout}\n${run.stderr}`;
  assert.ok(
    !combined.includes('Cannot find module'),
    `the installed CLI hit an unresolvable require with PATH scrubbed:\n${combined}`,
  );
  assert.equal(
    run.status,
    0,
    `an ordinary non-fleet command failed with no interpreter on PATH:\n${combined}`,
  );
  assert.match(run.stdout, /unset/, 'config-get did not produce the default value');
});
