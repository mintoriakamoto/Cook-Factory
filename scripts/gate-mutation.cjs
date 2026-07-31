#!/usr/bin/env node
'use strict';

/**
 * scripts/gate-mutation.cjs — the guard surface mutation gate (phase 20, 20-SC3).
 *
 * A surviving mutant on a guard module means a guard that CANNOT FIRE, which is
 * this repository's recurring defect class. `@stryker-mutator/core` has been in
 * devDependencies with a config file and a `test:mutation` script for some time,
 * and until this gate existed nothing ever ran it as a gate: it reported a score
 * and failed nothing. A gate that cannot fail is itself a guard that cannot fire.
 *
 * Usage:
 *   node scripts/gate-mutation.cjs                    # every roster module
 *   node scripts/gate-mutation.cjs gate-cap           # 1 roster module
 *   node scripts/gate-mutation.cjs --cjs <path> --tests <a,b> --min <n> [--name <n>]
 *
 * Exit codes: 0 when every evaluated module passed or was skipped, 1 when any
 * module scored below its floor, 2 on a usage or infrastructure error.
 *
 * ── THE LOAD BEARING DECISION ────────────────────────────────────────────────
 * The verdict is computed from the PER FILE row of Stryker's json report, never
 * from the pooled score. Stryker applies its own `thresholds.break` to the score
 * pooled across every file in the report, and `stryker.config.mjs` sets
 * `incremental: true`, so a per module `--mutate` run still reports the
 * accumulated cache. Measured during phase 20 planning: a run pointed at
 * `governance-manifest.cjs` reported a pooled 52.57 while the module itself sat
 * at 46.03, because the pool held 3 healthy modules. With 4 healthy modules the
 * same dead guard would have passed. A gate that reads the pooled number cannot
 * fire on the module it was pointed at. Read the row.
 *
 * This gate therefore runs Stryker under a GENERATED config with `incremental`
 * off, an isolated temp dir and `thresholds.break` left unset, so Stryker never
 * renders a verdict of its own and the pool cannot contaminate the measurement.
 * `evaluateModule` still reads the row rather than the pool, because a config is
 * a value somebody can change and the row read is the contract.
 *
 * ── CADENCE ──────────────────────────────────────────────────────────────────
 * Invoked deliberately through `npm run gate:mutation`. It is deliberately NOT
 * in `lint:ci`, which already exceeds 2 minutes, and NOT in `npm test`. A gate
 * that makes the everyday loop slower is a gate somebody removes.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { GUARD_SURFACE } = require('./mutation-matrix.cjs');

const ROOT = path.join(__dirname, '..');

/** Hard ceiling for a single module's Stryker run. The slowest measured roster
 *  module (governance-manifest, 982 mutants) took 19 seconds; 20 minutes is a
 *  runaway stop, not a budget. */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

const Verdict = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  SKIP: 'SKIP',
});

/**
 * Thrown when the report cannot answer the question the gate asked of it.
 * A missing row is NOT a pass: it is the shape a misconfigured `--mutate`
 * argument produces, and silently passing on it is the exact failure this
 * whole gate exists to prevent.
 */
class MutationReportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MutationReportError';
  }
}

/** Thrown when a roster entry is malformed, so a bad table fails loudly. */
class RosterEntryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RosterEntryError';
  }
}

// ── Scoring ───────────────────────────────────────────────────────────────────
// The mutation-testing-elements schema (schemaVersion 1.0, confirmed against a
// live 9.6.1 report): detected = Killed + Timeout; undetected = Survived +
// NoCoverage; everything else (Ignored, CompileError, RuntimeError) is not a
// valid mutant and is excluded from the denominator entirely.

/**
 * @param {Array<{status: string}>} mutants
 * @returns {{ detected: number, undetected: number, valid: number, score: number }}
 */
function scoreFromMutants(mutants) {
  let detected = 0;
  let undetected = 0;
  for (const m of mutants) {
    if (m.status === 'Killed' || m.status === 'Timeout') detected += 1;
    else if (m.status === 'Survived' || m.status === 'NoCoverage') undetected += 1;
  }
  const valid = detected + undetected;
  return { detected, undetected, valid, score: valid === 0 ? 0 : (detected / valid) * 100 };
}

/** Normalise a report key or a roster path to forward slashes for comparison. */
function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

/**
 * Find the per file row for `cjsPath` in a parsed Stryker json report.
 * Matches the exact key first, then any key that ends with the same relative
 * path, because Stryker has emitted both relative and absolute keys across
 * versions.
 *
 * @returns {{ key: string, file: object } | null}
 */
function findFileRow(report, cjsPath) {
  const files = (report && report.files) || {};
  const want = toPosix(cjsPath);
  if (Object.prototype.hasOwnProperty.call(files, cjsPath)) {
    return { key: cjsPath, file: files[cjsPath] };
  }
  for (const key of Object.keys(files)) {
    const k = toPosix(key);
    if (k === want || k.endsWith(`/${want}`)) return { key, file: files[key] };
  }
  return null;
}

// ── The pure verdict ──────────────────────────────────────────────────────────

/**
 * Decide 1 module's verdict from a roster entry and a parsed report. PURE:
 * no filesystem, no clock, no subprocess. Every verdict arm in
 * tests/gate-mutation.test.cjs drives this directly with a hand built report,
 * which is why the fast battery never launches Stryker.
 *
 * @param {{ name: string, entry: object, report: object }} args
 * @returns {{ verdict: string, name: string, score: number|null, floor: number|null,
 *             detected: number|null, valid: number|null, reason: string|null }}
 */
function evaluateModule({ name, entry, report }) {
  if (!entry || typeof entry !== 'object') {
    throw new RosterEntryError(`roster entry for "${name}" is missing`);
  }

  const hasFloor = typeof entry.minScore === 'number';
  const hasExcluded = typeof entry.excluded === 'string' && entry.excluded.length > 0;

  if (hasFloor && hasExcluded) {
    throw new RosterEntryError(
      `roster entry "${name}" carries BOTH minScore and excluded; it must carry exactly 1`
    );
  }
  if (!hasFloor && !hasExcluded) {
    throw new RosterEntryError(
      `roster entry "${name}" carries NEITHER minScore nor a non-empty excluded reason`
    );
  }

  // An excluded module is named, with its reason, and contributes no failure.
  if (hasExcluded) {
    return {
      verdict: Verdict.SKIP,
      name,
      score: null,
      floor: null,
      detected: null,
      valid: null,
      reason: entry.excluded,
    };
  }

  const row = findFileRow(report, entry.cjs);
  if (row === null) {
    throw new MutationReportError(
      `the report carries no row for "${name}" (${entry.cjs}). An absent row is not a pass: ` +
        `it is what a misconfigured --mutate argument produces. ` +
        `Rows present: ${Object.keys((report && report.files) || {}).join(', ') || '(none)'}`
    );
  }

  const mutants = Array.isArray(row.file.mutants) ? row.file.mutants : [];
  const { detected, valid, score } = scoreFromMutants(mutants);

  // Zero valid mutants is a vacuous pass: "nothing survived" is trivially true
  // of an empty mutant set. Refuse it the same way an absent row is refused.
  if (valid === 0) {
    throw new MutationReportError(
      `the row for "${name}" (${row.key}) carries 0 valid mutants, so its score would be ` +
        `vacuously true. A module with nothing to kill is not a module under a gate.`
    );
  }

  return {
    verdict: score >= entry.minScore ? Verdict.PASS : Verdict.FAIL,
    name,
    score,
    floor: entry.minScore,
    detected,
    valid,
    reason: null,
  };
}

// ── The impure runner ─────────────────────────────────────────────────────────

/**
 * Build the generated Stryker config for 1 module. Kept pure and exported so a
 * test can assert its shape without launching anything.
 *
 * @returns {object}
 */
function buildStrykerConfig({ entry, workDir }) {
  return {
    testRunner: 'command',
    commandRunner: {
      command: `node --test ${entry.tests.join(' ')}`,
    },
    mutate: [entry.cjs],
    coverageAnalysis: 'off',
    reporters: ['json'],
    jsonReporter: { fileName: path.join(workDir, 'mutation.json') },
    // Off, and isolated. The incremental cache is what pools an accumulated
    // score across modules; see the header. Each run measures 1 module only.
    incremental: false,
    tempDirName: path.join(workDir, '.stryker-tmp'),
    cleanTempDir: 'always',
    // NO thresholds.break. Stryker renders no verdict here — this gate does,
    // from the per file row.
    logLevel: 'off',
    // ─── WHY THE AGENT STATE DIRECTORIES ARE HERE (FF-B337) ─────────────────
    //
    // Stryker builds its sandbox by COPYING the working tree, and a copy is not
    // atomic. Anything that appears and disappears between the enumeration and
    // the copy makes the whole run die on ENOENT, and a run that dies produces
    // NO REPORT, which this gate reports as exit 2, an infrastructure error.
    //
    // That is not hypothetical. Both observed arms of tests/gate-mutation.test.cjs
    // failed inside the full suite, and passed in isolation, on exactly this:
    //
    //   ENOENT: copyfile '.ijfw/index/.files.tmp' -> '<sandbox>/.ijfw/index/.files.tmp'
    //
    // `.ijfw/` is agent tooling state that is rewritten continuously while the
    // suite runs, and `.claude/` is the same for the harness. NEITHER holds
    // source under mutation and neither holds a test input, so copying them buys
    // nothing and costs a flaky gate whose failure mode is an infrastructure
    // error dressed as a verdict. `.ferrox/` is already excluded by gitignore.
    //
    // The narrow alternative, ignoring only the 1 temp file that was observed,
    // would leave every OTHER transient file in those trees able to do the same
    // thing on a different day. The directory is the unit of the defect.
    ignorePatterns: [
      'node_modules', 'reports', '.stryker-tmp', 'coverage', 'hooks/dist',
      '.ijfw', '.claude',
    ],
  };
}

/**
 * Resolve the Stryker entry script without depending on a `.bin` shim, which is
 * a `.cmd` on Windows and a symlink elsewhere.
 *
 * `require.resolve('@stryker-mutator/core/bin/stryker.js')` does NOT work: the
 * package's `exports` map does not publish that subpath, and Node refuses it
 * with ERR_PACKAGE_PATH_NOT_EXPORTED. `./package.json` IS exported, so resolve
 * that, then read the declared `bin` entry and join it to the package root.
 * Reading the field rather than hardcoding the path means an upstream move of
 * the entry script is followed rather than guessed.
 */
function resolveStrykerBin() {
  const pkgPath = require.resolve('@stryker-mutator/core/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.stryker;
  if (!rel) {
    throw new MutationReportError(
      '@stryker-mutator/core declares no `bin` entry, so the gate has nothing to invoke'
    );
  }
  return path.join(path.dirname(pkgPath), rel);
}

/**
 * Environment variables that MUST NOT reach Stryker's command runner.
 *
 * NODE_TEST_CONTEXT is the load bearing one, and it is not a theoretical
 * concern: it was observed silently zeroing this gate. `node:test` sets
 * NODE_TEST_CONTEXT=child-v8 in every process it spawns, and a nested
 * `node --test` that sees it reports through the v8 serializer and **exits 0
 * even when its tests fail**:
 *
 *     node --test failing.spec.cjs                        -> exit 1
 *     NODE_TEST_CONTEXT=child-v8 node --test failing.spec.cjs -> exit 0
 *
 * Stryker's command runner decides a mutant is KILLED from a non-zero exit. So
 * when this gate is driven from inside a node:test parent (which is exactly how
 * its own observed arms drive it), every mutant would be reported as SURVIVED
 * and every module would score 0.00. That is a gate reporting numbers that are
 * not measurements, which is the same class of defect as a gate that cannot
 * fire. Scrub it.
 *
 * NODE_V8_COVERAGE is scrubbed too: under `npm run test:coverage` it would make
 * every one of the hundreds of mutant runs write a coverage profile.
 */
const SCRUBBED_ENV_KEYS = Object.freeze(['NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE']);

/**
 * Build the environment Stryker runs under, with the test-runner leakage removed.
 * Pure, and exported so the scrub is asserted rather than assumed.
 *
 * @param {object} baseEnv
 * @returns {object}
 */
function scrubEnv(baseEnv) {
  const env = { ...baseEnv };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  return env;
}

/**
 * Run Stryker over 1 module and return its parsed json report.
 * `spawn` is injected so tests can drive this without launching Stryker.
 *
 * @param {{ name: string, entry: object, workDir?: string, spawn?: Function,
 *           timeoutMs?: number, env?: object }} args
 * @returns {object} the parsed report
 */
function runModule({ name, entry, workDir, spawn, timeoutMs, env }) {
  const run = spawn || execFileSync;
  const dir =
    workDir || fs.mkdtempSync(path.join(os.tmpdir(), `ferrox-gate-mutation-${name}-`));
  fs.mkdirSync(dir, { recursive: true });

  const config = buildStrykerConfig({ entry, workDir: dir });
  const configPath = path.join(dir, `stryker.gate.${name}.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  try {
    run(process.execPath, [resolveStrykerBin(), 'run', configPath], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: scrubEnv(env || process.env),
    });
  } catch (err) {
    // A non-zero Stryker exit is not automatically fatal: the report may still
    // have been written. Only a missing report is unrecoverable, and that is
    // checked immediately below with the spawn failure attached.
    if (!fs.existsSync(config.jsonReporter.fileName)) {
      const detail = (err && (err.stderr || err.message)) || String(err);
      throw new MutationReportError(
        `Stryker produced no report for "${name}" (${entry.cjs}): ${detail}`
      );
    }
  }

  const reportPath = config.jsonReporter.fileName;
  if (!fs.existsSync(reportPath)) {
    throw new MutationReportError(
      `Stryker produced no report for "${name}" at ${reportPath}`
    );
  }
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

// ── Presentation ──────────────────────────────────────────────────────────────

/**
 * One line per module, naming the verdict, the module, its score and its floor.
 * The refusal arm asserts against this text, so the failure output has to name
 * what failed and by how much rather than only setting an exit code.
 */
function formatVerdict(result) {
  if (result.verdict === Verdict.SKIP) {
    return `SKIP ${result.name}: ${result.reason}`;
  }
  const score = result.score.toFixed(2);
  return (
    `${result.verdict} ${result.name}: score ${score} floor ${result.floor} ` +
    `(${result.detected}/${result.valid} mutants killed)`
  );
}

// ── Argument parsing ──────────────────────────────────────────────────────────

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{ moduleName: string|null, adhoc: object|null, workDir: string|null,
 *             timeoutMs: number|null }}
 */
function parseArgs(argv) {
  const out = { moduleName: null, adhoc: null, workDir: null, timeoutMs: null };
  const ad = { cjs: null, tests: null, min: null, name: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(
        [
          'Usage:',
          '  node scripts/gate-mutation.cjs [module]',
          '  node scripts/gate-mutation.cjs --cjs <path> --tests <a,b> --min <n> [--name <n>]',
          '',
          'Options:',
          '  --cjs <path>      ad-hoc subject to mutate instead of a roster module',
          '  --tests <a,b>     comma separated test files for the ad-hoc subject',
          '  --min <n>         floor for the ad-hoc subject, 1-100',
          '  --name <n>        label for the ad-hoc subject (default: its basename)',
          '  --work-dir <dir>  where the generated config, temp dir and report go',
          '  --timeout-ms <n>  per module runaway stop',
        ].join('\n')
      );
      throw new ExitError(0);
    } else if (arg === '--cjs') {
      ad.cjs = argv[++i];
    } else if (arg === '--tests') {
      ad.tests = argv[++i];
    } else if (arg === '--min') {
      ad.min = argv[++i];
    } else if (arg === '--name') {
      ad.name = argv[++i];
    } else if (arg === '--work-dir') {
      out.workDir = argv[++i];
    } else if (arg === '--timeout-ms') {
      out.timeoutMs = Number(argv[++i]);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument: ${arg}`);
    } else if (out.moduleName === null) {
      out.moduleName = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (ad.cjs !== null || ad.tests !== null || ad.min !== null) {
    if (!ad.cjs || !ad.tests || ad.min === null || ad.min === undefined) {
      throw new Error('--cjs, --tests and --min must be given together');
    }
    const min = Number(ad.min);
    if (!Number.isFinite(min) || min < 1 || min > 100) {
      throw new Error(`--min invalid: "${ad.min}" (expected a floor 1-100)`);
    }
    const tests = ad.tests.split(',').map(t => t.trim()).filter(Boolean);
    if (tests.length === 0) throw new Error('--tests requires at least 1 file');
    out.adhoc = {
      name: ad.name || path.basename(ad.cjs).replace(/\.cjs$/, ''),
      entry: { cjs: ad.cjs, tests, minScore: min },
    };
  }

  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Resolve which (name, entry) pairs this invocation evaluates.
 * Exported so a test can assert selection without running anything.
 */
function selectTargets({ moduleName, adhoc, roster }) {
  if (adhoc) return [[adhoc.name, adhoc.entry]];
  if (moduleName !== null) {
    if (!Object.prototype.hasOwnProperty.call(roster, moduleName)) {
      throw new Error(
        `unknown module: "${moduleName}". Roster: ${Object.keys(roster).join(', ')}`
      );
    }
    return [[moduleName, roster[moduleName]]];
  }
  return Object.entries(roster);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ExitError) throw err;
    console.error(`gate-mutation: ${err.message}`);
    throw new ExitError(2);
  }

  let targets;
  try {
    targets = selectTargets({
      moduleName: args.moduleName,
      adhoc: args.adhoc,
      roster: GUARD_SURFACE,
    });
  } catch (err) {
    console.error(`gate-mutation: ${err.message}`);
    throw new ExitError(2);
  }

  let failed = 0;
  for (const [name, entry] of targets) {
    let result;
    try {
      const isExcluded = typeof entry.excluded === 'string' && entry.excluded.length > 0;
      const report = isExcluded
        ? null
        : runModule({
            name,
            entry,
            workDir: args.workDir
              ? path.join(args.workDir, name)
              : null,
            timeoutMs: args.timeoutMs,
          });
      result = evaluateModule({ name, entry, report });
    } catch (err) {
      console.error(`ERROR ${name}: ${err.message}`);
      throw new ExitError(2);
    }
    console.log(formatVerdict(result));
    if (result.verdict === Verdict.FAIL) failed += 1;
  }

  if (failed > 0) {
    console.error(
      `gate-mutation: ${failed} module(s) below floor. A surviving mutant on a guard ` +
        `module is a guard that cannot fire.`
    );
    throw new ExitError(1);
  }
}

module.exports = {
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
  DEFAULT_TIMEOUT_MS,
};

if (require.main === module) runMain(main);
