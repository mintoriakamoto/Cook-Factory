'use strict';

/**
 * THE COMMIT STALENESS SIGNAL HAS TO REACH A HUMAN, WITH ITS TRI STATE INTACT.
 *
 * `commit_stale` was computed correctly and read by nobody. A grep for it over
 * src/, scripts/ and tests/ returned exactly 1 file: the file that emits it. The
 * neighbouring TIME based `stale` field IS consumed, so a graph 30 commits
 * behind but written to disk 3 hours ago reported `stale: false` and the only
 * consumer that existed said nothing at all.
 *
 * So this file refuses to assert that `commit_stale` is present in the payload.
 * It has been present all along, and its presence IS the defect. Every arm here
 * drives the RENDERED ADVISORY, which is the thing a reader actually sees.
 *
 * 3 things are guarded, and each one is a different way the fix can rot:
 *
 *   1. THE CONTRACT. 3 tri state values, 3 pairwise different strings, and a
 *      null that never reads as current. UNKNOWN IS NEVER 0: a graph whose
 *      staleness could not be determined is not a graph known to be current.
 *   2. THE CONTRACT CAN FAIL. The contract is run against a deliberately wrong
 *      implementation that collapses null to false, and is required to reject
 *      it. A guard that cannot fail reads like coverage and is not.
 *   3. THE HEADLINE CASE. A real repository, many commits behind, written to
 *      disk seconds ago. `stale` reads false and the advisory reports behind,
 *      in 1 fixture. That is the exact case that read as fine before this.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const GRAPHIFY = require(path.join(ROOT, 'ferrox-core', 'bin', 'lib', 'graphify.cjs'));

/**
 * Words that mean the graph matches the working tree. The null rendering is
 * forbidden from containing any of them, because an unreadable signal rendered
 * as reassurance is worse than no signal.
 */
const READS_AS_CURRENT = /current|fresh|up[\s-]?to[\s-]?date|in sync|matches head/i;

/**
 * THE CONTRACT, applied to any candidate rendering function.
 *
 * Written as a reusable assertion so the SAME contract can be pointed at the
 * shipped implementation (where it must pass) and at a deliberately wrong one
 * (where it must fail). That symmetry is the whole point: a contract that has
 * only ever been run against the code it was written for has not been shown to
 * discriminate between anything.
 *
 * @param {(commitStale: boolean|null, commitsBehind: unknown) => string} render
 * @param {string} label
 */
function assertAdvisoryContract(render, label) {
  const behind = render(true, 3);
  const current = render(false, 0);
  const unknown = render(null, null);

  for (const [state, text] of [['true', behind], ['false', current], ['null', unknown]]) {
    assert.strictEqual(
      typeof text, 'string',
      `${label}: the ${state} state must render a string, got ${typeof text}`,
    );
    assert.ok(
      text.trim().length > 20,
      `${label}: the ${state} state rendered nothing legible: ${JSON.stringify(text)}`,
    );
    assert.ok(
      !/\b(null|undefined|NaN)\b/.test(text),
      `${label}: the ${state} state leaked a raw ${'null'}ish value into prose: ${text}`,
    );
  }

  // Counted, not sampled. "The advisory covers every state" is vacuously true
  // of 0 states, so the number of DISTINCT renderings is asserted directly.
  const distinct = new Set([behind, current, unknown]);
  assert.strictEqual(
    distinct.size, 3,
    `${label}: expected 3 distinct renderings over the tri state, got ${distinct.size}\n` +
    `  true  -> ${behind}\n  false -> ${current}\n  null  -> ${unknown}`,
  );

  // Pairwise, so a failure names WHICH two states collapsed rather than only
  // that some collapse happened.
  assert.notStrictEqual(behind, current, `${label}: the true and false states render the same string`);
  assert.notStrictEqual(current, unknown, `${label}: the false and null states render the same string. Null collapsed to false, which is the defect this guard exists to catch`);
  assert.notStrictEqual(behind, unknown, `${label}: the true and null states render the same string`);

  // UNKNOWN IS NEVER 0.
  assert.ok(
    !READS_AS_CURRENT.test(unknown),
    `${label}: the null rendering reads as current, which it must never do: ${unknown}`,
  );

  // The true state has to name the count, or the reader cannot tell 1 commit
  // behind from 300.
  assert.match(
    behind, /\b3\b/,
    `${label}: the true rendering must name how many commits behind, got: ${behind}`,
  );
}

/**
 * A DELIBERATELY WRONG IMPLEMENTATION. Null is collapsed to false, which is the
 * single most likely way this signal gets broken: a reader who treats "we could
 * not determine it" as "we determined it is fine".
 *
 * Built here, inside the test file, so the failing case never has to exist in
 * src/graphify.cts even for a moment.
 */
function nullCollapsesToFalse(commitStale, commitsBehind) {
  const resolved = commitStale === null || commitStale === undefined ? false : commitStale;
  if (resolved) return `Graph is ${commitsBehind} commits behind HEAD: it describes an older tree.`;
  return 'Graph was built at the current commit.';
}

/** Run git in `cwd`, failing the test loudly rather than silently skipping. */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.error}`);
  return (r.stdout || '').trim();
}

/**
 * A REAL repository whose graph was built `behind` commits ago and written to
 * disk just now. Synthetic tri-state values prove the rendering; only a real
 * repo proves the rendering is reached with the right inputs.
 */
function scratchRepoBehindBy(behind) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ferrox-commit-advisory-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@ferrox.invalid']);
  git(dir, ['config', 'user.name', 'Ferrox Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'the commit the graph was built at']);
  const builtAt = git(dir, ['rev-parse', 'HEAD']);
  for (let i = 1; i <= behind; i++) {
    git(dir, ['commit', '-q', '--allow-empty', '-m', `landed after the graph was built (${i})`]);
  }
  fs.mkdirSync(path.join(dir, '.planning', 'graphs'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ graphify: { enabled: true } }),
  );
  fs.writeFileSync(
    path.join(dir, '.planning', 'graphs', 'graph.json'),
    JSON.stringify({ built_at_commit: builtAt, nodes: [], edges: [] }),
  );
  return dir;
}

function cleanup(dir) {
  try {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- this repo ships no shared cleanup helper, so the Windows EBUSY retry budget is carried inline here
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------------ *
 * 1. The contract, and the proof that it can fail
 * ------------------------------------------------------------------------ */

test('the SHIPPED advisory renders the tri state as 3 pairwise different strings', () => {
  assertAdvisoryContract(GRAPHIFY.commitStalenessAdvisory, 'shipped');
});

test('THE CONTRACT REJECTS a null-collapses-to-false implementation', () => {
  // The required failing arm, kept as a permanent inverted assertion. When it
  // was first run directly against the wrapper it reported:
  //
  //   null-collapses-to-false: expected 3 distinct renderings over the tri
  //   state, got 2
  //     true  -> Graph is 3 commits behind HEAD: it describes an older tree.
  //     false -> Graph was built at the current commit.
  //     null  -> Graph was built at the current commit.
  //
  // Inverting it keeps that discrimination machine-checked forever: if someone
  // loosens the contract until a collapsing implementation passes, this fails.
  assert.throws(
    () => assertAdvisoryContract(nullCollapsesToFalse, 'null-collapses-to-false'),
    (err) => {
      assert.strictEqual(err.code, 'ERR_ASSERTION', `expected an assertion failure, got ${err}`);
      assert.match(
        err.message, /3 distinct renderings|null states render the same/,
        `the contract failed, but not because null collapsed to false: ${err.message}`,
      );
      return true;
    },
    'a null-collapses-to-false implementation PASSED the contract, so the contract guards nothing',
  );
});

test('the null rendering leans stale rather than silent, because UNKNOWN IS NEVER 0', () => {
  const unknown = GRAPHIFY.commitStalenessAdvisory(null, null);
  assert.ok(
    !READS_AS_CURRENT.test(unknown),
    `an undetermined result must never read as current: ${unknown}`,
  );
  assert.match(
    unknown, /older tree|not determined|undetermined/i,
    `an undetermined result must say so out loud: ${unknown}`,
  );
});

test('the true rendering counts in singular and plural, so "1 commits" never ships', () => {
  assert.match(GRAPHIFY.commitStalenessAdvisory(true, 1), /\b1 commit\b(?!s)/);
  assert.match(GRAPHIFY.commitStalenessAdvisory(true, 30), /\b30 commits\b/);
});

/* ------------------------------------------------------------------------ *
 * 2. The headline case: fresh in time, stale in commits
 * ------------------------------------------------------------------------ */

test('HEADLINE: a graph 30 commits behind but written seconds ago reports BEHIND while stale reads false', () => {
  const dir = scratchRepoBehindBy(30);
  try {
    const status = GRAPHIFY.graphifyStatus(dir);

    // The time-based signal says everything is fine. It is not wrong; it is
    // measuring a different thing, and on its own it is the whole defect.
    assert.strictEqual(status.stale, false, 'fixture must be FRESH in time for this case to mean anything');
    assert.strictEqual(status.age_hours, 0, 'fixture must be freshly written');

    // The advisory is the part a reader sees, and it disagrees.
    assert.match(
      status.commit_advisory, /\b30 commits behind HEAD\b/,
      `the advisory must name the drift, got: ${status.commit_advisory}`,
    );
    assert.match(
      status.commit_advisory, /older tree/,
      `the advisory must say the graph describes an older tree, got: ${status.commit_advisory}`,
    );
    assert.notStrictEqual(
      status.commit_advisory,
      GRAPHIFY.commitStalenessAdvisory(false, 0),
      'the advisory rendered the built-at-current-commit string for a graph 30 commits behind',
    );
    assert.ok(
      !READS_AS_CURRENT.test(status.commit_advisory),
      `a graph 30 commits behind must not read as current: ${status.commit_advisory}`,
    );
  } finally {
    cleanup(dir);
  }
});

test('a graph built at HEAD reports built-at-current, so the advisory is not a constant', () => {
  const dir = scratchRepoBehindBy(0);
  try {
    const status = GRAPHIFY.graphifyStatus(dir);
    assert.strictEqual(
      status.commit_advisory, GRAPHIFY.commitStalenessAdvisory(false, 0),
      `a graph built at HEAD must render the false state, got: ${status.commit_advisory}`,
    );
    assert.ok(
      !/behind HEAD/.test(status.commit_advisory),
      `a graph built at HEAD must not report drift: ${status.commit_advisory}`,
    );
  } finally {
    cleanup(dir);
  }
});

/* ------------------------------------------------------------------------ *
 * 3. Totality: telemetry must never break a session
 * ------------------------------------------------------------------------ */

test('the helper is TOTAL: no tri state and no commits-behind value throws or leaks a nullish', () => {
  const states = [true, false, null, undefined, 0, 1, 'true', 'false', NaN, {}, []];
  const counts = [null, undefined, 0, 1, 30, -1, 1.5, NaN, Infinity, '7', 'seven', {}, []];
  let rendered = 0;
  for (const state of states) {
    for (const count of counts) {
      const out = GRAPHIFY.commitStalenessAdvisory(state, count);
      assert.strictEqual(
        typeof out, 'string',
        `commitStalenessAdvisory(${String(state)}, ${String(count)}) returned ${typeof out}`,
      );
      assert.ok(
        out.trim().length > 20,
        `commitStalenessAdvisory(${String(state)}, ${String(count)}) rendered nothing legible`,
      );
      assert.ok(
        !/\b(null|undefined|NaN|Infinity|\[object Object\])\b/.test(out),
        `commitStalenessAdvisory(${String(state)}, ${String(count)}) leaked a raw value: ${out}`,
      );
      rendered += 1;
    }
  }
  assert.strictEqual(rendered, states.length * counts.length, 'every combination must have been driven');

  // A true state with no usable count still has to be legible prose.
  const noCount = GRAPHIFY.commitStalenessAdvisory(true, 'seven');
  assert.match(noCount, /older tree/, `a behind graph with an unusable count must still say so: ${noCount}`);
});

/* ------------------------------------------------------------------------ *
 * 4. The tri state is interpreted in exactly 1 place
 * ------------------------------------------------------------------------ */

test('the researcher includes the RENDERED advisory and re-derives nothing', () => {
  const md = fs.readFileSync(path.join(ROOT, 'agents', 'ferrox-phase-researcher.md'), 'utf8');
  assert.ok(
    md.includes('commit_advisory'),
    'the only consumer of graph status must read the rendered advisory',
  );
  assert.ok(
    !md.includes('commit_stale'),
    'the consumer names the raw tri-state field, so the tri state is interpreted in 2 places and they can disagree',
  );
  // The existing time-based note is INDEPENDENT and must survive untouched.
  assert.ok(
    md.includes('treat semantic relationships as approximate'),
    'the existing time-based stale note was lost',
  );
});
