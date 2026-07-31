'use strict';

/**
 * tests/gate-mutation.test.cjs — the guard surface mutation gate.
 *
 * Two batteries and 2 slow arms:
 *
 *   1. the VERDICT battery drives `evaluateModule` with hand built reports, so
 *      it runs in well under a second and never launches Stryker;
 *   2. the ROSTER battery checks GUARD_SURFACE against the filesystem, so the
 *      table cannot rot into a list of names;
 *   3. the OBSERVED arms drive the real binary over a fixture, because a report
 *      a test authored is not evidence that Stryker produces that shape, and a
 *      threshold nobody has watched reject something is not a threshold.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'gate-mutation.cjs');

const {
  Verdict,
  MutationReportError,
  RosterEntryError,
  scoreFromMutants,
  findFileRow,
  evaluateModule,
  buildStrykerConfig,
  scrubEnv,
  SCRUBBED_ENV_KEYS,
  runModule,
  formatVerdict,
  parseArgs,
  selectTargets,
} = require(GATE);

const { GUARD_SURFACE } = require(path.join(ROOT, 'scripts', 'mutation-matrix.cjs'));

const SCRATCH_ROOTS = [];
function scratch(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-gate-mutation-${label}-`));
  SCRATCH_ROOTS.push(dir);
  return dir;
}

/** Build a report row of `killed` Killed mutants and `survived` Survived ones. */
function row(killed, survived) {
  const mutants = [];
  for (let i = 0; i < killed; i++) mutants.push({ id: `k${i}`, status: 'Killed' });
  for (let i = 0; i < survived; i++) mutants.push({ id: `s${i}`, status: 'Survived' });
  return { language: 'javascript', source: '', mutants };
}

/** A report whose `files` map is built from { path: [killed, survived] }. */
function report(spec) {
  const files = {};
  for (const [p, [k, s]] of Object.entries(spec)) files[p] = row(k, s);
  return { schemaVersion: '1.0', files };
}

// ─── 1. the verdict battery ───────────────────────────────────────────────────

test('evaluateModule returns PASS when the per file score is above its floor', () => {
  const entry = { cjs: 'lib/a.cjs', tests: ['t.cjs'], minScore: 50 };
  const r = evaluateModule({
    name: 'a',
    entry,
    report: report({ 'lib/a.cjs': [9, 1] }), // 90.00
  });
  assert.strictEqual(r.verdict, Verdict.PASS);
  assert.strictEqual(r.score, 90);
  assert.strictEqual(r.floor, 50);
});

test('evaluateModule returns PASS when the score sits EXACTLY on its floor', () => {
  // The boundary is the whole point: this repository's own gate-cap.cjs ships a
  // surviving `>=` to `>` mutant precisely because no test pinned its boundary.
  const entry = { cjs: 'lib/a.cjs', tests: ['t.cjs'], minScore: 80 };
  const r = evaluateModule({
    name: 'a',
    entry,
    report: report({ 'lib/a.cjs': [8, 2] }), // exactly 80.00
  });
  assert.strictEqual(r.verdict, Verdict.PASS, 'at the floor is at or above the floor');
  assert.strictEqual(r.score, 80);
});

test('evaluateModule returns FAIL one point below the floor', () => {
  const entry = { cjs: 'lib/a.cjs', tests: ['t.cjs'], minScore: 80 };
  const r = evaluateModule({
    name: 'a',
    entry,
    report: report({ 'lib/a.cjs': [79, 21] }), // 79.00
  });
  assert.strictEqual(r.verdict, Verdict.FAIL);
  assert.strictEqual(r.score, 79);
});

test('evaluateModule returns FAIL when a healthy POOL hides a failing module', () => {
  // This is the arm that separates this gate from one that cannot fire on the
  // module it names. Phase 20 CONTEXT.md C3: a run pointed at governance-manifest
  // reported a pooled 52.57 while the module itself was at 46.03, because the
  // pool held 3 healthy modules.
  const entry = { cjs: 'lib/target.cjs', tests: ['t.cjs'], minScore: 80 };
  const pooled = report({
    'lib/target.cjs': [40, 60], // 40.00 — the module under test, well below floor
    'lib/healthy-1.cjs': [100, 0], // 100.00
    'lib/healthy-2.cjs': [100, 0], // 100.00
    'lib/healthy-3.cjs': [100, 0], // 100.00
  });

  // Prove the pool really does pass, so the arm is not vacuous.
  const allMutants = Object.values(pooled.files).flatMap(f => f.mutants);
  const pooledScore = scoreFromMutants(allMutants).score;
  assert.ok(
    pooledScore >= entry.minScore,
    `the pooled score must clear the floor for this arm to mean anything (got ${pooledScore})`
  );

  const r = evaluateModule({ name: 'target', entry, report: pooled });
  assert.strictEqual(r.verdict, Verdict.FAIL, 'the row decides, not the pool');
  assert.strictEqual(r.score, 40);
});

test('evaluateModule returns SKIP with the recorded reason for an excluded module', () => {
  const entry = {
    cjs: 'lib/x.cjs',
    tests: ['t.cjs'],
    excluded: 'its test shells to git and the sandbox has none',
  };
  const r = evaluateModule({ name: 'x', entry, report: report({}) });
  assert.strictEqual(r.verdict, Verdict.SKIP);
  assert.strictEqual(r.reason, 'its test shells to git and the sandbox has none');
  assert.strictEqual(r.score, null);
});

test('a SKIP never contributes a failure to the command line exit code', () => {
  // An excluded module never reaches Stryker, so this arm is fast and launches
  // nothing: it is the CLI proving that SKIP is not a failure.
  const res = spawnSync(process.execPath, [GATE, 'atomic-state'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
  assert.match(res.stdout, /^SKIP atomic-state: /m);
});

test('evaluateModule THROWS a named error when the report has no row for the module', () => {
  const entry = { cjs: 'lib/absent.cjs', tests: ['t.cjs'], minScore: 50 };
  assert.throws(
    () => evaluateModule({ name: 'absent', entry, report: report({ 'lib/other.cjs': [1, 0] }) }),
    err => {
      assert.ok(err instanceof MutationReportError, 'the error is named, not generic');
      assert.strictEqual(err.name, 'MutationReportError');
      assert.match(err.message, /no row for "absent"/);
      return true;
    },
    'an absent row must never be treated as a pass'
  );
});

test('evaluateModule THROWS when the row carries 0 valid mutants, refusing a vacuous pass', () => {
  const entry = { cjs: 'lib/empty.cjs', tests: ['t.cjs'], minScore: 50 };
  assert.throws(
    () => evaluateModule({ name: 'empty', entry, report: report({ 'lib/empty.cjs': [0, 0] }) }),
    err => {
      assert.strictEqual(err.name, 'MutationReportError');
      assert.match(err.message, /0 valid mutants/);
      return true;
    }
  );
});

test('evaluateModule THROWS on a roster entry carrying both minScore and excluded', () => {
  assert.throws(
    () =>
      evaluateModule({
        name: 'both',
        entry: { cjs: 'lib/b.cjs', tests: [], minScore: 50, excluded: 'why' },
        report: report({}),
      }),
    err => {
      assert.strictEqual(err.name, 'RosterEntryError');
      return true;
    }
  );
});

test('evaluateModule THROWS on a roster entry carrying neither minScore nor excluded', () => {
  assert.throws(
    () =>
      evaluateModule({
        name: 'neither',
        entry: { cjs: 'lib/b.cjs', tests: [] },
        report: report({}),
      }),
    err => {
      assert.ok(err instanceof RosterEntryError);
      return true;
    }
  );
});

test('scoreFromMutants counts Timeout as detected and excludes Ignored from the denominator', () => {
  const s = scoreFromMutants([
    { status: 'Killed' },
    { status: 'Timeout' },
    { status: 'Survived' },
    { status: 'NoCoverage' },
    { status: 'Ignored' },
    { status: 'CompileError' },
  ]);
  assert.strictEqual(s.detected, 2);
  assert.strictEqual(s.undetected, 2);
  assert.strictEqual(s.valid, 4, 'Ignored and CompileError are not valid mutants');
  assert.strictEqual(s.score, 50);
});

test('findFileRow matches an absolute report key against a relative roster path', () => {
  const r = {
    files: { '/abs/repo/ferrox-core/bin/lib/a.cjs': row(1, 0) },
  };
  const found = findFileRow(r, 'ferrox-core/bin/lib/a.cjs');
  assert.ok(found, 'a report keyed absolutely still answers for a relative roster path');
  assert.strictEqual(found.key, '/abs/repo/ferrox-core/bin/lib/a.cjs');
});

test('findFileRow does NOT match a merely similar suffix', () => {
  const r = { files: { 'other/xa.cjs': row(1, 0) } };
  assert.strictEqual(findFileRow(r, 'a.cjs'), null, 'xa.cjs is not a.cjs');
});

test('formatVerdict names the module, its score and its floor', () => {
  const line = formatVerdict({
    verdict: Verdict.FAIL,
    name: 'gate-cap',
    score: 33.333333,
    floor: 90,
    detected: 3,
    valid: 9,
    reason: null,
  });
  assert.match(line, /FAIL gate-cap/);
  assert.match(line, /score 33\.33/);
  assert.match(line, /floor 90/);
});

// ─── the config the runner generates ──────────────────────────────────────────

test('buildStrykerConfig disables incremental and sets NO break threshold', () => {
  const cfg = buildStrykerConfig({
    entry: { cjs: 'lib/a.cjs', tests: ['t1.cjs', 't2.cjs'], minScore: 50 },
    workDir: path.join('some', 'work'),
  });
  assert.strictEqual(cfg.incremental, false, 'the incremental cache is what pools the score');
  assert.strictEqual(cfg.thresholds, undefined, 'this gate renders the verdict, not Stryker');
  assert.deepStrictEqual(cfg.mutate, ['lib/a.cjs']);
  assert.deepStrictEqual(cfg.reporters, ['json']);
  assert.strictEqual(cfg.commandRunner.command, 'node --test t1.cjs t2.cjs');
});

test('scrubEnv removes NODE_TEST_CONTEXT, which silently zeroes every mutant', () => {
  // Observed, not theorised: `node --test failing.spec.cjs` exits 1, but
  // `NODE_TEST_CONTEXT=child-v8 node --test failing.spec.cjs` exits 0. Stryker
  // reads a non-zero exit as a kill, so leaking this var makes every module
  // score 0.00 and every reported number a non-measurement.
  const scrubbed = scrubEnv({ NODE_TEST_CONTEXT: 'child-v8', PATH: '/usr/bin', FOO: 'bar' });
  assert.ok(!('NODE_TEST_CONTEXT' in scrubbed), 'NODE_TEST_CONTEXT must not reach Stryker');
  assert.strictEqual(scrubbed.PATH, '/usr/bin', 'the rest of the environment is preserved');
  assert.strictEqual(scrubbed.FOO, 'bar');
});

test('scrubEnv removes NODE_V8_COVERAGE and mutates no caller object', () => {
  const base = { NODE_V8_COVERAGE: '/cov', KEEP: '1' };
  const scrubbed = scrubEnv(base);
  assert.ok(!('NODE_V8_COVERAGE' in scrubbed));
  assert.strictEqual(base.NODE_V8_COVERAGE, '/cov', 'the caller env is not mutated');
  assert.deepStrictEqual([...SCRUBBED_ENV_KEYS].sort(), ['NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE']);
});

test('runModule passes the SCRUBBED environment to the spawn', () => {
  const dir = scratch('scrubbed');
  let sawOpts = null;
  runModule({
    name: 'a',
    entry: { cjs: 'lib/a.cjs', tests: ['t.cjs'], minScore: 50 },
    workDir: dir,
    env: { NODE_TEST_CONTEXT: 'child-v8', PATH: '/usr/bin' },
    spawn: (cmd, args, opts) => {
      sawOpts = opts;
      const cfg = JSON.parse(fs.readFileSync(args[args.length - 1], 'utf8'));
      fs.writeFileSync(
        cfg.jsonReporter.fileName,
        JSON.stringify(report({ 'lib/a.cjs': [1, 0] })),
        'utf8'
      );
      return '';
    },
  });
  assert.ok(!('NODE_TEST_CONTEXT' in sawOpts.env), 'the spawn env is scrubbed');
  assert.strictEqual(sawOpts.env.PATH, '/usr/bin');
});

test('runModule reads the report the run produced, with the spawn injected', () => {
  const dir = scratch('injected');
  const entry = { cjs: 'lib/a.cjs', tests: ['t.cjs'], minScore: 50 };
  let sawArgs = null;

  const parsed = runModule({
    name: 'a',
    entry,
    workDir: dir,
    spawn: (cmd, args) => {
      sawArgs = args;
      // Stand in for Stryker: write the report the real binary would write.
      const cfg = JSON.parse(fs.readFileSync(args[args.length - 1], 'utf8'));
      fs.writeFileSync(
        cfg.jsonReporter.fileName,
        JSON.stringify(report({ 'lib/a.cjs': [7, 3] })),
        'utf8'
      );
      return '';
    },
  });

  assert.strictEqual(sawArgs[1], 'run', 'the binary is invoked as `stryker run <config>`');
  const r = evaluateModule({ name: 'a', entry, report: parsed });
  assert.strictEqual(r.verdict, Verdict.PASS);
  assert.strictEqual(r.score, 70);
});

test('runModule THROWS a named error when the run produced no report at all', () => {
  const dir = scratch('noreport');
  assert.throws(
    () =>
      runModule({
        name: 'a',
        entry: { cjs: 'lib/a.cjs', tests: ['t.cjs'], minScore: 50 },
        workDir: dir,
        spawn: () => '', // writes nothing
      }),
    err => {
      assert.strictEqual(err.name, 'MutationReportError');
      assert.match(err.message, /no report/);
      return true;
    }
  );
});

// ─── argument handling ────────────────────────────────────────────────────────

test('parseArgs reads the module name from a bare positional', () => {
  assert.strictEqual(parseArgs(['gate-cap']).moduleName, 'gate-cap');
});

test('parseArgs builds an ad-hoc entry from --cjs, --tests and --min', () => {
  const a = parseArgs(['--cjs', 'x/y.cjs', '--tests', 'a.cjs,b.cjs', '--min', '90']);
  assert.deepStrictEqual(a.adhoc.entry, {
    cjs: 'x/y.cjs',
    tests: ['a.cjs', 'b.cjs'],
    minScore: 90,
  });
  assert.strictEqual(a.adhoc.name, 'y');
});

test('parseArgs REFUSES a --min outside 1-100 rather than gating on nonsense', () => {
  assert.throws(() => parseArgs(['--cjs', 'a.cjs', '--tests', 't.cjs', '--min', '0']), /min invalid/);
  assert.throws(() => parseArgs(['--cjs', 'a.cjs', '--tests', 't.cjs', '--min', 'x']), /min invalid/);
});

test('parseArgs REFUSES a partial ad-hoc entry', () => {
  assert.throws(() => parseArgs(['--cjs', 'a.cjs']), /must be given together/);
});

test('selectTargets refuses an unknown module rather than evaluating nothing', () => {
  assert.throws(
    () => selectTargets({ moduleName: 'nope', adhoc: null, roster: GUARD_SURFACE }),
    /unknown module: "nope"/
  );
});

test('selectTargets with no module name returns the WHOLE roster', () => {
  const t = selectTargets({ moduleName: null, adhoc: null, roster: GUARD_SURFACE });
  assert.strictEqual(t.length, Object.keys(GUARD_SURFACE).length);
});

// ─── 2. the roster battery ────────────────────────────────────────────────────

test('every roster entry carries exactly 1 of minScore and excluded', () => {
  for (const [name, entry] of Object.entries(GUARD_SURFACE)) {
    const hasFloor = typeof entry.minScore === 'number';
    const hasEx = typeof entry.excluded === 'string' && entry.excluded.length > 0;
    assert.notStrictEqual(
      hasFloor,
      hasEx,
      `${name} must carry exactly 1 of minScore and a non-empty excluded reason`
    );
  }
});

test('every roster floor is a number in 1-100', () => {
  for (const [name, entry] of Object.entries(GUARD_SURFACE)) {
    if (typeof entry.minScore !== 'number') continue;
    assert.ok(
      Number.isFinite(entry.minScore) && entry.minScore >= 1 && entry.minScore <= 100,
      `${name} floor ${entry.minScore} is outside 1-100`
    );
  }
});

test('every non-excluded roster entry names a built artifact that EXISTS on disk', () => {
  for (const [name, entry] of Object.entries(GUARD_SURFACE)) {
    if (typeof entry.excluded === 'string') continue;
    const abs = path.join(ROOT, entry.cjs);
    assert.ok(
      fs.existsSync(abs),
      `${name} names ${entry.cjs}, which does not exist. A roster entry pointing at ` +
        `nothing is a guard module silently out of scope.`
    );
  }
});

test('every roster entry names at least 1 test file, and all of them exist on disk', () => {
  for (const [name, entry] of Object.entries(GUARD_SURFACE)) {
    assert.ok(Array.isArray(entry.tests) && entry.tests.length > 0, `${name} names no tests`);
    for (const t of entry.tests) {
      assert.ok(fs.existsSync(path.join(ROOT, t)), `${name} names ${t}, which does not exist`);
    }
  }
});

test('the 4 named guard modules are ALL present, so the surface cannot shrink silently', () => {
  // This is the arm that stops a future edit quietly dropping a guard out of
  // scope, which is the same failure shape scripts/lint-pr-check-project-dir.cjs
  // exhibits today via .filter(existsSync).
  for (const required of [
    'gate-cap',
    'governance-manifest',
    'fleet-capability',
    'strength-severity-route',
  ]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(GUARD_SURFACE, required),
      `${required} was dropped from GUARD_SURFACE. Removing a guard module from the ` +
        `roster removes it from the gate; that is a decision, not a cleanup.`
    );
    assert.strictEqual(
      typeof GUARD_SURFACE[required].minScore,
      'number',
      `${required} must carry a numeric floor, not an exclusion`
    );
  }
});

test('every EXCLUDED entry carries a non-empty reason, never a bare omission', () => {
  const excluded = Object.entries(GUARD_SURFACE).filter(([, e]) => e.excluded !== undefined);
  assert.ok(excluded.length > 0, 'the exclusion arm is not vacuous');
  for (const [name, entry] of excluded) {
    assert.strictEqual(typeof entry.excluded, 'string', `${name} exclusion is not a string`);
    assert.ok(entry.excluded.trim().length > 20, `${name} exclusion reason is not a reason`);
  }
});

test('the gate is wired to gate:mutation and to NEITHER lint:ci NOR npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['gate:mutation'], 'node scripts/gate-mutation.cjs');
  assert.ok(
    !pkg.scripts['lint:ci'].includes('gate-mutation'),
    'lint:ci already exceeds 2 minutes; a gate that slows the everyday loop gets removed'
  );
  assert.ok(!pkg.scripts.test.includes('gate-mutation'), 'npm test does not run the gate');
  assert.ok(!pkg.scripts.pretest.includes('gate-mutation'), 'pretest does not run the gate');
});

// ─── 3. the observed arms: the real binary, over a fixture ────────────────────
//
// Measured on this machine: each arm is a 9 mutant subject with a sub-second
// test set and completes in roughly 4 seconds. Both arms are pointed at their
// OWN work directory, because a shared Stryker cache would make the second arm's
// result depend on the first arm's, and a test whose result depends on run order
// is not evidence.

const FIXTURE_SUBJECT = 'tests/fixtures/gate-mutation/weak/subject.cjs';
const FIXTURE_WEAK = 'tests/fixtures/gate-mutation/weak/subject.spec.cjs';
const FIXTURE_STRONG = 'tests/fixtures/gate-mutation/strong/subject.spec.cjs';

/** Drive the real gate CLI over the fixture with the given test set and floor. */
function runGateOnFixture({ label, tests, min }) {
  const dir = scratch(label);
  return spawnSync(
    process.execPath,
    [
      GATE,
      '--cjs', FIXTURE_SUBJECT,
      '--tests', tests,
      '--min', String(min),
      '--name', 'fixture',
      '--work-dir', dir,
    ],
    { cwd: ROOT, encoding: 'utf8' }
  );
}

test('the fixture subject and both of its arms exist', () => {
  for (const f of [FIXTURE_SUBJECT, FIXTURE_WEAK, FIXTURE_STRONG]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing`);
  }
});

test('OBSERVED REFUSAL: the gate exits NON ZERO on a weakly tested subject', { timeout: 300000 }, () => {
  const res = runGateOnFixture({ label: 'weak', tests: FIXTURE_WEAK, min: 90 });

  assert.notStrictEqual(
    res.status,
    0,
    `the gate must refuse a subject below its floor. stdout: ${res.stdout} stderr: ${res.stderr}`
  );
  assert.strictEqual(res.status, 1, 'exit 1 is the below-floor verdict, not an infrastructure error');

  // Asserting only the exit code would pass if the gate died for an unrelated
  // reason, which is the shape of a guard that fires for the wrong reason.
  assert.match(res.stdout, /^FAIL fixture: /m, 'the refusal names the module');
  assert.match(res.stdout, /score \d+\.\d+ floor 90/, 'the refusal names the score and the floor');

  const m = res.stdout.match(/score (\d+\.\d+) floor 90/);
  const score = Number(m[1]);
  assert.ok(score < 90, `the reported score ${score} must actually be below the floor`);

  // The refusal must be a MEASUREMENT, not a collapse. A score of exactly 0.00
  // means the test command never signalled a kill at all, and this arm would
  // then be passing for the wrong reason. That is not hypothetical: leaking
  // NODE_TEST_CONTEXT into Stryker's command runner produced exactly 0.00 here,
  // and this assertion is what caught it.
  assert.ok(
    score > 0,
    `the weak arm scored ${score}, so NOTHING was killed. The gate is not measuring; ` +
      `it is collapsing. Check that the Stryker command runner's environment is scrubbed.`
  );
  assert.match(res.stdout, /\(\d+\/9 mutants killed\)/, 'the subject yields 9 valid mutants');
});

test('OBSERVED PASS: the same fixture with a real test set exits 0', { timeout: 300000 }, () => {
  const res = runGateOnFixture({ label: 'strong', tests: FIXTURE_STRONG, min: 90 });

  assert.strictEqual(
    res.status,
    0,
    `the gate must pass a subject above its floor. stdout: ${res.stdout} stderr: ${res.stderr}`
  );
  assert.match(res.stdout, /^PASS fixture: /m);
  const m = res.stdout.match(/score (\d+\.\d+) floor 90/);
  assert.ok(m && Number(m[1]) >= 90, `the reported score must clear the floor, got ${m && m[1]}`);
});

test.after(() => {
  for (const dir of SCRATCH_ROOTS) {
    try {
      // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch { /* best effort */ }
  }
});
