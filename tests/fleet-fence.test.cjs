'use strict';

/**
 * Phase 18 plan 02, task 3: upstream's default off fence, pinned by 3 tests,
 * each observed reporting against a case that carries the thing it detects.
 *
 * D1 is the decision this file enforces. The vendored maintain entrypoint
 * already fences execution of an untrusted contributor suite behind 2 opt in
 * environment variables, and this project keeps that fence rather than deleting
 * the file or rewriting the predicate. A fence that is kept is only worth
 * keeping if it is pinned, so:
 *
 * 1. The predicate returns false on a clean environment AND true when either
 *    opt in variable is set to the string 1. The second arm is the entire
 *    reason this test is worth committing. The first arm alone restates a
 *    default that was already true before this phase started, which is exactly
 *    the trivially passing shape D5 forbids.
 * 2. No file in the Ferrox authored executable surface sets either variable,
 *    and the same scanner reports against a fixture that does. The scanner's
 *    resolved file list is asserted to contain THIS file, so the test cannot
 *    become the 1 place the fence does not reach.
 * 3. No file in that surface invokes the maintain entrypoint or its gate verb,
 *    and the same scanner reports against 2 fixtures that do.
 *
 * Plus a 4th, which is what stops this task from being the one that quietly
 * modified the fence: the vendored file still hashes to its pristine pin and
 * carries no divergence ledger entry.
 *
 * WHY TASK 4 DOES NOT VIOLATE TEST 3. The divergence tests in
 * tests/fleet-divergence.test.cjs load the exec entrypoint directly as a
 * library by file location and call its functions in process. That is the
 * runner and exec surface D1 permits. Nothing in this repository shells to the
 * maintain entrypoint, and nothing runs its gate verb. The import based fence
 * probe below is the same shape: it loads the module and reads 1 predicate. It
 * runs no verb, because the module carries exactly 1 main guard and importing
 * it therefore executes no command.
 *
 * NEITHER VARIABLE NAME APPEARS AS A LITERAL IN THIS FILE. Both are assembled
 * from parts at runtime, because this file is inside the scanned surface and a
 * literal here would either make the scanner report against itself or force an
 * exclusion, and an exclusion for the test file is a hole big enough to drive
 * the whole fence through. The maintain entrypoint's own name is assembled the
 * same way and for the same reason.
 *
 * BYTECODE. Importing a vendored entrypoint makes the interpreter write a
 * bytecode directory NEXT TO the source, inside the tree the vendor integrity
 * guard forbids artifacts in. Observed on the first run of this file, which
 * planted 2 compiled files under the vendored bin directory. Every child
 * process below therefore runs with bytecode writing disabled, and the absence
 * of any artifact is asserted afterwards rather than assumed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const P = 'phase 18 plan 02';
const REPO_ROOT = path.join(__dirname, '..');
const VENDOR_ROOT = path.join(REPO_ROOT, 'ferrox-core', 'bin', 'vendor', 'ratchet');

// Assembled from parts. See the header: no literal of either name lives here.
const VAR_PREFIX = 'RATCHET_' + 'GATE_';
const VAR_ALLOW = VAR_PREFIX + 'ALLOW_' + 'UNTRUSTED';
const VAR_SANDBOX = VAR_PREFIX + 'SAND' + 'BOX';
const MAINTAIN_NAME = 'ratchet' + '-' + 'maintain';
const MAINTAIN_KEY = 'bin/' + MAINTAIN_NAME;
const MAINTAIN_PATH = path.join(VENDOR_ROOT, 'bin', MAINTAIN_NAME);

const SCRATCH_ROOTS = [];

function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-fence-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ─── the scanned surface ─────────────────────────────────────────────────────
//
// The Ferrox authored executable surface. The vendored directory is removed
// because that is where the fence itself lives, and the planning directory is
// excluded entirely because the decision records are exactly where these names
// are SUPPOSED to appear.

const SURFACE_DIRS = ['src', 'scripts', 'hooks', 'capabilities', 'agents', 'commands', 'bin', 'tests', 'ferrox-core'];
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '__pycache__']);
const TEXT_EXTS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.json', '.sh', '.bash', '.zsh',
  '.md', '.yml', '.yaml', '.py', '.txt', '',
]);

/**
 * PURE over a root directory, so every detector below can be pointed at a
 * scratch fixture root as well as at the real tree. That is the same design the
 * vendor integrity guard uses, and it is what makes the planted arms possible.
 */
function collectSurfaceFiles(root, dirs) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        // The vendored tree is upstream source. It is where the fence lives and
        // it is deliberately not part of the Ferrox authored surface.
        if (path.relative(VENDOR_ROOT, full) === '' || !path.relative(VENDOR_ROOT, full).startsWith('..')) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!TEXT_EXTS.has(path.extname(e.name))) continue;
      out.push(full);
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return out.sort();
}

/** Detector 2: any file that SETS either opt in variable. */
function scanForOptInVariables(files) {
  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!text.includes(VAR_ALLOW) && !text.includes(VAR_SANDBOX)) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const name of [VAR_ALLOW, VAR_SANDBOX]) {
        if (line.includes(name)) hits.push(`${f}:${i + 1}: ${name} in: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return hits;
}

/**
 * Detector 3: any file that INVOKES the maintain entrypoint or its gate verb.
 *
 * A mention is not an invocation. A comment naming the file, or a manifest key
 * holding its path, is legitimate and must not be reported, because a detector
 * that rejects a correct write is the failure shape this phase exists to stop.
 * A hit is the entrypoint name in an execution context, or the entrypoint name
 * followed by its gate verb.
 */
const EXEC_CONTEXT = /(spawn|spawnSync|exec|execSync|execFile|execFileSync|child_process|subprocess|sh\s+-c|bash\s+-c)/;

function scanForMaintainInvocation(files) {
  const hits = [];
  const verbForm = new RegExp(MAINTAIN_NAME + '["\'\\s]+gate\\b');
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!text.includes(MAINTAIN_NAME)) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.includes(MAINTAIN_NAME)) return;
      if (verbForm.test(line)) {
        hits.push(`${f}:${i + 1}: the maintain gate verb is invoked: ${line.trim().slice(0, 120)}`);
        return;
      }
      if (EXEC_CONTEXT.test(line)) {
        hits.push(`${f}:${i + 1}: the maintain entrypoint is invoked: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return hits;
}

// ─── test 1: the fence predicate, both directions ────────────────────────────

const FENCE_PROBE = [
  'import importlib.util, importlib.machinery, sys',
  'loader = importlib.machinery.SourceFileLoader("ratchet_fence_probe", sys.argv[1])',
  'spec = importlib.util.spec_from_loader(loader.name, loader)',
  'm = importlib.util.module_from_spec(spec)',
  'loader.exec_module(m)',
  'sys.stdout.write(str(m._untrusted_exec_allowed()))',
  '',
].join('\n');

function driveFence(probePath, env) {
  // sys.dont_write_bytecode via the environment, so the import cannot plant a
  // bytecode directory inside the guarded vendored tree.
  const childEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete childEnv[VAR_ALLOW];
  delete childEnv[VAR_SANDBOX];
  Object.assign(childEnv, env || {});
  const r = spawnSync('python3', [probePath, MAINTAIN_PATH], {
    encoding: 'utf8',
    env: childEnv,
    timeout: 60000,
  });
  return r;
}

function countVendoredBytecode() {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__pycache__') { found.push(full); continue; }
        walk(full);
      } else if (e.name.endsWith('.pyc')) {
        found.push(full);
      }
    }
  };
  walk(VENDOR_ROOT);
  return found;
}

test(`${P}: the vendored fence is closed on a clean environment AND observed opening when the opt in is set`, () => {
  const dir = scratch('probe');
  const probe = path.join(dir, 'fence-probe.py');
  fs.writeFileSync(probe, FENCE_PROBE, 'utf8');

  const clean = driveFence(probe, {});
  assert.equal(
    clean.error === undefined && clean.status === 0,
    true,
    `${P} fence arm: the interpreter could not drive the vendored fence predicate. This is a loud failure ` +
      'rather than a skip on purpose: a fence test that quietly skips is worth nothing. ' +
      `error: ${clean.error && clean.error.message}, stderr: ${(clean.stderr || '').trim()}`,
  );
  assert.equal(
    clean.stdout.trim(),
    'False',
    `${P} fence arm CLOSED: the vendored predicate must refuse to execute an untrusted suite by default. ` +
      `Observed: ${clean.stdout.trim()}`,
  );

  for (const name of [VAR_ALLOW, VAR_SANDBOX]) {
    const opened = driveFence(probe, { [name]: '1' });
    assert.equal(
      opened.stdout.trim(),
      'True',
      `${P} fence arm OPEN via ${name}: the fence did not flip. A fence assertion that has never been ` +
        'observed flipping is not evidence, so this arm is the one that makes the closed arm above mean ' +
        `something. Observed: ${opened.stdout.trim()}, stderr: ${(opened.stderr || '').trim()}`,
    );
  }

  // Only the exact string 1 opens it. A truthy looking value must not.
  const notOne = driveFence(probe, { [VAR_ALLOW]: '0' });
  assert.equal(
    notOne.stdout.trim(),
    'False',
    `${P} fence arm: a value other than the string 1 opened the fence. Observed: ${notOne.stdout.trim()}`,
  );

  const artifacts = countVendoredBytecode();
  assert.deepEqual(
    artifacts,
    [],
    `${P} fence arm: driving the fence planted compiled bytecode inside the guarded vendored tree, which ` +
      'is the exact artifact the vendor integrity guard forbids. Observed: ' + JSON.stringify(artifacts),
  );
});

// ─── test 2: no Ferrox authored file sets either variable ────────────────────

test(`${P}: the scanned surface includes this test file, so the fence has no hole`, () => {
  const files = collectSurfaceFiles(REPO_ROOT, SURFACE_DIRS);
  assert.ok(
    files.includes(__filename),
    `${P} surface arm: the scanner's resolved file list does not contain this test's own path, so the ` +
      'test file would be the 1 place the fence does not reach. Files scanned: ' + files.length,
  );
  assert.ok(
    files.length > 100,
    `${P} surface arm: the scanner resolved only ${files.length} files, which is too few to be the real ` +
      'surface. A scanner that walks almost nothing reports 0 hits for the wrong reason.',
  );
  // Recorded so a later reader can tell a shrinking surface from a clean one.
  console.log(`# ${P}: fence scanner covers ${files.length} files across ${SURFACE_DIRS.length} surface directories`);
});

test(`${P}: no Ferrox authored file sets either fence opt in variable`, () => {
  const files = collectSurfaceFiles(REPO_ROOT, SURFACE_DIRS);
  const hits = scanForOptInVariables(files);
  assert.deepEqual(
    hits,
    [],
    `${P} variable arm CLEAN: a Ferrox authored file names a fence opt in variable. Keeping upstream's ` +
      'fence is worth nothing if this project sets the variable that opens it. Observed: ' + JSON.stringify(hits),
  );
});

test(`${P}: the variable scanner reports against a fixture that DOES set one`, () => {
  const root = scratch('var-fixture');
  const dir = path.join(root, 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'planted-opt-in.sh'),
    `#!/bin/sh\nexport ${VAR_ALLOW}=1\n`,
    'utf8',
  );
  const files = collectSurfaceFiles(root, ['scripts']);
  assert.equal(files.length, 1, `${P} variable arm PLANTED: the fixture walk found ${files.length} files, expected 1`);
  const hits = scanForOptInVariables(files);
  assert.equal(
    hits.length,
    1,
    `${P} variable arm PLANTED: the scanner did not report against a file that sets the opt in variable, ` +
      'so the clean arm above proves nothing. Observed: ' + JSON.stringify(hits),
  );
  assert.match(hits[0], /planted-opt-in\.sh:2:/);

  // The other variable, planted separately, because a scanner that only sees 1
  // of the 2 names would pass the arm above and still leave the fence open.
  const dir2 = path.join(root, 'hooks');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'planted-sandbox.js'), `process.env.${VAR_SANDBOX} = '1';\n`, 'utf8');
  const hits2 = scanForOptInVariables(collectSurfaceFiles(root, ['hooks']));
  assert.equal(
    hits2.length,
    1,
    `${P} variable arm PLANTED (second name): the scanner missed the other opt in variable. Observed: ` +
      JSON.stringify(hits2),
  );
});

// ─── test 3: no Ferrox authored file invokes the maintain entrypoint ─────────

test(`${P}: no Ferrox authored file invokes the maintain entrypoint or its gate verb`, () => {
  const files = collectSurfaceFiles(REPO_ROOT, SURFACE_DIRS);
  const hits = scanForMaintainInvocation(files);
  assert.deepEqual(
    hits,
    [],
    `${P} maintain arm CLEAN: a Ferrox authored file invokes the maintain entrypoint. D1 permits the ` +
      'runner and exec surface only. Observed: ' + JSON.stringify(hits),
  );
});

test(`${P}: the maintain invocation scanner reports against 2 fixtures that DO invoke it`, () => {
  const root = scratch('maintain-fixture');
  const dir = path.join(root, 'scripts');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'planted-spawn.js'),
    `const { spawnSync } = require('node:child_process');\nspawnSync('${MAINTAIN_NAME}', ['gate', '--pr', '7']);\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'planted-shell.sh'),
    `#!/bin/sh\n${MAINTAIN_NAME} gate --ref feature-branch\n`,
    'utf8',
  );
  // A legitimate MENTION, which must NOT be reported. A detector that rejects a
  // correct write is the same defect class as one that cannot fire.
  fs.writeFileSync(
    path.join(dir, 'legitimate-mention.js'),
    `// The vendored ${MAINTAIN_NAME} entrypoint defines the fence this project keeps.\n` +
      `const PINNED = 'bin/${MAINTAIN_NAME}';\nmodule.exports = { PINNED };\n`,
    'utf8',
  );

  const files = collectSurfaceFiles(root, ['scripts']);
  assert.equal(files.length, 3, `${P} maintain arm PLANTED: the fixture walk found ${files.length} files, expected 3`);
  const hits = scanForMaintainInvocation(files);
  assert.equal(
    hits.length,
    2,
    `${P} maintain arm PLANTED: expected exactly 2 reports, 1 per invoking fixture, and 0 for the ` +
      'legitimate mention. Observed: ' + JSON.stringify(hits),
  );
  assert.ok(hits.some((h) => h.includes('planted-spawn.js')), `${P}: the spawn form was not reported`);
  assert.ok(hits.some((h) => h.includes('planted-shell.sh')), `${P}: the shell form was not reported`);
  assert.ok(
    !hits.some((h) => h.includes('legitimate-mention.js')),
    `${P} maintain arm PLANTED: the scanner reported a legitimate mention, which would reject a correct write`,
  );
});

// ─── test 4: the fence file itself is provably unmodified ────────────────────

test(`${P}: the vendored maintain entrypoint still hashes to its pristine pin and carries no ledger entry`, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR_ROOT, 'UPSTREAM-MANIFEST.json'), 'utf8'));
  const pinned = manifest.files[MAINTAIN_KEY];
  assert.ok(pinned, `${P} pin arm: the maintain entrypoint is absent from the pristine manifest`);

  const actual = sha256(MAINTAIN_PATH);
  assert.equal(
    actual,
    pinned.sha256,
    `${P} pin arm: the file that DEFINES the fence no longer matches its pristine pin. D1 says upstream's ` +
      `fence is kept and never modified. Observed ${actual}, pinned ${pinned.sha256}`,
  );

  const ledger = JSON.parse(fs.readFileSync(path.join(VENDOR_ROOT, 'DIVERGENCES.json'), 'utf8'));
  const entries = ledger.divergences.filter((e) => e.file === MAINTAIN_KEY);
  assert.equal(
    entries.length,
    0,
    `${P} pin arm: the maintain entrypoint carries ${entries.length} divergence ledger entries. It must ` +
      'carry 0, so no plan can quietly diverge the fence behind a ledger row.',
  );

  // The predicate itself, read as text, still reads both variable names. A hash
  // match already implies this, but a reader of a failure needs to see which
  // property broke, and this arm names it.
  const text = fs.readFileSync(MAINTAIN_PATH, 'utf8');
  assert.ok(text.includes(VAR_ALLOW), `${P} pin arm: the fence no longer names its first opt in variable`);
  assert.ok(text.includes(VAR_SANDBOX), `${P} pin arm: the fence no longer names its second opt in variable`);
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
